import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { extensionPath, jitiPath } from "./sdk.mjs";

const { createJiti } = await import(pathToFileURL(jitiPath).href);
const jiti = createJiti(import.meta.url, { moduleCache: false });
const root = dirname(extensionPath);
const diagram = await jiti.import(join(root, "diagram-presentation.ts"));
const lesson = await jiti.import(join(root, "lesson.ts"));
const quality = await jiti.import(join(root, "learn-quality.ts"));
const { handleNotes } = await jiti.import(join(root, "tool-actions/learning.ts"));
const { transcriptBlock, readTranscript } = await jiti.import(join(root, "note-records.ts"));
const now = "2026-09-23T00:00:00.000Z";
const sourceHash = "a".repeat(64);
const makeDiagram = (id = "feedback", mermaid = "flowchart TD\nInput[Input: change] --> Output[Observed result]") => ({
  id, title: "Feedback path", kind: "flowchart", mermaid,
  takeaway: "A change at the input propagates to the observed result.", sourcePages: [1],
});
const marker = "[[scholar-diagram:feedback]]";

const rendered = diagram.renderLessonDiagrams(`### Feedback\n\n${marker}`, [makeDiagram()], [1]);
assert.deepEqual(rendered.diagramIds, ["feedback"]);
assert.match(rendered.markdown, /^> \[!scholar-diagram\] Diagram · Feedback path$/m);
assert.match(rendered.markdown, /> ```mermaid\n> flowchart TD\n> Input\["Input: change"\] --> Output\[Observed result\]\n> ```/);
assert.match(rendered.markdown, /> \*\*Takeaway:\*\* A change at the input propagates/);
assert.match(rendered.markdown, /> \*Source: PDF page 1\.\*/);
assert.equal(diagram.renderLessonDiagrams("Plain prose", [], [1]).markdown, "Plain prose");
for (const [kind, mermaid] of [
  ["sequence", "sequenceDiagram\nClient->>Server: Request"],
  ["state", "stateDiagram-v2\nIdle --> Working"],
  ["class", "classDiagram\nclass Controller"],
  ["mindmap", "mindmap\n  root((Feedback))\n    Observe"],
  ["timeline", "timeline\n  First : Input\n  Second : Output"],
]) assert.ok(diagram.renderLessonDiagrams("[[scholar-diagram:kind]]", [{ ...makeDiagram("kind"), kind, mermaid }], [1]).markdown.includes(`> ${mermaid.split("\n")[0]}`));
console.log("[PASS] every declared diagram kind renders a native callout with Mermaid, takeaway, source and saved ID");

for (const [source, match] of [
  ["flowchart TD\nA[Unclosed --> B", /line 2.*unbalanced/i],
  ["flowchart TD\nA[\"Unclosed] --> B", /line 2.*quotes/i],
  ["flowchart TD\nclick A https://example.com", /line 2.*links/i],
  ["flowchart TD\n%%{init: {theme: 'dark'}}%%", /line 2.*directives/i],
  ["flowchart TD\nA[<script>alert(1)</script>] --> B", /line 2.*HTML/i],
  ["flowchart TD\nthis is not Mermaid", /line 2.*malformed/i],
  ["flowchart TD\nclassDef known fill:#4a4", /at least one node/i],
  ["sequenceDiagram\nA->>B: Not a flowchart", /line 1.*kind/i],
  [`flowchart TD\n${Array.from({ length: 41 }, (_, n) => `N${n}[Node ${n}]`).join("\n")}`, /40 nodes/i],
  [`flowchart TD\n${Array.from({ length: 80 }, (_, n) => `N${n}[Node]`).join("\n")}`, /line 81/i],
]) assert.throws(() => diagram.renderLessonDiagrams(marker, [makeDiagram("feedback", source)], [1]), match, source);
assert.throws(() => diagram.renderLessonDiagrams(marker, [{ ...makeDiagram("feedback", `classDiagram\n${Array.from({ length: 41 }, (_, n) => `class N${n}`).join("\n")}`), kind: "class" }], [1]), /40 nodes/i);
assert.ok(diagram.lintMermaid("flowchart TD\nclassDef known fill:#4a4,color:#fff\nA:::known --> B\nstyle B fill:#fff", "flowchart").includes("classDef known"));
for (const markdown of [`${marker}\n${marker}`, `See ${marker} here`, `> ${marker}`, `\`\`\`text\n${marker}\n\`\`\``, `<!--\n${marker}\n-->`]) {
  assert.throws(() => diagram.renderLessonDiagrams(markdown, [makeDiagram()], [1]), /diagram/i);
}
assert.throws(() => diagram.renderLessonDiagrams("> [!scholar-diagram] Diagram · forged", [], [1]), /do not author/i);
assert.throws(() => diagram.renderLessonDiagrams(marker, [makeDiagram()], [2]), /sourcePages/);
console.log("[PASS] unsafe or malformed Mermaid and missing, duplicate, hidden or out-of-scope markers fail before save");

function fixture() {
  const section = { id: "s1", number: "1.1", title: "Feedback", order: 1, startPage: 1, endPage: 1,
    objectives: ["Explain feedback"], coveredObjectives: [], requiredChecks: ["conceptual"], status: "learning",
    keyPoints: [], misconceptions: [], attempts: [], transcript: [], createdAt: now, updatedAt: now };
  const book = { id: sourceHash, source: { fingerprint: { sha256: sourceHash } },
    chapters: [{ id: "c1", sections: [section] }], tutorSessions: [] };
  return { section, book };
}
const input = (id = "unit", withDiagram = true) => ({ id, title: "Feedback", objectives: ["Explain feedback"],
  keyPoints: ["Feedback changes the result."], sourcePages: [1],
  markdown: `### Feedback\n\nA change at the input propagates to the observed result.${withDiagram ? `\n\n${marker}` : ""}`,
  ...(withDiagram ? { diagrams: [makeDiagram()] } : {}) });

let { section, book } = fixture();
lesson.saveLesson(section, book, input());
assert.deepEqual(section.transcript[0].lesson.diagramIds, ["feedback"]);
assert.deepEqual(lesson.lessonDiagramIssues(section), []);
assert.equal(lesson.isLessonReceipt(section.transcript[0].lesson), true);
assert.deepEqual(readTranscript(transcriptBlock(section.transcript))[0].lesson.diagramIds, ["feedback"], "visible-note round trips retain optional diagram receipts");
const old = section.transcript[0].markdown.match(/^> \[!scholar-diagram\][^\n]*(?:\n>[^\n]*)*/m)[0];
const expectedContentHash = section.transcript[0].lesson.contentHash;
lesson.patchLesson(section, book, { id: "unit", expectedContentHash,
  calloutEdits: [{ oldText: old, diagram: { ...makeDiagram(), takeaway: "The output follows the changed input." } }] });
assert.match(section.transcript[0].markdown, /The output follows the changed input/);
assert.deepEqual(section.transcript[0].lesson.diagramIds, ["feedback"]);
assert.throws(() => lesson.patchLesson(section, book, { id: "unit", expectedContentHash: section.transcript[0].lesson.contentHash,
  calloutEdits: [{ oldText: section.transcript[0].markdown.match(/^> \[!scholar-diagram\][^\n]*(?:\n>[^\n]*)*/m)[0], diagram: makeDiagram("other") }] }), /preserve the ID/);
const legacy = fixture();
lesson.saveLesson(legacy.section, legacy.book, input("legacy", false));
assert.equal(lesson.lessonDiagramIssues(legacy.section).length, 1);
console.log("[PASS] saved receipts bind diagram IDs and same-ID callout repairs; the new quota remains a separate commit precheck");

const coverageBase = { id: "system", kind: "system", description: "Feedback system", sourcePages: [1],
  objective: "Explain feedback", lessonId: "unit", evidence: "> A change at the *input* propagates to the observed result!!!", diagramId: "feedback" };
const context = { startPage: 1, endPage: 1, objectives: section.objectives,
  lessons: [{ id: section.transcript[0].id, markdown: section.transcript[0].markdown, diagramIds: section.transcript[0].lesson.diagramIds }] };
for (const kind of ["system", "workflow", "sequence"]) {
  assert.deepEqual(quality.sourceCoverageIssues([{ ...coverageBase, kind }], context, { delivered: true }), []);
  const { diagramId: _diagramId, ...withoutDiagram } = coverageBase;
  assert.match(quality.sourceCoverageIssues([{ ...withoutDiagram, kind }], context, { delivered: true }).join(" "), /diagram ID/);
}
assert.match(quality.sourceCoverageIssues([
  coverageBase,
  { ...coverageBase, id: "workflow", kind: "workflow" },
], context, { delivered: true }).join(" "), /own diagram/i);
assert.match(quality.sourceCoverageIssues([{ ...coverageBase, evidence: "A --> B" }], context, { delivered: true }).join(" "), /explanatory body/);
const { diagramId: _diagramId, ...withoutDiagram } = coverageBase;
assert.deepEqual(quality.updateCoverageEvidence([withoutDiagram], [{ id: "system", diagramId: "feedback" }])[0].diagramId, "feedback");
console.log("[PASS] system, workflow and sequence coverage needs a rendered diagram in the same unit and explanatory prose outside fenced code");

({ section, book } = fixture());
const mutate = async (_id, fn) => { const copy = structuredClone(book); const result = await fn(copy); Object.assign(book, copy); section = book.chapters[0].sections[0]; return { book, result }; };
const save = params => handleNotes(book, { mode: "learn", recordId: "s1" }, params, b => b.chapters[0].sections[0], mutate,
  (action, summary) => ({ content: [{ type: "text", text: summary }], details: { action, summary } }));
await save({ lessons: [input("first"), { ...input("second", false), markdown: "### Second step\n\nThe output feeds into the next reasoning step." }] });
assert.deepEqual(section.transcript.map(entry => entry.id), ["lesson-first", "lesson-second"]);
await assert.rejects(save({ lesson: input("third"), lessons: [input("fourth")] }), /either lesson or lessons/);
await assert.rejects(save({ lessons: Array.from({ length: 7 }, (_, n) => input(`unit-${n}`)) }), /1–6/);
await assert.rejects(save({ lessons: [input("third"), input("third")] }), /unique stable IDs/);
await assert.rejects(save({ lessons: [input("third"), { ...input("bad"), sourcePages: [2] }] }), /sourcePages/);
assert.equal(section.transcript.length, 2, "a failed batch cannot save its first unit");
console.log("[PASS] notes accepts up to six unique lesson units atomically and keeps the legacy single-unit form");
