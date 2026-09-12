import {
  appendTranscript,
  compactStrings,
  firstIncomplete,
  learnQuestionGrounding,
  recomputeProgress,
  requiredChecks,
  sectionLabel,
  sectionProgressMessage,
  unansweredQuestionMessage,
} from "../domain.ts";
import { assertQuestionGrounding, normalizeQuestionGrounding } from "../question-grounding.ts";
import { prepareOpenAssessment, type OpenAssessmentEvaluation, type OpenResponseGate } from "../open-assessment.ts";
import type { ScholarRuntimeSession } from "../runtime-session.ts";
import type { ToolDetails } from "../tool-contract.ts";
import { saveLesson, commitLesson, validLessonEntries, isObjectiveChecks, type LessonInput, type ObjectiveCheck } from "../lesson.ts";
import type { ScholarConfig } from "../types.ts";
import {
  findSection,
  type AssessmentAttempt,
  type AssessmentKind,
  type AssessmentOutcome,
  type QuestionGrounding,
  type ScholarBook,
  type ScholarSection,
  type TutorSession,
} from "../types.ts";

/** The stored schema's own vocabularies, checked here so a rejection names the field. */
const ASSESSMENT_KINDS: AssessmentKind[] = ["conceptual", "application", "computation", "discrimination", "quiz"];
const RESOLUTION_OUTCOMES: AssessmentOutcome[] = ["pass", "review", "unsure", "cancelled"];

type MutateBook = <T>(
  bookId: string,
  mutate: (book: ScholarBook) => Promise<T> | T,
) => Promise<{ book: ScholarBook; result: T }>;

type ToolResultFn = (
  action: string,
  summary: string,
  details?: Partial<ToolDetails>,
) => { content: Array<{ type: "text"; text: string }>; details: ToolDetails };

export async function handleNotes(
  book: ScholarBook,
  session: ScholarRuntimeSession,
  params: {
    synthesis?: string;
    keyPoints?: string[];
    sectionId?: string;
    objectives?: string[];
    coveredObjectives?: string[];
    requiredChecks?: AssessmentKind[];
    misconceptions?: string[];
    lesson?: LessonInput;
    lessonComplete?: boolean;
    objectiveChecks?: ObjectiveCheck[];
  },
  requireLearnSection: (book: ScholarBook) => ScholarSection,
  mutateBook: MutateBook,
  toolResult: ToolResultFn,
  config?: ScholarConfig,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: ToolDetails }> {
  const synthesis = params.synthesis?.trim();
  const keyPoints = compactStrings(params.keyPoints);
  if (!params.lesson && !params.lessonComplete && (!synthesis || synthesis.length < 40 || keyPoints.length === 0)) {
    throw new Error("Scholar notes require a substantive synthesis and at least one key point.");
  }
  if (session.mode === "tutor") {
    if (!session.recordId) throw new Error("No Tutor session is active.");
    const mutation = await mutateBook(book.id, (state) => {
      const tutor = state.tutorSessions.find((item) => item.id === session.recordId);
      if (!tutor || tutor.status !== "active") throw new Error("The active Tutor session is missing or closed.");
      if (synthesis) tutor.synthesis = synthesis;
      tutor.keyPoints = compactStrings([...tutor.keyPoints, ...keyPoints, ...(params.lesson?.keyPoints || [])]);
      if (params.lesson) saveLesson(tutor, state, params.lesson, config);
      tutor.updatedAt = new Date().toISOString();
    });
    return toolResult("notes", `Saved source-grounded Tutor notes for ${mutation.book.tutorSessions.find((item) => item.id === session.recordId)?.title}.`, { bookId: book.id });
  }
  const activeSection = requireLearnSection(book);
  const sectionId = params.sectionId || activeSection.id;
  if (sectionId !== activeSection.id) throw new Error("Scholar Learn notes must target the frozen Learn section.");
  const objectives = params.objectives === undefined ? activeSection.objectives : compactStrings(params.objectives);
  const covered = compactStrings(params.coveredObjectives);
  if (objectives.length === 0) throw new Error("Scholar Learn notes require at least one source-grounded objective.");
  const unknownCovered = covered.filter((objective) => !objectives.includes(objective));
  if (unknownCovered.length) throw new Error(`Covered objectives must exactly match declared objectives: ${unknownCovered.join("; ")}`);
  const mutation = await mutateBook(book.id, (state) => {
    const section = findSection(state, sectionId);
    if (!section) throw new Error(`Unknown Scholar section: ${sectionId}`);
    const sameMembers = (left: string[], right: string[]) => left.length === right.length && left.every((value) => right.includes(value));
    if (section.status === "complete" && (
      !sameMembers(objectives, section.objectives)
      || (params.coveredObjectives !== undefined && !sameMembers(covered, section.coveredObjectives))
      || (params.requiredChecks !== undefined && !sameMembers(requiredChecks(params.requiredChecks), requiredChecks(section.requiredChecks)))
    )) {
      throw new Error("This section is complete; practice cannot change its earned objective coverage or required checks. Keep those fields unchanged when saving practice notes.");
    }
    // Completion requires covering every declared objective, so a shrinking
    // declaration would certify the section by lowering the bar: declare five,
    // teach one, redeclare that one, complete. Once teaching has begun the
    // declared set may grow but never lose or reword an entry — grounding
    // receipts also cite these strings verbatim, so a rewrite would silently
    // invalidate the basis of every question already asked.
    const retired = section.objectives.filter((objective) => !objectives.includes(objective));
    if (section.status !== "not-started" && retired.length > 0) {
      throw new Error(
        `Scholar Learn objectives are fixed once teaching begins, and completion requires covering all of them. `
        + `This call drops ${retired.length} already-declared objective(s): ${retired.join("; ")}. `
        + `Include them again — add to coveredObjectives as you teach them. To state one more clearly, keep the original text and append the clearer version as a new objective.`,
      );
    }
    section.objectives = objectives;
    if (params.objectiveChecks !== undefined) {
      if (!isObjectiveChecks(params.objectiveChecks) || params.objectiveChecks.some(item => !objectives.includes(item.objective))) throw new Error("objectiveChecks must map declared objectives to nonempty conceptual/application/computation/discrimination checks.");
      const changed = (section.objectiveChecks || []).some(old => !params.objectiveChecks!.some(next => next.objective === old.objective && old.checks.every(kind => next.checks.includes(kind))));
      if (changed) throw new Error("Keep existing objective checks; do not lower the mastery requirements after teaching starts.");
      if (section.status === "complete" && JSON.stringify(params.objectiveChecks) !== JSON.stringify(section.objectiveChecks)) throw new Error("Practice cannot change the completed section's objective checks.");
      section.objectiveChecks = params.objectiveChecks;
    }
    const checks = params.requiredChecks === undefined
      ? requiredChecks(section.requiredChecks) : requiredChecks(params.requiredChecks);
    const droppedChecks = section.requiredChecks.filter((kind) => !checks.includes(kind));
    if (section.status !== "not-started" && droppedChecks.length > 0) {
      throw new Error(`Scholar Learn checks are fixed once teaching begins. Keep these required checks: ${droppedChecks.join(", ")}.`);
    }
    section.requiredChecks = requiredChecks([...checks, ...(section.objectiveChecks || []).flatMap(item => item.checks)]);
    if (synthesis) section.synthesis = synthesis;
    section.keyPoints = compactStrings([...section.keyPoints, ...keyPoints, ...(params.lesson?.keyPoints || [])]);
    if (params.misconceptions !== undefined) section.misconceptions = compactStrings(params.misconceptions);
    if (params.lesson) saveLesson(section, state, params.lesson, config);
    const taught = compactStrings(validLessonEntries(section, state.source.fingerprint.sha256).flatMap(entry => entry.lesson!.objectives));
    if (params.coveredObjectives !== undefined && covered.some(objective => !taught.includes(objective)) && section.status !== "complete") {
      throw new Error("Coverage needs an explicitly saved explanation for each objective; a summary or label cannot mark it taught. Save notes.lesson first.");
    }
    if (section.status !== "complete") section.coveredObjectives = taught;
    if (params.lessonComplete) commitLesson(section, state);
    recomputeProgress(state, section);
  });
  const section = findSection(mutation.book, sectionId)!;
  return toolResult("notes", `Saved ${params.lesson ? "instructional explanation" : "notes"} for ${sectionLabel(mutation.book, section)}.${params.lessonComplete ? " Full lesson committed." : ""} Status: ${section.status}. ${sectionProgressMessage(section)}`, { bookId: book.id, sectionId });
}

export async function handleAssess(
  book: ScholarBook,
  session: ScholarRuntimeSession,
  toolCallId: string,
  params: {
    outcome?: AssessmentOutcome | string;
    attemptId?: string;
    kind?: string;
    question?: string;
    format?: string;
    difficulty?: string;
    grounding?: QuestionGrounding;
    sectionId?: string;
    feedback?: string;
    expectedAnswer?: string;
    criteria?: string[];
    evaluation?: OpenAssessmentEvaluation;
  },
  requireLearnSection: (book: ScholarBook) => ScholarSection,
  mutateBook: MutateBook,
  toolResult: ToolResultFn,
  responseGate?: OpenResponseGate,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: ToolDetails }> {
  const outcome = params.outcome as AssessmentOutcome | undefined;
  const attemptId = params.attemptId?.trim();

  if (!attemptId) {
    if (outcome !== "pending" || !params.kind || !params.question?.trim() || !params.grounding) {
      throw new Error("Prepare an open question before showing it: call Scholar assess with outcome=pending, kind, question, grounding, expectedAnswer, and criteria.");
    }
    if (params.format && params.format !== "open") throw new Error("Scholar's two-phase assess path is for open-response questions only.");
    // Validate the enums the stored schema will insist on. Letting an unknown
    // value through only moves the failure to the atomic write, where the
    // message names the whole book instead of the field.
    if (params.grounding?.purpose !== "diagnostic" && !ASSESSMENT_KINDS.includes(params.kind as AssessmentKind)) {
      throw new Error(`Scholar assess kind must be one of ${ASSESSMENT_KINDS.join(", ")}; received ${JSON.stringify(params.kind)}.`);
    }

    const question = params.question.trim();
    const openAssessment = prepareOpenAssessment(params.expectedAnswer, params.criteria);
    let grounding = normalizeQuestionGrounding(params.grounding) as QuestionGrounding;
    const preparedId = `assessment-${toolCallId}`;
    const now = new Date().toISOString();
    let sectionId: string | undefined;
    if (session.mode === "tutor") {
      if (!session.recordId) throw new Error("No Tutor session is active.");
      const tutor = book.tutorSessions.find((item) => item.id === session.recordId);
      if (!tutor || tutor.status !== "active") throw new Error("The active Tutor session is missing or closed.");
      assertQuestionGrounding(grounding, book, { mode: "tutor", tutor });
    } else {
      const section = requireLearnSection(book);
      grounding = learnQuestionGrounding(section, grounding);
      sectionId = params.sectionId || section.id;
      if (sectionId !== section.id) throw new Error("Scholar Learn assessment must target the frozen Learn section.");
      assertQuestionGrounding(grounding, book, { mode: "learn", section });
    }

    const attempt: AssessmentAttempt = {
      id: preparedId,
      toolCallId,
      kind: grounding.purpose === "diagnostic" ? "quiz" : params.kind as AssessmentKind,
      format: "open",
      question,
      ...(params.difficulty?.trim() ? { difficulty: params.difficulty.trim() } : {}),
      grounding,
      openAssessment,
      outcome: "pending",
      createdAt: now,
    };

    await mutateBook(book.id, (state) => {
      const target = session.mode === "tutor"
        ? state.tutorSessions.find((item) => item.id === session.recordId && item.status === "active")
        : findSection(state, sectionId);
      if (!target) throw new Error(`The active ${session.mode} record changed while Scholar prepared the question.`);
      if (session.mode === "learn") {
        if (sectionId !== session.recordId) throw new Error("The frozen Learn target changed while Scholar prepared the question.");
        grounding = learnQuestionGrounding(target as ScholarSection, grounding);
        attempt.grounding = grounding;
        assertQuestionGrounding(grounding, state, { mode: "learn", section: target as ScholarSection });
      } else {
        assertQuestionGrounding(grounding, state, { mode: "tutor", tutor: target as TutorSession });
      }
      const pending = unansweredQuestionMessage(target.attempts);
      if (pending) throw new Error(`Resolve or cancel the existing open question, or resume the saved quiz, before preparing another. ${pending}`);
      target.attempts.push(attempt);
      appendTranscript(target.transcript, {
        id: `open-question-${preparedId}`,
        kind: "question",
        markdown: `**${question}**`,
        createdAt: now,
      });
      target.updatedAt = now;
      if ("status" in target && session.mode === "learn" && target.status === "not-started") target.status = "learning";
    });

    return {
      content: [{ type: "text" as const, text: `Present this approved question exactly, without answer cues:\n\n${question}` }],
      details: {
        action: "assess",
        summary: `Question approved · ${preparedId}`,
        bookId: book.id,
        ...(sectionId ? { sectionId } : {}),
        attemptId: preparedId,
      } satisfies ToolDetails,
    };
  }

  // Legacy unanswered questions keep their exact prompt; add only the missing
  // pre-answer grading contract, then wait for a fresh response.
  if (outcome === "pending") {
    if (params.question || params.kind || params.grounding || params.difficulty || params.format || params.sectionId || params.feedback || params.evaluation) {
      throw new Error("Upgrade only a legacy pending question's expectedAnswer and criteria; its prompt and grounding cannot change.");
    }
    const contract = prepareOpenAssessment(params.expectedAnswer, params.criteria);
    await mutateBook(book.id, (state) => {
      const target = session.mode === "tutor" ? state.tutorSessions.find((item) => item.id === session.recordId && item.status === "active")
        : findSection(state, session.recordId);
      const attempt = target?.attempts.at(-1);
      if (!attempt || attempt.id !== attemptId || attempt.format !== "open" || attempt.outcome !== "pending") throw new Error(`No pending open question matches ${attemptId}.`);
      if (attempt.openAssessment) throw new Error("This question already has a frozen grading contract; it cannot be replaced.");
      attempt.openAssessment = contract;
      target!.updatedAt = new Date().toISOString();
    });
    responseGate?.clear();
    return toolResult("assess", "Saved the missing grading contract. Present the same unanswered question and wait for the learner's response before grading.", { bookId: book.id, attemptId });
  }

  if (!outcome || !RESOLUTION_OUTCOMES.includes(outcome)) {
    throw new Error(`Resolve a prepared question with one of ${RESOLUTION_OUTCOMES.join(", ")}; received ${JSON.stringify(outcome)}.`);
  }
  if ((outcome === "pass" || outcome === "review" || outcome === "unsure") && !params.feedback?.trim()) {
    throw new Error("A graded open response requires concise evidence-based feedback.");
  }
  if (params.question || params.kind || params.grounding || params.difficulty || params.format || params.sectionId || params.expectedAnswer || params.criteria) {
    throw new Error("A prepared question is immutable. Resolve it using only attemptId, outcome, evaluation, and evidence-based feedback.");
  }

  let sectionId: string | undefined;
  const mutation = await mutateBook(book.id, (state) => {
    const target = session.mode === "tutor"
      ? state.tutorSessions.find((item) => item.id === session.recordId && item.status === "active")
      : findSection(state, session.recordId);
    if (!target) throw new Error(`No active ${session.mode} record can resolve this question.`);
    const attempt = target.attempts.find((item) => item.id === attemptId);
    if (!attempt || attempt.format !== "open" || attempt.outcome !== "pending") {
      throw new Error(`No pending open question matches ${attemptId}.`);
    }
    if (target.attempts.at(-1)?.id !== attemptId) throw new Error("Only the last unanswered question in this note can receive a response.");
    if (outcome === "cancelled") {
      if (!responseGate) throw new Error('Keep the unanswered question pending until the learner explicitly requests cancellation, for example "cancel this question".');
      responseGate.assertCancellation(state, session, attempt);
    }
    if (outcome !== "cancelled") {
      if (!responseGate) throw new Error("No actual learner response is bound to this pending question. Wait for user input before grading.");
      const graded = responseGate.evaluate(state, session, attempt, params.evaluation);
      if (outcome !== graded.outcome && !(outcome === "unsure" && graded.outcome === "review")) {
        throw new Error(`The frozen criterion results require outcome=${graded.outcome}; the requested outcome=${outcome} is inconsistent.`);
      }
      attempt.submission = graded.submission;
      attempt.evaluation = graded.evaluation;
    }
    attempt.outcome = outcome;
    attempt.feedback = params.feedback?.trim() || undefined;
    const now = new Date().toISOString();
    appendTranscript(target.transcript, {
      id: `open-result-${attemptId}`,
      kind: "result",
      markdown: `**Outcome:** ${outcome}. ${attempt.feedback || ""}`.trim(),
      createdAt: now,
    });
    target.updatedAt = now;
    if (session.mode === "learn") {
      sectionId = target.id;
      recomputeProgress(state, target as ScholarSection);
    }
  });
  responseGate?.clear();

  if (session.mode === "tutor") {
    return toolResult("assess", `Tutor practice recorded as ${outcome}. It does not alter Learn completion or Exam evidence.`, { bookId: book.id, attemptId });
  }
  const section = sectionId ? findSection(mutation.book, sectionId) : undefined;
  const completed = section?.status === "complete";
  if (completed && section?.attempts.find((attempt) => attempt.id === attemptId)?.grounding?.purpose === "practice") {
    return toolResult("assess", `Practice recorded as ${outcome}. This section remains complete; earned completion is unchanged.`, { bookId: book.id, sectionId, attemptId });
  }
  const next = completed ? firstIncomplete(mutation.book) : findSection(mutation.book, session.recordId);
  return toolResult("assess", completed
    ? `Section complete. ${next ? `Next section: ${sectionLabel(mutation.book, next)}. Stop this lesson here.` : "All sections in the book are complete."}`
    : `Assessment recorded as ${outcome}. ${sectionId ? sectionProgressMessage(findSection(mutation.book, sectionId)!) : "No Learn section is active."}`,
  { bookId: book.id, ...(sectionId ? { sectionId } : {}), attemptId });
}
