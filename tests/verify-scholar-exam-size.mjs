import { extensionPath as packagedExtensionPath, piPackageRoot as sdkRoot, jitiPath as sdkJitiPath } from "./sdk.mjs";
// In-memory exam size gate: no vault, config, or saved bookstate is touched.
// Question counts are uncapped; form quality, completeness and storage guards remain.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
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
const { validateExamQuestions, validateExamAnswerNote, parseExamResponses, examAnswerProgress } = await mod("exam.ts");
const { examAnswerNoteText } = await mod("render/assessment.ts");
const { MAX_EXAM_ANSWER_NOTE_BYTES } = await mod("exam-paper.ts");
const { ScholarParams } = await mod("tool-contract.ts");
const { isScholarBook } = await mod("state-schema.ts");
const { handleExamBuild, handleExamGrade } = await mod("tool-actions/exam.ts");
const { kickoffMessage } = await mod("runtime-coordinator.ts");
const { examInstructions } = await mod("policies.ts");

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

await check("build and grading schemas have no count cap, with coverage-driven guidance", () => {
  assert.equal(ScholarParams.properties.questions.minItems, 1);
  assert.equal(Object.hasOwn(ScholarParams.properties.questions, "maxItems"), false);
  assert.equal(ScholarParams.properties.itemResults.minItems, 1);
  assert.equal(Object.hasOwn(ScholarParams.properties.itemResults, "maxItems"), false);
  assert.match(ScholarParams.properties.questions.description, /concept coverage/);
  assert.match(ScholarParams.properties.questions.description, /multiple distinct probes/);
  assert.match(ScholarParams.properties.questions.description, /no fixed question-count cap/);
});

for (const count of [1, 7, 20, 21, 37, 50, 51, 80, 81, 250]) {
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
    const config = { obsidianRoot: join(extension, "in-memory-vault") };
    const exam = h.book.exams[0], paper = examAnswerNoteText(config, h.book, exam);
    assert.ok(Buffer.byteLength(paper, "utf8") < MAX_EXAM_ANSWER_NOTE_BYTES);
    validateExamAnswerNote(h.book, exam, paper);
    const responses = parseExamResponses(exam, paper);
    assert.equal(responses.length, count);
    assert.equal(responses.at(-1).questionId, `q${count}`);
    assert.deepEqual(examAnswerProgress(exam, paper), {
      ok: true, total: count, answered: 0, blank: raw.map((question) => question.id),
    });
  });
}

for (const count of [0]) {
  await check(`${count} questions fail before any mutation or presentation`, async () => {
    const h = harness(), raw = questions(count), before = structuredClone(h.book);
    assert.equal(Check(ScholarParams, { action: "exam_build", questions: raw }), false);
    assert.throws(() => validateExamQuestions(h.book.exams[0], raw), /at least one question/);
    await assert.rejects(() => handleExamBuild(h.book, "exam-001", raw, undefined, h.mutate, h.present, result), /at least one question/);
    assert.deepEqual(h.counts(), { mutations: 0, presentations: 0 });
    assert.deepEqual(h.book, before);
  });
}

for (const count of [51, 80, 81, 250]) {
  await check(`frozen ${count}-question forms remain readable and gradable in full`, async () => {
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

await check("large forms still reject invalid questions before any mutation", async () => {
  for (const invalid of ["scope", "duplicate", "rubric"]) {
    const h = harness(), raw = questions(250), before = structuredClone(h.book);
    if (invalid === "scope") raw.at(-1).sectionIds = ["out-of-scope"];
    if (invalid === "duplicate") raw.at(-1).id = "q1";
    if (invalid === "rubric") raw.at(-1).rubric = [];
    await assert.rejects(() => handleExamBuild(h.book, "exam-001", raw, undefined, h.mutate, h.present, result));
    assert.deepEqual(h.counts(), { mutations: 0, presentations: 0 });
    assert.deepEqual(h.book, before);
  }
});

await check("uncapped grading still rejects incomplete or duplicated results before mutation", async () => {
  const h = harness(), exam = h.book.exams[0];
  Object.assign(exam, { status: "submitted", questions: questions(250) });
  const complete = exam.questions.map((question) => ({ questionId: question.id, outcome: "correct",
    earnedPoints: question.maxPoints, maxPoints: question.maxPoints, feedback: "Valid reasoning." }));
  for (const invalid of [complete.slice(0, -1), [...complete.slice(0, -1), complete[0]]]) {
    await assert.rejects(() => handleExamGrade(h.book, exam.id, invalid, h.mutate, result), /exactly one unique result/);
    assert.equal(exam.status, "submitted");
    assert.deepEqual(h.counts(), { mutations: 0, presentations: 0 });
  }
});

await check("draft kickoff and policy choose useful coverage without a fixed quota", () => {
  const book = fixture(), kickoff = kickoffMessage(book, "exam", book.exams[0]);
  const instructions = examInstructions(book, book.exams[0]);
  for (const text of [kickoff, instructions]) {
    assert.match(text, /no fixed question-count cap/);
    assert.doesNotMatch(text, /1[–-]50|50 is a ceiling|too large for 50|stop at 20/);
  }
  assert.match(kickoff, /as few or as many as are useful/);
  assert.match(kickoff, /multiple distinct probes for important concepts/);
});

console.log(`\nScholar exam-size summary: ${passed} passed, ${failed} failed.`);
process.exitCode = failed ? 1 : 0;
