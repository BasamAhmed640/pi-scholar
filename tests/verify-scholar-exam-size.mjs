import { extensionPath as packagedExtensionPath, piPackageRoot as sdkRoot, jitiPath as sdkJitiPath, resolvePiDependency } from "./sdk.mjs";
// In-memory exam size gate: no vault, config, or saved bookstate is touched.
// New forms use 1–50 questions; previously frozen longer forms remain usable.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const piRoot = sdkRoot;
const piRequire = createRequire(join(piRoot, "package.json"));
const { createJiti } = await import(pathToFileURL(sdkJitiPath).href);
const { Check } = await import(pathToFileURL(piRequire.resolve("typebox/value")).href);
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: {
  "@earendil-works/pi-coding-agent": join(piRoot, "dist", "index.js"),
  "@earendil-works/pi-tui": piRequire.resolve("@earendil-works/pi-tui"),
  typebox: piRequire.resolve("typebox"),
} });
const extension = dirname(process.env.PI_SCHOLAR_EXTENSION || packagedExtensionPath);
const mod = (path) => jiti.import(join(extension, path));
const { MAX_EXAM_QUESTIONS } = await mod("exam-limits.ts");
const { validateExamQuestions } = await mod("exam.ts");
const { ScholarParams } = await mod("tool-contract.ts");
const { isScholarBook } = await mod("state-schema.ts");
const { handleExamBuild, handleExamGrade } = await mod("tool-actions/exam.ts");
const { kickoffMessage } = await mod("runtime-coordinator.ts");

const timestamp = "2026-01-01T00:00:00.000Z";
function questions(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `q${index + 1}`, sectionIds: ["s1"], claim: `Tests model reasoning ${index + 1}.`,
    requiredEvidence: ["Names the applicable model", "Checks its assumptions"], dimensions: ["Model selection"],
    explanation: "Compare propagation delay with rise time and verify the assumptions.",
    ...(index % 2 ? {
      format: "open", prompt: `Derive the model relation for scenario ${index + 1}.`, maxPoints: 3,
      rubric: [
        { id: "r1", criterion: "States assumptions", requiredEvidence: ["Assumptions stated"], points: 1 },
        { id: "r2", criterion: "Derives the relation", requiredEvidence: ["Correct relation"], points: 2 },
      ],
    } : {
      format: "multiple-choice", prompt: `Which model applies to scenario ${index + 1}?`, maxPoints: 2,
      options: [
        { value: "a", label: "Lumped", misconception: "Ignores propagation delay" },
        { value: "b", label: "Transmission line" },
        { value: "c", label: "Static conductor", misconception: "Ignores changing fields" },
      ], correctAnswer: "b",
    }),
  }));
}
function fixture() {
  const id = "d".repeat(64);
  const section = { id: "s1", order: 1, number: "1.1", title: "Models", startPage: 1, endPage: 2, status: "not-started",
    objectives: [], coveredObjectives: [], requiredChecks: ["conceptual"], keyPoints: [], misconceptions: [], attempts: [], transcript: [],
    createdAt: timestamp, updatedAt: timestamp };
  const exam = { id: "exam-001", title: "Models exam", scope: { chapterIds: ["c1"], sectionIds: ["s1"], description: "Chapter 1" },
    status: "draft", questions: [], rawResponses: [], itemResults: [], breakdown: [], earnedPoints: 0, maxPoints: 0,
    percent: 0, transcript: [], createdAt: timestamp, updatedAt: timestamp };
  return { schemaVersion: 3, revision: 0, id, instanceId: "exam-size-fixture", source: {
    absolutePath: join(extension, "fixture.pdf"), relativePath: "fixture.pdf", fileName: "fixture.pdf", format: "pdf",
    fingerprint: { sha256: id, size: 1, mtimeMs: 1 } }, metadata: { title: "Exam size fixture", authors: [], pageCount: 2 },
    outlineStatus: "ready", noteDirectory: "Exam size fixture", chapters: [{ id: "c1", number: "1", order: 1, title: "Models",
      startPage: 1, endPage: 2, status: "not-started", sections: [section] }], exams: [exam], currentExamId: exam.id,
    tutorSessions: [], createdAt: timestamp, updatedAt: timestamp };
}
const result = (action, summary, details = {}) => ({ content: [{ type: "text", text: summary }], details: { action, summary, ...details } });
function harness() {
  const book = fixture();
  let mutations = 0, presentations = 0;
  const mutate = async (bookId, mutation) => {
    assert.equal(bookId, book.id);
    const value = await mutation(book);
    assert.ok(isScholarBook(book), "a successful in-memory mutation must be storable");
    mutations++;
    return { book, result: value };
  };
  const present = async (_bookId, examId) => {
    presentations++;
    assert.equal(examId, book.exams[0].id);
    return { exam: book.exams[0], path: "in-memory-paper.md" };
  };
  return { book, mutate, present, counts: () => ({ mutations, presentations }) };
}
let passed = 0, failed = 0;
async function check(name, run) {
  try { await run(); passed++; console.log(`[PASS] ${name}`); }
  catch (error) { failed++; console.error(`[FAIL] ${name}: ${error.stack || error.message}`); }
}

await check("new-build schema advertises 1–50 with coverage-driven guidance", () => {
  assert.equal(MAX_EXAM_QUESTIONS, 50);
  assert.equal(ScholarParams.properties.questions.minItems, 1);
  assert.equal(ScholarParams.properties.questions.maxItems, 50);
  assert.match(ScholarParams.properties.questions.description, /concept coverage/);
  assert.match(ScholarParams.properties.questions.description, /multiple distinct probes/);
  assert.match(ScholarParams.properties.questions.description, /ceiling, not a target/);
});

for (const count of [1, 7, 20, 21, 37, 50]) {
  await check(`${count} questions pass schema, runtime, build, presentation and stored validation`, async () => {
    const h = harness(), raw = questions(count);
    assert.ok(Check(ScholarParams, { action: "exam_build", questions: raw }));
    assert.equal(validateExamQuestions(h.book.exams[0], raw).length, count);
    const built = await handleExamBuild(h.book, "exam-001", raw, undefined, h.mutate, h.present, result);
    assert.equal(h.book.exams[0].status, "active");
    assert.equal(h.book.exams[0].questions.length, count);
    assert.equal(h.book.exams[0].questions.at(-1).id, `q${count}`);
    assert.deepEqual(h.counts(), { mutations: 1, presentations: 1 });
    assert.match(built.content[0].text, new RegExp(`${count} question\\(s\\)`));
  });
}

for (const count of [0, 51, 80, 81]) {
  await check(`${count} questions fail before any mutation or presentation`, async () => {
    const h = harness(), raw = questions(count), before = structuredClone(h.book);
    assert.equal(Check(ScholarParams, { action: "exam_build", questions: raw }), false);
    assert.throws(() => validateExamQuestions(h.book.exams[0], raw), /1 to 50 questions/);
    await assert.rejects(() => handleExamBuild(h.book, "exam-001", raw, undefined, h.mutate, h.present, result), /1 to 50 questions/);
    assert.deepEqual(h.counts(), { mutations: 0, presentations: 0 });
    assert.deepEqual(h.book, before);
  });
}

for (const count of [51, 80]) {
  await check(`previously frozen ${count}-question forms remain readable and gradable`, async () => {
    const h = harness(), exam = h.book.exams[0];
    Object.assign(exam, { status: "submitted", questions: questions(count), startedAt: timestamp, submittedAt: timestamp });
    exam.maxPoints = exam.questions.reduce((total, question) => total + question.maxPoints, 0);
    exam.rawResponses = exam.questions.map((question) => ({ questionId: question.id, response: "Previously saved response" }));
    assert.ok(isScholarBook(h.book));
    const itemResults = exam.questions.map((question) => ({ questionId: question.id, outcome: "correct",
      earnedPoints: question.maxPoints, maxPoints: question.maxPoints, feedback: "The response demonstrates the required evidence." }));
    assert.ok(Check(ScholarParams, { action: "exam_grade", itemResults }));
    await handleExamGrade(h.book, exam.id, itemResults, h.mutate, result);
    assert.equal(exam.status, "graded");
    assert.equal(exam.itemResults.length, count);
    assert.equal(exam.percent, 100);
  });
}

await check("draft kickoff chooses useful concept coverage and distinct probes within the ceiling", () => {
  const book = fixture(), kickoff = kickoffMessage(book, "exam", book.exams[0]);
  assert.match(kickoff, /1–50 questions/);
  assert.match(kickoff, /as few or as many as are useful/);
  assert.match(kickoff, /multiple distinct probes for important concepts/);
  assert.match(kickoff, /50 is a ceiling, not a target/);
});

console.log(`\nScholar exam-size summary: ${passed} passed, ${failed} failed.`);
process.exitCode = failed ? 1 : 0;
