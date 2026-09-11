import { extensionPath as packagedExtensionPath, piPackageRoot as sdkRoot, jitiPath as sdkJitiPath } from "./sdk.mjs";
// Disposable verifier for Scholar's Pi editor lock.
//
// The installed extension is copied to a temporary directory. One test-only
// hook is injected into that copy so the otherwise-private release closure can
// be exercised; the installed Scholar source is never modified.
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const extensionPath = resolve(
  process.env.PI_SCHOLAR_EXTENSION
    || packagedExtensionPath,
);
const installedExtension = basename(extensionPath).toLowerCase() === "index.ts"
  ? dirname(extensionPath)
  : extensionPath;
const loaderPath = join(
  sdkRoot,
  "dist",
  "core",
  "extensions",
  "loader.js",
);
const { createExtensionRuntime, loadExtensions } = await import(pathToFileURL(loaderPath).href);

const results = [];
function pass(name, detail) {
  results.push({ name, passed: true });
  console.log(`[PASS] ${name} - ${detail}`);
}

async function prove(name, test, detail) {
  await test();
  pass(name, detail);
}

function pdfLiteral(value) {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function syntheticPdf() {
  const lines = [
    "Scholar Input Lock Verifier",
    "Chapter 1: Loading",
    "1.1 Editor ownership",
    "A temporary source used only by the input-lock verifier.",
  ];
  const commands = ["BT", "/F1 11 Tf", "72 740 Td", "18 TL"];
  lines.forEach((line, index) => {
    if (index) commands.push("T*");
    commands.push(`(${pdfLiteral(line)}) Tj`);
  });
  commands.push("ET");
  const stream = commands.join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let document = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(document, "latin1"));
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(document, "latin1");
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) document += `${String(offset).padStart(10, "0")} 00000 n \n`;
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(document, "latin1");
}

class DraftEditor {
  constructor() {
    this.text = "";
    this.onSubmit = undefined;
    this.onChange = undefined;
  }

  getText() {
    return this.text;
  }

  setText(text) {
    this.text = text;
  }

  handleInput(data) {
    if (data === "\r") this.onSubmit?.(this.text);
    else {
      this.text += data;
      this.onChange?.(this.text);
    }
  }
}

function createUi(draft, timeline) {
  const tui = { requestRender() {} };
  const theme = {
    borderColor: (value) => value,
    fg: (_role, value) => value,
    bold: (value) => value,
  };
  const keybindings = {
    matches(data, action) {
      return action === "app.interrupt" && data === "configured-interrupt";
    },
  };
  const priorFactory = () => new DraftEditor();
  let currentFactory = priorFactory;
  let currentEditor = priorFactory(tui, theme, keybindings);
  let submits = 0;
  const customCalls = [];
  currentEditor.setText(draft);

  const ui = {
    notifications: [],
    workingMessages: [],
    theme,
    priorFactory,
    get currentFactory() { return currentFactory; },
    get currentEditor() { return currentEditor; },
    get submits() { return submits; },
    customCalls,
    isLocked() { return currentFactory !== priorFactory; },
    getEditorComponent() { return currentFactory; },
    setEditorComponent(factory) {
      const transferredDraft = currentEditor.getText();
      const nextFactory = factory || priorFactory;
      const nextEditor = nextFactory(tui, theme, keybindings);
      nextEditor.onSubmit = () => { submits += 1; };
      nextEditor.onChange = () => {};
      nextEditor.setText(transferredDraft);
      currentFactory = factory;
      currentEditor = nextEditor;
      timeline.push({ type: "factory", locked: ui.isLocked(), draft: transferredDraft, factory });
    },
    notify(message, level) {
      ui.notifications.push({ message, level, locked: ui.isLocked() });
      timeline.push({ type: "notify", message, level, locked: ui.isLocked() });
    },
    setStatus(key, text) {
      timeline.push({ type: "status", key, text, locked: ui.isLocked() });
    },
    setWorkingMessage(message) {
      ui.workingMessages.push(message);
      timeline.push({ type: "working", message, locked: ui.isLocked() });
    },
    setEditorText(text) {
      currentEditor.setText(text);
    },
    async select(_title, options) {
      return options[0];
    },
    custom(factory) {
      const call = { locked: ui.isLocked(), initialLines: [], finishedAfterAnswer: false };
      customCalls.push(call);
      timeline.push({ type: "custom", locked: call.locked });
      return new Promise((resolveModal, rejectModal) => {
        try {
          let finished = false;
          const component = factory(tui, theme, keybindings, (value) => {
            finished = true;
            resolveModal(value);
          });
          call.initialLines = component.render(80);
          component.handleInput("\r");
          call.finishedAfterAnswer = finished;
          if (!finished) rejectModal(new Error("Scholar modal did not close after the accepted answer"));
        } catch (error) {
          rejectModal(error);
        }
      });
    },
  };
  return ui;
}

async function fire(extension, name, event, ctx) {
  const output = [];
  for (const handler of extension.handlers.get(name) || []) output.push(await handler(event, ctx));
  return output;
}

function wasHandled(output) {
  return output.some((value) => value?.action === "handled");
}

async function filesNamed(root, fileName) {
  const matches = [];
  async function walk(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name === fileName) matches.push(path);
    }
  }
  await walk(root);
  return matches;
}

const tempRoot = await mkdtemp(join(tmpdir(), "scholar-input-lock-"));
const copiedExtension = join(tempRoot, "extension");
const library = join(tempRoot, "library");
const vault = join(tempRoot, "vault");
const stateRoot = join(tempRoot, "state");
const sourceName = "Scholar Input Lock Verifier.pdf";
const hookName = `__scholarInputLockVerifier_${process.pid}_${Date.now()}`;
const originalEnvironment = {
  state: process.env.PI_SCHOLAR_STATE_ROOT,
  library: process.env.PI_SCHOLAR_LIBRARY_ROOT,
  obsidian: process.env.PI_SCHOLAR_OBSIDIAN_ROOT,
};

try {
  await Promise.all([
    cp(installedExtension, copiedExtension, { recursive: true }),
    mkdir(library, { recursive: true }),
    mkdir(vault, { recursive: true }),
    mkdir(stateRoot, { recursive: true }),
  ]);
  await writeFile(join(library, sourceName), syntheticPdf());

  const copiedIndex = join(copiedExtension, "index.ts");
  const source = await readFile(copiedIndex, "utf8");
  const marker = "  const toolController = createScholarToolController({";
  assert.equal(source.split(marker).length, 2, "test-hook injection marker must occur exactly once");
  const instrumented = source.replace(
    marker,
    `  (globalThis as any)[${JSON.stringify(hookName)}] = { acquireInputLock, releaseAllInputLocks };\n\n${marker}`,
  );
  await writeFile(copiedIndex, instrumented, "utf8");

  process.env.PI_SCHOLAR_STATE_ROOT = stateRoot;
  process.env.PI_SCHOLAR_LIBRARY_ROOT = library;
  process.env.PI_SCHOLAR_OBSIDIAN_ROOT = vault;

  async function harness({ draft, failSend = false, initialBranch = [] } = {}) {
    const timeline = [];
    const branch = structuredClone(initialBranch);
    const sent = [];
    const runtime = createExtensionRuntime();
    const ui = createUi(draft || "unsent draft", timeline);
    let aborts = 0;
    let counter = 0;
    runtime.appendEntry = (customType, data) => {
      const entry = { type: "custom", id: `entry-${++counter}`, customType, data };
      branch.push(entry);
      return entry;
    };
    runtime.refreshTools = () => {};
    let activeTools = ["read", "bash"];
    runtime.getActiveTools = () => [...activeTools];
    runtime.setActiveTools = (names) => { activeTools = [...names]; };
    runtime.sendUserMessage = () => {};
    runtime.sendMessage = (message, options) => {
      timeline.push({ type: "send", locked: ui.isLocked(), message, options });
      if (failSend) throw new Error("forced kickoff send failure");
      sent.push({ message, options });
    };
    const loaded = await loadExtensions([copiedIndex], tempRoot, undefined, runtime);
    assert.deepEqual(loaded.errors, [], `extension load failed: ${loaded.errors.map((item) => item.error).join("; ")}`);
    assert.equal(loaded.extensions.length, 1, "exactly one extension should load");
    const extension = loaded.extensions[0];
    const ctx = {
      cwd: tempRoot,
      hasUI: true,
      isIdle: () => true,
      abort: () => { aborts += 1; },
      sessionManager: {
        getSessionId: () => "scholar-input-lock-verifier",
        getSessionFile: () => join(tempRoot, "session.jsonl"),
        getEntries: () => branch,
        getBranch: () => branch,
      },
      ui,
    };
    await fire(extension, "session_start", {}, ctx);
    return {
      extension,
      ctx,
      ui,
      sent,
      branch,
      timeline,
      runtime,
      command: extension.commands.get("scholar"),
      get aborts() { return aborts; },
      hook: globalThis[hookName],
    };
  }

  const success = await harness({ draft: "keep this unsent draft" });
  assert.ok(success.command, "Scholar command must be registered");
  await prove("ordinary Pi turns leave Scholar dormant", async () => {
    assert.deepEqual(success.timeline, []);
    assert.equal(success.extension.tools.size, 0);
    await fire(success.extension, "before_agent_start", { systemPrompt: "ORDINARY" }, success.ctx);
    await fire(success.extension, "input", { text: "hello", source: "interactive" }, success.ctx);
    await fire(success.extension, "message_end", { message: { role: "assistant", content: [{ type: "text", text: "Hello" }] } }, success.ctx);
    await fire(success.extension, "agent_settled", {}, success.ctx);
    await fire(success.extension, "session_shutdown", {}, success.ctx);
    assert.deepEqual(success.timeline, []);
    assert.deepEqual(success.branch, []);
    assert.deepEqual(await readdir(vault), []);
    assert.deepEqual(await readdir(stateRoot), []);
  }, "no editor/status changes, tools, vault files, or session writes before opening");
  await success.command.handler(`open "${sourceName}"`, success.ctx);

  await prove(
    "lock installs before book loading",
    () => {
      const inspect = success.ui.notifications.find((item) => item.message.startsWith("Inspecting "));
      assert.ok(inspect, "first open should inspect the PDF");
      assert.equal(inspect.locked, true, "the locked factory must already own the editor during inspection");
      const inspectIndex = success.timeline.findIndex((item) => item.type === "notify" && item.message.startsWith("Inspecting "));
      assert.ok(success.timeline.slice(0, inspectIndex).some((item) => item.type === "factory" && item.locked));
    },
    "the mocked Pi UI observed the locked factory before the Inspecting phase",
  );

  const setupFactory = success.ui.currentFactory;
  const setupEditor = success.ui.currentEditor;
  await fire(success.extension, "before_agent_start", { systemPrompt: "BASE" }, success.ctx);
  await prove(
    "lock remains through the setup agent turn",
    () => {
      assert.equal(success.sent.length, 1);
      assert.equal(success.timeline.find((item) => item.type === "send")?.locked, true);
      assert.equal(success.ui.currentFactory, setupFactory);
      assert.notEqual(setupFactory, success.ui.priorFactory);
    },
    "the kickoff was sent under the lock and before_agent_start did not release it",
  );

  await prove(
    "setup run fences slash-command navigation",
    async () => {
      const sentBefore = success.sent.length;
      const branchBefore = success.branch.length;
      await success.command.handler("close", success.ctx);
      assert.equal(success.sent.length, sentBefore);
      assert.equal(success.branch.length, branchBefore);
      assert.ok(success.ui.notifications.some((item) => /navigation is locked/i.test(item.message)));
      assert.equal(success.ui.currentFactory, setupFactory);
    },
    "a direct command invocation could not close or retarget Scholar while setup owned the editor",
  );

  await prove(
    "locked editor swallows typing and submission",
    () => {
      const before = setupEditor.getText();
      setupEditor.handleInput("printable text");
      setupEditor.handleInput("\r");
      assert.equal(setupEditor.getText(), before);
      assert.equal(success.ui.submits, 0);
      const rendered = setupEditor.render(80);
      assert.equal(rendered.length, 1);
      assert.match(rendered[0], /input paused/i);
    },
    "printable input and Enter changed no text, submitted nothing, and the pause UI stayed one line",
  );

  await prove(
    "interrupt bindings still abort",
    () => {
      setupEditor.handleInput("configured-interrupt");
      setupEditor.handleInput("\x1b");
      assert.equal(success.aborts, 2);
      assert.equal(success.ui.currentFactory, setupFactory);
    },
    "both configured app.interrupt and raw Esc called ctx.abort without unlocking early",
  );

  await prove(
    "successful agent_settled restores the exact editor factory and draft",
    async () => {
      assert.equal(setupEditor.getText(), "keep this unsent draft");
      await fire(success.extension, "agent_settled", { type: "agent_settled" }, success.ctx);
      assert.equal(success.ui.currentFactory, success.ui.priorFactory);
      assert.equal(success.ui.currentEditor.getText(), "keep this unsent draft");
    },
    "Pi's factory swap contract transferred the old draft into the lock and back into the prior factory",
  );


  await prove(
    "paused setup cannot use the still-registered source tool",
    async () => {
      const tool = success.extension.tools.get("scholar")?.definition;
      assert.ok(tool, "setup must register the Scholar source tool");
      const result = await tool.execute(
        "idle-setup-read",
        { action: "read", startPage: 1, endPage: 1 },
        new AbortController().signal,
        () => {},
        success.ctx,
      );
      assert.equal(result.details?.tone, "retry");
      assert.match(result.content?.[0]?.text || "", /no active operation/i);
    },
    "after setup settled without validation, a model tool call failed closed instead of reading the PDF",
  );

  const failed = await harness({ draft: "failure-path draft", failSend: true });
  await failed.command.handler(`open "${sourceName}"`, failed.ctx);
  await prove(
    "setup failure restores",
    () => {
      assert.ok(failed.ui.notifications.some((item) => /forced kickoff send failure/.test(item.message)));
      assert.equal(failed.timeline.find((item) => item.type === "send")?.locked, true);
      assert.equal(failed.ui.currentFactory, failed.ui.priorFactory);
      assert.equal(failed.ui.currentEditor.getText(), "failure-path draft");
    },
    "a synchronous kickoff failure released both nested lock tokens and preserved the draft",
  );

  const shutdown = await harness({ draft: "shutdown-path draft" });
  await shutdown.command.handler(`open "${sourceName}"`, shutdown.ctx);
  assert.notEqual(shutdown.ui.currentFactory, shutdown.ui.priorFactory, "setup must still be locked before shutdown");
  await fire(shutdown.extension, "session_shutdown", { type: "session_shutdown" }, shutdown.ctx);
  await prove(
    "session shutdown restores",
    () => {
      assert.equal(shutdown.ui.currentFactory, shutdown.ui.priorFactory);
      assert.equal(shutdown.ui.currentEditor.getText(), "shutdown-path draft");
    },
    "session_shutdown released the setup token and the all-locks fallback restored the prior editor",
  );

  const stale = await harness({ draft: "stale-release draft" });
  assert.equal(typeof stale.hook?.acquireInputLock, "function", "instrumented test hook must expose the real helper");
  const staleRelease = stale.hook.acquireInputLock(stale.ctx, "old operation");
  stale.hook.releaseAllInputLocks();
  assert.equal(stale.ui.currentFactory, stale.ui.priorFactory);
  const laterRelease = stale.hook.acquireInputLock(stale.ctx, "later operation");
  const laterFactory = stale.ui.currentFactory;
  staleRelease();
  await prove(
    "stale release cannot unlock a later lock",
    () => {
      assert.notEqual(laterFactory, stale.ui.priorFactory);
      assert.equal(stale.ui.currentFactory, laterFactory);
      assert.equal(stale.ui.currentEditor.getText(), "stale-release draft");
      laterRelease();
      assert.equal(stale.ui.currentFactory, stale.ui.priorFactory);
      assert.equal(stale.ui.currentEditor.getText(), "stale-release draft");
    },
    "an old token cleared by releaseAll was harmless after a newer token acquired editor ownership",
  );

  const bookFiles = await filesNamed(join(vault, "Scholar", "Books"), "book.json");
  assert.equal(bookFiles.length, 1, "the disposable vault should contain one authoritative book.json");
  const readyBook = JSON.parse(await readFile(bookFiles[0], "utf8"));
  const readyAt = new Date().toISOString();
  readyBook.revision += 1;
  readyBook.outlineStatus = "ready";
  readyBook.chapters = [{
    id: "chapter-001",
    order: 1,
    number: "1",
    title: "Loading",
    startPage: 1,
    endPage: 1,
    status: "not-started",
    sections: [{
      id: "chapter-001-section-001",
      order: 1,
      number: "1.1",
      title: "Editor ownership",
      startPage: 1,
      endPage: 1,
      objectives: ["Explain editor ownership during a Scholar turn"],
      coveredObjectives: [],
      requiredChecks: ["conceptual"],
      status: "not-started",
      keyPoints: [],
      misconceptions: [],
      attempts: [],
      transcript: [],
      createdAt: readyAt,
      updatedAt: readyAt,
    }],
  }];
  delete readyBook.currentSectionId;
  readyBook.exams = [];
  delete readyBook.currentExamId;
  readyBook.tutorSessions = [];
  delete readyBook.currentTutorId;
  readyBook.updatedAt = readyAt;
  await writeFile(bookFiles[0], JSON.stringify(readyBook), "utf8");

  const readySelected = await harness({ draft: "ready no-mode draft" });
  await readySelected.command.handler(`open "${sourceName}"`, readySelected.ctx);
  assert.equal(readySelected.ui.currentFactory, readySelected.ui.priorFactory, "ready open should finish its scoped lock");
  const unrelatedPrompt = await fire(
    readySelected.extension,
    "before_agent_start",
    { systemPrompt: "UNRELATED" },
    readySelected.ctx,
  );
  await prove(
    "selected ready book without a mode does not lock unrelated Pi turns",
    () => {
      assert.ok(unrelatedPrompt.every((value) => value === undefined));
      assert.equal(readySelected.ui.currentFactory, readySelected.ui.priorFactory);
      assert.equal(readySelected.ui.currentEditor.getText(), "ready no-mode draft");
    },
    "a selected ready book with no Learn/Exam/Tutor mode left an unrelated before_agent_start untouched",
  );

  await readySelected.command.handler('learn "1.1"', readySelected.ctx);
  const learnFactory = readySelected.ui.currentFactory;
  const learnEditor = readySelected.ui.currentEditor;
  assert.notEqual(learnFactory, readySelected.ui.priorFactory, "Learn must lock before its custom kickoff is sent");
  assert.equal(
    readySelected.timeline.find((item) => item.type === "send")?.locked,
    true,
    "Learn kickoff must be observed under the lock",
  );
  const learnPrompt = await fire(
    readySelected.extension,
    "before_agent_start",
    { systemPrompt: "LEARN BASE" },
    readySelected.ctx,
  );
  assert.equal(readySelected.ui.currentFactory, learnFactory, "before_agent_start must reuse the pre-acquired Learn lock");
  const learnInteractive = await fire(readySelected.extension, "input", {
    type: "input",
    text: "hold this Learn follow-up",
    source: "interactive",
    streamingBehavior: "steer",
  }, readySelected.ctx);
  const learnProgrammatic = await fire(readySelected.extension, "input", {
    type: "input",
    text: "programmatic Learn follow-up",
    source: "extension",
    streamingBehavior: "followUp",
  }, readySelected.ctx);
  learnEditor.handleInput("typed behind Learn");
  learnEditor.handleInput("\r");
  await prove(
    "active Learn turn locks and swallows chat input",
    () => {
      assert.ok(learnPrompt.some((value) => typeof value?.systemPrompt === "string"));
      assert.notEqual(learnFactory, readySelected.ui.priorFactory);
      assert.equal(readySelected.ui.currentFactory, learnFactory);
      assert.ok(wasHandled(learnInteractive));
      assert.ok(wasHandled(learnProgrammatic));
      assert.equal(learnEditor.getText(), "hold this Learn follow-up");
      assert.equal(readySelected.ui.submits, 0);
    },
    "the command locked before send; before_agent_start reused that lock and both queued input routes were handled",
  );

  const repeatedMarkdown = "A timestamp-distinct Scholar explanation.";
  const firstAssistant = {
    role: "assistant",
    content: [{ type: "text", text: repeatedMarkdown }],
    timestamp: 1_780_000_000_001,
  };
  const secondAssistant = {
    role: "assistant",
    content: [{ type: "text", text: repeatedMarkdown }],
    timestamp: 1_780_000_000_002,
  };
  await fire(readySelected.extension, "message_end", { type: "message_end", message: firstAssistant }, readySelected.ctx);
  readySelected.branch.push({
    type: "message",
    id: "assistant-entry-one",
    timestamp: new Date(firstAssistant.timestamp).toISOString(),
    message: firstAssistant,
  });
  await fire(readySelected.extension, "message_end", { type: "message_end", message: secondAssistant }, readySelected.ctx);
  readySelected.branch.push({
    type: "message",
    id: "assistant-entry-two",
    timestamp: new Date(secondAssistant.timestamp).toISOString(),
    message: secondAssistant,
  });
  await readySelected.command.handler("close", readySelected.ctx);
  const transcriptBook = JSON.parse(await readFile(bookFiles[0], "utf8"));
  const repeatedEntries = transcriptBook.chapters[0].sections[0].transcript
    .filter((entry) => entry.kind === "assistant" && entry.markdown === repeatedMarkdown);
  await prove(
    "message_end captures repeated assistant text without crashing or navigation duplication",
    () => {
      assert.equal(repeatedEntries.length, 2);
      assert.equal(new Set(repeatedEntries.map((entry) => entry.id)).size, 2);
      assert.ok(readySelected.ui.notifications.some((item) => /navigation is locked/i.test(item.message)));
      assert.equal(readySelected.ui.currentFactory, learnFactory, "rejected navigation must leave the Learn turn lock active");
    },
    "two identical responses produced two stable entries, while a direct command could not navigate during the active turn",
  );

  const quiz = readySelected.extension.tools.get("scholar_quiz")?.definition;
  assert.ok(quiz, "Learn mode should register the Scholar quiz modal");
  const quizInput = {
    question: "Which component owns chat input during this Scholar response?",
    options: [
      { label: "The Scholar locked editor", value: "locked" },
      { label: "The ordinary editor", value: "ordinary" },
    ],
    correctAnswer: "locked",
    explanation: "Scholar temporarily owns the main editor while its response is running.",
    shuffle: false,
    grounding: {
      purpose: "diagnostic", competency: "Identify editor ownership", sourcePages: [1],
      requiredEvidence: ["Identify which editor owns chat input"],
      basis: [{ kind: "prerequisite", value: "The source introduces editor ownership.",
        prerequisiteBasis: "source-declared", sourcePage: 1, supports: [1] }],
    },
  };
  const quizPreflight = await fire(readySelected.extension, "tool_call", {
    toolName: "scholar_quiz", toolCallId: "input-lock-modal", input: quizInput,
  }, readySelected.ctx);
  assert.ok(quizPreflight.every((result) => !result?.block), JSON.stringify(quizPreflight));
  let quizUpdate;
  const quizResult = await quiz.execute(
    "input-lock-modal",
    quizInput,
    new AbortController().signal,
    (partialResult) => {
      quizUpdate = fire(readySelected.extension, "tool_execution_update", {
        toolName: "scholar_quiz", toolCallId: "input-lock-modal", partialResult,
      }, readySelected.ctx);
    },
    readySelected.ctx,
  );
  await quizUpdate;
  await fire(readySelected.extension, "tool_result", {
    toolName: "scholar_quiz", toolCallId: "input-lock-modal", details: quizResult.details,
  }, readySelected.ctx);
  const renderedQuizResult = quiz.renderResult(quizResult, {}, readySelected.ui.theme).render(80);
  await prove(
    "Scholar quiz closes after one accepted answer without releasing the Learn lock",
    () => {
      assert.equal(quizResult.details.status, "answered");
      assert.equal(quizResult.details.correct, true);
      assert.equal(readySelected.ui.customCalls.length, 1);
      assert.equal(readySelected.ui.customCalls[0].locked, true);
      assert.ok(readySelected.ui.customCalls[0].initialLines.length > 2);
      assert.equal(readySelected.ui.customCalls[0].finishedAfterAnswer, true);
      assert.match(quizResult.content[0].text, /User answered correctly/);
      assert.match(quizResult.content[0].text, /Scholar temporarily owns the main editor/);
      assert.ok(renderedQuizResult.some((line) => /Correct!/i.test(line)));
      assert.ok(renderedQuizResult.some((line) => /Scholar temporarily owns the main editor/i.test(line)));
      assert.equal(readySelected.ui.currentFactory, learnFactory);
    },
    "one Enter resolved the custom overlay with recorded feedback while the still-running Scholar turn kept its editor lock",
  );

  await prove(
    "finalized MCQ ignores duplicate results and late presentation updates",
    async () => {
      const finalized = JSON.parse(await readFile(bookFiles[0], "utf8")).chapters[0].sections[0];
      const attempt = finalized.attempts.find((item) => item.toolCallId === "input-lock-modal");
      assert.equal(attempt?.outcome, "pass");
      assert.match(attempt.correctAnswer, /The Scholar locked editor/);
      assert.equal(attempt.feedback, quizInput.explanation);
      const changedOptions = [{ index: 1, label: "Late replacement A" }, { index: 2, label: "Late replacement B" }];
      await fire(readySelected.extension, "tool_execution_update", {
        toolName: "scholar_quiz", toolCallId: "input-lock-modal",
        partialResult: { details: { options: changedOptions } },
      }, readySelected.ctx);
      await fire(readySelected.extension, "tool_result", {
        toolName: "scholar_quiz", toolCallId: "input-lock-modal", details: quizResult.details,
      }, readySelected.ctx);
      await fire(readySelected.extension, "tool_result", {
        toolName: "scholar_quiz", toolCallId: "input-lock-modal",
        details: { ...quizResult.details, correct: false, correctIndices: [2],
          options: changedOptions, explanation: "Late conflicting feedback" },
      }, readySelected.ctx);
      const after = JSON.parse(await readFile(bookFiles[0], "utf8")).chapters[0].sections[0];
      assert.deepEqual(after.attempts, finalized.attempts);
      assert.deepEqual(after.transcript, finalized.transcript);
      assert.equal(after.attempts.filter((item) => item.toolCallId === "input-lock-modal").length, 1);
      assert.equal(after.transcript.filter((item) => item.id === "quiz-result-input-lock-modal").length, 1);
      assert.equal(readySelected.ui.currentFactory, learnFactory);
    },
    "the persisted answer, options, explanation, and transcript stayed exact after repeated and conflicting late events",
  );

  await fire(readySelected.extension, "agent_settled", { type: "agent_settled" }, readySelected.ctx);
  await prove(
    "active Learn turn restores on settle",
    () => {
      assert.equal(readySelected.ui.currentFactory, readySelected.ui.priorFactory);
      assert.equal(readySelected.ui.currentEditor.getText(), "hold this Learn follow-up");
    },
    "agent_settled restored the exact prior factory and the held interactive follow-up",
  );

  const examTurn = await harness({ draft: "exam turn draft" });
  await examTurn.command.handler('exam "1"', examTurn.ctx);
  const examFactory = examTurn.ui.currentFactory;
  const examEditor = examTurn.ui.currentEditor;
  assert.notEqual(examFactory, examTurn.ui.priorFactory, "Exam must lock before its custom kickoff is sent");
  assert.equal(examTurn.timeline.find((item) => item.type === "send")?.locked, true);
  const examPrompt = await fire(
    examTurn.extension,
    "before_agent_start",
    { systemPrompt: "EXAM BASE" },
    examTurn.ctx,
  );
  assert.equal(examTurn.ui.currentFactory, examFactory, "before_agent_start must reuse the pre-acquired Exam lock");
  const examInteractive = await fire(examTurn.extension, "input", {
    type: "input",
    text: "hold this Exam follow-up",
    source: "interactive",
    streamingBehavior: "steer",
  }, examTurn.ctx);
  const examProgrammatic = await fire(examTurn.extension, "input", {
    type: "input",
    text: "programmatic Exam follow-up",
    source: "extension",
    streamingBehavior: "followUp",
  }, examTurn.ctx);
  examEditor.handleInput("typed behind Exam");
  examEditor.handleInput("\r");
  await prove(
    "active Exam turn locks and restores on settle",
    async () => {
      assert.ok(examPrompt.some((value) => typeof value?.systemPrompt === "string"));
      assert.notEqual(examFactory, examTurn.ui.priorFactory);
      assert.ok(wasHandled(examInteractive));
      assert.ok(wasHandled(examProgrammatic));
      assert.equal(examEditor.getText(), "hold this Exam follow-up");
      assert.equal(examTurn.ui.submits, 0);
      await fire(examTurn.extension, "agent_settled", { type: "agent_settled" }, examTurn.ctx);
      assert.equal(examTurn.ui.currentFactory, examTurn.ui.priorFactory);
      assert.equal(examTurn.ui.currentEditor.getText(), "hold this Exam follow-up");
    },
    "a representative non-Learn mode blocked both chat routes, swallowed typing/Enter, and restored on settle",
  );

  const tutorTurn = await harness({ draft: "tutor turn draft" });
  await tutorTurn.command.handler('tutor "1.1"', tutorTurn.ctx);
  const tutorFactory = tutorTurn.ui.currentFactory;
  const tutorEditor = tutorTurn.ui.currentEditor;
  const tutorInteractive = await fire(tutorTurn.extension, "input", {
    type: "input",
    text: "hold this Tutor follow-up",
    source: "interactive",
    streamingBehavior: "steer",
  }, tutorTurn.ctx);
  tutorEditor.handleInput("typed behind Tutor");
  tutorEditor.handleInput("\r");
  await prove(
    "Tutor command locks before custom kickoff without relying on before_agent_start",
    async () => {
      assert.notEqual(tutorFactory, tutorTurn.ui.priorFactory);
      assert.equal(tutorTurn.timeline.find((item) => item.type === "send")?.locked, true);
      assert.ok(wasHandled(tutorInteractive));
      assert.equal(tutorEditor.getText(), "hold this Tutor follow-up");
      assert.equal(tutorTurn.ui.submits, 0);
      await fire(tutorTurn.extension, "agent_settled", { type: "agent_settled" }, tutorTurn.ctx);
      assert.equal(tutorTurn.ui.currentFactory, tutorTurn.ui.priorFactory);
      assert.equal(tutorTurn.ui.currentEditor.getText(), "hold this Tutor follow-up");
    },
    "the Tutor kickoff was locked at send time and stayed locked until agent_settled even with no before_agent_start event",
  );

  const failedMode = await harness({ draft: "mode failure draft", failSend: true });
  await failedMode.command.handler('learn "1.1"', failedMode.ctx);
  await prove(
    "mode kickoff failure restores the editor",
    () => {
      assert.ok(failedMode.ui.notifications.some((item) => /forced kickoff send failure/.test(item.message)));
      assert.equal(failedMode.timeline.find((item) => item.type === "send")?.locked, true);
      assert.equal(failedMode.ui.currentFactory, failedMode.ui.priorFactory);
      assert.equal(failedMode.ui.currentEditor.getText(), "mode failure draft");
      const pointer = [...failedMode.branch].reverse().find((entry) => entry.customType === "scholar-active-v3")?.data;
      assert.equal(pointer?.active, true);
      assert.equal(pointer?.mode, undefined);
    },
    "a synchronous Learn kickoff failure released its lock, preserved the draft, and demoted navigation to selected",
  );

  await prove("resumed lessons recover only study history after an explicit command", async () => {
    const priorBranch = [...structuredClone(readySelected.branch), {
      type: "message", id: "missed-study-response", timestamp: new Date().toISOString(),
      message: { role: "assistant", content: [{ type: "text", text: "STUDY_HISTORY_TO_RECOVER" }] },
    }];
    const resumed = await harness({ initialBranch: priorBranch, draft: "ordinary draft" });
    assert.deepEqual(resumed.timeline, []);
    assert.equal(resumed.extension.tools.size, 0);
    assert.equal(resumed.branch.at(-1).data.active, false);
    resumed.branch.push({ type: "message", id: "ordinary-response", timestamp: new Date().toISOString(),
      message: { role: "assistant", content: [{ type: "text", text: "ORDINARY_CHAT_MUST_STAY_OUT" }] } });
    await fire(resumed.extension, "agent_settled", {}, resumed.ctx);
    assert.deepEqual(resumed.timeline, []);
    await resumed.command.handler('learn "1.1"', resumed.ctx);
    const history = JSON.parse(await readFile(bookFiles[0], "utf8")).chapters[0].sections[0].transcript;
    assert.ok(history.some((entry) => entry.markdown.includes("STUDY_HISTORY_TO_RECOVER")));
    assert.ok(history.every((entry) => !entry.markdown.includes("ORDINARY_CHAT_MUST_STAY_OUT")));
    assert.ok(resumed.runtime.getActiveTools().includes("scholar_quiz"));
    await fire(resumed.extension, "agent_settled", {}, resumed.ctx);
    resumed.runtime.setActiveTools([...resumed.runtime.getActiveTools(), "another_extension_tool"]);
    await resumed.command.handler("close", resumed.ctx);
    assert.deepEqual(resumed.runtime.getActiveTools(), ["read", "bash", "another_extension_tool"]);
    const before = [...resumed.timeline];
    const saved = await readFile(bookFiles[0], "utf8");
    await fire(resumed.extension, "input", { text: "ordinary", source: "interactive" }, resumed.ctx);
    await fire(resumed.extension, "before_agent_start", { systemPrompt: "ORDINARY" }, resumed.ctx);
    await fire(resumed.extension, "agent_settled", {}, resumed.ctx);
    assert.deepEqual(resumed.timeline, before);
    assert.equal(await readFile(bookFiles[0], "utf8"), saved);
    await resumed.command.handler('learn "1.1"', resumed.ctx);
    assert.ok(resumed.runtime.getActiveTools().includes("scholar_quiz"));
    assert.ok(resumed.runtime.getActiveTools().includes("another_extension_tool"));
    assert.equal(resumed.extension.tools.size, 2);
    await fire(resumed.extension, "agent_settled", {}, resumed.ctx);
    await resumed.command.handler("close", resumed.ctx);
  }, "recovery excludes intervening ordinary chat; close disables only Scholar tools and reopening reuses them");

  const pendingBook = JSON.parse(await readFile(bookFiles[0], "utf8"));
  pendingBook.revision += 1;
  pendingBook.outlineStatus = "pending";
  pendingBook.exams = [];
  pendingBook.tutorSessions = [];
  delete pendingBook.currentExamId;
  delete pendingBook.currentTutorId;
  delete pendingBook.currentSectionId;
  for (const chapter of pendingBook.chapters) {
    chapter.status = "not-started";
    for (const section of chapter.sections) {
      section.status = "not-started";
      section.attempts = [];
      section.transcript = [];
    }
  }
  await writeFile(bookFiles[0], JSON.stringify(pendingBook), "utf8");
  const restoredSetup = await harness({
    draft: "restored setup draft",
    initialBranch: [{
      type: "custom",
      customType: "scholar-active-v3",
      data: { active: true, bookId: pendingBook.id, instanceId: pendingBook.instanceId },
    }],
  });
  await prove(
    "restored pending setup stays dormant until explicitly reopened",
    async () => {
      assert.equal(restoredSetup.sent.length, 0);
      assert.deepEqual(restoredSetup.timeline, []);
      assert.equal(restoredSetup.extension.tools.size, 0);
      assert.equal(restoredSetup.branch.at(-1).data.active, false);
      assert.deepEqual(await fire(restoredSetup.extension, "before_agent_start", { systemPrompt: "ORDINARY" }, restoredSetup.ctx), [undefined]);
      await fire(restoredSetup.extension, "agent_settled", {}, restoredSetup.ctx);
      assert.deepEqual(restoredSetup.timeline, []);
      await restoredSetup.command.handler(`open "${sourceName}"`, restoredSetup.ctx);
      assert.equal(restoredSetup.sent.length, 1);
      assert.notEqual(restoredSetup.ui.currentFactory, restoredSetup.ui.priorFactory);
      assert.equal(restoredSetup.timeline.find((item) => item.type === "send")?.locked, true);
      const prompt = await fire(restoredSetup.extension, "before_agent_start", { systemPrompt: "RESTORE" }, restoredSetup.ctx);
      assert.ok(prompt.some((value) => /book setup is active/i.test(value?.systemPrompt || "")));
      await fire(restoredSetup.extension, "agent_settled", {}, restoredSetup.ctx);
      assert.equal(restoredSetup.ui.currentFactory, restoredSetup.ui.priorFactory);
      assert.equal(restoredSetup.ui.currentEditor.getText(), "restored setup draft");
    },
    "a saved pending book starts no work until /scholar open, then uses the existing input lock",
  );

  const blankVault = join(tempRoot, "blank-vault");
  await mkdir(blankVault, { recursive: true });
  await restoredSetup.command.handler(`obsidian "${blankVault}"`, restoredSetup.ctx);
  await restoredSetup.command.handler(`library "${library}"`, restoredSetup.ctx);
  await prove(
    "navigation never opens a PDF implicitly",
    async () => {
      const sentBefore = restoredSetup.sent.length;
      await restoredSetup.command.handler('learn "chapter 1"', restoredSetup.ctx);
      assert.equal(restoredSetup.sent.length, sentBefore);
      assert.ok(restoredSetup.ui.notifications.some((item) => /no selected book.*open one explicitly/i.test(item.message)));
      const authorities = await filesNamed(join(blankVault, "Scholar", "Books"), "book.json")
        .catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error));
      assert.equal(authorities.length, 0);
    },
    "Learn stopped with one explicit /scholar open instruction and created no book authority",
  );
  await prove(
    "no-argument commands reject trailing input",
    async () => {
      const before = restoredSetup.branch.length;
      await restoredSetup.command.handler("close unexpected", restoredSetup.ctx);
      assert.equal(restoredSetup.branch.length, before);
      assert.ok(restoredSetup.ui.notifications.some((item) => /invalid Scholar command/i.test(item.message)));
    },
    "a malformed close command could not change the active session pointer",
  );

  console.log(`\n${results.length} focused Scholar input-lock checks passed.`);
} finally {
  if (originalEnvironment.state === undefined) delete process.env.PI_SCHOLAR_STATE_ROOT;
  else process.env.PI_SCHOLAR_STATE_ROOT = originalEnvironment.state;
  if (originalEnvironment.library === undefined) delete process.env.PI_SCHOLAR_LIBRARY_ROOT;
  else process.env.PI_SCHOLAR_LIBRARY_ROOT = originalEnvironment.library;
  if (originalEnvironment.obsidian === undefined) delete process.env.PI_SCHOLAR_OBSIDIAN_ROOT;
  else process.env.PI_SCHOLAR_OBSIDIAN_ROOT = originalEnvironment.obsidian;
  delete globalThis[hookName];
  await rm(tempRoot, { recursive: true, force: true });
}
