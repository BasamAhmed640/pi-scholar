// The per-unit review service: one saved explanation revision is one audit unit with bounded
// source windows, one explanation check and — only when it embeds saved crops — a visual check.
// Everything runs on the installed Pi SDK with injected evidence; no network or study-vault access.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { extensionPath, piPackageRoot, jitiPath, resolvePiDependency, piRequire } from "./sdk.mjs";

const { createJiti } = await import(pathToFileURL(jitiPath).href);
const piAiEntry = piRequire.resolve.paths("@earendil-works/pi-ai").map(directory => join(directory, "@earendil-works/pi-ai/dist/index.js")).find(existsSync);
assert.ok(piAiEntry, "The installed Pi SDK must include pi-ai");
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: {
  "@earendil-works/pi-coding-agent": join(piPackageRoot, "dist/index.js"),
  "@earendil-works/pi-ai": piAiEntry,
  "@earendil-works/pi-tui": resolvePiDependency("@earendil-works/pi-tui"),
  "typebox/value": resolvePiDependency("typebox/value"), typebox: resolvePiDependency("typebox"),
} });
const load = name => jiti.import(join(dirname(extensionPath), name));
const { planLessonUnitPackets, reviewCheckpoint, reviewLearnQuestion } = await load("learn-review.ts");
const { runReviewPass, reviewOne, currentReviewSnapshots, REVIEW_CHECKPOINT_MESSAGE } = await load("review-layer.ts");
const { lessonHash, learnReviewHash, learnReviewIssues, lessonReviewUnits, lessonUnitRevision } = await load("lesson.ts");
const { isReviewReceipt, pruneReviewReceipts, reviewGateIssues, reviewUnitIssues, unitBlockingFindings, unitReviewFailures, computeFindingKey } = await load("learn-quality.ts");
const { ModelRegistry } = await import(pathToFileURL(join(piPackageRoot, "dist/core/model-registry.js")).href);

const now = "2026-09-13T00:00:00.000Z";
const model = { id: "isolated-review", provider: "custom-provider", api: "custom-api", input: ["text", "image"], contextWindow: 300_000, maxTokens: 32_000 };
const pass = { status: "pass", findings: [] };
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aJcAAAAASUVORK5CYII=";
const usage = { input: 100, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 130,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const message = (content = pass, stopReason = "stop") => ({ role: "assistant", api: model.api, provider: model.provider, model: model.id,
  content: Array.isArray(content) ? content : [{ type: "text", text: typeof content === "string" ? content : JSON.stringify(content) }],
  usage, timestamp: Date.now(), stopReason });
const call = (name, args, id = `${name}-1`) => ({ type: "toolCall", name, arguments: args, id });
const readCall = (startPage = 1, endPage = 2) => call("read_source", { startPage, endPage });
const visualCalls = () => [call("view_source", { page: 1 }, "page-1"), call("view_source", { page: 2 }, "page-2"),
  call("view_crop", { id: "crop-1" }, "crop-1"), call("view_crop", { id: "crop-2" }, "crop-2")];
const listed = (prompt, label) => /Required (?:read_source|view_source) pages|Required view_crop IDs/.test(label)
  ? new RegExp(`${label}: ([^\\n]+)\\.`).exec(prompt)[1].split(", ").filter(item => !item.startsWith("none")) : [];
const cropsIn = prompt => listed(prompt, "Required view_crop IDs");
const roleOf = context => {
  const prompt = context.messages[0].content;
  if (prompt.startsWith("Compare the ENTIRE")) return "source";
  if (prompt.startsWith("Evaluate the lesson as instruction")) return "teaching";
  if (prompt.startsWith("Inspect every saved crop")) return "visual";
  if (prompt.startsWith("Review this frozen proposed question")) return "assessment";
  throw new Error("Unknown review assignment");
};
function fixture(complete = async () => message()) {
  const markdown = "### Why zero free charge does not force zero field\n\nZero divergence constrains the net flux out of a small volume. It does not determine the whole vector field; boundary conditions and curl still matter.";
  const sourceHash = "a".repeat(64);
  const objective = "Explain what Gauss's law does and does not determine";
  const section = { id: "s1", order: 1, title: "Electric displacement", startPage: 1, endPage: 2, objectives: [objective],
    objectiveChecks: [{ objective, checks: ["conceptual"] }], coveredObjectives: [], requiredChecks: ["conceptual"], status: "learning",
    synthesis: "D tracks free charge in its divergence; this alone does not determine D.", keyPoints: ["Zero divergence is not zero field"], misconceptions: [], attempts: [],
    transcript: [{ id: "lesson-displacement", kind: "assistant", markdown, createdAt: now,
      lesson: { title: "Why zero free charge does not force zero field", objectives: [objective], keyPoints: ["Zero divergence is not zero field"], sourcePages: [1, 2], contentHash: lessonHash(markdown), sourceHash } }],
    snapshots: [1, 2].map(page => ({ id: `crop-${page}`, page, caption: `Source figure ${page}`, assetFile: `crop-${page}.png`, sha256: `${page}`.repeat(64),
      crop: { x: 0, y: 0, width: 20, height: 20, canvasWidth: 100, canvasHeight: 100 }, createdAt: now })),
    figureCoverage: { pages: [1, 2].map(page => ({ page, read: true, viewed: { width: 100, height: 100 }, candidates: [`Figure ${page}`],
      review: { page, observation: "The full figure shows the relevant field arrows.", figures: [{ label: `Figure ${page}`, snapshotId: `crop-${page}` }] } })) },
    learnQuality: { version: 1, coverage: [{ id: "nonzero-field", kind: "counterexample", description: "A polarized body with no free charge can have nonzero D", sourcePages: [1], objective,
      lessonId: "displacement", evidence: "Zero divergence constrains the net flux out of a small volume." }], reviews: [] }, createdAt: now, updatedAt: now };
  const book = { id: "b".repeat(64), metadata: { title: "Synthetic electrodynamics fixture" }, source: { fingerprint: { sha256: sourceHash } },
    chapters: [{ id: "c1", startPage: 1, endPage: 2, sections: [section] }] };
  const reads = [], views = [], crops = [];
  const evidence = {
    async read(start, end) { reads.push([start, end]); return Array.from({ length: end - start + 1 }, (_, index) => `[Page ${start + index}]\nA synthetic source explains the boundary conditions and the zero-free-charge counterexample.`).join("\n"); },
    async view(page) { views.push(page); return { data: png, mimeType: "image/png" }; },
    async crop(id) { crops.push(id); return { data: png, mimeType: "image/png" }; },
  };
  return { book, section, config: { obsidianRoot: "fixture-vault-not-on-disk" }, ctx: { model, modelRegistry: new ModelRegistry({ complete }), parentSecret: "not-for-reviewer" },
    evidence, observations: { reads, views, crops } };
}
function withTools(calls, verdict = pass) {
  return async (_selected, context) => context.messages.length === 1 && calls.length ? message(calls, "toolUse") : message(verdict);
}
const unitOf = options => lessonReviewUnits(options.section, options.book.source.fingerprint.sha256)[0];
const auditOptions = options => ({ ...options, sourceHash: options.book.source.fingerprint.sha256, contentHash: unitOf(options).contentHash,
  snapshots: currentReviewSnapshots(options.section, options.book.source.fingerprint.sha256), prepared: true,
  existingReviews: options.section.learnQuality?.reviews || [] });
const scope = overrides => ({ role: "source", id: "scoped", instruction: "Scoped test packet.", reads: [], views: [], cropIds: [], payload: {}, ...overrides });
let checks = 0;
async function check(name, fn) { await fn(); checks++; console.log(`[PASS] ${name}`); }

await check("A saved unit plans bounded source windows, one explanation check and its own crops", async () => {
  const options = fixture();
  const unit = unitOf(options);
  assert.equal(unit.key, "lesson:lesson-displacement");
  assert.equal(unit.contentHash, lessonHash(options.section.transcript[0].markdown), "stored receipts bind to the saved lesson revision");
  assert.equal(unit.revision, lessonUnitRevision(unit.contentHash, [1, 2], []), "the evidence revision covers the unit's cited pages and crops");
  assert.notEqual(unit.revision, unit.contentHash, "the audited evidence is a distinct identity from the markdown hash");
  assert.deepEqual(unit.roles, ["source", "teaching"], "a unit without embedded crops needs no visual check");
  const plan = planLessonUnitPackets(unit, options.section, options.book.source.fingerprint.sha256);
  assert.deepEqual(plan.map(item => item.role), ["source", "teaching"]);
  assert.deepEqual(plan[0].reads, [1, 2], "the source window is exactly the unit's cited pages");
  assert.deepEqual(plan[1].reads, [1, 2], "the explanation check reads the same bounded pages");
  assert.deepEqual(plan.flatMap(item => item.views), [], "no packet renders a full page");
  assert.deepEqual(plan.flatMap(item => item.cropIds), [], "a unit without embedded crops plans no crop");
  assert.deepEqual(Object.keys(plan[1].payload), ["source", "objectives", "outline", "lesson", "checklist", "checks", "recap", "keyPoints"]);
  assert.equal(plan[1].payload.lesson.markdown, options.section.transcript[0].markdown, "the payload carries exactly the saved revision");

  options.section.transcript[0].lesson.embeddedSnapshotIds = ["crop-1", "crop-2"];
  const visual = planLessonUnitPackets(unitOf(options), options.section, options.book.source.fingerprint.sha256);
  assert.deepEqual(unitOf(options).roles, ["source", "teaching", "visual"], "embedded saved crops add the visual role");
  assert.deepEqual(visual.map(item => item.role), ["source", "teaching", "visual"]);
  assert.deepEqual(visual[2].cropIds, ["crop-1", "crop-2"], "the visual check inspects exactly the unit's embedded crops");
  assert.deepEqual(visual[2].views, []);
  assert.equal(visual[2].payload.figures.length, 2);
  assert.deepEqual(visual[2].payload.figureInventory.map(page => page.page), [1, 2]);

  options.section.transcript[0].lesson.sourcePages = [1];
  options.section.transcript[0].lesson.embeddedSnapshotIds = ["crop-1"];
  const small = planLessonUnitPackets(unitOf(options), options.section, options.book.source.fingerprint.sha256, 32_000);
  options.section.endPage = 9;
  options.section.learnQuality.coverage[0].sourcePages = [3, 5, 7];
  const spread = planLessonUnitPackets(unitOf(options), options.section, options.book.source.fingerprint.sha256, 32_000);
  assert.deepEqual(spread.filter(item => item.role === "source").map(item => item.reads), [[1, 3], [5, 7]], "a small window splits cited pages into bounded runs");
  assert.equal(small[0].reads.length, 1);
});

await check("The unit revision covers the audited evidence, and only an evidence change moves it", async () => {
  const options = fixture();
  const unit = unitOf(options);
  assert.equal(unit.revision, lessonUnitRevision(unit.contentHash, [1, 2], []), "an unchanged unit keeps its evidence revision");
  assert.deepEqual(unitOf(options).revision, unit.revision, "re-reading the same saved unit is stable");

  // The same lesson text with a different cited page list is a different audit, even though the
  // stored lesson receipt must keep matching the markdown.
  options.section.transcript[0].lesson.sourcePages = [1];
  const narrowed = unitOf(options);
  assert.notEqual(narrowed.revision, unit.revision, "a page-list-only change is a new evidence revision");
  assert.equal(narrowed.contentHash, unit.contentHash, "the lesson revision stored with the entry is untouched");
  assert.equal(narrowed.contentHash, lessonHash(options.section.transcript[0].markdown));

  // Embedded crops are evidence too: adding one changes the revision and the audited roles.
  options.section.transcript[0].lesson.embeddedSnapshotIds = ["crop-2"];
  const cropped = unitOf(options);
  assert.deepEqual(cropped.roles, ["source", "teaching", "visual"]);
  assert.equal(cropped.revision, lessonUnitRevision(cropped.contentHash, [1], ["crop-2"]), "the current crops are part of the evidence revision");
  assert.notEqual(cropped.revision, narrowed.revision, "a crop change is a new evidence revision");

  // Receipts keep binding to the lesson revision the entry stores; the controller retires them
  // when the evidence they audited is replaced (proved end to end in the audit-as-you-go verifier).
  const receipts = await runReviewPass(auditOptions(options), planLessonUnitPackets(cropped, options.section, options.book.source.fingerprint.sha256));
  assert.deepEqual(receipts.map(receipt => receipt.contentHash), [cropped.contentHash, cropped.contentHash, cropped.contentHash],
    "receipts bind to the lesson revision, not the evidence revision");
  assert.equal(cropped.contentHash, lessonHash(options.section.transcript[0].markdown));
  options.section.learnQuality.reviews = receipts;
  assert.deepEqual(learnReviewIssues(options.section, options.book.source.fingerprint.sha256), [], "this evidence revision is approved");
});

await check("A unit audit runs prepared, reads only its pages, never renders a page, and binds receipts to the revision", async () => {
  const captures = [], signals = [];
  let active = 0, peak = 0;
  const options = fixture(async (selected, context, request) => {
    assert.equal(selected, model);
    captures.push(structuredClone(context));
    signals.push(request.signal);
    active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 20)); active--;
    return message();
  });
  options.section.transcript[0].lesson.embeddedSnapshotIds = ["crop-1", "crop-2"];
  const unit = unitOf(options);
  const before = structuredClone(options.section);
  const receipts = await runReviewPass(auditOptions(options), planLessonUnitPackets(unit, options.section, options.book.source.fingerprint.sha256));
  assert.equal(captures.length, 3, "one source window, one explanation check and one crop check");
  assert.equal(peak, 3, "independent checks run at the same time");
  assert.deepEqual(receipts.map(item => item.role), ["source", "teaching", "visual"]);
  assert(receipts.every(item => isReviewReceipt(item) && item.status === "pass" && item.contentHash === unit.contentHash
    && item.sourceHash === options.book.source.fingerprint.sha256 && item.model === "custom-provider/isolated-review"));
  assert.equal(new Set(signals).size, 3);
  assert(signals.every(signal => signal.aborted));
  assert.deepEqual(options.observations.reads, [[1, 2], [1, 2]]);
  assert.deepEqual(options.observations.views, [], "the unit audit renders no full source page");
  assert.deepEqual(options.observations.crops, ["crop-1", "crop-2"]);
  assert.deepEqual(options.section, before, "review service cannot persist verdicts or mutate study progress");
  for (const value of captures) {
    assert.deepEqual(value.tools, [], "Prepared review has no tool loop or access beyond its packet");
    assert(!JSON.stringify(value).includes("not-for-reviewer"));
    assert.equal(value.messages.length, 2, "Only its prompt and prepared evidence are supplied");
    assert.match(value.messages[0].content, /Unit check for saved explanation lesson-displacement/);
  }
});

await check("A source check requires every scoped page, not the model's unsupported assertion", async () => {
  const partial = await reviewOne(fixture(withTools([readCall(1, 1)])), "source", undefined);
  assert.equal(partial.status, "changes");
  assert.match(partial.findings[0].issue, /read page 2/);
  const complete = await reviewOne(fixture(withTools([readCall()])), "source");
  assert.equal(complete.status, "pass");
});

await check("Truncated or missing source pages never count as reviewed evidence", async () => {
  for (const sourceText of ["[Page 1]\nText\n[Page 2]\nText\n[Scholar: excerpt truncated at the limit]", "[Page 1]\nOnly one page was returned."]) {
    const options = fixture(withTools([readCall()]));
    options.evidence.read = async () => sourceText;
    const result = await reviewOne(options, "source");
    assert.equal(result.status, "changes");
    assert.match(result.findings[0].issue, /did not complete/);
  }
  const truncatedModel = await reviewOne(fixture(async () => message(pass, "length")), "teaching");
  assert.equal(truncatedModel.status, "changes");
});

await check("Bound readers reject out-of-section pages, reversed ranges, unknown crops and wider reads", async () => {
  for (const tool of [readCall(0, 1), readCall(1, 3), readCall(2, 1), call("view_source", { page: 3 }), call("view_crop", { id: "another-book-crop" })]) {
    const options = fixture(withTools([tool]));
    const result = await reviewOne(options, "source");
    assert.equal(result.status, "changes");
    assert.deepEqual(options.observations, { reads: [], views: [], crops: [] });
  }
  const options = fixture(withTools([readCall(1, 9)]));
  options.section.endPage = 9;
  assert.equal((await reviewOne(options, "source")).status, "changes");
  assert.deepEqual(options.observations.reads, []);
});

await check("Assigned packet boundaries are enforced by readers, even when a model asks for adjacent evidence", async () => {
  const source = fixture(withTools([readCall(1, 2)])); source.assignment = scope({ reads: [1] });
  assert.equal((await reviewOne(source, "source")).failure.code, "tool");
  assert.deepEqual(source.observations.reads, []);
  const visual = fixture(withTools([call("view_source", { page: 2 })])); visual.assignment = scope({ role: "visual", views: [1], cropIds: ["crop-1"] });
  assert.equal((await reviewOne(visual, "visual")).failure.code, "tool");
  assert.deepEqual(visual.observations.views, []);
  const crop = fixture(withTools([call("view_crop", { id: "crop-2" })])); crop.assignment = scope({ role: "visual", views: [1, 2], cropIds: ["crop-1"] });
  assert.equal((await reviewOne(crop, "visual")).failure.code, "tool");
  assert.deepEqual(crop.observations.crops, []);
});

await check("Prepared evidence errors never reach the model or produce approval", async () => {
  let requests = 0; const options = fixture(async () => { requests++; return message(); }); options.prepared = true;
  options.evidence.read = async () => "[Page 1] only one of two required pages";
  const result = await reviewOne(options, "source");
  assert.equal(result.failure.code, "evidence"); assert.equal(requests, 0); assert(isReviewReceipt(result));
});

await check("Replaced crops stay in history but only current lesson/inventory figures are reviewed", async () => {
  const options = fixture(withTools(visualCalls()));
  options.section.transcript[0].lesson.embeddedSnapshotIds = ["crop-1", "crop-2"];
  options.section.snapshots.push({ ...options.section.snapshots[0], id: "old-clipped-crop" });
  const unit = unitOf(options);
  assert.deepEqual(unit.snapshotIds, ["crop-1", "crop-2"], "a crop removed from the section is no longer inspectable evidence");
  assert.deepEqual(currentReviewSnapshots(options.section, options.book.source.fingerprint.sha256).map(crop => crop.id), ["crop-1", "crop-2"]);
  const result = await reviewOne(auditOptions(options), "visual", undefined);
  assert.equal(result.status, "pass");
  assert.deepEqual(options.observations.crops, ["crop-1", "crop-2"]);
  assert.equal(options.section.snapshots.length, 3, "no crop or user history is deleted");
});

await check("A text-only model gets figure metadata for a crop check and never claims a visual pass", async () => {
  const options = fixture(async () => message());
  options.ctx.model = { ...model, input: ["text"] };
  options.section.transcript[0].lesson.embeddedSnapshotIds = ["crop-1", "crop-2"];
  const result = await reviewOne(auditOptions(options), "visual", undefined);
  assert.equal(result.status, "pass");
  assert.ok(result.findings.some(finding => finding.severity === "advice" && finding.issue.includes("text-only model")));
  const plan = planLessonUnitPackets(unitOf(options), options.section, options.book.source.fingerprint.sha256);
  const prepared = await reviewOne(auditOptions(options), "visual", undefined);
  assert.equal(prepared.status, "pass");
  assert.deepEqual(options.observations.views, [], "even a tool-loop crop check never renders a page");
  assert.deepEqual(plan.filter(item => item.role === "visual").flatMap(item => item.cropIds), ["crop-1", "crop-2"]);
});

await check("Question review reads its source and blocks a unique correct-option explanation cue", async () => {
  const proposed = { question: "Which consequence follows from zero free charge?", options: [
    { value: "divergence", label: "The divergence of D is zero", description: "This correctly separates divergence from the value of the entire field." },
    { value: "field", label: "D itself is zero everywhere" }], correctValues: ["divergence"], kind: "conceptual" };
  const bad = { status: "changes", findings: [{ severity: "blocking", target: "question/options/0/description", sourcePages: [1],
    issue: "Only the correct option explains why it is correct, revealing the answer before assessment.", repair: "Remove the revealing explanation from the answer choices and retain it for feedback after submission." }] };
  const requests = [];
  const options = fixture(async (_selected, context) => { requests.push(structuredClone(context)); return message(bad); });
  const before = structuredClone(proposed);
  await assert.rejects(reviewLearnQuestion(options, proposed, [1]), /Repair the proposed question.*revealing the answer/s);
  assert.deepEqual(proposed, before);
  assert.equal(requests.length, 1, "a question review is one request, not a tool loop");
  assert.deepEqual(requests[0].tools, [], "a prepared question review has no tool loop");
  assert.equal(requests[0].messages.length, 2, "it sees only its prompt and prepared evidence");
  assert.deepEqual(options.observations.reads, [[1, 1]]);
  assert.deepEqual(options.observations.views, [], "a text question needs no rendered page");
  assert.deepEqual(options.observations.crops, [], "a text question needs no crop image");
  const unreadable = fixture();
  unreadable.evidence.read = async () => "the returned text never names the page it came from";
  await assert.rejects(reviewLearnQuestion(unreadable, proposed, [1]), /Question review incomplete \(evidence\)/);
});

await check("Question approval prepares its figure evidence, and a text question stays text only", async () => {
  const figureQuestion = { question: "Use the field arrows in the figure to explain the flux.", kind: "conceptual" };
  const figure = fixture();
  const guard = await reviewLearnQuestion(figure, figureQuestion, [1]);
  assert.doesNotThrow(() => guard(figure.section));
  assert.deepEqual(figure.observations, { reads: [[1, 1]], views: [1], crops: ["crop-1"] });
  const text = fixture();
  const textGuard = await reviewLearnQuestion(text, { question: "Explain why zero divergence does not imply zero field.", kind: "conceptual" }, [1]);
  assert.doesNotThrow(() => textGuard(text.section));
  assert.deepEqual(text.observations, { reads: [[1, 1]], views: [], crops: [] }, "a text question review carries the page text and no images");
  const broken = fixture();
  broken.evidence.crop = async () => { throw new Error("Saved figure bytes changed; the review is invalid."); };
  await assert.rejects(reviewLearnQuestion(broken, figureQuestion, [1]), /Question review incomplete \(evidence\)/);
});

await check("Question approval rejects lesson, source-plan and figure changes before display", async () => {
  const options = fixture();
  const guard = await reviewLearnQuestion(options, { question: "Explain why zero divergence does not imply zero field.", kind: "conceptual" }, [1]);
  assert.doesNotThrow(() => guard(options.section));
  for (const mutate of [
    current => { current.transcript[0].markdown += "\n\nAn unreviewed change."; },
    current => { current.learnQuality.coverage[0].description = "A different source claim"; },
    current => { current.snapshots[0].sha256 = "e".repeat(64); },
    current => { current.objectiveChecks[0].checks = ["application"]; },
    current => { current.learnQuality = undefined; },
  ]) {
    const current = structuredClone(options.section); mutate(current);
    assert.throws(() => guard(current), /lesson changed during question review/i);
  }
  const legacy = fixture(); legacy.section.learnQuality = undefined;
  const legacyGuard = await reviewLearnQuestion(legacy, { question: "Legacy practice" }, [1]);
  assert.doesNotThrow(() => legacyGuard(legacy.section));
  assert.deepEqual(legacy.observations.reads, [], "Old completed sessions retain their compatibility path");
});

await check("Cancelled specialist review is never converted into a blocking or passing persisted receipt", async () => {
  const owner = new AbortController(); owner.abort(new Error("Stopped by learner"));
  const options = fixture(); options.signal = owner.signal;
  await assert.rejects(reviewOne(options, "teaching"), /Stopped by learner/);
  await assert.rejects(runReviewPass({ ...auditOptions(options), signal: owner.signal },
    planLessonUnitPackets(unitOf(options), options.section, options.book.source.fingerprint.sha256)), /Stopped by learner/);
});

await check("An unchanged revision keeps its receipts, and only a revision change invalidates them", async () => {
  const options = fixture();
  const unit = unitOf(options);
  const receipts = await runReviewPass(auditOptions(options), planLessonUnitPackets(unit, options.section, options.book.source.fingerprint.sha256));
  options.section.learnQuality.reviews = receipts;
  assert.deepEqual(learnReviewIssues(options.section, options.book.source.fingerprint.sha256), [], "current receipts approve the unit");
  assert.deepEqual(reviewUnitIssues(options.section.learnQuality.reviews, { contentHash: unit.contentHash, sourceHash: options.book.source.fingerprint.sha256, roles: unit.roles }), []);
  const edited = structuredClone(options.section);
  edited.transcript[0].markdown += "\n\nCurl can be nonzero even where divergence vanishes.";
  edited.transcript[0].lesson.contentHash = lessonHash(edited.transcript[0].markdown);
  const issues = learnReviewIssues(edited, options.book.source.fingerprint.sha256);
  assert.deepEqual(issues, ["lesson:lesson-displacement: Complete the source review.", "lesson:lesson-displacement: Complete the teaching review."],
    "the replacement revision has no receipts yet");
  assert.equal(edited.learnQuality.reviews.length, 2, "an older revision's receipts stay stored but never approve the replacement");
  assert.deepEqual(unitBlockingFindings(edited.learnQuality.reviews, { contentHash: edited.transcript[0].lesson.contentHash,
    sourceHash: options.book.source.fingerprint.sha256, roles: ["source", "teaching"] }), [], "an older revision's findings never surface for the replacement");
});

await check("Blocking findings are reported with their answer keys and clear once answered", async () => {
  const issue = "The counterexample is asserted without its boundary condition.";
  const options = fixture(() => message({ status: "changes", findings: [{ severity: "blocking", target: "lesson-displacement / counterexample", sourcePages: [1],
    issue, repair: "State that the surface is polarized with no free charge." }] }));
  const unit = unitOf(options);
  const receipts = await runReviewPass(auditOptions(options), planLessonUnitPackets(unit, options.section, options.book.source.fingerprint.sha256));
  const blocking = unitBlockingFindings(receipts, { contentHash: unit.contentHash, sourceHash: options.book.source.fingerprint.sha256, roles: unit.roles });
  assert.equal(blocking.length, 2, "each role reports its finding");
  assert.deepEqual(blocking.map(item => item.key), blocking.map(item => computeFindingKey(item.role, item.finding)));
  assert.deepEqual(unitBlockingFindings(receipts, { contentHash: unit.contentHash, sourceHash: options.book.source.fingerprint.sha256, roles: unit.roles,
    responses: blocking.map(item => ({ key: item.key })) }), [], "an answered finding no longer blocks");
  assert.deepEqual(unitReviewFailures(receipts, { contentHash: unit.contentHash, sourceHash: options.book.source.fingerprint.sha256, roles: unit.roles }), []);
  const failed = { ...receipts[0], failure: { code: "timeout", message: "Source review timed out." }, status: "changes",
    findings: [{ severity: "blocking", target: "review evidence", sourcePages: [], issue: "The source check did not finish.", repair: "Resume the review; do not treat it as approval." }] };
  assert.deepEqual(unitReviewFailures([failed], { contentHash: unit.contentHash, sourceHash: options.book.source.fingerprint.sha256, roles: ["source"] }).map(item => item.code), ["timeout"]);
});

await check("Pruning keeps only receipts this target can still reuse and collapses duplicates", async () => {
  const options = fixture();
  const contentHash = learnReviewHash(options.section), sourceHash = options.book.source.fingerprint.sha256;
  const reviewer = "custom-provider/isolated-review";
  const at = (minutes, extra) => ({ ...pass, role: "source", contentHash, sourceHash, model: reviewer, createdAt: `2026-09-13T00:${String(minutes).padStart(2, "0")}:00.000Z`, ...extra });
  const receipts = [
    at(1),                                                                    // older completed check for this content
    at(5),                                                                    // newest completed check for this content
    { ...at(6), failure: { code: "cancelled", message: REVIEW_CHECKPOINT_MESSAGE } },   // superseded checkpoint
    { ...at(9), contentHash: "e".repeat(64), failure: { code: "cancelled", message: REVIEW_CHECKPOINT_MESSAGE } },   // live checkpoint
    at(3, { contentHash: "c".repeat(64) }),                                   // stale content still needed by the gate
    at(4, { sourceHash: "d".repeat(64) }),                                    // another source
    at(7, { model: "other-provider/other-model" }),                           // another reviewer model
  ];
  const kept = pruneReviewReceipts(receipts, { sourceHash, model: reviewer });
  assert.deepEqual(kept.map(receipt => receipt.createdAt).sort(),
    ["2026-09-13T00:03:00.000Z", "2026-09-13T00:05:00.000Z", "2026-09-13T00:09:00.000Z"].sort(),
    "the newest completed check per content hash, the live checkpoint, and the stale-content check the gate may still consume");
  const repeated = receipts[1];
  const collapsed = pruneReviewReceipts([...receipts, repeated, repeated], { sourceHash, model: reviewer });
  assert.deepEqual(collapsed, kept, "re-merging an already saved receipt collapses instead of duplicating it");
});

await check("One shared deadline ends a hung check, every finished packet is checkpointed, and a retry reuses it", async () => {
  let stalled = true; const checkpoints = [];
  const options = fixture(async (_model, context) => {
    const prompt = context.messages[0].content;
    if (stalled && roleOf(context) === "source" && listed(prompt, "Required read_source pages").map(Number).includes(9)) return new Promise(() => {}); // provider ignores abort
    return message();
  });
  options.section.endPage = 11; options.section.snapshots = [];
  options.section.transcript[0].lesson.sourcePages = [1, 9, 11];
  options.section.transcript[0].lesson.embeddedSnapshotIds = [];
  const unit = unitOf(options);
  const packets = planLessonUnitPackets(unit, options.section, options.book.source.fingerprint.sha256, 32_000);
  assert.deepEqual(packets.filter(item => item.role === "source").map(item => item.reads), [[1, 9], [11]]);
  options.onCheckpoint = (role, batches) => checkpoints.push({ role, batches });
  const started = Date.now();
  const receipts = await runReviewPass({ ...auditOptions(options), deadlineAt: started + 300, onCheckpoint: options.onCheckpoint }, packets);
  assert(Date.now() - started < 3000, "a hung provider cannot outlive the shared deadline");
  const source = receipts.find(receipt => receipt.role === "source");
  assert.equal(source.failure.code, "timeout");
  assert.equal(source.batches.length, 1, "the finished window was recorded before the deadline");
  const saved = checkpoints.filter(item => item.role === "source").at(-1);
  const savedAll = checkpoints.map(item => reviewCheckpoint(unit.contentHash, options.book.source.fingerprint.sha256, options.ctx, item.role, item.batches));
  const checkpoint = savedAll.find(item => item.role === "source");
  assert(isReviewReceipt(checkpoint) && checkpoint.failure.message === REVIEW_CHECKPOINT_MESSAGE);
  assert(reviewGateIssues([checkpoint], { contentHash: unit.contentHash, sourceHash: options.book.source.fingerprint.sha256, roles: ["source"] }).length, "a checkpoint is never approval");
  assert(reviewUnitIssues([checkpoint], { contentHash: unit.contentHash, sourceHash: options.book.source.fingerprint.sha256, roles: ["source"] }).length,
    "the per-unit gate also refuses an unfinished checkpoint as evidence");
  assert(receipts.every(isReviewReceipt));
  options.section.learnQuality.reviews = savedAll;
  stalled = false;
  const readsBefore = options.observations.reads.length;
  const resumed = await runReviewPass({ ...auditOptions(options), deadlineAt: Date.now() + 1000 }, packets);
  assert(resumed.every(receipt => receipt.status === "pass" && !receipt.failure));
  assert.deepEqual(options.observations.reads.slice(readsBefore), [[1, 1], [9, 9]], "a saved checkpoint means only the unfinished window is re-read");
});

await check("A failed packet preserves other packets' content findings without pretending the review finished", async () => {
  const options = fixture(async (_model, context) => {
    const role = roleOf(context), prompt = context.messages[0].content;
    if (role === "source" && listed(prompt, "Required read_source pages").map(Number).includes(9)) throw new Error("Simulated window outage");
    return role === "source" ? message({ status: "changes", findings: [{ severity: "blocking", target: "lesson-sign", sourcePages: [1],
      issue: "The reflected field sign is reversed.", repair: "Correct the sign using the stated propagation direction." }] }) : message();
  });
  options.section.endPage = 11; options.section.snapshots = [];
  options.section.transcript[0].lesson.sourcePages = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  const unit = unitOf(options);
  const packets = planLessonUnitPackets(unit, options.section, options.book.source.fingerprint.sha256);
  assert.deepEqual(packets.filter(item => item.role === "source").map(item => item.reads), [[1, 2, 3, 4], [5, 6, 7, 8], [9]]);
  const source = (await runReviewPass(auditOptions(options), packets)).find(receipt => receipt.role === "source");
  assert.equal(source.failure.code, "provider");
  assert.equal(source.status, "changes");
  assert(source.findings.some(finding => finding.target === "lesson-sign"));
  assert(isReviewReceipt(source));
});

await check("Any-model compatibility handles prose wrapping, follow-up recovery turns, small windows, and undeclared limits", async () => {
  // 1. Model that wraps the JSON in prose
  const wrapped = "Here is my evaluation:\n```json\n" + JSON.stringify(pass) + "\n```\nAll clear!";
  const wrappedRes = await reviewOne(fixture(async () => message(wrapped)), "teaching");
  assert.equal(wrappedRes.status, "pass");

  // 2. Model that returns prose first, then JSON on the follow-up recovery turn
  let turnCount = 0;
  const followUpRes = await reviewOne(fixture(async () => {
    turnCount++;
    return turnCount === 1 ? message("I think this looks good.") : message(pass);
  }), "teaching");
  assert.equal(followUpRes.status, "pass");
  assert.equal(turnCount, 2);

  // 3. A small context window splits a unit's cited pages into bounded 2-page windows
  const opts = fixture();
  opts.section.transcript[0].lesson.sourcePages = [1, 2];
  opts.section.endPage = 9;
  opts.section.learnQuality.coverage[0].sourcePages = [3, 4, 5, 6, 7, 8, 9];
  const plan32k = planLessonUnitPackets(unitOf(opts), opts.section, opts.book.source.fingerprint.sha256, 32_000);
  assert.ok(plan32k.filter(item => item.role === "source").every(item => item.reads.length <= 2));

  // 4. Model with no maxTokens uses fallback and completes
  const noMaxTokensModel = { ...model };
  delete noMaxTokensModel.maxTokens;
  const noMaxOpts = fixture(async () => message());
  noMaxOpts.ctx.model = noMaxTokensModel;
  const noMaxRes = await reviewOne(noMaxOpts, "teaching");
  assert.equal(noMaxRes.status, "pass");
});
console.log(`Scholar Learn unit review service: ${checks} checks passed with mock completions and injected evidence; no network or study-vault access.`);
