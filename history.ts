import type { AssessmentAttempt, ScholarBook, TranscriptEntry } from "./types.ts";

type HistoryRecord = { transcript: TranscriptEntry[]; attempts?: AssessmentAttempt[] };

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
  const nextRecords = records(after);
  for (const [key, previous] of records(before)) {
    const next = nextRecords.get(key);
    const reject = (detail: string): never => {
      throw new Error(`Scholar refused an update that would erase or rewrite saved history in ${key}: ${detail}. The saved book was left unchanged.`);
    };
    for (const [index, entry] of previous.transcript.entries()) {
      const current = next?.transcript[index];
      if (!current || entry.id !== current.id || entry.kind !== current.kind
        || entry.markdown !== current.markdown || entry.createdAt !== current.createdAt) {
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
      if (attempt.outcome !== "pending") {
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
