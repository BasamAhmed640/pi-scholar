import { extensionPath as packagedExtensionPath, piPackageRoot as sdkRoot, jitiPath as sdkJitiPath } from "./sdk.mjs";
// Focused disposable regression verifier for Scholar's vault-authority contract.
//
// The installed Scholar extension is tested by default. Override it only when
// deliberately verifying another build:
//   PI_SCHOLAR_EXTENSION=C:\\path\\to\\scholar\\index.ts node .\\work\\verify-scholar-vault-authority.mjs
//
// Every source PDF, vault, bootstrap file, and generated note used here lives in
// one temporary directory that is removed after the run.
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const piPackageRoot = sdkRoot;
const loaderPath = join(piPackageRoot, "dist", "core", "extensions", "loader.js");
const jitiPath = sdkJitiPath;
const extensionPath = resolve(
  process.env.PI_SCHOLAR_EXTENSION
    || packagedExtensionPath,
);
const extensionDirectory = dirname(extensionPath);
const storagePath = join(extensionDirectory, "storage.ts");

const { createExtensionRuntime, loadExtensions } = await import(pathToFileURL(loaderPath).href);
const { createJiti } = await import(pathToFileURL(jitiPath).href);
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: {
    "@earendil-works/pi-coding-agent": join(piPackageRoot, "dist", "index.js"),
  },
});
const storage = await jiti.import(storagePath);

const checks = [];
function check(name, condition, detail) {
  const passed = Boolean(condition);
  checks.push({ name, passed, detail });
  console.log(`[${passed ? "PASS" : "FAIL"}] ${name} - ${detail}`);
  return passed;
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function pdfLiteral(value) {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function syntheticPdf(variant) {
  const lines = [
    "Vault Authority Regression Book",
    "Chapter 1: Foundations",
    "1.1 First Principle",
    "A selected Obsidian vault is the sole authority for Scholar book state.",
    `This is source-library variant ${variant}.`,
  ];
  const commands = ["BT", "/F1 11 Tf", "72 740 Td", "18 TL"];
  lines.forEach((line, index) => {
    if (index) commands.push("T*");
    commands.push(`(${pdfLiteral(line)}) Tj`);
  });
  commands.push("ET");
  const stream = commands.join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let document = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(document, "latin1"));
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(document, "latin1");
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    document += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(document, "latin1");
}

function installRuntime(runtime, branch, sent) {
  let sequence = 0;
  runtime.appendEntry = (customType, data) => {
    const entry = {
      type: "custom",
      id: `vault-authority-${++sequence}`,
      parentId: null,
      timestamp: new Date().toISOString(),
      customType,
      data,
    };
    branch.push(entry);
    return entry;
  };
  runtime.sendMessage = (message, options) => sent.push({ message, options });
  runtime.sendUserMessage = (message, options) => sent.push({ message, options, user: true });
  runtime.refreshTools = () => {};
}

function createContext(root, branch, notifications, uiState) {
  let editorFactory;
  return {
    cwd: root,
    hasUI: true,
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => "scholar-vault-authority",
      getSessionFile: () => join(root, "session.jsonl"),
      getEntries: () => branch,
      getBranch: () => branch,
    },
    ui: {
      notify: (message, level) => notifications.push({ message, level }),
      setStatus: (key, value) => uiState.statuses.set(key, value),
      setWorkingMessage: (value) => uiState.workingMessages.push(value),
      setEditorText: (value) => uiState.editorTexts.push(value),
      setEditorComponent: (factory) => { editorFactory = factory; },
      getEditorComponent: () => editorFactory,
      select: async (_title, options) => options[0],
    },
  };
}

async function runHandlers(extension, eventName, event, context) {
  const results = [];
  for (const handler of extension.handlers.get(eventName) || []) {
    results.push(await handler(event, context));
  }
  return results;
}

async function loadScholar(root, branch = []) {
  const sent = [];
  const notifications = [];
  const uiState = { statuses: new Map(), workingMessages: [], editorTexts: [] };
  const runtime = createExtensionRuntime();
  installRuntime(runtime, branch, sent);
  const loaded = await loadExtensions([extensionPath], root, undefined, runtime);
  requireCondition(
    loaded.errors.length === 0 && loaded.extensions.length === 1,
    loaded.errors.length
      ? loaded.errors.map((item) => item.error).join("; ")
      : `Expected one Scholar extension, found ${loaded.extensions.length}.`,
  );
  const extension = loaded.extensions[0];
  const context = createContext(root, branch, notifications, uiState);
  await runHandlers(extension, "session_start", {}, context);
  const command = extension.commands.get("scholar");
  requireCondition(Boolean(command), "Loaded extension did not register /scholar.");
  return { branch, command, context, extension, notifications, sent, uiState };
}

async function exists(path) {
  return stat(path).then(() => true, (error) => {
    if (error?.code === "ENOENT") return false;
    throw error;
  });
}

function isInside(root, candidate) {
  const fromRoot = relative(resolve(root), resolve(candidate));
  return fromRoot === "" || (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`));
}

async function filesUnder(root) {
  const output = [];
  async function walk(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else output.push(path);
    }
  }
  await walk(root);
  return output.sort((left, right) => left.localeCompare(right));
}

function blankBook(book) {
  return book.revision === 0
    && book.outlineStatus === "pending"
    && Array.isArray(book.chapters) && book.chapters.length === 0
    && Array.isArray(book.exams) && book.exams.length === 0
    && Array.isArray(book.tutorSessions) && book.tutorSessions.length === 0
    && book.currentSectionId === undefined
    && book.currentExamId === undefined
    && book.currentTutorId === undefined;
}

const environmentNames = [
  "PI_SCHOLAR_LIBRARY_ROOT",
  "PI_SCHOLAR_OBSIDIAN_ROOT",
  "PI_SCHOLAR_STATE_ROOT",
];
const originalEnvironment = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]]));
const root = await mkdtemp(join(tmpdir(), "scholar-vault-authority-"));
const libraryA = join(root, "PDF Library A");
const libraryB = join(root, "PDF Library B");
const vaultA = join(root, "Obsidian Vault A");
const vaultB = join(root, "Obsidian Vault B");
const bootstrapRoot = join(root, "OS-local bootstrap");
const sourceFileName = "Vault Authority Regression Book.pdf";
const sourcePathA = join(libraryA, sourceFileName);
const sourcePathB = join(libraryB, sourceFileName);
const sourceBytesA = syntheticPdf("A");
const sourceBytesB = syntheticPdf("B");
const sourceHashA = createHash("sha256").update(sourceBytesA).digest("hex");
const sourceHashB = createHash("sha256").update(sourceBytesB).digest("hex");

try {
  process.env.PI_SCHOLAR_STATE_ROOT = bootstrapRoot;
  delete process.env.PI_SCHOLAR_LIBRARY_ROOT;
  delete process.env.PI_SCHOLAR_OBSIDIAN_ROOT;
  await Promise.all([
    mkdir(libraryA, { recursive: true }),
    mkdir(libraryB, { recursive: true }),
    mkdir(vaultA, { recursive: true }),
    mkdir(vaultB, { recursive: true }),
    mkdir(bootstrapRoot, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(sourcePathA, sourceBytesA),
    writeFile(sourcePathB, sourceBytesB),
    writeFile(join(root, "session.jsonl"), "", "utf8"),
  ]);
  const collisionMtime = new Date("2026-01-02T03:04:06.000Z");
  await Promise.all([
    utimes(sourcePathA, collisionMtime, collisionMtime),
    utimes(sourcePathB, collisionMtime, collisionMtime),
  ]);
  const [sourceStatsA, sourceStatsB] = await Promise.all([stat(sourcePathA), stat(sourcePathB)]);
  let unsafeLayoutError = "";
  try {
    storage.resolveScholarConfig({ libraryRoot: root, obsidianRoot: vaultA, stateRoot: bootstrapRoot });
  } catch (error) {
    unsafeLayoutError = error instanceof Error ? error.message : String(error);
  }
  check(
    "PDF library cannot contain Scholar write locations",
    /PDF library contains a Scholar write location/i.test(unsafeLayoutError),
    unsafeLayoutError || "unsafe overlapping roots were accepted",
  );
  check(
    "library collision fixture defeats path-size-mtime identity",
    !sourceBytesA.equals(sourceBytesB)
      && sourceHashA !== sourceHashB
      && basename(sourcePathA) === basename(sourcePathB)
      && sourceStatsA.size === sourceStatsB.size
      && sourceStatsA.mtimeMs === sourceStatsB.mtimeMs,
    `relative=${sourceFileName}; size=${sourceStatsA.size}/${sourceStatsB.size}; mtime=${sourceStatsA.mtimeMs}/${sourceStatsB.mtimeMs}`,
  );

  const first = await loadScholar(root);
  await first.command.handler(`obsidian ${JSON.stringify(vaultA)}`, first.context);
  await first.command.handler(`library ${JSON.stringify(libraryA)}`, first.context);
  await first.command.handler(`open ${JSON.stringify(sourceFileName)}`, first.context);
  const firstErrors = first.notifications.filter(({ message, level }) => level === "error" || /^Scholar error:/i.test(message));
  requireCondition(firstErrors.length === 0, firstErrors.map((item) => item.message).join("; "));

  const configA = await storage.loadConfig();
  const catalogA = await storage.loadCatalog(configA);
  const bookId = catalogA.currentBookId;
  requireCondition(typeof bookId === "string" && bookId.length > 0, "Vault A catalog has no currentBookId after open.");
  let originalBook = await storage.loadBookState(configA, bookId);
  requireCondition(Boolean(originalBook), "Vault A did not contain the opened book authority.");
  const scholarTool = first.extension.tools.get("scholar")?.definition;
  requireCondition(Boolean(scholarTool), "Scholar tool did not activate for the opened book.");
  const automaticOutline = await scholarTool.execute(
    "vault-authority-auto-outline",
    {
      action: "outline",
      outlineConfidence: "verified",
      chapters: [{
        number: "1",
        title: "Foundations",
        startPage: 1,
        endPage: 1,
        sections: [{ number: "1.1", title: "First Principle", startPage: 1, endPage: 1 }],
      }],
    },
    undefined,
    undefined,
    first.context,
  );
  originalBook = await storage.loadBookState(configA, bookId);
  requireCondition(Boolean(originalBook), "Automatically validated book authority disappeared.");
  check(
    "automatic validation persists only the ready outline",
    automaticOutline.details?.validationReport?.status === "ready"
      && !automaticOutline.content?.[0]?.text?.startsWith("Scholar error:")
      && originalBook.outlineStatus === "ready"
      && originalBook.currentSectionId === undefined
      && !Object.prototype.hasOwnProperty.call(originalBook, "outlineValidation"),
    automaticOutline.details?.summary || "no summary",
  );
  const [libraryFilesAfterValidation, sourceBytesAfterValidation, sourceStatsAfterValidation] = await Promise.all([
    filesUnder(libraryA),
    readFile(sourcePathA),
    stat(sourcePathA),
  ]);
  check(
    "automatic validation leaves the PDF library read-only",
    libraryFilesAfterValidation.length === 1
      && resolve(libraryFilesAfterValidation[0]) === resolve(sourcePathA)
      && sourceBytesAfterValidation.equals(sourceBytesA)
      && sourceStatsAfterValidation.size === sourceStatsA.size
      && sourceStatsAfterValidation.mtimeMs === sourceStatsA.mtimeMs,
    `${libraryFilesAfterValidation.length} library file(s); sha256=${createHash("sha256").update(sourceBytesAfterValidation).digest("hex").slice(0, 12)}`,
  );
  const originalStatePath = storage.bookStatePath(configA, originalBook);
  const visibleBookDirectory = dirname(dirname(originalStatePath));
  check(
    "book authority lives under selected vault",
    isInside(vaultA, originalStatePath)
      && relative(vaultA, originalStatePath).split(/[\\/]+/).includes("Books")
      && await exists(originalStatePath),
    relative(vaultA, originalStatePath),
  );
  const prePoisonBootstrapFiles = await filesUnder(bootstrapRoot);
  const bootstrapConfig = JSON.parse(await readFile(join(bootstrapRoot, "config.json"), "utf8"));
  check(
    "OS-local storage is only the selected-vault pointer",
    prePoisonBootstrapFiles.length === 1
      && basename(prePoisonBootstrapFiles[0]).toLowerCase() === "config.json"
      && Object.keys(bootstrapConfig).sort().join(",") === "obsidianRoot,schemaVersion,updatedAt",
    `${prePoisonBootstrapFiles.length} bootstrap file(s): ${prePoisonBootstrapFiles.map((path) => relative(bootstrapRoot, path)).join(", ")}`,
  );

  const oldInstanceId = originalBook.instanceId;
  requireCondition(typeof oldInstanceId === "string" && oldInstanceId.length > 0, "Opened book has no instanceId.");
  const oldInstanceAssistantMarker = "OLD INSTANCE A ASSISTANT TRANSCRIPT MUST NOT CROSS THE REIMPORT BOUNDARY";
  first.branch.push({
    type: "message",
    id: "old-instance-a-assistant",
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text: oldInstanceAssistantMarker }],
    },
  });
  const legacyBook = structuredClone(originalBook);
  legacyBook.instanceId = oldInstanceId;
  legacyBook.revision = 777;
  legacyBook.metadata.title = "LEGACY EXTERNAL BOOK MUST BE IGNORED";
  legacyBook.updatedAt = new Date().toISOString();
  const legacyBooksDirectory = join(bootstrapRoot, "books");
  await mkdir(legacyBooksDirectory, { recursive: true });
  await Promise.all([
    writeFile(join(legacyBooksDirectory, `${bookId}.json`), `${JSON.stringify(legacyBook, null, 2)}\n`, "utf8"),
    writeFile(join(bootstrapRoot, "catalog.json"), `${JSON.stringify({
      schemaVersion: legacyBook.schemaVersion,
      currentBookId: bookId,
      entries: [{
        relativePath: originalBook.source.relativePath,
        bookId,
        size: originalBook.source.fingerprint.size,
        mtimeMs: originalBook.source.fingerprint.mtimeMs,
      }],
    }, null, 2)}\n`, "utf8"),
  ]);

  await runHandlers(first.extension, "agent_settled", { type: "agent_settled" }, first.context);
  await first.command.handler("close", first.context);
  requireCondition(isInside(root, visibleBookDirectory), `Refusing to delete non-fixture path: ${visibleBookDirectory}`);
  await rm(visibleBookDirectory, { recursive: true, force: true });
  check(
    "deleting visible Obsidian book removes authority",
    !(await exists(visibleBookDirectory)) && await storage.loadBookState(configA, bookId) === undefined,
    "loadBookState returned undefined after the visible book directory was deleted",
  );

  const second = await loadScholar(root, first.branch);
  check(
    "legacy external book JSON is ignored",
    second.extension.tools.size === 0
      && await storage.loadBookState(await storage.loadConfig(), bookId) === undefined,
    "a stale Pi pointer plus external books/<id>.json did not reactivate the deleted book",
  );

  const sentBeforeReopen = second.sent.length;
  await second.command.handler(`open ${JSON.stringify(sourceFileName)}`, second.context);
  const secondErrors = second.notifications.filter(({ message, level }) => level === "error" || /^Scholar error:/i.test(message));
  requireCondition(secondErrors.length === 0, secondErrors.map((item) => item.message).join("; "));
  const reopenedConfig = await storage.loadConfig();
  const reopenedCatalog = await storage.loadCatalog(reopenedConfig);
  const reopenedBookId = reopenedCatalog.currentBookId;
  requireCondition(reopenedBookId === bookId, "Reopening the same unchanged PDF unexpectedly changed its content id.");
  const reopenedBook = await storage.loadBookState(reopenedConfig, reopenedBookId);
  requireCondition(Boolean(reopenedBook), "Reopening did not create new vault-local book authority.");
  check(
    "reopening deleted PDF import starts fresh",
    reopenedBook.instanceId !== oldInstanceId
      && reopenedBook.revision !== 777
      && reopenedBook.metadata.title !== legacyBook.metadata.title
      && blankBook(reopenedBook)
      && second.sent.slice(sentBeforeReopen).some((item) => item.message?.customType === "scholar-kickoff" && item.options?.triggerTurn === true),
    `old instance=${oldInstanceId}; new instance=${reopenedBook.instanceId}; revision=${reopenedBook.revision}; outline=${reopenedBook.outlineStatus}`,
  );

  const outlineTimestamp = new Date().toISOString();
  const chapterId = "chapter-001";
  const sectionId = "chapter-001-section-001";
  const outlinedBook = structuredClone(reopenedBook);
  outlinedBook.revision += 1;
  outlinedBook.outlineStatus = "ready";
  outlinedBook.chapters = [{
    id: chapterId,
    order: 1,
    number: "1",
    title: "Foundations",
    startPage: 1,
    endPage: 1,
    status: "learning",
    sections: [{
      id: sectionId,
      order: 1,
      number: "1.1",
      title: "Vault authority",
      startPage: 1,
      endPage: 1,
      objectives: ["Explain why the selected Obsidian vault is Scholar's book authority."],
      coveredObjectives: [],
      requiredChecks: ["conceptual", "application"],
      status: "learning",
      keyPoints: [],
      misconceptions: [],
      attempts: [],
      transcript: [],
      createdAt: outlineTimestamp,
      updatedAt: outlineTimestamp,
    }],
  }];
  outlinedBook.currentSectionId = sectionId;
  outlinedBook.updatedAt = outlineTimestamp;
  const outlineValid = storage.isScholarBook(outlinedBook);
  if (outlineValid) await storage.saveBookState(reopenedConfig, outlinedBook, reopenedBook.revision);
  const reloadedOutline = await storage.loadBookState(reopenedConfig, bookId);
  check(
    "stable chapter and section ids survive validation and save",
    outlineValid
      && reloadedOutline?.chapters.length === 1
      && reloadedOutline.chapters[0]?.id === chapterId
      && reloadedOutline.chapters[0]?.sections[0]?.id === sectionId
      && reloadedOutline.currentSectionId === sectionId,
    `chapter=${reloadedOutline?.chapters[0]?.id || "missing"}; section=${reloadedOutline?.chapters[0]?.sections[0]?.id || "missing"}`,
  );

  requireCondition(Boolean(reloadedOutline), "The saved realistic outline could not be reloaded.");
  const attemptTimestamp = new Date().toISOString();
  const attemptId = "assessment-roundtrip-open-001";
  const bookWithAttempt = structuredClone(reloadedOutline);
  bookWithAttempt.revision += 1;
  bookWithAttempt.updatedAt = attemptTimestamp;
  const attemptSection = bookWithAttempt.chapters[0]?.sections[0];
  requireCondition(Boolean(attemptSection), "The realistic section disappeared before the assessment round-trip.");
  attemptSection.attempts.push({
    id: attemptId,
    toolCallId: "roundtrip-open-001",
    kind: "conceptual",
    format: "open",
    question: "Why must deleting the visible Obsidian book directory make the book unknown to Scholar?",
    outcome: "pass",
    answerSummary: "The book-local authority no longer exists, so no external cache may resurrect it.",
    feedback: "The answer correctly identifies the vault-local existence boundary.",
    createdAt: attemptTimestamp,
  });
  attemptSection.updatedAt = attemptTimestamp;
  const attemptValid = storage.isScholarBook(bookWithAttempt);
  if (attemptValid) await storage.saveBookState(reopenedConfig, bookWithAttempt, reloadedOutline.revision);
  const reloadedAttemptBook = await storage.loadBookState(reopenedConfig, bookId);
  const reloadedAttempt = reloadedAttemptBook?.chapters[0]?.sections[0]?.attempts.find((attempt) => attempt.id === attemptId);
  check(
    "assessment-style attempt id survives validation and save",
    attemptValid
      && reloadedAttempt?.toolCallId === "roundtrip-open-001"
      && reloadedAttempt.outcome === "pass"
      && reloadedAttempt.kind === "conceptual",
    `attempt=${reloadedAttempt?.id || "missing"}; outcome=${reloadedAttempt?.outcome || "missing"}`,
  );

  await runHandlers(second.extension, "agent_settled", { type: "agent_settled" }, second.context);
  await second.command.handler(`learn ${JSON.stringify("1.1")}`, second.context);
  const currentInstanceAssistantMarker = "CURRENT INSTANCE B ASSISTANT TRANSCRIPT SHOULD BACKFILL";
  second.branch.push({
    type: "message",
    id: "current-instance-b-assistant",
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "text", text: currentInstanceAssistantMarker }],
    },
  });
  await runHandlers(second.extension, "agent_settled", { type: "agent_settled" }, second.context);
  await second.command.handler("backfill", second.context);
  const backfilledBook = await storage.loadBookState(reopenedConfig, bookId);
  const backfilledTranscript = backfilledBook?.chapters[0]?.sections[0]?.transcript || [];
  check(
    "backfill is isolated by book instanceId",
    backfilledBook?.instanceId === reopenedBook.instanceId
      && backfilledTranscript.some((entry) => entry.markdown.includes(currentInstanceAssistantMarker))
      && !backfilledTranscript.some((entry) => entry.markdown.includes(oldInstanceAssistantMarker)),
    `transcript entries=${backfilledTranscript.length}; current=${backfilledTranscript.some((entry) => entry.markdown.includes(currentInstanceAssistantMarker))}; old=${backfilledTranscript.some((entry) => entry.markdown.includes(oldInstanceAssistantMarker))}`,
  );
  const vaultABookFilesBeforeSwitch = (await filesUnder(join(vaultA, "Scholar", "Books")))
    .filter((path) => basename(path).toLowerCase() === "book.json");
  await second.command.handler(`obsidian ${JSON.stringify(vaultB)}`, second.context);
  const switchErrors = second.notifications.filter(({ message, level }) => level === "error" || /^Scholar error:/i.test(message));
  requireCondition(switchErrors.length === 0, switchErrors.map((item) => item.message).join("; "));
  const configB = await storage.loadConfig();
  const vaultBBooks = await storage.listBookStates(configB);
  const vaultBBookFiles = (await filesUnder(join(vaultB, "Scholar", "Books")))
    .filter((path) => basename(path).toLowerCase() === "book.json");
  const originalStillInA = await storage.loadBookState(reopenedConfig, bookId);
  check(
    "vault switching does not copy books",
    resolve(configB.obsidianRoot) === resolve(vaultB)
      && configB.currentBookId === undefined
      && vaultBBooks.length === 0
      && vaultBBookFiles.length === 0
      && vaultABookFilesBeforeSwitch.length === 1
      && originalStillInA?.instanceId === reopenedBook.instanceId
      && originalStillInA?.chapters[0]?.sections[0]?.attempts.some((attempt) => attempt.id === attemptId),
    `vault B books=${vaultBBooks.length}, vault B book.json=${vaultBBookFiles.length}, vault A preserved=${Boolean(originalStillInA)}`,
  );

  // Deliberately establish an A-source catalog hint inside vault B, then change
  // only B's source library. The two candidates have the same relative path,
  // byte length, and mtime, so a path/metadata cache would select the wrong PDF.
  await second.command.handler(`library ${JSON.stringify(libraryA)}`, second.context);
  await second.command.handler(`open ${JSON.stringify(sourceFileName)}`, second.context);
  const configBUsingA = await storage.loadConfig();
  const catalogBUsingA = await storage.loadCatalog(configBUsingA);
  const bookBUsingAId = catalogBUsingA.currentBookId;
  requireCondition(bookBUsingAId === sourceHashA, `Vault B did not fingerprint the A source as ${sourceHashA}.`);
  const bookBUsingA = await storage.loadBookState(configBUsingA, bookBUsingAId);
  requireCondition(Boolean(bookBUsingA), "Vault B did not create authority for the deliberate A-source collision hint.");
  check(
    "collision precondition stores an A-source hint in vault B",
    resolve(configBUsingA.libraryRoot) === resolve(libraryA)
      && catalogBUsingA.entries.length === 1
      && catalogBUsingA.entries[0]?.bookId === sourceHashA
      && catalogBUsingA.entries[0]?.relativePath === sourceFileName
      && catalogBUsingA.entries[0]?.size === sourceStatsA.size
      && catalogBUsingA.entries[0]?.mtimeMs === sourceStatsA.mtimeMs,
    `book=${bookBUsingAId}; entries=${catalogBUsingA.entries.length}; library=${configBUsingA.libraryRoot}`,
  );
  await runHandlers(second.extension, "agent_settled", { type: "agent_settled" }, second.context);

  await second.command.handler(`library ${JSON.stringify(libraryB)}`, second.context);
  const configBAfterLibrarySwitch = await storage.loadConfig();
  const catalogBAfterLibrarySwitch = await storage.loadCatalog(configBAfterLibrarySwitch);
  check(
    "changing a vault's library clears source catalog hints",
    resolve(configBAfterLibrarySwitch.obsidianRoot) === resolve(vaultB)
      && resolve(configBAfterLibrarySwitch.libraryRoot) === resolve(libraryB)
      && configBAfterLibrarySwitch.currentBookId === undefined
      && catalogBAfterLibrarySwitch.currentBookId === undefined
      && catalogBAfterLibrarySwitch.entries.length === 0,
    `entries=${catalogBAfterLibrarySwitch.entries.length}; current=${catalogBAfterLibrarySwitch.currentBookId || "none"}; library=${configBAfterLibrarySwitch.libraryRoot}`,
  );

  const sentBeforeBOpen = second.sent.length;
  await second.command.handler(`open ${JSON.stringify(sourceFileName)}`, second.context);
  const configBUsingB = await storage.loadConfig();
  const catalogBUsingB = await storage.loadCatalog(configBUsingB);
  const bookBUsingBId = catalogBUsingB.currentBookId;
  requireCondition(typeof bookBUsingBId === "string", "Vault B has no current book after opening its B source.");
  const bookBUsingB = await storage.loadBookState(configBUsingB, bookBUsingBId);
  requireCondition(Boolean(bookBUsingB), "Vault B did not create authority for its B source.");
  check(
    "same path-size-mtime PDF is fingerprinted instead of cache-reused",
    bookBUsingBId === sourceHashB
      && bookBUsingBId !== sourceHashA
      && bookBUsingB.source.fingerprint.sha256 === sourceHashB
      && bookBUsingB.instanceId !== bookBUsingA.instanceId
      && blankBook(bookBUsingB)
      && catalogBUsingB.entries.length === 1
      && catalogBUsingB.entries[0]?.bookId === sourceHashB
      && second.sent.slice(sentBeforeBOpen).some((item) => item.message?.customType === "scholar-kickoff" && item.options?.triggerTurn === true),
    `A=${sourceHashA.slice(0, 12)}; B=${bookBUsingBId.slice(0, 12)}; entries=${catalogBUsingB.entries.length}`,
  );
  await runHandlers(second.extension, "agent_settled", { type: "agent_settled" }, second.context);

  await second.command.handler(`obsidian ${JSON.stringify(vaultA)}`, second.context);
  const configAAfterRoundTrip = await storage.loadConfig();
  const catalogAAfterRoundTrip = await storage.loadCatalog(configAAfterRoundTrip);
  const stateAAfterRoundTrip = await storage.loadBookState(configAAfterRoundTrip, bookId);
  await second.command.handler(`obsidian ${JSON.stringify(vaultB)}`, second.context);
  const configBAfterRoundTrip = await storage.loadConfig();
  const catalogBAfterRoundTrip = await storage.loadCatalog(configBAfterRoundTrip);
  const stateBAfterRoundTrip = await storage.loadBookState(configBAfterRoundTrip, bookBUsingBId);
  check(
    "each vault retains its own source library and current book",
    resolve(configAAfterRoundTrip.obsidianRoot) === resolve(vaultA)
      && resolve(configAAfterRoundTrip.libraryRoot) === resolve(libraryA)
      && catalogAAfterRoundTrip.libraryRoot === resolve(libraryA)
      && catalogAAfterRoundTrip.currentBookId === bookId
      && stateAAfterRoundTrip?.instanceId === reopenedBook.instanceId
      && resolve(configBAfterRoundTrip.obsidianRoot) === resolve(vaultB)
      && resolve(configBAfterRoundTrip.libraryRoot) === resolve(libraryB)
      && catalogBAfterRoundTrip.libraryRoot === resolve(libraryB)
      && catalogBAfterRoundTrip.currentBookId === bookBUsingBId
      && stateBAfterRoundTrip?.instanceId === bookBUsingB.instanceId,
    `A library=${configAAfterRoundTrip.libraryRoot}; B library=${configBAfterRoundTrip.libraryRoot}`,
  );

  const laterErrors = second.notifications.filter(({ message, level }) => level === "error" || /^Scholar error:/i.test(message));
  requireCondition(laterErrors.length === 0, laterErrors.map((item) => item.message).join("; "));

  const corruptBookRoot = join(vaultB, "Scholar", "Books", "Corrupt authority");
  const corruptStateRoot = join(corruptBookRoot, ".scholar");
  await mkdir(corruptStateRoot, { recursive: true });
  await writeFile(join(corruptStateRoot, "book.json"), "{ not valid json", "utf8");
  let corruptAuthorityError = "";
  try {
    await storage.listBookStates(configBAfterRoundTrip);
  } catch (error) {
    corruptAuthorityError = error instanceof Error ? error.message : String(error);
  }
  check(
    "malformed vault authority fails closed",
    corruptAuthorityError.length > 0,
    corruptAuthorityError || "malformed authority was silently skipped",
  );
  await rm(corruptBookRoot, { recursive: true, force: true });

  // A v2 OS-local state tree may contribute only bootstrap paths. Its catalog,
  // current-book hint, and book JSON must never become vault-local authority.
  const migrationRoot = join(root, "V2 migration fixture");
  const migrationBootstrap = join(migrationRoot, "legacy external state");
  const migrationLibrary = join(migrationRoot, "legacy PDF library");
  const migrationVault = join(migrationRoot, "selected Obsidian vault");
  const migrationBooks = join(migrationBootstrap, "books");
  await Promise.all([
    mkdir(migrationBooks, { recursive: true }),
    mkdir(migrationLibrary, { recursive: true }),
    mkdir(migrationVault, { recursive: true }),
  ]);
  const migrationMarker = "LEGACY V2 EXTERNAL BOOK MUST NOT BE IMPORTED";
  const v2Book = structuredClone(legacyBook);
  v2Book.schemaVersion = 2;
  delete v2Book.instanceId;
  v2Book.revision = 888;
  v2Book.metadata.title = migrationMarker;
  v2Book.updatedAt = new Date().toISOString();
  const legacyV2Config = {
    schemaVersion: 2,
    libraryRoot: migrationLibrary,
    obsidianRoot: migrationVault,
    stateRoot: migrationBootstrap,
    currentBookId: v2Book.id,
    updatedAt: new Date().toISOString(),
  };
  await Promise.all([
    writeFile(join(migrationBootstrap, "config.json"), `${JSON.stringify(legacyV2Config, null, 2)}\n`, "utf8"),
    writeFile(join(migrationBootstrap, "catalog.json"), `${JSON.stringify({
      schemaVersion: 2,
      currentBookId: v2Book.id,
      entries: [{
        relativePath: v2Book.source.relativePath,
        bookId: v2Book.id,
        size: v2Book.source.fingerprint.size,
        mtimeMs: v2Book.source.fingerprint.mtimeMs,
      }],
    }, null, 2)}\n`, "utf8"),
    writeFile(join(migrationBooks, `${v2Book.id}.json`), `${JSON.stringify(v2Book, null, 2)}\n`, "utf8"),
  ]);

  const previousStateRoot = process.env.PI_SCHOLAR_STATE_ROOT;
  process.env.PI_SCHOLAR_STATE_ROOT = migrationBootstrap;
  try {
    const migratedConfig = await storage.loadConfig();
    const rewrittenPointer = JSON.parse(await readFile(join(migrationBootstrap, "config.json"), "utf8"));
    const migratedCatalog = await storage.loadCatalog(migratedConfig);
    const migratedBooks = await storage.listBookStates(migratedConfig);
    const migratedVaultFiles = await filesUnder(migrationVault);
    const migratedVaultBookFiles = migratedVaultFiles.filter((path) => basename(path).toLowerCase() === "book.json");
    const migratedVaultText = (await Promise.all(
      migratedVaultFiles
        .filter((path) => /\.(?:json|md)$/i.test(path))
        .map((path) => readFile(path, "utf8")),
    )).join("\n");
    check(
      "v2 bootstrap migration transfers paths but imports no authority",
      rewrittenPointer.schemaVersion === 3
        && resolve(rewrittenPointer.obsidianRoot) === resolve(migrationVault)
        && typeof rewrittenPointer.updatedAt === "string"
        && Object.keys(rewrittenPointer).sort().join(",") === "obsidianRoot,schemaVersion,updatedAt"
        && resolve(migratedConfig.obsidianRoot) === resolve(migrationVault)
        && resolve(migratedConfig.libraryRoot) === resolve(migrationLibrary)
        && migratedConfig.currentBookId === undefined
        && migratedCatalog.schemaVersion === 3
        && resolve(migratedCatalog.libraryRoot) === resolve(migrationLibrary)
        && migratedCatalog.currentBookId === undefined
        && migratedCatalog.entries.length === 0
        && migratedBooks.length === 0
        && migratedVaultBookFiles.length === 0
        && !migratedVaultText.includes(migrationMarker),
      `pointer keys=${Object.keys(rewrittenPointer).sort().join(",")}; catalog entries=${migratedCatalog.entries.length}; vault books=${migratedBooks.length}`,
    );
  } finally {
    if (previousStateRoot === undefined) delete process.env.PI_SCHOLAR_STATE_ROOT;
    else process.env.PI_SCHOLAR_STATE_ROOT = previousStateRoot;
  }
} catch (error) {
  check(
    "vault-authority harness execution",
    false,
    error instanceof Error ? error.stack || error.message : String(error),
  );
} finally {
  for (const name of environmentNames) {
    const previous = originalEnvironment[name];
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
  requireCondition(isInside(tmpdir(), root), `Refusing to remove non-temporary fixture root: ${root}`);
  await rm(root, { recursive: true, force: true });
}

const failures = checks.filter((item) => !item.passed);
console.log(`\nScholar vault-authority summary: ${checks.length - failures.length} passed, ${failures.length} failed.`);
process.exitCode = failures.length ? 1 : 0;
