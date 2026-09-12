import { mkdir, readFile, readdir, rename, rm, rmdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { safePathWithinRoot, writeTextFileAtomic, ScholarRevisionConflictError } from "./storage.ts";
import { bookHomePath, bookNoteDirectory, sectionNotePath, tutorNotePath, examNotePath } from "./obsidian-paths.ts";
import { renderBook } from "./render/navigation.ts";
import { referencedFigureLines, renderSection } from "./render/section.ts";
import { renderExam, renderTutorSession, tutorSourceFigures } from "./render/assessment.ts";
import { GENERATED_END, isSectionMaterialized } from "./render/common.ts";
import { isScholarBook, scholarBookIssues } from "./state-schema.ts";
import { migrateLegacyCompletion, migrateLearnAssessmentKinds } from "./domain.ts";
import { deriveStatus, type ScholarBook, type ScholarConfig, type ScholarSection, type TutorSession } from "./types.ts";
import { attachDetails, blankSection, bookMetadata, examDocument, migrateVisibleQuestions, migrateVisibleTeaching, readDetails, readExamDocument, readStudyDocument, studyDocument } from "./note-records.ts";

// Only live in-process optimistic-concurrency snapshots, never a persistent cache.
const snapshots = new WeakMap<ScholarBook, Map<string, string>>();
async function maybeRead(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
async function markdownFiles(root: string): Promise<string[]> {
  try { return (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => resolve(root, entry.name)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
function preserveTail(document: string, previous?: string): string {
  if (!previous) return document;
  if ((previous.match(/^<!-- scholar:generated:end -->\r?$/gm) || []).length !== 1) throw new Error("A Scholar note has ambiguous end boundaries. Resolve the edit before saving; the original note was kept.");
  const index = previous.indexOf(GENERATED_END);
  if (index < 0) throw new Error("A Scholar note has no end boundary. Finish the edit or restore its boundary; its contents will not be overwritten.");
  return document.trimEnd() + previous.slice(index + GENERATED_END.length);
}
function validate(book: ScholarBook): void {
  if (!isScholarBook(book)) throw new Error(`Scholar notes contain invalid study records: ${scholarBookIssues(book).join("; ")}`);
}
function recordIdentity(text: string): string | undefined {
  for (const kind of ["book", "section", "exam", "tutor"]) {
    const data = readDetails(text, kind);
    if (data) return `${kind}:${data.id}`;
  }
  return undefined;
}

export async function readNoteBook(config: ScholarConfig, path: string): Promise<ScholarBook> {
  const files = new Map<string, string>();
  const read = async (file: string) => {
    const safe = await safePathWithinRoot(config.obsidianRoot, file);
    const text = await readFile(safe, "utf8"); files.set(safe, text); return text;
  };
  const metadata = readDetails(await read(path), "book");
  if (!metadata) throw new Error(`Missing Scholar book details: ${path}`);
  const book: ScholarBook = { ...metadata, chapters: metadata.chapters.map((chapter: any) => ({ ...chapter, sections: chapter.sections.map(blankSection) })), exams: [], tutorSessions: [] };
  const directory = bookNoteDirectory(config, book);
  if (resolve(dirname(path)).toLowerCase() !== directory.toLowerCase()) throw new Error(`Scholar book note is in the wrong folder: ${path}`);
  const sectionIds = new Set<string>();
  for (const file of await markdownFiles(resolve(directory, "Sections"))) {
    const text = await read(file);
    const data = readDetails(text, "section");
    if (!data) { files.delete(file); continue; }
    const chapter = book.chapters.find((chapter) => chapter.sections.some((section) => section.id === data.id));
    if (!chapter) throw new Error(`Unknown section in ${file}; restore its outline entry before continuing.`);
    if (sectionIds.has(data.id)) throw new Error(`Duplicate Scholar section: ${file}`);
    sectionIds.add(data.id);
    chapter.sections[chapter.sections.findIndex((section) => section.id === data.id)] = readStudyDocument(text, "section") as ScholarSection;
  }
  for (const file of await markdownFiles(resolve(directory, "Exams"))) {
    const text = await read(file);
    if (readDetails(text, "exam")) book.exams.push(readExamDocument(text));
    else files.delete(file);
  }
  for (const file of await markdownFiles(resolve(directory, "Tutor"))) {
    const text = await read(file);
    if (readDetails(text, "tutor")) book.tutorSessions.push(readStudyDocument(text, "tutor") as TutorSession);
    else files.delete(file);
  }
  book.exams.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  book.tutorSessions.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (!sectionIds.has(book.currentSectionId || "")) delete book.currentSectionId;
  if (!book.exams.some((exam) => exam.id === book.currentExamId)) delete book.currentExamId;
  if (!book.tutorSessions.some((tutor) => tutor.id === book.currentTutorId)) delete book.currentTutorId;
  for (const chapter of book.chapters) chapter.status = deriveStatus(chapter.sections);
  migrateLearnAssessmentKinds(migrateLegacyCompletion(book));
  validate(book);
  snapshots.set(book, files);
  return book;
}

function documents(config: ScholarConfig, book: ScholarBook): Map<string, string> {
  const result = new Map<string, string>();
  const add = (path: string, text: string) => {
    if ([...result.keys()].some((entry) => entry.toLowerCase() === path.toLowerCase())) throw new Error(`Two Scholar records target the same note: ${path}`);
    result.set(path, text);
  };
  for (const chapter of book.chapters) for (const section of chapter.sections) {
    const note = sectionNotePath(config, book, chapter, section);
    if (isSectionMaterialized(book, section)) add(note, studyDocument(renderSection(config, book, chapter, section), "section", section, question => referencedFigureLines(config, book, note, question, section.snapshots || [])));
  }
  for (const exam of book.exams) {
    const note = examNotePath(config, book, exam);
    add(note, examDocument(renderExam(config, book, exam), exam, question => referencedFigureLines(config, book, note, question, exam.snapshots || [])));
  }
  for (const tutor of book.tutorSessions) {
    const note = tutorNotePath(config, book, tutor);
    add(note, studyDocument(renderTutorSession(config, book, tutor), "tutor", tutor, question => referencedFigureLines(config, book, note, question, tutorSourceFigures(book, tutor))));
  }
  // Publish the book revision after its changed records.
  add(bookHomePath(config, book), attachDetails(renderBook(config, book), "book", bookMetadata(book)));
  return result;
}

export async function writeNoteBook(config: ScholarConfig, book: ScholarBook, expectedRevision?: number, migration = false): Promise<ScholarBook> {
  validate(book);
  const path = await safePathWithinRoot(config.obsidianRoot, bookHomePath(config, book));
  return withFileMutationQueue(`${path}:notes`, async () => {
    let previous = await maybeRead(path);
    let previousBookPath = path;
    if (expectedRevision !== undefined && !previous) {
      for (const candidate of await markdownFiles(bookNoteDirectory(config, book))) {
        const content = await readFile(candidate, "utf8");
        const record = readDetails(content, "book");
        if (record?.id === book.id) { previous = content; previousBookPath = candidate; break; }
      }
    }
    const currentMetadata = previous && readDetails(previous, "book");
    if (expectedRevision === undefined) {
      if (currentMetadata) throw new Error(`Scholar book already exists in this Obsidian vault: ${book.metadata.title}`);
    } else {
      if (!currentMetadata || currentMetadata.id !== book.id || currentMetadata.instanceId !== book.instanceId) throw new Error(`Scholar book authority was deleted or changed while saving: ${path}`);
      if (currentMetadata.revision !== expectedRevision) throw new ScholarRevisionConflictError(book.id, expectedRevision, currentMetadata.revision, path);
    }
    const snapshot = snapshots.get(book);
    const existingRecords = new Map<string, { path: string; text: string }>();
    for (const folder of [bookNoteDirectory(config, book), ...["Sections", "Exams", "Tutor"].map((name) => resolve(bookNoteDirectory(config, book), name))]) {
      for (const file of await markdownFiles(folder)) {
        const text = await readFile(await safePathWithinRoot(config.obsidianRoot, file), "utf8");
        const identity = recordIdentity(text);
        if (!identity) continue;
        if (existingRecords.has(identity)) throw new Error(`Duplicate Scholar record: ${file}`);
        existingRecords.set(identity, { path: file, text });
      }
    }
    const assertSnapshot = async () => {
      if (!snapshot) return;
      for (const [file, text] of snapshot) if (await maybeRead(file) !== text) throw new Error(`Scholar note changed while answering: ${file}. Your edit was kept. Retry after it finishes saving.`);
    };
    await assertSnapshot();
    const updates = new Map<string, { previous?: string; next: string }>();
    const moved = new Map<string, string>();
    for (const [file, generated] of documents(config, book)) {
      const safe = await safePathWithinRoot(config.obsidianRoot, file);
      const old = await maybeRead(safe);
      const oldRecord = existingRecords.get(recordIdentity(generated)!);
      if (old && recordIdentity(old) !== recordIdentity(generated) && !migration) throw new Error(`Another note already occupies ${safe}; it was left unchanged.`);
      if (old && !migration && expectedRevision === undefined && !readDetails(old, "book")) {
        // A deliberate new import must not quietly reclaim edited notes from another book.
        throw new Error(`A note already exists at ${safe}. Move that visible book folder before importing again.`);
      }
      const next = preserveTail(generated, oldRecord?.text || (safe === path ? previous : old));
      if (oldRecord && oldRecord.path !== safe) moved.set(oldRecord.path, oldRecord.text);
      if (next !== old) updates.set(safe, { previous: old, next });
    }
    await assertSnapshot();
    const written: string[] = [];
    try {
      for (const [file, update] of updates) {
        if (await maybeRead(file) !== update.previous) throw new Error(`Scholar note changed while saving: ${file}. Your edit was kept.`);
        await writeTextFileAtomic(config.obsidianRoot, file, update.next);
        written.push(file);
      }
    } catch (error) {
      // Roll back only our own bytes. An intervening Obsidian edit always wins.
      for (const file of written.reverse()) {
        const update = updates.get(file)!;
        if (await maybeRead(file) !== update.next) continue;
        if (update.previous === undefined) await rm(await safePathWithinRoot(config.obsidianRoot, file));
        else await writeTextFileAtomic(config.obsidianRoot, file, update.previous);
      }
      throw error;
    }
    snapshots.delete(book);
    for (const [oldPath, text] of moved) if (!updates.has(oldPath) && await maybeRead(oldPath) === text) await rm(await safePathWithinRoot(config.obsidianRoot, oldPath));
    return book;
  });
}

/** One-time conversion, never recovery: existing visible questions determine what survives. */
async function migrateBook(config: ScholarConfig, directory: string): Promise<void> {
  const legacy = await safePathWithinRoot(config.obsidianRoot, resolve(directory, ".scholar", "book.json"));
  const text = await maybeRead(legacy);
  if (!text) return;
  const book = migrateLearnAssessmentKinds(migrateLegacyCompletion(JSON.parse(text)));
  validate(book);
  const note = await maybeRead(bookHomePath(config, book));
  if (!note || !readDetails(note, "book")) {
    for (const chapter of book.chapters) for (const section of chapter.sections) {
      const visible = await maybeRead(sectionNotePath(config, book, chapter, section));
      section.attempts = visible ? migrateVisibleQuestions(visible, section.attempts) : [];
      section.transcript = migrateVisibleTeaching(visible, section);
    }
    for (const tutor of book.tutorSessions) {
      const visible = await maybeRead(tutorNotePath(config, book, tutor));
      tutor.attempts = visible ? migrateVisibleQuestions(visible, tutor.attempts) : [];
      tutor.transcript = migrateVisibleTeaching(visible, tutor);
    }
    delete book.recoveryCheckpoints;
    await writeNoteBook(config, book, undefined, true);
  }
  await readNoteBook(config, bookHomePath(config, book)); // Also verify a conversion interrupted before legacy cleanup.
  const oldDirectory = await safePathWithinRoot(config.obsidianRoot, resolve(directory, ".scholar"));
  // Preserve unrelated old files (for example a saved answer paper) visibly.
  // They are never read as study state. Resolve collisions before removing anything.
  const extras = (await readdir(oldDirectory)).filter((name) => !["book.json", "book.prev.json"].includes(name));
  const moves = await Promise.all(extras.map(async (name) => ({
    from: await safePathWithinRoot(config.obsidianRoot, resolve(oldDirectory, name)),
    to: await safePathWithinRoot(config.obsidianRoot, resolve(directory, "Legacy notes", name)),
  })));
  for (const move of moves) {
    try { await readFile(move.to); throw new Error(`Legacy file already exists: ${move.to}. Resolve the duplicate before conversion continues.`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  for (const move of moves) { await mkdir(dirname(move.to), { recursive: true }); await rename(move.from, move.to); }
  for (const name of ["book.json", "book.prev.json"]) await rm(await safePathWithinRoot(config.obsidianRoot, resolve(oldDirectory, name)), { force: true });
  await rmdir(oldDirectory);
}

export async function noteBookFiles(config: ScholarConfig): Promise<string[]> {
  if (!config.obsidianRoot) return [];
  const root = await safePathWithinRoot(config.obsidianRoot, resolve(config.obsidianRoot, "Scholar", "Books"));
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const result: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = await safePathWithinRoot(root, resolve(root, entry.name));
    await migrateBook(config, directory);
    for (const file of await markdownFiles(directory)) if (readDetails(await readFile(file, "utf8"), "book")) result.push(file);
  }
  return result.sort();
}
