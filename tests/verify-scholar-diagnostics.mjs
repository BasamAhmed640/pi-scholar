import { extensionPath as packagedExtensionPath, piPackageRoot as sdkRoot, jitiPath as sdkJitiPath, resolvePiDependency } from "./sdk.mjs";
// Scholar failure-legibility gate.
//
// Two validators sit between a model and the vault, and both used to reduce a
// rejection to a boolean: state-schema's isScholarBook ("invalid book state")
// and question-grounding ("missing or malformed"). A model told only that
// resubmits the same payload. This asserts every rejection names its field,
// and that cosmetic spacing is normalized rather than refused.
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

const piPackageRoot = sdkRoot;
const jitiPath = sdkJitiPath;
const { createJiti } = await import(pathToFileURL(jitiPath).href);
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: { "@earendil-works/pi-coding-agent": join(piPackageRoot, "dist", "index.js") },
});

const EXT = dirname(process.env.PI_SCHOLAR_EXTENSION || packagedExtensionPath);
const mod = (rel) => jiti.import(join(EXT, rel));
const { isQuestionGrounding, normalizeQuestionGrounding, questionGroundingIssues, questionGroundingShapeIssues } = await mod("question-grounding.ts");
const { isScholarBook, scholarBookIssues } = await mod("state-schema.ts");

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? ` - ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

// ------------------------------------------------------- grounding fixtures --
const KEY_POINT = "A short rise time forces a transmission-line model";
const target = {
  mode: "learn",
  section: { id: "s1", startPage: 1, endPage: 999, coveredObjectives: [], keyPoints: [KEY_POINT] },
};
const book = { chapters: [] };
const base = () => ({
  purpose: "mastery",
  competency: "Select the right interconnect model",
  requiredEvidence: ["names the governing model"],
  sourcePages: [31],
  basis: [{ kind: "key-point", value: KEY_POINT, supports: [1] }],
});
const issuesFor = (value) => questionGroundingIssues(normalizeQuestionGrounding(value), book, target);

// ------------------------------------ 1. cosmetic spacing must not cost a Q --
// These differ from the stored form only in whitespace. Normalizing them is
// correct: none of them changes what the receipt actually claims.
const cosmetic = [
  ["double space in competency", { ...base(), competency: "Select the  right interconnect model" }],
  ["trailing space in competency", { ...base(), competency: "Select the right interconnect model " }],
  ["leading space in competency", { ...base(), competency: " Select the right interconnect model" }],
  ["newline inside required evidence", { ...base(), requiredEvidence: ["names the\ngoverning model"] }],
  ["tab inside a basis value", { ...base(), basis: [{ kind: "key-point", value: KEY_POINT.replace(" ", "\t"), supports: [1] }] }],
  ["duplicate source pages", { ...base(), sourcePages: [31, 31] }],
];
for (const [name, value] of cosmetic) {
  const issues = issuesFor(value);
  check(`normalized, not rejected: ${name}`, issues.length === 0, issues[0] || "accepted");
}
check("normalizing preserves the clean case", issuesFor(base()).length === 0, "baseline still accepted");
check("normalizing does not merge duplicate evidence",
  normalizeQuestionGrounding({ ...base(), requiredEvidence: ["a", "a"] }).requiredEvidence.length === 2,
  "basis.supports indexes by position, so merging would remap the proof");

// --------------------------------- 2. real defects must name their own field --
const named = [
  ["bad purpose", { ...base(), purpose: "practise" }, /purpose must be diagnostic, practice or mastery/],
  ["empty competency", { ...base(), competency: "" }, /competency must not be empty/],
  ["overlong competency", { ...base(), competency: "x".repeat(501) }, /competency must be 500 characters or fewer/],
  ["duplicate required evidence", { ...base(), requiredEvidence: ["same claim", "same claim"] }, /requiredEvidence must not repeat/],
  ["too many evidence atoms", { ...base(), requiredEvidence: Array.from({ length: 13 }, (_, i) => `atom ${i}`) }, /requiredEvidence must hold 1 to 12/],
  ["non-integer source page", { ...base(), sourcePages: [31.5] }, /sourcePages must be positive whole page numbers/],
  ["empty basis", { ...base(), basis: [] }, /basis must hold 1 to 24/],
  ["bad basis kind", { ...base(), basis: [{ kind: "vibes", value: KEY_POINT, supports: [1] }] }, /basis\[1\]\.kind must be objective, key-point or prerequisite/],
  ["basis with no supports", { ...base(), basis: [{ kind: "key-point", value: KEY_POINT, supports: [] }] }, /basis\[1\]\.supports must list at least one/],
  ["repeated supports index", { ...base(), basis: [{ kind: "key-point", value: KEY_POINT, supports: [1, 1] }] }, /basis\[1\]\.supports must not repeat/],
  ["unexpected grounding field", { ...base(), sourceNotes: "x" }, /unexpected field\(s\): sourceNotes/],
  ["unexpected basis field", { ...base(), basis: [{ kind: "key-point", value: KEY_POINT, supports: [1], weight: 2 }] }, /basis\[1\] has unexpected field\(s\): weight/],
];
for (const [name, value, pattern] of named) {
  const issues = issuesFor(value);
  check(`names the field: ${name}`, issues.some((issue) => pattern.test(issue)), issues[0] || "no issue raised");
}
check("no rejection falls back to the old blanket message",
  named.every(([, value]) => !issuesFor(value).some((issue) => /missing or malformed/.test(issue))),
  "every case produced a specific reason");

// --------------------------- 3. semantic gate still enforced after normalizing --
check("out-of-scope pages are still refused",
  issuesFor({ ...base(), sourcePages: [4242] }).some((issue) => /outside the active learn scope/.test(issue)),
  "scope check intact");
check("untaught basis is still refused",
  issuesFor({ ...base(), basis: [{ kind: "key-point", value: "never taught", supports: [1] }] })
    .some((issue) => /not already taught/.test(issue)),
  "teaching check intact");

// -------------------------------------------- 4. book state names its field --
const goodBook = {
  schemaVersion: 3, revision: 0,
  id: "a".repeat(64), instanceId: "11111111-2222-3333-4444-555555555555",
  source: {
    absolutePath: process.platform === "win32" ? "C:\\books\\x.pdf" : "/books/x.pdf",
    relativePath: "x.pdf", fileName: "x.pdf", format: "pdf",
    fingerprint: { sha256: "a".repeat(64), size: 10, mtimeMs: 10 },
  },
  metadata: { title: "A Book", authors: ["Someone"] },
  outlineStatus: "pending", chapters: [], exams: [], tutorSessions: [],
  noteDirectory: "A Book", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};
check("a valid book yields no issues", isScholarBook(goodBook) && scholarBookIssues(goodBook).length === 0, "clean");

const bookCases = [
  ["wrong schema version", { ...goodBook, schemaVersion: 2 }, /schemaVersion must be 3/],
  ["bad book id", { ...goodBook, id: "nope" }, /^id /],
  ["negative revision", { ...goodBook, revision: -1 }, /revision must be a non-negative integer/],
  ["missing metadata title", { ...goodBook, metadata: { title: "", authors: ["A"] } }, /metadata\.title/],
  ["nested note directory", { ...goodBook, noteDirectory: "Books/deep/deeper" }, /noteDirectory/],
  ["currentSectionId with no sections", { ...goodBook, currentSectionId: "ghost" }, /currentSectionId names no section/],
];
for (const [name, value, pattern] of bookCases) {
  const issues = scholarBookIssues(value);
  check(`book issue names the field: ${name}`, issues.some((issue) => pattern.test(issue)), issues[0] || "no issue raised");
}
check("book diagnostics never contradict the authority",
  bookCases.every(([, value]) => !isScholarBook(value) && scholarBookIssues(value).length > 0)
    && scholarBookIssues(goodBook).length === 0,
  "isScholarBook remains the sole gate");

console.log(`\nScholar diagnostics summary: ${pass} passed, ${fail} failed.`);
process.exitCode = fail ? 1 : 0;
