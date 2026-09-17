// Audit-as-you-go: a completed save schedules one audit per saved unit revision beside the
// author's turn instead of blocking it, findings ride the next Scholar result once per
// revision, an unchanged revision is never re-audited, a stale receipt can neither approve
// nor surface against its replacement, and finalization waits for outstanding current
// revisions — reporting a failed audit clearly and leaving delivery unapproved.
// Exam forms follow the same per-unit contract: one audit per submitted form fingerprint,
// awaited at freeze, with the gate and the fingerprint revalidated inside the activation.
// Synthetic in-memory records plus one real single-page PDF fixture; no vault or network access.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { extensionPath, piPackageRoot, jitiPath, sdkAliases } from "./sdk.mjs";

const piRequire = createRequire(join(piPackageRoot, "package.json"));
const { createJiti } = await import(pathToFileURL(jitiPath).href);
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: { ...sdkAliases,
  "@earendil-works/pi-coding-agent": join(piPackageRoot, "dist", "index.js"),
  "@earendil-works/pi-tui": piRequire.resolve("@earendil-works/pi-tui"),
  typebox: piRequire.resolve("typebox"),
} });
const loadModule = name => jiti.import(join(dirname(extensionPath), name));
const lesson = await loadModule("lesson.ts");
const { computeFindingKey } = await loadModule("learn-quality.ts");
const { examFormFingerprint } = await loadModule("exam.ts");
const { createScholarToolController } = await loadModule("tool-controller.ts");
const { ScholarRuntimeSession } = await loadModule("runtime-session.ts");

const root = mkdtempSync(join(tmpdir(), "scholar-audit-as-you-go-"));
const now = "2026-09-17T00:00:00.000Z";
const objective = "Explain how length and speed determine travel time";
const keyPoint = "At fixed speed, doubling the path length doubles travel time.";
const pass = { status: "pass", findings: [] };
const issue = "The proportional claim is not qualified.";
const blocking = { status: "changes", findings: [{ severity: "blocking", target: "lesson-boundary / travel time", sourcePages: [1], issue, repair: "State that the speed stays fixed." }] };
/** Three valid questions: one open item plus two multiple-choice items pass the form engine. */
const examQuestions = (marker = "") => [
  { id: "q1", sectionIds: ["s1"], claim: `Identifies the travel-time relation${marker}`, requiredEvidence: ["Names the relation"], dimensions: ["conceptual"],
    format: "multiple-choice", prompt: `Which relation gives travel time${marker}?`,
    options: [{ value: "a", label: "t = d / v" }, { value: "b", label: "t = d × v", misconception: "Multiplies instead of dividing" },
      { value: "c", label: "t = v / d", misconception: "Inverts the ratio" }],
    correctAnswer: "a", explanation: "Travel time is path length divided by speed.", maxPoints: 2 },
  { id: "q2", sectionIds: ["s1"], claim: "Derives the relation from constant speed", requiredEvidence: ["States the fixed speed"], dimensions: ["reasoning"],
    format: "open", prompt: `Derive $t = d/v$ from the definition of constant speed${marker}.`,
    rubric: [{ id: "r1", criterion: "States constant speed", requiredEvidence: ["Fixed speed"], points: 1 },
      { id: "r2", criterion: "Rearranges the definition", requiredEvidence: ["Correct relation"], points: 2 }],
    explanation: "Speed is distance over time; rearrange for time.", maxPoints: 3 },
  { id: "q3", sectionIds: ["s1"], claim: "Checks the units of travel time", requiredEvidence: ["Names the units"], dimensions: ["conceptual"],
    format: "multiple-choice", prompt: `Which unit does travel time take${marker}?`,
    options: [{ value: "a", label: "Seconds" }, { value: "b", label: "Meters", misconception: "Reports distance" },
      { value: "c", label: "Meters per second", misconception: "Reports speed" }],
    correctAnswer: "a", explanation: "Time is measured in seconds.", maxPoints: 2 },
];

function pdfFixture() {
  const page = label => `BT /F1 11 Tf 60 750 Td 18 TL (1.1 Travel time) Tj T* (Travel time follows from the path length and the speed.) Tj T* (Page ${label}: at a fixed speed, doubling the distance doubles the time.) Tj ET`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(page("one"))} >>\nstream\n${page("one")}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>",
    `<< /Length ${Buffer.byteLength(page("two"))} >>\nstream\n${page("two")}\nendstream`];
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
    id: "s1", number: "1.1", title: "Travel time", order: 1, startPage: 1, endPage: 2,
    objectives: [objective], coveredObjectives: [], requiredChecks: ["conceptual"], objectiveChecks: [{ objective, checks: ["conceptual"] }],
    keyPoints: [keyPoint], misconceptions: [], status: "learning",
    synthesis: "Travel time follows from path length and speed; doubling the length doubles the time only while speed stays fixed.",
    transcript: [], attempts: [],
    figureCoverage: { pages: [1, 2].map(page => ({ page, read: true, viewed: { width: 600, height: 800 }, candidates: [],
      review: { page, observation: "The full source page contains text and no figures.", figures: [] } })) },
    learnQuality: { version: 1, coverage: [{ id: "time-concept", kind: "concept", description: "Explain the physical meaning of travel time",
      sourcePages: [1], objective, lessonId: "fixture-explanation", evidence: "A model connects an input to an observable result." }], reviews: [] },
    createdAt: now, updatedAt: now,
  };
  const tutor = { id: "tutor-1", title: "Travel-time tutoring", scope: { sectionIds: ["s1"] }, status: "active", keyPoints: [], attempts: [], transcript: [], createdAt: now, updatedAt: now };
  const exam = { id: "exam-1", title: "Travel-time exam", scope: { chapterIds: ["c1"], sectionIds: ["s1"], description: "Chapter 1" },
    status: "draft", questions: [], rawResponses: [], itemResults: [], breakdown: [], earnedPoints: 0, maxPoints: 0,
    percent: 0, transcript: [], createdAt: now, updatedAt: now };
  const book = {
    schemaVersion: 3, revision: 0, id: sha256, instanceId: `audit-as-you-go-${caseId}`,
    source: { absolutePath: sourcePath, relativePath: "travel-time.pdf", fileName: "travel-time.pdf", format: "pdf",
      fingerprint: { sha256, size: sourceBytes.length, mtimeMs: statSync(sourcePath).mtimeMs } },
    metadata: { title: "Audit-as-you-go fixture", authors: [], pageCount: 2 }, outlineStatus: "ready",
    chapters: [{ id: "c1", number: "1", order: 1, title: "Motion", startPage: 1, endPage: 2, status: "learning", sections: [section] }],
    currentSectionId: "s1", exams: [exam], currentExamId: exam.id, tutorSessions: [tutor], noteDirectory: "Audit-as-you-go fixture", createdAt: now, updatedAt: now,
  };
  return book;
}

/** The reviewer is fully controlled: hold, release with a verdict, fail, or answer automatically. */
function harness(caseId, mode = "learn") {
  const book = fixture(caseId);
  const section = book.chapters[0].sections[0];
  // Exam freezes present their answer paper into the vault; Learn and Tutor never write there.
  mkdirSync(join(root, `${caseId}-vault`), { recursive: true });
  const session = new ScholarRuntimeSession();
  if (mode === "tutor") session.activate(book.id, "tutor", "tutor-1");
  else if (mode === "exam") session.activate(book.id, "exam", book.exams[0].id);
  else session.activate(book.id, "learn", "s1");
  let definition, nextCall = 0, bookLoads = 0;
  const controller = createScholarToolController({
    pi: { registerTool(tool) { definition = tool; } },
    session,
    getConfig: () => ({ libraryRoot: join(root, `${caseId}-library`), obsidianRoot: join(root, `${caseId}-vault`) }),
    loadBook: async () => { bookLoads++; return book; },
    mutateBook: async (_id, mutate) => ({ book, result: await mutate(book) }),
    isActiveAuthority: () => true,
    isSetupActive: () => false,
  });
  controller.ensureRegistered();
  const requests = [], held = [];
  const gate = { mode: "auto", decide: () => pass, heldRoles: undefined };
  const model = { id: "audit-fixture", provider: "fixture", api: "fixture", input: ["text"], contextWindow: 100_000, maxTokens: 8000 };
  const reply = verdict => ({ role: "assistant", api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
    content: [{ type: "text", text: JSON.stringify(verdict) }],
    usage: { input: 200, output: 40, cacheRead: 0, cacheWrite: 0, totalTokens: 240, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const context = { hasUI: false, ui: { notify: () => {} }, model, modelRegistry: { complete: async (_selected, reviewContext) => {
    const role = /Assigned role: (\w+)\./.exec(reviewContext.systemPrompt)?.[1] || "unknown";
    requests.push({ role, prompt: reviewContext.messages[0].content, evidence: reviewContext.messages.at(-1)?.content });
    if (gate.mode === "fail") throw new Error("Simulated reviewer outage");
    if (gate.mode === "hold" || gate.heldRoles?.has(role)) return new Promise(resolve => held.push({ role, resolve }));
    return reply(gate.decide(role, requests.length));
  } } };
  return {
    book, section, tutor: book.tutorSessions[0], exam: book.exams[0], requests, held, session, controller,
    bookLoads: () => bookLoads,
    reviews: () => (mode === "tutor" ? book.tutorSessions[0].review?.receipts : mode === "exam" ? book.exams[0].review?.receipts : section.learnQuality.reviews) || [],
    hold: () => { gate.mode = "hold"; gate.heldRoles = undefined; },
    /** Hold only one role, so the other roles finish and checkpoint while it is still running. */
    holdRole: role => { gate.mode = "auto"; gate.heldRoles = new Set([role]); },
    auto: decide => { gate.mode = "auto"; gate.heldRoles = undefined; gate.decide = decide || (() => pass); },
    failNext: () => { gate.mode = "fail"; gate.heldRoles = undefined; },
    release: verdict => { gate.mode = "auto"; gate.heldRoles = undefined; for (const item of held.splice(0)) item.resolve(reply(typeof verdict === "function" ? verdict(item.role) : verdict)); },
    settle: () => new Promise(resolve => setTimeout(resolve, 25)),
    wait: async (predicate, timeout = 10_000) => {
      const started = Date.now();
      while (!predicate()) {
        if (Date.now() - started > timeout) throw new Error("Timed out waiting for the audit state");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    },
    execute: params => definition.execute(`audit-${caseId}-${++nextCall}`, params, undefined, undefined, context),
  };
}

const lessonInput = id => ({ id, title: "Travel time from a constant speed", markdown: lessonMarkdown,
  objectives: [objective], keyPoints: [keyPoint], sourcePages: [1] });
const objectiveGap = { action: "notes", synthesis: "An unreviewed recap that must not persist.",
  lesson: { ...lessonInput("second-explanation"), markdown: lessonMarkdown.replace("A model connects", "A different model connects") },
  coverageUpdates: [{ id: "unknown-item", evidence: "A model connects an input to an observable result." }] };
const textOf = result => result.content.map(item => item.type === "text" ? item.text : "").join("\n");
const keysIn = text => [...new Set([...text.matchAll(/\[F-([0-9a-f]{12})\]/g)].map(match => match[1]))];

let passed = 0, failed = 0;
async function check(name, test) {
  try { await test(); passed++; console.log(`[PASS] ${name}`); }
  catch (error) { failed++; console.error(`[FAIL] ${name}: ${error.stack || error.message}`); }
}

await check("a completed save returns while its unit audit is still running", async () => {
  const h = harness("pending");
  h.hold();
  const saved = await h.execute({ action: "notes", lesson: lessonInput("fixture-explanation") });
  assert.ok(!["review", "error", "retry"].includes(saved.details.tone), textOf(saved));
  assert.equal(h.section.transcript.length, 1, "the save is durable before its audit finishes");
  await h.wait(() => h.held.length === 2);
  assert.equal(h.requests.length, 2, `one prepared request per required role (${h.requests.length})`);
  assert.equal(h.reviews().length, 0, "no verdict has been written yet");
  assert.equal(h.section.lessonCommit, undefined);
  assert(lesson.learnReviewIssues(h.section, h.book.source.fingerprint.sha256).length, "an unaudited revision is not approved");
  const revision = h.section.transcript[0].lesson.contentHash;
  h.release(pass);
  await h.wait(() => h.reviews().length === 2);
  assert.deepEqual(h.reviews().map(receipt => receipt.role), ["source", "teaching"]);
  assert.ok(h.reviews().every(receipt => receipt.contentHash === revision && receipt.sourceHash === h.book.source.fingerprint.sha256 && receipt.status === "pass"));
  const quiet = h.requests.length;
  await h.execute({ action: "notes", synthesis: "A reviewed recap addition." });
  await h.settle();
  assert.equal(h.requests.length, quiet, "an unchanged revision is not re-audited");
});

await check("findings reach the author's next Scholar result once per revision", async () => {
  const h = harness("findings");
  h.auto(() => blocking);
  await h.execute({ action: "notes", lesson: lessonInput("fixture-explanation") });
  await h.wait(() => h.reviews().length === 2);
  const revision = h.section.transcript[0].lesson.contentHash;
  const expected = ["source", "teaching"].map(role => computeFindingKey(role, blocking.findings[0]));
  const next = await h.execute({ action: "read", startPage: 1, endPage: 1 });
  const nextText = textOf(next);
  for (const key of expected) assert(nextText.includes(`[F-${key}]`), `the next tool result carries finding ${key}`);
  assert.match(nextText, new RegExp(issue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(nextText, /Repair: State that the speed stays fixed\./);
  assert.deepEqual(keysIn(nextText), expected, "each blocking finding is named once");
  const repeat = await h.execute({ action: "status" });
  assert.deepEqual(keysIn(textOf(repeat)), [], "the same finding is not delivered twice for one revision");
  assert.ok(h.reviews().every(receipt => receipt.contentHash === revision));
});

await check("an unchanged rejected revision keeps its verdict across saves and finalization attempts", async () => {
  const h = harness("rejected");
  h.auto(() => blocking);
  await h.execute({ action: "notes", lesson: lessonInput("fixture-explanation") });
  await h.wait(() => h.reviews().length === 2);
  const requests = h.requests.length;
  const second = await h.execute({ action: "notes", lessonComplete: true });
  assert.equal(second.details.tone, "review", textOf(second));
  assert.match(textOf(second), /specialist review found repairs/);
  assert.equal(h.requests.length, requests, "finalization waits for the verdict instead of re-auditing");
  assert.equal(h.section.lessonCommit, undefined, "unresolved blocking findings leave delivery unapproved");
  assert.equal(lesson.lessonReady(h.section, h.book.source.fingerprint.sha256), false);
  await h.execute({ action: "notes", synthesis: "An unrelated recap edit." });
  await h.settle();
  assert.equal(h.requests.length, requests, "later saves never re-audit the unchanged rejected revision");
});

await check("a stale receipt can neither approve nor surface against its replacement revision", async () => {
  const h = harness("stale");
  h.auto(() => blocking);
  await h.execute({ action: "notes", lesson: lessonInput("fixture-explanation") });
  await h.wait(() => h.reviews().length === 2);
  const oldRevision = h.section.transcript[0].lesson.contentHash;
  const oldKey = computeFindingKey("source", blocking.findings[0]);
  h.hold();
  const patched = await h.execute({ action: "notes", lessonPatch: { id: "fixture-explanation", expectedContentHash: lesson.lessonHash(h.section.transcript[0].markdown),
    edits: [{ oldText: "A model connects an input to an observable result.", newText: "A model connects a measured input to an observable result." }] } });
  assert.ok(!["review", "error", "retry"].includes(patched.details.tone), textOf(patched));
  const newRevision = h.section.transcript[0].lesson.contentHash;
  assert.notEqual(newRevision, oldRevision, "the patch produced a new revision");
  await h.wait(() => h.held.length === 2);
  const issues = lesson.learnReviewIssues(h.section, h.book.source.fingerprint.sha256);
  assert.deepEqual(issues, ["lesson:lesson-fixture-explanation: Complete the source review.", "lesson:lesson-fixture-explanation: Complete the teaching review."],
    "the older revision's receipt neither approves nor blocks the replacement");
  const next = await h.execute({ action: "status" });
  assert.equal(keysIn(textOf(next)).includes(oldKey), false, "an older revision's finding is never shown as current");
  assert.equal(lesson.lessonReady(h.section, h.book.source.fingerprint.sha256), false, "no approval without an audit of the current revision");
  h.release(pass);
  await h.wait(() => h.reviews().length === 4);
  assert.ok(h.reviews().every(receipt => receipt.contentHash === newRevision || receipt.contentHash === oldRevision));
});

await check("a page-list-only revision change re-audits and the replaced receipts never approve it", async () => {
  const h = harness("evidence");
  h.auto(() => pass);
  await h.execute({ action: "notes", lesson: { ...lessonInput("fixture-explanation"), sourcePages: [1] } });
  await h.wait(() => h.reviews().length === 2);
  const sourceHash = h.book.source.fingerprint.sha256;
  const unit = () => lesson.lessonReviewUnits(h.section, sourceHash)[0];
  const markdownHash = h.section.transcript[0].lesson.contentHash;
  assert.equal(markdownHash, lesson.lessonHash(h.section.transcript[0].markdown), "the stored lesson receipt keeps matching the markdown");
  assert.deepEqual(lesson.learnReviewIssues(h.section, sourceHash), [], "page 1 is audited and approved");
  const audited = unit();
  const calls = h.requests.length;

  h.hold();
  const resaved = await h.execute({ action: "notes", lesson: { ...lessonInput("fixture-explanation"), sourcePages: [1, 2],
    expectedContentHash: markdownHash } });
  await h.wait(() => h.held.length === 2);
  assert.ok(!["review", "error", "retry"].includes(resaved.details.tone), textOf(resaved));
  assert.equal(h.section.transcript[0].lesson.contentHash, markdownHash, "the lesson revision is unchanged");
  assert.notEqual(unit().revision, audited.revision, "citing another page is a new evidence revision");
  assert.equal(h.requests.length, calls + 2, "the new evidence is audited even though the lesson text is unchanged");
  assert.deepEqual(h.reviews(), [], "receipts that audited the replaced page list are retired, never approval");
  assert.deepEqual(lesson.learnReviewIssues(h.section, sourceHash),
    ["lesson:lesson-fixture-explanation: Complete the source review.", "lesson:lesson-fixture-explanation: Complete the teaching review."],
    "the unit is not approved until its new evidence has its own audit");
  assert.equal(lesson.lessonReady(h.section, sourceHash), false, "a stale-evidence verdict cannot deliver the lesson");
  h.release(pass);
  await h.wait(() => h.reviews().length === 2);
  assert.ok(h.reviews().every(receipt => receipt.contentHash === markdownHash), "the replacement receipts bind to the lesson revision");
  assert.deepEqual(lesson.learnReviewIssues(h.section, sourceHash), []);

  const quiet = h.requests.length;
  await h.execute({ action: "notes", lesson: { ...lessonInput("fixture-explanation"), sourcePages: [1, 2], expectedContentHash: markdownHash } });
  await h.settle();
  assert.equal(h.requests.length, quiet, "an unchanged unit reuses its receipts");
  assert.equal(h.reviews().length, 2);
});

await check("a superseded audit's late verdict never lands as current evidence", async () => {
  const h = harness("late-verdict");
  h.hold();
  await h.execute({ action: "notes", lesson: { ...lessonInput("fixture-explanation"), sourcePages: [1] } });
  await h.wait(() => h.held.length === 2);
  const markdownHash = h.section.transcript[0].lesson.contentHash;
  // A concurrent writer resaves the same text with a different cited page list; this session
  // never schedules (so never aborts), and its in-flight audit still finishes normally.
  h.section.transcript[0].lesson.sourcePages = [1, 2];
  h.release(pass);
  await h.settle();
  assert.deepEqual(h.reviews(), [], "a verdict for the replaced evidence is never stored");
  assert.equal(h.section.transcript[0].lesson.contentHash, markdownHash);
  h.auto(() => pass);
  const resaved = await h.execute({ action: "notes", lesson: { ...lessonInput("fixture-explanation"), sourcePages: [1, 2],
    expectedContentHash: markdownHash } });
  assert.ok(!["review", "error", "retry"].includes(resaved.details.tone), textOf(resaved));
  await h.wait(() => h.reviews().length === 2);
  assert.ok(h.reviews().every(receipt => receipt.contentHash === markdownHash && receipt.status === "pass"));
  assert.deepEqual(lesson.learnReviewIssues(h.section, h.book.source.fingerprint.sha256), [], "the current evidence is approved by its own audit");
});

await check("finalization awaits the outstanding audit of the current revision and commits on its pass", async () => {
  const h = harness("await");
  h.hold();
  await h.execute({ action: "notes", lesson: lessonInput("fixture-explanation") });
  await h.wait(() => h.held.length === 2);
  const finishing = h.execute({ action: "notes", lessonComplete: true });
  let settled = false; finishing.then(() => { settled = true; });
  await h.settle();
  assert.equal(settled, false, "finalization waits for the audit of the current revision");
  assert.equal(h.section.lessonCommit, undefined);
  h.release(pass);
  const committed = await finishing;
  assert.ok(!["review", "error", "retry"].includes(committed.details.tone), textOf(committed));
  assert.match(textOf(committed), /Full lesson committed after source, teaching and visual review/);
  assert.ok(h.section.lessonCommit, "the passing current-revision audit approves delivery");
  assert.ok(lesson.lessonReady(h.section, h.book.source.fingerprint.sha256));
});

await check("a tool result with nothing to deliver performs no delivery book load", async () => {
  const h = harness("delivery-load");
  h.auto(() => pass);
  await h.execute({ action: "notes", lesson: lessonInput("fixture-explanation") });
  await h.wait(() => h.reviews().length === 2);
  const quiet = h.bookLoads();
  const read = await h.execute({ action: "read", startPage: 1, endPage: 1 });
  assert.ok(!["review", "error", "retry"].includes(read.details.tone), textOf(read));
  assert.equal(h.bookLoads() - quiet, 1, "a passing audit with nothing pending never re-reads the book for delivery");

  h.auto(() => blocking);
  await h.execute({ action: "notes", lesson: { ...lessonInput("second-explanation"),
    markdown: lessonMarkdown.replace("A model connects", "A different model connects") } });
  await h.wait(() => h.reviews().length === 4);
  const before = h.bookLoads();
  const next = await h.execute({ action: "read", startPage: 1, endPage: 1 });
  assert.equal(keysIn(textOf(next)).length, 2, textOf(next));
  assert.equal(h.bookLoads() - before, 2, "a pending finding rides the next result and pays exactly one delivery load");
});

await check("a failed audit leaves delivery unapproved with a clear message", async () => {
  const h = harness("failed");
  h.failNext();
  await h.execute({ action: "notes", lesson: lessonInput("fixture-explanation") });
  await h.wait(() => h.reviews().length === 2 && h.reviews().every(receipt => receipt.failure));
  const failed = await h.execute({ action: "notes", lessonComplete: true });
  assert.equal(failed.details.tone, "review", textOf(failed));
  assert.match(textOf(failed), /review incomplete \(lesson:lesson-fixture-explanation: provider\)/);
  assert.match(textOf(failed), /Generation stopped/);
  assert.match(textOf(failed), /lesson:lesson-fixture-explanation \/ execution incomplete/);
  assert.equal(h.section.lessonCommit, undefined, "a failed audit never approves delivery");
  assert.equal(lesson.lessonReady(h.section, h.book.source.fingerprint.sha256), false);
  const blocked = await h.execute({ action: "read", startPage: 1, endPage: 1 });
  assert.ok(["retry", "error"].includes(blocked.details.tone), textOf(blocked));
  assert.match(textOf(blocked), /review incomplete/, "a stopped preparation keeps blocking later actions");
  assert.equal(h.section.transcript.length, 1, "the blocked action changed nothing");
});

await check("a discarded audit returns an actionable repair path and approves nothing", async () => {
  const h = harness("discarded");
  h.hold();
  await h.execute({ action: "notes", lesson: lessonInput("fixture-explanation") });
  await h.wait(() => h.held.length === 2);
  const finishing = h.execute({ action: "notes", lessonComplete: true });
  await h.settle();
  // The active preparation changes while finalization waits: its pending audits are discarded.
  h.controller.resetTransientState();
  h.release(pass); // a provider that ignores the abort still gets no verdict stored
  const result = await finishing;
  const text = textOf(result);
  assert.equal(result.details.tone, "review", text);
  assert.match(text, /discarded because the active preparation changed \(lesson:lesson-fixture-explanation\)/);
  assert.match(text, /Save the current revision again, then resubmit lessonComplete/);
  assert.doesNotMatch(text, /review incomplete|specialist review found repairs|Full lesson committed/,
    "a discarded audit is never reported as a review result");
  assert.equal(h.section.learnQuality.reviews.length, 0, "the discarded preparation stored no verdict");
  assert.equal(h.section.lessonCommit, undefined);
  assert.equal(lesson.lessonReady(h.section, h.book.source.fingerprint.sha256), false, "a discarded audit never approves delivery");
});

await check("a rejected save schedules no audit for data it did not persist", async () => {
  const h = harness("partial");
  const before = JSON.stringify({ transcript: h.section.transcript, coverage: h.section.learnQuality.coverage, reviews: h.section.learnQuality.reviews });
  const failed = await h.execute(objectiveGap);
  assert.equal(failed.details.tone, "retry", textOf(failed));
  assert.equal(h.requests.length, 0, "an atomic save failure never starts a review");
  assert.equal(JSON.stringify({ transcript: h.section.transcript, coverage: h.section.learnQuality.coverage, reviews: h.section.learnQuality.reviews }), before,
    "no partially written lesson, coverage or receipt survives the rejected call");
  h.auto(() => pass);
  const saved = await h.execute({ action: "notes", lesson: lessonInput("fixture-explanation") });
  assert.ok(!["review", "error", "retry"].includes(saved.details.tone), textOf(saved));
  await h.wait(() => h.reviews().length === 2);
  const audit = JSON.parse(h.requests[0].prompt.slice(h.requests[0].prompt.indexOf('\n{"source":') + 1));
  assert.equal(audit.lesson.markdown, h.section.transcript[0].markdown, "the audit is built from the saved revision, never the request payload");
  assert.deepEqual(h.reviews().map(receipt => receipt.contentHash), [h.section.transcript[0].lesson.contentHash, h.section.transcript[0].lesson.contentHash]);
});

await check("Tutor explanations are audited as teaching units without blocking their save", async () => {
  const h = harness("tutor", "tutor");
  h.hold();
  const saved = await h.execute({ action: "notes", lesson: { id: "tutor-explanation", title: "Travel-time tutoring", markdown: lessonMarkdown,
    objectives: [], keyPoints: [keyPoint], sourcePages: [1] } });
  assert.ok(!["review", "error", "retry"].includes(saved.details.tone), textOf(saved));
  await h.wait(() => h.held.length === 1);
  assert.equal(h.requests.length, 1, "one teaching check per saved explanation");
  assert.equal(h.requests[0].role, "teaching");
  const revision = lesson.lessonHash(h.tutor.transcript[0].markdown);
  h.release(blocking);
  await h.wait(() => h.reviews().length === 1);
  assert.deepEqual(h.reviews().map(receipt => [receipt.role, receipt.contentHash]), [["teaching", revision]], "Tutor receipts use the teaching role and markdown hash");
  assert.equal(revision, h.tutor.transcript[0].lesson.contentHash);
  const next = await h.execute({ action: "status" });
  assert.deepEqual(keysIn(textOf(next)), [computeFindingKey("teaching", blocking.findings[0])], "the finding reaches the next Tutor result");
  const requests = h.requests.length;
  await h.execute({ action: "notes", lesson: { id: "tutor-explanation", title: "Travel-time tutoring", markdown: lessonMarkdown,
    objectives: [], keyPoints: [keyPoint], sourcePages: [1] } });
  await h.settle();
  assert.equal(h.requests.length, requests, "an unchanged Tutor explanation is not re-audited");
});

await check("an exam form revision is audited once, and its findings reach the author in the same result", async () => {
  const h = harness("exam-findings", "exam");
  h.auto(() => blocking);
  const questions = examQuestions();
  const first = await h.execute({ action: "exam_build", questions });
  assert.equal(first.details.tone, "review", textOf(first));
  assert.match(textOf(first), /specialist review found repairs/);
  assert.equal(h.exam.status, "draft", "blocking findings keep the exam editable");
  assert.equal(h.exam.questions.length, 0, "the form is not frozen while findings are open");
  assert.equal(h.requests.length, questions.length + 1, "one prepared check per question plus one form check");
  const fingerprint = examFormFingerprint({ ...h.exam, questions });
  assert.deepEqual(h.reviews().map(receipt => [receipt.role, receipt.status, receipt.contentHash]),
    [["assessment", "changes", fingerprint], ["teaching", "changes", fingerprint]],
    "the submitted revision keeps one receipt per role, bound to its form fingerprint");
  const keys = keysIn(textOf(first));
  assert.deepEqual(keys, ["assessment", "teaching"].map(role => computeFindingKey(role, blocking.findings[0])),
    "both role findings are named once in the result that produced them");
  assert.ok(textOf(first).includes(`assessment / blocking / [F-${keys[0]}] / ${blocking.findings[0].target} / PDF 1: ${issue}\nRepair: State that the speed stays fixed.`),
    `the finding is formatted role / severity / [F-<key>] / target / PDF pages: issue (${textOf(first)})`);

  const calls = h.requests.length;
  const answered = await h.execute({ action: "exam_build", questions,
    findingResponses: keys.map(key => ({ key, action: "fixed", note: "Qualified the claim and kept the speed fixed." })) });
  assert.ok(!["review", "error", "retry"].includes(answered.details.tone), textOf(answered));
  assert.equal(h.requests.length, calls, "an answered resubmission runs no new audit calls");
  assert.equal(h.exam.status, "active", "the answered revision freezes");
  assert.deepEqual(h.exam.questions.map(question => question.prompt), questions.map(question => question.prompt));
  assert.equal(h.reviews().length, 2, "the frozen form keeps exactly one receipt per role");
  assert.ok(keys.every(key => h.exam.review.responses.some(response => response.key === key && response.action === "fixed")),
    "every answered finding is stored with the frozen form");
});

await check("a changed form revision gets exactly one new audit the replaced receipts cannot freeze", async () => {
  const h = harness("exam-changed", "exam");
  h.auto(() => blocking);
  const original = examQuestions();
  const first = await h.execute({ action: "exam_build", questions: original });
  assert.equal(first.details.tone, "review", textOf(first));
  const answers = keysIn(textOf(first)).map(key => ({ key, action: "fixed", note: "Addressed the finding." }));
  const replacedFingerprint = examFormFingerprint({ ...h.exam, questions: original });
  assert.ok(h.reviews().length === 2 && h.reviews().every(receipt => receipt.contentHash === replacedFingerprint));

  const calls = h.requests.length;
  h.hold();
  const revised = examQuestions(" (revised)");
  const pending = h.execute({ action: "exam_build", questions: revised, findingResponses: answers });
  await h.wait(() => h.held.length === revised.length + 1);
  await h.settle();
  assert.equal(h.exam.status, "draft", "the replaced revision's answered receipts cannot freeze its replacement");
  assert.equal(h.exam.questions.length, 0);
  h.release(pass);
  const frozen = await pending;
  assert.ok(!["review", "error", "retry"].includes(frozen.details.tone), textOf(frozen));
  assert.equal(h.exam.status, "active");
  assert.deepEqual(h.exam.questions.map(question => question.prompt), revised.map(question => question.prompt), "the revised form is the frozen one");
  assert.equal(h.requests.length, calls + revised.length + 1, "the changed revision is audited exactly once");
  const frozenFingerprint = examFormFingerprint(h.exam);
  assert.notEqual(frozenFingerprint, replacedFingerprint, "a different form is a different revision");
  assert.ok(h.reviews().some(receipt => receipt.contentHash === replacedFingerprint), "the replaced revision's receipts are kept, not rewritten");
  assert.ok(["assessment", "teaching"].every(role => h.reviews().filter(receipt => receipt.role === role && receipt.contentHash === frozenFingerprint).length === 1),
    "exactly one completed receipt per role for the frozen revision");
  assert.deepEqual(keysIn(textOf(frozen)), [], "the replaced revision's findings are never reported as current");
});

await check("a pending exam audit is awaited at freeze", async () => {
  const h = harness("exam-await", "exam");
  h.hold();
  const questions = examQuestions();
  const building = h.execute({ action: "exam_build", questions });
  let settled = false; building.then(() => { settled = true; }, () => { settled = true; });
  await h.wait(() => h.held.length === questions.length + 1);
  await h.settle();
  assert.equal(settled, false, "finalization waits for the audit of the current revision");
  assert.equal(h.exam.status, "draft");
  assert.equal(h.exam.questions.length, 0);
  h.release(pass);
  const built = await building;
  assert.ok(!["review", "error", "retry"].includes(built.details.tone), textOf(built));
  assert.equal(h.exam.status, "active", "the passing current-revision audit activates the exam");
  const fingerprint = examFormFingerprint(h.exam);
  assert.deepEqual(h.reviews().map(receipt => [receipt.role, receipt.contentHash]),
    [["assessment", fingerprint], ["teaching", fingerprint]], "one passing receipt per role, bound to the frozen form");
});

await check("a failed exam audit leaves the exam unfrozen with a clear message", async () => {
  const h = harness("exam-failed", "exam");
  h.failNext();
  const questions = examQuestions();
  const failed = await h.execute({ action: "exam_build", questions });
  assert.equal(failed.details.tone, "review", textOf(failed));
  assert.match(textOf(failed), /review incomplete \(form:exam-1: provider\)/);
  assert.match(textOf(failed), /form:exam-1 \/ execution incomplete/);
  assert.equal(h.exam.status, "draft", "a failed audit never freezes the exam");
  assert.equal(h.exam.questions.length, 0);
  assert.ok(h.reviews().length && h.reviews().every(receipt => receipt.failure), "the failure is recorded for this revision");
  h.auto(() => pass);
  const retried = await h.execute({ action: "exam_build", questions });
  assert.ok(!["review", "error", "retry"].includes(retried.details.tone), textOf(retried));
  assert.equal(h.exam.status, "active", "the failed revision is audited again and its retry can freeze");
});

await check("a form changed during its audit is never frozen", async () => {
  const h = harness("exam-drift", "exam");
  h.hold();
  const questions = examQuestions();
  const building = h.execute({ action: "exam_build", questions });
  await h.wait(() => h.held.length === questions.length + 1);
  // A concurrent writer rescopes the exam while the audit of the submitted revision runs.
  h.exam.scope = { ...h.exam.scope, description: "Chapter 1, rescoped while the audit ran" };
  h.release(pass);
  const drifted = await building;
  assert.ok(["retry", "error"].includes(drifted.details.tone), textOf(drifted));
  assert.match(textOf(drifted), /changed while its audit ran/);
  assert.equal(h.exam.status, "draft", "approval of the audited revision does not activate a form that changed under it");
  assert.equal(h.exam.questions.length, 0);
});

await check("an interrupted exam audit resumes from its checkpointed question checks", async () => {
  const h = harness("exam-resume", "exam");
  h.holdRole("teaching");
  const questions = examQuestions();
  const interrupted = h.execute({ action: "exam_build", questions });
  await h.wait(() => h.held.length === 1);
  await h.wait(() => h.reviews().some(receipt => receipt.role === "assessment" && receipt.failure?.code === "cancelled"));
  const checkpoint = h.reviews().find(receipt => receipt.role === "assessment");
  assert.ok(checkpoint.batches?.length >= 1, "the finished question checks are carried while the audit is still running");

  h.controller.resetTransientState();
  h.release(pass);
  const stopped = await interrupted;
  assert.equal(stopped.details.tone, "review", textOf(stopped));
  assert.match(textOf(stopped), /review incomplete/);
  assert.equal(h.exam.status, "draft", "an interrupted audit never freezes the exam");
  assert.equal(h.exam.questions.length, 0);

  const calls = h.requests.length;
  h.auto(() => pass);
  const resumed = await h.execute({ action: "exam_build", questions });
  assert.ok(!["review", "error", "retry"].includes(resumed.details.tone), textOf(resumed));
  assert.equal(h.exam.status, "active");
  assert.ok(h.requests.length - calls >= 1 && h.requests.length - calls < questions.length + 1,
    `finished question checks are reused instead of re-run (${h.requests.length - calls} new checks)`);
  assert.deepEqual(h.reviews().map(receipt => [receipt.role, receipt.status]), [["assessment", "pass"], ["teaching", "pass"]]);
});

assert.equal(dirname(resolve(root)), resolve(tmpdir()));
assert.ok(basename(root).startsWith("scholar-audit-as-you-go-"));
rmSync(root, { recursive: true, force: true });
console.log(`Scholar audit-as-you-go summary: ${passed} passed, ${failed} failed.`);
process.exitCode = failed ? 1 : 0;
