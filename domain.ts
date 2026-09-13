import { createHash } from "node:crypto";

import { scopedPageRanges, type PageRange } from "./page-scope.ts";
import { isProvisionalOutline } from "./outline-validation.ts";
import { questionCountsTowardCompletion } from "./question-grounding.ts";
import { lessonReady, isObjectiveChecks, lessonObjectiveHash } from "./lesson.ts";
import {
  allSections,
  deriveStatus,
  findChapterForSection,
  findSection,
  type AssessmentAttempt,
  type AssessmentKind,
  type QuestionGrounding,
  type ScholarBook,
  type ScholarChapter,
  type ScholarMode,
  type ScholarScope,
  type ScholarSection,
  type TranscriptEntry,
  type TutorSession,
} from "./types.ts";
export { findSection } from "./types.ts";

export function compactStrings(values: unknown, limit = 100): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().replace(/\s+/g, " "))
    .filter(Boolean))].slice(0, limit);
}

export function requiredChecks(values: unknown): AssessmentKind[] {
  const allowed = new Set<AssessmentKind>(["conceptual", "application", "computation", "discrimination"]);
  const checks = compactStrings(values).filter((value): value is AssessmentKind => allowed.has(value as AssessmentKind));
  return ["conceptual", ...checks.filter((value) => value !== "conceptual")];
}

export function quoted(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function titleFor(book: ScholarBook): string {
  return `${book.metadata.title}${book.metadata.edition ? ` (${book.metadata.edition})` : ""}`;
}

export function sectionLabel(book: ScholarBook, section: ScholarSection | undefined): string {
  if (!section) return "outline";
  const chapter = findChapterForSection(book, section.id);
  const prefix = section.number || chapter?.number || String(section.order);
  return `${prefix} ${section.title}`.trim();
}

export function firstIncomplete(book: ScholarBook): ScholarSection | undefined {
  return allSections(book).find((section) => section.status !== "complete");
}

export function unansweredQuestion(attempts: AssessmentAttempt[]): AssessmentAttempt | undefined {
  const last = attempts.at(-1);
  return last?.outcome === "pending" && last.question?.trim() ? last : undefined;
}

export function unansweredQuestionMessage(attempts: AssessmentAttempt[]): string | undefined {
  const pending = unansweredQuestion(attempts);
  if (!pending) return undefined;
  return pending.format === "multiple-choice"
    ? `Unanswered saved question ${pending.id}: ${pending.question} Call scholar_quiz with only resumeAttemptId=${JSON.stringify(pending.id)} to reopen its exact choices. Do not create a replacement question.`
    : `Pending approved open question ${pending.id}: ${pending.question} Present this exact question again and wait for the learner's answer before resolving it with assess. Do not cancel it just because a session ended, and do not prepare another question.`;
}

export function latestAttemptForKind(section: ScholarSection, kind: AssessmentKind): AssessmentAttempt | undefined {
  const candidates = (section.attempts || []).filter((attempt) =>
    attempt.kind === kind
    && questionCountsTowardCompletion(attempt)
    && attempt.outcome !== "pending"
    && attempt.outcome !== "cancelled"
    && attempt.outcome !== "unavailable",
  );
  return candidates.at(-1);
}

/** Any graded attempt the learner made under the current grounded rule. */
function hasResolvedMasteryEvidence(section: ScholarSection): boolean {
  return section.attempts.some((attempt) =>
    attempt.grounding?.purpose === "mastery"
    && attempt.outcome !== "pending"
    && attempt.outcome !== "cancelled"
    && attempt.outcome !== "unavailable");
}

function checksComplete(section: ScholarSection): boolean {
  return requiredChecks(section.requiredChecks).every(
    (kind) => latestAttemptForKind(section, kind)?.outcome === "pass",
  );
}

export function sectionCompletionBlockers(section: ScholarSection, sourceHash?: string): string[] {
  const objectives = section.objectives || [];
  const objectiveSet = new Set(objectives);
  const coveredSet = new Set((section.coveredObjectives || []).filter((objective) => objectiveSet.has(objective)));
  const coverageComplete = objectives.length > 0 && objectives.every((objective) => coveredSet.has(objective));
  const notesComplete = Boolean(section.synthesis?.trim()) && (section.keyPoints?.length || 0) > 0;
  // Existing results remain valid until this section enters the visual-review
  // workflow. New Learn questions require its receipt at the tool boundary.
  const figuresComplete = section.figureCoverage ? Array.from(
    { length: section.endPage - section.startPage + 1 }, (_, index) => section.startPage + index,
  ).every((page) => {
    const entry = section.figureCoverage!.pages.find((item) => item.page === page);
    return entry?.read && entry.viewed && entry.review
      && entry.candidates.every((label) => entry.review!.figures.some((figure) => figure.label === label));
  }) : section.status === "complete";
  // A grandfathered section keeps the completion it earned under the older
  // rule. Coverage and notes are still required: only the mastery-evidence
  // test is waived, and only for work that was already finished.
  return [
    ...(!coverageComplete ? ["teaching coverage for every declared objective"] : []),
    ...(!notesComplete ? ["saved synthesis and key points"] : []),
    ...(!figuresComplete ? ["source-page and figure review"] : []),
    ...(section.legacyLessonCompletion ? [] : [
      ...(!lessonReady(section, sourceHash) ? ["complete saved instructional lesson"] : []),
      ...objectiveMasteryBlockers(section),
    ]),
    ...(section.legacyCompletion === true ? [] : requiredChecks(section.requiredChecks)
      .filter((kind) => latestAttemptForKind(section, kind)?.outcome !== "pass")
      .map((kind) => `${kind} check`)),
  ];
}

/** A pass for one objective never replaces a miss or missing evidence for another. */
export function objectiveMasteryBlockers(section: ScholarSection): string[] {
  if (!isObjectiveChecks(section.objectiveChecks) || section.objectives.some(objective => !section.objectiveChecks!.some(item => item.objective === objective))) return ["mastery plan for every objective"];
  return section.objectiveChecks.flatMap(({ objective, checks }) => checks.filter(kind => {
    const last = latestAttemptForObjectiveCheck(section, objective, kind);
    return last?.outcome !== "pass";
  }).map(kind => `${kind} evidence for: ${objective}`));
}

export function latestAttemptForObjectiveCheck(section: ScholarSection, objective: string, kind: AssessmentKind): AssessmentAttempt | undefined {
  return section.attempts.filter(attempt => attempt.kind === kind && questionCountsTowardCompletion(attempt)
    && !["pending", "cancelled", "unavailable"].includes(attempt.outcome)
    && attempt.grounding!.basis.some(basis => basis.kind === "objective" && basis.value === objective)).at(-1);
}

export function sectionProgressMessage(section: ScholarSection): string {
  const unanswered = unansweredQuestionMessage(section.attempts || []);
  if (unanswered) return `${section.status === "complete" ? "Section complete; this question is practice. " : ""}${unanswered}`;
  if (section.status === "complete") return "Section complete. Stop this lesson here. Any later questions are practice only and do not change earned completion.";
  const remaining = sectionCompletionBlockers(section);
  return `Section ${section.status}. Remaining: ${remaining.join("; ") || "progress reconciliation"}. Resume only the missing work; do not repeat passed checks or claim completion yet.`;
}

/** Once completion is earned, follow-up questions are practice even if a model labels them mastery. */
export function learnQuestionGrounding(section: ScholarSection, grounding: QuestionGrounding): QuestionGrounding {
  return section.status === "complete" ? { ...grounding, purpose: "practice" } : grounding;
}

/**
 * Grandfather sections completed before grounded mastery was required.
 *
 * questionCountsTowardCompletion once accepted an ungrounded attempt as mastery
 * evidence. Tightening it would otherwise silently un-complete finished work,
 * and no honest repair exists for those attempts: inventing a grounding receipt
 * would fabricate the very provenance the gate exists to prove.
 *
 * So the old verdict is recorded instead of re-derived. This is a pure function
 * applied wherever a book is read; the flag persists on the next ordinary write,
 * and `recomputeProgress` drops it as soon as the section can stand on the
 * current rule. Sections that were not already complete are untouched — they
 * must meet the new bar.
 */
export function migrateLegacyCompletion(book: ScholarBook): ScholarBook {
  for (const chapter of book.chapters) {
    for (const section of chapter.sections) {
      if (section.status === "complete" && !section.lessonCommit) section.legacyLessonCompletion = true;
      if (section.legacyCompletion === true) continue;
      if (section.status !== "complete" || checksComplete(section)) continue;
      const relies = section.attempts.some((attempt) => attempt.grounding === undefined && attempt.outcome === "pass");
      if (relies) section.legacyCompletion = true;
    }
  }
  return book;
}

/** Repair only a saved explicit kind label; never infer credit from a question's prose. */
export function migrateLearnAssessmentKinds(book: ScholarBook): ScholarBook {
  for (const section of allSections(book)) {
    let changed = false;
    for (const attempt of section.attempts) {
      if (attempt.format !== "multiple-choice" || attempt.kind !== "quiz" || attempt.grounding?.purpose !== "mastery") continue;
      const kind = quizKind(undefined, attempt.difficulty);
      if (kind === "quiz") continue;
      attempt.kind = kind;
      changed = true;
    }
    // Reconcile the format-rule change too, including already correctly labeled MC checks.
    if (section.status !== "complete" && (changed || sectionCompletionBlockers(section).length === 0)) {
      const updatedAt = section.updatedAt;
      recomputeProgress(book, section);
      section.updatedAt = updatedAt;
    }
  }
  return book;
}

export function recomputeProgress(book: ScholarBook, changedSection?: ScholarSection): void {
  if (changedSection) {
    // The waiver covers past work only. It ends as soon as the section can
    // stand on the current rule, and equally as soon as the learner produces
    // any resolved mastery evidence — otherwise a failed review could never
    // demote a grandfathered section, permanently disabling revision for it.
    if (changedSection.legacyCompletion === true
      && (checksComplete(changedSection) || hasResolvedMasteryEvidence(changedSection))) {
      delete changedSection.legacyCompletion;
    }
    if (sectionCompletionBlockers(changedSection, book.source?.fingerprint?.sha256).length === 0) {
      if (changedSection.learnQuality && changedSection.lessonCommit) changedSection.learnQuality.earnedDelivery = {
        sourceHash: changedSection.lessonCommit.sourceHash, objectiveHash: lessonObjectiveHash(changedSection),
      };
      changedSection.status = "complete";
    } else {
      const last = changedSection.attempts.at(-1);
      changedSection.status = last && (last.outcome === "review" || last.outcome === "unsure") ? "review" : "learning";
    }
    changedSection.updatedAt = new Date().toISOString();
  }
  for (const chapter of book.chapters) chapter.status = deriveStatus(chapter.sections);
}

export function quizKind(details: unknown, difficulty: unknown, section?: ScholarSection, declaredKind?: AssessmentKind): AssessmentKind {
  if (declaredKind) return declaredKind;
  for (const value of [difficulty, details]) {
    if (typeof value !== "string") continue;
    const normalized = value.toLowerCase();
    if (/\bconcept(?:ual)?\b/.test(normalized)) return "conceptual";
    if (/\bcomput(?:ation|ational)?\b/.test(normalized)) return "computation";
    if (/\b(?:misconception\s+)?discrimination\b/.test(normalized)) return "discrimination";
    if (/\bapplication\b/.test(normalized)) return "application";
  }
  switch (difficulty) {
    case "discrimination":
      return "discrimination";
    case "application":
    case "transfer":
    case "creation":
      return "application";
    default: {
      if (!section) return "quiz";
      const outstanding = requiredChecks(section.requiredChecks)
        .filter((kind) => kind !== "conceptual")
        .filter((kind) => latestAttemptForKind(section, kind)?.outcome !== "pass");
      return outstanding.length === 1 ? outstanding[0]! : "quiz";
    }
  }
}

export function findQuizAttempt(book: ScholarBook, sectionId: string | undefined, toolCallId: string): { section: ScholarSection; attempt: AssessmentAttempt } | undefined {
  const section = findSection(book, sectionId);
  const attempt = section && [...section.attempts].reverse().find((item) => item.toolCallId === toolCallId || item.resumeToolCallIds?.includes(toolCallId));
  return section && attempt ? { section, attempt } : undefined;
}

export function findTutorQuizAttempt(book: ScholarBook, tutorId: string | undefined, toolCallId: string): { tutor: TutorSession; attempt: AssessmentAttempt } | undefined {
  const tutor = book.tutorSessions.find((item) => item.id === tutorId);
  const attempt = tutor?.attempts.find((item) => item.toolCallId === toolCallId || item.resumeToolCallIds?.includes(toolCallId));
  return tutor && attempt ? { tutor, attempt } : undefined;
}

export function progressSummary(book: ScholarBook): string {
  if (book.outlineStatus !== "ready") return `${titleFor(book)}: outline ${isProvisionalOutline(book) ? "validation pending" : book.outlineStatus}.`;
  const sections = allSections(book);
  const completed = sections.filter((section) => section.status === "complete").length;
  const current = findSection(book, book.currentSectionId);
  const selection = current
    ? ` Current: ${sectionLabel(book, current)}.`
    : sections.length > 0 && completed === sections.length
      ? " Book complete."
      : sections.length > 0
        ? " No Learn section selected."
        : ` Outline ${book.outlineStatus}.`;
  return `${titleFor(book)}: ${completed}/${sections.length} sections complete.${selection}`;
}

export function activeProgressSummary(book: ScholarBook, mode: ScholarMode | undefined, recordId: string | undefined): string {
  if (mode === "exam") {
    const exam = book.exams.find((item) => item.id === recordId);
    return exam ? `${exam.title}: ${exam.status}${exam.status === "graded" ? ` · ${exam.earnedPoints}/${exam.maxPoints} (${exam.percent}%)` : ` · ${exam.questions.length} frozen question(s)`}.` : "No Exam record is active.";
  }
  if (mode === "tutor") {
    const tutor = book.tutorSessions.find((item) => item.id === recordId);
    return tutor ? `${tutor.title}: ${tutor.status} · ${tutor.scope.description}.` : "No Tutor record is active.";
  }
  if (mode === "learn") {
    const section = findSection(book, recordId);
    const sections = allSections(book);
    const completed = sections.filter((item) => item.status === "complete").length;
    return section
      ? `${titleFor(book)}: Learn ${sectionLabel(book, section)} · ${completed}/${sections.length} sections complete.`
      : "No valid Learn section is active.";
  }
  if (book.outlineStatus !== "ready") return `${titleFor(book)} is selected; outline ${isProvisionalOutline(book) ? "validation pending" : book.outlineStatus}.`;
  return `${titleFor(book)} is selected; no mode is active.`;
}

export function transcriptId(prefix: string, value: string): string {
  return `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 20)}`;
}

function assistantText(message: any): string {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content
    .filter((part: any) => part?.type === "text" && typeof part.text === "string")
    .map((part: any) => part.text.trim())
    .filter(Boolean)
    .join("\n\n");
}

export function messageTranscriptEntry(message: any, stableId?: string, timestamp?: string): TranscriptEntry | undefined {
  const markdown = assistantText(message);
  if (!markdown) return undefined;
  const createdAt = timestamp || (typeof message.timestamp === "number"
    ? new Date(message.timestamp).toISOString()
    : typeof message.timestamp === "string"
      ? message.timestamp
      : new Date().toISOString());
  const identity = `${stableId || String(message.timestamp || createdAt)}\n${markdown}`;
  return { id: transcriptId("assistant", identity), kind: "assistant", markdown, createdAt };
}

export function appendTranscript(
  entries: TranscriptEntry[],
  incoming: TranscriptEntry,
): boolean {
  if (entries.some((entry) => entry.id === incoming.id)) return false;
  if (!incoming.lesson && entries.some(entry => entry.lesson && entry.markdown.replace(/\s+/g, " ").trim() === incoming.markdown.replace(/\s+/g, " ").trim())) return false;
  entries.push(incoming);
  // This is the vault's durable lesson record, not a model context window.
  // Resume prompts select a short recent synthesis without deleting history.
  return true;
}

type ScopeSelector = { kind?: "chapter" | "section"; value: string };

function normalizedToken(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function scopeSelector(token: string): ScopeSelector {
  // A plural qualifier reads naturally with a range or list ("chapters 3-5"),
  // so accept it and normalize to the singular kind the matchers expect.
  const explicit = /^(chapters?|sections?)\s+(.+)$/i.exec(token.trim());
  if (!explicit) return { value: token.trim() };
  const kind = explicit[1]!.toLowerCase().replace(/s$/, "") as "chapter" | "section";
  return { kind, value: explicit[2]!.trim() };
}

function chapterMatches(chapter: ScholarChapter, token: string): boolean {
  const query = normalizedToken(token);
  return Boolean(query) && (
    normalizedToken(chapter.id) === query
    || normalizedToken(chapter.number || "") === query
    || normalizedToken(chapter.title) === query
    || normalizedToken(`${chapter.number || ""} ${chapter.title}`) === query
  );
}

function sectionMatches(section: ScholarSection, token: string): boolean {
  const query = normalizedToken(token);
  return Boolean(query) && (
    normalizedToken(section.id) === query
    || normalizedToken(section.number || "") === query
    || normalizedToken(section.title) === query
    || normalizedToken(`${section.number || ""} ${section.title}`) === query
  );
}

function expandChapterRange(book: ScholarBook, token: string): ScholarChapter[] {
  const match = /^(\d+)\s*-\s*(\d+)$/.exec(normalizedToken(token));
  if (!match) return [];
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (end < start) throw new Error(`Invalid chapter range: ${token}`);
  return book.chapters.filter((chapter) => {
    const number = Number(chapter.number || chapter.order);
    return Number.isFinite(number) && number >= start && number <= end;
  });
}

function matchingChapters(book: ScholarBook, selector: ScopeSelector): ScholarChapter[] {
  return selector.kind === "section" ? [] : book.chapters.filter((chapter) => chapterMatches(chapter, selector.value));
}

function matchingSections(book: ScholarBook, selector: ScopeSelector): ScholarSection[] {
  return selector.kind === "chapter" ? [] : allSections(book).filter((section) => sectionMatches(section, selector.value));
}

function assertUnambiguousSelector(token: string, chapters: ScholarChapter[], sections: ScholarSection[]): void {
  if (chapters.length + sections.length <= 1) return;
  throw new Error(`Scholar target ${quoted(token)} is ambiguous. Use an explicit unique selector such as ${chapters.length ? quoted(`chapter ${chapters[0]!.number || chapters[0]!.id}`) : quoted(`section ${sections[0]!.id}`)}.`);
}

export function resolveScope(book: ScholarBook, input: string | undefined, allowTopic: boolean): ScholarScope {
  const value = input?.trim();
  if (!value || /^all$/i.test(value)) {
    return {
      chapterIds: book.chapters.map((chapter) => chapter.id),
      sectionIds: allSections(book).map((section) => section.id),
      description: "the complete book",
    };
  }
  const tokens = value.split(/[,;]+/).map((token) => token.trim()).filter(Boolean);
  const chapters: ScholarChapter[] = [];
  const sections: ScholarSection[] = [];
  const unmatched: string[] = [];
  for (const token of tokens) {
    const selector = scopeSelector(token);
    const ranged = selector.kind === "section" ? [] : expandChapterRange(book, selector.value);
    if (ranged.length) {
      chapters.push(...ranged);
      continue;
    }
    const chapterMatchesForToken = matchingChapters(book, selector);
    const sectionMatchesForToken = matchingSections(book, selector);
    assertUnambiguousSelector(token, chapterMatchesForToken, sectionMatchesForToken);
    if (chapterMatchesForToken[0]) {
      chapters.push(chapterMatchesForToken[0]);
      continue;
    }
    if (sectionMatchesForToken[0]) {
      sections.push(sectionMatchesForToken[0]);
      continue;
    }
    unmatched.push(token);
  }
  if (unmatched.length && !allowTopic) throw new Error(`No chapter or section matches: ${unmatched.join(", ")}`);
  const chapterIds = [...new Set(chapters.map((chapter) => chapter.id))];
  const explicitSectionIds = sections.map((section) => section.id);
  const chapterSectionIds = chapters.flatMap((chapter) => chapter.sections.map((section) => section.id));
  const sectionIds = [...new Set([...chapterSectionIds, ...explicitSectionIds])];
  for (const section of sections) {
    const chapter = findChapterForSection(book, section.id);
    if (chapter && !chapterIds.includes(chapter.id)) chapterIds.push(chapter.id);
  }
  if (sectionIds.length === 0 && !allowTopic) throw new Error(`The scope ${quoted(value)} contains no source sections.`);
  return {
    chapterIds,
    sectionIds,
    description: unmatched.length ? value : tokens.join(", "),
  };
}

export function resolveLearnSection(book: ScholarBook, input: string | undefined): ScholarSection | undefined {
  const value = input?.trim();
  if (!value) {
    const current = findSection(book, book.currentSectionId);
    return current && (current.status === "learning" || current.status === "review" || unansweredQuestion(current.attempts)) ? current : undefined;
  }
  const selector = scopeSelector(value);
  const chapters = matchingChapters(book, selector);
  const sections = matchingSections(book, selector);
  assertUnambiguousSelector(value, chapters, sections);
  if (sections[0]) return sections[0];
  const chapter = chapters[0];
  if (!chapter) return undefined;
  const unfinished = chapter.sections.find((section) => unansweredQuestion(section.attempts))
    || chapter.sections.find((section) => section.status !== "complete");
  if (!unfinished) {
    throw new Error(`${chapter.number ? `Chapter ${chapter.number}` : chapter.title} is complete. Select a specific section explicitly to review it.`);
  }
  return unfinished;
}

function scopedSections(book: ScholarBook, scope: ScholarScope): ScholarSection[] {
  const allowed = new Set(scope.sectionIds);
  const sections = allSections(book).filter((section) => allowed.has(section.id));
  const found = new Set(sections.map((section) => section.id));
  const missing = [...allowed].filter((sectionId) => !found.has(sectionId));
  if (missing.length) {
    throw new Error(`Scholar mode scope references missing source sections: ${missing.join(", ")}. Select the scope again.`);
  }
  return sections;
}

export function sectionsInModeScope(
  book: ScholarBook,
  mode: ScholarMode | undefined,
  recordId: string | undefined,
): ScholarSection[] | undefined {
  if (!mode) return undefined;
  if (!recordId?.trim()) throw new Error(`Scholar ${mode} mode has no exact target record. Start ${mode} again with an explicit scope.`);
  if (mode === "learn") {
    const section = findSection(book, recordId);
    if (!section) throw new Error("Scholar Learn has no valid frozen section target. Start Learn again with an explicit chapter or section.");
    return [section];
  }
  if (mode === "exam") {
    const exam = book.exams.find((item) => item.id === recordId);
    if (!exam) throw new Error("Scholar Exam has no valid frozen exam target. Start Exam again with an explicit scope.");
    const sections = scopedSections(book, exam.scope);
    if (!sections.length) throw new Error("Scholar Exam has no valid source sections. Start Exam again with an explicit scope.");
    return sections;
  }
  const tutor = book.tutorSessions.find((item) => item.id === recordId);
  if (!tutor) throw new Error("Scholar Tutor has no valid frozen session target. Start Tutor again with an explicit scope or topic.");
  // A real free-topic Tutor session intentionally has whole-book source access.
  // Only that existing record may use an unbounded section scope; stale records
  // must fail above instead of being mistaken for a free-topic session.
  if (!tutor.scope.sectionIds.length) return undefined;
  return scopedSections(book, tutor.scope);
}

export type { PageRange } from "./page-scope.ts";

/**
 * The pages a mode may read.
 *
 * A chapter's pages are not all covered by its sections. A chapter title page,
 * a full-page figure sitting between two subsections, and an end-of-chapter
 * summary belong to the chapter rather than to any one section. Allowing only
 * section ranges made those pages unreachable — in this project's own source
 * book, ten of thirteen chapters open on such a page — so an ordinary
 * contiguous read failed with a scope error and the caller was forced into slow
 * single-page probing to find the boundary.
 *
 * Allowed is therefore every scoped section's range, plus the pages of a scoped
 * section's own chapter that none of that chapter's sections cover. A
 * section-scoped exam gains its chapter's unmapped pages and still never gains
 * another subsection.
 */
export function allowedPageRanges(
  book: ScholarBook,
  mode: ScholarMode | undefined,
  recordId: string | undefined,
): PageRange[] | undefined {
  const sections = sectionsInModeScope(book, mode, recordId);
  return sections ? scopedPageRanges(book, sections) : undefined;
}

export function assertPagesInModeScope(
  book: ScholarBook,
  mode: ScholarMode | undefined,
  recordId: string | undefined,
  startPage: number,
  endPage: number,
): void {
  // An inverted range would run zero loop iterations below and pass silently,
  // so any page could escape the scope check by asking for it backwards.
  if (!Number.isInteger(startPage) || !Number.isInteger(endPage) || startPage < 1 || endPage < startPage) {
    throw new Error(
      `Scholar page range ${startPage}-${endPage} is invalid: both pages must be whole numbers of at least 1, with the start on or before the end.`,
    );
  }
  const ranges = allowedPageRanges(book, mode, recordId);
  if (!ranges) return;
  for (let page = startPage; page <= endPage; page += 1) {
    if (!ranges.some((range) => page >= range.startPage && page <= range.endPage)) {
      throw new Error(`PDF page ${page} is outside the active ${mode} scope.`);
    }
  }
}
