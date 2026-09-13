import { sdkAliases } from "./sdk.mjs";
import { extensionPath as packagedExtensionPath, piPackageRoot as sdkRoot, jitiPath as sdkJitiPath, resolvePiDependency } from "./sdk.mjs";
// Real service/storage/projection integration; all authority and notes are disposable.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const requested = resolve(process.env.PI_SCHOLAR_EXTENSION || packagedExtensionPath);
const extension = basename(requested).toLowerCase() === "index.ts" ? dirname(requested) : requested;
const packageRoot = sdkRoot;
const piRequire = createRequire(join(packageRoot, "package.json"));
const { createJiti } = await import(pathToFileURL(sdkJitiPath).href);
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: { ...sdkAliases,
  "@earendil-works/pi-coding-agent": join(packageRoot, "dist", "index.js"),
  "@earendil-works/pi-tui": piRequire.resolve("@earendil-works/pi-tui"),
  typebox: piRequire.resolve("typebox"),
} });
const projection = await jiti.import(join(extension, "obsidian.ts"));
const storage = await jiti.import(join(extension, "storage.ts"));
const { createBookService } = await jiti.import(join(extension, "book-service.ts"));
const { ScholarRuntimeCoordinator } = await jiti.import(join(extension, "runtime-coordinator.ts"));
const temporaryParent = resolve(tmpdir());
const root = await mkdtemp(join(temporaryParent, "scholar-projection-isolation-"));
const originalEnvironment = new Map(["PI_SCHOLAR_LIBRARY_ROOT", "PI_SCHOLAR_OBSIDIAN_ROOT", "PI_SCHOLAR_STATE_ROOT"].map((key) => [key, process.env[key]]));
for (const key of originalEnvironment.keys()) delete process.env[key];
const now = "2026-09-04T12:00:00.000Z";
let checks = 0;
function passed(name) { checks++; console.log(`[PASS] ${name}`); }
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const exists = (path) => readFile(path).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; });

function bookFixture(config, key) {
  const id = key.repeat(64);
  return { schemaVersion: 3, revision: 0, id, instanceId: `isolation-${key}`, source: {
    absolutePath: join(config.libraryRoot, `Fixture-${key}.pdf`), relativePath: `Fixture-${key}.pdf`, fileName: `Fixture-${key}.pdf`, format: "pdf",
    fingerprint: { sha256: id, size: 1, mtimeMs: 1 },
  }, metadata: { title: `Projection Fixture ${key}`, authors: ["Fixture Author"], pageCount: 1 }, outlineStatus: "ready",
  chapters: [{ id: "chapter-1", number: "1", title: "Foundations", order: 1, startPage: 1, endPage: 1, status: "learning",
    sections: [1, 2].map((number) => ({ id: `section-${number}`, number: `1.${number}`, title: `Concept ${number}`, order: number,
      startPage: 1, endPage: 1, objectives: ["Explain the concept"], coveredObjectives: [], requiredChecks: [], status: "learning",
      keyPoints: [], misconceptions: [], attempts: [], transcript: [], createdAt: now, updatedAt: now })),
  }], exams: [], tutorSessions: [], noteDirectory: `Projection Fixture ${key}`, createdAt: now, updatedAt: now };
}
async function setup(folder, keys = ["a"]) {
  const config = { schemaVersion: 3, obsidianRoot: join(root, folder, "Vault"), libraryRoot: join(root, folder, "Library"), stateRoot: join(root, folder, "State"), updatedAt: now };
  await Promise.all([mkdir(config.obsidianRoot, { recursive: true }), mkdir(config.libraryRoot, { recursive: true })]);
  const books = keys.map((key) => bookFixture(config, key));
  for (const book of books) {
    await writeFile(book.source.absolutePath, "fixture");
    await storage.createBookState(config, book);
  }
  await projection.renderScholarWorkspace(config, books);
  return { config, books };
}
function sectionPath(config, book, index = 0) {
  return projection.sectionNotePath(config, book, book.chapters[0], book.chapters[0].sections[index]);
}
function recordProgress(book, text) {
  for (const section of book.chapters[0].sections) {
    section.coveredObjectives = [...section.objectives];
    section.synthesis = text;
    section.updatedAt = new Date().toISOString();
  }
  return text;
}
function serviceFor(config, warnings = [], saves = []) {
  return createBookService({ getConfig: () => config, load: storage.loadBookState, save: storage.saveBookState, list: storage.listBookStates,
    project: (activeConfig, books) => projection.renderScholarWorkspace(activeConfig, books, (warning) => warnings.push(warning)),
    onSave: (book) => saves.push(structuredClone(book)), librarySetupMessage: "Fixture library is missing.",
  });
}
function coordinatorFor(config, notify) {
  const coordinator = new ScholarRuntimeCoordinator({ appendEntry() {} }, () => () => {}, () => {}, notify);
  coordinator.setConfig(config);
  return coordinator;
}
/**
 * Damage a note in a way that stays genuinely ambiguous.
 *
 * A dangling start marker no longer qualifies: Scholar can prove nothing after
 * it is the reader's writing, so it heals that silently. An orphan end marker
 * still admits two readings of the same bytes, which is what this file is here
 * to test — recovery must warn and must not lose the handwritten text.
 */
async function damage(path) {
  const original = await readFile(path, "utf8");
  const broken = `${original}\nHandwritten note to retain.\n${projection.GENERATED_END}\nUnfinished personal edit.\n`;
  await writeFile(path, broken);
  return { original, broken };
}
/** Recovery rebuilds the note and keeps the unreadable text rather than freezing it. */
async function assertRecovered(path, broken) {
  const rebuilt = await readFile(path, "utf8");
  assert.notEqual(rebuilt, broken, `${path} must resume updating instead of staying frozen`);
  assert(rebuilt.includes(projection.QUARANTINE_START), `${path} must quarantine its unreadable text`);
  assert(rebuilt.includes("Handwritten note to retain."), `${path} must not lose handwritten text`);
  const balanced = (token) => rebuilt.split(token).length - 1;
  assert.equal(balanced(projection.GENERATED_START), balanced(projection.GENERATED_END), `${path} must end with balanced markers`);
  return rebuilt;
}
async function assertAuthority(config, book, revision, synthesis) {
  const primary = await json(storage.bookStatePath(config, book));
  const loaded = await storage.loadBookState(config, book.id);
  assert.equal(primary.revision, revision);
  assert.equal(loaded.revision, revision);
  assert.equal(primary.instanceId, book.instanceId);
  for (const section of primary.chapters[0].sections) {
    assert.equal(section.synthesis, synthesis);
    assert.deepEqual(section.coveredObjectives, section.objectives);
  }
}

try {
 const {config,books:[bookA,bookB]}=await setup("source-isolation",["a","b"]);
 const path=sectionPath(config,bookA); const original=await readFile(path,"utf8");
 const broken=original.replace('"format": "scholar-notes-v1"','"format": INVALID_JSON');
 await writeFile(path,broken);
 await assert.rejects(storage.loadBookState(config,bookA.id),/Invalid Scholar/);
 const warnings=[],saves=[];const service=serviceFor(config,warnings,saves);
 const other=await service.mutateBook(bookB.id,book=>recordProgress(book,"Other book remains writable."));
 assert.equal(other.book.revision,1);assert.equal(other.projectionStatus,"pending");
 assert.equal(await readFile(path,"utf8"),broken);
 assert.equal((await storage.loadBookState(config,bookB.id)).chapters[0].sections[0].synthesis,"Other book remains writable.");
 passed("a malformed section remains untouched while another book can save; navigation refresh reports pending");
 await writeFile(path,original); assert.equal((await service.sync()).synced,true);
 const oldBookNote=storage.bookStatePath(config,bookA); await rm(oldBookNote);
 assert.equal(await storage.loadBookState(config,bookA.id),undefined);
 await service.renderAll();assert.equal(await exists(oldBookNote),false);
 await assert.rejects(service.mutateBook(bookA.id,()=>{}),/missing/);
 assert.equal((await storage.loadBookState(config,bookB.id)).revision,1);
 passed("deleting one book note never restores it or alters another book");
 console.log("Scholar note isolation: "+checks+" passed, 0 failed.");

} finally {
  for (const [key, value] of originalEnvironment) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  const withinTemporary = relative(temporaryParent, resolve(root));
  assert(withinTemporary && !isAbsolute(withinTemporary) && withinTemporary !== ".." && !withinTemporary.startsWith(`..${sep}`));
  assert(basename(root).startsWith("scholar-projection-isolation-"));
  await rm(root, { recursive: true, force: true });
}
