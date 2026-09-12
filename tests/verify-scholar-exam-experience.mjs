import { extensionPath as packagedExtensionPath, piPackageRoot as sdkRoot, jitiPath as sdkJitiPath, resolvePiDependency } from "./sdk.mjs";
// Scholar exam-experience gate.
//
// Covers the parts of an exam a learner actually touches: the form they answer,
// the answer key they return to, and picking up an exam they did not finish.
// The answer paper is learner-owned Markdown; generated receipts and answer
// keys continue to exclude raw responses and generation transcripts.
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

const piPackageRoot = sdkRoot;
const jitiPath = sdkJitiPath;
const { createJiti } = await import(pathToFileURL(jitiPath).href);
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: { "@earendil-works/pi-coding-agent": join(piPackageRoot, "dist", "index.js") },
});

const EXT = dirname(process.env.PI_SCHOLAR_EXTENSION || packagedExtensionPath);
const mod = (rel) => jiti.import(join(EXT, rel));
const { parseExamResponses } = await mod("exam.ts");
const { examAnswerNoteText, renderExam, renderExamAnswerKey } = await mod("render/assessment.ts");
const { answerKeyNotePath, examNotePath, examAnswerNotePath } = await mod("obsidian-paths.ts");
const { chooseUnfinishedExam, unfinishedExams } = await mod("commands.ts");

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? ` - ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

// ---------------------------------------------------------------- fixtures --
const config = { schemaVersion: 3, libraryRoot: "", obsidianRoot: join(homedir(), "vault-probe"), stateRoot: "", updatedAt: "2026-01-01T00:00:00.000Z" };
const section = {
  id: "chapter-001-section-001", order: 1, number: "1.1", title: "What Is SI",
  startPage: 1, endPage: 9, status: "not-started",
  objectives: [], coveredObjectives: [], requiredChecks: ["conceptual"], keyPoints: [], misconceptions: [],
  attempts: [], transcript: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};
const book = {
  id: "c".repeat(64), instanceId: "exam-experience-fixture", metadata: { title: "Signal and Power Integrity", authors: ["Bogatin"] },
  noteDirectory: "Signal and Power Integrity",
  chapters: [{ id: "chapter-001", number: "1", title: "Signal Integrity", order: 1, startPage: 1, endPage: 9, status: "not-started", sections: [section] }],
  exams: [], tutorSessions: [],
};
const questions = [
  {
    id: "q1", sectionIds: [section.id], claim: "Selects the right model.",
    requiredEvidence: ["names the governing model"], dimensions: ["model selection"],
    format: "multiple-choice", prompt: "Which model applies to a 50 ps edge on a 6 inch trace?",
    options: [
      { value: "a", label: "Lumped", misconception: "ignores propagation delay" },
      { value: "b", label: "Transmission line" },
      { value: "c", label: "Distributed RC", misconception: "treats a low-loss line as diffusive" },
    ],
    correctAnswer: "b", explanation: "The edge is short compared with the flight time.", maxPoints: 2,
  },
  {
    id: "q2", sectionIds: [section.id], claim: "Derives characteristic impedance.",
    requiredEvidence: ["states assumptions", "computes the value"], dimensions: ["reasoning", "execution"],
    format: "open", prompt: "Derive the characteristic impedance and state your assumptions.",
    rubric: [
      { id: "r1", criterion: "States the lossless assumption", requiredEvidence: ["assumption stated"], points: 2 },
      { id: "r2", criterion: "Computes Z0 correctly", requiredEvidence: ["value correct"], points: 3 },
    ],
    explanation: "Z0 = sqrt(L/C) for a lossless line.", maxPoints: 5,
  },
];
const PRIVATE_RESPONSE = "i think its lumped because the trace looks short to me";
const exam = {
  id: "exam-001", title: "Exam 01 — chapter 1",
  scope: { chapterIds: ["chapter-001"], sectionIds: [section.id], description: "chapter 1" },
  status: "active", questions, rawResponses: [], itemResults: [], breakdown: [],
  earnedPoints: 0, maxPoints: 7, percent: 0, transcript: [],
  createdAt: "2026-02-01T00:00:00.000Z", updatedAt: "2026-02-01T00:00:00.000Z", startedAt: "2026-02-01T00:00:00.000Z",
};
book.exams = [exam];

// =============================================== 1. the form to answer in ==
const form = examAnswerNoteText(config, book, exam);
check("form states the scope and totals", /\*\*2 questions · 7 points\*\* · 1 multiple choice · 1 written response/.test(form) && form.includes("chapter 1"),
  form.split("\n").find((line) => line.startsWith("**2 questions")));
check("form explains how to answer", /Click the checkboxes/.test(form) && /Choose one unless/.test(form)
  && /Write open responses in \*\*Live Preview\*\*/.test(form), "checkbox and written-response instructions present");
check("each question shows its points and format",
  /> \[!question\] Question 1 · 2 points[\s\S]*?> \*Select one answer\.\*/.test(form)
    && /> \[!question\] Question 2 · 5 points[\s\S]*?> \*Written response · Show your reasoning\.\*/.test(form), "labelled");
check("multiple-choice options are native unchecked tasks with frozen indices",
  /^> - \[ \] \*\*b\*\* — Transmission line <!-- scholar:choice:1 -->$/m.test(form)
    && (form.match(/^> - \[ \] .*<!-- scholar:choice:\d+ -->$/gm) || []).length === 3
    && /^answer_format: checkboxes-v1$/m.test(form), "three selectable options rendered");
check("the editable paper reveals no pregrading key, rubric or distractor explanation",
  questions.every((question) => !form.includes(question.explanation))
    && questions.flatMap((question) => question.options || []).every((option) => !option.misconception || !form.includes(option.misconception))
    && questions.flatMap((question) => question.rubric || []).every((criterion) => !form.includes(criterion.criterion))
    && !/^- \[[xX]\]|Correct answer|RUBRIC:/m.test(form), "choices start unselected and private grading content is absent");

const openBlock = /<!-- scholar:answer:q2:start -->([\s\S]*?)<!-- \/scholar:answer:q2:end -->/.exec(form)?.[1] || "";
check("open questions get real blank space to write in",
  openBlock.split("\n").length >= 8 && openBlock.replace(/^> ?/gm, "").trim() === "",
  `${openBlock.split("\n").length - 2} blank line(s), no placeholder text to delete`);
check("form ends with a submit block",
  /## Submit/.test(form) && form.includes('/scholar exam "exam-001" submit') && /save/i.test(form),
  "save in Obsidian, then explicitly submit the exact exam in Pi");

const parsedBlank = parseExamResponses(exam, form);
check("an untouched form parses as entirely unanswered",
  parsedBlank.length === 2 && parsedBlank.every((item) => item.response === ""), "no placeholder leaks into a response");

const answered = form
  .replace("- [ ] **b** — Transmission line <!-- scholar:choice:1 -->", "- [x] **b** — Transmission line <!-- scholar:choice:1 -->")
  .replace(/(<!-- scholar:answer:q2:start -->\n)[\s\S]*?(<!-- \/scholar:answer:q2:end -->)/, (_, start, end) => `${start}> ${PRIVATE_RESPONSE}\n> ${end}`);
const parsedAnswered = parseExamResponses(exam, answered);
check("checked MCQ and written answers round-trip through the markers",
  parsedAnswered[0].response === "b" && parsedAnswered[1].response === PRIVATE_RESPONSE,
  "both captured");

// ================================================ 2. the ungraded exam note ==
const activeNote = renderExam(config, book, exam);
check("an unsubmitted exam note carries submit guidance",
  /Not yet submitted/.test(activeNote)
    && activeNote.includes('/scholar exam "exam-001" submit')
    && /Answer paper/i.test(activeNote)
    && !/## Questions|## Exam transcript/.test(activeNote),
  "compact receipt links to the editable paper and exact submission command");
check("paper is separate from the generated receipt",
  examAnswerNotePath(config, book, exam) !== examNotePath(config, book, exam)
    && questions.every((question) => form.includes(question.prompt) && !activeNote.includes(question.prompt)),
  "one editable copy of every question");
check("an unsubmitted exam note reveals no answer key",
  !/Correct answer/.test(activeNote) && !/Rubric/.test(activeNote), "nothing leaked before submission");

// ==================================================== 3. the graded key note ==
const graded = {
  ...exam,
  status: "graded", gradedAt: "2026-02-02T00:00:00.000Z", submittedAt: "2026-02-01T12:00:00.000Z",
  rawResponses: [{ questionId: "q1", response: "a" }, { questionId: "q2", response: PRIVATE_RESPONSE }],
  earnedPoints: 3, percent: 42.9,
  itemResults: [
    {
      questionId: "q1", outcome: "incorrect", earnedPoints: 0, maxPoints: 2,
      feedback: "The lumped model was selected although the edge is far shorter than the flight time.",
      firstDecisiveError: "Compared trace length to physical size rather than to the signal's spatial extent.",
      correctReasoning: "A 50 ps edge spans about 0.3 inch, so a 6 inch trace is electrically long.",
      transferableLesson: "Compare the edge's spatial extent to the interconnect, never the ruler length alone.",
    },
    {
      questionId: "q2", outcome: "partial", earnedPoints: 3, maxPoints: 5,
      feedback: "The impedance was computed correctly but the lossless assumption was never stated.",
      firstDecisiveError: "Omitted the assumption that R and G are negligible.",
      correctReasoning: "Z0 = sqrt(L/C) holds only when the line is lossless at the frequency of interest.",
      transferableLesson: "State the validity condition whenever a simplified form is used.",
    },
  ],
  breakdown: [{ key: "section:chapter-001-section-001", label: "1.1 What Is SI", earnedPoints: 3, maxPoints: 7, percent: 42.9 }],
};
const bookGraded = { ...book, exams: [graded] };
const key = renderExamAnswerKey(config, bookGraded, graded);

check("the key is its own note beside the exam",
  answerKeyNotePath(config, bookGraded, graded) !== examNotePath(config, bookGraded, graded)
    && /Answer Key/.test(answerKeyNotePath(config, bookGraded, graded)),
  "distinct path");
check("the key links back to the exam", key.includes(graded.title), "wikilink present");
check("the key headlines the score", /Answer key · 3\/7 · 42\.9%/.test(key), "score line");
check("the key counts outcomes", /1 correct · 1 partial · 1 incorrect · 0 unanswered/.test(key) || /0 correct · 1 partial · 1 incorrect · 0 unanswered/.test(key), "tally line");
check("the key points at what to review first",
  /## Where to look first/.test(key) && key.indexOf("Question 1") < key.indexOf("Question 2"),
  "incorrect item listed before partial");
check("the key carries the correct answer and why it holds",
  /\*\*Correct answer:\*\* Transmission line/.test(key) && /edge is short compared with the flight time/.test(key),
  "gold reasoning present");
check("the key explains the learner's specific error",
  /Compared trace length to physical size/.test(key) && /First decisive error/.test(key), "diagnosis present");
check("the key gives a transferable lesson",
  /spatial extent to the interconnect/.test(key), "lesson present");
check("the key reports the competency profile",
  /## Competency profile/.test(key) && /1\.1 What Is SI/.test(key), "breakdown present");

// The invariant that matters most.
check("the key never contains the learner's raw response",
  !key.includes(PRIVATE_RESPONSE), "raw answer is not copied into generated output");
const gradedNote = renderExam(config, bookGraded, graded);
check("the graded exam note never contains the raw response",
  !gradedNote.includes(PRIVATE_RESPONSE), "raw answer is not copied into generated output");
check("the graded exam note links to the key instead of inlining it",
  /## Answer key/.test(gradedNote) && /Answer Key/.test(gradedNote) && !/First decisive error/.test(gradedNote),
  "key lives in its own node");

// ==================================================== 4. resuming an exam ===
const draft = { ...exam, id: "exam-002", title: "Exam 02 — chapter 1", status: "draft", questions: [], createdAt: "2026-03-01T00:00:00.000Z" };
const silentCtx = () => ({ ui: { notify: () => {} } });
const pickingCtx = (answer) => ({ ui: { notify: () => {}, select: async () => answer } });

check("graded exams are not offered for resume",
  unfinishedExams({ ...book, exams: [graded] }).length === 0, "nothing unfinished");
// A lone unfinished exam is still offered. Resuming it silently looked exactly
// like starting a fresh one at the prompt, and it left no way to open a new exam
// from a bare command while the first was still unfinished.
const solo = { ...book, exams: [graded, exam] };
const soloOptions = [];
const soloCtx = { ui: { notify: () => {}, select: async (_title, options) => { soloOptions.push(...options); return options[0]; } } };
check("a single unfinished exam is still shown in the picker",
  (await chooseUnfinishedExam(solo, soloCtx)).exam?.id === "exam-001",
  soloOptions.join(" | "));
check("the single-exam picker still offers a new exam",
  soloOptions.length === 2 && soloOptions[1] === "Start a new exam instead…",
  String(soloOptions[1]));
check("a new exam is reachable while exactly one is unfinished",
  (await chooseUnfinishedExam(solo, pickingCtx("Start a new exam instead…"))).kind === "none",
  "declining opens scope selection");
check("without a picker a single unfinished exam still resumes",
  (await chooseUnfinishedExam(solo, silentCtx())).exam?.id === "exam-001",
  "fallback resumes directly");

const many = { ...book, exams: [graded, exam, draft], currentExamId: "exam-001" };
const listed = unfinishedExams(many);
check("multiple unfinished exams are all offered", listed.length === 2, listed.map((item) => item.id).join(", "));
check("the picker resumes the chosen exam",
  (await chooseUnfinishedExam(many, pickingCtx("Exam 01 — chapter 1 — 2 question(s) · not yet submitted"))).exam?.id === "exam-001",
  "selection honoured");
check("the picker can decline and start a new exam",
  (await chooseUnfinishedExam(many, pickingCtx("Start a new exam instead…"))).kind === "none",
  "falls through to scope selection");
check("cancelling the picker creates nothing",
  (await chooseUnfinishedExam(many, pickingCtx(undefined))).kind === "cancelled",
  "no exam created");
check("without a picker the current exam wins",
  (await chooseUnfinishedExam(many, silentCtx())).exam?.id === "exam-001", "currentExamId preferred");

console.log(`\nScholar exam-experience summary: ${pass} passed, ${fail} failed.`);
process.exitCode = fail ? 1 : 0;
