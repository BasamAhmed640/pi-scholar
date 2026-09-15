// The simplified Learn flow: lessonComplete commits without any reviewer model,
// three resolved short questions complete the section, multi-part questions are
// refused, and the consecutive-rejection loop guard still stops delivery.
// Synthetic in-memory records only; no vault, PDF or network access.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { extensionPath, piPackageRoot, jitiPath, resolvePiDependency, sdkAliases } from "./sdk.mjs";
import { saveFixtureLesson } from "./lesson-fixture.mjs";

const piRequire = createRequire(join(piPackageRoot, "package.json"));
const { createJiti } = await import(pathToFileURL(jitiPath).href);
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: { ...sdkAliases,
  "@earendil-works/pi-coding-agent": join(piPackageRoot, "dist", "index.js"),
  "@earendil-works/pi-tui": piRequire.resolve("@earendil-works/pi-tui"),
  typebox: piRequire.resolve("typebox"),
} });
const loadModule = name => jiti.import(join(dirname(extensionPath), name));
const lesson = await loadModule("lesson.ts");
const domain = await loadModule("domain.ts");
const { createScholarToolController } = await loadModule("tool-controller.ts");
const { ScholarRuntimeSession } = await loadModule("runtime-session.ts");

const now = "2026-09-14T00:00:00.000Z";
const objective = "Explain how length and speed determine travel time";
const keyPoint = "At fixed speed, doubling the path length doubles travel time.";
const grounding = purpose => ({ purpose, competency: objective, requiredEvidence: ["State the proportional change in travel time"], sourcePages: [1],
  basis: [{ kind: "objective", value: objective, supports: [1] }] });

function fixture(caseId) {
  const section = {
    id: "s1", number: "1.1", title: "Travel time", order: 1, startPage: 1, endPage: 1,
    objectives: [objective], coveredObjectives: [], requiredChecks: ["conceptual"], objectiveChecks: [{ objective, checks: ["conceptual"] }],
    keyPoints: [keyPoint], misconceptions: [], status: "learning",
    synthesis: "Travel time follows from path length and speed; doubling the length doubles the time only while speed stays fixed.",
    transcript: [], attempts: [],
    figureCoverage: { pages: [{ page: 1, read: true, viewed: { width: 600, height: 800 }, candidates: [],
      review: { page: 1, observation: "The full source page contains text and no figures.", figures: [] } }] },
    learnQuality: { version: 1, coverage: [{ id: "time-concept", kind: "concept", description: "Explain the physical meaning of travel time",
      sourcePages: [1], objective, lessonId: "fixture-explanation", evidence: "A model connects an input to an observable result." }], reviews: [] },
    createdAt: now, updatedAt: now,
  };
  const book = {
    schemaVersion: 3, revision: 0, id: "a".repeat(64), instanceId: `simple-learn-${caseId}`,
    source: { absolutePath: "unopened.pdf", relativePath: "unopened.pdf", fileName: "unopened.pdf", format: "pdf", fingerprint: { sha256: "a".repeat(64), size: 1, mtimeMs: 1 } },
    metadata: { title: "Simple Learn fixture", authors: [], pageCount: 1 }, outlineStatus: "ready",
    chapters: [{ id: "c1", number: "1", order: 1, title: "Motion", startPage: 1, endPage: 1, status: "learning", sections: [section] }],
    currentSectionId: "s1", exams: [], tutorSessions: [], noteDirectory: "Simple Learn fixture", createdAt: now, updatedAt: now,
  };
  saveFixtureLesson(lesson, book, section);
  return book;
}

function harness(caseId) {
  const book = fixture(caseId);
  const session = new ScholarRuntimeSession();
  session.activate(book.id, "learn", "s1");
  let definition, nextCall = 0, reviewerCalls = 0;
  createScholarToolController({
    pi: { registerTool(tool) { definition = tool; } },
    session,
    getConfig: () => ({ libraryRoot: "/synthetic-library", obsidianRoot: "/synthetic-vault" }),
    loadBook: async () => book,
    mutateBook: async (_id, mutate) => ({ book, result: await mutate(book) }),
    isActiveAuthority: () => true,
    isSetupActive: () => false,
  }).ensureRegistered();
  const context = { hasUI: false, model: { id: "simple-learn", provider: "fixture", api: "fixture", input: ["text"], contextWindow: 100_000, maxTokens: 8000 },
    modelRegistry: { complete: async () => { reviewerCalls++; throw new Error("no reviewer may run"); } } };
  return {
    book,
    section: book.chapters[0].sections[0],
    reviewerCalls: () => reviewerCalls,
    execute: params => definition.execute(`simple-learn-${caseId}-${++nextCall}`, params, undefined, undefined, context),
  };
}

let passed = 0, failed = 0;
async function check(name, test) {
  try { await test(); passed++; console.log(`[PASS] ${name}`); }
  catch (error) { failed++; console.error(`[FAIL] ${name}: ${error.stack || error.message}`); }
}

await check("lessonComplete commits with zero reviewer model requests", async () => {
  const h = harness("commit");
  const result = await h.execute({ action: "notes", lessonComplete: true });
  assert.notEqual(result.details.tone, "retry");
  assert.notEqual(result.details.tone, "error");
  assert.equal(h.reviewerCalls(), 0, "no reviewer model may be called");
  assert.match(result.content[0].text, /Full lesson saved/);
  assert.ok(h.section.lessonCommit, "the lesson is committed");
  domain.recomputeProgress(h.book, h.section);
  assert.notEqual(h.section.status, "complete", "the lesson alone does not complete the section");
  assert.deepEqual(domain.quickQuestionBlockers(h.section), ["3 more short questions"]);
});

await check("three resolved short questions, including a cancelled one, complete the section", async () => {
  const h = harness("questions"), section = h.section;
  section.attempts.push({ id: "diagnostic", kind: "conceptual", format: "open", question: "Warm-up", outcome: "pass", grounding: grounding("diagnostic"), createdAt: now });
  domain.recomputeProgress(h.book, section);
  assert.equal(domain.answeredQuickQuestions(section), 0, "a diagnostic question does not count toward the three");
  assert.notEqual(section.status, "complete");
  section.attempts.push(
    { id: "q-pass", kind: "conceptual", format: "open", question: "What does doubling the length do?", outcome: "pass", grounding: grounding("mastery"), createdAt: now },
    { id: "q-cancelled", kind: "computation", format: "open", question: "Compute the travel time.", outcome: "cancelled", grounding: grounding("mastery"), createdAt: now },
    { id: "q-missed", kind: "application", format: "open", question: "Apply the relation to a new case.", outcome: "review", grounding: grounding("mastery"), createdAt: now },
  );
  assert.equal(domain.answeredQuickQuestions(section), 3);
  assert.deepEqual(domain.quickQuestionBlockers(section), []);
  domain.recomputeProgress(h.book, section);
  assert.equal(section.status, "complete");
});

await check("a multi-part question is rejected and a short one is accepted", async () => {
  const h = harness("multipart");
  const rejected = await h.execute({ action: "assess", outcome: "pending", kind: "conceptual",
    question: "(a) Find the travel time. (b) Find the distance covered.", expectedAnswer: "Two answers.", criteria: ["Both parts explained."],
    grounding: grounding("mastery") });
  assert.equal(rejected.details.tone, "retry");
  assert.match(rejected.content[0].text, /one part at a time/i);
  assert.equal(h.section.attempts.length, 0);
  assert.throws(() => domain.assertShortQuestion("x".repeat(601)), /too long/i);
  assert.doesNotThrow(() => domain.assertShortQuestion("How long does the trip take at the same speed?"));
});

await check("eight consecutive rejections still stop delivery", async () => {
  const h = harness("rejections");
  for (let index = 1; index < 8; index++) {
    const rejected = await h.execute({ action: "assess", outcome: "pending", kind: "conceptual" });
    assert.equal(rejected.details.tone, "retry", `rejection ${index}: ${rejected.content[0].text}`);
  }
  const eighth = await h.execute({ action: "assess", outcome: "pending", kind: "conceptual" });
  assert.equal(eighth.details.tone, "error");
  assert.match(eighth.content[0].text, /8 consecutive rejections/);
  const blocked = await h.execute({ action: "read", startPage: 1, endPage: 1 });
  assert.equal(blocked.details.tone, "error");
  const status = await h.execute({ action: "status" });
  assert.equal(status.details.action, "status", "status stays available after a delivery stop");
});

console.log(`Scholar simple-learn summary: ${passed} passed, ${failed} failed.`);
process.exitCode = failed ? 1 : 0;
