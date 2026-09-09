import { extensionPath as packagedExtensionPath, piPackageRoot as sdkRoot, jitiPath as sdkJitiPath, resolvePiDependency } from "./sdk.mjs";
// Scholar exam-form contract gate.
//
// exam_build is the only path between a model-authored question and the vault:
// exam.ts:validateExamQuestions accepts, then the atomic write runs
// state-schema.ts:isScholarBook. If those disagree the tool reports success and
// the save dies with a message naming nothing, which is unrecoverable for the
// caller. This asserts they agree, and covers the scope parsing that selects
// which sections an exam may draw from.
//
// exam.ts, domain.ts and state-schema.ts have no Pi SDK dependency, so this
// runs standalone.

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

const { examBlueprint, examBlueprintSummary, examFormIssues, validateExamQuestions } = await mod("exam.ts");
const { isExamQuestion } = await mod("state-schema.ts");
const { resolveScope } = await mod("domain.ts");

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? ` - ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

// ---------------------------------------------------------------- fixtures --
const section = (id, number, title, startPage, endPage) => ({
  id, number, title, order: 1, startPage, endPage, status: "not-started",
  objectives: [], coveredObjectives: [], requiredChecks: ["conceptual"],
  keyPoints: [], misconceptions: [], attempts: [], transcript: [],
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
});
const chapter = (id, number, title, sections) => ({
  id, number, title, order: Number(number), startPage: sections[0].startPage,
  endPage: sections.at(-1).endPage, status: "not-started", sections,
});
const book = {
  chapters: [
    chapter("chapter-001", "1", "Signal Integrity", [section("chapter-001-section-001", "1.1", "What Is SI", 31, 33)]),
    chapter("chapter-002", "2", "Time and Frequency", [section("chapter-002-section-001", "2.1", "The Time Domain", 73, 78)]),
    chapter("chapter-003", "3", "Impedance", [section("chapter-003-section-001", "3.1", "Impedance", 111, 118)]),
    chapter("chapter-004", "4", "Resistance", [section("chapter-004-section-001", "4.1", "Resistance", 157, 163)]),
    chapter("chapter-005", "5", "Capacitance", [section("chapter-005-section-001", "5.1", "Capacitance", 239, 246)]),
  ],
};
const SEC = "chapter-001-section-001";
const exam = { scope: { chapterIds: ["chapter-001"], sectionIds: [SEC], description: "chapter 1" } };

const mcq = () => ({
  id: "q1", sectionIds: [SEC], claim: "Selects the right model.",
  requiredEvidence: ["names the governing model"], dimensions: ["model selection"],
  format: "multiple-choice", prompt: "Which model applies?",
  options: [
    { value: "a", label: "Lumped", misconception: "ignores propagation delay" },
    { value: "b", label: "Transmission line" },
    { value: "c", label: "Distributed RC", misconception: "treats a low-loss line as diffusive" },
  ],
  correctAnswer: "b", explanation: "Rise time is short.", maxPoints: 2,
});
const open = () => ({
  id: "q2", sectionIds: [SEC], claim: "Derives impedance.",
  requiredEvidence: ["states assumption", "computes value"], dimensions: ["reasoning"],
  format: "open", prompt: "Derive Z0.",
  rubric: [{ id: "r1", criterion: "States assumptions", requiredEvidence: ["assumption"], points: 1 },
           { id: "r2", criterion: "Correct computation", requiredEvidence: ["value"], points: 2 }],
  explanation: "Z0 = sqrt(L/C).", maxPoints: 3,
});

// ------------------------------------------------- 1. accepted == storable --
// The core invariant: anything validateExamQuestions returns must satisfy the
// stored schema. Otherwise exam_build reports success and the write fails.
const accepted = [
  ["baseline MCQ", [mcq()]],
  ["baseline open", [open()]],
  ["mixed form", [mcq(), open()]],
  ["four plausible options", [{ ...mcq(), options: [
    { value: "a", label: "Lumped", misconception: "ignores propagation delay" },
    { value: "b", label: "Transmission line" },
    { value: "c", label: "Distributed RC", misconception: "treats a low-loss line as diffusive" },
    { value: "d", label: "Quasi-static", misconception: "assumes the line is electrically short" }] }]],
  ["multi-select correctAnswer", [{ ...mcq(), correctAnswer: ["a", "b"] }]],
  // Unknown annotations are dropped, not fatal: a model may add scratch fields.
  ["unknown annotation fields", [{ ...mcq(), sourcePages: [31], difficulty: "transfer", points: 2 }]],
];
for (const [name, raw] of accepted) {
  let out, err;
  try { out = validateExamQuestions(exam, raw); } catch (e) { err = e.message; }
  const storable = out?.every(isExamQuestion);
  check(`accepted and storable: ${name}`, Boolean(out) && storable, err || (storable ? `${out.length} question(s)` : "returned a question the vault would reject"));
}

// ------------------------------------------- 2. rejected with a real reason --
// These are modeling errors. They must fail here, naming the question, rather
// than at the atomic write with an opaque whole-book rejection.
const rejected = [
  ["MCQ carrying a rubric", [{ ...mcq(), rubric: [{ id: "r1", criterion: "R", requiredEvidence: ["x"], points: 2 }] }], /must not carry a rubric/],
  ["open carrying empty options", [{ ...open(), options: [] }], /must not carry options or a correctAnswer/],
  ["open carrying a correctAnswer", [{ ...open(), correctAnswer: "n/a" }], /must not carry options or a correctAnswer/],
  ["duplicate rubric criterion ids", [{ ...open(), rubric: [
    { id: "r1", criterion: "A", requiredEvidence: ["a"], points: 1 },
    { id: "r1", criterion: "B", requiredEvidence: ["b"], points: 2 }] }], /duplicate rubric criterion id/],
  ["rubric criterion with no evidence", [{ ...open(), rubric: [
    { id: "r1", criterion: "A", requiredEvidence: [], points: 1 },
    { id: "r2", criterion: "B", requiredEvidence: ["b"], points: 2 }] }], /needs required evidence/],
  ["option value over 200 chars", [{ ...mcq(), options: [
    { value: "x".repeat(201), label: "Long", misconception: "m1" },
    { value: "b", label: "Short" },
    { value: "c", label: "Other", misconception: "m2" }] }], /200 characters or fewer/],
  ["rubric points not totalling maxPoints", [{ ...open(), maxPoints: 9 }], /must total maxPoints/],
  ["question outside the frozen scope", [{ ...mcq(), sectionIds: ["chapter-002-section-001"] }], /only sections in the frozen scope/],
  ["duplicate question ids", [mcq(), { ...open(), id: "q1" }], /Duplicate exam question id/],
];
for (const [name, raw, pattern] of rejected) {
  let message = "";
  try { validateExamQuestions(exam, raw); } catch (e) { message = e.message; }
  check(`rejected with a usable reason: ${name}`, pattern.test(message), message || "no error thrown");
}

// ------------------------------------------ 2b. question-engine standards --
// The mechanically checkable parts of the engine. They cannot make an exam
// good, but they rule out the cheapest ways of making it bad.
const engineRules = [
  ["two-option coin flip", [{ ...mcq(), options: [
    { value: "a", label: "Lumped", misconception: "m1" }, { value: "b", label: "Transmission line" }] }],
    /at least 3 genuinely plausible options/],
  ["all-of-the-above option", [{ ...mcq(), options: [
    { value: "a", label: "Lumped", misconception: "m1" },
    { value: "b", label: "Transmission line" },
    { value: "c", label: "All of the above", misconception: "m2" }] }],
    /catch-all option/],
  ["none-of-these option", [{ ...mcq(), options: [
    { value: "a", label: "Lumped", misconception: "m1" },
    { value: "b", label: "Transmission line" },
    { value: "c", label: "None of these", misconception: "m2" }] }],
    /catch-all option/],
  ["distractor that diagnoses nothing", [{ ...mcq(), options: [
    { value: "a", label: "Lumped" },
    { value: "b", label: "Transmission line" },
    { value: "c", label: "Distributed RC", misconception: "m2" }] }],
    /declare no misconception/],
  ["distractors repeating one misconception", [{ ...mcq(), options: [
    { value: "a", label: "Lumped", misconception: "same error" },
    { value: "b", label: "Transmission line" },
    { value: "c", label: "Distributed RC", misconception: "Same Error" }] }],
    /repeats a distractor misconception/],
  ["holistic single-criterion rubric", [{ ...open(), rubric: [
    { id: "r1", criterion: "Overall quality", requiredEvidence: ["good answer"], points: 3 }] }],
    /at least 2 rubric criteria/],
];
for (const [name, raw, pattern] of engineRules) {
  let message = "";
  try { validateExamQuestions(exam, raw); } catch (error) { message = error.message; }
  check(`engine rule enforced: ${name}`, pattern.test(message), message || "accepted, but should not be");
}

// ---------------------------------------------- 2c. form-level thoroughness --
const q = (id, format) => format === "open"
  ? { ...open(), id }
  : { ...mcq(), id };
const blueprintFor = (questions) => examBlueprint(exam, validateExamQuestions(exam, questions));

const allRecognition = [q("a", "mcq"), q("b", "mcq"), q("c", "mcq"), q("d", "mcq")];
check("an all-recognition form of four items is refused",
  examFormIssues(blueprintFor(allRecognition)).some((issue) => /entirely recognition/.test(issue)),
  examFormIssues(blueprintFor(allRecognition))[0] || "accepted");

const shortForm = [q("a", "mcq"), q("b", "mcq"), q("c", "mcq")];
check("a short three-item quiz may be all one format",
  examFormIssues(blueprintFor(shortForm)).length === 0, "no form issues below the threshold");

// mcq is 2 points, open is 3: four MCQ (8) plus one open (3) is 73% recognition.
const lopsided = [q("a", "mcq"), q("b", "mcq"), q("c", "mcq"), q("d", "mcq"), q("e", "open")];
check("a form dominated by multiple choice is refused",
  examFormIssues(blueprintFor(lopsided)).some((issue) => /% of the score/.test(issue)),
  examFormIssues(blueprintFor(lopsided))[0] || "accepted");

const balanced = [q("a", "mcq"), q("b", "mcq"), q("c", "open"), q("d", "open")];
check("a balanced form passes", examFormIssues(blueprintFor(balanced)).length === 0, "no form issues");

const blueprint = blueprintFor(balanced);
check("the blueprint reports coverage",
  blueprint.questionCount === 4 && blueprint.sectionsScoped === 1 && blueprint.sectionsSampled === 1
    && blueprint.dimensions.length > 0,
  examBlueprintSummary(blueprint));

// -------------------------------------------------------- 3. scope parsing --
const scopes = [
  ["bare range", "1-3", 3],
  ["singular qualifier", "chapter 3", 1],
  ["plural qualifier with a range", "chapters 3-5", 3],
  ["plural qualifier, single", "chapters 2", 1],
  ["comma list", "1, 3, 5", 3],
  ["plural sections qualifier", "sections 1.1", 1],
];
for (const [name, input, expectedSections] of scopes) {
  let scope, err;
  try { scope = resolveScope(book, input, false); } catch (e) { err = e.message; }
  check(`scope resolves: ${name} (${JSON.stringify(input)})`,
    scope?.sectionIds.length === expectedSections,
    err || `${scope?.sectionIds.length ?? 0} section(s), expected ${expectedSections}`);
}

console.log(`\nScholar exam-contract summary: ${pass} passed, ${fail} failed.`);
process.exitCode = fail ? 1 : 0;
