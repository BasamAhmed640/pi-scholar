import type { AssessmentAttempt, ScholarBook, TranscriptEntry } from "./types.ts";

type HistoryRecord = { transcript: TranscriptEntry[]; attempts?: AssessmentAttempt[] };

// A validated lesson edit may change exactly one entry in this in-memory
// transaction. Receipts are never serialized or reusable against a later load.
const revisionKey = Symbol.for("pi.scholar.validated-lesson-revisions");
type RevisionBook = ScholarBook & { [revisionKey]?: Map<TranscriptEntry, { before: string; after: string }> };

export function recordValidatedLessonRevision(book: ScholarBook, entry: TranscriptEntry, before: string): void {
  const revisions = (book as RevisionBook)[revisionKey] || new Map();
  const prior = revisions.get(entry);
  if (prior && prior.after !== before) throw new Error("The lesson changed outside its validated revision.");
  revisions.set(entry, { before: prior?.before || before, after: JSON.stringify(entry) });
  // A non-enumerable symbol also survives separately loaded extension modules,
  // but cannot enter JSON, the vault, or a structuredClone of this transaction.
  Object.defineProperty(book, revisionKey, { value: revisions, configurable: true });
}

function records(book: ScholarBook): Map<string, HistoryRecord> {
  return new Map<string, HistoryRecord>([
    ...book.chapters.flatMap((chapter) => chapter.sections.map((section) => [`learn:${section.id}`, section] as const)),
    ...book.exams.map((exam) => [`exam:${exam.id}`, exam] as const),
    ...book.tutorSessions.map((tutor) => [`tutor:${tutor.id}`, tutor] as const),
  ]);
}

/**
 * Enforced at the shared commit boundary: ordinary updates may append history
 * and resolve pending attempts, never trim or retarget earlier learning.
 * Does not recover deleted books or turn visible notes into state authority.
 */
export function assertDurableHistoryPreserved(before: ScholarBook, after: ScholarBook): void {
  const revisions = (after as RevisionBook)[revisionKey];
  delete (after as RevisionBook)[revisionKey];
  const nextRecords = records(after);
  for (const [key, previous] of records(before)) {
    const next = nextRecords.get(key);
    const reject = (detail: string): never => {
      throw new Error(`Scholar refused an update that would erase or rewrite saved history in ${key}: ${detail}. The saved book was left unchanged.`);
    };
    for (const [index, entry] of previous.transcript.entries()) {
      const current = next?.transcript[index];
      const revision = current && revisions?.get(current);
      const validated = entry.lesson && revision?.before === JSON.stringify(entry) && revision.after === JSON.stringify(current);
      if (!current || entry.id !== current.id || entry.kind !== current.kind
        || entry.createdAt !== current.createdAt
        || (!validated && (entry.markdown !== current.markdown || JSON.stringify(entry.lesson) !== JSON.stringify(current.lesson)))) {
        reject(`transcript ${entry.id}`);
      }
    }
    for (const [index, attempt] of (previous.attempts || []).entries()) {
      const current = next?.attempts?.[index];
      if (!current || attempt.id !== current.id || attempt.question !== current.question
        || attempt.format !== current.format || attempt.kind !== current.kind
        || attempt.toolCallId !== current.toolCallId || attempt.createdAt !== current.createdAt) {
        reject(`question ${attempt.id}`);
      }
      if (attempt.quiz && JSON.stringify(attempt.quiz) !== JSON.stringify(current!.quiz)) reject(`frozen quiz ${attempt.id}`);
      if (attempt.resumeToolCallIds?.some((id, position) => current!.resumeToolCallIds?.[position] !== id)) reject(`quiz deliveries ${attempt.id}`);
      const reopeningUnanswered = (attempt.outcome === "cancelled" || attempt.outcome === "unavailable")
        && current!.outcome === "pending" && current!.quiz && !attempt.correctAnswer;
      if (attempt.outcome !== "pending" && !reopeningUnanswered) {
        for (const field of ["outcome", "correctAnswer", "feedback"] as const) {
          // Recovery may fill a historically missing key/feedback, never
          // replace a result that the learner has already received.
          if (attempt[field] !== undefined && attempt[field] !== ""
            && attempt[field] !== current![field]) reject(`finalized ${field} for ${attempt.id}`);
        }
      }
    }
  }
}
