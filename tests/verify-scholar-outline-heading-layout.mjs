import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { extensionPath, jitiPath } from "./sdk.mjs";

const { createJiti } = await import(pathToFileURL(jitiPath).href);
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { preflightOutlineValidation } = await jiti.import(join(dirname(extensionPath), "outline-validation.ts"));
const chapter = (id, title, startPage, endPage) => ({ id, title, startPage, endPage, sections: [] });
const book = { chapters: [chapter("c1", "Feedback Control Systems", 3, 9), chapter("c2", "Stability", 10, 11)] };
const sources = new Map([
  [3, "CHAPTER 1\n\nFeedback Control Systems\nA control system responds to disturbances."],
  [7, "Chapter 1 · Feedback Control Systems\n\nA tuning workflow checks margin."],
  [11, "Chapter 2 · Stability\n\nStability margins quantify distance from failure."],
]);
const run = { outlineRevision: 1, sparsePages: new Set(), pageText: sources,
  checkpoints: [...sources.keys()].map(page => ({ id: `coverage-page-${page}`, page, kind: "coverage", label: "chapter coverage" })) };
const report = preflightOutlineValidation(book, run);
assert.equal(report.status, "ready", JSON.stringify(report.issues));
assert.equal(report.passed, 3);
const wrong = preflightOutlineValidation({ chapters: [chapter("c1", "Different topic", 3, 9), book.chapters[1]] }, run);
assert.equal(wrong.status, "outline-repair", "a real title mismatch must still be refused");
assert.ok(wrong.issues.some(issue => issue.checkpointId === "coverage-page-3"));

const checkpointRun = (page, source, kind, id = "c2", label = "Feedback Control Systems") => ({
  outlineRevision: 1,
  sparsePages: new Set(),
  pageText: new Map([[page, source]]),
  checkpoints: [{ id: kind === "heading" ? id : `coverage-page-${page}`, page, kind, label: kind === "heading" ? label : "chapter coverage" }],
});
const mixedPage = "Chapter 1 · Feedback Control Systems\nCHAPTER 2\nStability\nStability margins quantify distance from failure.";
const wrongSecondChapter = {
  chapters: [chapter("c1", "Feedback Control Systems", 3, 9), chapter("c2", "Feedback Control Systems", 10, 11)],
};
for (const kind of ["heading", "coverage"]) {
  const result = preflightOutlineValidation(wrongSecondChapter, checkpointRun(10, mixedPage, kind));
  assert.equal(result.status, "visual-review", `old running header must not mask wrong ${kind} chapter`);
}
const correctMixedPage = preflightOutlineValidation(book, checkpointRun(10, mixedPage, "coverage"));
assert.equal(correctMixedPage.status, "visual-review", JSON.stringify(correctMixedPage.issues));
const correctMixedHeading = preflightOutlineValidation(book, checkpointRun(10, mixedPage, "heading", "c2", "Stability"));
assert.equal(correctMixedHeading.status, "visual-review", JSON.stringify(correctMixedHeading.issues));

const ambiguousPage = "Chapter 1 · Feedback Control Systems\nChapter 2 · Stability\nStability margins quantify distance from failure.";
for (const kind of ["heading", "coverage"]) {
  const result = preflightOutlineValidation(book, checkpointRun(10, ambiguousPage, kind, "c2", "Stability"));
  assert.equal(result.status, "visual-review", `ambiguous title-case chapter signals require ${kind} review`);
}

const wrappedPage = "CHAPTER 1\nFeedback Control\nSystems\nA control system responds to disturbances.";
const incompleteTitle = { chapters: [chapter("c1", "Feedback Control", 3, 9)] };
for (const kind of ["heading", "coverage"]) {
  const result = preflightOutlineValidation(incompleteTitle, checkpointRun(3, wrappedPage, kind, "c1"));
  assert.equal(result.status, "visual-review", `wrapped chapter title must not pass ${kind} check`);
  const complete = preflightOutlineValidation({ chapters: [chapter("c1", "Feedback Control Systems", 3, 9)] },
    checkpointRun(3, wrappedPage, kind, "c1", "Feedback Control Systems"));
  assert.equal(complete.status, "visual-review", JSON.stringify(complete.issues));
}
const unpunctuatedBody = "CHAPTER 1\nFeedback Control Systems\nA control system responds to disturbances\nand corrects the output.";
for (const kind of ["heading", "coverage"]) {
  for (const title of ["Feedback Control Systems", "Feedback Control Systems A control system responds to disturbances"]) {
    const result = preflightOutlineValidation({ chapters: [chapter("c1", title, 3, 9)] },
      checkpointRun(3, unpunctuatedBody, kind, "c1", title));
    assert.equal(result.status, "visual-review", `unclear title/body boundary must not approve or reject ${kind}`);
  }
}
const uppercaseOldHeader = "CHAPTER 1 · Feedback Control Systems\nChapter 2 · Stability\nStability margins quantify distance from failure.";
for (const kind of ["heading", "coverage"]) {
  const result = preflightOutlineValidation(book, checkpointRun(10, uppercaseOldHeader, kind, "c2", "Stability"));
  assert.equal(result.status, "visual-review", `case alone must not disambiguate ${kind} chapter signals`);
}
const inlineWrappedTitle = "CHAPTER 1 Feedback Control\nSystems\nA control system responds to disturbances.";
const sentenceCaseTitle = "CHAPTER 1\nFeedback control systems\nA control system responds to disturbances.";
const titleCaseSubheading = "CHAPTER 1\nFeedback Control Systems\nSystem Response\n1.1 The Plant\nA control system responds to disturbances.";
const numericTitleContinuation = "CHAPTER 1\nFeedback Control\n101\nThe closed-loop response is measured.";
const punctuatedTitleContinuation = "CHAPTER 1\nFeedback Control\nSystems.\nThe closed-loop response is measured.";
for (const source of [inlineWrappedTitle, sentenceCaseTitle, titleCaseSubheading, numericTitleContinuation, punctuatedTitleContinuation]) {
  for (const kind of ["heading", "coverage"]) {
    const candidate = source === titleCaseSubheading
      ? { chapters: [chapter("c1", "Feedback Control Systems System Response", 3, 9)] }
      : incompleteTitle;
    const result = preflightOutlineValidation(candidate, checkpointRun(3, source, kind, "c1", candidate.chapters[0].title));
    assert.equal(result.status, "visual-review", `unclear ${kind} title boundary needs visual review`);
  }
}
const numericNewHeading = "Chapter 1 · Feedback Control Systems\n2 Stability\nStability margins quantify distance from failure.";
for (const kind of ["heading", "coverage"]) {
  const result = preflightOutlineValidation({ chapters: [chapter("c1", "Feedback Control Systems", 3, 11)] },
    checkpointRun(10, numericNewHeading, kind, "c1"));
  assert.equal(result.status, "visual-review", `numeric new chapter must not be hidden by running header in ${kind}`);
}
const numberedRunningTitle = "7 Feedback Control Systems\nA feedback system uses measured output to correct error.";
const numberedResult = preflightOutlineValidation(book, checkpointRun(7, numberedRunningTitle, "coverage"));
assert.equal(numberedResult.status, "visual-review", "page number beside running title is not a chapter conflict");
console.log("[PASS] chapter heading layout, running headers, and wrapped titles");
