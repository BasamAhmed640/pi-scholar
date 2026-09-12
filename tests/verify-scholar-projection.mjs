import { extensionPath as packagedExtensionPath, piPackageRoot as sdkRoot, jitiPath as sdkJitiPath, resolvePiDependency } from "./sdk.mjs";
// Projection safety gate: every mutation is confined to a disposable vault.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const requested = resolve(process.env.PI_SCHOLAR_EXTENSION || packagedExtensionPath);
const extension = basename(requested).toLowerCase() === "index.ts" ? dirname(requested) : requested;
const packageRoot = sdkRoot;
const { createJiti } = await import(pathToFileURL(sdkJitiPath).href);
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: { "@earendil-works/pi-coding-agent": join(packageRoot, "dist", "index.js") } });
const projection = await jiti.import(join(extension, "obsidian.ts"));
const storage = await jiti.import(join(extension, "storage.ts"));
const common = await jiti.import(join(extension, "render/common.ts"));
const root = await mkdtemp(join(tmpdir(), "scholar-projection-"));
const originalEnvironment = Object.fromEntries(["PI_SCHOLAR_LIBRARY_ROOT", "PI_SCHOLAR_OBSIDIAN_ROOT", "PI_SCHOLAR_STATE_ROOT"].map((key) => [key, process.env[key]]));
for (const key of Object.keys(originalEnvironment)) delete process.env[key];
const now = "2026-09-04T12:00:00.000Z";
let checks = 0;
function passed(name) { checks++; console.log(`[PASS] ${name}`); }
const count = (text, token) => text.split(token).length - 1;
const exists = (path) => readFile(path).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; });

function section(id, number, title, status = "learning") {
  return { id, number, title, order: 1, startPage: 1, endPage: 1, objectives: [], coveredObjectives: [], requiredChecks: [], status,
    keyPoints: [], misconceptions: [], attempts: [], transcript: [], createdAt: now, updatedAt: now };
}
function chapter(id, number, title, sections) {
  return { id, number, title, sections, order: Number(number) || 1, startPage: 1, endPage: 1, status: "learning" };
}
function bookFixture(folder) {
  const id = "a".repeat(64);
  return { schemaVersion: 3, revision: 0, id, instanceId: `fixture-${folder}`, source: {
    absolutePath: join(root, folder, "Library", "Fixture.pdf"), relativePath: "Fixture.pdf", fileName: "Fixture.pdf", format: "pdf",
    fingerprint: { sha256: id, size: 1, mtimeMs: 1 },
  }, metadata: { title: "Projection Fixture", authors: ["Fixture Author"], pageCount: 1 }, outlineStatus: "ready",
    chapters: [chapter("chapter-1", "1", "Foundations", [section("section-1", "1.1", "Concepts")])],
    exams: [], tutorSessions: [], noteDirectory: "Projection Fixture", createdAt: now, updatedAt: now };
}
async function setup(folder, mutate = () => {}) {
  const config = { schemaVersion: 3, obsidianRoot: join(root, folder, "Vault"), libraryRoot: join(root, folder, "Library"), stateRoot: join(root, folder, "State"), updatedAt: now };
  await Promise.all([mkdir(config.obsidianRoot, { recursive: true }), mkdir(config.libraryRoot, { recursive: true })]);
  const book = bookFixture(folder);
  mutate(book);
  book.chapters.forEach((item, index) => { item.order = index + 1; });
  await writeFile(book.source.absolutePath, "fixture");
  await storage.createBookState(config, book);
  return { config, book };
}
async function notesSnapshot(directory) {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && entry.name !== ".scholar") Object.assign(result, await notesSnapshot(path));
    else if (entry.isFile() && entry.name.endsWith(".md")) result[path] = await readFile(path, "utf8");
  }
  return result;
}

try {
  const { GENERATED_START: start, GENERATED_END: end } = common;
  assert.deepEqual(common.block("## Empty", ["", " \t "]), []);
  assert.deepEqual(common.collapsedRecord("Empty", [""]), []);
  assert.equal(common.collapsedRecord("Record", ["body", "", "    code"], "abstract").join("\n"), "\n> [!abstract]- Record\n> body\n>\n>     code\n");
  assert.equal(common.tableText("A | B\nC"), "A \\| B<br>C");
  assert(!common.markdownText(`${start}\n${end}`).includes(start));
  passed("shared blocks omit blank content, preserve indentation, and escape table/marker content");

  const plain = await setup("idempotence", (state) => {
    const scope = { chapterIds: ["chapter-1"], sectionIds: ["section-1"], description: "Fixture scope" };
    state.exams = [{ id: "graded-exam", title: "Graded Fixture", scope, status: "graded", questions: [{
      id: "q1", sectionIds: ["section-1"], claim: "Chooses the correct concept", requiredEvidence: ["Selects correct"], dimensions: ["concept"],
      format: "multiple-choice", prompt: "Which concept?", options: [{ value: "a", label: "Correct" }, { value: "b", label: "Incorrect" }],
      correctAnswer: "a", explanation: "The first concept applies.", maxPoints: 1,
    }], rawResponses: [{ questionId: "q1", response: "a" }], itemResults: [{ questionId: "q1", outcome: "correct", earnedPoints: 1, maxPoints: 1, feedback: "Correct." }],
      breakdown: [{ key: "section:section-1", label: "Concepts", earnedPoints: 1, maxPoints: 1, percent: 100 }], earnedPoints: 1, maxPoints: 1, percent: 100, transcript: [], createdAt: now, updatedAt: now, startedAt: now, submittedAt: now, gradedAt: now }];
    state.tutorSessions = [{ id: "tutor-1", title: "Tutor Fixture", scope, status: "active", keyPoints: [], attempts: [], transcript: [], createdAt: now, updatedAt: now }];
  });
  const { config, book } = plain;
  await projection.renderScholarWorkspace(config, [book]);
  const initial = await notesSnapshot(projection.scholarWorkspaceRoot(config));
  assert.equal(Object.keys(initial).length, 7);
  for (const [path, text] of Object.entries(initial)) {
    assert.equal(count(text, start), 1);
    await appendFile(path, `\nMy private note for ${basename(path)}\n`);
  }
  const withTails = await notesSnapshot(projection.scholarWorkspaceRoot(config));
  await projection.renderScholarWorkspace(config, [book]);
  assert.deepEqual(await notesSnapshot(projection.scholarWorkspaceRoot(config)), withTails);
  await projection.renderScholarWorkspace(config, [book]);
  assert.deepEqual(await notesSnapshot(projection.scholarWorkspaceRoot(config)), withTails);
  passed("full workspace renders twice and three times with byte-identical handwritten tails");


  const sectionPath = projection.sectionNotePath(config, book, book.chapters[0], book.chapters[0].sections[0]);
  const original = await readFile(sectionPath,"utf8");
  const edited=original.replace("<!-- scholar:generated:start -->","<!-- scholar:generated:start -->\nMY EDIT INSIDE THE NOTE\n");
  await writeFile(sectionPath,edited);
  await projection.renderScholarWorkspace(config,[book]);
  assert.equal(await readFile(sectionPath,"utf8"),edited);
  await rm(sectionPath);await projection.renderScholarWorkspace(config,[book]);
  assert.equal(await exists(sectionPath),false);
  assert.equal((await storage.loadBookState(config,book.id)).chapters[0].sections[0].status,"not-started");
  passed("refresh keeps source edits and does not recreate a deleted section");
  const collision = await setup("collisions", (state) => {
    state.chapters = [
      chapter("chapter-a", "1", "Repeated: Topic", [section("section-a", "1", "Local: Concept")]),
      chapter("chapter-b", "1", "Repeated? Topic", [section("section-b", "1", "Local? Concept", "not-started")]),
      chapter("chapter-c", "3", "Unique", [section("section-c", "3.1", "x".repeat(101))]),
      chapter("chapter-d", "4", "Other", [section("section-d", "3.1", `${"x".repeat(100)}y`)]),
    ];
  });
  let collidingBook = collision.book;
  const chapterPaths = collidingBook.chapters.map((item) => projection.chapterNotePath(collision.config, collidingBook, item));
  const sectionPaths = collidingBook.chapters.map((item) => projection.sectionNotePath(collision.config, collidingBook, item, item.sections[0]));
  assert.equal(new Set(chapterPaths.map((path) => path.toLowerCase())).size, 4);
  assert.equal(new Set(sectionPaths.map((path) => path.toLowerCase())).size, 4);
  assert.equal(basename(chapterPaths[2]), "Chapter 3 - Unique.md");
  assert.match(basename(chapterPaths[0]), /Repeated Topic - [a-f0-9]{12}\.md$/);
  const reordered = structuredClone(collidingBook);
  reordered.chapters.reverse();
  for (const item of reordered.chapters) assert.equal(projection.sectionNotePath(collision.config, reordered, item, item.sections[0]), sectionPaths[collidingBook.chapters.findIndex((candidate) => candidate.id === item.id)]);
  await projection.renderScholarWorkspace(collision.config, [collidingBook]);
  assert.equal(await exists(sectionPaths[1]), false);
  for (const index of [0, 2, 3]) await appendFile(sectionPaths[index], `\nOWNER ${index}\n`);
  const updated = structuredClone(collidingBook);
  updated.chapters[1].sections[0].status = "learning";
  updated.revision++;
  await storage.saveBookState(collision.config, updated, collidingBook.revision);
  collidingBook = updated;
  await projection.renderScholarWorkspace(collision.config, [collidingBook]);
  for (let index = 0; index < 4; index++) {
    const item = collidingBook.chapters[index];
    assert.equal(projection.sectionNotePath(collision.config, collidingBook, item, item.sections[0]), sectionPaths[index]);
    assert((await readFile(chapterPaths[index], "utf8")).includes(basename(sectionPaths[index], ".md")));
    if (index !== 1) assert.equal(count(await readFile(sectionPaths[index], "utf8"), `OWNER ${index}`), 1);
  }
  const collisionSnapshot = await notesSnapshot(projection.scholarWorkspaceRoot(collision.config));
  await projection.renderScholarWorkspace(collision.config, [collidingBook]);
  assert.deepEqual(await notesSnapshot(projection.scholarWorkspaceRoot(collision.config)), collisionSnapshot);
  passed("local-number, sanitized-title, and truncated-title collisions get unique stable links independent of materialization/order");

  const firstChapter = collidingBook.chapters[0];
  console.log("Scholar projection safety: "+checks+" passed, 0 failed.");
} finally {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  assert(root.startsWith(join(tmpdir(), "scholar-projection-")));
  await rm(root, { recursive: true, force: true });
}
