import {
  compactStrings,
  recomputeProgress,
  requiredChecks,
} from "../domain.ts";
import {
  assertOutlineStructure,
  evaluateOutlineValidationDecisions,
  isProvisionalOutline,
  type OutlineValidationDecisionInput,
  type OutlineValidationReport,
  type OutlineValidationRun,
} from "../outline-validation.ts";
import type { ToolDetails } from "../tool-contract.ts";
import {
  allSections,
  type AssessmentKind,
  type ScholarBook,
  type ScholarChapter,
  type ScholarSection,
} from "../types.ts";

export type OutlineChapterInput = {
  number?: string;
  title: string;
  startPage: number;
  endPage: number;
  sections: Array<{
    number?: string;
    title: string;
    startPage: number;
    endPage: number;
    objectives?: string[];
    requiredChecks?: AssessmentKind[];
  }>;
};

type MutateBook = <T>(
  bookId: string,
  mutate: (book: ScholarBook) => Promise<T> | T,
) => Promise<{ book: ScholarBook; result: T }>;

type ToolResultFn = (
  action: string,
  summary: string,
  details?: Partial<ToolDetails>,
) => { content: Array<{ type: "text"; text: string }>; details: ToolDetails };

export function buildOutlineChapters(
  chapters: OutlineChapterInput[],
  pageCount?: number,
): ScholarChapter[] {
  const now = new Date().toISOString();
  return chapters.map((inputChapter, chapterIndex) => {
    const chapterTitle = inputChapter.title.trim();
    if (!chapterTitle || !inputChapter.sections.length) {
      throw new Error(`Chapter ${chapterIndex + 1} needs a title and at least one section.`);
    }
    if (inputChapter.endPage < inputChapter.startPage || (pageCount && inputChapter.endPage > pageCount)) {
      throw new Error(`Chapter ${chapterIndex + 1} has invalid PDF page bounds.`);
    }
    if (chapterIndex > 0 && inputChapter.startPage < chapters[chapterIndex - 1]!.startPage) {
      throw new Error("Scholar chapters must be supplied in source-page order.");
    }
    const chapterId = `chapter-${String(chapterIndex + 1).padStart(3, "0")}`;
    const sections: ScholarSection[] = inputChapter.sections.map((inputSection, sectionIndex) => {
      const sectionTitle = inputSection.title.trim();
      if (!sectionTitle) throw new Error(`Chapter ${chapterIndex + 1}, section ${sectionIndex + 1} needs a title.`);
      if (
        inputSection.endPage < inputSection.startPage
        || inputSection.startPage < inputChapter.startPage
        || inputSection.endPage > inputChapter.endPage
      ) throw new Error(`Chapter ${chapterIndex + 1}, section ${sectionIndex + 1} falls outside its chapter.`);
      if (sectionIndex > 0 && inputSection.startPage < inputChapter.sections[sectionIndex - 1]!.startPage) {
        throw new Error(`Chapter ${chapterIndex + 1} sections must be supplied in source-page order.`);
      }
      return {
        id: `${chapterId}-section-${String(sectionIndex + 1).padStart(3, "0")}`,
        order: sectionIndex + 1,
        ...(inputSection.number?.trim() ? { number: inputSection.number.trim() } : {}),
        title: sectionTitle,
        startPage: inputSection.startPage,
        endPage: inputSection.endPage,
        objectives: compactStrings(inputSection.objectives),
        coveredObjectives: [],
        requiredChecks: requiredChecks(inputSection.requiredChecks),
        status: "not-started",
        keyPoints: [],
        misconceptions: [],
        attempts: [],
        transcript: [],
        createdAt: now,
        updatedAt: now,
      };
    });
    return {
      id: chapterId,
      order: chapterIndex + 1,
      ...(inputChapter.number?.trim() ? { number: inputChapter.number.trim() } : {}),
      title: chapterTitle,
      startPage: inputChapter.startPage,
      endPage: inputChapter.endPage,
      status: "not-started",
      sections,
    };
  });
}

export async function handleOutline(
  book: ScholarBook,
  setupActive: boolean,
  params: {
    chapters?: OutlineChapterInput[];
    outlineConfidence?: "verified" | "needs-review";
    title?: string;
    authors?: string[];
    edition?: string;
    isbn?: string;
  },
  isSetupActive: (book: ScholarBook) => boolean,
  mutateBook: MutateBook,
  resetValidation: () => void,
  hydrateOutlineValidation: (book: ScholarBook) => Promise<{ run: OutlineValidationRun; report: OutlineValidationReport }>,
  finishOutlineValidation: (book: ScholarBook, run: OutlineValidationRun, report: OutlineValidationReport) => Promise<{ content: Array<{ type: "text"; text: string }>; details: ToolDetails }>,
  toolResult: ToolResultFn,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: ToolDetails }> {
  if (book.outlineStatus === "ready") throw new Error("Scholar will not replace a verified outline outside an explicit recovery workflow.");
  const chapters = params.chapters;
  if (!chapters?.length) throw new Error("Scholar outline requires at least one chapter.");
  if (!params.outlineConfidence) throw new Error("Scholar outline requires outlineConfidence: verified or needs-review.");
  if (book.chapters.some((chapter) => chapter.sections.some((section) => section.attempts.length > 0))) {
    throw new Error("Scholar will not replace an outline after assessments exist.");
  }
  const pageCount = book.metadata.pageCount;
  const built = buildOutlineChapters(chapters, pageCount);
  assertOutlineStructure(built, pageCount);

  const mutation = await mutateBook(book.id, (state) => {
    if (
      !isSetupActive(state)
      || state.instanceId !== book.instanceId
      || state.revision !== book.revision
      || state.outlineStatus === "ready"
    ) throw new Error("Scholar book setup changed while the outline was being prepared; restart setup from the current vault state.");
    if (
      state.exams.length > 0
      || state.tutorSessions.length > 0
      || state.chapters.some((chapter) => chapter.sections.some((section) => section.attempts.length > 0))
    ) throw new Error("Scholar will not replace an outline after learning or assessment records exist.");
    state.metadata = {
      ...state.metadata,
      ...(params.title?.trim() ? { title: params.title.trim() } : {}),
      ...(params.authors ? { authors: compactStrings(params.authors, 20) } : {}),
      ...(params.edition?.trim() ? { edition: params.edition.trim() } : {}),
      ...(params.isbn?.trim() ? { isbn: params.isbn.trim() } : {}),
    };
    state.chapters = built;
    state.outlineStatus = params.outlineConfidence === "verified" ? "pending" : "needs-review";
    state.currentSectionId = undefined;
    recomputeProgress(state);
  });
  resetValidation();
  if (isProvisionalOutline(mutation.book)) {
    const hydrated = await hydrateOutlineValidation(mutation.book);
    const result = await finishOutlineValidation(mutation.book, hydrated.run, hydrated.report);
    const validationBody = result.content[0]?.type === "text" ? result.content[0].text : result.details.summary;
    result.details.action = "outline";
    result.details.summary = hydrated.report.status === "ready"
      ? `Outline saved and validated · ${mutation.book.chapters.length} chapters · ${allSections(mutation.book).length} sections`
      : `Outline saved · ${mutation.book.chapters.length} chapters · ${allSections(mutation.book).length} sections · ${result.details.summary}`;
    result.content[0] = {
      type: "text",
      text: `${hydrated.report.status === "ready" ? "Saved and validated" : "Saved"} an outline with ${mutation.book.chapters.length} chapters and ${allSections(mutation.book).length} sections. ${validationBody}`,
    };
    return result;
  }
  return toolResult(
    "outline",
    "Saved the provisional outline as needs-review; correct the disputed headings or boundaries and submit one complete replacement outline before teaching.",
    { bookId: mutation.book.id, outlineRevision: mutation.book.revision, tone: "review" },
  );
}

export async function handleOutlineValidate(
  book: ScholarBook,
  outlineRevision: number | undefined,
  validationChecks: unknown[] | undefined,
  hydrateOutlineValidation: (book: ScholarBook) => Promise<{ run: OutlineValidationRun; report: OutlineValidationReport }>,
  finishOutlineValidation: (book: ScholarBook, run: OutlineValidationRun, report: OutlineValidationReport) => Promise<{ content: Array<{ type: "text"; text: string }>; details: ToolDetails }>,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: ToolDetails }> {
  if (!isProvisionalOutline(book)) {
    throw new Error(`Scholar has no provisional outline awaiting validation (current status: ${book.outlineStatus}).`);
  }
  if (!Number.isSafeInteger(outlineRevision) || outlineRevision! < 0) {
    throw new Error("Scholar outline validation requires the provisional outlineRevision returned by the outline call.");
  }
  if (outlineRevision !== book.revision) {
    throw new Error(`Stale outline validation revision ${outlineRevision}; the current provisional outline is revision ${book.revision}.`);
  }
  assertOutlineStructure(book.chapters, book.metadata.pageCount);
  const hydrated = await hydrateOutlineValidation(book);
  const decisions = (validationChecks || []) as OutlineValidationDecisionInput[];
  const report = decisions.length
    ? evaluateOutlineValidationDecisions(book, hydrated.run, decisions)
    : hydrated.report;
  return finishOutlineValidation(book, hydrated.run, report);
}
