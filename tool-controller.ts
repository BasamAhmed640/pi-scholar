import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import {
  activeProgressSummary,
} from "./domain.ts";
import {
  examAnswerProgress,
  examFormFingerprint,
  parseExamResponses,
} from "./exam.ts";
import { ensureExamAnswerNote, readExamAnswerNote } from "./exam-paper.ts";
import { isSameVaultPath } from "./transcript-recovery.ts";
import { createFigureCaptureTarget, type SourceFigureView } from "./figure-capture.ts";
import { modeCan } from "./modes.ts";
import { assertFreshSource, extractSourcePages } from "./ingest.ts";
import { applyFigureReviews, assertLearnFigureCoverage, validateFigureReviews } from "./figure-coverage.ts";
import {
  assertOutlineStructure,
  evaluateOutlineValidationDecisions,
  isProvisionalOutline,
  outlineValidationCheckpoints,
  preflightOutlineValidation,
  validationTextIsSparse,
  type OutlineValidationDecisionInput,
  type OutlineValidationReport,
  type OutlineValidationRun,
} from "./outline-validation.ts";
import type { ScholarRuntimeSession } from "./runtime-session.ts";
import {
  MAX_TOOL_CHARS,
  MAX_TOOL_PAGES,
  ScholarParams,
  type ToolDetails,
} from "./tool-contract.ts";
import {
  allSections,
  findSection,
  type ScholarBook,
  type ScholarConfig,
  type ScholarExam,
  type ScholarMode,
  type ScholarSection,
  type TutorSession,
} from "./types.ts";

import {
  handleSourceRead,
  handleSourceSearch,
  handleSourceView,
} from "./tool-actions/source.ts";
import {
  handleImageSave,
  handleImageSearch,
  handleSnapshot,
  handleModeSnapshot,
  type ImageSearchCache,
} from "./tool-actions/visuals.ts";
import {
  handleOutline,
  handleOutlineValidate,
} from "./tool-actions/outline.ts";
import {
  handleAssess,
  handleNotes,
} from "./tool-actions/learning.ts";
import {
  handleExamBuild,
  handleExamGrade,
  handleExamPresent,
} from "./tool-actions/exam.ts";

export type MutateBook = <T>(
  bookId: string,
  mutate: (book: ScholarBook) => Promise<T> | T,
) => Promise<{ book: ScholarBook; result: T; projectionStatus?: "synced" | "pending" }>;

export type ExamPresentation = { book: ScholarBook; exam: ScholarExam; path?: string; created?: boolean };
export type ExamSubmission = { book: ScholarBook; exam: ScholarExam; submitted: boolean; projectionStatus?: "synced" | "pending" };

export type ScholarToolControllerPorts = {
  pi: ExtensionAPI;
  session: ScholarRuntimeSession;
  getConfig(): ScholarConfig;
  loadBook(bookId: string): Promise<ScholarBook | undefined>;
  mutateBook: MutateBook;
  isActiveAuthority(book: ScholarBook): boolean;
  isSetupActive(book: ScholarBook): boolean;
};

export type ScholarToolController = {
  ensureRegistered(): void;
  prepareOutlineValidation(book: ScholarBook): OutlineValidationRun | undefined;
  clearOutlineValidation(): void;
  resetTransientState(): void;
  presentExam(bookId: string, examId: string, ctx?: ExtensionContext): Promise<ExamPresentation>;
  submitExam(bookId: string, examId: string, ctx: ExtensionContext): Promise<ExamSubmission>;
};

export function createScholarToolController(ports: ScholarToolControllerPorts): ScholarToolController {
  const { pi, session, loadBook, mutateBook } = ports;
  let toolRegistered = false;
  let outlineValidationRun: OutlineValidationRun | undefined;
  let outlineValidationAuthorityKey: string | undefined;
  let imageSearchCache: ImageSearchCache | undefined;
  const sourceFigureViews = new Map<number, SourceFigureView>();

  const librarySetupMessage = 'Scholar has no PDF library configured. Run /scholar library "<path>".';
  const obsidianSetupMessage = 'Scholar has no Obsidian vault configured. Run /scholar obsidian "<path>".';
  const hasConfiguredLibrary = () => ports.getConfig().libraryRoot.trim().length > 0;
  const hasConfiguredObsidian = () => ports.getConfig().obsidianRoot.trim().length > 0;

  const prepareOutlineValidation = (book: ScholarBook): OutlineValidationRun | undefined => {
    if (!isProvisionalOutline(book)) {
      outlineValidationRun = undefined;
      outlineValidationAuthorityKey = undefined;
      return undefined;
    }
    const authorityKey = createHash("sha256")
      .update(JSON.stringify([book.id, book.instanceId, book.revision, book.chapters]))
      .digest("hex");
    if (
      !outlineValidationRun
      || outlineValidationRun.bookId !== book.id
      || outlineValidationRun.outlineRevision !== book.revision
      || outlineValidationAuthorityKey !== authorityKey
    ) {
      outlineValidationRun = {
        bookId: book.id,
        outlineRevision: book.revision,
        checkpoints: outlineValidationCheckpoints(book.chapters, book.metadata.pageCount),
        pageText: new Map<number, string>(),
        sparsePages: new Set<number>(),
        viewedPages: new Set<number>(),
      };
      outlineValidationAuthorityKey = authorityKey;
    }
    return outlineValidationRun;
  };

  const recordOutlineValidationView = (book: ScholarBook, page: number): void => {
    if (session.mode || !isProvisionalOutline(book)) return;
    const run = prepareOutlineValidation(book);
    if (run?.checkpoints.some((checkpoint) => checkpoint.page === page)) run.viewedPages.add(page);
  };

  const hydrateOutlineValidation = async (
    book: ScholarBook,
  ): Promise<{ run: OutlineValidationRun; report: OutlineValidationReport }> => {
    const run = prepareOutlineValidation(book);
    if (!run) throw new Error("Scholar has no provisional outline awaiting validation.");
    run.pageText.clear();
    run.sparsePages.clear();
    const pages = [...new Set(run.checkpoints.map((checkpoint) => checkpoint.page))].sort((a, b) => a - b);
    for (const page of pages) {
      const source = await extractSourcePages(book, page, page, 12_000, true);
      const header = `[Page ${page}]\n`;
      const text = (source.startsWith(header) ? source.slice(header.length) : source).trim();
      if (validationTextIsSparse(text)) run.sparsePages.add(page);
      else run.pageText.set(page, text);
    }
    return { run, report: preflightOutlineValidation(book, run) };
  };

  const validationSummary = (report: OutlineValidationReport): string => {
    const score = `${report.passed}/${report.total} checks passed`;
    if (report.status === "ready") return `Outline ready · ${score}.`;
    const issueText = report.issues.map((item) => {
      const at = item.page ? `${item.checkpointId} on PDF page ${item.page}` : item.checkpointId;
      return `${at}: ${item.message}${item.observed ? ` Observed: ${item.observed}` : ""}`;
    }).join(" ");
    if (report.status === "visual-review") {
      const pages = report.visualPages.length ? ` Render PDF page${report.visualPages.length === 1 ? "" : "s"} ${report.visualPages.join(", ")}.` : "";
      const decisions = report.requiredDecisionIds.length ? ` Then submit one decision for: ${report.requiredDecisionIds.join(", ")}.` : "";
      return `Outline review · ${score}.${pages}${decisions}${issueText ? ` ${issueText}` : ""}`;
    }
    if (report.status === "source-read-required") {
      return `Outline check paused · ${score}. Scholar could not collect all checkpoint text.${issueText ? ` ${issueText}` : ""}`;
    }
    return `Outline needs review · ${score}. All checkpoint findings: ${issueText || "the candidate outline is disputed"}. No learning data was lost.`;
  };

  const validationHeadline = (report: OutlineValidationReport): string => {
    const score = `${report.passed}/${report.total}`;
    if (report.status === "ready") return `Outline ready · ${score} checks passed`;
    if (report.status === "visual-review") {
      const pages = report.visualPages.length ? ` · review page${report.visualPages.length === 1 ? "" : "s"} ${report.visualPages.join(", ")}` : "";
      return `Outline review · ${score} checks passed${pages}`;
    }
    if (report.status === "source-read-required") return `Outline check paused · ${score} checks passed`;
    const corrections = report.issues.length;
    return `Outline needs ${corrections} correction${corrections === 1 ? "" : "s"} · ${score} checks passed`;
  };

  const finishOutlineValidation = async (
    book: ScholarBook,
    run: OutlineValidationRun,
    report: OutlineValidationReport,
  ): Promise<{ content: Array<{ type: "text"; text: string }>; details: ToolDetails }> => {
    if (report.status === "ready") {
      const mutation = await mutateBook(book.id, (state) => {
        if (!ports.isSetupActive(state) || state.instanceId !== book.instanceId) {
          throw new Error("Scholar setup ended or changed during outline validation.");
        }
        if (state.revision !== run.outlineRevision || !isProvisionalOutline(state)) {
          throw new Error("The provisional outline changed during validation; validate its current revision.");
        }
        state.outlineStatus = "ready";
        state.currentSectionId = undefined;
      });
      const persisted = mutation.book;
      outlineValidationRun = undefined;
      outlineValidationAuthorityKey = undefined;
      const result = toolResult(
        "outline_validate",
        validationHeadline(report),
        {
          bookId: persisted.id,
          outlineRevision: run.outlineRevision,
          checkpoints: run.checkpoints,
          tone: "progress",
          validationReport: report,
        },
      );
      result.content[0] = {
        type: "text",
        text: `${validationSummary(report)} The book is ready. No Learn section was selected; choose a chapter or section explicitly with /scholar learn.`,
      };
      return result;
    }

    if (report.status === "outline-repair" || report.status === "needs-review") {
      const mutation = await mutateBook(book.id, (state) => {
        if (!ports.isSetupActive(state) || state.instanceId !== book.instanceId) {
          throw new Error("Scholar setup ended or changed during outline validation.");
        }
        if (state.revision !== run.outlineRevision || !isProvisionalOutline(state)) {
          throw new Error("The provisional outline changed during validation; validate its current revision.");
        }
        state.outlineStatus = "needs-review";
        state.currentSectionId = undefined;
      });
      outlineValidationRun = undefined;
      outlineValidationAuthorityKey = undefined;
      const result = toolResult(
        "outline_validate",
        validationHeadline(report),
        {
          bookId: mutation.book.id,
          outlineRevision: run.outlineRevision,
          checkpoints: run.checkpoints,
          tone: "review",
          validationReport: report,
        },
      );
      result.content[0] = {
        type: "text",
        text: `${validationSummary(report)} Submit one replacement outline with the corrected boundaries and headings before teaching.`,
      };
      return result;
    }

    const result = toolResult(
      "outline_validate",
      validationHeadline(report),
      {
        bookId: book.id,
        outlineRevision: run.outlineRevision,
        checkpoints: run.checkpoints,
        tone: "review",
        validationReport: report,
      },
    );
    result.content[0] = {
      type: "text",
      text: `${validationSummary(report)} Call view for the unresolved page(s), inspect the rendered headings, then submit your decisions.`,
    };
    return result;
  };

  const toolResult = (
    action: string,
    summary: string,
    details: Partial<ToolDetails> = {},
  ): { content: Array<{ type: "text"; text: string }>; details: ToolDetails } => ({
    content: [{ type: "text", text: summary }],
    details: { action, summary, ...details } as ToolDetails,
  });

  const requireActiveBook = async (): Promise<ScholarBook> => {
    if (!hasConfiguredLibrary()) throw new Error(librarySetupMessage);
    const bookId = session.bookId || ports.getConfig().currentBookId;
    if (!bookId) throw new Error("No book is currently selected in Scholar. Run /scholar open.");
    const book = await loadBook(bookId);
    if (!book) throw new Error(`Scholar could not load book ${bookId}. Run /scholar open.`);
    return book;
  };

  const requireMode = (expected: ScholarMode): void => {
    if (session.mode !== expected) throw new Error(`Scholar action requires ${expected} mode (current mode: ${session.mode || "none"}).`);
  };

  const requireLearnSection = (book: ScholarBook): ScholarSection => {
    requireMode("learn");
    if (!session.recordId) throw new Error("No Learn section is active. Start with /scholar learn.");
    const section = findSection(book, session.recordId);
    if (!section) throw new Error("Scholar Learn has no valid frozen section target. Start Learn again with an explicit chapter or section.");
    return section;
  };

  const isOperationalFailure = (error: unknown, message: string): boolean => {
    if (!(error instanceof Error) || error.name !== "Error") return true;
    if (typeof (error as Error & { code?: unknown }).code === "string") return true;
    return /(?:source changed since import|source is not a file|book state could not be loaded|authority .*missing|schema v3|refusing to (?:create|save)|configured root is not a directory|could not (?:read|render|extract|download)|\bPoppler\b|identity collision)/i.test(message);
  };

  const requireReferenceImageTarget = (book: ScholarBook): ScholarExam | TutorSession => {
    if (session.mode === "exam") {
      const exam = book.exams.find((item) => item.id === session.recordId);
      if (!exam || exam.status !== "draft") {
        throw new Error("Internet visuals can be selected only while the active Exam is still a draft.");
      }
      return exam;
    }
    if (session.mode === "tutor") {
      const tutor = book.tutorSessions.find((item) => item.id === session.recordId);
      if (!tutor || tutor.status !== "active") throw new Error("Internet visuals require an active Tutor session.");
      return tutor;
    }
    throw new Error("Internet visuals are available only in Exam or Tutor mode. Learn uses exact figures from the selected PDF.");
  };

  const presentExam = async (
    bookId: string,
    examId: string,
    ctx?: ExtensionContext,
  ): Promise<ExamPresentation> => {
    const config = structuredClone(ports.getConfig());
    const book = await loadBook(bookId);
    const exam = book?.exams.find((item) => item.id === examId);
    if (!book || !exam) throw new Error(`Scholar exam is missing: ${examId}`);
    if (exam.status === "submitted" || exam.status === "graded") return { book, exam };
    if (exam.status !== "active" || !exam.questions.length) throw new Error("The exam has no frozen questions yet.");
    const paper = await ensureExamAnswerNote(config, book, exam);
    if (paper.created) ctx?.ui.notify("Created a blank answer paper from the frozen exam. Any answers in a previously deleted paper cannot be recovered.", "info");
    return { book, exam, ...paper };
  };

  // The command owns the navigation/input lock. No model tool can submit on
  // the learner's behalf; only this explicit, confirmed command path commits.
  const submitExam = async (bookId: string, examId: string, ctx: ExtensionContext): Promise<ExamSubmission> => {
    if (!ctx.hasUI || typeof ctx.ui?.confirm !== "function") throw new Error("Exam submission requires interactive confirmation in Pi.");
    const config = structuredClone(ports.getConfig());
    const book = await loadBook(bookId);
    const exam = book?.exams.find((item) => item.id === examId);
    if (!book || !exam) throw new Error(`Scholar exam is missing: ${examId}`);
    if (exam.status !== "active") throw new Error(`Only an active exam can be submitted. ${exam.title} is ${exam.status}; reopen it with /scholar exam "${exam.id}".`);
    const form = examFormFingerprint(exam);
    const paper = await readExamAnswerNote(config, book, exam);
    const progress = examAnswerProgress(exam, paper.text);
    if (!progress.ok) throw new Error(progress.problem);
    const rawResponses = parseExamResponses(exam, paper.text);
    const confirmed = await ctx.ui.confirm(`Submit ${exam.title}?`, [
      `${progress.total} questions · ${progress.answered} answered · ${progress.blank.length} blank`,
      ...(progress.blank.length ? [`Blank: ${progress.blank.join(", ")}`] : []),
      "", "Submitting is final. Blank answers receive 0 points.",
      "Save your Obsidian edits first. Later edits will not change this submission.",
    ].join("\n"));
    if (!confirmed) return { book, exam, submitted: false };
    const assertTarget = () => {
      if (!isSameVaultPath(config.obsidianRoot, ports.getConfig().obsidianRoot)) throw new Error("The selected vault changed. Reopen the exam before submitting.");
    };
    assertTarget();
    const mutation = await mutateBook(bookId, async (state) => {
      assertTarget();
      const current = state.exams.find((item) => item.id === examId);
      if (state.instanceId !== book.instanceId || !current || current.status !== "active" || examFormFingerprint(current) !== form) {
        throw new Error("The exam changed while submission was being confirmed. Reopen it; no answers were replaced.");
      }
      // Check inside the serialized mutation, after any earlier writer, and
      // commit only the exact saved bytes that the learner confirmed.
      const latest = await readExamAnswerNote(config, state, current);
      assertTarget();
      if (latest.text !== paper.text) throw new Error("The saved answer paper changed during confirmation. Nothing was submitted; run submit again to confirm the updated answers.");
      current.rawResponses = rawResponses;
      current.status = "submitted";
      current.submittedAt = new Date().toISOString();
      current.updatedAt = current.submittedAt;
    });
    return { book: mutation.book, exam: mutation.book.exams.find((item) => item.id === examId)!, submitted: true, projectionStatus: mutation.projectionStatus };
  };

  const ensureRegistered = () => {
    if (toolRegistered) return;
    toolRegistered = true;
    pi.registerTool({
      name: "scholar",
      label: "Scholar",
      description: "Read the selected PDF and persist source-grounded Learn, Exam, or Tutor work. All modes can save literal PDF crops after viewing the page; Exam captures must precede exam_build and Tutor captures require an active session. Exam/Tutor may also select attributed Commons visuals. Exam answers are written by the learner in Obsidian and submitted explicitly in Pi; ordinary chat is not transcribed.",
      parameters: ScholarParams,
      executionMode: "sequential",
      renderShell: "self",

      async execute(toolCallId, params, signal, _onUpdate, ctx) {
        try {
          const book = await requireActiveBook();
          if (!ports.isActiveAuthority(book)) {
            throw new Error("Scholar stopped because the active book authority changed. Select the PDF again.");
          }
          const setupActive = ports.isSetupActive(book);
          if (!session.mode && !setupActive && params.action !== "status") {
            throw new Error("Scholar has no active operation. Start explicitly with /scholar learn, /scholar exam, or /scholar tutor.");
          }
          if (session.mode && book.outlineStatus !== "ready") {
            throw new Error("Scholar modes are locked until this PDF's outline is verified.");
          }

          if (params.action === "read") {
            return await handleSourceRead(book, session, params, mutateBook);
          }

          if (params.action === "view") {
            const canCapture = session.mode === "exam"
              ? book.exams.some((item) => item.id === session.recordId && item.status === "draft")
              : session.mode === "tutor" && book.tutorSessions.some((item) => item.id === session.recordId && item.status === "active");
            const target = canCapture ? createFigureCaptureTarget(book, session, ports.getConfig, ports.isActiveAuthority) : undefined;
            return await handleSourceView(book, session, params, recordOutlineValidationView, mutateBook, target
              ? async (page, width, height) => {
                const current = await loadBook(book.id);
                if (!current) throw new Error("The source book was removed while viewing its figure.");
                target.assertCurrent(current);
                await assertFreshSource(current);
                target.assertCurrent(current);
                // Retain only this activation's receipts, bounded by source pages.
                const previous = sourceFigureViews.values().next().value;
                if (previous && (previous.activation !== target.activation || previous.identity !== target.identity)) sourceFigureViews.clear();
                sourceFigureViews.set(page, { activation: target.activation, identity: target.identity, page, width, height });
              } : undefined);
          }

          if (params.action === "search") {
            return await handleSourceSearch(book, session, params);
          }

          if (params.action === "snapshot") {
            if (!hasConfiguredObsidian()) throw new Error(obsidianSetupMessage);
            if (!modeCan(session.mode, "capturesSourceFigures")) throw new Error("Scholar snapshot requires an active Learn, Exam, or Tutor record.");
            if (session.mode !== "learn") {
              const target = createFigureCaptureTarget(book, session, ports.getConfig, ports.isActiveAuthority);
              return await handleModeSnapshot(book, target, sourceFigureViews.get(params.page!), params, ports.getConfig, mutateBook, toolResult);
            }
            const section = requireLearnSection(book);
            const activation = session.state;
            const vault = ports.getConfig().obsidianRoot;
            return await handleSnapshot(book, section, params, () => ports.getConfig(), mutateBook, toolResult, (state) => {
              if (session.state !== activation || !isSameVaultPath(vault, ports.getConfig().obsidianRoot) || !ports.isActiveAuthority(state)) {
                throw new Error("The active Learn record or vault changed while preparing its snapshot. View the page again in the current section.");
              }
            });
          }

          if (params.action === "image_search") {
            requireReferenceImageTarget(book);
            return await handleImageSearch(book, session, params.query, params.limit, signal, (cache) => { imageSearchCache = cache; }, toolResult);
          }

          if (params.action === "image_save") {
            if (!hasConfiguredObsidian()) throw new Error(obsidianSetupMessage);
            requireReferenceImageTarget(book);
            return await handleImageSave(book, session, params.imagePageId, params.caption, imageSearchCache, signal, () => ports.getConfig(), mutateBook);
          }

          if (params.action === "outline") {
            if (session.mode || !setupActive) throw new Error("Scholar outlines can be created only by the active book-setup operation.");
            return await handleOutline(
              book,
              setupActive,
              params,
              ports.isSetupActive,
              mutateBook,
              () => { outlineValidationRun = undefined; },
              hydrateOutlineValidation,
              finishOutlineValidation,
              toolResult,
            );
          }

          if (params.action === "outline_validate") {
            if (session.mode || !setupActive) throw new Error("Scholar outline validation can be performed only by the active book-setup operation.");
            return await handleOutlineValidate(
              book,
              params.outlineRevision,
              params.validationChecks,
              hydrateOutlineValidation,
              finishOutlineValidation,
            );
          }

          if (params.action === "notes") {
            const saveNotes: MutateBook = async (bookId, update) => mutateBook(bookId, async (state) => {
              if (session.mode === "learn" && params.figureReviews) {
                const section = requireLearnSection(state);
                const reviews = await validateFigureReviews(ports.getConfig(), state, section, params.figureReviews);
                applyFigureReviews(section, reviews);
              } else if (params.figureReviews) {
                throw new Error("Source figure reviews belong only to the active Learn section.");
              }
              const result = await update(state);
              const section = session.mode === "learn" ? requireLearnSection(state) : undefined;
              if (section?.status === "complete" && section.figureCoverage) await assertLearnFigureCoverage(ports.getConfig(), state, section);
              return result;
            });
            return await handleNotes(book, session, params, requireLearnSection, saveNotes, toolResult);
          }

          if (params.action === "assess") {
            if (session.mode === "learn" && !params.attemptId && params.grounding?.purpose !== "diagnostic") {
              await assertLearnFigureCoverage(ports.getConfig(), book, requireLearnSection(book));
            }
            const saveAssessment: MutateBook = async (bookId, update) => mutateBook(bookId, async (state) => {
              if (session.mode === "learn" && !params.attemptId && params.grounding?.purpose !== "diagnostic") {
                await assertLearnFigureCoverage(ports.getConfig(), state, requireLearnSection(state));
              }
              const result = await update(state);
              const section = session.mode === "learn" ? requireLearnSection(state) : undefined;
              if (section?.status === "complete" && section.figureCoverage) await assertLearnFigureCoverage(ports.getConfig(), state, section);
              return result;
            });
            return await handleAssess(book, session, toolCallId, params, requireLearnSection, saveAssessment, toolResult);
          }

          if (params.action === "exam_build") {
            requireMode("exam");
            const examId = params.examId || session.recordId;
            if (!examId || examId !== session.recordId) throw new Error("Scholar exam_build must target the active exam.");
            return await handleExamBuild(book, examId, params.questions || [], ctx, mutateBook, presentExam, toolResult);
          }

          if (params.action === "exam_present") {
            requireMode("exam");
            const examId = params.examId || session.recordId;
            if (!examId || examId !== session.recordId) throw new Error("Scholar exam_present must target the active exam.");
            return await handleExamPresent(book, examId, ctx, presentExam, toolResult);
          }

          if (params.action === "exam_grade") {
            requireMode("exam");
            const examId = params.examId || session.recordId;
            if (!examId || examId !== session.recordId) throw new Error("Scholar exam_grade must target the active exam.");
            return await handleExamGrade(book, examId, params.itemResults || [], mutateBook, toolResult);
          }

          if (params.action === "status") {
            const summary = activeProgressSummary(book, session.mode, session.recordId);
            return toolResult("status", summary, { bookId: book.id });
          }

          throw new Error(`Unknown Scholar action: ${(params as { action?: string }).action}`);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/(?:PDF outline is missing|needs OCR|no text)/i.test(message)) {
            try {
              const currentBook = await loadBook(session.bookId || ports.getConfig().currentBookId || "");
              if (currentBook) {
                await mutateBook(currentBook.id, (state) => {
                  const section = session.recordId ? findSection(state, session.recordId) : undefined;
                  state.outlineStatus = "needs-ocr";
                  state.currentSectionId = undefined;
                  if (section && section.status !== "complete") section.status = "review";
                });
                outlineValidationRun = undefined;
                outlineValidationAuthorityKey = undefined;
              }
            } catch {
              // Preserve the original extraction error if state persistence also fails.
            }
          }
          const recoverableOutlineIssue = !session.mode
            && (params.action === "outline" || params.action === "outline_validate")
            && /(?:provisional outline|outline requires|outline validation requires|stale outline validation|outline changed during validation|outlines can be created only|will not replace an outline|chapter \d+ needs|chapter \d+ has invalid|chapters .*overlap|chapters must be supplied|section \d+ needs|section \d+ falls outside|sections must be supplied|sections .*overlap)/i.test(message);
          const operationalFailure = !recoverableOutlineIssue && isOperationalFailure(error, message);
          const tone = recoverableOutlineIssue ? "review" : operationalFailure ? "error" : "retry";
          return toolResult(
            params.action,
            `${recoverableOutlineIssue ? "Scholar review" : operationalFailure ? "Scholar error" : "Scholar retry"}: ${message}`,
            { tone },
          );
        }
      },

      renderCall(args, theme) {
        const action = typeof args.action === "string" ? args.action : "work";
        const pageRange = action === "read" && typeof args.startPage === "number"
          ? ` ${args.startPage}${typeof args.endPage === "number" && args.endPage !== args.startPage ? `–${args.endPage}` : ""}`
          : "";
        return new Text(
          `${theme.fg("toolTitle", theme.bold(`Scholar · ${action}`))}${theme.fg("muted", pageRange)}`,
          0,
          0,
        );
      },

      renderResult(result, { expanded }, theme, context) {
        const details = result.details as ToolDetails | undefined;
        const summary = details?.summary || "Scholar finished.";
        const isError = context?.isError === true || details?.tone === "error" || summary.startsWith("Scholar error:");
        if (!expanded && details?.tone === "retry") return new Text("", 0, 0);
        // A successful read already names its page range in renderCall. Keep the
        // collapsed transcript to one line; Ctrl+O still reveals the summary.
        if (!expanded && !isError && details?.action === "read") return new Text("", 0, 0);
        const role = isError ? "error" : details?.tone === "review" ? "warning" : "muted";
        return new Text(theme.fg(role, summary), 0, 0);
      },
    });
  };

  const clearOutlineValidation = (): void => {
    outlineValidationRun = undefined;
    outlineValidationAuthorityKey = undefined;
  };

  const clearImageSelection = (): void => {
    imageSearchCache = undefined;
  };

  const resetTransientState = (): void => {
    clearOutlineValidation();
    clearImageSelection();
    sourceFigureViews.clear();
  };

  return {
    ensureRegistered,
    prepareOutlineValidation,
    clearOutlineValidation,
    resetTransientState,
    presentExam,
    submitExam,
  };
}
