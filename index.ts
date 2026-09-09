import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { getScholarArgumentCompletions } from "./command-syntax.ts";
import { ensureScholarAppearance } from "./appearance.ts";
import { handleScholarCommand } from "./commands.ts";
import {
  appendTranscript,
  findQuizAttempt,
  findSection,
  findTutorQuizAttempt,
  messageTranscriptEntry,
  quizKind,
  recomputeProgress,
  titleFor,
} from "./domain.ts";
import { modeCan } from "./modes.ts";
import { assertQuestionGrounding } from "./question-grounding.ts";
import { assertLearnFigureCoverage } from "./figure-coverage.ts";
import { registerScholarQuiz } from "./quiz.ts";
import {
  parseScholarQuizDetails,
  parseScholarQuizInput,
  scholarQuizCorrectAnswer,
  SCHOLAR_QUIZ_TOOL_NAME,
} from "./quiz-contract.ts";
import { createScholarInputLockController } from "./input-lock.ts";
import { createScholarToolController } from "./tool-controller.ts";
import { isProvisionalOutline } from "./outline-validation.ts";
import {
  kickoffMessage,
  ScholarRuntimeCoordinator,
  setupInstructions,
} from "./runtime-coordinator.ts";
import { reconcileScholarRuntimeTarget } from "./runtime-session.ts";
import { loadBookState } from "./storage.ts";
import { modeInstructions } from "./policies.ts";
import { freezeRecoveryTarget, isSameVaultPath } from "./transcript-recovery.ts";
import type { ScholarSection } from "./types.ts";

export default function scholarExtension(pi: ExtensionAPI) {
  const { acquireInputLock, releaseAllInputLocks } = createScholarInputLockController();
  let warningContext: ExtensionContext | undefined;
  const coordinator = new ScholarRuntimeCoordinator(pi, acquireInputLock, releaseAllInputLocks,
    (message) => warningContext?.ui.notify(message, "warning"));

  const toolController = createScholarToolController({
    pi,
    session: coordinator.runtimeSession,
    getConfig: () => coordinator.getConfig(),
    loadBook: (bookId) => loadBookState(coordinator.getConfig(), bookId),
    mutateBook: coordinator.mutateBook,
    isActiveAuthority: (book) => coordinator.ownsActiveAuthority(book),
    isSetupActive: (book) => coordinator.isSetupActive(book),
  });
  coordinator.toolController = toolController;

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    warningContext = ctx;
    coordinator.resetProjectionWarnings();
    coordinator.releaseAllInputLocks();
    const hadInFlightRun = Boolean(coordinator.setupRun || coordinator.scholarTurnRun);
    coordinator.setupRun = undefined;
    coordinator.scholarTurnRun = undefined;
    coordinator.navigationRun = undefined;
    coordinator.activeAuthority = undefined;
    coordinator.toolController.resetTransientState();

    const releaseInput = coordinator.acquireInputLock(ctx, "starting");
    try {
      const restored = coordinator.runtimeSession.restore(ctx.sessionManager.getBranch());
      const activeConfig = await coordinator.loadFreshConfig();
      await ensureScholarAppearance(activeConfig, (message) => ctx.ui.notify(message, "warning"));

      // Reconcile vault note projections on startup whenever Obsidian is configured,
      // independently of whether a mode/book is active, preserving empty-vault protection.
      if (coordinator.hasConfiguredObsidian()) {
        try {
          await coordinator.renderAll();
        } catch (error) {
          ctx.ui.notify(`Scholar could not sync notes on startup: ${error instanceof Error ? error.message : String(error)}`, "warning");
        }
      }

      if (!coordinator.runtimeSession.active) {
        await coordinator.setStatus(ctx);
        return;
      }
      if (!coordinator.hasConfiguredLibrary() || !coordinator.hasConfiguredObsidian()) {
        coordinator.deactivateSession();
        coordinator.persistSessionPointer();
        await coordinator.setStatus(ctx);
        return;
      }
      if (restored.vaultPath && !isSameVaultPath(restored.vaultPath, activeConfig.obsidianRoot)) {
        coordinator.deactivateSession();
        coordinator.persistSessionPointer();
        await coordinator.setStatus(ctx);
        return;
      }
      const restoredState = coordinator.runtimeSession.state;
      const book = coordinator.runtimeSession.bookId ? await loadBookState(activeConfig, coordinator.runtimeSession.bookId) : undefined;
      const reconciliation = reconcileScholarRuntimeTarget(restoredState, book, restored.instanceId);
      let normalized = false;
      if (reconciliation.kind === "invalid") {
        if ((hadInFlightRun || coordinator.setupRun || coordinator.scholarTurnRun) && typeof ctx.abort === "function") void ctx.abort();
        coordinator.deactivateSession();
        coordinator.persistSessionPointer();
        await coordinator.setStatus(ctx);
        return;
      }
      if (!book) {
        coordinator.deactivateSession();
        coordinator.persistSessionPointer();
        await coordinator.setStatus(ctx);
        return;
      }
      coordinator.activeAuthority = { bookId: book.id, instanceId: book.instanceId };
      if (coordinator.runtimeSession.mode && coordinator.runtimeSession.bookId) {
        const recoveryTarget = freezeRecoveryTarget(
          activeConfig.obsidianRoot,
          coordinator.runtimeSession,
          coordinator.activeAuthority,
        );
        if (recoveryTarget) {
          try {
            const outcome = await coordinator.recoverTarget(recoveryTarget, ctx, true);
            if (outcome.kind === "error") {
              ctx.ui.notify(`Scholar transcript recovery encountered an issue: ${outcome.error}`, "warning");
            }
          } catch (error) {
            ctx.ui.notify(`Scholar could not recover transcript on startup: ${error instanceof Error ? error.message : String(error)}`, "warning");
          }
        }
      }
      if (
        reconciliation.kind === "stale"
        || (reconciliation.kind === "setup" && restoredState.kind !== "selected")
        || (reconciliation.kind === "active" && reconciliation.terminal)
      ) {
        coordinator.runtimeSession.activate(book.id);
        normalized = true;
      }
      if (normalized) coordinator.persistSessionPointer(book);
      else if (restored.found) coordinator.runtimeSession.seedPersistedKey(book, restored.sectionId);

      if (book.outlineStatus !== "ready" || coordinator.runtimeSession.mode) coordinator.toolController.ensureRegistered();
      if (modeCan(coordinator.runtimeSession.mode, "assesses") && !coordinator.quizRegistered) {
        registerScholarQuiz(pi);
        coordinator.quizRegistered = true;
      }
      await coordinator.setStatus(ctx);
      if (reconciliation.kind === "setup") await coordinator.startBookSetup(book, ctx);
    } finally {
      releaseInput();
    }
  });

  pi.on("before_agent_start", async (event, ctx: ExtensionContext) => {
    if (!coordinator.hasConfiguredLibrary() || !coordinator.runtimeSession.active || !coordinator.runtimeSession.bookId) return;
    const activeConfig = coordinator.getConfig();
    const book = await loadBookState(activeConfig, coordinator.runtimeSession.bookId);
    const reconciliation = reconcileScholarRuntimeTarget(
      coordinator.runtimeSession.state,
      book,
      coordinator.activeAuthority?.bookId === coordinator.runtimeSession.bookId ? coordinator.activeAuthority.instanceId : undefined,
    );
    if (reconciliation.kind === "invalid") {
      coordinator.deactivateSession();
      coordinator.persistSessionPointer();
      ctx.ui.notify("Scholar stopped because the selected book authority changed or disappeared from this Obsidian vault.", "warning");
      await coordinator.setStatus(ctx);
      return;
    }
    if (!book) return;
    if (reconciliation.kind === "stale") {
      if (coordinator.scholarTurnRun && typeof ctx.abort === "function") void ctx.abort();
      coordinator.runtimeSession.activate(book.id);
      coordinator.persistSessionPointer(book);
      ctx.ui.notify("Scholar paused because the exact Learn, Exam, or Tutor target no longer exists. Select a target again.", "warning");
      await coordinator.setStatus(ctx);
      return;
    }
    if (reconciliation.kind === "selected") return;
    if (reconciliation.kind === "setup") {
      if (coordinator.runtimeSession.mode) {
        coordinator.runtimeSession.activate(book.id);
        coordinator.persistSessionPointer(book);
      }
      if (coordinator.setupRun && (coordinator.setupRun.bookId !== book.id || coordinator.setupRun.instanceId !== book.instanceId)) {
        if (typeof ctx.abort === "function") void ctx.abort();
        coordinator.setupRun.releaseInput();
        coordinator.setupRun = undefined;
        coordinator.toolController.clearOutlineValidation();
      }
      if (!coordinator.setupRun) {
        ctx.ui.notify("Scholar setup is paused. Resume it explicitly by opening this PDF again or requesting a mode.", "warning");
        await coordinator.setStatus(ctx);
        return;
      }
      coordinator.toolController.prepareOutlineValidation(book);
      ctx.ui.setWorkingMessage(`${isProvisionalOutline(book) ? "Validating" : "Preparing"} book outline… Press Esc to stop`);
      await coordinator.setStatus(ctx);
    }
    let instructions: string;
    if (reconciliation.kind === "setup") instructions = setupInstructions(book);
    else if (reconciliation.kind === "active") instructions = modeInstructions(reconciliation.state.kind, book, reconciliation.target);
    else return;
    const title = coordinator.runtimeSession.mode
      ? `${coordinator.runtimeSession.mode[0]!.toUpperCase()}${coordinator.runtimeSession.mode.slice(1)} response`
      : "book setup";
    if (coordinator.runtimeSession.mode) coordinator.ensureScholarTurnInputLock(book, ctx, title);
    return { systemPrompt: `${event.systemPrompt}\n\n${instructions}` };
  });

  pi.on("input", (event, ctx: ExtensionContext) => {
    const busyRun = coordinator.setupRun || coordinator.scholarTurnRun || coordinator.navigationRun;
    if (!busyRun) return;
    if (event.source === "interactive") ctx.ui.setEditorText(event.text);
    if (!busyRun.warned) {
      busyRun.warned = true;
      ctx.ui.notify(
        `Scholar is still working on ${busyRun.title}. Your message was not sent${event.source === "interactive" ? " and remains in the editor" : ""}. Press Esc to interrupt.`,
        "info",
      );
    }
    return { action: "handled" as const };
  });

  pi.on("agent_settled", async (_event, ctx: ExtensionContext) => {
    const releaseInput = coordinator.acquireInputLock(ctx, "syncing");
    try {
      coordinator.scholarTurnRun?.releaseInput();
      coordinator.scholarTurnRun = undefined;
      if (coordinator.runtimeSession.mode && coordinator.runtimeSession.bookId) {
        if (coordinator.activeAuthority) {
          const recoveryTarget = freezeRecoveryTarget(
            coordinator.getConfig().obsidianRoot,
            coordinator.runtimeSession,
            coordinator.activeAuthority,
          );
          if (recoveryTarget) {
            try {
              const outcome = await coordinator.recoverTarget(recoveryTarget, ctx, true);
              if (outcome.kind === "error") {
                ctx.ui.notify(`Scholar transcript recovery encountered an issue: ${outcome.error}`, "warning");
              }
            } catch (error) {
              ctx.ui.notify(`Scholar could not recover transcript: ${error instanceof Error ? error.message : String(error)}`, "warning");
            }
          }
        }
        try {
          const settledModeBook = await loadBookState(coordinator.getConfig(), coordinator.runtimeSession.bookId);
          const reconciliation = reconcileScholarRuntimeTarget(
            coordinator.runtimeSession.state,
            settledModeBook,
            coordinator.activeAuthority?.bookId === coordinator.runtimeSession.bookId ? coordinator.activeAuthority.instanceId : undefined,
          );
          if (reconciliation.kind === "invalid") {
            coordinator.deactivateSession();
            coordinator.persistSessionPointer();
          } else if (
            settledModeBook
            && (reconciliation.kind === "setup" || reconciliation.kind === "stale" || (reconciliation.kind === "active" && reconciliation.terminal))
          ) {
            coordinator.runtimeSession.activate(settledModeBook.id);
            coordinator.persistSessionPointer(settledModeBook);
          }
        } catch (error) {
          coordinator.deactivateSession();
          coordinator.persistSessionPointer();
          ctx.ui.notify(`Scholar could not verify the active navigation target: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
      }
      if (coordinator.isPending()) {
        try {
          await coordinator.renderAll();
        } catch {
          /* pending retry */
        }
      }
      if (!coordinator.setupRun) {
        await coordinator.setStatus(ctx);
        return;
      }
      const completedRun = coordinator.setupRun;
      try {
        const settledBook = coordinator.runtimeSession.bookId ? await loadBookState(coordinator.getConfig(), coordinator.runtimeSession.bookId).catch(() => undefined) : undefined;
        if (settledBook && settledBook.instanceId === completedRun.instanceId && settledBook.outlineStatus !== "ready") {
          ctx.ui.notify(
            `${titleFor(settledBook)} setup paused with outline status ${settledBook.outlineStatus}; Learn, Exam, and Tutor remain locked until validation passes.`,
            "warning",
          );
        }
      } finally {
        completedRun.releaseInput();
        coordinator.setupRun = undefined;
        ctx.ui.setWorkingMessage();
        await coordinator.setStatus(ctx);
      }
    } finally {
      releaseInput();
    }
  });

  pi.on("session_shutdown", (_event, ctx: ExtensionContext) => {
    warningContext = undefined;
    coordinator.scholarTurnRun?.releaseInput();
    coordinator.scholarTurnRun = undefined;
    coordinator.setupRun?.releaseInput();
    coordinator.setupRun = undefined;
    coordinator.navigationRun = undefined;
    coordinator.releaseAllInputLocks();
    coordinator.toolController.resetTransientState();
    ctx.ui.setWorkingMessage();
  });

  pi.on("message_end", async (event, ctx: ExtensionContext) => {
    if (!coordinator.hasConfiguredLibrary() || !coordinator.runtimeSession.active || !coordinator.runtimeSession.bookId || !coordinator.runtimeSession.mode) return;
    if ((event.message as { role?: unknown })?.role !== "assistant") return;
    try {
      const timestamp = (event.message as any)?.timestamp ?? (event as any)?.timestamp;
      const entry = messageTranscriptEntry(event.message, undefined, typeof timestamp === "number" ? new Date(timestamp).toISOString() : typeof timestamp === "string" ? timestamp : undefined);
      if (!entry) return;
      await coordinator.mutateBook(coordinator.runtimeSession.bookId, (book) => {
        if (!coordinator.ownsActiveAuthority(book)) throw new Error("The active book authority changed before this response could be saved.");
        if (coordinator.runtimeSession.mode === "learn") {
          const section = findSection(book, coordinator.runtimeSession.recordId);
          if (section && appendTranscript(section.transcript, entry)) section.updatedAt = new Date().toISOString();
        } else if (coordinator.runtimeSession.mode === "tutor") {
          const tutor = book.tutorSessions.find((item) => item.id === coordinator.runtimeSession.recordId);
          if (tutor && appendTranscript(tutor.transcript, entry)) tutor.updatedAt = new Date().toISOString();
        } else {
          const exam = book.exams.find((item) => item.id === coordinator.runtimeSession.recordId);
          if (exam?.status === "graded" && appendTranscript(exam.transcript, entry)) exam.updatedAt = new Date().toISOString();
        }
      });
    } catch (error) {
      ctx.ui.notify(`Scholar could not save this response to Obsidian: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  });

  pi.on("tool_call", async (event) => {
    if (!coordinator.hasConfiguredLibrary() || !coordinator.runtimeSession.active || !coordinator.runtimeSession.bookId || event.toolName !== SCHOLAR_QUIZ_TOOL_NAME) return;
    if (!modeCan(coordinator.runtimeSession.mode, "assesses")) return;
    const input = parseScholarQuizInput(event.input);
    if (input.question === undefined) return;
    const book = await loadBookState(coordinator.getConfig(), coordinator.runtimeSession.bookId);
    if (!book || !coordinator.ownsActiveAuthority(book)) {
      return { block: true, reason: "Scholar blocked this quiz because the active book no longer exists in the selected Obsidian vault." };
    }
    const section = coordinator.runtimeSession.mode === "learn" ? findSection(book, coordinator.runtimeSession.recordId) : undefined;
    const tutor = coordinator.runtimeSession.mode === "tutor" ? book.tutorSessions.find((item) => item.id === coordinator.runtimeSession.recordId) : undefined;
    try {
      if (coordinator.runtimeSession.mode === "learn") {
        if (!section) throw new Error("Scholar blocked this question before presentation: no Learn section is active.");
        assertQuestionGrounding(input.grounding, book, { mode: "learn", section });
        if (input.grounding.purpose !== "diagnostic") await assertLearnFigureCoverage(coordinator.getConfig(), book, section);
      } else {
        if (!tutor || tutor.status !== "active") throw new Error("Scholar blocked this question before presentation: no Tutor session is active.");
        assertQuestionGrounding(input.grounding, book, { mode: "tutor", tutor });
      }
    } catch (error) {
      return { block: true, reason: error instanceof Error ? error.message : String(error) };
    }
    try {
      await coordinator.mutateBook(coordinator.runtimeSession.bookId, async (targetBook) => {
        if (!coordinator.ownsActiveAuthority(targetBook)) throw new Error("Scholar blocked this question because the active book authority changed.");
        const currentSection = coordinator.runtimeSession.mode === "learn" ? findSection(targetBook, coordinator.runtimeSession.recordId) : undefined;
        const currentTutor = coordinator.runtimeSession.mode === "tutor" ? targetBook.tutorSessions.find((item) => item.id === coordinator.runtimeSession.recordId) : undefined;
        if (coordinator.runtimeSession.mode === "learn") {
          if (!currentSection) throw new Error("Scholar blocked this question before presentation: no Learn section is active.");
          assertQuestionGrounding(input.grounding, targetBook, { mode: "learn", section: currentSection });
          if (input.grounding.purpose !== "diagnostic") await assertLearnFigureCoverage(coordinator.getConfig(), targetBook, currentSection);
        } else {
          if (!currentTutor || currentTutor.status !== "active") throw new Error("Scholar blocked this question before presentation: no Tutor session is active.");
          assertQuestionGrounding(input.grounding, targetBook, { mode: "tutor", tutor: currentTutor });
        }
        const attempts = currentSection?.attempts || currentTutor?.attempts;
        if (!attempts || attempts.some((item) => item.toolCallId === event.toolCallId)) return;
        attempts.push({
          id: `quiz-${event.toolCallId}`,
          toolCallId: event.toolCallId,
          kind: input.grounding!.purpose === "diagnostic" ? "quiz" : quizKind(input.details, input.difficulty, currentSection),
          format: "multiple-choice",
          question: input.question,
          mode: input.multiSelect === true ? "multi-select" : "single-select",
          ...(typeof input.difficulty === "string" ? { difficulty: input.difficulty } : {}),
          grounding: input.grounding!,
          outcome: "pending",
          createdAt: new Date().toISOString(),
        });
        if (currentSection) {
          if (currentSection.status === "not-started") currentSection.status = "learning";
          currentSection.updatedAt = new Date().toISOString();
        }
        if (currentTutor) currentTutor.updatedAt = new Date().toISOString();
      });
    } catch (error) {
      return { block: true, reason: error instanceof Error ? error.message : String(error) };
    }
  });

  pi.on("tool_execution_update", async (event) => {
    if (!coordinator.hasConfiguredLibrary() || !coordinator.runtimeSession.active || !coordinator.runtimeSession.bookId || event.toolName !== SCHOLAR_QUIZ_TOOL_NAME) return;
    if (!modeCan(coordinator.runtimeSession.mode, "assesses")) return;
    const partial = event.partialResult as { details?: unknown } | undefined;
    const details = parseScholarQuizDetails(partial?.details);
    if (!details.options) return;
    const options = details.options.map((option) => option.label);
    await coordinator.mutateBook(coordinator.runtimeSession.bookId, (book) => {
      if (!coordinator.ownsActiveAuthority(book)) throw new Error("The active book authority changed while saving this quiz.");
      const found = coordinator.runtimeSession.mode === "learn"
        ? findQuizAttempt(book, coordinator.runtimeSession.recordId, event.toolCallId)
        : findTutorQuizAttempt(book, coordinator.runtimeSession.recordId, event.toolCallId);
      if (!found || found.attempt.outcome !== "pending") return;
      found.attempt.options = options;
      const transcript = "section" in found ? found.section.transcript : found.tutor.transcript;
      appendTranscript(transcript, {
        id: `quiz-question-${event.toolCallId}`,
        kind: "question",
        markdown: [`**${found.attempt.question}**`, "", ...options.map((option, index) => `${index + 1}. ${option}`)].join("\n"),
        createdAt: new Date().toISOString(),
      });
      if ("section" in found) found.section.updatedAt = new Date().toISOString();
      else found.tutor.updatedAt = new Date().toISOString();
    });
  });

  pi.on("tool_result", async (event) => {
    if (!coordinator.hasConfiguredLibrary() || !coordinator.runtimeSession.active || !coordinator.runtimeSession.bookId || event.toolName !== SCHOLAR_QUIZ_TOOL_NAME) return;
    if (!modeCan(coordinator.runtimeSession.mode, "assesses")) return;
    const details = parseScholarQuizDetails(event.details);
    await coordinator.mutateBook(coordinator.runtimeSession.bookId, (book) => {
      if (!coordinator.ownsActiveAuthority(book)) throw new Error("The active book authority changed while saving this quiz.");
      const found = coordinator.runtimeSession.mode === "learn"
        ? findQuizAttempt(book, coordinator.runtimeSession.recordId, event.toolCallId)
        : findTutorQuizAttempt(book, coordinator.runtimeSession.recordId, event.toolCallId);
      // Recovery and live delivery may race. A finalized answer is immutable;
      // repeated or late tool events must not change the recorded outcome.
      if (!found || found.attempt.outcome !== "pending") return;
      const attempt = found.attempt;
      if (details.options) attempt.options = details.options.map((option) => option.label);
      attempt.outcome = details.status === "cancelled" ? "cancelled"
        : details.status === "unavailable" || (event as { isError?: unknown }).isError === true ? "unavailable"
        : details.dontKnow === true ? "unsure"
        : details.correct === true ? "pass" : "review";
      if (details.mode === "single-select" || details.mode === "multi-select") attempt.mode = details.mode;
      const answered = details.status === "answered" && attempt.outcome !== "unavailable";
      attempt.correctAnswer = answered ? scholarQuizCorrectAnswer(details, attempt.options) : undefined;
      const feedback: string[] = [];
      if (answered && typeof details.explanation === "string" && details.explanation.trim()) feedback.push(details.explanation.trim());
      if (attempt.outcome === "unavailable" && typeof details.message === "string" && details.message.trim()) feedback.push(details.message.trim());
      attempt.feedback = feedback.join(" ") || undefined;
      const transcript = "section" in found ? found.section.transcript : found.tutor.transcript;
      appendTranscript(transcript, {
        id: `quiz-result-${event.toolCallId}`,
        kind: "result",
        markdown: `**Outcome:** ${attempt.outcome === "pass" ? "Correct" : attempt.outcome === "unsure" ? "Knowledge gap identified" : attempt.outcome === "review" ? "Needs review" : attempt.outcome}. ${attempt.correctAnswer ? `Correct answer: ${attempt.correctAnswer}. ` : ""}${attempt.feedback || ""}`.trim(),
        createdAt: new Date().toISOString(),
      });
      if ("section" in found) recomputeProgress(book, found.section);
      else found.tutor.updatedAt = new Date().toISOString();
    });
  });

  pi.registerCommand("scholar", {
    description: "Select a PDF book and explicitly start isolated Learn, Exam, or Tutor mode",
    getArgumentCompletions: async (prefix) =>
      getScholarArgumentCompletions(
        prefix,
        async () => (coordinator.setupRun || coordinator.scholarTurnRun ? coordinator.getConfig() : coordinator.loadFreshConfig()),
        coordinator.runtimeSession.bookId || coordinator.getConfig().currentBookId,
      ),
    handler: (args: string, ctx: ExtensionCommandContext) => {
      warningContext = ctx;
      return handleScholarCommand(args, ctx, coordinator);
    },
  });
}
