import { sdkAliases } from "./sdk.mjs";
import { extensionPath as packagedExtensionPath, piPackageRoot as sdkRoot, jitiPath as sdkJitiPath } from "./sdk.mjs";
// Independent Exam/Tutor PDF figures through the real tool, Poppler, and vault
// storage. No model is invoked; every writable path is a disposable fixture.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const piRoot = sdkRoot;
const piRequire = createRequire(join(piRoot, "package.json"));
const { createJiti } = await import(pathToFileURL(sdkJitiPath).href);
const extension = dirname(packagedExtensionPath);
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: { ...sdkAliases,
  "@earendil-works/pi-coding-agent": join(piRoot, "dist", "index.js"),
  "@earendil-works/pi-tui": piRequire.resolve("@earendil-works/pi-tui"),
  typebox: piRequire.resolve("typebox"),
} });
const storage = await jiti.import(join(extension, "storage.ts"));
const { ScholarRuntimeSession } = await jiti.import(join(extension, "runtime-session.ts"));
const { createScholarToolController } = await jiti.import(join(extension, "tool-controller.ts"));
const { snapshotAssetPath, bookNoteDirectory } = await jiti.import(join(extension, "obsidian-paths.ts"));
const render = await jiti.import(join(extension, "render", "assessment.ts"));
const root = await mkdtemp(join(tmpdir(), "scholar-mode-figures-"));
const now = "2026-09-04T12:00:00.000Z";
let passed = 0, failed = 0, nextCase = 0;
const envKeys = ["PI_SCHOLAR_OBSIDIAN_ROOT", "PI_SCHOLAR_LIBRARY_ROOT", "PI_SCHOLAR_STATE_ROOT"];
const oldEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
for (const key of envKeys) delete process.env[key];

function pdfFixture() {
  const streams = Array.from({ length: 4 }, (_, index) => `BT /F1 12 Tf 60 720 Td (Source page ${index + 1}: a diagram connects physical causes to observed behavior.) Tj ET\n60 420 200 80 re S\n260 460 m 400 460 l S\n400 420 100 80 re S\n`);
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R 9 0 R] /Count 4 >>"];
  for (let index = 0; index < streams.length; index++) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 11 0 R >> >> /Contents ${4 + index * 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(streams[index])} >>\nstream\n${streams[index]}endstream`);
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => { const at = Buffer.byteLength(pdf); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; return at; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

async function harness(mode = "exam") {
  const directory = join(root, `case-${++nextCase}`);
  const config = { schemaVersion: 3, libraryRoot: join(directory, "library"), obsidianRoot: join(directory, "vault"), stateRoot: join(directory, "bootstrap"), updatedAt: now };
  await Promise.all([mkdir(config.libraryRoot, { recursive: true }), mkdir(config.obsidianRoot, { recursive: true })]);
  const sourcePath = join(config.libraryRoot, "figures.pdf"), bytes = pdfFixture();
  await writeFile(sourcePath, bytes);
  const fingerprint = { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, mtimeMs: (await stat(sourcePath)).mtimeMs };
  const section = (id, page) => ({ id, title: id, order: page, startPage: page, endPage: page, objectives: [], coveredObjectives: [], requiredChecks: ["conceptual"], status: "not-started", keyPoints: [], misconceptions: [], attempts: [], transcript: [], createdAt: now, updatedAt: now });
  const scope = { chapterIds: ["chapter-1"], sectionIds: ["section-1"], description: "Selected source section" };
  const exam = { id: "exam-1", title: "Source Exam", scope: structuredClone(scope), status: "draft", questions: [], rawResponses: [], itemResults: [], breakdown: [], earnedPoints: 0, maxPoints: 0, percent: 0, transcript: [], createdAt: now, updatedAt: now };
  const tutor = { id: "tutor-1", title: "Source Tutor", scope: structuredClone(scope), status: "active", keyPoints: [], attempts: [], transcript: [], createdAt: now, updatedAt: now };
  const initial = { schemaVersion: 3, revision: 0, id: fingerprint.sha256, instanceId: `fixture-${nextCase}`, source: { absolutePath: sourcePath, relativePath: "figures.pdf", fileName: "figures.pdf", format: "pdf", fingerprint }, metadata: { title: "Independent Figures", authors: [], pageCount: 4 }, outlineStatus: "ready", chapters: [
    { id: "chapter-1", title: "One", order: 1, startPage: 1, endPage: 3, status: "not-started", sections: [section("section-1", 2), section("section-2", 3)] },
    { id: "chapter-2", title: "Two", order: 2, startPage: 4, endPage: 4, status: "not-started", sections: [section("section-3", 4)] },
  ], exams: [exam], tutorSessions: [tutor], noteDirectory: "Books/Independent Figures", createdAt: now, updatedAt: now };
  if (mode === "learn") {
    initial.chapters[0].status = "learning";
    initial.chapters[0].sections[0].status = "learning";
    initial.currentSectionId = "section-1";
  }
  assert.ok(storage.isScholarBook(initial));
  await storage.createBookState(config, initial);
  const session = new ScholarRuntimeSession();
  session.activate(initial.id, mode, mode === "learn" ? "section-1" : mode === "exam" ? exam.id : tutor.id);
  let tool, calls = 0, loads = 0;
  const h = { config, initial, session, sourcePath, beforeMutation: undefined, beforeLoad: undefined };
  h.load = () => storage.loadBookState(config, initial.id);
  h.update = async (mutate) => {
    const state = await h.load(), revision = state.revision;
    await mutate(state);
    await storage.saveBookState(config, state, revision);
  };
  const controller = createScholarToolController({
    pi: { registerTool(definition) { tool = definition; } }, session, getConfig: () => config,
    loadBook: async () => { await h.beforeLoad?.(++loads); return h.load(); },
    mutateBook: async (_bookId, mutate) => {
      await h.beforeMutationLoad?.();
      const state = await h.load();
      if (!state) throw new Error("The selected book authority is missing; refusing to create it from an old capture.");
      const revision = state.revision;
      await h.beforeMutation?.(state);
      const result = await mutate(state);
      await storage.saveBookState(config, state, revision);
      return { book: await h.load(), result };
    },
    isActiveAuthority: (book) => book.instanceId === initial.instanceId && session.bookId === book.id,
    isSetupActive: () => false,
  });
  controller.ensureRegistered();
  h.reset = () => controller.resetTransientState();
  h.execute = (params) => tool.execute(`mode-figure-${++calls}`, params, undefined, undefined, { hasUI: false });
  h.view = async (page = 2) => { const result = await h.execute({ action: "view", page }); success(result); return result.details; };
  h.crop = (view, extra = {}) => h.execute({ action: "snapshot", page: view.page, x: 120, y: 650, width: 800, height: 240, canvasWidth: view.width, canvasHeight: view.height, caption: "Physical causes connect through the source diagram.", ...extra });
  h.record = (book) => mode === "exam" ? book.exams[0] : book.tutorSessions[0];
  return h;
}
function success(result) { assert.ok(!["error", "retry", "review"].includes(result.details.tone), result.content[0].text); }
function refused(result, pattern) { assert.ok(["error", "retry"].includes(result.details.tone), JSON.stringify(result.details)); assert.match(result.content[0].text, pattern); }
async function unchanged(h) { const state = await h.load(); assert.deepEqual(state.chapters, h.initial.chapters); assert.equal(state.currentSectionId, undefined); return state; }
async function check(name, test) {
  try { await test(); passed++; console.log(`[PASS] ${name}`); }
  catch (error) { failed++; console.error(`[FAIL] ${name}: ${error.stack}`); }
}

try {
  for (const mode of ["exam", "tutor"]) {
    await check(`${mode} saves a real crop without prior Learn; metadata and assets survive reload`, async () => {
      const h = await harness(mode), view = await h.view();
      const captured = await h.crop(view);
      success(captured);
      const state = await unchanged(h), record = h.record(state), snapshot = record.snapshots[0];
      assert.ok(storage.isScholarBook(state));
      const image = await readFile(snapshotAssetPath(h.config, state, snapshot));
      assert.equal(createHash("sha256").update(image).digest("hex"), snapshot.sha256);
      const returnedImages = captured.content.filter(item => item.type === "image");
      assert.equal(returnedImages.length, 1, "capture must return the actual saved crop for inspection");
      assert.equal(returnedImages[0].mimeType, "image/png");
      const returnedBytes = Buffer.from(returnedImages[0].data, "base64");
      assert.deepEqual(returnedBytes, image, "model-visible pixels must be the immutable vault asset, not a full page or unrelated preview");
      assert.equal(createHash("sha256").update(returnedBytes).digest("hex"), snapshot.sha256);
      assert.equal(image.readUInt32BE(16), 800); assert.equal(image.readUInt32BE(20), 240);
      const note = mode === "exam" ? render.examAnswerNoteText(h.config, state, record) : render.renderTutorSession(h.config, state, record);
      assert.ok(note.includes(snapshot.assetFile));
      if (mode === "exam") assert.ok(render.renderExam(h.config, state, record).includes(snapshot.assetFile));
      assert.equal((mode === "exam" ? state.tutorSessions[0] : state.exams[0]).snapshots, undefined);
      const reused = await h.crop(view, { caption: "A revised concise source caption." });
      success(reused);
      assert.equal(reused.details.reused, true);
      assert.deepEqual(Buffer.from(reused.content.find(item => item.type === "image").data, "base64"), image, "reused snapshots remain visually inspectable");
      assert.equal(h.record(await h.load()).snapshots.length, 1);
      assert.equal((await readdir(h.config.stateRoot).catch(() => [])).length, 0);
    });
    await check(`${mode} rejects unviewed pages, false canvas sizes, sibling sections, and other chapters`, async () => {
      const h = await harness(mode);
      refused(await h.crop({ page: 2, width: 1391, height: 1800 }), /View this page/);
      const view = await h.view();
      refused(await h.crop(view, { canvasWidth: view.width + 1 }), /intrinsic canvas/);
      for (const page of [3, 4]) {
        refused(await h.execute({ action: "view", page }), /outside the active/);
        refused(await h.crop(view, { page }), /outside the active/);
      }
      assert.equal(h.record(await unchanged(h)).snapshots, undefined);
    });
    await check(`${mode} can capture selected chapter context without section contamination`, async () => {
      const h = await harness(mode), view = await h.view(1);
      success(await h.crop(view));
      const state = await unchanged(h);
      assert.equal(h.record(state).snapshots[0].page, 1);
      assert.ok(storage.isScholarBook(state));
    });
    await check(`${mode} requires a new real view after changing records or switching away and back`, async () => {
      const h = await harness(mode), view = await h.view();
      h.session.activate(h.initial.id, mode, mode === "exam" ? "exam-1" : "tutor-1");
      refused(await h.crop(view), /View this page/);
      const freshView = await h.view(); h.reset();
      refused(await h.crop(freshView), /View this page/);
      const beforeSwitch = await h.view();
      await h.update(state => {
        const records = mode === "exam" ? state.exams : state.tutorSessions;
        records.push({ ...structuredClone(records[0]), id: "another-record" });
      });
      h.session.activate(h.initial.id, mode, "another-record");
      refused(await h.crop(beforeSwitch), /View this page/);
    });
    await check(`${mode} rejects an async activation change before committing a crop`, async () => {
      const h = await harness(mode), view = await h.view();
      h.beforeMutation = () => h.session.activate(h.initial.id, mode === "exam" ? "tutor" : "exam", mode === "exam" ? "tutor-1" : "exam-1");
      refused(await h.crop(view), /record changed/);
      assert.equal(h.record(await unchanged(h)).snapshots, undefined);
    });
    await check(`${mode} rejects an async source-record identity or scope change`, async () => {
      for (const change of [state => { state.instanceId = "new-import"; }, state => { hRecord(state, mode).createdAt = "2026-09-09T12:01:00.000Z"; }, state => { hRecord(state, mode).scope.sectionIds = ["section-2"]; }]) {
        const h = await harness(mode), view = await h.view();
        h.beforeMutation = change;
        refused(await h.crop(view), /record changed/);
        assert.equal(h.record(await unchanged(h)).snapshots, undefined);
      }
    });
    await check(`${mode} rejects view receipts produced after an async mode change`, async () => {
      const h = await harness(mode);
      h.beforeLoad = (count) => { if (count === 2) h.session.activate(h.initial.id); };
      refused(await h.execute({ action: "view", page: 2 }), /record changed/);
      assert.equal(h.record(await unchanged(h)).snapshots, undefined);
    });
    await check(`${mode} rejects a stale actual PDF both before rendering and at commit`, async () => {
      for (const duringCommit of [false, true]) {
        const h = await harness(mode), view = await h.view();
        const alter = async () => writeFile(h.sourcePath, Buffer.concat([pdfFixture(), Buffer.from("\n% changed")]));
        if (duringCommit) h.beforeMutation = alter; else await alter();
        refused(await h.crop(view), /source changed since import/);
        assert.equal(h.record(await unchanged(h)).snapshots, undefined);
      }
    });
  }
  await check("active, submitted, and graded Exams cannot add or revise frozen figures", async () => {
    for (const status of ["active", "submitted", "graded"]) {
      const h = await harness(), view = await h.view();
      h.beforeMutation = state => { state.exams[0].status = status; };
      refused(await h.crop(view), /still a draft/);
      assert.equal((await unchanged(h)).exams[0].snapshots, undefined);
      h.beforeMutation = undefined;
      success(await h.crop(view));
      const snapshots = (await h.load()).exams[0].snapshots;
      await h.update(state => {
        const exam = state.exams[0];
        exam.questions = [{ id: "q1", sectionIds: ["section-1"], claim: "Interpret the source diagram", requiredEvidence: ["Identifies the cause"], dimensions: ["conceptual"], format: "multiple-choice", prompt: "Which element is the cause?", options: [{ value: "a", label: "Input" }, { value: "b", label: "Output" }], correctAnswer: "a", explanation: "The diagram begins with the input.", maxPoints: 1 }];
        exam.status = status; exam.startedAt = now; exam.maxPoints = 1;
        if (status !== "active") { exam.submittedAt = now; exam.rawResponses = [{ questionId: "q1", response: "a" }]; }
        if (status === "graded") {
          exam.gradedAt = now; exam.earnedPoints = 1; exam.percent = 100;
          exam.itemResults = [{ questionId: "q1", outcome: "correct", earnedPoints: 1, maxPoints: 1, feedback: "Identified the source cause." }];
          exam.breakdown = [{ key: "conceptual", label: "Conceptual", earnedPoints: 1, maxPoints: 1, percent: 100 }];
        }
      });
      refused(await h.crop(view, { caption: "A later replacement caption." }), /still a draft/);
      assert.deepEqual((await unchanged(h)).exams[0].snapshots, snapshots);
    }
  });
  await check("closed Tutor rejects both direct and asynchronous figure changes", async () => {
    const h = await harness("tutor"), view = await h.view();
    h.beforeMutation = state => { state.tutorSessions[0].status = "closed"; };
    refused(await h.crop(view), /active Tutor/);
    h.beforeMutation = undefined;
    await h.update(state => { state.tutorSessions[0].status = "closed"; state.tutorSessions[0].closedAt = now; });
    refused(await h.crop(view), /active Tutor/);
    assert.equal((await unchanged(h)).tutorSessions[0].snapshots, undefined);
  });
  await check("free-topic Tutor can capture any valid book page", async () => {
    const h = await harness("tutor");
    await h.update(state => { state.tutorSessions[0].scope = { chapterIds: [], sectionIds: [], description: "Topic" }; });
    success(await h.crop(await h.view(4)));
    assert.ok(storage.isScholarBook(await unchanged(h)));
  });
  await check("a stale PDF at the view receipt boundary cannot authorize a later crop", async () => {
    const h = await harness();
    h.beforeLoad = async count => { if (count === 2) await writeFile(h.sourcePath, Buffer.concat([pdfFixture(), Buffer.from("\n% changed")])); };
    refused(await h.execute({ action: "view", page: 2 }), /source changed since import/);
    assert.equal((await unchanged(h)).exams[0].snapshots, undefined);
  });
  await check("schema rejects malformed, duplicate, and out-of-scope mode snapshots; old v3 records stay valid", async () => {
    const h = await harness(), view = await h.view(); success(await h.crop(view));
    const book = await h.load(); assert.ok(storage.isScholarBook(h.initial));
    for (const change of [
      copy => { copy.exams[0].snapshots.push(structuredClone(copy.exams[0].snapshots[0])); },
      copy => { copy.exams[0].snapshots[0].crop.width = -1; },
      copy => { copy.exams[0].snapshots[0].assetFile = "../escape.png"; },
      copy => { copy.exams[0].snapshots[0].page = 3; },
      copy => { copy.tutorSessions[0].snapshots = structuredClone(copy.exams[0].snapshots); copy.tutorSessions[0].snapshots[0].page = 5; },
      copy => { copy.exams[0].viewed = { width: 1391, height: 1800 }; },
    ]) { const copy = structuredClone(book); change(copy); assert.equal(storage.isScholarBook(copy), false); }
  });
  await check("own and legacy section figure projections are preserved and deduplicated", async () => {
    const h = await harness(), view = await h.view(); success(await h.crop(view));
    const book = await h.load(), own = book.exams[0].snapshots[0];
    const legacy = { ...structuredClone(own), id: "snapshot-0000000000000000", assetFile: "p0002-snapshot-0000000000000000.png", caption: "Legacy section source figure." };
    book.chapters[0].sections[0].snapshots = [structuredClone(own), legacy];
    book.tutorSessions[0].snapshots = [own];
    for (const note of [render.examAnswerNoteText(h.config, book, book.exams[0]), render.renderTutorSession(h.config, book, book.tutorSessions[0])]) {
      assert.equal(note.split(own.assetFile).length - 1, 1);
      assert.ok(note.includes(legacy.assetFile));
    }
  });
  await check("Learn capture rejects async mode, vault, instance, section, and view changes before writing assets", async () => {
    for (const change of ["mode", "vault", "instance", "section", "view", "source"]) {
      const h = await harness("learn"), view = await h.view();
      const originalConfig = { ...h.config }, before = await h.load();
      const otherVault = join(root, `other-vault-${nextCase}`);
      await mkdir(otherVault);
      h.beforeMutation = async state => {
        if (change === "mode") h.session.activate(h.initial.id, "tutor", "tutor-1");
        if (change === "vault") h.config.obsidianRoot = otherVault;
        if (change === "instance") state.instanceId = "new-import";
        if (change === "section") state.chapters[0].sections[0].createdAt = "2026-09-05T12:00:00.000Z";
        if (change === "view") delete state.chapters[0].sections[0].figureCoverage.pages[0].viewed;
        if (change === "source") await writeFile(h.sourcePath, Buffer.concat([pdfFixture(), Buffer.from("\n% changed")]));
      };
      refused(await h.crop(view), /changed while|source changed since import/);
      assert.deepEqual(await readdir(otherVault), []);
      assert.deepEqual(await readdir(join(bookNoteDirectory(originalConfig, before), "Assets")).catch(() => []), []);
      const after = await storage.loadBookState(originalConfig, before.id);
      assert.deepEqual(after.chapters, before.chapters);
      assert.equal(after.instanceId, before.instanceId);
    }
  });
  await check("a Learn book removed while its crop renders is never recreated by capture", async () => {
    const h = await harness("learn"), view = await h.view(), before = await h.load();
    const manifest = storage.bookStatePath(h.config, before);
    h.beforeMutationLoad = () => rm(manifest);
    refused(await h.crop(view), /authority is missing/);
    assert.equal(await h.load(), undefined);
    await assert.rejects(readFile(manifest), { code: "ENOENT" });
    assert.deepEqual(await readdir(join(bookNoteDirectory(h.config, before), "Assets")).catch(() => []), []);
  });
} finally {
  for (const [key, value] of oldEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await rm(root, { recursive: true, force: true });
}
function hRecord(book, mode) { return mode === "exam" ? book.exams[0] : book.tutorSessions[0]; }
console.log(`Scholar mode figures: ${passed} passed, ${failed} failed.`);
process.exitCode = failed ? 1 : 0;
