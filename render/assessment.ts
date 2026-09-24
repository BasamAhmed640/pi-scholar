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
import { computeFindingKey } from "../learn-quality.ts";
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
  statusCallout,
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

/** Later recaptures of one labelled source figure replace older paper embeds. */
function examPaperSourceFigures(owned: ScholarSnapshot[] | undefined, legacy: ScholarSnapshot[]): ScholarSnapshot[] {
  const figures = recordSourceFigures(owned, legacy);
  const bySource = new Map<string, ScholarSnapshot>();
  for (const snapshot of figures) {
    // Unlabelled captions can describe separate figures on the same page.
    const labelled = /\b(?:figure|fig\.|table)\s+\d+(?:[.\-–]\d+)*[a-z]?\b/i.test(snapshot.caption);
    const caption = snapshot.caption.replace(/\s+/g, " ").trim().toLowerCase();
    const key = labelled ? `${snapshot.page}\u0000${caption}` : snapshot.id;
    const previous = bySource.get(key);
    const area = snapshot.crop.width * snapshot.crop.height;
    const previousArea = previous ? previous.crop.width * previous.crop.height : 0;
    if (!previous || snapshot.createdAt > previous.createdAt
      || (snapshot.createdAt === previous.createdAt && area > previousArea)) bySource.set(key, snapshot);
  }
  return [...bySource.values()];
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

function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function pointsLabel(points: number): string {
  return `${breakdownPoints(points)} ${points === 1 ? "point" : "points"}`;
}

function isSelectAll(question: ExamQuestion): boolean {
  return Array.isArray(question.correctAnswer) && question.correctAnswer.length > 1;
}

/** A planning estimate for the paper's header: about a minute per choice, three per short written answer. */
export function examMinutes(questions: ExamQuestion[]): number {
  return Math.max(1, questions.reduce((sum, question) => sum + (question.format === "open" ? 3 : 1), 0));
}

/** Every line of a callout body carries the single-level frame the answer parser expects. */
function framed(lines: string[]): string[] {
  return lines.map((line) => line ? `> ${line}` : ">");
}

/** Adjacent blocks each bring a spacer; keep one, since Live Preview shows every blank line. */
function singleSpaced(lines: string[]): string[] {
  return lines.filter((line, index) => line !== "" || lines[index - 1] !== "");
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

/**
 * The complete editable paper is learner-owned; generatedDocument must not wrap it.
 * Layout is presentation only: the identity header, `checkboxes-v1` rows, answer
 * markers, single-level `> ` frames and the completion marker are the submission
 * contract, and papers already in a vault are never rewritten to match this layout.
 */
export function examAnswerNoteText(config: ScholarConfig, book: ScholarBook, exam: ScholarExam): string {
  const notePath = examAnswerNotePath(config, book, exam);
  const totalPoints = exam.questions.reduce((sum, question) => sum + question.maxPoints, 0);
  const openCount = exam.questions.filter((question) => question.format === "open").length;
  const choiceCount = exam.questions.length - openCount;
  const snapshots = book.chapters.flatMap((chapter) => chapter.sections.flatMap((section) =>
    exam.scope.sectionIds.includes(section.id) ? section.snapshots || [] : []));
  const figures = examPaperSourceFigures(exam.snapshots, snapshots);
  const steps = [
    ...(choiceCount ? [`**Choose** — tick one box${exam.questions.some(isSelectAll) ? ", or every box that applies when a question says *select all that apply*" : ""}.`] : []),
    ...(openCount ? ["**Write** — answer in a line or two under **Your response**, in Live Preview. Leave the hidden answer markers in place."] : []),
    "**Submit** — save this note, then run the command at the end of the paper in Pi.",
  ];
  return singleSpaced([
    frontmatter([
      "type: scholar-exam-paper", `book_id: ${yaml(book.id)}`, `book_instance_id: ${yaml(book.instanceId)}`,
      `exam_id: ${yaml(exam.id)}`, `form_fingerprint: ${yaml(examFormFingerprint(exam))}`,
      "answer_format: checkboxes-v1",
    ]), "",
    `# ${markdownText(exam.title)}`, "",
    wikiLink(notePath, bookHomePath(config, book), book.metadata.title), "",
    `> [!info] ${counted(exam.questions.length, "question")} · ${pointsLabel(totalPoints)} · about ${counted(examMinutes(exam.questions), "minute")}`,
    `> ${[choiceCount ? `${choiceCount} multiple choice` : "", openCount ? `${openCount} written` : ""].filter(Boolean).join(" · ")} · blank answers score 0`,
    ">", "> **How to answer**", ">",
    ...steps.map((step, index) => `> ${index + 1}. ${step}`), "",
    ...collapsedRecord("Exam scope", scopeLines(config, book, notePath, exam.scope)),
    ...block("## Source figures", sourceFigureLines(config, book, notePath, figures)),
    ...block("## Visual references", referenceImageLines(config, book, notePath, exam.images)),
    ...exam.questions.flatMap((question, index) => {
      const questionFigures = referencedFigureLines(config, book, notePath, question.prompt, figures);
      return [
        "", `> [!question] Question ${index + 1} · ${pointsLabel(question.maxPoints)}`, ">",
        ...framed(markdownText(question.prompt).split("\n")),
        ...(questionFigures.trim() ? [">", ...framed(questionFigures.split("\n"))] : []), ">",
        `> *${question.format === "open" ? "Written response · Answer briefly — one line or two sentences, not an extended derivation."
          : isSelectAll(question) ? "Select all that apply." : "Select one answer."}*`,
        ...framed(examAnswerRegionLines(question)), "",
      ];
    }), "",
    "> [!tip] Submit when you're done",
    "> Save this note, then run this exact command in Pi:", ">",
    "> ```text", `> /scholar exam ${JSON.stringify(exam.id)} submit`, "> ```", ">",
    "> Pi shows how many questions you answered and asks you to confirm. Submission is final; later edits do not change your score.", ">",
    `> ${wikiLink(notePath, examNotePath(config, book, exam), "Exam status and results")}`, "",
    EXAM_PAPER_COMPLETE, "",
  ]).join("\n");
}

export function displayedCorrectAnswer(question: ExamQuestion): string {
  const values = Array.isArray(question.correctAnswer) ? question.correctAnswer : question.correctAnswer === undefined ? [] : [question.correctAnswer];
  return values.map((value) => question.options?.find((option) => option.value === value)?.label ?? value).map(markdownText).filter(Boolean).join(", ");
}

const flattened = (text: string) => text.replace(/\s+/g, " ").trim();

export function gradedQuestionLines(question: ExamQuestion, result: ExamItemResult | undefined, index: number, figures = ""): string[] {
  const correctAnswer = displayedCorrectAnswer(question);
  // Scholar's own multiple-choice feedback already ends with the frozen explanation.
  const explanation = question.explanation?.trim() && !(result?.feedback && flattened(result.feedback).includes(flattened(question.explanation)))
    ? question.explanation : "";
  // What the learner reads first: score, key, why, and the diagnosis. The grading
  // contract (claim, dimensions, evidence, rubric) closes the item.
  const lines = [
    ...(result ? [`**Score:** <span class="scholar-score">${breakdownPoints(result.earnedPoints)}/${breakdownPoints(result.maxPoints)}</span> · ${markdownText(result.outcome)}`, ""] : []),
    ...(correctAnswer ? [`**Correct answer:** ${correctAnswer}`, ""] : []),
    ...(explanation ? [`**Explanation:** ${markdownText(explanation)}`, ""] : []),
  ];
  if (result?.diagnosticSummary) lines.push(`**Diagnosis:** ${markdownText(result.diagnosticSummary)}`, "");
  if (result?.feedback) lines.push(`**Feedback:** ${markdownText(result.feedback)}`, "");
  if (result?.firstDecisiveError) lines.push(`**First decisive error:** ${markdownText(result.firstDecisiveError)}`, "");
  if (result?.correctReasoning) lines.push(`**Correct reasoning:** ${markdownText(result.correctReasoning)}`, "");
  if (result?.transferableLesson) lines.push(`**Transferable lesson:** ${markdownText(result.transferableLesson)}`, "");
  lines.push(
    ...(question.claim.trim() ? [`**Claim:** ${markdownText(question.claim)}`] : []),
    ...(question.dimensions.length ? [`**Dimensions:** ${question.dimensions.map(markdownText).join(", ")}`] : []),
    ...(question.requiredEvidence.length ? ["", "**Required evidence:**", "", ...question.requiredEvidence.map((item) => `- ${markdownText(item)}`)] : []),
    ...(question.rubric?.length ? ["", "**Rubric:**", "", ...question.rubric.map((atom) => {
      const evidence = unknownMarkdown(atom.requiredEvidence);
      return `- ${markdownText(atom.criterion)} — ${breakdownPoints(atom.points)} point${atom.points === 1 ? "" : "s"}${evidence ? `; ${evidence}` : ""}`;
    })] : []),
  );
  while (lines.at(-1) === "") lines.pop();
  const title = result?.outcome === "correct" ? "Correct" : result?.outcome === "partial" ? "Partial credit" : result?.outcome === "unanswered" ? "Unanswered" : "Needs review";
  // Drop the heading and its spacer: the callout title already names the question.
  return [callout("question", `Question ${index + 1}`, [
    ...examQuestionLines(question, index).slice(2), ...(figures.trim() ? ["", figures] : []), "",
    callout(result?.outcome === "correct" ? "success" : "warning", title, lines.join("\n")).trimEnd(),
  ].join("\n"))];
}

/** Outcome counts as a Mermaid pie; built from saved results only, empty slices omitted. */
export function outcomePieLines(exam: ScholarExam): string[] {
  if (!(exam.status === "graded" || exam.gradedAt)) return [];
  const slices = ([["Correct", "correct"], ["Partial", "partial"], ["Incorrect", "incorrect"], ["Unanswered", "unanswered"]] as const)
    .map(([label, outcome]) => [label, exam.itemResults.filter((result) => result.outcome === outcome).length] as const)
    .filter(([, count]) => count > 0);
  return slices.length ? ["```mermaid", "pie title Your results", ...slices.map(([label, count]) => `    "${label}" : ${count}`), "```"] : [];
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
  const pie = outcomePieLines(exam);
  return generatedDocument(frontmatter([
    "type: scholar-answer-key", `book_id: ${yaml(book.id)}`, `exam_id: ${yaml(exam.id)}`, `score: ${exam.percent}`,
    ...(exam.gradedAt ? [`graded: ${yaml(exam.gradedAt)}`] : []),
  ]), [
    `> [!success] Answer key · ${breakdownPoints(exam.earnedPoints)}/${breakdownPoints(exam.maxPoints)} · ${breakdownPoints(exam.percent)}%`,
    `> ${count("correct")} correct · ${count("partial")} partial · ${count("incorrect")} incorrect · ${count("unanswered")} unanswered`, "",
    ...(pie.length ? [...pie, ""] : []),
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
    ...(exam.review && (exam.review.receipts.length || exam.review.responses.length) ? [
      "",
      "> [!note]- Question review",
      ...exam.review.receipts.flatMap((receipt) => {
        const responsesByKey = new Map((exam.review?.responses || []).map((r) => [r.key, r]));
        const lines: string[] = [];
        for (const finding of receipt.findings) {
          const key = computeFindingKey(receipt.role, finding);
          const response = responsesByKey.get(key);
          lines.push(`> - **[F-${key}]** (${receipt.role}: ${finding.severity}) ${finding.issue}`);
          if (finding.repair) lines.push(`>   Repair: ${finding.repair}`);
          if (response) lines.push(`>   Response (${response.action}): ${response.note}`);
        }
        if (receipt.failure) {
          lines.push(`> - **Review warning** (${receipt.role}): Not independently reviewed (${receipt.failure.code}): ${receipt.failure.message}`);
        }
        return lines;
      }),
    ] : []),
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
  const paperLink = (alias: string) => wikiLink(notePath, examAnswerNotePath(config, book, exam), alias);
  const keyLink = () => wikiLink(notePath, answerKeyNotePath(config, book, exam), `${exam.title} — Answer Key`);
  // One obvious next action per state. Review findings never appear here: before
  // grading they would hint at answers, so they live only in the answer key.
  const nextStep = graded
    ? callout("tip", "Next step", `Your score: **${breakdownPoints(exam.earnedPoints)}/${breakdownPoints(exam.maxPoints)} (${breakdownPoints(exam.percent)}%)**. `
      + `Open ${wikiLink(notePath, answerKeyNotePath(config, book, exam), "the answer key")} and start with **Where to look first**.`)
    : submitted
      ? callout("info", "Next step", "Your answers are saved and grading continues in Pi. If grading was interrupted, reopen this exam in Pi to resume it. The answer key appears here once grading finishes.")
      : exam.questions.length
        ? callout("tip", "Next step", [
          `1. Answer every question in ${paperLink("your answer paper")} and save it.`,
          `2. Submit in Pi: \`/scholar exam ${JSON.stringify(exam.id)} submit\``,
        ].join("\n"))
        : "";
  return generatedDocument(frontmatter([
    "type: scholar-exam", `book_id: ${yaml(book.id)}`, `exam_id: ${yaml(exam.id)}`, `status: ${yaml(exam.status)}`,
    `created: ${yaml(exam.createdAt)}`, ...(exam.startedAt ? [`started: ${yaml(exam.startedAt)}`] : []),
    ...(exam.submittedAt ? [`submitted: ${yaml(exam.submittedAt)}`] : []),
    ...(exam.gradedAt ? [`graded: ${yaml(exam.gradedAt)}`] : []), `updated: ${yaml(exam.updatedAt)}`,
  ]), [
    statusCallout(
      graded ? `Exam graded · ${breakdownPoints(exam.earnedPoints)}/${breakdownPoints(exam.maxPoints)} · ${breakdownPoints(exam.percent)}%`
        : submitted ? "Submitted · Awaiting grading" : exam.questions.length ? "Exam · Not yet submitted" : "Exam · Preparing questions",
      [
        `${counted(exam.questions.length, "question")} · ${pointsLabel(points)}`,
        !submitted && !graded && exam.questions.length ? `about ${counted(examMinutes(exam.questions), "minute")}` : "",
        submitted || graded ? `submitted completeness: ${submittedResponses}/${exam.questions.length} answered · ${exam.questions.length - submittedResponses} blank` : "",
      ].filter(Boolean).join(" · ")), "",
    ...(nextStep ? [nextStep] : []),
    wikiLink(notePath, bookHomePath(config, book), book.metadata.title), "",
    ...block("## Scope", scopeLines(config, book, notePath, exam.scope, { includeSections: false })),
    ...block("## Source figures", sourceFigureLines(config, book, notePath, exam.snapshots || [])),
    ...(exam.questions.length && (submitted || graded) ? block("## Answer paper", [
      paperLink("Your answer paper"), "",
      "Your submitted answers are saved. Later edits to the paper do not change this submission.",
    ]) : []),
    ...(graded ? [
      ...block("## Competency profile", competencyTable(exam)),
      ...block("## Answer key", [`Review every question and its reasoning in ${keyLink()}.`]),
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
  // Tutor review is advisory: execution failures are listed once, collapsed below the
  // teaching, so the note opens directly on its first unit (the Learning path, when the
  // session has one). Entry order is untouched: the note is the transcript's authority.
  const reviewNotes = [...new Set((session.review?.receipts || []).flatMap((review) =>
    review.failure ? [`- Not independently reviewed: ${review.role} (${review.failure.code})`] : []))];
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
    ...collapsedRecord("Reviewer notes", reviewNotes, "warning"),
    // The book link travels with the appendix below the teaching, as in Learn.
    wikiLink(notePath, bookHomePath(config, book), book.metadata.title), "",
    ...assessmentQuestionBlock(session.attempts),
  ];
  return generatedDocument(frontmatter([
    "type: scholar-tutor", `book_id: ${yaml(book.id)}`, `tutor_id: ${yaml(session.id)}`, `status: ${yaml(session.status)}`,
    `created: ${yaml(session.createdAt)}`, ...(session.closedAt ? [`closed: ${yaml(session.closedAt)}`] : []), `updated: ${yaml(session.updatedAt)}`,
  ]), [
    statusCallout("Tutor", `${session.status === "active" ? "In progress" : "Closed"} · Assisted practice`), "",
    "Practice does not change Exam scores or Learn completion.", "",
    ...content,
  ].join("\n"));
}
