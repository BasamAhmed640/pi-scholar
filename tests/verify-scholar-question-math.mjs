import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { extensionPath, piPackageRoot, jitiPath, resolvePiDependency } from "./sdk.mjs";

const { createJiti } = await import(pathToFileURL(jitiPath));
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: {
  "@earendil-works/pi-coding-agent": join(piPackageRoot, "dist/index.js"),
  "@earendil-works/pi-tui": resolvePiDependency("@earendil-works/pi-tui"), typebox: resolvePiDependency("typebox"),
} });
const load = name => jiti.import(join(dirname(extensionPath), name));
const { prepareScholarQuiz, registerScholarQuiz } = await load("quiz.ts");
const { prepareOpenQuestionText, prepareOpenAssessment, openQuestionFingerprint, OpenResponseGate } = await load("open-assessment.ts");
const { isFrozenScholarQuiz } = await load("quiz-contract.ts");
const { ScholarRuntimeSession } = await load("runtime-session.ts");
const { questionBlock, readQuestions } = await load("note-records.ts");

const params = { question: String.raw`For \(\mathbf D\), what changes when \(\rho_f=0\)?`,
  details: String.raw`Consider \[\nabla\cdot\mathbf D = \rho_f\] without assuming the field vanishes.`,
  options: [{ label: String.raw`\(\nabla\cdot\mathbf D=0\)`, description: String.raw`Here \(\rho_f\) denotes free-charge density.` },
    { label: String.raw`\(\mathbf D=0\)`, value: String.raw`literal-\(D\)`, misconception: "Confuses zero divergence with zero field" }],
  correctAnswer: String.raw`\(\nabla\cdot\mathbf D=0\)`,
  explanation: String.raw`Gauss’s law fixes \(\nabla\cdot\mathbf D\), not \(\mathbf D\) itself.`, shuffle: false };
const unchanged = structuredClone(params);
const frozen = prepareScholarQuiz(params);
assert.ok(isFrozenScholarQuiz(frozen));
assert.equal(frozen.question, String.raw`For $\mathbf D$, what changes when $\rho_f=0$?`);
assert.equal(frozen.options[0].label, String.raw`$\nabla\cdot\mathbf D=0$`);
assert.equal(frozen.options[0].value, params.options[0].label, "implicit machine value is the original raw label");
assert.equal(frozen.options[1].value, params.options[1].value, "explicit machine values never undergo math conversion");
assert.equal(frozen.correctValues[0], params.correctAnswer);
assert.ok(!/\\[()[\]]/.test([frozen.question, frozen.context, ...frozen.options.flatMap(option => [option.label, option.description || ""]), frozen.explanation].join("\n")));
assert.deepEqual(params, unchanged, "validation must not rewrite tool input");
assert.deepEqual(prepareScholarQuiz(params), frozen, "an identical non-shuffled retry has an identical frozen form");
const duplicate = structuredClone(params); duplicate.options[1].label = frozen.options[0].label;
assert.throws(() => prepareScholarQuiz(duplicate), /duplicate option label/, "cosmetically different delimiters cannot disguise duplicate choices");
console.log("[PASS] new quiz text normalizes before freezing and duplicate validation; stable answer values and original input remain intact");

const legacy = prepareScholarQuiz(params, [params.options[1].label, params.options[0].label]);
assert.equal(legacy.question, params.question);
assert.equal(legacy.explanation, params.explanation);
assert.deepEqual(legacy.options.map(option => option.label), [params.options[1].label, params.options[0].label]);
assert.equal(legacy.correctValues[0], params.correctAnswer);
let tool;
const beforeResume = JSON.stringify(legacy);
registerScholarQuiz({ registerTool(value) { tool = value; } }, async () => legacy);
for (const action of ["cancel", "answer"]) {
  const result = await tool.execute("resume", { resumeAttemptId: "saved" }, undefined, undefined, { hasUI: true, ui: { custom: async factory => new Promise(done => {
    const component = factory({ requestRender() {} }, { fg: (_name, text) => text, bold: text => text }, {}, done);
    assert.ok(component.render(120).join("\n").includes(params.question));
    component.handleInput(action === "cancel" ? "\x1b" : "\r");
  }) } });
  assert.equal(result.details.status, action === "cancel" ? "cancelled" : "answered");
  assert.equal(result.details.question, params.question);
  if (action === "answer") {
    assert.equal(result.details.correct, false, "the first saved option is still the incorrect option after resume");
    assert.deepEqual(result.details.correctIndices, [2]);
    assert.deepEqual(result.details.options.map(option => option.label), legacy.options.map(option => option.label));
  }
  assert.equal(JSON.stringify(legacy), beforeResume);
}
console.log("[PASS] a resumed legacy form retains exact wording, display order and grading key through cancel and answer");

for (const quiz of [frozen, legacy]) {
  const attempt = { id: "quiz", toolCallId: "quiz", kind: "conceptual", format: "multiple-choice", question: quiz.question,
    options: quiz.options.map(option => option.label), quiz, outcome: "pending", createdAt: "2026-09-13T00:00:00.000Z" };
  const document = `## Questions\n\n${questionBlock(attempt, 0)}\n<!-- scholar:generated:end -->`;
  const reloaded = readQuestions(document)[0];
  assert.deepEqual(reloaded, attempt, "normalized and historical math both retain frozen forms through the actual Markdown record codec");
  assert.throws(() => readQuestions(document.replace(quiz.question, `${quiz.question} A changed condition.`)), /saved quiz prompt or choices changed/);
}
console.log("[PASS] normalized and legacy quiz forms survive real note serialization, while altered questions invalidate the saved form hash");

const newPrompt = prepareOpenQuestionText(String.raw`Explain why \(\rho_f=0\) does not imply \(\mathbf D=0\).`);
const contract = prepareOpenAssessment(String.raw`Only \(\nabla\cdot\mathbf D=0\) follows.`, [String.raw`Distinguish \(\mathbf D\) from its divergence.`]);
assert.equal(newPrompt, String.raw`Explain why $\rho_f=0$ does not imply $\mathbf D=0$.`);
assert.equal(contract.expectedAnswer, String.raw`Only $\nabla\cdot\mathbf D=0$ follows.`);
assert.equal(contract.criteria[0], String.raw`Distinguish $\mathbf D$ from its divergence.`);
assert.throws(() => prepareOpenAssessment("A result", [String.raw`State \(D\).`, "State $D$."]), /distinct observable/);
const attempt = { id: "a1", toolCallId: "a1", kind: "conceptual", format: "open", question: newPrompt,
  openAssessment: contract, outcome: "pending", createdAt: "2026-09-13T00:00:00.000Z" };
const hash = openQuestionFingerprint(attempt);
assert.equal(openQuestionFingerprint(structuredClone(attempt)), hash);
const book = { id: "b", instanceId: "i", tutorSessions: [{ id: "t", status: "active", attempts: [attempt] }] };
const session = new ScholarRuntimeSession(); session.activate("b", "tutor", "t");
const gate = new OpenResponseGate(); const response = "Zero divergence does not mean a zero vector.";
gate.capture(book, session, response, "interactive"); gate.beginTurn(book, session, response);
const result = gate.evaluate(book, session, attempt, { criteria: [{ criterionIndex: 1, met: true, evidence: "Zero divergence does not mean a zero vector" }] });
assert.equal(result.outcome, "pass"); assert.equal(result.submission.questionHash, hash);
assert.equal(openQuestionFingerprint(attempt), hash);
const openDocument = `## Questions\n\n${questionBlock(attempt, 0)}\n<!-- scholar:generated:end -->`;
assert.deepEqual(readQuestions(openDocument)[0], attempt);
assert.equal(openQuestionFingerprint(readQuestions(openDocument)[0]), hash);
const legacyAttempt = { ...attempt, question: String.raw`Explain \(D\).`, openAssessment: { expectedAnswer: String.raw`A vector \(D\).`, criteria: [String.raw`Interpret \(D\).`] } };
const oldHash = openQuestionFingerprint(legacyAttempt);
openQuestionFingerprint(legacyAttempt);
assert.equal(openQuestionFingerprint(legacyAttempt), oldHash, "hashing a frozen legacy question never normalizes it");
console.log("[PASS] new open prompts and criteria normalize before fingerprints; response binding and frozen legacy hashes remain stable");
