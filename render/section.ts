import { latestAttemptForKind, sectionCompletionBlockers } from "../domain.ts";
import { chapterNotePath, sectionNotePath, snapshotAssetPath } from "../obsidian-paths.ts";
import type { AssessmentAttempt, AssessmentKind, ScholarBook, ScholarChapter, ScholarConfig, ScholarSection, ScholarSnapshot, TranscriptEntry } from "../types.ts";
import { block, collapsedRecord, frontmatter, generatedDocument, markdownText, pageRange, readableOutcome, statusLabel, tableText, titleCase, wikiEmbed, wikiLink, yaml } from "./common.ts";

export function comparableTranscriptText(value: string): string {
  return markdownText(value).replace(/^\*\*([\s\S]*)\*\*$/, "$1").replace(/\s+/g, " ").trim().toLowerCase();
}

function questionLines(attempt: AssessmentAttempt, index: number): string[] {
  return [
    `### Question ${index + 1} · ${titleCase(attempt.kind)}${attempt.grounding?.purpose === "practice" ? " · Practice" : ""}`, "", markdownText(attempt.question),
    ...(attempt.options?.length ? ["", ...attempt.options.map((option, optionIndex) => `${optionIndex + 1}. ${markdownText(option)}`)] : []),
  ];
}

/** Questions and derived feedback share attempt numbering; private responses never enter this projection. */
export function sectionQuestionLines(section: Pick<ScholarSection, "attempts">): string[] {
  return section.attempts.flatMap((attempt, index) => [...(index ? [""] : []), ...questionLines(attempt, index)]);
}

export function answerPresentation(outcome: AssessmentAttempt["outcome"]): { type: string; title: string } {
  switch (outcome) {
    case "pass": return { type: "success", title: "Correct" };
    case "review": return { type: "warning", title: "Needs review" };
    case "unsure": return { type: "warning", title: "Knowledge gap identified" };
    case "cancelled": return { type: "info", title: "Cancelled" };
    case "unavailable": return { type: "failure", title: "Unavailable" };
    default: return { type: "question", title: "Awaiting response" };
  }
}

export function sectionAnswerLines(section: Pick<ScholarSection, "attempts">): string[] {
  return section.attempts.flatMap((attempt, index) => attempt.outcome === "pending" ? [] : [
    ...(index ? [""] : []), `#### Answer ${index + 1}`, "", ...attemptAnswerLines(attempt),
  ]);
}

function attemptAnswerLines(attempt: AssessmentAttempt): string[] {
  if (attempt.outcome === "pending") return [];
  if (attempt.outcome === "cancelled") return ["*Cancelled*", ...(attempt.feedback?.trim() ? ["", markdownText(attempt.feedback)] : [])];
  const presentation = answerPresentation(attempt.outcome);
  const body = [
    ...(attempt.correctAnswer?.trim() ? [`**Correct answer:** ${markdownText(attempt.correctAnswer)}`] : []),
    ...(attempt.feedback?.trim() ? ["", `**${attempt.correctAnswer?.trim() ? "Explanation" : "Feedback"}:** ${markdownText(attempt.feedback)}`] : []),
    ...(attempt.grounding?.sourcePages.length ? ["", `*PDF ${attempt.grounding.sourcePages.length === 1 ? "page" : "pages"} ${attempt.grounding.sourcePages.join(", ")}*`] : []),
  ];
  return [
    `> [!${presentation.type}] ${presentation.title}`,
    ...body.join("\n").trim().split("\n").map((line) => line ? `> ${line}` : ">"), "",
  ];
}

/** Preserve authored teaching, excluding exact repeated entries and question echoes. */
export function teachingRecordLines(entries: TranscriptEntry[], attempts: AssessmentAttempt[], synthesis?: string): string[] {
  const repeated = new Set(attempts.map((attempt) => comparableTranscriptText(attempt.question)));
  if (synthesis?.trim()) repeated.add(comparableTranscriptText(synthesis));
  const teaching: string[] = [];
  for (const entry of entries) {
    if (entry.kind !== "assistant") continue;
    const text = markdownText(entry.markdown);
    const comparable = comparableTranscriptText(text);
    if (!text || repeated.has(comparable)) continue;
    repeated.add(comparable);
    // A transport echo may be appended to otherwise unique teaching. Remove
    // only a final paragraph that exactly repeats a recorded question.
    const paragraphs = text.split(/\n\s*\n/);
    if (attempts.some((attempt) => comparableTranscriptText(attempt.question) === comparableTranscriptText(paragraphs.at(-1)!))) paragraphs.pop();
    if (paragraphs.length) teaching.push(paragraphs.join("\n\n"));
  }
  return teaching.flatMap((text, index) => [...(index ? ["", "---", ""] : []), text]);
}

export function sectionTeachingLines(section: ScholarSection): string[] {
  return teachingRecordLines(section.transcript || [], section.attempts);
}

/** Omit only exact repeated paragraphs; never summarize away unique teaching. */
export function uniqueSupplementLines(values: string[], visible: string[]): string[] {
  const shown = new Set(visible.flatMap((text) => text.split(/\n\s*\n/)).map(comparableTranscriptText));
  return values.flatMap((value) => {
    const text = markdownText(value);
    const comparable = comparableTranscriptText(text);
    if (!text || shown.has(comparable)) return [];
    shown.add(comparable);
    return [text];
  });
}

export function sourceFigureLines(config: ScholarConfig, book: ScholarBook, notePath: string, snapshots: ScholarSnapshot[]): string[] {
  const seen = new Set<string>();
  return [...snapshots]
    .sort((left, right) => left.page - right.page || left.id.localeCompare(right.id))
    .flatMap((snapshot) => {
      if (seen.has(snapshot.assetFile)) return [];
      seen.add(snapshot.assetFile);
      return [
        `**Figure · PDF page ${snapshot.page}**`, "",
        wikiEmbed(notePath, snapshotAssetPath(config, book, snapshot), 640), "",
        markdownText(snapshot.caption), "",
        `*Source: ${markdownText(book.source.fileName).replace(/\n/g, " ")} · PDF viewer page ${snapshot.page}.*`, "",
      ];
    });
}

export function assessmentSummaryLine(attempt: AssessmentAttempt): string {
  const source = attempt.grounding?.sourcePages.length
    ? ` · PDF ${attempt.grounding.sourcePages.length === 1 ? "page" : "pages"} ${attempt.grounding.sourcePages.join(", ")}` : "";
  return `- **${titleCase(attempt.kind)}** — ${readableOutcome(attempt.outcome)}${source}`;
}

export function pendingQuestionLines(attempts: AssessmentAttempt[]): string[] {
  return attempts.flatMap((attempt, index) => attempt.outcome !== "pending" ? [] : [
    ...questionLines(attempt, index), "", "*Awaiting response*", "",
  ]);
}

export function assessmentRecordLines(attempts: AssessmentAttempt[], _title = "Assessment record"): string[] {
  // Each completed prompt stays next to its answer. Pending questions follow
  // the history at the end of the note and retain their original numbering.
  const history = attempts.flatMap((attempt, index) => attempt.outcome === "pending" ? [] : [{ attempt, index }]);
  return history.flatMap(({ attempt, index }, position) => [
    ...(position ? ["", "---", ""] : []), ...questionLines(attempt, index), "", ...attemptAnswerLines(attempt), "",
  ]);
}

/** Learn and Tutor deliberately share the complete question/feedback layout. */
export function assessmentQuestionBlock(attempts: AssessmentAttempt[]): string[] {
  return block("## Questions", [...assessmentRecordLines(attempts), ...pendingQuestionLines(attempts)]);
}

export function passedCheckKinds(section: ScholarSection): Set<AssessmentKind> {
  return new Set(section.requiredChecks.filter((kind) => latestAttemptForKind(section, kind)?.outcome === "pass"));
}

export function renderSection(config: ScholarConfig, book: ScholarBook, chapter: ScholarChapter, section: ScholarSection): string {
  const notePath = sectionNotePath(config, book, chapter, section);
  const chapterLabel = chapter.number ? `Chapter ${chapter.number}: ${chapter.title}` : chapter.title;
  const covered = new Set(section.coveredObjectives);
  const passed = passedCheckKinds(section);
  const objectives = section.objectives.length ? [
    "| Objective | Teaching coverage |", "| --- | --- |",
    ...section.objectives.map((objective) => `| ${tableText(objective)} | ${covered.has(objective) ? "Taught" : "Not yet taught"} |`),
  ] : [];
  const checks = section.requiredChecks.length ? [
    "| Understanding check | Result |", "| --- | --- |",
    ...section.requiredChecks.map((kind) => `| ${tableText(titleCase(kind))} | ${passed.has(kind) ? "Demonstrated" : "Not yet demonstrated"} |`),
  ] : [];
  const teaching = sectionTeachingLines(section);
  const lesson = teaching.length ? teaching : section.synthesis?.trim() ? [markdownText(section.synthesis)] : [];
  const summary = uniqueSupplementLines(section.synthesis ? [section.synthesis] : [], lesson);
  const keyPoints = uniqueSupplementLines(section.keyPoints, [...lesson, ...summary]);
  const pitfalls = uniqueSupplementLines(section.misconceptions, [...lesson, ...summary, ...keyPoints]);
  const current = book.currentSectionId === section.id;
  const content = [
    ...(lesson.length ? block("## Lesson", lesson) : ["This section is ready. The lesson will appear as you work through it.", ""]),
    ...block("## Source figures", sourceFigureLines(config, book, notePath, section.snapshots || [])),
    ...collapsedRecord("Recap and pitfalls", [
      ...block("### Section summary", summary),
      ...block("### Key points", keyPoints.map((point) => `- ${point}`)),
      ...block("### Common pitfalls", pitfalls.map((point) => `- ${point}`)),
    ]),
    ...collapsedRecord("Learning record", [
      ...block("### Learning objectives", objectives),
      ...block("### Understanding checks", checks),
    ]),
    ...assessmentQuestionBlock(section.attempts),
  ];
  return generatedDocument(frontmatter([
    "type: scholar-section", `book_id: ${yaml(book.id)}`, `chapter_id: ${yaml(chapter.id)}`, `section_id: ${yaml(section.id)}`,
    `status: ${yaml(section.status)}`, `current: ${current}`, `created: ${yaml(section.createdAt)}`, `updated: ${yaml(section.updatedAt)}`,
  ]), [
    `*${statusLabel(section.status)}${current ? " · Current section" : ""} · ${pageRange(section.startPage, section.endPage)}*`, "",
    ...(section.status === "complete" ? ["**Section complete.** Reopen for practice anytime; practice does not change your earned completion.", ""]
      : section.status !== "not-started" ? [`**Remaining to complete:** ${sectionCompletionBlockers(section).map(markdownText).join("; ")}.`, ""] : []),
    wikiLink(notePath, chapterNotePath(config, book, chapter), chapterLabel), "",
    ...(content.some((line) => line.trim()) ? content : ["This section is ready. Notes will appear as you work through it."]),
  ].join("\n"));
}
