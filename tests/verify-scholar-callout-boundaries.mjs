import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { extensionPath, piPackageRoot, jitiPath } from "./sdk.mjs";

const { createJiti } = await import(pathToFileURL(jitiPath));
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: {
  "@earendil-works/pi-coding-agent": join(piPackageRoot, "dist/index.js"),
} });
const mod = file => jiti.import(join(dirname(extensionPath), file));
const { questionBlock, questionChunks, readQuestions, readDetails } = await mod("note-records.ts");
const { unframeQuestion } = await mod("render/callouts.ts");
const { parseExamResponses } = await mod("exam.ts");
const pending = { id: "q1", kind: "conceptual", format: "open", question: "Explain the concept.",
  outcome: "pending", createdAt: "2026-09-12T12:00:00.000Z" };
const document = attempts => `## Questions\n\n${attempts.map((attempt, i) => questionBlock(attempt, i)).join("\n")}\n<!-- scholar:generated:end -->`;
let checks = 0, failures = 0;
function check(name, run) {
  checks++;
  try { run(); console.log(`[PASS] ${name}`); }
  catch (error) { failures++; console.error(`[FAIL] ${name}\n${error.stack}`); }
}

check("authored feedback-looking callouts do not grade or truncate a pending question", () => {
  for (const [type, title] of [["success", "Correct"], ["warning", "Needs review"], ["warning", "Knowledge gap"]]) {
    const attempt = { ...pending, question: `Explain this example:\n\n> [!${type}] ${title}\n> An illustrative callout, not a saved assessment.\n\nExplain your reasoning.` };
    assert.deepEqual(readQuestions(document([attempt])), [attempt], title);
  }
});

check("quoted code fences cannot split questions and end before the next real question", () => {
  for (const fence of ["```", "~~~"]) {
    const attempt = { ...pending, question: `Read this code:\n\n${fence}text\n[!question] Question 99\n### Question 98\n## Questions\n${fence}\n\nExplain what it prints.` };
    const next = { ...pending, id: "q2", question: "Now explain the next concept." };
    const text = document([attempt, next]);
    assert.equal(questionChunks(text).length, 2, fence);
    assert.deepEqual(readQuestions(text), [attempt, next], fence);
  }
});

check("quiz context is normalized visibly, stored once, and cannot be silently deleted or replaced", () => {
  for (const context of [" A uniform path. ", "A uniform path.\r\nAt fixed speed."]) {
    const normalized = context.replace(/\r\n?/g, "\n").trim();
    const quiz = { question: "Which factor matters?", context, mode: "single-select",
      options: [{ value: "a", label: "Length" }, { value: "b", label: "Colour" }],
      correctValues: ["a"], explanation: "Length affects delay at fixed speed." };
    const attempt = { ...pending, format: "multiple-choice", question: quiz.question,
      options: quiz.options.map(option => option.label), mode: quiz.mode, quiz };
    const text = document([attempt]);
    assert.deepEqual(readQuestions(text), [{ ...attempt, quiz: { ...quiz, context: normalized } }]);
    const metadata = readDetails(unframeQuestion(questionChunks(text)[0]), "question");
    assert.equal(Object.hasOwn(metadata.quiz, "context"), false, "context must not have a second copy in metadata");
    const start = text.indexOf("> #### Context"), end = text.indexOf("> #### Choices", start);
    assert.ok(start >= 0 && end > start, "fixture must contain a visible context field");
    assert.throws(() => readQuestions(text.slice(0, start) + text.slice(end)), /context changed/i);
    assert.throws(() => readQuestions(text.replace("A uniform path.", "A different medium.")), /context changed/i);
  }
});

check("unsupported exam quote prefixes cannot turn blank responses into answered questions", () => {
  const exam = { questions: [{ id: "q1", format: "open" }] };
  const paper = (prefix, answer = "") => `${prefix}<!-- scholar:answer:q1:start -->\n${prefix}${answer}\n${prefix}<!-- /scholar:answer:q1:end -->`;
  for (const prefix of ["", "> "]) {
    assert.deepEqual(parseExamResponses(exam, paper(prefix)), [{ questionId: "q1", response: "" }]);
    assert.deepEqual(parseExamResponses(exam, paper(prefix, "Delay increases.")), [{ questionId: "q1", response: "Delay increases." }]);
  }
  for (const prefix of [">  ", "> > "]) assert.throws(() => parseExamResponses(exam, paper(prefix)), /callout|frame|boundary/i);
});

console.log(`${checks - failures}/${checks} callout boundary checks passed.`);
process.exitCode = failures ? 1 : 0;
