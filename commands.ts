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
  sectionLabel,
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

/** How many times a mistyped exam scope is re-asked before giving up. */
const MAX_EXAM_SCOPE_PROMPTS = 3;

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
export function scholarGuide(book?: ScholarBook): string {
  const current = book
    ? `Selected book: ${titleFor(book)}`
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
    '  Guided study of textbook sections. Presents source-grounded lessons, verified diagrams/figures, and comprehension checks with feedback to build section mastery. Run bare (/scholar learn) to resume your active unfinished section.',
    "",
    "• /scholar exam <scope>",
    '  Answer an exam in Obsidian. Specify chapters (e.g. "1-3", "1, 2", or "all"), or reopen an exam by ID. Run bare (/scholar exam) to resume an in-progress exam or begin a new one.',
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
 * Resolve an exam scope, re-asking with the specific reason when the entry does
 * not match the book. A scope typed on the command line gets the same treatment,
 * so a near miss reopens the picker instead of ending the command.
 */
export async function resolveExamScope(
  book: ScholarBook,
  provided: string | undefined,
  ctx: ExtensionCommandContext,
): Promise<ScholarScope | undefined> {
  const guidance = examScopeGuidance(book);
  const canPrompt = typeof ctx.ui?.input === "function";
  let candidate = provided?.trim() ? provided : undefined;
  let problem: string | undefined;

  for (let attempt = 0; attempt < MAX_EXAM_SCOPE_PROMPTS; attempt += 1) {
    if (!candidate) {
      if (!canPrompt) {
        ctx.ui.notify(`${problem ? `${problem}\n\n` : ""}Choose an exam scope.\n\n${guidance}`, problem ? "warning" : "warning");
        return undefined;
      }
      const heading = problem
        ? `${problem}\n\nTry again.\n\n${guidance}`
        : `Create an exam from ${titleFor(book)}.\n\n${guidance}`;
      const entered = await ctx.ui.input(heading, "e.g. 1-3");
      if (entered === undefined) return undefined;
      if (!entered.trim()) {
        problem = "No scope entered.";
        continue;
      }
      candidate = cleanArgument(entered);
    }
    try {
      return resolveScope(book, candidate, false);
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
      candidate = undefined;
      if (!canPrompt) {
        ctx.ui.notify(`${problem}\n\n${guidance}`, "warning");
        return undefined;
      }
    }
  }
  ctx.ui.notify(`${problem || "That exam scope could not be matched."}\n\nNo exam was created.\n\n${guidance}`, "warning");
  return undefined;
}

const START_A_NEW_EXAM = "Start a new exam instead…";

/** Every exam that can still be answered or graded, newest first. */
export function unfinishedExams(book: ScholarBook): ScholarExam[] {
  return book.exams
    .filter((exam) => exam.status !== "graded")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function examResumeLabel(exam: ScholarExam): string {
  const state = exam.status === "submitted"
    ? "submitted · awaiting grading"
    : exam.status === "active"
      ? `${exam.questions.length} question(s) · not yet submitted`
      : "draft · questions not built yet";
  return `${exam.title} — ${state}`;
}

type ExamResume =
  | { kind: "resume"; exam: ScholarExam }
  | { kind: "none" }
  | { kind: "cancelled" };

/**
 * Pick up an exam that was started and not finished.
 *
 * A bare `/scholar exam` used to consult only currentExamId, so a second
 * unfinished exam was unreachable and silently became a new one. Offer every
 * unfinished exam instead, and treat cancelling the picker as "do nothing"
 * rather than "create another".
 *
 * The picker also runs for a single unfinished exam. Resuming silently made a
 * resume and a fresh start look identical at the prompt, and it left no way to
 * begin a new exam from a bare command while one was still open.
 */
export async function chooseUnfinishedExam(book: ScholarBook, ctx: ExtensionCommandContext, config?: ScholarConfig): Promise<ExamResume> {
  const unfinished = unfinishedExams(book);
  if (unfinished.length === 0) return { kind: "none" };

  const current = unfinished.find((exam) => exam.id === book.currentExamId);
  if (typeof ctx.ui?.select !== "function") {
    return { kind: "resume", exam: current || unfinished[0]! };
  }
  const labels = await Promise.all(unfinished.map((exam) => config && exam.status === "active" ? examPaperLabel(config, book, exam) : examResumeLabel(exam)));
  const chosen = await ctx.ui.select(
    `Resume an unfinished exam from ${titleFor(book)}`,
    [...labels, START_A_NEW_EXAM],
  );
  if (chosen === undefined) return { kind: "cancelled" };
  if (chosen === START_A_NEW_EXAM) return { kind: "none" };
  const index = labels.indexOf(chosen);
  return index >= 0 ? { kind: "resume", exam: unfinished[index]! } : { kind: "cancelled" };
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

export async function handleScholarCommand(
  args: string,
  ctx: ExtensionCommandContext,
  coordinator: ScholarRuntimeCoordinator,
): Promise<void> {
  try {
    const parsed = parseScholarCommand(args);
    if (parsed.action === "invalid") {
      ctx.ui.notify("Invalid Scholar command. Use /scholar help for the exact command forms.", "warning");
      return;
    }

    if (parsed.action === "help") {
      const bookId = coordinator.runtimeSession.bookId || coordinator.getConfig().currentBookId;
      const book = bookId ? await loadBookState(coordinator.getConfig(), bookId).catch(() => undefined) : undefined;
      ctx.ui.notify(scholarGuide(book), "info");
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

    if (!coordinator.getSetupRun() && coordinator.runtimeSession.active && coordinator.runtimeSession.bookId && !await loadBookState(activeConfig, coordinator.runtimeSession.bookId).catch(() => undefined)) {
      coordinator.deactivateSession();
      coordinator.persistSessionPointer();
      await coordinator.setStatus(ctx);
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

    const bookId = coordinator.runtimeSession.bookId || activeConfig.currentBookId;
    let book = bookId ? await loadBookState(activeConfig, bookId).catch(() => undefined) : undefined;

    if (parsed.action === "default") {
      ctx.ui.notify(scholarGuide(book), "info");
      return;
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
          const resume = await chooseUnfinishedExam(book, ctx, activeConfig);
          if (resume.kind === "cancelled") return;
          if (resume.kind === "resume") {
            exam = resume.exam;
            ctx.ui.notify(`Resuming ${examResumeLabel(exam)}.`, "info");
          }
        } else {
          const found = findNamedExam(book, parsed.value);
          if (found) {
            exam = found;
            if (exam.status === "graded") {
              ctx.ui.notify(`Viewing ${exam.title} (already graded: ${exam.earnedPoints}/${exam.maxPoints}, ${exam.percent}%).`, "info");
            } else {
              ctx.ui.notify(`Resuming ${examResumeLabel(exam)}.`, "info");
            }
          }
        }
        if (!exam) {
          const scope = await resolveExamScope(book, parsed.value, ctx);
          if (!scope) return;
          const now = new Date().toISOString();
          const number = book.exams.length + 1;
          exam = {
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
          const created = exam;
          const mutation = await coordinator.mutateBook(book.id, (state) => {
            state.exams.push(created);
            state.currentExamId = created.id;
          });
          book = mutation.book;
          exam = book.exams.find((item) => item.id === created.id)!;
          ctx.ui.notify(`Started ${exam.title}.`, "info");
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
          // Another Pi may have submitted/graded between the picker and open.
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
