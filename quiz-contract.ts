/**
 * Shared wire contract for Scholar's interactive quiz tool.
 *
 * Keep this module free of Pi UI and Scholar persistence concerns. The quiz
 * producer and event consumers can share these shapes without importing one
 * another or rebuilding the protocol with casts.
 */
import { isQuestionGrounding, normalizeQuestionGrounding } from "./question-grounding.ts";
import type { AssessmentKind, QuestionGrounding } from "./types.ts";

export const SCHOLAR_QUIZ_TOOL_NAME = "scholar_quiz" as const;

export type ScholarQuizMode = "single-select" | "multi-select";
export type ScholarQuizStatus = "answered" | "cancelled" | "unavailable";

export interface ScholarQuizOption {
  label: string;
  value: string;
  description?: string;
}

export interface ScholarQuizAnswer {
  label: string;
  value: string;
  index: number;
}

export interface ScholarQuizDisplayedOption {
  index: number;
  label: string;
}

/** Pre-answer update; deliberately excludes the answer key and explanation. */
export interface ScholarQuizProgressDetails {
  options: ScholarQuizDisplayedOption[];
}

export interface ScholarQuizResponse {
  dontKnow: boolean;
  answers: ScholarQuizAnswer[];
}

/** Exact detail object emitted by the Scholar quiz tool. */
export interface ScholarQuizResultDetails {
  status: ScholarQuizStatus;
  question: string;
  context?: string;
  mode: ScholarQuizMode;
  message?: string;
  options?: ScholarQuizDisplayedOption[];
  answers?: ScholarQuizAnswer[];
  correctIndices?: number[];
  correct?: boolean;
  dontKnow?: boolean;
  explanation?: string;
}

/** Tolerant view of an event or historical result crossing the wire. */
export interface ObservedScholarQuizDetails {
  status?: string;
  question?: string;
  context?: string;
  mode?: ScholarQuizMode;
  message?: string;
  options?: ScholarQuizDisplayedOption[];
  answers?: ScholarQuizAnswer[];
  correctIndices?: number[];
  correct?: boolean;
  dontKnow?: boolean;
  explanation?: string;
}

/** Fields used by Scholar when observing a quiz tool call. */
export interface ObservedScholarQuizInput {
  kind?: AssessmentKind;
  question?: string;
  details?: string;
  multiSelect?: boolean;
  difficulty?: string;
  grounding?: QuestionGrounding;
  optionLabels?: string[];
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function toScholarQuizDisplayedOptions(
  options: ReadonlyArray<Pick<ScholarQuizOption, "label">>,
): ScholarQuizDisplayedOption[] {
  return options.map((option, offset) => ({ index: offset + 1, label: option.label }));
}

/**
 * Read displayed options from an untrusted event payload. Invalid members are
 * ignored and valid members are returned in display-index order, matching the
 * protocol handling that preceded this shared contract.
 */
export function normalizeScholarQuizDisplayedOptions(value: unknown): ScholarQuizDisplayedOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    return typeof candidate.index === "number" && typeof candidate.label === "string"
      ? [{ index: candidate.index, label: candidate.label }]
      : [];
  }).sort((left, right) => left.index - right.index);
}

export function scholarQuizDisplayedOptionLabels(value: unknown): string[] {
  return normalizeScholarQuizDisplayedOptions(value).map((option) => option.label);
}

/** Input options have no display index until the quiz has shuffled them. */
export function scholarQuizInputOptionLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) =>
    isRecord(candidate) && typeof candidate.label === "string" ? [candidate.label] : []
  );
}

export function parseScholarQuizInput(value: unknown): ObservedScholarQuizInput {
  if (!isRecord(value)) return {};
  const optionLabels = scholarQuizInputOptionLabels(value.options);
  // Tidy cosmetic spacing before validating: otherwise a stray double space
  // silently drops grounding, and the gate reports it as simply missing.
  const grounding = normalizeQuestionGrounding(value.grounding);
  return {
    ...(["conceptual", "application", "computation", "discrimination"].includes(value.kind as string)
      ? { kind: value.kind as AssessmentKind } : {}),
    ...(typeof value.question === "string" ? { question: value.question } : {}),
    ...(typeof value.details === "string" ? { details: value.details } : {}),
    ...(typeof value.multiSelect === "boolean" ? { multiSelect: value.multiSelect } : {}),
    ...(typeof value.difficulty === "string" ? { difficulty: value.difficulty } : {}),
    // Pass a malformed receipt through rather than dropping it. Dropping made
    // the gate report a missing object, hiding the field-level reason and
    // sending the caller into a retry loop over a receipt it did supply.
    ...(value.grounding !== undefined ? { grounding: grounding as QuestionGrounding } : {}),
    ...(Array.isArray(value.options) ? { optionLabels } : {}),
  };
}

export function parseScholarQuizDetails(value: unknown): ObservedScholarQuizDetails {
  if (!isRecord(value)) return {};
  const options = normalizeScholarQuizDisplayedOptions(value.options);
  const answers = Array.isArray(value.answers)
    ? value.answers.flatMap((candidate) => {
      if (!isRecord(candidate)) return [];
      return typeof candidate.index === "number"
        && typeof candidate.label === "string"
        && typeof candidate.value === "string"
        ? [{ index: candidate.index, label: candidate.label, value: candidate.value }]
        : [];
    }).sort((left, right) => left.index - right.index)
    : undefined;
  const correctIndices = Array.isArray(value.correctIndices)
    && value.correctIndices.every((candidate) => typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 1)
    ? value.correctIndices as number[] : undefined;
  const mode = value.mode === "single-select" || value.mode === "multi-select" ? value.mode : undefined;
  return {
    ...(typeof value.status === "string" ? { status: value.status } : {}),
    ...(typeof value.question === "string" ? { question: value.question } : {}),
    ...(typeof value.context === "string" ? { context: value.context } : {}),
    ...(mode ? { mode } : {}),
    ...(typeof value.message === "string" ? { message: value.message } : {}),
    ...(Array.isArray(value.options) ? { options } : {}),
    ...(answers ? { answers } : {}),
    ...(correctIndices ? { correctIndices } : {}),
    ...(typeof value.correct === "boolean" ? { correct: value.correct } : {}),
    ...(typeof value.dontKnow === "boolean" ? { dontKnow: value.dontKnow } : {}),
    ...(typeof value.explanation === "string" ? { explanation: value.explanation } : {}),
  };
}

export function scholarQuizCorrectOptionReferences(
  correctIndices: readonly number[] | undefined,
  optionLabels: readonly string[] | undefined,
): string[] {
  if (!correctIndices || !optionLabels) return [];
  return correctIndices.flatMap((index) =>
    typeof index === "number" && optionLabels[index - 1]
      ? [`${index}. ${optionLabels[index - 1]}`]
      : []
  );
}

/** Use only a submitted quiz's exact key and displayed order, never its selected answers. */
export function scholarQuizCorrectAnswer(
  details: ObservedScholarQuizDetails,
  displayedLabels?: readonly string[],
): string | undefined {
  if (details.status !== "answered" || !details.correctIndices?.length) return undefined;
  const options = details.options ?? displayedLabels?.map((label, offset) => ({ index: offset + 1, label }));
  if (!options?.length) return undefined;
  const labels = new Map<number, string>();
  for (const option of options) {
    if (!Number.isInteger(option.index) || option.index < 1 || !option.label.trim() || labels.has(option.index)) return undefined;
    labels.set(option.index, option.label);
  }
  const indices = [...new Set(details.correctIndices)].sort((left, right) => left - right);
  if (indices.some((index) => !Number.isInteger(index) || !labels.has(index))) return undefined;
  return indices.map((index) => `${index}. ${labels.get(index)}`).join(", ");
}
