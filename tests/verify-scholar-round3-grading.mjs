import { sdkAliases } from "./sdk.mjs";
import { extensionPath as packagedExtensionPath, piPackageRoot as sdkRoot, jitiPath as sdkJitiPath, resolvePiDependency } from "./sdk.mjs";
// Exercise the real grading boundary, controller presentation and vault save path.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, basename, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const piRoot = sdkRoot;
const { createJiti } = await import(pathToFileURL(sdkJitiPath).href);
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: { ...sdkAliases,
  "@earendil-works/pi-coding-agent": join(piRoot, "dist", "index.js"),
  "@earendil-works/pi-tui": resolvePiDependency("@earendil-works/pi-tui"),
  "typebox": createRequire(join(piRoot, "package.json")).resolve("typebox"),
} });
const extension = dirname(process.env.PI_SCHOLAR_EXTENSION || packagedExtensionPath);
const mod = (path) => jiti.import(join(extension, path));
const { handleExamGrade } = await mod("tool-actions/exam.ts");
const { createScholarToolController } = await mod("tool-controller.ts");
const { ScholarRuntimeSession } = await mod("runtime-session.ts");
const { isScholarBook, scholarBookIssues } = await mod("state-schema.ts");
const { createBookService } = await mod("book-service.ts");
const { createBookState, loadBookState, saveBookState, listBookStates, bookStatePath } = await mod("storage.ts");

const root = await mkdtemp(join(tmpdir(), "scholar-round3-grading-"));
const config = { schemaVersion: 3, libraryRoot: join(root, "library"), obsidianRoot: join(root, "vault"), stateRoot: join(root, "bootstrap"), updatedAt: new Date().toISOString() };
await mkdir(config.libraryRoot);
await mkdir(config.obsidianRoot);
const timestamp = "2026-01-01T00:00:00.000Z";
function fixture() {
  return {
    schemaVersion: 3, revision: 0, id: "a".repeat(64), instanceId: "grading-fixture",
    source: { absolutePath: join(config.libraryRoot, "fixture.pdf"), relativePath: "fixture.pdf", fileName: "fixture.pdf", format: "pdf", fingerprint: { sha256: "a".repeat(64), size: 1, mtimeMs: 1 } },
    metadata: { title: "Grading fixture", authors: [], pageCount: 1 }, outlineStatus: "ready",
    chapters: [{ id: "c1", order: 1, title: "One", startPage: 1, endPage: 1, status: "not-started", sections: [{
      id: "s1", order: 1, title: "Section", startPage: 1, endPage: 1, status: "not-started",
      objectives: [], coveredObjectives: [], requiredChecks: ["conceptual"], keyPoints: [], misconceptions: [], attempts: [], transcript: [], createdAt: timestamp, updatedAt: timestamp,
    }] }],
    exams: [{ id: "e1", title: "Exam", status: "submitted", scope: { chapterIds: ["c1"], sectionIds: ["s1"], description: "Chapter 1" },
      questions: [{ id: "q1", sectionIds: ["s1"], dimensions: ["reasoning"], claim: "Explains a relation", requiredEvidence: ["explanation"], format: "open", prompt: "Explain the relation.", explanation: "The relation follows from the model.", maxPoints: 2,
        rubric: [{ id: "r1", criterion: "Explains", requiredEvidence: ["explanation"], points: 2 }] }],
      rawResponses: [{ questionId: "q1", response: "Learner response" }], itemResults: [], breakdown: [], earnedPoints: 0, maxPoints: 2, percent: 0, transcript: [],
      createdAt: timestamp, startedAt: timestamp, submittedAt: timestamp, updatedAt: timestamp,
    }], currentExamId: "e1", tutorSessions: [], noteDirectory: "Grading fixture", createdAt: timestamp, updatedAt: timestamp,
  };
}
const correct = (fields = {}) => ({ questionId: "q1", outcome: "correct", earnedPoints: 2, maxPoints: 2, feedback: " Explains the relation. ", ...fields });
const toolResult = (action, summary, details = {}) => ({ content: [{ type: "text", text: summary }], details: { action, summary, ...details } });

function harness(initial = fixture()) {
  let stored = structuredClone(initial), mutations = 0;
  const mutateBook = async (_id, mutate) => {
    mutations++;
    const draft = structuredClone(stored);
    const result = await mutate(draft);
    assert.ok(isScholarBook(draft), `Refusing to save invalid Scholar book state: ${scholarBookIssues(draft).join("; ")}`);
    stored = JSON.parse(JSON.stringify(draft));
    return { book: structuredClone(stored), result };
  };
  const session = new ScholarRuntimeSession();
  session.activate(initial.id, "exam", "e1");
  let definition;
  createScholarToolController({ pi: { registerTool: (value) => { definition = value; } }, session, getConfig: () => config,
    loadBook: async () => structuredClone(stored), mutateBook, isActiveAuthority: () => true, isSetupActive: () => false,
  }).ensureRegistered();
  return { get stored() { return stored; }, get mutations() { return mutations; }, mutateBook,
    grade: (items) => handleExamGrade(structuredClone(stored), "e1", items, mutateBook, toolResult),
    execute: (items) => definition.execute("grade-call", { action: "exam_grade", itemResults: items }),
  };
}

let passed = 0, failed = 0;
async function check(name, run) {
  try { await run(); passed++; console.log(`[PASS] ${name}`); }
  catch (error) { failed++; console.error(`[FAIL] ${name}: ${error.message}`); }
}
try {
  await check("submitted fixture is valid before grading", () => assert.ok(isScholarBook(fixture()), scholarBookIssues(fixture()).join("; ")));
  const invalid = [
    ["undefined array", undefined, /itemResults must be an array/],
    ["null array", null, /itemResults must be an array/],
    ["object instead of array", {}, /itemResults must be an array/],
    ["null member", [null], /itemResults\[0\].*object/],
    ["array member", [[]], /itemResults\[0\].*object/],
    ["missing result", [], /exactly one unique/],
    ["duplicate result", [correct(), correct()], /exactly one unique/],
    ["unknown question", [correct({ questionId: "other" })], /Missing result for q1/],
    ["unknown outcome", [correct({ outcome: "wrong" })], /q1 outcome must be/],
    ["missing outcome", [correct({ outcome: undefined })], /q1 outcome must be/],
    ["partial with full credit", [correct({ outcome: "partial" })], /q1 outcome.*contradicts/],
    ["partial with zero credit", [correct({ outcome: "partial", earnedPoints: 0 })], /q1 outcome.*contradicts/],
    ["correct with partial credit", [correct({ earnedPoints: 1 })], /q1 outcome.*contradicts/],
    ["incorrect with credit", [correct({ outcome: "incorrect", earnedPoints: 1 })], /q1 outcome.*contradicts/],
    ["unanswered with credit", [correct({ outcome: "unanswered" })], /q1 outcome.*contradicts/],
    ["NaN", [correct({ earnedPoints: NaN })], /q1.*non-numeric/],
    ["Infinity", [correct({ earnedPoints: Infinity })], /q1.*non-numeric/],
    ["numeric string", [correct({ earnedPoints: "2" })], /q1.*non-numeric/],
    ["unprintable earnedPoints object", [correct({ earnedPoints: { toString: 0, valueOf: 0 } })], /q1.*non-numeric/],
    ["unprintable maxPoints object", [correct({ maxPoints: { toString: 0, valueOf: 0 } })], /q1.*non-numeric/],
    ["negative credit", [correct({ earnedPoints: -1 })], /Invalid score for q1/],
    ["excess credit", [correct({ earnedPoints: 3 })], /Invalid score for q1/],
    ["wrong frozen max previously within .001", [correct({ maxPoints: 2.0005 })], /Invalid score for q1/],
    ["zero max", [correct({ maxPoints: 0 })], /Invalid score for q1/],
    ["blank feedback", [correct({ feedback: " " })], /q1 needs diagnostic feedback/],
    ...["diagnosticSummary", "firstDecisiveError", "correctReasoning", "transferableLesson"].flatMap((field) =>
      [null, " ", 42].map((value) => [`invalid ${field} ${JSON.stringify(value)}`, [correct({ [field]: value })], new RegExp(`q1 ${field} must be non-empty`)])),
  ];
  for (const [name, items, pattern] of invalid) {
    await check(`rejects ${name} before mutation`, async () => {
      const h = harness(), before = JSON.stringify(h.stored);
      await assert.rejects(() => h.grade(items), pattern);
      assert.equal(h.mutations, 0);
      assert.equal(JSON.stringify(h.stored), before);
    });
  }
  for (const outcome of ["correct", "partial", "incorrect", "unanswered"]) {
    await check(`valid ${outcome} grade survives JSON and schema validation`, async () => {
      const h = harness(), earnedPoints = outcome === "correct" ? 2 : outcome === "partial" ? 0.5 : 0;
      await h.grade([correct({ outcome, earnedPoints, diagnosticSummary: " Evidence summary. " })]);
      assert.equal(h.stored.exams[0].status, "graded");
      assert.equal(h.stored.exams[0].percent, earnedPoints / 2 * 100);
      assert.equal(h.stored.exams[0].itemResults[0].diagnosticSummary, "Evidence summary.");
      assert.equal(h.mutations, 1);
    });
  }
  await check("model annotations cannot leak into authoritative results", async () => {
    const h = harness();
    await h.grade([correct({ privateScratch: "not part of the state schema" })]);
    assert.ok(!Object.hasOwn(h.stored.exams[0].itemResults[0], "privateScratch"));
    assert.equal(h.stored.exams[0].itemResults[0].feedback, "Explains the relation.");
  });
  await check("floating arithmetic noise uses the frozen maximum", async () => {
    const h = harness();
    await h.grade([correct({ maxPoints: 2 + Number.EPSILON * 2 })]);
    assert.equal(h.stored.exams[0].itemResults[0].maxPoints, 2);
  });
  await check("controller returns actionable retry, not error, and accepts correction", async () => {
    const h = harness();
    const retry = await h.execute([correct({ outcome: "incorrect", earnedPoints: 1 })]);
    assert.equal(retry.details.tone, "retry");
    assert.match(retry.content[0].text, /Scholar retry:.*q1 outcome.*contradicts/);
    assert.equal(h.mutations, 0);
    const success = await h.execute([correct({ outcome: "partial", earnedPoints: 1 })]);
    assert.ok(!success.details.tone);
    assert.equal(h.stored.exams[0].percent, 50);
  });
  await check("real storage failure remains a visible operational error", async () => {
    const book = fixture(), session = new ScholarRuntimeSession();
    session.activate(book.id, "exam", "e1");
    let definition;
    createScholarToolController({ pi: { registerTool: (value) => { definition = value; } }, session, getConfig: () => config,
      loadBook: async () => book, mutateBook: async () => { throw Object.assign(new Error("Disk full"), { code: "ENOSPC" }); },
      isActiveAuthority: () => true, isSetupActive: () => false,
    }).ensureRegistered();
    const result = await definition.execute("grade-call", { action: "exam_grade", itemResults: [correct()] });
    assert.equal(result.details.tone, "error");
    assert.match(result.content[0].text, /Scholar error: Disk full/);
  });
  await check("vault bytes are untouched on rejection and a corrected grade persists once", async () => {
    const book = fixture();
    await createBookState(config, book);
    const statePath = bookStatePath(config, book), before = await readFile(statePath, "utf8");
    const service = createBookService({ getConfig: () => config, load: loadBookState, save: saveBookState, list: listBookStates,
      project: async () => {}, onSave: () => {}, librarySetupMessage: "Configure library" });
    await assert.rejects(() => handleExamGrade(book, "e1", [correct({ outcome: "partial" })], service.mutateBook, toolResult), /outcome.*contradicts/);
    assert.equal(await readFile(statePath, "utf8"), before);
    await handleExamGrade(book, "e1", [correct({ outcome: "partial", earnedPoints: 1 })], service.mutateBook, toolResult);
    const restored = await loadBookState(config, book.id);
    assert.equal(restored.revision, 1);
    assert.equal(restored.exams[0].status, "graded");
    assert.equal(restored.exams[0].percent, 50);
    assert.ok(isScholarBook(restored));
  });
} finally {
  // Delete only this verifier's freshly-created, validated temporary root.
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  assert.ok(basename(root).startsWith("scholar-round3-grading-"));
  await rm(root, { recursive: true, force: true });
}
console.log(`\nScholar round3-grading summary: ${passed} passed, ${failed} failed.`);
process.exitCode = failed ? 1 : 0;
