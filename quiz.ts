/**
 * Internal Scholar quiz UI.
 *
 * Adapted from Amos Blomqvist's learn extension at commit
 * 7cfd8942f82ab9476e63572387e1fe9bcea5082c. Scholar keeps its own tool name
 * and intentionally omits free-text capture.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key, Text, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { QuestionGroundingSchema } from "./question-grounding-schema.ts";
import {
  SCHOLAR_QUIZ_TOOL_NAME,
  toScholarQuizDisplayedOptions,
  type ScholarQuizAnswer as OptionAnswer,
  type ScholarQuizMode as QuizMode,
  type ScholarQuizOption as QuizOption,
  type ScholarQuizProgressDetails as QuizProgressDetails,
  type ScholarQuizResponse as QuizResponse,
  type ScholarQuizResultDetails as QuizResultDetails,
} from "./quiz-contract.ts";

interface DisplayOption extends QuizOption {
  id: string;
  index: number;
  kind: "answer" | "dont-know" | "submit";
}

const DONT_KNOW_VALUE = "__scholar_dont_know__";
const DONT_KNOW_LABEL = "I don't know";
const SUBMIT_VALUE = "__scholar_submit__";

const OptionSchema = Type.Object({
  label: Type.String({ description: "Answer text shown to the learner." }),
  value: Type.Optional(
    Type.String({
      description: "Stable machine-readable answer value. Defaults to the label when omitted.",
    }),
  ),
  description: Type.Optional(
    Type.String({ description: "Optional neutral clarification shown before the learner answers." }),
  ),
});

const ScholarQuizParams = Type.Object({
  kind: Type.Optional(Type.Union([
    Type.Literal("conceptual"), Type.Literal("application"), Type.Literal("computation"),
    Type.Literal("discrimination"),
  ], { description: "The understanding check this question tests. Set this explicitly; difficulty is only a rigor label." })),
  question: Type.String({ description: "Ask exactly one graded question." }),
  details: Type.Optional(
    Type.String({ description: "Optional source-bound context or instructions shown under the question." }),
  ),
  difficulty: Type.Optional(
    Type.String({ description: "Optional rigor label such as discrimination, computation, or transfer." }),
  ),
  grounding: QuestionGroundingSchema,
  options: Type.Array(OptionSchema, {
    minItems: 2,
    description:
      "Two or more real answer options. Give each a stable value; Scholar adds a distinct I don't know choice.",
  }),
  multiSelect: Type.Optional(
    Type.Boolean({ description: "True only when the exact correct answer contains multiple options." }),
  ),
  correctAnswer: Type.Union([Type.String(), Type.Array(Type.String())], {
    description:
      "Required correct option value, or array of values for multi-select. Values—not positions—are self-validated.",
  }),
  explanation: Type.String({
    description: "Required explanation revealed only after submission.",
  }),
  shuffle: Type.Optional(
    Type.Boolean({
      description: "Defaults to true. Set false only when answer order carries meaning.",
    }),
  ),
});

function isManualUncertainty(label: string, value: string): boolean {
  if (value === DONT_KNOW_VALUE || value === SUBMIT_VALUE) return true;
  const normalized = label
    .toLocaleLowerCase("en-US")
    .replace(/[’]/g, "'")
    .replace(/[.!?]+$/g, "")
    .trim();
  return /^(?:i (?:do not|don't) know|i(?:'m| am) not sure|not sure|unsure)$/.test(normalized);
}

function normalizeOptions(
  options: Array<{ label: string; value?: string; description?: string }> | undefined,
): QuizOption[] {
  const values = new Set<string>();
  const labels = new Set<string>();
  return (options || []).map((raw, position) => {
    const label = raw.label.trim();
    const value = raw.value?.trim() || label;
    const description = raw.description?.trim() || undefined;
    if (!label) throw new Error(`option ${position + 1} has an empty label`);
    if (!value) throw new Error(`option ${position + 1} has an empty value`);
    if (isManualUncertainty(label, value)) {
      throw new Error(`option ${position + 1} duplicates Scholar's automatic I don't know choice`);
    }
    if (values.has(value)) throw new Error(`duplicate option value "${value}"`);
    const labelKey = label.toLocaleLowerCase("en-US");
    if (labels.has(labelKey)) throw new Error(`duplicate option label "${label}"`);
    values.add(value);
    labels.add(labelKey);
    return { label, value, ...(description ? { description } : {}) };
  });
}

function shuffleOptions(options: QuizOption[]): QuizOption[] {
  const shuffled = [...options];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
  }
  return shuffled;
}

function coerceCorrectAnswer(correctAnswer: string | string[]): string[] {
  if (Array.isArray(correctAnswer)) return correctAnswer;
  const trimmed = correctAnswer.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map((value) => String(value));
    } catch {
      // Treat malformed JSON-looking input as one literal option value.
    }
  }
  return [correctAnswer];
}

function resolveCorrect(
  correctAnswer: string | string[] | undefined,
  options: QuizOption[],
  mode: QuizMode,
): { indices: number[]; error?: string } {
  if (correctAnswer === undefined) return { indices: [], error: "correctAnswer is required" };
  const values = coerceCorrectAnswer(correctAnswer).map((value) => value.trim()).filter(Boolean);
  if (values.length === 0) return { indices: [], error: "correctAnswer is required" };
  const uniqueValues = [...new Set(values)];
  if (mode === "single-select" && uniqueValues.length !== 1) {
    return { indices: [], error: "single-select requires exactly one correctAnswer value" };
  }
  if (mode === "multi-select" && uniqueValues.length < 2) {
    return { indices: [], error: "multi-select requires at least two correctAnswer values" };
  }

  const byValue = new Map(options.map((option, index) => [option.value, index + 1]));
  const indices: number[] = [];
  for (const value of uniqueValues) {
    const index = byValue.get(value);
    if (index === undefined) {
      const known = options.map((option) => `"${option.value}"`).join(", ");
      return {
        indices: [],
        error: `correctAnswer "${value}" does not match an option value (${known})`,
      };
    }
    indices.push(index);
  }
  return { indices: indices.sort((left, right) => left - right) };
}

function isCorrect(selectedIndices: number[], correctIndices: number[]): boolean {
  if (selectedIndices.length !== correctIndices.length) return false;
  const selected = [...selectedIndices].sort((left, right) => left - right);
  const correct = [...correctIndices].sort((left, right) => left - right);
  return selected.every((value, index) => value === correct[index]);
}

function addWrapped(lines: string[], text: string, width: number, indent = ""): void {
  const contentWidth = Math.max(1, width - indent.length);
  for (const line of wrapTextWithAnsi(text, contentWidth)) {
    lines.push(truncateToWidth(`${indent}${line}`, width));
  }
}

function optionReference(options: QuizOption[], index: number): string {
  return `${index}. ${options[index - 1]?.label || "(unknown)"}`;
}

function pushHeader(
  lines: string[],
  theme: any,
  width: number,
  question: string,
  context: string | undefined,
): void {
  lines.push(truncateToWidth(theme.fg("accent", "─".repeat(Math.max(1, width))), width));
  addWrapped(lines, theme.fg("text", question), width, " ");
  if (context) {
    lines.push("");
    addWrapped(lines, theme.fg("muted", context), width, " ");
  }
}

function sortedAnswers(answers: Iterable<OptionAnswer>): OptionAnswer[] {
  return [...answers].sort((left, right) => left.index - right.index);
}

async function askChoice(
  ctx: any,
  question: string,
  context: string | undefined,
  options: QuizOption[],
  mode: QuizMode,
): Promise<QuizResponse | null> {
  const answerItems: DisplayOption[] = options.map((option, offset) => ({
    ...option,
    id: `answer:${offset}`,
    index: offset + 1,
    kind: "answer",
  }));
  const dontKnowItem: DisplayOption = {
    id: "dont-know",
    index: 0,
    kind: "dont-know",
    label: DONT_KNOW_LABEL,
    value: DONT_KNOW_VALUE,
  };
  const submitItem: DisplayOption = {
    id: "submit",
    index: -1,
    kind: "submit",
    label: "Submit",
    value: SUBMIT_VALUE,
  };
  const items = mode === "multi-select"
    ? [...answerItems, dontKnowItem, submitItem]
    : [...answerItems, dontKnowItem];

  return ctx.ui.custom(
    (tui: any, theme: any, _keybindings: any, done: (response: QuizResponse | null) => void) => {
      let cursor = 0;
      let dontKnow = false;
      const selected = new Map<string, OptionAnswer>();
      let cachedLines: string[] | undefined;
      let cachedWidth = -1;

      const refresh = () => {
        cachedLines = undefined;
        tui.requestRender();
      };
      const answers = () => sortedAnswers(selected.values());
      const response = (): QuizResponse => ({
        dontKnow,
        answers: dontKnow ? [] : answers(),
      });
      const canSubmit = () => dontKnow || selected.size > 0;
      // Feedback is rendered from the completed tool result. Resolve the
      // custom UI as soon as the answer is accepted so it cannot keep the
      // tool call (and its Working indicator) open for an acknowledgement.
      const submitResponse = () => done(response());

      const chooseSingle = (item: DisplayOption) => {
        selected.clear();
        dontKnow = item.kind === "dont-know";
        if (item.kind === "answer") {
          selected.set(item.id, { label: item.label, value: item.value, index: item.index });
        }
        submitResponse();
      };

      const toggleMulti = (item: DisplayOption) => {
        if (item.kind === "dont-know") {
          dontKnow = !dontKnow;
          if (dontKnow) selected.clear();
        } else if (item.kind === "answer") {
          dontKnow = false;
          if (selected.has(item.id)) selected.delete(item.id);
          else selected.set(item.id, { label: item.label, value: item.value, index: item.index });
        }
        refresh();
      };

      const handleInput = (data: string) => {
        if (matchesKey(data, Key.escape)) {
          done(null);
          return;
        }
        if (matchesKey(data, Key.up)) {
          cursor = Math.max(0, cursor - 1);
          refresh();
          return;
        }
        if (matchesKey(data, Key.down)) {
          cursor = Math.min(items.length - 1, cursor + 1);
          refresh();
          return;
        }

        const current = items[cursor];
        if (mode === "single-select") {
          if (matchesKey(data, Key.enter) && current.kind !== "submit") chooseSingle(current);
          return;
        }
        if (matchesKey(data, Key.space)) {
          if (current.kind !== "submit") toggleMulti(current);
          return;
        }
        if (matchesKey(data, Key.enter)) {
          if (current.kind === "submit") {
            if (canSubmit()) submitResponse();
          } else {
            toggleMulti(current);
          }
        }
      };

      const render = (width: number): string[] => {
        if (cachedLines && cachedWidth === width) return cachedLines;
        const safeWidth = Math.max(1, width);
        const lines: string[] = [];
        const add = (text: string) => lines.push(truncateToWidth(text, safeWidth));
        pushHeader(lines, theme, safeWidth, question, context);

        lines.push("");
        for (let offset = 0; offset < items.length; offset += 1) {
          const item = items[offset];
          const focused = offset === cursor;
          const prefix = focused ? theme.fg("accent", "> ") : "  ";

          if (item.kind === "dont-know") {
            lines.push("");
            const checked = mode === "multi-select" ? `${dontKnow ? "[x]" : "[ ]"} ` : "";
            const label = `${checked}${item.label}`;
            add(`${prefix}${focused ? theme.fg("accent", label) : theme.fg(dontKnow ? "warning" : "dim", label)}`);
            continue;
          }

          if (item.kind === "submit") {
            const count = dontKnow ? "I don't know" : `${selected.size} selected`;
            const label = canSubmit() ? `✓ Submit (${count})` : "○ Submit";
            add(`${prefix}${focused ? theme.fg("accent", label) : theme.fg(canSubmit() ? "success" : "dim", label)}`);
            continue;
          }

          const checked = mode === "multi-select"
            ? `${selected.has(item.id) ? "[x]" : "[ ]"} `
            : "";
          const label = `${checked}${item.index}. ${item.label}`;
          const color = focused ? "accent" : selected.has(item.id) ? "success" : "text";
          add(`${prefix}${theme.fg(color, label)}`);
          if (item.description) addWrapped(lines, theme.fg("muted", item.description), safeWidth, "     ");
        }

        lines.push("");
        if (mode === "multi-select" && !canSubmit()) {
          add(theme.fg("warning", " Select at least one answer before submitting."));
        }
        add(
          theme.fg(
            "dim",
            mode === "multi-select"
              ? " ↑↓ navigate • Space toggle • Enter submit/toggle • Esc cancel"
              : " ↑↓ navigate • Enter answer • Esc cancel",
          ),
        );
        add(theme.fg("accent", "─".repeat(safeWidth)));
        cachedLines = lines;
        cachedWidth = width;
        return lines;
      };

      return {
        render,
        invalidate: () => {
          cachedLines = undefined;
        },
        handleInput,
      };
    },
  ) as Promise<QuizResponse | null>;
}

const SHARED_UI_LOCK_KEY = "__piSharedUiLock";

function getSharedUiLock(): { withLock<T>(operation: () => T | Promise<T>): Promise<T> } {
  const shared = globalThis as typeof globalThis & {
    [SHARED_UI_LOCK_KEY]?: { withLock<T>(operation: () => T | Promise<T>): Promise<T> };
  };
  if (!shared[SHARED_UI_LOCK_KEY]) {
    let chain: Promise<void> = Promise.resolve();
    shared[SHARED_UI_LOCK_KEY] = {
      withLock<T>(operation: () => T | Promise<T>): Promise<T> {
        const previous = chain;
        let release!: () => void;
        chain = new Promise<void>((resolve) => {
          release = resolve;
        });
        return previous.then(operation).finally(release);
      },
    };
  }
  return shared[SHARED_UI_LOCK_KEY]!;
}

function unavailableResult(
  question: string,
  mode: QuizMode,
  message: string,
  context?: string,
) {
  return {
    content: [{ type: "text" as const, text: message }],
    details: { status: "unavailable" as const, question, context, mode, message } satisfies QuizResultDetails,
  };
}

function cancelledResult(question: string, mode: QuizMode, context?: string) {
  const message = "User cancelled the Scholar quiz before submitting.";
  return {
    content: [{ type: "text" as const, text: message }],
    details: { status: "cancelled" as const, question, context, mode, message } satisfies QuizResultDetails,
  };
}

function answeredResult(
  question: string,
  context: string | undefined,
  mode: QuizMode,
  options: QuizOption[],
  response: QuizResponse,
  correctIndices: number[],
  explanation: string,
) {
  const selectedIndices = response.answers.map((answer) => answer.index);
  const correct = !response.dontKnow && isCorrect(selectedIndices, correctIndices);
  const correctText = correctIndices.map((index) => optionReference(options, index)).join(", ");
  const verdict = response.dontKnow
    ? "User reported a genuine knowledge gap without guessing."
    : correct
      ? "User answered correctly."
      : "User answered incorrectly.";

  return {
    content: [
      {
        type: "text" as const,
        text: `${verdict}\nCorrect: ${correctText}\nExplanation: ${explanation}`,
      },
    ],
    // Raw selected labels/values remain ephemeral here. Scholar's index owns
    // any intentionally reduced persistence or Obsidian projection.
    details: {
      status: "answered" as const,
      question,
      context,
      mode,
      options: toScholarQuizDisplayedOptions(options),
      answers: response.answers,
      correctIndices,
      correct,
      dontKnow: response.dontKnow,
      explanation,
    } satisfies QuizResultDetails,
  };
}

export function registerScholarQuiz(pi: ExtensionAPI): void {
  pi.registerTool({
    name: SCHOLAR_QUIZ_TOOL_NAME,
    label: "Scholar quiz",
    description:
      "Ask one source-bound graded Scholar question, collect a single- or multi-select answer, then reveal immediate feedback. Options are shuffled by default and a distinct I don't know choice is added automatically.",
    promptSnippet:
      "Use scholar_quiz for Scholar's graded multiple-choice checks. Supply stable option values, the correct value(s), and a post-answer explanation.",
    promptGuidelines: [
      "Set kind to the check being assessed (conceptual, application, computation, or discrimination). Read the saved progress in the result: stop when complete; follow-up questions are practice only.",
      "grounding is mandatory. It names the competency, observable evidence, in-scope PDF pages, and exact saved teaching basis. Scholar blocks unsupported questions before the picker opens.",
      "The guard constrains fairness, never rigor. Continue to use demanding computation, misconception discrimination, independent generation, and novel transfer when the competency supports them.",
      "correctAnswer is required and must contain option value strings, never position numbers. Invalid values are rejected before the picker opens.",
      "explanation is required and is hidden until the learner submits.",
      "Provide only real gradable choices. Scholar adds I don't know automatically; never add an uncertainty or opt-out choice.",
      "Use multiSelect only when two or more choices are jointly correct; grading requires an exact set match.",
      "Options shuffle by default. Set shuffle false only when their order is substantively meaningful.",
      // Question construction and adaptation live only in the
      // shared QUESTION_ENGINE_POLICY injected by every Scholar mode.
    ],
    parameters: ScholarQuizParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const question = params.question.trim();
      const context = params.details?.trim() || undefined;
      const explanation = params.explanation.trim();
      const mode: QuizMode = params.multiSelect ? "multi-select" : "single-select";

      if (!question) return unavailableResult(params.question, mode, "scholar_quiz requires a question", context);
      if (!explanation) {
        return unavailableResult(question, mode, "scholar_quiz requires a non-empty explanation", context);
      }

      let options: QuizOption[];
      try {
        options = normalizeOptions(params.options);
      } catch (error) {
        return unavailableResult(
          question,
          mode,
          `scholar_quiz ${error instanceof Error ? error.message : String(error)}`,
          context,
        );
      }
      if (options.length < 2) {
        return unavailableResult(question, mode, "scholar_quiz requires at least two options", context);
      }
      if (params.shuffle !== false) options = shuffleOptions(options);

      const resolved = resolveCorrect(params.correctAnswer as string | string[], options, mode);
      if (resolved.error) {
        return unavailableResult(question, mode, `scholar_quiz ${resolved.error}`, context);
      }
      if (signal?.aborted) return cancelledResult(question, mode, context);
      if (!ctx.hasUI) {
        return unavailableResult(question, mode, "scholar_quiz requires interactive mode UI", context);
      }

      // This pre-answer update deliberately contains neither the key nor the
      // explanation. It only exposes the true post-shuffle display order.
      onUpdate?.({
        content: [{ type: "text", text: "Awaiting learner response..." }],
        details: { options: toScholarQuizDisplayedOptions(options) } satisfies QuizProgressDetails,
      });

      return getSharedUiLock().withLock(async () => {
        if (signal?.aborted) return cancelledResult(question, mode, context);
        const response = await askChoice(
          ctx,
          question,
          context,
          options,
          mode,
        );
        if (!response) return cancelledResult(question, mode, context);
        return answeredResult(question, context, mode, options, response, resolved.indices, explanation);
      });
    },

    renderCall(args, theme) {
      const count = Array.isArray(args.options) ? args.options.length : 0;
      let text = theme.fg("toolTitle", theme.bold("Scholar quiz"));
      text += theme.fg("muted", " · validating grounding");
      if (args.multiSelect) text += theme.fg("dim", " [multi-select]");
      if (count > 0) text += theme.fg("dim", ` (${count} ${count === 1 ? "option" : "options"})`);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const details = result.details as QuizResultDetails | undefined;
      if (!details || !["answered", "cancelled", "unavailable"].includes(details.status)) {
        const message = result.content.find((item) => item.type === "text")?.text || "Scholar quiz unavailable";
        return new Text(theme.fg("warning", message), 0, 0);
      }
      if (details.status !== "answered") {
        return new Text(theme.fg("warning", details.message || `Scholar quiz ${details.status}`), 0, 0);
      }

      const selected = new Set((details.answers || []).map((answer) => answer.index));
      const correct = new Set(details.correctIndices || []);
      const lines: string[] = [];
      for (const option of details.options || []) {
        const chosen = selected.has(option.index);
        const isKey = correct.has(option.index);
        const marker = details.dontKnow
          ? isKey ? theme.fg("success", "✓ ") : "  "
          : chosen && !isKey ? theme.fg("error", "✗ ") : isKey ? theme.fg("success", "✓ ") : "  ";
        const color = chosen && !isKey ? "error" : isKey ? "success" : "dim";
        lines.push(`${marker}${theme.fg(color, `${option.index}. ${option.label}`)}`);
      }
      lines.push("");
      lines.push(
        details.dontKnow
          ? theme.fg("warning", "I don't know")
          : details.correct
            ? theme.fg("success", "Correct!")
            : theme.fg("error", "Incorrect"),
      );
      if (details.explanation) lines.push(theme.fg("muted", details.explanation));
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}
