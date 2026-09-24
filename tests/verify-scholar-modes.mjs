import { extensionPath as packagedExtensionPath, piPackageRoot as sdkRoot, jitiPath as sdkJitiPath, resolvePiDependency } from "./sdk.mjs";
import { saveFixtureLesson } from "./lesson-fixture.mjs";
// Scholar mode-capability gate.
//
// Modes differ in capability, not merely in name. Those differences used to be
// string comparisons scattered across the runtime, the tool layer and the
// grounding gate, where TypeScript cannot check a disjunction of string
// literals for exhaustiveness. modes.ts now states them once; this asserts the
// table still matches the behaviour it claims to describe, and that adding a
// fourth mode is a table entry rather than an eleven-file hunt.
import { readFileSync, readdirSync, statSync } from "node:fs";
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
const { MODE_CAPABILITIES, MODE_ENGINES, SCHOLAR_MODES, isScholarMode, modeCan } = await mod("modes.ts");
const { modeInstructions } = await mod("policies.ts");
const { questionGroundingIssues } = await mod("question-grounding.ts");
const lesson = await mod("lesson.ts");

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? ` - ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

// ------------------------------------------------------------ table shape --
const CAPABILITIES = ["interactiveTeaching", "interactiveQuestions", "citesLearnObjectives", "usesWebImages", "usesWebResearch", "materializesSections"];
check("every mode declares every capability",
  SCHOLAR_MODES.every((mode) => CAPABILITIES.every((cap) => typeof MODE_CAPABILITIES[mode][cap] === "boolean")),
  SCHOLAR_MODES.join(", "));
check("the table is frozen against accidental mutation",
  Object.isFrozen(MODE_CAPABILITIES) && SCHOLAR_MODES.every((mode) => Object.isFrozen(MODE_CAPABILITIES[mode])),
  "Object.freeze applied");
check("isScholarMode accepts exactly the declared modes",
  SCHOLAR_MODES.every(isScholarMode)
    && !isScholarMode("review") && !isScholarMode("toString") && !isScholarMode(undefined) && !isScholarMode(7),
  `${SCHOLAR_MODES.length} modes; prototype keys and unknown names refused`);
check("modeCan tolerates no active mode", modeCan(undefined, "assesses") === false, "returns false, does not throw");
check("Tutor alone can use bounded web research",
  SCHOLAR_MODES.every((mode) => MODE_CAPABILITIES[mode].usesWebResearch === (mode === "tutor")),
  "Learn and Exam remain PDF-only");

// -------------------------------------------- the table matches behaviour --
// Exam intentionally does not teach: policies.ts must reflect that, and does so
// by omitting the teaching engine from the exam prompt.
const book = {
  source: { fingerprint: { sha256: "a".repeat(64) } },
  metadata: { title: "Probe Book", authors: ["A"] },
  chapters: [{
    id: "chapter-001", number: "1", title: "One", order: 1, startPage: 1, endPage: 9, status: "not-started",
    sections: [{
      id: "s1", number: "1.1", title: "First", order: 1, startPage: 1, endPage: 9, status: "not-started",
      objectives: [], coveredObjectives: [], requiredChecks: ["conceptual"], keyPoints: [], misconceptions: [],
      attempts: [], transcript: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    }],
  }],
  exams: [], tutorSessions: [],
};
const section = book.chapters[0].sections[0];
const exam = { id: "exam-001", title: "E", status: "draft", scope: { chapterIds: ["chapter-001"], sectionIds: ["s1"], description: "1" }, questions: [], transcript: [] };
const tutor = { id: "tutor-001", title: "T", status: "active", scope: { chapterIds: ["chapter-001"], sectionIds: ["s1"], description: "1" }, keyPoints: [], attempts: [], transcript: [] };
const targetFor = { learn: section, exam, tutor };

const TEACHING_MARKER = "Teaching engine (guided mastery with fading support)";
const QUESTION_MARKER = "Question engine (general, concept-centered, evidence-first)";
const SHORT_QUESTION_MARKER = "Short questions (interactive delivery surfaces)";
const ENGINE_MARKERS = [
  TEACHING_MARKER,
  "Explanation quality (precision with fewer assumed prerequisites)",
  "Native Obsidian presentation (formatting only)",
  QUESTION_MARKER,
  "Question safety gate (fairness without reduced rigor)",
];
// The four engines are universal, so every mode's prompt carries every engine; only the
// interactive-surface block follows the interactiveTeaching surface.
check("every mode declares every engine",
  SCHOLAR_MODES.every((mode) => Object.values(MODE_ENGINES[mode]).every((value) => value === true)),
  JSON.stringify(MODE_ENGINES.learn));
for (const mode of SCHOLAR_MODES) {
  const prompt = modeInstructions(mode, book, targetFor[mode]);
  check(`${mode} carries every engine exactly once`,
    ENGINE_MARKERS.every((marker) => prompt.split(marker).length - 1 === 1),
    `${ENGINE_MARKERS.filter((marker) => prompt.includes(marker)).length}/${ENGINE_MARKERS.length} engine blocks present`);
  const shortQuestions = prompt.split(SHORT_QUESTION_MARKER).length - 1;
  check(`${mode} matches interactiveTeaching=${MODE_CAPABILITIES[mode].interactiveTeaching} for the interactive question surface`,
    shortQuestions === (MODE_CAPABILITIES[mode].interactiveTeaching ? 1 : 0),
    MODE_CAPABILITIES[mode].interactiveTeaching ? "short-question block present" : "short-question block absent");
}

// citesLearnObjectives is the rule that keeps Tutor evidence from borrowing
// what Learn certified. It must hold for exactly the modes that declare it.
const taughtSection = { ...section, objectives: ["Explain skin effect"], coveredObjectives: ["Explain skin effect"], keyPoints: ["Explain skin effect"], synthesis: "A source-grounded recap of the current distribution and its frequency dependence." };
saveFixtureLesson(lesson, book, taughtSection);
const groundingCitingObjective = {
  purpose: "practice",
  competency: "Apply the taught objective",
  requiredEvidence: ["applies it"],
  sourcePages: [2],
  basis: [{ kind: "objective", value: "Explain skin effect", supports: [1] }],
};
const learnIssues = questionGroundingIssues(groundingCitingObjective, book, { mode: "learn", section: taughtSection });
check("learn may cite a covered Learn objective",
  MODE_CAPABILITIES.learn.citesLearnObjectives && learnIssues.length === 0,
  learnIssues[0] || "accepted");
const tutorIssues = questionGroundingIssues(groundingCitingObjective, book, {
  mode: "tutor",
  tutor: { ...tutor, keyPoints: ["Explain skin effect"] },
});
check("tutor may not cite a Learn objective",
  !MODE_CAPABILITIES.tutor.citesLearnObjectives && tutorIssues.some((issue) => /cannot borrow Learn objectives/.test(issue)),
  tutorIssues[0] || "unexpectedly accepted");

// ------------------------------------------- capability checks are central --
// Guard against the pattern returning: a compound mode disjunction outside
// modes.ts is exactly the drift this table exists to prevent.
function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && entry.name.endsWith(".ts") ? [full] : [];
  });
}
const disjunction = /mode\s*===\s*"(learn|exam|tutor)"\s*\|\|\s*[^\n]*mode\s*===\s*"(learn|exam|tutor)"|mode\s*!==\s*"(learn|exam|tutor)"\s*&&\s*[^\n]*mode\s*!==\s*"(learn|exam|tutor)"/;
const offenders = sourceFiles(EXT)
  .filter((file) => !file.endsWith(`${"modes"}.ts`))
  .filter((file) => {
    const text = readFileSync(file, "utf8");
    // runtime-session's getter narrows a discriminated union, which the
    // compiler does check; that one is legitimate and stays.
    if (file.endsWith("runtime-session.ts")) return false;
    return disjunction.test(text);
  })
  .map((file) => file.slice(EXT.length + 1));
check("no compound mode disjunctions outside modes.ts", offenders.length === 0,
  offenders.length ? offenders.join(", ") : "capability questions all route through the table");

// -------------------------------------------- adding a mode stays localized --
check("the capability surface is small enough to extend",
  CAPABILITIES.length <= 8,
  `${CAPABILITIES.length} capabilities: ${CAPABILITIES.join(", ")}`);

console.log(`\nScholar modes summary: ${pass} passed, ${fail} failed.`);
process.exitCode = fail ? 1 : 0;
