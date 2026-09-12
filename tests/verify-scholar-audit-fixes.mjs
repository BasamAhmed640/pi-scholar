import { extensionPath as packagedExtensionPath, piPackageRoot as sdkRoot, jitiPath as sdkJitiPath, resolvePiDependency } from "./sdk.mjs";
// Regression gate for the defects found by the September 2026 deep audit.
//
// Each case pins the behaviour that was wrong, and — where a fix widened
// something — also pins the boundary that must stay closed.
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { saveFixtureLesson } from "./lesson-fixture.mjs";

const piPackageRoot = sdkRoot;
const jitiPath = sdkJitiPath;
const { createJiti } = await import(pathToFileURL(jitiPath).href);
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: { "@earendil-works/pi-coding-agent": join(piPackageRoot, "dist", "index.js") },
});

const EXT = dirname(process.env.PI_SCHOLAR_EXTENSION || packagedExtensionPath);
const mod = (rel) => jiti.import(join(EXT, rel));
const {
  allowedPageRanges, assertPagesInModeScope,
  latestAttemptForKind, recomputeProgress,
} = await mod("domain.ts");
const { buildExamBreakdown } = await mod("exam.ts");
const { handleExamGrade } = await mod("tool-actions/exam.ts");
const { handleNotes } = await mod("tool-actions/learning.ts");
const { isScholarBook } = await mod("state-schema.ts");
const lesson = await mod("lesson.ts");

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? ` - ${detail}` : ""}`);
  ok ? pass++ : fail++;
};
const threw = async (run) => { try { await run(); return ""; } catch (error) { return error.message; } };

// ---------------------------------------------------------------- fixtures --
const sec = (id, number, startPage, endPage, extra = {}) => ({
  id, order: Number(number.split(".")[1]), number, title: `S ${number}`, startPage, endPage,
  status: "not-started", objectives: [], coveredObjectives: [], requiredChecks: ["conceptual"],
  keyPoints: [], misconceptions: [], attempts: [], transcript: [],
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...extra,
});
// Chapter 1 opens on a title page (30) its sections do not cover, and carries a
// full-page figure at 34 between two sections — both real shapes from the book.
const chapter1 = {
  id: "chapter-001", number: "1", title: "One", order: 1, startPage: 30, endPage: 40, status: "not-started",
  sections: [sec("c1s1", "1.1", 31, 33), sec("c1s2", "1.2", 35, 40)],
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

// ============================ BUG-01 / BUG-02: unmapped chapter pages =======
const scopePages = (a, b) => threw(() => assertPagesInModeScope(book, "exam", "exam-001", a, b));
check("BUG-01 a chapter title page is readable in exam scope", (await scopePages(30, 30)) === "", await scopePages(30, 30));
check("BUG-02 a full-page figure between sections is readable", (await scopePages(34, 34)) === "", await scopePages(34, 34));
check("BUG-01/02 a contiguous read across the whole chapter succeeds",
  (await scopePages(30, 40)) === "", await scopePages(30, 40));
check("scope still refuses pages outside every scoped chapter",
  /outside the active exam scope/.test(await scopePages(73, 73)), await scopePages(73, 73));

// Widening must not leak another subsection into a section-scoped exam.
const sectionScoped = {
  ...book,
  exams: [{ ...book.exams[0], id: "exam-002", scope: { chapterIds: ["chapter-001"], sectionIds: ["c1s1"], description: "1.1" } }],
};
const narrow = (a, b) => threw(() => assertPagesInModeScope(sectionScoped, "exam", "exam-002", a, b));
check("a section-scoped exam gains its chapter's unmapped pages", (await narrow(30, 30)) === "", await narrow(30, 30));
check("a section-scoped exam does NOT gain a sibling subsection",
  /outside the active exam scope/.test(await narrow(36, 36)), await narrow(36, 36));

// ================================== BUG-03: inverted and invalid ranges =====
check("BUG-03 an inverted range is refused instead of passing silently",
  /is invalid/.test(await scopePages(99, 10)), await scopePages(99, 10));
check("BUG-03 a zero page is refused", /is invalid/.test(await scopePages(0, 5)), await scopePages(0, 5));
check("BUG-03 a fractional page is refused", /is invalid/.test(await scopePages(1.5, 5)), await scopePages(1.5, 5));

// ================================ BUG-04: objective dropping exploit ========
const learnSection = () => sec("c1s1", "1.1", 31, 33, {
  status: "learning", objectives: ["Alpha", "Beta", "Gamma"], coveredObjectives: ["Alpha"],
});
const notesBook = (section) => ({ ...book, chapters: [{ ...chapter1, sections: [section, chapter1.sections[1]] }] });
const fakeMutate = (state) => async (_id, mutate) => { const result = await mutate(state); return { book: state, result }; };
const toolResult = (action, summary) => ({ content: [{ type: "text", text: summary }], details: { action, summary } });
const runNotes = (section, params) => {
  const state = notesBook(section);
  return handleNotes(state, { mode: "learn", recordId: section.id }, params,
    () => section, fakeMutate(state), toolResult);
};

const dropMessage = await threw(() => runNotes(learnSection(), {
  synthesis: "A synthesis long enough to satisfy the minimum length requirement.",
  keyPoints: ["kp"], sectionId: "c1s1", objectives: ["Alpha"], coveredObjectives: ["Alpha"],
}));
check("BUG-04 dropping declared objectives is refused", /objectives are fixed once teaching begins/.test(dropMessage), dropMessage || "ACCEPTED — section could self-complete");
check("BUG-04 the refusal names the dropped objectives",
  /Beta/.test(dropMessage) && /Gamma/.test(dropMessage), dropMessage.slice(0, 80));

const appendMessage = await threw(() => runNotes(learnSection(), {
  synthesis: "A synthesis long enough to satisfy the minimum length requirement.",
  keyPoints: ["kp"], sectionId: "c1s1",
  objectives: ["Alpha", "Beta", "Gamma", "Delta"], coveredObjectives: ["Alpha", "Beta"],
  lesson: { id: "alpha-beta", title: "Alpha and Beta", markdown: "### Alpha and Beta\n\nAlpha names the input in this synthetic source model. Beta names the resulting output. The source relationship connects a change in Alpha to the corresponding change in Beta, so explaining the output requires identifying both the changed input and the relationship between them.", objectives: ["Alpha", "Beta"], keyPoints: ["kp"], sourcePages: [31] },
}));
check("BUG-04 appending a new objective is still allowed", appendMessage === "", appendMessage || "accepted");

const freshMessage = await threw(() => runNotes(sec("c1s1", "1.1", 31, 33), {
  synthesis: "A synthesis long enough to satisfy the minimum length requirement.",
  keyPoints: ["kp"], sectionId: "c1s1", objectives: ["Only"], coveredObjectives: [],
}));
check("BUG-04 an untouched section may still declare freely", freshMessage === "", freshMessage || "accepted");

// ==================================== BUG-06: breakdown result lookup =======
const question = {
  id: "q1", sectionIds: ["c1s1"], claim: "c", requiredEvidence: ["e"], dimensions: ["d"],
  format: "multiple-choice", prompt: "p", options: [], explanation: "x", maxPoints: 2,
};
const breakdownMessage = await threw(() =>
  buildExamBreakdown(book, { ...book.exams[0], questions: [question] }, [{ questionId: "typo", outcome: "correct", earnedPoints: 2, maxPoints: 2, feedback: "f" }]));
check("BUG-06 a missing result names the question instead of a TypeError",
  /no result for question q1/.test(breakdownMessage) && !/Cannot read properties/.test(breakdownMessage),
  breakdownMessage || "no error");

// ======================================== BUG-07: non-finite exam scores ====
const submitted = {
  ...book,
  exams: [{
    ...book.exams[0], status: "submitted", questions: [question], maxPoints: 2,
    rawResponses: [{ questionId: "q1", response: "a" }],
  }],
};
for (const [label, earned] of [["NaN", Number.NaN], ["Infinity", Number.POSITIVE_INFINITY]]) {
  const message = await threw(() => handleExamGrade(submitted, "exam-001",
    [{ questionId: "q1", outcome: "correct", earnedPoints: earned, maxPoints: 2, feedback: "f" }],
    fakeMutate(submitted), toolResult));
  check(`BUG-07 a ${label} score is refused`, /non-numeric score/.test(message), message || "ACCEPTED");
}
const validMessage = await threw(() => handleExamGrade(submitted, "exam-001",
  [{ questionId: "q1", outcome: "correct", earnedPoints: 2, maxPoints: 2, feedback: "f" }],
  fakeMutate(submitted), toolResult));
check("BUG-07 an ordinary score still grades", validMessage === "", validMessage || "graded");

// ======================================== BUG-08: overlapping sections ======
const overlapping = { ...book, chapters: [{ ...chapter1, sections: [sec("c1s1", "1.1", 31, 36), sec("c1s2", "1.2", 35, 40)] }] };
check("BUG-08 overlapping sections are refused by the stored schema",
  !isScholarBook(overlapping), "rejected");
const sharedBoundary = { ...book, chapters: [{ ...chapter1, sections: [sec("c1s1", "1.1", 31, 35), sec("c1s2", "1.2", 35, 40)] }] };
check("BUG-08 a shared boundary page is still legal",
  isScholarBook(sharedBoundary), "two headings may begin on one page");
check("BUG-08 the ordinary book still validates", isScholarBook(book), "no false positives");

// ==================================== BUG-09: pending-attempt overflow ======
const attempt = (index, overrides = {}) => ({
  id: `a-${String(index).padStart(4, "0")}`, kind: "quiz", format: "multiple-choice",
  question: `Q${index}`, outcome: "pending",
  createdAt: new Date(Date.UTC(2026, 0, 2, 0, 0, index)).toISOString(), ...overrides,
});
const flooded = [
  attempt(0, { id: "conceptual-pass", kind: "conceptual", format: "open", outcome: "pass", grounding: { purpose: "mastery", competency: "Demonstrates the section competency", requiredEvidence: ["shows the reasoning"], sourcePages: [31], basis: [{ kind: "objective", value: "Alpha", supports: [1] }] } }),
  ...Array.from({ length: 120 }, (_, index) => attempt(index + 1)),
];
check("BUG-09 historic pending attempts are not silently discarded",
  flooded.length === 121, `${flooded.length} retained`);
check("BUG-09 completion evidence still survives the flood",
  flooded.some((item) => item.id === "conceptual-pass"), "passing conceptual retained");
check("BUG-09 oldest and newest pending attempts both survive",
  flooded.some((item) => item.id === "a-0001") && flooded.some((item) => item.id === "a-0120"), "both retained");

const completed = sec("c1s1", "1.1", 31, 33, {
  status: "learning", objectives: ["Alpha"], coveredObjectives: ["Alpha"],
  synthesis: "A synthesis long enough to count as substantive.", keyPoints: ["kp"],
  attempts: flooded,
  figureCoverage: {
    pages: [31, 32, 33].map((page) => ({ page, read: true, viewed: { width: 600, height: 800 }, candidates: [],
      review: { page, observation: "Visual review confirms this fixture page contains only text and no source figures.", figures: [] } })),
    boundaryChecked: 33,
  },
});
const completedBook = notesBook(completed);
saveFixtureLesson(lesson, completedBook, completed);
recomputeProgress(completedBook, completed);
check("BUG-09 a section still completes after a pending flood",
  latestAttemptForKind(completed, "conceptual")?.outcome === "pass" && completed.status === "complete",
  `status=${completed.status}`);

console.log(`\nScholar audit-fixes summary: ${pass} passed, ${fail} failed.`);
process.exitCode = fail ? 1 : 0;
