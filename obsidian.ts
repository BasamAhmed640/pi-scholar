import { mkdir, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { loadMatchingBookAuthority, safePathWithinRoot, writeTextFileAtomic } from "./storage.ts";
import type { ScholarBook, ScholarConfig } from "./types.ts";

import {
  answerKeyNotePath,
  BOOKS_FOLDER,
  SCHOLAR_FOLDER,
  bookHomePath,
  bookHubFileName,
  bookNoteDirectory,
  chapterFileName,
  chapterNotePath,
  configuredVaultRoot,
  examAnswerNotePath,
  examFileName,
  examNotePath,
  legacyBookHomePath,
  legacyScholarHomePath,
  orderedPrefix,
  pathFromRoot,
  referenceImageAssetPath,
  relativeNoteDirectory,
  safeNoteSegment,
  scholarHomePath,
  scholarWorkspaceRoot,
  sectionFileName,
  sectionNotePath,
  snapshotAssetPath,
  tutorFileName,
  tutorNotePath,
} from "./obsidian-paths.ts";

import {
  GENERATED_END,
  GENERATED_START,
  GeneratedMarkerError,
  LEGACY_BOOK_HUB_TAIL_END,
  LEGACY_BOOK_HUB_TAIL_START,
  LEGACY_HOME_TAIL_END,
  LEGACY_HOME_TAIL_START,
  QUARANTINE_END,
  QUARANTINE_START,
  frontmatter,
  block,
  collapsedRecord,
  generatedDocument,
  isSectionMaterialized,
  markdownText,
  pageRange,
  portableRelative,
  preservedUserContent,
  progress,
  quarantineBlock,
  readableOutcome,
  referenceImageLines,
  removeLeadingFrontmatter,
  statusGlyph,
  statusLabel,
  titleCase,
  tableText,
  tableWikiLink,
  transcriptCallout,
  transcriptLines,
  unknownMarkdown,
  untrustedInline,
  wikiAlias,
  wikiEmbed,
  wikiLink,
  yaml,
} from "./render/common.ts";

import {
  renderBook,
  renderChapter,
  renderScholarHome,
} from "./render/navigation.ts";

import {
  answerPresentation,
  assessmentSummaryLine,
  comparableTranscriptText,
  passedCheckKinds,
  renderSection,
  sectionAnswerLines,
  sectionQuestionLines,
  sectionTeachingLines,
} from "./render/section.ts";

import {
  calloutLines,
  displayedCorrectAnswer,
  examAnswerNoteText,
  examQuestionLines,
  gradedQuestionLines,
  renderExam,
  renderExamAnswerKey,
  renderTutorSession,
  scopeLines,
  type ExamItemResult,
  type ExamQuestion,
} from "./render/assessment.ts";

// Re-export all path helpers, renderers, and formatting utilities so obsidian.ts
// remains a complete, non-breaking public façade for tests and existing callers.
export {
  BOOKS_FOLDER,
  GENERATED_END,
  GENERATED_START,
  GeneratedMarkerError,
  LEGACY_BOOK_HUB_TAIL_END,
  LEGACY_BOOK_HUB_TAIL_START,
  LEGACY_HOME_TAIL_END,
  LEGACY_HOME_TAIL_START,
  QUARANTINE_END,
  QUARANTINE_START,
  SCHOLAR_FOLDER,
  answerPresentation,
  assessmentSummaryLine,
  bookHomePath,
  bookHubFileName,
  bookNoteDirectory,
  block,
  calloutLines,
  chapterFileName,
  chapterNotePath,
  comparableTranscriptText,
  collapsedRecord,
  configuredVaultRoot,
  displayedCorrectAnswer,
  examAnswerNotePath,
  examAnswerNoteText,
  examFileName,
  examNotePath,
  examQuestionLines,
  frontmatter,
  generatedDocument,
  gradedQuestionLines,
  legacyBookHomePath,
  legacyScholarHomePath,
  markdownText,
  orderedPrefix,
  pageRange,
  passedCheckKinds,
  pathFromRoot,
  portableRelative,
  preservedUserContent,
  progress,
  readableOutcome,
  referenceImageAssetPath,
  referenceImageLines,
  relativeNoteDirectory,
  removeLeadingFrontmatter,
  renderBook,
  renderChapter,
  renderExam,
  renderExamAnswerKey,
  renderScholarHome,
  renderSection,
  renderTutorSession,
  safeNoteSegment,
  scholarHomePath,
  scholarWorkspaceRoot,
  scopeLines,
  sectionAnswerLines,
  sectionFileName,
  sectionNotePath,
  sectionQuestionLines,
  sectionTeachingLines,
  snapshotAssetPath,
  statusGlyph,
  statusLabel,
  titleCase,
  tableText,
  tableWikiLink,
  transcriptCallout,
  transcriptLines,
  tutorFileName,
  tutorNotePath,
  unknownMarkdown,
  untrustedInline,
  wikiAlias,
  wikiEmbed,
  wikiLink,
  yaml,
  type ExamItemResult,
  type ExamQuestion,
};

export type ScholarProjectionWarning = { path: string; reason: string };
type NoteIdentity = { type: string } & Record<string, string>;
type ProjectionArtifact = { id: string; title: string; path: string; identity: NoteIdentity; learnerOwned?: boolean };

/** Ownership comes from unambiguous metadata, independently of marker health. */
function belongsToGeneratedNote(content: string, identity: NoteIdentity): boolean {
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
  if (!header) return false;
  const lines = header.split(/\r?\n/);
  return Object.entries(identity).every(([key, value]) => {
    const fields = lines.filter((line) => line.startsWith(`${key}:`));
    return fields.length === 1 && fields[0]!.slice(key.length + 1).trim() === (key === "type" ? value : JSON.stringify(value));
  });
}

export function validateNoteOwnership(content: string, identity: NoteIdentity, path: string): void {
  if (!belongsToGeneratedNote(content, identity)) {
    const kind = identity.type === "scholar-chapter" || identity.type === "scholar-section" ? "chapter or section note" : "note";
    throw new Error(`Scholar cannot replace an unrelated ${kind}: ${path}`);
  }
}

/**
 * Can this note's generated boundary be read?
 *
 * Moving or merging a note whose boundary is unreadable risks losing the tail,
 * so migrations ask first and skip rather than guess. A migration that is
 * skipped leaves both files exactly where they are: the reader loses nothing,
 * the note keeps updating in place, and the next projection can retry — unlike
 * a thrown error, which would stop every other note in the vault from
 * refreshing because one legacy file is damaged.
 */
function markersAreReadable(content: string): boolean {
  try {
    preservedUserContent(content, true);
    return true;
  } catch (error) {
    if (!(error instanceof GeneratedMarkerError)) throw error;
    return false;
  }
}

function skipMigration(
  path: string,
  onWarning: ((warning: ScholarProjectionWarning) => void) | undefined,
): false {
  onWarning?.({
    path,
    reason: "Scholar found a generated boundary it could not read, so this note was not moved or merged.",
  });
  return false;
}

async function writeGeneratedNote(
  root: string,
  filePath: string,
  generated: string,
  identity: NoteIdentity,
  onWarning: (warning: ScholarProjectionWarning) => void,
): Promise<void> {
  const safePath = await safePathWithinRoot(root, filePath);
  let existingContent: string | undefined;
  let userContent: string | undefined;
  try {
    existingContent = await readFile(safePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let quarantined = "";
  if (existingContent !== undefined) {
    validateNoteOwnership(existingContent, identity, filePath);
    try {
      userContent = preservedUserContent(existingContent, true);
    } catch (error) {
      if (!(error instanceof GeneratedMarkerError)) throw error;
      // The boundary is ambiguous, but the bytes are not precious: they can be
      // moved. Rebuild the note so it resumes updating and keep the old text in
      // a labelled block, rather than freezing the note indefinitely to protect
      // text the reader can still see and decide about.
      quarantined = quarantineBlock(error.quarantineBody);
      userContent = undefined;
      if (quarantined) onWarning({ path: filePath, reason: error.message });
    }
  }
  const tail = quarantined ? `\n\n${quarantined}\n` : userContent;
  // A CRLF note's tail begins "\r\n", so a plain startsWith("\n") test misses it
  // and injects a stray LF, giving the note mixed endings and breaking the
  // byte-identical round trip on every projection.
  const separator = tail && !/^\r?\n/.test(tail) ? "\n" : "";
  const content = tail ? `${generated.trimEnd()}${separator}${tail}` : `${generated.trimEnd()}\n`;
  if (existingContent === content) return;
  await writeTextFileAtomic(root, safePath, content);
}

export async function migrateGeneratedNote(
  root: string,
  previousPath: string,
  currentPath: string,
  tailStart: string,
  tailEnd: string,
  onWarning?: (warning: ScholarProjectionWarning) => void,
): Promise<void> {
  const previous = await safePathWithinRoot(root, previousPath);
  const current = await safePathWithinRoot(root, currentPath);
  const samePath = process.platform === "win32"
    ? previous.toLowerCase() === current.toLowerCase()
    : previous === current;
  if (samePath) return;

  const [previousExists, currentExists] = await Promise.all([
    stat(previous).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    }),
    stat(current).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    }),
  ]);
  if (!previousExists) return;
  // Validate boundaries before moving even when the destination does not exist.
  // An unreadable source is skipped, never renamed and never unlinked: this
  // path deletes a file, so it must not run on a note whose tail it cannot find.
  if (!markersAreReadable(await readFile(previous, "utf8"))) {
    skipMigration(previousPath, onWarning);
    return;
  }
  if (!currentExists) {
    await rename(previous, current);
    return;
  }

  // If an interrupted or manual migration left both notes, retain any writing
  // outside Scholar's generated block exactly once, then remove the stale hub.
  const [previousContent, currentContent] = await Promise.all([
    readFile(previous, "utf8"),
    readFile(current, "utf8"),
  ]);
  if (!markersAreReadable(currentContent)) {
    skipMigration(currentPath, onWarning);
    return;
  }
  const previousTail = preservedUserContent(previousContent, true).trim();
  const migratedTailBlock = `${tailStart}\n${previousTail}\n${tailEnd}`;
  if (previousTail && !currentContent.includes(migratedTailBlock)) {
    await writeTextFileAtomic(
      root,
      current,
      `${currentContent.trimEnd()}\n\n${migratedTailBlock}\n`,
    );
  }
  await unlink(previous);
}

export function belongsToBookHub(content: string, bookId: string): boolean {
  return belongsToGeneratedNote(content, { type: "scholar-book", book_id: bookId });
}

type OutlineNote = {
  path: string;
  previousPath: string;
  bookId: string;
  chapterId: string;
  sectionId?: string;
};

function notePathKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

function belongsToOutlineNote(content: string, note: OutlineNote): boolean {
  const identity: NoteIdentity = {
    type: `scholar-${note.sectionId ? "section" : "chapter"}`,
    book_id: note.bookId, chapter_id: note.chapterId,
  };
  if (note.sectionId) identity.section_id = note.sectionId;
  return belongsToGeneratedNote(content, identity);
}

async function existingNoteContent(root: string, path: string): Promise<string | undefined> {
  const safePath = await safePathWithinRoot(root, path);
  return readFile(safePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
}

/** Resolve old shared filenames by explicit owner; never transfer another note's tail. */
async function planOutlineMigrations(
  root: string,
  notes: OutlineNote[],
  onWarning?: (warning: ScholarProjectionWarning) => void,
): Promise<OutlineNote[]> {
  const migrations: OutlineNote[] = [];
  for (const note of notes) {
    const current = await existingNoteContent(root, note.path);
    if (current !== undefined && !belongsToOutlineNote(current, note)) {
      throw new Error(`Scholar cannot replace an unrelated chapter or section note: ${note.path}`);
    }
    if (notePathKey(note.path) === notePathKey(note.previousPath)) continue;
    const previous = await existingNoteContent(root, note.previousPath);
    if (previous === undefined) continue;
    if (belongsToOutlineNote(previous, note)) {
      // Skip only this note's move; one damaged legacy file must not stop every
      // healthy note in the vault from refreshing.
      if (!markersAreReadable(previous)) { skipMigration(note.previousPath, onWarning); continue; }
      if (current !== undefined && !markersAreReadable(current)) { skipMigration(note.path, onWarning); continue; }
      migrations.push(note);
    } else if (!notes.some((candidate) =>
      notePathKey(candidate.previousPath) === notePathKey(note.previousPath)
      && belongsToOutlineNote(previous, candidate))) {
      throw new Error(`Scholar cannot identify the owner of a colliding legacy note: ${note.previousPath}`);
    }
  }
  return migrations;
}

export async function migrateBookHub(
  workspaceRoot: string,
  config: ScholarConfig,
  book: ScholarBook,
  preflightOnly = false,
  onWarning?: (warning: ScholarProjectionWarning) => void,
): Promise<void> {
  const directory = await safePathWithinRoot(workspaceRoot, bookNoteDirectory(config, book));
  // Validate the desired path but retain its lexical casing; canonicalizing an
  // existing Windows path would erase a case-only title correction.
  const current = resolve(directory, bookHubFileName(book));
  await safePathWithinRoot(workspaceRoot, current);
  const entries = await readdir(directory, { withFileTypes: true });
  const candidates: string[] = [];
  let currentContent: string | undefined;
  let caseOnlyCandidate: string | undefined;

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
    const candidate = await safePathWithinRoot(workspaceRoot, resolve(directory, entry.name));
    const samePath = process.platform === "win32"
      ? candidate.toLowerCase() === current.toLowerCase()
      : candidate === current;
    const content = await readFile(candidate, "utf8");
    if (samePath) {
      if (!belongsToBookHub(content, book.id)) {
        throw new Error(`Scholar cannot create the book hub because an unrelated note already uses ${entry.name}.`);
      }
      currentContent = content;
      if (candidate !== current) caseOnlyCandidate = candidate;
      continue;
    }
    if (belongsToBookHub(content, book.id)) {
      // Leave an unreadable duplicate hub in place rather than merging it
      // blind or failing the whole projection over it.
      if (!markersAreReadable(content)) { skipMigration(candidate, onWarning); continue; }
      candidates.push(candidate);
    }
  }
  // A normal refresh can skip a damaged hub; moving or merging one cannot.
  if (currentContent !== undefined && (caseOnlyCandidate || candidates.length > 0)
    && !markersAreReadable(currentContent)) {
    skipMigration(current, onWarning);
    return;
  }
  if (preflightOnly) return;

  if (caseOnlyCandidate) {
    // Windows treats case-only title changes as the same path. Hop through
    // a private sibling so Obsidian receives the exact current title case.
    const temporary = await safePathWithinRoot(
      workspaceRoot,
      resolve(directory, `.scholar-book-hub-${book.id.slice(0, 12)}-${process.pid}.tmp`),
    );
    await rename(caseOnlyCandidate, temporary);
    try {
      await rename(temporary, current);
    } catch (error) {
      await rename(temporary, caseOnlyCandidate).catch(() => undefined);
      throw error;
    }
  }

  // Prefer the fixed legacy filename first. If several prior title-based hubs
  // exist, each handwritten tail is merged exactly once into the canonical one.
  candidates.sort((left, right) => {
    const leftLegacy = basename(left).toLowerCase() === basename(legacyBookHomePath(config, book)).toLowerCase();
    const rightLegacy = basename(right).toLowerCase() === basename(legacyBookHomePath(config, book)).toLowerCase();
    return Number(rightLegacy) - Number(leftLegacy) || left.localeCompare(right);
  });
  for (const candidate of candidates) {
    await migrateGeneratedNote(
      workspaceRoot,
      candidate,
      current,
      LEGACY_BOOK_HUB_TAIL_START,
      LEGACY_BOOK_HUB_TAIL_END,
      onWarning,
    );
  }
}

/**
 * Refresh derived navigation and answer-key views. Source notes are never rewritten by projection.
 */
export async function renderScholarWorkspace(
  config: ScholarConfig,
  books: ScholarBook[],
  onWarning?: (warning: ScholarProjectionWarning) => void,
): Promise<void> {
  if (!config.obsidianRoot.trim()) return;

  const vaultRoot = configuredVaultRoot(config);
  let vaultInfo;
  try {
    vaultInfo = await stat(vaultRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Scholar's configured Obsidian vault does not exist: ${vaultRoot}`);
    }
    throw error;
  }
  if (!vaultInfo.isDirectory()) {
    throw new Error(`Scholar's configured Obsidian vault is not a folder: ${vaultRoot}`);
  }
  const authoritativeBooks: ScholarBook[] = [];
  for (const expected of books) {
    const current = await loadMatchingBookAuthority(config, expected);
    if (current) authoritativeBooks.push(current);
  }
  books = authoritativeBooks;
  await safePathWithinRoot(vaultRoot, vaultRoot);
  const workspaceRoot = await safePathWithinRoot(vaultRoot, scholarWorkspaceRoot(config));
  await mkdir(workspaceRoot, { recursive: true });
  await safePathWithinRoot(workspaceRoot, workspaceRoot);
  await mkdir(resolve(workspaceRoot, BOOKS_FOLDER), { recursive: true });

  const warnedPaths = new Set<string>();
  const reportWarning = (warning: ScholarProjectionWarning) => {
    const key = notePathKey(warning.path);
    if (warnedPaths.has(key)) return;
    warnedPaths.add(key);
    onWarning?.(warning);
  };
  const homeIdentity = { type: "scholar-home" };
  const noteIdentities = new Map<string, NoteIdentity>([[notePathKey(scholarHomePath(config)), homeIdentity]]);
  const writeNote = (path: string, generated: string) => {
    const identity = noteIdentities.get(notePathKey(path))!;
    if (["scholar-book", "scholar-section", "scholar-exam", "scholar-tutor"].includes(identity.type)) return Promise.resolve();
    return writeGeneratedNote(
    workspaceRoot, path, generated, noteIdentities.get(notePathKey(path))!, reportWarning,
  );
  };

  const seenDirectories = new Map<string, string>();
  const seenArtifactPaths = new Map<string, string>([[notePathKey(scholarHomePath(config)), "scholar-home"]]);
  const outlineNotes: OutlineNote[] = [];
  for (const book of books) {
    const directory = bookNoteDirectory(config, book);
    const key = notePathKey(directory);
    const prior = seenDirectories.get(key);
    if (prior && prior !== book.id) {
      throw new Error(`Two Scholar books resolve to the same note directory: ${book.metadata.title}`);
    }
    seenDirectories.set(key, book.id);

    const artifacts: ProjectionArtifact[] = [
      { id: `${book.id}:book`, title: book.metadata.title, path: bookHomePath(config, book), identity: { type: "scholar-book", book_id: book.id } },
      ...book.chapters.flatMap<ProjectionArtifact>((chapter) => {
        const chapterNote: OutlineNote = {
          bookId: book.id, chapterId: chapter.id,
          path: chapterNotePath(config, book, chapter),
          previousPath: resolve(directory, "Chapters", chapterFileName(chapter)),
        };
        outlineNotes.push(chapterNote);
        return [
          { id: `${book.id}:chapter:${chapter.id}`, title: chapter.title, path: chapterNote.path, identity: { type: "scholar-chapter", book_id: book.id, chapter_id: chapter.id } },
          ...chapter.sections.map<ProjectionArtifact>((section) => {
            const sectionNote: OutlineNote = {
              bookId: book.id, chapterId: chapter.id, sectionId: section.id,
              path: sectionNotePath(config, book, chapter, section),
              previousPath: resolve(directory, "Sections", sectionFileName(chapter, section)),
            };
            outlineNotes.push(sectionNote);
            return { id: `${book.id}:section:${section.id}`, title: section.title, path: sectionNote.path, identity: { type: "scholar-section", book_id: book.id, chapter_id: chapter.id, section_id: section.id } };
          }),
        ];
      }),
      ...(book.exams || []).flatMap<ProjectionArtifact>((exam) => [
        { id: `${book.id}:exam:${exam.id}`, title: exam.title, path: examNotePath(config, book, exam), identity: { type: "scholar-exam", book_id: book.id, exam_id: exam.id } },
        { id: `${book.id}:paper:${exam.id}`, title: `${exam.title} — Answer paper`, path: examAnswerNotePath(config, book, exam), identity: { type: "scholar-exam-paper", book_id: book.id, exam_id: exam.id }, learnerOwned: true },
        // Reserve answer-key paths even before grading so grading cannot start
        // overwriting an exam that already occupies the eventual key's name.
        { id: `${book.id}:key:${exam.id}`, title: `${exam.title} — Answer Key`, path: answerKeyNotePath(config, book, exam), identity: { type: "scholar-answer-key", book_id: book.id, exam_id: exam.id } },
      ]),
      ...(book.tutorSessions || []).map<ProjectionArtifact>((session) => ({ id: `${book.id}:tutor:${session.id}`, title: session.title, path: tutorNotePath(config, book, session), identity: { type: "scholar-tutor", book_id: book.id, tutor_id: session.id } })),
    ];
    for (const artifact of artifacts) {
      const artifactKey = notePathKey(artifact.path);
      const priorArtifact = seenArtifactPaths.get(artifactKey);
      if (priorArtifact !== undefined) {
        throw new Error(`Two Scholar artifacts resolve to the same note path: ${artifact.title}`);
      }
      seenArtifactPaths.set(artifactKey, artifact.id);
      // Reserve the path globally, but keep handwritten papers outside every
      // generated-note reader, writer, migration and preservation mechanism.
      if (artifact.learnerOwned) {
        await safePathWithinRoot(workspaceRoot, artifact.path);
        continue;
      }
      noteIdentities.set(artifactKey, artifact.identity);
      const existing = await existingNoteContent(workspaceRoot, artifact.path);
      // Ownership is a global guard and stays in preflight. Marker damage is
      // not reported here: the writer is the only place that knows whether a
      // note was actually rebuilt, and a preflight warning would both claim a
      // rebuild that may never happen and mask the writer's accurate one,
      // because warnings deduplicate per path and keep the first.
      if (existing !== undefined) validateNoteOwnership(existing, artifact.identity, artifact.path);
    }
  }

  const outlineMigrations = await planOutlineMigrations(workspaceRoot, outlineNotes, reportWarning);
  const currentHome = await existingNoteContent(workspaceRoot, scholarHomePath(config));
  if (currentHome !== undefined) validateNoteOwnership(currentHome, homeIdentity, scholarHomePath(config));
  const legacyHome = await existingNoteContent(workspaceRoot, legacyScholarHomePath(config));
  if (legacyHome !== undefined) validateNoteOwnership(legacyHome, homeIdentity, legacyScholarHomePath(config));
  for (const book of books) await migrateBookHub(workspaceRoot, config, book, true, reportWarning);
  // Ownership and path collisions remain global guards. A note whose markers
  // cannot be read is skipped by its migration and recovered by its writer, so
  // one damaged file never stops the rest of the vault from refreshing.
  await migrateGeneratedNote(
    workspaceRoot, legacyScholarHomePath(config), scholarHomePath(config),
    LEGACY_HOME_TAIL_START, LEGACY_HOME_TAIL_END, reportWarning,
  );
  for (const book of books) await migrateBookHub(workspaceRoot, config, book, false, reportWarning);
  for (const note of outlineMigrations) {
    await migrateGeneratedNote(
      workspaceRoot, note.previousPath, note.path,
      "<!-- scholar:legacy-outline-tail:start -->", "<!-- scholar:legacy-outline-tail:end -->",
      reportWarning,
    );
  }

  await writeNote(
    scholarHomePath(config),
    renderScholarHome(config, books),
  );

  for (const book of books) {
    await writeNote(bookHomePath(config, book), renderBook(config, book));

    for (const chapter of [...book.chapters].sort((a, b) => a.order - b.order)) {
      await writeNote(
        chapterNotePath(config, book, chapter),
        renderChapter(config, book, chapter),
      );
      for (const section of [...chapter.sections].sort((a, b) => a.order - b.order)) {
        if (!isSectionMaterialized(book, section)) continue;
        await writeNote(
          sectionNotePath(config, book, chapter, section),
          renderSection(config, book, chapter, section),
        );
      }
    }

    for (const exam of [...(book.exams || [])].sort((left, right) => left.createdAt.localeCompare(right.createdAt))) {
      // Answer papers are learner-owned. Only explicit presentation creates
      // them; projection must not read or repair a draft the learner is editing.
      await writeNote(
        examNotePath(config, book, exam),
        renderExam(config, book, exam),
      );
      // The key is a separate node and appears only once the exam is graded.
      if (exam.status === "graded" || exam.gradedAt) {
        await writeNote(
          answerKeyNotePath(config, book, exam),
          renderExamAnswerKey(config, book, exam),
        );
      }
    }

    for (const session of [...(book.tutorSessions || [])].sort((left, right) => left.createdAt.localeCompare(right.createdAt))) {
      await writeNote(
        tutorNotePath(config, book, session),
        renderTutorSession(config, book, session),
      );
    }
  }
}
