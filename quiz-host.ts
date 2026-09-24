import { applyQuizAnswer, findQuizSet } from "./domain.ts";
import type { ObservedScholarQuizDetails, FrozenScholarQuiz } from "./quiz-contract.ts";
import type { ScholarBook } from "./types.ts";

export type SavedQuizItem = { attemptId: string; quiz: FrozenScholarQuiz };
export type ScholarQuizHost = {
  load(toolCallId: string): Promise<SavedQuizItem[]>;
  record(toolCallId: string, attemptId: string, result: ObservedScholarQuizDetails): Promise<"saved" | "gone">;
};

export function createScholarQuizHost(ports: {
  active(): { bookId: string; mode: "learn" | "tutor"; recordId: string } | undefined;
  loadBook(bookId: string): Promise<ScholarBook | undefined>;
  mutateBook(bookId: string, mutator: (book: ScholarBook) => boolean): Promise<{ result: boolean }>;
  ownsBook(book: ScholarBook): boolean;
  onLoaded?(): void;
}): ScholarQuizHost {
  const active = () => {
    const target = ports.active();
    if (!target) throw new Error("Open Scholar Learn or Tutor first.");
    return target;
  };
  const load = async (toolCallId: string): Promise<SavedQuizItem[]> => {
    const target = active();
    const book = await ports.loadBook(target.bookId);
    if (!book || !ports.ownsBook(book)) throw new Error("The active Scholar book changed.");
    const found = findQuizSet(book, target.mode, target.recordId, toolCallId);
    if (!found) throw new Error("This quiz was not approved or has already been answered.");
    const pending = found.attempts.filter((attempt) => attempt.outcome === "pending");
    if (!pending.length || pending.some((attempt) => !attempt.quiz)) {
      throw new Error("This quiz was not approved or has already been answered.");
    }
    ports.onLoaded?.();
    return pending.map((attempt) => ({ attemptId: attempt.id, quiz: structuredClone(attempt.quiz!) }));
  };
  const saveOnce = async (toolCallId: string, attemptId: string, result: ObservedScholarQuizDetails): Promise<"saved" | "gone"> => {
    const target = active();
    const mutation = await ports.mutateBook(target.bookId, (book) => {
      if (!ports.ownsBook(book)) throw new Error("The active Scholar book changed.");
      const found = findQuizSet(book, target.mode, target.recordId, toolCallId);
      const attempt = found?.attempts.find((item) => item.id === attemptId);
      if (!found || !attempt || attempt.outcome !== "pending") return false;
      if (!applyQuizAnswer(book, found.record, attempt, result)) {
        throw new Error("The quiz answer did not match its saved form.");
      }
      return true;
    });
    return mutation.result ? "saved" : "gone";
  };
  return {
    load,
    async record(toolCallId, attemptId, result) {
      try {
        return await saveOnce(toolCallId, attemptId, result);
      } catch (firstError) {
        // Retry only while this exact pending form remains authoritative. A
        // projection or transient filesystem error can clear between loads.
        const fresh = await load(toolCallId).catch(() => []);
        if (!fresh.some((item) => item.attemptId === attemptId)) return "gone";
        return saveOnce(toolCallId, attemptId, result).catch((secondError) => {
          throw new Error(`Scholar could not save this answer after retry: ${secondError instanceof Error ? secondError.message : String(secondError)}`, { cause: firstError });
        });
      }
    },
  };
}
