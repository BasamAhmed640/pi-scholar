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
console.log("[PASS] split and running chapter headings map by exact title; wrong titles remain blocked");
