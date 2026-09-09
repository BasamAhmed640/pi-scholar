import { relative, resolve } from "node:path";
import { referenceImageAssetPath } from "../obsidian-paths.ts";
import type {
  AssessmentAttempt,
  ScholarBook,
  ScholarConfig,
  ScholarReferenceImage,
  ScholarSection,
  SectionStatus,
  TranscriptEntry,
} from "../types.ts";

export const GENERATED_START = "<!-- scholar:generated:start -->";
export const GENERATED_END = "<!-- scholar:generated:end -->";
export const LEGACY_HOME_TAIL_START = "<!-- scholar:legacy-home-tail:start -->";
export const LEGACY_HOME_TAIL_END = "<!-- scholar:legacy-home-tail:end -->";
export const LEGACY_BOOK_HUB_TAIL_START = "<!-- scholar:legacy-book-hub-tail:start -->";
export const LEGACY_BOOK_HUB_TAIL_END = "<!-- scholar:legacy-book-hub-tail:end -->";

export function yaml(value: string): string {
  return JSON.stringify(value);
}

export function markdownText(value: string): string {
  return value
    .replaceAll(GENERATED_START, "&lt;!-- scholar:generated:start --&gt;")
    .replaceAll(GENERATED_END, "&lt;!-- scholar:generated:end --&gt;")
    .replace(/\r\n?/g, "\n")
    .trim();
}

export function wikiAlias(value: string): string {
  return value.replace(/[\[\]|]/g, " ").replace(/\s+/g, " ").trim();
}

export function portableRelative(fromDirectory: string, target: string): string {
  const value = relative(fromDirectory, target).replace(/\\/g, "/").replace(/\.md$/i, "");
  return value.startsWith(".") ? value : `./${value}`;
}

export function wikiLink(fromNote: string, targetNote: string, alias: string): string {
  return `[[${portableRelative(resolve(fromNote, ".."), targetNote)}|${wikiAlias(alias)}]]`;
}

/** Markdown tables split on pipes even inside Obsidian links. */
export function tableText(value: string): string {
  return markdownText(value).replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

export function tableWikiLink(fromNote: string, targetNote: string, alias: string): string {
  return tableText(wikiLink(fromNote, targetNote, alias));
}

export function block(heading: string, lines: string[]): string[] {
  if (!lines.some((line) => line.trim())) return [];
  return [heading, "", ...lines, ""];
}

export function collapsedRecord(title: string, lines: string[], type = "note"): string[] {
  if (!lines.some((line) => line.trim())) return [];
  // An unquoted blank line terminates the Markdown blockquote. Keep both
  // boundaries so adjacent records cannot become one collapsed callout.
  return [
    "",
    `> [!${type}]- ${markdownText(title).replace(/\n/g, " ")}`,
    ...markdownText(lines.join("\n")).split("\n").map((line) => line ? `> ${line}` : ">"),
    "",
  ];
}

export function wikiEmbed(fromNote: string, targetAsset: string, width?: number): string {
  const value = relative(resolve(fromNote, ".."), targetAsset).replace(/\\/g, "/");
  const portable = value.startsWith(".") ? value : `./${value}`;
  return `![[${portable}${width ? `|${width}` : ""}]]`;
}

export function untrustedInline(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/([\\`*_[\]<>])/g, "\\$1");
}

export function referenceImageLines(
  config: ScholarConfig,
  book: ScholarBook,
  notePath: string,
  images: ScholarReferenceImage[] | undefined,
): string[] {
  return [...(images || [])]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    .flatMap((image, index) => [
      ...(index > 0 ? [""] : []),
      `> [!example] Visual reference ${index + 1}`,
      ...[
        wikiEmbed(notePath, referenceImageAssetPath(config, book, image), 700),
        "",
        `*${markdownText(image.caption)}*`,
        "",
        `**Source:** ${untrustedInline(image.title)} · <${image.sourceUrl}>`,
        `**Creator:** ${untrustedInline(image.artist)}`,
        `**License:** ${untrustedInline(image.license)}${image.licenseUrl ? ` · <${image.licenseUrl}>` : ""}`,
      ].join("\n").split("\n").map((line) => line ? `> ${line}` : ">"),
    ]);
}

/**
 * Scholar's single materialization contract. An unstarted section has no note
 * on disk, so no projection may link to one. Selecting a range for an Exam or
 * a Tutor session deliberately does not materialize its sections: choosing to
 * be examined on material is not the same as studying it. Every projection —
 * the chapter checklist, exam/tutor scope lines, and the disk writer — must
 * share this predicate so they cannot drift apart again.
 */
export function isSectionMaterialized(book: ScholarBook, section: ScholarSection): boolean {
  return section.status !== "not-started" || section.id === book.currentSectionId;
}

export function statusGlyph(status: SectionStatus): string {
  switch (status) {
    case "complete":
      return "✅";
    case "review":
      return "⚠️";
    case "learning":
      return "🟡";
    default:
      return "⬜";
  }
}

export function statusLabel(status: SectionStatus): string {
  switch (status) {
    case "complete":
      return "Complete";
    case "review":
      return "Needs review";
    case "learning":
      return "In progress";
    default:
      return "Not started";
  }
}

export function progress(completed: number, total: number): { percent: number; bar: string } {
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
  const filled = Math.max(0, Math.min(10, Math.round(percent / 10)));
  return { percent, bar: `${"█".repeat(filled)}${"░".repeat(10 - filled)}` };
}

export function frontmatter(lines: string[]): string {
  const noteType = lines.find((line) => /^type: scholar-(home|book|chapter|section|exam|exam-paper|answer-key|tutor)$/.test(line))?.slice(6);
  return [
    "---", ...lines, "cssclasses:", "  - alvar-learning", "  - scholar-note",
    ...(noteType ? [`  - ${noteType}`] : []), "tags:", "  - scholar", "---",
  ].join("\n");
}

export function generatedDocument(header: string, body: string): string {
  return `${header}\n${GENERATED_START}\n${body.trim()}\n${GENERATED_END}\n`;
}

export function removeLeadingFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

/**
 * Raised only when a note's generated boundary is genuinely ambiguous, so the
 * caller cannot tell Scholar's own output from the reader's writing. The body
 * travels with the error: recovery quarantines that text rather than losing it.
 */
export class GeneratedMarkerError extends Error {
  /** The note body, marker-neutralized, ready to place in a quarantine block. */
  readonly quarantineBody: string;

  constructor(reason: string, quarantineBody = "") {
    super(`Scholar found ${reason}.`);
    this.name = "GeneratedMarkerError";
    this.quarantineBody = quarantineBody;
  }
}

export const QUARANTINE_START = "<!-- scholar:quarantine:start -->";
export const QUARANTINE_END = "<!-- scholar:quarantine:end -->";

/**
 * Defuse every Scholar comment marker in recovered text.
 *
 * Quarantined text is written back into a live note, so any marker it still
 * contains would be parsed on the next projection and re-break the note it was
 * meant to rescue. Escaping the opening delimiter leaves the text readable
 * while making the line unmatchable as a marker.
 */
export function neutralizeScholarMarkers(text: string): string {
  return text.replace(/<!--(\s*\/?\s*scholar:)/gi, "&lt;!--$1");
}

const QUARANTINE_NOTICE = [
  "> [!warning] Recovered text",
  "> Scholar could not read this note's generated markers, so it rebuilt the note",
  "> and kept the earlier text here. Move anything worth keeping above this block,",
  "> then delete the block.",
];
/** A quarantine delimiter, still live or already escaped by a previous rescue. */
const QUARANTINE_DELIMITER = /^\s*(?:&lt;|<)!--\s*\/?\s*scholar:quarantine:(?:start|end)\s*-->\s*$/;

/** Preserve unreadable note text below the rebuilt region instead of freezing the note. */
export function quarantineBlock(body: string): string {
  // A note that breaks twice must end with one block, not a Russian doll: drop
  // the previous rescue's own delimiters and notice so its contents are carried
  // forward into a single block rather than wrapped inside a new one.
  const notice = new Set(QUARANTINE_NOTICE);
  const unwrapped = body
    .split(/\r\n|\n|\r/)
    .filter((line) => !QUARANTINE_DELIMITER.test(line) && !notice.has(line.trimEnd()))
    .join("\n");
  const kept = neutralizeScholarMarkers(unwrapped).trim();
  if (!kept) return "";
  return [QUARANTINE_START, ...QUARANTINE_NOTICE, "", kept, QUARANTINE_END].join("\n");
}

export function preservedUserContent(content: string, requireGeneratedRegion = false): string {
  const body = removeLeadingFrontmatter(content);
  const markers: { kind: string; index: number; length: number }[] = [];
  let fence: { character: string; length: number } | undefined;
  // Handwritten tails can document these tags inline or in fenced examples.
  // Only standalone markers outside Markdown fences delimit generated regions.
  for (const match of body.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)) {
    const line = match[0].replace(/[\r\n]+$/, "");
    if (fence) {
      const closing = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
      if (closing && closing[1]![0] === fence.character && closing[1]!.length >= fence.length) fence = undefined;
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (opening && (opening[1]![0] !== "`" || !opening[2]!.includes("`"))) {
      fence = { character: opening[1]![0]!, length: opening[1]!.length };
      continue;
    }
    const marker = /^ {0,3}(<!-- scholar:generated:(start|end) -->)[ \t]*$/.exec(line);
    if (marker) markers.push({ kind: marker[2]!, index: match.index! + line.indexOf(marker[1]!), length: marker[1]!.length });
  }
  if (markers.length === 0) {
    if (requireGeneratedRegion) throw new GeneratedMarkerError("no generated markers", body);
    return `\n\n${body}`;
  }

  // Remove every complete generated region, retaining text between duplicate
  // regions as well as the final handwritten tail. Nested and orphan markers
  // admit two readings of the same bytes, so they are handed to the caller for
  // quarantine rather than guessed at.
  const preserved: string[] = [];
  let cursor = 0;
  let inGeneratedRegion = false;
  for (const marker of markers) {
    const index = marker.index;
    if (marker.kind === "start") {
      if (inGeneratedRegion) throw new GeneratedMarkerError("nested generated markers", body);
      const outside = body.slice(cursor, index);
      if (cursor > 0 || outside.trim()) preserved.push(outside);
      inGeneratedRegion = true;
    } else {
      if (!inGeneratedRegion) throw new GeneratedMarkerError("an orphan generated end marker", body);
      inGeneratedRegion = false;
      cursor = index + marker.length;
    }
  }
  // An unclosed region is safe to discard only when the note truly has no end
  // marker: a truncated write stops before ever emitting one, so nothing after
  // the dangling start can be the reader's writing, and that span is Scholar's
  // own unfinished output which every projection rewrites anyway.
  //
  // The line scanner can also MISS a real end marker — swallowed by an unclosed
  // code fence above it, indented four spaces, or carrying trailing text. Those
  // notes look identical here but do have a reader tail below that marker, and
  // discarding it would destroy their writing. So trust the raw text over the
  // scan: if the end delimiter appears anywhere at all, treat the note as
  // ambiguous and let the caller quarantine it instead of healing.
  if (inGeneratedRegion) {
    if (/<!--\s*scholar:generated:end\s*-->/i.test(body)) {
      throw new GeneratedMarkerError("a generated end marker it could not read", body);
    }
    const healed = preserved.join("");
    return healed.trim() ? healed : "";
  }
  const remainder = body.slice(cursor);
  if (!remainder.trim()) {
    const combined = preserved.join("");
    return combined.trim() ? combined : "";
  }
  preserved.push(remainder);
  return preserved.join("");
}

export function pageRange(startPage: number, endPage: number): string {
  if (startPage <= 0 && endPage <= 0) return "Source pages pending";
  return startPage === endPage ? `Page ${startPage}` : `Pages ${startPage}–${endPage}`;
}

export function transcriptCallout(entry: TranscriptEntry): string[] {
  const body = markdownText(entry.markdown);
  if (!body) return [];
  const presentation = entry.kind === "question"
    ? { type: "question", title: "Question" }
    : entry.kind === "result"
      ? { type: "example", title: "Result" }
      : { type: "abstract", title: "Scholar" };
  return [
    `> [!${presentation.type}] ${presentation.title}`,
    ...body.split("\n").map((line) => line.length > 0 ? `> ${line}` : ">"),
  ];
}

export function transcriptLines(entries: TranscriptEntry[]): string[] {
  const callouts = entries.map(transcriptCallout).filter((rendered) => rendered.length > 0);
  const lines = callouts.flatMap((rendered, index) => [...(index > 0 ? [""] : []), ...rendered]);
  return lines.length > 0 ? lines : ["> [!info] No assistant transcript has been recorded yet."];
}

export function titleCase(value: string): string {
  return value.replace(/(^|[-\s])\p{L}/gu, (letter) => letter.toUpperCase());
}

export function readableOutcome(outcome: AssessmentAttempt["outcome"]): string {
  switch (outcome) {
    case "pass":
      return "Passed";
    case "review":
      return "Needs review";
    case "unsure":
      return "Unsure";
    case "cancelled":
      return "Cancelled";
    case "unavailable":
      return "Unavailable";
    default:
      return "Pending";
  }
}

export function unknownMarkdown(value: unknown): string {
  if (typeof value === "string") return markdownText(value);
  if (Array.isArray(value)) return value.map(unknownMarkdown).filter(Boolean).join(", ");
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}
