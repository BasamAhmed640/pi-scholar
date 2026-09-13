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
    mutateBook, isActiveAuthority: book => book.instanceId === initial.instanceId, isSetupActive: () => false });
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
    assert.match(textOf(result), /Do not rewrite/);
    const first = active(await h.load());
    assert.equal(first.learnQuality.reviews.find(review=>review.role==='source').failure.code, 'provider');
    assert.equal(first.lessonCommit, undefined);
    const start = h.requests.length;
    h.onRequest = undefined;
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
    const readEvidence = h.requests.flatMap(request => request.context.messages).filter(message => message.role === "toolResult" && message.toolName === "read_source");
    assert.ok(readEvidence.some(message => message.content.some(item => item.type === "text" && item.text.includes("[Page 1]") && item.text.includes("constant speed"))));
    const renderedEvidence = h.requests.flatMap(request => request.context.messages).filter(message => message.role === "toolResult" && message.toolName === "view_source");
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
  console.log(`Scholar Learn review integration: ${checks} passed.`);
} finally {
  const contained = relative(temporary, resolve(root));
  assert.ok(contained && contained !== ".." && !contained.startsWith(`..${sep}`) && !contained.includes(":"), "only remove this test's verified temporary directory");
  await rm(root, { recursive: true, force: true });
}
