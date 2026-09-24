import { createHash } from "node:crypto";
import { markdownText } from "./render/common.ts";
import { pageInRanges, scopedPageRanges } from "./page-scope.ts";
import { resolveLessonFigures } from "./lesson-figures.ts";
import { normalizeObsidianMath } from "./math-formatting.ts";
import { renderKeyEquations, type KeyEquation } from "./equation-presentation.ts";
import { renderLessonDiagrams, type LessonDiagram } from "./diagram-presentation.ts";
import { sourceCoverageIssues, reviewUnitIssues, type ReviewRole } from "./learn-quality.ts";
import { recordValidatedLessonRevision } from "./history.ts";
import type { AssessmentKind, ScholarBook, ScholarConfig, ScholarSection, TranscriptEntry, TutorSession } from "./types.ts";

export type LessonInput = { id: string; title: string; markdown: string; objectives: string[]; keyPoints: string[]; sourcePages: number[]; keyEquations?: KeyEquation[]; diagrams?: LessonDiagram[]; expectedContentHash?: string };
export type LessonPatch = { id: string; expectedContentHash: string; edits?: Array<{ oldText: string; newText: string }>;
  calloutEdits?: Array<{ oldText: string; equation?: KeyEquation; diagram?: LessonDiagram; snapshotId?: string; replacesSnapshotId?: string }> };
export type LessonReceipt = Omit<LessonInput, "id" | "markdown" | "expectedContentHash" | "keyEquations" | "diagrams"> & { contentHash: string; sourceHash: string; keyEquationIds?: string[]; diagramIds?: string[]; embeddedSnapshotIds?: string[] };
export type LessonCommit = { entryIds: string[]; contentHash: string; sourceHash: string };
export type ObjectiveCheck = { objective: string; checks: AssessmentKind[] };
const checks = new Set(["conceptual", "application", "computation", "discrimination"]);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string" && item.trim().length > 0) && new Set(value).size === value.length;
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f\d]{64}$/.test(value);
export const lessonHash = (value: string): string => createHash("sha256").update(value.replace(/\r\n/g, "\n").trim()).digest("hex");
const savedLessonId = (record: ScholarSection | TutorSession, id: string): string => record.transcript.some(entry => entry.id === id && entry.lesson)
  || record.lessonEntryIds?.includes(id) ? id : `lesson-${id}`;

export function isLessonReceipt(value: any): value is LessonReceipt {
  return value && Object.keys(value).every(key => ["title", "objectives", "keyPoints", "sourcePages", "contentHash", "sourceHash", "keyEquationIds", "diagramIds", "embeddedSnapshotIds"].includes(key))
    && (value.keyEquationIds === undefined || strings(value.keyEquationIds))
    && (value.diagramIds === undefined || strings(value.diagramIds))
    && (value.embeddedSnapshotIds === undefined || strings(value.embeddedSnapshotIds))
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
    if (!fence && /^#{1,2}\s/.test(raw)) issues.push("use a subsection heading (###), not another top-level page title or H2 inside the lesson");
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
        if (!display && inlineStart === undefined && /^(?:[∇∂∑∫][²³]?[·×]?[A-Za-zΑ-ω]|[A-Za-zΑ-ω][₀-₉]+\s*[=+−])/.test(visible.slice(i))) {
          issues.push("wrap equations in prose with $...$; plain Unicode operators and subscripts do not typeset as mathematics");
        }
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

/** Fit the lesson under the note's own H2 without asking the model to rewrite it. */
export function normalizeLessonHeadings(markdown: string): string {
  const lines = markdown.split("\n"), headings = new Map<number, number>();
  let fence = "";
  lines.forEach((line, index) => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) { if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = ""; return; }
    if (marker) { fence = marker[1]!; return; }
    const heading = /^(#{1,6})\s/.exec(line);
    if (heading) headings.set(index, heading[1]!.length);
  });
  const shift = 3 - Math.min(3, ...headings.values());
  return shift ? lines.map((line, index) => headings.has(index)
    ? line.replace(/^#{1,6}/, "#".repeat(Math.min(6, headings.get(index)! + shift))) : line).join("\n") : markdown;
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
  let markdown = normalizeLessonHeadings(normalizeObsidianMath(markdownText(input.markdown)).trim()).replace(/\n\s*\n/g, "\n\n");
  if (input.keyEquations !== undefined || markdown.includes("[[scholar-equation:")) markdown = renderKeyEquations(markdown, input.keyEquations || [], input.sourcePages);
  const diagramResult = input.diagrams !== undefined || markdown.includes("[[scholar-diagram:") || /^ {0,3}>\s*\[!scholar-diagram\]/m.test(markdown)
    ? renderLessonDiagrams(markdown, input.diagrams || [], input.sourcePages) : { markdown, diagramIds: [] as string[] };
  markdown = diagramResult.markdown;
  const embeddedSnapshotIds = [...markdown.matchAll(/\[\[scholar-figure:([^\]]+)\]\]/g)].map(match => match[1]!);
  const issues = lessonMarkdownIssues(markdown);
  if (!/^#{1,6}\s/.test(markdown)) markdown = `### ${input.title.trim().replace(/[\r\n]+/g, " ")}\n\n${markdown}`;
  if (issues.length) throw new Error(`Repair the lesson presentation: ${issues.join("; ")}.`);
  markdown = normalizeObsidianMath(resolveLessonFigures(markdown, record, book, input.sourcePages, config)).replace(/\n\s*\n/g, "\n\n").trim();
  if (/\[\[scholar-figure:/.test(markdown)) throw new Error("An inline figure reference is incomplete.");
  const receipt: LessonReceipt = { title: input.title.trim(), objectives: input.objectives, keyPoints: input.keyPoints,
    sourcePages: input.sourcePages, sourceHash: book.source.fingerprint.sha256, contentHash: lessonHash(markdown),
    ...(input.keyEquations?.length ? { keyEquationIds: input.keyEquations.map(item => item.id) } : {}),
    ...(diagramResult.diagramIds.length ? { diagramIds: diagramResult.diagramIds } : {}),
    ...(embeddedSnapshotIds.length ? { embeddedSnapshotIds } : {}) };
  const id = savedLessonId(record, input.id);
  const finalIssues = lessonMarkdownIssues(markdown);
  if (finalIssues.length) throw new Error(`Repair the composed lesson: ${finalIssues.join("; ")}.`);
  const previous = record.transcript.find(entry => entry.id === id);
  if (previous && (lessonHash(previous.markdown) !== receipt.contentHash || JSON.stringify(previous.lesson) !== JSON.stringify(receipt))) {
    if (input.expectedContentHash !== lessonHash(previous.markdown)) throw new Error(`Lesson ${input.id} changed. Read the current visible entry before revising it and pass its expectedContentHash; a stale retry cannot overwrite it.`);
    const before = JSON.stringify(previous);
    previous.markdown = markdown;
    previous.lesson = receipt;
    recordValidatedLessonRevision(book, previous, before);
  }
  if (!previous && (input.expectedContentHash || record.lessonEntryIds?.includes(id))) throw new Error("This lesson was deleted. Do not restore it from an old retry; save a newly requested explanation with a new ID.");
  if (!previous) record.transcript.push({ id, kind: "assistant", markdown, lesson: receipt, createdAt: new Date().toISOString() });
  record.lessonEntryIds = [...new Set([...(record.lessonEntryIds || []), id])];
}

/** Exact prose repairs preserve callouts. Explicit callout replacements reuse
 * the structured equation, diagram and figure validators. */
export function patchLesson(record: ScholarSection | TutorSession, book: ScholarBook, patch: LessonPatch, config?: ScholarConfig): void {
  const edits = patch?.edits ?? [];
  const calloutEdits = patch?.calloutEdits ?? [];
  if (!patch || typeof patch.id !== "string" || !hash(patch.expectedContentHash) || !Array.isArray(edits) || !Array.isArray(calloutEdits)
    || !(edits.length + calloutEdits.length) || edits.length + calloutEdits.length > 16 || edits.some(edit => !edit || typeof edit.oldText !== "string"
      || !edit.oldText.trim() || typeof edit.newText !== "string" || edit.oldText.length > 24000 || edit.newText.length > 24000)) {
    throw new Error("lessonPatch needs id, current expectedContentHash and 1–16 exact oldText/newText edits (up to 24000 characters each).");
  }
  const id = savedLessonId(record, patch.id);
  const entry = record.transcript.find(item => item.id === id);
  if (!entry?.lesson) throw new Error("This lesson is absent from the active note. A prose patch cannot restore deleted explanations.");
  if (lessonHash(entry.markdown) !== patch.expectedContentHash || entry.lesson.contentHash !== patch.expectedContentHash
    || entry.lesson.sourceHash !== book.source.fingerprint.sha256) throw new Error("Stale lessonPatch. Read status with lessonId again; changes outside the validated lesson require a full structured revision.");
  const original = entry.markdown;
  let markdown = original;
  for (const edit of edits) {
    const oldText = edit.oldText.replace(/\r\n/g, "\n"), newText = edit.newText.replace(/\r\n/g, "\n");
    if (markdown.split(oldText).length !== 2) throw new Error("Each lessonPatch oldText must occur exactly once in the current lesson. No edits were saved.");
    markdown = markdown.replace(oldText, () => newText);
  }
  markdown = normalizeObsidianMath(markdown).trim();
  const protectedContent = (text: string) => [
    // The renderer writes contiguous quoted callout blocks. Protect every
    // quoted block, not just names that could be changed by a malformed patch.
    ...text.matchAll(/^ {0,3}>[^\n]*(?:\n {0,3}>[^\n]*)*/gm),
    ...text.matchAll(/!\[\[[^\]]+\]\]|!\[[^\]]*\]\([^\n]+?\)/g),
  ].map(match => match[0]);
  if (JSON.stringify(protectedContent(original)) !== JSON.stringify(protectedContent(markdown))
    || markdown.includes("[[scholar-") || /<!--/.test(markdown)) throw new Error("lessonPatch preserves rendered equation, figure and other callout blocks. Use a full lesson revision to change those blocks or their references.");
  let embeddedSnapshotIds = [...(entry.lesson.embeddedSnapshotIds || [])];
  const changed = new Set<string>();
  for (const edit of calloutEdits) {
    if (!edit || typeof edit.oldText !== "string" || edit.oldText.length > 24000) throw new Error("A callout edit needs the exact saved callout.");
    const old = edit.oldText.replace(/\r\n/g, "\n").trim();
    const blocks = [...markdown.matchAll(/^>[^\n]*(?:\n>[^\n]*)*/gm)].map(match => match[0]);
    if (!blocks.includes(old) || markdown.split(old).length !== 2 || changed.has(old)) throw new Error("Replace exactly one complete saved callout; no partial or duplicate targets.");
    changed.add(old);
    let replacement: string;
    if (edit.equation && !edit.diagram && !edit.snapshotId && !edit.replacesSnapshotId) {
      if (!/^> \[!(?:note|scholar-equation)\] Key equation\b/.test(old) || !entry.lesson.keyEquationIds?.includes(edit.equation.id)) throw new Error("Equation edits must preserve an existing equation ID and target a Key equation callout.");
      replacement = renderKeyEquations(`[[scholar-equation:${edit.equation.id}]]`, [edit.equation], entry.lesson.sourcePages);
    } else if (edit.diagram && !edit.equation && !edit.snapshotId && !edit.replacesSnapshotId) {
      const diagramBlocks = blocks.filter(block => /^> \[!scholar-diagram\] Diagram · /.test(block));
      const diagramIndex = diagramBlocks.indexOf(old);
      if (diagramIndex < 0 || entry.lesson.diagramIds?.[diagramIndex] !== edit.diagram.id) throw new Error("Diagram edits must preserve the ID of the targeted diagram callout.");
      replacement = renderLessonDiagrams(`[[scholar-diagram:${edit.diagram.id}]]`, [edit.diagram], entry.lesson.sourcePages).markdown;
    } else if (!edit.equation && !edit.diagram && edit.snapshotId && edit.replacesSnapshotId) {
      const previous = record.snapshots?.find(item => item.id === edit.replacesSnapshotId);
      if (!/^> \[!example\] Figure\b/.test(old) || !previous || !old.includes(previous.assetFile)
        || !embeddedSnapshotIds.includes(previous.id) || embeddedSnapshotIds.includes(edit.snapshotId)) throw new Error("Figure edits must replace one existing embedded source crop with a new scoped crop.");
      replacement = resolveLessonFigures(`[[scholar-figure:${edit.snapshotId}]]`, record, book, entry.lesson.sourcePages, config);
      embeddedSnapshotIds = embeddedSnapshotIds.map(id => id === previous.id ? edit.snapshotId! : id);
    } else throw new Error("Supply a structured equation, a same-ID diagram, or a replacement snapshot pair for each callout edit.");
    markdown = markdown.replace(old, () => replacement.trim());
  }
  const issues = lessonMarkdownIssues(markdown);
  if (issues.length) throw new Error(`Repair the prose patch presentation: ${issues.join("; ")}.`);
  if (!markdown) throw new Error("A prose patch cannot empty the lesson.");
  if (markdown === original) return;
  const before = JSON.stringify(entry);
  entry.markdown = markdown;
  entry.lesson = { ...entry.lesson, contentHash: lessonHash(markdown), ...(embeddedSnapshotIds.length ? { embeddedSnapshotIds } : {}) };
  recordValidatedLessonRevision(book, entry, before);
}

function commitHash(section: ScholarSection, entries: TranscriptEntry[]): string {
  return lessonHash(JSON.stringify([section.id, section.objectives, section.objectiveChecks,
    entries.map(entry => [entry.id, entry.lesson]), ...(section.learnQuality ? [learnReviewHash(section)] : [])]));
}

/** Exact editorial state; review receipts themselves never contribute to this hash. */
export function learnReviewHash(section: ScholarSection): string {
  return lessonHash(JSON.stringify([section.id, section.startPage, section.endPage, section.objectives,
    section.objectiveChecks, section.requiredChecks, section.synthesis, section.keyPoints, section.misconceptions,
    section.transcript.filter(entry => entry.lesson).map(entry => [entry.id, entry.markdown, entry.lesson]),
    section.snapshots, section.figureCoverage, section.learnQuality?.coverage]));
}

export function learnDeliveryIssues(section: ScholarSection, sourceHash?: string): string[] {
  if (!section.learnQuality) return [];
  return sourceCoverageIssues(section.learnQuality.coverage, {
    startPage: section.startPage, endPage: section.endPage, objectives: section.objectives, objectiveChecks: section.objectiveChecks,
    lessons: validLessonEntries(section, sourceHash).map(entry => ({ id: entry.id, markdown: entry.markdown,
      keyEquationIds: entry.lesson!.keyEquationIds, diagramIds: entry.lesson!.diagramIds,
      embeddedSnapshotIds: entry.lesson!.embeddedSnapshotIds })),
  }, { delivered: true });
}

/** The audit identity of one saved unit: the lesson revision plus the evidence its audit reads.
 * Receipts store `contentHash` (the lesson revision); the evidence revision is what decides
 * whether that audit is still current, so re-citing pages or crops re-audits the unit. */
export const lessonUnitRevision = (contentHash: string, sourcePages: readonly number[], snapshotIds: readonly string[]): string =>
  lessonHash(JSON.stringify(["lesson-unit-v1", contentHash, sourcePages, snapshotIds]));

/**
 * One saved explanation revision is one audit unit. A Learn unit is checked against its own
 * cited source pages, and visually only when it embeds saved crops that still exist; a Tutor
 * explanation is a teaching-only unit bound to the markdown hash its gate already uses.
 */
export type LessonReviewUnit = {
  key: string;
  entryId: string;
  /** The audited evidence revision. A change here means the stored receipts no longer describe this unit. */
  revision: string;
  /** The lesson revision stored receipts bind to; `validLessonEntries` keeps it `lessonHash(markdown)`. */
  contentHash: string;
  roles: ReviewRole[];
  markdown: string;
  title: string;
  keyPoints: string[];
  sourcePages: number[];
  snapshotIds: string[];
};

export function lessonReviewUnits(section: ScholarSection, sourceHash: string): LessonReviewUnit[] {
  const snapshots = new Set((section.snapshots || []).map(snapshot => snapshot.id));
  return validLessonEntries(section, sourceHash).map(entry => {
    const snapshotIds = (entry.lesson!.embeddedSnapshotIds || []).filter(id => snapshots.has(id));
    const sourcePages = [...entry.lesson!.sourcePages];
    return { key: `lesson:${entry.id}`, entryId: entry.id, contentHash: entry.lesson!.contentHash,
      revision: lessonUnitRevision(entry.lesson!.contentHash, sourcePages, snapshotIds),
      roles: ["source", "teaching", ...(snapshotIds.length ? ["visual"] as ReviewRole[] : [])],
      markdown: entry.markdown, title: entry.lesson!.title, keyPoints: [...entry.lesson!.keyPoints],
      sourcePages, snapshotIds };
  });
}

export function tutorReviewUnits(tutor: TutorSession): LessonReviewUnit[] {
  return tutor.transcript.filter(entry => entry.kind === "assistant" && entry.lesson
    && entry.lesson.contentHash === lessonHash(entry.markdown))
    .map(entry => ({ key: `lesson:${entry.id}`, entryId: entry.id, revision: lessonHash(entry.markdown),
      contentHash: entry.lesson!.contentHash, roles: ["teaching"] as ReviewRole[],
      markdown: entry.markdown, title: entry.lesson!.title, keyPoints: [...entry.lesson!.keyPoints],
      sourcePages: [...entry.lesson!.sourcePages], snapshotIds: [] }));
}

/** The per-unit gate: receipts bind to the lesson revision they stored; a unit whose evidence
 * revision changed has its superseded receipts retired before this can ever approve it. */
export function learnReviewIssues(section: ScholarSection, sourceHash: string): string[] {
  if (!section.learnQuality) return [];
  return lessonReviewUnits(section, sourceHash).flatMap(unit => reviewUnitIssues(section.learnQuality!.reviews, {
    contentHash: unit.contentHash, sourceHash, roles: unit.roles, responses: section.learnQuality!.responses,
  }).map(issue => `${unit.key}: ${issue}`));
}

export function lessonObjectiveHash(section: ScholarSection): string {
  return lessonHash(JSON.stringify([section.id, section.startPage, section.endPage, section.objectives, section.objectiveChecks, section.requiredChecks]));
}

export function lessonCoverageIssues(section: ScholarSection, sourceHash?: string): string[] {
  const entries = validLessonEntries(section, sourceHash);
  const covered = new Set(entries.flatMap(entry => entry.lesson!.objectives));
  return [
    ...learnDeliveryIssues(section, sourceHash),
    ...(!entries.length ? ["save the actual instructional explanation"] : []),
    ...section.objectives.filter(objective => !covered.has(objective)).map(objective => `explain: ${objective}`),
    ...(!section.synthesis?.trim() || !section.keyPoints.length ? ["save a recap and key points"] : []),
  ];
}

/** New Learn preparations need a diagram; legacy committed sections are not re-gated. */
export function lessonDiagramIssues(section: ScholarSection): string[] {
  return validLessonEntries(section).some(entry => {
    const ids = entry.lesson?.diagramIds || [];
    return ids.length > 0 && (entry.markdown.match(/^> \[!scholar-diagram\] Diagram · /gm) || []).length === ids.length;
  })
    ? [] : ["add at least one relevant Mermaid diagram to the Learn lesson"];
}

export function commitLesson(section: ScholarSection, book: ScholarBook): void {
  const issues = [...lessonCoverageIssues(section, book.source.fingerprint.sha256), ...learnReviewIssues(section, book.source.fingerprint.sha256)];
  if (issues.length) throw new Error(`The lesson is not ready: ${issues.join("; ")}. Save explanations in parts, then set lessonComplete=true.`);
  const entries = validLessonEntries(section, book.source.fingerprint.sha256);
  section.lessonCommit = { entryIds: entries.map(entry => entry.id), contentHash: commitHash(section, entries), sourceHash: book.source.fingerprint.sha256 };
}

/** Preparation is the window before a not-yet-complete section's lesson is saved. A
 * completed section is never "being prepared": it is reopened for practice only. */
export function lessonPreparationPending(section: ScholarSection, sourceHash?: string): boolean {
  return section.status !== "complete" && !lessonReady(section, sourceHash);
}

export function lessonReady(section: ScholarSection, sourceHash?: string): boolean {
  const earned = section.learnQuality?.earnedDelivery;
  if (earned && earned.sourceHash === (sourceHash || section.lessonCommit?.sourceHash) && earned.objectiveHash === lessonObjectiveHash(section)) return true;
  const commit = section.lessonCommit;
  if (!isLessonCommit(commit) || (sourceHash && commit.sourceHash !== sourceHash)) return false;
  const entries = validLessonEntries(section, commit.sourceHash).filter(entry => commit.entryIds.includes(entry.id));
  return entries.length === commit.entryIds.length && lessonCoverageIssues(section, commit.sourceHash).length === 0
    && learnReviewIssues(section, commit.sourceHash).length === 0
    && commit.contentHash === commitHash(section, entries);
}

export function taughtLessonBasis(record: ScholarSection | TutorSession, sourceHash: string): { objectives: Set<string>; keyPoints: Set<string> } {
  const entries = validLessonEntries(record, sourceHash);
  return { objectives: new Set(entries.flatMap(entry => entry.lesson!.objectives)), keyPoints: new Set(entries.flatMap(entry => entry.lesson!.keyPoints)) };
}
