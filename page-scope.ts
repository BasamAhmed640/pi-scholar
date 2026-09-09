import type { ScholarBook, ScholarSection } from "./types.ts";

export type PageRange = { startPage: number; endPage: number };

/**
 * The pages a set of scoped sections makes available.
 *
 * A chapter's pages are not all covered by its sections: a chapter title page,
 * a full-page figure between two subsections, and an end-of-chapter summary
 * belong to the chapter rather than to any one section. Excluding them made an
 * ordinary contiguous read fail — in this project's own source book, ten of
 * thirteen chapters open on such a page.
 *
 * Allowed is every scoped section's range, plus the pages of a scoped section's
 * own chapter that none of that chapter's sections cover. A section-scoped
 * record gains its chapter's unmapped pages and never gains a sibling section.
 *
 * This lives in its own module because both the read gate (domain.ts) and the
 * question gate (question-grounding.ts) must agree on it, and domain.ts already
 * imports question-grounding.ts. Reading a page that a question may not then
 * cite is a contradiction the caller cannot resolve, so the two must share one
 * definition rather than keep two that drift.
 */
export function scopedPageRanges(book: ScholarBook, scopedSections: readonly ScholarSection[]): PageRange[] {
  const ranges: PageRange[] = scopedSections.map((section) => ({
    startPage: section.startPage,
    endPage: section.endPage,
  }));
  const scopedIds = new Set(scopedSections.map((section) => section.id));

  for (const chapter of book.chapters) {
    if (!chapter.sections.some((section) => scopedIds.has(section.id))) continue;
    let unmappedStart: number | undefined;
    for (let page = chapter.startPage; page <= chapter.endPage; page += 1) {
      const mapped = chapter.sections.some((section) => page >= section.startPage && page <= section.endPage);
      if (!mapped) {
        unmappedStart ??= page;
        continue;
      }
      if (unmappedStart !== undefined) {
        ranges.push({ startPage: unmappedStart, endPage: page - 1 });
        unmappedStart = undefined;
      }
    }
    if (unmappedStart !== undefined) ranges.push({ startPage: unmappedStart, endPage: chapter.endPage });
  }
  return ranges;
}

export function pageInRanges(page: number, ranges: readonly PageRange[]): boolean {
  return ranges.some((range) => page >= range.startPage && page <= range.endPage);
}
