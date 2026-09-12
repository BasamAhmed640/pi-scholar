export const SCHOLAR_SCHEMA_VERSION = 3 as const;

export type OutlineStatus = "pending" | "ready" | "needs-review" | "needs-ocr";
export type SectionStatus = "not-started" | "learning" | "review" | "complete";
export type ScholarMode = "learn" | "exam" | "tutor";
export type AssessmentKind = "conceptual" | "application" | "computation" | "discrimination" | "quiz";
export type AssessmentOutcome = "pending" | "pass" | "review" | "unsure" | "cancelled" | "unavailable";
export type TranscriptEntryKind = "assistant" | "question" | "result";
export type ExamQuestionFormat = "multiple-choice" | "open";
export type ExamStatus = "draft" | "active" | "submitted" | "graded";
export type ExamItemOutcome = "correct" | "partial" | "incorrect" | "unanswered";
export type TutorSessionStatus = "active" | "closed";

export type QuestionPurpose = "diagnostic" | "practice" | "mastery";

export type QuestionBasis = {
  /** Exact durable objective/key point, or an explicitly declared prerequisite. */
  kind: "objective" | "key-point" | "prerequisite";
  value: string;
  /** One-based indexes into QuestionGrounding.requiredEvidence. */
  supports: number[];
  /** Required only for prerequisites; ordinary means general prior knowledge. */
  prerequisiteBasis?: "ordinary" | "source-declared";
  /** Required for source-declared prerequisites and forbidden otherwise. */
  sourcePage?: number;
};

/**
 * Compact, durable proof that a question is fair without constraining its rigor.
 * It records claims and locators—not copied source text or an answer key.
 */
export type QuestionGrounding = {
  purpose: QuestionPurpose;
  competency: string;
  requiredEvidence: string[];
  sourcePages: number[];
  basis: QuestionBasis[];
};

export type SourceFingerprint = {
  sha256: string;
  size: number;
  mtimeMs: number;
};

export type BookCandidate = {
  catalogKey: string;
  absolutePath: string;
  relativePath: string;
  fileName: string;
  displayTitle: string;
  format: "pdf";
  size: number;
  mtimeMs: number;
};

export type BookMetadata = {
  title: string;
  authors: string[];
  edition?: string;
  isbn?: string;
  pageCount?: number;
};

export type AssessmentAttempt = {
  id: string;
  toolCallId?: string;
  /** Additional deliveries of the same unanswered question, never new attempts. */
  resumeToolCallIds?: string[];
  /** Frozen same-note form, including the original display order and grading key. */
  quiz?: import("./quiz-contract.ts").FrozenScholarQuiz;
  kind: AssessmentKind;
  format: "open" | "multiple-choice";
  question: string;
  options?: string[];
  mode?: "single-select" | "multi-select";
  note?: string;
  difficulty?: string;
  grounding?: QuestionGrounding;
  outcome: AssessmentOutcome;
  answerSummary?: string;
  /** Verified displayed answer key, retained only after a multiple-choice response is submitted. */
  correctAnswer?: string;
  feedback?: string;
  openAssessment?: import("./open-assessment.ts").OpenAssessmentContract;
  submission?: import("./open-assessment.ts").OpenAssessmentSubmission;
  evaluation?: import("./open-assessment.ts").OpenAssessmentEvaluation;
  createdAt: string;
};

/**
 * A durable, ordered projection of assistant-authored learning activity.
 * User chat is deliberately not copied here; answers remain in attempts or
 * private exam responses.
 */
export type TranscriptEntry = {
  id: string;
  kind: TranscriptEntryKind;
  markdown: string;
  createdAt: string;
  /** Associations only; the instructional text exists once, in this visible entry. */
  lesson?: import("./lesson.ts").LessonReceipt;
};

export type ScholarSnapshot = {
  id: string;
  page: number;
  crop: {
    x: number;
    y: number;
    width: number;
    height: number;
    canvasWidth: number;
    canvasHeight: number;
  };
  assetFile: string;
  sha256: string;
  caption: string;
  createdAt: string;
};

export type FigurePageReview = {
  page: number;
  observation: string;
  figures: Array<{ label: string; snapshotId?: string; skipReason?: string }>;
};

export type FigureCoveragePage = {
  page: number;
  read: boolean;
  viewed?: { width: number; height: number };
  candidates: string[];
  review?: FigurePageReview;
};

export type FigureCoverage = {
  pages: FigureCoveragePage[];
  boundaryChecked?: number;
};

/**
 * A deliberately selected, freely licensed visual reference. Web images are
 * presentation aids only: the active PDF remains Scholar's content authority.
 */
export type ScholarReferenceImage = {
  id: string;
  source: "wikimedia-commons";
  pageId: number;
  title: string;
  assetFile: string;
  sha256: string;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  caption: string;
  artist: string;
  license: string;
  licenseUrl?: string;
  sourceUrl: string;
  createdAt: string;
};

export type ScholarSection = {
  id: string;
  order: number;
  number?: string;
  title: string;
  startPage: number;
  endPage: number;
  objectives: string[];
  coveredObjectives: string[];
  requiredChecks: AssessmentKind[];
  status: SectionStatus;
  synthesis?: string;
  keyPoints: string[];
  misconceptions: string[];
  attempts: AssessmentAttempt[];
  transcript: TranscriptEntry[];
  snapshots?: ScholarSnapshot[];
  figureCoverage?: FigureCoverage;
  lessonCommit?: import("./lesson.ts").LessonCommit;
  /** IDs only, so a retry cannot restore a lesson entry deleted from this note. */
  lessonEntryIds?: string[];
  /** Preserves completion earned before explicit instructional delivery was required. */
  legacyLessonCompletion?: true;
  objectiveChecks?: import("./lesson.ts").ObjectiveCheck[];
  /**
   * Set only by migration, on a section that was already complete under the
   * pre-grounding rule where an ungrounded attempt could certify mastery.
   * It grandfathers finished work; it never lets new work skip the gate, and
   * it is cleared as soon as the section earns completion under the current
   * rule. Absent on every section created since grounding became mandatory.
   */
  legacyCompletion?: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ScholarChapter = {
  id: string;
  order: number;
  number?: string;
  title: string;
  startPage: number;
  endPage: number;
  status: SectionStatus;
  sections: ScholarSection[];
};

export type ScholarScope = {
  /** Frozen chapter identities captured when an exam or tutor session starts. */
  chapterIds: string[];
  /** Frozen section identities captured when an exam or tutor session starts. */
  sectionIds: string[];
  description: string;
};

export type ExamOption = {
  /** Stable value used for storage and grading; labels may be reworded. */
  value: string;
  label: string;
  misconception?: string;
};

export type ExamRubricCriterion = {
  id: string;
  criterion: string;
  requiredEvidence: string[];
  points: number;
};

/** A source-grounded assessment item and its complete grading contract. */
export type ExamQuestion = {
  id: string;
  sectionIds: string[];
  claim: string;
  requiredEvidence: string[];
  dimensions: string[];
  format: ExamQuestionFormat;
  prompt: string;
  options?: ExamOption[];
  correctAnswer?: string | string[];
  rubric?: ExamRubricCriterion[];
  explanation: string;
  maxPoints: number;
};

/** Submitted learner input retained in the visible exam record; later paper edits cannot change it. */
export type ExamRawResponse = {
  questionId: string;
  response: string | string[];
};

/** Derived grading evidence for one frozen exam question. */
export type ExamItemResult = {
  questionId: string;
  outcome: ExamItemOutcome;
  earnedPoints: number;
  maxPoints: number;
  feedback: string;
  diagnosticSummary?: string;
  firstDecisiveError?: string;
  correctReasoning?: string;
  transferableLesson?: string;
};

/** Derived aggregation for one scored facet, such as a section or competency. */
export type ExamBreakdown = {
  key: string;
  label: string;
  earnedPoints: number;
  maxPoints: number;
  percent: number;
};

export type ScholarExam = {
  id: string;
  title: string;
  scope: ScholarScope;
  status: ExamStatus;
  questions: ExamQuestion[];
  rawResponses: ExamRawResponse[];
  itemResults: ExamItemResult[];
  breakdown: ExamBreakdown[];
  earnedPoints: number;
  maxPoints: number;
  percent: number;
  transcript: TranscriptEntry[];
  images?: ScholarReferenceImage[];
  /** Exact PDF crops owned by this exam and frozen when its draft is built. */
  snapshots?: ScholarSnapshot[];
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  submittedAt?: string;
  gradedAt?: string;
};

export type TutorSession = {
  lessonEntryIds?: string[];
  id: string;
  title: string;
  scope: ScholarScope;
  status: TutorSessionStatus;
  synthesis?: string;
  keyPoints: string[];
  attempts: AssessmentAttempt[];
  transcript: TranscriptEntry[];
  images?: ScholarReferenceImage[];
  /** Exact PDF crops owned by this Tutor session, independent of Learn. */
  snapshots?: ScholarSnapshot[];
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
};

export type ScholarRecoveryCheckpoint = {
  lastProcessedEntryId: string;
  activationEntryId?: string;
  sessionId?: string;
  updatedAt: string;
};

export type ScholarBook = {
  schemaVersion: typeof SCHOLAR_SCHEMA_VERSION;
  revision: number;
  id: string;
  /** Distinguishes a fresh import from a deleted prior import of the same PDF. */
  instanceId: string;
  source: {
    absolutePath: string;
    relativePath: string;
    fileName: string;
    format: "pdf";
    fingerprint: SourceFingerprint;
  };
  metadata: BookMetadata;
  outlineStatus: OutlineStatus;
  chapters: ScholarChapter[];
  currentSectionId?: string;
  exams: ScholarExam[];
  currentExamId?: string;
  tutorSessions: TutorSession[];
  currentTutorId?: string;
  recoveryCheckpoints?: Record<string, ScholarRecoveryCheckpoint>;
  noteDirectory: string;
  createdAt: string;
  updatedAt: string;
};

export type ScholarConfig = {
  schemaVersion: typeof SCHOLAR_SCHEMA_VERSION;
  libraryRoot: string;
  obsidianRoot: string;
  stateRoot: string;
  currentBookId?: string;
  updatedAt: string;
};

export type CatalogEntry = {
  relativePath: string;
  bookId: string;
  size: number;
  mtimeMs: number;
};

export type ScholarCatalog = {
  schemaVersion: typeof SCHOLAR_SCHEMA_VERSION;
  entries: CatalogEntry[];
  /** Vault-local convenience pointers. Neither one can create a missing book. */
  libraryRoot?: string;
  currentBookId?: string;
};

export type SourceSearchHit = {
  page: number;
  snippet: string;
};

export function allSections(book: ScholarBook): ScholarSection[] {
  return book.chapters.flatMap((chapter) => chapter.sections);
}

export function findSection(book: ScholarBook, sectionId: string | undefined): ScholarSection | undefined {
  if (!sectionId) return undefined;
  return allSections(book).find((section) => section.id === sectionId);
}

export function findChapterForSection(book: ScholarBook, sectionId: string | undefined): ScholarChapter | undefined {
  if (!sectionId) return undefined;
  return book.chapters.find((chapter) => chapter.sections.some((section) => section.id === sectionId));
}

export function deriveStatus(sections: ScholarSection[]): SectionStatus {
  if (sections.length > 0 && sections.every((section) => section.status === "complete")) return "complete";
  if (sections.some((section) => section.status === "review")) return "review";
  if (sections.some((section) => section.status !== "not-started")) return "learning";
  return "not-started";
}
