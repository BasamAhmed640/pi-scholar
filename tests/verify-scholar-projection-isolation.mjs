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
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: {
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
  const { config, books: [bookA, bookB] } = await setup("service", ["a", "b"]);
  const brokenPath = sectionPath(config, bookA);
  const { broken } = await damage(brokenPath);
  const warnings = [];
  const saves = [];
  const service = serviceFor(config, warnings, saves);
  const first = await service.mutateBook(bookA.id, (book) => recordProgress(book, "First book progress survived."));
  assert.equal(first.result, "First book progress survived.");
  await assertAuthority(config, bookA, 1, first.result);
  const recovered = await assertRecovered(brokenPath, broken);
  assert((await readFile(sectionPath(config, bookA, 1), "utf8")).includes(first.result));
  assert(warnings.some((warning) => warning.path === brokenPath && /orphan/i.test(warning.reason)));
  passed("owned malformed note is rebuilt with its handwritten text quarantined while same-book progress, revision, healthy note, and warning commit");

  const second = await service.mutateBook(bookB.id, (book) => recordProgress(book, "Separate book progress survived."));
  await assertAuthority(config, bookB, 1, second.result);
  await assertAuthority(config, bookA, 1, first.result);
  assert.equal(await readFile(brokenPath, "utf8"), recovered, "a recovered note is stable across later projections");
  assert((await readFile(sectionPath(config, bookB), "utf8")).includes(second.result));
  assert.deepEqual(saves.map((book) => book.id), [bookA.id, bookB.id]);
  for (const book of [bookA, bookB]) {
    const previous = await json(join(dirname(storage.bookStatePath(config, book)), "book.prev.json"));
    assert.equal(previous.revision, 0, "a soft projection warning must not trigger a rollback save");
    assert.equal(previous.chapters[0].sections[0].synthesis, undefined);
  }
  passed("one book's damaged note cannot roll back another book; successful saves retain only the actual previous revision");

  const primaryA = storage.bookStatePath(config, bookA);
  const previousA = join(dirname(primaryA), "book.prev.json");
  const previousBytes = await readFile(previousA);
  await rm(primaryA);
  await service.renderAll();
  await assert.rejects(service.mutateBook(bookA.id, (book) => recordProgress(book, "Must not revive backup.")), /state is missing/);
  assert.equal(await storage.loadBookState(config, bookA.id), undefined);
  assert.equal(await exists(primaryA), false);
  assert.deepEqual(await readFile(previousA), previousBytes);
  assert.deepEqual((await storage.listBookStates(config)).map((book) => book.id), [bookB.id]);
  await assertAuthority(config, bookB, 1, second.result);
  passed("retained backup never becomes authority when a book manifest is deleted, even beside a damaged note");

  const fatal = await setup("fatal-ownership");
  const fatalBook = fatal.books[0];
  const fatalPath = sectionPath(fatal.config, fatalBook);
  const unrelated = (await readFile(fatalPath, "utf8")).replace('section_id: "section-1"', 'section_id: "some-other-section"');
  await writeFile(fatalPath, unrelated);
  const originalAuthority = await readFile(storage.bookStatePath(fatal.config, fatalBook));
  const healthyBefore = await readFile(sectionPath(fatal.config, fatalBook, 1));
  const fatalWarnings = [];
  const fatalSaves = [];
  const fatalService = serviceFor(fatal.config, fatalWarnings, fatalSaves);
  const outcome1 = await fatalService.mutateBook(fatalBook.id,
    (book) => recordProgress(book, "Progress committed; notes pending."));
  assert.equal(outcome1.projectionStatus, "pending");
  assert(outcome1.projectionError instanceof Error);
  assert.match(outcome1.projectionError.message, /unrelated chapter or section/);
  const after1 = await storage.loadBookState(fatal.config, fatalBook.id);
  assert.equal(after1.revision, 1);
  assert.equal(after1.chapters[0].sections[0].synthesis, "Progress committed; notes pending.");
  assert.deepEqual(await readFile(sectionPath(fatal.config, fatalBook, 1)), healthyBefore);
  assert.equal(await readFile(fatalPath, "utf8"), unrelated);
  assert.deepEqual(fatalWarnings, []);
  assert.equal(fatalSaves.length, 1);
  passed("genuine ownership failure marks projection pending while authoritative progress commits safely");

  await rm(fatalPath);
  await mkdir(fatalPath);
  const outcome2 = await fatalService.mutateBook(fatalBook.id,
    (book) => recordProgress(book, "Filesystem failure leaves progress committed."));
  assert.equal(outcome2.projectionStatus, "pending");
  assert.equal(outcome2.projectionError?.code, "EISDIR");
  const after2 = await storage.loadBookState(fatal.config, fatalBook.id);
  assert.equal(after2.revision, 2);
  assert.equal(after2.chapters[0].sections[0].synthesis, "Filesystem failure leaves progress committed.");
  assert.deepEqual(await readFile(sectionPath(fatal.config, fatalBook, 1)), healthyBefore);
  assert.deepEqual(fatalWarnings, []);
  assert.equal(fatalSaves.length, 2);
  passed("unexpected note filesystem errors leave progress committed with notes pending and no rollback");

  const runtime = await setup("coordinator");
  const runtimeBook = runtime.books[0];
  const runtimePath = sectionPath(runtime.config, runtimeBook);
  const runtimeDamage = await damage(runtimePath);
  const notices = [];
  const coordinator = coordinatorFor(runtime.config, (message) => notices.push(message));
  await coordinator.mutateBook(runtimeBook.id, (book) => recordProgress(book, "Coordinator progress one."));
  await coordinator.renderAll();
  await coordinator.mutateBook(runtimeBook.id, (book) => recordProgress(book, "Coordinator progress two."));
  assert.equal(notices.length, 1, "one recovery reports once, not once per projection");
  assert(notices[0].includes(runtimePath), "warning must identify the affected path");
  assert.match(notices[0], /orphan/i);
  assert.match(notices[0], /quarantine/i, "the notice must say where the recovered text went");
  await assertAuthority(runtime.config, runtimeBook, 2, "Coordinator progress two.");
  await assertRecovered(runtimePath, runtimeDamage.broken);
  await writeFile(runtimePath, runtimeDamage.original);
  await coordinator.renderAll();
  assert.equal(notices.length, 1);
  assert((await readFile(runtimePath, "utf8")).includes("Coordinator progress two."));
  await damage(runtimePath);
  await coordinator.mutateBook(runtimeBook.id, (book) => recordProgress(book, "Coordinator progress after recurrence."));
  assert.equal(notices.length, 2, "repair followed by a new damaged marker must warn again");
  await assertAuthority(runtime.config, runtimeBook, 3, "Coordinator progress after recurrence.");
  passed("runtime warning reaches notifier once per unresolved path and can recur after a successful repair");

  let throwingCalls = 0;
  // Recovery leaves the note healthy, so re-damage it to guarantee a warning
  // is actually pending when the throwing notifier is exercised.
  await damage(runtimePath);
  const throwingCoordinator = coordinatorFor(runtime.config, () => { throwingCalls++; throw new Error("Fixture UI notifier failed."); });
  await throwingCoordinator.mutateBook(runtimeBook.id, (book) => recordProgress(book, "Progress survives notifier failure."));
  assert.equal(throwingCalls, 1);
  await assertAuthority(runtime.config, runtimeBook, 4, "Progress survives notifier failure.");
  assert((await readFile(sectionPath(runtime.config, runtimeBook, 1), "utf8")).includes("Progress survives notifier failure."));
  passed("a throwing warning notifier cannot invalidate an otherwise valid mutation");
  console.log(`Scholar projection isolation: ${checks} passed, 0 failed.`);
} finally {
  for (const [key, value] of originalEnvironment) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  const withinTemporary = relative(temporaryParent, resolve(root));
  assert(withinTemporary && !isAbsolute(withinTemporary) && withinTemporary !== ".." && !withinTemporary.startsWith(`..${sep}`));
  assert(basename(root).startsWith("scholar-projection-isolation-"));
  await rm(root, { recursive: true, force: true });
}
