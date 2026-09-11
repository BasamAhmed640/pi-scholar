import { extensionPath as packagedExtensionPath, piPackageRoot as sdkRoot, jitiPath as sdkJitiPath, resolvePiDependency } from "./sdk.mjs";
// DEFECT-10 regression: exercise the real coordinator, hashing, PDF tools,
// authoritative storage and source readers. Only the Pi UI/model boundary is
// stubbed. All PDF, vault and bootstrap writes stay in a disposable directory.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const piPackageRoot = sdkRoot;
const piRequire = createRequire(join(piPackageRoot, "package.json"));
const { createJiti } = await import(pathToFileURL(sdkJitiPath).href);
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: {
    "@earendil-works/pi-coding-agent": join(piPackageRoot, "dist", "index.js"),
    "@earendil-works/pi-tui": piRequire.resolve("@earendil-works/pi-tui"),
    typebox: piRequire.resolve("typebox"),
  },
});
const extensionDirectory = dirname(resolve(process.env.PI_SCHOLAR_EXTENSION
  || packagedExtensionPath));
const { ScholarRuntimeCoordinator } = await jiti.import(join(extensionDirectory, "runtime-coordinator.ts"));
const storage = await jiti.import(join(extensionDirectory, "storage.ts"));
const ingest = await jiti.import(join(extensionDirectory, "ingest.ts"));

function syntheticPdf(variant = "A") {
  const stream = [
    "BT", "/F1 11 Tf", "72 740 Td", "18 TL",
    "(Source freshness regression book) Tj", "T*",
    "(Chapter 1: Foundations) Tj", "T*",
    `(This PDF contains enough selectable text to verify source variant ${variant}.) Tj`, "ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let document = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(document);
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(document);
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) document += `${String(offset).padStart(10, "0")} 00000 n \n`;
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(document);
}

const temporaryParent = resolve(tmpdir());
const root = await mkdtemp(join(temporaryParent, "scholar-round3-source-"));
const libraryRoot = join(root, "library");
const sourceFolder = join(libraryRoot, "nested");
const vaultRoot = join(root, "vault");
const stateRoot = join(root, "bootstrap");
const sourcePath = join(sourceFolder, "source.pdf");
const originalBytes = syntheticPdf();
const originalId = createHash("sha256").update(originalBytes).digest("hex");
const environmentKeys = ["PI_SCHOLAR_LIBRARY_ROOT", "PI_SCHOLAR_OBSIDIAN_ROOT", "PI_SCHOLAR_STATE_ROOT"];
const originalEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
let passed = 0;
let failed = 0;

async function check(name, test) {
  try {
    await test();
    passed += 1;
    console.log(`[PASS] ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`[FAIL] ${name}: ${error.message}`);
  }
}

try {
  process.env.PI_SCHOLAR_LIBRARY_ROOT = libraryRoot;
  process.env.PI_SCHOLAR_OBSIDIAN_ROOT = vaultRoot;
  process.env.PI_SCHOLAR_STATE_ROOT = stateRoot;
  await Promise.all([mkdir(sourceFolder, { recursive: true }), mkdir(vaultRoot), mkdir(stateRoot)]);
  await writeFile(sourcePath, originalBytes);

  const pointers = [];
  let inputLocks = 0;
  let activeTools = [];
  const coordinator = new ScholarRuntimeCoordinator({
    getActiveTools: () => [...activeTools],
    setActiveTools: (names) => { activeTools = [...names]; },
    appendEntry: (_type, pointer) => pointers.push(structuredClone(pointer)),
    sendMessage: () => { throw new Error("Regression test must not trigger a model turn."); },
  }, () => {
    inputLocks += 1;
    return () => { inputLocks -= 1; };
  }, () => {});
  coordinator.setConfig(storage.resolveScholarConfig());
  coordinator.toolController = { resetTransientState() {}, ensureRegistered() {} };
  const context = {
    // Actual startBookSetup declines to start a model run when the host is busy.
    isIdle: () => false,
    ui: { notify() {}, setStatus() {}, setWorkingMessage() {} },
  };
  async function candidateAt(path) {
    const candidate = (await ingest.scanLibrary(coordinator.getConfig().libraryRoot))
      .find((item) => item.absolutePath === path);
    assert.ok(candidate, `Fixture candidate missing: ${path}`);
    return candidate;
  }
  const loadOriginal = () => storage.loadBookState(coordinator.getConfig(), originalId);
  async function open(path) {
    await coordinator.openCandidate(await candidateAt(path), context);
    assert.equal(inputLocks, 0, "openCandidate must release its input lock");
    assert.equal(coordinator.navigationRun, undefined);
    return storage.loadBookState(coordinator.getConfig(), coordinator.runtimeSession.bookId);
  }
  async function touch(path) {
    const before = await stat(path);
    await utimes(path, before.atime, new Date(Math.floor(before.mtimeMs) + 10_000));
    assert.notEqual((await stat(path)).mtimeMs, before.mtimeMs);
  }
  async function assertUsable(book, variant = "A") {
    assert.match(await ingest.extractSourcePages(book, 1, 1), new RegExp(`variant ${variant}`));
    assert.equal((await ingest.searchSource(book, `variant ${variant}`))[0]?.page, 1);
    const preview = await ingest.renderPdfPage(book, 1);
    assert.ok(preview.bytes > 0 && preview.width >= 32 && preview.height >= 32);
    const crop = await ingest.renderPdfCrop(book, 1, {
      x: 0, y: 0, width: 32, height: 32, canvasWidth: preview.width, canvasHeight: preview.height,
    });
    assert.equal(crop.width, 32);
    assert.equal(crop.height, 32);
  }
  async function assertRefreshed(before, path) {
    const after = await open(path);
    const candidate = await candidateAt(path);
    const inspected = await ingest.inspectBook(candidate);
    // Check usable source operations first: these are the actual user failure.
    await assertUsable(after);
    assert.equal(after.id, originalId);
    assert.equal(after.instanceId, before.instanceId);
    assert.equal(after.revision, before.revision + 1);
    assert.equal(after.source.absolutePath, candidate.absolutePath);
    assert.equal(after.source.relativePath, candidate.relativePath);
    assert.equal(after.source.fileName, candidate.fileName);
    assert.deepEqual(after.source.fingerprint, inspected.fingerprint);
    assert.deepEqual(after.chapters, before.chapters);
    assert.equal(after.currentSectionId, before.currentSectionId);
    assert.equal(after.outlineStatus, "ready");
    assert.equal(after.noteDirectory, before.noteDirectory);
    return after;
  }

  const initial = await open(sourcePath);
  assert.equal(initial.id, originalId);
  assert.equal(initial.outlineStatus, "pending");
  await assertUsable(initial);
  const { book: prepared } = await coordinator.mutateBook(originalId, (book) => {
    book.outlineStatus = "ready";
    book.currentSectionId = "section-one";
    book.chapters = [{
      id: "chapter-one", order: 1, title: "Foundations", startPage: 1, endPage: 1, status: "learning",
      sections: [{
        id: "section-one", order: 1, title: "First principle", startPage: 1, endPage: 1,
        status: "learning", objectives: ["Retain progress"], coveredObjectives: ["Retain progress"],
        requiredChecks: ["conceptual"], keyPoints: ["Preserve verified content identity"],
        misconceptions: [], attempts: [],
        transcript: [{ id: "lesson-one", kind: "assistant", markdown: "Existing lesson must survive reopening.", createdAt: book.createdAt }],
        createdAt: book.createdAt, updatedAt: book.updatedAt,
      }],
    }];
  });
  assert.ok(storage.isScholarBook(prepared));

  await check("opening an unchanged PDF leaves book revision, authority bytes and mtime unchanged", async () => {
    const before = await loadOriginal();
    const path = storage.bookStatePath(coordinator.getConfig(), before);
    const bytes = await readFile(path);
    const mtime = (await stat(path)).mtimeMs;
    assert.deepEqual(await open(sourcePath), before);
    assert.deepEqual(await readFile(path), bytes);
    assert.equal((await stat(path)).mtimeMs, mtime);
  });

  await check("same-path timestamp change rejects stale reads, then actual reopen restores every source operation", async () => {
    const before = await loadOriginal();
    await touch(sourcePath);
    await assert.rejects(ingest.extractSourcePages(before, 1, 1), /source changed since import/);
    await assertRefreshed(before, sourcePath);
  });

  await check("replacing a PDF with identical bytes keeps outline and progress while refreshing its timestamp", async () => {
    const before = await loadOriginal();
    const replacementPath = join(sourceFolder, "replacement.pdf");
    await writeFile(replacementPath, originalBytes);
    await touch(replacementPath);
    await rename(replacementPath, sourcePath);
    assert.notEqual((await stat(sourcePath)).mtimeMs, before.source.fingerprint.mtimeMs);
    await assertRefreshed(before, sourcePath);
  });

  await check("rebasing the library refreshes relativePath even when absolutePath and fingerprint stay fixed", async () => {
    const before = await loadOriginal();
    process.env.PI_SCHOLAR_LIBRARY_ROOT = sourceFolder;
    coordinator.setConfig(storage.resolveScholarConfig({ ...coordinator.getConfig(), libraryRoot: sourceFolder }));
    await assertRefreshed(before, sourcePath);
    assert.equal((await loadOriginal()).source.relativePath, "source.pdf");
  });

  const movedPath = join(sourceFolder, "renamed.pdf");
  await check("moving and renaming identical PDF content retains the original book authority", async () => {
    const before = await loadOriginal();
    await rename(sourcePath, movedPath);
    await assertRefreshed(before, movedPath);
  });

  await check("a stale stored file size is repaired only after matching the full-content SHA", async () => {
    const { book: before } = await coordinator.mutateBook(originalId, (book) => {
      book.source.fingerprint.size += 1;
    });
    await assert.rejects(ingest.extractSourcePages(before, 1, 1), /source changed since import/);
    await assertRefreshed(before, movedPath);
  });

  await check("repeated unchanged reopens after refresh do not churn book revisions", async () => {
    const before = await loadOriginal();
    assert.deepEqual(await open(movedPath), before);
    assert.deepEqual(await open(movedPath), before);
  });

  await check("same-size changed content gets a different book with no inherited outline, progress or authority", async () => {
    const before = await loadOriginal();
    const oldAuthorityPath = storage.bookStatePath(coordinator.getConfig(), before);
    const oldBytes = await readFile(oldAuthorityPath);
    const changedBytes = syntheticPdf("B");
    assert.equal(changedBytes.length, originalBytes.length);
    await writeFile(movedPath, changedBytes);
    await touch(movedPath);
    const changed = await open(movedPath);
    await assertUsable(changed, "B");
    assert.notEqual(changed.id, originalId);
    assert.equal(changed.id, createHash("sha256").update(changedBytes).digest("hex"));
    assert.notEqual(changed.instanceId, before.instanceId);
    assert.notEqual(changed.noteDirectory, before.noteDirectory);
    assert.equal(changed.outlineStatus, "pending");
    assert.equal(changed.revision, 0);
    assert.deepEqual(changed.chapters, []);
    assert.deepEqual(changed.exams, []);
    assert.deepEqual(changed.tutorSessions, []);
    assert.equal(changed.currentSectionId, undefined);
    assert.deepEqual(await loadOriginal(), before);
    assert.deepEqual(await readFile(oldAuthorityPath), oldBytes);
    assert.equal((await storage.listBookStates(coordinator.getConfig())).length, 2);
    const catalog = await storage.loadCatalog(coordinator.getConfig());
    assert.equal(catalog.currentBookId, changed.id);
    assert.equal(catalog.entries.find((entry) => entry.relativePath === "renamed.pdf")?.bookId, changed.id);
    assert.equal(pointers.at(-1).bookId, changed.id);
    assert.equal(inputLocks, 0);
  });
} finally {
  for (const [key, value] of originalEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const relativeRoot = relative(temporaryParent, resolve(root));
  assert.ok(relativeRoot.startsWith("scholar-round3-source-") && !isAbsolute(relativeRoot)
    && !relativeRoot.includes(sep), "Cleanup must target only this verifier's temporary directory");
  await rm(root, { recursive: true, force: true });
}

console.log(`Scholar round3 source gate: ${passed} passed, ${failed} failed.`);
process.exitCode = failed ? 1 : 0;
