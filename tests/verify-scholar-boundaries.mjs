import { extensionPath as packagedExtensionPath, piPackageRoot as sdkRoot, jitiPath as sdkJitiPath, resolvePiDependency } from "./sdk.mjs";
// Scholar boundary and durable-history gate.
//
// Two invariants that together caused most of this codebase's hard failures:
//
//   1. Boundary parity. Every path that turns model-authored input into stored
//      records must rebuild it field by field, so unknown annotations are
//      dropped rather than failing an atomic write that names nothing. Anything
//      a builder returns must satisfy the stored schema.
//
//   2. Durable history. Model resume context is bounded separately; saved
//      lessons and attempts must never be silently removed from the vault.
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
const { buildOutlineChapters } = await mod("tool-actions/outline.ts");
const { assertOutlineStructure } = await mod("outline-validation.ts");
const {
  appendTranscript, latestAttemptForKind, recomputeProgress,
} = await mod("domain.ts");
const { scholarBookIssues } = await mod("state-schema.ts");
const lesson = await mod("lesson.ts");

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? ` - ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

// =========================================================== 1. boundary ====
const outlineInput = [{
  number: "1", title: "  Signal Integrity  ", startPage: 1, endPage: 20,
  // Fields a model plausibly adds that the stored schema has no room for.
  summary: "chapter overview", confidence: 0.9,
  sections: [
    { number: "1.1", title: "What Is SI", startPage: 1, endPage: 9, objectives: ["Define SI", "Define SI"], notes: "scratch" },
    { number: "1.2", title: "Cross Talk", startPage: 10, endPage: 20, requiredChecks: ["application"] },
  ],
}];
const built = buildOutlineChapters(structuredClone(outlineInput), 100);
const chapterKeys = Object.keys(built[0]).sort();
const sectionKeys = Object.keys(built[0].sections[0]).sort();
check("outline builder drops unknown chapter fields",
  !chapterKeys.includes("summary") && !chapterKeys.includes("confidence"), chapterKeys.join(", "));
check("outline builder drops unknown section fields",
  !sectionKeys.includes("notes"), sectionKeys.join(", "));
check("outline builder trims titles", built[0].title === "Signal Integrity", JSON.stringify(built[0].title));
check("outline builder dedupes objectives",
  built[0].sections[0].objectives.length === 1, JSON.stringify(built[0].sections[0].objectives));
check("outline builder always seeds a conceptual check",
  built[0].sections.every((section) => section.requiredChecks[0] === "conceptual"),
  built[0].sections.map((s) => s.requiredChecks.join("+")).join(" / "));

const bookWithOutline = {
  schemaVersion: 3, revision: 0,
  id: "b".repeat(64), instanceId: "11111111-2222-3333-4444-555555555555",
  source: {
    absolutePath: process.platform === "win32" ? "C:\\books\\x.pdf" : "/books/x.pdf",
    relativePath: "x.pdf", fileName: "x.pdf", format: "pdf",
    fingerprint: { sha256: "b".repeat(64), size: 10, mtimeMs: 10 },
  },
  metadata: { title: "Probe", authors: ["A"] },
  outlineStatus: "ready", chapters: built, exams: [], tutorSessions: [],
  noteDirectory: "Probe", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};
const outlineIssues = scholarBookIssues(bookWithOutline);
check("outline builder output is storable as-is", outlineIssues.length === 0, outlineIssues[0] || "clean");

for (const [name, chapters, pattern] of [
  ["overlapping sections", [{ ...built[0], sections: [
    { ...built[0].sections[0], endPage: 15 }, { ...built[0].sections[1], startPage: 10 }] }], /overlap/],
  ["section outside its chapter", [{ ...built[0], sections: [
    { ...built[0].sections[0], endPage: 99 }, built[0].sections[1]] }], /falls outside its chapter/],
]) {
  let message = "";
  try { assertOutlineStructure(structuredClone(chapters), 100); } catch (error) { message = error.message; }
  check(`outline structure names the fault: ${name}`, pattern.test(message), message || "no error thrown");
}

// ==================================================== 2. bounded history ====
const entry = (index) => ({
  id: `assistant-${String(index).padStart(4, "0")}`,
  kind: "assistant",
  markdown: `Lesson step ${index}`,
  createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
});
const transcript = [];
for (let index = 0; index < 100; index += 1) appendTranscript(transcript, entry(index));
check("transcript preserves all entries beyond the former cap", transcript.length === 100 && transcript[0].markdown === "Lesson step 0", `${transcript.length} entries`);
check("transcript keeps the newest entries",
  transcript.at(-1).markdown === "Lesson step 99",
  transcript.at(-1).markdown);
check("transcript still dedupes by id",
  appendTranscript(transcript, transcript.at(-1)) === false && transcript.length === 100,
  "repeat rejected");

const attempt = (index, overrides = {}) => ({
  id: `quiz-${String(index).padStart(4, "0")}`,
  kind: "quiz", format: "multiple-choice", question: `Q${index}`, outcome: "review",
  createdAt: new Date(Date.UTC(2026, 0, 2, 0, 0, index)).toISOString(),
  ...overrides,
});

// The completion-critical case: a passing conceptual attempt made long ago,
// buried under hundreds of newer ones. Dropping it would silently un-complete
// a finished section.
const section = {
  id: "s1", order: 1, number: "1.1", title: "First", startPage: 1, endPage: 9,
  objectives: ["Define SI"], coveredObjectives: ["Define SI"], requiredChecks: ["conceptual"],
  status: "learning", synthesis: "A durable synthesis of the section's content.", keyPoints: ["Rise time sets bandwidth"],
  misconceptions: [], transcript: [],
  figureCoverage: {
    pages: Array.from({ length: 9 }, (_, offset) => ({ page: offset + 1, read: true, viewed: { width: 600, height: 800 }, candidates: [],
      review: { page: offset + 1, observation: "Visual review confirms this fixture page contains only text and no source figures.", figures: [] } })),
    boundaryChecked: 9,
  },
  // Completion evidence must now be a declared mastery attempt: an ungrounded
  // one no longer certifies, which is what a real attempt looks like today.
  attempts: [attempt(0, { id: "conceptual-pass", kind: "conceptual", format: "open", outcome: "pass", grounding: { purpose: "mastery", competency: "Demonstrates the section competency", requiredEvidence: ["shows the reasoning"], sourcePages: [1], basis: [{ kind: "objective", value: "Define SI", supports: [1] }] } })],
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};
const pending = attempt(1, { id: "open-pending", kind: "application", format: "open", outcome: "pending" });
section.attempts.push(pending);
for (let index = 2; index < 230; index += 1) section.attempts.push(attempt(index));

const historyBook = { ...bookWithOutline, chapters: [{ ...built[0], sections: [section] }] };
saveFixtureLesson(lesson, historyBook, section);
recomputeProgress(historyBook, section);
check("section is complete with long history", section.status === "complete", `status=${section.status}`);

check("all attempts survive progress recomputation", section.attempts.length === 230,
  `${section.attempts.length} retained`);
check("the old passing conceptual attempt survives",
  section.attempts.some((item) => item.id === "conceptual-pass"), "completion evidence retained");
check("the pending open attempt survives",
  section.attempts.some((item) => item.id === "open-pending"), "resolved later by id");
check("latestAttemptForKind still finds the passing conceptual",
  latestAttemptForKind(section, "conceptual")?.outcome === "pass", "kind lookup intact");
check("attempts stay in chronological order",
  section.attempts.every((item, index, all) => index === 0 || all[index - 1].createdAt <= item.createdAt),
  "order preserved");

recomputeProgress(historyBook, section);
check("the section is STILL complete after recomputation", section.status === "complete",
  `status=${section.status} — old completion evidence remains available`);

console.log(`\nScholar boundaries summary: ${pass} passed, ${fail} failed.`);
process.exitCode = fail ? 1 : 0;
