import { Type } from "typebox";

import type { OutlineValidationReport } from "./outline-validation.ts";
import { QuestionGroundingSchema } from "./question-grounding-schema.ts";

export const MAX_TOOL_PAGES = 12;
export const MAX_TOOL_CHARS = 60_000;

const CheckKindSchema = Type.Union([
  Type.Literal("conceptual"),
  Type.Literal("application"),
  Type.Literal("computation"),
  Type.Literal("discrimination"),
]);

const OutlineSectionSchema = Type.Object({
  number: Type.Optional(Type.String()),
  title: Type.String(),
  startPage: Type.Integer({ minimum: 1 }),
  endPage: Type.Integer({ minimum: 1 }),
  objectives: Type.Optional(Type.Array(Type.String())),
  requiredChecks: Type.Optional(Type.Array(CheckKindSchema)),
});

const OutlineChapterSchema = Type.Object({
  number: Type.Optional(Type.String()),
  title: Type.String(),
  startPage: Type.Integer({ minimum: 1 }),
  endPage: Type.Integer({ minimum: 1 }),
  sections: Type.Array(OutlineSectionSchema),
});

const OutlineValidationCheckSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 200 }),
  outcome: Type.Union([Type.Literal("match"), Type.Literal("non-substantive"), Type.Literal("mismatch"), Type.Literal("uncertain")]),
  observation: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  // Legacy fields remain accepted so an in-flight setup from an older prompt
  // can finish. Scholar owns the checkpoint page and source evidence now.
  page: Type.Optional(Type.Integer({ minimum: 1 })),
  evidence: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
});

const ExamOptionSchema = Type.Object({
  value: Type.String(),
  label: Type.String(),
  misconception: Type.Optional(Type.String()),
});

const ExamRubricSchema = Type.Object({
  id: Type.String(),
  criterion: Type.String(),
  requiredEvidence: Type.Array(Type.String()),
  points: Type.Number({ minimum: 0.25 }),
});

const ExamQuestionSchema = Type.Object({
  id: Type.String(),
  sectionIds: Type.Array(Type.String(), { minItems: 1 }),
  claim: Type.String(),
  requiredEvidence: Type.Array(Type.String(), { minItems: 1 }),
  dimensions: Type.Array(Type.String(), { minItems: 1 }),
  format: Type.Union([Type.Literal("multiple-choice"), Type.Literal("open")]),
  prompt: Type.String(),
  options: Type.Optional(Type.Array(ExamOptionSchema, { minItems: 2 })),
  correctAnswer: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String(), { minItems: 1 })])),
  rubric: Type.Optional(Type.Array(ExamRubricSchema, { minItems: 1 })),
  explanation: Type.String(),
  maxPoints: Type.Number({ minimum: 0.25 }),
});

const ExamItemResultSchema = Type.Object({
  questionId: Type.String(),
  outcome: Type.Union([
    Type.Literal("correct"),
    Type.Literal("partial"),
    Type.Literal("incorrect"),
    Type.Literal("unanswered"),
  ]),
  earnedPoints: Type.Number({ minimum: 0 }),
  maxPoints: Type.Number({ minimum: 0.25 }),
  feedback: Type.String(),
  diagnosticSummary: Type.Optional(Type.String()),
  firstDecisiveError: Type.Optional(Type.String()),
  correctReasoning: Type.Optional(Type.String()),
  transferableLesson: Type.Optional(Type.String()),
});

const FigureReviewItemSchema = Type.Union([
  Type.Object({ label: Type.String({ minLength: 1, maxLength: 160 }), snapshotId: Type.String({ minLength: 1, maxLength: 200 }) }),
  Type.Object({ label: Type.String({ minLength: 1, maxLength: 160 }), skipReason: Type.String({ minLength: 20, maxLength: 500 }) }),
]);

const FigurePageReviewSchema = Type.Object({
  page: Type.Integer({ minimum: 1 }),
  observation: Type.String({ minLength: 12, maxLength: 500 }),
  figures: Type.Array(FigureReviewItemSchema, { maxItems: 40 }),
});

export const ScholarParams = Type.Object({
  action: Type.Union([
    Type.Literal("read"),
    Type.Literal("view"),
    Type.Literal("snapshot"),
    Type.Literal("image_search"),
    Type.Literal("image_save"),
    Type.Literal("search"),
    Type.Literal("outline"),
    Type.Literal("outline_validate"),
    Type.Literal("notes"),
    Type.Literal("assess"),
    Type.Literal("exam_build"),
    Type.Literal("exam_present"),
    Type.Literal("exam_grade"),
    Type.Literal("status"),
  ]),
  startPage: Type.Optional(Type.Integer({ minimum: 1 })),
  endPage: Type.Optional(Type.Integer({ minimum: 1 })),
  page: Type.Optional(Type.Integer({ minimum: 1 })),
  x: Type.Optional(Type.Integer({ minimum: 0, maximum: 20_000 })),
  y: Type.Optional(Type.Integer({ minimum: 0, maximum: 20_000 })),
  width: Type.Optional(Type.Integer({ minimum: 32, maximum: 20_000 })),
  height: Type.Optional(Type.Integer({ minimum: 32, maximum: 20_000 })),
  canvasWidth: Type.Optional(Type.Integer({ minimum: 32, maximum: 20_000 })),
  canvasHeight: Type.Optional(Type.Integer({ minimum: 32, maximum: 20_000 })),
  caption: Type.Optional(Type.String()),
  imagePageId: Type.Optional(Type.Integer({ minimum: 1 })),
  maxChars: Type.Optional(Type.Integer({ minimum: 1_000, maximum: MAX_TOOL_CHARS })),
  query: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  title: Type.Optional(Type.String()),
  authors: Type.Optional(Type.Array(Type.String())),
  edition: Type.Optional(Type.String()),
  isbn: Type.Optional(Type.String()),
  outlineConfidence: Type.Optional(Type.Union([Type.Literal("verified"), Type.Literal("needs-review")])),
  outlineRevision: Type.Optional(Type.Integer({ minimum: 0 })),
  validationChecks: Type.Optional(Type.Array(OutlineValidationCheckSchema, { minItems: 1, maxItems: 12 })),
  chapters: Type.Optional(Type.Array(OutlineChapterSchema)),
  sectionId: Type.Optional(Type.String()),
  objectives: Type.Optional(Type.Array(Type.String())),
  coveredObjectives: Type.Optional(Type.Array(Type.String())),
  requiredChecks: Type.Optional(Type.Array(CheckKindSchema)),
  synthesis: Type.Optional(Type.String()),
  keyPoints: Type.Optional(Type.Array(Type.String())),
  misconceptions: Type.Optional(Type.Array(Type.String())),
  figureReviews: Type.Optional(Type.Array(FigurePageReviewSchema, { maxItems: 200 })),
  kind: Type.Optional(CheckKindSchema),
  format: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("multiple-choice")])),
  question: Type.Optional(Type.String()),
  attemptId: Type.Optional(Type.String()),
  grounding: Type.Optional(QuestionGroundingSchema),
  feedback: Type.Optional(Type.String()),
  outcome: Type.Optional(Type.Union([
    Type.Literal("pending"),
    Type.Literal("pass"),
    Type.Literal("review"),
    Type.Literal("unsure"),
    Type.Literal("cancelled"),
  ])),
  difficulty: Type.Optional(Type.String()),
  examId: Type.Optional(Type.String()),
  questions: Type.Optional(Type.Array(ExamQuestionSchema, {
    minItems: 1,
    description: "Build at least one question according to concept coverage, with multiple distinct probes for important concepts when useful. There is no fixed question-count cap; avoid redundant questions.",
  })),
  // Runtime validation requires exactly one result per frozen question.
  itemResults: Type.Optional(Type.Array(ExamItemResultSchema, { minItems: 1 })),
});

export type ToolDetails = {
  action: string;
  summary: string;
  bookId?: string;
  sectionId?: string;
  attemptId?: string;
  startPage?: number;
  endPage?: number;
  page?: number;
  characters?: number;
  bytes?: number;
  width?: number;
  height?: number;
  reused?: boolean;
  imageId?: string;
  outlineRevision?: number;
  checkpoints?: Array<{ id: string; page: number; kind: "heading" | "coverage"; label: string }>;
  tone?: "progress" | "retry" | "review" | "error";
  validationReport?: OutlineValidationReport;
};
