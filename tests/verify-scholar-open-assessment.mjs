import { sdkAliases } from "./sdk.mjs";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { extensionPath, piPackageRoot, jitiPath, resolvePiDependency } from "./sdk.mjs";

const { createJiti } = await import(pathToFileURL(jitiPath));
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: { ...sdkAliases,
  "@earendil-works/pi-coding-agent": join(piPackageRoot, "dist/index.js"),
  "@earendil-works/pi-tui": resolvePiDependency("@earendil-works/pi-tui"), typebox: resolvePiDependency("typebox"),
} });
const root = dirname(extensionPath);
const { OpenResponseGate, prepareOpenAssessment, isOpenAssessmentContract, isOpenAssessmentSubmission,
  isOpenAssessmentEvaluation } = await jiti.import(join(root, "open-assessment.ts"));
const { handleAssess } = await jiti.import(join(root, "tool-actions/learning.ts"));
const { ScholarRuntimeSession } = await jiti.import(join(root, "runtime-session.ts"));
const { prepareScholarQuiz } = await jiti.import(join(root, "quiz.ts"));
const { createScholarToolController } = await jiti.import(join(root, "tool-controller.ts"));
const { isFrozenScholarQuiz } = await jiti.import(join(root, "quiz-contract.ts"));

const now = "2026-09-12T00:00:00.000Z";
const contract = prepareOpenAssessment("For fixed speed, twice the length requires twice the travel time.", ["State how delay changes when path length doubles."]);
const question = "At fixed speed, how does doubling path length change delay?";
const grounding = { purpose: "diagnostic", competency: "Relate path length to delay", requiredEvidence: ["Identify a proportional relation"], sourcePages: [1],
  basis: [{ kind: "prerequisite", value: "Travel time", supports: [1], prerequisiteBasis: "source-declared", sourcePage: 1 }] };
const seed = () => ({ id: "book", instanceId: "instance", outlineStatus: "ready", source: { fingerprint: { sha256: "source" } }, metadata: { pageCount: 3 }, chapters: [{ id: "c1", title: "Travel", sections: [{ id: "s1", startPage: 1, endPage: 3 }] }],
  tutorSessions: [{ id: "t1", status: "active", scope: { sectionIds: ["s1"] }, keyPoints: [], attempts: [], transcript: [], updatedAt: now }] });
const session = new ScholarRuntimeSession(); session.activate("book", "tutor", "t1");
let book = seed();
const target = () => book.tutorSessions[0];
const mutate = async (id, operation) => {
  assert.equal(id, book.id);
  const copy = structuredClone(book); const result = await operation(copy); book = copy; return { book, result };
};
const result = (action, summary, details) => ({ content: [{ type: "text", text: summary }], details: { action, summary, ...details } });
const gate = new OpenResponseGate();
const call = (id, params, bound = gate) => handleAssess(book, session, id, params, () => { throw new Error("Learn must not be called"); }, mutate, result, bound);
const prepare = () => call("prepare", { outcome: "pending", kind: "conceptual", question, grounding, ...contract });
const evaluate = (outcome = "pass", evaluation = { criteria: [{ criterionIndex: 1, met: true, evidence: "delay doubles" }] }) => call("grade", {
  attemptId: "assessment-prepare", outcome, evaluation, feedback: "With speed fixed, delay scales in direct proportion to length.",
});
const bind = (text = "The delay doubles.", source = "interactive") => { gate.capture(book, session, text, source); gate.beginTurn(book, session, text); };

await assert.rejects(call("invalid", { outcome: "pending", kind: "conceptual", question, grounding }), /expectedAnswer/);
assert.equal(target().attempts.length, 0);
await prepare();
assert.deepEqual(target().attempts[0].openAssessment, contract);
await assert.rejects(evaluate(), /no learner response/);
assert.equal(target().attempts[0].outcome, "pending");
for (const source of ["extension", "rpc", undefined]) {
  gate.capture(book, session, "The delay doubles.", source); gate.beginTurn(book, session, "The delay doubles.");
  await assert.rejects(evaluate(), /no learner response/);
}
bind("/scholar continue"); await assert.rejects(evaluate(), /no learner response/);
gate.capture(book, session, "The delay doubles.", "interactive");
gate.beginTurn(book, session, "Continue the lesson.");
await assert.rejects(evaluate(), /no learner response/);
bind();
await assert.rejects(evaluate("pass", { criteria: [{ criterionIndex: 1, met: true, evidence: "I computed a factor of two" }] }), /verbatim evidence/);
await assert.rejects(evaluate("pass", { criteria: [{ criterionIndex: 2, met: true, evidence: "delay doubles" }] }), /every frozen criterion/);
await assert.rejects(evaluate("pass", { criteria: [{ criterionIndex: 1, met: false }] }), /outcome=review/);
await evaluate();
assert.equal(target().attempts[0].outcome, "pass");
assert.ok(isOpenAssessmentSubmission(target().attempts[0].submission));
assert.ok(isOpenAssessmentEvaluation(target().attempts[0].evaluation));
assert.deepEqual(target().attempts[0].evaluation, { criteria: [{ criterionIndex: 1, met: true }] });
assert.ok(!JSON.stringify(book).includes("The delay doubles."), "raw learner response is not stored");
await assert.rejects(evaluate(), /No pending/);

for (const edit of ["question", "contract", "delete", "authority", "restart"]) {
  book = seed(); gate.clear(); await prepare(); bind();
  if (edit === "question") target().attempts[0].question += " Explain the next case.";
  if (edit === "contract") target().attempts[0].openAssessment.criteria[0] = "A different requirement";
  if (edit === "delete") target().attempts.splice(0);
  if (edit === "authority") book.instanceId = "replacement";
  if (edit === "restart") gate.clear();
  await assert.rejects(evaluate(), /no learner response|No pending/);
}

book = seed(); gate.clear(); await prepare();
delete target().attempts[0].openAssessment;
bind(); await assert.rejects(evaluate(), /no learner response/);
await call("upgrade", { attemptId: "assessment-prepare", outcome: "pending", ...contract });
assert.equal(target().attempts[0].question, question, "legacy upgrade must preserve unanswered prompt");
await assert.rejects(evaluate(), /no learner response/);
await assert.rejects(call("rewrite", { attemptId: "assessment-prepare", outcome: "pending", ...contract }), /cannot be replaced/);
bind("I don't know.");
await evaluate("unsure", { criteria: [{ criterionIndex: 1, met: false }] });
assert.equal(target().attempts[0].outcome, "unsure");
assert.equal(isOpenAssessmentContract({ ...contract, criteria: ["Same", "same"] }), false);

const cancel = () => call("cancel", { attemptId: "assessment-prepare", outcome: "cancelled" });
for (const legacy of [false, true]) {
  book = seed(); gate.clear(); await prepare();
  if (legacy) delete target().attempts[0].openAssessment;
  await assert.rejects(cancel(), /explicitly requests cancellation/);
  for (const text of ["Stop for today", "Do not cancel this question", "Continue", "/scholar close"]) {
    bind(text); await assert.rejects(cancel(), /explicitly requests cancellation/);
    assert.equal(target().attempts[0].outcome, "pending");
  }
  bind("Please cancel this question.");
  await cancel(); assert.equal(target().attempts[0].outcome, "cancelled");
  assert.equal(target().attempts[0].submission, undefined, "cancellation is not an answer");
}

// A slow note read must not bind an old input to a fresh activation or override
// a more recent input. These cases exercise the real tool controller's awaits.
for (const change of ["reopen", "reset", "new-input"]) {
  book = seed(); gate.clear(); await prepare();
  let unblock, first = true, definition;
  const waiting = new Promise((resolve) => { unblock = resolve; });
  const controller = createScholarToolController({
    pi: { registerTool: (tool) => { definition = tool; } }, session,
    getConfig: () => ({ libraryRoot: "fixture", obsidianRoot: "fixture", stateRoot: "fixture" }),
    loadBook: async () => { if (first) { first = false; await waiting; } return book; },
    mutateBook: mutate, isActiveAuthority: () => true, isSetupActive: () => false,
  });
  controller.ensureRegistered();
  const pendingInput = controller.captureOpenResponse("The delay doubles.", "interactive");
  if (change === "reopen") session.activate("book", "tutor", "t1");
  if (change === "reset") controller.resetTransientState();
  if (change === "new-input") await controller.captureOpenResponse("I don't know.", "interactive");
  unblock(); await pendingInput;
  controller.bindOpenResponseTurn(book, "The delay doubles.");
  const blocked = await definition.execute("late-input-grade", { action: "assess", attemptId: "assessment-prepare", outcome: "pass",
    feedback: "Late input cannot grade.", evaluation: { criteria: [{ criterionIndex: 1, met: true, evidence: "delay doubles" }] } }, undefined, undefined, { ui: { notify() {} } });
  assert.match(blocked.content[0].text, /no learner response/);
  assert.equal(target().attempts[0].outcome, "pending");
}

const photos = [{ data: Buffer.from("fixture handwritten equation").toString("base64"), mimeType: "image/png" }];
for (const text of ["", "My handwritten derivation is attached."]) {
  book = seed(); gate.clear(); await prepare();
  gate.capture(book, session, text, "interactive", photos); gate.beginTurn(book, session, text, photos);
  await assert.rejects(evaluate("pass", { criteria: [{ criterionIndex: 1, met: true, imageIndex: 2, evidence: "A second equation" }] }), /not attached/);
  await evaluate("pass", { criteria: [{ criterionIndex: 1, met: true, imageIndex: 1, evidence: "The handwritten ratio equates the new delay to twice the old delay." }] });
  assert.equal(target().attempts[0].outcome, "pass");
  assert.deepEqual(target().attempts[0].evaluation, { criteria: [{ criterionIndex: 1, met: true }] });
  assert.ok(!JSON.stringify(book).includes(photos[0].data));
}
book = seed(); gate.clear(); await prepare();
gate.capture(book, session, "", "interactive", photos);
gate.beginTurn(book, session, "", [{ ...photos[0], data: Buffer.from("replacement photo").toString("base64") }]);
await assert.rejects(evaluate(), /no learner response/);
gate.capture(book, session, "", "interactive", photos); gate.clear();
gate.beginTurn(book, session, "", photos);
await assert.rejects(evaluate(), /no learner response/);

const validQuiz = { question, options: [{ label: "Doubles", value: "double" },
  { label: "Stays fixed", value: "fixed", misconception: "Confuses constant speed with constant time" },
  { label: "Halves", value: "half", misconception: "Reverses proportionality" }], correctAnswer: "double", explanation: contract.expectedAnswer, shuffle: false };
assert.ok(isFrozenScholarQuiz(prepareScholarQuiz(validQuiz)));
const missing = structuredClone(validQuiz); delete missing.options[1].misconception;
assert.throws(() => prepareScholarQuiz(missing), /declare the specific misconception/);
const catchAll = structuredClone(validQuiz); catchAll.options[1].label = "All of the above";
assert.throws(() => prepareScholarQuiz(catchAll), /catch-all/);
const repeated = structuredClone(validQuiz); repeated.options[2].misconception = repeated.options[1].misconception;
assert.throws(() => prepareScholarQuiz(repeated), /distinct misconception/);
const two = structuredClone(validQuiz); two.options.pop(); assert.ok(prepareScholarQuiz(two));
const frozen = prepareScholarQuiz(validQuiz); frozen.options.forEach((option) => delete option.misconception);
assert.ok(isFrozenScholarQuiz(frozen), "legacy unanswered forms remain valid for exact resume");
console.log("Open grading: real-input binding, frozen criteria, edits/restarts, privacy and legacy resume passed. MCQ quality guards passed.");
