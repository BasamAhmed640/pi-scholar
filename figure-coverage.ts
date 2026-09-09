import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { snapshotAssetPath } from "./obsidian-paths.ts";
import { safePathWithinRoot } from "./storage.ts";
import { allSections, type FigurePageReview, type ScholarBook, type ScholarConfig, type ScholarSection } from "./types.ts";

const clean = (text: string) => text.replace(/\s+/g, " ").trim();
const headingKey = (text: string) => clean(text).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export function nextSourceSection(book: ScholarBook, section: ScholarSection): ScholarSection | undefined {
  const sections = allSections(book);
  const index = sections.findIndex((item) => item.id === section.id);
  return index < 0 ? undefined : sections[index + 1];
}

/** Match a complete frozen heading, never a prose mention of its number. */
function headingLine(lines: string[], section: ScholarSection): number {
  const expected = headingKey(`${section.number || ""} ${section.title}`);
  for (let index = 0; index < lines.length; index++) {
    if (headingKey(lines[index]!) === expected
      || headingKey(`${lines[index]} ${lines[index + 1] || ""}`) === expected) return index;
  }
  return -1;
}

function withoutRunningHeader(text: string): string {
  return text.split("\n").filter((line, index) => index > 4
    || !/^\s*(?:\[Page \d+\]|\d+\s*$|\d+\s+.*\bChapter\b|Chapter\s+\d+\b.*\s+\d+\s*$)/i.test(line)).join("\n").trim();
}

/** Caption candidates need a caption-shaped line, not merely a Figure reference. */
export function detectFigureLabels(text: string): string[] {
  const labels = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(Figure|Fig\.?|Table|Plate|Diagram|Graph|Map)\s+(\d+(?:[.\-–]\d+)*[a-z]?)(?:\s*[:.\-–—]\s*|\s+|$)(.*)$/i.exec(line);
    if (!match) continue;
    const tail = match[3]!.trim();
    // Line-wrapped cross references often begin with Figure N shows/is/... .
    if (!tail || /^(?:shows?|illustrates?|depicts?|presents?|provides?|summarizes?|compares?|is|are|was|were|can|will|also|above|below|and|or|in|on|of)\b/i.test(tail)
      || /^[a-z]/.test(tail)) continue;
    const kind = /^fig/i.test(match[1]!) ? "Figure" : `${match[1]![0]!.toUpperCase()}${match[1]!.slice(1).toLowerCase()}`;
    labels.add(`${kind} ${match[2]!.replace(/–/g, "-")}`);
  }
  return [...labels];
}

/** A single adjacent-page probe may prove that the prior section continues. */
export function hasSharedBoundaryContinuation(section: ScholarSection, next: ScholarSection, text: string): boolean {
  if (section.endPage !== next.startPage - 1) return false;
  const lines = text.split(/\r?\n/);
  const boundary = headingLine(lines, next);
  if (boundary < 0) return false;
  const prefix = withoutRunningHeader(lines.slice(0, boundary).join("\n"));
  return detectFigureLabels(prefix).length > 0
    || (prefix.match(/\p{L}+/gu)?.length || 0) >= 24 && /[.!?]/.test(prefix);
}

/** Exclude a neighboring section's body on a legitimately shared PDF page. */
export function sectionPageText(book: ScholarBook, section: ScholarSection, page: number, text: string): string {
  let lines = text.split(/\r?\n/);
  const next = nextSourceSection(book, section);
  if (next?.startPage === page) {
    const boundary = headingLine(lines, next);
    if (boundary < 0) throw new Error(`The next section heading on shared PDF page ${page} could not be established from extracted text. View this boundary page and correct the frozen heading before reading across it.`);
    lines = lines.slice(0, boundary);
  }
  if (section.startPage === page) {
    const start = headingLine(lines, section);
    if (start >= 0) lines = lines.slice(start);
    else {
      const sections = allSections(book), index = sections.findIndex((item) => item.id === section.id);
      if (index > 0 && sections[index - 1]!.endPage === page) throw new Error(`The active section heading on shared PDF page ${page} could not be established from extracted text. View this boundary page and correct the frozen heading before reading across it.`);
    }
  }
  return lines.join("\n").trim();
}

export function extractedPages(source: string, start: number, end: number): Array<{ page: number; text: string }> {
  const markers = [...source.matchAll(/^\[Page (\d+)\]\r?\n/gm)];
  const pages: Array<{ page: number; text: string }> = [];
  for (let index = 0; index < markers.length; index++) {
    const marker = markers[index]!;
    const page = Number(marker[1]);
    if (page !== start + index || page > end) return [];
    const text = source.slice(marker.index! + marker[0].length, markers[index + 1]?.index).trim();
    if (text.includes("[Scholar: excerpt truncated;")) break;
    pages.push({ page, text });
  }
  return pages;
}

export function recordLearnRead(book: ScholarBook, section: ScholarSection, source: string, start: number, end: number): void {
  section.figureCoverage ||= { pages: [] };
  for (const { page, text } of extractedPages(source, start, end)) {
    if (page < section.startPage || page > section.endPage) continue;
    let entry = section.figureCoverage.pages.find((item) => item.page === page);
    if (!entry) {
      entry = { page, read: true, candidates: [] };
      section.figureCoverage.pages.push(entry);
    }
    entry.read = true;
    const labels = detectFigureLabels(sectionPageText(book, section, page, text));
    entry.candidates = [...new Set([...entry.candidates, ...labels])];
    if (entry.review && entry.candidates.some((label) => !entry!.review!.figures.some((figure) => figure.label === label))) delete entry.review;
  }
  section.figureCoverage.pages.sort((a, b) => a.page - b.page);
}

export function recordLearnView(section: ScholarSection, page: number, width: number, height: number): void {
  section.figureCoverage ||= { pages: [] };
  let entry = section.figureCoverage.pages.find((item) => item.page === page);
  if (!entry) {
    entry = { page, read: false, candidates: [] };
    section.figureCoverage.pages.push(entry);
  }
  entry.viewed = { width, height };
}

async function verifySnapshot(config: ScholarConfig, book: ScholarBook, section: ScholarSection, page: number, snapshotId: string): Promise<void> {
  const snapshot = section.snapshots?.find((item) => item.id === snapshotId && item.page === page);
  if (!snapshot) throw new Error(`Figure coverage needs a saved snapshot from page ${page}: ${snapshotId}.`);
  const path = await safePathWithinRoot(config.obsidianRoot, snapshotAssetPath(config, book, snapshot));
  let bytes: Buffer;
  try { bytes = await readFile(path); }
  catch { throw new Error(`The saved figure image for page ${page} is missing. Save its source snapshot again before checking understanding.`); }
  if (createHash("sha256").update(bytes).digest("hex") !== snapshot.sha256) {
    throw new Error(`The saved figure image for page ${page} no longer matches its source snapshot. Restore it before checking understanding.`);
  }
}

export async function validateFigureReviews(config: ScholarConfig, book: ScholarBook, section: ScholarSection, reviews: FigurePageReview[]): Promise<FigurePageReview[]> {
  if (!Array.isArray(reviews) || reviews.length > section.endPage - section.startPage + 1) throw new Error("Figure reviews must describe pages in the active Learn section.");
  const seen = new Set<number>();
  const normalized: FigurePageReview[] = [];
  for (const review of reviews) {
    if (!review || typeof review !== "object" || Array.isArray(review)) throw new Error("Each figure review must be a page review object.");
    const page = review.page;
    if (!Number.isSafeInteger(page) || page < section.startPage || page > section.endPage || seen.has(page)) throw new Error("Figure reviews need distinct pages in the active Learn section.");
    seen.add(page);
    const entry = section.figureCoverage?.pages.find((item) => item.page === page);
    if (!entry?.read || !entry.viewed) throw new Error(`Read and view PDF page ${page} before recording its figure review.`);
    if (typeof review.observation !== "string") throw new Error(`Page ${page} needs a written visual observation.`);
    const observation = clean(review.observation);
    if (observation.length < 12 || observation.length > 500 || !Array.isArray(review.figures) || review.figures.length > 40) throw new Error(`Page ${page} needs a concise visual observation and a list of its source figures (empty only if none belong to this section).`);
    const labels = new Set<string>();
    const figures: FigurePageReview["figures"] = [];
    for (const figure of review.figures) {
      if (!figure || typeof figure !== "object" || Array.isArray(figure)
        || typeof figure.label !== "string" || (figure.snapshotId !== undefined && typeof figure.snapshotId !== "string")
        || (figure.skipReason !== undefined && typeof figure.skipReason !== "string")) throw new Error(`Each figure on page ${page} needs a written label and snapshotId or skipReason.`);
      const label = clean(figure.label);
      const snapshotId = figure.snapshotId?.trim();
      const skipReason = clean(figure.skipReason || "");
      if (!label || label.length > 160 || labels.has(label) || Boolean(snapshotId) === Boolean(skipReason)) throw new Error(`Each figure on page ${page} needs a distinct label and either a saved snapshotId or an explicit skipReason.`);
      labels.add(label);
      if (skipReason && (skipReason.length < 20 || skipReason.length > 500)) throw new Error(`Explain specifically why ${label} is decorative, duplicate, fully redundant, or belongs outside the active section.`);
      if (snapshotId) await verifySnapshot(config, book, section, page, snapshotId);
      figures.push({ label, ...(snapshotId ? { snapshotId } : { skipReason }) });
    }
    const missing = entry.candidates.filter((label) => !labels.has(label));
    if (missing.length) throw new Error(`Account for the source caption(s) on page ${page}: ${missing.join(", ")}. Save a crop or give each an explicit justified skip.`);
    normalized.push({ page, observation, figures });
  }
  return normalized;
}

export function applyFigureReviews(section: ScholarSection, reviews: FigurePageReview[]): void {
  for (const review of reviews) {
    const page = section.figureCoverage?.pages.find((item) => item.page === review.page);
    if (!page?.read || !page.viewed) throw new Error(`The visual review for page ${review.page} is no longer current; read and view it again.`);
    page.review = review;
  }
}

export function pendingFigurePages(section: ScholarSection): number[] {
  const pending: number[] = [];
  for (let page = section.startPage; page <= section.endPage; page++) {
    const entry = section.figureCoverage?.pages.find((item) => item.page === page);
    if (!entry?.read || !entry.viewed || !entry.review
      || entry.candidates.some((label) => !entry.review!.figures.some((figure) => figure.label === label))) pending.push(page);
  }
  return pending;
}

export async function assertLearnFigureCoverage(config: ScholarConfig, book: ScholarBook, section: ScholarSection): Promise<void> {
  const pending = pendingFigurePages(section);
  if (pending.length) throw new Error(`Finish the source figures before practice or mastery checks: read/view PDF page(s) ${pending.join(", ")}, save every useful source visual, then record notes.figureReviews with saved snapshot IDs or specific justified skips. Include vector diagrams even when text extraction found no caption.`);
  for (const entry of section.figureCoverage!.pages) {
    for (const figure of entry.review?.figures || []) {
      if (figure.snapshotId) await verifySnapshot(config, book, section, entry.page, figure.snapshotId);
    }
  }
}
