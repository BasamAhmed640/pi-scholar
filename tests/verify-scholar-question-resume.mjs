import { sdkAliases } from "./sdk.mjs";
import assert from "node:assert/strict";
import { saveFixtureLesson } from "./lesson-fixture.mjs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { extensionPath, piPackageRoot, jitiPath, resolvePiDependency } from "./sdk.mjs";

const { createJiti } = await import(pathToFileURL(jitiPath));
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: { ...sdkAliases,
  "@earendil-works/pi-coding-agent": join(piPackageRoot, "dist/index.js"),
  "@earendil-works/pi-tui": resolvePiDependency("@earendil-works/pi-tui"), typebox: resolvePiDependency("typebox"),
} });
const mod = (file) => jiti.import(join(dirname(extensionPath), file));
const { default: install } = await mod("index.ts");
const storage = await mod("storage.ts");
const domain = await mod("domain.ts");
const { createScholarQuizHost } = await mod("quiz-host.ts");
const { createBookService } = await mod("book-service.ts");
const { renderScholarWorkspace, sectionNotePath, tutorNotePath } = await mod("obsidian.ts");
const { recoverTranscriptTarget } = await mod("transcript-recovery.ts");
const { handleAssess } = await mod("tool-actions/learning.ts");
const { OpenResponseGate } = await mod("open-assessment.ts");
const lessonModule = await mod("lesson.ts");
const { ScholarRuntimeSession } = await mod("runtime-session.ts");
const { kickoffMessage } = await mod("runtime-coordinator.ts");
const root = await mkdtemp(join(tmpdir(), "scholar-question-resume-"));
const now = "2026-01-01T00:00:00.000Z";
const config = { schemaVersion: 3, libraryRoot: join(root, "lib"), obsidianRoot: join(root, "vault"), stateRoot: join(root, "state"), updatedAt: now };
process.env.PI_SCHOLAR_LIBRARY_ROOT = config.libraryRoot;
process.env.PI_SCHOLAR_OBSIDIAN_ROOT = config.obsidianRoot;
process.env.PI_SCHOLAR_STATE_ROOT = config.stateRoot;
const basis = "A mechanism predicts a measurable outcome";
const book = { schemaVersion: 3, revision: 0, id: "b".repeat(64), instanceId: "resume-fixture",
  source: { absolutePath: join(config.libraryRoot, "fixture.pdf"), relativePath: "fixture.pdf", fileName: "fixture.pdf", format: "pdf", fingerprint: { sha256: "b".repeat(64), size: 1, mtimeMs: 1 } },
  metadata: { title: "Resume fixture", authors: [], pageCount: 1 }, outlineStatus: "ready",
  chapters: [{ id: "c1", order: 1, title: "Mechanisms", startPage: 1, endPage: 1, status: "learning", sections: [{
    id: "s1", number: "1.1", order: 1, title: "Prediction", startPage: 1, endPage: 1, status: "learning", objectives: [basis], coveredObjectives: [basis], requiredChecks: ["conceptual"],
    synthesis: "A mechanism relates an assumption to a measurable prediction that can be checked.", keyPoints: [basis], misconceptions: [], attempts: [], transcript: [],
    figureCoverage: { pages: [{ page: 1, read: true, viewed: { width: 600, height: 800 }, candidates: [], review: { page: 1, observation: "The source page contains text only and no figures.", figures: [] } }] }, createdAt: now, updatedAt: now,
  }] }], exams: [], tutorSessions: [{ id: "t1", title: "Tutor fixture", status: "active", scope: { chapterIds: ["c1"], sectionIds: ["s1"], description: "Mechanisms" }, keyPoints: [basis], attempts: [], transcript: [], createdAt: now, updatedAt: now }],
  currentSectionId: "s1", currentTutorId: "t1", noteDirectory: "Resume fixture", createdAt: now, updatedAt: now,
};
const grounding = { purpose: "practice", competency: basis, requiredEvidence: ["Predict the outcome"], sourcePages: [1], basis: [{ kind: "key-point", value: basis, supports: [1] }] };
saveFixtureLesson(lessonModule, book, book.chapters[0].sections[0]);
saveFixtureLesson(lessonModule, book, book.tutorSessions[0]);
const openContract = { expectedAnswer: "The governing relation connects the mechanism to its measurable outcome.", criteria: ["Connect the mechanism to the predicted outcome."] };
const read = () => storage.loadBookState(config, book.id);
const target = (state, mode) => mode === "learn" ? state.chapters[0].sections[0] : state.tutorSessions[0];
const service = createBookService({ getConfig: () => config, load: storage.loadBookState, save: storage.saveBookState, list: storage.listBookStates, project: renderScholarWorkspace, onSave() {}, librarySetupMessage: "Missing source" });
const toolResult = (action, summary, details = {}) => ({ content: [{ type: "text", text: summary }], details: { action, summary, ...details } });
let checks = 0;
function pass(text) { checks++; console.log(`[PASS] ${text}`); }
async function host(mode) {
  const handlers = new Map(), tools = new Map(), commands = new Map(), sent = [], branch = [];
  let activeTools = [], editor;
  install({ on: (name, fn) => handlers.set(name, [...(handlers.get(name) || []), fn]),
    registerTool: (tool) => tools.set(tool.name, tool), registerCommand: (name, command) => commands.set(name, command),
    getActiveTools: () => activeTools, setActiveTools: (names) => { activeTools = names; },
    appendEntry: (customType, data) => branch.push({ id: `pointer-${branch.length}`, type: "custom", customType, data }),
    sendMessage: (message) => sent.push(message),
  });
  const ctx = { hasUI: true, sessionManager: { getBranch: () => branch, getEntries: () => branch },
    ui: { notify() {}, setStatus() {}, setWorkingMessage() {}, getEditorComponent: () => editor, setEditorComponent: (factory) => { editor = factory; } } };
  const fire = async (name, event) => {
    const results = [];
    for (const fn of handlers.get(name) || []) results.push(await fn(event, ctx));
    return results;
  };
  await fire("session_start", {});
  assert.equal(tools.size, 0, "a new session must remain dormant");
  await commands.get("scholar").handler(mode === "learn" ? "learn s1" : "tutor", ctx);
  assert.ok(tools.has("scholar_quiz"));
  assert.equal(tools.get("scholar_quiz").parameters.type, "object", "provider-compatible tool schema root");
  assert.equal(tools.get("scholar_quiz").parameters.anyOf, undefined);
  const call = (id, input) => fire("tool_call", { toolName: "scholar_quiz", toolCallId: id, input });
  async function execute(id, input, action, emitResult = true) {
    let update = Promise.resolve();
    const output = await tools.get("scholar_quiz").execute(id, input, undefined, (partialResult) => {
      assert.equal(partialResult.details.correctIndices, undefined);
      assert.equal(partialResult.details.explanation, undefined);
      update = fire("tool_execution_update", { toolName: "scholar_quiz", toolCallId: id, partialResult });
    }, { hasUI: action !== "unavailable", ui: { custom: async (factory) => {
      await update;
      return new Promise((done) => {
        const component = factory({ requestRender() {} }, { fg: (_color, text) => text, bold: (text) => text }, {}, done);
        assert.ok(!component.render(100).join("\n").includes("PRIVATE_EXPLANATION"));
        component.handleInput(action === "escape" ? "\x1b" : "\r");
      });
    } } });
    await update;
    if (emitResult) {
      const feedback = await fire("tool_result", { toolName: "scholar_quiz", toolCallId: id, ...output });
      if (action === "escape" || action === "unavailable") assert.match(JSON.stringify(feedback), /End this turn.*Do not reopen the picker/);
    }
    return output;
  }
  return { fire, call, execute, sent, ctx, tools };
}
try {
  await Promise.all([mkdir(config.libraryRoot), mkdir(config.obsidianRoot), mkdir(config.stateRoot)]);
  await writeFile(book.source.absolutePath, "fixture");
  await storage.createBookState(config, book);
  await storage.saveConfig({ ...config, currentBookId: book.id });
  for (const mode of ["learn", "tutor"]) {
    const h = await host(mode);
    const id = `${mode}-original`;
    const input = { question: `Which mechanism predicts ${mode}?`, details: "Use the taught relation.", kind: "conceptual", grounding,
      options: [{ value: "a", label: "Mechanism A", misconception: "Confuses the assumption with the mechanism" }, { value: "b", label: "Mechanism B", description: "Assume steady conditions." }, { value: "c", label: "Mechanism C", misconception: "Reverses the predicted causal direction" }],
      correctAnswer: "b", explanation: "PRIVATE_EXPLANATION: The governing relation selects B.", shuffle: true };
    assert.ok(!(await h.call(id, input)).some((item) => item?.block));
    let saved = await read();
    const original = structuredClone(target(saved, mode).attempts.at(-1));
    assert.ok(original.quiz, "freeze the full form before the UI can open or the process can exit");
    const replacement = await h.call(`${mode}-replacement`, { ...input, question: "A different question?" });
    assert.match(replacement.find((item) => item?.block).reason, /resumeAttemptId/);
    const active = new ScholarRuntimeSession(); active.activate(book.id, mode, mode === "learn" ? "s1" : "t1");
    await assert.rejects(handleAssess(await read(), active, `${mode}-replace-with-open`,
      { outcome: "pending", kind: "conceptual", question: "Replace the pending quiz with an explanation?", grounding, ...openContract },
      (state) => target(state, "learn"), service.mutateBook, toolResult), /resume the saved quiz/);
    await h.execute(id, input, "escape");
    saved = await read();
    assert.equal(target(saved, mode).attempts.at(-1).outcome, "pending");
    const note = mode === "learn" ? sectionNotePath(config, saved, saved.chapters[0], target(saved, mode)) : tutorNotePath(config, saved, target(saved, mode));
    assert.match(await readFile(note, "utf8"), /> \[!info\]- Scholar question details/);
    const resumed = await host(mode); // Empty new Pi branch, no original model input.
    assert.match(resumed.sent.at(-1).content, /resumeAttemptId/);
    const resume = { resumeAttemptId: original.id };
    assert.ok(!(await resumed.call(`${mode}-resume`, resume)).some((item) => item?.block));
    await resumed.execute(`${mode}-resume`, resume, "unavailable");
    assert.equal(target(await read(), mode).attempts.at(-1).outcome, "pending");
    const afterUnavailable = await host(mode);
    assert.ok(!(await afterUnavailable.call(`${mode}-answer`, resume)).some((item) => item?.block));
    const answered = await afterUnavailable.execute(`${mode}-answer`, resume, "answer");
    saved = await read();
    const settled = target(saved, mode).attempts.at(-1);
    assert.equal(target(saved, mode).attempts.length, 1);
    assert.equal(settled.id, original.id);
    assert.deepEqual(settled.quiz, original.quiz);
    assert.deepEqual(answered.details.options.map((option) => option.label), original.options);
    assert.equal(settled.outcome, original.quiz.options[0].value === "b" ? "pass" : "review");
    assert.equal(target(saved, mode).transcript.filter((entry) => entry.kind === "question").length, 0);
    assert.equal(target(saved, mode).transcript.filter((entry) => entry.kind === "result").length, 0);
    assert.ok((await readFile(note, "utf8")).includes("PRIVATE_EXPLANATION"));
    assert.ok((await afterUnavailable.call(`${mode}-regrade`, resume)).some((item) => item?.block));
    const stable = await read();
    await afterUnavailable.fire("tool_result", { toolName: "scholar_quiz", toolCallId: `${mode}-resume`, details: { status: "cancelled" } });
    assert.deepEqual(await read(), stable, "late cancellation cannot change an answered attempt");
    await assert.rejects(service.mutateBook(book.id, (state) => { target(state, mode).attempts[0].quiz.correctValues = ["a"]; }), /frozen quiz/);
    pass(`${mode}: Esc and unavailable UI preserve one question; a fresh session resumes exact choices, order and key without leaking answers`);
  }

  const setHost = await host("learn");
  const setQuestions = [1, 2, 3].map((number) => ({
    question: `Set question ${number}: which mechanism predicts the outcome?`, kind: "conceptual", grounding,
    options: [{ value: "a", label: `Mechanism A ${number}`, misconception: "Confuses the assumption with the mechanism" },
      { value: "b", label: `Mechanism B ${number}` },
      { value: "c", label: `Mechanism C ${number}`, misconception: "Reverses the causal direction" }],
    correctAnswer: "b", explanation: `PRIVATE_SET_EXPLANATION_${number}`, shuffle: false,
  }));
  assert.ok(!(await setHost.call("three-set", { questions: setQuestions })).some((item) => item?.block));
  let setState = await read();
  const originalSet = target(setState, "learn").attempts.filter((item) => item.toolCallId === "three-set");
  assert.deepEqual(originalSet.map((item) => item.id), ["quiz-three-set", "quiz-three-set-2", "quiz-three-set-3"]);
  assert.ok(originalSet.every((item) => item.outcome === "pending" && item.quizSet?.size === 3 && item.quiz));
  let selections = 0;
  const signal = new AbortController().signal;
  const rpc = { hasUI: true, mode: "rpc", ui: {
    custom() { throw new Error("RPC must not open a custom picker"); },
    select: async (_title, choices, options) => { assert.equal(options.signal, signal); return ++selections <= 2 ? choices[0] : undefined; },
    notify() {},
  } };
  const setTool = setHost.tools.get("scholar_quiz");
  const partial = await setTool.execute("three-set", { questions: setQuestions }, signal, undefined, rpc);
  assert.equal(partial.details.status, "cancelled");
  assert.equal(partial.details.itemResults.length, 2);
  assert.ok(!JSON.stringify(partial).includes("PRIVATE_SET_EXPLANATION_3"));
  setState = await read();
  const partialSet = target(setState, "learn").attempts.filter((item) => item.toolCallId === "three-set");
  assert.deepEqual(partialSet.map((item) => item.outcome), ["review", "review", "pending"]);
  assert.equal(domain.unansweredQuestion(target(setState, "learn").attempts).id, "quiz-three-set-3");
  const resumeHost = await host("learn");
  assert.ok(!(await resumeHost.call("three-resume", { resumeAttemptId: "quiz-three-set-3" })).some((item) => item?.block));
  const resumedSet = target(await read(), "learn").attempts.filter((item) => item.toolCallId === "three-set");
  assert.ok(resumedSet[2].resumeToolCallIds.includes("three-resume"));
  const resumed = await resumeHost.tools.get("scholar_quiz").execute("three-resume", { resumeAttemptId: "quiz-three-set-3" }, signal, undefined,
    { hasUI: true, mode: "rpc", ui: { custom() { throw new Error("RPC custom picker opened"); }, select: async (_title, choices) => choices[1], notify() {} } });
  assert.equal(resumed.details.status, "answered");
  assert.deepEqual(target(await read(), "learn").attempts.filter((item) => item.toolCallId === "three-set").map((item) => item.outcome), ["review", "review", "pass"]);
  await resumeHost.fire("tool_result", { toolName: "scholar_quiz", toolCallId: "three-resume", details: resumed.details });
  assert.equal(target(await read(), "learn").attempts.filter((item) => item.toolCallId === "three-set").length, 3);
  pass("one call freezes a three-item set; RPC selection saves each answer before tool_result; restart resumes only the remaining item");

  const tuiHost = await host("tutor");
  const tuiQuestions = setQuestions.slice(0, 2).map((item, index) => ({ ...item, question: `Tutor feedback question ${index + 1}?` }));
  assert.ok(!(await tuiHost.call("tui-set", { questions: tuiQuestions })).some((item) => item?.block));
  const panels = [];
  const tuiResult = await tuiHost.tools.get("scholar_quiz").execute("tui-set", { questions: tuiQuestions }, signal, undefined,
    { hasUI: true, mode: "tui", ui: { custom: async (factory) => new Promise((done) => {
      const component = factory({ requestRender() {} }, { fg: (_role, value) => value, bold: (value) => value }, {}, done);
      const view = component.render(100).join("\n");
      panels.push(view);
      component.handleInput("\r");
    }), notify() {} } });
  assert.equal(tuiResult.details.status, "answered");
  assert.equal(panels.length, 4, "each choice is followed by a feedback panel");
  assert.ok(!panels[0].includes("PRIVATE_SET_EXPLANATION_1"));
  assert.ok(panels[1].includes("PRIVATE_SET_EXPLANATION_1"));
  assert.ok(panels[3].includes("PRIVATE_SET_EXPLANATION_2"));
  assert.deepEqual(target(await read(), "tutor").attempts.filter((item) => item.toolCallId === "tui-set").map((item) => item.outcome), ["review", "review"]);
  pass("TUI set shows feedback inside the quiz flow after each durable answer");

  const multiInput = { ...setQuestions[0], question: "Which two mechanisms apply together?", multiSelect: true,
    correctAnswer: ["a", "b"], options: [{ label: "A", value: "a" }, { label: "B", value: "b" },
      { label: "C", value: "c", misconception: "Adds an unrelated mechanism" }] };
  assert.ok(!(await tuiHost.call("rpc-multi", { questions: [multiInput] })).some((item) => item?.block));
  let inputSignal;
  const multiResult = await tuiHost.tools.get("scholar_quiz").execute("rpc-multi", { questions: [multiInput] }, signal, undefined,
    { hasUI: true, mode: "rpc", ui: { input: async (_title, _placeholder, options) => { inputSignal = options.signal; return "1,2"; }, notify() {} } });
  assert.equal(inputSignal, signal);
  assert.equal(multiResult.details.correct, true);
  assert.equal(target(await read(), "tutor").attempts.find((item) => item.toolCallId === "rpc-multi").outcome, "pass");
  pass("RPC multi-select input accepts numbered choices with the abort signal and grades the frozen key");

  const pausedHost = await host("tutor");
  assert.ok(!(await pausedHost.call("whole-pause", { questions: tuiQuestions })).some((item) => item?.block));
  const pausedBeforeFirst = await pausedHost.tools.get("scholar_quiz").execute("whole-pause", { questions: tuiQuestions }, signal, undefined,
    { hasUI: true, mode: "rpc", ui: { select: async () => undefined, notify() {} } });
  assert.equal(pausedBeforeFirst.details.itemResults.length, 0);
  const pendingPair = target(await read(), "tutor").attempts.filter((item) => item.toolCallId === "whole-pause");
  assert.deepEqual(pendingPair.map((item) => item.outcome), ["pending", "pending"]);
  const pairedResume = await host("tutor");
  assert.ok(!(await pairedResume.call("whole-resume", { resumeAttemptId: pendingPair[0].id })).some((item) => item?.block));
  const withDelivery = target(await read(), "tutor").attempts.filter((item) => item.toolCallId === "whole-pause");
  assert.ok(withDelivery.every((item) => item.resumeToolCallIds.includes("whole-resume")));
  const finishedPair = await pairedResume.tools.get("scholar_quiz").execute("whole-resume", { resumeAttemptId: pendingPair[0].id }, signal, undefined,
    { hasUI: true, mode: "rpc", ui: { select: async (_title, choices) => choices[0], notify() {} } });
  assert.equal(finishedPair.details.itemResults.length, 2);
  assert.ok(target(await read(), "tutor").attempts.filter((item) => item.toolCallId === "whole-pause").every((item) => item.outcome === "review"));
  pass("resuming a paused set appends one delivery ID to every still-pending item");

  const retryBook = structuredClone(await read());
  const retryQuiz = structuredClone(target(retryBook, "tutor").attempts.find((item) => item.toolCallId === "tui-set").quiz);
  target(retryBook, "tutor").attempts.push({ id: "quiz-retry-save", toolCallId: "retry-save",
    quizSet: { id: "retry-save", index: 1, size: 1 }, kind: "conceptual", format: "multiple-choice",
    question: retryQuiz.question, quiz: retryQuiz, options: retryQuiz.options.map((option) => option.label),
    mode: retryQuiz.mode, grounding, outcome: "pending", createdAt: now });
  let writeAttempts = 0;
  const retryHost = createScholarQuizHost({
    active: () => ({ bookId: retryBook.id, mode: "tutor", recordId: "t1" }),
    loadBook: async () => structuredClone(retryBook), ownsBook: () => true,
    mutateBook: async (_bookId, mutate) => { if (++writeAttempts === 1) throw new Error("transient save failure"); return { result: mutate(retryBook) }; },
  });
  const keyIndex = retryQuiz.options.findIndex((option) => retryQuiz.correctValues.includes(option.value));
  const retryDetails = { status: "answered", question: retryQuiz.question, mode: retryQuiz.mode,
    options: retryQuiz.options.map((option, index) => ({ index: index + 1, label: option.label })),
    answers: [{ index: keyIndex + 1, label: retryQuiz.options[keyIndex].label, value: retryQuiz.options[keyIndex].value }],
    dontKnow: false, correct: true, correctIndices: [keyIndex + 1], explanation: retryQuiz.explanation };
  assert.equal(await retryHost.record("retry-save", "quiz-retry-save", retryDetails), "saved");
  assert.equal(writeAttempts, 2);
  assert.equal(target(retryBook, "tutor").attempts.at(-1).outcome, "pass");
  assert.equal(await retryHost.record("retry-save", "quiz-retry-save", retryDetails), "gone");
  pass("a transient save failure reloads and retries once; a duplicate event cannot rewrite the finalized answer");

  const h = await host("learn");
  const input = { question: "Question saved just before a process exits?", kind: "conceptual", grounding, options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No", misconception: "Assumes persisted data vanishes with a process" }], correctAnswer: "yes", explanation: "The original key is preserved.", shuffle: false };
  await h.call("crash-before-ui", input); // No execute or result event: simulate process termination.
  const saved = await read(), pending = target(saved, "learn").attempts.at(-1);
  const restart = await host("learn");
  const resume = { resumeAttemptId: pending.id };
  await restart.call("crash-resume", resume);
  const output = await restart.execute("crash-resume", resume, "answer", false); // Lose the live result handler.
  const recoveryTarget = { vaultPath: config.obsidianRoot, bookId: book.id, instanceId: book.instanceId, mode: "learn", recordId: "s1" };
  const branch = [{ id: "activation", type: "custom", customType: "scholar-active-v3", data: { ...recoveryTarget, active: true } },
    { id: "cancel", type: "message", message: { role: "toolResult", toolName: "scholar_quiz", toolCallId: "crash-before-ui", details: { status: "cancelled" } } },
    { id: "answer", type: "message", message: { role: "toolResult", toolName: "scholar_quiz", toolCallId: "crash-resume", ...output } }];
  await recoverTranscriptTarget({ target: recoveryTarget, branch, loadBook: read, mutateBook: service.mutateBook, isAutomatic: true });
  assert.equal(target(await read(), "learn").attempts.at(-1).outcome, "pass", "the awaited quiz host saves before tool_result or history recovery");
  await restart.fire("tool_result", { toolName: "scholar_quiz", toolCallId: "crash-resume", ...output });
  assert.equal(target(await read(), "learn").attempts.at(-1).outcome, "pass");
  pass("crash before UI preserves the form; an answer is durable before tool_result and history cannot override the note");

  const session = new ScholarRuntimeSession(); session.activate(book.id, "learn", "s1");
  const prepared = await handleAssess(await read(), session, "open-first", { outcome: "pending", kind: "conceptual", question: "Explain the original mechanism in your own words.", grounding, ...openContract },
    (state) => target(state, "learn"), service.mutateBook, toolResult);
  const next = await host("learn");
  assert.match(next.sent.at(-1).content, /Explain the original mechanism in your own words/);
  assert.ok((await next.call("replace-open-with-mc", input)).some((item) => item?.block));
  await assert.rejects(handleAssess(await read(), session, "open-replacement", { outcome: "pending", kind: "conceptual", question: "A different open question?", grounding, ...openContract },
    (state) => target(state, "learn"), service.mutateBook, toolResult), /existing open question/);
  const gate = new OpenResponseGate(), answeredBook = await read(), answer = "The relation predicts the outcome from the mechanism.";
  gate.capture(answeredBook, session, answer, "interactive"); gate.beginTurn(answeredBook, session, answer);
  await handleAssess(await read(), session, "resolve-open", { attemptId: prepared.details.attemptId, outcome: "pass", feedback: "The explanation establishes the relation.", evaluation: { criteria: [{ criterionIndex: 1, met: true, evidence: "predicts the outcome from the mechanism" }] } },
    (state) => target(state, "learn"), service.mutateBook, toolResult, gate);
  assert.equal(domain.unansweredQuestion(target(await read(), "learn").attempts), undefined);
  pass("an unanswered open question survives reopening and blocks both kinds of replacement until resolved");

  const racer = await host("learn");
  const countBefore = target(await read(), "learn").attempts.length;
  const races = await Promise.all([racer.call("race-a", input), racer.call("race-b", input)]);
  assert.equal(races.filter((results) => results.some((item) => item?.block)).length, 1, JSON.stringify(races));
  assert.equal(target(await read(), "learn").attempts.length, countBefore + 1);
  pass("concurrent question requests cannot leave two pending attempts");
  const completePractice = await read();
  target(completePractice, "learn").status = "complete";
  assert.equal(domain.resolveLearnSection(completePractice, undefined).id, "s1");
  assert.equal(domain.resolveLearnSection(completePractice, "chapter c1").id, "s1");
  pass("bare Learn and chapter reopening also resume unfinished practice in an already completed section");
  console.log(`\n${checks} question-resume verifications passed.`);
} finally { await rm(root, { recursive: true, force: true }); }
