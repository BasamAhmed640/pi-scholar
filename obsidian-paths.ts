import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import type {
  ScholarBook,
  ScholarChapter,
  ScholarConfig,
  ScholarExam,
  ScholarReferenceImage,
  ScholarSection,
  ScholarSnapshot,
  TutorSession,
} from "./types.ts";

export const SCHOLAR_FOLDER = "Scholar";
export const BOOKS_FOLDER = "Books";

export function safeNoteSegment(value: string, fallback = "Untitled"): string {
  let segment = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100)
    .replace(/[. ]+$/g, "");
  if (segment.startsWith(".")) segment = `_${segment}`;
  const deviceName = segment.split(".", 1)[0]!.trimEnd();
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(deviceName)) segment = `_${segment}`;
  return segment || fallback;
}

export function relativeNoteDirectory(book: ScholarBook): string {
  const raw = book.noteDirectory.trim();
  if (!raw) {
    const edition = book.metadata.edition ? ` - ${book.metadata.edition}` : "";
    return `${BOOKS_FOLDER}/${safeNoteSegment(`${book.metadata.title}${edition}`, book.id)}`;
  }
  if (isAbsolute(raw)) throw new Error(`Scholar noteDirectory must be relative: ${raw}`);
  const parts = raw.split(/[\\/]+/).filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) {
    throw new Error(`Scholar noteDirectory may not contain traversal: ${raw}`);
  }
  const safeParts = parts.map((part) => safeNoteSegment(part));
  if (safeParts[0]?.toLowerCase() === BOOKS_FOLDER.toLowerCase()) return safeParts.join("/");
  return [BOOKS_FOLDER, ...safeParts].join("/");
}

export function pathFromRoot(root: string, portableRelativePath: string): string {
  const candidate = resolve(root, ...portableRelativePath.split("/"));
  const fromRoot = relative(resolve(root), candidate);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`Scholar note path escapes the visible workspace: ${portableRelativePath}`);
  }
  return candidate;
}

export function configuredVaultRoot(config: ScholarConfig): string {
  const root = config.obsidianRoot.trim();
  if (!root) throw new Error("Scholar's Obsidian vault is not configured.");
  return resolve(root);
}

export function scholarWorkspaceRoot(config: ScholarConfig): string {
  return pathFromRoot(configuredVaultRoot(config), SCHOLAR_FOLDER);
}

export function scholarHomePath(config: ScholarConfig): string {
  return pathFromRoot(scholarWorkspaceRoot(config), `${BOOKS_FOLDER}/Scholar Home.md`);
}

export function legacyScholarHomePath(config: ScholarConfig): string {
  return pathFromRoot(scholarWorkspaceRoot(config), "Scholar Home.md");
}

export function bookNoteDirectory(config: ScholarConfig, book: ScholarBook): string {
  return pathFromRoot(scholarWorkspaceRoot(config), relativeNoteDirectory(book));
}

export function bookHubFileName(book: ScholarBook): string {
  return `${safeNoteSegment(book.metadata.title.normalize("NFC"), book.id)}.md`;
}

export function bookHomePath(config: ScholarConfig, book: ScholarBook): string {
  return resolve(bookNoteDirectory(config, book), bookHubFileName(book));
}

export function legacyBookHomePath(config: ScholarConfig, book: ScholarBook): string {
  return resolve(bookNoteDirectory(config, book), "Book Home.md");
}

export function orderedPrefix(order: number): string {
  return String(Math.max(0, Math.trunc(order))).padStart(2, "0");
}

export function chapterFileName(chapter: ScholarChapter): string {
  const label = chapter.number || orderedPrefix(chapter.order);
  return `Chapter ${safeNoteSegment(label, orderedPrefix(chapter.order))} - ${safeNoteSegment(chapter.title)}.md`;
}

export function sectionFileName(chapter: ScholarChapter, section: ScholarSection): string {
  const chapterLabel = safeNoteSegment(chapter.number || orderedPrefix(chapter.order), orderedPrefix(chapter.order));
  const sectionLabel = safeNoteSegment(section.number || `${chapterLabel}.${orderedPrefix(section.order)}`, orderedPrefix(section.order));
  return `${sectionLabel} - ${safeNoteSegment(section.title)}.md`;
}

export function chapterNotePath(config: ScholarConfig, book: ScholarBook, chapter: ScholarChapter): string {
  const names = disambiguatedFileNames(book.chapters.map((candidate) => ({
    id: candidate.id,
    name: chapterFileName(candidate),
  })));
  return resolve(bookNoteDirectory(config, book), "Chapters", names.get(chapter.id) || chapterFileName(chapter));
}

export function sectionNotePath(
  config: ScholarConfig,
  book: ScholarBook,
  chapter: ScholarChapter,
  section: ScholarSection,
): string {
  // Include unstarted sections: materializing one must not retarget every link
  // to a previously studied section that happens to have the same local number.
  const names = disambiguatedFileNames(book.chapters.flatMap((candidateChapter) =>
    candidateChapter.sections.map((candidate) => ({
      id: candidate.id,
      name: sectionFileName(candidateChapter, candidate),
    }))));
  return resolve(bookNoteDirectory(config, book), "Sections", names.get(section.id) || sectionFileName(chapter, section));
}

function fileNameKey(value: string): string {
  // Keep names portable to case-insensitive vaults even when rendered on Linux.
  return value.normalize("NFC").toLowerCase();
}

function disambiguatedFileNames(candidates: { id: string; name: string }[]): Map<string, string> {
  const names = new Map<string, string>();
  const suffixed = new Set<string>();
  if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) {
    throw new Error("Scholar cannot project duplicate chapter or section identities.");
  }
  // A suffix can itself match a natural title. Resolve those secondary
  // collisions as well; the writer also preflights the final complete mapping.
  for (let pass = 0; pass <= candidates.length; pass++) {
    const owners = new Map<string, string>();
    let changed = false;
    for (const candidate of candidates) {
      const suffix = createHash("sha256").update(candidate.id).digest("hex").slice(0, 12);
      const name = suffixed.has(candidate.id)
        ? `${candidate.name.slice(0, -3)} - ${suffix}.md`
        : candidate.name;
      names.set(candidate.id, name);
      const key = fileNameKey(name);
      const previous = owners.get(key);
      if (previous !== undefined) {
        if (suffixed.has(previous) && suffixed.has(candidate.id)) {
          throw new Error(`Scholar could not safely disambiguate note path: ${candidate.name}`);
        }
        suffixed.add(previous);
        suffixed.add(candidate.id);
        changed = true;
      }
      owners.set(key, candidate.id);
    }
    if (!changed) return names;
  }
  throw new Error("Scholar could not safely disambiguate note paths.");
}

export function examFileName(exam: ScholarExam): string {
  return `${safeNoteSegment(exam.title, exam.id)}.md`;
}

export function tutorFileName(session: TutorSession): string {
  return `${safeNoteSegment(session.title, session.id)}.md`;
}

export function examNotePath(config: ScholarConfig, book: ScholarBook, exam: ScholarExam): string {
  const names = disambiguatedFileNames(book.exams.map((item) => ({ id: item.id, name: examFileName(item) })));
  return resolve(bookNoteDirectory(config, book), "Exams", names.get(exam.id) || examFileName(exam));
}

/** The learner's paper has a stable identity-based name, independent of its title. */
export function examAnswerNotePath(config: ScholarConfig, book: ScholarBook, exam: ScholarExam): string {
  const suffix = createHash("sha256").update(exam.id).digest("hex").slice(0, 12);
  return resolve(bookNoteDirectory(config, book), "Exams", `${safeNoteSegment(exam.id, "exam")} - ${suffix} - Answers.md`);
}

/**
 * The answer key is its own note so it is a distinct node in the graph: it only
 * exists once an exam is graded, and it carries the corrections a learner
 * returns to, separate from the paper they sat.
 */
export function answerKeyFileName(exam: ScholarExam): string {
  return `${safeNoteSegment(`${exam.title} — Answer Key`, `${exam.id}-answer-key`)}.md`;
}

export function answerKeyNotePath(config: ScholarConfig, book: ScholarBook, exam: ScholarExam): string {
  const names = disambiguatedFileNames(book.exams.map((item) => ({ id: item.id, name: answerKeyFileName(item) })));
  return resolve(bookNoteDirectory(config, book), "Exams", names.get(exam.id) || answerKeyFileName(exam));
}

export function tutorNotePath(config: ScholarConfig, book: ScholarBook, session: TutorSession): string {
  const names = disambiguatedFileNames(book.tutorSessions.map((item) => ({ id: item.id, name: tutorFileName(item) })));
  return resolve(bookNoteDirectory(config, book), "Tutor", names.get(session.id) || tutorFileName(session));
}

export function snapshotAssetPath(config: ScholarConfig, book: ScholarBook, snapshot: ScholarSnapshot): string {
  if (basename(snapshot.assetFile) !== snapshot.assetFile || !/^p\d{4,}-snapshot-[a-f\d]{16}\.png$/i.test(snapshot.assetFile)) {
    throw new Error(`Invalid Scholar snapshot asset name: ${snapshot.assetFile}`);
  }
  return resolve(bookNoteDirectory(config, book), "Assets", snapshot.assetFile);
}

export function referenceImageAssetPath(config: ScholarConfig, book: ScholarBook, image: ScholarReferenceImage): string {
  if (
    basename(image.assetFile) !== image.assetFile
    || !/^commons-\d+-[a-f\d]{16}\.(?:png|jpg)$/i.test(image.assetFile)
  ) {
    throw new Error(`Invalid Scholar reference-image asset name: ${image.assetFile}`);
  }
  return resolve(bookNoteDirectory(config, book), "Assets", image.assetFile);
}
