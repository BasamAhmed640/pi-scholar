import {
  answerKeyNotePath,
  bookHomePath,
  chapterNotePath,
  examAnswerNotePath,
  examNotePath,
  sectionNotePath,
  tutorNotePath,
} from "../obsidian-paths.ts";
import { EXAM_PAPER_COMPLETE, examAnswerRegionLines, examFormFingerprint, examQuestionLines } from "../exam.ts";
import { callout } from "./callouts.ts";
export { examQuestionLines } from "../exam.ts";
import type {
  ScholarBook,
  ScholarConfig,
  ScholarExam,
  ScholarSnapshot,
  TutorSession,
} from "../types.ts";
import {
  block,
  collapsedRecord,
  tableText,
  frontmatter,
  generatedDocument,
  isSectionMaterialized,
  markdownText,
  referenceImageLines,
  unknownMarkdown,
  wikiLink,
  yaml,
} from "./common.ts";
import { assessmentQuestionBlock, referencedFigureLines, sourceFigureLines, supplementalSourceFigureLines, uniqueSupplementLines } from "./section.ts";
import { transcriptBlock } from "../note-records.ts";

export type ExamQuestion = ScholarExam["questions"][number];
export type ExamItemResult = ScholarExam["itemResults"][number];

/** Own figures come first; preserve historical section projection without duplicates. */
function recordSourceFigures(owned: ScholarSnapshot[] | undefined, legacy: ScholarSnapshot[]): ScholarSnapshot[] {
  const byId = new Map<string, ScholarSnapshot>();
  for (const snapshot of [...(owned || []), ...legacy]) if (!byId.has(snapshot.id)) byId.set(snapshot.id, snapshot);
  return [...byId.values()];
}

export function tutorSourceFigures(book: ScholarBook, session: TutorSession): ScholarSnapshot[] {
  return recordSourceFigures(session.snapshots, book.chapters.flatMap(chapter => chapter.sections.flatMap(section => {
    const selected = session.scope.sectionIds.length ? session.scope.sectionIds.includes(section.id)
      : session.scope.chapterIds.length ? session.scope.chapterIds.includes(chapter.id) : true;
    return selected ? section.snapshots || [] : [];
  })));
}

/** Keep weighted fractions readable without rounding tiny nonzero credit to zero. */
function breakdownPoints(points: number): string {
  return String(Number(points.toPrecision(6)));
}

export function calloutLines(prefix: string, value: string): string[] {
  const lines = markdownText(value).split("\n");
  return lines.map((line, index) => `> ${index === 0 ? prefix : ""}${line}`);
}

export function scopeLines(
  config: ScholarConfig,
  book: ScholarBook,
  notePath: string,
  scope: ScholarExam["scope"] | TutorSession["scope"],
  options?: { includeSections?: boolean },
): string[] {
  const lines: string[] = [];
  if (scope.description.trim()) lines.push(markdownText(scope.description));

  const chapters = scope.chapterIds.flatMap((chapterId) => {
    const chapter = book.chapters.find((candidate) => candidate.id === chapterId);
    if (!chapter) return [];
    const label = chapter.number ? `Chapter ${chapter.number}: ${chapter.title}` : chapter.title;
    return [wikiLink(notePath, chapterNotePath(config, book, chapter), label)];
  });
  const includeSections = options?.includeSections ?? true;
  const shouldRenderSections = includeSections || chapters.length === 0;
  const sections = shouldRenderSections
    ? scope.sectionIds.flatMap((sectionId) => {
        for (const chapter of book.chapters) {
          const section = chapter.sections.find((candidate) => candidate.id === sectionId);
          if (!section) continue;
          const label = section.number ? `${section.number} ${section.title}` : section.title;
          return [isSectionMaterialized(book, section)
            ? wikiLink(notePath, sectionNotePath(config, book, chapter, section), label)
            : markdownText(label)];
        }
        return [];
      })
    : [];

  if (chapters.length > 0) lines.push(`**Chapters:** ${chapters.join(", ")}`);
  if (sections.length > 0) lines.push(`**Sections:** ${sections.join(", ")}`);
  if (lines.length === 0) lines.push("Entire book");
  return lines;
}

/** The complete editable paper is learner-owned; generatedDocument must not wrap it. */
export function examAnswerNoteText(config: ScholarConfig, book: ScholarBook, exam: ScholarExam): string {
  const notePath = examAnswerNotePath(config, book, exam);
  const totalPoints = exam.questions.reduce((sum, question) => sum + question.maxPoints, 0);
  const openCount = exam.questions.filter((question) => question.format === "open").length;
  const snapshots = book.chapters.flatMap((chapter) => chapter.sections.flatMap((section) =>
    exam.scope.sectionIds.includes(section.id) ? section.snapshots || [] : []));
  return [
    frontmatter([
      "type: scholar-exam-paper", `book_id: ${yaml(book.id)}`, `book_instance_id: ${yaml(book.instanceId)}`,
      `exam_id: ${yaml(exam.id)}`, `form_fingerprint: ${yaml(examFormFingerprint(exam))}`,
      "answer_format: checkboxes-v1",
    ]), "",
    `# ${markdownText(exam.title)}`, "",
    wikiLink(notePath, bookHomePath(config, book), book.metadata.title), "",
    `**${exam.questions.length} questions · ${breakdownPoints(totalPoints)} points** · ${exam.questions.length - openCount} multiple choice · ${openCount} written response`, "",
    "> [!info] Before you begin",
    "> Click the checkboxes to select answers. Choose one unless a question says **select all that apply**.",
    "> Write open responses in **Live Preview**. Save, then submit in Pi when finished. Blank answers receive 0 points; grading and the answer key come after submission.", "",
    ...collapsedRecord("Exam scope", scopeLines(config, book, notePath, exam.scope)),
    ...block("## Source figures", sourceFigureLines(config, book, notePath, recordSourceFigures(exam.snapshots, snapshots))),
    ...block("## Visual references", referenceImageLines(config, book, notePath, exam.images)),
    ...exam.questions.flatMap((question, index) => [
      "", `> [!question] Question ${index + 1} · ${breakdownPoints(question.maxPoints)} ${question.maxPoints === 1 ? "point" : "points"}`,
      ">",
      ...markdownText(question.prompt).split("\n").map((line) => `> ${line}`), ">",
      ...referencedFigureLines(config, book, notePath, question.prompt, recordSourceFigures(exam.snapshots, snapshots)).split("\n").map(line => `> ${line}`), ">",
      `> *${question.format === "open" ? "Written response · Show your reasoning."
        : Array.isArray(question.correctAnswer) && question.correctAnswer.length > 1 ? "Select all that apply." : "Select one answer."}*`,
      ...examAnswerRegionLines(question).map(line => line ? `> ${line}` : ">"), "",
    ]), "", "---", "", "## Submit", "",
    "Save your changes in Obsidian, then run this exact command in Pi:", "",
    "```text", `/scholar exam ${JSON.stringify(exam.id)} submit`, "```", "",
    "Pi will confirm your answered/blank count. Submission is final; later edits do not change your score.", "",
    wikiLink(notePath, examNotePath(config, book, exam), "Exam status and results"), "",
    EXAM_PAPER_COMPLETE, "",
  ].join("\n");
}

export function displayedCorrectAnswer(question: ExamQuestion): string {
  const values = Array.isArray(question.correctAnswer) ? question.correctAnswer : question.correctAnswer === undefined ? [] : [question.correctAnswer];
  return values.map((value) => question.options?.find((option) => option.value === value)?.label ?? value).map(markdownText).filter(Boolean).join(", ");
}

export function gradedQuestionLines(question: ExamQuestion, result: ExamItemResult | undefined, index: number, figures = ""): string[] {
  const correctAnswer = displayedCorrectAnswer(question);
  const lines = [
    ...(result ? [`**Score:** ${breakdownPoints(result.earnedPoints)}/${breakdownPoints(result.maxPoints)} · ${markdownText(result.outcome)}`, ""] : []),
    ...(correctAnswer ? [`**Correct answer:** ${correctAnswer}`, ""] : []),
    ...(question.explanation ? [`**Explanation:** ${markdownText(question.explanation)}`, ""] : []),
    ...(question.claim.trim() ? [`**Claim:** ${markdownText(question.claim)}`] : []),
    ...(question.dimensions.length ? [`**Dimensions:** ${question.dimensions.map(markdownText).join(", ")}`] : []),
    ...(question.requiredEvidence.length ? ["", "**Required evidence:**", "", ...question.requiredEvidence.map((item) => `- ${markdownText(item)}`)] : []),
    ...(question.rubric?.length ? ["", "**Rubric:**", "", ...question.rubric.map((atom) => {
      const evidence = unknownMarkdown(atom.requiredEvidence);
      return `- ${markdownText(atom.criterion)} — ${breakdownPoints(atom.points)} point${atom.points === 1 ? "" : "s"}${evidence ? `; ${evidence}` : ""}`;
    })] : []),
  ];
  if (result?.diagnosticSummary) lines.push("", `**Diagnosis:** ${markdownText(result.diagnosticSummary)}`);
  if (result?.feedback) lines.push("", `**Feedback:** ${markdownText(result.feedback)}`);
  if (result?.firstDecisiveError) lines.push("", `**First decisive error:** ${markdownText(result.firstDecisiveError)}`);
  if (result?.correctReasoning) lines.push("", `**Correct reasoning:** ${markdownText(result.correctReasoning)}`);
  if (result?.transferableLesson) lines.push("", `**Transferable lesson:** ${markdownText(result.transferableLesson)}`);
  const title = result?.outcome === "correct" ? "Correct" : result?.outcome === "partial" ? "Partial credit" : result?.outcome === "unanswered" ? "Unanswered" : "Needs review";
  return [callout("question", `Question ${index + 1}`, [
    ...examQuestionLines(question, index).slice(1), "", figures, "",
    callout(result?.outcome === "correct" ? "success" : "warning", title, lines.join("\n")),
  ].join("\n"))];
}

function competencyTable(exam: ScholarExam): string[] {
  return exam.breakdown.length ? [
    "| Competency | Points | Score |", "| --- | --- | --- |",
    ...exam.breakdown.map((entry) => `| ${tableText(entry.label)} | ${breakdownPoints(entry.earnedPoints)}/${breakdownPoints(entry.maxPoints)} | ${breakdownPoints(entry.percent)}% |`),
  ] : [];
}

/** Corrections are assistant-authored; private learner responses never enter the key. */
export function renderExamAnswerKey(config: ScholarConfig, book: ScholarBook, exam: ScholarExam): string {
  const notePath = answerKeyNotePath(config, book, exam);
  const byId = new Map(exam.itemResults.map((result) => [result.questionId, result]));
  const count = (outcome: ExamItemResult["outcome"]) => exam.itemResults.filter((result) => result.outcome === outcome).length;
  const rank = (question: ExamQuestion): number => {
    switch (byId.get(question.id)?.outcome) {
      case "incorrect": return 0;
      case "unanswered": return 1;
      case "partial": return 2;
      default: return 3;
    }
  };
  const ordered = exam.questions.map((question, index) => ({ question, index })).sort((left, right) => rank(left.question) - rank(right.question) || left.index - right.index);
  const needsWork = ordered.filter(({ question }) => rank(question) < 3);
  return generatedDocument(frontmatter([
    "type: scholar-answer-key", `book_id: ${yaml(book.id)}`, `exam_id: ${yaml(exam.id)}`, `score: ${exam.percent}`,
    ...(exam.gradedAt ? [`graded: ${yaml(exam.gradedAt)}`] : []),
  ]), [
    `> [!success] Answer key · ${breakdownPoints(exam.earnedPoints)}/${breakdownPoints(exam.maxPoints)} · ${breakdownPoints(exam.percent)}%`,
    `> ${count("correct")} correct · ${count("partial")} partial · ${count("incorrect")} incorrect · ${count("unanswered")} unanswered`, "",
    `${wikiLink(notePath, examNotePath(config, book, exam), exam.title)} · ${wikiLink(notePath, examAnswerNotePath(config, book, exam), "Your answer paper")}`, "",
    ...block("## Where to look first", needsWork.map(({ question, index }) => {
      const result = byId.get(question.id);
      return `- **Question ${index + 1}** — ${markdownText(result?.outcome || "unscored")}${result?.firstDecisiveError ? `: ${markdownText(result.firstDecisiveError)}` : ""}`;
    })),
    ...block("## Competency profile", competencyTable(exam)),
    ...block("## Source figures", sourceFigureLines(config, book, notePath, exam.snapshots || [])),
    ...block("## Visual references", referenceImageLines(config, book, notePath, exam.images)),
    ...block("## Every question", ordered.flatMap(({ question, index }, position) => [
      ...(position ? [""] : []), ...gradedQuestionLines(question, byId.get(question.id), index, referencedFigureLines(config, book, notePath, question.prompt, exam.snapshots || [])),
    ])),
  ].join("\n"));
}

export function renderExam(config: ScholarConfig, book: ScholarBook, exam: ScholarExam): string {
  const notePath = examNotePath(config, book, exam);
  const graded = exam.status === "graded" || Boolean(exam.gradedAt);
  const submitted = exam.status === "submitted";
  const points = exam.questions.reduce((sum, question) => sum + question.maxPoints, 0);
  const submittedResponses = exam.questions.filter((question) => {
    const response = exam.rawResponses.find((item) => item.questionId === question.id)?.response;
    return Array.isArray(response) ? response.some((value) => value.trim()) : Boolean(response?.trim());
  }).length;
  return generatedDocument(frontmatter([
    "type: scholar-exam", `book_id: ${yaml(book.id)}`, `exam_id: ${yaml(exam.id)}`, `status: ${yaml(exam.status)}`,
    `created: ${yaml(exam.createdAt)}`, ...(exam.startedAt ? [`started: ${yaml(exam.startedAt)}`] : []),
    ...(exam.submittedAt ? [`submitted: ${yaml(exam.submittedAt)}`] : []),
    ...(exam.gradedAt ? [`graded: ${yaml(exam.gradedAt)}`] : []), `updated: ${yaml(exam.updatedAt)}`,
  ]), [
    graded
      ? `> [!success] Exam graded · ${breakdownPoints(exam.earnedPoints)}/${breakdownPoints(exam.maxPoints)} · ${breakdownPoints(exam.percent)}%`
      : `> [!info] ${submitted ? "Submitted · Awaiting grading" : exam.questions.length ? "Exam · Not yet submitted" : "Exam · Preparing questions"}`,
    `> ${exam.questions.length} ${exam.questions.length === 1 ? "question" : "questions"} · ${breakdownPoints(points)} ${points === 1 ? "point" : "points"}`,
    ...(submitted || graded ? [`> Submitted completeness: ${submittedResponses}/${exam.questions.length} answered · ${exam.questions.length - submittedResponses} blank`] : []),
    ...(!graded && !submitted && exam.questions.length ? [">", "> Answer and save the paper in Obsidian, then submit once in Pi."] : []),
    "", wikiLink(notePath, bookHomePath(config, book), book.metadata.title), "",
    ...block("## Scope", scopeLines(config, book, notePath, exam.scope, { includeSections: false })),
    ...block("## Source figures", sourceFigureLines(config, book, notePath, exam.snapshots || [])),
    ...(exam.questions.length ? block("## Answer paper", [
      wikiLink(notePath, examAnswerNotePath(config, book, exam), "Open your answer paper"), "",
      submitted || graded
        ? "Your submitted answers are saved. Later edits to the paper do not change this submission."
        : `Save in Obsidian, then run \`/scholar exam ${JSON.stringify(exam.id)} submit\` in Pi.`,
    ]) : []),
    ...(graded ? [
      ...block("## Competency profile", competencyTable(exam)),
      ...block("## Answer key", [`Review every question and its reasoning in ${wikiLink(notePath, answerKeyNotePath(config, book, exam), `${exam.title} — Answer Key`)}.`]),
    ] : []),
  ].join("\n"));
}

export function renderTutorSession(config: ScholarConfig, book: ScholarBook, session: TutorSession): string {
  const notePath = tutorNotePath(config, book, session);
  const images = referenceImageLines(config, book, notePath, session.images);
  const authored = transcriptBlock(session.transcript || [], session.attempts).trim();
  const lesson = authored ? authored.split("\n") : [];
  const summary = uniqueSupplementLines(session.synthesis ? [session.synthesis] : [], lesson);
  const keyPoints = uniqueSupplementLines(session.keyPoints, [...lesson, ...summary]);
  const snapshots = book.chapters.flatMap((chapter) => chapter.sections.flatMap((section) => {
    const selected = session.scope.sectionIds.length ? session.scope.sectionIds.includes(section.id)
      : session.scope.chapterIds.length ? session.scope.chapterIds.includes(chapter.id) : true;
    return selected ? section.snapshots || [] : [];
  }));
  const content = [
    ...(lesson.length ? block("## Lesson", lesson) : [session.synthesis?.trim()
      ? "A recap is saved below. The full explanation has not been saved yet."
      : "This session is ready. The lesson and practice will appear as you work.", ""]),
    ...supplementalSourceFigureLines(config, book, notePath, recordSourceFigures(session.snapshots, snapshots), authored),
    ...block("## Visual references", images),
    ...collapsedRecord("Recap", [
      ...block("### Session summary", summary),
      ...block("### Key points", keyPoints.map((point) => `- ${point}`)),
    ]),
    ...collapsedRecord("Practice scope", scopeLines(config, book, notePath, session.scope)),
    ...assessmentQuestionBlock(session.attempts),
  ];
  return generatedDocument(frontmatter([
    "type: scholar-tutor", `book_id: ${yaml(book.id)}`, `tutor_id: ${yaml(session.id)}`, `status: ${yaml(session.status)}`,
    `created: ${yaml(session.createdAt)}`, ...(session.closedAt ? [`closed: ${yaml(session.closedAt)}`] : []), `updated: ${yaml(session.updatedAt)}`,
  ]), [
    `*Tutor · ${session.status === "active" ? "In progress" : "Closed"} · Assisted practice*`,
    "", "Practice does not change Exam scores or Learn completion.",
    "", wikiLink(notePath, bookHomePath(config, book), book.metadata.title), "",
    ...(content.some((line) => line.trim()) ? content : ["This session is ready. The model and practice will appear as you work."]),
  ].join("\n"));
}
