import { extensionPath as packagedExtensionPath, piPackageRoot as sdkRoot, jitiPath as sdkJitiPath, resolvePiDependency } from "./sdk.mjs";
// Focused pure regression checks for Scholar's question-admissibility gate.
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const extensionPath = resolve(
  process.env.PI_SCHOLAR_EXTENSION
    || packagedExtensionPath,
);
const extensionDirectory = dirname(extensionPath);
const piRoot = sdkRoot;
const jitiPath = sdkJitiPath;
const { createJiti } = await import(pathToFileURL(jitiPath).href);
const jiti = createJiti(import.meta.url, { moduleCache: false });
const groundingModule = await jiti.import(join(extensionDirectory, "question-grounding.ts"));
const domain = await jiti.import(join(extensionDirectory, "domain.ts"));

const { questionGroundingIssues } = groundingModule;
const { migrateLegacyCompletion, recomputeProgress } = domain;
const now = "2026-09-01T12:00:00.000Z";

function section() {
  return {
    id: "chapter-001-section-001",
    order: 1,
    number: "1.1",
    title: "Field reasoning",
    startPage: 10,
    endPage: 20,
    objectives: ["Relate field equations to physical mechanisms."],
    coveredObjectives: ["Relate field equations to physical mechanisms."],
    requiredChecks: ["conceptual"],
    status: "learning",
    synthesis: "A substantive synthesis of how the governing field equations encode physical sources and circulation.",
    keyPoints: ["Select the governing field equation from the physical mechanism."],
    misconceptions: [],
    attempts: [],
    transcript: [],
    createdAt: now,
    updatedAt: now,
  };
}

function tutor(scopeIds = ["chapter-001-section-001"]) {
  return {
    id: "tutor-001",
    title: "Tutor 01",
    scope: { chapterIds: scopeIds.length ? ["chapter-001"] : [], sectionIds: scopeIds, description: "field reasoning" },
    status: "active",
    synthesis: "A source-grounded Tutor explanation of the governing field model and its limits.",
    keyPoints: ["Infer the governing equation from the source and circulation pattern."],
    attempts: [],
    transcript: [],
    createdAt: now,
    updatedAt: now,
  };
}

function book(activeSection = section(), sessions = [tutor()]) {
  return {
    schemaVersion: 3,
    revision: 1,
    id: "a".repeat(64),
    instanceId: "instance-001",
    source: {
      absolutePath: process.platform === "win32" ? "C:\\books\\fields.pdf" : "/books/fields.pdf",
      relativePath: "fields.pdf",
      fileName: "fields.pdf",
      format: "pdf",
      fingerprint: { sha256: "a".repeat(64), size: 1, mtimeMs: 1 },
    },
    metadata: { title: "Fields", authors: ["Scholar"], pageCount: 30 },
    outlineStatus: "ready",
    chapters: [{
      id: "chapter-001",
      order: 1,
      number: "1",
      title: "Fields",
      startPage: 10,
      endPage: 20,
      status: "learning",
      sections: [activeSection],
    }],
    currentSectionId: activeSection.id,
    exams: [],
    tutorSessions: sessions,
    currentTutorId: sessions[0]?.id,
    noteDirectory: "Fields",
    createdAt: now,
    updatedAt: now,
  };
}

function grounding(overrides = {}) {
  return {
    purpose: "mastery",
    competency: "Select and justify the governing field equation in a changed physical situation.",
    requiredEvidence: ["Identify the physical source or circulation mechanism.", "Justify the governing equation under changed conditions."],
    sourcePages: [12],
    basis: [{
      kind: "objective",
      value: "Relate field equations to physical mechanisms.",
      supports: [1, 2],
    }],
    ...overrides,
  };
}

const checks = [];
function check(name, passed, detail) {
  checks.push(Boolean(passed));
  console.log(`[${passed ? "PASS" : "FAIL"}] ${name} - ${detail}`);
}

const learnSection = section();
const testBook = book(learnSection);
const validIssues = questionGroundingIssues(grounding(), testBook, { mode: "learn", section: learnSection });
check("demanding grounded mastery is admitted", validIssues.length === 0, validIssues.join("; ") || "no difficulty cap");

const outOfScope = questionGroundingIssues(grounding({ sourcePages: [21] }), testBook, { mode: "learn", section: learnSection });
check("out-of-scope pages are rejected", outOfScope.some((issue) => /outside/.test(issue)), outOfScope.join("; "));

const uncovered = questionGroundingIssues(grounding({
  basis: [{ kind: "objective", value: "Use an objective that was never taught.", supports: [1, 2] }],
}), testBook, { mode: "learn", section: learnSection });
check("uncovered Learn objectives are rejected", uncovered.some((issue) => /not already covered/.test(issue)), uncovered.join("; "));

const missingLink = questionGroundingIssues(grounding({
  basis: [{ kind: "objective", value: "Relate field equations to physical mechanisms.", supports: [1] }],
}), testBook, { mode: "learn", section: learnSection });
check("every evidence atom needs a basis", missingLink.some((issue) => /item 2 has no declared basis/.test(issue)), missingLink.join("; "));

const ordinaryOnly = questionGroundingIssues(grounding({
  purpose: "diagnostic",
  requiredEvidence: ["Recall vector-calculus notation."],
  basis: [{ kind: "prerequisite", value: "Basic vector-calculus notation.", prerequisiteBasis: "ordinary", supports: [1] }],
}), testBook, { mode: "learn", section: learnSection });
check("ordinary-prerequisite-only diagnostics are rejected", ordinaryOnly.some((issue) => /source-declared basis/.test(issue)), ordinaryOnly.join("; "));

const sourcedDiagnostic = questionGroundingIssues(grounding({
  purpose: "diagnostic",
  requiredEvidence: ["Distinguish source from circulation."],
  basis: [{
    kind: "prerequisite",
    value: "The section distinguishes source and circulation mechanisms.",
    prerequisiteBasis: "source-declared",
    sourcePage: 12,
    supports: [1],
  }],
}), testBook, { mode: "learn", section: learnSection });
check("source-tied diagnostics are admitted", sourcedDiagnostic.length === 0, sourcedDiagnostic.join("; ") || "source receipt accepted");

const tutorSession = tutor();
const tutorBook = book(section(), [tutorSession]);
const tutorLeak = questionGroundingIssues(grounding(), tutorBook, { mode: "tutor", tutor: tutorSession });
check("Tutor cannot borrow Learn objectives", tutorLeak.some((issue) => /cannot borrow Learn objectives/.test(issue)), tutorLeak.join("; "));

const tutorValid = questionGroundingIssues(grounding({
  purpose: "practice",
  requiredEvidence: ["Infer the equation from the physical pattern."],
  basis: [{ kind: "key-point", value: "Infer the governing equation from the source and circulation pattern.", supports: [1] }],
}), tutorBook, { mode: "tutor", tutor: tutorSession });
check("Tutor-owned teaching receipt is admitted", tutorValid.length === 0, tutorValid.join("; ") || "Tutor isolation preserved");

const freeTutor = tutor([]);
const freeTutorBook = book(section(), [freeTutor]);
const freeDiagnostic = questionGroundingIssues(grounding({
  purpose: "diagnostic",
  requiredEvidence: ["Distinguish source from circulation."],
  basis: [{
    kind: "prerequisite",
    value: "The cited source page distinguishes source and circulation.",
    prerequisiteBasis: "source-declared",
    sourcePage: 12,
    supports: [1],
  }],
}), freeTutorBook, { mode: "tutor", tutor: freeTutor });
check("free-topic Tutor diagnostics still require a concrete book page", freeDiagnostic.length === 0, freeDiagnostic.join("; ") || "whole-book page anchor accepted");

const progressSection = section();
const progressBook = book(progressSection, []);
progressSection.attempts.push({
  id: "practice-001",
  kind: "conceptual",
  format: "open",
  question: "Practice",
  grounding: grounding({ purpose: "practice" }),
  outcome: "pass",
  createdAt: now,
});
recomputeProgress(progressBook, progressSection);
check("practice cannot certify completion", progressSection.status !== "complete", `status=${progressSection.status}`);

progressSection.attempts.push({
  id: "mastery-001",
  kind: "conceptual",
  format: "open",
  question: "Mastery",
  grounding: grounding(),
  outcome: "pass",
  createdAt: now,
});
recomputeProgress(progressBook, progressSection);
check("mastery cannot complete unfinished work without source-figure review", progressSection.status !== "complete", `status=${progressSection.status}`);
progressSection.figureCoverage = {
  pages: Array.from({ length: progressSection.endPage - progressSection.startPage + 1 }, (_, offset) => ({
    page: progressSection.startPage + offset, read: true, viewed: { width: 600, height: 800 }, candidates: [],
    review: { page: progressSection.startPage + offset, observation: "Visual review confirms this fixture page contains only text and no source figures.", figures: [] },
  })),
  boundaryChecked: progressSection.endPage,
};
recomputeProgress(progressBook, progressSection);
check("mastery can certify completion", progressSection.status === "complete", `status=${progressSection.status}`);

progressSection.attempts.push({
  id: "mastery-002",
  kind: "conceptual",
  format: "open",
  question: "Fresh mastery retry",
  grounding: grounding(),
  outcome: "review",
  createdAt: now,
});
recomputeProgress(progressBook, progressSection);
check("latest mastery evidence controls status", progressSection.status === "review", `status=${progressSection.status}`);

const legacySection = section();
const legacyBook = book(legacySection, []);
legacySection.attempts.push({
  id: "legacy-001",
  kind: "conceptual",
  format: "open",
  question: "Historic question",
  outcome: "pass",
  createdAt: now,
});
// An ungrounded attempt no longer certifies mastery on its own: no path can
// create one any more, so the old allowance only widened the gate.
recomputeProgress(legacyBook, legacySection);
check(
  "ungrounded evidence alone no longer certifies mastery",
  legacySection.status !== "complete",
  `status=${legacySection.status}`,
);

// Work already finished under the old rule is grandfathered by migration
// rather than by weakening the gate. Nothing invents a grounding receipt.
legacySection.status = "complete";
migrateLegacyCompletion(legacyBook);
check(
  "migration grandfathers a section completed under the old rule",
  legacySection.legacyCompletion === true,
  `legacyCompletion=${legacySection.legacyCompletion}`,
);
recomputeProgress(legacyBook, legacySection);
check(
  "a grandfathered section stays complete",
  legacySection.status === "complete",
  `status=${legacySection.status}`,
);

// A section that was not already complete gets no waiver.
const unfinishedSection = section();
const unfinishedBook = book(unfinishedSection, []);
unfinishedSection.attempts.push({
  id: "legacy-002", kind: "conceptual", format: "open",
  question: "Historic question", outcome: "pass", createdAt: now,
});
recomputeProgress(unfinishedBook, unfinishedSection);
migrateLegacyCompletion(unfinishedBook);
check(
  "migration does not grandfather unfinished work",
  unfinishedSection.legacyCompletion === undefined && unfinishedSection.status !== "complete",
  `legacyCompletion=${unfinishedSection.legacyCompletion}; status=${unfinishedSection.status}`,
);

// Once real mastery evidence exists, the waiver is dropped rather than kept.
legacySection.attempts.push({
  id: "mastery-003", kind: "conceptual", format: "open",
  question: "Properly grounded retry", grounding: grounding(), outcome: "pass", createdAt: now,
});
recomputeProgress(legacyBook, legacySection);
check(
  "the waiver is cleared once the section earns completion outright",
  legacySection.legacyCompletion === undefined && legacySection.status === "complete",
  `legacyCompletion=${legacySection.legacyCompletion}; status=${legacySection.status}`,
);

const failed = checks.filter((passed) => !passed).length;
console.log(`\nScholar question-guard summary: ${checks.length - failed} passed, ${failed} failed.`);
process.exitCode = failed ? 1 : 0;
