// The production controller, notes codec, review loops and Poppler readers run
// unchanged. Only the selected provider is simulated; all files are disposable.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { extensionPath, piPackageRoot, jitiPath, resolvePiDependency, piRequire } from "./sdk.mjs";
import { saveFixtureLesson } from "./lesson-fixture.mjs";

const { createJiti } = await import(pathToFileURL(jitiPath));
const piAiEntry = piRequire.resolve.paths("@earendil-works/pi-ai").map(directory => join(directory, "@earendil-works/pi-ai/dist/index.js")).find(existsSync);
assert.ok(piAiEntry);
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: {
  "@earendil-works/pi-coding-agent": join(piPackageRoot, "dist/index.js"), "@earendil-works/pi-ai": piAiEntry,
  "@earendil-works/pi-tui": resolvePiDependency("@earendil-works/pi-tui"),
  "typebox/value": resolvePiDependency("typebox/value"), typebox: resolvePiDependency("typebox"),
} });
const loadModule = name => jiti.import(join(dirname(extensionPath), name));
const storage = await loadModule("storage.ts");
const lesson = await loadModule("lesson.ts");
const { createScholarToolController } = await loadModule("tool-controller.ts");
const { createBookService } = await loadModule("book-service.ts");
const { ScholarRuntimeSession } = await loadModule("runtime-session.ts");
const { sectionNotePath } = await loadModule("obsidian-paths.ts");
const { ModelRegistry } = await import(pathToFileURL(join(piPackageRoot, "dist/core/model-registry.js")));

const temporary = resolve(tmpdir());
const root = await mkdtemp(join(temporary, "scholar-learn-review-integration-"));
const now = "2026-09-13T00:00:00.000Z";
const objective = "Explain how length and speed determine travel time";
const keyPoint = "At fixed speed, doubling the path length doubles travel time.";
const explanation = "Travel time counts how long motion takes. Speed tells us how much distance is covered in each second, so dividing path length by speed gives the number of seconds needed.";
const meaning = "At fixed speed, doubling the path length doubles the time because there is twice as much distance to cover at the same rate.";
const model = { id: "integration-review", provider: "fixture-provider", api: "fixture-api", input: ["text", "image"], contextWindow: 300_000, maxTokens: 32_000 };
const pass = { status: "pass", findings: [] };
const changes = { status: "changes", findings: [{ severity: "blocking", target: "lesson-delay / assumptions", sourcePages: [1],
  issue: "Explain why speed must remain constant for this proportional prediction.", repair: "Connect the fixed-speed assumption to the distance covered each second." }] };
const usage = { input: 200, output: 40, cacheRead: 0, cacheWrite: 0, totalTokens: 240,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const reply = (content = pass, stopReason = "stop") => ({ role: "assistant", api: model.api, provider: model.provider, model: model.id,
  content: Array.isArray(content) ? content : [{ type: "text", text: JSON.stringify(content) }], stopReason, usage, timestamp: Date.now() });
const call = (name, args) => ({ type: "toolCall", id: `${name}-1`, name, arguments: args });
const textOf = result => result.content.filter(item => item.type === "text").map(item => item.text).join("\n");
const success = result => assert.ok(!["retry", "error", "review"].includes(result.details.tone), textOf(result));
const active = book => book.chapters[0].sections[0];

function pdfFixture() {
  const streams = [
    "BT /F1 11 Tf 50 750 Td 18 TL (1.1 Travel time) Tj T* (Travel time is path length divided by a constant speed: t = l / v.) Tj T* (Length measures distance; speed measures distance covered per second.) Tj T* (At a fixed speed, doubling distance doubles the time needed.) Tj ET",
    "BT /F1 11 Tf 50 750 Td (1.2 Earlier study material remains available.) Tj ET",
  ];
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>"];
  for (let index = 0; index < streams.length; index++) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents ${4 + index * 2} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(streams[index])} >>\nstream\n${streams[index]}\nendstream`);
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => { const offset = Buffer.byteLength(pdf); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; return offset; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

function notes() {
  return { action: "notes", objectives: [objective], coveredObjectives: [objective], requiredChecks: ["conceptual"],
    objectiveChecks: [{ objective, checks: ["conceptual"] }], synthesis: "Travel time follows from path length and speed; doubling length doubles the time only while speed stays fixed.", keyPoints: [keyPoint],
    sourceCoverage: [{ id: "time-concept", kind: "concept", objective, description: "Explain the physical meaning of travel time", sourcePages: [1], lessonId: "delay", evidence: explanation },
      { id: "time-equation", kind: "equation", objective, description: "Explain the central travel-time relation", sourcePages: [1], lessonId: "delay", equationId: "delay", evidence: meaning }],
    lesson: { id: "delay", title: "Travel time", markdown: `### Understanding travel time\n\n${explanation}\n\n[[scholar-equation:delay]]\n\nFor example, a two-metre path takes twice as long as a one-metre path if the speed is the same.`,
      objectives: [objective], keyPoints: [keyPoint], sourcePages: [1], keyEquations: [{ id: "delay", title: "Travel time", latex: String.raw`t = \frac{\ell}{v}`,
        symbols: [{ symbol: "t", definition: "travel time" }, { symbol: String.raw`\ell`, definition: "path length" }, { symbol: "v", definition: "constant speed" }],
        assumptions: "The speed remains constant and nonzero along the path.", meaning, sourcePages: [1] }] },
    figureReviews: [{ page: 1, observation: "The rendered source page contains text and the stated relation, without figures or tables.", figures: [] }] };
}
const question = () => ({ action: "assess", outcome: "pending", kind: "conceptual", question: String.raw`At fixed \(v\), how does doubling \(\ell\) change travel time?`,
  grounding: { purpose: "practice", competency: objective, requiredEvidence: ["Explain the proportional change in travel time"], sourcePages: [1],
    basis: [{ kind: "objective", value: objective, supports: [1] }] },
  expectedAnswer: String.raw`The time \(t\) doubles because speed stays fixed.`, criteria: ["State that travel time doubles when the path doubles at fixed speed."] });

let caseId = 0;
async function harness(fresh = false) {
  const directory = join(root, `case-${++caseId}`);
  const config = { schemaVersion: 3, libraryRoot: join(directory, "library"), obsidianRoot: join(directory, "vault"), stateRoot: join(directory, "bootstrap"), updatedAt: now };
  await Promise.all([mkdir(config.libraryRoot, { recursive: true }), mkdir(config.obsidianRoot, { recursive: true })]);
  const sourcePath = join(config.libraryRoot, "travel.pdf"), bytes = pdfFixture();
  await writeFile(sourcePath, bytes);
  const fingerprint = { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, mtimeMs: (await stat(sourcePath)).mtimeMs };
  const section = (id, number, page) => ({ id, number, order: page, title: page === 1 ? "Travel time" : "Existing lesson", startPage: page, endPage: page,
    objectives: [objective], coveredObjectives: [], requiredChecks: ["conceptual"], keyPoints: [keyPoint], synthesis: "A fixed source relation predicts travel time from length and constant speed.",
    status: "learning", misconceptions: [], attempts: [], transcript: [], createdAt: now, updatedAt: now });
  const initial = { schemaVersion: 3, revision: 0, id: fingerprint.sha256, instanceId: `review-case-${caseId}`,
    source: { absolutePath: sourcePath, relativePath: "travel.pdf", fileName: "travel.pdf", format: "pdf", fingerprint }, metadata: { title: "Review integration fixture", authors: [], pageCount: 2 },
    outlineStatus: "ready", chapters: [{ id: "c1", number: "1", order: 1, title: "Motion", startPage: 1, endPage: 2, status: "learning", sections: [section("s1", "1.1", 1), section("legacy", "1.2", 2)] }],
    currentSectionId: "s1", exams: [], tutorSessions: [], noteDirectory: "Review integration fixture", createdAt: now, updatedAt: now };
  saveFixtureLesson(lesson, initial, initial.chapters[0].sections[1], { sourcePages: [2] });
  if (fresh) active(initial).objectives = [];
  assert.ok(storage.isScholarBook(initial));
  await storage.createBookState(config, initial);
  const h = { config, initial, requests: [], verdicts: {}, onRequest: undefined };
  h.load = () => storage.loadBookState(config, initial.id);
  const service = createBookService({ getConfig: () => config, load: storage.loadBookState, list: storage.listBookStates,
    save: storage.saveBookState, project: async () => {}, onSave() {}, librarySetupMessage: 'Fixture library missing' });
  const mutateBook = (id, mutate) => service.mutateBook(id, async state => { await h.beforeMutation?.(); return mutate(state); });
  h.mutate = mutateBook;
  const registry = new ModelRegistry({ complete: async (selected, context, request) => {
    assert.equal(selected, model);
    const role = /Assigned role: (\w+)\./.exec(context.systemPrompt)[1];
    h.requests.push({ role, context: structuredClone(context), sessionId: request.sessionId });
    await h.onRequest?.({ role, context, request });
    if (context.messages.length === 1) {
      if (role === "source" || role === "assessment") return reply([call("read_source", { startPage: 1, endPage: 1 })], "toolUse");
      if (role === "visual") return reply([call("view_source", { page: 1 })], "toolUse");
    }
    return reply(h.verdicts[role] || pass);
  } });
  const session = new ScholarRuntimeSession(); session.activate(initial.id, "learn", "s1");
  let definition, nextCall = 0;
  h.controller = createScholarToolController({ pi: { registerTool(tool) { definition = tool; } }, session, getConfig: () => config, loadBook: h.load,
    mutateBook, isActiveAuthority: book => book.instanceId === initial.instanceId, isSetupActive: () => false, now: () => h.now?.() ?? Date.now() });
  h.controller.ensureRegistered();
  h.session = session;
  h.context = () => ({ hasUI: false, model, modelRegistry: registry, ...(h.contextSignal ? { signal: h.contextSignal } : {}) });
  h.execute = (params, signal) => definition.execute(`review-integration-${++nextCall}`, params, signal, undefined, h.context());
  success(await h.execute({ action: "read", startPage: 1, endPage: 1 }));
  const viewed = await h.execute({ action: "view", page: 1 }); success(viewed);
  assert.ok(viewed.content.some(item => item.type === "image"), "the production source reader must return actual rendered evidence");
  return h;
}

let checks = 0;
async function check(name, test) { await test(); checks++; console.log(`[PASS] ${name}`); }
try {
  await check("Independent notes updates and displayed section numbers preserve authority and avoid prose regeneration", async () => {
    const h=await harness();
    success(await h.execute({action:'notes',sectionId:'1.1',objectiveChecks:notes().objectiveChecks}));
    success(await h.execute({action:'notes',figureReviews:notes().figureReviews}));
    success(await h.execute({action:'notes',synthesis:notes().synthesis}));
    success(await h.execute({action:'notes',keyPoints:notes().keyPoints}));
    assert.equal(active(await h.load()).transcript.length,0);
    const before=await h.load();
    assert.match(textOf(await h.execute({action:'notes',sectionId:'1.2',keyPoints:['Wrong section']})),/frozen Learn section s1/);
    assert.deepEqual(await h.load(),before);
    const input=notes(); input.lesson.markdown=input.lesson.markdown.replace('### Understanding','# Understanding');
    success(await h.execute(input));
    const saved=active(await h.load());
    assert.match(saved.transcript[0].markdown,/^### Understanding/);
    const evidence=explanation.split('. ')[0]+'.';
    const result=await h.execute({action:'notes',coverageUpdates:[{id:'time-concept',evidence}]});
    success(result);
    assert(textOf(result).length<1000,'draft saves do not list every future mastery check');
    const updated=active(await h.load());
    assert.equal(updated.learnQuality.coverage[0].evidence,evidence);
    assert.equal(updated.learnQuality.coverage.length,saved.learnQuality.coverage.length);
    assert.equal(updated.transcript[0].markdown,saved.transcript[0].markdown);
    success(await h.execute({action:'notes',lessonComplete:true}));
    assert.equal(lesson.lessonReady(active(await h.load())),true);
  });

  await check("Exact prose patches preserve equation receipts, reject stale/structural edits, and require fresh review", async () => {
    const h = await harness();
    success(await h.execute({...notes(), lessonComplete:true}));
    const before = active(await h.load()).transcript.find(entry=>entry.lesson);
    success(await h.execute({action:'notes',lesson:{...notes().lesson,id:before.id,expectedContentHash:before.lesson.contentHash}}));
    assert.equal(active(await h.load()).transcript.filter(entry=>entry.lesson).length,1,'the stored ID returned by status must resolve to the existing lesson');
    const improved = explanation+' This ratio follows from distance equal to speed times elapsed time.';
    const patch = {id:'delay',expectedContentHash:before.lesson.contentHash,edits:[{oldText:explanation,newText:improved}]};
    success(await h.execute({action:'notes',lessonPatch:patch}));
    const changed = await h.load(), current = active(changed), entry = current.transcript.find(item=>item.lesson);
    assert.equal(current.transcript.filter(item=>item.lesson).length,1);
    assert.equal(entry.markdown,before.markdown.replace(explanation,improved));
    assert.deepEqual(entry.lesson.keyEquationIds,before.lesson.keyEquationIds);
    assert.equal(lesson.lessonReady(current,changed.source.fingerprint.sha256),false);
    assert.match(textOf(await h.execute({action:'notes',lessonPatch:patch})),/Stale lessonPatch/);
    const structural = {...patch,expectedContentHash:entry.lesson.contentHash,edits:[{oldText:String.raw`t = \frac{\ell}{v}`,newText:'t = 1'}]};
    assert.match(textOf(await h.execute({action:'notes',lessonPatch:structural})),/preserves rendered equation/);
    const ambiguous = {...patch,expectedContentHash:entry.lesson.contentHash,edits:[{oldText:'speed',newText:'velocity'}]};
    assert.match(textOf(await h.execute({action:'notes',lessonPatch:ambiguous})),/exactly once/);
    assert.deepEqual(await h.load(),changed);
    success(await h.execute({action:'notes',lessonComplete:true}));
    const reviewed = await h.load();
    assert(lesson.lessonReady(active(reviewed),reviewed.source.fingerprint.sha256));
    h.controller.resetTransientState();
  });
  await check("Rejected initial notes name the missing field, preserve the vault, and recover without duplicating a lesson", async () => {
    const h = await harness(true), before = await h.load();
    const missing = notes(); delete missing.objectives;
    const failed = await h.execute(missing);
    assert.match(textOf(failed), /Nothing saved.*top-level objectives/s);
    assert.deepEqual(await h.load(), before);
    const malformed = notes(); malformed.sourceCoverage[0].equationId = '';
    const rejected = await h.execute(malformed);
    assert.match(textOf(rejected), /Invalid sourceCoverage item\(s\): 1 \(time-concept\)/);
    assert.deepEqual(await h.load(), before);
    const valid = notes(); valid.sourceCoverage[0].equationId = 'delay';
    success(await h.execute(valid));
    const saved = active(await h.load());
    assert.deepEqual(saved.objectives, [objective]);
    assert.equal(saved.transcript.filter(entry => entry.lesson).length, 1);
    h.controller.resetTransientState();
  });
  await check("An execution failure is saved as incomplete and retry reuses unchanged successful reviewers", async () => {
    const h = await harness();
    h.onRequest = async ({role}) => { if (role === 'source') throw new Error('Simulated connection failure'); };
    const result = await h.execute({ ...notes(), lessonComplete: true });
    assert.match(textOf(result), /review incomplete.*source: provider/s);
    assert.match(textOf(result), /No automatic retry or rewrite/);
    const first = active(await h.load());
    assert.equal(first.learnQuality.reviews.find(review=>review.role==='source').failure.code, 'provider');
    assert.equal(first.lessonCommit, undefined);
    const start = h.requests.length;
    h.onRequest = undefined;
    assert.match(textOf(await h.execute({action:'notes',lessonComplete:true})), /Generation stopped/);
    assert.equal(h.requests.length, start, 'a model cannot retry a failed execution in the same turn');
    assert.match(textOf(result), /\/scholar learn "1\.1" continue/);
    for (const source of ['interactive', 'extension']) {
      await h.controller.captureOpenResponse('Continue this saved draft', source);
      h.controller.endAgentTurn();
      assert.match(textOf(await h.execute({action:'notes',lessonComplete:true})), /Generation stopped/);
    }
    assert.equal(h.requests.length, start, 'chat or extension input cannot clear a stopped delivery');
    h.controller.resetTransientState(); // what the explicit /scholar learn "1.1" continue activation does
    success(await h.execute({action:'notes',lessonComplete:true}));
    assert(h.requests.slice(start).every(request=>request.role==='source'));
    const current = await h.load();
    assert(lesson.lessonReady(active(current),current.source.fingerprint.sha256));
    assert.equal(active(current).transcript.filter(entry=>entry.lesson).length, 1);
  });
  await check("Fresh Learn enables quality gates, serializes coverage and equation boxes, and leaves the legacy lesson intact", async () => {
    const h = await harness(), before = (await h.load()).chapters[0].sections[1];
    success(await h.execute(notes()));
    const saved = await h.load(), section = active(saved);
    assert.equal(section.learnQuality.version, 1);
    assert.deepEqual(section.learnQuality.coverage, notes().sourceCoverage);
    assert.deepEqual(section.transcript[0].lesson.keyEquationIds, ["delay"]);
    assert.match(section.transcript[0].markdown, /> \[!note\] Key equation · Travel time/);
    assert.match(section.transcript[0].markdown, /\$v\$ → constant speed/);
    assert.equal(lesson.lessonHash(section.transcript[0].markdown), section.transcript[0].lesson.contentHash,
      "the equation-composed lesson must retain its content hash through the actual vault note codec");
    assert.equal(section.lessonCommit, undefined);
    assert.equal(h.requests.length, 0, "saving a draft does not start reviewers");
    assert.deepEqual(saved.chapters[0].sections[1], before);
    assert.equal(saved.chapters[0].sections[1].learnQuality, undefined);
    const blocked = await h.execute(question());
    assert.match(textOf(blocked), /lesson|instructional/i);
    assert.equal(active(await h.load()).attempts.length, 0);
    assert.equal(h.requests.length, 0, "unfinished lessons cannot reach question review or expose a new question");
  });

  await check("Three isolated reviewers inspect real PDF evidence before commit; a fourth reviews the new question without awarding mastery", async () => {
    const h = await harness();
    success(await h.execute({ ...notes(), lessonComplete: true }));
    const saved = await h.load(), section = active(saved);
    assert.ok(lesson.lessonReady(section, saved.source.fingerprint.sha256));
    assert.deepEqual(section.learnQuality.reviews.map(receipt => receipt.role), ["source", "teaching", "visual"]);
    assert.equal(new Set(h.requests.map(request => request.sessionId)).size, 3);
    assert.deepEqual([...new Set(h.requests.map(request => request.role))].sort(), ["source", "teaching", "visual"]);
    const readEvidence = h.requests.flatMap(request => request.context.messages).filter(message => Array.isArray(message.content));
    assert.ok(readEvidence.some(message => message.content.some(item => item.type === "text" && item.text.includes("[Page 1]") && item.text.includes("constant speed"))));
    const renderedEvidence = readEvidence;
    const png = renderedEvidence.flatMap(message => message.content).find(item => item.type === "image");
    assert.ok(png && Buffer.from(png.data, "base64").readUInt32BE(16) > 100, "reviewer receives the real Poppler page, not a fake approval receipt");
    assert.equal(section.attempts.length, 0);
    assert.notEqual(section.status, "complete", "editorial approval is not earned mastery");
    success(await h.execute(question()));
    const prepared = active(await h.load()).attempts[0];
    assert.equal(prepared.outcome, "pending");
    assert.ok(prepared.question.includes("$v$") && !prepared.question.includes(String.raw`\(`));
    assert.ok(h.requests.some(request => request.role === "assessment"));
    assert.notEqual(active(await h.load()).status, "complete");
  });

  await check("A blocking specialist finding saves the draft and findings while preventing commit and learner questions", async () => {
    const h = await harness(); h.verdicts.teaching = changes;
    const result = await h.execute({ ...notes(), lessonComplete: true });
    assert.equal(result.details.tone, "review");
    assert.match(textOf(result), /speed must remain constant/);
    const saved = active(await h.load());
    assert.equal(saved.lessonCommit, undefined);
    assert.equal(saved.learnQuality.reviews.find(review => review.role === "teaching").status, "changes");
    assert.ok(saved.transcript[0].markdown.includes(explanation));
    assert.equal(lesson.lessonReady(saved), false);
    const before = h.requests.length;
    const blocked = await h.execute(question());
    assert.ok(["retry", "error"].includes(blocked.details.tone));
    assert.equal(active(await h.load()).attempts.length, 0);
    assert.equal(h.requests.length, before);
  });

  await check("Cancellation during a provider request cannot commit a saved draft or create review approvals", async () => {
    const h = await harness(), stop = new AbortController();
    let entered; const started = new Promise(resolve => { entered = resolve; });
    h.onRequest = async ({ request }) => {
      entered();
      await new Promise((_resolve, reject) => {
        if (request.signal.aborted) reject(request.signal.reason);
        else request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
      });
    };
    const pending = h.execute({ ...notes(), lessonComplete: true }, stop.signal);
    await started; stop.abort(new Error("User cancelled the review."));
    const result = await pending;
    assert.ok(["retry", "error"].includes(result.details.tone));
    const section = active(await h.load());
    assert.ok(section.transcript[0].markdown.includes(explanation));
    assert.equal(section.lessonCommit, undefined);
    assert.deepEqual(section.learnQuality.reviews, []);
    assert.equal(section.attempts.length, 0);
  });

  await check("An actual note edit during review is preserved and makes otherwise passing verdicts stale", async () => {
    const h = await harness();
    let changed = false;
    const edited = "The learner inserted this independent clarification while reviewers were still checking the earlier draft.";
    h.onRequest = async () => {
      if (changed) return; changed = true;
      const state = await h.load(), section = active(state);
      const path = sectionNotePath(h.config, state, state.chapters[0], section);
      const document = await readFile(path, "utf8");
      assert.ok(document.includes(`\n\n${explanation}\n\n`));
      await writeFile(path, document.replace(`\n\n${explanation}\n\n`, `\n\n${explanation}\n\n${edited}\n\n`));
    };
    const result = await h.execute({ ...notes(), lessonComplete: true });
    assert.ok(["retry", "error"].includes(result.details.tone), textOf(result));
    assert.match(textOf(result), /changed during review/);
    const section = active(await h.load());
    assert.ok(section.transcript[0].markdown.includes(edited));
    assert.equal(section.lessonCommit, undefined);
    assert.deepEqual(section.learnQuality.reviews, []);
  });

  await check("The question event prehook cancels from ctx.signal alone without changing committed notes or creating a question", async () => {
    const h = await harness();
    success(await h.execute({ ...notes(), lessonComplete: true }));
    const before = await h.load(), stop = new AbortController();
    h.contextSignal = stop.signal;
    let entered, requestSignal;
    const started = new Promise(resolve => { entered = resolve; });
    h.onRequest = async ({ role, request }) => {
      assert.equal(role, "assessment"); requestSignal = request.signal; entered();
      await new Promise((_resolve, reject) => {
        if (request.signal.aborted) reject(request.signal.reason);
        else request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
      });
    };
    // The index.ts prehook has an ExtensionContext signal but no execute signal.
    const pending = h.controller.reviewQuestion(before, active(before), question(), [1], h.context());
    const rejected = assert.rejects(pending, /cancel/i);
    await started; stop.abort(new Error("Question event context cancelled."));
    await rejected;
    assert.equal(requestSignal.aborted, true, "context cancellation must reach the provider request");
    assert.deepEqual(await h.load(), before, "question review never persists transient verdicts or an unanswered question after cancellation");
  });

  await check("Late context cancellation at the lesson approval or question write boundary cannot persist a pass", async () => {
    for (const phase of ["lesson", "question"]) {
      const h = await harness();
      if (phase === "question") success(await h.execute({ ...notes(), lessonComplete: true }));
      const before = await h.load(), stop = new AbortController();
      h.contextSignal = stop.signal;
      let mutations = 0, abortedAtWrite = false;
      h.beforeMutation = () => {
        mutations++;
        // Lesson has a draft save then an approval write; the prepared question
        // has only its post-review write. Abort after review has already returned.
        if (phase === "question" || mutations === 2) {
          assert.ok(h.requests.some(request => request.role === (phase === "question" ? "assessment" : "visual")));
          abortedAtWrite = true;
          stop.abort(new Error(`Late ${phase} context cancellation.`));
        }
      };
      const result = await h.execute(phase === "question" ? question() : { ...notes(), lessonComplete: true });
      assert.equal(abortedAtWrite, true, "the test must reach the real write boundary after specialist review");
      assert.ok(["retry", "error"].includes(result.details.tone), textOf(result));
      assert.match(textOf(result), /cancel/i);
      const after = await h.load(), section = active(after);
      assert.equal(section.attempts.length, 0);
      if (phase === "lesson") {
        assert.ok(section.transcript[0].markdown.includes(explanation), "draft remains inspectable");
        assert.equal(section.lessonCommit, undefined);
        assert.deepEqual(section.learnQuality.reviews, [], "cancelled approval cannot write passing review receipts");
      } else assert.deepEqual(after, before, "cancelled question write cannot change prior approval, progress, or the note");
    }
  });
  await check("Structured equation edits preserve other prose and receipts and invalidate approval atomically", async()=>{
    const h=await harness();success(await h.execute({...notes(),lessonComplete:true}));
    const before=active(await h.load()), entry=before.transcript.find(item=>item.lesson);
    const old=[...entry.markdown.matchAll(/^>[^\n]*(?:\n>[^\n]*)*/gm)].find(match=>match[0].startsWith('> [!note] Key equation'))[0];
    const equation={...notes().lesson.keyEquations[0],symbols:[{symbol:'t',definition:'elapsed travel time'},...notes().lesson.keyEquations[0].symbols.slice(1)]};
    success(await h.execute({action:'notes',lessonPatch:{id:entry.id,expectedContentHash:entry.lesson.contentHash,calloutEdits:[{oldText:old,equation}]}}));
    const after=active(await h.load()), updated=after.transcript.find(item=>item.lesson);
    assert.equal(updated.markdown.replace('elapsed travel time','travel time'),entry.markdown);
    assert.deepEqual(updated.lesson.keyEquationIds,entry.lesson.keyEquationIds);
    assert.equal(updated.createdAt,entry.createdAt);
    assert.equal(lesson.lessonReady(after),false);
    const snapshot=await h.load();
    const invalid=await h.execute({action:'notes',lessonPatch:{id:entry.id,expectedContentHash:updated.lesson.contentHash,calloutEdits:[{oldText:old,equation:{...equation,sourcePages:[2]}}]}});
    assert.ok(['error','retry'].includes(invalid.details.tone));assert.deepEqual(await h.load(),snapshot);
    const stale=await h.execute({action:'notes',lessonPatch:{id:entry.id,expectedContentHash:entry.lesson.contentHash,calloutEdits:[{oldText:old,equation}]}});
    assert.match(textOf(stale),/Stale/);
  });
  await check("Provider failure actively aborts the author loop and blocks follow-on rewrites", async()=>{
    const h=await harness();let aborts=0;const context=h.context;
    h.context=()=>({...context(),abort(){aborts++;}});
    h.onRequest=async({role})=>{if(role==='source')throw new Error('Connection reset');};
    const result=await h.execute({...notes(),lessonComplete:true});
    assert.match(textOf(result),/Generation stopped/);assert.equal(aborts,1);
    const before=await h.load(), calls=h.requests.length;
    assert.match(textOf(await h.execute(notes())),/Generation stopped/);
    assert.deepEqual(await h.load(),before);assert.equal(h.requests.length,calls);
    assert.match(textOf(await h.execute({action:'read',startPage:1,endPage:1})),/Generation stopped/);
    success(await h.execute({action:'status'}));
  });
  await check("The third unresolved content review stops the author before any fourth repair", async()=>{
    const h=await harness();h.verdicts.source=changes;let aborts=0;const context=h.context;
    h.context=()=>({...context(),abort(){aborts++;}});
    for(let round=0;round<3;round++) {
      const result=await h.execute(round===0?{...notes(),lessonComplete:true}:{action:'notes',lessonComplete:true});
      assert.equal(result.details.tone,'review');
    }
    assert.equal(aborts,1);
    const before=await h.load(),calls=h.requests.length;
    assert.match(textOf(await h.execute(notes())),/three review rounds/);
    assert.equal(h.requests.length,calls);assert.deepEqual(await h.load(),before);
  });
  await check("Replacing one literal crop updates only that callout and cannot bypass figure validation", async()=>{
    const h=await harness();
    const viewed=active(await h.load()).figureCoverage.pages[0].viewed;
    const capture=async x=>success(await h.execute({action:'snapshot',page:1,x,y:30,width:600,height:180,
      canvasWidth:viewed.width,canvasHeight:viewed.height,caption:`Source equation crop at offset ${x}.`}));
    await capture(10);await capture(20);
    const [first,second]=active(await h.load()).snapshots;
    const input=notes();input.lesson.markdown+=`\n\n[[scholar-figure:${first.id}]]`;
    input.figureReviews=[{page:1,observation:'The text source contains the stated equation, retained as a literal crop.',figures:[{label:'Source equation',snapshotId:first.id}]}];
    input.sourceCoverage.push({id:'source-crop',kind:'figure',objective,description:'Inspect the literal equation',sourcePages:[1],lessonId:'delay',evidence:meaning,snapshotId:first.id});
    success(await h.execute({...input,lessonComplete:true}));
    const before=active(await h.load()),entry=before.transcript.find(item=>item.lesson);
    const old=[...entry.markdown.matchAll(/^>[^\n]*(?:\n>[^\n]*)*/gm)].find(match=>match[0].startsWith('> [!example] Figure'))[0];
    const patch={id:entry.id,expectedContentHash:entry.lesson.contentHash,calloutEdits:[{oldText:old,snapshotId:second.id,replacesSnapshotId:first.id}]};
    success(await h.execute({action:'notes',lessonPatch:patch,
      figureReviews:[{...input.figureReviews[0],figures:[{label:'Source equation',snapshotId:second.id}]}],
      coverageUpdates:[{id:'source-crop',snapshotId:second.id}]}));
    const current=active(await h.load()),updated=current.transcript.find(item=>item.lesson);
    const changed=[...updated.markdown.matchAll(/^>[^\n]*(?:\n>[^\n]*)*/gm)].find(match=>match[0].startsWith('> [!example] Figure'))[0];
    assert.equal(updated.markdown.replace(changed,old),entry.markdown);
    assert.deepEqual(updated.lesson.embeddedSnapshotIds,[second.id]);
    assert.deepEqual(updated.lesson.keyEquationIds,entry.lesson.keyEquationIds);
    assert.equal(current.snapshots.length,2);assert.equal(lesson.lessonReady(current),false);
    const durable=await h.load();
    assert.ok(['retry','error'].includes((await h.execute({action:'notes',lessonPatch:{...patch,expectedContentHash:updated.lesson.contentHash,
      calloutEdits:[{oldText:changed,snapshotId:'missing-crop',replacesSnapshotId:second.id}]}})).details.tone));
    assert.deepEqual(await h.load(),durable);
    success(await h.execute({action:'notes',lessonComplete:true}));
    assert(lesson.lessonReady(active(await h.load())));
  });
  await check("Reopening a saved draft starts no generation; explicit continue starts exactly one turn", async()=>{
    const h=await harness();success(await h.execute(notes()));
    const {handleScholarCommand}=await loadModule('commands.ts');
    const {parseScholarCommand}=await loadModule('command-syntax.ts');
    assert.deepEqual(parseScholarCommand('learn "1.1" continue'),{action:'learn',value:'1.1',continue:true});
    assert.deepEqual(parseScholarCommand('learn "continue"'),{action:'learn',value:'continue'});
    const notifications=[];let generations=0,locks=0;
    const ctx={hasUI:false,isIdle:()=>true,ui:{notify:message=>notifications.push(message)}};
    const coordinator={runtimeSession:h.session,getConfig:()=>h.config,loadFreshConfig:async()=>h.config,
      getNavigationRun:()=>undefined,getSetupRun:()=>undefined,getScholarTurnRun:()=>undefined,
      hasConfiguredLibrary:()=>true,hasConfiguredObsidian:()=>true,mutateBook:h.mutate,
      beginNavigation(){locks++;return()=>{locks--;};},activateBook:async(book,_ctx,mode,id)=>h.session.activate(book.id,mode,id),
      startScholarModeTurn:async()=>{generations++;}};
    await handleScholarCommand('learn "1.1"',ctx,coordinator);
    assert.equal(generations,0);assert.equal(locks,0);assert(notifications.some(message=>message.includes('No generation started')));
    assert.equal(h.session.mode,undefined,'reopening a draft selects the book without entering Learn');
    const calls=h.requests.length,before=await h.load();
    for(const params of [{action:'notes',lessonComplete:true},{action:'read',startPage:1,endPage:1},notes()]) {
      assert.match(textOf(await h.execute(params)),/no active operation/,'ordinary chat cannot write, read or review the reopened draft');
    }
    assert.equal(h.requests.length,calls);assert.deepEqual(await h.load(),before);
    await handleScholarCommand('learn "1.1" continue',ctx,coordinator);
    assert.equal(generations,1);assert.equal(locks,0);assert.equal(h.session.mode,'learn');
    for(const [answer,expected] of [['continue',1],['view',0],['cancel',0]]){
      const prompts=[];let started=0;
      const uiCtx={hasUI:true,isIdle:()=>true,ui:{notify:message=>notifications.push(message),
        select:async(title,options)=>{prompts.push({title,options});return answer==='continue'?options[0]:answer==='view'?options[1]:undefined;}}};
      await handleScholarCommand('learn "1.1"',uiCtx,{...coordinator,startScholarModeTurn:async()=>{started++;}});
      assert.equal(prompts.length,1,`an interactive reopen asks instead of silently doing nothing (${answer})`);
      assert.match(prompts[0].title,/1\.1.*not yet approved/);assert.match(prompts[0].options[0],/20 minutes/);
      assert.equal(started,expected,`reopen answer "${answer}" starts ${expected} turn(s)`);
      assert.equal(h.session.mode,expected?'learn':undefined);assert.equal(locks,0);
    }
    const promptsWithContinue=[];
    await handleScholarCommand('learn "1.1" continue',{...ctx,hasUI:true,ui:{...ctx.ui,select:async(title)=>{promptsWithContinue.push(title);}}},coordinator);
    assert.equal(promptsWithContinue.length,0,'explicit continue never asks');assert.equal(generations,2);
  });
  await check("The total Learn deadline stops a long writer, excludes learner waiting, and cannot stop a later session", async()=>{
    const h=await harness();const book=await h.load();
    const {ScholarRuntimeCoordinator}=await loadModule('runtime-coordinator.ts');
    const {ScholarLoadingProgress}=await loadModule('loading-progress.ts');
    let clock=0,stops=0;const timers=new Set();
    const originalSet=globalThis.setInterval,originalClear=globalThis.clearInterval;
    globalThis.setInterval=callback=>{const timer={callback,unref(){}};timers.add(timer);return timer;};
    globalThis.clearInterval=timer=>timers.delete(timer);
    try{
      const coordinator=new ScholarRuntimeCoordinator({},()=>()=>{},()=>{});
      Object.defineProperty(coordinator,'loading',{value:new ScholarLoadingProgress(()=>clock)});
      coordinator.runtimeSession.activate(book.id,'learn','s1');
      coordinator.toolController={stopDelivery:()=>{stops++;}};
      const ctx={hasUI:false,ui:{}};
      const run=coordinator.ensureScholarTurnInputLock(book,ctx,'Learn response');
      assert.equal(timers.size,1);
      clock=60_000;
      await coordinator.loading.withUserInput(async()=>{clock+=30*60_000;});
      [...timers].forEach(timer=>timer.callback());assert.equal(stops,0);
      clock+=19*60_000;[...timers].forEach(timer=>timer.callback());
      assert.equal(stops,1);assert.equal(timers.size,0);
      run.releaseInput();coordinator.scholarTurnRun=undefined;
      const next=coordinator.ensureScholarTurnInputLock(book,ctx,'Learn response');
      const late=[...timers][0];next.releaseInput();coordinator.scholarTurnRun=undefined;
      late.callback();assert.equal(stops,1);assert.equal(timers.size,0);
      coordinator.loading.clear();
    }finally{globalThis.setInterval=originalSet;globalThis.clearInterval=originalClear;}
  });
  await check("Chat and extension input cannot reset the review-round cap; only explicit activation grants a new bounded attempt", async()=>{
    const h=await harness();h.verdicts.source=changes;let aborts=0;const context=h.context;
    h.context=()=>({...context(),abort(){aborts++;}});
    for(let round=0;round<3;round++){
      if(round){await h.controller.captureOpenResponse('Please keep repairing it',round===1?'extension':'interactive');h.controller.endAgentTurn();}
      assert.equal((await h.execute(round===0?{...notes(),lessonComplete:true}:{action:'notes',lessonComplete:true})).details.tone,'review');
    }
    assert.equal(aborts,1);
    const calls=h.requests.length;
    await h.controller.captureOpenResponse('Try once more','interactive');h.controller.endAgentTurn();
    assert.match(textOf(await h.execute({action:'notes',lessonComplete:true})),/Generation stopped/);
    assert.equal(h.requests.length,calls);
    success(await h.execute({action:'status'}));
    const stoppedBook=await h.load();
    await assert.rejects(h.controller.reviewQuestion(stoppedBook,active(stoppedBook),question(),[1],h.context()),/Generation stopped/);
    assert.equal(h.requests.length,calls,'the scholar_quiz prehook cannot start a reviewer after a stop');
    h.controller.resetTransientState();
    assert.equal((await h.execute({action:'notes',lessonComplete:true})).details.tone,'review');
    assert.ok(h.requests.length>calls,'the explicit continue activation permits a new bounded round');
  });
  await check("Repeated lessonComplete submissions with delivery gaps stop the author before any reviewer runs", async()=>{
    const h=await harness();let aborts=0;const context=h.context;
    h.context=()=>({...context(),abort(){aborts++;}});
    const input=notes();input.sourceCoverage[0].evidence='This passage does not occur in the saved lesson.';
    for(let attempt=1;attempt<=3;attempt++){
      const result=await h.execute(attempt===1?{...input,lessonComplete:true}:{action:'notes',lessonComplete:true});
      assert.match(textOf(result),new RegExp(`delivery gaps.*${attempt}/4`,'s'));
    }
    assert.equal(aborts,0);
    assert.match(textOf(await h.execute({action:'notes',lessonComplete:true})),/rejected 4 times.*Generation stopped/s);
    assert.equal(aborts,1);
    assert.match(textOf(await h.execute({action:'read',startPage:1,endPage:1})),/Generation stopped/);
    assert.equal(h.requests.length,0);
  });
  await check("The controller enforces the preparation budget itself, excludes idle turns, and never starts an unfinishable review", async()=>{
    const h=await harness();let aborts=0;const context=h.context;
    h.context=()=>({...context(),abort(){aborts++;}});
    let clock=0;h.now=()=>clock;h.controller.resetTransientState();
    success(await h.execute(notes()));
    clock=10*60_000;h.controller.endAgentTurn();
    clock=5*60*60_000; // hours idle between turns are not preparation work
    success(await h.execute({action:'status'}));
    clock+=9*60_000; // 19 minutes of active preparation spent
    assert.match(textOf(await h.execute({action:'notes',lessonComplete:true})),/too little of Learn's 20-minute preparation limit/);
    assert.equal(h.requests.length,0);assert.equal(aborts,1);
    assert.deepEqual(active(await h.load()).learnQuality.reviews,[]);
    h.controller.resetTransientState();clock=0;
    success(await h.execute({action:'read',startPage:1,endPage:1}));
    clock=20*60_000;
    assert.match(textOf(await h.execute({action:'read',startPage:1,endPage:1})),/20-minute preparation limit/);
    assert.equal(aborts,2,'the hard limit does not depend on the loading widget timer');
    h.controller.resetTransientState();clock=0;
    success(await h.execute({action:'status'}));
    clock=15*60_000;
    const timeouts=[];h.onRequest=async({request})=>{timeouts.push(request.timeoutMs);};
    success(await h.execute({action:'notes',lessonComplete:true}));
    assert.ok(timeouts.length&&timeouts.every(ms=>ms>0&&ms<=5*60_000),`reviews receive only the remaining preparation time: ${timeouts}`);
    assert(lesson.lessonReady(active(await h.load())));
  });
  console.log(`Scholar Learn review integration: ${checks} passed.`);
} finally {
  const contained = relative(temporary, resolve(root));
  assert.ok(contained && contained !== ".." && !contained.startsWith(`..${sep}`) && !contained.includes(":"), "only remove this test's verified temporary directory");
  await rm(root, { recursive: true, force: true });
}
