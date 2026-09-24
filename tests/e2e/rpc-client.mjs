// Drives the real Pi CLI in RPC mode (JSONL commands on stdin, responses and
// events on stdout) for the Scholar end-to-end harness.
//
// Protocol facts relied on (Pi 0.87.1, docs/rpc*.md):
//   * every command may carry an `id`; its `response` repeats it;
//   * a `prompt` whose text is an extension command (`/scholar ...`) runs the
//     command handler first and responds only after the handler returns; an
//     agent run it triggers streams `agent_start` ... `agent_end` and finally
//     `agent_settled` (no further automatic work);
//   * dialogs (`select`, `confirm`, `input`, `editor`) arrive as
//     `extension_ui_request` and block until an `extension_ui_response` with the
//     same id; `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`
//     are fire-and-forget;
//   * `abort` waits for the session to become idle before it responds, so any
//     open dialog must be answered (or cancelled) first or abort never returns.
import { spawn, execFileSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { StringDecoder } from "node:string_decoder";
import { dirname, join, resolve } from "node:path";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const WINDOWS_DEFAULT_CLI = "C:/Users/basam/AppData/Local/pi-node/current/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";
export const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function isPiPackage(directory) {
  try { return JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).name === PI_PACKAGE; } catch { return false; }
}

/** Locates Pi's dist/cli.js without going through the shell wrapper. */
export function resolvePiCli(explicit) {
  const candidates = [];
  if (explicit) candidates.push(resolve(explicit));
  if (process.env.PI_E2E_CLI) candidates.push(resolve(process.env.PI_E2E_CLI));
  if (process.env.PI_SCHOLAR_PI_PACKAGE) candidates.push(join(resolve(process.env.PI_SCHOLAR_PI_PACKAGE), "dist", "cli.js"));
  candidates.push(WINDOWS_DEFAULT_CLI);
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  try {
    const globalRoot = execFileSync(process.platform === "win32" ? "cmd.exe" : "npm",
      process.platform === "win32" ? ["/d", "/s", "/c", "npm root --global"] : ["root", "--global"],
      { encoding: "utf8", timeout: 15_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
    const packageRoot = join(globalRoot, PI_PACKAGE);
    if (isPiPackage(packageRoot) && existsSync(join(packageRoot, "dist", "cli.js"))) return join(packageRoot, "dist", "cli.js");
  } catch { /* fall through */ }
  throw new Error(`Cannot find Pi's dist/cli.js. Pass --pi-cli <path> or set PI_E2E_CLI (tried: ${candidates.join(", ")}).`);
}

export function piVersionFor(cliPath) {
  let directory = dirname(cliPath);
  while (dirname(directory) !== directory) {
    if (isPiPackage(directory)) return JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).version;
    directory = dirname(directory);
  }
  return "unknown";
}

/** Replaces bulky/binary payloads so the in-memory copy and the log stay readable. */
function sanitize(value, depth = 0) {
  if (depth > 40 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => sanitize(item, depth + 1));
  if (value.type === "image" && typeof value.data === "string") {
    return { type: "image", mimeType: value.mimeType, base64Chars: value.data.length };
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = sanitize(item, depth + 1);
  return out;
}

function summarizeMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  return { count: messages.length, roles: messages.map((message) => message?.role).join(",") };
}

/** Reduces an event to what the harness keeps in memory and writes to the log. */
function compactRecord(record, fullDeltas) {
  if (record?.type === "message_update" && !fullDeltas) {
    const inner = record.assistantMessageEvent || {};
    if (typeof inner.delta === "string") {
      return { type: "message_update", assistantMessageEvent: { type: inner.type, contentIndex: inner.contentIndex, deltaChars: inner.delta.length } };
    }
  }
  if (record?.type === "agent_end") return { ...record, messages: summarizeMessages(record.messages) };
  if (record?.type === "turn_end") {
    const message = record.message || {};
    return { type: "turn_end", message: { role: message.role, stopReason: message.stopReason, usage: message.usage, errorMessage: message.errorMessage },
      toolResults: Array.isArray(record.toolResults) ? record.toolResults.length : record.toolResults };
  }
  return sanitize(record);
}

/** One JSONL file for the whole run: every stdout record, command, UI response, stderr line and harness mark. */
export class RunLog {
  constructor(filePath, { startedAt = Date.now() } = {}) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.filePath = filePath;
    this.startedAt = startedAt;
    this.stream = createWriteStream(filePath, { flags: "a" });
  }
  write(entry) {
    const now = Date.now();
    this.stream.write(`${JSON.stringify({ ts: new Date(now).toISOString(), t: now - this.startedAt, ...entry })}\n`);
  }
  close() { return new Promise((done) => this.stream.end(done)); }
}

export class PiRpcClient extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.piCli       absolute path to Pi's dist/cli.js
   * @param {string} options.extensionDir Scholar checkout loaded with -e
   * @param {string} options.cwd         working directory (constant across restarts so --continue finds the session)
   * @param {string} options.sessionDir  --session-dir
   * @param {string} options.stateRoot   PI_SCHOLAR_STATE_ROOT
   * @param {string} options.model       provider/model
   * @param {string} [options.thinking]  --thinking level
   * @param {RunLog} options.log
   * @param {{respond(request, client): Promise<object|undefined>}} [options.learner]
   */
  constructor(options) {
    super();
    this.options = { fullDeltas: false, startupTimeoutMs: 120_000, isolateResources: true, ...options };
    this.log = options.log;
    this.learner = options.learner;
    this.events = [];          // {seq, t, at, proc, dir, rec} (message deltas are counted, not stored)
    this.seq = 0;
    this.generation = 0;       // incremented per spawned Pi process
    this.pending = new Map();  // command id -> {resolve, reject, timer, command}
    this.dialogs = new Map();  // open extension_ui_request id -> request
    this.waiters = new Set();
    this.commandCounter = 0;
    this.deltaCount = 0;
    this.lastActivityAt = Date.now();
    this.child = undefined;
    this.exitInfo = undefined;
    this.startedAt = options.log?.startedAt ?? Date.now();
    this.commands = [];
  }

  get running() { return Boolean(this.child && !this.exitInfo); }
  get pendingDialogs() { return [...this.dialogs.values()]; }

  buildArgs({ continueSession }) {
    const o = this.options;
    const args = [o.piCli, "--mode", "rpc", "--no-extensions", "-e", o.extensionDir, "--session-dir", o.sessionDir, "--model", o.model];
    if (o.thinking) args.push("--thinking", o.thinking);
    if (o.isolateResources) args.push("--no-context-files", "--no-skills", "--no-prompt-templates", "--no-themes");
    if (o.name) args.push("--name", o.name);
    if (continueSession) args.push("--continue");
    args.push(...(o.extraArgs || []));
    return args;
  }

  buildEnv() {
    const env = { ...process.env, ...(this.options.env || {}) };
    for (const key of ["PI_SCHOLAR_LIBRARY_ROOT", "PI_SCHOLAR_OBSIDIAN_ROOT", "SCHOLAR_DESIGN_PREVIEW", "PI_SCHOLAR_EXTENSION"]) delete env[key];
    env.PI_SCHOLAR_STATE_ROOT = this.options.stateRoot;
    env.PI_SKIP_VERSION_CHECK = "1";
    return env;
  }

  record(dir, rec, extra = {}) {
    const entry = { seq: ++this.seq, t: Date.now() - this.startedAt, at: Date.now(), proc: this.generation, dir, rec, ...extra };
    this.events.push(entry);
    this.log?.write({ seq: entry.seq, proc: entry.proc, dir, rec, ...extra });
    for (const waiter of [...this.waiters]) {
      let matched = false;
      try { matched = waiter.predicate(entry); } catch (error) { waiter.reject(error); this.waiters.delete(waiter); continue; }
      if (matched) { this.waiters.delete(waiter); clearTimeout(waiter.timer); waiter.resolve(entry); }
    }
    this.emit("record", entry);
    return entry;
  }

  /** A harness-level annotation in the same timeline (stage boundaries, vault observations, …). */
  mark(name, data = {}) {
    return this.record("mark", { type: "harness_mark", name, ...data });
  }

  async start({ continueSession = false } = {}) {
    if (this.running) throw new Error("Pi is already running.");
    this.generation += 1;
    this.exitInfo = undefined;
    const args = this.buildArgs({ continueSession });
    this.record("meta", { type: "process_start", generation: this.generation, argv: args.slice(1), cwd: this.options.cwd, continueSession });
    const child = spawn(process.execPath, args, { cwd: this.options.cwd, env: this.buildEnv(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    const generation = this.generation;
    const stdoutDecoder = new StringDecoder("utf8");
    let stdoutBuffer = "";
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += stdoutDecoder.write(chunk);
      let newline;
      while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
        let line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line.trim()) this.handleLine(line, generation);
      }
    });
    const stderrDecoder = new StringDecoder("utf8");
    let stderrBuffer = "";
    child.stderr.on("data", (chunk) => {
      stderrBuffer += stderrDecoder.write(chunk);
      let newline;
      while ((newline = stderrBuffer.indexOf("\n")) >= 0) {
        const line = stderrBuffer.slice(0, newline).replace(/\r$/, "");
        stderrBuffer = stderrBuffer.slice(newline + 1);
        if (line.trim()) this.record("stderr", { line: line.length > 4000 ? `${line.slice(0, 4000)}…` : line });
      }
    });
    child.stdin.on("error", (error) => this.record("meta", { type: "stdin_error", message: error.message }));
    child.once("error", (error) => this.record("meta", { type: "process_error", message: error.message }));
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      this.exitInfo = { code, signal, at: Date.now() };
      this.record("meta", { type: "process_exit", generation, code, signal });
      const failure = new Error(`Pi exited (code ${code}${signal ? `, signal ${signal}` : ""}).`);
      for (const [id, pending] of this.pending) { clearTimeout(pending.timer); pending.reject(failure); this.pending.delete(id); }
      this.dialogs.clear();
      for (const waiter of [...this.waiters]) {
        if (waiter.rejectOnExit !== false) { this.waiters.delete(waiter); clearTimeout(waiter.timer); waiter.reject(failure); }
      }
      this.emit("exit", this.exitInfo);
    });
    const state = await this.send({ type: "get_state" }, { timeoutMs: this.options.startupTimeoutMs });
    if (!state.success) throw new Error(`Pi did not report its state: ${state.error}`);
    const commands = await this.send({ type: "get_commands" }, { timeoutMs: 30_000 });
    this.commands = commands.success ? commands.data?.commands || [] : [];
    this.record("meta", { type: "process_ready", generation, model: state.data?.model ? `${state.data.model.provider}/${state.data.model.id}` : undefined,
      thinkingLevel: state.data?.thinkingLevel, sessionFile: state.data?.sessionFile, messageCount: state.data?.messageCount,
      extensionCommands: this.commands.filter((command) => command.source === "extension").map((command) => command.name) });
    return state.data;
  }

  handleLine(line, generation) {
    let rec;
    try { rec = JSON.parse(line); } catch {
      this.record("stdout-unparsed", { line: line.slice(0, 2000) });
      return;
    }
    this.lastActivityAt = Date.now();
    if (rec?.type === "message_update" && !this.options.fullDeltas && typeof rec.assistantMessageEvent?.delta === "string") {
      // Deltas are counted and logged compactly; the complete content arrives in *_end and message_end.
      this.deltaCount += 1;
      this.log?.write({ proc: generation, dir: "out", rec: compactRecord(rec, false) });
      this.emit("delta", rec);
      return;
    }
    const entry = this.record("out", compactRecord(rec, this.options.fullDeltas));
    if (rec.type === "response" && rec.id && this.pending.has(rec.id)) {
      const pending = this.pending.get(rec.id);
      this.pending.delete(rec.id);
      clearTimeout(pending.timer);
      pending.resolve({ ...rec, seq: entry.seq });
      return;
    }
    if (rec.type === "extension_ui_request" && DIALOG_METHODS.has(rec.method)) {
      this.dialogs.set(rec.id, { ...rec, seq: entry.seq, at: entry.at });
      void this.answerDialog(rec, entry);
    }
  }

  async answerDialog(request, entry) {
    let payload;
    try {
      payload = this.learner ? await this.learner.respond(request, this, entry) : undefined;
    } catch (error) {
      this.record("meta", { type: "learner_error", requestId: request.id, message: error instanceof Error ? error.message : String(error) });
      payload = undefined;
    }
    if (!this.dialogs.has(request.id)) return; // already answered (e.g. cancelled by abort)
    this.respondDialog(request.id, payload ?? { cancelled: true });
  }

  respondDialog(id, payload) {
    if (!this.dialogs.has(id)) return false;
    this.dialogs.delete(id);
    const message = { type: "extension_ui_response", id, ...payload };
    this.writeLine(message);
    this.record("in", message);
    return true;
  }

  cancelPendingDialogs(reason = "harness") {
    const ids = [...this.dialogs.keys()];
    for (const id of ids) {
      this.record("meta", { type: "dialog_force_cancel", requestId: id, reason });
      this.respondDialog(id, { cancelled: true });
    }
    return ids.length;
  }

  writeLine(object) {
    if (!this.running) throw new Error("Pi is not running.");
    this.child.stdin.write(`${JSON.stringify(object)}\n`);
  }

  /** Sends one command and resolves with its response record. */
  send(command, { timeoutMs = 60_000 } = {}) {
    const id = command.id || `h${++this.commandCounter}`;
    const message = { ...command, id };
    return new Promise((resolvePromise, reject) => {
      if (!this.running) { reject(new Error(`Pi is not running (cannot send ${command.type}).`)); return; }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out after ${timeoutMs} ms waiting for the ${command.type} response.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject, timer, command: message });
      this.record("in", message);
      this.writeLine(message);
    });
  }

  async getState() {
    const response = await this.send({ type: "get_state" }, { timeoutMs: 30_000 });
    if (!response.success) throw new Error(`get_state failed: ${response.error}`);
    return { ...response.data, seq: response.seq };
  }

  /** Resolves with the first event after `since` (default: now) that matches. */
  waitFor(predicate, { timeoutMs = 60_000, since = this.seq, label = "event", rejectOnExit = true } = {}) {
    for (const entry of this.events) {
      if (entry.seq > since && predicate(entry)) return Promise.resolve(entry);
    }
    return new Promise((resolvePromise, reject) => {
      const waiter = { predicate: (entry) => entry.seq > since && predicate(entry), resolve: resolvePromise, reject, rejectOnExit };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        const error = new Error(`Timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${label}.`);
        error.code = "E2E_TIMEOUT";
        reject(error);
      }, Math.max(0, timeoutMs));
      this.waiters.add(waiter);
    });
  }

  /** True when an agent run started after `since` has not yet settled. */
  runOpenSince(since) {
    let open = false;
    for (const entry of this.events) {
      if (entry.seq <= since || entry.dir !== "out") continue;
      if (entry.rec.type === "agent_start") open = true;
      else if (entry.rec.type === "agent_settled") open = false;
    }
    return open;
  }

  /**
   * Waits until Pi has no agent run in flight: every agent_start after `since`
   * has its agent_settled, get_state reports not streaming, and nothing new
   * starts during a short quiet period.
   */
  async waitForIdle({ since = this.seq, timeoutMs = 600_000, quietMs = 1200 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        const error = new Error(`Timed out after ${Math.round(timeoutMs / 1000)} s waiting for Pi to become idle.`);
        error.code = "E2E_TIMEOUT";
        throw error;
      }
      if (this.runOpenSince(since)) {
        await this.waitFor((entry) => entry.dir === "out" && entry.rec.type === "agent_settled", { timeoutMs: remaining, since: this.lastAgentStartSeq(since), label: "agent_settled" });
        continue;
      }
      const state = await this.getState();
      if (state.isStreaming || state.isCompacting) {
        await this.waitFor((entry) => entry.dir === "out" && entry.rec.type === "agent_settled", { timeoutMs: Math.max(1, deadline - Date.now()), since: state.seq, label: "agent_settled" });
        continue;
      }
      const quietFrom = this.seq;
      await sleep(quietMs);
      if (this.events.some((entry) => entry.seq > quietFrom && entry.dir === "out" && entry.rec.type === "agent_start")) continue;
      if (this.dialogs.size) continue; // a dialog is still being answered
      return;
    }
  }

  lastAgentStartSeq(since) {
    let seq = since;
    for (const entry of this.events) if (entry.seq > since && entry.dir === "out" && entry.rec.type === "agent_start") seq = entry.seq - 1;
    return seq;
  }

  /**
   * Sends a prompt (a `/scholar …` command or a plain learner message) and waits
   * until Pi is idle again. Never throws for Pi-side failures; returns a result.
   */
  async runCommand(text, { timeoutMs = 600_000, quietMs = 1200 } = {}) {
    const since = this.seq;
    const startedAt = Date.now();
    let response;
    try {
      response = await this.send({ type: "prompt", message: text }, { timeoutMs });
    } catch (error) {
      return { ok: false, since, error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt };
    }
    if (!response.success) return { ok: false, since, error: response.error, durationMs: Date.now() - startedAt, response };
    try {
      await this.waitForIdle({ since, timeoutMs: Math.max(1_000, timeoutMs - (Date.now() - startedAt)), quietMs });
    } catch (error) {
      return { ok: false, since, timedOut: error?.code === "E2E_TIMEOUT", error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - startedAt, response };
    }
    return { ok: true, since, durationMs: Date.now() - startedAt, response };
  }

  /** Esc: cancel any open dialog (abort would otherwise wait for it), then abort and wait for idle. */
  async abort({ timeoutMs = 120_000 } = {}) {
    const cancelled = this.cancelPendingDialogs("abort");
    const since = this.seq;
    this.record("mark", { type: "harness_mark", name: "abort_requested", cancelledDialogs: cancelled });
    const response = await this.send({ type: "abort" }, { timeoutMs });
    await this.waitForIdle({ since, timeoutMs, quietMs: 800 }).catch(() => undefined);
    return response;
  }

  /**
   * Arms an abort that fires when `predicate` matches a future event (or after
   * `afterMs`, whichever comes first). Returns {fired: Promise<entry|undefined>, disarm()}.
   */
  abortAfter(predicate, { afterMs, label = "abort trigger" } = {}) {
    let settled = false;
    let timer;
    let resolveFired;
    const fired = new Promise((done) => { resolveFired = done; });
    const cleanup = () => { this.off("record", listener); this.off("exit", onExit); clearTimeout(timer); };
    const fire = async (entry) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!this.running) { resolveFired(undefined); return; }
      this.record("mark", { type: "harness_mark", name: "abort_trigger", trigger: entry.timer ? `timer ${afterMs} ms` : label, triggerSeq: entry.seq });
      await this.abort().catch((error) => this.record("meta", { type: "abort_error", message: error.message }));
      resolveFired(entry);
    };
    const listener = (entry) => {
      if (settled) return;
      let matched = false;
      try { matched = predicate(entry); } catch { matched = false; }
      if (matched) setImmediate(() => void fire(entry));
    };
    const onExit = () => { if (!settled) { settled = true; cleanup(); resolveFired(undefined); } };
    this.on("record", listener);
    this.on("exit", onExit);
    if (afterMs !== undefined) timer = setTimeout(() => void fire({ timer: true, seq: this.seq }), afterMs);
    return { fired, disarm: () => { if (!settled) { settled = true; cleanup(); resolveFired(undefined); } } };
  }

  /** The tool_execution_start record for a tool call id (searching recent events first). */
  toolStart(toolCallId) {
    for (let index = this.events.length - 1; index >= 0; index--) {
      const rec = this.events[index].rec;
      if (rec?.type === "tool_execution_start" && rec.toolCallId === toolCallId) return rec;
    }
    return undefined;
  }

  /** Orderly shutdown: close stdin, wait, then force. */
  async stop({ timeoutMs = 20_000 } = {}) {
    if (!this.running) return this.exitInfo;
    const child = this.child;
    this.cancelPendingDialogs("stop");
    const exited = new Promise((done) => child.once("exit", () => done()));
    try { child.stdin.end(); } catch { /* already closed */ }
    const timer = sleep(timeoutMs).then(() => "timeout");
    if (await Promise.race([exited.then(() => "exit"), timer]) === "timeout") {
      this.record("meta", { type: "stop_timeout_kill" });
      child.kill("SIGKILL");
      await exited;
    }
    return this.exitInfo;
  }

  /** Crash-like termination (TerminateProcess on Windows). */
  async kill() {
    if (!this.running) return this.exitInfo;
    const child = this.child;
    const exited = new Promise((done) => child.once("exit", () => done()));
    this.record("mark", { type: "harness_mark", name: "kill" });
    child.kill("SIGKILL");
    await Promise.race([exited, sleep(15_000)]);
    return this.exitInfo;
  }

  async restart({ continueSession = true, hard = false } = {}) {
    if (hard) await this.kill(); else await this.stop();
    await sleep(500);
    return this.start({ continueSession });
  }
}
