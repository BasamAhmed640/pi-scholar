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

const KeyEquationSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 120 }), title: Type.String({ minLength: 1 }),
  latex: Type.String({ minLength: 1, description: "Display mathematics without outer delimiters." }),
  symbols: Type.Array(Type.Object({ symbol: Type.String({ minLength: 1 }), definition: Type.String({ minLength: 1 }) }), { minItems: 1 }),
  assumptions: Type.String({ minLength: 1 }), meaning: Type.String({ minLength: 1 }),
  sourcePages: Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1 }),
});
const SourceCoverageSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 120 }),
  kind: Type.Union(["concept", "definition", "derivation", "equation", "assumption", "example", "counterexample", "figure"].map(kind => Type.Literal(kind))),
  description: Type.String({ minLength: 1 }), sourcePages: Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1 }),
  objective: Type.String({ minLength: 1 }),
  lessonId: Type.Optional(Type.String()), evidence: Type.Optional(Type.String({ description: "Exact explanatory passage in the saved lesson; required at completion, not just a heading or label." })),
  equationId: Type.Optional(Type.String()), snapshotId: Type.Optional(Type.String()),
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
  sourceCoverage: Type.Optional(Type.Array(SourceCoverageSchema, { description: "Source-based checklist of essential concepts, derivations, central equations, assumptions, examples/counterexamples and useful figures. Map each to exact saved lesson evidence before completion." })),
  lesson: Type.Optional(Type.Object({
    id: Type.String({ minLength: 1, maxLength: 120 }),
    expectedContentHash: Type.Optional(Type.String({ description: "For an intentional editorial replacement, hash of the currently visible entry. Omit for new entries and identical retries." })),
    title: Type.String({ minLength: 1 }),
    markdown: Type.String({ minLength: 1, description: "The actual explanation, with native Markdown/math/callouts. Place saved PDF figures using [[scholar-figure:snapshot-ID]]. Reuse an id only for an identical retry." }),
    objectives: Type.Array(Type.String()),
    keyPoints: Type.Array(Type.String()),
    sourcePages: Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1 }),
    keyEquations: Type.Optional(Type.Array(KeyEquationSchema, { description: "Central equations. Place each exactly once using its own-line [[scholar-equation:ID]] marker; Scholar builds the equation callout." })),
  })),
  lessonComplete: Type.Optional(Type.Boolean({ description: "Commit the full saved Learn lesson after all declared objectives have real explanations and the editorial review is complete. Does not award mastery." })),
  lessonId: Type.Optional(Type.String({ description: "With action=status, read this saved lesson entry and its current content hash before an intentional revision." })),
  objectiveChecks: Type.Optional(Type.Array(Type.Object({ objective: Type.String(), checks: Type.Array(CheckKindSchema, { minItems: 1 }) }))),
  keyPoints: Type.Optional(Type.Array(Type.String())),
  misconceptions: Type.Optional(Type.Array(Type.String())),
  figureReviews: Type.Optional(Type.Array(FigurePageReviewSchema, { maxItems: 200 })),
  kind: Type.Optional(CheckKindSchema),
  format: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("multiple-choice")])),
  question: Type.Optional(Type.String()),
  attemptId: Type.Optional(Type.String()),
  grounding: Type.Optional(QuestionGroundingSchema),
  feedback: Type.Optional(Type.String()),
  expectedAnswer: Type.Optional(Type.String()),
  criteria: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 12 })),
  evaluation: Type.Optional(Type.Object({ criteria: Type.Array(Type.Object({
    criterionIndex: Type.Integer({ minimum: 1, maximum: 12 }), met: Type.Boolean(), evidence: Type.Optional(Type.String()), imageIndex: Type.Optional(Type.Integer({ minimum: 1 })),
  }), { minItems: 1, maxItems: 12 }) })),
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
