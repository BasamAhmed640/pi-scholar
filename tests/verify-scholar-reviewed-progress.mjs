import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { extensionPath, jitiPath, sdkAliases } from "./sdk.mjs";

const { createJiti } = await import(pathToFileURL(jitiPath).href);
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: sdkAliases });
const load = name => jiti.import(join(dirname(extensionPath), name));
const lesson = await load("lesson.ts");
const domain = await load("domain.ts");
const { handleNotes } = await load("tool-actions/learning.ts");
const { details, readDetails, transcriptBlock, readTranscript } = await load("note-records.ts");
const now = "2026-09-13T00:00:00.000Z";
const objective = "Explain why zero divergence does not imply a zero field";
const keyPoint = "Zero net outward flux can coexist with a nonzero field.";
const explanation = "A uniform field enters one face and leaves the opposite face. Those contributions cancel in the net outward flux even though the field remains nonzero.";
const sourceHash = "a".repeat(64);
const sectionOf = book => book.chapters[0].sections[0];
function attempt(id = "mastery", purpose = "mastery", outcome = "pass") {
  return { id, kind: "conceptual", format: "multiple-choice", outcome, question: "Explain the uniform-field counterexample.", createdAt: now,
    grounding: { purpose, competency: objective, requiredEvidence: ["Explain cancellation of opposing fluxes"], sourcePages: [1],
      basis: [{ kind: "objective", value: objective, supports: [1] }] } };
}
function fixture({ completed = false } = {}) {
  const section = { id: "s1", order: 1, number: "4.3", title: "Electric displacement", startPage: 1, endPage: 1,
    objectives: [objective], coveredObjectives: [objective], requiredChecks: ["conceptual"], objectiveChecks: [{ objective, checks: ["conceptual"] }],
    status: "learning", synthesis: "A zero-divergence field may remain nonzero because inward and outward flux can cancel.", keyPoints: [keyPoint], misconceptions: [], transcript: [], attempts: [],
    figureCoverage: { pages: [{ page: 1, read: true, viewed: { width: 600, height: 800 }, candidates: [], review: { page: 1, observation: "The full source page contains text with no figures.", figures: [] } }] },
    learnQuality: { version: 1, coverage: [{ id: "flux-example", kind: "counterexample", description: "Uniform nonzero field with zero divergence", sourcePages: [1], objective,
      lessonId: "flux", evidence: explanation }], reviews: [] }, createdAt: now, updatedAt: now };
  const book = { schemaVersion: 3, revision: 0, id: sourceHash, instanceId: "reviewed-progress-fixture",
    source: { absolutePath: "synthetic-unopened.pdf", relativePath: "synthetic-unopened.pdf", fileName: "synthetic-unopened.pdf", format: "pdf", fingerprint: { sha256: sourceHash, size: 1, mtimeMs: 1 } },
    metadata: { title: "Synthetic reviewed-progress fixture", authors: [], pageCount: 1 }, outlineStatus: "ready",
    chapters: [{ id: "c1", number: "4", order: 1, title: "Fields", startPage: 1, endPage: 1, status: "learning", sections: [section] }],
    exams: [], tutorSessions: [], currentSectionId: "s1", createdAt: now, updatedAt: now };
  lesson.saveLesson(section, book, { id: "flux", title: "A zero-divergence counterexample", markdown: `### A uniform field\n\n${explanation}`,
    objectives: [objective], keyPoints: [keyPoint], sourcePages: [1] });
  section.learnQuality.reviews = ["source", "teaching", "visual"].map(role => ({ role, status: "pass", findings: [], model: "any-provider/reviewer",
    sourceHash, contentHash: lesson.learnReviewHash(section), createdAt: now }));
  lesson.commitLesson(section, book);
  if (completed) section.attempts.push(attempt());
  domain.recomputeProgress(book, section);
  return book;
}
async function notes(book, params) {
  return handleNotes(book, { mode: "learn", recordId: "s1" }, params, sectionOf,
    async (_id, update) => {
      const copy = structuredClone(book), result = await update(copy);
      Object.assign(book, copy);
      return { book, result };
    }, (action, summary) => ({ content: [{ type: "text", text: summary }], details: { action, summary } }));
}
const recap = "A uniform field remains nonzero while opposite faces contribute equal and opposite outward flux.";
let checks = 0, failures = 0;
async function check(name, fn) {
  checks++;
  try { await fn(); console.log(`[PASS] ${name}`); }
  catch (error) { failures++; console.error(`[FAIL] ${name}\n${error.stack}`); }
}

await check("Independent lesson approval alone cannot manufacture earned completion", async () => {
  const book = fixture(), section = sectionOf(book);
  assert(lesson.lessonReady(section, sourceHash));
  assert.notEqual(section.status, "complete");
  assert.equal(section.learnQuality.earnedDelivery, undefined);
  section.attempts.push(attempt());
  domain.recomputeProgress(book, section);
  assert.equal(section.status, "complete");
  assert.deepEqual(section.learnQuality.earnedDelivery, { sourceHash, objectiveHash: lesson.lessonObjectiveHash(section) });
});

await check("Reviewed completion survives later practice explanation and recap changes", async () => {
  const book = fixture({ completed: true });
  const earned = structuredClone(sectionOf(book).learnQuality.earnedDelivery);
  sectionOf(book).attempts.push(attempt("practice", "practice", "review"));
  await notes(book, { synthesis: recap, keyPoints: ["The cancellation concerns flux, not the field itself."], misconceptions: ["Do not confuse zero divergence with zero field."] });
  assert.equal(sectionOf(book).status, "complete");
  assert.equal(book.chapters[0].status, "complete");
  assert.deepEqual(sectionOf(book).learnQuality.earnedDelivery, earned);
  assert(lesson.learnReviewIssues(sectionOf(book), sourceHash).length, "Old editorial receipts honestly become stale");
  assert(lesson.lessonReady(sectionOf(book), sourceHash), "Earned instructional delivery survives an additional practice note");
  const current = sectionOf(book).transcript[0];
  await notes(book, { lesson: { id: "flux", title: "A zero-divergence counterexample", markdown: `${current.markdown}\n\nThe equal fluxes have opposite signs because the outward normals point in opposite directions.`,
    expectedContentHash: lesson.lessonHash(current.markdown), objectives: [objective], keyPoints: [keyPoint], sourcePages: [1] } });
  assert.equal(sectionOf(book).status, "complete");
  assert.equal(domain.learnQuestionGrounding(sectionOf(book), attempt().grounding).purpose, "practice");
});

await check("Deleting or changing actual mastery evidence still removes completion", async () => {
  for (const mutate of [
    section => { section.attempts = []; },
    section => { section.attempts[0].outcome = "review"; },
    section => { section.attempts[0].grounding.purpose = "practice"; },
    section => { section.attempts[0].grounding.purpose = "diagnostic"; },
  ]) {
    const book = fixture({ completed: true }), section = sectionOf(book);
    mutate(section);
    domain.recomputeProgress(book, section);
    assert.notEqual(section.status, "complete");
    assert(domain.sectionCompletionBlockers(section).some(issue => /evidence|check/.test(issue)));
  }
});

await check("A different source, scope, objective or mastery plan cannot borrow earned delivery", async () => {
  const complete = fixture({ completed: true });
  assert.equal(lesson.lessonReady(sectionOf(complete), "b".repeat(64)), false);
  for (const [label, mutate] of [
    ["identity", section => { section.id = "another-section"; }],
    ["scope", section => { section.endPage = 2; }],
    ["objectives", section => { section.objectives = ["A different objective"]; }],
    ["objective checks", section => { section.objectiveChecks[0].checks.push("application"); }],
    ["required checks", section => { section.requiredChecks.push("application"); }],
  ]) {
    const book = structuredClone(complete), section = sectionOf(book);
    mutate(section);
    assert.equal(lesson.lessonReady(section, sourceHash), false, `Changed ${label} cannot reuse the old lesson approval`);
    domain.recomputeProgress(book, section);
    assert.notEqual(section.status, "complete");
  }
});

await check("Progress recomputation binds earned delivery to the current book source", async () => {
  const changedSource = fixture({ completed: true });
  changedSource.source.fingerprint.sha256 = "b".repeat(64);
  domain.recomputeProgress(changedSource, sectionOf(changedSource));
  assert.notEqual(sectionOf(changedSource).status, "complete", "Progress must use the current book source, not the old commit's source hash");
});

await check("A reviewed lesson may repair an excessive check plan and false key point before assessment", async () => {
  const book = fixture(), section = sectionOf(book);
  const all = ["conceptual", "application", "computation", "discrimination"];
  section.objectiveChecks[0].checks = all;
  section.requiredChecks = [...all];
  section.keyPoints = ["Zero divergence means the field is zero."];
  await notes(book, { synthesis: recap, keyPoints: [keyPoint], objectiveChecks: [{ objective, checks: ["conceptual"] }] });
  assert.deepEqual(sectionOf(book).objectiveChecks, [{ objective, checks: ["conceptual"] }]);
  assert.deepEqual(sectionOf(book).requiredChecks, ["conceptual"]);
  assert.deepEqual(sectionOf(book).keyPoints, [keyPoint]);
  assert.equal(sectionOf(book).learnQuality.earnedDelivery, undefined);
  assert.equal(lesson.lessonReady(sectionOf(book), sourceHash), false, "Corrected editorial state requires fresh review before question delivery");
  const diagnosticBook = fixture();
  sectionOf(diagnosticBook).attempts.push(attempt("diagnostic", "diagnostic", "review"));
  sectionOf(diagnosticBook).objectiveChecks[0].checks = [...all];
  sectionOf(diagnosticBook).requiredChecks = [...all];
  await notes(diagnosticBook, { synthesis: recap, keyPoints: [keyPoint], objectiveChecks: [{ objective, checks: ["conceptual"] }] });
  assert.deepEqual(sectionOf(diagnosticBook).requiredChecks, ["conceptual"], "A diagnostic is not an earned mastery requirement");
});

await check("Once a mastery or practice question exists its requirements cannot be lowered", async () => {
  for (const purpose of ["mastery", "practice"]) {
    const book = fixture(), section = sectionOf(book);
    section.objectiveChecks[0].checks = ["conceptual", "application"];
    section.requiredChecks = ["conceptual", "application"];
    section.attempts.push(attempt("prepared", purpose, "pending"));
    const before = structuredClone(book);
    await assert.rejects(notes(book, { synthesis: recap, keyPoints: [keyPoint], objectiveChecks: [{ objective, checks: ["conceptual"] }] }), /Keep existing objective checks/);
    assert.deepEqual(book, before);
    await assert.rejects(notes(book, { synthesis: recap, keyPoints: [keyPoint], requiredChecks: ["conceptual"] }), /checks are fixed/);
    assert.deepEqual(book, before);
  }
});

await check("Completed practice cannot adopt or replace a source-coverage contract", async () => {
  const book = fixture({ completed: true });
  const before = structuredClone(book);
  const changed = structuredClone(sectionOf(book).learnQuality.coverage); changed[0].description = "A newly substituted source claim";
  await assert.rejects(notes(book, { synthesis: recap, keyPoints: [keyPoint], sourceCoverage: changed }), /Practice cannot adopt or replace/);
  assert.deepEqual(book, before);
  const older = fixture({ completed: true });
  delete sectionOf(older).learnQuality;
  await assert.rejects(notes(older, { synthesis: recap, keyPoints: [keyPoint], sourceCoverage: changed }), /Practice cannot adopt or replace/);
});

await check("Earned delivery survives the note codec without hiding or restoring deleted questions", async () => {
  const book = fixture({ completed: true }), section = sectionOf(book);
  const quality = readDetails(details("section", { learnQuality: section.learnQuality }), "section").learnQuality;
  assert.deepEqual(quality.earnedDelivery, section.learnQuality.earnedDelivery);
  section.learnQuality = quality;
  section.transcript = readTranscript(transcriptBlock(section.transcript));
  assert(lesson.lessonReady(section, sourceHash));
  section.attempts = [];
  domain.recomputeProgress(book, section);
  assert.notEqual(section.status, "complete");
});

console.log(`Scholar reviewed progress: ${checks - failures}/${checks} checks passed using synthetic in-memory records; no study-vault or network access.`);
process.exitCode = failures ? 1 : 0;
