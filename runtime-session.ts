import { isScholarMode } from "./modes.ts";
import {
  findSection,
  type ScholarBook,
  type ScholarExam,
  type ScholarMode,
  type ScholarSection,
  type TutorSession,
} from "./types.ts";

export const SCHOLAR_SESSION_STATE_TYPE = "scholar-active-v3";

/**
 * The persisted Pi-session shape predates the discriminated runtime state.
 * Keep it stable so existing v3 session branches continue to restore.
 */
export type ScholarSessionPointer = {
  active: boolean;
  vaultPath?: string;
  bookId?: string;
  instanceId?: string;
  mode?: ScholarMode;
  recordId?: string;
  sectionId?: string;
};

export type ScholarRuntimeState =
  | { readonly kind: "inactive" }
  | { readonly kind: "selected"; readonly bookId: string }
  | { readonly kind: "learn"; readonly bookId: string; readonly recordId: string }
  | { readonly kind: "exam"; readonly bookId: string; readonly recordId: string }
  | { readonly kind: "tutor"; readonly bookId: string; readonly recordId: string };

type InactiveRuntimeState = Extract<ScholarRuntimeState, { kind: "inactive" }>;
type SelectedRuntimeState = Extract<ScholarRuntimeState, { kind: "selected" }>;
type LearnRuntimeState = Extract<ScholarRuntimeState, { kind: "learn" }>;
type ExamRuntimeState = Extract<ScholarRuntimeState, { kind: "exam" }>;
type TutorRuntimeState = Extract<ScholarRuntimeState, { kind: "tutor" }>;

export type ScholarRuntimeTargetReconciliation =
  | { readonly kind: "inactive"; readonly state: InactiveRuntimeState }
  | {
      readonly kind: "invalid";
      readonly reason: "book-missing" | "book-id-mismatch" | "instance-missing" | "instance-mismatch";
      readonly state: InactiveRuntimeState;
    }
  | { readonly kind: "setup"; readonly reason: "outline-not-ready"; readonly state: SelectedRuntimeState }
  | {
      readonly kind: "stale";
      readonly reason: "learn-target-missing" | "learn-target-not-started" | "exam-target-missing" | "tutor-target-missing";
      readonly state: SelectedRuntimeState;
    }
  | { readonly kind: "selected"; readonly state: SelectedRuntimeState }
  | {
      readonly kind: "active";
      readonly state: LearnRuntimeState;
      readonly target: ScholarSection;
      readonly terminal?: "learn-complete";
    }
  | {
      readonly kind: "active";
      readonly state: ExamRuntimeState;
      readonly target: ScholarExam;
      readonly terminal?: "exam-graded";
    }
  | {
      readonly kind: "active";
      readonly state: TutorRuntimeState;
      readonly target: TutorSession;
      readonly terminal?: "tutor-closed";
    };

export type ScholarSessionRestore = {
  found: boolean;
  vaultPath?: string;
  instanceId?: string;
  sectionId?: string;
};

type SessionEntry = {
  type?: unknown;
  customType?: unknown;
  data?: ScholarSessionPointer;
};

type SessionBook = Pick<ScholarBook, "id" | "instanceId">;

const INACTIVE_STATE: InactiveRuntimeState = { kind: "inactive" };

function activeState(
  bookId: string,
  mode: ScholarMode | undefined,
  recordId: string | undefined,
): ScholarRuntimeState {
  if (!mode) return Object.freeze({ kind: "selected", bookId });
  if (!recordId?.trim()) throw new Error(`Scholar ${mode} mode requires an exact target record.`);
  return Object.freeze({ kind: mode, bookId, recordId });
}

function modeFor(state: ScholarRuntimeState): ScholarMode | undefined {
  return state.kind === "selected" || state.kind === "inactive" ? undefined : state.kind;
}

/**
 * Reconcile a Pi-session pointer with the exact vault-local authority it claims
 * to target. This is deliberately pure: callers decide when to apply the
 * returned inactive/selected state and when a legitimate terminal target
 * should remain available for explicit review or reporting.
 */
export function reconcileScholarRuntimeTarget(
  state: ScholarRuntimeState,
  book: ScholarBook | undefined,
  expectedInstanceId: string | undefined,
): ScholarRuntimeTargetReconciliation {
  if (state.kind === "inactive") return { kind: "inactive", state };
  if (!book) return { kind: "invalid", reason: "book-missing", state: INACTIVE_STATE };
  if (book.id !== state.bookId) return { kind: "invalid", reason: "book-id-mismatch", state: INACTIVE_STATE };
  if (!expectedInstanceId?.trim()) return { kind: "invalid", reason: "instance-missing", state: INACTIVE_STATE };
  if (book.instanceId !== expectedInstanceId) return { kind: "invalid", reason: "instance-mismatch", state: INACTIVE_STATE };

  const selected = activeState(book.id, undefined, undefined) as SelectedRuntimeState;
  if (book.outlineStatus !== "ready") return { kind: "setup", reason: "outline-not-ready", state: selected };
  if (state.kind === "selected") return { kind: "selected", state };

  if (state.kind === "learn") {
    const target = findSection(book, state.recordId);
    if (!target) return { kind: "stale", reason: "learn-target-missing", state: selected };
    if (target.status === "not-started") {
      return { kind: "stale", reason: "learn-target-not-started", state: selected };
    }
    return {
      kind: "active",
      state,
      target,
      ...(target.status === "complete" ? { terminal: "learn-complete" as const } : {}),
    };
  }

  if (state.kind === "exam") {
    const target = book.exams.find((exam) => exam.id === state.recordId);
    if (!target) return { kind: "stale", reason: "exam-target-missing", state: selected };
    return {
      kind: "active",
      state,
      target,
      ...(target.status === "graded" ? { terminal: "exam-graded" as const } : {}),
    };
  }

  const target = book.tutorSessions.find((tutor) => tutor.id === state.recordId);
  if (!target) return { kind: "stale", reason: "tutor-target-missing", state: selected };
  return {
    kind: "active",
    state,
    target,
    ...(target.status === "closed" ? { terminal: "tutor-closed" as const } : {}),
  };
}

export function scholarSessionPointerKey(pointer: ScholarSessionPointer): string {
  return JSON.stringify(pointer);
}

/**
 * Owns only Pi-session selection. Book progress and mode records remain in the
 * selected Obsidian vault and are deliberately outside this controller.
 */
export class ScholarRuntimeSession {
  private current: ScholarRuntimeState = INACTIVE_STATE;
  private lastPersistedKey: string | undefined;

  get state(): ScholarRuntimeState {
    return this.current;
  }

  get active(): boolean {
    return this.current.kind !== "inactive";
  }

  get bookId(): string | undefined {
    return this.current.kind === "inactive" ? undefined : this.current.bookId;
  }

  get mode(): ScholarMode | undefined {
    return modeFor(this.current);
  }

  get recordId(): string | undefined {
    return this.current.kind === "learn" || this.current.kind === "exam" || this.current.kind === "tutor"
      ? this.current.recordId
      : undefined;
  }

  /** Start a fresh Pi session, including a fresh persistence-dedupe window. */
  reset(): void {
    this.current = INACTIVE_STATE;
    this.lastPersistedKey = undefined;
  }

  /** Close or invalidate the current selection without resetting dedupe. */
  deactivate(): void {
    this.current = INACTIVE_STATE;
  }

  activate(bookId: string): void;
  activate(bookId: string, mode: ScholarMode, recordId: string): void;
  activate(bookId: string, mode?: ScholarMode, recordId?: string): void {
    this.current = activeState(bookId, mode, recordId);
  }

  /**
   * Restore the latest legacy v3 pointer from a Pi session branch. Invalid
   * active pointers without a book normalize to inactive, matching the former
   * index.ts post-restore guard.
   */
  restore(entries: readonly SessionEntry[]): ScholarSessionRestore {
    this.reset();
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]!;
      if (entry.type !== "custom" || entry.customType !== SCHOLAR_SESSION_STATE_TYPE) continue;
      const pointer = entry.data;
      if (pointer?.active === true && typeof pointer.bookId === "string" && pointer.bookId) {
        const mode = isScholarMode(pointer.mode) ? pointer.mode : undefined;
        const target = mode === "learn" ? pointer.recordId || pointer.sectionId : pointer.recordId;
        this.current = mode && !target
          ? activeState(pointer.bookId, undefined, undefined)
          : activeState(pointer.bookId, mode, target);
      }
      return {
        found: true,
        ...(typeof pointer?.vaultPath === "string" ? { vaultPath: pointer.vaultPath } : {}),
        ...(this.active && typeof pointer?.instanceId === "string" ? { instanceId: pointer.instanceId } : {}),
        ...(this.mode === "learn" && typeof pointer?.sectionId === "string" ? { sectionId: pointer.sectionId } : {}),
      };
    }
    return { found: false };
  }

  serialize(book?: SessionBook, vaultPath?: string): ScholarSessionPointer {
    const bookId = this.bookId;
    const mode = this.mode;
    const recordId = this.recordId;
    return {
      active: this.active,
      ...(vaultPath ? { vaultPath } : {}),
      ...(bookId ? { bookId } : {}),
      ...(bookId && book?.id === bookId ? { instanceId: book.instanceId } : {}),
      ...(mode ? { mode } : {}),
      ...(recordId ? { recordId } : {}),
      ...(mode === "learn" && recordId ? { sectionId: recordId } : {}),
    };
  }

  /**
   * Seed deduplication after restoring and validating the referenced book.
   * The section override preserves the exact legacy pointer key until the
   * authoritative book changes and a new pointer genuinely needs appending.
   */
  seedPersistedKey(book?: SessionBook, restoredSectionId?: string, vaultPath?: string): string {
    const key = scholarSessionPointerKey({
      ...this.serialize(book, vaultPath),
      ...(restoredSectionId ? { sectionId: restoredSectionId } : {}),
    });
    this.lastPersistedKey = key;
    return key;
  }

  /** Append exactly once per distinct serialized pointer. */
  persist(book: SessionBook | undefined, append: (pointer: ScholarSessionPointer) => void, vaultPath?: string): boolean {
    const pointer = this.serialize(book, vaultPath);
    const key = scholarSessionPointerKey(pointer);
    if (key === this.lastPersistedKey) return false;
    append(pointer);
    this.lastPersistedKey = key;
    return true;
  }
}
