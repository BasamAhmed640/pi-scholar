import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { extensionPath, jitiPath } from "./sdk.mjs";
const { createJiti } = await import(pathToFileURL(jitiPath).href);
const jiti = createJiti(import.meta.url, { moduleCache: false });
const quality = await jiti.import(join(dirname(extensionPath), "learn-quality.ts"));

const objective = "Derive the field boundary conditions";
const explanation = "Integrate across a thin pillbox. Its side flux tends to zero with its height, leaving the difference between the normal field components.";
const figureExplanation = "Read the arrow crossing the upper face as the outward normal. The lower face has the opposite normal, which supplies the minus sign.";
const equationExplanation = "The jump in the normal displacement equals the free surface charge. The opposite surface normals determine the subtraction order.";
const context = {
  startPage: 181, endPage: 185, objectives: [objective],
  lessons: [{ id: "lesson-boundary", markdown: `### Boundary conditions\n\n${explanation}\n\n${figureExplanation}\n\n${equationExplanation}`,
    keyEquationIds: ["normal-jump"], embeddedSnapshotIds: ["pillbox"] }],
  objectiveChecks: [{ objective, checks: ["application"] }],
};
const plan = [{ id: "pillbox-derivation", kind: "derivation", description: "Derive the normal boundary condition with a pillbox", sourcePages: [184], objective }];
const delivered = [{ ...plan[0], lessonId: "boundary", evidence: explanation }];
const check = (value, overrides = {}) => quality.sourceCoverageIssues(value, { ...context, ...overrides }, { delivered: true });
assert.equal(quality.isSourceCoverageLedger(plan), true);
assert.deepEqual(quality.sourceCoverageIssues(plan, context), []);
assert(check(plan).some(issue => /lessonId/.test(issue)));
assert.deepEqual(check(delivered), []);
assert.deepEqual(check([{ ...delivered[0], lessonId: "lesson-boundary" }]), []);
assert.deepEqual(check([{ ...delivered[0], lessonId: "lesson-boundary" }], {
  lessons: [{ ...context.lessons[0], id: "lesson-lesson-boundary" }],
}), []);
assert(quality.sourceCoverageIssues([], context).some(issue => /source-based/.test(issue)));
console.log("[PASS] source planning precedes delivery; both public and saved lesson IDs resolve");

assert(check([...delivered, ...delivered]).some(issue => /unique IDs/.test(issue)));
assert(check([{ ...delivered[0], objective: "Invented objective" }]).some(issue => /declared objective/.test(issue)));
assert(check([{ ...delivered[0], sourcePages: [190] }]).some(issue => /outside this section/.test(issue)));
assert(check([{ ...delivered[0], sourcePages: [184, 184] }]).length);
assert(check([{ ...delivered[0], sourcePages: [184.5] }]).length);
assert(check([{ ...delivered[0], lessonId: "deleted" }]).some(issue => /current saved/.test(issue)));
assert(check(delivered, { lessons: [context.lessons[0], { ...context.lessons[0], id: "boundary" }] }).some(issue => /one current/.test(issue)));
assert(check([{ ...delivered[0], authorVerified: true }]).length);
assert(check([{ ...delivered[0], snapshotId: "unrelated" }]).length);
console.log("[PASS] duplicate, out-of-scope, deleted, ambiguous, and author-invented records cannot certify coverage");

assert(check([{ ...delivered[0], evidence: "A different explanation with similar meaning." }]).some(issue => /exact excerpt/.test(issue)));
assert(check(delivered, { lessons: [{ ...context.lessons[0], markdown: "The learner deleted the old explanation." }] }).some(issue => /exact excerpt/.test(issue)));
const label = { ...delivered[0], kind: "concept", description: "Vectors have direction only", evidence: "Vectors have direction only" };
assert(check([label], { lessons: [{ id: "lesson-boundary", markdown: label.evidence }] }).some(issue => /body evidence/.test(issue)));
assert(check([{ ...delivered[0], evidence: "### Boundary conditions" }]).some(issue => /body evidence/.test(issue)));
assert(check([{ ...delivered[0], evidence: "![[Assets/pillbox.png]]" }], { lessons: [{ id: "boundary", markdown: "![[Assets/pillbox.png]]" }] }).some(issue => /body evidence/.test(issue)));
console.log("[PASS] label-only coverage and four-word placeholder lessons fail; evidence remains tied to visible prose");

const equation = { ...delivered[0], id: "normal-equation", kind: "equation", description: "Normal displacement jump", evidence: equationExplanation, equationId: "normal-jump" };
const figure = { ...delivered[0], id: "pillbox-figure", kind: "figure", description: "Pillbox surface normals", evidence: figureExplanation, snapshotId: "pillbox" };
assert.deepEqual(check([...delivered, equation, figure]), []);
assert(check([{ ...equation, equationId: "not-rendered" }]).some(issue => /Key equation ID/.test(issue)));
assert(check([{ ...figure, snapshotId: "not-embedded" }]).some(issue => /snapshot ID/.test(issue)));
assert(check([{ ...equation, equationId: undefined }]).length);
assert(check([equation], { lessons: [{ ...context.lessons[0], keyEquationIds: [] }] }).some(issue => /Key equation ID/.test(issue)));
assert(check([figure], { lessons: [{ ...context.lessons[0], embeddedSnapshotIds: [] }] }).some(issue => /snapshot ID/.test(issue)));
console.log("[PASS] equations and figures require actual rendered IDs in their own saved lesson unit");

assert(check(delivered, { objectiveChecks: [{ objective, checks: ["conceptual"] }] }).some(issue => /application or computation/.test(issue)));
assert(check(delivered, { objectiveChecks: [{ objective, checks: ["discrimination", "conceptual"] }] }).some(issue => /application or computation/.test(issue)));
assert(check(delivered, { objectiveChecks: undefined }).some(issue => /application or computation/.test(issue)));
assert.deepEqual(check(delivered, { objectiveChecks: [{ objective, checks: ["computation"] }] }), []);
assert.deepEqual(check([{ ...delivered[0], kind: "concept" }], { objectiveChecks: [{ objective, checks: ["conceptual"] }] }), []);
console.log("[PASS] derivation mastery requires applied reasoning without making every objective use all four checks");

const blocking = { severity: "blocking", target: "lesson-boundary / normal field equation", sourcePages: [184],
  issue: "The lower-face normal is not explained.", repair: "Explain the reversed surface normal before subtracting the fields." };
const advice = { ...blocking, severity: "advice", issue: "The sentence could be clearer.", repair: "Consider a concrete pillbox example." };
const pass = { status: "pass", findings: [] };
assert(quality.isReviewResult(pass));
assert(quality.isReviewResult({ status: "pass", findings: [advice] }));
assert(quality.isReviewResult({ status: "changes", findings: [blocking] }));
for (const malformed of [
  { status: "pass", findings: [blocking] }, { status: "changes", findings: [] }, { status: "changes", findings: [advice] },
  { ...pass, authorVerified: true }, { status: "pass" }, { status: "PASS", findings: [] },
  { status: "changes", findings: [{ ...blocking, issue: "" }] }, { status: "changes", findings: [{ ...blocking, sourcePages: [-1] }] },
  { status: "changes", findings: [{ ...blocking, confidence: 1 }] }, { status: "changes", findings: Array(41).fill(blocking) },
  { status: "changes", findings: [{ ...blocking, target: "x".repeat(1001) }] },
]) assert(!quality.isReviewResult(malformed), JSON.stringify(malformed).slice(0, 200));
assert.deepEqual(quality.parseReviewerVerdict(JSON.stringify(pass)), pass);
assert.deepEqual(quality.parseReviewerVerdict(`\n\`\`\`json\n${JSON.stringify(pass)}\n\`\`\`\n`), pass);
for (const raw of ["", "Looks good!", '{"status":"pass","findings":[', `${JSON.stringify(pass)} extra`,
  JSON.stringify({ status: "pass", findings: [blocking] }), JSON.stringify({ ...pass, contentHash: "a".repeat(64) })]) {
  assert.throws(() => quality.parseReviewerVerdict(raw));
}
console.log("[PASS] malformed, truncated, oversized, and contradictory reviewer verdicts fail closed");

const current = { contentHash: "a".repeat(64), sourceHash: "b".repeat(64) };
const receipt = (role, changes = {}) => ({ ...pass, role, ...current, model: "any-provider/any-model", createdAt: "2026-09-13T00:00:00.000Z", ...changes });
const receipts = [receipt("source"), receipt("teaching"), receipt("visual")];
assert.deepEqual(quality.reviewGateIssues(receipts, current), []);
assert(quality.reviewGateIssues(receipts.slice(0, 2), current).some(issue => /visual/.test(issue)));
assert(quality.reviewGateIssues(receipts, { ...current, contentHash: "c".repeat(64) }).every(issue => /stale/.test(issue)));
assert(quality.reviewGateIssues(receipts, { ...current, sourceHash: "d".repeat(64) }).every(issue => /stale/.test(issue)));
assert(!quality.isReviewReceipt(receipt("author")));
assert(!quality.isReviewReceipt(receipt("source", { createdAt: "yesterday" })));
assert(!quality.isReviewReceipt(receipt("source", { model: " " })));
assert(!quality.isReviewReceipt(receipt("source", { contentHash: "claimed" })));
assert(!quality.isReviewReceipt(receipt("source", { status: "pass", findings: [blocking] })));
assert(quality.reviewGateIssues([{ ...receipts[0], authorReported: true }, ...receipts.slice(1)], current).length);
assert(quality.reviewGateIssues(receipts, { ...current, roles: ["assessment"] }).some(issue => /assessment/.test(issue)));
assert.deepEqual(quality.reviewGateIssues([receipt("assessment")], { ...current, roles: ["assessment"] }), []);
assert(quality.reviewGateIssues(receipts, { ...current, roles: [] }).length);
console.log("[PASS] current lesson/source hashes and separate specialist receipts are required for lesson and assessment gates");

const later = "2026-09-13T00:00:01.000Z";
assert(quality.reviewGateIssues([...receipts, receipt("source", { createdAt: later, status: "changes", findings: [blocking] })], current).some(issue => /blocking source/.test(issue)));
assert(quality.reviewGateIssues([...receipts, receipt("source", { createdAt: later, contentHash: "c".repeat(64) })], current).some(issue => /stale/.test(issue)));
assert(quality.reviewGateIssues([...receipts, receipt("source", { status: "changes", findings: [blocking] })], current).some(issue => /conflicting/.test(issue)));
assert.deepEqual(quality.reviewGateIssues([...receipts, structuredClone(receipts[0])], current), []);
assert.deepEqual(quality.reviewGateIssues([...receipts, receipt("source", { createdAt: later, findings: [advice] })], current), []);
console.log("[PASS] an earlier pass cannot mask newer blocking or stale evidence; advisory findings do not deadlock delivery");
