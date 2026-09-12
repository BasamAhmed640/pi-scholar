// Synthetic fixtures only: exercise Pi events, durable vault saves and projections.
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { extensionPath, piPackageRoot, jitiPath, loaderPath, resolvePiDependency } from "./sdk.mjs";

const { createJiti } = await import(pathToFileURL(jitiPath).href);
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: {
  "@earendil-works/pi-coding-agent": join(piPackageRoot, "dist", "index.js"),
  "@earendil-works/pi-tui": resolvePiDependency("@earendil-works/pi-tui"),
  typebox: resolvePiDependency("typebox"),
} });
const mod = (file) => jiti.import(join(dirname(extensionPath), file));
const domain = await mod("domain.ts");
const storage = await mod("storage.ts");
const paths = await mod("obsidian-paths.ts");
const { renderScholarWorkspace } = await mod("obsidian.ts");
const { createBookService } = await mod("book-service.ts");
const { handleAssess, handleNotes } = await mod("tool-actions/learning.ts");
const { handleExamGrade } = await mod("tool-actions/exam.ts");
const { kickoffMessage } = await mod("runtime-coordinator.ts");
const { createExtensionRuntime, loadExtensions } = await import(pathToFileURL(loaderPath).href);
const root = await mkdtemp(join(tmpdir(), "scholar-completion-practice-"));
const hook = `__scholarCompletion_${process.pid}`;
const now = "2026-01-01T00:00:00.000Z";
const config = { schemaVersion: 3, libraryRoot: join(root, "library"), obsidianRoot: join(root, "vault"), stateRoot: join(root, "bootstrap"), updatedAt: now };
process.env.PI_SCHOLAR_STATE_ROOT = config.stateRoot;
process.env.PI_SCHOLAR_LIBRARY_ROOT = config.libraryRoot;
process.env.PI_SCHOLAR_OBSIDIAN_ROOT = config.obsidianRoot;
const objective = "Explain how the model predicts a change";
const grounding = () => ({ purpose: "mastery", competency: objective, requiredEvidence: ["Correct prediction"], sourcePages: [1], basis: [{ kind: "objective", value: objective, supports: [1] }] });
const attempt = (id, kind, outcome = "pass", extra = {}) => ({ id, kind, outcome, format: "multiple-choice", question: `Synthetic ${id} question`, grounding: grounding(), createdAt: now, ...extra });
const section = (book) => book.chapters[0].sections[0];
const result = (action, summary, details = {}) => ({ content: [{ type: "text", text: summary }], details: { action, summary, ...details } });
function fixture() {
  return {
    schemaVersion: 3, revision: 0, id: "a".repeat(64), instanceId: "completion-fixture",
    source: { absolutePath: join(config.libraryRoot, "fixture.pdf"), relativePath: "fixture.pdf", fileName: "fixture.pdf", format: "pdf", fingerprint: { sha256: "a".repeat(64), size: 1, mtimeMs: 1 } },
    metadata: { title: "Completion fixture", authors: [], pageCount: 1 }, outlineStatus: "ready",
    chapters: [{ id: "c1", order: 1, number: "1", title: "One", startPage: 1, endPage: 1, status: "learning", sections: [{
      id: "s1", order: 1, number: "1.1", title: "A model", startPage: 1, endPage: 1, status: "learning",
      objectives: [objective], coveredObjectives: [objective], requiredChecks: ["conceptual", "application", "discrimination"],
      synthesis: "The source model predicts how changing an input affects the measured output.", keyPoints: [objective], misconceptions: [], transcript: [],
      figureCoverage: { pages: [{ page: 1, read: true, viewed: { width: 600, height: 800 }, candidates: [], review: { page: 1, observation: "The complete source page contains text and no figures.", figures: [] } }] },
      attempts: [attempt("concept", "quiz", "pass", { difficulty: "conceptual recheck" }), attempt("app-miss", "application", "review"), attempt("app-pass", "application"), attempt("app-cancel", "application", "cancelled")],
      createdAt: now, updatedAt: now,
    }] }],
    exams: [{ id: "e1", title: "Exam 01", status: "submitted", scope: { chapterIds: ["c1"], sectionIds: ["s1"], description: "Chapter 1" },
      questions: [{ id: "q1", sectionIds: ["s1"], dimensions: ["reasoning"], claim: objective, requiredEvidence: ["explanation"], format: "open", prompt: "Explain the relation.", explanation: "The model determines the relation.", maxPoints: 2,
        rubric: [{ id: "r1", criterion: "Names the relation", requiredEvidence: ["explanation"], points: 1 }, { id: "r2", criterion: "Justifies the prediction", requiredEvidence: ["explanation"], points: 1 }] }],
      rawResponses: [{ questionId: "q1", response: "A saved learner explanation" }], itemResults: [], breakdown: [], earnedPoints: 0, maxPoints: 2, percent: 0, transcript: [],
      createdAt: now, startedAt: now, submittedAt: now, updatedAt: now,
    }], currentSectionId: "s1", tutorSessions: [], noteDirectory: "Completion fixture", createdAt: now, updatedAt: now,
  };
}
let passed = 0;
function pass(name) { passed++; console.log(`[PASS] ${name}`); }
try {
  await Promise.all([mkdir(config.libraryRoot), mkdir(config.obsidianRoot), mkdir(config.stateRoot)]);
  await writeFile(join(config.libraryRoot, "fixture.pdf"), "synthetic source placeholder");
  const book = fixture();
  const before = structuredClone(book);
  domain.migrateLearnAssessmentKinds(book);
  assert.equal(section(book).attempts[0].kind, "conceptual");
  assert.deepEqual(domain.sectionCompletionBlockers(section(book)), ["discrimination check"]);
  assert.deepEqual(book.exams, before.exams);
  assert.deepEqual(section(book).attempts.map(({ kind, ...rest }) => rest), section(before).attempts.map(({ kind, ...rest }) => rest));
  assert.equal(section(book).updatedAt, now);
  const migrated = structuredClone(book);
  domain.migrateLearnAssessmentKinds(book);
  assert.deepEqual(book, migrated);
  assert.equal(domain.quizKind(undefined, "easy", undefined, "conceptual"), "conceptual");
  assert.equal(domain.quizKind(undefined, "conceptual"), "conceptual");
  pass("legacy declared kinds reconcile without inventing grades, changing exams or rewriting history");

  const complete = structuredClone(book);
  section(complete).attempts.push(attempt("discrim", "discrimination"));
  domain.recomputeProgress(complete, section(complete));
  assert.equal(section(complete).status, "complete");
  assert.equal(complete.chapters[0].status, "complete");
  for (const change of [
    (s) => { s.coveredObjectives = []; },
    (s) => { s.synthesis = ""; },
    (s) => { s.figureCoverage.pages[0].review = undefined; },
    (s) => { s.attempts.at(-1).grounding.purpose = "practice"; },
    (s) => { s.attempts.at(-1).grounding.purpose = "diagnostic"; },
    (s) => { s.attempts[0].difficulty = "easy"; s.attempts[0].kind = "quiz"; },
  ]) {
    const missing = structuredClone(complete);
    change(section(missing));
    domain.recomputeProgress(missing, section(missing));
    assert.notEqual(section(missing).status, "complete");
  }
  pass("grounded MC checks can complete Learn; missing coverage, notes, figures or mastery cannot");

  await storage.createBookState(config, fixture());
  const copy = join(root, "extension");
  await cp(dirname(extensionPath), copy, { recursive: true, filter: (file) => ![".git", "node_modules"].includes(basename(file)) });
  const index = join(copy, "index.ts");
  const source = await readFile(index, "utf8");
  const marker = "  const toolController = createScholarToolController({";
  assert.equal(source.split(marker).length, 2);
  await writeFile(index, source.replace(marker, `  (globalThis as any)[${JSON.stringify(hook)}] = coordinator;\n${marker}`));
  const runtime = createExtensionRuntime();
  runtime.appendEntry = () => {};
  runtime.refreshTools = () => {};
  runtime.getActiveTools = () => ["read", "bash"];
  runtime.setActiveTools = () => {};
  runtime.sendMessage = () => {};
  const loaded = await loadExtensions([index], root, undefined, runtime);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  const coordinator = globalThis[hook];
  coordinator.setConfig(config);
  coordinator.runtimeSession.activate(book.id, "learn", "s1");
  coordinator.activeAuthority = { bookId: book.id, instanceId: book.instanceId };
  const statuses = [];
  const ctx = { cwd: root, hasUI: false, ui: { setStatus: (_key, text) => statuses.push(text), notify() {} }, sessionManager: { getBranch: () => [] } };
  const fire = async (name, event) => {
    const results = [];
    for (const handler of extension.handlers.get(name) || []) results.push(await handler(event, ctx));
    return results;
  };
  const read = () => storage.loadBookState(config, book.id);
  async function quiz(id, kind, correct) {
    const calls = await fire("tool_call", { toolName: "scholar_quiz", toolCallId: id, input: { question: `Predict the result for ${id}.`, kind, difficulty: "easy", grounding: grounding() } });
    assert.ok(!calls.some((value) => value?.block), JSON.stringify(calls));
    return fire("tool_result", { toolName: "scholar_quiz", toolCallId: id, content: [{ type: "text", text: "Quiz result" }], details: { status: "answered", correct, explanation: "The saved model supports the prediction." } });
  }
  const final = await quiz("last-required", "discrimination", true);
  assert.match(JSON.stringify(final), /Section complete/);
  let saved = await read();
  assert.equal(section(saved).status, "complete");
  assert.equal(saved.chapters[0].status, "complete");
  assert.match(statuses.at(-1), /Learn practice/);
  const note = paths.sectionNotePath(config, saved, saved.chapters[0], section(saved));
  assert.match(await readFile(note, "utf8"), /Section complete/);
  assert.match(await readFile(paths.chapterNotePath(config, saved, saved.chapters[0]), "utf8"), /100%/);
  assert.match(kickoffMessage(saved, "learn", section(saved)), /practice only/);
  pass("real Pi quiz events finish the section and update durable chapter progress and Obsidian");

  const earned = structuredClone(section(saved).attempts);
  await quiz("reopened-wrong", "conceptual", false);
  saved = await read();
  assert.equal(section(saved).attempts.at(-1).grounding.purpose, "practice");
  assert.equal(section(saved).status, "complete");
  assert.deepEqual(section(saved).attempts.slice(0, earned.length), earned);
  const practiceInput = { outcome: "pending", kind: "application", question: "Explain a fresh prediction.", grounding: grounding() };
  const prepared = await handleAssess(saved, coordinator.runtimeSession, "open-practice", practiceInput, section, coordinator.mutateBook, result);
  saved = await read();
  assert.equal(section(saved).attempts.at(-1).grounding.purpose, "practice");
  const resolved = await handleAssess(saved, coordinator.runtimeSession, "resolve", { attemptId: prepared.details.attemptId, outcome: "review", feedback: "The practice explanation omitted the governing relation." }, section, coordinator.mutateBook, result);
  assert.match(resolved.details.summary, /remains complete/);
  saved = await read();
  assert.equal(saved.chapters[0].status, "complete");
  assert.match(await readFile(note, "utf8"), /Practice/);
  const notes = { synthesis: section(saved).synthesis, keyPoints: section(saved).keyPoints, objectives: [objective, "A new practice topic"], coveredObjectives: [objective] };
  await assert.rejects(handleNotes(saved, coordinator.runtimeSession, notes, section, coordinator.mutateBook, result), /practice cannot change/);
  assert.deepEqual(await read(), saved);
  pass("reopened MC and open questions are practice, failed practice preserves credit, and notes cannot reset completion");

  let failProjection = true;
  const service = createBookService({ getConfig: () => config, load: storage.loadBookState, save: storage.saveBookState, list: storage.listBookStates,
    project: async (cfg, books) => { if (failProjection) throw new Error("simulated note refresh failure"); await renderScholarWorkspace(cfg, books); },
    onSave() {}, librarySetupMessage: "missing library",
  });
  const learnBeforeExam = structuredClone(saved.chapters);
  const frozen = structuredClone(saved.exams[0]);
  const grades = [{ questionId: "q1", outcome: "correct", earnedPoints: 2, maxPoints: 2, feedback: "The explanation names and justifies the relation." }];
  const graded = await handleExamGrade(saved, "e1", grades, service.mutateBook, result);
  assert.match(graded.details.summary, /grade is saved.*pending/);
  saved = await read();
  assert.equal(saved.exams[0].status, "graded");
  assert.equal(saved.exams[0].percent, 100);
  assert.deepEqual(saved.exams[0].questions, frozen.questions);
  assert.deepEqual(saved.exams[0].rawResponses, frozen.rawResponses);
  assert.deepEqual(saved.chapters, learnBeforeExam);
  const committed = structuredClone(saved);
  await assert.rejects(handleExamGrade(saved, "e1", grades, service.mutateBook, result), /Only a submitted exam/);
  // A stale caller must also be rejected inside the serialized transaction.
  await assert.rejects(handleExamGrade({ ...saved, exams: [frozen] }, "e1", grades, service.mutateBook, result), /changed while grading/);
  assert.deepEqual(await read(), committed);
  failProjection = false;
  await service.renderAll();
  assert.deepEqual(await read(), committed);
  assert.match(await readFile(paths.examNotePath(config, saved, saved.exams[0]), "utf8"), /100%/);
  assert.match(kickoffMessage(saved, "exam", saved.exams[0]), /already graded.*Do not change/);
  pass("exam scores survive projection failure and reopen; retry does not regrade or change Learn evidence");
  console.log(`\n${passed} completion/practice verifications passed.`);
} finally {
  delete globalThis[hook];
  await rm(root, { recursive: true, force: true });
}
