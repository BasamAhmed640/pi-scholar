import { createHash } from "node:crypto";
import { compactStrings, sectionLabel } from "./domain.ts";
import { answerShapeIssues, CATCH_ALL_OPTION, MAX_RECOGNITION_SHARE, MIN_MCQ_OPTIONS, MIN_RUBRIC_CRITERIA, MIXED_FORM_THRESHOLD, optionIssues } from "./quiz-contract.ts";
import { markdownText } from "./render/common.ts";
import { isExamQuestion } from "./state-schema.ts";
import { findSection, type ExamBreakdown, type ExamItemResult, type ExamQuestion, type ScholarBook, type ScholarExam } from "./types.ts";

const ANSWER_START = "<!-- scholar:answer:";
const ANSWER_END = "<!-- /scholar:answer:";

/** Mirrors state-schema's isStableId so a rejection names its own field. */
const MAX_STABLE_ID = 200;

/** Guidance, not enforcement: a new form aims for about two items per scoped subsection, kept at 4–12. */
export const EXAM_RECOMMENDED_MIN = 4;
export const EXAM_RECOMMENDED_MAX = 12;
/** The only hard length rule, applied when a new form freezes; frozen exams keep their original length. */
export const EXAM_MAX_QUESTIONS = 16;

export function recommendedExamLength(sectionCount: number): number {
  const sections = Number.isFinite(sectionCount) ? Math.max(0, Math.trunc(sectionCount)) : 0;
  return Math.min(EXAM_RECOMMENDED_MAX, Math.max(EXAM_RECOMMENDED_MIN, 2 * sections));
}

/** What a frozen form actually covers, reported back so weak coverage is visible. */
export type ExamBlueprint = {
  questionCount: number;
  totalPoints: number;
  openPoints: number;
  recognitionShare: number;
  sectionsScoped: number;
  sectionsSampled: number;
  dimensions: string[];
  /** The concise length this scope calls for; reported beside the actual count. */
  recommendedLength: number;
};

export function examBlueprint(exam: ScholarExam, questions: ExamQuestion[]): ExamBlueprint {
  const totalPoints = questions.reduce((sum, question) => sum + question.maxPoints, 0);
  const openPoints = questions
    .filter((question) => question.format === "open")
    .reduce((sum, question) => sum + question.maxPoints, 0);
  const sampled = new Set(questions.flatMap((question) => question.sectionIds));
  return {
    questionCount: questions.length,
    totalPoints: Number(totalPoints.toFixed(3)),
    openPoints: Number(openPoints.toFixed(3)),
    recognitionShare: totalPoints > 0 ? Number(((totalPoints - openPoints) / totalPoints).toFixed(3)) : 0,
    sectionsScoped: exam.scope.sectionIds.length,
    sectionsSampled: exam.scope.sectionIds.filter((id) => sampled.has(id)).length,
    dimensions: [...new Set(questions.flatMap((question) => question.dimensions))].sort(),
    recommendedLength: recommendedExamLength(exam.scope.sectionIds.length),
  };
}

/**
 * Form-level engine rules. A short quiz may legitimately be all one format, so
 * these only bind once the form is long enough for the balance to be a choice
 * rather than an artefact of length.
 */
export function examFormIssues(blueprint: ExamBlueprint): string[] {
  const issues: string[] = [];
  if (blueprint.questionCount < MIXED_FORM_THRESHOLD) return issues;
  if (blueprint.openPoints === 0) {
    issues.push(
      `This form is entirely recognition: ${blueprint.questionCount} questions and no constructed response. `
      + "Important competencies must survive independent generation, not only selection. Add at least one open item.",
    );
  } else if (blueprint.recognitionShare > MAX_RECOGNITION_SHARE) {
    issues.push(
      `Multiple choice carries ${Math.round(blueprint.recognitionShare * 100)}% of the score. `
      + `A defensible form keeps recognition at or below ${Math.round(MAX_RECOGNITION_SHARE * 100)}% so the exam tests generation and transfer, not only discrimination.`,
    );
  }
  return issues;
}

/** One readable line describing what the frozen form covers. */
export function examBlueprintSummary(blueprint: ExamBlueprint): string {
  const coverage = blueprint.sectionsScoped > 0
    ? `${blueprint.sectionsSampled}/${blueprint.sectionsScoped} scoped subsection(s) sampled`
    : "no scoped subsections";
  const recommended = blueprint.recommendedLength ?? recommendedExamLength(blueprint.sectionsScoped);
  return `${blueprint.questionCount} question(s) · ${blueprint.totalPoints} point(s) · `
    + `${Math.round(blueprint.recognitionShare * 100)}% recognition · ${coverage} · `
    + `${blueprint.dimensions.length} competency dimension(s) · recommended length ${recommended} `
    + `(about 2 per scoped subsection, ${EXAM_RECOMMENDED_MIN}–${EXAM_RECOMMENDED_MAX}; at most ${EXAM_MAX_QUESTIONS})`;
}

function coerceAnswerValues(value: string | string[] | undefined): string[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

/**
 * The frozen form delimits each answer with a comment marker, and the submitted
 * text is parsed by locating those markers. Authored content that contains one
 * would create a second region for the same question, so a lazy match could
 * capture the wrong span and hand the grader another question's answer. Refuse
 * it where the form is built rather than discovering it at submission.
 */
const ANSWER_MARKER_TEXT = /<!--\s*\/?\s*scholar:answer:/i;

function assertNoAnswerMarker(value: string, label: string): void {
  if (ANSWER_MARKER_TEXT.test(value)) {
    throw new Error(`${label} contains one of Scholar's answer markers. That would corrupt the submitted form; reword it without the marker comment.`);
  }
}

function stableIdOrThrow(value: unknown, label: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) throw new Error(`${label} must be a nonempty string.`);
  if (trimmed.length > MAX_STABLE_ID) throw new Error(`${label} must be ${MAX_STABLE_ID} characters or fewer.`);
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw new Error(`${label} must not contain control characters.`);
  return trimmed;
}

/**
 * Build the frozen exam form. This is the only gate between a model-authored
 * question and the vault, so it must accept exactly what the stored schema
 * accepts: anything it returns is guaranteed to survive isScholarBook.
 *
 * Each question is rebuilt field by field rather than spread, so unrecognized
 * annotations are dropped instead of failing the atomic save with a message
 * that names nothing. Real modeling errors — a rubric on a multiple-choice
 * item, options on an open item — are reported so they can be corrected.
 */
export function validateExamQuestions(exam: ScholarExam, questions: ExamQuestion[]): ExamQuestion[] {
  const target = recommendedExamLength(exam.scope?.sectionIds?.length ?? 0);
  if (!Array.isArray(questions) || questions.length < 1) {
    throw new Error(`A new exam must contain at least one question. Aim for about ${target} — roughly two per scoped subsection — chosen from the scoped concepts and distinct evidence needed.`);
  }
  // A long paper costs the learner time and the grader a turn; the cap is fixed so a
  // rejected form always says exactly how short it must become.
  if (questions.length > EXAM_MAX_QUESTIONS) {
    throw new Error(`This form has ${questions.length} questions, but a new exam holds at most ${EXAM_MAX_QUESTIONS}. `
      + `Aim for about ${target} (roughly two per scoped subsection): keep one demanding item per important concept, `
      + "merge or drop near-duplicates, then call exam_build again with the shorter form.");
  }
  const scoped = new Set(exam.scope.sectionIds);
  const ids = new Set<string>();
  return questions.map((question, index) => {
    const id = stableIdOrThrow(question.id?.trim() || `q${index + 1}`, `Exam question ${index + 1} id`);
    assertNoAnswerMarker(id, `Exam question ${id} id`);
    if (id.includes("-->") || id.includes("<!--")) {
      throw new Error(`Exam question ${id} id cannot contain HTML comment markers ("-->" or "<!--").`);
    }
    if (ids.has(id)) throw new Error(`Duplicate exam question id: ${id}`);
    ids.add(id);

    const sectionIds = [...new Set(question.sectionIds || [])];
    if (!sectionIds.length || sectionIds.some((sectionId) => !scoped.has(sectionId))) {
      throw new Error(`Exam question ${id} must reference only sections in the frozen scope.`);
    }
    const claim = question.claim?.trim() || "";
    const prompt = question.prompt?.trim() || "";
    const explanation = question.explanation?.trim() || "";
    const requiredEvidence = compactStrings(question.requiredEvidence);
    const dimensions = compactStrings(question.dimensions);
    if (!claim || !prompt || !requiredEvidence.length || !dimensions.length) {
      throw new Error(`Exam question ${id} needs a claim, prompt, required evidence, and dimensions.`);
    }
    if (!explanation) throw new Error(`Exam question ${id} needs a post-submission explanation.`);
    if (!(question.maxPoints > 0)) throw new Error(`Exam question ${id} needs positive points.`);
    // Question engine: each item is answered with one short response, so a
    // proof-shaped or essay-length prompt cannot be frozen as a single item.
    // Name the item so the author can split or shorten it.
    const answerIssues = answerShapeIssues(prompt);
    if (answerIssues.length) throw new Error(`Exam question ${id} prompt: ${answerIssues[0]}`);
    assertNoAnswerMarker(prompt, `Exam question ${id} prompt`);
    assertNoAnswerMarker(claim, `Exam question ${id} claim`);
    assertNoAnswerMarker(explanation, `Exam question ${id} explanation`);
    for (const [index, item] of requiredEvidence.entries()) assertNoAnswerMarker(item, `Exam question ${id} requiredEvidence[${index + 1}]`);

    const base = { id, sectionIds, claim, requiredEvidence, dimensions, prompt, explanation, maxPoints: question.maxPoints };
    let normalized: ExamQuestion;

    if (question.format === "multiple-choice") {
      if (question.rubric !== undefined) {
        throw new Error(`MCQ ${id} must not carry a rubric. Use format "open" for rubric-scored work.`);
      }
      const rawOptions = question.options || [];
      // Question engine: use as many options as can be made genuinely plausible,
      // normally three or four. Two options is a coin flip, not a discrimination.
      if (rawOptions.length < MIN_MCQ_OPTIONS) {
        throw new Error(`MCQ ${id} needs at least ${MIN_MCQ_OPTIONS} genuinely plausible options; ${rawOptions.length} makes the item a guess rather than a discrimination.`);
      }
      const options = rawOptions.map((option, optionIndex) => {
        const misconception = option?.misconception?.trim();
        return {
          value: stableIdOrThrow(option?.value, `MCQ ${id} option ${optionIndex + 1} value`),
          label: option?.label?.trim() || "",
          ...(misconception ? { misconception } : {}),
        };
      });
      if (options.some((option) => !option.label)) throw new Error(`MCQ ${id} options each need a label.`);
      for (const option of options) {
        assertNoAnswerMarker(option.value, `MCQ ${id} option value ${option.value}`);
        assertNoAnswerMarker(option.label, `MCQ ${id} option ${option.value} label`);
      }
      const values = options.map((option) => option.value);
      if (new Set(values).size !== values.length) throw new Error(`MCQ ${id} option values must be unique.`);
      const correct = [...new Set(coerceAnswerValues(question.correctAnswer).map((value) => value.trim()))];
      if (!correct.length || correct.some((value) => !values.includes(value))) {
        throw new Error(`MCQ ${id} has an invalid correctAnswer value.`);
      }
      // Question engine: the shared option rules decide, this gate only phrases the rejection.
      const issues = optionIssues(options, correct);
      if (issues.includes("catch-all")) {
        throw new Error(`MCQ ${id} uses a catch-all option (${JSON.stringify(options.find((option) => CATCH_ALL_OPTION.test(option.label))?.label)}). The question engine forbids all/none-of-the-above: it tests bookkeeping rather than a decision.`);
      }
      if (issues.includes("missing-misconception")) {
        const undiagnosed = options.filter((option) => !correct.includes(option.value) && !option.misconception);
        throw new Error(`MCQ ${id} distractor(s) ${undiagnosed.map((option) => option.value).join(", ")} declare no misconception. Each distractor must name the one distinct misconception it targets.`);
      }
      if (issues.includes("duplicate-misconception")) {
        throw new Error(`MCQ ${id} repeats a distractor misconception. Each wrong option must target a different error.`);
      }
      normalized = {
        ...base,
        format: "multiple-choice",
        options,
        correctAnswer: Array.isArray(question.correctAnswer) ? correct : correct[0]!,
      };
    } else {
      if (question.options !== undefined || question.correctAnswer !== undefined) {
        throw new Error(`Open question ${id} must not carry options or a correctAnswer. Score it with a rubric.`);
      }
      const rawRubric = question.rubric || [];
      if (!rawRubric.length) throw new Error(`Open question ${id} needs an analytic rubric.`);
      // Question engine: score evidence, not answer length. One criterion is a
      // holistic impression; an analytic rubric separates what was demonstrated.
      if (rawRubric.length < MIN_RUBRIC_CRITERIA) {
        throw new Error(`Open question ${id} needs at least ${MIN_RUBRIC_CRITERIA} rubric criteria so conceptual, procedural and checking evidence can be scored apart; found ${rawRubric.length}.`);
      }
      const criterionIds = new Set<string>();
      const rubric = rawRubric.map((criterion, criterionIndex) => {
        const criterionId = stableIdOrThrow(criterion?.id, `Open question ${id} rubric criterion ${criterionIndex + 1} id`);
        if (criterionIds.has(criterionId)) {
          throw new Error(`Open question ${id} has a duplicate rubric criterion id: ${criterionId}`);
        }
        criterionIds.add(criterionId);
        const criterionText = criterion?.criterion?.trim() || "";
        if (!criterionText) throw new Error(`Open question ${id} rubric criterion ${criterionId} needs a description.`);
        assertNoAnswerMarker(criterionText, `Open question ${id} rubric criterion ${criterionId}`);
        const criterionEvidence = compactStrings(criterion?.requiredEvidence);
        if (!criterionEvidence.length) {
          throw new Error(`Open question ${id} rubric criterion ${criterionId} needs required evidence.`);
        }
        if (!(criterion.points > 0)) {
          throw new Error(`Open question ${id} rubric criterion ${criterionId} needs positive points.`);
        }
        return { id: criterionId, criterion: criterionText, requiredEvidence: criterionEvidence, points: criterion.points };
      });
      const rubricPoints = rubric.reduce((sum, criterion) => sum + criterion.points, 0);
      if (Math.abs(rubricPoints - question.maxPoints) > 0.001) {
        throw new Error(`Open question ${id} rubric points must total maxPoints.`);
      }
      normalized = { ...base, format: "open", rubric };
    }

    // Parity backstop. The stored schema is the authority; if it would refuse
    // this question, fail here with the question named rather than later with
    // an opaque whole-book rejection.
    if (!isExamQuestion(normalized)) {
      throw new Error(`Exam question ${id} does not match Scholar's stored schema and cannot be saved.`);
    }
    return normalized;
  });
}

/** Visible room to write in. Open questions need space, not a one-line prompt. */
const OPEN_ANSWER_LINES = 8;

/** Shared question presentation for the editable paper and the post-submit key. */
export function examQuestionLines(question: ExamQuestion, index: number): string[] {
  const format = question.format === "multiple-choice"
    ? Array.isArray(question.correctAnswer) && question.correctAnswer.length > 1
      ? "Multiple choice · select all that apply"
      : "Multiple choice"
    : "Open response";
  return [
    `### Question ${index + 1}`, "",
    `*${format} · ${Number(question.maxPoints.toPrecision(6))} ${question.maxPoints === 1 ? "point" : "points"}*`, "",
    markdownText(question.prompt),
    ...(question.options?.length ? ["", ...question.options.map((option) => `- **${markdownText(option.value)}** — ${markdownText(option.label)}`)] : []),
  ];
}

export function examAnswerRegionLines(question: ExamQuestion): string[] {
  return [
    "", ...(question.format === "open" ? ["**Your response** · Write below in Live Preview.", ""] : []),
    `${ANSWER_START}${question.id}:start -->`,
    ...(question.format === "open" ? Array<string>(OPEN_ANSWER_LINES).fill("")
      : (question.options || []).map((option, index) =>
        `- [ ] **${markdownText(option.value)}** — ${markdownText(option.label).replace(/\n/g, "<br>")} <!-- scholar:choice:${index} -->`)),
    `${ANSWER_END}${question.id}:end -->`,
  ];
}

/** Native Obsidian task checkboxes; indices identify the frozen options, not labels. */
function checkboxResponse(question: ExamQuestion, response: string): string {
  const rows = response.split(/\r?\n/).filter((line) => line.trim());
  const selected: string[] = [];
  const seen = new Set<number>();
  for (const row of rows) {
    const match = /^- \[([ xX])\] .+ <!-- scholar:choice:(\d+) -->\s*$/.exec(row);
    const index = match ? Number(match[2]) : -1;
    const option = question.options?.[index];
    if (!match || !option || seen.has(index) || (row.match(/<!--\s*scholar:choice:/g) || []).length !== 1) {
      throw new Error(`Question ${question.id}: an answer choice is missing, duplicated or damaged. Restore its checkbox row before submitting.`);
    }
    seen.add(index);
    if (match[1].toLowerCase() === "x") selected.push(option.value);
  }
  if (seen.size !== question.options?.length) {
    throw new Error(`Question ${question.id}: keep every answer choice, including unchecked choices, before submitting.`);
  }
  if (selected.length > 1 && !(Array.isArray(question.correctAnswer) && question.correctAnswer.length > 1)) {
    throw new Error(`Question ${question.id}: select one answer only. Uncheck the extra choices before submitting.`);
  }
  return selected.join(", ");
}

function canonicalFormValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalFormValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, canonicalFormValue(item)]));
  }
  return value;
}

/** Mutable status, timestamps, responses and grades do not change the frozen form. */
export function examFormFingerprint(exam: ScholarExam): string {
  return createHash("sha256").update(JSON.stringify(canonicalFormValue({ scope: exam.scope, questions: exam.questions }))).digest("hex");
}

export const EXAM_PAPER_COMPLETE = "<!-- scholar:exam-paper:complete -->";

/** Wrong/stale paper detection is an accident guard, not a tamper-proof signature. */
export function validateExamAnswerNote(book: ScholarBook, exam: ScholarExam, text: string): void {
  const header = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
  if (!header) throw new Error("The answer paper is missing its identity header. Restore the original paper before submitting.");
  const lines = header.split(/\r?\n/);
  const identity = {
    type: "scholar-exam-paper", book_id: book.id, book_instance_id: book.instanceId,
    exam_id: exam.id, form_fingerprint: examFormFingerprint(exam),
  };
  for (const [key, expected] of Object.entries(identity)) {
    const fields = lines.filter((line) => new RegExp(`^[ \\t]*${key}[ \\t]*:`).test(line));
    const value = fields[0]?.slice(fields[0].indexOf(":") + 1).trim();
    // Accept Obsidian's plain or JSON-quoted scalar spelling. No YAML aliases,
    // duplicate fields or multiline values can supply identity.
    if (fields.length !== 1 || (value !== expected && value !== JSON.stringify(expected))) {
      throw new Error(`The answer paper has a wrong or damaged ${key}; it does not match this book instance and frozen exam. Restore the matching paper before submitting.`);
    }
  }
  const completion = text.indexOf(EXAM_PAPER_COMPLETE);
  if (completion < 0 || completion !== text.lastIndexOf(EXAM_PAPER_COMPLETE)
    || !text.slice(0, completion).endsWith("\n")
    || !/^(?:\r?\n|$)/.test(text.slice(completion + EXAM_PAPER_COMPLETE.length))
    || completion < text.lastIndexOf(ANSWER_END)) {
    throw new Error("The answer paper is incomplete or its completion marker is damaged. Restore the complete paper before submitting.");
  }
  parseExamResponses(exam, text);
}

export function parseExamResponses(exam: ScholarExam, text: string): Array<{ questionId: string; response: string }> {
  const spans: Array<{ questionId: string; start: number; contentStart: number; end: number; endLength: number }> = [];
  if (new Set(exam.questions.map((question) => question.id)).size !== exam.questions.length) {
    throw new Error("The frozen exam has duplicate question IDs; its answers cannot be read safely.");
  }
  for (const question of exam.questions) {
    const start = `${ANSWER_START}${question.id}:start -->`;
    const end = `${ANSWER_END}${question.id}:end -->`;

    // Each marker must appear exactly once. A duplicate means the submitted
    // text contains a marker that is not the one Scholar wrote — typed into an
    // answer, or carried in from the source — and a lazy match would silently
    // capture the wrong region and grade it. Fail loudly instead.
    const startCount = text.split(start).length - 1;
    const endCount = text.split(end).length - 1;
    if (startCount === 0 || endCount === 0) {
      throw new Error(`The answer markers for ${question.id} were removed or damaged. Restore its original opening and closing markers in Obsidian before submitting.`);
    }
    if (startCount > 1 || endCount > 1) {
      throw new Error(
        `The submitted form contains ${Math.max(startCount, endCount)} copies of the answer marker for ${question.id}. `
        + "Scholar cannot tell which region is your answer. Remove any text that looks like "
        + "an answer marker comment, then submit again.",
      );
    }

    const startIndex = text.indexOf(start);
    const endIndex = text.indexOf(end);
    if (endIndex < startIndex + start.length) {
      throw new Error(`The answer region for ${question.id} is malformed: its closing marker appears before its opening marker.`);
    }
    spans.push({ questionId: question.id, start: startIndex, contentStart: startIndex + start.length, end: endIndex, endLength: end.length });
  }
  const ordered = [...spans].sort((left, right) => left.start - right.start);
  for (let index = 1; index < ordered.length; index++) {
    if (ordered[index]!.start < ordered[index - 1]!.end + ordered[index - 1]!.endLength) {
      throw new Error(`The answer regions for ${ordered[index - 1]!.questionId} and ${ordered[index]!.questionId} overlap or cross. Keep each answer inside its own matching markers.`);
    }
  }
  const expectedPositions = new Set(spans.flatMap((span) => [span.start, span.end]));
  for (const marker of text.matchAll(/<!--\s*\/?\s*scholar:answer:/gi)) {
    if (!expectedPositions.has(marker.index!)) {
      throw new Error("The answer paper contains an unknown or damaged answer marker. Remove the extra marker or restore its original spelling before submitting.");
    }
  }
  const checkboxPaper = /^answer_format:\s*(?:checkboxes-v1|"checkboxes-v1"|'checkboxes-v1')\s*$/m
    .test(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1] || "");
  return spans.map((span, index) => {
    // Older frozen forms seeded a placeholder sentence; blank space replaced it.
    // Treat either as unanswered so a resumed exam grades consistently.
    const openingPrefix = text.slice(text.lastIndexOf("\n", span.start) + 1, span.start);
    const closingPrefix = text.slice(text.lastIndexOf("\n", span.end) + 1, span.end);
    const framed = /^> ?$/.test(openingPrefix);
    if ((openingPrefix && !framed) || (closingPrefix && !/^> ?$/.test(closingPrefix))) throw new Error(`The answer callout for ${span.questionId} has an unsupported quote prefix. Restore its single-level frame before submitting.`);
    if (framed !== /^> ?$/.test(closingPrefix)) throw new Error(`The answer callout for ${span.questionId} has a damaged boundary. Restore its matching frame before submitting.`);
    const raw = text.slice(span.contentStart, span.end);
    const response = (framed ? raw.replace(/^> ?/gm, "") : raw).trim();
    const question = exam.questions[index]!;
    if (question.format === "multiple-choice" && (checkboxPaper || response.includes("scholar:choice:"))) {
      return { questionId: span.questionId, response: checkboxResponse(question, response) };
    }
    return { questionId: span.questionId, response: response === "Write your answer here." ? "" : response };
  });
}

export type ExamAnswerProgress = { ok: true; total: number; answered: number; blank: string[] } | { ok: false; problem: string };

/** Use exactly the submission parser: damaged regions never masquerade as blanks. */
export function examAnswerProgress(exam: ScholarExam, text: string): ExamAnswerProgress {
  try {
    const responses = parseExamResponses(exam, text);
    const blank = responses.filter((item) => !item.response).map((item) => item.questionId);
    return { ok: true, total: responses.length, answered: responses.length - blank.length, blank };
  } catch (error) {
    return { ok: false, problem: error instanceof Error ? error.message : String(error) };
  }
}

/** Scholar's own score for a multiple-choice item; a grader can add feedback but never change it. */
export type ChoiceScore = {
  outcome: "correct" | "incorrect" | "unanswered";
  earnedPoints: number;
  /** Frozen option values the learner selected, in the order they were read. */
  selected: string[];
  /** Frozen option values the key requires, as an exact set. */
  key: string[];
  /** The submitted text did not unambiguously name frozen options. */
  unrecognized?: boolean;
};

/** A blank never earns credit and is not evidence of a misconception. */
export const UNANSWERED_FEEDBACK = "Not answered — 0 points. Review the correct answer and reasoning below.";

function frozenChoiceKey(question: ExamQuestion): string[] | undefined {
  const values = (question.options || []).map((option) => option.value);
  const key = [...new Set(coerceAnswerValues(question.correctAnswer))];
  return question.format === "multiple-choice" && key.length && key.every((value) => values.includes(value)) ? key : undefined;
}

/**
 * Read a submitted choice as frozen option values: [] when blank, undefined when
 * the text is not unambiguously a set of options. A checkbox paper stores the
 * ticked values joined by ", "; an older typed paper may hold "b", "B" or a
 * sentence. Only an exact (or unambiguous case-folded) option value counts.
 */
export function submittedChoiceValues(question: ExamQuestion, response: unknown): string[] | undefined {
  const values = (question.options || []).map((option) => option.value);
  const optionFor = (token: string): string | undefined => {
    if (values.includes(token)) return token;
    const folded = values.filter((value) => value.toLowerCase() === token.toLowerCase());
    return folded.length === 1 ? folded[0] : undefined;
  };
  const read = (tokens: string[]): string[] | undefined => {
    const selected = tokens.map(optionFor);
    return tokens.length && selected.every((value): value is string => value !== undefined) ? [...new Set(selected)] : undefined;
  };
  if (Array.isArray(response)) {
    if (!response.every((item) => typeof item === "string")) return undefined;
    const tokens = response.map((item) => item.trim()).filter(Boolean);
    return tokens.length ? read(tokens) : [];
  }
  if (typeof response !== "string") return undefined;
  const text = response.trim();
  if (!text) return [];
  const whole = optionFor(text);
  const split = read(text.split(",").map((token) => token.trim()).filter(Boolean));
  // An option value that itself contains a comma makes the joined text readable two
  // ways; a grader decides rather than Scholar picking one.
  if (whole !== undefined && split !== undefined && (split.length !== 1 || split[0] !== whole)) return undefined;
  return whole !== undefined ? [whole] : split;
}

/**
 * Deterministic multiple-choice scoring: an exact set match earns full points,
 * a blank is unanswered and anything else is incorrect. An unrecognized answer
 * earns zero deterministically; only a corrupt frozen key makes scoring impossible.
 */
export function scoreChoiceItem(question: ExamQuestion, response: unknown): ChoiceScore | undefined {
  const key = frozenChoiceKey(question);
  const selected = key ? submittedChoiceValues(question, response) : undefined;
  if (!key) return undefined;
  if (!selected) return { outcome: "incorrect", earnedPoints: 0, selected: [], key, unrecognized: true };
  if (!selected.length) return { outcome: "unanswered", earnedPoints: 0, selected, key };
  const exact = selected.length === key.length && key.every((value) => selected.includes(value));
  return { outcome: exact ? "correct" : "incorrect", earnedPoints: exact ? question.maxPoints : 0, selected, key };
}

/** Every item Scholar scores itself, by question id. */
export function scholarChoiceScores(exam: ScholarExam): Map<string, ChoiceScore> {
  const scores = new Map<string, ChoiceScore>();
  for (const question of exam.questions) {
    if (question.format !== "multiple-choice") continue;
    const score = scoreChoiceItem(question, exam.rawResponses.find((item) => item.questionId === question.id)?.response);
    if (!score) throw new Error(`Exam ${exam.id} has an invalid frozen answer key for ${question.id}; grading cannot continue.`);
    scores.set(question.id, score);
  }
  return scores;
}

function optionName(question: ExamQuestion, value: string): string {
  const label = question.options?.find((option) => option.value === value)?.label || value;
  return `“${label.replace(/\s+/g, " ").trim()}”`;
}

function listed(items: string[]): string {
  return items.length < 3 ? items.join(" and ") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function asSentence(text: string): string {
  const value = text.replace(/\s+/g, " ").trim();
  return /[.!?…]$/.test(value) ? value : `${value}.`;
}

/**
 * Scholar's feedback for an item it scored: the verdict, the declared misconception
 * behind each wrong pick, then the frozen explanation. It names authored option
 * labels only, never learner-written text.
 */
export function choiceFeedback(question: ExamQuestion, score: ChoiceScore): string {
  if (score.outcome === "unanswered") return UNANSWERED_FEEDBACK;
  const explanation = question.explanation.trim();
  if (score.outcome === "correct") return `Correct. ${explanation}`;
  if (score.unrecognized) return `Incorrect — the submitted answer did not match a listed choice. ${explanation}`;
  const wrong = score.selected.filter((value) => !score.key.includes(value));
  const missed = score.key.filter((value) => !score.selected.includes(value));
  const diagnosed = wrong.flatMap((value) => {
    const misconception = question.options?.find((option) => option.value === value)?.misconception?.trim();
    return misconception ? [{ value, misconception }] : [];
  });
  const parts = [`Incorrect — you chose ${listed(score.selected.map((value) => optionName(question, value)))}.`];
  if (diagnosed.length === 1 && score.selected.length === 1) parts.push(`That choice reflects a common misconception: ${asSentence(diagnosed[0]!.misconception)}`);
  else for (const { value, misconception } of diagnosed) parts.push(`${optionName(question, value)} reflects a common misconception: ${asSentence(misconception)}`);
  if (missed.length && score.key.length > 1) parts.push(`The answer also includes ${listed(missed.map((value) => optionName(question, value)))}.`);
  parts.push(explanation);
  return parts.join(" ");
}

function packetPoints(points: number): string {
  return String(Number(points.toPrecision(6)));
}

/**
 * The submitted form as the grader sees it. Scholar has already scored every clean
 * multiple-choice answer, so the grader judges only written responses.
 */
export function gradingPacket(exam: ScholarExam): string {
  const scores = scholarChoiceScores(exam);
  const judged = exam.questions.filter((question) => !scores.has(question.id));
  const lines = [`Exam ${exam.id} was submitted.`];
  if (scores.size) {
    lines.push("", `SCORED BY SCHOLAR from the frozen key (${scores.size} multiple-choice item(s); final, do not re-grade):`);
    for (const question of exam.questions) {
      const score = scores.get(question.id);
      if (!score) continue;
      lines.push(`- ${question.id}: ${score.outcome} · ${packetPoints(score.earnedPoints)}/${packetPoints(question.maxPoints)}`
        + (score.unrecognized ? " (answer did not match a listed choice)"
          : score.outcome === "incorrect" ? ` (selected ${score.selected.join(", ")}; key ${score.key.join(", ")})` : ""));
    }
  }
  if (judged.length) {
    lines.push("", `GRADE ${judged.length === exam.questions.length ? "EVERY ITEM" : "THESE ITEMS"} against the frozen contract:`);
    for (const question of judged) {
      const response = exam.rawResponses.find((item) => item.questionId === question.id)?.response || "";
      lines.push("", `QUESTION ${question.id}`,
        question.prompt, `LEARNER RESPONSE:\n${Array.isArray(response) ? response.join(", ") : response || "(blank)"}`);
      lines.push("RUBRIC:", ...(question.rubric || []).map((criterion) => `- ${criterion.id}: ${criterion.points} point(s) — ${criterion.criterion}; evidence: ${criterion.requiredEvidence.join("; ")}`));
      lines.push(`MAX POINTS: ${question.maxPoints}`, `GOLD EXPLANATION: ${question.explanation}`);
    }
    lines.push("", `Call scholar action=exam_grade with exactly one result for each of: ${judged.map((question) => question.id).join(", ")}.`
      + (scores.size ? " Omit the Scholar-scored items; any result sent for one is ignored." : "")
      + " Feedback must be diagnostic and nonverbatim; never copy the learner response into feedback.");
  } else {
    lines.push("", "Every item was scored by Scholar. Call scholar action=exam_grade with no itemResults to record the grade.");
  }
  return lines.join("\n");
}

export function buildExamBreakdown(book: ScholarBook, exam: ScholarExam, results: ExamItemResult[]): ExamBreakdown[] {
  const totals = new Map<string, { label: string; earned: number; max: number }>();
  const add = (key: string, label: string, earned: number, max: number) => {
    const current = totals.get(key) || { label, earned: 0, max: 0 };
    current.earned += earned;
    current.max += max;
    totals.set(key, current);
  };
  for (const question of exam.questions) {
    const result = results.find((item) => item.questionId === question.id);
    if (!result) throw new Error(`Exam breakdown has no result for question ${question.id}.`);
    const sectionShare = question.sectionIds.length || 1;
    for (const sectionId of question.sectionIds) {
      const section = findSection(book, sectionId);
      add(`section:${sectionId}`, section ? sectionLabel(book, section) : sectionId, result.earnedPoints / sectionShare, result.maxPoints / sectionShare);
    }
    const dimensionShare = question.dimensions.length || 1;
    for (const dimension of question.dimensions) {
      add(`dimension:${dimension}`, dimension, result.earnedPoints / dimensionShare, result.maxPoints / dimensionShare);
    }
  }
  return [...totals.entries()].map(([key, value]) => ({
    key,
    label: value.label,
    // Keep split weights at full precision so the stored ratio remains the
    // actual score, including tiny positive weights. Round only for display.
    earnedPoints: value.earned,
    maxPoints: value.max,
    percent: value.max > 0 ? Math.round((value.earned / value.max) * 1000) / 10 : 0,
  }));
}
