import { createHash } from "node:crypto";
import { markdownText } from "./render/common.ts";
import { pageInRanges, scopedPageRanges } from "./page-scope.ts";
import { resolveLessonFigures } from "./lesson-figures.ts";
import { normalizeObsidianMath } from "./math-formatting.ts";
import type { AssessmentKind, ScholarBook, ScholarConfig, ScholarSection, TranscriptEntry, TutorSession } from "./types.ts";

export type LessonInput = { id: string; title: string; markdown: string; objectives: string[]; keyPoints: string[]; sourcePages: number[]; expectedContentHash?: string };
export type LessonReceipt = Omit<LessonInput, "id" | "markdown" | "expectedContentHash"> & { contentHash: string; sourceHash: string };
export type LessonCommit = { entryIds: string[]; contentHash: string; sourceHash: string };
export type ObjectiveCheck = { objective: string; checks: AssessmentKind[] };
const checks = new Set(["conceptual", "application", "computation", "discrimination"]);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string" && item.trim().length > 0) && new Set(value).size === value.length;
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f\d]{64}$/.test(value);
export const lessonHash = (value: string): string => createHash("sha256").update(value.replace(/\r\n/g, "\n").trim()).digest("hex");

export function isLessonReceipt(value: any): value is LessonReceipt {
  return value && Object.keys(value).every(key => ["title", "objectives", "keyPoints", "sourcePages", "contentHash", "sourceHash"].includes(key))
    && typeof value.title === "string" && value.title.trim().length > 0
    && strings(value.objectives) && strings(value.keyPoints)
    && Array.isArray(value.sourcePages) && value.sourcePages.length > 0
    && value.sourcePages.every((page: any) => Number.isSafeInteger(page) && page > 0)
    && new Set(value.sourcePages).size === value.sourcePages.length && hash(value.contentHash) && hash(value.sourceHash);
}
export function isLessonCommit(value: any): value is LessonCommit {
  return value && Object.keys(value).every(key => ["entryIds", "contentHash", "sourceHash"].includes(key))
    && strings(value.entryIds) && value.entryIds.length > 0 && hash(value.contentHash) && hash(value.sourceHash);
}
export function isObjectiveChecks(value: any): value is ObjectiveCheck[] {
  return Array.isArray(value) && value.every(item => item && Object.keys(item).every(key => ["objective", "checks"].includes(key))
    && typeof item.objective === "string" && item.objective.trim() && strings(item.checks) && item.checks.length > 0 && item.checks.every((kind: string) => checks.has(kind)))
    && new Set(value.map(item => item.objective)).size === value.length;
}

/** Structural validation cannot certify scientific accuracy or good teaching. */
export function lessonMarkdownIssues(markdown: string): string[] {
  const issues: string[] = [];
  if (!markdown.trim()) issues.push("save an actual explanation, not an empty lesson");
  if (/<!--\s*scholar:|^\s*>\s*\[!info\]- Scholar|^## (?:Questions|Lesson)\s*$/mi.test(markdown)) issues.push("lesson text must not contain Scholar record boundaries or reserved headings");
  let fence = "";
  let display: { depth: number; body: string } | undefined;
  const keyEquations: Array<{ depth: number; rendered: boolean }> = [];
  let equation: { depth: number; rendered: boolean } | undefined;
  const escaped = (line: string, index: number) => (/(\\*)$/.exec(line.slice(0, index))![1]!.length % 2) === 1;
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.replace(/^(?: {0,3}> ?)+/, "");
    const depth = (/^(?: {0,3}> ?)+/.exec(raw)?.[0].match(/>/g) || []).length;
    if (!fence && equation && (depth < equation.depth || /^\[!/.test(line))) {
      keyEquations.push(equation); equation = undefined;
    }
    if (!fence && /^\[!note\][+-]?\s+Key equation\b/i.test(line)) equation = { depth, rendered: false };
    if (!fence && /^#\s/.test(raw)) issues.push("use a subsection heading (###), not another top-level page title inside the lesson");
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (match && match[1]![0] === fence[0] && match[1]!.length >= fence.length && !match[2]!.trim()) fence = "";
      continue;
    }
    if (match && !display) {
      fence = match[1]!;
      if (/^(?:math|latex|tex|equation)\s*$/i.test(match[2]!.trim())) issues.push("typeset equations with $$...$$, not a math/LaTeX code fence");
      continue;
    }
    // Code examples are not mathematics. Only flag unambiguous math notation
    // inside prose code spans; plain assignments such as `x = 2` remain valid code.
    const visible = line.replace(/(`+)([^`]*?)\1(?!`)/g, (_span, _ticks, body: string) => {
      if (/(?:\\(?:frac|dfrac|sqrt|mathbf|vec|hat|cdot|times|sum|int)\b|[∑∫√×·])/.test(body)
        || /^\${1,2}[^$]+\${1,2}$/.test(body.trim())) issues.push("put mathematical notation in $...$ or $$...$$, not inline code backticks");
      return " ";
    });
    if (display && depth !== display.depth) {
      issues.push("keep both display-math delimiters inside the same callout or prose block");
      display = undefined;
    }
    let inlineStart: number | undefined;
    for (let i = 0; i < visible.length; i++) {
      if (!display && inlineStart === undefined && visible[i] === "\\" && !escaped(visible, i)) {
        if (/^[()[\]]/.test(visible.slice(i + 1))) issues.push("use Obsidian math delimiters $...$ and $$...$$ instead of \\(…\\) or \\[…\\]");
        else if (/^\\(?:frac|dfrac|sqrt|mathbf|boldsymbol|vec|hat|cdot|times|theta|alpha|beta|sum|int)\b/.test(visible.slice(i))) issues.push("wrap LaTeX notation in $...$ or $$...$$ so Obsidian renders it as mathematics");
      }
      if (visible[i] !== "$" || escaped(visible, i)) {
        if (display) display.body += visible[i];
        continue;
      }
      if (visible[i + 1] === "$") {
        if (inlineStart !== undefined) issues.push("close inline mathematics with $ before starting a display equation");
        inlineStart = undefined;
        if (display) {
          if (!display.body.trim()) issues.push("a display equation must contain mathematics");
          else if (equation) equation.rendered = true;
          display = undefined;
        } else display = { depth, body: "" };
        i++;
      } else if (!display) {
        if (inlineStart !== undefined) inlineStart = undefined;
        else if (/\S/.test(visible[i + 1] || "")) inlineStart = i;
        else issues.push("pair inline mathematics with $...$ on the same line; escape a literal dollar sign as \\$");
      }
    }
    // A lone $5 is ordinary currency, not a broken equation. Numeric equations
    // with TeX commands still need their closing delimiter.
    if (inlineStart !== undefined && !/^\d[\d,.]*(?:\s|$)/.test(visible.slice(inlineStart + 1))) issues.push("close inline mathematics with $ on the same line");
  }
  if (equation) keyEquations.push(equation);
  if (keyEquations.some(item => !item.rendered)) issues.push("a Key equation callout must contain rendered display math using $$...$$, not code backticks");
  if (fence) issues.push("close the Markdown/Mermaid code fence");
  if (display) issues.push("close the display-math block");
  return [...new Set(issues)];
}

export function validLessonEntries(record: Pick<ScholarSection, "transcript">, sourceHash?: string): TranscriptEntry[] {
  return record.transcript.filter(entry => entry.kind === "assistant" && isLessonReceipt(entry.lesson)
    && entry.lesson.contentHash === lessonHash(entry.markdown)
    && (!sourceHash || entry.lesson.sourceHash === sourceHash));
}

/** Repeated saves are idempotent; edited note content is never overwritten by a stale retry. */
export function saveLesson(record: ScholarSection | TutorSession, book: ScholarBook, input: LessonInput, config?: ScholarConfig): void {
  if (!input || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(input.id || "")) throw new Error("lesson.id needs a stable short ID; reuse it only for an identical retry.");
  if (typeof input.markdown !== "string" || typeof input.title !== "string" || !input.title.trim()
    || !strings(input.objectives) || !strings(input.keyPoints) || !Array.isArray(input.sourcePages) || !input.sourcePages.length) throw new Error("lesson needs title, markdown, objectives, keyPoints, and sourcePages.");
  const learn = "objectives" in record;
  if (learn && (!input.objectives.length || input.objectives.some(objective => !record.objectives.includes(objective)))) throw new Error("Map this explanation to exact declared section objectives.");
  if (!learn && (input.objectives.length || !input.keyPoints.length)) throw new Error("Tutor explanations use their own keyPoints and an empty objectives array.");
  const ranges = learn ? [{ startPage: record.startPage, endPage: record.endPage }] : scopedPageRanges(book, book.chapters.flatMap(chapter => chapter.sections).filter(section => record.scope.sectionIds.includes(section.id)));
  if (input.sourcePages.some(page => !Number.isSafeInteger(page) || !pageInRanges(page, ranges)) || new Set(input.sourcePages).size !== input.sourcePages.length) throw new Error("Lesson sourcePages must be unique pages in this active source scope.");
  let markdown = normalizeObsidianMath(markdownText(input.markdown)).trim().replace(/\n\s*\n/g, "\n\n");
  const issues = lessonMarkdownIssues(markdown);
  if (!/^#{1,6}\s/.test(markdown)) markdown = `### ${input.title.trim().replace(/[\r\n]+/g, " ")}\n\n${markdown}`;
  if (issues.length) throw new Error(`Repair the lesson presentation: ${issues.join("; ")}.`);
  markdown = normalizeObsidianMath(resolveLessonFigures(markdown, record, book, input.sourcePages, config));
  if (/\[\[scholar-figure:/.test(markdown)) throw new Error("An inline figure reference is incomplete.");
  const receipt: LessonReceipt = { title: input.title.trim(), objectives: input.objectives, keyPoints: input.keyPoints,
    sourcePages: input.sourcePages, sourceHash: book.source.fingerprint.sha256, contentHash: lessonHash(markdown) };
  const id = `lesson-${input.id}`;
  const finalIssues = lessonMarkdownIssues(markdown);
  if (finalIssues.length) throw new Error(`Repair the composed lesson: ${finalIssues.join("; ")}.`);
  const previous = record.transcript.find(entry => entry.id === id);
  if (previous && (lessonHash(previous.markdown) !== receipt.contentHash || JSON.stringify(previous.lesson) !== JSON.stringify(receipt))) {
    if (input.expectedContentHash !== lessonHash(previous.markdown)) throw new Error(`Lesson ${input.id} changed. Read the current visible entry before revising it and pass its expectedContentHash; a stale retry cannot overwrite it.`);
    previous.markdown = markdown;
    previous.lesson = receipt;
  }
  if (!previous && (input.expectedContentHash || record.lessonEntryIds?.includes(id))) throw new Error("This lesson was deleted. Do not restore it from an old retry; save a newly requested explanation with a new ID.");
  if (!previous) record.transcript.push({ id, kind: "assistant", markdown, lesson: receipt, createdAt: new Date().toISOString() });
  record.lessonEntryIds = [...new Set([...(record.lessonEntryIds || []), id])];
}

function commitHash(section: ScholarSection, entries: TranscriptEntry[]): string {
  return lessonHash(JSON.stringify([section.id, section.objectives, section.objectiveChecks,
    entries.map(entry => [entry.id, entry.lesson])]));
}

export function lessonCoverageIssues(section: ScholarSection, sourceHash?: string): string[] {
  const entries = validLessonEntries(section, sourceHash);
  const covered = new Set(entries.flatMap(entry => entry.lesson!.objectives));
  return [
    ...(!entries.length ? ["save the actual instructional explanation"] : []),
    ...section.objectives.filter(objective => !covered.has(objective)).map(objective => `explain: ${objective}`),
    ...(!isObjectiveChecks(section.objectiveChecks) || section.objectives.some(objective => !section.objectiveChecks!.some(item => item.objective === objective))
      || section.objectiveChecks!.some(item => !section.objectives.includes(item.objective)) ? ["declare appropriate objectiveChecks for every objective"] : []),
    ...(!section.synthesis?.trim() || !section.keyPoints.length ? ["save a recap and key points"] : []),
  ];
}

export function commitLesson(section: ScholarSection, book: ScholarBook): void {
  const issues = lessonCoverageIssues(section, book.source.fingerprint.sha256);
  if (issues.length) throw new Error(`The lesson is not ready: ${issues.join("; ")}. Save explanations in parts, then set lessonComplete=true.`);
  const entries = validLessonEntries(section, book.source.fingerprint.sha256);
  section.lessonCommit = { entryIds: entries.map(entry => entry.id), contentHash: commitHash(section, entries), sourceHash: book.source.fingerprint.sha256 };
}

export function lessonReady(section: ScholarSection, sourceHash?: string): boolean {
  const commit = section.lessonCommit;
  if (!isLessonCommit(commit) || (sourceHash && commit.sourceHash !== sourceHash)) return false;
  const entries = validLessonEntries(section, commit.sourceHash).filter(entry => commit.entryIds.includes(entry.id));
  return entries.length === commit.entryIds.length && lessonCoverageIssues(section, commit.sourceHash).length === 0
    && commit.contentHash === commitHash(section, entries);
}

export function taughtLessonBasis(record: ScholarSection | TutorSession, sourceHash: string): { objectives: Set<string>; keyPoints: Set<string> } {
  const entries = validLessonEntries(record, sourceHash);
  return { objectives: new Set(entries.flatMap(entry => entry.lesson!.objectives)), keyPoints: new Set(entries.flatMap(entry => entry.lesson!.keyPoints)) };
}
