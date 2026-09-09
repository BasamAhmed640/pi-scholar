import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  buildExamBreakdown,
  examBlueprint,
  examBlueprintSummary,
  examFormIssues,
  gradingPacket,
  validateExamQuestions,
} from "../exam.ts";
import type { ToolDetails } from "../tool-contract.ts";
import type {
  ExamBreakdown,
  ExamItemResult,
  ExamQuestion,
  ScholarBook,
  ScholarExam,
} from "../types.ts";

type MutateBook = <T>(
  bookId: string,
  mutate: (book: ScholarBook) => Promise<T> | T,
) => Promise<{ book: ScholarBook; result: T; projectionStatus?: "synced" | "pending" }>;

type ToolResultFn = (
  action: string,
  summary: string,
  details?: Partial<ToolDetails>,
) => { content: Array<{ type: "text"; text: string }>; details: ToolDetails };

export type PresentExamFn = (
  bookId: string,
  examId: string,
  ctx?: ExtensionContext,
) => Promise<{ exam: ScholarExam; path?: string }>;

export async function handleExamBuild(
  book: ScholarBook,
  examId: string,
  rawQuestions: unknown[],
  ctx: ExtensionContext | undefined,
  mutateBook: MutateBook,
  presentExam: PresentExamFn,
  toolResult: ToolResultFn,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: ToolDetails }> {
  const current = book.exams.find((item) => item.id === examId);
  if (!current || current.status !== "draft" || current.questions.length) {
    throw new Error("The active exam is not an empty draft.");
  }
  const questions = validateExamQuestions(current, (rawQuestions || []) as ExamQuestion[]);
  const blueprint = examBlueprint(current, questions);
  const formIssues = examFormIssues(blueprint);
  if (formIssues.length > 0) {
    throw new Error(`This exam form does not meet the question engine's standard. ${formIssues.join(" ")}`);
  }
  await mutateBook(book.id, (state) => {
    const exam = state.exams.find((item) => item.id === examId);
    if (!exam || exam.status !== "draft" || exam.questions.length) {
      throw new Error("The exam changed while its form was being built.");
    }
    exam.questions = questions;
    exam.maxPoints = questions.reduce((sum, question) => sum + question.maxPoints, 0);
    exam.earnedPoints = 0;
    exam.percent = 0;
    exam.status = "active";
    exam.startedAt = new Date().toISOString();
    exam.updatedAt = exam.startedAt;
  });
  const presented = await presentExam(book.id, examId, ctx);
  return toolResult(
    "exam_build",
    `${presented.exam.title} is ready (${examBlueprintSummary(blueprint)}). Answer and save the paper in Obsidian: ${presented.path}. Submit with /scholar exam "${examId}" submit. End this turn and wait for explicit submission; do not grade or reveal the key.`,
    { bookId: book.id },
  );
}

export async function handleExamPresent(
  book: ScholarBook,
  examId: string,
  ctx: ExtensionContext | undefined,
  presentExam: PresentExamFn,
  toolResult: ToolResultFn,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: ToolDetails }> {
  const presented = await presentExam(book.id, examId, ctx);
  if (presented.exam.status === "submitted") {
    return {
      content: [{ type: "text" as const, text: gradingPacket(presented.exam) }],
      details: {
        action: "exam_present",
        summary: `${presented.exam.title} submitted; grade it now.`,
        bookId: book.id,
      } satisfies ToolDetails,
    };
  }
  return toolResult(
    "exam_present",
    presented.exam.status === "active"
      ? `${presented.exam.title} is ready in Obsidian: ${presented.path}. Answer and save there, then /scholar exam "${examId}" submit. End this turn; wait for explicit submission without hints or grading.`
      : `${presented.exam.title} is already ${presented.exam.status}. Do not re-grade it.`,
    { bookId: book.id },
  );
}

export async function handleExamGrade(
  book: ScholarBook,
  examId: string,
  rawItemResults: unknown,
  mutateBook: MutateBook,
  toolResult: ToolResultFn,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: ToolDetails }> {
  const exam = book.exams.find((item) => item.id === examId);
  if (!exam || exam.status !== "submitted") throw new Error("Only a submitted exam can be graded.");
  if (!Array.isArray(rawItemResults)) throw new Error("exam_grade itemResults must be an array of question results.");
  const supplied = rawItemResults.map((item: unknown, index): Record<string, unknown> => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`exam_grade itemResults[${index}] must be a question result object.`);
    }
    return item as Record<string, unknown>;
  });
  if (
    supplied.length !== exam.questions.length
    || new Set(supplied.map((item) => item.questionId)).size !== exam.questions.length
  ) {
    throw new Error("exam_grade requires exactly one unique result for every frozen question.");
  }
  const results = exam.questions.map((question): ExamItemResult => {
    const result = supplied.find((item) => item.questionId === question.id);
    if (!result) throw new Error(`Missing result for ${question.id}.`);
    // NaN and Infinity pass every comparison below (NaN < 0 is false, and so
    // is NaN > max), so they must be excluded before the range checks.
    const { earnedPoints, maxPoints, outcome } = result;
    if (typeof earnedPoints !== "number" || !Number.isFinite(earnedPoints)
      || typeof maxPoints !== "number" || !Number.isFinite(maxPoints)) {
      throw new Error(`Result ${question.id} has a non-numeric score; earnedPoints and maxPoints must be finite numbers.`);
    }
    if (
      Math.abs(maxPoints - question.maxPoints) > 1e-7 * Math.max(1, maxPoints, question.maxPoints)
      || maxPoints <= 0
      || earnedPoints < 0
      || earnedPoints > question.maxPoints
    ) {
      throw new Error(`Invalid score for ${question.id}.`);
    }
    if (outcome !== "correct" && outcome !== "partial" && outcome !== "incorrect" && outcome !== "unanswered") {
      throw new Error(`Result ${question.id} outcome must be correct, partial, incorrect, or unanswered.`);
    }
    if (
      (outcome === "correct" && Math.abs(earnedPoints - question.maxPoints) > 1e-7 * Math.max(1, question.maxPoints))
      || (outcome === "partial" && !(earnedPoints > 0 && earnedPoints < question.maxPoints))
      || ((outcome === "incorrect" || outcome === "unanswered") && earnedPoints !== 0)
    ) {
      throw new Error(`Result ${question.id} outcome "${outcome}" contradicts its score ${earnedPoints}/${question.maxPoints}. Use correct for full credit, partial for credit strictly between zero and full, and incorrect or unanswered for zero credit.`);
    }
    if (typeof result.feedback !== "string" || !result.feedback.trim()) {
      throw new Error(`Result ${question.id} needs diagnostic feedback.`);
    }
    const response = exam.rawResponses.find((item) => item.questionId === question.id)?.response;
    if (response !== undefined && (Array.isArray(response) ? response.every((value) => !value.trim()) : !response.trim())) {
      // Absence is not evidence of a misconception, and never earns credit,
      // even if a model accidentally marks the blank answer correct.
      return { questionId: question.id, outcome: "unanswered", earnedPoints: 0, maxPoints: question.maxPoints, feedback: "Not answered — 0 points. Review the correct answer and reasoning below." };
    }
    // Freeze the maximum to the question and persist only schema-owned fields.
    const normalized: ExamItemResult = { questionId: question.id, outcome, earnedPoints, maxPoints: question.maxPoints, feedback: result.feedback.trim() };
    for (const field of ["diagnosticSummary", "firstDecisiveError", "correctReasoning", "transferableLesson"] as const) {
      const value = result[field];
      if (value === undefined) continue;
      if (typeof value !== "string" || !value.trim()) throw new Error(`Result ${question.id} ${field} must be non-empty text when supplied; otherwise omit it.`);
      normalized[field] = value.trim();
    }
    return normalized;
  });
  const earnedPoints = results.reduce((sum, result) => sum + result.earnedPoints, 0);
  const maxPoints = exam.questions.reduce((sum, question) => sum + question.maxPoints, 0);
  const breakdown = buildExamBreakdown(book, exam, results);
  const mutation = await mutateBook(book.id, (state) => {
    const current = state.exams.find((item) => item.id === examId);
    if (!current || current.status !== "submitted") throw new Error("The exam changed while grading.");
    current.itemResults = results;
    current.breakdown = breakdown;
    current.earnedPoints = earnedPoints;
    current.maxPoints = maxPoints;
    current.percent = maxPoints > 0 ? Math.round((earnedPoints / maxPoints) * 1000) / 10 : 0;
    current.status = "graded";
    current.gradedAt = new Date().toISOString();
    current.updatedAt = current.gradedAt;
  });
  const graded = mutation.book.exams.find((item) => item.id === examId)!;
  return toolResult(
    "exam_grade",
    `${graded.title} graded: ${graded.earnedPoints}/${graded.maxPoints} (${graded.percent}%). ${mutation.projectionStatus === "pending" ? "The grade is saved; the Obsidian note update is pending. Reopen this exam to retry projection without re-grading." : "The report and answer key are now in Obsidian."}`,
    { bookId: book.id },
  );
}
