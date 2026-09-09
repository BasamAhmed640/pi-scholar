import type { ScholarBook, ScholarChapter } from "./types.ts";

export type OutlineValidationOutcome = "match" | "non-substantive" | "mismatch" | "uncertain";

export function isOutlineValidationOutcome(value: unknown): value is OutlineValidationOutcome {
  return value === "match" || value === "non-substantive" || value === "mismatch" || value === "uncertain";
}

/**
 * The compact judgment required only when source text cannot settle a
 * checkpoint deterministically. Textual evidence remains owned by Scholar;
 * callers never need to copy an exact page excerpt back into the tool.
 */
export type OutlineValidationDecisionInput = {
  id: string;
  outcome: OutlineValidationOutcome;
  observation?: string;
  /** Accepted from older in-flight prompts but never trusted as authority. */
  page?: number;
  /** Accepted as a legacy observation; source evidence is always tool-owned. */
  evidence?: string;
};

export type OutlineValidationIssueCode =
  | "source-read-required"
  | "visual-required"
  | "heading-conflict"
  | "coverage-conflict"
  | "unmapped-substantive-page"
  | "missing-decision"
  | "duplicate-decision"
  | "unknown-decision"
  | "visual-not-rendered"
  | "invalid-decision"
  | "decision-disputed";

export type OutlineValidationIssue = {
  checkpointId: string;
  page?: number;
  code: OutlineValidationIssueCode;
  severity: "review" | "repair";
  message: string;
  expected?: string;
  observed?: string;
};

export type OutlineValidationReportStatus =
  | "ready"
  | "source-read-required"
  | "visual-review"
  | "outline-repair"
  | "needs-review";

export type OutlineValidationReport = {
  status: OutlineValidationReportStatus;
  outlineRevision: number;
  passed: number;
  total: number;
  visualPages: number[];
  requiredDecisionIds: string[];
  issues: OutlineValidationIssue[];
};

export type OutlineValidationCheckpoint = {
  id: string;
  page: number;
  kind: "heading" | "coverage";
  label: string;
};

export type OutlineValidationRun = {
  bookId: string;
  outlineRevision: number;
  checkpoints: OutlineValidationCheckpoint[];
  pageText: Map<number, string>;
  sparsePages: Set<number>;
  viewedPages: Set<number>;
};

export function assertOutlineStructure(chapters: ScholarChapter[], pageCount?: number): void {
  if (chapters.length === 0) throw new Error("Scholar outline requires at least one chapter.");
  for (let chapterIndex = 0; chapterIndex < chapters.length; chapterIndex += 1) {
    const chapter = chapters[chapterIndex]!;
    if (chapter.startPage < 1 || chapter.endPage < chapter.startPage || (pageCount && chapter.endPage > pageCount)) {
      throw new Error(`Chapter ${chapterIndex + 1} has invalid PDF page bounds.`);
    }
    const previousChapter = chapters[chapterIndex - 1];
    if (previousChapter && previousChapter.endPage > chapter.startPage) {
      throw new Error(`Chapters ${chapterIndex} and ${chapterIndex + 1} overlap beyond a shared boundary page.`);
    }
    if (chapter.sections.length === 0) throw new Error(`Chapter ${chapterIndex + 1} needs at least one section.`);
    for (let sectionIndex = 0; sectionIndex < chapter.sections.length; sectionIndex += 1) {
      const section = chapter.sections[sectionIndex]!;
      if (
        section.startPage < chapter.startPage
        || section.endPage < section.startPage
        || section.endPage > chapter.endPage
      ) throw new Error(`Chapter ${chapterIndex + 1}, section ${sectionIndex + 1} falls outside its chapter.`);
      const previousSection = chapter.sections[sectionIndex - 1];
      if (previousSection) {
        // Two headings can legitimately begin on the same PDF page. A prior
        // section may therefore end on the next section's start page, but it
        // may not extend beyond that shared boundary. Gaps remain legal for
        // chapter lead-ins, exercises, and other intentionally unscoped pages.
        if (previousSection.endPage > section.startPage) {
          throw new Error(`Chapter ${chapterIndex + 1}, sections ${sectionIndex} and ${sectionIndex + 1} overlap beyond a shared boundary page.`);
        }
      }
    }
  }
}

export function outlineValidationCheckpoints(chapters: ScholarChapter[], pageCount?: number): OutlineValidationCheckpoint[] {
  if (chapters.length === 0) return [];
  const sections = chapters.flatMap((chapter) => chapter.sections);
  const chapterCandidates = [
    chapters[0],
    chapters[Math.floor((chapters.length - 1) / 2)],
    chapters.at(-1),
  ];
  const sectionCandidates = [
    sections[0],
    sections[Math.floor((sections.length - 1) / 2)],
    sections.at(-1),
  ];
  const checkpoints = new Map<string, OutlineValidationCheckpoint>();
  for (const chapter of chapterCandidates) {
    if (chapter) checkpoints.set(chapter.id, { id: chapter.id, page: chapter.startPage, kind: "heading", label: chapter.title });
  }
  for (const section of sectionCandidates) {
    if (section) checkpoints.set(section.id, { id: section.id, page: section.startPage, kind: "heading", label: section.title });
  }
  const firstMappedPage = chapters[0]!.startPage;
  const finalSourcePage = pageCount || chapters.at(-1)!.endPage;
  const coveragePages = [
    firstMappedPage,
    Math.round(firstMappedPage + ((finalSourcePage - firstMappedPage) / 2)),
    finalSourcePage,
  ];
  for (const page of new Set(coveragePages)) {
    const id = `coverage-page-${page}`;
    const mapped = chapters
      .filter((chapter) => chapter.startPage <= page && chapter.endPage >= page)
      .map((chapter) => {
        const sectionsOnPage = chapter.sections
          .filter((section) => section.startPage <= page && section.endPage >= page)
          .map((section) => `${section.number || section.order} ${section.title}`.trim())
          .join(", ");
        return `${chapter.number || chapter.order} ${chapter.title}${sectionsOnPage ? ` → ${sectionsOnPage}` : ""}`.trim();
      });
    const label = mapped.length
      ? `candidate maps ${mapped.join(" | ")}`
      : "candidate maps no chapter on this page";
    checkpoints.set(id, { id, page, kind: "coverage", label });
  }
  return [...checkpoints.values()];
}

export function isProvisionalOutline(book: ScholarBook): boolean {
  return book.outlineStatus === "pending" && book.chapters.length > 0;
}

export function normalizedSourceExcerpt(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[‐‑‒–—−]/g, "-")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedOutlineNumber(value: string): string {
  const normalized = normalizedSourceExcerpt(value).replace(/^chapter\s+/, "").replace(/[^a-z0-9.]+/g, "");
  if (/^\d+(?:\.\d+)*$/.test(normalized)) {
    return normalized.split(".").map((part) => String(Number(part))).join(".");
  }
  return normalized;
}

type SourceChapterSignal = { number: string; title?: string; line: string };

function normalizedChapterTitle(value: string): string {
  return normalizedSourceExcerpt(value)
    .replace(/^chapter\s+[a-z0-9]+\s*(?:[:.\-]\s*)?/, "")
    .trim();
}

export function sourceChapterSignals(value: string): SourceChapterSignal[] {
  const signals: SourceChapterSignal[] = [];
  const leadingLines = value.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 8);
  for (const line of leadingLines) {
    const chapter = /^(?:\d+\s+)?chapter\s+([a-z0-9]+)\b(?:\s*[:.\-\u2013\u2014]\s*|\s+)?(.*)$/i.exec(line);
    if (chapter) {
      const title = normalizedChapterTitle(chapter[2] || "");
      signals.push({
        number: normalizedOutlineNumber(chapter[1]!),
        ...(title ? { title } : {}),
        line,
      });
    }
  }
  return signals;
}

export function sourceChapterMatchesCandidate(signal: SourceChapterSignal, chapter: ScholarChapter): boolean {
  const title = normalizedChapterTitle(chapter.title);
  if (chapter.number) {
    if (normalizedOutlineNumber(chapter.number) !== signal.number) return false;
    return !signal.title || (title.length >= 4 && title === signal.title);
  }
  return Boolean(signal.title && title.length >= 4 && title === signal.title);
}

export function clearlyNonSubstantiveText(value: string): boolean {
  const leadingLines = value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => normalizedSourceExcerpt(line))
    .filter(Boolean)
    .slice(0, 4);
  return leadingLines.some((line) => /^(?:(?:inside\s+)?(?:back|front)\s+cover|copyright(?:\s+page)?|colophon|credits?|dedication|acknowledg(?:e)?ments?|about\s+the\s+author|author\s+biograph(?:y|ies)|table\s+of\s+contents|contents|index|bibliograph(?:y|ies)|references|glossary|answer\s+key|solutions?|this\s+page\s+intentionally\s+left\s+blank|free\s+online\s+edition|online\s+edition|fundamental\s+(?:physical\s+)?constants|physical\s+constants)\s*(?:$|[:\-])/i.test(line));
}

export function validationTextIsSparse(value: string): boolean {
  return (value.match(/[\p{L}\p{N}]/gu)?.length || 0) < 8;
}

function observedSourceStart(value: string): string | undefined {
  const observed = value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!observed) return undefined;
  return observed.length <= 240 ? observed : `${observed.slice(0, 237).trimEnd()}...`;
}

function checkpointChapter(book: ScholarBook, checkpoint: OutlineValidationCheckpoint): ScholarChapter | undefined {
  if (checkpoint.kind !== "heading") return undefined;
  return book.chapters.find((chapter) => chapter.id === checkpoint.id);
}

function issue(
  checkpoint: OutlineValidationCheckpoint,
  code: OutlineValidationIssueCode,
  severity: OutlineValidationIssue["severity"],
  message: string,
  extra: Pick<OutlineValidationIssue, "expected" | "observed"> = {},
): OutlineValidationIssue {
  return {
    checkpointId: checkpoint.id,
    page: checkpoint.page,
    code,
    severity,
    message,
    ...extra,
  };
}

function reportStatus(
  issues: OutlineValidationIssue[],
  forceNeedsReview = false,
): OutlineValidationReportStatus {
  if (forceNeedsReview) return "needs-review";
  if (issues.some((item) => item.severity === "repair")) return "outline-repair";
  if (issues.some((item) => item.code === "source-read-required")) return "source-read-required";
  if (issues.length > 0) return "visual-review";
  return "ready";
}

function validationReport(
  run: OutlineValidationRun,
  issues: OutlineValidationIssue[],
  requiredDecisionIds: string[],
  forceNeedsReview = false,
): OutlineValidationReport {
  const checkpointIdsWithIssues = new Set(
    issues
      .map((item) => item.checkpointId)
      .filter((id) => run.checkpoints.some((checkpoint) => checkpoint.id === id)),
  );
  const visualPages = [...new Set(
    issues
      .filter((item) => item.code === "visual-required" || item.code === "visual-not-rendered")
      .map((item) => item.page)
      .filter((page): page is number => page !== undefined),
  )].sort((a, b) => a - b);
  return {
    status: reportStatus(issues, forceNeedsReview),
    outlineRevision: run.outlineRevision,
    passed: Math.max(0, run.checkpoints.length - checkpointIdsWithIssues.size),
    total: run.checkpoints.length,
    visualPages,
    requiredDecisionIds: [...new Set(requiredDecisionIds)],
    issues,
  };
}

/**
 * Evaluate every checkpoint against text captured by Scholar after the
 * provisional outline was saved. The report owns exact source evidence and
 * aggregates all recoverable work instead of failing at the first checkpoint.
 */
export function preflightOutlineValidation(book: ScholarBook, run: OutlineValidationRun): OutlineValidationReport {
  const issues: OutlineValidationIssue[] = [];
  const requiredDecisionIds: string[] = [];

  for (const checkpoint of run.checkpoints) {
    const rawSource = run.pageText.get(checkpoint.page);
    const sparse = run.sparsePages.has(checkpoint.page)
      || (rawSource !== undefined && validationTextIsSparse(rawSource));
    if (rawSource === undefined && !sparse) {
      issues.push(issue(
        checkpoint,
        "source-read-required",
        "review",
        `PDF page ${checkpoint.page} still needs a post-outline source read.`,
        { expected: checkpoint.label },
      ));
      continue;
    }
    if (sparse) {
      issues.push(issue(
        checkpoint,
        "visual-required",
        "review",
        `PDF page ${checkpoint.page} needs one visual review because its selectable text is sparse.`,
        { expected: checkpoint.label, observed: observedSourceStart(rawSource || "") },
      ));
      requiredDecisionIds.push(checkpoint.id);
      continue;
    }

    const source = normalizedSourceExcerpt(rawSource || "");
    const observed = observedSourceStart(rawSource || "");
    if (checkpoint.kind === "heading") {
      const label = normalizedSourceExcerpt(checkpoint.label);
      if (source.includes(label)) continue;

      const chapter = checkpointChapter(book, checkpoint);
      const chapterSignals = chapter ? sourceChapterSignals(rawSource || "") : [];
      const conflictingChapter = chapterSignals.find((signal) => !sourceChapterMatchesCandidate(signal, chapter!));
      if (chapter && conflictingChapter) {
        issues.push(issue(
          checkpoint,
          "heading-conflict",
          "repair",
          `The source heading on PDF page ${checkpoint.page} conflicts with the mapped chapter.`,
          { expected: checkpoint.label, observed: conflictingChapter.line },
        ));
        continue;
      }

      issues.push(issue(
        checkpoint,
        "visual-required",
        "review",
        `The mapped heading was not found confidently in selectable text on PDF page ${checkpoint.page}; inspect that page once.`,
        { expected: checkpoint.label, observed },
      ));
      requiredDecisionIds.push(checkpoint.id);
      continue;
    }

    const mappedChapters = book.chapters.filter((chapter) =>
      chapter.startPage <= checkpoint.page && chapter.endPage >= checkpoint.page);
    const sourceChapters = sourceChapterSignals(rawSource || "");
    const conflictingChapters = sourceChapters.filter((sourceSignal) =>
      !mappedChapters.some((chapter) => sourceChapterMatchesCandidate(sourceSignal, chapter)));
    if (conflictingChapters.length > 0) {
      issues.push(issue(
        checkpoint,
        mappedChapters.length > 0 ? "coverage-conflict" : "unmapped-substantive-page",
        "repair",
        mappedChapters.length > 0
          ? `The source chapter heading on PDF page ${checkpoint.page} conflicts with the candidate coverage range.`
          : `PDF page ${checkpoint.page} contains a chapter heading but the candidate maps no chapter there.`,
        { expected: checkpoint.label, observed: conflictingChapters[0]!.line },
      ));
      continue;
    }
    if (mappedChapters.length > 0) continue;
    if (clearlyNonSubstantiveText(rawSource || "")) continue;

    issues.push(issue(
      checkpoint,
      "visual-required",
      "review",
      `PDF page ${checkpoint.page} is outside the candidate outline and needs one visual classification.`,
      { expected: checkpoint.label, observed },
    ));
    requiredDecisionIds.push(checkpoint.id);
  }

  return validationReport(run, issues, requiredDecisionIds);
}

function observationFor(
  decision: OutlineValidationDecisionInput,
): string {
  if ("observation" in decision && typeof decision.observation === "string") return decision.observation.trim();
  if ("evidence" in decision && typeof decision.evidence === "string") return decision.evidence.trim();
  return "";
}

/**
 * Resolve only the checkpoints that preflight could not decide from text.
 * Legacy check objects are accepted, but their copied page/evidence fields are
 * never treated as authoritative source evidence.
 */
export function evaluateOutlineValidationDecisions(
  book: ScholarBook,
  run: OutlineValidationRun,
  decisions: readonly OutlineValidationDecisionInput[],
): OutlineValidationReport {
  const preflight = preflightOutlineValidation(book, run);
  if (preflight.status === "source-read-required" || preflight.status === "outline-repair") return preflight;
  if (preflight.status === "ready") {
    const unknown = decisions.filter((decision) => !run.checkpoints.some((checkpoint) => checkpoint.id === decision.id));
    if (unknown.length === 0) return preflight;
    return validationReport(run, unknown.map((decision) => ({
      checkpointId: decision.id,
      code: "unknown-decision" as const,
      severity: "review" as const,
      message: `Unknown outline validation checkpoint ${JSON.stringify(decision.id)}.`,
    })), []);
  }

  const reviewIds = new Set(preflight.requiredDecisionIds);
  const byId = new Map<string, OutlineValidationDecisionInput[]>();
  for (const decision of decisions) {
    const values = byId.get(decision.id) || [];
    values.push(decision);
    byId.set(decision.id, values);
  }

  const issues = preflight.issues.filter((item) => item.code !== "visual-required");
  const unresolvedIds: string[] = [];
  let disputed = false;

  for (const decision of decisions) {
    if (reviewIds.has(decision.id)) continue;
    issues.push({
      checkpointId: decision.id,
      code: "unknown-decision",
      severity: "review",
      message: `Checkpoint ${JSON.stringify(decision.id)} does not require a validation decision.`,
    });
  }

  for (const checkpointId of preflight.requiredDecisionIds) {
    const checkpoint = run.checkpoints.find((item) => item.id === checkpointId)!;
    const matching = byId.get(checkpointId) || [];
    if (matching.length === 0) {
      issues.push(issue(
        checkpoint,
        "missing-decision",
        "review",
        `Visual checkpoint ${checkpoint.id} still needs one decision.`,
        { expected: checkpoint.label },
      ));
      unresolvedIds.push(checkpoint.id);
      continue;
    }
    if (matching.length > 1) {
      issues.push(issue(
        checkpoint,
        "duplicate-decision",
        "review",
        `Visual checkpoint ${checkpoint.id} received duplicate decisions.`,
        { expected: checkpoint.label },
      ));
      unresolvedIds.push(checkpoint.id);
      continue;
    }
    if (!run.viewedPages.has(checkpoint.page)) {
      issues.push(issue(
        checkpoint,
        "visual-not-rendered",
        "review",
        `Render PDF page ${checkpoint.page} before deciding visual checkpoint ${checkpoint.id}.`,
        { expected: checkpoint.label },
      ));
      unresolvedIds.push(checkpoint.id);
      continue;
    }

    const decision = matching[0]!;
    const observation = observationFor(decision);
    if (!isOutlineValidationOutcome(decision.outcome)) {
      issues.push(issue(
        checkpoint,
        "invalid-decision",
        "review",
        `Visual checkpoint ${checkpoint.id} received an invalid outcome.`,
        { expected: checkpoint.label, observed: observation || undefined },
      ));
      unresolvedIds.push(checkpoint.id);
      continue;
    }
    if (observation.length < 4 || observation.length > 500) {
      issues.push(issue(
        checkpoint,
        "invalid-decision",
        "review",
        `Visual checkpoint ${checkpoint.id} needs a concise observation of 4 to 500 characters.`,
        { expected: checkpoint.label },
      ));
      unresolvedIds.push(checkpoint.id);
      continue;
    }
    if (checkpoint.kind === "heading" && decision.outcome === "non-substantive") {
      issues.push(issue(
        checkpoint,
        "invalid-decision",
        "review",
        `Heading checkpoint ${checkpoint.id} cannot be classified as non-substantive.`,
        { expected: checkpoint.label, observed: observation },
      ));
      unresolvedIds.push(checkpoint.id);
      continue;
    }
    const mapsChapter = book.chapters.some((chapter) =>
      chapter.startPage <= checkpoint.page && chapter.endPage >= checkpoint.page);
    if (checkpoint.kind === "coverage" && !mapsChapter && decision.outcome === "match") {
      issues.push(issue(
        checkpoint,
        "invalid-decision",
        "review",
        `Coverage checkpoint ${checkpoint.id} cannot match because the candidate maps no chapter on PDF page ${checkpoint.page}.`,
        { expected: checkpoint.label, observed: observation },
      ));
      unresolvedIds.push(checkpoint.id);
      continue;
    }
    if (decision.outcome === "mismatch" || decision.outcome === "uncertain") {
      disputed = true;
      issues.push(issue(
        checkpoint,
        "decision-disputed",
        "review",
        `Visual review disputed checkpoint ${checkpoint.id}: ${decision.outcome}.`,
        { expected: checkpoint.label, observed: observation },
      ));
    }
  }

  const hasDecisionContractIssue = issues.some((item) =>
    item.code === "missing-decision"
    || item.code === "duplicate-decision"
    || item.code === "unknown-decision"
    || item.code === "visual-not-rendered"
    || item.code === "invalid-decision");
  return validationReport(
    run,
    issues,
    hasDecisionContractIssue ? preflight.requiredDecisionIds : unresolvedIds,
    disputed && !hasDecisionContractIssue,
  );
}
