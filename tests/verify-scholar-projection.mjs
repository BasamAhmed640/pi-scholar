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
  const original = await readFile(sectionPath, "utf8");
  await writeFile(sectionPath, `${original}\nInterstitial handwritten paragraph.\n${start}\nDUPLICATE GENERATED BODY\n${end}\nFinal handwritten paragraph.\n`);
  await projection.renderScholarWorkspace(config, [book]);
  const healed = await readFile(sectionPath, "utf8");
  assert.equal(count(healed, start), 1);
  assert.equal(count(healed, end), 1);
  assert(!healed.includes("DUPLICATE GENERATED BODY"));
  for (const text of ["My private note", "Interstitial handwritten paragraph.", "Final handwritten paragraph."]) assert.equal(count(healed, text), 1);
  await projection.renderScholarWorkspace(config, [book]);
  assert.equal(await readFile(sectionPath, "utf8"), healed);
  passed("duplicate generated regions self-heal without losing interstitial or trailing manual text");

  const literalTails = [
    `\n\nManual inline example: ${start} KEEP INLINE EXPLANATION ${end}.\n`,
    `\n\nManual HTML example:\n\`\`\`html\n${start}\nKEEP BACKTICK EXPLANATION\n${end}\n\`\`\`\n`,
    `\n\n~~~html\n${start}\nKEEP TILDE EXPLANATION\n${end}\n~~~\n`,
    `\n\n\`\`\`\`markdown\n\`\`\`html\n${start}\nKEEP LONG-FENCE EXPLANATION\n${end}\n\`\`\`\n\`\`\`\`\n`,
    `\n\n   ~~~~html\n${start}\nKEEP INDENTED-FENCE EXPLANATION\n${end}\n   ~~~~~\n`,
    `\r\n\r\n\`\`\`html\r\n${end}\r\nKEEP ORPHAN EXAMPLE\r\n${start}\r\n\`\`\`\r\n`,
    `\n\n    ${start}\n    KEEP INDENTED CODE EXPLANATION\n    ${end}\n`,
  ];
  for (const tail of literalTails) {
    assert.equal(common.preservedUserContent(`${start}\nGENERATED\n${end}${tail}`), tail);
  }
  const withLiteralExamples = healed + literalTails.join("");
  await writeFile(sectionPath, withLiteralExamples);
  await projection.renderScholarWorkspace(config, [book]);
  assert.equal(await readFile(sectionPath, "utf8"), withLiteralExamples);
  await projection.renderScholarWorkspace(config, [book]);
  assert.equal(await readFile(sectionPath, "utf8"), withLiteralExamples);
  passed("inline, backtick, tilde, longer, indented, and CRLF fenced marker examples survive repeated workspace renders verbatim");

  await writeFile(sectionPath, healed);
  const independentBook = structuredClone(bookFixture("idempotence"));
  independentBook.id = "b".repeat(64);
  independentBook.instanceId = "fixture-independent";
  independentBook.source.fingerprint.sha256 = independentBook.id;
  independentBook.source.absolutePath = join(config.libraryRoot, "Independent.pdf");
  independentBook.source.fileName = independentBook.source.relativePath = "Independent.pdf";
  independentBook.metadata.title = independentBook.noteDirectory = "Independent Fixture";
  await writeFile(independentBook.source.absolutePath, "independent fixture");
  await storage.createBookState(config, independentBook);
  const bothBooks = [book, independentBook];
  await projection.renderScholarWorkspace(config, bothBooks);
  const ownedNotes = Object.fromEntries(await Promise.all(Object.keys(initial).map(async (path) => [path, await readFile(path, "utf8")])));
  const independentPath = projection.bookHomePath(config, independentBook);
  const independentOriginal = await readFile(independentPath, "utf8");
  const stale = (content) => content.slice(0, content.indexOf(start) + start.length) + "\nSTALE GENERATED CONTENT\n" + content.slice(content.indexOf(end));
  // A truncated write leaves a dangling start marker. Nothing after it can be
  // the reader's writing, so Scholar rebuilds the note silently instead of
  // freezing it. `keepsTail` records whether the handwritten tail sat before
  // the dangling marker (retained) or was swallowed into the unclosed region
  // by deleting the end marker, where every projection rewrites it anyway.
  // Only a note with no end delimiter left anywhere is a genuine truncated
  // write. Both shapes below lose their end marker, which puts the handwritten
  // tail inside the unclosed region that every projection rewrites regardless.
  const healedVersions = (content) => [
    { broken: content.replace(end, ""), keepsTail: false },
    { broken: `${content.slice(0, content.indexOf(end))}`, keepsTail: false },
  ];
  // Nested and orphan markers admit two readings of the same bytes. Scholar
  // rebuilds the note anyway and keeps the unreadable text in a quarantine
  // block, so the note resumes updating without losing anything.
  // A dangling start below an intact region is hand-authored, not truncated:
  // the end marker is still there, so the reader's tail is real and is kept.
  const quarantinedVersions = (content) => [
    `${content}\n${start}\ntruncated`,
    `${content}\n${end}\norphan`, `${content}\n${start}\n${start}\n${end}`,
    content.replace(start, ""), content.replace(start, "").replace(end, ""),
  ];
  for (const [damagedPath, content] of Object.entries(ownedNotes)) {
    const [healthyPath, healthyContent] = Object.entries(ownedNotes).find(([path]) => path !== damagedPath);
    const restoreNeighbours = async () => {
      await writeFile(healthyPath, stale(healthyContent));
      await writeFile(independentPath, stale(independentOriginal));
    };
    const tailText = `My private note for ${basename(damagedPath)}`;
    for (const { broken, keepsTail } of healedVersions(content)) {
      await writeFile(damagedPath, broken);
      await restoreNeighbours();
      const warnings = [];
      await projection.renderScholarWorkspace(config, bothBooks, (warning) => warnings.push(warning));
      const healed = await readFile(damagedPath, "utf8");
      assert.equal(warnings.length, 0, "a truncated note heals without a warning");
      assert.equal(count(healed, start), 1, "the healed note has exactly one generated region");
      assert.equal(count(healed, end), 1, "the healed note closes its generated region");
      assert(!healed.includes("truncated"), "orphaned generated output is not kept");
      assert(!healed.includes(projection.QUARANTINE_START), "a knowable boundary needs no quarantine");
      assert.equal(count(healed, tailText), keepsTail ? 1 : 0, "a tail outside the unclosed region survives exactly once");
      // Healing is idempotent: the rebuilt note is stable and still silent.
      const second = [];
      await projection.renderScholarWorkspace(config, bothBooks, (warning) => second.push(warning));
      assert.equal(second.length, 0, "a healed note stops warning");
      assert.equal(await readFile(damagedPath, "utf8"), healed, "the healed note round-trips unchanged");
      assert.equal(await readFile(healthyPath, "utf8"), healthyContent);
      assert.equal(await readFile(independentPath, "utf8"), independentOriginal);
    }
    for (const broken of quarantinedVersions(content)) {
      await writeFile(damagedPath, broken);
      await restoreNeighbours();
      const warnings = [];
      await projection.renderScholarWorkspace(config, bothBooks, (warning) => warnings.push(warning));
      const rebuilt = await readFile(damagedPath, "utf8");
      assert.equal(warnings.length, 1);
      assert.equal(warnings[0].path, damagedPath);
      assert.match(warnings[0].reason, /orphan|nested|no generated markers|could not read/);
      assert(rebuilt.includes(projection.QUARANTINE_START), "unreadable text is quarantined, never discarded");
      assert(rebuilt.includes(projection.QUARANTINE_END), "the quarantine block is closed");
      assert.equal(count(rebuilt, start), count(rebuilt, end), "the rebuilt note has balanced markers");
      // The rescue must not re-break the note it rescued: a second projection
      // sees a healthy note, keeps the block verbatim, and warns no further.
      const second = [];
      await projection.renderScholarWorkspace(config, bothBooks, (warning) => second.push(warning));
      assert.equal(second.length, 0, "a quarantined note stops warning once rebuilt");
      assert.equal(await readFile(damagedPath, "utf8"), rebuilt, "the quarantine block round-trips unchanged");
      assert.equal(await readFile(healthyPath, "utf8"), healthyContent);
      assert.equal(await readFile(independentPath, "utf8"), independentOriginal);
    }
    await writeFile(damagedPath, content);
  }
  passed("all seven note types heal truncated markers silently, quarantine ambiguous ones once, and refresh same-book and unrelated-book notes throughout");

  const homePath = projection.scholarHomePath(config);
  const homeOriginal = ownedNotes[homePath];
  // The writer is the only reporter, so damage the note written first (home)
  // and let its warning damage notes written later. Each must still be found
  // and recovered within the same projection, one warning per path.
  const chapterPath = projection.chapterNotePath(config, book, book.chapters[0]);
  const brokenSection = `${healed}\n${end}\norphan`;
  const brokenHome = `${homeOriginal}\n${end}\norphan`;
  const brokenChapter = `${ownedNotes[chapterPath]}\n${end}\norphan`;
  await writeFile(homePath, brokenHome);
  const raceWarnings = [];
  await projection.renderScholarWorkspace(config, bothBooks, (warning) => {
    raceWarnings.push(warning);
    if (warning.path === homePath) writeFileSync(chapterPath, brokenChapter);
    if (warning.path === chapterPath) writeFileSync(sectionPath, brokenSection);
  });
  assert.deepEqual(raceWarnings.map(({ path }) => path).sort(), [sectionPath, homePath, chapterPath].sort());
  for (const [path, damaged] of [[homePath, brokenHome], [sectionPath, brokenSection], [chapterPath, brokenChapter]]) {
    const rebuilt = await readFile(path, "utf8");
    assert(rebuilt.includes(projection.QUARANTINE_START), `${path} quarantines its unreadable text`);
    assert.equal(count(rebuilt, start), count(rebuilt, end), `${path} has balanced markers after recovery`);
    assert.notEqual(rebuilt, damaged, `${path} resumed updating instead of staying frozen`);
  }
  for (const path of [homePath, sectionPath, chapterPath]) await writeFile(path, ownedNotes[path]);
  passed("marker damage introduced after preflight is recovered by the final writer with one warning per affected path");

  for (const [path, content] of Object.entries(ownedNotes)) {
    const unrelated = content.includes("book_id:") ? content.replace(/^book_id:.*$/m, `book_id: ${JSON.stringify("another-book")}`) : content.replace("type: scholar-home", "type: handwritten-home");
    await writeFile(path, `${unrelated}\n${end}\norphan`);
    const before = await notesSnapshot(projection.scholarWorkspaceRoot(config));
    await assert.rejects(projection.renderScholarWorkspace(config, bothBooks), /unrelated/);
    assert.deepEqual(await notesSnapshot(projection.scholarWorkspaceRoot(config)), before);
    await writeFile(path, content);
  }
  await writeFile(sectionPath, healed.replace(/^book_id:.*$/m, (line) => `${line}\nbook_id: "another-book"`));
  const beforeDuplicateOwner = await notesSnapshot(projection.scholarWorkspaceRoot(config));
  await assert.rejects(projection.renderScholarWorkspace(config, bothBooks), /unrelated/);
  assert.deepEqual(await notesSnapshot(projection.scholarWorkspaceRoot(config)), beforeDuplicateOwner);
  await writeFile(sectionPath, healed);
  passed("wrong or duplicate ownership remains globally fatal for every note type even when markers are also damaged");

  await writeFile(homePath, brokenHome);
  const replacedChapter = ownedNotes[chapterPath].replace(/^book_id:.*$/m, 'book_id: "another-book"');
  await assert.rejects(projection.renderScholarWorkspace(config, bothBooks, ({ path }) => {
    if (path === homePath) writeFileSync(chapterPath, replacedChapter);
  }), /unrelated chapter or section/);
  assert.equal(await readFile(chapterPath, "utf8"), replacedChapter);
  await writeFile(homePath, homeOriginal);
  await writeFile(chapterPath, ownedNotes[chapterPath]);
  passed("the final writer refuses an unrelated replacement introduced after ownership preflight");

  for (const [previousPath, currentPath] of [
    [projection.legacyScholarHomePath(config), homePath],
    [projection.legacyBookHomePath(config, book), projection.bookHomePath(config, book)],
  ]) {
    const current = await readFile(currentPath, "utf8");
    for (const damagedSide of ["source", "destination"]) {
      const legacyTail = "Legacy handwritten tail.";
      const damagedSource = `${current}\n${end}\norphan\n${legacyTail}\n`;
      await writeFile(previousPath, damagedSide === "source" ? damagedSource : `${current}\n${legacyTail}\n`);
      await writeFile(currentPath, damagedSide === "destination" ? `${current}\n${end}\norphan` : current);
      const migrationWarnings = [];
      await projection.renderScholarWorkspace(config, bothBooks, (warning) => migrationWarnings.push(warning));
      // The migration is abandoned, not attempted: nothing is renamed, merged
      // or unlinked, so the legacy file and its handwritten tail still exist.
      assert(await exists(previousPath), "a skipped migration must not delete its source");
      assert((await readFile(previousPath, "utf8")).includes(legacyTail), "the legacy tail is never lost");
      assert(migrationWarnings.some(({ reason }) => /not moved or merged/.test(reason)), "the skipped migration is reported");
      // Invariant 5: one damaged legacy file must not stop the vault refreshing.
      assert.equal(await readFile(independentPath, "utf8"), independentOriginal);
      await rm(previousPath);
      await writeFile(currentPath, current);
    }
  }
  await projection.renderScholarWorkspace(config, bothBooks);
  passed("malformed home and book-hub migrations are skipped with their source intact while every healthy note still refreshes");

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
  const oldSectionPath = join(projection.bookNoteDirectory(collision.config, collidingBook), "Sections", projection.sectionFileName(firstChapter, firstChapter.sections[0]));
  const oldChapterPath = join(projection.bookNoteDirectory(collision.config, collidingBook), "Chapters", projection.chapterFileName(firstChapter));
  const ownerZero = await readFile(sectionPaths[0], "utf8");
  for (const [previousPath, currentPath] of [[oldSectionPath, sectionPaths[0]], [oldChapterPath, chapterPaths[0]]]) {
    const current = await readFile(currentPath, "utf8");
    for (const damagedSide of ["source", "destination"]) {
      const legacyTail = "Legacy outline tail.";
      await writeFile(previousPath, damagedSide === "source" ? `${current}\n${end}\norphan\n${legacyTail}\n` : current);
      await writeFile(currentPath, damagedSide === "destination" ? `${current}\n${end}\norphan` : current);
      const migrationWarnings = [];
      await projection.renderScholarWorkspace(collision.config, [collidingBook], (warning) => migrationWarnings.push(warning));
      assert(await exists(previousPath), "a skipped outline migration must not delete its source");
      if (damagedSide === "source") {
        assert((await readFile(previousPath, "utf8")).includes(legacyTail), "the legacy outline tail is never lost");
      }
      assert(migrationWarnings.some(({ reason }) => /not moved or merged/.test(reason)), "the skipped outline migration is reported");
      await rm(previousPath);
      await writeFile(currentPath, current);
    }
  }
  await projection.renderScholarWorkspace(collision.config, [collidingBook]);
  passed("malformed chapter and section migrations are skipped with their source intact instead of failing the projection");
  await writeFile(oldSectionPath, `${ownerZero}\nOLD SHARED FILE OWNER A\n`);
  await appendFile(sectionPaths[0], "\nCURRENT FILE OWNER A\n");
  await rename(chapterPaths[0], oldChapterPath);
  await appendFile(oldChapterPath, "\nOLD CHAPTER OWNER A\n");
  const otherOwnerBefore = await readFile(sectionPaths[1], "utf8");
  await projection.renderScholarWorkspace(collision.config, [collidingBook]);
  const migrated = await readFile(sectionPaths[0], "utf8");
  assert(migrated.includes("OLD SHARED FILE OWNER A"));
  assert(migrated.includes("CURRENT FILE OWNER A"));
  assert((await readFile(chapterPaths[0], "utf8")).includes("OLD CHAPTER OWNER A"));
  assert.equal(await readFile(sectionPaths[1], "utf8"), otherOwnerBefore);
  assert.equal(await exists(oldSectionPath), false);
  assert.equal(await exists(oldChapterPath), false);
  await projection.renderScholarWorkspace(collision.config, [collidingBook]);
  assert.equal(await readFile(sectionPaths[0], "utf8"), migrated);
  passed("legacy shared chapter/section files migrate only to their frontmatter owner, retaining both same-owner tails");

  await writeFile(oldSectionPath, "Handwritten note with no reliable owner.\n");
  const beforeAmbiguous = await notesSnapshot(projection.scholarWorkspaceRoot(collision.config));
  await assert.rejects(projection.renderScholarWorkspace(collision.config, [collidingBook]), /identify the owner/);
  assert.deepEqual(await notesSnapshot(projection.scholarWorkspaceRoot(collision.config)), beforeAmbiguous);
  await rm(oldSectionPath);
  await writeFile(sectionPaths[0], otherOwnerBefore);
  const beforeWrongOwner = await notesSnapshot(projection.scholarWorkspaceRoot(collision.config));
  await assert.rejects(projection.renderScholarWorkspace(collision.config, [collidingBook]), /unrelated chapter or section/);
  assert.deepEqual(await notesSnapshot(projection.scholarWorkspaceRoot(collision.config)), beforeWrongOwner);
  passed("ambiguous legacy files and wrong-owner destinations fail closed without cross-owner tail merging or overwrites");

  const exams = await setup("exam-key-collision", (state) => {
    state.exams = ["Exam", "Exam — Answer Key"].map((title, index) => ({ id: `exam-${index}`, title, scope: { chapterIds: ["chapter-1"], sectionIds: ["section-1"], description: "Fixture" }, status: "draft", questions: [], rawResponses: [], itemResults: [], breakdown: [], earnedPoints: 0, maxPoints: 0, percent: 0, transcript: [], createdAt: now, updatedAt: now }));
  });
  await assert.rejects(projection.renderScholarWorkspace(exams.config, [exams.book]), /same note path/);
  assert.deepEqual(await notesSnapshot(projection.scholarWorkspaceRoot(exams.config)), {});
  passed("exam/answer-key collisions are reserved and rejected before the first note write");
  console.log(`Scholar projection safety: ${checks} passed, 0 failed.`);
} finally {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  assert(root.startsWith(join(tmpdir(), "scholar-projection-")));
  await rm(root, { recursive: true, force: true });
}
