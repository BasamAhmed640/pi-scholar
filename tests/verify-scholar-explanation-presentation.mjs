// Composed reading layout and mode policy checks. These exercise rendering,
// not the scientific quality of a model-generated explanation.
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { marked } from "marked";
import { extensionPath, piPackageRoot, jitiPath } from "./sdk.mjs";

const { createJiti } = await import(pathToFileURL(jitiPath));
const jiti = createJiti(import.meta.url, { moduleCache: false,
  alias: { "@earendil-works/pi-coding-agent": join(piPackageRoot, "dist/index.js") } });
const mod = file => jiti.import(join(dirname(extensionPath), file));
const { renderSection, supplementalSourceFigureLines } = await mod("render/section.ts");
const { renderTutorSession } = await mod("render/assessment.ts");
const { wikiEmbed } = await mod("render/common.ts");
const { sectionNotePath, tutorNotePath, snapshotAssetPath } = await mod("obsidian-paths.ts");
const { learnInstructions, tutorInstructions, examInstructions } = await mod("policies.ts");
const { resolveLessonFigures } = await mod("lesson-figures.ts");
const now = "2026-09-12T12:00:00.000Z";
const config = { schemaVersion: 3, obsidianRoot: join(process.cwd(), "fixture-vault"), libraryRoot: join(process.cwd(), "fixture-library"), stateRoot: join(process.cwd(), "fixture-state"), updatedAt: now };
const snapshots = Array.from({ length: 16 }, (_, i) => ({ id: `figure-${i + 1}`, page: i + 1,
  assetFile: `p${String(i + 1).padStart(4, "0")}-snapshot-${String(i + 1).padStart(16, "a")}.png`,
  sha256: String(i + 1).padStart(64, "a"), caption: `Figure ${i + 1}. Illustrative source geometry.`,
  crop: { x: 0, y: 0, width: 640, height: 320, canvasWidth: 1000, canvasHeight: 1400 }, createdAt: now }));
const section = { id: "s1", number: "1.1", order: 1, title: "Vector algebra", startPage: 1, endPage: 16, status: "learning",
  synthesis: "Vector operations describe magnitude, direction, and relationships between directed quantities.",
  objectives: [], coveredObjectives: [], requiredChecks: [], keyPoints: [], misconceptions: [], attempts: [], transcript: [], snapshots, createdAt: now, updatedAt: now };
const chapter = { id: "c1", number: "1", order: 1, title: "Vectors", startPage: 1, endPage: 16, status: "learning", sections: [section] };
const book = { schemaVersion: 3, revision: 0, id: "c".repeat(64), instanceId: "explanation-fixture",
  source: { fileName: "Vector fixture.pdf" }, metadata: { title: "Illustrative vector material", pageCount: 16, authors: [] },
  noteDirectory: "Vector fixture", chapters: [chapter], exams: [], tutorSessions: [], currentSectionId: "s1", createdAt: now, updatedAt: now };
const tutor = { id: "t1", title: "Cross product order", scope: { sectionIds: ["s1"], chapterIds: ["c1"], description: "Vector operations" },
  status: "active", synthesis: section.synthesis, keyPoints: [], attempts: [], transcript: [], snapshots, createdAt: now, updatedAt: now };
const path = sectionNotePath(config, book, chapter, section);
const asset = snapshotAssetPath(config, book, snapshots[0]);
const embed = wikiEmbed(path, asset, 640);
const blocks = [
  "### What the operation tells you\n\nTwo arrows can describe directions in a shared flat surface, such as a sheet of paper. The cross product gives another arrow pointing straight out of that surface. This perpendicular direction is called the normal direction.",
  `> [!example] Figure · PDF page 1\n>\n> ${embed}\n>\n> *Illustrative fixture, PDF page 1.*\n\nFollow the input arrows together. The output points perpendicular to both; reversing their order reverses the output arrow.`,
  "> [!note] Key equation · Reversing the order\n>\n> $$\n> \\mathbf B\\times\\mathbf A = -(\\mathbf A\\times\\mathbf B)\n> $$\n>\n> **Symbols:** $\\mathbf A$ → first input vector; $\\mathbf B$ → second input vector.\n>\n> The minus sign reverses direction without changing magnitude. This order-reversal property is called anti-commutativity.\n>\n> *Illustrative fixture, PDF page 1.*",
  "### Apply the idea\n\nSuppose the original cross product points upward. Swapping the input order makes it point downward with the same magnitude. We reverse the whole result, rather than negating both inputs.",
  "> [!example] Explanatory schematic · Following the change\n>\n> ```mermaid\n> flowchart LR\n> A[Swap input order] --> B[Reverse output direction]\n> ```\n>\n> The arrow describes the consequence of one operation. It does not describe a physical cause.\n> *Illustrative fixture, PDF page 1.*",
];
section.transcript = blocks.map((markdown, i) => ({ id: `unit-${i}`, kind: "assistant", markdown, createdAt: now }));
const note = renderSection(config, book, chapter, section);
const topLevel = marked.lexer(note);
const callouts = topLevel.filter(token => token.type === "blockquote");
const reference = callouts.find(token => token.text.startsWith("[!note]- Source references"));
assert.ok(reference, "unused captures remain inspectable in one collapsed reference area");
assert.equal(callouts.filter(token => token.text.startsWith("[!example] Figure")).length, 1,
  "only the figure authored into the explanation is expanded");
assert.equal((reference.text.match(/\[!example\] Figure/g) || []).length, 15);
assert.equal(note.split(snapshots[0].assetFile).length - 1, 1, "placed figure has no duplicate full-size reference");
for (const snapshot of snapshots.slice(1)) assert.ok(reference.text.includes(snapshot.assetFile));
for (const block of blocks) assert.ok(note.includes(block), "composed instructional content is preserved verbatim");
assert.ok(note.indexOf("The minus sign") < note.indexOf("### Apply the idea"));
assert.ok(callouts.some(token => token.text.startsWith("[!note] Key equation") && token.text.includes("$$")));
assert.ok(callouts.some(token => token.text.startsWith("[!example] Explanatory schematic") && token.text.includes("```mermaid")));
assert.ok(topLevel.some(token => token.type === "paragraph" && token.text.startsWith("Follow the input arrows")), "figure interpretation stays readable outside metadata");
console.log("[PASS] a composed lesson preserves prose, equation, purposeful figure and Mermaid; sixteen captures do not become a wall");

const tutorPath = tutorNotePath(config, book, tutor);
tutor.transcript = section.transcript.map(entry => ({ ...entry, markdown: entry.markdown.replace(embed, wikiEmbed(tutorPath, asset, 640)) }));
const tutorNote = renderTutorSession(config, book, tutor);
assert.equal(tutorNote.split(snapshots[0].assetFile).length - 1, 1);
for (const result of [renderSection(config, book, chapter, { ...section, transcript: [] }), renderTutorSession(config, book, { ...tutor, transcript: [] })]) {
  assert.doesNotMatch(result, /^## Lesson$/m);
  assert.match(result, /full explanation has not been saved yet/);
  assert.ok(result.includes(section.synthesis));
  assert.ok(result.indexOf("[!note]- Recap") < result.indexOf(section.synthesis));
}
console.log("[PASS] Learn and Tutor label a summary honestly without claiming a lesson was delivered");

for (const visible of [embed, embed.replace("|640", "|320"), `> ${embed}`, `![[${snapshots[0].assetFile}]]`]) {
  assert.equal(supplementalSourceFigureLines(config, book, path, [snapshots[0]], visible).length, 0);
}
for (const merelyMentioned of [snapshots[0].assetFile, `\`${embed}\``, `\`\`\`markdown\n${embed}\n\`\`\``, `> \`\`\`markdown\n> ${embed}\n> \`\`\``]) {
  assert.ok(supplementalSourceFigureLines(config, book, path, [snapshots[0]], merelyMentioned).length,
    "prose or code mentioning an embed must not hide its only source reference");
}
console.log("[PASS] embed deduplication ignores widths and callout framing while preserving references mentioned only in code or prose");

const token = "[[scholar-figure:figure-1]]";
const placed = resolveLessonFigures(`Meaning before the figure.\n\n${token}\n\nNow interpret its labels.`, section, book, [1], config);
assert.doesNotMatch(placed, /scholar-figure:/);
assert.ok(placed.includes(snapshots[0].caption));
assert.equal(marked.lexer(placed).filter(token => token.type === "blockquote" && token.text.startsWith("[!example] Figure")).length, 1);
const framed = resolveLessonFigures(`> [!example] Original source figure\n>\n> ${token}\n>\n> Explain the labels together.`, section, book, [1], config);
assert.equal((framed.match(/\[!example\]/g) || []).length, 1, "an existing figure callout is not wrapped again");
assert.ok(framed.split("\n").every(line => line.startsWith(">")), "every expanded line retains the surrounding callout prefix");
const nested = resolveLessonFigures(`> [!note] Worked reasoning\n>\n> ${token}`, section, book, [1], config);
assert.match(nested, /^> > \[!example\] Figure/m);
assert.match(nested, /^> > !\[\[/m);
for (const invalid of [`Inline ${token}`, `${token}\n\n${token}`, `\`\`\`markdown\n${token}\n\`\`\``, "[[scholar-figure:missing]]", "[[scholar-figure:figure-1]"]) {
  assert.throws(() => resolveLessonFigures(invalid, section, book, [1], config));
}
assert.throws(() => resolveLessonFigures(token, section, book, [2], config), /sourcePages/);
assert.throws(() => resolveLessonFigures(token, section, book, [1]), /vault configuration/);
console.log("[PASS] figure placement resolves to native callouts, preserves existing quote frames, and rejects broken or out-of-scope references");

const objectiveA = "Interpret cross product order", objectiveB = "Calculate cross product components";
const planned = { ...section, objectives: [objectiveA, objectiveB], coveredObjectives: [objectiveA, objectiveB],
  objectiveChecks: [{ objective: objectiveA, checks: ["conceptual"] }, { objective: objectiveB, checks: ["conceptual", "computation"] }],
  attempts: [{ id: "mastery-a", kind: "conceptual", format: "open", outcome: "pass", question: "What changes when the input order swaps?", createdAt: now,
    grounding: { purpose: "mastery", competency: objectiveA, requiredEvidence: ["The direction reverses"], sourcePages: [1], basis: [{ kind: "objective", value: objectiveA, supports: [1] }] } }] };
const plannedNote = renderSection(config, book, chapter, planned);
assert.match(plannedNote, /\| Interpret cross product order \| Conceptual \| Demonstrated \|/);
assert.match(plannedNote, /\| Calculate cross product components \| Conceptual \| Not yet demonstrated \|/);
assert.match(plannedNote, /\| Calculate cross product components \| Computation \| Not yet demonstrated \|/);
console.log("[PASS] the progress table cannot present one objective's conceptual pass as another objective's mastery");

const longObjectives = Array.from({ length: 6 }, (_, i) => `Objective ${i + 1}: explain the entire relationship between input orientation, magnitude, coordinate conventions, assumptions, intermediate calculations, interpretation, and the limits of each operation in detail.`);
const longPlan = { ...section, objectives: longObjectives, coveredObjectives: [],
  objectiveChecks: longObjectives.map(objective => ({ objective, checks: ["conceptual", "computation"] })), attempts: [] };
const longNote = renderSection(config, book, chapter, longPlan);
const preLesson = longNote.slice(0, longNote.indexOf("## Lesson"));
assert.match(preLesson, /Lesson in progress · 12 understanding checks remaining/);
assert.doesNotMatch(preLesson, /Objective \d+:|evidence for:|Remaining to complete/);
const progressLine = preLesson.split("\n").find(line => line.startsWith("**Progress:**"));
assert.ok(progressLine.length < 150, "progress above the lesson stays short regardless of objective length");
const learningRecord = marked.lexer(longNote).find(token => token.type === "blockquote" && token.text.startsWith("[!note]- Learning record"));
assert.ok(learningRecord);
for (const objective of longObjectives) assert.ok(learningRecord.text.includes(objective));
assert.match(learningRecord.text, /### Remaining work/);
assert.match(learningRecord.text, /source-page and figure review|complete saved instructional lesson/);
console.log("[PASS] long objective/check plans stay in the collapsed learning record instead of forming a wall above the lesson");

const learnPolicy = learnInstructions(book, section), tutorPolicy = tutorInstructions(book, tutor);
const examPolicy = examInstructions(book, { id: "e1", status: "draft", scope: tutor.scope });
for (const policy of [learnPolicy, tutorPolicy]) {
  assert.match(policy, /concrete meaning before relying on its technical term/);
  assert.match(policy, /Distinguish a definition from a derived result/);
  assert.match(policy, /one focused editorial review/);
  assert.match(policy, /Independent Learn reviewers then inspect the saved draft/);
  assert.match(policy, /symbol → definition/);
  assert.match(policy, /\[\[scholar-figure:ID\]\]/);
  assert.match(policy, /Refer to an inspected source figure when it makes the explanation easier to understand/);
  assert.match(policy, /Refer back to the same figure for later reasoning/);
}
assert.match(learnPolicy, /before its confirmation questions/);
assert.match(learnPolicy, /notes\.lessonComplete=true/);
assert.match(learnPolicy, /Diagnostic and practice results cannot satisfy missing mastery checks/);
assert.match(tutorPolicy, /Remain interactive/);
assert.match(tutorPolicy, /does not require a complete section lesson/);
assert.doesNotMatch(examPolicy, /Explanation quality|reading-first|lessonComplete|Native Obsidian presentation/);
console.log("[PASS] Learn finishes the explanation before confirmation; Tutor stays interactive and Exam stays isolated");
