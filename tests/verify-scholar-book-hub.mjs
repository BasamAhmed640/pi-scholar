import { extensionPath as packagedExtensionPath, piPackageRoot as sdkRoot, jitiPath as sdkJitiPath, resolvePiDependency } from "./sdk.mjs";
// Current-v3 regression checks for title-named Obsidian book hubs.
// All files are created in a disposable vault; no user data is read or changed.
import { appendFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const requestedPath = resolve(
  process.env.PI_SCHOLAR_EXTENSION
    || packagedExtensionPath,
);
const extensionDirectory = basename(requestedPath).toLowerCase() === "index.ts"
  ? dirname(requestedPath)
  : requestedPath;
const piPackageRoot = sdkRoot;
const jitiPath = sdkJitiPath;
const { createJiti } = await import(pathToFileURL(jitiPath).href);
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: {
    "@earendil-works/pi-coding-agent": join(piPackageRoot, "dist", "index.js"),
  },
});
const storage = await jiti.import(join(extensionDirectory, "storage.ts"));
const obsidian = await jiti.import(join(extensionDirectory, "obsidian.ts"));
const { createBookService } = await jiti.import(join(extensionDirectory, "book-service.ts"));

const checks = [];
function check(name, condition, detail) {
  const passed = Boolean(condition);
  checks.push({ name, passed, detail });
  console.log(`[${passed ? "PASS" : "FAIL"}] ${name} - ${detail}`);
}

async function exists(path) {
  return readFile(path).then(() => true, () => false);
}

function occurrences(text, value) {
  return text.split(value).length - 1;
}

function fixtureBook(root, title = "Signal and Power Integrity") {
  const now = new Date().toISOString();
  const id = "a".repeat(64);
  return {
    schemaVersion: 3,
    revision: 0,
    id,
    instanceId: "book-hub-fixture-instance",
    source: {
      absolutePath: join(root, "Library", "Signal and Power Integrity.pdf"),
      relativePath: "Signal and Power Integrity.pdf",
      fileName: "Signal and Power Integrity.pdf",
      format: "pdf",
      fingerprint: { sha256: id, size: 1, mtimeMs: 1 },
    },
    metadata: { title, authors: ["Fixture Author"], pageCount: 1 },
    outlineStatus: "ready",
    chapters: [{
      id: "chapter-001",
      order: 1,
      number: "1",
      title: "Foundations",
      startPage: 1,
      endPage: 1,
      status: "not-started",
      sections: [{
        id: "chapter-001-section-001",
        order: 1,
        number: "1.1",
        title: "First Principle",
        startPage: 1,
        endPage: 1,
        objectives: [],
        coveredObjectives: [],
        requiredChecks: [],
        status: "not-started",
        keyPoints: [],
        misconceptions: [],
        attempts: [],
        transcript: [],
        createdAt: now,
        updatedAt: now,
      }],
    }],
    exams: [],
    tutorSessions: [],
    noteDirectory: "Signal and Power Integrity",
    createdAt: now,
    updatedAt: now,
  };
}

const root = await mkdtemp(join(tmpdir(), "scholar-book-hub-"));
try {
  const vault = join(root, "Vault");
  const library = join(root, "Library");
  const stateRoot = join(root, "State");
  await Promise.all([mkdir(vault, { recursive: true }), mkdir(library, { recursive: true })]);
  const book = fixtureBook(root);
  await writeFile(book.source.absolutePath, "fixture", "utf8");
  const config = storage.resolveScholarConfig({
    libraryRoot: library,
    obsidianRoot: vault,
    stateRoot,
    currentBookId: book.id,
  });
  await storage.createBookState(config, book);
  await obsidian.renderScholarWorkspace(config, [book]);

  const bookDirectory = obsidian.bookNoteDirectory(config, book);
  const titledHub = obsidian.bookHomePath(config, book);
  const legacyHub = join(bookDirectory, "Book Home.md");
  const scholarHome = obsidian.scholarHomePath(config);
  const chapter = obsidian.chapterNotePath(config, book, book.chapters[0]);
  const [scholarText, hubText, chapterText] = await Promise.all([
    readFile(scholarHome, "utf8"),
    readFile(titledHub, "utf8"),
    readFile(chapter, "utf8"),
  ]);
  check(
    "book hub uses the sanitized book title",
    basename(titledHub) === "Signal and Power Integrity.md"
      && await exists(titledHub)
      && !await exists(legacyHub),
    `${basename(titledHub)}; legacy=${await exists(legacyHub)}`,
  );
  check(
    "Scholar Home, titled hub, and chapter links form the exact hierarchy",
    scholarText.includes("[[./Signal and Power Integrity/Signal and Power Integrity\\|Signal and Power Integrity]]")
      && hubText.includes("[[../Scholar Home|Scholar Home]]")
      && hubText.includes("[[./Chapters/Chapter 1 - Foundations\\|Chapter 1: Foundations]]")
      && chapterText.includes("[[../Signal and Power Integrity|Signal and Power Integrity]]"),
    "Scholar Home → book title → chapter, with a chapter backlink",
  );

  const legacyTail = "LEGACY_BOOK_HOME_LEARNER_CONTENT";
  await rename(titledHub, legacyHub);
  await appendFile(legacyHub, `\n${legacyTail}\n`, "utf8");
  await obsidian.renderScholarWorkspace(config, [book]);
  const migrated = await readFile(titledHub, "utf8");
  check(
    "legacy Book Home migrates without losing learner content",
    !await exists(legacyHub)
      && occurrences(migrated, legacyTail) === 1
      && migrated.includes('title: "Signal and Power Integrity"')
      && !/^# /m.test(migrated)
      && migrated.includes("| Status | Chapter | Source | Completed sections |"),
    `legacy=${await exists(legacyHub)}; preserved=${occurrences(migrated, legacyTail)}`,
  );

  const oldTitleHub = titledHub;
  const oldTitleTail = "OLD_TITLE_LEARNER_CONTENT";
  const destinationTail = "NEW_TITLE_EXISTING_LEARNER_CONTENT";
  await appendFile(oldTitleHub, `\n${oldTitleTail}\n`, "utf8");
  const revised = structuredClone(book);
  revised.metadata.title = "Signal and Power Integrity—Simplified";
  revised.revision += 1;
  revised.updatedAt = new Date().toISOString();
  await storage.saveBookState(config, revised, book.revision);
  const stale = structuredClone(book);
  stale.metadata.title = "STALE WRITER MUST NOT WIN";
  stale.revision += 1;
  stale.updatedAt = new Date().toISOString();
  let staleError;
  try {
    await storage.saveBookState(config, stale, book.revision);
  } catch (error) {
    staleError = error;
  }
  const afterStaleSave = await storage.loadBookState(config, book.id);
  check(
    "revision CAS rejects a stale authority save",
    staleError instanceof storage.ScholarRevisionConflictError
      && staleError.expectedRevision === book.revision
      && staleError.actualRevision === revised.revision
      && afterStaleSave?.revision === revised.revision
      && afterStaleSave.metadata.title === revised.metadata.title,
    staleError instanceof Error ? staleError.message : "stale save unexpectedly succeeded",
  );
  const revisedHub = obsidian.bookHomePath(config, revised);
  await appendFile(revisedHub, `\n${destinationTail}\n`, "utf8");
  await obsidian.renderScholarWorkspace(config, [revised]);
  const revisedText = await readFile(revisedHub, "utf8");
  await obsidian.renderScholarWorkspace(config, [revised]);
  const rerenderedText = await readFile(revisedHub, "utf8");
  check(
    "title refinement leaves one hub and merges both handwritten tails idempotently",
    !await exists(oldTitleHub)
      && occurrences(rerenderedText, legacyTail) === 1
      && occurrences(rerenderedText, oldTitleTail) === 1
      && occurrences(rerenderedText, destinationTail) === 1
      && revisedText === rerenderedText,
    `old=${await exists(oldTitleHub)}; legacy=${occurrences(rerenderedText, legacyTail)}; oldTail=${occurrences(rerenderedText, oldTitleTail)}; destinationTail=${occurrences(rerenderedText, destinationTail)}`,
  );

  const cases = [
    ["Signal:/Power* Integrity?", "Signal Power Integrity.md"],
    [".hidden", "_.hidden.md"],
    ["CON", "_CON.md"],
    ["<>:\"/\\|?*", `${book.id}.md`],
    ["x".repeat(120), `${"x".repeat(100)}.md`],
  ];
  const sanitized = cases.every(([title, expected]) => {
    const candidate = structuredClone(book);
    candidate.metadata.title = title;
    const path = obsidian.bookHomePath(config, candidate);
    return basename(path) === expected && dirname(path) === bookDirectory;
  });
  check(
    "book-title filenames are portable and remain inside the book directory",
    sanitized,
    cases.map(([title, expected]) => `${JSON.stringify(title)}→${expected}`).join("; "),
  );

  const literalBookHome = structuredClone(revised);
  literalBookHome.metadata.title = "Book Home";
  literalBookHome.revision += 1;
  literalBookHome.updatedAt = new Date().toISOString();
  await storage.saveBookState(config, literalBookHome, revised.revision);
  await obsidian.renderScholarWorkspace(config, [literalBookHome]);
  const samePathHub = obsidian.bookHomePath(config, literalBookHome);
  const topLevelBookHubs = [];
  for (const entry of await readdir(bookDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
    const content = await readFile(join(bookDirectory, entry.name), "utf8");
    if (/^type:\s*scholar-book\s*$/m.test(content)) topLevelBookHubs.push(entry.name);
  }
  check(
    "a book literally titled Book Home is handled as the canonical same path",
    basename(samePathHub) === "Book Home.md"
      && await exists(samePathHub)
      && topLevelBookHubs.length === 1,
    `hub=${basename(samePathHub)}; scholar-book notes=${topLevelBookHubs.join(",")}`,
  );

  const recased = structuredClone(literalBookHome);
  recased.metadata.title = "book home";
  recased.revision += 1;
  recased.updatedAt = new Date().toISOString();
  await storage.saveBookState(config, recased, literalBookHome.revision);
  await obsidian.renderScholarWorkspace(config, [recased]);
  const recasedEntries = [];
  for (const entry of await readdir(bookDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
    const content = await readFile(join(bookDirectory, entry.name), "utf8");
    if (/^type:\s*scholar-book\s*$/m.test(content)) recasedEntries.push(entry.name);
  }
  check(
    "case-only title changes recase the graph node on Windows",
    recasedEntries.length === 1 && recasedEntries[0] === "book home.md",
    `scholar-book notes=${recasedEntries.join(",")}`,
  );

  const saveExpectations = [];
  let competingRevision;
  const service = createBookService({
    getConfig: () => config,
    load: storage.loadBookState,
    save: (saveConfig, saveBook, expectedRevision) => {
      saveExpectations.push(expectedRevision);
      return storage.saveBookState(saveConfig, saveBook, expectedRevision);
    },
    list: storage.listBookStates,
    project: async (projectConfig) => {
      const current = await storage.loadBookState(projectConfig, book.id);
      if (!current) throw new Error("CAS verifier could not load the just-saved authority.");
      const competing = structuredClone(current);
      competing.metadata.title = "CONCURRENT WRITER WINS";
      competing.revision += 1;
      competing.updatedAt = new Date().toISOString();
      competingRevision = competing.revision;
      await storage.saveBookState(projectConfig, competing, current.revision);
      throw new Error("forced projection failure after competing save");
    },
    onSave: () => undefined,
    librarySetupMessage: "library missing",
  });
  let rollbackError;
  let outcome;
  try {
    outcome = await service.mutateBook(book.id, (state) => {
      state.metadata.edition = "service mutation that must not overwrite its competitor";
    });
  } catch (error) {
    rollbackError = error;
  }
  const afterFailedRollback = await storage.loadBookState(config, book.id);
  check(
    "book-service preserves committed state and newer writer without rollback save",
    saveExpectations.length === 1
      && saveExpectations[0] === recased.revision
      && outcome?.projectionStatus === "pending"
      && afterFailedRollback?.revision === competingRevision
      && afterFailedRollback.metadata.title === "CONCURRENT WRITER WINS",
    rollbackError instanceof Error ? rollbackError.message : "projection failure unexpectedly triggered rollback or overwrote the competing writer",
  );
} catch (error) {
  check(
    "book-hub verifier execution",
    false,
    error instanceof Error ? error.stack || error.message : String(error),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

const failures = checks.filter((item) => !item.passed);
console.log(`\nScholar book-hub summary: ${checks.length - failures.length} passed, ${failures.length} failed.`);
process.exitCode = failures.length ? 1 : 0;
