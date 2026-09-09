import { resolve } from "node:path";
import {
  findQuizAttempt,
  findSection,
  findTutorQuizAttempt,
  messageTranscriptEntry,
  transcriptId,
  appendTranscript,
  recomputeProgress,
} from "./domain.ts";
import {
  parseScholarQuizDetails,
  parseScholarQuizInput,
  scholarQuizCorrectAnswer,
  SCHOLAR_QUIZ_TOOL_NAME,
} from "./quiz-contract.ts";
import {
  SCHOLAR_SESSION_STATE_TYPE,
  type ScholarRuntimeSession,
  type ScholarSessionPointer,
} from "./runtime-session.ts";
import type {
  AssessmentOutcome,
  ScholarBook,
  ScholarMode,
  TranscriptEntry,
} from "./types.ts";

export type FrozenRecoveryTarget = {
  readonly vaultPath: string;
  readonly bookId: string;
  readonly instanceId: string;
  readonly mode: ScholarMode;
  readonly recordId: string;
};

export type RecoveryOutcome =
  | { readonly kind: "success"; readonly writtenCount: number; readonly attemptsRepaired?: number }
  | { readonly kind: "noop"; readonly message: string }
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "error"; readonly error: string };

export function normalizeVaultPathKey(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "";
  const isCaseInsensitive = process.platform === "win32" && (/^[a-zA-Z]:/.test(trimmed) || trimmed.startsWith("\\\\"));
  const resolved = resolve(trimmed);
  return isCaseInsensitive ? resolved.toLowerCase() : resolved;
}

export function isSameVaultPath(left?: string, right?: string): boolean {
  if (!left?.trim() || !right?.trim()) return false;
  return normalizeVaultPathKey(left) === normalizeVaultPathKey(right);
}

export function freezeRecoveryTarget(
  vaultPath: string | undefined,
  session: ScholarRuntimeSession,
  activeAuthority?: { bookId: string; instanceId: string },
): FrozenRecoveryTarget | undefined {
  if (!vaultPath?.trim()) return undefined;
  if (!session.active || !session.bookId || !session.mode || !session.recordId) return undefined;
  if (!activeAuthority || activeAuthority.bookId !== session.bookId) return undefined;
  return Object.freeze({
    vaultPath: vaultPath.trim(),
    bookId: session.bookId,
    instanceId: activeAuthority.instanceId,
    mode: session.mode,
    recordId: session.recordId,
  });
}

export function freezeExplicitTarget(
  vaultPath: string | undefined,
  bookId: string | undefined,
  instanceId: string | undefined,
  mode: ScholarMode | undefined,
  recordId: string | undefined,
): FrozenRecoveryTarget | undefined {
  if (!vaultPath?.trim() || !bookId?.trim() || !instanceId?.trim() || !mode || !recordId?.trim()) return undefined;
  return Object.freeze({
    vaultPath: vaultPath.trim(),
    bookId: bookId.trim(),
    instanceId: instanceId.trim(),
    mode,
    recordId: recordId.trim(),
  });
}

function pointerMatchesTargetIdentity(
  data: ScholarSessionPointer | undefined,
  target: FrozenRecoveryTarget,
): boolean {
  if (!data || !data.active) return false;
  if (data.bookId !== target.bookId) return false;
  if (data.instanceId !== target.instanceId) return false;
  if (data.mode !== target.mode) return false;
  return target.mode === "learn"
    ? (data.recordId === target.recordId || data.sectionId === target.recordId)
    : data.recordId === target.recordId;
}

function pointerMatchesTarget(
  data: ScholarSessionPointer | undefined,
  target: FrozenRecoveryTarget,
  allowMissingVault = false,
): boolean {
  if (!pointerMatchesTargetIdentity(data, target)) return false;
  if (data.vaultPath !== undefined) {
    return isSameVaultPath(data.vaultPath, target.vaultPath);
  }
  return allowMissingVault;
}

function isBoundaryPointer(entry: any, target: FrozenRecoveryTarget, allowMissingVault = false): boolean {
  if (entry?.type !== "custom" || entry.customType !== SCHOLAR_SESSION_STATE_TYPE) return false;
  const data = entry.data as ScholarSessionPointer | undefined;
  return !pointerMatchesTarget(data, target, allowMissingVault);
}

export type RecoverTranscriptOptions = {
  target: FrozenRecoveryTarget;
  branch: readonly any[];
  loadBook: (bookId: string) => Promise<ScholarBook | undefined>;
  mutateBook: (bookId: string, mutator: (book: ScholarBook) => void) => Promise<{
    book: ScholarBook;
    result: unknown;
    projectionStatus: "synced" | "pending";
    projectionError?: unknown;
  }>;
  isAutomatic?: boolean;
};

export async function recoverTranscriptTarget(options: RecoverTranscriptOptions): Promise<RecoveryOutcome> {
  const { target, branch, loadBook, mutateBook, isAutomatic = true } = options;
  if (!Array.isArray(branch) || branch.length === 0) {
    return { kind: "skipped", reason: "empty-branch" };
  }

  // 0. Pre-validate that the book authority exists and instance matches
  const currentBook = await loadBook(target.bookId);
  if (!currentBook || currentBook.instanceId !== target.instanceId) {
    return { kind: "skipped", reason: "book-missing-or-instance-mismatch" };
  }

  // 1. Locate the latest matching pointer in branch
  let lastMatchingIndex = -1;
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type === "custom" && entry.customType === SCHOLAR_SESSION_STATE_TYPE) {
      const data = entry.data as ScholarSessionPointer | undefined;
      if (pointerMatchesTargetIdentity(data, target)) {
        lastMatchingIndex = index;
        break;
      }
    }
  }

  if (lastMatchingIndex === -1) {
    return { kind: "skipped", reason: "target-not-activated-on-branch" };
  }

  const matchingPointerData = branch[lastMatchingIndex].data as ScholarSessionPointer | undefined;
  if (matchingPointerData?.vaultPath === undefined) {
    if (isAutomatic) {
      return { kind: "skipped", reason: "legacy-pointer-ambiguous" };
    }
  } else if (!isSameVaultPath(matchingPointerData.vaultPath, target.vaultPath)) {
    return { kind: "skipped", reason: "vault-mismatch" };
  }

  // 2. Identify the contiguous activation interval [startIndex, endIndex)
  let endIndex = branch.length;
  for (let index = lastMatchingIndex + 1; index < branch.length; index++) {
    const entry = branch[index];
    if (isBoundaryPointer(entry, target, !isAutomatic)) {
      endIndex = index;
      break;
    }
  }

  let startIndex = lastMatchingIndex;
  for (let index = lastMatchingIndex - 1; index >= 0; index--) {
    const entry = branch[index];
    if (isBoundaryPointer(entry, target, !isAutomatic)) {
      break;
    }
    if (entry?.type === "custom" && entry.customType === SCHOLAR_SESSION_STATE_TYPE) {
      const data = entry.data as ScholarSessionPointer | undefined;
      if (pointerMatchesTarget(data, target, !isAutomatic)) {
        startIndex = index;
      }
    }
  }

  // 3. Checkpoint evaluation
  const sessionHeader = branch.find((e) => e?.type === "session");
  const currentSessionId = typeof sessionHeader?.id === "string" ? sessionHeader.id : undefined;

  const activationEntry = branch[startIndex];
  const currentActivationId = (activationEntry?.type === "custom" && activationEntry.customType === SCHOLAR_SESSION_STATE_TYPE)
    ? (typeof activationEntry.id === "string" ? activationEntry.id : undefined)
    : (typeof activationEntry?.id === "string" ? activationEntry.id : undefined);

  const checkpointKey = `${target.mode}:${target.recordId}`;
  const existingCheckpoint = currentBook.recoveryCheckpoints?.[checkpointKey];
  let scanStartIndex = startIndex;

  if (existingCheckpoint) {
    const isSameActivation = !existingCheckpoint.activationEntryId
      || !currentActivationId
      || existingCheckpoint.activationEntryId === currentActivationId;
    const isSameSession = !existingCheckpoint.sessionId
      || !currentSessionId
      || existingCheckpoint.sessionId === currentSessionId;

    if (isSameActivation && isSameSession) {
      let cpIndex = -1;
      for (let index = startIndex; index < endIndex; index++) {
        const entry = branch[index];
        const entryId = entry?.id ?? `entry-${index}`;
        if (entryId === existingCheckpoint.lastProcessedEntryId) {
          cpIndex = index;
          break;
        }
      }
      if (cpIndex === -1) {
        return { kind: "skipped", reason: "checkpoint-entry-missing-after-compaction-or-fork" };
      }
      scanStartIndex = cpIndex + 1;
    } else {
      // Genuinely new activation interval or new session: scan starts fresh from this interval's startIndex.
      scanStartIndex = startIndex;
    }
  }

  if (scanStartIndex >= endIndex) {
    return { kind: "noop", message: "already-up-to-date" };
  }

  // 4. Pre-collect tool calls in [startIndex, endIndex) so results can resolve arguments
  const toolCalls = new Map<string, ReturnType<typeof parseScholarQuizInput>>();
  let examGradingIndex = -1;
  for (let index = startIndex; index < endIndex; index++) {
    const entry = branch[index];
    if (entry?.type === "message" && entry.message?.role === "assistant") {
      for (const part of entry.message.content || []) {
        if (part?.type === "toolCall" && typeof part.id === "string") {
          if (part.name === SCHOLAR_QUIZ_TOOL_NAME) {
            toolCalls.set(part.id, parseScholarQuizInput(part.arguments));
          } else if (part.name === "exam_grade") {
            examGradingIndex = index;
          }
        }
      }
    } else if (entry?.type === "tool_execution_end" && entry.toolName === "exam_grade") {
      examGradingIndex = index;
    }
  }

  let lastAssistantIndex = -1;
  for (let index = scanStartIndex; index < endIndex; index++) {
    const entry = branch[index];
    if (entry?.type === "message" && entry.message?.role === "assistant") {
      lastAssistantIndex = index;
    }
  }

  let existingTranscript: TranscriptEntry[] = [];
  if (target.mode === "learn") {
    existingTranscript = findSection(currentBook, target.recordId)?.transcript || [];
  } else if (target.mode === "exam") {
    existingTranscript = currentBook.exams.find((e) => e.id === target.recordId)?.transcript || [];
  } else if (target.mode === "tutor") {
    existingTranscript = currentBook.tutorSessions.find((t) => t.id === target.recordId)?.transcript || [];
  }

  // 5. Collect eligible incoming entries from [scanStartIndex, endIndex)
  const incomingTranscripts: TranscriptEntry[] = [];
  const quizAnswers = new Map<string, {
    outcome: AssessmentOutcome;
    options?: string[];
    correctAnswer?: string;
    feedback?: string;
  }>();

  let lastSafelyProcessedEntryId: string | undefined;

  for (let index = scanStartIndex; index < endIndex; index++) {
    const entry = branch[index];
    const entryId = entry?.id ?? `entry-${index}`;

    if (entry?.type === "message") {
      const message = entry.message;
      if (message?.role === "assistant") {
        let hasUnresolvedQuiz = false;
        for (const part of message.content || []) {
          if (part?.type === "toolCall" && part.name === SCHOLAR_QUIZ_TOOL_NAME && typeof part.id === "string") {
            const hasResult = branch.slice(index + 1).some(
              (e) => e?.type === "message" && e.message?.role === "toolResult" && e.message?.toolCallId === part.id,
            );
            if (!hasResult) {
              hasUnresolvedQuiz = true;
              break;
            }
          }
        }
        if (hasUnresolvedQuiz) {
          break;
        }

        if (target.mode === "exam") {
          const exam = currentBook.exams.find((e) => e.id === target.recordId);
          if (exam?.status === "graded") {
            // Only messages generated strictly after the exam grading event or the narrowly eligible final report record are eligible.
            const isEligible = examGradingIndex !== -1 ? index > examGradingIndex : index === lastAssistantIndex;
            if (isEligible) {
              const transcript = messageTranscriptEntry(message, undefined, entry.timestamp);
              if (transcript) {
                const legacyId = entry.id ? transcriptId("assistant", `${entry.id}\n${transcript.markdown}`) : undefined;
                const alreadyPresent = existingTranscript.some((t) =>
                  t.id === transcript.id
                  || (legacyId && t.id === legacyId)
                  || (t.markdown === transcript.markdown && Math.abs(new Date(t.createdAt).getTime() - new Date(transcript.createdAt).getTime()) < 60000)
                );
                if (!alreadyPresent) incomingTranscripts.push(transcript);
              }
              lastSafelyProcessedEntryId = entryId;
            }
          }
        } else {
          const transcript = messageTranscriptEntry(message, undefined, entry.timestamp);
          if (transcript) {
            const legacyId = entry.id ? transcriptId("assistant", `${entry.id}\n${transcript.markdown}`) : undefined;
            const alreadyPresent = existingTranscript.some((t) =>
              t.id === transcript.id
              || (legacyId && t.id === legacyId)
              || (t.markdown === transcript.markdown && Math.abs(new Date(t.createdAt).getTime() - new Date(transcript.createdAt).getTime()) < 60000)
            );
            if (!alreadyPresent) incomingTranscripts.push(transcript);
          }
          lastSafelyProcessedEntryId = entryId;
        }

        continue;
      }

      if (message?.role === "toolResult" && message.toolName === SCHOLAR_QUIZ_TOOL_NAME) {
        const call = toolCalls.get(message.toolCallId) ?? parseScholarQuizInput(undefined);
        const details = parseScholarQuizDetails(message.details);
        const priorAttempt = target.mode === "learn"
          ? findQuizAttempt(currentBook, target.recordId, message.toolCallId)?.attempt
          : target.mode === "tutor"
            ? findTutorQuizAttempt(currentBook, target.recordId, message.toolCallId)?.attempt
            : undefined;

        const options = details.options?.map((option) => option.label) || priorAttempt?.options || [];
        if (call.question !== undefined) {
          incomingTranscripts.push({
            id: `quiz-question-${message.toolCallId}`,
            kind: "question",
            markdown: [`**${call.question}**`, "", ...options.map((option: string, optionIndex: number) => `${optionIndex + 1}. ${option}`)].join("\n"),
            createdAt: new Date(typeof message.timestamp === "number" ? message.timestamp : Date.now()).toISOString(),
          });
        }

        const isError = message.isError === true;
        const answered = details.status === "answered" && !isError;
        const outcome: AssessmentOutcome = details.status === "cancelled"
          ? "cancelled"
          : details.status === "unavailable" || isError
            ? "unavailable"
            : details.dontKnow === true
              ? "unsure"
              : details.correct === true
                ? "pass"
                : "review";

        const correctAnswer = answered ? scholarQuizCorrectAnswer(details, options) : undefined;
        const explanation = answered && typeof details.explanation === "string" ? details.explanation.trim() : undefined;
        const unavailMsg = outcome === "unavailable" && typeof details.message === "string" ? details.message.trim() : undefined;
        const feedbackStr = [correctAnswer ? `Correct answer: ${correctAnswer}.` : "", explanation || unavailMsg || ""].filter(Boolean).join(" ");
        const outcomeLabel = outcome === "pass" ? "Correct"
          : outcome === "unsure" ? "Knowledge gap identified"
          : outcome === "review" ? "Needs review"
          : outcome === "cancelled" ? "Cancelled"
          : "Unavailable";

        incomingTranscripts.push({
          id: `quiz-result-${message.toolCallId}`,
          kind: "result",
          markdown: `**Outcome:** ${outcomeLabel}. ${feedbackStr}`.trim(),
          createdAt: new Date(typeof message.timestamp === "number" ? message.timestamp : Date.now()).toISOString(),
        });

        quizAnswers.set(message.toolCallId, {
          outcome,
          options: options.length > 0 ? options : undefined,
          correctAnswer,
          feedback: feedbackStr || undefined,
        });

        lastSafelyProcessedEntryId = entryId;
        continue;
      }
    }

    lastSafelyProcessedEntryId = entryId;
  }

  // 6. Check if there are genuine additions before running a book mutation
  const hasNewTranscripts = incomingTranscripts.some((inc) => !existingTranscript.some((t) => t.id === inc.id));
  let hasAttemptRepairs = false;
  for (const [toolCallId, answer] of quizAnswers) {
    const found = target.mode === "learn"
      ? findQuizAttempt(currentBook, target.recordId, toolCallId)
      : target.mode === "tutor"
        ? findTutorQuizAttempt(currentBook, target.recordId, toolCallId)
        : undefined;
    if (!found) continue;
    const att = found.attempt;
    if (att.outcome === "pending" && answer.outcome !== "pending") hasAttemptRepairs = true;
    if (answer.correctAnswer && !att.correctAnswer) hasAttemptRepairs = true;
    if (answer.feedback && !att.feedback) hasAttemptRepairs = true;
  }

  if (!hasNewTranscripts && !hasAttemptRepairs) {
    return { kind: "noop", message: "already-up-to-date" };
  }

  // 7. Commit recovery atomically in a single batch mutation
  let writtenCount = 0;
  let attemptsRepaired = 0;

  await mutateBook(target.bookId, (book) => {
    if (book.id !== target.bookId || book.instanceId !== target.instanceId) {
      throw new Error("The active book authority changed during recovery.");
    }

    let transcript: TranscriptEntry[] | undefined;
    if (target.mode === "learn") {
      const section = findSection(book, target.recordId);
      if (!section) throw new Error(`Target Learn section ${target.recordId} is missing.`);
      transcript = section.transcript;
    } else if (target.mode === "exam") {
      const exam = book.exams.find((e) => e.id === target.recordId);
      if (!exam) throw new Error(`Target Exam ${target.recordId} is missing.`);
      if (exam.status !== "graded") throw new Error("Cannot recover exam transcript before grading.");
      transcript = exam.transcript;
    } else if (target.mode === "tutor") {
      const tutor = book.tutorSessions.find((t) => t.id === target.recordId);
      if (!tutor) throw new Error(`Target Tutor session ${target.recordId} is missing.`);
      transcript = tutor.transcript;
    }

    if (!transcript) throw new Error("The target transcript container is missing.");

    for (const entry of incomingTranscripts) {
      if (appendTranscript(transcript, entry)) {
        writtenCount++;
      }
    }

    for (const [toolCallId, answer] of quizAnswers) {
      const found = target.mode === "learn"
        ? findQuizAttempt(book, target.recordId, toolCallId)
        : target.mode === "tutor"
          ? findTutorQuizAttempt(book, target.recordId, toolCallId)
          : undefined;
      if (!found) continue;
      const attempt = found.attempt;
      let attemptModified = false;
      if (attempt.outcome === "pending" && answer.outcome !== "pending") {
        attempt.outcome = answer.outcome;
        attemptModified = true;
      }
      if (answer.options && (!attempt.options || attempt.options.length === 0)) {
        attempt.options = answer.options;
        attemptModified = true;
      }
      if (answer.correctAnswer && !attempt.correctAnswer) {
        attempt.correctAnswer = answer.correctAnswer;
        attemptModified = true;
      }
      if (answer.feedback && !attempt.feedback) {
        attempt.feedback = answer.feedback;
        attemptModified = true;
      }
      if (attemptModified) {
        attemptsRepaired++;
        if ("section" in found) recomputeProgress(book, found.section);
        else found.tutor.updatedAt = new Date().toISOString();
      }
    }

    if (lastSafelyProcessedEntryId) {
      book.recoveryCheckpoints = book.recoveryCheckpoints || {};
      book.recoveryCheckpoints[checkpointKey] = {
        lastProcessedEntryId: lastSafelyProcessedEntryId,
        ...(currentActivationId ? { activationEntryId: currentActivationId } : {}),
        ...(currentSessionId ? { sessionId: currentSessionId } : {}),
        updatedAt: new Date().toISOString(),
      };
    }

    if (writtenCount > 0) {
      if (target.mode === "learn") {
        const sec = findSection(book, target.recordId);
        if (sec) sec.updatedAt = new Date().toISOString();
      } else if (target.mode === "tutor") {
        const tut = book.tutorSessions.find((t) => t.id === target.recordId);
        if (tut) tut.updatedAt = new Date().toISOString();
      } else if (target.mode === "exam") {
        const ex = book.exams.find((e) => e.id === target.recordId);
        if (ex) ex.updatedAt = new Date().toISOString();
      }
    }
  });

  if (writtenCount === 0 && attemptsRepaired === 0) {
    return { kind: "noop", message: "already-up-to-date" };
  }

  return { kind: "success", writtenCount, attemptsRepaired };
}
