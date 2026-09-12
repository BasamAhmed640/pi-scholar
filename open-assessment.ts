import { createHash } from "node:crypto";
import type { AssessmentAttempt, ScholarBook } from "./types.ts";
import { findSection } from "./types.ts";
import type { ScholarRuntimeSession } from "./runtime-session.ts";

export interface OpenAssessmentContract { expectedAnswer: string; criteria: string[] }
export interface OpenAssessmentEvaluation {
  criteria: Array<{ criterionIndex: number; met: boolean; evidence?: string; imageIndex?: number }>;
}
export interface OpenAssessmentSubmission { submittedAt: string; responseHash: string; questionHash: string }
export interface OpenResponseImage { data: string; mimeType: string }

const record = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && !!value.trim();
const keys = (value: Record<string, any>, allowed: string[]) => Object.keys(value).every((key) => allowed.includes(key));
const normalized = (value: string) => value.replace(/\s+/g, " ").trim();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

export function isOpenAssessmentContract(value: unknown): value is OpenAssessmentContract {
  return record(value) && keys(value, ["expectedAnswer", "criteria"]) && text(value.expectedAnswer)
    && Array.isArray(value.criteria) && value.criteria.length > 0 && value.criteria.length <= 12
    && value.criteria.every(text) && new Set(value.criteria.map((item: string) => normalized(item).toLowerCase())).size === value.criteria.length;
}

export function isOpenAssessmentEvaluation(value: unknown): value is OpenAssessmentEvaluation {
  return record(value) && keys(value, ["criteria"]) && Array.isArray(value.criteria) && value.criteria.length > 0
    && value.criteria.length <= 12 && value.criteria.every((item: unknown) => record(item)
      && keys(item, ["criterionIndex", "met", "evidence", "imageIndex"]) && Number.isInteger(item.criterionIndex)
      && item.criterionIndex >= 1 && typeof item.met === "boolean" && (item.evidence === undefined || text(item.evidence))
      && (item.imageIndex === undefined || (Number.isInteger(item.imageIndex) && item.imageIndex >= 1)))
    && new Set(value.criteria.map((item: { criterionIndex: number }) => item.criterionIndex)).size === value.criteria.length;
}

export function isOpenAssessmentSubmission(value: unknown): value is OpenAssessmentSubmission {
  return record(value) && keys(value, ["submittedAt", "responseHash", "questionHash"])
    && typeof value.submittedAt === "string" && Number.isFinite(Date.parse(value.submittedAt))
    && typeof value.responseHash === "string" && /^[a-f0-9]{64}$/.test(value.responseHash)
    && typeof value.questionHash === "string" && /^[a-f0-9]{64}$/.test(value.questionHash);
}

export function prepareOpenAssessment(expectedAnswer: unknown, criteria: unknown): OpenAssessmentContract {
  const contract = { expectedAnswer: typeof expectedAnswer === "string" ? expectedAnswer.trim() : expectedAnswer,
    criteria: Array.isArray(criteria) ? criteria.map((item) => typeof item === "string" ? item.trim() : item) : criteria };
  if (!isOpenAssessmentContract(contract)) throw new Error("Prepare the expectedAnswer and 1–12 distinct observable grading criteria before presenting an open question.");
  return contract;
}

/** Includes the displayed prompt and immutable grading basis; edits invalidate a pending input receipt. */
export function openQuestionFingerprint(attempt: AssessmentAttempt): string {
  return hash(JSON.stringify([attempt.id, attempt.createdAt, attempt.question, attempt.kind, attempt.difficulty,
    attempt.grounding, attempt.openAssessment]));
}

function targetAttempt(book: ScholarBook, session: ScholarRuntimeSession): AssessmentAttempt | undefined {
  const target = session.mode === "learn" ? findSection(book, session.recordId)
    : session.mode === "tutor" ? book.tutorSessions.find((item) => item.id === session.recordId && item.status === "active") : undefined;
  const last = target?.attempts.at(-1);
  return last?.format === "open" && last.outcome === "pending" ? last : undefined;
}

type Receipt = OpenAssessmentSubmission & { target: string; response: string; imageHashes: string[]; armed: boolean };
const imageHashes = (images: OpenResponseImage[]) => images.map((image) =>
  createHash("sha256").update(image.mimeType).update("\0").update(Buffer.from(image.data, "base64")).digest("hex"));
const explicitCancellation = (value: string) => /^(?:please\s+)?(?:cancel|skip|discard|drop)(?:\s+(?:(?:this|the|current|pending|that)\s+)?(?:question|item|exercise|one))?(?:\s+please)?[.!]?$/i.test(normalized(value));

/** Runtime-only answer receipt. Raw chat never enters a note, cache, or session custom entry. */
export class OpenResponseGate {
  private receipt?: Receipt;
  clear(): void { this.receipt = undefined; }
  private target(book: ScholarBook, session: ScholarRuntimeSession): string {
    return JSON.stringify([book.id, book.instanceId, session.mode, session.recordId]);
  }
  capture(book: ScholarBook, session: ScholarRuntimeSession, response: string, source: string, images: OpenResponseImage[] = []): void {
    this.clear();
    if (source !== "interactive" || typeof response !== "string" || (!response.trim() && !images.length) || /^\s*\//.test(response)) return;
    if (images.some((image) => !text(image.data) || !text(image.mimeType))) return;
    const attempt = targetAttempt(book, session);
    if (!attempt || (!isOpenAssessmentContract(attempt.openAssessment) && !explicitCancellation(response))) return;
    const hashes = imageHashes(images);
    this.receipt = { target: this.target(book, session), response, imageHashes: hashes, armed: false,
      submittedAt: new Date().toISOString(), responseHash: hash(JSON.stringify([response, hashes])), questionHash: openQuestionFingerprint(attempt) };
  }
  beginTurn(book: ScholarBook, session: ScholarRuntimeSession, prompt: string, images: OpenResponseImage[] = []): void {
    const receipt = this.receipt;
    const attempt = targetAttempt(book, session);
    if (!receipt || receipt.armed || typeof prompt !== "string" || !attempt || receipt.target !== this.target(book, session)
      || receipt.questionHash !== openQuestionFingerprint(attempt) || normalized(receipt.response) !== normalized(prompt)
      || JSON.stringify(receipt.imageHashes) !== JSON.stringify(imageHashes(images))) {
      this.clear(); return;
    }
    receipt.armed = true;
  }
  assertCancellation(book: ScholarBook, session: ScholarRuntimeSession, attempt: AssessmentAttempt): void {
    const receipt = this.receipt;
    if (!receipt?.armed || receipt.target !== this.target(book, session) || receipt.questionHash !== openQuestionFingerprint(attempt)
      || !explicitCancellation(receipt.response)) {
      throw new Error('Keep this unanswered question pending unless the learner explicitly requests cancellation. To discard it, the learner can type "cancel this question"; stopping or closing Scholar only pauses it.');
    }
  }
  evaluate(book: ScholarBook, session: ScholarRuntimeSession, attempt: AssessmentAttempt, value: unknown): {
    outcome: "pass" | "review"; evaluation: OpenAssessmentEvaluation; submission: OpenAssessmentSubmission;
  } {
    const receipt = this.receipt;
    if (!receipt?.armed || receipt.target !== this.target(book, session) || receipt.questionHash !== openQuestionFingerprint(attempt)) {
      throw new Error("This exact pending question has no learner response in the current turn. Wait for actual user input; after restart, ask the learner to submit their response again. Never grade a continuation command.");
    }
    if (!isOpenAssessmentContract(attempt.openAssessment)) throw new Error("Prepare the saved open question's grading contract before accepting a response.");
    if (!isOpenAssessmentEvaluation(value) || value.criteria.length !== attempt.openAssessment.criteria.length
      || value.criteria.some((item) => item.criterionIndex > attempt.openAssessment!.criteria.length)) {
      throw new Error("Evaluate every frozen criterion exactly once using its 1-based criterionIndex and met flag.");
    }
    for (const item of value.criteria) {
      if (item.imageIndex !== undefined && item.imageIndex > receipt.imageHashes.length) {
        throw new Error(`Criterion ${item.criterionIndex} references an image that was not attached to this learner response.`);
      }
      if (item.met && (!item.evidence || (item.imageIndex === undefined && !normalized(receipt.response).includes(normalized(item.evidence))))) {
        throw new Error(`Criterion ${item.criterionIndex} marked met needs a verbatim evidence excerpt from the actual learner response.`);
      }
    }
    return {
      outcome: value.criteria.every((item) => item.met) ? "pass" : "review",
      // Validate quotations in memory, then discard them rather than recording raw answers.
      evaluation: { criteria: value.criteria.map(({ criterionIndex, met }) => ({ criterionIndex, met })).sort((a, b) => a.criterionIndex - b.criterionIndex) },
      submission: { submittedAt: receipt.submittedAt, responseHash: receipt.responseHash, questionHash: receipt.questionHash },
    };
  }
}
