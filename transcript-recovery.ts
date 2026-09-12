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

/** Compatibility entry point: conversation history is never a source of note content. */
export async function recoverTranscriptTarget(_options: RecoverTranscriptOptions): Promise<RecoveryOutcome> {
  return { kind: "noop", message: "The visible Obsidian note is authoritative. History backfill is disabled." };
}
