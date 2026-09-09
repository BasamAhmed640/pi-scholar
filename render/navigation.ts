import { bookHomePath, chapterNotePath, examNotePath, scholarHomePath, sectionNotePath, tutorNotePath } from "../obsidian-paths.ts";
import { allSections, deriveStatus, type ScholarBook, type ScholarChapter, type ScholarConfig, type SectionStatus } from "../types.ts";
import { block, frontmatter, generatedDocument, isSectionMaterialized, markdownText, pageRange, progress, tableText, tableWikiLink, wikiLink, yaml } from "./common.ts";

function stateLabel(status: SectionStatus): string {
  return status === "complete" ? "Complete" : status === "review" ? "Review" : status === "learning" ? "In progress" : "Not started";
}

function completion(sections: ScholarChapter["sections"]): string {
  const completed = sections.filter((section) => section.status === "complete").length;
  return `${completed}/${sections.length} · ${progress(completed, sections.length).percent}%`;
}

function rowStatus(status: SectionStatus, current: boolean): string {
  return current ? `**Current · ${stateLabel(status)}**` : stateLabel(status);
}

export function renderScholarHome(config: ScholarConfig, books: ScholarBook[]): string {
  const ordered = [...books].sort((a, b) => a.metadata.title.localeCompare(b.metadata.title));
  const sections = books.flatMap(allSections);
  const rows = ordered.map((book) => {
    const parts = allSections(book);
    return `| ${rowStatus(deriveStatus(parts), config.currentBookId === book.id)} | ${tableWikiLink(scholarHomePath(config), bookHomePath(config, book), book.metadata.title)} | ${completion(parts)} |`;
  });
  return generatedDocument(frontmatter(["type: scholar-home"]), [
    "> [!info] Scholar library",
    `> ${books.length} ${books.length === 1 ? "book" : "books"} · ${completion(sections)} sections complete`, "",
    ...(rows.length ? ["| Status | Book | Completed sections |", "| --- | --- | --- |", ...rows] : ["Your library is ready. Open a supported book in Scholar to begin."]),
  ].join("\n"));
}

export function renderBook(config: ScholarConfig, book: ScholarBook): string {
  const notePath = bookHomePath(config, book);
  const sections = allSections(book);
  const state = deriveStatus(sections);
  const chapters = [...book.chapters].sort((a, b) => a.order - b.order);
  const chapterRows = chapters.map((chapter) => {
    const label = chapter.number ? `Chapter ${chapter.number}: ${chapter.title}` : chapter.title;
    const current = chapter.sections.some((section) => section.id === book.currentSectionId);
    return `| ${rowStatus(deriveStatus(chapter.sections), current)} | ${tableWikiLink(notePath, chapterNotePath(config, book, chapter), label)} | ${pageRange(chapter.startPage, chapter.endPage)} | ${completion(chapter.sections)} |`;
  });
  const examRows = [...(book.exams || [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((exam) =>
    `| ${exam.id === book.currentExamId ? "**Current · " : ""}${tableText(exam.status === "submitted" ? "Awaiting grading" : exam.status === "graded" ? "Graded" : exam.status === "active" ? "In progress" : "Ready")}${exam.id === book.currentExamId ? "**" : ""} | ${tableWikiLink(notePath, examNotePath(config, book, exam), exam.title)} |`);
  const tutorRows = [...(book.tutorSessions || [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((session) =>
    `| ${session.id === book.currentTutorId ? "**Current · " : ""}${tableText(session.status === "active" ? "In progress" : "Closed")}${session.id === book.currentTutorId ? "**" : ""} | ${tableWikiLink(notePath, tutorNotePath(config, book, session), session.title)} |`);
  const notice = book.outlineStatus === "ready" ? "" : book.outlineStatus === "needs-ocr"
    ? "This book needs OCR before Scholar can teach it reliably."
    : book.outlineStatus === "needs-review" ? "Review the detected chapter and section outline before learning."
    : book.outlineStatus === "pending" && chapters.length ? "Scholar is validating the provisional outline against source checkpoints."
    : "Scholar is preparing the book outline.";
  return generatedDocument(frontmatter([
    "type: scholar-book", `book_id: ${yaml(book.id)}`, `title: ${yaml(book.metadata.title)}`,
    ...(book.metadata.authors.length ? ["authors:", ...book.metadata.authors.map((author) => `  - ${yaml(author)}`)] : ["authors: []"]),
    ...(book.metadata.edition ? [`edition: ${yaml(book.metadata.edition)}`] : []),
    `source_file: ${yaml(book.source.fileName)}`, `outline_status: ${yaml(book.outlineStatus)}`, `status: ${yaml(state)}`,
    `progress: ${progress(sections.filter((section) => section.status === "complete").length, sections.length).percent}`,
    `created: ${yaml(book.createdAt)}`, `updated: ${yaml(book.updatedAt)}`,
  ]), [
    `> [!${state === "complete" ? "success" : state === "review" || book.outlineStatus === "needs-review" || book.outlineStatus === "needs-ocr" ? "warning" : "info"}] ${stateLabel(state)}`,
    `> ${completion(sections)} sections complete`,
    ...(notice ? [">", `> ${notice}`] : []), "",
    wikiLink(notePath, scholarHomePath(config), "Scholar Home"), "",
    ...(book.metadata.authors.length ? [`**Author${book.metadata.authors.length === 1 ? "" : "s"}:** ${book.metadata.authors.map(markdownText).join(", ")}`] : []),
    ...(book.metadata.edition ? [`**Edition:** ${markdownText(book.metadata.edition)}`] : []),
    `**Source:** ${markdownText(book.source.fileName)}`, "",
    ...block("## Chapters", chapterRows.length ? ["| Status | Chapter | Source | Completed sections |", "| --- | --- | --- | --- |", ...chapterRows] : []),
    ...block("## Exams", examRows.length ? ["| Status | Exam |", "| --- | --- |", ...examRows] : []),
    ...block("## Tutor sessions", tutorRows.length ? ["| Status | Session |", "| --- | --- |", ...tutorRows] : []),
  ].join("\n"));
}

export function renderChapter(config: ScholarConfig, book: ScholarBook, chapter: ScholarChapter): string {
  const notePath = chapterNotePath(config, book, chapter);
  const state = deriveStatus(chapter.sections);
  const rows = [...chapter.sections].sort((a, b) => a.order - b.order).map((section) => {
    const label = section.number ? `${section.number} ${section.title}` : section.title;
    const name = isSectionMaterialized(book, section)
      ? tableWikiLink(notePath, sectionNotePath(config, book, chapter, section), label) : tableText(label);
    return `| ${rowStatus(section.status, section.id === book.currentSectionId)} | ${name} | ${pageRange(section.startPage, section.endPage)} |`;
  });
  return generatedDocument(frontmatter([
    "type: scholar-chapter", `book_id: ${yaml(book.id)}`, `chapter_id: ${yaml(chapter.id)}`, `status: ${yaml(state)}`,
    `progress: ${progress(chapter.sections.filter((section) => section.status === "complete").length, chapter.sections.length).percent}`,
  ]), [
    `> [!${state === "complete" ? "success" : state === "review" ? "warning" : "info"}] ${stateLabel(state)}`,
    `> ${pageRange(chapter.startPage, chapter.endPage)} · ${completion(chapter.sections)} sections complete`, "",
    wikiLink(notePath, bookHomePath(config, book), book.metadata.title), "",
    ...block("## Sections", rows.length ? ["| Status | Section | Source |", "| --- | --- | --- |", ...rows] : []),
    ...(!rows.length ? ["Sections will appear when Scholar has prepared this chapter's outline."] : []),
  ].join("\n"));
}
