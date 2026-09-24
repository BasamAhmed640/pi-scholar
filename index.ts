import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { getScholarArgumentCompletions } from "./command-syntax.ts";
import { handleScholarCommand } from "./commands.ts";
import {
  appendTranscript,
  answeredQuickQuestions,
  applyQuizAnswer,
  assertShortQuestion,
  findQuizSet,
  findSection,
  messageTranscriptEntry,
  learnQuestionGrounding,
  quizKind,
  QUICK_QUESTIONS,
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
  scholarQuizInputItems,
  SCHOLAR_QUIZ_TOOL_NAME,
} from "./quiz-contract.ts";
import { createScholarInputLockController } from "./input-lock.ts";
import { createScholarToolController } from "./tool-controller.ts";
import { isProvisionalOutline } from "./outline-validation.ts";
import { lessonPreparationPending } from "./lesson.ts";
import { LEARN_PREPARATION_MESSAGE } from "./tool-actions/learning.ts";
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
    onLoadingActivity: (action, ctx, signal) => coordinator.loadingActivity(action, ctx, signal),
    onReviewProgress: (event, total) => coordinator.loadingReview(event, total),
    onReviewOutcome: message => coordinator.loadingReviewOutcome(message),
    inputContext: ctx => coordinator.loading.inputContext(ctx),
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
    coordinator.loading.bindSignal(ctx.signal);
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

  pi.on("agent_end", (event) => {
    if (!coordinator.loading.active) return;
    const last = [...event.messages].reverse().find(message => message.role === "assistant");
    coordinator.loadingFailed = last?.role === "assistant" && ["error", "aborted", "length"].includes(last.stopReason);
    if (coordinator.loadingFailed && !coordinator.loadingProblem && last?.role === "assistant") coordinator.loadingProblem = last.stopReason === "aborted" ? "Interrupted · saved work preserved"
      : last.stopReason === "length" ? "Response reached its output limit · saved work preserved" : "Model connection failed · saved work preserved";
  });

  pi.on("message_update", () => coordinator.loadingModelActivity());
  pi.on("tool_execution_start", () => coordinator.loading.activity());
  pi.on("tool_execution_end", () => coordinator.loading.activity());

  pi.on("agent_settled", async (_event, ctx: ExtensionContext) => {
    // Idle time between turns does not spend the preparation budget. This never clears a stop.
    coordinator.toolController.endAgentTurn();
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
      await coordinator.finishLoading();
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
        // A Learn section's durable record comes only from explicit lesson writes and
        // shown questions. Ambient narration during a section load must never be
        // journaled into the lesson; Tutor and Exam keep their existing recording.
        if (coordinator.runtimeSession.mode === "tutor") {
          const tutor = book.tutorSessions.find((item) => item.id === coordinator.runtimeSession.recordId);
          if (tutor?.lessonEntryIds?.length || tutor?.transcript.some(item => item.lesson)) return;
          if (tutor && appendTranscript(tutor.transcript, entry)) tutor.updatedAt = new Date().toISOString();
        } else if (coordinator.runtimeSession.mode === "exam") {
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
    if (!modeCan(coordinator.runtimeSession.mode, "interactiveQuestions")) return;
    let rawItems: unknown[];
    try { rawItems = scholarQuizInputItems(event.input); }
    catch (error) { return { block: true, reason: error instanceof Error ? error.message : String(error) }; }
    const input = parseScholarQuizInput(event.input);
    const inputs = rawItems.map(parseScholarQuizInput);
    if (!inputs.length && !input.resumeAttemptId) return;
    if (input.resumeAttemptId && (typeof event.input !== "object" || event.input === null
      || Object.keys(event.input).some((key) => key !== "resumeAttemptId"))) {
      return { block: true, reason: "Supply only resumeAttemptId to reopen the frozen pending set." };
    }
    const book = await loadBookState(coordinator.getConfig(), coordinator.runtimeSession.bookId);
    if (!book || !coordinator.ownsActiveAuthority(book)) {
      return { block: true, reason: "Scholar blocked this quiz because the active book no longer exists in the selected Obsidian vault." };
    }
    const section = coordinator.runtimeSession.mode === "learn" ? findSection(book, coordinator.runtimeSession.recordId) : undefined;
    const tutor = coordinator.runtimeSession.mode === "tutor" ? book.tutorSessions.find((item) => item.id === coordinator.runtimeSession.recordId) : undefined;
    // A section whose lesson is still being prepared never asks the learner anything,
    // including resuming an older question; preparation finishes on its own first.
    if (section && lessonPreparationPending(section, book.source.fingerprint.sha256)) {
      return { block: true, reason: LEARN_PREPARATION_MESSAGE };
    }
    if (input.resumeAttemptId) {
      try {
        await coordinator.mutateBook(book.id, (state) => {
          if (!coordinator.ownsActiveAuthority(state)) throw new Error("The active Scholar book changed.");
          const target = coordinator.runtimeSession.mode === "learn" ? findSection(state, coordinator.runtimeSession.recordId)
            : state.tutorSessions.find((item) => item.id === coordinator.runtimeSession.recordId && item.status === "active");
          const first = target && unansweredQuestion(target.attempts);
          if (!first || first.id !== input.resumeAttemptId || !first.quiz) throw new Error("Resume the first unanswered multiple-choice question in the active record; answered questions cannot be regraded.");
          const pending = first.quizSet
            ? target!.attempts.filter((attempt) => attempt.quizSet?.id === first.quizSet!.id && attempt.outcome === "pending")
            : [first];
          const prior = findQuizSet(state, coordinator.runtimeSession.mode as "learn" | "tutor", target!.id, event.toolCallId);
          if (prior && prior.attempts.some((attempt) => !pending.includes(attempt))) throw new Error("Quiz delivery ID is already in use.");
          for (const attempt of pending) {
            if (!attempt.quiz) throw new Error("A pending quiz item has no saved form.");
            if (coordinator.runtimeSession.mode === "learn") {
              const current = findSection(state, target!.id)!;
              attempt.grounding = learnQuestionGrounding(current, attempt.grounding!);
              assertQuestionGrounding(attempt.grounding, state, { mode: "learn", section: current }, { resume: true });
            } else {
              assertQuestionGrounding(attempt.grounding, state, { mode: "tutor", tutor: state.tutorSessions.find((item) => item.id === target!.id)! }, { resume: true });
            }
            if (attempt.toolCallId !== event.toolCallId && !attempt.resumeToolCallIds?.includes(event.toolCallId)) {
              (attempt.resumeToolCallIds ||= []).push(event.toolCallId);
            }
          }
        });
        return;
      } catch (error) { return { block: true, reason: error instanceof Error ? error.message : String(error) }; }
    }
    try {
      const pending = unansweredQuestion(section?.attempts || tutor?.attempts || []);
      if (pending && pending.toolCallId !== event.toolCallId) throw new Error(unansweredQuestionMessage([pending]));
      for (const item of inputs) {
        assertShortQuestion(item.question);
        if (coordinator.runtimeSession.mode === "learn") {
          if (!section) throw new Error("Scholar blocked this question before presentation: no Learn section is active.");
          if (item.grounding) item.grounding = learnQuestionGrounding(section, item.grounding);
          assertQuestionGrounding(item.grounding, book, { mode: "learn", section });
          if (item.grounding.purpose === "mastery" && item.grounding.basis.filter(basis => basis.kind === "objective").length !== 1) throw new Error("A mastery multiple-choice question must assess one focused objective. Use separate probes or an open multi-step question for multiple competencies.");
        } else {
          if (!tutor || tutor.status !== "active") throw new Error("Scholar blocked this question before presentation: no Tutor session is active.");
          assertQuestionGrounding(item.grounding, book, { mode: "tutor", tutor });
        }
      }
      if (section) {
        if (inputs.some((item) => item.grounding?.purpose === "mastery")
          && inputs.length > Math.max(0, QUICK_QUESTIONS - answeredQuickQuestions(section))) throw new Error("This mastery set exceeds the remaining five-question allowance for this Learn section.");
        if (inputs.some((item) => item.grounding?.purpose !== "diagnostic")) await assertLearnFigureCoverage(coordinator.getConfig(), book, section);
      }
    } catch (error) {
      return { block: true, reason: error instanceof Error ? error.message : String(error) };
    }
    try {
      // Invalid forms still receive the quiz tool's field-level error. Only a
      // validated form can be shown or become a resumable unanswered question.
      const frozen = rawItems.map((item) => prepareScholarQuiz(item));
      const targetRecord = coordinator.runtimeSession.mode === "learn" ? section : tutor;
      const needsReview = !!section && inputs.some((item) => item.grounding?.purpose === "mastery");
      const verifyReview = targetRecord && needsReview && !targetRecord.attempts.some(item => item.toolCallId === event.toolCallId)
        ? await toolController.reviewQuestion(book, targetRecord,
          frozen.map((quiz, index) => ({ quiz, grounding: inputs[index]!.grounding, kind: inputs[index]!.kind, difficulty: inputs[index]!.difficulty })),
          [...new Set(inputs.flatMap((item) => item.grounding?.sourcePages || []))], ctx)
        : undefined;
      await coordinator.mutateBook(coordinator.runtimeSession.bookId, async (targetBook) => {
        if (!coordinator.ownsActiveAuthority(targetBook)) throw new Error("Scholar blocked this question because the active book authority changed.");
        const currentSection = coordinator.runtimeSession.mode === "learn" ? findSection(targetBook, coordinator.runtimeSession.recordId) : undefined;
        const currentTutor = coordinator.runtimeSession.mode === "tutor" ? targetBook.tutorSessions.find((item) => item.id === coordinator.runtimeSession.recordId) : undefined;
        if (coordinator.runtimeSession.mode === "learn") {
          if (!currentSection) throw new Error("Scholar blocked this question before presentation: no Learn section is active.");
          for (const item of inputs) {
            if (item.grounding) item.grounding = learnQuestionGrounding(currentSection, item.grounding);
            assertQuestionGrounding(item.grounding, targetBook, { mode: "learn", section: currentSection });
            if (item.grounding.purpose === "mastery" && item.grounding.basis.filter(basis => basis.kind === "objective").length !== 1) throw new Error("A mastery multiple-choice question must assess one focused objective.");
          }
          if (inputs.some((item) => item.grounding?.purpose === "mastery")
            && inputs.length > Math.max(0, QUICK_QUESTIONS - answeredQuickQuestions(currentSection))) throw new Error("This mastery set exceeds the remaining five-question allowance for this Learn section.");
          if (inputs.some((item) => item.grounding?.purpose !== "diagnostic")) await assertLearnFigureCoverage(coordinator.getConfig(), targetBook, currentSection);
          verifyReview?.(currentSection);
        } else {
          if (!currentTutor || currentTutor.status !== "active") throw new Error("Scholar blocked this question before presentation: no Tutor session is active.");
          for (const item of inputs) assertQuestionGrounding(item.grounding, targetBook, { mode: "tutor", tutor: currentTutor });
        }
        const attempts = currentSection?.attempts || currentTutor?.attempts;
        if (!attempts) throw new Error("The Scholar question target disappeared.");
        const ids = inputs.map((_, index) => `quiz-${event.toolCallId}${index ? `-${index + 1}` : ""}`);
        if (attempts.some((item) => item.toolCallId === event.toolCallId)) {
          if (ids.every((id) => attempts.some((item) => item.id === id && item.toolCallId === event.toolCallId))) return;
          throw new Error("Quiz delivery ID is already in use.");
        }
        if (ids.some((id) => attempts.some((item) => item.id === id))) throw new Error("Quiz attempt ID is already in use.");
        const pending = unansweredQuestion(attempts);
        if (pending) throw new Error(unansweredQuestionMessage([pending]));
        attempts.push(...frozen.map((quiz, index) => ({
          id: ids[index]!, toolCallId: event.toolCallId,
          quizSet: { id: event.toolCallId, index: index + 1, size: frozen.length },
          kind: inputs[index]!.grounding!.purpose === "diagnostic" ? "quiz" : quizKind(inputs[index]!.details, inputs[index]!.difficulty, currentSection, inputs[index]!.kind),
          format: "multiple-choice" as const,
          question: quiz.question, quiz, options: quiz.options.map((option) => option.label),
          mode: quiz.mode,
          ...(typeof inputs[index]!.difficulty === "string" ? { difficulty: inputs[index]!.difficulty } : {}),
          grounding: inputs[index]!.grounding!, outcome: "pending" as const,
          createdAt: new Date().toISOString(),
        })));
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
    if (!modeCan(coordinator.runtimeSession.mode, "interactiveQuestions")) return;
    const partial = event.partialResult as { details?: unknown } | undefined;
    const details = parseScholarQuizDetails(partial?.details);
    if (!details.options) return;
    const options = details.options.map((option) => option.label);
    await coordinator.mutateBook(coordinator.runtimeSession.bookId, (book) => {
      if (!coordinator.ownsActiveAuthority(book)) throw new Error("The active book authority changed while saving this quiz.");
      const found = findQuizSet(book, coordinator.runtimeSession.mode as "learn" | "tutor", coordinator.runtimeSession.recordId, event.toolCallId);
      const attempt = found?.attempts.find((item) => item.id === details.attemptId)
        || found?.attempts.find((item) => item.outcome === "pending");
      if (!found || !attempt || attempt.outcome !== "pending") return;
      if (attempt.quiz && JSON.stringify(options) !== JSON.stringify(attempt.quiz.options.map((item) => item.label))) return;
      attempt.options = options;
      const transcript = found.record.transcript;
      appendTranscript(transcript, {
        id: `quiz-question-${attempt.id.slice("quiz-".length)}`,
        kind: "question",
        markdown: [`**${attempt.question}**`, "", ...options.map((option, index) => `${index + 1}. ${option}`)].join("\n"),
        createdAt: new Date().toISOString(),
      });
      found.record.updatedAt = new Date().toISOString();
    });
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!coordinator.hasConfiguredLibrary() || !coordinator.runtimeSession.active || !coordinator.runtimeSession.bookId || event.toolName !== SCHOLAR_QUIZ_TOOL_NAME) return;
    if (!modeCan(coordinator.runtimeSession.mode, "interactiveQuestions")) return;
    if (!coordinator.loading.active) coordinator.startFeedbackLoading(ctx);
    const details = parseScholarQuizDetails(event.details);
    const mutation = await coordinator.mutateBook(coordinator.runtimeSession.bookId, (book) => {
      if (!coordinator.ownsActiveAuthority(book)) throw new Error("The active book authority changed while saving this quiz.");
      const found = findQuizSet(book, coordinator.runtimeSession.mode as "learn" | "tutor", coordinator.runtimeSession.recordId, event.toolCallId);
      if (!found) return;
      const results = details.itemResults?.length ? details.itemResults : [details];
      for (const result of results) {
        const attempt = result.attemptId
          ? found.attempts.find((item) => item.id === result.attemptId)
          : found.attempts.length === 1 ? found.attempts[0] : undefined;
        if (attempt) applyQuizAnswer(book, found.record, attempt, result, (event as { isError?: unknown }).isError === true);
      }
    });
    const section = coordinator.runtimeSession.mode === "learn"
      ? findSection(mutation.book, coordinator.runtimeSession.recordId) : undefined;
    const delivered = findQuizSet(mutation.book, coordinator.runtimeSession.mode as "learn" | "tutor", coordinator.runtimeSession.recordId, event.toolCallId);
    const paused = !!delivered?.attempts.some((attempt) => attempt.outcome === "pending");
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
