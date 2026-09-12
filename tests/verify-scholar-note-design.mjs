import { extensionPath as packagedExtensionPath, piPackageRoot as sdkRoot, jitiPath as sdkJitiPath, resolvePiDependency } from "./sdk.mjs";
// In-memory presentation contracts. Only SCHOLAR_DESIGN_PREVIEW opts into writing
// generated review samples; no configured vault is loaded or modified.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

const piRoot = sdkRoot;
const { createJiti } = await import(pathToFileURL(sdkJitiPath).href);
import { marked } from "marked";
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: { "@earendil-works/pi-coding-agent": join(piRoot, "dist", "index.js") },
});
const extension = dirname(process.env.PI_SCHOLAR_EXTENSION || packagedExtensionPath);
const { assessmentQuestionBlock, renderSection } = await jiti.import(join(extension, "render", "section.ts"));
const { renderBook, renderChapter, renderScholarHome } = await jiti.import(join(extension, "render", "navigation.ts"));
const { examAnswerNoteText, renderExam, renderExamAnswerKey, renderTutorSession } = await jiti.import(join(extension, "render", "assessment.ts"));
const facade = await jiti.import(join(extension, "obsidian.ts"));
const timestamp = "2026-09-04T12:00:00.000Z";
const fixtureRoot = join(process.cwd(), "work", "scholar-note-design-fixture");
const config = { schemaVersion: 3, libraryRoot: join(fixtureRoot, "library"), obsidianRoot: join(fixtureRoot, "vault"), stateRoot: join(fixtureRoot, "state"), updatedAt: timestamp, currentBookId: "a".repeat(64) };
const privateResponse = "PRIVATE_RESPONSE_DO_NOT_PROJECT";
const synthesis = "A transmission line becomes necessary when propagation time is significant compared with the signal's rise time. Compare the edge's spatial extent with the interconnect, then choose a model whose assumptions hold.";
const longExplanation = "A ruler gives physical length, but the signal experiences electrical length. In a low-loss dielectric, the wave travels at a finite speed, so the far end cannot respond instantly.\n\nFor a fast edge, the driver initially sees the characteristic impedance, not the eventual load.\n\n$$Z_0 = \\sqrt{\\frac{L}{C}}$$\n\nThis relation assumes negligible resistance and leakage at the frequencies of interest. If those conditions fail, the frequency-dependent form is required; the equation alone is not sufficient evidence that the lossless model applies.";
const attempt = (id, kind, outcome, question, feedback) => ({ id, kind, outcome, question, feedback, correctAnswer: outcome === "pending" ? "PENDING_ANSWER_MUST_STAY_PRIVATE" : "1. Use propagation delay relative to rise time", options: ["Use propagation delay relative to rise time", "Use physical length alone"], answerSummary: privateResponse, createdAt: timestamp });
const section = {
  id: "s1", order: 1, number: "1.1", title: "Electrical length | rise time and the limits of the lumped approximation", startPage: 4, endPage: 12, status: "learning",
  objectives: ["Choose a model using propagation delay | rise time, including very long explanatory labels that must wrap in a narrow note", "State the lossless assumptions before using the characteristic impedance equation"],
  coveredObjectives: ["Choose a model using propagation delay | rise time, including very long explanatory labels that must wrap in a narrow note"], requiredChecks: ["conceptual"], synthesis,
  keyPoints: ["Electrical length depends on both the interconnect and the edge.", "The lossless impedance relation is $Z_0=\\sqrt{L/C}$; state its assumptions."],
  misconceptions: ["A physically short trace can still be electrically long for a sufficiently fast edge."],
  attempts: [attempt("a1", "conceptual", "review", "Why can a short trace require a transmission-line model?", "Compare propagation delay with rise time. Physical length alone omits the signal timescale."), attempt("a2", "conceptual", "pass", "Which comparison determines electrical length?", "Correct: the comparison is between propagation time and rise time."), attempt("a3", "conceptual", "pending", "How would halving the rise time change your model choice for the same trace?")],
  transcript: [{ id: "t1", kind: "assistant", markdown: synthesis, createdAt: timestamp }, { id: "t2", kind: "assistant", markdown: longExplanation, createdAt: timestamp }, { id: "t3", kind: "assistant", markdown: "Consider a 50 ps edge on a six-inch trace. The trace length exceeds the spatial extent of the transition, so different locations cannot be assumed to share one instantaneous voltage.", createdAt: timestamp }, { id: "t4", kind: "assistant", markdown: "How would halving the rise time change your model choice for the same trace?", createdAt: timestamp }],
  snapshots: [{ id: "figure1", page: 7, crop: { x: 0, y: 0, width: 600, height: 300, canvasWidth: 1000, canvasHeight: 1400 }, assetFile: "p0007-snapshot-bbbbbbbbbbbbbbbb.png", sha256: "b".repeat(64), caption: "The advancing edge occupies only part of an electrically long interconnect.", createdAt: timestamp }],
  createdAt: timestamp, updatedAt: timestamp,
};
const unstarted = { ...structuredClone(section), id: "s2", number: "1.2", title: "Reflections at an impedance boundary", order: 2, startPage: 13, endPage: 18, status: "not-started", objectives: [], coveredObjectives: [], requiredChecks: [], synthesis: undefined, keyPoints: [], misconceptions: [], attempts: [], transcript: [], snapshots: [] };
const chapter = { id: "c1", number: "1", order: 1, title: "Signals, models | and physical reasoning", startPage: 1, endPage: 18, status: "learning", sections: [section, unstarted] };
const book = {
  schemaVersion: 3, revision: 1, id: config.currentBookId, instanceId: "design-fixture", source: { absolutePath: join(config.libraryRoot, "Signal Integrity.pdf"), relativePath: "Signal Integrity.pdf", fileName: "Signal Integrity.pdf", format: "pdf", fingerprint: { sha256: config.currentBookId, size: 1, mtimeMs: 1 } },
  metadata: { title: "Signal Integrity — From Models to Decisions", authors: ["A. Example"], edition: "Second edition", pageCount: 240 }, outlineStatus: "ready", noteDirectory: "Signal Integrity", chapters: [chapter], currentSectionId: "s1", exams: [], tutorSessions: [], createdAt: timestamp, updatedAt: timestamp,
};
const questions = [
  { id: "q1", sectionIds: ["s1"], claim: "Chooses the model from timescales.", requiredEvidence: ["compares edge and flight time"], dimensions: ["Model selection"], format: "multiple-choice", prompt: "Which model applies to a 50 ps edge on a six-inch trace?", options: [{ value: "a", label: "Lumped circuit" }, { value: "b", label: "Transmission line" }, { value: "c", label: "Static conductor" }], correctAnswer: "b", explanation: "The edge is short compared with the flight time, so the trace is electrically long.", maxPoints: 2 },
  { id: "q2", sectionIds: ["s1"], claim: "States the assumptions behind impedance.", requiredEvidence: ["negligible loss", "derivation"], dimensions: ["Assumptions", "Reasoning"], format: "open", prompt: "Derive the characteristic impedance and state when the lossless expression is valid.", rubric: [{ id: "r1", criterion: "States negligible resistance and leakage", requiredEvidence: ["lossless assumption"], points: 2 }, { id: "r2", criterion: "Derives the impedance", requiredEvidence: ["relation"], points: 3 }], explanation: "For a lossless line, $Z_0=\\sqrt{L/C}$. The assumption must hold at the frequencies that matter to the edge.", maxPoints: 5 },
];
const exam = { id: "e1", title: "Model selection and assumptions", scope: { chapterIds: ["c1"], sectionIds: ["s1"], description: "Electrical length and characteristic impedance" }, status: "graded", questions, rawResponses: [{ questionId: "q1", response: privateResponse }], itemResults: [{ questionId: "q1", outcome: "correct", earnedPoints: 2, maxPoints: 2, feedback: "The comparison uses the relevant timescales." }, { questionId: "q2", outcome: "partial", earnedPoints: 1, maxPoints: 5, feedback: "The lossless condition was not established.", firstDecisiveError: "Used the simplified expression without checking losses.", correctReasoning: "Check resistance and leakage before simplifying the frequency-dependent relation.", transferableLesson: "Attach a validity condition to every simplified model." }], breakdown: [{ key: "dimension:reasoning", label: "Reasoning | assumptions", earnedPoints: 0.07142857142857142, maxPoints: 0.14285714285714285, percent: 50 }], earnedPoints: 3, maxPoints: 7, percent: 42.857142857142854, transcript: [{ id: "secret", kind: "assistant", markdown: "GENERATION_TRANSCRIPT_PRIVATE_KEY", createdAt: timestamp }], createdAt: timestamp, startedAt: timestamp, submittedAt: timestamp, gradedAt: timestamp, updatedAt: timestamp };
const tutor = { id: "tu1", title: "When a short trace is electrically long", scope: exam.scope, status: "active", synthesis, keyPoints: section.keyPoints, attempts: section.attempts, transcript: section.transcript, createdAt: timestamp, updatedAt: timestamp };
book.exams = [exam]; book.tutorSessions = [tutor];
const before = JSON.stringify(book);
const activeExam = { ...exam, status: "active", gradedAt: undefined, submittedAt: undefined };
const submittedExam = { ...activeExam, status: "submitted", submittedAt: timestamp };
const answerPaper = examAnswerNoteText(config, book, activeExam);
const samples = {
  "scholar-home": renderScholarHome(config, [book]), "book": renderBook(config, book), "chapter": renderChapter(config, book, chapter),
  "section": renderSection(config, book, chapter, section), "fresh-section": renderSection(config, book, chapter, unstarted),
  "tutor": renderTutorSession(config, book, tutor), "exam-active": renderExam(config, book, activeExam), "exam-submitted": renderExam(config, book, submittedExam),
  "exam-graded": renderExam(config, book, exam), "answer-key": renderExamAnswerKey(config, book, exam),
};
let passed = 0, failed = 0;
function check(name, run) { try { run(); passed++; console.log(`[PASS] ${name}`); } catch (error) { failed++; console.error(`[FAIL] ${name}: ${error.message}`); } }
check("the public projection facade contains callable renderers and no undefined runtime exports", () => {
  assert.ok(Object.keys(facade).length > 30, "the facade must expose its public formatting and projection API");
  for (const [name, value] of Object.entries(facade)) assert.notEqual(value, undefined, `${name} resolves to undefined`);
  for (const name of ["renderScholarHome", "renderBook", "renderChapter", "renderSection", "renderTutorSession", "renderExam", "renderExamAnswerKey", "renderScholarWorkspace", "gradedQuestionLines", "examQuestionLines", "scopeLines", "collapsedRecord"]) assert.equal(typeof facade[name], "function", name);
});
check("all notes have scoped classes, no duplicate H1, no placeholder sections or Unicode progress bars", () => {
  for (const [name, note] of Object.entries(samples)) {
    assert.ok(note.includes("  - scholar-note"), name);
    assert.doesNotMatch(note, /^# |█|░|_None recorded yet|No assistant transcript|No tutor synthesis|No answers or feedback/m, name);
    assert.equal((note.match(/<!-- scholar:generated:start -->/g) || []).length, 1, name);
    assert.equal((note.match(/<!-- scholar:generated:end -->/g) || []).length, 1, name);
    assert.doesNotMatch(note, /PRIVATE_RESPONSE_DO_NOT_PROJECT|GENERATION_TRANSCRIPT_PRIVATE_KEY|PENDING_ANSWER_MUST_STAY_PRIVATE/, name);
  }
});
check("Learn puts the full visible lesson first, optional source references next, and paired questions last", () => {
  const note = samples.section;
  const order = ["## Lesson", synthesis, longExplanation, "> [!note]- Source references", "> [!note]- Recap and pitfalls", "> ### Key points", "> ### Common pitfalls", "> [!note]- Learning record", "> ### Learning objectives", "> ### Understanding checks", "## Questions", "### Question 1", section.attempts[0].question, "**Correct answer:** 1.", section.attempts[0].feedback, "### Question 2", section.attempts[1].question, section.attempts[1].feedback, "### Question 3", section.attempts[2].question, "*Awaiting response*"];
  const positions = order.map((text) => note.indexOf(text));
  assert.ok(positions.every((value, index) => value >= 0 && (index === 0 || value > positions[index - 1])), JSON.stringify(positions));
  assert.equal(note.split(synthesis).length - 1, 1);
  for (const paragraph of longExplanation.split("\n\n")) assert.ok(note.includes(paragraph));
  assert.ok(note.includes("different locations cannot be assumed"));
  assert.ok(note.includes("> [!warning] Needs review") && note.includes("> [!success] Correct"));
  assert.equal(note.split("How would halving the rise time change").length - 1, 1);
  assert.ok(note.includes("| Choose a model using propagation delay \\| rise time"));
  assert.ok(note.includes("p0007-snapshot-bbbbbbbbbbbbbbbb.png|640]]") && note.includes("PDF viewer page 7"));
  assert.ok(note.includes("| Taught |") && note.includes("| Not yet taught |") && note.includes("| Not yet demonstrated |"));
  const resolved = renderSection(config, book, chapter, { ...section, attempts: [{
    ...section.attempts[1], format: "open", options: undefined, correctAnswer: undefined,
    grounding: { purpose: "mastery", competency: "Choose the model using relevant timescales.", requiredEvidence: ["Compare propagation delay with rise time."], sourcePages: [7], basis: [{ kind: "objective", value: section.objectives[0], supports: [1] }] },
  }] });
  assert.ok(resolved.includes("| Demonstrated |"));
  assert.doesNotMatch(note, /What you established|Established|Teaching record|Assessment record|\[!question\]-/);
  assert.doesNotMatch(note.slice(note.indexOf("## Questions")), /^> \[!\w+\][-+]|\*\*Result:\*\*/m, "feedback is open and the outcome is not repeated");
});
check("empty sections have a single fresh-note message and no empty headings or records", () => {
  assert.doesNotMatch(samples["fresh-section"], /^## |\[!\w+\]-/m);
  assert.equal(samples["fresh-section"].split("This section is ready.").length - 1, 1);
});
check("Markdown keeps the lesson and question-answer pairs outside collapsed administrative records", () => {
  const callouts = (note) => marked.lexer(note).filter((token) => token.type === "blockquote" && /^\[!\w+\]/.test(token.text) && !/^\[!info\]- Scholar entry details/.test(token.text));
  for (const hasTeaching of [false, true]) for (const hasHistory of [false, true]) for (const hasPending of [false, true]) {
    const attempts = [...(hasHistory ? section.attempts.slice(0, 2) : []), ...(hasPending ? [section.attempts[2]] : [])];
    const transcript = hasTeaching ? [section.transcript[1]] : [];
    for (const [kind, note] of [
      ["Learn", renderSection(config, book, chapter, { ...section, attempts, transcript, snapshots: [] })],
      ["Tutor", renderTutorSession(config, book, { ...tutor, attempts, transcript })],
    ]) {
      const parsed = callouts(note).filter(token => !token.text.startsWith("[!note]- Source references"));
      const label = `${kind}: teaching=${hasTeaching}, history=${hasHistory}, pending=${hasPending}`;
      assert.equal(parsed.length, 2 + (hasHistory ? 2 : 0), label);
      for (const token of parsed) assert.equal((token.text.match(/^\[!\w+\]/gm) || []).length, 1, `${label}: merged callout headers`);
      assert.equal(parsed[0].text.startsWith(kind === "Learn" ? "[!note]- Recap and pitfalls" : "[!note]- Recap"), true, label);
      assert.equal(parsed[1].text.startsWith(kind === "Learn" ? "[!note]- Learning record" : "[!note]- Practice scope"), true, label);
      for (const token of parsed.slice(0, 2)) assert.doesNotMatch(token.text, /A ruler gives|Which comparison|How would halving|Correct answer|Explanation:/, label);
      for (const token of parsed.slice(2)) {
        assert.match(token.text, /^\[!(?:success|warning)\] /, label);
        assert.ok(token.text.includes("**Correct answer:**") && token.text.includes("**Explanation:**"), label);
        assert.doesNotMatch(token.text, /### Question|A ruler gives/, "question and teaching stay outside the feedback callout");
      }
      assert.equal(note.includes("*Awaiting response*"), hasPending, label);
      assert.equal(note.includes("> [!success] Correct"), hasHistory, label);
      assert.equal(note.includes("A ruler gives"), hasTeaching, label);
      if (hasHistory || hasPending) assert.ok(note.indexOf("## Questions") > note.indexOf("[!note]-"), label);
    }
  }
  // Supplemental figures remain available together without an expanded gallery.
  const figuresOnly = { ...section, synthesis: undefined, keyPoints: [], misconceptions: [], objectives: [], requiredChecks: [], attempts: section.attempts.slice(0, 2), transcript: [section.transcript[1]], snapshots: [section.snapshots[0], { ...section.snapshots[0], id: "figure2", page: 8, assetFile: "p0008-snapshot-cccccccccccccccc.png" }] };
  const figuresNote = renderSection(config, book, chapter, figuresOnly);
  assert.equal(callouts(figuresNote).length, 4);
  assert.ok(callouts(figuresNote)[0].text.startsWith("[!note]- Source references"));
  assert.ok(callouts(figuresNote)[1].text.startsWith("[!note]- Learning record"));
  assert.ok(callouts(figuresNote).slice(2).every((token) => /^\[!(?:warning|success)\] /.test(token.text)));
  assert.equal((figuresNote.match(/^> > !\[\[.*\|640\]\]$/gm) || []).length, 2);
  assert.ok(figuresNote.indexOf("[!note]- Source references") < figuresNote.indexOf("## Questions"));
});
check("navigation tables identify the current section and never link an unstarted sibling", () => {
  assert.ok(samples.chapter.includes("| **Current · In progress** | [["));
  const sibling = samples.chapter.split("\n").find((line) => line.includes("1.2 Reflections"));
  assert.ok(sibling && !sibling.includes("[[") && sibling.includes("Not started"));
  assert.ok(samples.book.includes("| Status | Chapter | Source | Completed sections |"));
  assert.ok(samples.book.includes("\\|Chapter 1: Signals, models and physical reasoning]]"));
});
check("Tutor keeps assisted practice distinct and preserves teaching and active question", () => {
  assert.ok(samples.tutor.includes("*Tutor · In progress · Assisted practice*") && samples.tutor.includes("does not change Exam scores or Learn completion"));
  const order = ["## Lesson", longExplanation, "> [!note]- Source references", "> [!note]- Recap", "> ### Key points", "> [!note]- Practice scope", "## Questions", "### Question 1", section.attempts[0].feedback, "### Question 2", section.attempts[1].feedback, "### Question 3", "*Awaiting response*"];
  assert.ok(order.every((text, index) => samples.tutor.includes(text) && (index === 0 || samples.tutor.indexOf(text) > samples.tutor.indexOf(order[index - 1]))));
  assert.ok(samples.tutor.includes("p0007-snapshot-bbbbbbbbbbbbbbbb.png|640]]"));
  assert.doesNotMatch(samples.tutor, /Teaching record|Practice record|## The model|\[!question\]-/);
  assert.ok(samples.tutor.includes("frequency-dependent form is required"));
});
check("Tutor and Learn render identical question blocks for both formats and every assessment outcome", () => {
  const outcomes = ["pending", "pass", "review", "unsure", "cancelled", "unavailable"];
  const badges = { pass: "success] Correct", review: "warning] Needs review", unsure: "warning] Knowledge gap identified", unavailable: "failure] Unavailable" };
  const fixtures = ["multiple-choice", "open"].flatMap((format) => outcomes.map((outcome) => ({
    ...attempt(`${format}-${outcome}`, format === "open" ? "application" : "conceptual", outcome,
      `${format} ${outcome}: Which timescale determines the model?`,
      outcome === "pending" ? "PENDING_FEEDBACK_MUST_STAY_PRIVATE" : `Reasoning for ${format} ${outcome}.\n\nCheck the assumptions.`),
    format,
    options: format === "multiple-choice" ? ["Compare propagation delay with rise time", "Use physical length alone"] : undefined,
    correctAnswer: format === "open" ? undefined : outcome === "cancelled" ? "CANCELLED_KEY_MUST_STAY_PRIVATE"
      : outcome === "pending" ? "PENDING_ANSWER_MUST_STAY_PRIVATE" : "1. Compare propagation delay with rise time",
    grounding: { purpose: "practice", competency: "Choose the model using relevant timescales.", requiredEvidence: ["Compare propagation delay with rise time."],
      sourcePages: format === "open" ? [7, 8] : [7], basis: [{ kind: "objective", value: section.objectives[0], supports: [1] }] },
  })));
  const questionsFrom = (note) => /^## Questions\n[\s\S]*?(?=\n## |\n<!-- scholar:generated:end -->)/m.exec(note)?.[0] || "";
  for (const attempts of [[], ...fixtures.map((fixture) => [fixture]), fixtures]) {
    const label = attempts.map(({ id }) => id).join(", ") || "empty";
    const original = JSON.stringify(attempts);
    const transcript = [{ id: "private-answer", kind: "question", markdown: privateResponse, createdAt: timestamp }];
    const learn = renderSection(config, book, chapter, { ...section, attempts, transcript });
    const tutorNote = renderTutorSession(config, book, { ...tutor, attempts, transcript });
    const rendered = questionsFrom(learn);
    assert.equal(questionsFrom(tutorNote), rendered, `${label}: Tutor must preserve the exact Learn question presentation`);
    assert.equal(rendered, assessmentQuestionBlock(attempts).join("\n").trimEnd(), `${label}: both notes use the shared block`);
    assert.equal(JSON.stringify(attempts), original, `${label}: projection cannot mutate assessment state`);
    for (const note of [learn, tutorNote]) assert.doesNotMatch(note, /PRIVATE_RESPONSE_DO_NOT_PROJECT|PENDING_ANSWER_MUST_STAY_PRIVATE|PENDING_FEEDBACK_MUST_STAY_PRIVATE|CANCELLED_KEY_MUST_STAY_PRIVATE/, label);
    assert.doesNotMatch(rendered, /^> \[!\w+\][-+]|\*\*Result:\*\*/m, `${label}: feedback stays open without duplicate result labels`);
    const questionNumbers = [...rendered.matchAll(/^### Question (\d+) · /gm)].map((match) => Number(match[1]));
    assert.deepEqual(questionNumbers, attempts.length === fixtures.length ? [2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 1, 7]
      : attempts.length ? [1] : [], `${label}: history precedes pending questions while original numbering is retained`);
    for (const [index, fixture] of attempts.entries()) {
      const heading = `### Question ${index + 1} · ${fixture.format === "open" ? "Application" : "Conceptual"}`;
      const start = rendered.indexOf(heading);
      assert.ok(start >= 0, `${label}: ${heading}`);
      const next = rendered.indexOf("\n### Question ", start + heading.length);
      const question = rendered.slice(start, next < 0 ? undefined : next);
      assert.ok(question.includes(`\n\n${fixture.question}\n`), fixture.id);
      if (fixture.options) assert.ok(question.includes("\n1. Compare propagation delay with rise time\n2. Use physical length alone\n"), fixture.id);
      else assert.doesNotMatch(question, /^\d+\. /m, fixture.id);
      if (fixture.outcome === "pending") {
        assert.ok(question.includes("*Awaiting response*"), fixture.id);
        assert.doesNotMatch(question, /\[!|\*\*(?:Correct answer|Explanation|Feedback):\*\*|\*PDF pages? /, fixture.id);
      } else if (fixture.outcome === "cancelled") {
        assert.ok(question.includes(`*Cancelled*\n\n${fixture.feedback}`), fixture.id);
        assert.doesNotMatch(question, /\[!|\*\*Correct answer:\*\*|\*PDF pages? /, fixture.id);
      } else {
        assert.ok(question.includes(`> [!${badges[fixture.outcome]}`), fixture.id);
        if (fixture.correctAnswer) assert.ok(question.includes(`> **Correct answer:** ${fixture.correctAnswer}`), fixture.id);
        else assert.doesNotMatch(question, /\*\*Correct answer:\*\*/, fixture.id);
        assert.ok(question.includes(`> **${fixture.correctAnswer ? "Explanation" : "Feedback"}:** Reasoning for ${fixture.format} ${fixture.outcome}.\n>\n> Check the assumptions.`), fixture.id);
        assert.ok(question.includes(fixture.format === "open" ? "> *PDF pages 7, 8*" : "> *PDF page 7*"), fixture.id);
      }
    }
  }
});
check("summary-only notes label the missing explanation honestly and exact duplicate supplements appear once", () => {
  const onlySummary = renderSection(config, book, chapter, { ...section, transcript: [], keyPoints: [synthesis, ...section.keyPoints, section.keyPoints[0]], misconceptions: [section.keyPoints[0]] });
  assert.doesNotMatch(onlySummary, /## Lesson|### Common pitfalls/);
  assert.match(onlySummary, /full explanation has not been saved yet/);
  assert.ok(onlySummary.indexOf("### Section summary") < onlySummary.indexOf(synthesis));
  assert.equal(onlySummary.split(synthesis).length - 1, 1);
  assert.equal(onlySummary.split(section.keyPoints[0]).length - 1, 1);
  const duplicate = { ...section.transcript[1], id: "duplicate" };
  const mixedEcho = { id: "mixed", kind: "assistant", markdown: `UNIQUE_EXPLANATION_BEFORE_A_QUESTION\n\n${section.attempts[2].question}`, createdAt: timestamp };
  const userEntry = { id: "private", kind: "user", markdown: privateResponse, createdAt: timestamp };
  const note = renderSection(config, book, chapter, { ...section, transcript: [...section.transcript, duplicate, mixedEcho, userEntry], synthesis: "A distinct concise section summary." });
  assert.equal(note.split(longExplanation).length - 1, 2); // Distinct saved deliveries remain inspectable; no hidden transcript copy.
  assert.equal(note.split(section.attempts[2].question).length - 1, 1);
  assert.ok(note.indexOf("UNIQUE_EXPLANATION_BEFORE_A_QUESTION") < note.indexOf("## Questions"));
  assert.ok(note.includes("> ### Section summary\n>\n> A distinct concise section summary."));
  assert.doesNotMatch(note, /PRIVATE_RESPONSE_DO_NOT_PROJECT/);
});
check("legacy completed feedback remains visible without inventing a correct answer", () => {
  const legacy = { ...section.attempts[0], correctAnswer: undefined, feedback: "LEGACY_FEEDBACK_VERBATIM: Review propagation delay." };
  for (const note of [renderSection(config, book, chapter, { ...section, attempts: [legacy], transcript: [] }), renderTutorSession(config, book, { ...tutor, attempts: [legacy], transcript: [] })]) {
    const questions = note.slice(note.indexOf("## Questions"));
    assert.ok(questions.includes(legacy.question) && questions.includes(`**Feedback:** ${legacy.feedback}`));
    assert.ok(questions.includes("> [!warning] Needs review"));
    assert.doesNotMatch(questions, /Correct answer|PRIVATE_RESPONSE/);
  }
});
check("open-response feedback stays open and cancellations stay quiet without an answer key", () => {
  const open = { ...section.attempts[1], format: "open", options: undefined, correctAnswer: undefined, feedback: "First paragraph of open-response feedback.\n\nSecond paragraph preserves the reasoning." };
  const cancelled = { ...section.attempts[0], outcome: "cancelled", correctAnswer: "CANCELLED_KEY_MUST_NOT_APPEAR", feedback: undefined };
  for (const note of [renderSection(config, book, chapter, { ...section, attempts: [open, cancelled], transcript: [] }), renderTutorSession(config, book, { ...tutor, attempts: [open, cancelled], transcript: [] })]) {
    assert.ok(note.includes("> [!success] Correct\n> **Feedback:** First paragraph of open-response feedback.\n>\n> Second paragraph preserves the reasoning."));
    assert.ok(note.includes("*Cancelled*"));
    assert.doesNotMatch(note, /CANCELLED_KEY_MUST_NOT_APPEAR|\[!success\]-|\*\*Result:\*\*/);
  }
});
check("the learner-owned paper groups prompts, native unchecked tasks and open writing space in question callouts", () => {
  const tokens = marked.lexer(answerPaper);
  const prompts = tokens.filter((token) => token.type === "blockquote" && /^\[!question\]/.test(token.text));
  const choiceLists = prompts.flatMap((prompt) => prompt.tokens.filter((token) => token.type === "list" && token.items.some((item) => item.task)));
  assert.equal(prompts.length, questions.length);
  assert.equal(choiceLists.length, 1);
  assert.equal(choiceLists[0].items.length, questions[0].options.length);
  for (const item of choiceLists[0].items) { assert.equal(item.task, true); assert.equal(item.checked, false); }
  assert.ok(prompts.every((token) => /scholar:choice:|Your response/.test(token.text)), "answer controls stay with their question");
  const open = /<!-- scholar:answer:q2:start -->([\s\S]*?)<!-- \/scholar:answer:q2:end -->/.exec(answerPaper)?.[1];
  assert.ok(open && open.replace(/^> ?/gm, "").trim() === "" && open.split("\n").length >= 8);
  assert.ok(answerPaper.includes("**Your response** · Write below in Live Preview."));
  assert.doesNotMatch(answerPaper, /scholar:generated|PRIVATE_RESPONSE_DO_NOT_PROJECT|GENERATION_TRANSCRIPT_PRIVATE_KEY|Correct answer|Rubric/);
  for (const question of questions) assert.ok(!answerPaper.includes(question.explanation));
  for (const criterion of questions[1].rubric) assert.ok(!answerPaper.includes(criterion.criterion));
});
check("ungraded exam receipts link to the paper without duplicating prompts or keys; submitted state cannot ask for resubmission", () => {
  for (const name of ["exam-active", "exam-submitted"]) {
    assert.match(samples[name], /Answer paper/i);
    for (const question of questions) assert.ok(!samples[name].includes(question.prompt), "questions live in the learner-owned paper");
    assert.doesNotMatch(samples[name], /Correct answer|Required evidence|Rubric|firstDecisiveError|GENERATION_TRANSCRIPT|edge is short compared/);
  }
  assert.ok(samples["exam-submitted"].includes("Submitted · Awaiting grading"));
  assert.doesNotMatch(samples["exam-submitted"], /\/scholar exam|submit once|Not yet submitted/);
});
check("graded receipt is concise and key preserves every prompt, option, correction and weighted score", () => {
  const receipt = samples["exam-graded"], key = samples["answer-key"];
  assert.ok(receipt.includes("Exam graded · 3/7 · 42.8571%") && receipt.includes("## Answer key"));
  assert.doesNotMatch(receipt, /## Questions|Which model applies|Used the simplified expression/);
  assert.ok(key.indexOf("> [!question] Question 2") < key.indexOf("> [!question] Question 1"), "weak item first, original numbering retained");
  assert.match(key, /^> > \[!warning\] Partial credit/m);
  for (const question of questions) { assert.ok(key.includes(question.prompt)); assert.ok(key.includes(question.explanation)); for (const option of question.options || []) assert.ok(key.includes(option.label)); }
  assert.ok(key.includes("First decisive error") && key.includes("Correct reasoning") && key.includes("Transferable lesson"));
  for (const note of [receipt, key]) assert.ok(note.includes("| Reasoning \\| assumptions | 0.0714286/0.142857 | 50% |"));
  assert.equal(JSON.stringify(book), before, "rendering cannot mutate or round stored state");
});
if (process.env.SCHOLAR_DESIGN_PREVIEW) {
  assert.ok(isAbsolute(process.env.SCHOLAR_DESIGN_PREVIEW), "preview directory must be absolute");
  await mkdir(process.env.SCHOLAR_DESIGN_PREVIEW, { recursive: true });
  await Promise.all(Object.entries({ ...samples, "exam-answer-paper": answerPaper }).map(([name, note]) => writeFile(join(process.env.SCHOLAR_DESIGN_PREVIEW, `${name}.md`), note, "utf8")));
  console.log(`Preview notes: ${process.env.SCHOLAR_DESIGN_PREVIEW}`);
}
console.log(`\nScholar note-design summary: ${passed} passed, ${failed} failed.`);
process.exitCode = failed ? 1 : 0;
