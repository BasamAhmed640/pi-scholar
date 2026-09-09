import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

import { migrateLegacyCompletion } from "./domain.ts";
import {
  SCHOLAR_SCHEMA_VERSION,
  type CatalogEntry,
  type ScholarBook,
  type ScholarCatalog,
  type ScholarConfig,
} from "./types.ts";
import {
  bookDirectorySegment,
  isBookId,
  isBootstrapConfig,
  isCatalogEntry,
  isScholarBook,
  isScholarCatalog,
  scholarBookIssues,
  legacyBootstrapPaths,
  type BootstrapConfig,
} from "./state-schema.ts";

// Keep storage.ts's public validation API stable for existing callers.
export { isScholarBook };

// A fresh Scholar installation has no implicit book location. The user must
// explicitly select one with `/scholar library "<path>"`.
export const DEFAULT_SCHOLAR_LIBRARY_ROOT = "";
export const DEFAULT_SCHOLAR_OBSIDIAN_ROOT = "";
export const DEFAULT_SCHOLAR_STATE_ROOT = join(homedir(), ".pi", "agent", "scholar");

const CONFIG_FILE = "config.json";
const CATALOG_FILE = "catalog.json";
const SCHOLAR_FOLDER = "Scholar";
const VISIBLE_BOOKS_FOLDER = "Books";
const VAULT_STATE_FOLDER = ".scholar";
const BOOK_STATE_FILE = "book.json";
const BOOK_PREVIOUS_STATE_FILE = "book.prev.json";

function normalizeRoot(value: string, fallback: string): string {
  const trimmed = value.trim();
  return resolve(trimmed || fallback);
}

function normalizeOptionalRoot(value: string | undefined): string {
  const trimmed = value?.trim() || "";
  return trimmed ? resolve(trimmed) : "";
}

function assertReadOnlyLibraryLayout(config: ScholarConfig): void {
  if (!config.libraryRoot) return;
  const libraryKey = process.platform === "win32" ? config.libraryRoot.toLowerCase() : config.libraryRoot;
  for (const writeRoot of [
    config.stateRoot,
    config.obsidianRoot ? resolve(config.obsidianRoot, SCHOLAR_FOLDER) : "",
    config.obsidianRoot ? resolve(config.obsidianRoot, ".obsidian") : "",
  ].filter(Boolean)) {
    const writeKey = process.platform === "win32" ? writeRoot.toLowerCase() : writeRoot;
    const fromLibrary = relative(libraryKey, writeKey);
    if (fromLibrary === "" || (!isAbsolute(fromLibrary) && fromLibrary !== ".." && !fromLibrary.startsWith(`..${sep}`))) {
      throw new Error("Scholar configuration is unsafe: its PDF library contains a Scholar write location. Choose separate paths so the PDF library remains read-only.");
    }
  }
}

/** Resolve portable home-relative defaults and optional environment overrides without touching disk. */
export function resolveScholarConfig(overrides: Partial<ScholarConfig> = {}): ScholarConfig {
  const config: ScholarConfig = {
    schemaVersion: SCHOLAR_SCHEMA_VERSION,
    libraryRoot: normalizeOptionalRoot(
      process.env.PI_SCHOLAR_LIBRARY_ROOT ?? overrides.libraryRoot ?? DEFAULT_SCHOLAR_LIBRARY_ROOT,
    ),
    obsidianRoot: normalizeOptionalRoot(
      process.env.PI_SCHOLAR_OBSIDIAN_ROOT ?? overrides.obsidianRoot ?? DEFAULT_SCHOLAR_OBSIDIAN_ROOT,
    ),
    stateRoot: normalizeRoot(
      process.env.PI_SCHOLAR_STATE_ROOT ?? overrides.stateRoot ?? DEFAULT_SCHOLAR_STATE_ROOT,
      DEFAULT_SCHOLAR_STATE_ROOT,
    ),
    ...(overrides.currentBookId ? { currentBookId: overrides.currentBookId } : {}),
    updatedAt: overrides.updatedAt || new Date().toISOString(),
  };
  assertReadOnlyLibraryLayout(config);
  return config;
}

function configPath(config: ScholarConfig): string {
  return resolve(config.stateRoot, CONFIG_FILE);
}

/** Hidden vault-local metadata shared by the books in this selected vault. */
export function vaultStateDirectory(config: ScholarConfig): string {
  if (!config.obsidianRoot.trim()) throw new Error("Scholar's Obsidian vault is not configured.");
  return resolve(config.obsidianRoot, SCHOLAR_FOLDER, VAULT_STATE_FOLDER);
}

export function catalogPath(config: ScholarConfig): string {
  return resolve(vaultStateDirectory(config), CATALOG_FILE);
}

export function bookStatesDirectory(config: ScholarConfig): string {
  if (!config.obsidianRoot.trim()) throw new Error("Scholar's Obsidian vault is not configured.");
  return resolve(config.obsidianRoot, SCHOLAR_FOLDER, VISIBLE_BOOKS_FOLDER);
}

function safeBookId(bookId: string): string {
  const value = bookId.trim();
  if (!isBookId(value)) {
    throw new Error(`Invalid Scholar book id: ${JSON.stringify(bookId)}`);
  }
  return value;
}

function authorityDirectory(config: ScholarConfig, book: ScholarBook): string {
  const segment = bookDirectorySegment(book.noteDirectory);
  if (!segment) {
    throw new Error(`Scholar book authority must be one folder inside ${VISIBLE_BOOKS_FOLDER}: ${book.noteDirectory}`);
  }
  return resolve(bookStatesDirectory(config), segment);
}

export function bookStatePath(config: ScholarConfig, book: ScholarBook): string {
  safeBookId(book.id);
  return resolve(authorityDirectory(config, book), VAULT_STATE_FOLDER, BOOK_STATE_FILE);
}

async function canonicalizeAllowMissing(inputPath: string): Promise<string> {
  let cursor = resolve(inputPath);
  const missingSegments: string[] = [];

  for (;;) {
    try {
      const existing = await realpath(cursor);
      return resolve(existing, ...missingSegments.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missingSegments.push(basename(cursor));
      cursor = parent;
    }
  }
}

function isWithinCanonicalRoot(root: string, candidate: string): boolean {
  const rootKey = process.platform === "win32" ? root.toLowerCase() : root;
  const candidateKey = process.platform === "win32" ? candidate.toLowerCase() : candidate;
  const pathFromRoot = relative(rootKey, candidateKey);
  return pathFromRoot === "" || (!isAbsolute(pathFromRoot) && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`));
}

/**
 * Resolve a path and reject lexical traversal as well as existing symlinks/junctions
 * that escape the requested root. The returned path is canonical and absolute.
 */
export async function safePathWithinRoot(root: string, candidate: string): Promise<string> {
  if (!root.trim()) throw new Error("Scholar path root is not configured.");
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const lexicalRelative = relative(resolvedRoot, resolvedCandidate);
  if (lexicalRelative === ".." || lexicalRelative.startsWith(`..${sep}`) || isAbsolute(lexicalRelative)) {
    throw new Error(`Scholar path escapes its configured root: ${resolvedCandidate}`);
  }

  const [canonicalRoot, canonicalCandidate] = await Promise.all([
    canonicalizeAllowMissing(resolvedRoot),
    canonicalizeAllowMissing(resolvedCandidate),
  ]);
  if (!isWithinCanonicalRoot(canonicalRoot, canonicalCandidate)) {
    throw new Error(`Scholar path resolves outside its configured root: ${resolvedCandidate}`);
  }
  return canonicalCandidate;
}

async function atomicWriteUnlocked(
  filePath: string,
  content: string | Uint8Array,
  createParent = true,
): Promise<void> {
  if (createParent) await mkdir(dirname(filePath), { recursive: true });
  else {
    const parent = await stat(dirname(filePath));
    if (!parent.isDirectory()) throw new Error(`Scholar authority directory is missing: ${dirname(filePath)}`);
  }
  const temporary = resolve(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    if (typeof content === "string") await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    else await writeFile(temporary, content, { flag: "wx" });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function atomicReplaceBookAuthority(
  filePath: string,
  content: string,
  expectedBookId: string,
  expectedInstanceId: string,
  expectedRevision: number,
): Promise<void> {
  const verifyCurrent = async (): Promise<string> => {
    let parsed: unknown;
    let current: string;
    try {
      current = await readFile(filePath, "utf8");
      parsed = JSON.parse(current) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Scholar book authority was deleted while saving: ${filePath}`);
      }
      throw error;
    }
    if (!isScholarBook(parsed) || parsed.id !== expectedBookId || parsed.instanceId !== expectedInstanceId) {
      throw new Error(`Scholar book authority changed while saving: ${filePath}`);
    }
    if (parsed.revision !== expectedRevision) {
      throw new ScholarRevisionConflictError(
        expectedBookId,
        expectedRevision,
        parsed.revision,
        filePath,
      );
    }
    return current;
  };

  const previous = await verifyCurrent();
  const temporary = resolve(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  const previousPath = resolve(dirname(filePath), BOOK_PREVIOUS_STATE_FILE);
  // Reject an existing symlink/junction that would send the backup outside
  // this authority directory, just as the primary path is confined by its caller.
  await safePathWithinRoot(dirname(filePath), previousPath);
  const previousTemporary = `${temporary}.prev`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    // Copy the verified bytes; never move the live authority away. A failed
    // copy leaves both the primary and the last successful backup intact.
    await writeFile(previousTemporary, previous, { encoding: "utf8", flag: "wx" });
    // Re-check immediately before replacement. Deleting the manifest or
    // recreating the same PDF as a fresh instance can never be overwritten by
    // an older in-flight save.
    const current = await verifyCurrent();
    if (current !== previous) {
      throw new Error(`Scholar book authority changed while saving: ${filePath}`);
    }
    // Publish one previous generation only after the final CAS checks. Discovery
    // reads exactly book.json; this backup is never a recovery authority.
    await rename(previousTemporary, previousPath);
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
    await rm(previousTemporary, { force: true }).catch(() => undefined);
  }
}

export class ScholarRevisionConflictError extends Error {
  readonly name = "ScholarRevisionConflictError";

  constructor(
    readonly bookId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number,
    readonly authorityPath: string,
  ) {
    super(
      `Scholar book revision conflict for ${bookId}: expected revision ${expectedRevision}, found ${actualRevision}.`,
    );
  }
}

async function assertExistingRoot(root: string): Promise<void> {
  if (!root.trim()) throw new Error("Scholar path root is not configured.");
  let info;
  try {
    info = await stat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Scholar configured root does not exist: ${resolve(root)}`);
    }
    throw error;
  }
  if (!info.isDirectory()) throw new Error(`Scholar configured root is not a directory: ${resolve(root)}`);
}

/** Atomically replace a UTF-8 file after confining it to root. */
export async function writeTextFileAtomic(root: string, filePath: string, content: string): Promise<void> {
  await assertExistingRoot(root);
  const safePath = await safePathWithinRoot(root, filePath);
  await withFileMutationQueue(safePath, () => atomicWriteUnlocked(safePath, content));
}

/**
 * Create a learner-owned UTF-8 file without ever replacing an existing entry.
 * A failed write may leave partial bytes; callers must validate their document's
 * completion marker before treating an existing file as a complete document.
 */
export async function writeTextFileIfAbsent(root: string, filePath: string, content: string): Promise<"written" | "exists"> {
  await assertExistingRoot(root);
  const safePath = await safePathWithinRoot(root, filePath);
  return withFileMutationQueue(safePath, async () => {
    await mkdir(dirname(safePath), { recursive: true });
    // Recheck after creating parents and immediately before exclusive creation.
    const destination = await safePathWithinRoot(root, filePath);
    if (destination !== safePath) throw new Error("Scholar answer-paper path changed while creating its folder.");
    try {
      await writeFile(destination, content, { encoding: "utf8", flag: "wx" });
      return "written" as const;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return "exists" as const;
      throw error;
    }
  });
}

/** Write an immutable binary asset once, or verify that an identical asset already exists. */
export async function writeBinaryFileOnce(
  root: string,
  filePath: string,
  content: Uint8Array,
): Promise<"written" | "reused"> {
  await assertExistingRoot(root);
  const safePath = await safePathWithinRoot(root, filePath);
  return withFileMutationQueue(safePath, async () => {
    try {
      const existing = await readFile(safePath);
      if (!existing.equals(Buffer.from(content))) {
        throw new Error(`Scholar snapshot asset already exists with different bytes: ${basename(safePath)}`);
      }
      return "reused" as const;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await atomicWriteUnlocked(safePath, content);
    return "written" as const;
  });
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

async function ensureVaultMetadata(config: ScholarConfig): Promise<void> {
  if (!config.obsidianRoot.trim()) return;
  await assertExistingRoot(config.obsidianRoot);
  const stateFolder = await safePathWithinRoot(config.obsidianRoot, vaultStateDirectory(config));
  await mkdir(stateFolder, { recursive: true });
  await safePathWithinRoot(config.obsidianRoot, catalogPath(config));
}

export async function initializeScholarStorage(config: ScholarConfig = resolveScholarConfig()): Promise<ScholarConfig> {
  const normalized = resolveScholarConfig(config);
  // The OS-local directory contains only the selected-vault pointer. Book
  // state, progress, catalog, and current-book selection belong to the vault.
  await mkdir(normalized.stateRoot, { recursive: true });
  await safePathWithinRoot(normalized.stateRoot, configPath(normalized));
  return normalized;
}

async function writeBootstrapConfig(config: ScholarConfig): Promise<void> {
  const bootstrap: BootstrapConfig = {
    schemaVersion: SCHOLAR_SCHEMA_VERSION,
    obsidianRoot: config.obsidianRoot,
    updatedAt: config.updatedAt,
  };
  await writeTextFileAtomic(config.stateRoot, configPath(config), `${JSON.stringify(bootstrap, null, 2)}\n`);
}

export async function loadConfig(): Promise<ScholarConfig> {
  const defaults = resolveScholarConfig();
  let bootstrapRoot = "";
  let legacyLibraryRoot = "";
  let needsRewrite = false;
  try {
    const parsed = await readJson(configPath(defaults));
    if (isBootstrapConfig(parsed)) bootstrapRoot = parsed.obsidianRoot;
    else {
      const legacy = legacyBootstrapPaths(parsed);
      if (!legacy) throw new Error("Scholar config.json does not match the supported bootstrap schema.");
      bootstrapRoot = legacy.obsidianRoot || "";
      legacyLibraryRoot = legacy.libraryRoot || "";
      needsRewrite = true;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    needsRewrite = true;
  }

  let config = await initializeScholarStorage(resolveScholarConfig({
    obsidianRoot: bootstrapRoot,
    stateRoot: defaults.stateRoot,
  }));
  if (config.obsidianRoot) {
    const catalog = await loadCatalog(config);
    config = resolveScholarConfig({
      ...config,
      libraryRoot: catalog.libraryRoot || legacyLibraryRoot,
      currentBookId: catalog.currentBookId,
      stateRoot: defaults.stateRoot,
    });
    if (legacyLibraryRoot && !catalog.libraryRoot) {
      const rootExists = await stat(config.obsidianRoot).then((info) => info.isDirectory(), () => false);
      if (rootExists) await updateCatalog(config, (state) => { state.libraryRoot = legacyLibraryRoot; });
    }
    if (config.currentBookId && !await loadBookState(config, config.currentBookId)) {
      config = resolveScholarConfig({ ...config, currentBookId: undefined });
      await updateCatalog(config, (state) => { delete state.currentBookId; });
    }
  }
  if (needsRewrite) await writeBootstrapConfig(config);
  return config;
}

export async function saveConfig(config: ScholarConfig): Promise<ScholarConfig> {
  let normalized = await initializeScholarStorage({
    ...resolveScholarConfig(config),
    currentBookId: config.currentBookId,
    updatedAt: new Date().toISOString(),
  });
  if (normalized.obsidianRoot) {
    await ensureVaultMetadata(normalized);
    if (normalized.currentBookId && !await loadBookState(normalized, normalized.currentBookId)) {
      normalized = resolveScholarConfig({ ...normalized, currentBookId: undefined });
    }
    await updateCatalog(normalized, (catalog) => {
      if (normalized.libraryRoot) catalog.libraryRoot = normalized.libraryRoot;
      else delete catalog.libraryRoot;
      if (normalized.currentBookId) catalog.currentBookId = normalized.currentBookId;
      else delete catalog.currentBookId;
    });
  }
  // Publish the selected-vault pointer only after the target vault accepted
  // its local configuration, so a failed switch cannot strand Scholar.
  await writeBootstrapConfig(normalized);
  return normalized;
}

export async function loadCatalog(config: ScholarConfig): Promise<ScholarCatalog> {
  const normalized = resolveScholarConfig(config);
  if (!normalized.obsidianRoot) return { schemaVersion: SCHOLAR_SCHEMA_VERSION, entries: [] };
  const filePath = await safePathWithinRoot(normalized.obsidianRoot, catalogPath(normalized));
  try {
    const parsed = await readJson(filePath);
    if (!isScholarCatalog(parsed)) throw new Error("Scholar catalog.json does not match schema v3.");
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { schemaVersion: SCHOLAR_SCHEMA_VERSION, entries: [] };
    }
    throw error;
  }
}

export async function updateCatalog(
  config: ScholarConfig,
  update: CatalogEntry | CatalogEntry[] | ((catalog: ScholarCatalog) => void | ScholarCatalog),
): Promise<ScholarCatalog> {
  const normalized = await initializeScholarStorage(config);
  if (!normalized.obsidianRoot) throw new Error("Scholar's Obsidian vault is not configured.");
  await ensureVaultMetadata(normalized);
  const filePath = await safePathWithinRoot(normalized.obsidianRoot, catalogPath(normalized));
  return withFileMutationQueue(filePath, async () => {
    let catalog: ScholarCatalog;
    try {
      const parsed = await readJson(filePath);
      if (!isScholarCatalog(parsed)) throw new Error("Scholar catalog.json does not match schema v3.");
      catalog = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      catalog = { schemaVersion: SCHOLAR_SCHEMA_VERSION, entries: [] };
    }

    if (typeof update === "function") {
      catalog = update(catalog) || catalog;
    } else {
      const incoming = Array.isArray(update) ? update : [update];
      if (!incoming.every(isCatalogEntry)) throw new Error("Refusing to add an invalid Scholar catalog entry.");
      const incomingPaths = new Set(incoming.map((entry) => entry.relativePath.toLowerCase()));
      catalog.entries = catalog.entries.filter((entry) => !incomingPaths.has(entry.relativePath.toLowerCase()));
      catalog.entries.push(...incoming);
    }

    if (!isScholarCatalog(catalog)) throw new Error("Scholar catalog update produced invalid schema v3 data.");
    catalog.entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    await atomicWriteUnlocked(filePath, `${JSON.stringify(catalog, null, 2)}\n`);
    return catalog;
  });
}

async function authorityStateFiles(config: ScholarConfig): Promise<string[]> {
  if (!config.obsidianRoot) return [];
  const booksRoot = await safePathWithinRoot(config.obsidianRoot, bookStatesDirectory(config));
  let entries;
  try {
    entries = await readdir(booksRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.toLowerCase() === VAULT_STATE_FOLDER.toLowerCase()) continue;
    const candidate = await safePathWithinRoot(
      config.obsidianRoot,
      resolve(booksRoot, entry.name, VAULT_STATE_FOLDER, BOOK_STATE_FILE),
    );
    const exists = await stat(candidate).then((info) => info.isFile(), (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    if (exists) files.push(candidate);
  }
  return files.sort((a, b) => a.localeCompare(b));
}

async function readBookAuthority(config: ScholarConfig, filePath: string): Promise<ScholarBook> {
  const parsed = await readJson(filePath);
  if (!isScholarBook(parsed)) throw new Error(`Scholar book authority does not match schema v3: ${filePath}`);
  const expected = await safePathWithinRoot(config.obsidianRoot, bookStatePath(config, parsed));
  const actual = await safePathWithinRoot(config.obsidianRoot, filePath);
  const samePath = process.platform === "win32" ? expected.toLowerCase() === actual.toLowerCase() : expected === actual;
  if (!samePath) throw new Error(`Scholar book authority is stored in the wrong book directory: ${filePath}`);
  if (config.libraryRoot) {
    const sourceFromRelativePath = resolve(config.libraryRoot, ...parsed.source.relativePath.split(/[\\/]+/));
    parsed.source.absolutePath = await safePathWithinRoot(config.libraryRoot, sourceFromRelativePath);
  }
  // Applied at the one place a stored book is parsed, so every in-memory book
  // is already migrated. It is pure; the flag persists on the next ordinary
  // write rather than forcing a write during a read.
  return migrateLegacyCompletion(parsed);
}

/** Reload an expected book only if the same vault-local import still exists. */
export async function loadMatchingBookAuthority(
  config: ScholarConfig,
  expected: ScholarBook,
): Promise<ScholarBook | undefined> {
  const normalized = resolveScholarConfig(config);
  if (!normalized.obsidianRoot) return undefined;
  const filePath = await safePathWithinRoot(normalized.obsidianRoot, bookStatePath(normalized, expected));
  let current: ScholarBook;
  try {
    current = await readBookAuthority(normalized, filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return current?.id === expected.id && current.instanceId === expected.instanceId ? current : undefined;
}

export async function loadBookState(config: ScholarConfig, bookId: string): Promise<ScholarBook | undefined> {
  safeBookId(bookId);
  const normalized = resolveScholarConfig(config);
  let match: ScholarBook | undefined;
  for (const filePath of await authorityStateFiles(normalized)) {
    const book = await readBookAuthority(normalized, filePath);
    if (book.id !== bookId) continue;
    if (match) throw new Error(`Scholar found duplicate authority for book ${bookId} in the selected Obsidian vault.`);
    match = book;
  }
  return match;
}

function serializedBook(book: ScholarBook): string {
  return `${JSON.stringify(book, (key, value) =>
    (key === "snapshots" || key === "images") && Array.isArray(value) && value.length === 0 ? undefined : value, 2)}\n`;
}

/** The only operation allowed to create a new authoritative book directory. */
export async function createBookState(config: ScholarConfig, book: ScholarBook): Promise<ScholarBook> {
  if (!isScholarBook(book)) throw new Error(`Refusing to create invalid Scholar book state: ${scholarBookIssues(book).join("; ")}`);
  const normalized = await initializeScholarStorage(config);
  if (!normalized.obsidianRoot) throw new Error("Scholar's Obsidian vault is not configured.");
  const directory = await safePathWithinRoot(normalized.obsidianRoot, authorityDirectory(normalized, book));
  const filePath = await safePathWithinRoot(normalized.obsidianRoot, bookStatePath(normalized, book));
  await withFileMutationQueue(filePath, async () => {
    const manifestExists = await stat(filePath).then((info) => info.isFile(), (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    if (manifestExists) throw new Error(`Scholar book already exists in this Obsidian vault: ${book.metadata.title}`);
    // A user may delete only the hidden authority while leaving readable notes
    // or generated assets behind. Re-importing deliberately reclaims that same
    // book folder as a blank state instead of creating duplicate directories.
    await mkdir(resolve(directory, VAULT_STATE_FOLDER), { recursive: true });
    // Exclusive creation means two simultaneous imports cannot replace one
    // another even before either caller sees the catalog update.
    await writeFile(filePath, serializedBook(book), { encoding: "utf8", flag: "wx" });
  });
  return book;
}

/** Replace an existing authority only when its identity and revision still match the caller's snapshot. */
export async function saveBookState(
  config: ScholarConfig,
  book: ScholarBook,
  expectedRevision: number,
): Promise<ScholarBook> {
  if (!isScholarBook(book)) throw new Error(`Refusing to save invalid Scholar book state: ${scholarBookIssues(book).join("; ")}`);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new Error("Scholar save requires a non-negative expected book revision.");
  }
  const normalized = await initializeScholarStorage(config);
  if (!normalized.obsidianRoot) throw new Error("Scholar's Obsidian vault is not configured.");
  const filePath = await safePathWithinRoot(normalized.obsidianRoot, bookStatePath(normalized, book));
  await withFileMutationQueue(filePath, () =>
    atomicReplaceBookAuthority(
      filePath,
      serializedBook(book),
      book.id,
      book.instanceId,
      expectedRevision,
    ));
  return book;
}

export async function listBookStates(config: ScholarConfig): Promise<ScholarBook[]> {
  const normalized = resolveScholarConfig(config);
  const books: ScholarBook[] = [];
  const ids = new Set<string>();
  for (const filePath of await authorityStateFiles(normalized)) {
    const book = await readBookAuthority(normalized, filePath);
    if (ids.has(book.id)) throw new Error(`Scholar found duplicate authority for book ${book.id} in the selected Obsidian vault.`);
    ids.add(book.id);
    books.push(book);
  }
  return books.sort((a, b) => a.metadata.title.localeCompare(b.metadata.title));
}
