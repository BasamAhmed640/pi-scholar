import { basename, extname, isAbsolute } from "node:path";
import { isQuestionGrounding } from "./question-grounding.ts";
import { isFrozenScholarQuiz } from "./quiz-contract.ts";
import { pageInRanges, scopedPageRanges } from "./page-scope.ts";

import {
  SCHOLAR_SCHEMA_VERSION,
  type AssessmentAttempt,
  type CatalogEntry,
  type ExamBreakdown,
  type ExamItemResult,
  type ExamOption,
  type ExamQuestion,
  type ExamRawResponse,
  type ExamRubricCriterion,
  type ScholarBook,
  type ScholarCatalog,
  type ScholarChapter,
  type ScholarExam,
  type ScholarRecoveryCheckpoint,
  type ScholarReferenceImage,
  type ScholarScope,
  type ScholarSection,
  type ScholarSnapshot,
  type TranscriptEntry,
  type TutorSession,
} from "./types.ts";

const VISIBLE_BOOKS_FOLDER = "Books";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: JsonRecord, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStableId(value: unknown): value is string {
  return typeof value === "string" && value === value.trim() && value.length > 0 && value.length <= 200 &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

export function isBookId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f\d]{64}$/.test(value);
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isStringArray(value: unknown, options: { nonEmpty?: boolean; unique?: boolean } = {}): value is string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && (!options.nonEmpty || item.trim()))) {
    return false;
  }
  return !options.unique || new Set(value).size === value.length;
}

function hasUniqueIds<T extends { id: string }>(items: T[]): boolean {
  return new Set(items.map((item) => item.id)).size === items.length;
}

function approximatelyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-7 * Math.max(1, Math.abs(left), Math.abs(right));
}

function isDerivedPercent(percent: unknown, earnedPoints: number, maxPoints: number): percent is number {
  if (!isFiniteNumber(percent) || percent < 0 || percent > 100) return false;
  const expected = maxPoints === 0 ? 0 : (earnedPoints / maxPoints) * 100;
  // Stored reports intentionally round display percentages to one decimal.
  return approximatelyEqual(percent, expected) || Math.abs(percent - expected) <= 0.051;
}

function isSafeStoredRelativePath(value: string): boolean {
  if (!value.trim() || isAbsolute(value)) return false;
  const parts = value.split(/[\\/]+/);
  return parts.every((part) => part !== "" && part !== "." && part !== "..");
}

export function bookDirectorySegment(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim() || isAbsolute(value)) return undefined;
  const rawParts = value.split(/[\\/]+/).filter(Boolean);
  const parts = rawParts[0]?.toLowerCase() === VISIBLE_BOOKS_FOLDER.toLowerCase()
    ? rawParts.slice(1)
    : rawParts;
  if (parts.length !== 1) return undefined;
  const segment = parts[0]!;
  const deviceStem = segment.split(".", 1)[0]!.trimEnd();
  if (
    segment === "."
    || segment === ".."
    || segment !== segment.trim()
    || segment.startsWith(".")
    || /[. ]$/.test(segment)
    || basename(segment) !== segment
    || /[\\/:*?"<>|\u0000-\u001f]/.test(segment)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(deviceStem)
  ) return undefined;
  return segment;
}

function isStatus(value: unknown): boolean {
  return value === "not-started" || value === "learning" || value === "review" || value === "complete";
}

function isAssessmentKind(value: unknown): boolean {
  return (
    value === "conceptual" ||
    value === "application" ||
    value === "computation" ||
    value === "discrimination" ||
    value === "quiz"
  );
}

function isAttempt(value: unknown): value is AssessmentAttempt {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(
    value,
    ["id", "kind", "format", "question", "outcome", "createdAt"],
    ["toolCallId", "resumeToolCallIds", "quiz", "options", "mode", "note", "difficulty", "grounding", "answerSummary", "correctAnswer", "feedback"],
  )) return false;
  const common = (
    isStableId(value.id) &&
    (value.toolCallId === undefined || isNonEmptyString(value.toolCallId)) &&
    (value.resumeToolCallIds === undefined || isStringArray(value.resumeToolCallIds, { nonEmpty: true, unique: true })) &&
    (value.quiz === undefined || (value.format === "multiple-choice" && isFrozenScholarQuiz(value.quiz)
      && value.quiz.question === value.question && value.quiz.mode === value.mode
      && JSON.stringify(value.options) === JSON.stringify(value.quiz.options.map((option) => option.label)))) &&
    isAssessmentKind(value.kind) &&
    (value.format === "open" || value.format === "multiple-choice") &&
    isNonEmptyString(value.question) &&
    (value.options === undefined || isStringArray(value.options, { nonEmpty: true, unique: true })) &&
    (value.mode === undefined || value.mode === "single-select" || value.mode === "multi-select") &&
    (value.note === undefined || typeof value.note === "string") &&
    (value.difficulty === undefined || typeof value.difficulty === "string") &&
    (value.grounding === undefined || isQuestionGrounding(value.grounding)) &&
    (value.outcome === "pending" ||
      value.outcome === "pass" ||
      value.outcome === "review" ||
      value.outcome === "unsure" ||
      value.outcome === "cancelled" ||
      value.outcome === "unavailable") &&
    (value.answerSummary === undefined || typeof value.answerSummary === "string") &&
    (value.correctAnswer === undefined || (isNonEmptyString(value.correctAnswer)
      && value.format === "multiple-choice"
      && (value.outcome === "pass" || value.outcome === "review" || value.outcome === "unsure"))) &&
    (value.feedback === undefined || typeof value.feedback === "string") &&
    isTimestamp(value.createdAt)
  );
  if (!common) return false;
  return true;
}

function isTranscriptEntry(value: unknown): value is TranscriptEntry {
  return isRecord(value) &&
    hasOnlyKeys(value, ["id", "kind", "markdown", "createdAt"]) &&
    isStableId(value.id) &&
    (value.kind === "assistant" || value.kind === "question" || value.kind === "result") &&
    isNonEmptyString(value.markdown) &&
    isTimestamp(value.createdAt);
}

function isTranscript(value: unknown): value is TranscriptEntry[] {
  return Array.isArray(value) && value.every(isTranscriptEntry) && hasUniqueIds(value);
}

function isSnapshot(value: unknown): value is ScholarSnapshot {
  if (!isRecord(value) || !isRecord(value.crop)) return false;
  const crop = value.crop;
  return (
    hasOnlyKeys(value, ["id", "page", "crop", "assetFile", "sha256", "caption", "createdAt"]) &&
    hasOnlyKeys(crop, ["x", "y", "width", "height", "canvasWidth", "canvasHeight"]) &&
    typeof value.id === "string" && /^snapshot-[a-f\d]{16}$/i.test(value.id) &&
    isNonNegativeInteger(value.page) && value.page >= 1 &&
    isNonNegativeInteger(crop.x) &&
    isNonNegativeInteger(crop.y) &&
    isNonNegativeInteger(crop.width) && crop.width >= 32 &&
    isNonNegativeInteger(crop.height) && crop.height >= 32 &&
    isNonNegativeInteger(crop.canvasWidth) && crop.canvasWidth >= 32 &&
    isNonNegativeInteger(crop.canvasHeight) && crop.canvasHeight >= 32 &&
    crop.x + crop.width <= crop.canvasWidth &&
    crop.y + crop.height <= crop.canvasHeight &&
    typeof value.assetFile === "string" &&
    basename(value.assetFile) === value.assetFile &&
    /^p\d{4,}-snapshot-[a-f\d]{16}\.png$/i.test(value.assetFile) &&
    typeof value.sha256 === "string" && /^[a-f\d]{64}$/i.test(value.sha256) &&
    typeof value.caption === "string" && value.caption.length > 0 && value.caption.length <= 500 &&
    !/[\r\n]/.test(value.caption) &&
    isTimestamp(value.createdAt)
  );
}

function isSnapshotArray(value: unknown): value is ScholarSnapshot[] {
  if (!Array.isArray(value) || !value.every(isSnapshot)) return false;
  return new Set(value.map((snapshot) => snapshot.id)).size === value.length;
}

function isBoundedReviewText(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value === value.trim() && value.length >= minimum && value.length <= maximum;
}

function isFigureCoverage(value: unknown, startPage: number, endPage: number, snapshots: ScholarSnapshot[] = []): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ["pages"], ["boundaryChecked"]) || !Array.isArray(value.pages)) return false;
  if (value.boundaryChecked !== undefined && (!isNonNegativeInteger(value.boundaryChecked)
    || value.boundaryChecked < startPage || value.boundaryChecked > endPage)) return false;
  const pages = new Set<number>();
  for (const entry of value.pages) {
    if (!isRecord(entry) || !hasOnlyKeys(entry, ["page", "read", "candidates"], ["viewed", "review"])
      || !isNonNegativeInteger(entry.page) || entry.page < startPage || entry.page > endPage || pages.has(entry.page)
      || typeof entry.read !== "boolean" || !isStringArray(entry.candidates, { nonEmpty: true, unique: true })
      || !entry.candidates.every((label) => isBoundedReviewText(label, 1, 160))) return false;
    pages.add(entry.page);
    if (entry.viewed !== undefined && (!isRecord(entry.viewed) || !hasOnlyKeys(entry.viewed, ["width", "height"])
      || !isNonNegativeInteger(entry.viewed.width) || entry.viewed.width < 1
      || !isNonNegativeInteger(entry.viewed.height) || entry.viewed.height < 1)) return false;
    if (entry.review === undefined) continue;
    const review = entry.review;
    if (!entry.read || !entry.viewed || !isRecord(review) || !hasOnlyKeys(review, ["page", "observation", "figures"])
      || review.page !== entry.page || !isBoundedReviewText(review.observation, 12, 500)
      || !Array.isArray(review.figures) || review.figures.length > 40) return false;
    const labels = new Set<string>();
    for (const figure of review.figures) {
      if (!isRecord(figure) || !hasOnlyKeys(figure, ["label"], ["snapshotId", "skipReason"])
        || !isBoundedReviewText(figure.label, 1, 160) || labels.has(figure.label)
        || (figure.snapshotId === undefined) === (figure.skipReason === undefined)) return false;
      labels.add(figure.label);
      if (figure.snapshotId !== undefined && (!isStableId(figure.snapshotId)
        || !snapshots.some((snapshot) => snapshot.id === figure.snapshotId && snapshot.page === entry.page))) return false;
      if (figure.skipReason !== undefined && !isBoundedReviewText(figure.skipReason, 20, 500)) return false;
    }
    if (entry.candidates.some((label) => !labels.has(label))) return false;
  }
  return true;
}

function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isReferenceImage(value: unknown): value is ScholarReferenceImage {
  if (!isRecord(value) || !hasOnlyKeys(
    value,
    [
      "id", "source", "pageId", "title", "assetFile", "sha256", "mimeType", "width", "height",
      "caption", "artist", "license", "sourceUrl", "createdAt",
    ],
    ["licenseUrl"],
  )) return false;
  const expectedExtension = value.mimeType === "image/png" ? "png"
    : value.mimeType === "image/jpeg" ? "jpg"
    : undefined;
  return (
    typeof value.id === "string" && /^reference-[a-f\d]{16}$/i.test(value.id) &&
    value.source === "wikimedia-commons" &&
    isNonNegativeInteger(value.pageId) && value.pageId >= 1 &&
    isNonEmptyString(value.title) && value.title.length <= 300 && !/[\r\n]/.test(value.title) &&
    typeof value.assetFile === "string" && basename(value.assetFile) === value.assetFile &&
    Boolean(expectedExtension) &&
    value.assetFile === `commons-${value.pageId}-${value.id.slice("reference-".length)}.${expectedExtension}` &&
    typeof value.sha256 === "string" && /^[a-f\d]{64}$/i.test(value.sha256) &&
    isNonNegativeInteger(value.width) && value.width >= 1 &&
    isNonNegativeInteger(value.height) && value.height >= 1 &&
    isNonEmptyString(value.caption) && value.caption.length <= 500 && !/[\r\n]/.test(value.caption) &&
    isNonEmptyString(value.artist) && value.artist.length <= 300 && !/[\r\n]/.test(value.artist) &&
    isNonEmptyString(value.license) && value.license.length <= 120 && !/[\r\n]/.test(value.license) &&
    (value.licenseUrl === undefined || isHttpsUrl(value.licenseUrl)) &&
    typeof value.sourceUrl === "string" && /^https:\/\/commons\.wikimedia\.org\/\?curid=\d+$/i.test(value.sourceUrl) &&
    isTimestamp(value.createdAt)
  );
}

function isReferenceImageArray(value: unknown): value is ScholarReferenceImage[] {
  if (!Array.isArray(value) || !value.every(isReferenceImage)) return false;
  return new Set(value.map((image) => image.id)).size === value.length;
}

function isSection(value: unknown): value is ScholarSection {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(
    value,
    [
      "id", "order", "title", "startPage", "endPage", "objectives", "coveredObjectives",
      "requiredChecks", "status", "keyPoints", "misconceptions", "attempts", "transcript",
      "createdAt", "updatedAt",
    ],
    ["number", "synthesis", "snapshots", "figureCoverage", "legacyCompletion"],
  )) return false;
  const valid = (
    isStableId(value.id) &&
    isNonNegativeInteger(value.order) &&
    (value.number === undefined || isNonEmptyString(value.number)) &&
    isNonEmptyString(value.title) &&
    isNonNegativeInteger(value.startPage) && value.startPage >= 1 &&
    isNonNegativeInteger(value.endPage) && value.endPage >= value.startPage &&
    (value.legacyCompletion === undefined || value.legacyCompletion === true) &&
    isStringArray(value.objectives, { nonEmpty: true, unique: true }) &&
    isStringArray(value.coveredObjectives, { nonEmpty: true, unique: true }) &&
    Array.isArray(value.requiredChecks) &&
    value.requiredChecks.every(isAssessmentKind) && new Set(value.requiredChecks).size === value.requiredChecks.length &&
    isStatus(value.status) &&
    (value.synthesis === undefined || isNonEmptyString(value.synthesis)) &&
    isStringArray(value.keyPoints, { nonEmpty: true }) &&
    isStringArray(value.misconceptions, { nonEmpty: true }) &&
    Array.isArray(value.attempts) &&
    value.attempts.every(isAttempt) && hasUniqueIds(value.attempts) &&
    isTranscript(value.transcript) &&
    (value.snapshots === undefined || (
      isSnapshotArray(value.snapshots) &&
      value.snapshots.every((snapshot) => snapshot.page >= value.startPage && snapshot.page <= value.endPage)
    )) &&
    (value.figureCoverage === undefined || isFigureCoverage(value.figureCoverage, value.startPage, value.endPage, value.snapshots)) &&
    isTimestamp(value.createdAt) &&
    isTimestamp(value.updatedAt) &&
    Date.parse(value.createdAt) <= Date.parse(value.updatedAt)
  );
  if (!valid) return false;
  const objectiveSet = new Set(value.objectives);
  return value.coveredObjectives.every((objective) => objectiveSet.has(objective));
}

function isChapter(value: unknown): value is ScholarChapter {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(
    value,
    ["id", "order", "title", "startPage", "endPage", "status", "sections"],
    ["number"],
  )) return false;
  const valid = (
    isNonEmptyString(value.id) &&
    isNonNegativeInteger(value.order) &&
    (value.number === undefined || isNonEmptyString(value.number)) &&
    isNonEmptyString(value.title) &&
    isNonNegativeInteger(value.startPage) && value.startPage >= 1 &&
    isNonNegativeInteger(value.endPage) && value.endPage >= value.startPage &&
    isStatus(value.status) &&
    Array.isArray(value.sections) &&
    value.sections.every(isSection) &&
    hasUniqueIds(value.sections) &&
    new Set(value.sections.map((section) => section.order)).size === value.sections.length
  );
  if (!valid) return false;
  if (!value.sections.every((section) => section.startPage >= value.startPage && section.endPage <= value.endPage)) {
    return false;
  }
  // Sections may share a boundary page — two headings can begin on one page —
  // but may not otherwise overlap. assertOutlineStructure enforces this when an
  // outline is built; the stored schema must too, or a hand-edited or imported
  // book could carry overlapping ranges that double-count pages in every scope
  // and coverage calculation.
  const ordered = [...value.sections].sort((left, right) => left.startPage - right.startPage);
  return ordered.every((section, index) =>
    index === 0 || ordered[index - 1]!.endPage <= section.startPage
  );
}

function isScope(value: unknown): value is ScholarScope {
  return isRecord(value) &&
    hasOnlyKeys(value, ["chapterIds", "sectionIds", "description"]) &&
    isStringArray(value.chapterIds, { nonEmpty: true, unique: true }) &&
    value.chapterIds.every(isStableId) &&
    isStringArray(value.sectionIds, { nonEmpty: true, unique: true }) &&
    value.sectionIds.every(isStableId) &&
    isNonEmptyString(value.description);
}

function isExamOption(value: unknown): value is ExamOption {
  return isRecord(value) &&
    hasOnlyKeys(value, ["value", "label"], ["misconception"]) &&
    isStableId(value.value) &&
    isNonEmptyString(value.label) &&
    (value.misconception === undefined || isNonEmptyString(value.misconception));
}

function isRubricCriterion(value: unknown): value is ExamRubricCriterion {
  return isRecord(value) &&
    hasOnlyKeys(value, ["id", "criterion", "requiredEvidence", "points"]) &&
    isStableId(value.id) &&
    isNonEmptyString(value.criterion) &&
    isStringArray(value.requiredEvidence, { nonEmpty: true, unique: true }) &&
    value.requiredEvidence.length > 0 &&
    isPositiveNumber(value.points);
}

export function isExamQuestion(value: unknown): value is ExamQuestion {
  if (!isRecord(value) || !hasOnlyKeys(
    value,
    [
      "id", "sectionIds", "claim", "requiredEvidence", "dimensions", "format", "prompt",
      "explanation", "maxPoints",
    ],
    ["options", "correctAnswer", "rubric"],
  )) return false;
  const common = isStableId(value.id) &&
    isStringArray(value.sectionIds, { nonEmpty: true, unique: true }) &&
    value.sectionIds.length > 0 && value.sectionIds.every(isStableId) &&
    isNonEmptyString(value.claim) &&
    isStringArray(value.requiredEvidence, { nonEmpty: true, unique: true }) &&
    value.requiredEvidence.length > 0 &&
    isStringArray(value.dimensions, { nonEmpty: true, unique: true }) &&
    value.dimensions.length > 0 &&
    (value.format === "multiple-choice" || value.format === "open") &&
    isNonEmptyString(value.prompt) &&
    isNonEmptyString(value.explanation) &&
    isPositiveNumber(value.maxPoints);
  if (!common) return false;

  if (value.format === "multiple-choice") {
    if (!Array.isArray(value.options) || value.options.length < 2 || !value.options.every(isExamOption)) return false;
    const optionValues = value.options.map((option) => option.value);
    if (new Set(optionValues).size !== optionValues.length || value.rubric !== undefined) return false;
    const answers = typeof value.correctAnswer === "string"
      ? [value.correctAnswer]
      : Array.isArray(value.correctAnswer) ? value.correctAnswer : [];
    return answers.length > 0 && new Set(answers).size === answers.length &&
      answers.every((answer) => isStableId(answer) && optionValues.includes(answer));
  }

  if (value.options !== undefined || value.correctAnswer !== undefined || !Array.isArray(value.rubric)) return false;
  if (value.rubric.length === 0 || !value.rubric.every(isRubricCriterion) || !hasUniqueIds(value.rubric)) return false;
  return approximatelyEqual(
    value.rubric.reduce((total, criterion) => total + criterion.points, 0),
    value.maxPoints,
  );
}

function isRawResponse(value: unknown): value is ExamRawResponse {
  if (!isRecord(value) || !hasOnlyKeys(value, ["questionId", "response"]) || !isStableId(value.questionId)) {
    return false;
  }
  return typeof value.response === "string" || isStringArray(value.response);
}

function isItemResult(value: unknown): value is ExamItemResult {
  if (!isRecord(value) || !hasOnlyKeys(
    value,
    ["questionId", "outcome", "earnedPoints", "maxPoints", "feedback"],
    ["diagnosticSummary", "firstDecisiveError", "correctReasoning", "transferableLesson"],
  )) return false;
  if (!isStableId(value.questionId) ||
    (value.outcome !== "correct" && value.outcome !== "partial" && value.outcome !== "incorrect" && value.outcome !== "unanswered") ||
    !isFiniteNumber(value.earnedPoints) || value.earnedPoints < 0 ||
    !isPositiveNumber(value.maxPoints) || value.earnedPoints > value.maxPoints ||
    !isNonEmptyString(value.feedback) ||
    (value.diagnosticSummary !== undefined && !isNonEmptyString(value.diagnosticSummary)) ||
    (value.firstDecisiveError !== undefined && !isNonEmptyString(value.firstDecisiveError)) ||
    (value.correctReasoning !== undefined && !isNonEmptyString(value.correctReasoning)) ||
    (value.transferableLesson !== undefined && !isNonEmptyString(value.transferableLesson))) return false;
  if (value.outcome === "correct") return approximatelyEqual(value.earnedPoints, value.maxPoints);
  if (value.outcome === "partial") return value.earnedPoints > 0 && value.earnedPoints < value.maxPoints;
  return value.earnedPoints === 0;
}

function isBreakdown(value: unknown): value is ExamBreakdown {
  return isRecord(value) &&
    hasOnlyKeys(value, ["key", "label", "earnedPoints", "maxPoints", "percent"]) &&
    isStableId(value.key) &&
    isNonEmptyString(value.label) &&
    isFiniteNumber(value.earnedPoints) && value.earnedPoints >= 0 &&
    isPositiveNumber(value.maxPoints) && value.earnedPoints <= value.maxPoints &&
    isDerivedPercent(value.percent, value.earnedPoints, value.maxPoints);
}

function isScholarExam(value: unknown): value is ScholarExam {
  if (!isRecord(value) || !hasOnlyKeys(
    value,
    [
      "id", "title", "scope", "status", "questions", "rawResponses", "itemResults", "breakdown",
      "earnedPoints", "maxPoints", "percent", "transcript", "createdAt", "updatedAt",
    ],
    ["startedAt", "submittedAt", "gradedAt", "images", "snapshots"],
  )) return false;
  if (!isStableId(value.id) || !isNonEmptyString(value.title) || !isScope(value.scope) ||
    (value.status !== "draft" && value.status !== "active" && value.status !== "submitted" && value.status !== "graded") ||
    !Array.isArray(value.questions) || !value.questions.every(isExamQuestion) || !hasUniqueIds(value.questions) ||
    !Array.isArray(value.rawResponses) || !value.rawResponses.every(isRawResponse) ||
    new Set(value.rawResponses.map((response) => response.questionId)).size !== value.rawResponses.length ||
    !Array.isArray(value.itemResults) || !value.itemResults.every(isItemResult) ||
    new Set(value.itemResults.map((result) => result.questionId)).size !== value.itemResults.length ||
    !Array.isArray(value.breakdown) || !value.breakdown.every(isBreakdown) ||
    new Set(value.breakdown.map((entry) => entry.key)).size !== value.breakdown.length ||
    !isFiniteNumber(value.earnedPoints) || value.earnedPoints < 0 ||
    !isFiniteNumber(value.maxPoints) || value.maxPoints < 0 || value.earnedPoints > value.maxPoints ||
    !isDerivedPercent(value.percent, value.earnedPoints, value.maxPoints) ||
    !isTranscript(value.transcript) ||
    (value.images !== undefined && !isReferenceImageArray(value.images)) ||
    (value.snapshots !== undefined && !isSnapshotArray(value.snapshots)) ||
    !isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt) ||
    Date.parse(value.createdAt) > Date.parse(value.updatedAt) ||
    (value.startedAt !== undefined && !isTimestamp(value.startedAt)) ||
    (value.submittedAt !== undefined && !isTimestamp(value.submittedAt)) ||
    (value.gradedAt !== undefined && !isTimestamp(value.gradedAt))) return false;

  if (value.status !== "draft" && value.questions.length === 0) return false;
  if (value.scope.sectionIds.length === 0) return false;
  const questionById = new Map(value.questions.map((question) => [question.id, question]));
  const scopeSectionIds = new Set(value.scope.sectionIds);
  if (value.questions.some((question) => question.sectionIds.some((id) => !scopeSectionIds.has(id)))) return false;
  if (value.rawResponses.some((response) => !questionById.has(response.questionId))) return false;
  if (value.itemResults.some((result) => {
    const question = questionById.get(result.questionId);
    return !question || !approximatelyEqual(question.maxPoints, result.maxPoints);
  })) return false;

  const expectedMax = value.questions.reduce((total, question) => total + question.maxPoints, 0);
  if (!approximatelyEqual(value.maxPoints, expectedMax)) return false;
  const created = Date.parse(value.createdAt);
  const started = value.startedAt === undefined ? undefined : Date.parse(value.startedAt);
  const submitted = value.submittedAt === undefined ? undefined : Date.parse(value.submittedAt);
  const graded = value.gradedAt === undefined ? undefined : Date.parse(value.gradedAt);
  if ((started !== undefined && started < created) ||
    (submitted !== undefined && (started === undefined || submitted < started)) ||
    (graded !== undefined && (submitted === undefined || graded < submitted)) ||
    (started !== undefined && started > Date.parse(value.updatedAt)) ||
    (submitted !== undefined && submitted > Date.parse(value.updatedAt)) ||
    (graded !== undefined && graded > Date.parse(value.updatedAt))) return false;

  if (value.status === "draft") {
    return started === undefined && submitted === undefined && graded === undefined &&
      value.rawResponses.length === 0 && value.itemResults.length === 0 &&
      value.breakdown.length === 0 && value.earnedPoints === 0;
  }
  if (value.status === "active") {
    return started !== undefined && submitted === undefined && graded === undefined &&
      value.rawResponses.length === 0 && value.itemResults.length === 0 &&
      value.breakdown.length === 0 && value.earnedPoints === 0;
  }
  if (value.status === "submitted") {
    return started !== undefined && submitted !== undefined && graded === undefined &&
      value.rawResponses.length === value.questions.length && value.itemResults.length === 0 &&
      value.breakdown.length === 0 && value.earnedPoints === 0;
  }

  const resultEarned = value.itemResults.reduce((total, result) => total + result.earnedPoints, 0);
  return started !== undefined && submitted !== undefined && graded !== undefined &&
    value.rawResponses.length === value.questions.length &&
    value.itemResults.length === value.questions.length && value.breakdown.length > 0 &&
    approximatelyEqual(resultEarned, value.earnedPoints);
}

function isTutorSession(value: unknown): value is TutorSession {
  if (!isRecord(value) || !hasOnlyKeys(
    value,
    ["id", "title", "scope", "status", "keyPoints", "attempts", "transcript", "createdAt", "updatedAt"],
    ["synthesis", "closedAt", "images", "snapshots"],
  )) return false;
  const valid = isStableId(value.id) &&
    isNonEmptyString(value.title) &&
    isScope(value.scope) &&
    (value.status === "active" || value.status === "closed") &&
    (value.synthesis === undefined || isNonEmptyString(value.synthesis)) &&
    isStringArray(value.keyPoints, { nonEmpty: true }) &&
    Array.isArray(value.attempts) && value.attempts.every(isAttempt) && hasUniqueIds(value.attempts) &&
    isTranscript(value.transcript) &&
    (value.images === undefined || isReferenceImageArray(value.images)) &&
    (value.snapshots === undefined || isSnapshotArray(value.snapshots)) &&
    isTimestamp(value.createdAt) && isTimestamp(value.updatedAt) &&
    Date.parse(value.createdAt) <= Date.parse(value.updatedAt) &&
    (value.closedAt === undefined || isTimestamp(value.closedAt));
  if (!valid) return false;
  if (value.status === "active") return value.closedAt === undefined;
  return value.closedAt !== undefined &&
    Date.parse(value.closedAt) >= Date.parse(value.createdAt) &&
    Date.parse(value.closedAt) <= Date.parse(value.updatedAt);
}

/**
 * Chapters may share a boundary page, like sections, but may not otherwise
 * overlap. assertOutlineStructure enforces this when an outline is built; the
 * stored schema must agree, or an imported or hand-edited book could double
 * count pages in every scope and coverage calculation.
 */
function chaptersDoNotOverlap(chapters: ScholarChapter[]): boolean {
  const ordered = [...chapters].sort((left, right) => left.startPage - right.startPage);
  return ordered.every((chapter, index) => index === 0 || ordered[index - 1]!.endPage <= chapter.startPage);
}

function isRecoveryCheckpoints(value: unknown): value is Record<string, ScholarRecoveryCheckpoint> {
  if (!isRecord(value)) return false;
  return Object.entries(value).every(
    ([key, cp]) =>
      typeof key === "string" &&
      key.length > 0 &&
      isRecord(cp) &&
      hasOnlyKeys(cp, ["lastProcessedEntryId", "updatedAt"], ["activationEntryId", "sessionId"]) &&
      typeof cp.lastProcessedEntryId === "string" &&
      cp.lastProcessedEntryId.length > 0 &&
      (cp.activationEntryId === undefined || (typeof cp.activationEntryId === "string" && cp.activationEntryId.length > 0)) &&
      (cp.sessionId === undefined || (typeof cp.sessionId === "string" && cp.sessionId.length > 0)) &&
      isTimestamp(cp.updatedAt),
  );
}

export function isScholarBook(value: unknown): value is ScholarBook {
  if (!isRecord(value) || !isRecord(value.source) || !isRecord(value.source.fingerprint) || !isRecord(value.metadata)) {
    return false;
  }
  const source = value.source;
  const fingerprint = source.fingerprint;
  const metadata = value.metadata;
  if (!hasOnlyKeys(
    value,
    [
      "schemaVersion", "revision", "id", "instanceId", "source", "metadata", "outlineStatus", "chapters", "exams",
      "tutorSessions", "noteDirectory", "createdAt", "updatedAt",
    ],
    ["currentSectionId", "currentExamId", "currentTutorId", "recoveryCheckpoints"],
  ) ||
    !hasOnlyKeys(source, ["absolutePath", "relativePath", "fileName", "format", "fingerprint"]) ||
    !hasOnlyKeys(fingerprint, ["sha256", "size", "mtimeMs"]) ||
    !hasOnlyKeys(metadata, ["title", "authors"], ["edition", "isbn", "pageCount"])) return false;
  const valid = (
    value.schemaVersion === SCHOLAR_SCHEMA_VERSION &&
    isNonNegativeInteger(value.revision) &&
    isBookId(value.id) &&
    isStableId(value.instanceId) &&
    typeof source.absolutePath === "string" && isAbsolute(source.absolutePath) &&
    typeof source.relativePath === "string" &&
    isSafeStoredRelativePath(source.relativePath) &&
    typeof source.fileName === "string" && basename(source.fileName) === source.fileName &&
    source.format === "pdf" &&
    extname(source.fileName).toLocaleLowerCase("en-US") === ".pdf" &&
    extname(source.relativePath).toLocaleLowerCase("en-US") === ".pdf" &&
    isBookId(fingerprint.sha256) &&
    value.id === fingerprint.sha256 &&
    isFiniteNumber(fingerprint.size) && fingerprint.size >= 0 &&
    isFiniteNumber(fingerprint.mtimeMs) && fingerprint.mtimeMs >= 0 &&
    isNonEmptyString(metadata.title) &&
    isStringArray(metadata.authors, { nonEmpty: true, unique: true }) &&
    (metadata.edition === undefined || isNonEmptyString(metadata.edition)) &&
    (metadata.isbn === undefined || isNonEmptyString(metadata.isbn)) &&
    (metadata.pageCount === undefined || (isNonNegativeInteger(metadata.pageCount) && metadata.pageCount > 0)) &&
    (value.outlineStatus === "pending" ||
      value.outlineStatus === "ready" ||
      value.outlineStatus === "needs-review" ||
      value.outlineStatus === "needs-ocr") &&
    Array.isArray(value.chapters) &&
    value.chapters.every(isChapter) && hasUniqueIds(value.chapters) &&
    chaptersDoNotOverlap(value.chapters) &&
    new Set(value.chapters.map((chapter) => chapter.order)).size === value.chapters.length &&
    (value.currentSectionId === undefined || isNonEmptyString(value.currentSectionId)) &&
    Array.isArray(value.exams) && value.exams.every(isScholarExam) && hasUniqueIds(value.exams) &&
    (value.currentExamId === undefined || isStableId(value.currentExamId)) &&
    Array.isArray(value.tutorSessions) && value.tutorSessions.every(isTutorSession) && hasUniqueIds(value.tutorSessions) &&
    (value.currentTutorId === undefined || isStableId(value.currentTutorId)) &&
    (value.recoveryCheckpoints === undefined || isRecoveryCheckpoints(value.recoveryCheckpoints)) &&
    bookDirectorySegment(value.noteDirectory) !== undefined &&
    isTimestamp(value.createdAt) && isTimestamp(value.updatedAt) &&
    Date.parse(value.createdAt) <= Date.parse(value.updatedAt)
  );
  if (!valid) return false;

  const chapterIds = new Set(value.chapters.map((chapter) => chapter.id));
  const sections = value.chapters.flatMap((chapter) => chapter.sections);
  const sectionIds = new Set(sections.map((section) => section.id));
  if (sectionIds.size !== sections.length ||
    (value.currentSectionId !== undefined && !sectionIds.has(value.currentSectionId)) ||
    (value.currentExamId !== undefined && !value.exams.some((exam) => exam.id === value.currentExamId)) ||
    (value.currentTutorId !== undefined && !value.tutorSessions.some((session) => session.id === value.currentTutorId))) {
    return false;
  }
  const scopesAreValid = [...value.exams, ...value.tutorSessions].every((entry) =>
    entry.scope.chapterIds.every((id) => chapterIds.has(id)) &&
    entry.scope.sectionIds.every((id) => sectionIds.has(id))
  );
  if (!scopesAreValid || value.exams.some((exam) =>
    exam.questions.some((question) => question.sectionIds.some((id) => !sectionIds.has(id)))
  )) return false;

  // Mode-owned crops use the same page scope as reads, including unmapped
  // chapter context. An empty Tutor section scope has whole-book access.
  for (const entry of [...value.exams, ...value.tutorSessions]) {
    if (!entry.snapshots?.length) continue;
    const ranges = entry.scope.sectionIds.length
      ? scopedPageRanges(value as ScholarBook, sections.filter((section) => entry.scope.sectionIds.includes(section.id)))
      : undefined;
    if (entry.snapshots?.some((snapshot) => (metadata.pageCount !== undefined && snapshot.page > metadata.pageCount)
      || (ranges && !pageInRanges(snapshot.page, ranges)))) return false;
  }

  return true;
}

/** Indexes of array members that fail `predicate`; empty when `items` is not an array. */
function failingIndexes(items: unknown, predicate: (value: unknown) => boolean): number[] {
  return Array.isArray(items) ? items.flatMap((item, index) => (predicate(item) ? [] : [index])) : [];
}

function duplicateFieldIssues(
  items: unknown,
  field: string,
  path: string,
  add: (path: string, problem: string) => void,
): void {
  if (!Array.isArray(items)) return;
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (!isRecord(item) || !isStableId(item[field])) return;
    if (seen.has(item[field])) add(`${path}[${index}].${field}`, "duplicates an earlier entry");
    seen.add(item[field]);
  });
}

/** Explain the existing whole-exam rules without assuming its members validated. */
function examRecordIssues(exam: JsonRecord, path: string, add: (path: string, problem: string) => void): void {
  const issue = (field: string, problem: string) => add(`${path}.${field}`, problem);
  if (!isStableId(exam.id)) issue("id", "must be a stable id");
  if (!isNonEmptyString(exam.title)) issue("title", "must be a nonempty string");
  if (isRecord(exam.scope)) {
    for (const field of ["chapterIds", "sectionIds"] as const) {
      const ids = exam.scope[field];
      if (!isStringArray(ids, { nonEmpty: true, unique: true }) || !ids.every(isStableId)) {
        issue(`scope.${field}`, "must contain unique nonempty stable ids");
      }
    }
    if (!isNonEmptyString(exam.scope.description)) issue("scope.description", "must be a nonempty string");
  }
  const status = exam.status;
  const knownStatus = status === "draft" || status === "active" || status === "submitted" || status === "graded";
  if (!knownStatus) issue("status", "must be draft, active, submitted, or graded");
  for (const [field, idField] of [["questions", "id"], ["rawResponses", "questionId"], ["itemResults", "questionId"], ["breakdown", "key"]] as const) {
    if (!Array.isArray(exam[field])) issue(field, "must be an array");
    duplicateFieldIssues(exam[field], idField, `${path}.${field}`, add);
  }
  if (!isTranscript(exam.transcript)) issue("transcript", "must contain valid entries with unique ids");
  if (exam.images !== undefined && !isReferenceImageArray(exam.images)) issue("images", "must contain valid reference images with unique ids");
  if (exam.snapshots !== undefined && !isSnapshotArray(exam.snapshots)) issue("snapshots", "must contain valid source snapshots with unique ids");
  if (!isFiniteNumber(exam.earnedPoints) || exam.earnedPoints < 0) issue("earnedPoints", "must be a non-negative finite number");
  if (!isFiniteNumber(exam.maxPoints) || exam.maxPoints < 0) issue("maxPoints", "must be a non-negative finite number");
  if (isFiniteNumber(exam.earnedPoints) && isFiniteNumber(exam.maxPoints)) {
    if (exam.earnedPoints > exam.maxPoints) issue("earnedPoints", "must not exceed maxPoints");
    if (!isDerivedPercent(exam.percent, exam.earnedPoints, exam.maxPoints)) issue("percent", "must match earnedPoints / maxPoints * 100 (zero when maxPoints is zero; one-decimal rounding allowed)");
  } else if (!isFiniteNumber(exam.percent) || exam.percent < 0 || exam.percent > 100) issue("percent", "must be a finite number from 0 to 100");

  for (const field of ["createdAt", "updatedAt", "startedAt", "submittedAt", "gradedAt"] as const) {
    if ((field === "createdAt" || field === "updatedAt" || exam[field] !== undefined) && !isTimestamp(exam[field])) {
      issue(field, "must be an ISO timestamp");
    }
  }
  const noEarlierThan = (field: string, earlier: string) => {
    if (isTimestamp(exam[field]) && isTimestamp(exam[earlier]) && Date.parse(exam[field]) < Date.parse(exam[earlier])) {
      issue(field, `must not be earlier than ${earlier}`);
    }
  };
  noEarlierThan("updatedAt", "createdAt");
  noEarlierThan("startedAt", "createdAt");
  noEarlierThan("submittedAt", "startedAt");
  noEarlierThan("gradedAt", "submittedAt");
  for (const field of ["startedAt", "submittedAt", "gradedAt"] as const) {
    if (isTimestamp(exam[field]) && isTimestamp(exam.updatedAt) && Date.parse(exam[field]) > Date.parse(exam.updatedAt)) {
      issue(field, "must not be later than updatedAt");
    }
  }
  if (exam.submittedAt !== undefined && exam.startedAt === undefined) issue("startedAt", "is required when submittedAt is present");
  if (exam.gradedAt !== undefined && exam.submittedAt === undefined) issue("submittedAt", "is required when gradedAt is present");
  if (knownStatus) {
    for (const [field, required] of [
      ["startedAt", status !== "draft"],
      ["submittedAt", status === "submitted" || status === "graded"],
      ["gradedAt", status === "graded"],
    ] as const) {
      if (required && exam[field] === undefined) issue(field, `is required for ${status} status`);
      if (!required && exam[field] !== undefined) issue(field, `must be absent for ${status} status`);
    }
    if (status !== "draft" && Array.isArray(exam.questions) && exam.questions.length === 0) issue("questions", `must not be empty for ${status} status`);
    for (const field of ["rawResponses", "itemResults", "breakdown"] as const) {
      const items = exam[field];
      if (!Array.isArray(items)) continue;
      const needsEntries = field === "rawResponses" ? status === "submitted" || status === "graded" : status === "graded";
      if (!needsEntries && items.length > 0) issue(field, `must be empty for ${status} status`);
      if (needsEntries && field === "breakdown" && items.length === 0) issue(field, "must not be empty for graded status");
      if (needsEntries && field !== "breakdown" && Array.isArray(exam.questions) && items.length !== exam.questions.length) {
        issue(field, `must contain exactly one entry per question for ${status} status`);
      }
    }
    if (status !== "graded" && exam.earnedPoints !== 0) issue("earnedPoints", `must be zero for ${status} status`);
  }

  if (isScope(exam.scope) && exam.scope.sectionIds.length === 0) issue("scope.sectionIds", "must name at least one section");
  if (Array.isArray(exam.questions)) {
    const questions = exam.questions;
    const questionById = new Map(questions.filter(isExamQuestion).map((question) => [question.id, question]));
    const questionIds = new Set(questions.filter(isRecord).map((question) => question.id).filter(isStableId));
    questions.forEach((question, questionIndex) => {
      if (!isRecord(question) || !Array.isArray(question.sectionIds) || !isScope(exam.scope)) return;
      const scopeSectionIds = exam.scope.sectionIds;
      if (!isStringArray(question.sectionIds, { nonEmpty: true, unique: true })) issue(`questions[${questionIndex}].sectionIds`, "must contain unique nonempty section ids");
      question.sectionIds.forEach((id, index) => {
        if (!isStableId(id) || !scopeSectionIds.includes(id)) issue(`questions[${questionIndex}].sectionIds[${index}]`, "must name a section in this exam's scope");
      });
    });
    for (const field of ["rawResponses", "itemResults"] as const) {
      const items = exam[field];
      if (!Array.isArray(items)) continue;
      items.forEach((item, index) => {
        if (!isRecord(item)) return;
        if (!isStableId(item.questionId) || !questionIds.has(item.questionId)) issue(`${field}[${index}].questionId`, "must name a question in this exam");
        const question = isStableId(item.questionId) ? questionById.get(item.questionId) : undefined;
        if (field === "itemResults" && question && isFiniteNumber(item.maxPoints) && !approximatelyEqual(item.maxPoints, question.maxPoints)) {
          issue(`${field}[${index}].maxPoints`, "must equal the referenced question's maxPoints");
        }
      });
    }
    if (questions.every(isExamQuestion) && isFiniteNumber(exam.maxPoints) && !approximatelyEqual(exam.maxPoints, questions.reduce((total, question) => total + question.maxPoints, 0))) {
      issue("maxPoints", "must equal the sum of question maxPoints");
    }
  }
  if (status === "graded" && Array.isArray(exam.itemResults) && exam.itemResults.every(isItemResult) && isFiniteNumber(exam.earnedPoints)
    && !approximatelyEqual(exam.earnedPoints, exam.itemResults.reduce((total, result) => total + result.earnedPoints, 0))) {
    issue("earnedPoints", "must equal the sum of itemResults earnedPoints");
  }
}

/**
 * Explain why `isScholarBook` refused a value.
 *
 * This is a diagnostic companion, never a second authority: it widens and
 * narrows nothing, and returns [] whenever isScholarBook accepts. It exists
 * because the caller of a rejected write is usually a model, and "invalid book
 * state" gives it nothing to correct — so it retries the same payload. Every
 * message here names a concrete path.
 */
export function scholarBookIssues(value: unknown): string[] {
  if (isScholarBook(value)) return [];
  if (!isRecord(value)) return ["book state is not an object"];

  const issues: string[] = [];
  const add = (path: string, problem: string) => { issues.push(`${path} ${problem}`); };

  // --- identity and source ---
  if (value.schemaVersion !== SCHOLAR_SCHEMA_VERSION) {
    add("schemaVersion", `must be ${SCHOLAR_SCHEMA_VERSION}`);
  }
  if (!isBookId(value.id)) add("id", "must be a 64-character lowercase sha256 hex string");
  if (!isNonNegativeInteger(value.revision)) add("revision", "must be a non-negative integer");
  if (!isStableId(value.instanceId)) add("instanceId", "must be a nonempty single-line string");
  if (!isRecord(value.source)) add("source", "must be an object");
  else {
    const source = value.source;
    if (typeof source.absolutePath !== "string" || !isAbsolute(source.absolutePath)) add("source.absolutePath", "must be an absolute path");
    if (typeof source.relativePath !== "string" || !isSafeStoredRelativePath(source.relativePath)) add("source.relativePath", "must be a contained relative path");
    if (typeof source.fileName !== "string" || basename(source.fileName) !== source.fileName) add("source.fileName", "must be a bare file name");
    if (source.format !== "pdf") add("source.format", 'must be "pdf"');
    if (!isRecord(source.fingerprint)) add("source.fingerprint", "must be an object");
    else if (!isBookId(source.fingerprint.sha256)) add("source.fingerprint.sha256", "must be a 64-character sha256 hex string");
    else if (value.id !== source.fingerprint.sha256) add("id", "must equal source.fingerprint.sha256");
  }
  if (!isRecord(value.metadata)) add("metadata", "must be an object");
  else {
    if (!isNonEmptyString(value.metadata.title)) add("metadata.title", "must be a nonempty string");
    if (!isStringArray(value.metadata.authors, { nonEmpty: true, unique: true })) add("metadata.authors", "must be unique nonempty strings");
  }
  if (value.outlineStatus !== "pending" && value.outlineStatus !== "ready" &&
    value.outlineStatus !== "needs-review" && value.outlineStatus !== "needs-ocr") {
    add("outlineStatus", "must be pending, ready, needs-review, or needs-ocr");
  }
  if (bookDirectorySegment(value.noteDirectory) === undefined) add("noteDirectory", "must be exactly one folder name inside Books");
  if (!isTimestamp(value.createdAt)) add("createdAt", "must be an ISO timestamp");
  if (!isTimestamp(value.updatedAt)) add("updatedAt", "must be an ISO timestamp");
  if (isTimestamp(value.createdAt) && isTimestamp(value.updatedAt) && Date.parse(value.createdAt) > Date.parse(value.updatedAt)) {
    add("updatedAt", "must not be earlier than createdAt");
  }

  // --- chapters, sections, and the records inside them ---
  if (!Array.isArray(value.chapters)) add("chapters", "must be an array");
  else {
    for (const chapterIndex of failingIndexes(value.chapters, isChapter)) {
      const chapter = value.chapters[chapterIndex] as JsonRecord | undefined;
      const path = `chapters[${chapterIndex}]`;
      if (!isRecord(chapter)) { add(path, "must be an object"); continue; }
      if (!Array.isArray(chapter.sections)) { add(`${path}.sections`, "must be an array"); continue; }

      const badSections = failingIndexes(chapter.sections, isSection);
      if (badSections.length === 0) { add(path, "does not match the stored chapter schema"); continue; }
      for (const sectionIndex of badSections) {
        const section = (chapter.sections as unknown[])[sectionIndex] as JsonRecord | undefined;
        const sectionPath = `${path}.sections[${sectionIndex}]`;
        if (!isRecord(section)) { add(sectionPath, "must be an object"); continue; }
        const badAttempts = failingIndexes(section.attempts, isAttempt);
        const badTranscript = failingIndexes(section.transcript, isTranscriptEntry);
        const badSnapshots = failingIndexes(section.snapshots, isSnapshot);
        for (const index of badAttempts) add(`${sectionPath}.attempts[${index}]`, "does not match the stored attempt schema");
        for (const index of badTranscript) add(`${sectionPath}.transcript[${index}]`, "does not match the stored transcript schema");
        for (const index of badSnapshots) add(`${sectionPath}.snapshots[${index}]`, "does not match the stored snapshot schema");
        if (!badAttempts.length && !badTranscript.length && !badSnapshots.length) {
          add(sectionPath, "does not match the stored section schema");
        }
      }
    }
  }

  // --- exams: the path that most often carries model-authored content ---
  if (!Array.isArray(value.exams)) add("exams", "must be an array");
  else {
    duplicateFieldIssues(value.exams, "id", "exams", add);
    for (const examIndex of failingIndexes(value.exams, isScholarExam)) {
      const exam = value.exams[examIndex] as JsonRecord | undefined;
      const path = `exams[${examIndex}]`;
      if (!isRecord(exam)) { add(path, "must be an object"); continue; }
      const beforeExamIssues = issues.length;
      examRecordIssues(exam, path, add);
      if (!isScope(exam.scope)) add(`${path}.scope`, "must name unique chapter and section ids with a description");

      const badQuestions = failingIndexes(exam.questions, isExamQuestion);
      for (const questionIndex of badQuestions) {
        const question = (exam.questions as unknown[])[questionIndex] as JsonRecord | undefined;
        const questionPath = `${path}.questions[${questionIndex}]`;
        if (!isRecord(question)) { add(questionPath, "must be an object"); continue; }
        for (const index of failingIndexes(question.options, isExamOption)) {
          add(`${questionPath}.options[${index}]`, "needs a stable value and a nonempty label");
        }
        for (const index of failingIndexes(question.rubric, isRubricCriterion)) {
          add(`${questionPath}.rubric[${index}]`, "needs an id, criterion, required evidence and positive points");
        }
        if (question.format === "multiple-choice" && question.rubric !== undefined) {
          add(questionPath, "is multiple-choice and must not carry a rubric");
        }
        if (question.format === "open" && (question.options !== undefined || question.correctAnswer !== undefined)) {
          add(questionPath, "is open and must not carry options or a correctAnswer");
        }
        add(questionPath, "does not match the stored question schema");
      }
      for (const index of failingIndexes(exam.itemResults, isItemResult)) add(`${path}.itemResults[${index}]`, "does not match the stored result schema");
      for (const index of failingIndexes(exam.breakdown, isBreakdown)) add(`${path}.breakdown[${index}]`, "does not match the stored breakdown schema");
      for (const index of failingIndexes(exam.rawResponses, isRawResponse)) add(`${path}.rawResponses[${index}]`, "does not match the stored response schema");
      if (issues.length === beforeExamIssues) add(path, "does not match the stored exam schema");
    }
  }

  // --- tutor sessions ---
  if (!Array.isArray(value.tutorSessions)) add("tutorSessions", "must be an array");
  else {
    for (const index of failingIndexes(value.tutorSessions, isTutorSession)) {
      const session = value.tutorSessions[index] as JsonRecord | undefined;
      const path = `tutorSessions[${index}]`;
      if (!isRecord(session)) { add(path, "must be an object"); continue; }
      if (!isScope(session.scope)) add(`${path}.scope`, "must name unique chapter and section ids with a description");
      if (session.snapshots !== undefined && !isSnapshotArray(session.snapshots)) add(`${path}.snapshots`, "must contain valid source snapshots with unique ids");
      for (const attemptIndex of failingIndexes(session.attempts, isAttempt)) add(`${path}.attempts[${attemptIndex}]`, "does not match the stored attempt schema");
      add(path, "does not match the stored tutor-session schema");
    }
  }

  // --- cross references, which pass the per-record checks but not the whole ---
  for (const [field, entries, label] of [
    ["currentExamId", value.exams, "exam"],
    ["currentTutorId", value.tutorSessions, "tutor session"],
  ] as const) {
    const id = value[field];
    if (id === undefined) continue;
    if (!isStableId(id)) {
      add(field, "must be a nonempty, trimmed, single-line stable id of at most 200 characters");
    } else if (Array.isArray(entries) && !entries.some((entry) => isRecord(entry) && entry.id === id)) {
      add(field, `names no ${label} in this book: ${id}`);
    }
  }
  if (value.recoveryCheckpoints !== undefined && !isRecoveryCheckpoints(value.recoveryCheckpoints)) {
    add("recoveryCheckpoints", "must be an object mapping keys to checkpoint records with lastProcessedEntryId and updatedAt");
  }
  if (Array.isArray(value.chapters) && value.chapters.every(isChapter)) {
    if (!chaptersDoNotOverlap(value.chapters)) {
      add("chapters", "must not overlap pages beyond a shared boundary page");
    }
    if (new Set(value.chapters.map((chapter) => chapter.order)).size !== value.chapters.length) {
      add("chapters", "contains duplicate chapter orders");
    }
    const sections = value.chapters.flatMap((chapter) => chapter.sections);
    const sectionIds = new Set(sections.map((section) => section.id));
    if (sectionIds.size !== sections.length) add("chapters", "contains duplicate section ids");
    if (value.currentSectionId !== undefined && !sectionIds.has(value.currentSectionId)) {
      add("currentSectionId", "names no section in this book");
    }
    const chapterIds = new Set(value.chapters.map((chapter) => chapter.id));
    for (const field of ["exams", "tutorSessions"] as const) {
      const entries = value[field];
      if (!Array.isArray(entries)) continue;
      entries.forEach((entry, index) => {
        if (!isRecord(entry) || !isScope(entry.scope)) return;
        if (entry.scope.chapterIds.some((id) => !chapterIds.has(id))) add(`${field}[${index}].scope.chapterIds`, "names missing chapters");
        if (entry.scope.sectionIds.some((id) => !sectionIds.has(id))) add(`${field}[${index}].scope.sectionIds`, "names missing sections");
        if (isSnapshotArray(entry.snapshots) && entry.snapshots.length) {
          const selectedIds = entry.scope.sectionIds;
          const ranges = selectedIds.length ? scopedPageRanges(value as ScholarBook,
            sections.filter((section) => selectedIds.includes(section.id))) : undefined;
          const pageCount = isRecord(value.metadata) && isNonNegativeInteger(value.metadata.pageCount) ? value.metadata.pageCount : undefined;
          entry.snapshots.forEach((snapshot, snapshotIndex) => {
            if ((pageCount !== undefined && snapshot.page > pageCount) || (ranges && !pageInRanges(snapshot.page, ranges))) {
              add(`${field}[${index}].snapshots[${snapshotIndex}].page`, "must belong to this record's selected source scope");
            }
          });
        }
      });
    }
    if (Array.isArray(value.exams)) {
      value.exams.forEach((exam, examIndex) => {
        if (!isRecord(exam) || !Array.isArray(exam.questions)) return;
        exam.questions.forEach((question, questionIndex) => {
          if (!isRecord(question) || !Array.isArray(question.sectionIds)) return;
          if (question.sectionIds.some((id) => !sectionIds.has(id as string))) add(`exams[${examIndex}].questions[${questionIndex}].sectionIds`, "contains ids outside this book");
        });
      });
    }
  }

  return issues.length > 0
    ? [...new Set(issues)]
    : ["book state does not match schema v3, and no single field could be isolated"];
}

export function isCatalogEntry(value: unknown): value is CatalogEntry {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["relativePath", "bookId", "size", "mtimeMs"]) &&
    typeof value.relativePath === "string" &&
    isSafeStoredRelativePath(value.relativePath) &&
    isBookId(value.bookId) &&
    isFiniteNumber(value.size) && value.size >= 0 &&
    isFiniteNumber(value.mtimeMs) && value.mtimeMs >= 0
  );
}

export function isScholarCatalog(value: unknown): value is ScholarCatalog {
  if (!isRecord(value) || !hasOnlyKeys(value, ["schemaVersion", "entries"], ["libraryRoot", "currentBookId"]) ||
    value.schemaVersion !== SCHOLAR_SCHEMA_VERSION || !Array.isArray(value.entries) ||
    !value.entries.every(isCatalogEntry) ||
    (value.libraryRoot !== undefined && (typeof value.libraryRoot !== "string" || (value.libraryRoot && !isAbsolute(value.libraryRoot)))) ||
    (value.currentBookId !== undefined && !isBookId(value.currentBookId))) return false;
  const paths = value.entries.map((entry) => entry.relativePath.toLocaleLowerCase("en-US"));
  return new Set(paths).size === paths.length;
}

export function legacyBootstrapPaths(value: unknown): { libraryRoot?: string; obsidianRoot?: string } | undefined {
  if (!isRecord(value) || value.schemaVersion !== 2) return undefined;
  const libraryRoot = typeof value.libraryRoot === "string" && (!value.libraryRoot || isAbsolute(value.libraryRoot))
    ? value.libraryRoot
    : undefined;
  const obsidianRoot = typeof value.obsidianRoot === "string" && (!value.obsidianRoot || isAbsolute(value.obsidianRoot))
    ? value.obsidianRoot
    : undefined;
  return libraryRoot !== undefined || obsidianRoot !== undefined ? { libraryRoot, obsidianRoot } : undefined;
}

export type BootstrapConfig = {
  schemaVersion: typeof SCHOLAR_SCHEMA_VERSION;
  obsidianRoot: string;
  updatedAt: string;
};

export function isBootstrapConfig(value: unknown): value is BootstrapConfig {
  return isRecord(value) &&
    hasOnlyKeys(value, ["schemaVersion", "obsidianRoot", "updatedAt"]) &&
    value.schemaVersion === SCHOLAR_SCHEMA_VERSION &&
    typeof value.obsidianRoot === "string" && (!value.obsidianRoot || isAbsolute(value.obsidianRoot)) &&
    isTimestamp(value.updatedAt);
}
