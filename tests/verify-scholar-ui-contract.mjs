import { findBookNotes, readFixtureBook, writeFixtureBook } from "./note-fixture.mjs";
import { extensionPath as packagedExtensionPath, piPackageRoot as sdkRoot, jitiPath as sdkJitiPath, resolvePiDependency } from "./sdk.mjs";
// Disposable regression probe for Scholar's compact read row and inactive status.
// It loads the real TypeScript extension through Pi's production loader and keeps
// all generated PDF, state, and Obsidian files in a temporary directory.
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const piRoot = sdkRoot;
const extensionPath = resolve(
  process.env.PI_SCHOLAR_EXTENSION
    || packagedExtensionPath,
);

const { createExtensionRuntime, loadExtensions } = await import(pathToFileURL(
  join(piRoot, "dist", "core", "extensions", "loader.js"),
).href);
const { ToolExecutionComponent } = await import(pathToFileURL(
  join(piRoot, "dist", "modes", "interactive", "components", "tool-execution.js"),
).href);
const { initTheme } = await import(pathToFileURL(
  join(piRoot, "dist", "modes", "interactive", "theme", "theme.js"),
).href);
const { stripTerminalSequences } = await import(pathToFileURL(
  resolvePiDependency("@earendil-works/pi-tui"),
).href);

function pdfLiteral(value) {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function syntheticPdf() {
  const sourceLines = [
    "Synthetic Scholar Book",
    "Chapter 1: Foundations",
    "1.1 First Principle",
    "A compact renderer should not surround a read with a padded card.",
  ];
  const commands = ["BT", "/F1 11 Tf", "72 740 Td", "18 TL"];
  sourceLines.forEach((line, index) => {
    if (index) commands.push("T*");
    commands.push(`(${pdfLiteral(line)}) Tj`);
  });
  commands.push("ET");
  const stream = commands.join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let document = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(document, "latin1"));
    document += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(document, "latin1");
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) {
    document += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(document, "latin1");
}

function installRuntime(runtime, branch) {
  runtime.appendEntry = (customType, data) => {
    const entry = { type: "custom", customType, data };
    branch.push(entry);
    return entry;
  };
  runtime.sendMessage = () => {};
  runtime.sendUserMessage = () => {};
  runtime.refreshTools = () => {};
    let activeTools = ["read", "bash"];
    runtime.getActiveTools = () => [...activeTools];
    runtime.setActiveTools = (names) => { activeTools = [...names]; };
}

async function readMarkdownTree(directory) {
  const documents = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) documents.push(await readMarkdownTree(path));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      const content = await readFile(path, "utf8");
      // Only the explicitly learner-owned exam paper may contain raw answers.
      if (!/^type: scholar-exam-paper$/m.test(content)) documents.push(content);
    }
  }
  return documents.join("\n");
}

const checks = [];
function check(name, passed, detail) {
  const item = { name, passed: Boolean(passed), detail };
  checks.push(item);
  console.log(`[${item.passed ? "PASS" : "FAIL"}] ${name} - ${detail}`);
}

async function runToolCallPreflight(extension, event, context) {
  for (const handler of extension.handlers.get("tool_call") || []) {
    const result = await handler(event, context);
    if (result?.block) return result;
  }
  return undefined;
}
async function learnerResponse(extension, context, text) {
  for (const handler of extension.handlers.get("agent_settled") || []) await handler({}, context);
  for (const handler of extension.handlers.get("input") || []) await handler({ type: "input", text, source: "interactive" }, context);
  for (const handler of extension.handlers.get("before_agent_start") || []) await handler({ systemPrompt: "base", prompt: text }, context);
}

const environmentNames = [
  "PI_SCHOLAR_LIBRARY_ROOT",
  "PI_SCHOLAR_OBSIDIAN_ROOT",
  "PI_SCHOLAR_STATE_ROOT",
];
const originalEnvironment = Object.fromEntries(
  environmentNames.map((name) => [name, process.env[name]]),
);
const root = await mkdtemp(join(tmpdir(), "scholar-ui-contract-"));
const library = join(root, "PDF Library");
const obsidian = join(root, "Obsidian Vault");
const state = join(root, "State");
const sourcePath = join(library, "Synthetic Scholar Book.pdf");

try {
  process.env.PI_SCHOLAR_STATE_ROOT = state;
  delete process.env.PI_SCHOLAR_LIBRARY_ROOT;
  delete process.env.PI_SCHOLAR_OBSIDIAN_ROOT;
  await Promise.all([
    mkdir(library, { recursive: true }),
    mkdir(obsidian, { recursive: true }),
  ]);
  await writeFile(sourcePath, syntheticPdf());

  const branch = [];
  const notifications = [];
  const privateExamResponse = "PRIVATE_EXAM_RESPONSE_X9";
  let editorFactory;
  const runtime = createExtensionRuntime();
  installRuntime(runtime, branch);
  const loaded = await loadExtensions([extensionPath], root, undefined, runtime);
  check(
    "production extension loader",
    loaded.errors.length === 0 && loaded.extensions.length === 1,
    loaded.errors.length ? loaded.errors.map((item) => item.error).join("; ") : extensionPath,
  );
  if (loaded.errors.length || loaded.extensions.length !== 1) {
    throw new Error("Scholar could not be loaded.");
  }

  const context = {
    cwd: root,
    hasUI: true,
    isIdle: () => true,
    abort: async () => {},
    sessionManager: {
      getSessionId: () => "scholar-ui-contract",
      getSessionFile: () => join(root, "session.jsonl"),
      getEntries: () => branch,
      getBranch: () => branch,
    },
    ui: {
      notify: (message, level) => notifications.push({ message, level }),
      setStatus: () => {},
      setWorkingMessage: () => {},
      setEditorText: () => {},
      setEditorComponent: (factory) => { editorFactory = factory; },
      getEditorComponent: () => editorFactory,
      editor: async () => { throw new Error("Exam must not use the Pi editor"); },
      confirm: async () => true,
      select: async (_title, options) => options[0],
    },
  };
  const extension = loaded.extensions[0];
  for (const handler of extension.handlers.get("session_start") || []) {
    await handler({}, context);
  }
  const command = extension.commands.get("scholar");
  await command.handler(`obsidian "${obsidian}"`, context);
  await command.handler(`library "${library}"`, context);
  await command.handler('open "Synthetic Scholar Book.pdf"', context);

  const definition = extension.tools.get("scholar")?.definition;
  if (!definition) throw new Error("Scholar tool did not activate after opening the book.");

  // /scholar status was removed. The same progress summary is still reachable
  // through the tool's status action, which is exempt from the active-mode gate.
  const setupStatusResult = await definition.execute(
    "setup-status-ui-contract",
    { action: "status" },
    undefined,
    undefined,
    context,
  );
  const setupStatus = setupStatusResult?.details?.summary || "";

  // Exercise the real setup path. Recoverable outline problems must arrive in
  // one review report, while a deterministic corrected outline should validate
  // itself without model-copied excerpts or a second validation call.
  const bookDirectories = (await readdir(join(obsidian, "Scholar", "Books"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory());
  if (bookDirectories.length !== 1) throw new Error(`Expected one Scholar book directory, found ${bookDirectories.length}.`);
  const bookStatePath = (await findBookNotes(obsidian))[0];
  const reviewResult = await definition.execute(
    "outline-review-ui-contract",
    {
      action: "outline",
      outlineConfidence: "verified",
      chapters: [
        { number: "8", title: "Invented Alpha", startPage: 1, endPage: 1, sections: [{ number: "8.1", title: "Invented One", startPage: 1, endPage: 1 }] },
        { number: "9", title: "Invented Beta", startPage: 1, endPage: 1, sections: [{ number: "9.1", title: "Invented Two", startPage: 1, endPage: 1 }] },
      ],
    },
    undefined,
    undefined,
    context,
  );
  const reviewedBook = (await readFixtureBook(bookStatePath));
  check(
    "outline corrections are aggregated without false errors",
    reviewResult.details?.tone === "review"
      && reviewResult.details?.validationReport?.issues?.length >= 2
      && !reviewResult.content?.[0]?.text?.startsWith("Scholar error:")
      && reviewedBook.outlineStatus === "needs-review",
    `${reviewResult.details?.validationReport?.issues?.length || 0} issue(s); ${reviewResult.details?.summary || "no summary"}`,
  );

  const visualOutline = await definition.execute(
    "outline-visual-ui-contract",
    {
      action: "outline",
      outlineConfidence: "verified",
      chapters: [{
        number: "1",
        title: "Foundations",
        startPage: 1,
        endPage: 1,
        sections: [{ number: "1.1", title: "Ambiguous Principle", startPage: 1, endPage: 1 }],
      }],
    },
    undefined,
    undefined,
    context,
  );
  check(
    "ambiguous checkpoints are requested together without copied evidence",
    visualOutline.details?.validationReport?.status === "visual-review"
      && visualOutline.details.validationReport.visualPages.join(",") === "1"
      && visualOutline.details.validationReport.requiredDecisionIds.join(",") === "chapter-001-section-001",
    visualOutline.details?.summary || "no summary",
  );
  await definition.execute("outline-visual-page-ui-contract", { action: "view", page: 1 }, undefined, undefined, context);
  const disputedVisual = await definition.execute(
    "outline-visual-decision-ui-contract",
    {
      action: "outline_validate",
      outlineRevision: visualOutline.details.outlineRevision,
      validationChecks: [{ id: "chapter-001-section-001", outcome: "mismatch", observation: "The rendered page says First Principle." }],
    },
    undefined,
    undefined,
    context,
  );
  check(
    "one compact visual decision resolves the requested review",
    disputedVisual.details?.validationReport?.status === "needs-review"
      && disputedVisual.details?.tone === "review"
      && !disputedVisual.content?.[0]?.text?.startsWith("Scholar error:"),
    disputedVisual.details?.summary || "no summary",
  );

  const outlineResult = await definition.execute(
    "outline-ready-ui-contract",
    {
      action: "outline",
      outlineConfidence: "verified",
      chapters: [{
        number: "1",
        title: "Foundations",
        startPage: 1,
        endPage: 1,
        sections: [{ number: "1.1", title: "First Principle", startPage: 1, endPage: 1, requiredChecks: ["conceptual"] }],
      }],
    },
    undefined,
    undefined,
    context,
  );
  const bookState = (await readFixtureBook(bookStatePath));
  check(
    "deterministic outline validation is automatic",
    outlineResult.details?.validationReport?.status === "ready"
      && outlineResult.details?.tone === "progress"
      && bookState.outlineStatus === "ready"
      && bookState.currentSectionId === undefined
      && !Object.prototype.hasOwnProperty.call(bookState, "outlineValidation"),
    outlineResult.details?.summary || "no summary",
  );
  for (const handler of extension.handlers.get("agent_settled") || []) {
    await handler({}, context);
  }
  const idleReadyRead = await definition.execute(
    "idle-ready-read-ui-contract",
    { action: "read", startPage: 1, endPage: 1 },
    undefined,
    undefined,
    context,
  );
  const idleReadyOutline = await definition.execute(
    "idle-ready-outline-ui-contract",
    { action: "outline", outlineConfidence: "verified", chapters: [] },
    undefined,
    undefined,
    context,
  );
  check(
    "selected ready book exposes no source or setup capability",
    idleReadyRead.details?.tone === "retry"
      && idleReadyOutline.details?.tone === "retry"
      && /no active operation/i.test(idleReadyRead.content?.[0]?.text || "")
      && /no active operation/i.test(idleReadyOutline.content?.[0]?.text || ""),
    `${idleReadyRead.details?.summary || "read allowed"}; ${idleReadyOutline.details?.summary || "outline allowed"}`,
  );
  await command.handler('learn "1.1"', context);
  const scopedSearch = await definition.execute(
    "scoped-search-ui-contract",
    { action: "search", query: "compact renderer", limit: 4 },
    undefined,
    undefined,
    context,
  );
  const scopedSearchText = scopedSearch.content?.map((item) => item.type === "text" ? item.text : "").join("\n") || "";
  check(
    "Learn search resolves active-section scope",
    !scopedSearchText.startsWith("Scholar error:") && scopedSearchText.includes("PDF page 1"),
    JSON.stringify(scopedSearchText),
  );

  const readResult = await definition.execute(
    "read-ui-contract",
    { action: "read", startPage: 1, endPage: 1, maxChars: 8_000 },
    undefined,
    undefined,
    context,
  );
  const readText = readResult.content?.find((item) => item.type === "text")?.text || "";
  check(
    "bounded PDF read survives the architecture split",
    readResult.details?.action === "read" && readText.includes("A compact renderer should not surround a read with a padded card."),
    readResult.details?.summary || JSON.stringify(readText),
  );

  const lessonPageView = await definition.execute("learn-figure-review-ui-contract", { action: "view", page: 1 }, undefined, undefined, context);
  check("the lesson page is visually inspected before recording its figure review", lessonPageView.details?.action === "view", lessonPageView.details?.summary || "no view");
  const notesResult = await definition.execute(
    "learn-notes-ui-contract",
    {
      action: "notes",
      sectionId: "chapter-001-section-001",
      objectives: ["Explain why the compact renderer avoids padded cards."],
      coveredObjectives: ["Explain why the compact renderer avoids padded cards."],
      requiredChecks: ["conceptual"],
      synthesis: "The compact renderer keeps a source read concise by showing one informative row without a padded surrounding card.",
      keyPoints: ["Compact source reads remain visible without redundant framing."],
      misconceptions: [],
      figureReviews: [{ page: 1, observation: "Rendered page contains only the source paragraphs; no figures or tables.", figures: [] }],
      objectiveChecks: [{ objective: "Explain why the compact renderer avoids padded cards.", checks: ["conceptual"] }],
      lesson: { id: "compact-explanation", title: "Keep information, remove repeated framing", objectives: ["Explain why the compact renderer avoids padded cards."],
        keyPoints: ["Compact source reads remain visible without redundant framing."], sourcePages: [1],
        markdown: "### Keep information, remove repeated framing\n\nA source read is one bounded passage fetched from the PDF. The learner needs that passage and its page reference. Extra nested cards repeat visual boundaries without adding evidence. Keep one informative row so the passage stays visible while repeated padding disappears." },
      lessonComplete: true,
    },
    undefined,
    undefined,
    context,
  );
  const notesText = notesResult.content?.map((item) => item.type === "text" ? item.text : "").join("\n") || "";
  check(
    "Learn notes persist through the extracted tool controller",
    !notesText.startsWith("Scholar error:") && notesText.includes("Saved instructional explanation") && notesText.includes("Full lesson committed"),
    JSON.stringify(notesText),
  );

  const beforeBlockedQuiz = (await readFixtureBook(bookStatePath));
  const ungroundedQuiz = await runToolCallPreflight(extension, {
    toolName: "scholar_quiz",
    toolCallId: "quiz-ungrounded-ui-contract",
    input: {
      question: "Which answer is right?",
      options: [{ label: "A", value: "a" }, { label: "B", value: "b" }],
      correctAnswer: "a",
      explanation: "A is right.",
    },
  }, context);
  const afterBlockedQuiz = (await readFixtureBook(bookStatePath));
  check(
    "ungrounded multiple choice is blocked before persistence or presentation",
    ungroundedQuiz?.block === true
      // Match the gate that fired, not its exact wording: the reasons are
      // deliberately field-specific now so a model can correct them.
      && /grounding/i.test(ungroundedQuiz.reason || "")
      && afterBlockedQuiz.revision === beforeBlockedQuiz.revision
      && afterBlockedQuiz.chapters[0].sections[0].attempts.length === beforeBlockedQuiz.chapters[0].sections[0].attempts.length,
    `${ungroundedQuiz?.reason || "not blocked"}; revision=${beforeBlockedQuiz.revision}/${afterBlockedQuiz.revision}`,
  );

  const outOfScopeQuiz = await runToolCallPreflight(extension, {
    toolName: "scholar_quiz",
    toolCallId: "quiz-out-of-scope-ui-contract",
    input: {
      question: "Apply the compact-renderer invariant on a later page.",
      difficulty: "transfer",
      grounding: {
        purpose: "mastery",
        competency: "Transfer the compact-renderer invariant to a changed layout.",
        requiredEvidence: ["Preserve the information invariant while removing redundant framing."],
        sourcePages: [2],
        basis: [{ kind: "objective", value: "Explain why the compact renderer avoids padded cards.", supports: [1] }],
      },
      options: [{ label: "Preserve the invariant", value: "preserve" }, { label: "Add framing", value: "frame" }],
      correctAnswer: "preserve",
      explanation: "The invariant survives the changed layout.",
    },
  }, context);
  const afterOutOfScopeQuiz = (await readFixtureBook(bookStatePath));
  check(
    "out-of-scope grounding is blocked without an orphan pending attempt",
    outOfScopeQuiz?.block === true
      && /source page 2 is outside/i.test(outOfScopeQuiz.reason || "")
      && afterOutOfScopeQuiz.revision === afterBlockedQuiz.revision
      && afterOutOfScopeQuiz.chapters[0].sections[0].attempts.length === 0,
    outOfScopeQuiz?.reason || "not blocked",
  );

  const demandingQuizInput = {
    shuffle: false,
    question: "A pipeline must display 10,000 bounded source reads in a pane four times narrower. Which redesign best preserves the compact renderer's information invariant across both scale and layout?",
    details: "application transfer",
    difficulty: "transfer",
    grounding: {
      purpose: "practice",
      competency: "Transfer compact rendering to a scaled and width-constrained system.",
      requiredEvidence: ["Identify the invariant that removes redundant framing while retaining the informative row."],
      sourcePages: [1],
      basis: [{ kind: "objective", value: "Explain why the compact renderer avoids padded cards.", supports: [1] }],
    },
    options: [
      { label: "Keep one informative row and remove per-read padded containers", value: "compact" },
      { label: "Add nested padded containers to separate every read", value: "nested", misconception: "Equates extra framing with additional information" },
      { label: "Hide the source-read information entirely", value: "hide", misconception: "Confuses removing repetition with removing evidence" },
    ],
    correctAnswer: "compact",
    explanation: "The changed context is harder, but the same information invariant governs the design.",
  };
  const demandingQuiz = await runToolCallPreflight(extension, {
    toolName: "scholar_quiz",
    toolCallId: "quiz-demanding-transfer-ui-contract",
    input: demandingQuizInput,
  }, context);
  const afterDemandingQuiz = (await readFixtureBook(bookStatePath));
  const demandingAttempt = afterDemandingQuiz.chapters[0].sections[0].attempts.at(-1);
  check(
    "a demanding grounded transfer question passes without being simplified",
    demandingQuiz === undefined
      && demandingAttempt?.outcome === "pending"
      && demandingAttempt?.difficulty === "transfer"
      && demandingAttempt?.grounding?.competency.includes("scaled and width-constrained"),
    `${demandingQuiz?.reason || "allowed"}; ${demandingAttempt?.question || "no attempt"}`,
  );
  for (const handler of extension.handlers.get("tool_execution_update") || []) {
    await handler({
      toolName: "scholar_quiz",
      toolCallId: "quiz-demanding-transfer-ui-contract",
      partialResult: {
        details: {
          options: demandingQuizInput.options.map((option, index) => ({ index: index + 1, label: option.label })),
        },
      },
    }, context);
  }
  for (const handler of extension.handlers.get("tool_result") || []) {
    await handler({
      toolName: "scholar_quiz",
      toolCallId: "quiz-demanding-transfer-ui-contract",
      details: { status: "answered", correct: false, question: demandingQuizInput.question, mode: "single-select" },
    }, context);
  }

  const preparedAssessment = await definition.execute(
    "learn-assess-prepare-ui-contract",
    {
      action: "assess",
      sectionId: "chapter-001-section-001",
      kind: "conceptual",
      format: "open",
      question: "Why should a compact source read avoid a padded card?",
      expectedAnswer: "The passage remains informative in one row; repeated padding adds no information.",
      criteria: ["Explain that repeated padding adds no information."],
      outcome: "pending",
      grounding: {
        purpose: "mastery",
        competency: "Explain why compact source presentation removes redundant framing.",
        requiredEvidence: ["Connect compact presentation to the removal of a redundant padded card."],
        sourcePages: [1],
        basis: [{
          kind: "objective",
          value: "Explain why the compact renderer avoids padded cards.",
          supports: [1],
        }],
      },
    },
    undefined,
    undefined,
    context,
  );
  const beforeAmbient = (await readFixtureBook(bookStatePath)).chapters[0].sections[0].transcript;
  for (const handler of extension.handlers.get("message_end") || []) {
    await handler({
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Saved the lesson to Obsidian. Preparing the next question." }],
      },
    }, context);
    await handler({
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Why should a compact source read avoid a padded card?" }],
      },
    }, context);
    await handler({ message: { role: "assistant", content: [{ type: "text", text:
      "A source read is one bounded passage fetched from the PDF. The learner needs that passage and its page reference. Extra nested cards repeat visual boundaries without adding evidence. Keep one informative row so the passage stays visible while repeated padding disappears." }] } }, context);
  }
  const afterAmbient = (await readFixtureBook(bookStatePath)).chapters[0].sections[0].transcript;
  check("ambient progress and body-only lesson echoes do not append after explicit lesson delivery",
    JSON.stringify(beforeAmbient) === JSON.stringify(afterAmbient), `entries=${beforeAmbient.length}/${afterAmbient.length}`);
  const clarification = await definition.execute("learn-explicit-followup", { action: "notes", lesson: {
    id: "compact-clarification", title: "Why the passage still matters", objectives: ["Explain why the compact renderer avoids padded cards."],
    keyPoints: ["Compact source reads remain visible without redundant framing."], sourcePages: [1],
    markdown: "### Why the passage still matters\n\nRemoving a card does not mean removing the source passage. The passage carries evidence; the repeated border and padding only separate areas visually. This distinction lets the layout become smaller while its meaning remains available.",
  } }, undefined, undefined, context);
  check("substantive follow-up explanations remain available through explicit lesson writes",
    clarification.details?.action === "notes"
      && (await readFixtureBook(bookStatePath)).chapters[0].sections[0].transcript.some(entry => entry.id === "lesson-compact-clarification"),
    clarification.content?.[0]?.text || "no saved clarification");
  const sectionDirectory = join(obsidian, "Scholar", "Books", bookDirectories[0].name, "Sections");
  const sectionFile = (await readdir(sectionDirectory)).find((name) => name.endsWith(".md"));
  if (!sectionFile) throw new Error("Expected the active Scholar section note.");
  const sectionNotePath = join(sectionDirectory, sectionFile);
  const pendingSectionMarkdown = await readFile(sectionNotePath, "utf8");
  const pendingQuestionIndex = pendingSectionMarkdown.indexOf("> [!question] Question 2");
  const pendingObjectivesIndex = pendingSectionMarkdown.indexOf("> ### Learning objectives");
  const pendingTeachingIndex = pendingSectionMarkdown.indexOf("## Lesson");
  const pendingAnswersIndex = pendingSectionMarkdown.indexOf("## Questions");
  check(
    "full lesson precedes collapsed admin, visible paired history, and the pending question at the note bottom",
    pendingTeachingIndex >= 0
      && pendingTeachingIndex < pendingObjectivesIndex
      && pendingObjectivesIndex < pendingAnswersIndex
      && pendingAnswersIndex < pendingQuestionIndex
      && pendingSectionMarkdown.includes("> [!question] Question 1")
      && pendingSectionMarkdown.includes(`1. ${demandingQuizInput.options[0].label}`)
      && pendingSectionMarkdown.slice(pendingQuestionIndex).includes("*Awaiting response*")
      && /^> > \[!info\]- Scholar question details/m.test(pendingSectionMarkdown.slice(pendingQuestionIndex))
      && pendingSectionMarkdown.split("Why should a compact source read avoid a padded card?").length - 1 === 1
      && pendingSectionMarkdown.includes("Removing a card does not mean removing the source passage.")
      && !pendingSectionMarkdown.includes("Saved the lesson to Obsidian. Preparing"),
    `questions=${pendingQuestionIndex}; objectives=${pendingObjectivesIndex}; teaching=${pendingTeachingIndex}; answers=${pendingAnswersIndex}`,
  );
  const duplicateOpen = await definition.execute(
    "learn-assess-duplicate-ui-contract",
    {
      action: "assess",
      sectionId: "chapter-001-section-001",
      kind: "conceptual",
      format: "open",
      question: "A second question must not replace the pending one.",
      expectedAnswer: "The passage remains informative in one row; repeated padding adds no information.",
      criteria: ["Explain that repeated padding adds no information."],
      outcome: "pending",
      grounding: {
        purpose: "mastery",
        competency: "Explain why compact presentation removes redundant framing.",
        requiredEvidence: ["Connect compact presentation to removal of redundant framing."],
        sourcePages: [1],
        basis: [{ kind: "objective", value: "Explain why the compact renderer avoids padded cards.", supports: [1] }],
      },
    },
    undefined,
    undefined,
    context,
  );
  const afterDuplicateOpen = (await readFixtureBook(bookStatePath));
  check(
    "a second open question cannot displace a pending approved question",
    duplicateOpen.content?.[0]?.text?.startsWith("Scholar retry:")
      && duplicateOpen.details?.tone === "retry"
      && /Resolve or cancel the existing open question/.test(duplicateOpen.content[0].text)
      && afterDuplicateOpen.chapters[0].sections[0].attempts.filter((attempt) => attempt.outcome === "pending").length === 1,
    duplicateOpen.content?.[0]?.text || "no rejection",
  );

  let resumePrompt = "";
  for (const handler of extension.handlers.get("before_agent_start") || []) {
    const result = await handler({ systemPrompt: "base" }, context);
    if (result?.systemPrompt) resumePrompt = result.systemPrompt;
  }
  check(
    "a pending open question is recoverable after resume",
    resumePrompt.includes(preparedAssessment.details?.attemptId)
      && resumePrompt.includes("Why should a compact source read avoid a padded card?"),
    preparedAssessment.details?.attemptId || "missing attempt id",
  );
  for (const handler of extension.handlers.get("agent_settled") || []) await handler({}, context);

  const tamperedResolution = await definition.execute(
    "learn-assess-tamper-ui-contract",
    {
      action: "assess",
      attemptId: preparedAssessment.details?.attemptId,
      question: "Replace the approved question.",
      outcome: "pass",
      feedback: "This must be rejected.",
    },
    undefined,
    undefined,
    context,
  );
  const afterTamper = (await readFixtureBook(bookStatePath));
  check(
    "an approved open question is immutable during resolution",
    tamperedResolution.content?.[0]?.text?.startsWith("Scholar retry:")
      && tamperedResolution.details?.tone === "retry"
      && /immutable/.test(tamperedResolution.content[0].text)
      && afterTamper.chapters[0].sections[0].attempts.find((attempt) => attempt.id === preparedAssessment.details?.attemptId)?.outcome === "pending",
    tamperedResolution.content?.[0]?.text || "no rejection",
  );
  const withoutResponse = await definition.execute("grade-without-input", {
    action: "assess", attemptId: preparedAssessment.details.attemptId, outcome: "pass", feedback: "A claimed answer without user input.",
    evaluation: { criteria: [{ criterionIndex: 1, met: true, evidence: "Repeated padding adds no information" }] },
  }, undefined, undefined, context);
  check("the real tool controller rejects a passing grade before actual user input",
    /no learner response/.test(withoutResponse.content?.[0]?.text || "")
      && (await readFixtureBook(bookStatePath)).chapters[0].sections[0].attempts.at(-1)?.outcome === "pending",
    withoutResponse.content?.[0]?.text || "missing rejection");
  await learnerResponse(extension, context, "Repeated padding adds no information, so retain the informative row.");
  const assessmentResult = await definition.execute(
    "learn-assess-resolve-ui-contract",
    {
      action: "assess",
      attemptId: preparedAssessment.details?.attemptId,
      outcome: "pass",
      feedback: "The response correctly connects compact presentation with removing redundant framing.",
      evaluation: { criteria: [{ criterionIndex: 1, met: true, evidence: "Repeated padding adds no information" }] },
    },
    undefined,
    undefined,
    context,
  );
  const assessmentText = assessmentResult.content?.map((item) => item.type === "text" ? item.text : "").join("\n") || "";
  check(
    "Learn assessment and completion survive the architecture split",
    !assessmentText.startsWith("Scholar error:") && assessmentText.includes("Section complete"),
    JSON.stringify(assessmentText),
  );

  const beforeProjection = (await readFixtureBook(bookStatePath));
  const projectedTranscriptIds = beforeProjection.chapters[0].sections[0].transcript.map((entry) => entry.id);
  const privateAnswerSummary = "PRIVATE_LEARNER_ANSWER_MUST_STAY_IN_JSON";
  beforeProjection.chapters[0].sections[0].attempts[1].answerSummary = privateAnswerSummary;
  beforeProjection.chapters[0].sections[0].transcript.push({
    id: "legacy-unmatched-result-ui-contract",
    kind: "result",
    markdown: "**Outcome:** Needs review. This legacy result has no trustworthy question pairing.",
    createdAt: new Date().toISOString(),
  });
  await writeFixtureBook(bookStatePath, beforeProjection);
  const projectionRefresh = await definition.execute(
    "learn-notes-projection-ui-contract",
    {
      action: "notes",
      sectionId: "chapter-001-section-001",
      objectives: ["Explain why the compact renderer avoids padded cards."],
      coveredObjectives: ["Explain why the compact renderer avoids padded cards."],
      requiredChecks: ["conceptual"],
      synthesis: "The compact renderer keeps a source read concise by showing one informative row without a padded surrounding card.",
      keyPoints: ["Compact source reads remain visible without redundant framing."],
      misconceptions: [],
    },
    undefined,
    undefined,
    context,
  );
  const completedSectionMarkdown = await readFile(sectionNotePath, "utf8");
  const completedAnswersIndex = completedSectionMarkdown.lastIndexOf("#### Feedback");
  const completedEndIndex = completedSectionMarkdown.indexOf("<!-- scholar:generated:end -->");
  const afterProjection = (await readFixtureBook(bookStatePath));
  check(
    "completed questions have visible paired feedback at the generated note bottom",
    projectionRefresh.details?.action === "notes"
      && completedSectionMarkdown.includes("> [!question] Question 1")
      && completedSectionMarkdown.includes("> [!question] Question 2")
      && completedAnswersIndex > completedSectionMarkdown.indexOf("> [!question] Question 2")
      && completedSectionMarkdown.indexOf("## Questions") > completedSectionMarkdown.indexOf("## Lesson")
      && completedAnswersIndex < completedEndIndex
      && /> \[!info\]- Scholar question details/.test(completedSectionMarkdown.slice(completedSectionMarkdown.indexOf("## Questions"), completedEndIndex))
      && !completedSectionMarkdown.includes("*Awaiting response*")
      && completedSectionMarkdown.split("The response correctly connects compact presentation").length - 1 === 1
      && completedSectionMarkdown.split("Why should a compact source read avoid a padded card?").length - 1 === 1
      && !completedSectionMarkdown.includes("This legacy result has no trustworthy question pairing")
      && completedSectionMarkdown.includes(privateAnswerSummary)
      && JSON.stringify(afterProjection.chapters[0].sections[0].transcript.map((entry) => entry.id)) === JSON.stringify(projectedTranscriptIds),
    `answers=${completedAnswersIndex}; end=${completedEndIndex}; transcript=${afterProjection.chapters[0].sections[0].transcript.length}`,
  );

  for (const handler of extension.handlers.get("agent_settled") || []) await handler({}, context);
  await command.handler('tutor "1.1"', context);
  const tutorNotesResult = await definition.execute(
    "tutor-notes-ui-contract",
    {
      action: "notes",
      synthesis: "The grounded principle connects its governing model to the nearby application and exposes the relevant boundary conditions.",
      keyPoints: ["Connect the governing model to its application."],
      lesson: { id: "tutor-explanation", title: "Choose a governing relation", objectives: [], keyPoints: ["Connect the governing model to its application."], sourcePages: [1],
        markdown: "### Choose a governing relation\n\nA governing model states which quantities depend on one another and under which assumptions. Check those assumptions against the case before using the relation. Then substitute the case's inputs to predict its result." },
    },
    undefined,
    undefined,
    context,
  );
  const tutorLeakAttempt = await definition.execute(
    "tutor-learn-leak-ui-contract",
    {
      action: "assess",
      kind: "application",
      format: "open",
      question: "Use Learn's objective directly.",
      expectedAnswer: "Use the relation whose assumptions match the case.", criteria: ["Choose a relation with matching assumptions."],
      outcome: "pending",
      grounding: {
        purpose: "mastery",
        competency: "Attempt to reuse evidence from the isolated Learn record.",
        requiredEvidence: ["Use Learn's covered objective."],
        sourcePages: [1],
        basis: [{ kind: "objective", value: "Explain why the compact renderer avoids padded cards.", supports: [1] }],
      },
    },
    undefined,
    undefined,
    context,
  );
  const afterTutorLeak = (await readFixtureBook(bookStatePath));
  check(
    "Tutor cannot borrow Learn teaching receipts",
    tutorLeakAttempt.content?.[0]?.text?.startsWith("Scholar retry:")
      && tutorLeakAttempt.details?.tone === "retry"
      && /cannot borrow Learn objectives/i.test(tutorLeakAttempt.content[0].text)
      && afterTutorLeak.tutorSessions.at(-1)?.attempts.length === 0,
    tutorLeakAttempt.content?.[0]?.text || "no rejection",
  );
  const preparedTutorAssessment = await definition.execute(
    "tutor-assess-prepare-ui-contract",
    {
      action: "assess",
      kind: "application",
      format: "open",
      question: "Apply the principle.",
      expectedAnswer: "Use the relation whose assumptions match the case.", criteria: ["Choose a relation with matching assumptions."],
      outcome: "pending",
      grounding: {
        purpose: "practice",
        competency: "Apply the governing model in a changed case.",
        requiredEvidence: ["Select and apply the governing model to the changed case."],
        sourcePages: [1],
        basis: [{
          kind: "key-point",
          value: "Connect the governing model to its application.",
          supports: [1],
        }],
      },
    },
    undefined,
    undefined,
    context,
  );
  await learnerResponse(extension, context, "I choose the relation whose assumptions match this case.");
  const tutorAssessmentResult = await definition.execute(
    "tutor-assess-resolve-ui-contract",
    {
      action: "assess",
      attemptId: preparedTutorAssessment.details?.attemptId,
      outcome: "pass",
      feedback: "The response selected and applied the governing model correctly.",
      evaluation: { criteria: [{ criterionIndex: 1, met: true, evidence: "relation whose assumptions match this case" }] },
    },
    undefined,
    undefined,
    context,
  );
  const afterTutor = (await readFixtureBook(bookStatePath));
  const tutor = afterTutor.tutorSessions.at(-1);
  const learnedSectionAfterTutor = afterTutor.chapters[0].sections[0];
  check(
    "Tutor notes and assessment remain isolated from Learn evidence",
    tutorNotesResult.details?.action === "notes"
      && tutorAssessmentResult.details?.action === "assess"
      && tutor?.synthesis
      && tutor.keyPoints.length === 1
      && tutor.attempts.length === 1
      && learnedSectionAfterTutor.attempts.length === 2
      && learnedSectionAfterTutor.attempts.every((attempt) => attempt.grounding)
      && tutor.attempts.every((attempt) => attempt.grounding),
    `tutorAttempts=${tutor?.attempts?.length || 0}; learnAttempts=${learnedSectionAfterTutor.attempts.length}; learnGrounding=${learnedSectionAfterTutor.attempts.map((attempt) => Boolean(attempt.grounding)).join(",")}; tutorGrounding=${tutor?.attempts?.map((attempt) => Boolean(attempt.grounding)).join(",")}`,
  );

  // A real user cannot navigate while the Tutor turn owns the editor. Settle
  // that turn before invoking the next slash command directly in this harness.
  for (const handler of extension.handlers.get("agent_settled") || []) await handler({}, context);
  await command.handler('exam "1"', context);
  const examBuildResult = await definition.execute(
    "exam-build-ui-contract",
    {
      action: "exam_build",
      questions: [{
        id: "q1",
        sectionIds: ["chapter-001-section-001"],
        claim: "The learner can identify the purpose of compact read rendering.",
        requiredEvidence: ["Recognizes redundant padding as unnecessary."],
        dimensions: ["conceptual"],
        format: "multiple-choice",
        prompt: "Which design best matches the source?",
        // Three plausible options, each distractor naming its own distinct
        // misconception: the question engine's mechanically enforced minimum.
        options: [
          { value: "A", label: "A compact read row without a padded card" },
          { value: "B", label: "A padded card around every read", misconception: "treats every tool result as a document" },
          { value: "C", label: "A collapsed row that hides the page range", misconception: "assumes provenance is noise" },
        ],
        correctAnswer: "A",
        explanation: "The source explicitly favors the compact renderer.",
        maxPoints: 1,
      }, {
        id: "q2",
        sectionIds: ["chapter-001-section-001"],
        claim: "The learner explains why compact source reads preserve useful evidence.",
        requiredEvidence: ["Identifies the information a compact read must preserve."],
        dimensions: ["conceptual"],
        format: "open",
        prompt: "Explain which information a compact read must preserve.",
        rubric: [
          { id: "r1", criterion: "Preserves source evidence", requiredEvidence: ["Identifies useful source evidence"], points: 0.5 },
          { id: "r2", criterion: "Checks page provenance", requiredEvidence: ["Checks that source pages remain identifiable"], points: 0.5 },
        ],
        explanation: "A compact source read preserves content and page provenance.",
        maxPoints: 1,
      }],
    },
    undefined,
    undefined,
    context,
  );
  const examBuildText = examBuildResult.content?.find((item) => item.type === "text")?.text || "";
  check(
    "Exam form validation and freezing survive the architecture split",
    examBuildResult.details?.action === "exam_build"
      && !examBuildText.startsWith("Scholar error:")
      && examBuildText.includes("ready")
      && !examBuildText.includes("Grade every item now"),
    examBuildResult.details?.summary || JSON.stringify(examBuildText),
  );

  const frozenBook = (await readFixtureBook(bookStatePath));
  const examDirectory = join(obsidian, "Scholar", "Books", frozenBook.noteDirectory, "Exams");
  const paperPath = join(examDirectory, (await readdir(examDirectory)).find((name) => name.endsWith(" - Answers.md")));
  const originalPaper = await readFile(paperPath, "utf8");
  const answeredPaper = originalPaper
    .replace("- [ ] **A** — A compact read row without a padded card <!-- scholar:choice:0 -->", "- [x] **A** — A compact read row without a padded card <!-- scholar:choice:0 -->")
    .replace(/(<!-- scholar:answer:q2:start -->\n)[\s\S]*?(<!-- \/scholar:answer:q2:end -->)/, (_, start, end) => `${start}> ${privateExamResponse}\n> ${end}`);
  check("Exam paper exposes native unchecked choices and receives a checked MCQ plus private written response",
    /^answer_format: checkboxes-v1$/m.test(originalPaper)
      && (originalPaper.match(/^> - \[ \] .*<!-- scholar:choice:\d+ -->$/gm) || []).length === 3
      && !/^> - \[[xX]\]/m.test(originalPaper)
      && !originalPaper.includes("The source explicitly favors the compact renderer.")
      && !originalPaper.includes("Preserves source evidence")
      && answeredPaper.includes("- [x] **A**") && answeredPaper.includes(privateExamResponse),
    "native tasks preserve a distinct private open answer without revealing the grading contract");
  await writeFile(paperPath, answeredPaper, "utf8");
  for (const handler of extension.handlers.get("agent_settled") || []) await handler({}, context);
  await command.handler('exam "exam-001" submit', context);

  const examGradeResult = await definition.execute(
    "exam-grade-ui-contract",
    {
      action: "exam_grade",
      itemResults: [{
        questionId: "q1",
        outcome: "correct",
        earnedPoints: 1,
        maxPoints: 1,
        feedback: "The selected answer matches the source-grounded principle.",
      }, {
        questionId: "q2",
        outcome: "correct",
        earnedPoints: 1,
        maxPoints: 1,
        feedback: "The response identifies the evidence the compact read preserves.",
      }],
    },
    undefined,
    undefined,
    context,
  );
  const afterExam = (await readFixtureBook(bookStatePath));
  const exam = afterExam.exams.at(-1);
  const groundingInState = afterExam.chapters[0].sections[0].attempts.map((attempt) => Boolean(attempt.grounding));
  const exactQuestion = "Why should a compact source read avoid a padded card?";
  const storedQuestionEntries = afterExam.chapters[0].sections[0].transcript
    .filter((entry) => entry.markdown.replace(/^\*\*|\*\*$/g, "") === exactQuestion).length;
  const visibleMarkdown = await readMarkdownTree(join(obsidian, "Scholar"));
  const visibleQuestionEntries = visibleMarkdown.split(exactQuestion).length - 1;
  check(
    "Exam submission, grading, breakdowns, and visible-note privacy survive the split",
    examGradeResult.details?.action === "exam_grade"
      && exam?.status === "graded"
      && exam.rawResponses.length === 2
      && exam.rawResponses[0].response === "A"
      && exam.rawResponses[1].response === privateExamResponse
      && await readFile(paperPath, "utf8") === answeredPaper
      && exam.itemResults.length === 2
      && exam.breakdown.length === 2
      && exam.earnedPoints === 2
      && exam.maxPoints === 2
      && exam.percent === 100
      && groundingInState.length === 2
      && groundingInState.every(Boolean)
      && storedQuestionEntries === 0
      && visibleQuestionEntries === 1
      && visibleMarkdown.includes("## Questions")
      && visibleMarkdown.includes("#### Feedback")
      && !visibleMarkdown.includes("> [!question]- Assessment record")
      && !visibleMarkdown.includes("## Attempts")
      && !visibleMarkdown.includes("**Grounding:**")
      && !visibleMarkdown.includes("**Basis:**")
      && !visibleMarkdown.includes("**Expected evidence:**")
      && visibleMarkdown.includes(privateExamResponse),
    `status=${exam?.status}; score=${exam?.earnedPoints}/${exam?.maxPoints}; breakdown=${exam?.breakdown?.length}; stateGrounding=${groundingInState.join(",")}; storedQuestionEntries=${storedQuestionEntries}; visibleQuestionEntries=${visibleQuestionEntries}; markdownLength=${visibleMarkdown.length}; attempts=${visibleMarkdown.includes("## Attempts")}; grounding=${visibleMarkdown.includes("**Grounding:**")}; evidence=${visibleMarkdown.includes("**Expected evidence:**")}; visibleRawResponse=${visibleMarkdown.includes(privateExamResponse)}`,
  );

  initTheme("dark");
  const quizDefinition = extension.tools.get("scholar_quiz")?.definition;
  const plainTheme = { fg: (_role, value) => value, bold: (value) => value };
  const secretRejectedQuestion = "THIS REJECTED QUESTION MUST NOT RENDER";
  const quizCallText = quizDefinition
    ? quizDefinition.renderCall({ question: secretRejectedQuestion, options: [{}, {}] }, plainTheme).render(120).join("\n")
    : "missing quiz";
  const quizBlockText = quizDefinition
    ? quizDefinition.renderResult(
      { content: [{ type: "text", text: "Scholar blocked this question before presentation." }], details: {} },
      { expanded: false, isPartial: false },
      plainTheme,
    ).render(120).join("\n")
    : "missing quiz";
  check(
    "quiz preflight UI hides rejected question text and explains the block",
    quizDefinition
      && quizCallText.includes("validating grounding")
      && !quizCallText.includes(secretRejectedQuestion)
      && quizBlockText.includes("blocked this question")
      && !quizBlockText.includes("undefined"),
    `call=${JSON.stringify(quizCallText)}; result=${JSON.stringify(quizBlockText)}`,
  );
  const ui = { requestRender: () => {} };
  const component = new ToolExecutionComponent(
    "scholar",
    "read-ui-contract",
    { action: "read", startPage: 13, endPage: 20 },
    { showImages: false },
    definition,
    ui,
    root,
  );
  component.markExecutionStarted();
  component.setArgsComplete();
  component.updateResult({
    content: [{ type: "text", text: "synthetic source text" }],
    details: { action: "read", summary: "Read PDF pages 13-20" },
  }, false);
  const rendered = component.render(120).map((line) => stripTerminalSequences(line));
  const visible = rendered.filter((line) => line.trim().length > 0);
  const joined = visible.join("\n");
  check(
    "compact read through Pi shell",
    definition.renderShell === "self"
      && rendered.length <= 2
      && visible.length === 1
      && (joined.match(/13–20/g) || []).length === 1
      && !joined.includes("Read PDF pages"),
    `shell=${definition.renderShell || "default"}; rows=${rendered.length}; nonblank=${visible.length}; text=${JSON.stringify(joined.trim())}`,
  );

  const validationRoles = [];
  definition.renderResult(
    { content: [{ type: "text", text: "review" }], details: { action: "outline_validate", summary: "Outline review", tone: "review" } },
    { expanded: false, isPartial: false },
    { fg: (role, value) => { validationRoles.push(role); return value; }, bold: (value) => value },
    { isError: false },
  );
  check(
    "recoverable outline findings render as review, not errors",
    validationRoles.includes("warning") && !validationRoles.includes("error"),
    `roles=${validationRoles.join(",")}`,
  );

  const quietRetry = definition.renderResult(
    { content: [{ type: "text", text: "retry" }], details: { action: "assess", summary: "Scholar retry: correct the request", tone: "retry" } },
    { expanded: false, isPartial: false },
    { fg: (_role, value) => value, bold: (value) => value },
    { isError: false },
  ).render(120).join("").trim();
  const visibleFailureRoles = [];
  definition.renderResult(
    { content: [{ type: "text", text: "failure" }], details: { action: "read", summary: "Scholar error: PDF source changed", tone: "error" } },
    { expanded: false, isPartial: false },
    { fg: (role, value) => { visibleFailureRoles.push(role); return value; }, bold: (value) => value },
    { isError: false },
  );
  check(
    "expected tool corrections stay quiet while true failures remain visible",
    quietRetry === "" && visibleFailureRoles.includes("error"),
    `retry=${JSON.stringify(quietRetry)}; failureRoles=${visibleFailureRoles.join(",")}`,
  );

  check(
    "single setup-status statement",
    (setupStatus.match(/outline pending/gi) || []).length === 1
      && !/no mode(?: is)? active/gi.test(setupStatus),
    JSON.stringify(setupStatus),
  );
} finally {
  await rm(root, { recursive: true, force: true });
  for (const name of environmentNames) {
    const value = originalEnvironment[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

const failures = checks.filter((item) => !item.passed);
console.log(`\n${checks.length - failures.length}/${checks.length} UI contract checks passed.`);
if (failures.length) process.exitCode = 1;
