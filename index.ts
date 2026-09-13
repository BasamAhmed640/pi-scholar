import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { getScholarArgumentCompletions } from "./command-syntax.ts";
import { handleScholarCommand } from "./commands.ts";
import {
  appendTranscript,
  findQuizAttempt,
  findSection,
  findTutorQuizAttempt,
  messageTranscriptEntry,
  learnQuestionGrounding,
  quizKind,
  recomputeProgress,
  sectionProgressMessage,
  unansweredQuestion,
  unansweredQuestionMessage,
  titleFor,
} from "./domain.ts";
import { modeCan } from "./modes.ts";
import { prepareScholarQuiz } from "./quiz.ts";
import { assertQuestionGrounding } from "./question-grounding.ts";
import { assertLearnFigureCoverage } from "./figure-coverage.ts";
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
  ScholarRuntimeCoordinator,
  setupInstructions,
} from "./runtime-coordinator.ts";
import { ScholarRuntimeSession, reconcileScholarRuntimeTarget } from "./runtime-session.ts";
import { loadBookState } from "./storage.ts";
import { modeInstructions } from "./policies.ts";
import { freezeRecoveryTarget } from "./transcript-recovery.ts";

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

  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    warningContext = undefined;
    coordinator.resetProjectionWarnings();
    coordinator.releaseAllInputLocks();
    coordinator.setupRun = undefined;
    coordinator.scholarTurnRun = undefined;
    coordinator.navigationRun = undefined;
    coordinator.deactivateSession();
    coordinator.runtimeSession.reset();
    coordinator.toolController.resetTransientState();

    // A resumed Pi conversation stays closed until an explicit Scholar command.
    // Close its old transcript segment so ordinary chat cannot later be recovered
    // into the old lesson (and other extensions do not see stale input ownership).
    const previous = new ScholarRuntimeSession();
    previous.restore(ctx.sessionManager.getBranch());
    if (previous.active) coordinator.persistSessionPointer();
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
    coordinator.toolController.bindOpenResponseTurn(book, event.prompt, event.images);
    if (coordinator.runtimeSession.mode) coordinator.ensureScholarTurnInputLock(book, ctx, title);
    return { systemPrompt: `${event.systemPrompt}\n\n${instructions}` };
  });

  pi.on("input", async (event, ctx: ExtensionContext) => {
    const busyRun = coordinator.setupRun || coordinator.scholarTurnRun || coordinator.navigationRun;
    if (!busyRun) {
      try { await coordinator.toolController.captureOpenResponse(event.text, event.source, event.images); }
      catch (error) { ctx.ui.notify(`Scholar could not bind this response to its saved question: ${error instanceof Error ? error.message : String(error)}`, "warning"); }
      return;
    }
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
    if (!coordinator.runtimeSession.active && !coordinator.setupRun && !coordinator.scholarTurnRun) return;
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
    if (!coordinator.runtimeSession.active && !coordinator.setupRun && !coordinator.scholarTurnRun && !coordinator.navigationRun) return;
    coordinator.scholarTurnRun?.releaseInput();
    coordinator.scholarTurnRun = undefined;
    coordinator.setupRun?.releaseInput();
    coordinator.setupRun = undefined;
    coordinator.navigationRun = undefined;
    coordinator.releaseAllInputLocks();
    coordinator.toolController.resetTransientState();
    coordinator.deactivateSession();
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
          // Explicit lesson writes own the note once adopted. Ambient progress
          // and transport echoes must not become extra instructional content.
          if (section?.lessonEntryIds?.length || section?.transcript.some(item => item.lesson)) return;
          if (section && appendTranscript(section.transcript, entry)) section.updatedAt = new Date().toISOString();
        } else if (coordinator.runtimeSession.mode === "tutor") {
          const tutor = book.tutorSessions.find((item) => item.id === coordinator.runtimeSession.recordId);
          if (tutor?.lessonEntryIds?.length || tutor?.transcript.some(item => item.lesson)) return;
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

  pi.on("tool_call", async (event, ctx) => {
    if (!coordinator.hasConfiguredLibrary() || !coordinator.runtimeSession.active || !coordinator.runtimeSession.bookId || event.toolName !== SCHOLAR_QUIZ_TOOL_NAME) return;
    if (!modeCan(coordinator.runtimeSession.mode, "assesses")) return;
    const input = parseScholarQuizInput(event.input);
    if (input.question === undefined && !input.resumeAttemptId) return;
    const book = await loadBookState(coordinator.getConfig(), coordinator.runtimeSession.bookId);
    if (!book || !coordinator.ownsActiveAuthority(book)) {
      return { block: true, reason: "Scholar blocked this quiz because the active book no longer exists in the selected Obsidian vault." };
    }
    const section = coordinator.runtimeSession.mode === "learn" ? findSection(book, coordinator.runtimeSession.recordId) : undefined;
    const tutor = coordinator.runtimeSession.mode === "tutor" ? book.tutorSessions.find((item) => item.id === coordinator.runtimeSession.recordId) : undefined;
    if (input.resumeAttemptId) {
      try {
        await coordinator.mutateBook(book.id, (state) => {
          if (!coordinator.ownsActiveAuthority(state)) throw new Error("The active Scholar book changed.");
          const target = coordinator.runtimeSession.mode === "learn" ? findSection(state, coordinator.runtimeSession.recordId)
            : state.tutorSessions.find((item) => item.id === coordinator.runtimeSession.recordId && item.status === "active");
          const attempt = target && unansweredQuestion(target.attempts);
          if (!attempt || attempt.id !== input.resumeAttemptId || !attempt.quiz) throw new Error("Resume the unanswered multiple-choice question in the active record; answered questions cannot be regraded.");
          if (coordinator.runtimeSession.mode === "learn") {
            const current = findSection(state, target!.id)!;
            attempt.grounding = learnQuestionGrounding(current, attempt.grounding!);
            assertQuestionGrounding(attempt.grounding, state, { mode: "learn", section: current }, { resume: true });
          } else {
            assertQuestionGrounding(attempt.grounding, state, { mode: "tutor", tutor: state.tutorSessions.find((item) => item.id === target!.id)! }, { resume: true });
          }
          const prior = coordinator.runtimeSession.mode === "learn" ? findQuizAttempt(state, target!.id, event.toolCallId)
            : findTutorQuizAttempt(state, target!.id, event.toolCallId);
          if (prior && prior.attempt.id !== attempt.id) throw new Error("Quiz delivery ID is already in use.");
          if (attempt.toolCallId !== event.toolCallId && !attempt.resumeToolCallIds?.includes(event.toolCallId)) {
            (attempt.resumeToolCallIds ||= []).push(event.toolCallId);
          }
          attempt.outcome = "pending";
        });
        return;
      } catch (error) { return { block: true, reason: error instanceof Error ? error.message : String(error) }; }
    }
    try {
      const pending = unansweredQuestion(section?.attempts || tutor?.attempts || []);
      if (pending && pending.toolCallId !== event.toolCallId) throw new Error(unansweredQuestionMessage([pending]));
      if (coordinator.runtimeSession.mode === "learn") {
        if (!section) throw new Error("Scholar blocked this question before presentation: no Learn section is active.");
        if (input.grounding) input.grounding = learnQuestionGrounding(section, input.grounding);
        assertQuestionGrounding(input.grounding, book, { mode: "learn", section });
        if (input.grounding.purpose === "mastery" && input.grounding.basis.filter(basis => basis.kind === "objective").length !== 1) throw new Error("A mastery multiple-choice question must assess one focused objective. Use separate probes or an open multi-step question for multiple competencies.");
        if (input.grounding.purpose !== "diagnostic") await assertLearnFigureCoverage(coordinator.getConfig(), book, section);
      } else {
        if (!tutor || tutor.status !== "active") throw new Error("Scholar blocked this question before presentation: no Tutor session is active.");
        assertQuestionGrounding(input.grounding, book, { mode: "tutor", tutor });
      }
    } catch (error) {
      return { block: true, reason: error instanceof Error ? error.message : String(error) };
    }
    try {
      // Invalid forms still receive the quiz tool's field-level error. Only a
      // validated form can be shown or become a resumable unanswered question.
      const frozen = prepareScholarQuiz(event.input);
      const verifyReview = section && frozen && !section.attempts.some(item => item.toolCallId === event.toolCallId)
        ? await toolController.reviewQuestion(book, section, { quiz: frozen, grounding: input.grounding, kind: input.kind, difficulty: input.difficulty }, input.grounding!.sourcePages, ctx)
        : undefined;
      await coordinator.mutateBook(coordinator.runtimeSession.bookId, async (targetBook) => {
        if (!coordinator.ownsActiveAuthority(targetBook)) throw new Error("Scholar blocked this question because the active book authority changed.");
        const currentSection = coordinator.runtimeSession.mode === "learn" ? findSection(targetBook, coordinator.runtimeSession.recordId) : undefined;
        const currentTutor = coordinator.runtimeSession.mode === "tutor" ? targetBook.tutorSessions.find((item) => item.id === coordinator.runtimeSession.recordId) : undefined;
        if (coordinator.runtimeSession.mode === "learn") {
          if (!currentSection) throw new Error("Scholar blocked this question before presentation: no Learn section is active.");
          verifyReview?.(currentSection);
          if (input.grounding) input.grounding = learnQuestionGrounding(currentSection, input.grounding);
          assertQuestionGrounding(input.grounding, targetBook, { mode: "learn", section: currentSection });
          if (input.grounding.purpose === "mastery" && input.grounding.basis.filter(basis => basis.kind === "objective").length !== 1) throw new Error("A mastery multiple-choice question must assess one focused objective.");
          if (input.grounding.purpose !== "diagnostic") await assertLearnFigureCoverage(coordinator.getConfig(), targetBook, currentSection);
          verifyReview?.(currentSection);
        } else {
          if (!currentTutor || currentTutor.status !== "active") throw new Error("Scholar blocked this question before presentation: no Tutor session is active.");
          assertQuestionGrounding(input.grounding, targetBook, { mode: "tutor", tutor: currentTutor });
        }
        const attempts = currentSection?.attempts || currentTutor?.attempts;
        if (!attempts || attempts.some((item) => item.toolCallId === event.toolCallId)) return;
        const pending = unansweredQuestion(attempts);
        if (pending) throw new Error(unansweredQuestionMessage([pending]));
        attempts.push({
          id: `quiz-${event.toolCallId}`,
          toolCallId: event.toolCallId,
          kind: input.grounding!.purpose === "diagnostic" ? "quiz" : quizKind(input.details, input.difficulty, currentSection, input.kind),
          format: "multiple-choice",
          question: frozen?.question || input.question!,
          ...(frozen ? { quiz: frozen, options: frozen.options.map((option) => option.label) } : {}),
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
        id: `quiz-question-${found.attempt.toolCallId || event.toolCallId}`,
        kind: "question",
        markdown: [`**${found.attempt.question}**`, "", ...options.map((option, index) => `${index + 1}. ${option}`)].join("\n"),
        createdAt: new Date().toISOString(),
      });
      if ("section" in found) found.section.updatedAt = new Date().toISOString();
      else found.tutor.updatedAt = new Date().toISOString();
    });
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!coordinator.hasConfiguredLibrary() || !coordinator.runtimeSession.active || !coordinator.runtimeSession.bookId || event.toolName !== SCHOLAR_QUIZ_TOOL_NAME) return;
    if (!modeCan(coordinator.runtimeSession.mode, "assesses")) return;
    const details = parseScholarQuizDetails(event.details);
    const mutation = await coordinator.mutateBook(coordinator.runtimeSession.bookId, (book) => {
      if (!coordinator.ownsActiveAuthority(book)) throw new Error("The active book authority changed while saving this quiz.");
      const found = coordinator.runtimeSession.mode === "learn"
        ? findQuizAttempt(book, coordinator.runtimeSession.recordId, event.toolCallId)
        : findTutorQuizAttempt(book, coordinator.runtimeSession.recordId, event.toolCallId);
      // Recovery and live delivery may race. A finalized answer is immutable;
      // repeated or late tool events must not change the recorded outcome.
      if (!found || found.attempt.outcome !== "pending") return;
      const attempt = found.attempt;
      if (attempt.quiz && (details.status !== "answered" || (event as { isError?: unknown }).isError === true)) {
        // Esc, a closed terminal, or unavailable UI leaves the same question
        // pending. No answer or result transcript exists until submission.
        return;
      }
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
        id: `quiz-result-${attempt.toolCallId || event.toolCallId}`,
        kind: "result",
        markdown: `**Outcome:** ${attempt.outcome === "pass" ? "Correct" : attempt.outcome === "unsure" ? "Knowledge gap identified" : attempt.outcome === "review" ? "Needs review" : attempt.outcome}. ${attempt.correctAnswer ? `Correct answer: ${attempt.correctAnswer}. ` : ""}${attempt.feedback || ""}`.trim(),
        createdAt: new Date().toISOString(),
      });
      if ("section" in found) recomputeProgress(book, found.section);
      else found.tutor.updatedAt = new Date().toISOString();
    });
    const section = coordinator.runtimeSession.mode === "learn"
      ? findSection(mutation.book, coordinator.runtimeSession.recordId) : undefined;
    const delivered = coordinator.runtimeSession.mode === "learn"
      ? findQuizAttempt(mutation.book, coordinator.runtimeSession.recordId, event.toolCallId)
      : findTutorQuizAttempt(mutation.book, coordinator.runtimeSession.recordId, event.toolCallId);
    const paused = delivered?.attempt.quiz && delivered.attempt.outcome === "pending"
      && (details.status !== "answered" || (event as { isError?: unknown }).isError === true);
    const pauseMessage = "The unanswered question is saved. End this turn and wait for the learner to reopen Scholar or explicitly continue. Do not reopen the picker or create another question now.";
    if (section) {
      await coordinator.setStatus(ctx);
      return { content: [...(event.content || []), { type: "text" as const, text: (paused ? pauseMessage : sectionProgressMessage(section))
        + (mutation.projectionStatus === "pending" ? " Progress is saved; the Obsidian note update is pending." : "") }] };
    }
    const pending = mutation.book.tutorSessions.find((item) => item.id === coordinator.runtimeSession.recordId);
    if (pending) return { content: [...(event.content || []), { type: "text" as const, text: paused ? pauseMessage : unansweredQuestionMessage(pending.attempts) || "Tutor answer saved." }] };
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
