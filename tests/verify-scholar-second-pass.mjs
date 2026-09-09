import { extensionPath as packagedExtensionPath, piPackageRoot as sdkRoot, jitiPath as sdkJitiPath, resolvePiDependency } from "./sdk.mjs";
// Regression gate for the second-pass audit defects.
//
// Most of these were consequences of an earlier fix being applied in one place
// and not its counterparts, so several checks here are parity properties rather
// than single cases: they assert two gates agree for every page, not that one
// example happens to work.
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

const piPackageRoot = sdkRoot;
const jitiPath = sdkJitiPath;
const { createJiti } = await import(pathToFileURL(jitiPath).href);
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: { "@earendil-works/pi-coding-agent": join(piPackageRoot, "dist", "index.js") },
});

const EXT = dirname(process.env.PI_SCHOLAR_EXTENSION || packagedExtensionPath);
const mod = (rel) => jiti.import(join(EXT, rel));
const { assertPagesInModeScope, migrateLegacyCompletion, recomputeProgress } = await mod("domain.ts");
const { questionGroundingIssues } = await mod("question-grounding.ts");
const { parseScholarQuizInput } = await mod("quiz-contract.ts");
const { handleAssess } = await mod("tool-actions/learning.ts");
const { handleExamGrade } = await mod("tool-actions/exam.ts");
const { isScholarBook } = await mod("state-schema.ts");

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? ` - ${detail}` : ""}`);
  ok ? pass++ : fail++;
};
const threw = async (run) => { try { await run(); return ""; } catch (error) { return error.message; } };

// ---------------------------------------------------------------- fixtures --
const KEY_POINT = "Rise time sets the usable bandwidth";
const sec = (id, number, startPage, endPage, extra = {}) => ({
  id, order: Number(number.split(".")[1]), number, title: `S ${number}`, startPage, endPage,
  status: "not-started", objectives: [], coveredObjectives: [], requiredChecks: ["conceptual"],
  keyPoints: [], misconceptions: [], attempts: [], transcript: [],
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...extra,
});
// Chapter 1 opens on an unmapped title page (30) and carries a full-page figure
// at 34 between its two sections — the real shape of the project's source book.
const chapter1 = {
  id: "chapter-001", number: "1", title: "One", order: 1, startPage: 30, endPage: 40, status: "not-started",
  sections: [sec("c1s1", "1.1", 31, 33, { keyPoints: [KEY_POINT] }), sec("c1s2", "1.2", 35, 40)],
};
const chapter2 = {
  id: "chapter-002", number: "2", title: "Two", order: 2, startPage: 72, endPage: 80, status: "not-started",
  sections: [sec("c2s1", "2.1", 73, 80)],
};
const book = {
  schemaVersion: 3, revision: 0, id: "a".repeat(64), instanceId: "11111111-2222-3333-4444-555555555555",
  source: {
    absolutePath: process.platform === "win32" ? "C:\\b\\x.pdf" : "/b/x.pdf",
    relativePath: "x.pdf", fileName: "x.pdf", format: "pdf",
    fingerprint: { sha256: "a".repeat(64), size: 1, mtimeMs: 1 },
  },
  metadata: { title: "Probe", authors: ["A"] }, outlineStatus: "ready",
  chapters: [chapter1, chapter2],
  exams: [{
    id: "exam-001", title: "E", status: "draft",
    scope: { chapterIds: ["chapter-001"], sectionIds: ["c1s1", "c1s2"], description: "1" },
    questions: [], rawResponses: [], itemResults: [], breakdown: [],
    earnedPoints: 0, maxPoints: 0, percent: 0, transcript: [],
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  }],
  tutorSessions: [], noteDirectory: "Probe",
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};
const learnSection = chapter1.sections[0];
const learnTarget = { mode: "learn", section: learnSection };
// A diagnostic backed by a source-declared prerequisite isolates the page gate:
// the only thing that can reject it is the page itself being out of scope.
const receiptFor = (page) => ({
  purpose: "diagnostic",
  competency: "Recognize the governing idea introduced on this page",
  requiredEvidence: ["names the idea"],
  sourcePages: [page],
  basis: [{
    kind: "prerequisite", value: "The cited page introduces the idea",
    prerequisiteBasis: "source-declared", sourcePage: page, supports: [1],
  }],
});

// ==== DEFECT-01: the read gate and the question gate must allow the same pages
const canRead = (page) => { try { assertPagesInModeScope(book, "learn", "c1s1", page, page); return true; } catch { return false; } };
const canCite = (page) => questionGroundingIssues(receiptFor(page), book, learnTarget)
  .every((issue) => !/outside the active/.test(issue));

check("DEFECT-01 a chapter lead-in page may be cited in Learn", canCite(30), "page 30 accepted");
check("DEFECT-01 a page outside the chapter still cannot be cited", !canCite(73), "page 73 refused");

const divergent = [];
for (let page = 1; page <= 90; page += 1) {
  if (canRead(page) !== canCite(page)) divergent.push(page);
}
check("DEFECT-01 read and cite agree on every page of the book",
  divergent.length === 0,
  divergent.length ? `diverge on ${divergent.join(", ")}` : "90 pages checked, no contradiction");

const tutorSession = {
  id: "tutor-001", title: "T", status: "active", keyPoints: [KEY_POINT], attempts: [], transcript: [],
  scope: { chapterIds: ["chapter-001"], sectionIds: ["c1s1"], description: "1.1" },
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};
const tutorCites = (page) => questionGroundingIssues(receiptFor(page), book, { mode: "tutor", tutor: tutorSession })
  .every((issue) => !/outside the active/.test(issue));
check("DEFECT-01 Tutor may also cite its chapter's lead-in page", tutorCites(30), "page 30 accepted");
check("DEFECT-01 Tutor still cannot cite another chapter", !tutorCites(73), "page 73 refused");

// ============ DEFECT-02: a malformed receipt must be diagnosed, not discarded
const malformed = {
  purpose: "mastery", competency: "c", requiredEvidence: ["e"], sourcePages: [31],
  basis: [{ kind: "invalid-kind", value: "v", supports: [1] }],
};
const parsed = parseScholarQuizInput({ question: "Q?", options: [{ label: "A" }], grounding: malformed });
check("DEFECT-02 a malformed receipt is kept rather than dropped",
  parsed.grounding !== undefined, parsed.grounding === undefined ? "DROPPED — reason is lost" : "retained");
const malformedIssues = questionGroundingIssues(parsed.grounding, book, learnTarget);
check("DEFECT-02 the caller is told which field is wrong",
  malformedIssues.some((issue) => /basis\[1\]\.kind must be objective, key-point or prerequisite/.test(issue)),
  malformedIssues[0] || "no issue raised");
check("DEFECT-02 it is not reported as a missing object",
  !malformedIssues.some((issue) => /must be an object with purpose/.test(issue)),
  "field diagnostics survive the boundary");

// ============== DEFECT-03: a grandfathered section must still be demotable ===
const grounded = (outcome) => ({
  id: `mastery-${outcome}`, kind: "conceptual", format: "open", question: "Q",
  outcome, createdAt: "2026-02-01T00:00:00.000Z",
  grounding: {
    purpose: "mastery", competency: "c", requiredEvidence: ["e"], sourcePages: [31],
    basis: [{ kind: "key-point", value: KEY_POINT, supports: [1] }],
  },
});
const legacySection = () => sec("c1s1", "1.1", 31, 33, {
  status: "complete", objectives: ["Alpha"], coveredObjectives: ["Alpha"],
  synthesis: "A synthesis long enough to count as substantive.", keyPoints: [KEY_POINT],
  attempts: [{ id: "legacy", kind: "conceptual", format: "open", question: "Old", outcome: "pass", createdAt: "2026-01-01T00:00:00.000Z" }],
});
const legacyBook = (section) => ({ ...book, chapters: [{ ...chapter1, sections: [section, chapter1.sections[1]] }] });

const grandfathered = legacySection();
migrateLegacyCompletion(legacyBook(grandfathered));
check("DEFECT-03 the section is grandfathered to begin with",
  grandfathered.legacyCompletion === true, `legacyCompletion=${grandfathered.legacyCompletion}`);

grandfathered.attempts.push(grounded("review"));
recomputeProgress(legacyBook(grandfathered), grandfathered);
check("DEFECT-03 a failed review demotes a grandfathered section",
  grandfathered.status !== "complete" && grandfathered.legacyCompletion === undefined,
  `status=${grandfathered.status}; legacyCompletion=${grandfathered.legacyCompletion}`);

const untouched = legacySection();
migrateLegacyCompletion(legacyBook(untouched));
recomputeProgress(legacyBook(untouched), untouched);
check("DEFECT-03 an untouched grandfathered section stays complete",
  untouched.status === "complete" && untouched.legacyCompletion === true,
  `status=${untouched.status}`);

const rePassed = legacySection();
migrateLegacyCompletion(legacyBook(rePassed));
rePassed.attempts.push(grounded("pass"));
recomputeProgress(legacyBook(rePassed), rePassed);
check("DEFECT-03 passing new mastery evidence retires the waiver",
  rePassed.status === "complete" && rePassed.legacyCompletion === undefined,
  `status=${rePassed.status}; legacyCompletion=${rePassed.legacyCompletion}`);

// ================= DEFECT-04 / 05: bad enums must not reach the atomic write =
const fakeMutate = (state) => async (_id, mutate) => ({ book: state, result: await mutate(state) });
const toolResult = (action, summary) => ({ content: [{ type: "text", text: summary }], details: { action, summary } });
const assessSection = sec("c1s1", "1.1", 31, 33, { status: "learning", keyPoints: [KEY_POINT] });
const assessBook = legacyBook(assessSection);
const runAssess = (params) => handleAssess(assessBook, { mode: "learn", recordId: "c1s1" }, "call-1", params,
  () => assessSection, fakeMutate(assessBook), toolResult);
const masteryReceipt = {
  purpose: "mastery", competency: "c", requiredEvidence: ["e"], sourcePages: [31],
  basis: [{ kind: "key-point", value: KEY_POINT, supports: [1] }],
};

const badKind = await threw(() => runAssess({ outcome: "pending", kind: "essay", question: "Q?", grounding: masteryReceipt }));
check("DEFECT-04 an unknown assessment kind is refused by name",
  /assess kind must be one of/.test(badKind) && /"essay"/.test(badKind), badKind || "ACCEPTED");
check("DEFECT-04 the refusal is not an opaque save failure",
  !/does not match the stored attempt schema/.test(badKind), "fails at the field, not the write");

const badOutcome = await threw(() => handleAssess(assessBook, { mode: "learn", recordId: "c1s1" }, "call-2",
  { attemptId: "assessment-call-1", outcome: "failed", feedback: "f" },
  () => assessSection, fakeMutate(assessBook), toolResult));
check("DEFECT-05 an unknown resolution outcome is refused by name",
  /Resolve a prepared question with one of/.test(badOutcome) && /"failed"/.test(badOutcome), badOutcome || "ACCEPTED");

// ============================ DEFECT-06: missing feedback must not be a crash =
const question = {
  id: "q1", sectionIds: ["c1s1"], claim: "c", requiredEvidence: ["e"], dimensions: ["d"],
  format: "multiple-choice", prompt: "p", options: [], explanation: "x", maxPoints: 2,
};
const submitted = { ...book, exams: [{ ...book.exams[0], status: "submitted", questions: [question], maxPoints: 2, rawResponses: [{ questionId: "q1", response: "a" }] }] };
for (const [label, feedback] of [["omitted", undefined], ["null", null], ["blank", "   "]]) {
  const message = await threw(() => handleExamGrade(submitted, "exam-001",
    [{ questionId: "q1", outcome: "correct", earnedPoints: 2, maxPoints: 2, feedback }],
    fakeMutate(submitted), toolResult));
  check(`DEFECT-06 ${label} feedback gives a clean error, not a TypeError`,
    /needs diagnostic feedback/.test(message) && !/Cannot read properties/.test(message), message || "no error");
}

// ================================== DEFECT-07: overlapping chapters ==========
const overlappingChapters = {
  ...book,
  chapters: [
    { ...chapter1, startPage: 10, endPage: 50, sections: [sec("c1s1", "1.1", 10, 50)] },
    { ...chapter2, startPage: 20, endPage: 60, sections: [sec("c2s1", "2.1", 20, 60)] },
  ],
  exams: [], currentSectionId: undefined,
};
check("DEFECT-07 overlapping chapters are refused by the stored schema",
  !isScholarBook(overlappingChapters), "rejected");
const sharedChapterBoundary = {
  ...book,
  chapters: [
    { ...chapter1, startPage: 10, endPage: 50, sections: [sec("c1s1", "1.1", 10, 50)] },
    { ...chapter2, startPage: 50, endPage: 60, sections: [sec("c2s1", "2.1", 50, 60)] },
  ],
  exams: [], currentSectionId: undefined,
};
check("DEFECT-07 a shared chapter boundary page is still legal",
  isScholarBook(sharedChapterBoundary), "one page may end a chapter and begin the next");
check("DEFECT-07 the ordinary book still validates", isScholarBook(book), "no false positives");

// ======================= DEFECT-08: search must cover the readable range =====
const searchSource = readFileSync(join(EXT, "tool-actions", "source.ts"), "utf8");
check("DEFECT-08 search derives its range from the read gate",
  /allowedPageRanges\(book, session\.mode, session\.recordId\)/.test(searchSource)
    && !/sectionsInModeScope/.test(searchSource),
  "handleSourceSearch uses allowedPageRanges");

console.log(`\nScholar second-pass summary: ${pass} passed, ${fail} failed.`);
process.exitCode = fail ? 1 : 0;
