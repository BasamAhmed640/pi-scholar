import { open, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ensureScholarAppearance } from "./appearance.ts";

import { cleanArgument, parseScholarCommand } from "./command-syntax.ts";
import {
  quoted,
  recomputeProgress,
  resolveLearnSection,
  resolveScope,
  titleFor,
} from "./domain.ts";
import { scanLibrary } from "./ingest.ts";
import { examAnswerProgress } from "./exam.ts";
import { readExamAnswerNote } from "./exam-paper.ts";
import { answerKeyNotePath, scholarWorkspaceRoot } from "./obsidian-paths.ts";
import { validateNoteOwnership } from "./obsidian.ts";
import type { InputLockContext } from "./input-lock.ts";
import type { ScholarRuntimeSession } from "./runtime-session.ts";
import {
  loadBookState,
  loadCatalog,
  resolveScholarConfig,
  safePathWithinRoot,
  updateCatalog,
} from "./storage.ts";
import { freezeRecoveryTarget, type FrozenRecoveryTarget, type RecoveryOutcome } from "./transcript-recovery.ts";
import type { ScholarToolController } from "./tool-controller.ts";
import {
  allSections,
  findSection,
  type BookCandidate,
  type ScholarBook,
  type ScholarConfig,
  type ScholarExam,
  type ScholarMode,
  type ScholarScope,
  type ScholarSection,
  type TutorSession,
} from "./types.ts";

export type ScholarRuntimeCoordinator = {
  inputContext?(ctx: ExtensionCommandContext): ExtensionCommandContext;
  getConfig(): ScholarConfig;
  setConfig(config: ScholarConfig): void;
  loadFreshConfig(): Promise<ScholarConfig>;
  saveConfig(config: ScholarConfig): Promise<ScholarConfig>;
  hasConfiguredLibrary(): boolean;
  hasConfiguredObsidian(): boolean;
  librarySetupMessage: string;
  obsidianSetupMessage: string;
  runtimeSession: ScholarRuntimeSession;
  ownsActiveAuthority(book: ScholarBook): boolean;
  deactivateSession(): void;
  persistSessionPointer(book?: ScholarBook): void;
  setStatus(ctx: { ui: { setStatus(key: string, text: string | undefined): void } }): Promise<void>;
  beginNavigation(ctx: InputLockContext, title: string): () => void;
  getSetupRun(): { title: string } | undefined;
  getScholarTurnRun(): { title: string } | undefined;
  getNavigationRun(): { title: string } | undefined;
  toolController: ScholarToolController;
  renderAll(): Promise<void>;
  mutateBook: <T>(bookId: string, mutate: (book: ScholarBook) => Promise<T> | T) => Promise<{ book: ScholarBook; result: T }>;
  activateBook(
    book: ScholarBook,
    ctx: { ui: { setStatus(key: string, text: string | undefined): void } },
    mode?: ScholarMode,
    recordId?: string,
  ): Promise<void>;
  startBookSetup(book: ScholarBook, ctx: ExtensionCommandContext): Promise<boolean>;
  startScholarModeTurn(
    book: ScholarBook,
    mode: ScholarMode,
    target: ScholarSection | ScholarExam | TutorSession,
    ctx: ExtensionCommandContext,
  ): Promise<void>;
  openCandidate(candidate: BookCandidate, ctx: ExtensionCommandContext): Promise<void>;
  chooseCandidate(value: string | undefined, ctx: ExtensionCommandContext): Promise<BookCandidate | undefined>;
  activeAuthority?: { bookId: string; instanceId: string };
  recoverTarget?: (
    target: FrozenRecoveryTarget,
    ctx: ExtensionCommandContext | ExtensionContext,
    isAutomatic?: boolean,
  ) => Promise<RecoveryOutcome>;
};

/** How many times an exam scope is tried (the typed value counts) before giving up. */
const MAX_EXAM_SCOPE_ATTEMPTS = 3;

/**
 * Book-specific guidance for an exam scope. Examples use this book's real
 * chapter and subsection numbers so the accepted shapes are unambiguous.
 */
export function examScopeGuidance(book: ScholarBook): string {
  const numbered = book.chapters.filter((chapter) => chapter.number);
  const first = numbered[0]?.number || "1";
  const third = numbered[2]?.number;
  const last = numbered.at(-1)?.number;
  const subsection = allSections(book).find((section) => section.number)?.number;
  const examples: Array<[string, string]> = [
    third ? [`${first}-${third}`, `chapters ${first} through ${third}`] : [first, `chapter ${first}`],
    ...(third ? [[`${first}, ${third}`, "only those chapters"] as [string, string]] : []),
    [`chapter ${first}`, "one whole chapter"],
    ...(subsection ? [[subsection, `one subsection (or "section ${subsection}")`] as [string, string]] : []),
    ["all", "the complete book"],
  ];
  const width = Math.max(...examples.map(([sample]) => sample.length));
  return [
    "Accepted formats:",
    ...examples.map(([sample, meaning]) => `  ${sample.padEnd(width)}   ${meaning}`),
    last && last !== first
      ? `This book has chapters ${first}-${last}.`
      : `This book has ${book.chapters.length} chapter(s).`,
  ].join("\n");
}

/**
 * Detailed but precise user guidance for Scholar tools and workflows.
 */
export function scholarGuide(book?: ScholarBook, unreadable = false): string {
  const current = book
    ? `Selected book: ${titleFor(book)}`
    : unreadable
      ? "Selected book: state could not be read. Book-specific guidance is omitted; /scholar open can switch books."
      : "No book currently selected. Run /scholar open to choose a textbook.";

  return [
    current,
    "",
    "Scholar Tools & Workflows:",
    "",
    "• /scholar open [book]",
    "  Open or switch textbooks from your configured PDF library. Run bare to browse all available books in a selector, or specify a partial title to jump directly.",
    "",
    "• /scholar learn <chapter/section>",
    '  Guided study with source-grounded explanations and 3 short questions. Reopening a section continues where it stopped. Pending unanswered questions resume unchanged.',
    "",
    "• /scholar exam <scope>",
    '  Answer an exam in Obsidian. Specify chapters (e.g. "1-3", "1, 2", or "all"), or reopen an exam by ID. Bare /scholar exam resumes the most recently touched unfinished exam and names any others; it never prompts.',
    '• /scholar exam "exam-001" submit',
    '  Confirm and submit saved Obsidian answers; blanks receive 0 points. /scholar exam submit offers active exams. Reopening a submitted exam resumes grading; reopening a graded exam restores a missing answer key without re-grading.',
    "",
    "• /scholar tutor <section/topic>",
    "  Interactive Socratic tutoring. Focuses on specific points of confusion, worked problem derivations, or conceptual questions without advancing formal section progress.",
    "",
    "• /scholar close",
    "  Safely leaves Scholar mode in this terminal session while preserving all progress, state, and notes.",
    "",
    "Setup & Configuration:",
    '  • /scholar library "<folder>"   Set the local PDF textbooks folder.',
    '  • /scholar obsidian "<vault>"   Set the existing Obsidian vault location.',
  ].join("\n");
}

/**
 * Resolve an explicit exam scope, re-asking with the specific reason when the
 * entry does not match the book. The scope typed on the command line is the
 * first attempt, so a near miss reopens the dialog instead of ending the
 * command. A bare `/scholar exam` never reaches this: it resumes an unfinished
 * exam or explains the creation syntax without prompting.
 */
export async function resolveExamScope(
  book: ScholarBook,
  provided: string,
  ctx: ExtensionCommandContext,
): Promise<ScholarScope | undefined> {
  const guidance = examScopeGuidance(book);
  const canPrompt = typeof ctx.ui?.input === "function";
  let candidate = cleanArgument(provided);
  let problem: string | undefined;

  for (let attempt = 0; attempt < MAX_EXAM_SCOPE_ATTEMPTS; attempt += 1) {
    if (!candidate) {
      if (!canPrompt) {
        ctx.ui.notify(`${problem || "No exam scope was given."}\n\n${guidance}`, "warning");
        return undefined;
      }
      const heading = problem
        ? `${problem}\n\nTry again.\n\n${guidance}`
        : `Create an exam from ${titleFor(book)}.\n\n${guidance}`;
      const entered = await ctx.ui.input(heading, "e.g. 1-3");
      if (entered === undefined) return undefined;
      candidate = cleanArgument(entered);
      if (!candidate) {
        problem = "No scope entered.";
        continue;
      }
    }
    try {
      return resolveScope(book, candidate, false);
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
      candidate = undefined;
    }
  }
  ctx.ui.notify(`${problem || "That exam scope could not be matched."}\n\nNo exam was created.\n\n${guidance}`, "warning");
  return undefined;
}

/**
 * Every exam that can still be answered or graded, most recently touched first.
 *
 * Activity wins over creation time so an exam that was just answered outranks
 * one that was only created later. Ties break on createdAt and then the ID, so
 * identical state always produces the same order.
 */
export function unfinishedExams(book: ScholarBook): ScholarExam[] {
  return book.exams
    .filter((exam) => exam.status !== "graded")
    .sort((left, right) =>
      (right.updatedAt ?? right.createdAt).localeCompare(left.updatedAt ?? left.createdAt)
      || right.createdAt.localeCompare(left.createdAt)
      || right.id.localeCompare(left.id));
}

function examResumeLabel(exam: ScholarExam): string {
  const state = exam.status === "submitted"
    ? "submitted · awaiting grading"
    : exam.status === "active"
      ? `${exam.questions.length} question(s) · not yet submitted`
      : "draft · questions not built yet";
  return `${exam.title} [${exam.id}] — ${state}`;
}

async function examPaperLabel(config: ScholarConfig, book: ScholarBook, exam: ScholarExam): Promise<string> {
  const title = `${exam.title} [${exam.id}]`;
  try {
    const paper = await readExamAnswerNote(config, book, exam);
    const progress = examAnswerProgress(exam, paper.text);
    return progress.ok ? `${title} — ${progress.answered}/${progress.total} answered` : `${title} — answer markers need repair`;
  } catch {
    return `${title} — answer paper missing or needs repair`;
  }
}

function findNamedExam(book: ScholarBook, value: string): ScholarExam | undefined {
  const needle = value.toLowerCase();
  const byId = book.exams.find((exam) => exam.id.toLowerCase() === needle);
  if (byId) return byId;
  const exact = book.exams.filter((exam) => exam.title.toLowerCase() === needle);
  const matches = exact.length ? exact : book.exams.filter((exam) => exam.title.toLowerCase().startsWith(needle));
  if (matches.length > 1) throw new Error("More than one exam matches that name. Use its exact exam ID.");
  return matches[0];
}

async function keyExists(config: ScholarConfig, book: ScholarBook, exam: ScholarExam, path: string): Promise<boolean> {
  const workspace = await safePathWithinRoot(config.obsidianRoot, scholarWorkspaceRoot(config));
  const safePath = await safePathWithinRoot(workspace, path);
  try {
    const handle = await open(safePath, "r");
    try {
      if (!(await handle.stat()).isFile()) throw new Error(`The answer key path is not a file: ${path}`);
      const header = Buffer.alloc(8192);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      validateNoteOwnership(header.subarray(0, bytesRead).toString("utf8"), { type: "scholar-answer-key", book_id: book.id, exam_id: exam.id }, path);
    } finally { await handle.close(); }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function recoverActiveOutgoingSession(
  coordinator: ScholarRuntimeCoordinator,
  activeConfig: ScholarConfig,
  ctx: ExtensionCommandContext,
  label = "outgoing",
): Promise<void> {
  if (coordinator.runtimeSession.mode && coordinator.runtimeSession.bookId && coordinator.activeAuthority) {
    const outgoingTarget = freezeRecoveryTarget(
      activeConfig.obsidianRoot,
      coordinator.runtimeSession,
      coordinator.activeAuthority,
    );
    if (outgoingTarget && coordinator.recoverTarget) {
      try {
        await coordinator.recoverTarget(outgoingTarget, ctx, true);
      } catch (error) {
        ctx.ui.notify(`Scholar could not recover the ${label} session: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
    }
  }
}

/**
 * Book state that cannot be read is a failure the learner must see. Reporting
 * it as "no selected book" hides a broken authority behind advice to open a
 * book that is already open.
 */
function loadFailureMessage(error: unknown, what: string): string {
  return `Scholar could not load ${what}: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * The guide documents commands, not book state. A selected book that cannot be
 * read is reported, then the same guide still runs: `/scholar help` and bare
 * `/scholar` must stay reachable when book state is broken.
 */
async function notifyScholarGuide(
  coordinator: ScholarRuntimeCoordinator,
  config: ScholarConfig,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const bookId = coordinator.runtimeSession.bookId || config.currentBookId;
  let book: ScholarBook | undefined;
  let unreadable = false;
  if (bookId) {
    try {
      book = await loadBookState(config, bookId);
    } catch (error) {
      unreadable = true;
      ctx.ui.notify(loadFailureMessage(error, "the selected book"), "warning");
    }
  }
  ctx.ui.notify(scholarGuide(book, unreadable), "info");
}

export async function handleScholarCommand(
  args: string,
  ctx: ExtensionCommandContext,
  coordinator: ScholarRuntimeCoordinator,
): Promise<void> {
  ctx = coordinator.inputContext?.(ctx) || ctx;
  try {
    const parsed = parseScholarCommand(args);
    if (parsed.action === "invalid") {
      ctx.ui.notify("Invalid Scholar command. Use /scholar help for the exact command forms.", "warning");
      return;
    }

    if (parsed.action === "help") {
      await notifyScholarGuide(coordinator, coordinator.getConfig(), ctx);
      return;
    }

    const navRun = coordinator.getNavigationRun();
    if (navRun) {
      ctx.ui.notify(`Scholar is ${navRun.title}. Wait for it to finish before running another command.`, "warning");
      return;
    }
    const activeRun = coordinator.getSetupRun() || coordinator.getScholarTurnRun();
    if (activeRun) {
      ctx.ui.notify(`Scholar is still working on ${activeRun.title}. Navigation is locked until it finishes or you press Esc.`, "warning");
      return;
    }

    // A running operation owns one immutable configuration snapshot. Only
    // read disk configuration when no Scholar operation is in flight.
    let activeConfig = activeRun ? coordinator.getConfig() : await coordinator.loadFreshConfig();

    // Only a command that actually needs the book may be stopped by a book load
    // failure. Closing the session, switching books, and reading the guide must
    // still work while the active book's state is unreadable.
    const bookDependent = parsed.action === "learn" || parsed.action === "exam" || parsed.action === "tutor";
    if (bookDependent && !coordinator.getSetupRun() && coordinator.runtimeSession.active && coordinator.runtimeSession.bookId) {
      let activeBook: ScholarBook | undefined;
      try {
        activeBook = await loadBookState(activeConfig, coordinator.runtimeSession.bookId);
      } catch (error) {
        ctx.ui.notify(loadFailureMessage(error, "the active book"), "warning");
        return;
      }
      if (!activeBook) {
        coordinator.deactivateSession();
        coordinator.persistSessionPointer();
        await coordinator.setStatus(ctx);
      }
    }

    if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {
      ctx.ui.notify("Scholar is already working. Wait for it to finish or press Esc before starting another Scholar task.", "warning");
      return;
    }

    if (parsed.action === "obsidian") {
      if (!parsed.value) {
        ctx.ui.notify(coordinator.hasConfiguredObsidian() ? `Scholar Obsidian vault: ${activeConfig.obsidianRoot}` : coordinator.obsidianSetupMessage, "info");
        return;
      }
      const releaseInput = coordinator.beginNavigation(ctx, "changing the Obsidian vault");
      try {
        const requested = resolve(parsed.value);
        const info = await stat(requested);
        if (!info.isDirectory()) throw new Error(`Scholar Obsidian vault is not a folder: ${requested}`);
        const targetBase = resolveScholarConfig({
          ...activeConfig,
          obsidianRoot: requested,
          libraryRoot: "",
          currentBookId: undefined,
        });
        const targetCatalog = await loadCatalog(targetBase);
        activeConfig = await coordinator.saveConfig({
          ...targetBase,
          libraryRoot: targetCatalog.libraryRoot || "",
          currentBookId: targetCatalog.currentBookId,
        });
        coordinator.deactivateSession();
        coordinator.toolController.resetTransientState();
        coordinator.persistSessionPointer();
        await ensureScholarAppearance(activeConfig, (message) => ctx.ui.notify(message, "warning"));
        await coordinator.renderAll();
        await coordinator.setStatus(ctx);
      } finally {
        releaseInput();
      }
      ctx.ui.notify(`Scholar Obsidian vault set to ${activeConfig.obsidianRoot}. This vault is now Scholar's complete book-state authority.`, "info");
      return;
    }

    if (parsed.action === "library") {
      if (!parsed.value) {
        ctx.ui.notify(coordinator.hasConfiguredLibrary() ? `Scholar library: ${activeConfig.libraryRoot}` : coordinator.librarySetupMessage, "info");
        return;
      }
      if (!coordinator.hasConfiguredObsidian()) {
        ctx.ui.notify(`Set the Obsidian vault first with /scholar obsidian "<path>". Scholar stores the library selection inside that vault.`, "warning");
        return;
      }
      const releaseInput = coordinator.beginNavigation(ctx, "changing the PDF library");
      let books: BookCandidate[] = [];
      try {
        const requested = resolve(parsed.value);
        const info = await stat(requested);
        if (!info.isDirectory()) throw new Error(`Scholar library is not a folder: ${requested}`);
        const previousLibrary = activeConfig.libraryRoot;
        const nextConfig = resolveScholarConfig({ ...activeConfig, libraryRoot: requested, currentBookId: undefined });
        if (!previousLibrary || resolve(previousLibrary) !== requested) {
          await updateCatalog(nextConfig, (catalog) => {
            catalog.entries = [];
            catalog.libraryRoot = requested;
            delete catalog.currentBookId;
          });
        }
        activeConfig = await coordinator.saveConfig(nextConfig);
        coordinator.deactivateSession();
        coordinator.toolController.resetTransientState();
        coordinator.persistSessionPointer();
        books = await scanLibrary(activeConfig.libraryRoot);
        await coordinator.renderAll();
        await coordinator.setStatus(ctx);
      } finally {
        releaseInput();
      }
      ctx.ui.notify(`Scholar library set to ${activeConfig.libraryRoot} (${books.length} PDF ${books.length === 1 ? "book" : "books"}).`, "info");
      return;
    }

    if (parsed.action === "close") {
      await recoverActiveOutgoingSession(coordinator, activeConfig, ctx, "closing");
      coordinator.deactivateSession();
      coordinator.toolController.resetTransientState();
      coordinator.persistSessionPointer();
      await coordinator.setStatus(ctx);
      ctx.ui.notify("Scholar mode is closed in this Pi session. Progress was kept.", "info");
      return;
    }

    if (parsed.action === "open") {
      if (!coordinator.hasConfiguredObsidian()) {
        ctx.ui.notify(coordinator.obsidianSetupMessage, "warning");
        return;
      }
      const candidate = await coordinator.chooseCandidate(parsed.value, ctx);
      if (candidate) {
        await recoverActiveOutgoingSession(coordinator, activeConfig, ctx, "outgoing");
        await ensureScholarAppearance(activeConfig, (message) => ctx.ui.notify(message, "warning"));
        await coordinator.openCandidate(candidate, ctx);
      }
      return;
    }

    if (parsed.action === "default") {
      await notifyScholarGuide(coordinator, activeConfig, ctx);
      return;
    }

    const bookId = coordinator.runtimeSession.bookId || activeConfig.currentBookId;
    let book: ScholarBook | undefined;
    if (bookId) {
      try {
        book = await loadBookState(activeConfig, bookId);
      } catch (error) {
        ctx.ui.notify(loadFailureMessage(error, "the selected book"), "warning");
        return;
      }
    }

    if (!coordinator.hasConfiguredLibrary()) {
      ctx.ui.notify(coordinator.librarySetupMessage, "warning");
      return;
    }

    if (!bookId || !book) {
      ctx.ui.notify("Scholar has no selected book. Open one explicitly with /scholar open; no PDF is chosen automatically.", "info");
      return;
    }

    if (!coordinator.hasConfiguredObsidian()) {
      ctx.ui.notify(coordinator.obsidianSetupMessage, "warning");
      return;
    }

    await ensureScholarAppearance(activeConfig, (message) => ctx.ui.notify(message, "warning"));

    if (book.outlineStatus !== "ready") {
      await coordinator.activateBook(book, ctx);
      await coordinator.startBookSetup(book, ctx);
      ctx.ui.notify("Scholar must verify this PDF's outline first. Re-run the requested mode when setup finishes.", "info");
      return;
    }

    const releaseModePreparation = coordinator.beginNavigation(ctx, `preparing ${parsed.action}`);
    try {
      await recoverActiveOutgoingSession(coordinator, activeConfig, ctx, "outgoing");
      if (parsed.action === "learn") {
        const selected = resolveLearnSection(book, parsed.value);
        if (!selected) {
          ctx.ui.notify(
            parsed.value
              ? `No Scholar chapter or section matches ${quoted(parsed.value)}.`
              : 'Choose a chapter or section first, for example: /scholar learn "chapter 1" or /scholar learn "section 1.2". A bare /scholar learn only resumes an unfinished section you already started.',
            "info",
          );
          return;
        }
        const mutation = await coordinator.mutateBook(book.id, (state) => {
          state.currentSectionId = selected.id;
          const section = findSection(state, selected.id);
          if (section && section.status === "not-started") section.status = "learning";
          recomputeProgress(state, section);
        });
        book = mutation.book;
        const section = findSection(book, selected.id)!;
        await coordinator.activateBook(book, ctx, "learn", section.id);
        await coordinator.startScholarModeTurn(book, "learn", section, ctx);
        return;
      }

      if (parsed.action === "exam") {
        let exam: ScholarExam | undefined;
        if (parsed.submit) {
          if (parsed.value) {
            exam = findNamedExam(book, parsed.value);
            if (!exam) throw new Error(`No exam matches ${quoted(parsed.value)}. Use an existing exam ID; no exam was created.`);
          } else {
            if (!ctx.hasUI || typeof ctx.ui.select !== "function" || typeof ctx.ui.confirm !== "function") {
              throw new Error("Exam submission requires interactive selection and confirmation in Pi.");
            }
            const candidates = unfinishedExams(book).filter((item) => item.status === "active");
            if (!candidates.length) { ctx.ui.notify("No active exam is ready to submit. Reopen a submitted exam to finish grading.", "info"); return; }
            const labels = await Promise.all(candidates.map((item) => examPaperLabel(activeConfig, book!, item)));
            const selected = await ctx.ui.select("Submit an exam — saved answers in Obsidian", labels);
            if (selected === undefined) return;
            exam = candidates[labels.indexOf(selected)];
            if (!exam) return;
          }
          if (exam.status === "active") {
            const submission = await coordinator.toolController.submitExam(book.id, exam.id, ctx);
            if (!submission.submitted) return;
            book = submission.book;
            exam = submission.exam;
            ctx.ui.notify(submission.projectionStatus === "pending"
              ? "Submission saved; the Obsidian note update is pending. Your final answers are safe."
              : "Submission saved. Grading the frozen answers now.", submission.projectionStatus === "pending" ? "warning" : "info");
          } else if (exam.status === "draft") {
            ctx.ui.notify("This exam is still a draft. Reopen it to finish building before submitting.", "warning");
            return;
          }
          // Already-submitted/graded requests follow the resume route below;
          // they never parse the edited paper or replace the saved answers.
        } else if (!parsed.value) {
          // Bare `/scholar exam` never prompts: the most recently touched
          // unfinished exam wins, and the rest are named rather than offered.
          const unfinished = unfinishedExams(book);
          if (!unfinished.length) {
            ctx.ui.notify(`No unfinished exam to resume. Create one with /scholar exam "<scope>".\n\n${examScopeGuidance(book)}`, "info");
            return;
          }
          exam = unfinished[0]!;
          const others = unfinished.slice(1);
          ctx.ui.notify(
            `Resuming ${examResumeLabel(exam)}.${others.length ? `\nOther unfinished exams: ${others.map((item) => `${item.title} [${item.id}]`).join("; ")}.` : ""}`,
            "info",
          );
        } else {
          const found = findNamedExam(book, parsed.value);
          if (found) {
            exam = found;
            if (exam.status === "graded") {
              ctx.ui.notify(`Viewing ${exam.title} (already graded: ${exam.earnedPoints}/${exam.maxPoints}, ${exam.percent}%).`, "info");
            } else {
              ctx.ui.notify(`Resuming ${examResumeLabel(exam)}.`, "info");
            }
          } else {
            const scope = await resolveExamScope(book, parsed.value, ctx);
            if (!scope) return;
            const now = new Date().toISOString();
            const number = book.exams.length + 1;
            const created: ScholarExam = {
              id: `exam-${String(number).padStart(3, "0")}`,
              title: `Exam ${String(number).padStart(2, "0")} — ${scope.description}`,
              scope,
              status: "draft",
              questions: [],
              rawResponses: [],
              itemResults: [],
              breakdown: [],
              earnedPoints: 0,
              maxPoints: 0,
              percent: 0,
              transcript: [],
              createdAt: now,
              updatedAt: now,
            };
            const mutation = await coordinator.mutateBook(book.id, (state) => {
              state.exams.push(created);
              state.currentExamId = created.id;
            });
            book = mutation.book;
            exam = book.exams.find((item) => item.id === created.id)!;
            ctx.ui.notify(`Started ${exam.title}.`, "info");
          }
        }
        if (exam.status === "active") {
          const presented = await coordinator.toolController.presentExam(book.id, exam.id, ctx);
          book = presented.book;
          exam = presented.exam;
          if (exam.status === "active") {
            await coordinator.activateBook(book, ctx, "exam", exam.id);
            ctx.ui.notify(`${exam.title}\nAnswer and save in Obsidian: ${presented.path}\nThen /scholar exam "${exam.id}" submit`, "info");
            return;
          }
          // Another Pi may have submitted/graded between the resume and open.
          // Route the fresh saved status instead of showing an undefined path.
        }
        if (exam.status === "graded") {
          const key = answerKeyNotePath(activeConfig, book, exam);
          if (!await keyExists(activeConfig, book, exam, key)) await coordinator.renderAll();
          if (!await keyExists(activeConfig, book, exam, key)) throw new Error(`The grade is saved, but its answer key could not be restored: ${key}`);
          ctx.ui.notify(`${exam.title}: ${exam.earnedPoints}/${exam.maxPoints} (${exam.percent}%).\nAnswer key: ${key}`, "info");
          return;
        }
        await coordinator.activateBook(book, ctx, "exam", exam.id);
        try {
          await coordinator.startScholarModeTurn(book, "exam", exam, ctx);
        } catch (error) {
          if (exam.status !== "submitted") throw error;
          ctx.ui.notify(`Your submission is saved, but grading could not start. Reopen /scholar exam "${exam.id}" to resume. ${error instanceof Error ? error.message : String(error)}`, "warning");
        }
        return;
      }

      if (parsed.action === "tutor") {
        let tutor = !parsed.value ? book.tutorSessions.find((item) => item.id === book.currentTutorId && item.status === "active") : undefined;
        if (!tutor) {
          if (!parsed.value) {
            ctx.ui.notify('Choose a chapter, section, or topic, for example: /scholar tutor "1.2".', "warning");
            return;
          }
          const scope = resolveScope(book, parsed.value, true);
          const now = new Date().toISOString();
          const number = book.tutorSessions.length + 1;
          tutor = {
            id: `tutor-${String(number).padStart(3, "0")}`,
            title: `Tutor ${String(number).padStart(2, "0")} — ${scope.description}`,
            scope,
            status: "active",
            keyPoints: [],
            attempts: [],
            transcript: [],
            createdAt: now,
            updatedAt: now,
          };
          const created = tutor;
          const mutation = await coordinator.mutateBook(book.id, (state) => {
            state.tutorSessions.push(created);
            state.currentTutorId = created.id;
          });
          book = mutation.book;
          tutor = book.tutorSessions.find((item) => item.id === created.id)!;
        }
        await coordinator.activateBook(book, ctx, "tutor", tutor.id);
        await coordinator.startScholarModeTurn(book, "tutor", tutor, ctx);
      }
    } finally {
      releaseModePreparation();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const programmingFailure = error instanceof ReferenceError || error instanceof TypeError || error instanceof SyntaxError;
    ctx.ui.notify(`Scholar could not continue: ${message}`, programmingFailure ? "error" : "warning");
  }
}
