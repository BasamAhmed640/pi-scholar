import { extensionPath as packagedExtensionPath, piPackageRoot as sdkRoot, jitiPath as sdkJitiPath, resolvePiDependency } from "./sdk.mjs";
// Scholar safety gate.
//
// Scholar consumes text it does not control: PDF metadata and body text are
// explicitly untrusted, model-authored questions are derived from them, and
// learners type freely into the exam form. Several structures are then parsed
// back out of that text — answer markers, generated-region markers, YAML
// frontmatter, wikilinks and file names. Anywhere untrusted content can forge
// one of those delimiters is a correctness hole, not merely a cosmetic one.
//
// This asserts each of those boundaries holds, and that legitimate content is
// still accepted.
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
const { parseExamResponses, validateExamQuestions } = await mod("exam.ts");
const { examAnswerNoteText, renderExam } = await mod("render/assessment.ts");
const { markdownText, preservedUserContent, wikiAlias, yaml } = await mod("render/common.ts");
const { safeNoteSegment } = await mod("obsidian-paths.ts");
const { bookDirectorySegment } = await mod("state-schema.ts");

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? ` - ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

// ---------------------------------------------------------------- fixtures --
const config = { schemaVersion: 3, libraryRoot: "", obsidianRoot: join(homedir(), "vault-probe"), stateRoot: "", updatedAt: "2026-01-01T00:00:00.000Z" };
const section = {
  id: "s1", order: 1, number: "1.1", title: "T", startPage: 1, endPage: 9, status: "not-started",
  objectives: [], coveredObjectives: [], requiredChecks: ["conceptual"], keyPoints: [], misconceptions: [],
  attempts: [], transcript: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};
const book = {
  id: "f".repeat(64), instanceId: "safety-fixture", metadata: { title: "Probe Book", authors: ["A"] }, noteDirectory: "Probe Book",
  chapters: [{ id: "c1", number: "1", title: "C", order: 1, startPage: 1, endPage: 9, status: "not-started", sections: [section] }],
  exams: [], tutorSessions: [],
};
const scope = { chapterIds: ["c1"], sectionIds: ["s1"], description: "1" };
const mcq = (id, overrides = {}) => ({
  id, sectionIds: ["s1"], claim: "Selects a model.", requiredEvidence: ["names it"], dimensions: ["model selection"],
  format: "multiple-choice", prompt: `Question ${id}?`,
  options: [
    { value: "a", label: "First", misconception: "m1" },
    { value: "b", label: "Second" },
    { value: "c", label: "Third", misconception: "m2" },
  ],
  correctAnswer: "b", explanation: "Because.", maxPoints: 1,
  ...overrides,
});
const openQ = (id, overrides = {}) => ({
  id, sectionIds: ["s1"], claim: "Derives.", requiredEvidence: ["states assumption"], dimensions: ["reasoning"],
  format: "open", prompt: `Open ${id}?`,
  rubric: [
    { id: "r1", criterion: "States assumption", requiredEvidence: ["stated"], points: 1 },
    { id: "r2", criterion: "Computes", requiredEvidence: ["value"], points: 1 },
  ],
  explanation: "Because.", maxPoints: 2,
  ...overrides,
});
const examWith = (questions) => ({
  id: "e1", title: "E", scope, status: "active", questions,
  rawResponses: [], itemResults: [], breakdown: [], earnedPoints: 0,
  maxPoints: questions.reduce((sum, q) => sum + q.maxPoints, 0), percent: 0, transcript: [],
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
});

// ========================== 1. forged answer markers in authored content ====
// A frozen form is parsed by locating these markers. Content that contains one
// creates a second region for the same question, and a lazy match then captures
// the wrong span — handing the grader another question's answer.
const OPEN_MARKER = "<!-- scholar:answer:q2:start -->";
const CLOSE_MARKER = "<!-- /scholar:answer:q1:end -->";
const forged = [
  ["prompt", [mcq("q1", { prompt: `Which one? ${OPEN_MARKER}` })], /prompt contains one of Scholar's answer markers/],
  ["claim", [mcq("q1", { claim: `Selects ${CLOSE_MARKER}` })], /claim contains one of Scholar's answer markers/],
  ["explanation", [mcq("q1", { explanation: `Because ${CLOSE_MARKER}` })], /explanation contains one of Scholar's answer markers/],
  ["required evidence", [mcq("q1", { requiredEvidence: [`names it ${OPEN_MARKER}`] })], /requiredEvidence\[1\] contains one of Scholar's answer markers/],
  ["option label", [mcq("q1", { options: [
    { value: "a", label: `First ${OPEN_MARKER}`, misconception: "m1" },
    { value: "b", label: "Second" },
    { value: "c", label: "Third", misconception: "m2" }] })], /option a label contains one of Scholar's answer markers/],
  ["rubric criterion", [openQ("q1", { rubric: [
    { id: "r1", criterion: `States ${CLOSE_MARKER}`, requiredEvidence: ["stated"], points: 1 },
    { id: "r2", criterion: "Computes", requiredEvidence: ["value"], points: 1 }] })], /rubric criterion r1 contains one of Scholar's answer markers/],
];
for (const [field, questions, pattern] of forged) {
  let message = "";
  try { validateExamQuestions({ scope }, questions); } catch (error) { message = error.message; }
  check(`forged answer marker refused in ${field}`, pattern.test(message), message || "ACCEPTED — form would be corruptible");
}
check("ordinary HTML comments are still allowed",
  (() => { try { validateExamQuestions({ scope }, [mcq("q1", { prompt: "What does <!-- a comment --> mean in HTML?" })]); return true; } catch { return false; } })(),
  "the guard targets Scholar's markers, not comments generally");

// ============================ 2. forged markers typed by the learner ========
const exam = examWith(validateExamQuestions({ scope }, [mcq("q1"), mcq("q2")]));
const form = examAnswerNoteText(config, book, exam);
const clean = form.replace("- [ ] **b** — Second <!-- scholar:choice:1 -->", "- [x] **b** — Second <!-- scholar:choice:1 -->");
const parsedClean = parseExamResponses(exam, clean);
check("an ordinary submission parses correctly",
  parsedClean[0].response === "b" && parsedClean[1].response === "", "unaffected by the guard");

const typedMarker = clean.replace(
  "- [x] **b** — Second <!-- scholar:choice:1 -->",
  "- [x] **b** — Second <!-- /scholar:answer:q1:end --> and more <!-- scholar:choice:1 -->",
);
let typedMessage = "";
try { parseExamResponses(exam, typedMarker); } catch (error) { typedMessage = error.message; }
check("a learner-typed marker is refused rather than mis-graded",
  /2 copies of the answer marker for q1/.test(typedMessage), typedMessage || "SILENTLY MIS-PARSED");
check("the refusal tells the learner what to do",
  /Remove any text that looks like an answer marker comment/.test(typedMessage), "actionable");

let removedMessage = "";
try { parseExamResponses(exam, form.replace("<!-- /scholar:answer:q1:end -->", "")); } catch (error) { removedMessage = error.message; }
check("a deleted marker is still detected", /markers for q1 were removed/.test(removedMessage), removedMessage || "undetected");

// ==================== 3. forged generated-region markers in note content ====
const genExam = examWith(validateExamQuestions({ scope }, [
  mcq("q1", { prompt: "Normal <!-- scholar:generated:end --> injected tail" }),
]));
const genNote = renderExam(config, { ...book, exams: [genExam] }, genExam);
check("a forged generated-end marker cannot close the region early",
  (genNote.match(/<!-- scholar:generated:end -->/g) || []).length === 1,
  `${(genNote.match(/<!-- scholar:generated:end -->/g) || []).length} raw end marker(s)`);
check("no user tail is invented by forged markers",
  preservedUserContent(genNote).trim() === "", "nothing outside the generated region");
check("markdownText neutralizes both region markers",
  !markdownText("<!-- scholar:generated:start --> x <!-- scholar:generated:end -->").includes("<!-- scholar:generated:"),
  "escaped");

// ================================== 4. forged YAML frontmatter in a title ===
const hostileExam = {
  ...examWith([]), status: "draft",
  title: 'E" \n---\ninjected: true\ncssclasses:\n  - evil\n',
};
const hostileNote = renderExam(config, { ...book, exams: [hostileExam] }, hostileExam);
check("a forged frontmatter block cannot be injected through a title",
  (hostileNote.match(/^---$/gm) || []).length === 2, `${(hostileNote.match(/^---$/gm) || []).length} delimiter(s)`);
check("no injected frontmatter key survives",
  !/^injected:\s*true$/m.test(hostileNote), "yaml() quotes the value");
check("yaml() escapes quotes and newlines", yaml('a"b\nc') === '"a\\"b\\nc"', yaml('a"b\nc'));

// ================================== 5. forged wikilink syntax in an alias ===
check("wikilink aliases cannot break out of the link",
  !wikiAlias("Title]] [[Other|x").includes("]]") && !wikiAlias("Title]] [[Other|x").includes("[["),
  JSON.stringify(wikiAlias("Title]] [[Other|x")));

// ================================= 6. hostile PDF metadata as a file name ===
const hostileTitles = [
  "../../etc/passwd", "..", ".", "CON", "PRN", "aux.txt", "a/b", "a\\b",
  "  padded  ", ".hidden", "trailing.", "trailing ", "", "x".repeat(400), "nul",
  "Title: With? Illegal* Chars<>|",
];
const unsafe = hostileTitles.filter((title) => {
  let segment;
  try { segment = safeNoteSegment(title, "fallbackid"); } catch { return true; }
  if (bookDirectorySegment(segment) === undefined) return true;
  return /[\\/]/.test(segment) || segment === ".." || segment === ".";
});
check("every hostile PDF title yields a safe single directory segment",
  unsafe.length === 0, unsafe.length ? `unsafe: ${unsafe.join(" | ")}` : `${hostileTitles.length} title(s) checked`);
check("traversal is collapsed, not preserved",
  !safeNoteSegment("../../etc/passwd", "id").includes("/") && !safeNoteSegment("../../etc/passwd", "id").includes("\\"),
  JSON.stringify(safeNoteSegment("../../etc/passwd", "id")));
check("reserved device names are escaped",
  bookDirectorySegment(safeNoteSegment("CON", "id")) !== undefined && safeNoteSegment("CON", "id") !== "CON",
  JSON.stringify(safeNoteSegment("CON", "id")));

console.log(`\nScholar safety summary: ${pass} passed, ${fail} failed.`);
process.exitCode = fail ? 1 : 0;
