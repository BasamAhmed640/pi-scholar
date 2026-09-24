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
const { unfinishedExams } = await mod("commands.ts");

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
const figure = (id, page, caption, createdAt) => ({
  id: `snapshot-${id}`, page, caption, createdAt,
  crop: { x: 0, y: 0, width: 600, height: 300, canvasWidth: 1000, canvasHeight: 1400 },
  assetFile: `p${String(page).padStart(4, "0")}-snapshot-${id}.png`, sha256: id.repeat(4),
});
const olderFigure = figure("aaaaaaaaaaaaaaaa", 1, "Figure 1.1   Closed-loop diagram.", "2026-01-01T00:00:00.000Z");
const newerFigure = figure("bbbbbbbbbbbbbbbb", 1, "figure 1.1 Closed-loop diagram.", "2026-01-02T00:00:00.000Z");
const distinctFigure = figure("cccccccccccccccc", 1, "Figure 1.2 Separate diagram.", "2026-01-03T00:00:00.000Z");
const otherPageFigure = figure("dddddddddddddddd", 2, "Figure 1.1 Closed-loop diagram.", "2026-01-04T00:00:00.000Z");
const unlabelledA = figure("eeeeeeeeeeeeeeee", 1, "Uncaptioned source diagram", "2026-01-01T00:00:00.000Z");
const unlabelledB = figure("ffffffffffffffff", 1, "Uncaptioned source diagram", "2026-01-02T00:00:00.000Z");
const figureBook = structuredClone(book);
figureBook.source = { fileName: "source.pdf" };
figureBook.chapters[0].sections[0].snapshots = [newerFigure, distinctFigure, otherPageFigure, unlabelledA, unlabelledB];
const figureExam = { ...exam, snapshots: [olderFigure], questions: [{ ...questions[0], prompt: "Using Figure 1.1, which model applies?" }, questions[1]] };
const figurePaper = examAnswerNoteText(config, figureBook, figureExam);
const sourceFigures = figurePaper.slice(figurePaper.indexOf("## Source figures"), figurePaper.indexOf("> [!question] Question 1"));
const firstQuestion = figurePaper.slice(figurePaper.indexOf("> [!question] Question 1"), figurePaper.indexOf("> [!question] Question 2"));
check("paper keeps the latest capture of a repeated labelled figure in source figures and question references",
  !figurePaper.includes(olderFigure.assetFile)
    && sourceFigures.includes(newerFigure.assetFile) && firstQuestion.includes(newerFigure.assetFile)
    && figurePaper.split(newerFigure.assetFile).length - 1 === 2,
  "one selected image appears in both places");
check("paper preserves different source figures on the same page and matching captions on other pages",
  (sourceFigures.match(/> \[!scholar-figure\]/g) || []).length === 5
    && sourceFigures.includes(distinctFigure.assetFile) && sourceFigures.includes(otherPageFigure.assetFile)
    && firstQuestion.includes(otherPageFigure.assetFile) && !firstQuestion.includes(distinctFigure.assetFile)
    && sourceFigures.includes(unlabelledA.assetFile) && sourceFigures.includes(unlabelledB.assetFile),
  "distinct figures and ambiguous unlabelled captures remain available");
// One multiple-choice item (about 1 minute) and one written item (about 3 minutes).
check("form opens with a header callout stating questions, points and time, plus the scope",
  /^> \[!info\] 2 questions · 7 points · about 4 minutes$/m.test(form)
    && /^> 1 multiple choice · 1 written · blank answers score 0$/m.test(form) && form.includes("chapter 1")
    && form.indexOf("> [!info] 2 questions") < form.indexOf("> [!question] Question 1"),
  form.split("\n").find((line) => line.startsWith("> [!info]")));
check("form explains how to answer in three steps: tick, write, save and submit",
  /^> \*\*How to answer\*\*$/m.test(form)
    && /^> 1\. \*\*Choose\*\* — tick one box\.$/m.test(form)
    && /^> 2\. \*\*Write\*\* — answer in a line or two under \*\*Your response\*\*, in Live Preview\./m.test(form)
    && /^> 3\. \*\*Submit\*\* — save this note, then run the command at the end of the paper in Pi\.$/m.test(form),
  "checkbox, written-response and submission steps present");
check("each question shows its points and format",
  /> \[!question\] Question 1 · 2 points[\s\S]*?> \*Select one answer\.\*/.test(form)
    && /> \[!question\] Question 2 · 5 points[\s\S]*?> \*Written response · Answer briefly — one line or two sentences, not an extended derivation\.\*/.test(form)
    && !/Show your reasoning/.test(form), "labelled with the brief-answer contract, not the old extended-reasoning cue");
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
const submitTip = form.slice(form.indexOf("> [!tip] Submit when you're done"));
check("form ends with a submit tip carrying the exact command",
  form.includes("> [!tip] Submit when you're done")
    && form.indexOf("> [!tip] Submit when you're done") > form.lastIndexOf("<!-- /scholar:answer:")
    && submitTip.includes('> /scholar exam "exam-001" submit') && /Save this note/.test(submitTip)
    && submitTip.indexOf("<!-- scholar:exam-paper:complete -->") > 0,
  "save in Obsidian, then explicitly submit the exact exam in Pi");
check("a select-all paper tells the learner when to tick several boxes",
  /^> 1\. \*\*Choose\*\* — tick one box, or every box that applies when a question says \*select all that apply\*\.$/m.test(
    examAnswerNoteText(config, book, { ...exam, questions: [{ ...questions[0], correctAnswer: ["a", "b"] }, questions[1]] })),
  "select-all guidance appears only when the paper needs it");

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
const nextStep = activeNote.slice(activeNote.indexOf("> [!tip] Next step"), activeNote.indexOf("[[../"));
check("the unsubmitted note's next-step callout names the paper link and the submit command",
  activeNote.indexOf("> [!tip] Next step") > activeNote.indexOf("Not yet submitted")
    && /\[\[[^\]]*Answers\|your answer paper\]\]/.test(nextStep) && nextStep.includes('`/scholar exam "exam-001" submit`'),
  nextStep.split("\n").slice(0, 4).join(" / "));

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
const pie = '```mermaid\npie title Your results\n    "Partial" : 1\n    "Incorrect" : 1\n```';
check("the key charts its outcomes as a Mermaid pie right under the banner, omitting empty slices",
  key.includes(pie) && key.indexOf(pie) > key.indexOf("Answer key · 3/7") && key.indexOf(pie) < key.indexOf("## Where to look first")
    && !/"Correct" :|"Unanswered" :/.test(key),
  "partial and incorrect slices only");
check("an ungraded or empty result set draws no pie",
  !renderExamAnswerKey(config, book, { ...graded, status: "submitted", gradedAt: undefined }).includes("```mermaid")
    && !renderExamAnswerKey(config, bookGraded, { ...graded, itemResults: [] }).includes("```mermaid"),
  "the chart only summarizes saved grades");

// The invariant that matters most.
check("the key never contains the learner's raw response",
  !key.includes(PRIVATE_RESPONSE), "raw answer is not copied into generated output");
const gradedNote = renderExam(config, bookGraded, graded);
check("the graded exam note never contains the raw response",
  !gradedNote.includes(PRIVATE_RESPONSE), "raw answer is not copied into generated output");
check("the graded exam note links to the key instead of inlining it",
  /## Answer key/.test(gradedNote) && /Answer Key/.test(gradedNote) && !/First decisive error/.test(gradedNote),
  "key lives in its own node");
check("the graded note's next step states the score and links the answer key",
  /> \[!tip\] Next step\n>\n> Your score: \*\*3\/7 \(42\.9%\)\*\*\. Open \[\[[^\]]*Answer Key\|the answer key\]\]/.test(gradedNote)
    && !gradedNote.includes("/scholar exam"),
  "score first, then the key; no submit command once graded");

// ==================================================== 4. resuming an exam ===
const draft = { ...exam, id: "exam-002", title: "Exam 02 — chapter 1", status: "draft", questions: [], createdAt: "2026-03-01T00:00:00.000Z" };

check("graded exams are not offered for resume",
  unfinishedExams({ ...book, exams: [graded] }).length === 0, "nothing unfinished");
check("a submitted exam is still unfinished",
  unfinishedExams({ ...book, exams: [{ ...exam, status: "submitted" }] }).length === 1,
  "awaiting grading");
const many = { ...book, exams: [graded, exam, draft], currentExamId: "exam-001" };
const listed = unfinishedExams(many);
check("multiple unfinished exams are all listed", listed.length === 2, listed.map((item) => item.id).join(", "));
check("the most recently touched exam comes first",
  listed[0].id === "exam-002", listed.map((item) => item.id).join(", "));
// The bare-command resume itself — deterministic choice, no picker, no prompt —
// is gated by tests/verify-scholar-resume-determinism.mjs.

console.log(`\nScholar exam-experience summary: ${pass} passed, ${fail} failed.`);
process.exitCode = fail ? 1 : 0;
