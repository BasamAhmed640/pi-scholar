import { allowedPageRanges, assertPagesInModeScope } from "./domain.ts";
import type { ScholarRuntimeSession, ScholarRuntimeState } from "./runtime-session.ts";
import { isSameVaultPath } from "./transcript-recovery.ts";
import type { ScholarBook, ScholarConfig, ScholarExam, TutorSession } from "./types.ts";

/** Memory-only proof of a rendered page, scoped to one activation and source. */
export type SourceFigureView = {
  activation: ScholarRuntimeState;
  identity: string;
  page: number;
  width: number;
  height: number;
};

export type FigureCaptureTarget = {
  mode: "exam" | "tutor";
  recordId: string;
  activation: ScholarRuntimeState;
  identity: string;
  assertCurrent(book: ScholarBook): ScholarExam | TutorSession;
};

function captureRecord(book: ScholarBook, mode: "exam" | "tutor", recordId: string): ScholarExam | TutorSession {
  if (book.outlineStatus !== "ready") throw new Error("Scholar snapshot requires a verified outline.");
  if (mode === "exam") {
    const exam = book.exams.find((item) => item.id === recordId);
    if (!exam || exam.status !== "draft") throw new Error("Source figures can be saved only while the active Exam is still a draft.");
    return exam;
  }
  const tutor = book.tutorSessions.find((item) => item.id === recordId);
  if (!tutor || tutor.status !== "active") throw new Error("Source figures require an active Tutor session.");
  return tutor;
}

function captureIdentity(book: ScholarBook, mode: "exam" | "tutor", recordId: string): string {
  const record = captureRecord(book, mode, recordId);
  return JSON.stringify([
    book.id, book.instanceId, book.source, book.metadata.pageCount,
    mode, record.id, record.createdAt, record.scope, allowedPageRanges(book, mode, recordId),
  ]);
}

export function createFigureCaptureTarget(
  book: ScholarBook,
  session: ScholarRuntimeSession,
  getConfig: () => ScholarConfig,
  isActiveAuthority: (book: ScholarBook) => boolean,
): FigureCaptureTarget {
  const mode = session.mode;
  const recordId = session.recordId;
  if (!mode || mode === "learn" || !recordId || session.bookId !== book.id) {
    throw new Error("Source figure capture requires an active Exam or Tutor record.");
  }
  const activation = session.state;
  const vault = getConfig().obsidianRoot;
  const identity = captureIdentity(book, mode, recordId);
  return {
    mode, recordId, activation, identity,
    assertCurrent(state) {
      if (session.state !== activation || !isSameVaultPath(vault, getConfig().obsidianRoot)
        || !isActiveAuthority(state) || captureIdentity(state, mode, recordId) !== identity) {
        throw new Error("The active source, scope, or record changed while preparing its figure. View the page again in the current record.");
      }
      return captureRecord(state, mode, recordId);
    },
  };
}

export function assertSourceFigureView(
  book: ScholarBook,
  target: FigureCaptureTarget,
  page: number,
  view: SourceFigureView | undefined,
  canvasWidth: number | undefined,
  canvasHeight: number | undefined,
): void {
  target.assertCurrent(book);
  assertPagesInModeScope(book, target.mode, target.recordId, page, page);
  if (!view || view.activation !== target.activation || view.identity !== target.identity || view.page !== page
    || view.width !== canvasWidth || view.height !== canvasHeight) {
    throw new Error("View this page in the current Exam or Tutor record before saving a snapshot, and use that view's intrinsic canvas dimensions.");
  }
}
