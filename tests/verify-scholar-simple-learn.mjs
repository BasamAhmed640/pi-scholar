// The restored Learn flow: lessonComplete runs the independent source, teaching and
// visual review crew and commits only after all three pass; blocking findings come
// back as [F-<key>] repair requests the author answers with findingResponses without
// re-running the crew; three resolved short questions complete the section; multi-part
// questions are refused; and the consecutive-rejection loop guard still stops delivery.
// Synthetic in-memory records plus one real single-page PDF fixture; no vault or network access.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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
const { REVIEW_CHECKPOINT_MESSAGE } = await loadModule("review-layer.ts");
const { ScholarRuntimeSession } = await loadModule("runtime-session.ts");

const root = mkdtempSync(join(tmpdir(), "scholar-simple-learn-"));
const now = "2026-09-14T00:00:00.000Z";
const objective = "Explain how length and speed determine travel time";
const keyPoint = "At fixed speed, doubling the path length doubles travel time.";
const grounding = purpose => ({ purpose, competency: objective, requiredEvidence: ["State the proportional change in travel time"], sourcePages: [1],
  basis: [{ kind: "objective", value: objective, supports: [1] }] });

// The reviewers read the real source page through Poppler, so the fixture is a real PDF.
function pdfFixture() {
  const stream = "BT /F1 11 Tf 60 750 Td 18 TL (1.1 Travel time) Tj T* (Travel time follows from the path length and the speed.) Tj T* (At a fixed speed, doubling the distance doubles the time.) Tj ET";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => { const offset = Buffer.byteLength(pdf); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; return offset; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

const sourceBytes = pdfFixture();
const lessonMarkdown = [
  "### Travel time from a constant speed",
  "A model connects an input to an observable result. Travel time follows from the path length and the speed, so a prediction names the relation before it gives a number.",
  "",
  "$$t = \\frac{d}{v}$$",
  "",
  "Use the relation on the cited source page to predict which output changes when the input changes.",
].join("\n");

function fixture(caseId) {
  const libraryRoot = join(root, `${caseId}-library`);
  const sourcePath = join(libraryRoot, "travel-time.pdf");
  mkdirSync(libraryRoot, { recursive: true });
  writeFileSync(sourcePath, sourceBytes);
  const sha256 = createHash("sha256").update(sourceBytes).digest("hex");
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
    schemaVersion: 3, revision: 0, id: sha256, instanceId: `simple-learn-${caseId}`,
    source: { absolutePath: sourcePath, relativePath: "travel-time.pdf", fileName: "travel-time.pdf", format: "pdf",
      fingerprint: { sha256, size: sourceBytes.length, mtimeMs: statSync(sourcePath).mtimeMs } },
    metadata: { title: "Simple Learn fixture", authors: [], pageCount: 1 }, outlineStatus: "ready",
    chapters: [{ id: "c1", number: "1", order: 1, title: "Motion", startPage: 1, endPage: 1, status: "learning", sections: [section] }],
    currentSectionId: "s1", exams: [], tutorSessions: [], noteDirectory: "Simple Learn fixture", createdAt: now, updatedAt: now,
  };
  // The section starts uncommitted: only the review crew may approve it.
  saveFixtureLesson(lesson, book, section, { commit: false, markdown: lessonMarkdown });
  return book;
}

function harness(caseId, decide = () => ({ status: "pass", findings: [] })) {
  const book = fixture(caseId);
  const session = new ScholarRuntimeSession();
  session.activate(book.id, "learn", "s1");
  let definition, nextCall = 0;
  createScholarToolController({
    pi: { registerTool(tool) { definition = tool; } },
    session,
    getConfig: () => ({ libraryRoot: join(root, `${caseId}-library`), obsidianRoot: join(root, `${caseId}-vault`) }),
    loadBook: async () => book,
    mutateBook: async (_id, mutate) => ({ book, result: await mutate(book) }),
    isActiveAuthority: () => true,
    isSetupActive: () => false,
  }).ensureRegistered();
  const requests = [];
  const model = { id: "simple-learn", provider: "fixture", api: "fixture", input: ["text"], contextWindow: 100_000, maxTokens: 8000 };
  const context = { hasUI: false, model, modelRegistry: { complete: async (_selected, reviewContext) => {
    const role = /Assigned role: (\w+)\./.exec(reviewContext.systemPrompt)?.[1] || "unknown";
    requests.push({ role });
    return { role: "assistant", api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
      content: [{ type: "text", text: JSON.stringify(decide(requests.length, role)) }],
      usage: { input: 200, output: 40, cacheRead: 0, cacheWrite: 0, totalTokens: 240, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  } } };
  return {
    book,
    section: book.chapters[0].sections[0],
    requests,
    execute: params => definition.execute(`simple-learn-${caseId}-${++nextCall}`, params, undefined, undefined, context),
  };
}

const findingKeys = text => [...new Set([...text.matchAll(/\[F-([0-9a-f]{12})\]/g)].map(match => match[1]))];

let passed = 0, failed = 0;
async function check(name, test) {
  try { await test(); passed++; console.log(`[PASS] ${name}`); }
  catch (error) { failed++; console.error(`[FAIL] ${name}: ${error.stack || error.message}`); }
}

await check("lessonComplete commits after the source, teaching and visual reviews", async () => {
  const h = harness("commit");
  // Stale load artifacts: a checkpoint that a completed check already supersedes, and a check
  // bound to a different source. Neither may survive the approval write.
  const sourceHash = h.book.source.fingerprint.sha256;
  h.section.learnQuality.reviews.push(
    { role: "source", contentHash: lesson.learnReviewHash(h.section), sourceHash, model: "fixture/simple-learn", createdAt: now,
      status: "changes", findings: [], failure: { code: "cancelled", message: REVIEW_CHECKPOINT_MESSAGE }, batches: [] },
    { role: "visual", contentHash: lesson.learnReviewHash(h.section), sourceHash: "b".repeat(64), model: "fixture/simple-learn", createdAt: now,
      status: "pass", findings: [] });
  const result = await h.execute({ action: "notes", lessonComplete: true });
  assert.ok(!["review", "error", "retry"].includes(result.details.tone), result.content[0].text);
  const roles = new Set(h.requests.map(request => request.role));
  for (const role of ["source", "teaching", "visual"]) assert.ok(roles.has(role), `the ${role} reviewer ran`);
  assert.ok(h.requests.length >= 3, `at least three reviewer requests were served (${h.requests.length})`);
  const section = h.section, currentSourceHash = h.book.source.fingerprint.sha256;
  assert.equal(section.learnQuality.reviews.length, 3, "one approved receipt per review role; stale receipts were pruned");
  assert.ok(section.learnQuality.reviews.every(receipt => receipt.sourceHash === currentSourceHash && receipt.failure === undefined),
    "a superseded checkpoint and a foreign-source receipt are gone");
  for (const receipt of section.learnQuality.reviews) {
    assert.equal(receipt.status, "pass", `${receipt.role} passed`);
    assert.ok(["source", "teaching", "visual"].includes(receipt.role));
    assert.equal(receipt.contentHash, lesson.learnReviewHash(section), "the receipt is bound to the reviewed content");
    assert.equal(receipt.sourceHash, sourceHash);
  }
  assert.match(result.content[0].text, /Full lesson committed after source, teaching and visual review/);
  assert.ok(section.lessonCommit, "the reviewed lesson is committed");
  assert.ok(lesson.lessonReady(section, sourceHash), "the commit satisfies the Learn delivery gate");
  domain.recomputeProgress(h.book, section);
  assert.notEqual(section.status, "complete", "the lesson alone does not complete the section");
  assert.deepEqual(domain.quickQuestionBlockers(section), ["3 more short questions"]);
});

await check("a blocking finding pauses the commit until the author answers, then commits without a second crew", async () => {
  const issue = "The proportional claim is not qualified.";
  const h = harness("findings", () => ({ status: "changes", findings: [{ severity: "blocking", target: "lesson-boundary / travel time", sourcePages: [1], issue, repair: "State that the speed stays fixed." }] }));
  const first = await h.execute({ action: "notes", lessonComplete: true });
  assert.equal(first.details.tone, "review");
  assert.match(first.content[0].text, /specialist review found repairs/);
  const keys = findingKeys(first.content.map(item => item.text).join("\n"));
  assert.ok(keys.length >= 3, `every finding is named with its repair key: ${keys.join(", ")}`);
  assert.equal(h.section.lessonCommit, undefined, "an open finding leaves the lesson uncommitted");
  assert.equal(lesson.lessonReady(h.section, h.book.source.fingerprint.sha256), false, "an unapproved draft is never delivered");
  const requestsBeforeAnswer = h.requests.length;

  const second = await h.execute({ action: "notes", lessonComplete: true,
    findingResponses: keys.map(key => ({ key, action: "fixed", note: "Qualified the proportional claim." })) });
  assert.ok(!["review", "error", "retry"].includes(second.details.tone), second.content[0].text);
  assert.match(second.content[0].text, /Full lesson committed after specialist review and author responses/);
  assert.equal(h.requests.length, requestsBeforeAnswer, "an answered resubmission checks responses instead of re-running the crew");
  assert.ok(h.section.lessonCommit, "the answered lesson commits");
  assert.ok(keys.every(key => (h.section.learnQuality.responses || []).some(response => response.key === key)), "every author response is stored");
});

await check("three resolved short questions, including a cancelled one, complete the section", async () => {
  const h = harness("questions"), section = h.section;
  const committed = await h.execute({ action: "notes", lessonComplete: true });
  assert.ok(!["review", "error", "retry"].includes(committed.details.tone), committed.content[0].text);
  assert.ok(lesson.lessonReady(section, h.book.source.fingerprint.sha256), "the reviewed lesson is delivered before questions");
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
  assert.equal(h.requests.length, 0, "an invalid question never reaches a reviewer");
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

assert.equal(dirname(resolve(root)), resolve(tmpdir()));
assert.ok(basename(root).startsWith("scholar-simple-learn-"));
rmSync(root, { recursive: true, force: true });
console.log(`Scholar simple-learn summary: ${passed} passed, ${failed} failed.`);
process.exitCode = failed ? 1 : 0;
