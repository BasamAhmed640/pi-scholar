#!/usr/bin/env node
// Scholar real end-to-end harness: the actual Pi CLI in RPC mode, the owner's
// real model, a generated textbook in a disposable library and a disposable
// Obsidian vault. It costs model calls, so it is NOT part of `npm test`.
//
//   node tests/e2e/run.mjs [--scenario full|smoke|baseline|plumbing] [--keep]
//        [--thinking max] [--model opencode-go/deepseek-v4.1-flash]
//        [--extension <scholar checkout>] [--pi-cli <dist/cli.js>]
//        [--max-minutes N] [--seed 42] [--p-correct 0.7] [--compare <report.json>]
//        [--run-id <id>] [--full-deltas]
//
// Scratch: <tmp>/claude/scholar-e2e/<run-id>/{library,vault,sessions,state,work,logs}.
// PI_SCHOLAR_STATE_ROOT points into the scratch dir, PI_SCHOLAR_LIBRARY_ROOT /
// PI_SCHOLAR_OBSIDIAN_ROOT are removed from the child environment, and Pi runs
// with --no-extensions -e <checkout> --session-dir <scratch>/sessions. The
// configured owner vault is excluded from scratch paths; the owner pointer is
// fingerprinted before and after the run.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ScriptedLearner } from "./learner.mjs";
import { makeTextbook, TEXTBOOK_FILE_NAME } from "./make-textbook.mjs";
import { buildReport, formatMs, writeReport } from "./report.mjs";
import { PiRpcClient, piVersionFor, resolvePiCli, RunLog } from "./rpc-client.mjs";
import { ensureDirectories, fileDigest, Harness, isInside } from "./steps.mjs";
import { inspectVault } from "./vault-inspect.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCENARIOS = ["full", "smoke", "baseline", "plumbing"];
const OWNER_POINTER = join(homedir(), ".pi", "agent", "scholar", "config.json");
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

function protectedVaults() {
  const roots = [];
  if (existsSync(OWNER_POINTER)) {
    let config;
    try { config = JSON.parse(readFileSync(OWNER_POINTER, "utf8")); }
    catch (error) { throw new Error(`Cannot read the owner's Scholar vault pointer: ${error.message}`); }
    if (config?.obsidianRoot && typeof config.obsidianRoot === "string") roots.push(config.obsidianRoot);
  }
  if (process.env.PI_SCHOLAR_OBSIDIAN_ROOT) roots.push(process.env.PI_SCHOLAR_OBSIDIAN_ROOT);
  if (process.env.SCHOLAR_E2E_OWNER_VAULT) roots.push(process.env.SCHOLAR_E2E_OWNER_VAULT);
  return [...new Set(roots.map((root) => existsSync(root) ? realpathSync(root) : resolve(root)))];
}

/** Canonicalize an intended new path through its nearest existing parent. */
function projectedRealPath(path) {
  let parent = resolve(path);
  const missing = [];
  while (!existsSync(parent)) {
    missing.unshift(basename(parent));
    const next = dirname(parent);
    if (next === parent) throw new Error(`Cannot resolve scratch parent for ${path}`);
    parent = next;
  }
  return resolve(realpathSync(parent), ...missing);
}

function usage() {
  return `Usage: node tests/e2e/run.mjs [options]

  --scenario <name>     full | smoke | baseline | plumbing (default: full)
                          full      plan §5 steps 1–9 (Learn ×2, abort, Esc, kill+restart, Tutor, Exam, deletion)
                          smoke     setup + Learn 1.1 (lesson + five questions)
                          baseline  setup + Learn 1.1 until lesson ready + 2 answers (≤ 15 min)
                          plumbing  no model calls: RPC, commands, restart, inspection
  --keep                keep library/vault/sessions/state (logs are always kept)
  --thinking <level>    off|minimal|low|medium|high|xhigh|max (default: max)
  --model <p/id>        default: opencode-go/deepseek-v4.1-flash
  --extension <dir>     Scholar checkout to load with -e (default: this checkout)
  --pi-cli <path>       Pi dist/cli.js (default: PI_E2E_CLI, PI_SCHOLAR_PI_PACKAGE, the owner's install, npm root -g)
  --max-minutes <n>     overall budget (default per scenario: full 180, smoke 45, baseline 15, plumbing 5)
  --seed <n>            learner RNG seed (default 42)
  --p-correct <p>       probability of choosing the right answer when the key is known (default 0.7)
  --compare <file>      earlier report.json to compare stage timings against
  --run-id <id>         safe single-segment scratch folder name (default: <timestamp>-<scenario>)
  --full-deltas         log every streamed delta verbatim (default: lengths only)`;
}

function parseArgs(argv) {
  const options = { scenario: "full", keep: false, thinking: "max", model: "opencode-go/deepseek-v4.1-flash", seed: 42, pCorrect: 0.7, fullDeltas: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    switch (arg) {
      case "--scenario": options.scenario = value(); break;
      case "--keep": options.keep = true; break;
      case "--thinking": options.thinking = value(); break;
      case "--model": options.model = value(); break;
      case "--extension": options.extension = value(); break;
      case "--pi-cli": options.piCli = value(); break;
      case "--max-minutes": options.maxMinutes = Number(value()); break;
      case "--seed": options.seed = Number(value()); break;
      case "--p-correct": options.pCorrect = Number(value()); break;
      case "--compare": options.compare = value(); break;
      case "--run-id": options.runId = value(); break;
      case "--full-deltas": options.fullDeltas = true; break;
      case "-h": case "--help": options.help = true; break;
      default: throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (!SCENARIOS.includes(options.scenario)) throw new Error(`--scenario must be one of ${SCENARIOS.join(", ")}`);
  if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(options.thinking)) throw new Error(`invalid --thinking ${options.thinking}`);
  if (!(options.pCorrect >= 0 && options.pCorrect <= 1)) throw new Error("--p-correct must be between 0 and 1");
  if (options.runId && (!SAFE_RUN_ID.test(options.runId) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(options.runId))) {
    throw new Error("--run-id must be one safe folder name using letters, digits, underscore or hyphen (max 80 characters)");
  }
  return options;
}

function gitDescription(directory) {
  try {
    const head = execFileSync("git", ["-C", directory, "rev-parse", "--short", "HEAD"], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
    const branch = execFileSync("git", ["-C", directory, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
    const dirty = execFileSync("git", ["-C", directory, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] })
      .split("\n").map((line) => line.slice(3).trim()).filter(Boolean);
    return `${branch}@${head}${dirty.length ? ` + uncommitted: ${dirty.join(", ")}` : ""}`;
  } catch { return undefined; }
}

function timestampId() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); } catch (error) { console.error(`${error.message}\n\n${usage()}`); return 2; }
  if (options.help) { console.log(usage()); return 0; }

  const scenario = await import(`./scenario-${options.scenario}.mjs`);
  const maxMinutes = options.maxMinutes > 0 ? options.maxMinutes : scenario.defaultMaxMinutes;
  const extensionDir = resolve(options.extension || join(HERE, "..", ".."));
  if (!existsSync(join(extensionDir, "index.ts")) || !existsSync(join(extensionDir, "package.json"))) {
    console.error(`--extension must be a Scholar checkout containing index.ts and package.json: ${extensionDir}`);
    return 2;
  }
  const runId = options.runId || `${timestampId()}-${options.scenario}`;
  const runRoot = resolve(tmpdir(), "claude", "scholar-e2e");
  let ownerVaults;
  try { ownerVaults = protectedVaults(); } catch (error) { console.error(error.message); return 2; }
  // Resolve existing parent symlinks before creating anything or choosing cleanup paths.
  const effectiveRunRoot = projectedRealPath(runRoot);
  const runDir = projectedRealPath(resolve(runRoot, runId));
  if (runDir === effectiveRunRoot || !isInside(effectiveRunRoot, runDir)) { console.error("Refusing: scratch escaped the e2e root."); return 2; }
  for (const protectedRoot of [...ownerVaults, existsSync(dirname(OWNER_POINTER)) ? realpathSync(dirname(OWNER_POINTER)) : dirname(OWNER_POINTER)]) {
    if (isInside(protectedRoot, runDir) || isInside(runDir, protectedRoot)) {
      console.error(`Refusing: scratch ${runDir} overlaps protected Scholar data at ${protectedRoot}.`);
      return 2;
    }
  }
  if (existsSync(runDir)) { console.error(`Scratch folder already exists: ${runDir} (choose another --run-id)`); return 2; }
  mkdirSync(runRoot, { recursive: true });
  if (!isInside(realpathSync(runRoot), runDir)) { console.error("Refusing: scratch root changed while preparing the run."); return 2; }
  ensureDirectories(runDir);
  const stateRoot = join(runDir, "state");

  let piCli;
  try { piCli = resolvePiCli(options.piCli); } catch (error) { console.error(error.message); return 2; }
  const pointerBefore = fileDigest(OWNER_POINTER);
  const run = {
    runId, scenario: options.scenario, description: scenario.description, runDir, extensionDir, git: gitDescription(extensionDir),
    piCli, piVersion: piVersionFor(piCli), model: options.model, thinking: options.thinking, seed: options.seed, pCorrect: options.pCorrect,
    maxMinutes, startedAt: Date.now(), startedAtIso: new Date().toISOString(), kept: options.keep, node: process.version,
  };
  console.log(`Scholar e2e · ${options.scenario} · ${runId}\n  extension ${extensionDir}${run.git ? ` (${run.git})` : ""}\n  Pi ${run.piVersion} · ${options.model} · thinking ${options.thinking} · budget ${maxMinutes} min\n  scratch ${runDir}`);

  console.log("Building the textbook PDF…");
  let textbook;
  try {
    const built = await makeTextbook(join(runDir, "library"));
    if (!built.verification.verified) throw new Error(`textbook layout check failed: ${built.verification.problems.join("; ")}`);
    textbook = { ...built, fileName: TEXTBOOK_FILE_NAME };
    run.textbook = { path: built.pdfPath, browser: built.browser, pages: built.verification.pages };
  } catch (error) {
    console.error(`Cannot build the textbook: ${error.message}`);
    return 2;
  }

  const log = new RunLog(join(runDir, "logs", "events.jsonl"), { startedAt: run.startedAt });
  const learner = new ScriptedLearner({ seed: options.seed, pCorrect: options.pCorrect, bookFileName: TEXTBOOK_FILE_NAME });
  const client = new PiRpcClient({
    piCli, extensionDir, cwd: join(runDir, "work"), sessionDir: join(runDir, "sessions"), stateRoot, model: options.model, thinking: options.thinking,
    name: `scholar-e2e ${runId}`, log, learner, fullDeltas: options.fullDeltas,
  });
  client.on("exit", (info) => { if (info.code !== 0 && info.code !== null) console.log(`  (Pi exited with code ${info.code})`); });
  const harness = new Harness({ runDir, extensionDir, client, learner, textbook, deadline: run.startedAt + maxMinutes * 60_000, scenario: options.scenario, strict: Boolean(scenario.strict) });

  try {
    const state = await client.start();
    const extensionCommands = client.commands.filter((command) => command.source === "extension").map((command) => command.name);
    // Pi's own inline built-ins (e.g. `llama` from <inline:llama.cpp>) are not user extensions.
    const foreign = client.commands.filter((command) => command.source === "extension" && command.name !== "scholar" && command.sourceInfo?.source !== "inline")
      .map((command) => `${command.name} (${command.sourceInfo?.path ?? "?"})`);
    run.session = { model: state.model ? `${state.model.provider}/${state.model.id}` : undefined, thinkingLevel: state.thinkingLevel, extensionCommands };
    console.log(`Pi ready · model ${run.session.model} · thinking ${state.thinkingLevel} · extension commands: ${extensionCommands.join(", ") || "none"}`);
    if (!extensionCommands.includes("scholar")) throw new Error("the Scholar extension did not register /scholar");
    const scholarSource = client.commands.find((command) => command.name === "scholar")?.sourceInfo?.path;
    if (scholarSource && !isInside(extensionDir, scholarSource)) harness.failures.push({ stage: "harness", reason: `/scholar came from ${scholarSource}, not ${extensionDir}` });
    if (foreign.length) harness.failures.push({ stage: "harness", reason: `other extensions loaded: ${foreign.join(", ")}` });
    if (options.model !== run.session.model) harness.failures.push({ stage: "harness", reason: `Pi selected ${run.session.model}, not ${options.model}` });
    await scenario.run(harness);
  } catch (error) {
    harness.fail("harness", error instanceof Error ? error.message : String(error));
  } finally {
    await client.stop().catch(() => undefined);
  }

  run.finishedAt = Date.now();
  const pointerAfter = fileDigest(OWNER_POINTER);
  run.ownerPointerUntouched = JSON.stringify(pointerBefore) === JSON.stringify(pointerAfter);
  if (!run.ownerPointerUntouched) harness.failures.push({ stage: "harness", reason: "the owner's ~/.pi/agent/scholar/config.json changed during the run" });
  const vault = harness.facts.vault || inspectVault(harness.vaultDir);
  let compare;
  if (options.compare) {
    try { compare = JSON.parse(readFileSync(resolve(options.compare), "utf8")); } catch (error) { console.log(`(cannot read --compare file: ${error.message})`); }
  }
  const stages = harness.stages.map(({ name, startSeq, endSeq, startAt, endAt, status, checks, notes }) => ({ name, startSeq, endSeq, startAt, endAt, status, checks, notes }));
  writeFileSync(join(runDir, "logs", "run-state.json"), `${JSON.stringify({ run, stages, failures: harness.failures, learner: { dialogs: learner.dialogs, unexpected: learner.unexpected }, vault, compare }, null, 2)}\n`);
  const report = buildReport({ run, stages, events: client.events, learner, vault, failures: harness.failures, compare });
  const paths = writeReport(join(runDir, "logs"), report);
  await log.close();

  if (!options.keep) {
    for (const directory of ["library", "vault", "sessions", "state", "work"]) {
      try { rmSync(join(runDir, directory), { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* Windows may hold a lock briefly */ }
    }
  }

  console.log(`\n${report.result} · ${formatMs(report.totals.durationMs)} · ${report.totals.assistantMessages} model responses · ${report.totals.retries} Scholar retries · tokens in ${report.totals.tokens.input} / out ${report.totals.tokens.output}`);
  for (const stage of report.stages) {
    console.log(`  ${stage.status.padEnd(7)} ${formatMs(stage.durationMs).padStart(8)}  ${stage.name}${stage.metrics.lessonReadyMs !== undefined ? ` · lesson ready ${formatMs(stage.metrics.lessonReadyMs)}` : ""}${stage.metrics.firstQuestionMs !== undefined ? ` · first question ${formatMs(stage.metrics.firstQuestionMs)}` : ""}`);
  }
  for (const failure of report.failures) console.log(`  ✗ ${failure.stage}: ${failure.reason}`);
  console.log(`Report: ${paths.markdown}`);
  return report.result === "PASS" ? 0 : 1;
}

process.exitCode = await main();
