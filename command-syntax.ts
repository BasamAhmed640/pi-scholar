import { quoted } from "./domain.ts";
import { scanLibrary } from "./ingest.ts";
import { listBookStates, loadBookState, loadConfig } from "./storage.ts";
import { allSections, type ScholarConfig } from "./types.ts";

export type ParsedScholarCommand = {
  action: string;
  value?: string;
  submit?: true;
};

export function cleanArgument(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function parseScholarCommand(input: string): ParsedScholarCommand {
  const trimmed = input.trim();
  if (!trimmed) return { action: "default" };
  const match = /^(library|obsidian|open|learn|exam|tutor|close|help)(?:\s+([\s\S]+))?$/i.exec(trimmed);
  if (!match) return { action: "invalid" };
  const action = match[1]!.toLowerCase();
  let rawValue = match[2]?.trim();
  let submit = false;
  if (action === "exam" && rawValue) {
    // Recognize the verb before stripping quotes: "submit" can be a title.
    const trailing = /(?:^|\s)submit$/i.exec(rawValue);
    if (trailing) {
      const target = rawValue.slice(0, trailing.index).trim();
      const quote = target[0];
      if (!target || (quote !== '"' && quote !== "'") || (target.length > 1 && target.endsWith(quote))) {
        submit = true;
        rawValue = target;
      }
    }
  }
  const value = rawValue ? cleanArgument(rawValue) : undefined;
  if (value && ["close", "help"].includes(action)) return { action: "invalid" };
  return { action, ...(value ? { value } : {}), ...(submit ? { submit: true as const } : {}) };
}

export const SCHOLAR_COMMAND_ACTIONS = [
  { value: "open ", label: "open", description: "Choose or open a book" },
  { value: "learn ", label: "learn", description: "Choose a chapter/section, or resume an active one" },
  { value: "exam ", label: "exam", description: 'Create an Obsidian exam (e.g. "1-3", "1, 2", or "all")' },
  { value: "tutor ", label: "tutor", description: "Tutor a selected chapter, section, or topic" },
  { value: "library ", label: "library", description: "Set the local books folder" },
  { value: "obsidian ", label: "obsidian", description: "Set the existing Obsidian vault" },
  { value: "close", label: "close", description: "Leave Scholar mode in this Pi session" },
  { value: "help", label: "help", description: "Show Scholar guide and commands" },
];

export async function getScholarArgumentCompletions(
  prefix: string,
  getActiveConfig: () => Promise<ScholarConfig> | ScholarConfig,
  currentBookId?: string,
): Promise<Array<{ value: string; label: string; description: string }> | null> {
  const trimmed = prefix.trimStart();
  if (!trimmed || !trimmed.includes(" ")) {
    const query = trimmed.toLowerCase();
    return SCHOLAR_COMMAND_ACTIONS.filter((item) => item.label.startsWith(query));
  }
  try {
    const completionConfig = await getActiveConfig();
    const open = /^open\s+([\s\S]*)$/i.exec(trimmed);
    if (open) {
      if (!completionConfig.libraryRoot.trim()) return null;
      const query = cleanArgument(open[1] || "").toLowerCase();
      const existingBooks = completionConfig.obsidianRoot
        ? await listBookStates(completionConfig).catch(() => [])
        : [];
      return (await scanLibrary(completionConfig.libraryRoot))
        .filter((book) => !query || book.displayTitle.toLowerCase().includes(query) || book.relativePath.toLowerCase().includes(query))
        .map((book) => {
          const existing = existingBooks.find((b) =>
            b.source.relativePath.toLowerCase() === book.relativePath.toLowerCase()
            || b.source.fileName.toLowerCase() === book.fileName.toLowerCase(),
          );
          const status = !completionConfig.obsidianRoot
            ? "PDF"
            : existing
              ? (existing.outlineStatus === "ready" ? "In Obsidian" : "In Obsidian (pending)")
              : "Not in Obsidian";
          return {
            value: `open ${quoted(book.relativePath)}`,
            label: book.displayTitle,
            description: `${status} · ${(book.size / 1024 / 1024).toFixed(1)} MiB`,
          };
        });
    }
    const examMatch = /^exam(?:\s+([\s\S]*))?$/i.exec(trimmed);
    if (examMatch) {
      const bookId = currentBookId || completionConfig.currentBookId;
      const book = bookId ? await loadBookState(completionConfig, bookId).catch(() => undefined) : undefined;
      const rawQuery = examMatch[1] || "";
      const query = cleanArgument(rawQuery).toLowerCase();
      const submitItem = { value: "exam submit", label: "submit", description: "Select an active exam and confirm submission" };
      const namedSubmit = /^([\s\S]+?)\s+(?:s|su|sub|subm|submi|submit)$/i.exec(rawQuery);
      if (namedSubmit) {
        const target = cleanArgument(namedSubmit[1]).toLowerCase();
        return (book?.exams || []).filter((exam) => exam.status === "active" && (exam.id.toLowerCase() === target || exam.title.toLowerCase() === target))
          .map((exam) => ({ value: `exam ${quoted(exam.id)} submit`, label: `${exam.title} — submit`, description: "Confirm saved answers; blanks receive 0 points" }));
      }
      const inProgressExams = (book?.exams || []).filter((exam) => exam.status !== "graded");
      const examItems = inProgressExams.map((exam) => ({
        value: `exam ${quoted(exam.id)}`,
        label: exam.title,
        description: exam.status === "active"
          ? `${exam.questions.length} question(s) · active`
          : exam.status === "submitted"
            ? "submitted · awaiting grading"
            : "draft",
      }));
      if (!examItems.length) {
        return [
          {
            value: prefix,
            label: prefix,
            description: 'Create an Obsidian exam (e.g. "1-3", "1, 2", or "all")',
          },
          ...(!query || "submit".startsWith(query) ? [submitItem] : []),
        ];
      }
      return [...examItems, submitItem].filter((item) =>
        !query
        || item.label.toLowerCase().includes(query)
        || item.value.toLowerCase().includes(query)
      );
    }
    const scoped = /^(learn|tutor)\s+([\s\S]*)$/i.exec(trimmed);
    if (!scoped) return null;
    const bookId = currentBookId || completionConfig.currentBookId;
    const book = bookId ? await loadBookState(completionConfig, bookId).catch(() => undefined) : undefined;
    if (!book?.chapters.length) return null;
    const mode = scoped[1]!.toLowerCase();
    const query = cleanArgument(scoped[2] || "").toLowerCase();

    const candidates = [
      ...book.chapters.map((chapter) => ({
        value: `${mode} ${quoted(`chapter ${chapter.number || chapter.id}`)}`,
        label: chapter.number ? `Chapter ${chapter.number}: ${chapter.title}` : chapter.title,
        description: "chapter",
      })),
      ...allSections(book).map((section) => ({
        value: `${mode} ${quoted(`section ${section.id}`)}`,
        label: section.number ? `${section.number} ${section.title}` : section.title,
        description: "section",
      })),
    ];
    if (!query) return candidates;
    const sectionPrefix = /^(?:sections?)\s*(.*)$/i.exec(query);
    const chapterPrefix = /^(?:chapters?)\s*(.*)$/i.exec(query);
    if (sectionPrefix) {
      const sub = sectionPrefix[1]!.trim();
      return candidates.filter((item) => item.description === "section" && (!sub || item.label.toLowerCase().includes(sub) || item.value.toLowerCase().includes(sub)));
    }
    if (chapterPrefix) {
      const sub = chapterPrefix[1]!.trim();
      return candidates.filter((item) => item.description === "chapter" && (!sub || item.label.toLowerCase().includes(sub) || item.value.toLowerCase().includes(sub)));
    }
    return candidates.filter((item) =>
      item.label.toLowerCase().includes(query)
      || item.value.toLowerCase().includes(query)
      || item.description.toLowerCase().includes(query)
    );
  } catch {
    return null;
  }
}
