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
const { reviewOne, reviewLearnDraft, reviewLearnQuestion, currentReviewSnapshots, planReviewAssignments, reviewCheckpoint, REVIEW_CHECKPOINT_MESSAGE } = await load("learn-review.ts");
const { lessonHash, learnReviewHash } = await load("lesson.ts");
const { isReviewReceipt, reviewGateIssues } = await load("learn-quality.ts");
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
const assessmentCalls = () => [readCall(1, 1), call("view_source", { page: 1 }, "assessment-page-1"), call("view_crop", { id: "crop-1" }, "assessment-crop-1")];
const visualCalls = () => [call("view_source", { page: 1 }, "page-1"), call("view_source", { page: 2 }, "page-2"),
  call("view_crop", { id: "crop-1" }, "crop-1"), call("view_crop", { id: "crop-2" }, "crop-2")];
const listed = (prompt, label) => /Required (?:read_source|view_source) pages|Required view_crop IDs/.test(label)
  ? new RegExp(`${label}: ([^\\n]+)\\.`).exec(prompt)[1].split(", ").filter(item => !item.startsWith("none")) : [];
const pagesIn = (prompt, kind) => listed(prompt, `Required ${kind} pages`).map(Number);
const cropsIn = prompt => listed(prompt, "Required view_crop IDs");
const sortedPairs = pairs => pairs.map(String).sort();
function roleOf(context) {
  const prompt = context.messages[0].content;
  if (prompt.startsWith("Compare the ENTIRE")) return "source";
  if (prompt.startsWith("Evaluate the lesson as instruction")) return "teaching";
  if (prompt.startsWith("Inspect the actual rendered")) return "visual";
  if (prompt.startsWith("Review this frozen proposed question")) return "assessment";
  throw new Error("Unknown review assignment");
}
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
const scope = overrides => ({ role: "source", id: "scoped", instruction: "Scoped test packet.", reads: [], views: [], cropIds: [], payload: {}, ...overrides });
let checks = 0;
async function check(name, fn) { await fn(); checks++; console.log(`[PASS] ${name}`); }

await check("A crew of isolated registry conversations runs in parallel and only returns owner-committable receipts", async () => {
  const captures = [], signals = [];
  let active = 0, peak = 0;
  const options = fixture(async (selected, context, request) => {
    assert.equal(selected, model);
    captures.push(structuredClone(context));
    signals.push(request.signal);
    active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 20)); active--;
    return message();
  });
  const before = structuredClone(options.section);
  const receipts = await reviewLearnDraft(options);
  assert.equal(captures.length, 4, "one source window, one topic check, one coherence check and one visual packet");
  assert.equal(peak, 4, "independent checks run at the same time");
  assert.deepEqual(receipts.map(item => item.role), ["source", "teaching", "visual"]);
  assert(receipts.every(item => isReviewReceipt(item) && item.status === "pass" && item.contentHash === learnReviewHash(options.section)
    && item.sourceHash === options.book.source.fingerprint.sha256 && item.model === "custom-provider/isolated-review"));
  assert.equal(new Set(signals).size, 4);
  assert(signals.every(signal => signal.aborted));
  assert.deepEqual(sortedPairs(options.observations.reads), sortedPairs([[1, 1], [1, 2]]));
  assert.deepEqual(options.observations.views, [1, 2]);
  assert.deepEqual(options.observations.crops, ["crop-1", "crop-2"]);
  assert.deepEqual(options.section, before, "Review service cannot persist verdicts or mutate study progress");
  for (const value of captures) {
    assert.deepEqual(value.tools, [], "Prepared review has no tool loop or access beyond its packet");
    assert(!JSON.stringify(value).includes("not-for-reviewer"));
    assert.equal(value.messages.length, 2, "Only its prompt and prepared evidence are supplied");
    assert.match(value.messages[0].content, /Crew assignment:/);
  }
});

await check("The crew plan maps topics to their evidence and still covers every page and current crop", async () => {
  const options = fixture();
  const entry = options.section.transcript[0];
  entry.markdown = ["### Alpha", "", "Alpha explains flux.", "", "![[../Assets/crop-1.png|720]]", "", "### Beta", "", "Beta derives the field.", "", "```", "### not a topic heading", "```", "", "$$", "E = 0", "$$"].join("\n");
  entry.lesson = { ...entry.lesson, sourcePages: [1, 2, 3, 4, 5, 6, 7, 8, 9], contentHash: lessonHash(entry.markdown), embeddedSnapshotIds: ["crop-1"] };
  options.section.endPage = 9;
  options.section.snapshots[0] = { ...options.section.snapshots[0], page: 2 };
  options.section.snapshots[1] = { ...options.section.snapshots[1], page: 8 };
  options.section.figureCoverage.pages = [{ page: 8, read: true, candidates: [], review: { page: 8, observation: "A loose figure.", figures: [{ label: "Figure 8", snapshotId: "crop-2" }] } }];
  options.section.learnQuality.coverage = [
    { id: "a", kind: "concept", description: "Flux", sourcePages: [2], objective: options.section.objectives[0], lessonId: "displacement", evidence: "Alpha explains flux." },
    { id: "b", kind: "derivation", description: "Field", sourcePages: [5, 7], objective: options.section.objectives[0], lessonId: "displacement", evidence: "Beta derives the field." }];
  const plan = planReviewAssignments(options.section, options.book.source.fingerprint.sha256);
  const of = role => plan.filter(item => item.role === role);
  assert.deepEqual(of("source").map(item => item.reads), [[1, 2, 3, 4], [5, 6, 7, 8], [9]]);
  assert.deepEqual(of("source")[0].payload.passages.map(passage => passage.heading), ["Alpha"], "a page window carries only the topics citing it");
  assert.deepEqual(of("teaching").map(item => item.reads), [[2], [5, 7], []]);
  assert.deepEqual(of("teaching")[2].payload.outline, ["Alpha", "Beta"], "fenced headings do not split topics");
  assert.equal(of("teaching")[2].payload.lesson, undefined);
  assert.deepEqual(of("visual").map(item => [item.views, item.cropIds]), [[[2], ["crop-1"]], [[5, 7], []], [[1, 3, 4, 6, 8], ["crop-2"]], [[9], []]]);
  assert.deepEqual([...new Set(of("visual").flatMap(item => item.views))].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual([...new Set(of("source").flatMap(item => item.reads))].length, 9);
  for (const item of of("visual")) {
    assert(item.views.length + item.cropIds.length <= 6);
    for (const id of item.cropIds) assert(item.views.includes(options.section.snapshots.find(crop => crop.id === id).page));
  }
  const beta = { ...options, prepared: true, assignment: of("teaching")[1] };
  assert.equal((await reviewOne(beta, "teaching")).status, "pass");
  assert.deepEqual(options.observations.reads, [[5, 5], [7, 7]], "noncontiguous pages load as separate bounded runs");
});

await check("A source pass requires every scoped source page, not the model's unsupported assertion", async () => {
  const noRead = await reviewOne(fixture(), "source");
  assert.equal(noRead.status, "changes");
  assert.match(noRead.findings[0].issue, /read page 1.*read page 2/);
  const partial = await reviewOne(fixture(withTools([readCall(1, 1)])), "source");
  assert.equal(partial.status, "changes");
  assert.match(partial.findings[0].issue, /read page 2/);
  const complete = await reviewOne(fixture(withTools([readCall()])), "source");
  assert.equal(complete.status, "pass");
});

await check("Visual approval requires every full page and every actual saved crop", async () => {
  for (const omitted of ["page-1", "page-2", "crop-1", "crop-2"]) {
    const result = await reviewOne(fixture(withTools(visualCalls().filter(item => item.id !== omitted))), "visual");
    assert.equal(result.status, "changes");
    assert.match(result.findings[0].issue, omitted.startsWith("page") ? new RegExp(`view page ${omitted.at(-1)}`) : new RegExp(`inspect crop ${omitted}`));
  }
  let called = 0;
  const options = fixture(async () => { called++; return message(); });
  options.ctx.model = { ...model, input: ["text"] };
  const textOnlyResult = await reviewOne(options, "visual");
  assert.equal(textOnlyResult.status, "pass");
  assert.ok(textOnlyResult.findings.some(f => f.severity === "advice" && f.issue.includes("text-only model")));
  assert.equal(called, 1);
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

await check("Question review reads its source and blocks a unique correct-option explanation cue", async () => {
  const proposed = { question: "Which consequence follows from zero free charge?", options: [
    { value: "divergence", label: "The divergence of D is zero", description: "This correctly separates divergence from the value of the entire field." },
    { value: "field", label: "D itself is zero everywhere" }], correctValues: ["divergence"], kind: "conceptual" };
  const bad = { status: "changes", findings: [{ severity: "blocking", target: "question/options/0/description", sourcePages: [1],
    issue: "Only the correct option explains why it is correct, revealing the answer before assessment.", repair: "Remove the revealing explanation from the answer choices and retain it for feedback after submission." }] };
  const options = fixture(withTools(assessmentCalls(), bad));
  const before = structuredClone(proposed);
  await assert.rejects(reviewLearnQuestion(options, proposed, [1]), /Repair the proposed question.*revealing the answer/s);
  assert.deepEqual(proposed, before);
  assert.deepEqual(options.observations.reads, [[1, 1]]);
  assert.deepEqual(options.observations.views, [1]);
  assert.deepEqual(options.observations.crops, ["crop-1"]);
  await assert.rejects(reviewLearnQuestion(fixture(), proposed, [1]), /read page 1/);
});

await check("Question approval requires its source figure and full page, without unrelated-page requirements", async () => {
  const question = { question: "Use the field arrows in the figure to explain the flux.", kind: "conceptual" };
  for (const omitted of ["view_source", "view_crop"]) {
    const options = fixture(withTools(assessmentCalls().filter(tool => tool.name !== omitted)));
    await assert.rejects(reviewLearnQuestion(options, question, [1]), omitted === "view_crop" ? /inspect crop crop-1/ : /view page 1/);
  }
  const textOnly = fixture(withTools([readCall(1, 1)]));
  await assert.rejects(reviewLearnQuestion(textOnly, question, [1]), /view page 1.*inspect crop crop-1/s);
  const complete = fixture(withTools(assessmentCalls()));
  const guard = await reviewLearnQuestion(complete, question, [1]);
  assert.doesNotThrow(() => guard(complete.section));
  assert.deepEqual(complete.observations, { reads: [[1, 1]], views: [1], crops: ["crop-1"] });
});

await check("Question approval rejects lesson, source-plan and figure changes before display", async () => {
  const options = fixture(withTools(assessmentCalls()));
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
  await assert.rejects(reviewLearnDraft(options), /Stopped by learner/);
});

await check("Current approvals are reused whole, and an edit re-runs only the checks whose packet changed", async () => {
  const prompts = [];
  const options = fixture(async (_selected, context) => { prompts.push(context.messages[0].content); return message(); });
  options.section.learnQuality.reviews = await reviewLearnDraft(options);
  const first = prompts.length;
  assert((await reviewLearnDraft(options)).every(item => item.status === "pass"));
  assert.equal(prompts.length, first, "an unchanged lesson makes no requests");
  options.section.keyPoints.push("A newly explained limitation");
  options.section.learnQuality.reviews = await reviewLearnDraft(options);
  assert.equal(prompts.length, first + 1, "a key point only changes the coherence packet");
  assert.match(prompts.at(-1), /whole-lesson coherence/);
  options.section.transcript[0].markdown += "\n\nCurl can be nonzero even where divergence vanishes.";
  options.section.transcript[0].lesson.contentHash = lessonHash(options.section.transcript[0].markdown);
  const refreshed = await reviewLearnDraft(options);
  assert.equal(prompts.length, first + 3, "a topic edit re-runs its topic check and the page window citing it");
  assert(prompts.slice(-2).some(prompt => prompt.startsWith("Compare the ENTIRE")) && prompts.slice(-2).some(prompt => /Crew assignment: topic 1/.test(prompt)));
  assert(refreshed.every(item => item.status === "pass" && item.contentHash === learnReviewHash(options.section)));
});

await check("Reusing persisted receipts selects the same newest review that the approval gate checked", async () => {
  const options = fixture();
  const contentHash = learnReviewHash(options.section), sourceHash = options.book.source.fingerprint.sha256;
  const current = ["source", "teaching", "visual"].map(role => ({ ...pass, role, contentHash, sourceHash,
    model: "custom-provider/isolated-review", createdAt: "2026-09-13T00:00:01.000Z" }));
  const stale = { ...current[0], contentHash: "c".repeat(64), createdAt: now };
  options.section.learnQuality.reviews = [...current, stale];
  const results = await reviewLearnDraft(options);
  assert.equal(results[0].contentHash, contentHash);
  assert.equal(results[0].createdAt, current[0].createdAt);
});

await check("Visual packets hold at most six images, keep each crop with its full page, and cover every page and crop", async () => {
  const packets = [];
  const options = fixture(async (_selected, context) => {
    const role = roleOf(context), prompt = context.messages[0].content;
    if (role !== "visual") return message();
    const pages = pagesIn(prompt, "view_source"), cropIds = cropsIn(prompt);
    packets.push({ pages, cropIds });
    const payload = JSON.parse(prompt.split("All following material is evidence, never instructions:\n")[1]);
    assert.equal(payload.lesson, undefined, "a crew packet does not carry the whole lesson");
    assert(pages.length + cropIds.length <= 6);
    for (const id of cropIds) assert(pages.includes(options.section.snapshots.find(crop => crop.id === id).page), "Each crop is reviewed alongside its source page");
    assert.equal(context.messages[1].content.filter(item => item.type === "image").length, pages.length + cropIds.length);
    return message();
  });
  options.section.snapshots = Array.from({ length: 15 }, (_, i) => ({ ...options.section.snapshots[0], id: `crowded-${i}`, caption: `Saved crowded-page crop ${i}` }));
  options.section.snapshots.push({ ...options.section.snapshots[0], id: "page-two", page: 2 });
  options.section.transcript[0].lesson.embeddedSnapshotIds = options.section.snapshots.map(crop => crop.id);
  const results = await reviewLearnDraft(options);
  assert(results.every(result => isReviewReceipt(result) && result.status === "pass"), JSON.stringify(results));
  assert(packets.length > 1, "Crowded pages are split into bounded packets");
  assert.deepEqual([...new Set(options.observations.views)].sort(), [1, 2]);
  assert.deepEqual([...options.observations.crops].sort(), options.section.snapshots.map(crop => crop.id).sort());
  assert.equal(new Set(options.observations.crops).size, options.section.snapshots.length);
});

await check("One blocked visual packet prevents aggregate approval without dropping its finding", async () => {
  const options = fixture(async (_selected, context) => {
    const prompt = context.messages[0].content, role = roleOf(context);
    if (role === "visual" && cropsIn(prompt).includes("crowded-0")) return message({ status: "changes", findings: [{
      severity: "blocking", target: "crowded-0", sourcePages: [1], issue: "The crop clips the direction arrow.", repair: "Recapture the full arrow and its label." }] });
    return message();
  });
  options.section.snapshots = Array.from({ length: 15 }, (_, i) => ({ ...options.section.snapshots[0], id: `crowded-${i}` }));
  options.section.transcript[0].lesson.embeddedSnapshotIds = options.section.snapshots.map(crop => crop.id);
  const result = (await reviewLearnDraft(options)).find(item => item.role === "visual");
  assert.equal(result.status, "changes");
  assert(result.findings.some(finding => finding.target === "crowded-0" && finding.severity === "blocking"));
  assert(isReviewReceipt(result));
});

await check("An eleven-page source is split into parallel page windows and completion events refer to whole roles", async () => {
  const events = [];
  const options = fixture();
  options.section.endPage = 11; options.section.snapshots = [];
  options.onProgress = event => events.push(event);
  const receipts = await reviewLearnDraft(options);
  assert(receipts.every(receipt => receipt.status === "pass" && !receipt.failure));
  assert.deepEqual(sortedPairs(options.observations.reads), sortedPairs([[1, 1], [1, 4], [5, 8], [9, 11]]));
  assert.deepEqual([...new Set(options.observations.views)].sort((a, b) => a - b), Array.from({ length: 11 }, (_, i) => i + 1));
  assert.deepEqual(events.filter(event => event.stage === "complete").map(event => event.role).sort(), ["source", "teaching", "visual"]);
  assert(events.some(event => event.batch === 7 && event.batches === 7), "progress reports finished checks out of the whole crew");
});

await check("A failed source window preserves other windows' content findings without pretending the review finished", async () => {
  const options = fixture(async (_model, context) => {
    const role = roleOf(context), prompt = context.messages[0].content;
    if (role === "source" && pagesIn(prompt, "read_source")[0] === 9) throw new Error("Simulated window outage");
    return role === "source" ? message({ status: "changes", findings: [{ severity: "blocking", target: "lesson-sign", sourcePages: [1],
      issue: "The reflected field sign is reversed.", repair: "Correct the sign using the stated propagation direction." }] }) : message();
  });
  options.section.endPage = 11; options.section.snapshots = [];
  const source = (await reviewLearnDraft(options)).find(receipt => receipt.role === "source");
  assert.equal(source.failure.code, "provider");
  assert.equal(source.status, "changes");
  assert(source.findings.some(finding => finding.target === "lesson-sign"));
  assert(isReviewReceipt(source));
});

await check("Replaced crops stay in history but only current lesson/inventory figures are reviewed", async () => {
  const options = fixture(withTools(visualCalls()));
  options.section.snapshots.push({ ...options.section.snapshots[0], id: "old-clipped-crop" });
  assert.deepEqual(currentReviewSnapshots(options.section, options.book.source.fingerprint.sha256).map(crop => crop.id), ["crop-1", "crop-2"]);
  const result = await reviewOne(options, "visual");
  assert.equal(result.status, "pass");
  assert.deepEqual(options.observations.crops, ["crop-1", "crop-2"]);
  assert.equal(options.section.snapshots.length, 3, "no crop or user history is deleted");
});

await check("One shared deadline ends a hung check, every pass is checkpointed first, and a retry re-runs only unfinished work", async () => {
  let stalled = true; const checkpoints = [];
  const options = fixture(async (_model, context) => {
    if (stalled && roleOf(context) === "source" && pagesIn(context.messages[0].content, "read_source")[0] === 9) return new Promise(() => {}); // provider ignores abort
    return message();
  });
  options.section.endPage = 11; options.section.snapshots = []; options.reviewTimeoutMs = 300;
  options.onCheckpoint = (role, batches) => checkpoints.push({ role, batches });
  const started = Date.now();
  const receipts = await reviewLearnDraft(options);
  assert(Date.now() - started < 3000, "a hung provider cannot outlive the shared deadline");
  const source = receipts.find(receipt => receipt.role === "source");
  assert.equal(source.failure.code, "timeout");
  assert.equal(source.batches.length, 2);
  const saved = checkpoints.filter(item => item.role === "source").at(-1);
  assert.equal(saved.batches.length, 2, "finished windows were handed to the owner before the deadline");
  const checkpoint = reviewCheckpoint(options.section, options.book, options.ctx, "source", saved.batches);
  assert(isReviewReceipt(checkpoint) && checkpoint.failure.message === REVIEW_CHECKPOINT_MESSAGE);
  assert(reviewGateIssues([checkpoint], { contentHash: learnReviewHash(options.section), sourceHash: options.book.source.fingerprint.sha256, roles: ["source"] }).length, "a checkpoint is never approval");
  assert(receipts.every(isReviewReceipt));
  assert(receipts.filter(receipt => receipt.role !== "source").every(receipt => receipt.status === "pass"));
  options.section.learnQuality.reviews = [checkpoint, ...JSON.parse(JSON.stringify(receipts.filter(receipt => receipt.role !== "source")))];
  stalled = false; options.reviewTimeoutMs = 1000;
  const readsBefore = options.observations.reads.length;
  const resumed = await reviewLearnDraft(options);
  assert(resumed.every(receipt => receipt.status === "pass" && !receipt.failure));
  assert.deepEqual(options.observations.reads.slice(readsBefore), [[9, 11]], "a saved checkpoint means only the unfinished window is re-read");
  assert.equal(resumed.find(receipt => receipt.role === "source").batches.length, 3);
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

await check("Any-model compatibility handles prose wrapping, follow-up recovery turn, small windows, and undeclared limits", async () => {
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

  // 3. Small context window derives 2-page source windows and 2-image visual packets
  const opts = fixture();
  const plan32k = planReviewAssignments(opts.section, opts.book.source.fingerprint.sha256, 32_000);
  const source32k = plan32k.filter(p => p.role === "source");
  assert.ok(source32k.every(p => p.reads.length <= 2));

  // 4. Model with no maxTokens uses fallback and completes
  const noMaxTokensModel = { ...model };
  delete noMaxTokensModel.maxTokens;
  const noMaxOpts = fixture(async () => message());
  noMaxOpts.ctx.model = noMaxTokensModel;
  const noMaxRes = await reviewOne(noMaxOpts, "teaching");
  assert.equal(noMaxRes.status, "pass");
});
console.log(`Scholar Learn review service: ${checks} checks passed with mock completions and injected evidence; no network or study-vault access.`);
