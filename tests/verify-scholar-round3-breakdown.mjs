import { extensionPath as packagedExtensionPath, piPackageRoot as sdkRoot, jitiPath as sdkJitiPath, resolvePiDependency } from "./sdk.mjs";
// DEFECT-09: weighted exam facets must keep their score and survive persistence.
// Uses production builders, the complete stored-book schema and both Markdown
// reports. Fixtures are in memory; this verifier never touches a user vault.
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

const piPackageRoot = sdkRoot;
const { createJiti } = await import(pathToFileURL(sdkJitiPath).href);
const jiti = createJiti(import.meta.url, { moduleCache: false });
const extension = dirname(process.env.PI_SCHOLAR_EXTENSION || packagedExtensionPath);
const { buildExamBreakdown, validateExamQuestions } = await jiti.import(join(extension, "exam.ts"));
const { isScholarBook, scholarBookIssues } = await jiti.import(join(extension, "state-schema.ts"));
const { renderExam, renderExamAnswerKey } = await jiti.import(join(extension, "render", "assessment.ts"));

const timestamp = "2026-09-04T00:00:00.000Z";
const sourceRoot = process.platform === "win32" ? "C:\\scholar-test" : "/scholar-test";
const sectionIds = Array.from({ length: 7 }, (_, index) => `s${index + 1}`);
const dimensions = Array.from({ length: 7 }, (_, index) => `competency ${index + 1}`);
const close = (actual, expected, message) => assert.ok(
  Math.abs(actual - expected) <= Math.max(Number.MIN_VALUE, Math.abs(expected) * 1e-12),
  `${message}: expected ${expected}, received ${actual}`,
);

function gradedBook(specifications) {
  const book = {
    schemaVersion: 3, revision: 1, id: "a".repeat(64), instanceId: "breakdown-fixture",
    source: {
      absolutePath: join(sourceRoot, "scores.pdf"), relativePath: "scores.pdf", fileName: "scores.pdf", format: "pdf",
      fingerprint: { sha256: "a".repeat(64), size: 10, mtimeMs: 10 },
    },
    metadata: { title: "Scoring precision", authors: [], pageCount: 7 },
    outlineStatus: "ready",
    chapters: [{
      id: "c1", order: 1, title: "Weighted credit", startPage: 1, endPage: 7, status: "not-started",
      sections: sectionIds.map((id, index) => ({
        id, order: index + 1, title: `Section ${index + 1}`, startPage: index + 1, endPage: index + 1,
        status: "not-started", objectives: [], coveredObjectives: [], requiredChecks: ["conceptual"],
        keyPoints: [], misconceptions: [], attempts: [], transcript: [], createdAt: timestamp, updatedAt: timestamp,
      })),
    }],
    exams: [], currentExamId: "e1", tutorSessions: [], noteDirectory: "Scoring precision",
    createdAt: timestamp, updatedAt: timestamp,
  };
  const exam = {
    id: "e1", title: "Fractional credit", scope: { chapterIds: ["c1"], sectionIds, description: "Seven sections" },
    status: "graded", questions: [], rawResponses: [], itemResults: [], breakdown: [],
    earnedPoints: 0, maxPoints: 0, percent: 0, transcript: [],
    createdAt: timestamp, startedAt: timestamp, submittedAt: timestamp, gradedAt: timestamp, updatedAt: timestamp,
  };
  exam.questions = validateExamQuestions(exam, specifications.map((specification, index) => ({
    id: `q${index + 1}`, sectionIds: specification.sectionIds || sectionIds, dimensions: specification.dimensions || dimensions,
    claim: "Explains and applies the relation", requiredEvidence: ["relation", "application"],
    format: "open", prompt: "Explain the relation and apply it.", explanation: "Both the relation and application are needed.",
    maxPoints: specification.max,
    rubric: [
      { id: "relation", criterion: "Explains", requiredEvidence: ["relation"], points: specification.max / 2 },
      { id: "application", criterion: "Applies", requiredEvidence: ["application"], points: specification.max / 2 },
    ],
  })));
  exam.rawResponses = exam.questions.map((question) => ({ questionId: question.id, response: "Fixture response" }));
  exam.itemResults = specifications.map((specification, index) => ({
    questionId: `q${index + 1}`, earnedPoints: specification.earned, maxPoints: specification.max,
    outcome: specification.earned === 0 ? "incorrect" : specification.earned === specification.max ? "correct" : "partial",
    feedback: "Credit reflects the demonstrated rubric evidence.",
  }));
  exam.earnedPoints = specifications.reduce((sum, specification) => sum + specification.earned, 0);
  exam.maxPoints = specifications.reduce((sum, specification) => sum + specification.max, 0);
  exam.percent = Math.round((exam.earnedPoints / exam.maxPoints) * 1000) / 10;
  exam.breakdown = buildExamBreakdown(book, exam, exam.itemResults);
  book.exams.push(exam);
  return book;
}

function assertPersistable(book) {
  assert.ok(isScholarBook(book), scholarBookIssues(book).join("; "));
  const restored = JSON.parse(JSON.stringify(book));
  assert.ok(isScholarBook(restored), scholarBookIssues(restored).join("; "));
  assert.deepEqual(restored.exams[0].breakdown, book.exams[0].breakdown, "JSON preserves every weighted score");
  const exam = restored.exams[0];
  for (const kind of ["section:", "dimension:"]) {
    const facets = exam.breakdown.filter((entry) => entry.key.startsWith(kind));
    close(facets.reduce((sum, entry) => sum + entry.earnedPoints, 0), exam.earnedPoints, `${kind} earned credit is conserved`);
    close(facets.reduce((sum, entry) => sum + entry.maxPoints, 0), exam.maxPoints, `${kind} available credit is conserved`);
  }
  return restored;
}

let passed = 0;
let failed = 0;
function check(name, run) {
  try { run(); passed += 1; console.log(`[PASS] ${name}`); }
  catch (error) { failed += 1; console.error(`[FAIL] ${name}: ${error.message}`); }
}

check("half credit across seven sections and seven dimensions stays 50% after JSON persistence", () => {
  const book = assertPersistable(gradedBook([{ earned: 0.5, max: 1 }]));
  assert.equal(book.exams[0].breakdown.length, 14);
  for (const entry of book.exams[0].breakdown) {
    assert.equal(entry.percent, 50);
    close(entry.earnedPoints, 0.5 / 7, "one seventh of earned credit");
    close(entry.maxPoints, 1 / 7, "one seventh of available credit");
  }
});

check("overlapping facets aggregate unequal item weights and preserve independent totals", () => {
  const book = assertPersistable(gradedBook([
    { earned: 0.5, max: 1 },
    { earned: 0.05, max: 0.2, sectionIds: sectionIds.slice(0, 3), dimensions: dimensions.slice(0, 2) },
    { earned: 0.003, max: 0.003, sectionIds: sectionIds.slice(-2), dimensions: [dimensions[0]] },
  ]));
  const byKey = new Map(book.exams[0].breakdown.map((entry) => [entry.key, entry]));
  close(byKey.get("section:s1").earnedPoints, 0.5 / 7 + 0.05 / 3, "shared section earned credit");
  close(byKey.get("section:s1").maxPoints, 1 / 7 + 0.2 / 3, "shared section maximum");
  close(byKey.get("dimension:competency 1").earnedPoints, 0.5 / 7 + 0.025 + 0.003, "shared dimension earned credit");
  assert.equal(byKey.get("section:s4").percent, 50, "untouched facet retains the original score");
});

check("tiny positive weights and zero, partial and full credit remain valid", () => {
  for (const max of [0.0001, 1e-12, 1e-300]) {
    for (const ratio of [0, 0.125, 0.5, 1]) {
      const book = assertPersistable(gradedBook([{ earned: max * ratio, max }]));
      for (const entry of book.exams[0].breakdown) {
        assert.ok(entry.maxPoints > 0, `positive maximum disappeared for ${max}`);
        assert.equal(entry.percent, ratio * 100);
        if (ratio > 0) assert.ok(entry.earnedPoints > 0, `positive credit disappeared for ${max}`);
      }
    }
  }
});

check("both reports format fractional credit concisely while preserving tiny nonzero credit", () => {
  const config = { schemaVersion: 3, libraryRoot: sourceRoot, obsidianRoot: join(sourceRoot, "vault"), stateRoot: join(sourceRoot, "state"), updatedAt: timestamp };
  for (const [max, expected] of [[1, "0.0714286/0.142857"], [1e-12, "7.14286e-14/1.42857e-13"]]) {
    const book = assertPersistable(gradedBook([{ earned: max / 2, max }]));
    const before = JSON.stringify(book);
    for (const render of [renderExam, renderExamAnswerKey]) {
      const markdown = render(config, book, book.exams[0]);
      assert.ok(markdown.includes(`| competency 1 | ${expected} | 50% |`), "competency table score must be concise and nonzero");
      assert.ok(!markdown.includes("0.07142857142857142"), "full-precision fractions should stay in stored state");
    }
    assert.equal(JSON.stringify(book), before, "rendering never rounds stored scores");
  }
});

console.log(`\nScholar round3-breakdown summary: ${passed} passed, ${failed} failed.`);
process.exitCode = failed ? 1 : 0;
