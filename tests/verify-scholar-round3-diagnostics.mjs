import { extensionPath as packagedExtensionPath, piPackageRoot as sdkRoot, jitiPath as sdkJitiPath, resolvePiDependency } from "./sdk.mjs";
// DEFECT-12: rejected states must identify the broken invariant safely.
// Fixtures are in memory; this suite does not read or write a Scholar vault.
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

const piPackageRoot = sdkRoot;
const { createJiti } = await import(pathToFileURL(sdkJitiPath).href);
const jiti = createJiti(import.meta.url, { moduleCache: false });
const extensionRoot = dirname(process.env.PI_SCHOLAR_EXTENSION || packagedExtensionPath);
const { isScholarBook, scholarBookIssues } = await jiti.import(join(extensionRoot, "state-schema.ts"));

const timestamp = "2026-09-04T12:00:00.000Z";
const section = (id, startPage, endPage) => ({
  id, order: 1, title: id, startPage, endPage, status: "not-started",
  objectives: [], coveredObjectives: [], requiredChecks: [], keyPoints: [],
  misconceptions: [], attempts: [], transcript: [], createdAt: timestamp, updatedAt: timestamp,
});
const baseBook = () => ({
  schemaVersion: 3, revision: 0, id: "a".repeat(64), instanceId: "diagnostics-instance",
  source: {
    absolutePath: process.platform === "win32" ? "C:\\books\\diagnostics.pdf" : "/books/diagnostics.pdf",
    relativePath: "diagnostics.pdf", fileName: "diagnostics.pdf", format: "pdf",
    fingerprint: { sha256: "a".repeat(64), size: 100, mtimeMs: 100 },
  },
  metadata: { title: "Diagnostics", authors: ["Test Author"] }, outlineStatus: "ready",
  chapters: [
    { id: "chapter-1", order: 1, title: "One", startPage: 1, endPage: 10, status: "not-started", sections: [section("section-1", 1, 10)] },
    { id: "chapter-2", order: 2, title: "Two", startPage: 10, endPage: 20, status: "not-started", sections: [section("section-2", 10, 20)] },
  ],
  exams: [{
    id: "exam-1", title: "Draft exam", status: "draft",
    scope: { chapterIds: ["chapter-1"], sectionIds: ["section-1"], description: "Chapter One" },
    questions: [], rawResponses: [], itemResults: [], breakdown: [], earnedPoints: 0, maxPoints: 0,
    percent: 0, transcript: [], createdAt: timestamp, updatedAt: timestamp,
  }],
  tutorSessions: [{
    id: "tutor-1", title: "Tutor", status: "active",
    scope: { chapterIds: ["chapter-2"], sectionIds: ["section-2"], description: "Chapter Two" },
    keyPoints: [], attempts: [], transcript: [], createdAt: timestamp, updatedAt: timestamp,
  }],
  currentSectionId: "section-1", currentExamId: "exam-1", currentTutorId: "tutor-1",
  noteDirectory: "Diagnostics", createdAt: timestamp, updatedAt: timestamp,
});

let passed = 0;
let failed = 0;
const test = (name, run) => {
  try { run(); passed++; console.log(`[PASS] ${name}`); }
  catch (error) { failed++; console.error(`[FAIL] ${name}: ${error.message}`); }
};
const rejectWith = (name, invalidate, expected) => test(name, () => {
  const book = baseBook();
  assert.equal(isScholarBook(book), true, "baseline fixture must be valid before mutation");
  invalidate(book);
  assert.equal(isScholarBook(book), false, "the independent mutation must invalidate the book");
  const before = structuredClone(book);
  const issues = scholarBookIssues(book);
  assert(issues.some((issue) => expected.test(issue)), `expected ${expected}; received ${JSON.stringify(issues)}`);
  assert(!issues.some((issue) => /no single field could be isolated/.test(issue)), "must not use the generic fallback");
  assert.deepEqual(book, before, "diagnostics must not mutate input");
});

test("valid linked book and shared chapter boundary yield no issues", () => {
  assert.equal(isScholarBook(baseBook()), true);
  assert.deepEqual(scholarBookIssues(baseBook()), []);
});
test("chapter array order does not change overlap acceptance", () => {
  const book = baseBook();
  book.chapters.reverse();
  assert.equal(isScholarBook(book), true);
  assert.deepEqual(scholarBookIssues(book), []);
});
test("optional current record IDs can be absent", () => {
  const book = baseBook();
  delete book.currentExamId;
  delete book.currentTutorId;
  assert.equal(isScholarBook(book), true);
  assert.deepEqual(scholarBookIssues(book), []);
});
for (const status of ["pending", "ready", "needs-review", "needs-ocr"]) {
  test(`accepted outlineStatus ${status} still produces no issues`, () => {
    const book = baseBook();
    book.outlineStatus = status;
    assert.equal(isScholarBook(book), true);
    assert.deepEqual(scholarBookIssues(book), []);
  });
}
for (const status of ["invalid", "READY", "", null, 4, {}, []]) {
  rejectWith(`invalid outlineStatus ${JSON.stringify(status)} identifies its field`,
    (book) => { book.outlineStatus = status; }, /^outlineStatus .*pending.*ready.*needs-review.*needs-ocr/);
}
rejectWith("reversed book timestamps identify updatedAt", (book) => {
  book.updatedAt = "2026-09-04T11:59:59.999Z";
}, /^updatedAt .*earlier than createdAt/);
rejectWith("overlapping valid chapters identify chapters", (book) => {
  book.chapters[1].startPage = 9;
}, /^chapters .*overlap.*shared boundary/);
rejectWith("duplicate chapter orders identify chapters", (book) => {
  book.chapters[1].order = book.chapters[0].order;
}, /^chapters(?:\[1\]\.order)? .*duplicate.*order/);
for (const field of ["currentExamId", "currentTutorId"]) {
  rejectWith(`dangling ${field} identifies its field`, (book) => { book[field] = "missing"; }, new RegExp(`^${field} names no `));
  for (const badId of [null, "", " padded ", "line\nbreak", 42, {}, []]) {
    rejectWith(`malformed ${field} ${JSON.stringify(badId)} identifies its field`,
      (book) => { book[field] = badId; }, new RegExp(`^${field} must be `));
  }
}
for (const collection of ["chapters", "exams", "tutorSessions"]) {
  for (const malformed of [null, 4, "text", [], {}]) {
    rejectWith(`${collection} safely diagnoses member ${JSON.stringify(malformed)}`, (book) => {
      book[collection].push(malformed);
    }, new RegExp(`^${collection}\\[\\d+\\](?: |\\.)`));
  }
  rejectWith(`${collection} safely diagnoses a non-array`, (book) => { book[collection] = null; }, new RegExp(`^${collection} must be an array`));
}
for (const relativePath of [null, undefined, 4, {}, []]) {
  rejectWith(`malformed source.relativePath ${JSON.stringify(relativePath)} cannot crash diagnostics`,
    (book) => { book.source.relativePath = relativePath; }, /^source\.relativePath /);
}
for (const value of [null, undefined, 42, "book", false, []]) {
  test(`non-object book ${JSON.stringify(value)} cannot crash diagnostics`, () => {
    assert.equal(isScholarBook(value), false);
    assert.deepEqual(scholarBookIssues(value), ["book state is not an object"]);
  });
}
test("independent invariant failures are reported together without duplicates", () => {
  const book = baseBook();
  book.outlineStatus = "invalid";
  book.updatedAt = "2026-09-04T11:00:00.000Z";
  book.chapters[1].startPage = 9;
  book.chapters[1].order = 1;
  book.currentExamId = "missing-exam";
  book.currentTutorId = "missing-tutor";
  const issues = scholarBookIssues(book);
  for (const pattern of [/^outlineStatus /, /^updatedAt /, /^chapters .*overlap/, /^chapters.*duplicate.*order/, /^currentExamId /, /^currentTutorId /]) {
    assert(issues.some((issue) => pattern.test(issue)), `missing ${pattern}: ${JSON.stringify(issues)}`);
  }
  assert.equal(new Set(issues).size, issues.length);
});
test("malformed members do not hide missing current record references", () => {
  const book = baseBook();
  book.exams = [null, 4, "exam"];
  book.tutorSessions = [null, false, "tutor"];
  const issues = scholarBookIssues(book);
  assert(issues.some((issue) => /^currentExamId names no exam/.test(issue)));
  assert(issues.some((issue) => /^currentTutorId names no tutor session/.test(issue)));
});

console.log(`\nScholar Round 3 diagnostics summary: ${passed} passed, ${failed} failed.`);
process.exitCode = failed ? 1 : 0;
