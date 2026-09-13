import { sdkAliases } from "./sdk.mjs";
import { extensionPath as packagedExtensionPath, piPackageRoot as sdkRoot, jitiPath as sdkJitiPath, resolvePiDependency } from "./sdk.mjs";
// Real Poppler, source routing, crops, receipt persistence and missing-asset gates.
// Everything writable is confined to a disposable vault and library.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const piRoot = sdkRoot;
const piRequire = createRequire(join(piRoot, "package.json"));
const { createJiti } = await import(pathToFileURL(sdkJitiPath).href);
const extension = dirname(resolve(process.env.PI_SCHOLAR_EXTENSION || packagedExtensionPath));
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: { ...sdkAliases,
  "@earendil-works/pi-coding-agent": join(piRoot, "dist", "index.js"),
  "@earendil-works/pi-tui": piRequire.resolve("@earendil-works/pi-tui"),
  typebox: piRequire.resolve("typebox"),
} });
const coverage = await jiti.import(join(extension, "figure-coverage.ts"));
const { migrateLegacyCompletion, recomputeProgress } = await jiti.import(join(extension, "domain.ts"));
const storage = await jiti.import(join(extension, "storage.ts"));
const { snapshotAssetPath } = await jiti.import(join(extension, "obsidian-paths.ts"));
const { ScholarRuntimeSession } = await jiti.import(join(extension, "runtime-session.ts"));
const { createScholarToolController } = await jiti.import(join(extension, "tool-controller.ts"));
const { ModelRegistry } = await import(pathToFileURL(join(piRoot, "dist/core/model-registry.js")));
const root = await mkdtemp(join(tmpdir(), "scholar-figure-coverage-"));
const envKeys = ["PI_SCHOLAR_OBSIDIAN_ROOT", "PI_SCHOLAR_LIBRARY_ROOT", "PI_SCHOLAR_STATE_ROOT"];
const oldEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
for (const key of envKeys) delete process.env[key];
const now = "2026-09-04T12:00:00.000Z";
let passed = 0, failed = 0;
async function check(name, test) {
  try { await test(); passed++; console.log(`[PASS] ${name}`); }
  catch (error) { failed++; console.error(`[FAIL] ${name}: ${error.stack}`); }
}

function pdfFixture() {
  const text = (lines) => ["BT /F1 11 Tf 60 750 Td 19 TL", ...lines.flatMap((line) => [`(${line.replace(/[()\\]/g, "\\$&")}) Tj`, "T*"]), "ET"].join("\n");
  const streams = [
    text(["3.1 Introduction", "A source model connects the physical design to its observable behavior.", "The process is described by the source and illustrated in", "Figure 3-1."]),
    text(["84 Chapter 3 Impedance and Electrical Models", "Specifications", "Modeling and simulation", "Figure 3-1 Process flow for hardware design.", "The two key processes are modeling and simulation. Each depends on a physical model.", "We understand the source behavior by tracing causes through every step of the process.", "3.2 What Is Impedance?", "The next section owns this additional diagram and its explanation.", "Figure 3-2 Neighbor section circuit."]) + "\n60 420 260 70 re S\n190 420 m 190 380 l S\n60 310 260 70 re S\n",
    "60 600 160 80 re S\n220 640 m 350 640 l S\n350 600 160 80 re S\n",
  ];
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>"];
  for (let index = 0; index < streams.length; index++) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 9 0 R >> >> /Contents ${4 + index * 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(streams[index])} >>\nstream\n${streams[index]}\nendstream`);
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => { const offset = Buffer.byteLength(pdf); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; return offset; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

try {
  const config = { schemaVersion: 3, libraryRoot: join(root, "library"), obsidianRoot: join(root, "vault"), stateRoot: join(root, "bootstrap"), updatedAt: now };
  await Promise.all([mkdir(config.libraryRoot), mkdir(config.obsidianRoot)]);
  const bytes = pdfFixture(), sourcePath = join(config.libraryRoot, "figures.pdf");
  await writeFile(sourcePath, bytes);
  const fingerprint = { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, mtimeMs: (await stat(sourcePath)).mtimeMs };
  const section = (id, number, title, startPage, endPage) => ({ id, number, title, order: Number(number.split(".")[1]), startPage, endPage, objectives: ["Explain the physical model"], coveredObjectives: [], requiredChecks: ["conceptual"], status: "learning", keyPoints: [], misconceptions: [], attempts: [], transcript: [], createdAt: now, updatedAt: now });
  const initial = { schemaVersion: 3, revision: 0, id: fingerprint.sha256, instanceId: "figure-coverage-fixture", source: { absolutePath: sourcePath, relativePath: "figures.pdf", fileName: "figures.pdf", format: "pdf", fingerprint }, metadata: { title: "Figure Coverage Fixture", authors: [], pageCount: 3 }, outlineStatus: "ready", chapters: [{ id: "chapter-3", number: "3", order: 1, title: "Impedance and Electrical Models", startPage: 1, endPage: 3, status: "learning", sections: [section("section-1", "3.1", "Introduction", 1, 1), section("section-2", "3.2", "What Is Impedance?", 2, 2), section("section-3", "3.3", "Vector Diagram", 3, 3)] }], currentSectionId: "section-1", exams: [], tutorSessions: [], noteDirectory: "Books/Figure Coverage Fixture", createdAt: now, updatedAt: now };
  assert.ok(storage.isScholarBook(initial));
  await storage.createBookState(config, initial);
  const load = () => storage.loadBookState(config, initial.id);
  const active = (book, index = 0) => book.chapters[0].sections[index];
  const mutateBook = async (bookId, mutate) => {
    const book = await load(), revision = book.revision;
    const result = await mutate(book);
    await storage.saveBookState(config, book, revision);
    return { book: await load(), result };
  };
  const session = new ScholarRuntimeSession();
  session.activate(initial.id, "learn", "section-1");
  let tool;
  createScholarToolController({ pi: { registerTool(definition) { tool = definition; } }, session, getConfig: () => config, loadBook: load, mutateBook, isActiveAuthority: () => true, isSetupActive: () => false }).ensureRegistered();
  let call = 0;
  const model = { id: "figure-review", provider: "fixture-provider", api: "fixture-api", input: ["text", "image"], contextWindow: 300_000, maxTokens: 32_000 };
  const reviewedCrops = new Set(), reviewedPages = new Set(), readPages = new Set();
  const reply = (content = [{ type: "text", text: JSON.stringify({ status: "pass", findings: [] }) }], stopReason = "stop") => ({ role: "assistant", content, stopReason,
    api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage: { input: 200, output: 40, cacheRead: 0, cacheWrite: 0, totalTokens: 240,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const modelRegistry = new ModelRegistry({ complete: async (selected, context) => {
    assert.equal(selected, model);
    const role = /Assigned role: (\w+)\./.exec(context.systemPrompt)[1];
    const prompt = context.messages[0].content;
    const payload = JSON.parse(prompt.slice(prompt.indexOf('\n{"source":') + 1));
    if (context.messages.length === 1) {
      const toolCall = (name, args, id) => ({ type: "toolCall", name, arguments: args, id });
      if (role === "source") return reply([toolCall("read_source", { startPage: payload.source.startPage, endPage: payload.source.endPage }, "source-pages")], "toolUse");
      if (role === "visual") return reply([
        ...Array.from({ length: payload.source.endPage - payload.source.startPage + 1 }, (_, index) => {
          const page = payload.source.startPage + index;
          return toolCall("view_source", { page }, `page-${page}`);
        }),
        ...(payload.figures || []).map((crop, index) => toolCall("view_crop", { id: crop.id }, `crop-${index}`)),
      ], "toolUse");
    }
    for (const result of context.messages.filter(message => message.role === "toolResult")) {
      if (result.toolName === "read_source") {
        const text = result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
        for (let page = payload.source.startPage; page <= payload.source.endPage; page++) {
          assert.ok(text.includes(`[Page ${page}]`), "source approval requires actual complete-page evidence"); readPages.add(page);
        }
      }
      if (result.toolName === "view_source" || result.toolName === "view_crop") {
        const image = result.content.find(item => item.type === "image");
        assert.equal(image?.mimeType, "image/png");
        const bytes = Buffer.from(image.data, "base64");
        assert.ok(bytes.readUInt32BE(16) >= 32 && bytes.readUInt32BE(20) >= 32, "review image must be a real rendered page or crop");
        if (result.toolName === "view_crop") reviewedCrops.add(createHash("sha256").update(bytes).digest("hex"));
        else reviewedPages.add(Number(result.toolCallId.replace("page-", "")));
      }
    }
    return reply();
  } });
  const execute = (params) => tool.execute(`figure-fixture-${++call}`, params, undefined, undefined, { hasUI: false, model, modelRegistry });
  const successful = (result) => assert.ok(!["error", "retry", "review"].includes(result.details.tone), result.content[0].text);
  const lessonSnapshots = new Map();
  const explanation = "A physical model represents how changes in a design affect observable behavior. Begin at the input of the source diagram and follow each connection to its output. Each connection expresses a relationship, so changing an input can change the outcome through the intermediate steps.";
  const figureExplanation = "To explain the model, name the changing input and trace the relationships to the measured result. The direction of each arrow tells you which step supplies the next one.";
  const notes = (figureReviews) => {
    const sourcePages = session.recordId === "section-3" ? [3] : [1, 2];
    const snapshots = lessonSnapshots.get(session.recordId) || [];
    return { action: "notes", synthesis: "The physical model connects each design choice to the resulting source behavior through a clear causal chain.", objectives: ["Explain the physical model"], coveredObjectives: ["Explain the physical model"], keyPoints: ["The model connects physical causes to observable behavior."], requiredChecks: ["conceptual"],
      objectiveChecks: [{ objective: "Explain the physical model", checks: ["conceptual"] }],
      sourceCoverage: [{ id: "model-concept", kind: "concept", description: "Explain how a source model relates a design change to observed behavior", sourcePages,
        objective: "Explain the physical model", lessonId: "physical-model", evidence: explanation },
        ...snapshots.map(snapshot => ({ id: `figure-${snapshot.id}`, kind: "figure", description: "Walk through the source diagram's directed connections", sourcePages: [snapshot.page],
          objective: "Explain the physical model", lessonId: "physical-model", evidence: figureExplanation, snapshotId: snapshot.id }))],
      lesson: { id: "physical-model", title: "Following causes through a model", markdown: ["### Following causes through a model", explanation,
        ...snapshots.map(snapshot => `[[scholar-figure:${snapshot.id}]]`), figureExplanation].join("\n\n"),
        objectives: ["Explain the physical model"], keyPoints: ["The model connects physical causes to observable behavior."], sourcePages },
      lessonComplete: true, ...(figureReviews ? { figureReviews } : {}) };
  };
  const noFigures = (page) => ({ page, observation: "Visual inspection confirms this portion contains only text and no source figures.", figures: [] });

  await check("caption detection excludes inline and line-wrapped Figure references", async () => {
    assert.deepEqual(coverage.detectFigureLabels("As shown in Figure 3-1, the source behaves consistently.\nFigure 3-1.\nFigure 3-1 shows the process.\nFigure 3-1 Process flow for hardware design.\nTable 3.2 Measured values"), ["Figure 3-1", "Table 3.2"]);
  });
  await check("truncated or ambiguous extracted text never certifies a complete page read", async () => {
    assert.deepEqual(coverage.extractedPages("[Page 1]\nComplete source.\n\n[Page 2]\nPartial\n\n[Scholar: excerpt truncated; request a smaller page range.]", 1, 2).map((page) => page.page), [1]);
    assert.deepEqual(coverage.extractedPages("[Page 1]\nSource\n[Page 1]\nForged marker", 1, 1), []);
  });
  await check("boundary proof requires the exact adjacent frozen heading and substantive preceding content", async () => {
    const first = active(initial), next = active(initial, 1);
    assert.equal(coverage.hasSharedBoundaryContinuation(first, next, "[Page 2]\n84 Chapter 3 Impedance and Electrical Models\n3.2 What Is Impedance?\nFigure 3-2 Next section figure"), false);
    assert.equal(coverage.hasSharedBoundaryContinuation(first, next, "[Page 2]\nFigure 3-1 Process flow\n3.9 Another heading"), false);
    assert.equal(coverage.hasSharedBoundaryContinuation(first, next, "[Page 2]\n84 Chapter 3 Impedance and Electrical Models\nFigure 3-1 Process flow\n3.2 What Is Impedance?"), true);
  });
  await check("real Learn read repairs an omitted shared page without exposing the next section", async () => {
    const result = await execute({ action: "read", startPage: 1, endPage: 1 });
    successful(result);
    assert.match(result.content[0].text, /shared boundary.*included/i);
    assert.equal(active(await load()).endPage, 2);
    assert.deepEqual(active(await load()).figureCoverage.pages[0].candidates, []);
    const shared = await execute({ action: "read", startPage: 2, endPage: 2 });
    successful(shared);
    assert.match(shared.content[0].text, /Figure 3-1 Process flow/);
    assert.doesNotMatch(shared.content[0].text, /Figure 3-2|next section owns|3\.2 What Is Impedance/);
    assert.deepEqual(active(await load()).figureCoverage.pages.find((page) => page.page === 2).candidates, ["Figure 3-1"]);
  });
  await check("unmatched shared-page headings stop with an actionable correction and never expose sibling text", async () => {
    const book = await load();
    assert.throws(() => coverage.sectionPageText(book, active(book), 2, "Figure 3-1 Process flow\n3.2 W h a t Is Impedance?\nSIBLING SECRET"), (error) => error.name === "Error" && /heading.*could not be established/.test(error.message) && !error.message.includes("SIBLING SECRET"));
  });
  await check("Learn search on shared pages cannot return a sibling's figure or prose", async () => {
    const own = await execute({ action: "search", query: "Process" });
    successful(own);
    assert.match(own.content[0].text, /Process flow/);
    assert.doesNotMatch(own.content[0].text, /Figure 3-2|next section owns/);
    const neighbor = await execute({ action: "search", query: "Neighbor" });
    successful(neighbor);
    assert.match(neighbor.content[0].text, /No source hits/);
  });
  await check("practice is blocked with an ordinary correction until source visuals are reviewed", async () => {
    const result = await execute({ action: "assess", outcome: "pending", kind: "conceptual", question: "Explain the physical model.", grounding: { purpose: "practice" } });
    assert.equal(result.details.tone, "retry");
    assert.match(result.content[0].text, /Finish the source figures/);
    assert.equal(active(await load()).attempts.length, 0);
  });
  await check("snapshot requires a real Learn view with matching canvas dimensions", async () => {
    const result = await execute({ action: "snapshot", page: 2, x: 0, y: 0, width: 100, height: 100, canvasWidth: 1800, canvasHeight: 1800, caption: "Figure 3-1: physical process flow." });
    assert.equal(result.details.tone, "retry");
    assert.match(result.content[0].text, /View this active Learn page/);
    successful(await execute({ action: "view", page: 1 }));
    successful(await execute({ action: "view", page: 2 }));
  });
  await check("a known source figure cannot be omitted from a reviewed page", async () => {
    const result = await execute(notes([noFigures(1), noFigures(2)]));
    assert.equal(result.details.tone, "retry");
    assert.match(result.content[0].text, /Account for.*Figure 3-1/);
    assert.equal(active(await load()).figureCoverage.pages[0].review, undefined);
  });
  await check("malformed figure reviews return actionable validation instead of TypeErrors", async () => {
    const book = await load();
    for (const reviews of [[null], [{ page: 1, observation: 42, figures: [] }], [{ page: 1, observation: "This page has no figures.", figures: [null] }], [{ page: 1, observation: "This page has no figures.", figures: [{ label: 42, skipReason: "A duplicate of an earlier source diagram." }] }]]) {
      await assert.rejects(coverage.validateFigureReviews(config, book, active(book), reviews), (error) => error.name === "Error" && /review|observation|figure/i.test(error.message));
    }
  });
  let savedSnapshot, imagePath, originalImage;
  await check("a real saved PDF crop fulfills the durable review and survives book reload", async () => {
    const book = await load(), viewed = active(book).figureCoverage.pages.find((page) => page.page === 2).viewed;
    const captured = await execute({ action: "snapshot", page: 2, x: 120, y: 800, width: 620, height: 350, canvasWidth: viewed.width, canvasHeight: viewed.height, caption: "Figure 3-1: physical process flow." });
    successful(captured);
    savedSnapshot = active(await load()).snapshots[0];
    lessonSnapshots.set(session.recordId, [savedSnapshot]);
    successful(await execute(notes([noFigures(1), { page: 2, observation: "Figure 3-1 belongs before the next section heading and is saved as a literal crop.", figures: [{ label: "Figure 3-1", snapshotId: savedSnapshot.id }] }])));
    const reloaded = await load();
    await coverage.assertLearnFigureCoverage(config, reloaded, active(reloaded));
    assert.ok(storage.isScholarBook(reloaded));
    assert.equal(active(reloaded).learnQuality.version, 1, "fresh fixture uses the current quality contract");
    assert.deepEqual(active(reloaded).learnQuality.reviews.map(review => review.role), ["source", "teaching", "visual"]);
    assert.ok(reviewedCrops.has(savedSnapshot.sha256), "visual reviewer must inspect the actual immutable crop");
    assert.ok([1, 2].every(page => readPages.has(page) && reviewedPages.has(page)));
    assert.deepEqual(active(reloaded).transcript[0].lesson.embeddedSnapshotIds, [savedSnapshot.id]);
    assert.equal(active(reloaded).figureCoverage.pages[1].review.figures[0].snapshotId, savedSnapshot.id);
    imagePath = snapshotAssetPath(config, reloaded, savedSnapshot);
    originalImage = await readFile(imagePath);
    assert.ok(originalImage.length > 100);
    const returnedImages = captured.content.filter(item => item.type === "image");
    assert.equal(returnedImages.length, 1, "Learn must expose the actual saved crop for visual review");
    assert.equal(returnedImages[0].mimeType, "image/png");
    const returnedBytes = Buffer.from(returnedImages[0].data, "base64");
    assert.deepEqual(returnedBytes, originalImage, "model-visible crop bytes must be the exact durable asset");
    assert.equal(createHash("sha256").update(returnedBytes).digest("hex"), savedSnapshot.sha256);
    assert.equal(returnedBytes.readUInt32BE(16), 620);
    assert.equal(returnedBytes.readUInt32BE(20), 350);
  });
  await check("new completion requires figures while previously completed legacy work stays complete", async () => {
    const book = await load(), section = active(book);
    section.attempts = [{ id: "passed-mastery", kind: "conceptual", format: "open", question: "Explain the model.", outcome: "pass", grounding: { purpose: "mastery", competency: "Explain the physical model", requiredEvidence: ["Trace the cause through the source model to an observable effect."], sourcePages: [1], basis: [{ kind: "objective", value: "Explain the physical model", supports: [1] }] }, createdAt: now }];
    recomputeProgress(book, section);
    assert.equal(section.status, "complete", "a fully reviewed section can complete");
    delete section.figureCoverage;
    section.status = "learning";
    recomputeProgress(book, section);
    assert.notEqual(section.status, "complete", "new completion cannot bypass a missing receipt");
    section.status = "complete";
    delete section.lessonCommit;
    migrateLegacyCompletion(book);
    recomputeProgress(book, section);
    assert.equal(section.status, "complete", "a previously earned result remains stable");
  });
  await check("repeat source reads and views do not rewrite unchanged coverage receipts", async () => {
    const before = await readFile(storage.bookStatePath(config, await load()));
    successful(await execute({ action: "read", startPage: 1, endPage: 2 }));
    successful(await execute({ action: "view", page: 1 }));
    assert.deepEqual(await readFile(storage.bookStatePath(config, await load())), before);
  });
  await check("a missing or modified saved image cannot satisfy practice coverage", async () => {
    await rm(imagePath);
    let book = await load();
    await assert.rejects(coverage.assertLearnFigureCoverage(config, book, active(book)), /image.*missing/);
    await writeFile(imagePath, "modified image bytes");
    book = await load();
    await assert.rejects(coverage.assertLearnFigureCoverage(config, book, active(book)), /no longer matches/);
    await writeFile(imagePath, originalImage);
  });
  await check("only an explicit specific skip can resolve an unnecessary source figure", async () => {
    const bad = await execute(notes([{ page: 2, observation: "The process figure repeats a source diagram already preserved.", figures: [{ label: "Figure 3-1", skipReason: "unneeded" }] }]));
    assert.equal(bad.details.tone, "retry");
    successful(await execute(notes([{ page: 2, observation: "The source figure is a duplicate of the literal process diagram already preserved.", figures: [{ label: "Figure 3-1", skipReason: "Duplicate of the same source process diagram already preserved on this page." }] }])));
    const book = await load();
    await coverage.assertLearnFigureCoverage(config, book, active(book));
  });
  await check("the next section receives its own caption and no preceding figure ownership", async () => {
    session.activate(initial.id, "learn", "section-2");
    const result = await execute({ action: "read", startPage: 2, endPage: 2 });
    successful(result);
    assert.match(result.content[0].text, /Figure 3-2 Neighbor/);
    assert.doesNotMatch(result.content[0].text, /Figure 3-1 Process/);
    assert.deepEqual(active(await load(), 1).figureCoverage.pages[0].candidates, ["Figure 3-2"]);
  });
  await check("vector-only pages remain readable and require visual review despite absent captions", async () => {
    session.activate(initial.id, "learn", "section-3");
    successful(await execute({ action: "read", startPage: 3, endPage: 3 }));
    const book = await load(), vector = active(book, 2);
    assert.equal(book.outlineStatus, "ready");
    assert.deepEqual(vector.figureCoverage.pages[0].candidates, []);
    await assert.rejects(coverage.assertLearnFigureCoverage(config, book, vector), /read\/view PDF page\(s\) 3/);
    successful(await execute({ action: "view", page: 3 }));
    const viewed = active(await load(), 2).figureCoverage.pages[0].viewed;
    successful(await execute({ action: "snapshot", page: 3, x: 120, y: 240, width: 1100, height: 250, canvasWidth: viewed.width, canvasHeight: viewed.height, caption: "Uncaptioned vector process diagram from this source section." }));
    const snapshot = active(await load(), 2).snapshots[0];
    lessonSnapshots.set(session.recordId, [snapshot]);
    successful(await execute(notes([{ page: 3, observation: "This page contains an uncaptained vector diagram connecting two process boxes.", figures: [{ label: "Uncaptioned vector process diagram", snapshotId: snapshot.id }] }])));
    const reloaded = await load();
    await coverage.assertLearnFigureCoverage(config, reloaded, active(reloaded, 2));
    assert.ok(reviewedPages.has(3) && readPages.has(3), "vector-only page still reaches real source readers");
    assert.ok(reviewedCrops.has(snapshot.sha256), "a vector-only crop must also reach independent visual review");
  });
  await check("unmapped chapter context remains readable without adding invalid section receipt pages", async () => {
    let contextBook = structuredClone(initial);
    contextBook.chapters[0].sections = [active(initial, 1), active(initial, 2)].map((item) => structuredClone(item));
    const contextSession = new ScholarRuntimeSession();
    contextSession.activate(initial.id, "learn", "section-2");
    let contextTool;
    createScholarToolController({ pi: { registerTool(definition) { contextTool = definition; } }, session: contextSession, getConfig: () => config, loadBook: async () => contextBook, mutateBook: async (_id, update) => ({ book: contextBook, result: await update(contextBook) }), isActiveAuthority: () => true, isSetupActive: () => false }).ensureRegistered();
    successful(await contextTool.execute("context-read", { action: "read", startPage: 1, endPage: 1 }, undefined, undefined, { hasUI: false }));
    successful(await contextTool.execute("context-view", { action: "view", page: 1 }, undefined, undefined, { hasUI: false }));
    assert.deepEqual(contextBook.chapters[0].sections[0].figureCoverage.pages, []);
  });
  await check("an adjacent section in another chapter never expands the active section", async () => {
    let crossChapter = structuredClone(initial);
    crossChapter.chapters = [{ ...crossChapter.chapters[0], endPage: 2, sections: [active(initial)] }, { id: "chapter-4", number: "4", order: 2, title: "Next chapter", startPage: 2, endPage: 3, status: "learning", sections: [active(initial, 1), active(initial, 2)] }];
    const crossSession = new ScholarRuntimeSession();
    crossSession.activate(initial.id, "learn", "section-1");
    let crossTool;
    createScholarToolController({ pi: { registerTool(definition) { crossTool = definition; } }, session: crossSession, getConfig: () => config, loadBook: async () => crossChapter, mutateBook: async (_id, update) => ({ book: crossChapter, result: await update(crossChapter) }), isActiveAuthority: () => true, isSetupActive: () => false }).ensureRegistered();
    successful(await crossTool.execute("cross-chapter-read", { action: "read", startPage: 1, endPage: 1 }, undefined, undefined, { hasUI: false }));
    assert.equal(active(crossChapter).endPage, 1);
  });
  assert.deepEqual(await readFile(sourcePath), bytes, "PDF library remains byte-identical");
} finally {
  for (const [key, value] of oldEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  assert.ok(basename(root).startsWith("scholar-figure-coverage-"));
  await rm(root, { recursive: true, force: true });
}
console.log(`Scholar figure coverage: ${passed} passed, ${failed} failed.`);
process.exitCode = failed ? 1 : 0;
