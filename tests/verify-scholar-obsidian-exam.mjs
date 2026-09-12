import { extensionPath as packagedExtensionPath, piPackageRoot as sdkRoot, jitiPath as sdkJitiPath, resolvePiDependency } from "./sdk.mjs";
// Isolated acceptance gate: edit an Obsidian paper, explicitly submit in Pi,
// preserve the frozen submission and reconstruct its saved grading report.
// Every write and cleanup is confined to this verifier's fresh temporary root.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile, rename } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const piRoot = sdkRoot;
const piRequire = createRequire(join(piRoot, "package.json"));
const { createJiti } = await import(pathToFileURL(sdkJitiPath).href);
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: {
  "@earendil-works/pi-coding-agent": join(piRoot, "dist", "index.js"),
  "@earendil-works/pi-tui": piRequire.resolve("@earendil-works/pi-tui"),
  typebox: piRequire.resolve("typebox"),
} });
const extension = dirname(process.env.PI_SCHOLAR_EXTENSION || packagedExtensionPath);
const mod = (path) => jiti.import(join(extension, path));
const { examFormFingerprint, examAnswerProgress, parseExamResponses, validateExamAnswerNote } = await mod("exam.ts");
const { examAnswerNoteText } = await mod("render/assessment.ts");
const { ensureExamAnswerNote, readExamAnswerNote } = await mod("exam-paper.ts");
const { examAnswerNotePath, examNotePath, answerKeyNotePath, snapshotAssetPath } = await mod("obsidian-paths.ts");
const { createScholarToolController } = await mod("tool-controller.ts");
const { ScholarRuntimeCoordinator } = await mod("runtime-coordinator.ts");
const { handleScholarCommand } = await mod("commands.ts");
const { parseScholarCommand, getScholarArgumentCompletions } = await mod("command-syntax.ts");
const { createBookService } = await mod("book-service.ts");
const storage = await mod("storage.ts");
const { readExamDocument } = await mod("note-records.ts");
const { freezeRecoveryTarget } = await mod("transcript-recovery.ts");

const root = await mkdtemp(join(tmpdir(), "scholar-obsidian-exam-"));
const timestamp = "2026-01-01T00:00:00.000Z";
const PRIVATE_ANSWER = "LEARNER_OWNED_ANSWER: Assume loss is negligible.\n\n$$Z_0=\\sqrt{L/C}$$\n\nThen check the units.";
const answers = { q1: "b", q2: "a, b", q3: PRIVATE_ANSWER };
function answerText(text, values) {
  for (const [id, response] of Object.entries(values)) {
    const start = `<!-- scholar:answer:${id}:start -->`, end = `<!-- /scholar:answer:${id}:end -->`;
    const first = text.indexOf(start), last = text.indexOf(end);
    assert.ok(first >= 0 && last > first, `fixture answer region ${id}`);
    const region = text.slice(first + start.length, last);
    if (region.includes("scholar:choice:")) {
      const wanted = new Set(response.split(",").map((value) => value.trim()).filter(Boolean));
      const found = new Set();
      const edited = region.replace(/^- \[[ xX]\] \*\*([^\n]+?)\*\*(.*<!-- scholar:choice:\d+ -->)$/gm, (_row, value, rest) => {
        if (wanted.has(value)) found.add(value);
        return `- [${wanted.has(value) ? "x" : " "}] **${value}**${rest}`;
      });
      assert.deepEqual(found, wanted, `fixture selected values for ${id} exist`);
      text = `${text.slice(0, first + start.length)}${edited}${text.slice(last)}`;
    } else {
      text = `${text.slice(0, first + start.length)}\n${response}\n${text.slice(last)}`;
    }
  }
  return text;
}
function fixture(config, status = "active") {
  const id = "e".repeat(64);
  const section = { id: "s1", number: "1.1", order: 1, title: "Models", startPage: 1, endPage: 2, status: "not-started",
    objectives: [], coveredObjectives: [], requiredChecks: ["conceptual"], keyPoints: [], misconceptions: [], attempts: [], transcript: [],
    snapshots: [{ id: "snapshot-bbbbbbbbbbbbbbbb", page: 1, crop: { x: 0, y: 0, width: 600, height: 300, canvasWidth: 1000, canvasHeight: 1400 },
      assetFile: "p0001-snapshot-bbbbbbbbbbbbbbbb.png", sha256: "b".repeat(64), caption: "Source timescales", createdAt: timestamp }],
    createdAt: timestamp, updatedAt: timestamp };
  const mcq = { id: "q1", sectionIds: ["s1"], claim: "Chooses a model", requiredEvidence: ["Compares timescales"], dimensions: ["Model selection"],
    format: "multiple-choice", prompt: "Which model applies?", options: [
      { value: "a", label: "Lumped circuit", misconception: "Ignores propagation delay" },
      { value: "b", label: "Transmission line" },
      { value: "c", label: "Static conductor", misconception: "Ignores changing fields" }],
    correctAnswer: "b", explanation: "GOLD_KEY_PRIVATE: Compare flight and rise times.", maxPoints: 2 };
  const questions = [mcq, { ...structuredClone(mcq), id: "q2", prompt: "Select every suitable assumption.", correctAnswer: ["a", "b"] },
    { id: "q3", sectionIds: ["s1"], claim: "Derives impedance", requiredEvidence: ["Assumptions", "Derivation"], dimensions: ["Reasoning"],
      format: "open", prompt: "Derive $Z_0=\\sqrt{L/C}$ and state its assumptions.", rubric: [
        { id: "r1", criterion: "States lossless conditions", requiredEvidence: ["Negligible loss"], points: 2 },
        { id: "r2", criterion: "Derives the relation", requiredEvidence: ["Correct relation"], points: 3 }],
      explanation: "GOLD_OPEN_PRIVATE: Use the lossless telegrapher equations.", maxPoints: 5 }];
  const exam = { id: "exam-001", title: "Exam 01 — Models", scope: { chapterIds: ["c1"], sectionIds: ["s1"], description: "Chapter 1" },
    status, questions: status === "draft" ? [] : questions, rawResponses: [], itemResults: [], breakdown: [], earnedPoints: 0,
    maxPoints: status === "draft" ? 0 : 9, percent: 0, transcript: [], createdAt: timestamp, updatedAt: timestamp,
    ...(status === "draft" ? {} : { startedAt: timestamp }) };
  return { schemaVersion: 3, revision: 0, id, instanceId: "obsidian-exam-fixture", source: {
    absolutePath: join(config.libraryRoot, "fixture.pdf"), relativePath: "fixture.pdf", fileName: "fixture.pdf", format: "pdf",
    fingerprint: { sha256: id, size: 1, mtimeMs: 1 } }, metadata: { title: "Obsidian exam fixture", authors: [], pageCount: 2 },
    outlineStatus: "ready", noteDirectory: "Obsidian exam fixture", chapters: [{ id: "c1", number: "1", order: 1, title: "Models", startPage: 1, endPage: 2,
      status: "not-started", sections: [section] }], exams: [exam], currentExamId: exam.id, tutorSessions: [], createdAt: timestamp, updatedAt: timestamp };
}
let sequence = 0;
async function harness(label, options = {}) {
  const folder = join(root, `${++sequence}-${label}`);
  const config = { schemaVersion: 3, libraryRoot: join(folder, "library"), obsidianRoot: join(folder, "vault"), stateRoot: join(folder, "bootstrap"), updatedAt: timestamp };
  await Promise.all([mkdir(config.libraryRoot, { recursive: true }), mkdir(config.obsidianRoot, { recursive: true })]);
  let book = fixture(config, options.status);
  options.customize?.(book);
  config.currentBookId = book.id;
  await writeFile(book.source.absolutePath, "%PDF-fixture");
  await storage.createBookState(config, book);
  const notices = [], confirmations = [], sent = [], branch = [], tools = new Map(), locks = new Set();
  let activeTools = [];
  const pi = { getActiveTools: () => [...activeTools], setActiveTools: (names) => { activeTools = [...names]; }, registerTool: (definition) => tools.set(definition.name, definition),
    appendEntry: (customType, data) => branch.push({ type: "custom", id: `entry-${branch.length}`, customType, data }),
    sendMessage: (message, sendOptions) => {
      const saved = { exams: [readExamDocument(readFileSync(examNotePath(config, book, book.exams[0]), "utf8"))] };
      sent.push({ message, options: sendOptions, savedStatus: saved.exams[0].status });
      if (options.failSend) throw new Error("simulated model transport failure");
    },
  };
  const acquire = (_ctx, label) => { const lock = { label }; locks.add(lock); return () => locks.delete(lock); };
  const coordinator = new ScholarRuntimeCoordinator(pi, acquire, () => locks.clear());
  coordinator.setConfig(config);
  // The selected fixture config replaces only the OS bootstrap lookup, keeping
  // the real command, coordinator, serialized mutation, and note projection.
  coordinator.loadFreshConfig = async () => coordinator.getConfig();
  if (options.projectionFailure) {
    const service = createBookService({ getConfig: () => coordinator.getConfig(), load: storage.loadBookState, save: storage.saveBookState,
      list: storage.listBookStates, project: async () => { throw new Error("simulated note projection failure"); }, onSave: () => {}, librarySetupMessage: "Configure library" });
    coordinator.bookService = service; coordinator.mutateBook = service.mutateBook; coordinator.renderAll = service.renderAll;
  }
  const context = { hasUI: true, isIdle: () => true, cwd: folder,
    sessionManager: { getBranch: () => branch, getEntries: () => branch, getSessionId: () => label, getSessionFile: () => join(folder, "session.jsonl") },
    ui: { notify: (message, level) => notices.push({ message, level }), setStatus() {}, setWorkingMessage() {},
      editor: async () => { throw new Error("terminal exam editor must never be opened"); },
      input: async () => { throw new Error("submission must not fall through to scope input"); },
      select: async (_title, options) => options[0],
      confirm: async (title, message) => { confirmations.push({ title, message, locks: locks.size }); return false; },
    } };
  coordinator.toolController = createScholarToolController({ pi, session: coordinator.runtimeSession, getConfig: () => coordinator.getConfig(),
    loadBook: (id) => storage.loadBookState(coordinator.getConfig(), id), mutateBook: (id, mutator) => coordinator.mutateBook(id, mutator),
    isActiveAuthority: (state) => coordinator.ownsActiveAuthority(state), isSetupActive: () => false,
  });
  await coordinator.activateBook(book, context, "exam", book.exams[0].id);
  const current = async () => storage.loadBookState(config, book.id);
  const paperPath = examAnswerNotePath(config, book, book.exams[0]);
  const show = () => coordinator.toolController.presentExam(book.id, book.exams[0].id, context);
  const submit = () => coordinator.toolController.submitExam(book.id, book.exams[0].id, context);
  const confirm = (handler = async () => true) => { context.ui.confirm = async (title, message) => {
    confirmations.push({ title, message, locks: locks.size }); return handler(title, message);
  }; };
  const fill = async (values = answers) => { await show(); const text = answerText(await readFile(paperPath, "utf8"), values); await writeFile(paperPath, text); return text; };
  const finishTurn = () => { coordinator.scholarTurnRun?.releaseInput(); coordinator.scholarTurnRun = undefined; };
  const restart = async () => {
    finishTurn(); coordinator.deactivateSession();
    const fresh = new ScholarRuntimeCoordinator(pi, acquire, () => locks.clear());
    fresh.setConfig(structuredClone(config)); fresh.loadFreshConfig = async () => fresh.getConfig();
    fresh.toolController = createScholarToolController({ pi, session: fresh.runtimeSession, getConfig: () => fresh.getConfig(),
      loadBook: (id) => storage.loadBookState(fresh.getConfig(), id), mutateBook: (id, mutator) => fresh.mutateBook(id, mutator),
      isActiveAuthority: (state) => fresh.ownsActiveAuthority(state), isSetupActive: () => false });
    await fresh.activateBook(await current(), context);
    return fresh;
  };
  return { book, config, coordinator, context, current, notices, confirmations, sent, tools, branch, locks, paperPath, show, submit, confirm, fill, finishTurn,
    restart,
    command: (args) => handleScholarCommand(args, context, coordinator),
    execute: (args) => tools.get("scholar").execute("exam-acceptance", args, undefined, undefined, context),
  };
}
async function exists(path) { return stat(path).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; }); }
let passed = 0, failed = 0, skipped = 0;
async function check(name, run) { try { await run(); passed++; console.log(`[PASS] ${name}`); } catch (error) { failed++; console.error(`[FAIL] ${name}: ${error.stack || error.message}`); } }

try {
  await check("paper renders single choice, select-all, open math, blank markers and no key", async () => {
    const h = await harness("render"); const exam = h.book.exams[0];
    const text = examAnswerNoteText(h.config, h.book, exam);
    assert.match(text, /^answer_format: checkboxes-v1$/m); assert.match(text, /select all/i); assert.match(text, /Click the checkboxes/);
    assert.equal((text.match(/^- \[ \] .*<!-- scholar:choice:\d+ -->$/gm) || []).length, 6);
    assert.doesNotMatch(text, /^- \[[xX]\]/m);
    assert.ok(text.includes(exam.questions[2].prompt));
    assert.ok(text.includes('/scholar exam "exam-001" submit'));
    assert.doesNotMatch(text, /GOLD_KEY_PRIVATE|GOLD_OPEN_PRIVATE|States lossless conditions/);
    assert.deepEqual(examAnswerProgress(exam, text), { ok: true, total: 3, answered: 0, blank: ["q1", "q2", "q3"] });
    const filled = answerText(text, answers); validateExamAnswerNote(h.book, exam, filled);
    assert.deepEqual(parseExamResponses(exam, filled), Object.entries(answers).map(([questionId, response]) => ({ questionId, response })));
    assert.deepEqual(examAnswerProgress(exam, filled), { ok: true, total: 3, answered: 3, blank: [] });
    const imagePath = snapshotAssetPath(h.config, h.book, h.book.chapters[0].sections[0].snapshots[0]);
    const embeds = [...text.matchAll(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)].map((match) => match[1]);
    assert.ok(embeds.some((link) => resolve(dirname(h.paperPath), link) === resolve(imagePath)), "source figure link resolves relative to answer paper");
    assert.equal(examFormFingerprint(exam), examFormFingerprint(structuredClone(exam)));
    assert.notEqual(examFormFingerprint(exam), examFormFingerprint({ ...exam, questions: exam.questions.map((q, i) => i ? q : { ...q, prompt: "Changed prompt" }) }));
  });

  await check("checkboxes accept uppercase X and select-all, preserve open Markdown, and unchecking restores blanks", async () => {
    const h = await harness("checkbox-roundtrip"), exam = h.book.exams[0], text = examAnswerNoteText(h.config, h.book, exam);
    const filled = answerText(text, answers).replace(/^- \[x\]/gm, "- [X]").replace(/\n/g, "\r\n");
    validateExamAnswerNote(h.book, exam, filled);
    assert.deepEqual(parseExamResponses(exam, filled), Object.entries(answers).map(([questionId, response]) => ({
      questionId, response: response.replace(/\n/g, "\r\n"),
    })));
    const cleared = answerText(answerText(text, answers), { q1: "", q2: "", q3: "" });
    assert.deepEqual(examAnswerProgress(exam, cleared), { ok: true, total: 3, answered: 0, blank: ["q1", "q2", "q3"] });
    assert.equal((cleared.match(/^- \[ \] .*<!-- scholar:choice:\d+ -->$/gm) || []).length, 6, "all unselected choices remain in the paper");
    const selectedAll = answerText(text, { q2: "a, b, c" });
    assert.equal(parseExamResponses(exam, selectedAll)[1].response, "a, b, c", "select-all accepts any subset, even an incorrect one");
  });

  await check("choice markers map to frozen values even if visible values and labels are edited", async () => {
    const h = await harness("checkbox-values"), exam = h.book.exams[0];
    const filled = answerText(examAnswerNoteText(h.config, h.book, exam), { q1: "b", q2: "a, c" })
      .replace("- [x] **b** — Transmission line <!-- scholar:choice:1 -->", "- [x] **invented** — Changed learner label <!-- scholar:choice:1 -->");
    validateExamAnswerNote(h.book, exam, filled);
    assert.deepEqual(parseExamResponses(exam, filled), [
      { questionId: "q1", response: "b" }, { questionId: "q2", response: "a, c" }, { questionId: "q3", response: "" },
    ]);
    const withoutFormat = filled.replace(/^answer_format: checkboxes-v1\r?\n/m, "");
    assert.deepEqual(parseExamResponses(exam, withoutFormat), parseExamResponses(exam, filled), "remaining choice markers retain checkbox semantics");
  });

  await check("missing, duplicate, unknown and malformed choice rows fail before confirmation or save", async () => {
    const h = await harness("checkbox-damage"), exam = h.book.exams[0], text = examAnswerNoteText(h.config, h.book, exam);
    const firstRow = "- [ ] **a** — Lumped circuit <!-- scholar:choice:0 -->";
    const damaged = [
      text.replace(`${firstRow}\n`, ""),
      text.replace(firstRow, `${firstRow}\n${firstRow}`),
      text.replace(firstRow, firstRow.replace(" <!-- scholar:choice:0 -->", " <!-- scholar:choice:2 --> <!-- scholar:choice:0 -->")),
      text.replace("<!-- scholar:choice:0 -->", "<!-- scholar:choice:99 -->"),
      text.replace("<!-- scholar:choice:0 -->", ""),
      text.replace(firstRow, firstRow.replace("[ ]", "[-]")),
      text.replace(/(<!-- scholar:answer:q1:start -->)[\s\S]*?(<!-- \/scholar:answer:q1:end -->)/, "$1\n\n$2"),
      text.replace(/(<!-- scholar:answer:q1:start -->)[\s\S]*?(<!-- \/scholar:answer:q1:end -->)/, "$1\nb\n$2"),
    ];
    await h.show(); h.confirm();
    for (const value of damaged) {
      assert.throws(() => parseExamResponses(exam, value), /choice|checkbox/i);
      assert.equal(examAnswerProgress(exam, value).ok, false);
      await writeFile(h.paperPath, value); await assert.rejects(h.submit, /choice|checkbox/i);
      const saved = (await h.current()).exams[0]; assert.equal(saved.status, "active"); assert.deepEqual(saved.rawResponses, []);
      assert.equal(await readFile(h.paperPath, "utf8"), value, "invalid papers remain learner-owned");
    }
    assert.equal(h.confirmations.length, 0); assert.equal(h.sent.length, 0);
  });

  await check("single-choice rejects multiple checked rows before confirmation", async () => {
    const h = await harness("checkbox-single"), exam = h.book.exams[0];
    const invalid = await h.fill({ q1: "a, b" }); h.confirm();
    assert.throws(() => parseExamResponses(exam, invalid), /select one/i);
    assert.equal(examAnswerProgress(exam, invalid).ok, false);
    await assert.rejects(h.submit, /select one/i);
    assert.equal((await h.current()).exams[0].status, "active"); assert.equal(h.confirmations.length, 0); assert.equal(h.sent.length, 0);
  });

  await check("a quoted answer-format field cannot downgrade damaged checkbox rows to legacy answers", async () => {
    const h = await harness("checkbox-format"), exam = h.book.exams[0];
    for (const format of ['"checkboxes-v1"', "'checkboxes-v1'", "checkboxes-v1  "]) {
      const text = examAnswerNoteText(h.config, h.book, exam).replace("answer_format: checkboxes-v1", `answer_format: ${format}`);
      validateExamAnswerNote(h.book, exam, text);
      const damaged = text.replace(/(<!-- scholar:answer:q1:start -->)[\s\S]*?(<!-- \/scholar:answer:q1:end -->)/, "$1\n\n$2");
      assert.throws(() => parseExamResponses(exam, damaged), /choice|checkbox/i);
      assert.equal(examAnswerProgress(exam, damaged).ok, false);
    }
  });

  await check("legacy text papers still validate, preserve open responses and submit frozen answers", async () => {
    const h = await harness("legacy-paper"), exam = h.book.exams[0];
    // Explicit old-paper fixture: no answer-format field and no choice rows.
    const legacyBlank = examAnswerNoteText(h.config, h.book, exam).replace(/^answer_format: checkboxes-v1\r?\n/m, "")
      .replace(/^- \[ \] .*<!-- scholar:choice:\d+ -->\n/gm, "");
    assert.doesNotMatch(legacyBlank, /answer_format:|scholar:choice:/);
    const legacyPlaceholder = answerText(legacyBlank, { q1: "Write your answer here.", q3: "Write your answer here." });
    assert.ok(parseExamResponses(exam, legacyPlaceholder).every((item) => item.response === ""));
    const filled = answerText(legacyBlank, answers); validateExamAnswerNote(h.book, exam, filled);
    const expected = Object.entries(answers).map(([questionId, response]) => ({ questionId, response }));
    assert.deepEqual(parseExamResponses(exam, filled), expected);
    await h.show(); await writeFile(h.paperPath, filled); h.confirm(); await h.command("exam submit");
    const saved = (await h.current()).exams[0]; assert.equal(saved.status, "submitted"); assert.deepEqual(saved.rawResponses, expected);
    assert.equal(await readFile(h.paperPath, "utf8"), filled); assert.equal(h.sent.length, 1); h.finishTurn();
  });

  await check("strict parser rejects deleted, duplicate, reversed and crossed answer regions without reporting blanks", async () => {
    const h = await harness("markers"), exam = h.book.exams[0], text = examAnswerNoteText(h.config, h.book, exam);
    const start1 = "<!-- scholar:answer:q1:start -->", end1 = "<!-- /scholar:answer:q1:end -->", start2 = "<!-- scholar:answer:q2:start -->", end2 = "<!-- /scholar:answer:q2:end -->";
    const damaged = [text.replace(start1, ""), `${text}\n${start1}`, text.replace(start1, "TEMP").replace(end1, start1).replace("TEMP", end1),
      text.replace(end1, "TEMP").replace(start2, end1).replace("TEMP", start2), `${text}\n<!-- scholar:answer:unknown:start -->\nx\n<!-- /scholar:answer:unknown:end -->`];
    await h.show(); h.confirm();
    for (const value of damaged) {
      assert.throws(() => parseExamResponses(exam, value)); const progress = examAnswerProgress(exam, value); assert.equal(progress.ok, false); assert.ok(progress.problem.length > 10);
      await writeFile(h.paperPath, value); await assert.rejects(h.submit); assert.equal((await h.current()).exams[0].status, "active");
    }
    assert.equal(h.confirmations.length, 0);
  });

  await check("active command opens saved paper without model/editor; repeat-open and projection preserve bytes", async () => {
    const h = await harness("active"); await h.command('exam "exam-001"');
    assert.equal(h.sent.length, 0); assert.equal(h.locks.size, 0); assert.ok(await exists(h.paperPath));
    const filled = await h.fill();
    await h.command('exam "exam-001"'); await h.coordinator.renderAll();
    const target = freezeRecoveryTarget(h.config.obsidianRoot, h.coordinator.runtimeSession, h.coordinator.activeAuthority);
    await h.coordinator.recoverTarget(target, h.context, true);
    assert.equal(await readFile(h.paperPath, "utf8"), filled);
    assert.equal((await h.current()).exams[0].status, "active"); assert.equal(h.sent.length, 0);
    assert.doesNotMatch(await readFile(examNotePath(h.config, h.book, h.book.exams[0]), "utf8"), /LEARNER_OWNED_ANSWER/);
    const fresh = await h.restart(); await handleScholarCommand('exam "exam-001"', h.context, fresh); await fresh.renderAll();
    assert.equal(await readFile(h.paperPath, "utf8"), filled); assert.equal(h.sent.length, 0);
  });

  await check("exam_build ends with active paper and explicit submission, never grading packet or key", async () => {
    const h = await harness("build", { status: "draft" });
    const result = await h.execute({ action: "exam_build", questions: fixture(h.config).exams[0].questions });
    assert.equal((await h.current()).exams[0].status, "active", result.content?.[0]?.text);
    assert.match(result.content[0].text, /paper|Obsidian/i); assert.match(result.content[0].text, /submit/i);
    assert.doesNotMatch(result.content[0].text, /GOLD_|CORRECT VALUE|RUBRIC:|LEARNER RESPONSE|grade .*now/i);
    assert.ok(await exists(h.paperPath)); assert.equal(h.sent.length, 0);
    assert.equal(await exists(answerKeyNotePath(h.config, h.book, h.book.exams[0])), false);
  });

  await check("missing paper cannot submit and active reopen recreates blank paper with recovery warning", async () => {
    const h = await harness("missing"); h.confirm();
    await assert.rejects(h.submit, /missing|not found|ENOENT|paper/i);
    assert.equal((await h.current()).exams[0].status, "active"); assert.equal(h.confirmations.length, 0);
    await h.show(); await h.fill(); await rm(h.paperPath);
    await h.command('exam "exam-001"');
    assert.equal(examAnswerProgress(h.book.exams[0], await readFile(h.paperPath, "utf8")).answered, 0);
    assert.ok(h.notices.some(({ message }) => /cannot.*recover|unrecoverable|not.*recover/i.test(message)), JSON.stringify(h.notices));
  });

  await check("wrong book, instance, exam and stale frozen form never submit or overwrite collided paper", async () => {
    const h = await harness("identity"); const original = await h.fill(); h.confirm(); const exam = h.book.exams[0];
    for (const other of [{ ...h.book, id: "f".repeat(64) }, { ...h.book, instanceId: "another-instance" }]) {
      assert.throws(() => validateExamAnswerNote(other, exam, original));
    }
    assert.throws(() => validateExamAnswerNote(h.book, { ...exam, id: "exam-999" }, original));
    assert.throws(() => validateExamAnswerNote(h.book, { ...exam, questions: exam.questions.slice(1) }, original));
    const collision = original.replace(h.book.instanceId, "wrong-instance"); await writeFile(h.paperPath, collision);
    await assert.rejects(() => ensureExamAnswerNote(h.config, h.book, exam)); await assert.rejects(h.submit);
    assert.equal(await readFile(h.paperPath, "utf8"), collision); assert.equal((await h.current()).exams[0].status, "active");
    assert.equal(h.confirmations.length, 0);
    await writeFile(h.paperPath, original.slice(0, original.lastIndexOf("<!--")));
    await assert.rejects(() => ensureExamAnswerNote(h.config, h.book, exam), /complete|partial|finish/i);
    await assert.rejects(h.submit); assert.equal((await h.current()).exams[0].status, "active");
  });

  await check("exclusive simultaneous creation leaves one complete valid paper", async () => {
    const h = await harness("exclusive"), exam = h.book.exams[0];
    const attempts = await Promise.allSettled(Array.from({ length: 5 }, () => ensureExamAnswerNote(h.config, h.book, exam)));
    const successes = attempts.filter((result) => result.status === "fulfilled").map((result) => result.value);
    assert.equal(successes.filter((result) => result.created).length, 1);
    assert.ok(successes.length >= 1);
    validateExamAnswerNote(h.book, exam, (await readExamAnswerNote(h.config, h.book, exam)).text);
    const bytes = await h.fill(); await ensureExamAnswerNote(h.config, h.book, exam); assert.equal(await readFile(h.paperPath, "utf8"), bytes);
  });

  await check("unsafe note directory and directory junction escape cannot read or create an answer paper", async () => {
    const h = await harness("confinement"), exam = h.book.exams[0], unsafe = { ...h.book, noteDirectory: "../../outside" };
    await assert.rejects(async () => ensureExamAnswerNote(h.config, unsafe, exam));
    const bytes = examAnswerNoteText(h.config, h.book, exam), outsideDir = join(root, "outside-papers");
    await mkdir(outsideDir); const outside = join(outsideDir, basename(h.paperPath)); await writeFile(outside, bytes);
    await mkdir(dirname(dirname(h.paperPath)), { recursive: true });
    await rename(dirname(h.paperPath), dirname(h.paperPath) + "-safe-fixture");
    await symlink(outsideDir, dirname(h.paperPath), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(() => readExamAnswerNote(h.config, h.book, exam));
    await assert.rejects(() => ensureExamAnswerNote(h.config, h.book, exam)); assert.equal(await readFile(outside, "utf8"), bytes);
  });

  await check("changing book instance, frozen form, or selected vault during confirmation prevents submission", async () => {
    for (const change of ["instance", "form", "vault"]) {
      const h = await harness(`stale-${change}`); await h.fill();
      h.confirm(async () => {
        if (change === "vault") h.coordinator.setConfig({ ...h.config, obsidianRoot: join(root, "different-selected-vault") });
        else await h.coordinator.mutateBook(h.book.id, (state) => {
          if (change === "instance") state.instanceId = "replacement-instance";
          else state.exams[0].questions[0].prompt = "Changed frozen question";
        });
        return true;
      });
      await h.command("exam submit");
      assert.equal((await h.current()).exams[0].status, "active"); assert.deepEqual((await h.current()).exams[0].rawResponses, []);
      assert.equal(h.sent.length, 0); assert.equal(h.locks.size, 0);
    }
  });

  await check("oversized and invalid UTF-8 answer papers fail before confirmation without rewriting", async () => {
    const h = await harness("bounded"); await h.show(); h.confirm();
    for (const bytes of [Buffer.alloc(1024 * 1024 + 1, "x"), Buffer.from([0xff, 0xfe, 0x00])]) {
      await writeFile(h.paperPath, bytes); await assert.rejects(h.submit);
      assert.deepEqual(await readFile(h.paperPath), bytes); assert.equal((await h.current()).exams[0].status, "active");
    }
    assert.equal(h.confirmations.length, 0); assert.equal(h.sent.length, 0);
  });

  for (const command of ["exam submit", 'exam "exam-001" submit']) {
    await check(`${command} confirms even one eligible exam, and cancellation changes no state or paper`, async () => {
      const h = await harness("cancel"); const filled = await h.fill({ q1: "b" }); const before = await h.current();
      await h.command(command);
      assert.equal(h.confirmations.length, 1, JSON.stringify(h.notices));
      const confirmation = h.confirmations[0]; const text = `${confirmation.title}\n${confirmation.message}`;
      assert.match(text, /Exam 01/); assert.match(text, /1\s*\/\s*3|1 of 3|1 answered.*3|3 questions.*1 answered/i); assert.match(text, /q2/); assert.match(text, /q3/);
      assert.match(text, /Submitting is final/); assert.match(text, /Blank answers receive 0 points/); assert.ok(confirmation.locks > 0);
      assert.deepEqual(await h.current(), before); assert.equal(await readFile(h.paperPath, "utf8"), filled); assert.equal(h.sent.length, 0); assert.equal(h.locks.size, 0);
    });
  }

  await check("edits during confirmation require fresh confirmation and declining keeps state active", async () => {
    const h = await harness("changed"); await h.fill({ q1: "a" }); let count = 0;
    h.confirm(async () => { count++; if (count === 1) { await writeFile(h.paperPath, answerText(await readFile(h.paperPath, "utf8"), { q1: "b", q2: "a, b" })); return true; } return false; });
    await h.command('exam "exam-001" submit');
    assert.equal((await h.current()).exams[0].status, "active");
    if (count === 1) { assert.ok(h.notices.some(({ message }) => /changed.*confirm|confirm.*updated/i.test(message))); await h.command('exam "exam-001" submit'); }
    assert.equal(count, 2); assert.match(h.confirmations[1].message, /2\s*\/\s*3|2 of 3|2 answered.*3|3 questions.*2 answered/i);
    assert.equal((await h.current()).exams[0].status, "active"); assert.equal(h.sent.length, 0); assert.equal(h.locks.size, 0);
  });

  await check("accepted changed-paper confirmation freezes its newest snapshot and starts grading after durable save", async () => {
    const h = await harness("freeze"); await h.fill({ q1: "a", q3: PRIVATE_ANSWER }); let confirmations = 0;
    h.confirm(async () => { if (++confirmations === 1) await writeFile(h.paperPath, answerText(await readFile(h.paperPath, "utf8"), { q1: "b" })); return true; });
    await h.command("exam submit");
    if (confirmations === 1) { assert.equal((await h.current()).exams[0].status, "active"); assert.equal(h.sent.length, 0); await h.command("exam submit"); }
    const submitted = await h.current();
    assert.equal(confirmations, 2); assert.equal(submitted.exams[0].status, "submitted"); assert.ok(submitted.exams[0].submittedAt);
    assert.equal(submitted.exams[0].rawResponses[0].response, "b"); assert.equal(submitted.exams[0].rawResponses[1].response, "");
    assert.equal(h.sent.length, 1); assert.ok(h.sent[0].options.triggerTurn); assert.equal(h.sent[0].savedStatus, "submitted");
    assert.ok(h.locks.size > 0, "generation lock remains after navigation releases");
    await writeFile(h.paperPath, answerText(await readFile(h.paperPath, "utf8"), { q1: "c", q2: "c", q3: "later edit" }));
    h.finishTurn(); await h.command('exam "exam-001" submit');
    assert.deepEqual((await h.current()).exams[0].rawResponses, submitted.exams[0].rawResponses); assert.equal(h.confirmations.length, 2);
    h.finishTurn();
  });

  await check("concurrent submit commits one response snapshot with no second confirmation or overwrite", async () => {
    const h = await harness("concurrent"); await h.fill(); let releaseConfirmation, confirmEntered;
    const entered = new Promise((resolve) => { confirmEntered = resolve; });
    h.confirm(async () => { confirmEntered(); return new Promise((resolve) => { releaseConfirmation = resolve; }); });
    const first = h.command("exam submit"); await entered; await h.command('exam "exam-001" submit'); releaseConfirmation(true); await first;
    assert.equal(h.confirmations.length, 1); assert.equal((await h.current()).revision, 1); assert.equal(h.sent.length, 1);
    assert.deepEqual((await h.current()).exams[0].rawResponses, Object.entries(answers).map(([questionId, response]) => ({ questionId, response })));
    h.finishTurn();
  });

  await check("concurrent Pi runtimes with separate navigation locks persist at most one submission", async () => {
    const h = await harness("concurrent-runtimes"); await h.fill(); const second = await h.restart();
    let ready, waiting = [];
    const bothConfirmed = new Promise((resolve) => { ready = resolve; });
    h.confirm(async () => new Promise((resolve) => { waiting.push(resolve); if (waiting.length === 2) ready(); }));
    const firstSubmit = h.command('exam "exam-001" submit');
    const secondSubmit = handleScholarCommand('exam "exam-001" submit', h.context, second);
    await bothConfirmed; for (const finish of waiting) finish(true); await Promise.all([firstSubmit, secondSubmit]);
    assert.equal((await h.current()).revision, 1); assert.equal(h.sent.length, 1); assert.equal(h.sent[0].savedStatus, "submitted");
    assert.deepEqual((await h.current()).exams[0].rawResponses, Object.entries(answers).map(([questionId, response]) => ({ questionId, response })));
    h.finishTurn(); second.scholarTurnRun?.releaseInput();
  });

  await check("unknown and ambiguous submit targets never create exams or ask for scope", async () => {
    const h = await harness("targets", { customize: (book) => { const second = structuredClone(book.exams[0]); second.id = "exam-002"; second.title = "Exam 02 — Models"; book.exams.push(second); } });
    const before = await h.current(); await h.command('exam "nonexistent" submit'); await h.command('exam "Exam" submit');
    assert.deepEqual(await h.current(), before); assert.equal(h.sent.length, 0); assert.equal(h.confirmations.length, 0);
    assert.ok(h.notices.some(({ message }) => /ambiguous|more than one|multiple.*match/i.test(message)), JSON.stringify(h.notices));
    assert.ok(!h.notices.some(({ message }) => /scope input/.test(message)));
  });

  await check("quoted submit title reopens by name, and command completion offers submission", async () => {
    const h = await harness("quotes", { customize: (book) => { book.exams[0].title = "Please submit"; } });
    await h.command('exam "Please submit"'); assert.equal(h.confirmations.length, 0); assert.equal(h.sent.length, 0); assert.ok(await exists(h.paperPath));
    assert.notDeepEqual(parseScholarCommand('exam "submit"'), parseScholarCommand("exam submit"));
    const completions = await getScholarArgumentCompletions("exam ", () => h.config, h.book.id);
    assert.ok(completions.some((item) => /submit/.test(item.value))); assert.ok(completions.some((item) => item.value === 'exam "exam-001"'));
  });

  await check("projection failure after submission reports saved submission and starts recoverable grading", async () => {
    const h = await harness("projection-failure", { projectionFailure: true }); await h.fill({ q1: "b" }); h.confirm();
    await h.command("exam submit"); assert.equal((await h.current()).exams[0].status, "submitted"); assert.equal(h.sent.length, 1);
    assert.ok(h.notices.some(({ message }) => /submission saved/i.test(message) && /pending/i.test(message)), JSON.stringify(h.notices));
    assert.ok(!h.notices.some(({ message }) => /submission failed/i.test(message))); h.finishTurn();
  });

  await check("a failed grading kickoff retains the submission and releases both locks", async () => {
    const h = await harness("kickoff-failure", { failSend: true }); await h.fill(); h.confirm(); await h.command("exam submit");
    assert.equal((await h.current()).exams[0].status, "submitted"); assert.equal(h.locks.size, 0);
    assert.ok(h.notices.some(({ message }) => /submission is saved/i.test(message) && /could not start/i.test(message)));
    assert.equal(h.sent[0].savedStatus, "submitted");
  });

  await check("blank grades are deterministic zero with no inferred misconception and attempted partial credit stays intact", async () => {
    const h = await harness("grade"); const filled = await h.fill({ q1: "b", q3: PRIVATE_ANSWER }); h.confirm(); await h.command("exam submit");
    const grading = await h.execute({ action: "exam_grade", itemResults: [
      { questionId: "q1", outcome: "correct", earnedPoints: 2, maxPoints: 2, feedback: "Compares the relevant timescales." },
      { questionId: "q2", outcome: "correct", earnedPoints: 2, maxPoints: 2, feedback: "MODEL_INVENTED_BLANK_FEEDBACK", firstDecisiveError: "MODEL_INVENTED_MISCONCEPTION" },
      { questionId: "q3", outcome: "partial", earnedPoints: 3, maxPoints: 5, feedback: "The relation is derived but its validity condition is incomplete." },
    ] });
    const saved = await h.current(), exam = saved.exams[0]; assert.equal(exam.status, "graded", grading.content[0].text);
    assert.equal(exam.earnedPoints, 5); assert.equal(exam.maxPoints, 9); assert.equal(exam.itemResults[1].outcome, "unanswered"); assert.equal(exam.itemResults[1].earnedPoints, 0);
    assert.doesNotMatch(JSON.stringify(exam.itemResults[1]), /MODEL_INVENTED/); assert.equal(exam.itemResults[2].earnedPoints, 3);
    assert.equal(exam.breakdown.find((item) => item.key === "section:s1").maxPoints, 9); assert.equal(await readFile(h.paperPath, "utf8"), filled);
    h.finishTurn(); const before = structuredClone(exam), keyPath = answerKeyNotePath(h.config, saved, exam); assert.ok(await exists(keyPath)); await rm(keyPath);
    const sends = h.sent.length; await h.command('exam "exam-001"');
    assert.equal(h.sent.length, sends); assert.ok(await exists(keyPath)); assert.deepEqual((await h.current()).exams[0], before);
    assert.equal(await readFile(h.paperPath, "utf8"), filled); assert.doesNotMatch(await readFile(keyPath, "utf8"), /LEARNER_OWNED_ANSWER/);
  });

  await check("saved submission resumes grading after restart without requiring or recreating its deleted paper", async () => {
    const h = await harness("restart"); await h.fill(); h.confirm(); await h.command("exam submit"); h.finishTurn();
    const before = (await h.current()).exams[0]; await rm(h.paperPath); const fresh = await h.restart();
    await handleScholarCommand('exam "exam-001"', h.context, fresh); assert.equal(h.sent.length, 2); assert.equal(await exists(h.paperPath), false);
    assert.deepEqual((await h.current()).exams[0], before); fresh.scholarTurnRun?.releaseInput();
  });

  await check("a damaged active paper does not block another exam's saved answer-key repair", async () => {
    const h = await harness("independent-key-repair", { customize: (book) => {
      const graded = structuredClone(book.exams[0]); graded.id = "exam-002"; graded.title = "Previously graded exam";
      graded.status = "graded"; graded.submittedAt = timestamp; graded.gradedAt = timestamp;
      graded.rawResponses = Object.entries(answers).map(([questionId, response]) => ({ questionId, response }));
      graded.itemResults = graded.questions.map((question) => ({ questionId: question.id, outcome: "correct", earnedPoints: question.maxPoints, maxPoints: question.maxPoints, feedback: "The required evidence is established." }));
      graded.breakdown = [{ key: "section:s1", label: "Models", earnedPoints: 9, maxPoints: 9, percent: 100 },
        { key: "dimension:Model selection", label: "Model selection", earnedPoints: 4, maxPoints: 4, percent: 100 },
        { key: "dimension:Reasoning", label: "Reasoning", earnedPoints: 5, maxPoints: 5, percent: 100 }];
      graded.earnedPoints = 9; graded.percent = 100; book.exams.push(graded);
    } });
    const filled = await h.fill(); await h.coordinator.renderAll();
    const damaged = filled.replace("<!-- scholar:answer:q1:start -->", "deleted answer marker"); await writeFile(h.paperPath, damaged);
    const before = (await h.current()).exams[1], keyPath = answerKeyNotePath(h.config, h.book, before); await rm(keyPath);
    await h.command('exam "exam-002"');
    assert.ok(await exists(keyPath), JSON.stringify(h.notices)); assert.equal(h.sent.length, 0); assert.deepEqual((await h.current()).exams[1], before);
    assert.equal(await readFile(h.paperPath, "utf8"), damaged);
    const foreign = "# Unrelated handwritten note\nDo not replace this file.\n";
    await writeFile(keyPath, foreign);
    await h.command('exam "exam-002"');
    assert.equal(await readFile(keyPath, "utf8"), foreign);
    assert.ok(h.notices.some(({ message }) => /unrelated note/.test(message)), JSON.stringify(h.notices));
    assert.equal(h.sent.length, 0); assert.deepEqual((await h.current()).exams[1], before);
  });
} finally {
  assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith("scholar-obsidian-exam-"));
  await rm(root, { recursive: true, force: true });
}
console.log(`\nScholar obsidian-exam summary: ${passed} passed, ${failed} failed, ${skipped} skipped.`);
process.exitCode = failed ? 1 : 0;
