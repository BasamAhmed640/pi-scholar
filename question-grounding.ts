import { MODE_CAPABILITIES } from "./modes.ts";
import { pageInRanges, scopedPageRanges, type PageRange } from "./page-scope.ts";
import {
  allSections,
  type QuestionBasis,
  type QuestionGrounding,
  type ScholarBook,
  type ScholarSection,
  type TutorSession,
} from "./types.ts";

const MAX_GROUNDING_TEXT = 500;

type GroundingTarget =
  | { mode: "learn"; section: ScholarSection }
  | { mode: "tutor"; tutor: TutorSession };

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyBoundedString(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_GROUNDING_TEXT
    && value === value.trim().replace(/\s+/g, " ");
}

function isUniqueIntegerArray(value: unknown, minimum: number, maximum: number): value is number[] {
  return Array.isArray(value)
    && value.length >= minimum
    && value.length <= maximum
    && value.every((item) => Number.isInteger(item) && item >= 1)
    && new Set(value).size === value.length;
}

function hasOnlyKeys(value: UnknownRecord, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function isQuestionBasis(value: unknown): value is QuestionBasis {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, ["kind", "value", "supports"], ["prerequisiteBasis", "sourcePage"])) return false;
  return (value.kind === "objective" || value.kind === "key-point" || value.kind === "prerequisite")
    && isNonEmptyBoundedString(value.value)
    && isUniqueIntegerArray(value.supports, 1, 12)
    && value.supports.every((item) => item <= 12)
    && (value.prerequisiteBasis === undefined || value.prerequisiteBasis === "ordinary" || value.prerequisiteBasis === "source-declared")
    && (value.sourcePage === undefined || (Number.isInteger(value.sourcePage) && value.sourcePage >= 1));
}

const GROUNDING_KEYS = ["purpose", "competency", "requiredEvidence", "sourcePages", "basis"];
const BASIS_KEYS = ["kind", "value", "supports", "prerequisiteBasis", "sourcePage"];

function tidyText(value: unknown): unknown {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : value;
}

/**
 * Bring cosmetic spacing into the shape the stored schema requires. A stray
 * double space is not a fairness problem, so it should never cost a question.
 *
 * Deliberately does NOT merge duplicate requiredEvidence: basis.supports
 * indexes into that array by position, so collapsing it would silently remap
 * which basis proves which evidence atom. Duplicates are reported instead.
 * sourcePages has no such index references, so deduping it is safe.
 */
export function normalizeQuestionGrounding(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    ...value,
    ...(typeof value.competency === "string" ? { competency: tidyText(value.competency) } : {}),
    ...(Array.isArray(value.requiredEvidence) ? { requiredEvidence: value.requiredEvidence.map(tidyText) } : {}),
    ...(Array.isArray(value.sourcePages) ? { sourcePages: [...new Set(value.sourcePages)] } : {}),
    ...(Array.isArray(value.basis)
      ? {
        basis: value.basis.map((entry) =>
          isRecord(entry) && typeof entry.value === "string" ? { ...entry, value: tidyText(entry.value) } : entry
        ),
      }
      : {}),
  };
}

function boundedTextIssue(value: unknown, label: string): string | undefined {
  if (typeof value !== "string") return `${label} must be a string`;
  if (value.length === 0) return `${label} must not be empty`;
  if (value.length > MAX_GROUNDING_TEXT) return `${label} must be ${MAX_GROUNDING_TEXT} characters or fewer`;
  if (value !== value.trim().replace(/\s+/g, " ")) return `${label} must be trimmed with single spaces between words`;
  return undefined;
}

/**
 * Field-level reasons a grounding receipt is malformed. The caller is a model:
 * "missing or malformed" tells it nothing and it resubmits the same payload,
 * so every message here names the exact field.
 */
export function questionGroundingShapeIssues(value: unknown): string[] {
  if (!isRecord(value)) return ["grounding must be an object with purpose, competency, requiredEvidence, sourcePages and basis"];
  const issues: string[] = [];
  const push = (issue: string | undefined) => { if (issue) issues.push(issue); };

  if (value.purpose !== "diagnostic" && value.purpose !== "practice" && value.purpose !== "mastery") {
    issues.push(`purpose must be diagnostic, practice or mastery (found ${JSON.stringify(value.purpose)})`);
  }
  push(boundedTextIssue(value.competency, "competency"));

  if (!Array.isArray(value.requiredEvidence)) issues.push("requiredEvidence must be an array");
  else {
    if (value.requiredEvidence.length < 1 || value.requiredEvidence.length > 12) {
      issues.push(`requiredEvidence must hold 1 to 12 items (found ${value.requiredEvidence.length})`);
    }
    value.requiredEvidence.forEach((item, index) => push(boundedTextIssue(item, `requiredEvidence[${index + 1}]`)));
    if (new Set(value.requiredEvidence).size !== value.requiredEvidence.length) {
      issues.push("requiredEvidence must not repeat an item; basis.supports refers to these by position");
    }
  }

  if (!Array.isArray(value.sourcePages)) issues.push("sourcePages must be an array");
  else {
    if (value.sourcePages.length < 1 || value.sourcePages.length > 24) {
      issues.push(`sourcePages must hold 1 to 24 pages (found ${value.sourcePages.length})`);
    }
    if (value.sourcePages.some((page) => !Number.isInteger(page) || (page as number) < 1)) {
      issues.push("sourcePages must be positive whole page numbers");
    }
  }

  if (!Array.isArray(value.basis)) issues.push("basis must be an array");
  else {
    if (value.basis.length < 1 || value.basis.length > 24) {
      issues.push(`basis must hold 1 to 24 entries (found ${value.basis.length})`);
    }
    value.basis.forEach((entry, index) => {
      const label = `basis[${index + 1}]`;
      if (!isRecord(entry)) { issues.push(`${label} must be an object`); return; }
      if (entry.kind !== "objective" && entry.kind !== "key-point" && entry.kind !== "prerequisite") {
        issues.push(`${label}.kind must be objective, key-point or prerequisite (found ${JSON.stringify(entry.kind)})`);
      }
      push(boundedTextIssue(entry.value, `${label}.value`));
      if (!Array.isArray(entry.supports) || entry.supports.length === 0) {
        issues.push(`${label}.supports must list at least one required-evidence index`);
      } else if (entry.supports.some((item) => !Number.isInteger(item) || (item as number) < 1 || (item as number) > 12)) {
        issues.push(`${label}.supports must be one-based indexes between 1 and 12`);
      } else if (new Set(entry.supports).size !== entry.supports.length) {
        issues.push(`${label}.supports must not repeat an index`);
      }
      if (entry.prerequisiteBasis !== undefined && entry.prerequisiteBasis !== "ordinary" && entry.prerequisiteBasis !== "source-declared") {
        issues.push(`${label}.prerequisiteBasis must be ordinary or source-declared (found ${JSON.stringify(entry.prerequisiteBasis)})`);
      }
      if (entry.sourcePage !== undefined && (!Number.isInteger(entry.sourcePage) || (entry.sourcePage as number) < 1)) {
        issues.push(`${label}.sourcePage must be a positive whole page number`);
      }
      const strayBasisKeys = Object.keys(entry).filter((key) => !BASIS_KEYS.includes(key));
      if (strayBasisKeys.length) issues.push(`${label} has unexpected field(s): ${strayBasisKeys.join(", ")}`);
    });
  }

  const strayKeys = Object.keys(value).filter((key) => !GROUNDING_KEYS.includes(key));
  if (strayKeys.length) issues.push(`grounding has unexpected field(s): ${strayKeys.join(", ")}`);

  return issues;
}

export function isQuestionGrounding(value: unknown): value is QuestionGrounding {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, ["purpose", "competency", "requiredEvidence", "sourcePages", "basis"])) return false;
  return (value.purpose === "diagnostic" || value.purpose === "practice" || value.purpose === "mastery")
    && isNonEmptyBoundedString(value.competency)
    && Array.isArray(value.requiredEvidence)
    && value.requiredEvidence.length >= 1
    && value.requiredEvidence.length <= 12
    && value.requiredEvidence.every(isNonEmptyBoundedString)
    && new Set(value.requiredEvidence).size === value.requiredEvidence.length
    && isUniqueIntegerArray(value.sourcePages, 1, 24)
    && Array.isArray(value.basis)
    && value.basis.length >= 1
    && value.basis.length <= 24
    && value.basis.every(isQuestionBasis);
}

const pageAllowed = pageInRanges;

/**
 * The pages a receipt may cite must be exactly the pages the mode may read.
 * When these diverged, a model could read a chapter lead-in page, find the
 * concept there, and then be refused for citing it — with no way to satisfy
 * both gates at once.
 */
function groundingRanges(book: ScholarBook, target: GroundingTarget): PageRange[] {
  if (target.mode === "learn") return scopedPageRanges(book, [target.section]);
  const selected = new Set(target.tutor.scope.sectionIds);
  const scoped = allSections(book).filter((section) => selected.has(section.id));
  // A free-topic Tutor has no resolved section IDs. Preserve that intentional
  // workflow, but require its diagnostic receipt to cite a concrete book page.
  return scopedPageRanges(book, scoped.length > 0 ? scoped : allSections(book));
}

/**
 * Validate relevance and fairness only. Difficulty is intentionally unrestricted:
 * a valid item may demand multi-step computation, discrimination, or novel transfer.
 */
export function questionGroundingIssues(
  value: unknown,
  book: ScholarBook,
  target: GroundingTarget,
): string[] {
  const shapeIssues = questionGroundingShapeIssues(value);
  if (shapeIssues.length > 0) return shapeIssues;
  if (!isQuestionGrounding(value)) return ["grounding metadata is missing or malformed"];

  const issues: string[] = [];
  const ranges = groundingRanges(book, target);
  const objectives = new Set(target.mode === "learn" ? target.section.coveredObjectives : []);
  const keyPoints = new Set(target.mode === "learn" ? target.section.keyPoints : target.tutor.keyPoints);

  for (const page of value.sourcePages) {
    if (!pageAllowed(page, ranges)) issues.push(`source page ${page} is outside the active ${target.mode} scope`);
  }

  const supported = new Set<number>();
  const taughtSupport = new Set<number>();
  let durableBasis = false;
  const seenBasis = new Set<string>();
  for (const basis of value.basis) {
    const identity = `${basis.kind}\u0000${basis.value}`;
    if (seenBasis.has(identity)) issues.push(`duplicate ${basis.kind} basis: ${basis.value}`);
    seenBasis.add(identity);

    for (const index of basis.supports) {
      if (index > value.requiredEvidence.length) {
        issues.push(`${basis.kind} basis references nonexistent required-evidence item ${index}`);
      } else {
        supported.add(index);
        if (basis.kind !== "prerequisite") taughtSupport.add(index);
      }
    }

    if (basis.kind === "objective") {
      const mayCiteObjectives = MODE_CAPABILITIES[target.mode].citesLearnObjectives;
      if (!mayCiteObjectives || !objectives.has(basis.value)) {
        issues.push(mayCiteObjectives
          ? `objective basis is not already covered in the active Learn section: ${basis.value}`
          : `Tutor questions cannot borrow Learn objectives; use an exact key point saved in this Tutor session: ${basis.value}`);
      } else {
        durableBasis = true;
      }
      if (basis.prerequisiteBasis !== undefined || basis.sourcePage !== undefined) {
        issues.push("objective basis cannot declare prerequisite fields");
      }
      continue;
    }

    if (basis.kind === "key-point") {
      if (!keyPoints.has(basis.value)) {
        issues.push(`key-point basis is not already taught in the active ${target.mode} record: ${basis.value}`);
      } else {
        durableBasis = true;
      }
      if (basis.prerequisiteBasis !== undefined || basis.sourcePage !== undefined) {
        issues.push("key-point basis cannot declare prerequisite fields");
      }
      continue;
    }

    if (!basis.prerequisiteBasis) {
      issues.push(`prerequisite basis must be labeled ordinary or source-declared: ${basis.value}`);
    } else if (basis.prerequisiteBasis === "ordinary") {
      if (basis.sourcePage !== undefined) issues.push("ordinary prerequisites cannot claim a source page");
    } else if (basis.sourcePage === undefined) {
      issues.push(`source-declared prerequisite requires a source page: ${basis.value}`);
    } else {
      durableBasis = true;
      if (!value.sourcePages.includes(basis.sourcePage)) {
        issues.push(`source-declared prerequisite page ${basis.sourcePage} is absent from sourcePages`);
      }
      if (!pageAllowed(basis.sourcePage, ranges)) {
        issues.push(`source-declared prerequisite page ${basis.sourcePage} is outside the active ${target.mode} scope`);
      }
    }
  }

  if (value.purpose === "diagnostic" && !durableBasis) {
    issues.push("a diagnostic question needs either already taught material or a source-declared basis tied to an in-scope PDF page");
  }

  for (let index = 1; index <= value.requiredEvidence.length; index += 1) {
    if (!supported.has(index)) issues.push(`required-evidence item ${index} has no declared basis`);
    if (value.purpose !== "diagnostic" && !taughtSupport.has(index)) {
      issues.push(`required-evidence item ${index} is not supported by already taught material`);
    }
  }

  if (value.purpose !== "diagnostic" && objectives.size === 0 && keyPoints.size === 0) {
    issues.push(`the active ${target.mode} record has no saved taught material; save notes before asking practice or mastery questions`);
  }

  return [...new Set(issues)];
}

export function assertQuestionGrounding(
  value: unknown,
  book: ScholarBook,
  target: GroundingTarget,
): asserts value is QuestionGrounding {
  const issues = questionGroundingIssues(value, book, target);
  if (issues.length > 0) {
    throw new Error(`Scholar blocked this question before presentation: ${issues.join("; ")}. Teach the missing basis or correct the grounding metadata, then retry at the same rigor.`);
  }
}

/**
 * Only a declared mastery attempt certifies completion.
 *
 * This once returned true for an ungrounded attempt as backward compatibility.
 * No path can create one any more — the quiz gate blocks before persisting and
 * assess requires grounding — so the allowance only widened the door. Sections
 * already completed under the old rule are grandfathered by the
 * legacyCompletion migration rather than by weakening this test.
 */
export function questionCountsTowardCompletion(attempt: { grounding?: QuestionGrounding }): boolean {
  return attempt.grounding?.purpose === "mastery";
}
