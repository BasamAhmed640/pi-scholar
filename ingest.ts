import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import { access, mkdtemp, opendir, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  delimiter,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import type {
  BookCandidate,
  BookMetadata,
  ScholarBook,
  SourceFingerprint,
  SourceSearchHit,
} from "./types.ts";

const DEFAULT_EXTRACT_CHARS = 240_000;
const MAX_EXTRACT_CHARS = 2_000_000;
const MAX_PDF_RANGE_PAGES = 250;
const PDFINFO_MAX_BUFFER = 4 * 1024 * 1024;
const PDFTEXT_MAX_BUFFER = 96 * 1024 * 1024;

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".obsidian",
  ".pi",
  "node_modules",
  "$recycle.bin",
  "system volume information",
]);

export type InspectedBook = {
  metadata: BookMetadata;
  fingerprint: SourceFingerprint;
};

export type PdfTools = {
  pdfinfo?: string;
  pdftotext?: string;
  pdftoppm?: string;
};

const discoveredToolCache = new Map<string, string>();

export type PixelCrop = {
  x: number;
  y: number;
  width: number;
  height: number;
  canvasWidth: number;
  canvasHeight: number;
};

export type RenderedPdfPage = {
  data: string;
  mimeType: "image/png";
  bytes: number;
  width: number;
  height: number;
  scaleTo: number;
};

export type RenderedPdfCrop = RenderedPdfPage & { sha256: string };

type RankedHit = SourceSearchHit & { exact: boolean; score: number };

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  );
}

function cleanDisplayTitle(fileName: string): string {
  const withoutExtension = basename(fileName, extname(fileName));
  return (
    withoutExtension
      .replace(/[_]+/g, " ")
      .replace(/\s+/g, " ")
      .replace(/^[\s.\-–—]+|[\s.\-–—]+$/g, "") || withoutExtension
  );
}

function catalogKey(relativePath: string): string {
  const portable = relativePath.replace(/\\/g, "/");
  return process.platform === "win32" ? portable.toLocaleLowerCase("en-US") : portable;
}

/** Recursively inventories PDF books without opening or hashing their contents. */
export async function scanLibrary(libraryRoot: string): Promise<BookCandidate[]> {
  if (!libraryRoot.trim()) throw new Error("Scholar library root cannot be empty.");

  const requestedRoot = resolve(libraryRoot);
  let root: string;
  try {
    root = await realpath(requestedRoot);
  } catch {
    throw new Error(`Scholar library folder does not exist: ${requestedRoot}`);
  }

  const rootStats = await stat(root);
  if (!rootStats.isDirectory()) throw new Error(`Scholar library root is not a folder: ${root}`);

  const books: BookCandidate[] = [];
  const pendingDirectories = [root];

  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop()!;
    if (!isWithin(root, directory)) continue;

    const handle = await opendir(directory);
    for await (const entry of handle) {
      const absolutePath = resolve(directory, entry.name);
      if (!isWithin(root, absolutePath) || entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name.toLocaleLowerCase("en-US"))) {
          pendingDirectories.push(absolutePath);
        }
        continue;
      }

      if (!entry.isFile()) continue;
      if (extname(entry.name).toLocaleLowerCase("en-US") !== ".pdf") continue;

      const fileStats = await stat(absolutePath);
      const relativePath = relative(root, absolutePath);
      books.push({
        catalogKey: catalogKey(relativePath),
        absolutePath,
        relativePath,
        fileName: entry.name,
        displayTitle: cleanDisplayTitle(entry.name),
        format: "pdf",
        size: fileStats.size,
        mtimeMs: fileStats.mtimeMs,
      });
    }
  }

  return books.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath, undefined, {
      numeric: true,
      sensitivity: "base",
    }),
  );
}

async function executableFile(path: string): Promise<string | undefined> {
  try {
    const fileStats = await stat(path);
    if (!fileStats.isFile()) return undefined;
    if (process.platform !== "win32") await access(path, fsConstants.X_OK);
    return path;
  } catch {
    return undefined;
  }
}

type PdfToolName = "pdfinfo" | "pdftotext" | "pdftoppm";

function executableNames(tool: PdfToolName): string[] {
  return process.platform === "win32" ? [`${tool}.exe`, tool] : [tool];
}

async function resolveConfiguredTool(
  configured: string | undefined,
  tool: PdfToolName,
): Promise<string | undefined> {
  const value = configured?.trim().replace(/^"|"$/g, "");
  if (!value) return undefined;

  const direct = await executableFile(resolve(value));
  if (direct) return direct;

  for (const name of executableNames(tool)) {
    const fromDirectory = await executableFile(resolve(value, name));
    if (fromDirectory) return fromDirectory;
  }
  return undefined;
}

function toolSearchDirectories(): string[] {
  const common = process.platform === "win32"
    ? (() => {
        const programFiles = process.env.ProgramFiles || "C:\\Program Files";
        const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
        return [
          join(programFiles, "Calibre2", "app", "bin"),
          join(programFiles, "Calibre2"),
          join(programFilesX86, "Calibre2", "app", "bin"),
          join(programFilesX86, "Calibre2"),
          join(programFiles, "poppler", "Library", "bin"),
          join(programFiles, "Poppler", "Library", "bin"),
        ];
      })()
    : process.platform === "darwin"
      ? ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"]
      : ["/usr/local/bin", "/usr/bin"];
  const fromPath = (process.env.PATH || "")
    .split(delimiter)
    .map((part) => part.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  return [...new Set([...common, ...fromPath].map((path) => resolve(path)))];
}

async function discoverTool(
  tool: PdfToolName,
  configured: string | undefined,
): Promise<string | undefined> {
  const cacheKey = `${tool}\u0000${configured || ""}`;
  const explicitlyConfigured = await resolveConfiguredTool(configured, tool);
  if (explicitlyConfigured) {
    discoveredToolCache.set(cacheKey, explicitlyConfigured);
    return explicitlyConfigured;
  }

  const cached = discoveredToolCache.get(cacheKey);
  if (cached) {
    const available = await executableFile(cached);
    if (available) return available;
    discoveredToolCache.delete(cacheKey);
  }

  for (const directory of toolSearchDirectories()) {
    for (const name of executableNames(tool)) {
      const discovered = await executableFile(join(directory, name));
      if (discovered) {
        discoveredToolCache.set(cacheKey, discovered);
        return discovered;
      }
    }
  }
  return undefined;
}

/** Finds Poppler without invoking a shell. Environment overrides take priority. */
export async function findPdfTools(): Promise<PdfTools> {
  const [pdfinfo, pdftotext, pdftoppm] = await Promise.all([
    discoverTool("pdfinfo", process.env.PI_SCHOLAR_PDFINFO),
    discoverTool("pdftotext", process.env.PI_SCHOLAR_PDFTOTEXT),
    discoverTool("pdftoppm", process.env.PI_SCHOLAR_PDFTOPPM),
  ]);
  return { pdfinfo, pdftotext, pdftoppm };
}

function runTextCommand(
  executable: string,
  args: string[],
  options: { timeoutMs: number; maxBuffer: number; label: string },
): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      executable,
      args,
      {
        encoding: "utf8",
        maxBuffer: options.maxBuffer,
        timeout: options.timeoutMs,
        windowsHide: true,
        shell: false,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolvePromise(stdout);
          return;
        }

        const detail = String(stderr || error.message).replace(/\s+/g, " ").trim().slice(0, 500);
        rejectPromise(new Error(`Scholar could not ${options.label}: ${detail || "unknown Poppler error"}`));
      },
    );
  });
}

async function fingerprintFile(absolutePath: string): Promise<SourceFingerprint> {
  const before = await stat(absolutePath);
  if (!before.isFile()) throw new Error(`Scholar source is not a file: ${absolutePath}`);

  const hash = createHash("sha256");
  for await (const chunk of createReadStream(absolutePath)) hash.update(chunk as Buffer);

  const after = await stat(absolutePath);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error(`Scholar source changed while it was being inspected: ${absolutePath}`);
  }
  return { sha256: hash.digest("hex"), size: after.size, mtimeMs: after.mtimeMs };
}

function parsePdfInfo(output: string, fallbackTitle: string): BookMetadata {
  const fields = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^([^:]+):\s*(.*)$/.exec(line);
    if (match) fields.set(match[1]!.trim().toLocaleLowerCase("en-US"), match[2]!.trim());
  }

  const title = fields.get("title")?.replace(/[\u0000-\u001f]+/g, " ").trim() || fallbackTitle;
  const authorField = fields.get("author") || "";
  const authors = authorField
    .split(/\s*(?:;|\band\b)\s*/i)
    .map((author) => author.trim())
    .filter(Boolean);
  const parsedPages = Number.parseInt(fields.get("pages") || "", 10);

  const descriptiveMetadata = [
    fields.get("edition"),
    fields.get("subject"),
    fields.get("keywords"),
  ]
    .filter(Boolean)
    .join(" ");
  const edition = descriptiveMetadata.match(
    /\b(?:(?:\d+)(?:st|nd|rd|th)|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+edition\b/i,
  )?.[0];

  const isbnMetadata = [fields.get("isbn"), fields.get("subject"), fields.get("keywords")]
    .filter(Boolean)
    .join(" ");
  const isbn = isbnMetadata.match(/\b(?:97[89][\s-]?)?(?:\d[\s-]?){8,11}[\dXx]\b/)?.[0]?.trim();

  return {
    title,
    authors,
    ...(edition ? { edition } : {}),
    ...(isbn ? { isbn } : {}),
    ...(Number.isSafeInteger(parsedPages) && parsedPages > 0 ? { pageCount: parsedPages } : {}),
  };
}

/** Reads authoritative metadata and computes a full-content fingerprint. */
export async function inspectBook(candidate: BookCandidate): Promise<InspectedBook> {
  if (!isAbsolute(candidate.absolutePath)) {
    throw new Error(`Scholar book candidate must use an absolute path: ${candidate.absolutePath}`);
  }
  if (
    candidate.format !== "pdf"
    || extname(candidate.fileName).toLocaleLowerCase("en-US") !== ".pdf"
    || extname(candidate.absolutePath).toLocaleLowerCase("en-US") !== ".pdf"
  ) {
    throw new Error("Scholar accepts PDF books only.");
  }

  const fingerprint = await fingerprintFile(candidate.absolutePath);
  const { pdfinfo } = await findPdfTools();
  if (!pdfinfo) {
    throw new Error(
      "Scholar requires Poppler pdfinfo for PDF metadata. Set PI_SCHOLAR_PDFINFO or install Calibre/Poppler.",
    );
  }
  const info = await runTextCommand(pdfinfo, ["-enc", "UTF-8", candidate.absolutePath], {
    timeoutMs: 20_000,
    maxBuffer: PDFINFO_MAX_BUFFER,
    label: `inspect PDF metadata for ${candidate.fileName}`,
  });
  const metadata = parsePdfInfo(info, candidate.displayTitle);
  if (!metadata.pageCount) {
    throw new Error(`Scholar could not determine the PDF page count for ${candidate.fileName}.`);
  }

  return { metadata, fingerprint };
}

function validateExtractBounds(book: ScholarBook, start: number, end: number, maxChars: number): void {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
    throw new Error("Scholar source bounds must be positive whole numbers with end >= start.");
  }
  if (!Number.isSafeInteger(maxChars) || maxChars < 256 || maxChars > MAX_EXTRACT_CHARS) {
    throw new Error(`Scholar maxChars must be a whole number from 256 to ${MAX_EXTRACT_CHARS}.`);
  }
  if (end - start + 1 > MAX_PDF_RANGE_PAGES) {
    throw new Error(`Scholar can extract at most ${MAX_PDF_RANGE_PAGES} PDF pages at once.`);
  }
  if (book.metadata.pageCount && end > book.metadata.pageCount) {
    throw new Error(`Scholar PDF page ${end} exceeds the book's ${book.metadata.pageCount} pages.`);
  }
}

export async function assertFreshSource(book: ScholarBook): Promise<void> {
  const sourceStats = await stat(book.source.absolutePath);
  const expected = book.source.fingerprint;
  if (sourceStats.size !== expected.size || sourceStats.mtimeMs !== expected.mtimeMs) {
    throw new Error(
      `Scholar source changed since import: ${book.source.fileName}. Re-import it before continuing.`,
    );
  }
}

function alphanumericCount(text: string): number {
  return text.match(/[\p{L}\p{N}]/gu)?.length || 0;
}

function assertAlphanumericWasExtracted(count: number, pageSpan: number, label: string): void {
  const minimum = Math.max(24, Math.min(500, pageSpan * 12));
  if (count < minimum) {
    throw new Error(
      `Scholar found too little selectable text in ${label}. The pages may be scanned images; OCR is required before Scholar can teach or search them.`,
    );
  }
}

function assertTextWasExtracted(text: string, pageSpan: number, label: string): void {
  assertAlphanumericWasExtracted(alphanumericCount(text), pageSpan, label);
}

function splitPdfPages(text: string): string[] {
  const pages = text.replace(/\r\n?/g, "\n").split("\f");
  if (pages.length > 1 && pages[pages.length - 1]!.trim() === "") pages.pop();
  return pages;
}

function formatPdfPages(text: string, firstPage: number): string {
  return splitPdfPages(text)
    .map((page, index) => `[Page ${firstPage + index}]\n${page.trim()}`)
    .join("\n\n");
}

function truncateExcerpt(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = "\n\n[Scholar: excerpt truncated; request a smaller page range.]";
  const available = Math.max(1, maxChars - marker.length);
  const lastLine = text.lastIndexOf("\n", available);
  const cutAt = lastLine >= Math.floor(available * 0.75) ? lastLine : available;
  return `${text.slice(0, cutAt).trimEnd()}${marker}`.slice(0, maxChars);
}

async function requirePdfTextTool(): Promise<string> {
  const { pdftotext } = await findPdfTools();
  if (!pdftotext) {
    throw new Error(
      "Scholar requires Poppler pdftotext for PDFs. Set PI_SCHOLAR_PDFTOTEXT or install Calibre/Poppler.",
    );
  }
  return pdftotext;
}

/** Extracts bounded text from PDF viewer pages. */
export async function extractSourcePages(
  book: ScholarBook,
  start: number,
  end: number,
  maxChars = DEFAULT_EXTRACT_CHARS,
  allowSparse = false,
): Promise<string> {
  validateExtractBounds(book, start, end, maxChars);
  await assertFreshSource(book);

  const pdftotext = await requirePdfTextTool();
  const raw = await runTextCommand(
    pdftotext,
    [
      "-f",
      String(start),
      "-l",
      String(end),
      "-layout",
      "-enc",
      "UTF-8",
      book.source.absolutePath,
      "-",
    ],
    {
      timeoutMs: 60_000,
      maxBuffer: Math.min(PDFTEXT_MAX_BUFFER, Math.max(2 * 1024 * 1024, maxChars * 8)),
      label: `extract pages ${start}-${end} from ${book.source.fileName}`,
    },
  );
  if (!allowSparse) assertTextWasExtracted(raw, end - start + 1, `pages ${start}-${end} of ${book.source.fileName}`);
  return truncateExcerpt(formatPdfPages(raw, start), maxChars);
}

const PDF_RENDER_SCALE = 1800;
const MAX_RENDER_BYTES = 20 * 1024 * 1024;

function validatePdfPage(book: ScholarBook, page: number): void {
  if (!Number.isSafeInteger(page) || page < 1 || (book.metadata.pageCount && page > book.metadata.pageCount)) {
    throw new Error(`Scholar PDF page ${page} is outside this book.`);
  }
}

function pngDimensions(image: Buffer): { width: number; height: number } {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (image.length < 24 || !image.subarray(0, 8).equals(signature) || image.toString("ascii", 12, 16) !== "IHDR") {
    throw new Error("Scholar's PDF renderer did not return a valid PNG image.");
  }
  const width = image.readUInt32BE(16);
  const height = image.readUInt32BE(20);
  if (width < 1 || height < 1 || width > 20_000 || height > 20_000) {
    throw new Error(`Scholar's PDF renderer returned invalid PNG dimensions: ${width}x${height}.`);
  }
  return { width, height };
}

async function renderPdfPng(book: ScholarBook, page: number, crop?: Omit<PixelCrop, "canvasWidth" | "canvasHeight">): Promise<RenderedPdfPage> {
  const { pdftoppm } = await findPdfTools();
  if (!pdftoppm) {
    throw new Error("Scholar requires Poppler pdftoppm to inspect page images. Set PI_SCHOLAR_PDFTOPPM or install Calibre/Poppler.");
  }

  const directory = await mkdtemp(join(tmpdir(), "scholar-page-"));
  const prefix = join(directory, "page");
  const output = `${prefix}.png`;
  try {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      execFile(
        pdftoppm,
        [
          "-f", String(page),
          "-l", String(page),
          "-png",
          "-singlefile",
          "-scale-to", String(PDF_RENDER_SCALE),
          ...(crop ? ["-x", String(crop.x), "-y", String(crop.y), "-W", String(crop.width), "-H", String(crop.height)] : []),
          book.source.absolutePath,
          prefix,
        ],
        { timeout: 60_000, windowsHide: true, shell: false, maxBuffer: 2 * 1024 * 1024 },
        (error, _stdout, stderr) => {
          if (!error) return resolvePromise();
          const detail = String(stderr || error.message).replace(/\s+/g, " ").trim().slice(0, 500);
          rejectPromise(new Error(`Scholar could not render PDF page ${page}: ${detail || "unknown Poppler error"}`));
        },
      );
    });
    const image = await readFile(output);
    if (image.length === 0 || image.length > MAX_RENDER_BYTES) {
      throw new Error(`Scholar rendered an invalid or oversized page image (${image.length} bytes).`);
    }
    const dimensions = pngDimensions(image);
    return {
      data: image.toString("base64"),
      mimeType: "image/png",
      bytes: image.length,
      ...dimensions,
      scaleTo: PDF_RENDER_SCALE,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Render one PDF viewer page for equations, tables, and figures that text extraction cannot preserve. */
export async function renderPdfPage(book: ScholarBook, page: number): Promise<RenderedPdfPage> {
  validatePdfPage(book, page);
  await assertFreshSource(book);
  const rendered = await renderPdfPng(book, page);
  await assertFreshSource(book);
  return rendered;
}

/** Render an exact, lossless crop in the intrinsic pixel coordinate space returned by renderPdfPage. */
export async function renderPdfCrop(book: ScholarBook, page: number, crop: PixelCrop): Promise<RenderedPdfCrop> {
  validatePdfPage(book, page);
  const values = [crop.x, crop.y, crop.width, crop.height, crop.canvasWidth, crop.canvasHeight];
  if (!values.every((value) => Number.isSafeInteger(value))) throw new Error("Scholar snapshot coordinates must be integers.");
  if (crop.x < 0 || crop.y < 0 || crop.width < 32 || crop.height < 32) {
    throw new Error("Scholar snapshots require a crop of at least 32x32 pixels with a non-negative origin.");
  }

  await assertFreshSource(book);
  const full = await renderPdfPng(book, page);
  if (crop.canvasWidth !== full.width || crop.canvasHeight !== full.height) {
    throw new Error(`Scholar snapshot coordinates target ${crop.canvasWidth}x${crop.canvasHeight}, but the current page preview is ${full.width}x${full.height}. View the page again first.`);
  }
  if (crop.x + crop.width > full.width || crop.y + crop.height > full.height) {
    throw new Error(`Scholar snapshot crop falls outside the ${full.width}x${full.height} page preview.`);
  }

  const rendered = await renderPdfPng(book, page, crop);
  if (rendered.width !== crop.width || rendered.height !== crop.height) {
    throw new Error(`Scholar snapshot renderer returned ${rendered.width}x${rendered.height}; expected ${crop.width}x${crop.height}.`);
  }
  await assertFreshSource(book);
  return {
    ...rendered,
    sha256: createHash("sha256").update(Buffer.from(rendered.data, "base64")).digest("hex"),
  };
}

function queryTokens(query: string): string[] {
  return [
    ...new Set(
      query
        .toLocaleLowerCase("en-US")
        .split(/[^\p{L}\p{N}]+/u)
        .filter((token) => token.length >= 2),
    ),
  ];
}

function snippetAt(text: string, index: number, matchLength: number): string {
  const before = 180;
  const after = 260;
  const start = Math.max(0, index - before);
  const end = Math.min(text.length, index + Math.max(matchLength, 1) + after);
  const snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${snippet}${end < text.length ? "…" : ""}`;
}

function rankPage(text: string, query: string, tokens: string[]): Omit<RankedHit, "page"> | undefined {
  const lowered = text.toLocaleLowerCase("en-US");
  const exactIndex = lowered.indexOf(query);
  if (exactIndex >= 0) {
    let occurrences = 0;
    let cursor = exactIndex;
    while (cursor >= 0) {
      occurrences += 1;
      cursor = lowered.indexOf(query, cursor + Math.max(query.length, 1));
    }
    return { snippet: snippetAt(text, exactIndex, query.length), exact: true, score: 1_000 + occurrences };
  }

  if (tokens.length === 0) return undefined;
  const positions = tokens.map((token) => lowered.indexOf(token));
  if (positions.some((position) => position < 0)) return undefined;
  const score = tokens.reduce((total, token) => {
    let occurrences = 0;
    let cursor = lowered.indexOf(token);
    while (cursor >= 0) {
      occurrences += 1;
      cursor = lowered.indexOf(token, cursor + token.length);
    }
    return total + occurrences;
  }, tokens.length * 10);
  return {
    snippet: snippetAt(text, Math.min(...positions), Math.max(...tokens.map((token) => token.length))),
    exact: false,
    score,
  };
}

function validateSearch(query: string, limit: number): string {
  const normalized = query.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
  if (normalized.length < 2 || normalized.length > 300) {
    throw new Error("Scholar search query must contain 2 to 300 characters.");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("Scholar search limit must be a whole number from 1 to 50.");
  }
  return normalized;
}

/** Searches source text without retaining a full-book cache in memory or on disk. */
export async function searchSource(
  book: ScholarBook,
  query: string,
  limit = 10,
  pageRanges?: readonly { startPage: number; endPage: number }[],
): Promise<SourceSearchHit[]> {
  const normalizedQuery = validateSearch(query, limit);
  await assertFreshSource(book);

  const pdftotext = await requirePdfTextTool();
  const requestedRanges = pageRanges?.length
    ? [...pageRanges]
        .map(({ startPage, endPage }) => {
          if (!Number.isSafeInteger(startPage) || !Number.isSafeInteger(endPage) || startPage < 1 || endPage < startPage) {
            throw new Error("Scholar search page ranges must contain valid positive bounds.");
          }
          if (book.metadata.pageCount && endPage > book.metadata.pageCount) {
            throw new Error(`Scholar search page ${endPage} exceeds the PDF's ${book.metadata.pageCount} pages.`);
          }
          return { startPage, endPage };
        })
        .sort((left, right) => left.startPage - right.startPage || left.endPage - right.endPage)
    : undefined;
  const ranges = requestedRanges?.reduce<Array<{ startPage: number; endPage: number }>>((merged, range) => {
    const previous = merged.at(-1);
    if (previous && range.startPage <= previous.endPage + 1) previous.endPage = Math.max(previous.endPage, range.endPage);
    else merged.push({ ...range });
    return merged;
  }, []);
  const extractionRanges = ranges || [{ startPage: 1, endPage: book.metadata.pageCount || 0 }];
  const tokens = queryTokens(normalizedQuery);
  const hits: RankedHit[] = [];
  let extractedCharacters = 0;
  let extractedPageSpan = 0;
  for (const range of extractionRanges) {
    const bounded = range.endPage > 0;
    const raw = await runTextCommand(
      pdftotext,
      [
        "-layout",
        "-enc",
        "UTF-8",
        ...(bounded ? ["-f", String(range.startPage), "-l", String(range.endPage)] : []),
        book.source.absolutePath,
        "-",
      ],
      {
        timeoutMs: 120_000,
        maxBuffer: PDFTEXT_MAX_BUFFER,
        label: `search ${book.source.fileName}`,
      },
    );
    const extracted = splitPdfPages(raw);
    extractedCharacters += alphanumericCount(raw);
    extractedPageSpan += bounded ? range.endPage - range.startPage + 1 : extracted.length;
    extracted.forEach((text, index) => {
      const page = (bounded ? range.startPage : 1) + index;
      const ranked = rankPage(text, normalizedQuery, tokens);
      if (ranked) hits.push({ page, ...ranked });
    });
  }
  assertAlphanumericWasExtracted(
    extractedCharacters,
    extractedPageSpan,
    `the searchable text of ${book.source.fileName}`,
  );

  return hits
    .sort((left, right) =>
      Number(right.exact) - Number(left.exact) || right.score - left.score || left.page - right.page,
    )
    .slice(0, limit)
    .map(({ page, snippet }) => ({ page, snippet }));
}
