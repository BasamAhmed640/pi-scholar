// Exercise real quiz UI, extension events, schema, storage, and Learn/Tutor projection.
// Only the Pi host is stubbed; all book state and notes use a disposable vault.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const requested = packagedExtensionPath;
const extension = basename(requested).toLowerCase() === "index.ts" ? dirname(requested) : requested;
const packageRoot = sdkRoot;
const piRequire = createRequire(join(packageRoot, "package.json"));
const { createJiti } = await import(pathToFileURL(sdkJitiPath).href);
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: {
  "@earendil-works/pi-coding-agent": join(packageRoot, "dist", "index.js"),
  "@earendil-works/pi-tui": piRequire.resolve("@earendil-works/pi-tui"), typebox: piRequire.resolve("typebox"),
} });
const storage = await jiti.import(join(extension, "storage.ts"));
const projection = await jiti.import(join(extension, "obsidian.ts"));
const schema = await jiti.import(join(extension, "state-schema.ts"));
const contract = await jiti.import(join(extension, "quiz-contract.ts"));
const { handleAssess } = await jiti.import(join(extension, "tool-actions/learning.ts"));
const { ScholarRuntimeCoordinator } = await jiti.import(join(extension, "runtime-coordinator.ts"));
const { default: install } = await jiti.import(join(extension, "index.ts"));
const temporaryParent = resolve(tmpdir());
const root = await mkdtemp(join(temporaryParent, "scholar-answer-feedback-"));
const environment = new Map(["PI_SCHOLAR_LIBRARY_ROOT", "PI_SCHOLAR_OBSIDIAN_ROOT", "PI_SCHOLAR_STATE_ROOT"].map((key) => [key, process.env[key]]));
const now = "2026-09-04T12:00:00.000Z";
const config = { schemaVersion: 3, libraryRoot: join(root, "Library"), obsidianRoot: join(root, "Vault"), stateRoot: join(root, "State"), updatedAt: now };
const keyPoint = "A mechanism connects an assumption to a prediction.";
const id = "c".repeat(64);
const book = { schemaVersion: 3, revision: 0, id, instanceId: "answer-feedback-fixture", source: {
  absolutePath: join(config.libraryRoot, "Fixture.pdf"), relativePath: "Fixture.pdf", fileName: "Fixture.pdf", format: "pdf",
  fingerprint: { sha256: id, size: 1, mtimeMs: 1 },
}, metadata: { title: "Answer Feedback Fixture", authors: [], pageCount: 1 }, outlineStatus: "ready",
  chapters: [{ id: "chapter-1", number: "1", title: "Mechanisms", order: 1, startPage: 1, endPage: 1, status: "learning", sections: [{
    id: "section-1", number: "1.1", title: "Prediction", order: 1, startPage: 1, endPage: 1,
    objectives: ["Explain a prediction"], coveredObjectives: ["Explain a prediction"], requiredChecks: ["conceptual", "application"], status: "learning",
    synthesis: "A mechanism connects assumptions to predicted observations and supports a checkable explanation.",
    keyPoints: [keyPoint], misconceptions: [], attempts: [], transcript: [], createdAt: now, updatedAt: now,
    figureCoverage: { pages: [{ page: 1, read: true, viewed: { width: 600, height: 800 }, candidates: [],
      review: { page: 1, observation: "The fixture page contains no source figures.", figures: [] } }], boundaryChecked: 1 },
  }] }], exams: [], tutorSessions: [{ id: "tutor-1", title: "Mechanism Practice", status: "active", scope: {
    chapterIds: ["chapter-1"], sectionIds: ["section-1"], description: "Mechanisms",
  }, keyPoints: [keyPoint], attempts: [], transcript: [], createdAt: now, updatedAt: now }],
  noteDirectory: "Answer Feedback Fixture", createdAt: now, updatedAt: now };
const grounding = { purpose: "practice", competency: "Explain a causal mechanism", requiredEvidence: ["Connect assumptions and prediction"],
  sourcePages: [1], basis: [{ kind: "key-point", value: keyPoint, supports: [1] }] };
let checks = 0;
const passed = (name) => { checks++; console.log(`[PASS] ${name}`); };
const load = () => storage.loadBookState(config, id);
const target = (state, mode) => mode === "learn" ? state.chapters[0].sections[0] : state.tutorSessions[0];
const recordId = (mode) => mode === "learn" ? "section-1" : "tutor-1";
const notePath = (mode) => mode === "learn"
  ? projection.sectionNotePath(config, book, book.chapters[0], book.chapters[0].sections[0])
  : projection.tutorNotePath(config, book, book.tutorSessions[0]);
const pointer = (mode) => ({ type: "custom", customType: "scholar-active-v3", data: {
  active: true, bookId: id, instanceId: book.instanceId, mode, recordId: recordId(mode), ...(mode === "learn" ? { sectionId: "section-1" } : {}),
} });

async function hostFor(mode) {
  const handlers = new Map();
  const tools = new Map();
  const commands = new Map();
  let activeTools = [];
  const branch = [pointer(mode)];
  const pi = { on: (event, handler) => handlers.set(event, [...(handlers.get(event) || []), handler]), registerCommand: (name, command) => commands.set(name, command),
    getActiveTools: () => [...activeTools], setActiveTools: (names) => { activeTools = [...names]; },
    registerTool: (tool) => tools.set(tool.name, tool), appendEntry: (customType, data) => branch.push({ type: "custom", customType, data }),
    sendMessage: () => {},
  };
  install(pi);
  let editorFactory;
  const context = { hasUI: true, sessionManager: { getBranch: () => branch, getEntries: () => branch },
    ui: { notify() {}, setStatus() {}, setWorkingMessage() {},
      setEditorComponent: (factory) => { editorFactory = factory; },
      getEditorComponent: () => editorFactory,
    },
  };
  const emit = async (name, event) => {
    for (const handler of handlers.get(name) || []) {
      const result = await handler(event, context);
      assert(!result?.block, result?.reason);
    }
  };
  await emit("session_start", {});
  assert.equal(tools.size, 0);
  await commands.get("scholar").handler(mode === "learn" ? "learn section-1" : "tutor", context);
  assert(tools.has("scholar_quiz"));
  return { context, emit, quiz: tools.get("scholar_quiz"), branch, pi, handlers };
}

try {
  process.env.PI_SCHOLAR_LIBRARY_ROOT = config.libraryRoot;
  process.env.PI_SCHOLAR_OBSIDIAN_ROOT = config.obsidianRoot;
  process.env.PI_SCHOLAR_STATE_ROOT = config.stateRoot;
  await Promise.all([mkdir(config.libraryRoot, { recursive: true }), mkdir(config.obsidianRoot, { recursive: true })]);
  await writeFile(book.source.absolutePath, "fixture");
  book.currentTutorId = "tutor-1";
  await storage.createBookState(config, book);
  // Explicit mode commands now open study; a saved Pi pointer cannot activate it.
  await storage.saveConfig({ ...config, currentBookId: id });
  await projection.renderScholarWorkspace(config, [book]);

  const gatedHost = await hostFor("learn");
  const uncovered = await load();
  delete uncovered.chapters[0].sections[0].figureCoverage;
  uncovered.revision++;
  await storage.saveBookState(config, uncovered, uncovered.revision - 1);
  const gateInput = { question: "Can this quiz start before figure review?", grounding,
    options: [{ label: "First", value: "first" }, { label: "Second", value: "second" }], correctAnswer: "second", explanation: "A test explanation.", shuffle: false };
  for (const purpose of ["practice", "mastery"]) {
    for (const handler of gatedHost.handlers.get("tool_call")) {
      const response = await handler({ toolName: "scholar_quiz", toolCallId: `missing-figures-${purpose}`, input: { ...gateInput, grounding: { ...grounding, purpose } } }, gatedHost.context);
      assert.equal(response?.block, true);
      assert.match(response.reason, /source figures|read\/view/);
    }
  }
  assert.equal(target(await load(), "learn").attempts.length, 0);
  await gatedHost.emit("tool_call", { toolName: "scholar_quiz", toolCallId: "diagnostic-before-figures", input: { ...gateInput, grounding: { ...grounding, purpose: "diagnostic" } } });
  await gatedHost.emit("tool_result", { toolName: "scholar_quiz", toolCallId: "diagnostic-before-figures", details: { status: "answered", correct: true } });
  const restored = await load();
  restored.chapters[0].sections[0].figureCoverage = structuredClone(book.chapters[0].sections[0].figureCoverage);
  restored.revision++;
  await storage.saveBookState(config, restored, restored.revision - 1);
  passed("Learn practice/mastery quiz preflight blocks missing source-figure coverage while diagnostics remain available");

  for (const mode of ["learn", "tutor"]) {
    const host = await hostFor(mode);
    for (const outcome of ["pass", "review", "unsure", "cancelled", "unavailable"]) {
      const toolCallId = `${mode}-${outcome}`;
      const explanation = `Explanation for ${toolCallId}: the mechanism supplies a testable prediction.`;
      const input = { question: `Which claim explains ${toolCallId}?`, grounding, options: [
        { label: "Repeat the label", value: "PRIVATE_SELECTED_VALUE" },
        { label: "Connect the mechanism to the prediction", value: "causal" },
      ], correctAnswer: "causal", explanation, shuffle: false };
      await host.emit("tool_call", { toolName: "scholar_quiz", toolCallId, input });
      const pending = target(await load(), mode).attempts.find((attempt) => attempt.toolCallId === toolCallId);
      assert.equal(pending.outcome, "pending");
      assert.equal(pending.correctAnswer, undefined);
      assert.equal(pending.feedback, undefined);
      let updateTask;
      const result = await host.quiz.execute(toolCallId, input, undefined, (partialResult) => {
        assert.equal(partialResult.details.correctIndices, undefined);
        assert.equal(partialResult.details.explanation, undefined);
        updateTask = host.emit("tool_execution_update", { toolName: "scholar_quiz", toolCallId, partialResult });
      }, { hasUI: outcome !== "unavailable", ui: { custom: async (factory) => {
        await updateTask;
        const before = await readFile(notePath(mode), "utf8");
        assert.match(before, /> \[!info\]- Scholar question details/);
        assert(before.includes(input.question));
        return new Promise((resolveAnswer) => {
          const component = factory({ requestRender() {} }, { fg: (_color, text) => text, bold: (text) => text }, {}, resolveAnswer);
          const rendered = component.render(100).join("\n");
          assert(!rendered.includes(explanation));
          if (outcome === "cancelled") component.handleInput("\x1b");
          else {
            const moves = outcome === "pass" ? 1 : outcome === "unsure" ? 2 : 0;
            for (let index = 0; index < moves; index++) component.handleInput("\x1b[B");
            component.handleInput("\r");
          }
        });
      } } });
      if (updateTask) await updateTask;
      if (result.details.answers?.length) result.details.answers[0].label = "PRIVATE_RAW_SELECTED_TEXT";
      await host.emit("tool_result", { toolName: "scholar_quiz", toolCallId, details: result.details });
      const state = await load();
      const resolved = target(state, mode).attempts.find((attempt) => attempt.toolCallId === toolCallId);
      const markdown = await readFile(notePath(mode), "utf8");
      assert.equal(resolved.outcome, ["cancelled", "unavailable"].includes(outcome) ? "pending" : outcome);
      if (["pass", "review", "unsure"].includes(outcome)) {
        assert.equal(resolved.correctAnswer, "2. Connect the mechanism to the prediction");
        assert.equal(resolved.feedback, explanation);
        assert(markdown.includes(resolved.correctAnswer));
        assert(markdown.includes(explanation));
      } else {
        assert.equal(resolved.correctAnswer, undefined);
        assert.match(markdown, /> \[!info\]- Scholar question details/);
      }
      assert(!JSON.stringify(state).includes("PRIVATE_RAW_SELECTED_TEXT"));
      assert(markdown.includes("PRIVATE_SELECTED_VALUE")); // Frozen option identifiers are inspectable in the same-note grading details.
      assert(!markdown.includes("PRIVATE_RAW_SELECTED_TEXT"));
      if (["cancelled", "unavailable"].includes(outcome)) {
        // Pausing is no longer a terminal result. Finish the same saved item
        // before this fixture proceeds to its next independent case.
        const resumeCall = `${toolCallId}-resume`;
        const resumeInput = { resumeAttemptId: resolved.id };
        await host.emit("tool_call", { toolName: "scholar_quiz", toolCallId: resumeCall, input: resumeInput });
        const retried = await host.quiz.execute(resumeCall, resumeInput, undefined, undefined,
          { hasUI: true, ui: { custom: async () => ({ dontKnow: true, answers: [] }) } });
        await host.emit("tool_result", { toolName: "scholar_quiz", toolCallId: resumeCall, details: retried.details });
        assert.equal(target(await load(), mode).attempts.find((attempt) => attempt.id === resolved.id).outcome, "unsure");
      }
    }
    passed(`${mode}: quiz answers persist feedback; cancelled/unavailable questions stay pending until resumed, without storing raw responses`);
  }

  const saved = await load();
  for (const mode of ["learn", "tutor"]) {
    const attempted = target(saved, mode).attempts.find((attempt) => attempt.outcome === "pass" && attempt.correctAnswer);
    const old = structuredClone(saved);
    for (const attempt of target(old, mode).attempts) delete attempt.correctAnswer;
    assert(schema.isScholarBook(old), "legacy attempts without a key remain readable");
    for (const outcome of ["pending", "cancelled", "unavailable"]) {
      const invalid = structuredClone(saved);
      target(invalid, mode).attempts.find((attempt) => attempt.id === attempted.id).outcome = outcome;
      assert(!schema.isScholarBook(invalid), "unanswered stored attempts may not carry the revealed answer field");
    }
  }
  assert.equal(contract.scholarQuizCorrectAnswer({ status: "cancelled", correctIndices: [1], options: [{ index: 1, label: "Hidden" }] }), undefined);
  assert.equal(contract.scholarQuizCorrectAnswer({ status: "answered", correctIndices: [1, 2], options: [{ index: 1, label: "Only partial key" }] }), undefined);
  assert.equal(contract.scholarQuizCorrectAnswer(contract.parseScholarQuizDetails({ status: "answered", correctIndices: [1, "bad"], options: [{ index: 1, label: "Not a complete key" }] })), undefined);
  assert.equal(contract.scholarQuizCorrectAnswer({ status: "answered", correctIndices: [3, 1], options: [{ index: 3, label: "Third" }, { index: 1, label: "First" }] }), "1. First, 3. Third");
  passed("schema remains backward compatible and rejects revealed keys on unanswered attempts; key recovery requires complete exact indices");

  for (const mode of ["learn", "tutor"]) {
    const coordinator = new ScholarRuntimeCoordinator({ appendEntry() {} }, () => () => {}, () => {});
    coordinator.setConfig(config);
    coordinator.runtimeSession.activate(id, mode, recordId(mode));
    coordinator.activeAuthority = { bookId: id, instanceId: book.instanceId };
    const toolResult = (action, summary, details) => ({ content: [{ type: "text", text: summary }], details: { action, summary, ...details } });
    const openId = `${mode}-open`;
    const prepared = await handleAssess(await load(), coordinator.runtimeSession, openId,
      { outcome: "pending", kind: "conceptual", question: `Explain the mechanism in ${mode}.`, grounding },
      (state) => state.chapters[0].sections[0], coordinator.mutateBook, toolResult);
    const feedback = `Open ${mode} feedback: identify the assumption, trace the mechanism, and justify its predicted observation.`;
    await handleAssess(await load(), coordinator.runtimeSession, `${openId}-resolve`,
      { attemptId: prepared.details.attemptId, outcome: "review", feedback },
      (state) => state.chapters[0].sections[0], coordinator.mutateBook, toolResult);
    const attempt = target(await load(), mode).attempts.find((item) => item.id === prepared.details.attemptId);
    assert.equal(attempt.correctAnswer, undefined);
    assert.equal(attempt.feedback, feedback);
    assert((await readFile(notePath(mode), "utf8")).includes(feedback));

    const before = await load();
    const beforeMarkdown = await readFile(notePath(mode), "utf8");
    const history = [pointer(mode), ...["pass", "review", "unsure", "cancelled"].flatMap((outcome) => {
      const toolCallId = `${mode}-${outcome}`;
      return [{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "scholar_quiz", id: toolCallId,
        arguments: { question: `Which claim explains ${toolCallId}?`, options: [{ label: "Unshuffled first" }, { label: "Unshuffled second" }] } }] } },
      { type: "message", message: { role: "toolResult", toolName: "scholar_quiz", toolCallId, details: {
        status: outcome === "cancelled" ? "cancelled" : "answered", correct: outcome === "pass",
        ...(outcome === "pass" ? { options: [{ index: 1, label: "Repeat the label" }, { index: 2, label: "Connect the mechanism to the prediction" }] } : {}),
        ...(outcome !== "review" ? { correctIndices: [2] } : {}),
        answers: [{ index: 1, label: "PRIVATE_HISTORY_RESPONSE", value: "private" }], explanation: outcome === "cancelled" ? "CANCELLED_SECRET_EXPLANATION" : "Exact historical explanation.",
      } } }];
    })];
    await coordinator.backfillActiveBranch({ sessionManager: { getBranch: () => history } });
    assert.deepEqual(await load(), before, "conversation history cannot change the visible study record");
    const markdown = await readFile(notePath(mode), "utf8");
    assert.equal(markdown, beforeMarkdown);
    assert(!markdown.includes("PRIVATE_HISTORY_RESPONSE"));
    assert(!markdown.includes("CANCELLED_SECRET_EXPLANATION"));
    passed(`${mode}: open feedback is visible and conversation backfill cannot replace the note's answers or feedback`);
  }
  console.log(`Scholar answer feedback: ${checks} passed, 0 failed.`);
} finally {
  for (const [key, value] of environment) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  const withinTemporary = relative(temporaryParent, resolve(root));
  assert(withinTemporary && !isAbsolute(withinTemporary) && withinTemporary !== ".." && !withinTemporary.startsWith(`..${sep}`));
  assert(basename(root).startsWith("scholar-answer-feedback-"));
  await rm(root, { recursive: true, force: true });
}
import { extensionPath as packagedExtensionPath, piPackageRoot as sdkRoot, jitiPath as sdkJitiPath } from "./sdk.mjs";
