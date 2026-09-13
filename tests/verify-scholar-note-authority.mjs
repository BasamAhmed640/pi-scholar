import { sdkAliases } from "./sdk.mjs";
import assert from "node:assert/strict";
import { saveFixtureLesson } from "./lesson-fixture.mjs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { extensionPath, piPackageRoot, jitiPath, resolvePiDependency } from "./sdk.mjs";

const { createJiti } = await import(pathToFileURL(jitiPath));
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: { ...sdkAliases,
  "@earendil-works/pi-coding-agent": join(piPackageRoot, "dist/index.js"),
  "@earendil-works/pi-tui": resolvePiDependency("@earendil-works/pi-tui"), typebox: resolvePiDependency("typebox"),
} });
const mod = (file) => jiti.import(join(dirname(extensionPath), file));
const { default: install } = await mod("index.ts");
const storage = await mod("storage.ts");
const domain = await mod("domain.ts");
const { createBookService } = await mod("book-service.ts");
const { renderScholarWorkspace, sectionNotePath, tutorNotePath } = await mod("obsidian.ts");
const { recoverTranscriptTarget } = await mod("transcript-recovery.ts");
const { handleAssess } = await mod("tool-actions/learning.ts");
const { ScholarRuntimeSession } = await mod("runtime-session.ts");
const { kickoffMessage } = await mod("runtime-coordinator.ts");
const lesson = await mod("lesson.ts");
const root = await mkdtemp(join(tmpdir(), "scholar-question-resume-"));
const now = "2026-01-01T00:00:00.000Z";
const config = { schemaVersion: 3, libraryRoot: join(root, "lib"), obsidianRoot: join(root, "vault"), stateRoot: join(root, "state"), updatedAt: now };
process.env.PI_SCHOLAR_LIBRARY_ROOT = config.libraryRoot;
process.env.PI_SCHOLAR_OBSIDIAN_ROOT = config.obsidianRoot;
process.env.PI_SCHOLAR_STATE_ROOT = config.stateRoot;
const basis = "A mechanism predicts a measurable outcome";
const book = { schemaVersion: 3, revision: 0, id: "b".repeat(64), instanceId: "resume-fixture",
  source: { absolutePath: join(config.libraryRoot, "fixture.pdf"), relativePath: "fixture.pdf", fileName: "fixture.pdf", format: "pdf", fingerprint: { sha256: "b".repeat(64), size: 1, mtimeMs: 1 } },
  metadata: { title: "Resume fixture", authors: [], pageCount: 1 }, outlineStatus: "ready",
  chapters: [{ id: "c1", order: 1, title: "Mechanisms", startPage: 1, endPage: 1, status: "learning", sections: [{
    id: "s1", number: "1.1", order: 1, title: "Prediction", startPage: 1, endPage: 1, status: "learning", objectives: [basis], coveredObjectives: [basis], requiredChecks: ["conceptual"],
    synthesis: "A mechanism relates an assumption to a measurable prediction that can be checked.", keyPoints: [basis], misconceptions: [], attempts: [], transcript: [],
    figureCoverage: { pages: [{ page: 1, read: true, viewed: { width: 600, height: 800 }, candidates: [], review: { page: 1, observation: "The source page contains text only and no figures.", figures: [] } }] }, createdAt: now, updatedAt: now,
  }] }], exams: [], tutorSessions: [{ id: "t1", title: "Tutor fixture", status: "active", scope: { chapterIds: ["c1"], sectionIds: ["s1"], description: "Mechanisms" }, keyPoints: [basis], attempts: [], transcript: [], createdAt: now, updatedAt: now }],
  currentSectionId: "s1", currentTutorId: "t1", noteDirectory: "Resume fixture", createdAt: now, updatedAt: now,
};
const grounding = { purpose: "practice", competency: basis, requiredEvidence: ["Predict the outcome"], sourcePages: [1], basis: [{ kind: "key-point", value: basis, supports: [1] }] };
saveFixtureLesson(lesson, book, book.chapters[0].sections[0]);
saveFixtureLesson(lesson, book, book.tutorSessions[0]);
const read = () => storage.loadBookState(config, book.id);
const target = (state, mode) => mode === "learn" ? state.chapters[0].sections[0] : state.tutorSessions[0];
const service = createBookService({ getConfig: () => config, load: storage.loadBookState, save: storage.saveBookState, list: storage.listBookStates, project: renderScholarWorkspace, onSave() {}, librarySetupMessage: "Missing source" });
const toolResult = (action, summary, details = {}) => ({ content: [{ type: "text", text: summary }], details: { action, summary, ...details } });
let checks = 0;
function pass(text) { checks++; console.log(`[PASS] ${text}`); }
async function host(mode) {
  const handlers = new Map(), tools = new Map(), commands = new Map(), sent = [], branch = [];
  let activeTools = [], editor;
  install({ on: (name, fn) => handlers.set(name, [...(handlers.get(name) || []), fn]),
    registerTool: (tool) => tools.set(tool.name, tool), registerCommand: (name, command) => commands.set(name, command),
    getActiveTools: () => activeTools, setActiveTools: (names) => { activeTools = names; },
    appendEntry: (customType, data) => branch.push({ id: `pointer-${branch.length}`, type: "custom", customType, data }),
    sendMessage: (message) => sent.push(message),
  });
  const ctx = { hasUI: true, sessionManager: { getBranch: () => branch, getEntries: () => branch },
    ui: { notify() {}, setStatus() {}, setWorkingMessage() {}, getEditorComponent: () => editor, setEditorComponent: (factory) => { editor = factory; } } };
  const fire = async (name, event) => {
    const results = [];
    for (const fn of handlers.get(name) || []) results.push(await fn(event, ctx));
    return results;
  };
  await fire("session_start", {});
  assert.equal(tools.size, 0, "a new session must remain dormant");
  await commands.get("scholar").handler(mode === "learn" ? "learn s1" : "tutor", ctx);
  assert.ok(tools.has("scholar_quiz"));
  assert.equal(tools.get("scholar_quiz").parameters.type, "object", "provider-compatible tool schema root");
  assert.equal(tools.get("scholar_quiz").parameters.anyOf, undefined);
  const call = (id, input) => fire("tool_call", { toolName: "scholar_quiz", toolCallId: id, input });
  async function execute(id, input, action, emitResult = true) {
    let update = Promise.resolve();
    const output = await tools.get("scholar_quiz").execute(id, input, undefined, (partialResult) => {
      assert.equal(partialResult.details.correctIndices, undefined);
      assert.equal(partialResult.details.explanation, undefined);
      update = fire("tool_execution_update", { toolName: "scholar_quiz", toolCallId: id, partialResult });
    }, { hasUI: action !== "unavailable", ui: { custom: async (factory) => {
      await update;
      return new Promise((done) => {
        const component = factory({ requestRender() {} }, { fg: (_color, text) => text, bold: (text) => text }, {}, done);
        assert.ok(!component.render(100).join("\n").includes("PRIVATE_EXPLANATION"));
        component.handleInput(action === "escape" ? "\x1b" : "\r");
      });
    } } });
    await update;
    if (emitResult) {
      const feedback = await fire("tool_result", { toolName: "scholar_quiz", toolCallId: id, ...output });
      if (action === "escape" || action === "unavailable") assert.match(JSON.stringify(feedback), /End this turn.*Do not reopen the picker/);
    }
    return output;
  }
  return { fire, call, execute, sent, ctx };
}
const { questionChunks, readDetails, questionBlock, migrateVisibleQuestions, examDocument, readExamDocument } = await mod("note-records.ts");
const { readNoteBook } = await mod("note-storage.ts");
const { readdir } = await import("node:fs/promises");
const quizInput = { question: "Which saved mechanism should be resumed?", kind: "conceptual", grounding,
  options: [{ value: "a", label: "First mechanism", misconception: "Treats a plausible label as evidence" }, { value: "b", label: "Second mechanism" }], correctAnswer: "b", explanation: "The evidence supports the second mechanism.", shuffle: false };
async function fileList(path) { const files=[]; for (const e of await readdir(path,{withFileTypes:true})) { const p=join(path,e.name); files.push(p); if(e.isDirectory()) files.push(...await fileList(p)); } return files; }
try {
  await Promise.all([mkdir(config.libraryRoot), mkdir(config.obsidianRoot), mkdir(config.stateRoot)]);
  await writeFile(book.source.absolutePath, "fixture");
  await storage.createBookState(config, book);
  await storage.saveConfig({ ...config, currentBookId: book.id });
  const h = await host("learn");
  await h.call("first", quizInput);
  await h.execute("first", quizInput, "answer");
  await h.call("last", {...quizInput, question: "The last question must resume exactly."});
  await h.execute("last", quizInput, "escape");
  let current=await read();
  const path=sectionNotePath(config,current,current.chapters[0],target(current,"learn"));
  let note=await readFile(path,"utf8");
  assert.equal(questionChunks(note).length,2);
  assert.equal((note.match(/The last question must resume exactly\./g)||[]).length,1, "one actual copy of the question");
  assert.equal(readDetails(await readFile(storage.bookStatePath(config,current),"utf8"),"book").chapters[0].sections[0].attempts,undefined);
  assert.ok(!(await fileList(config.obsidianRoot)).some(p=>/[\\/]\.scholar(?:[\\/]|$)|book(?:\.prev)?\.json$/.test(p)));
  assert.match((await host("learn")).sent.at(-1).content,/The last question must resume exactly/);
  pass("visible notes contain the complete study record, with no hidden database or duplicate prompts");

  const chunks=questionChunks(note);
  await writeFile(path,note.replace(chunks.at(-1),""));
  current=await read();
  assert.equal(target(current,"learn").attempts.length,1);
  assert.equal(domain.unansweredQuestion(target(current,"learn").attempts),undefined);
  assert.doesNotMatch((await host("learn")).sent.at(-1).content,/resumeAttemptId|The last question must resume exactly/);
  await h.fire("tool_result",{toolName:"scholar_quiz",toolCallId:"last",details:{status:"answered",correct:true,explanation:"LATE RESULT MUST NOT RESTORE"}});
  await service.renderAll();
  assert.doesNotMatch(await readFile(path,"utf8"),/The last question must resume exactly|LATE RESULT MUST NOT RESTORE/);
  pass("deleting the last pending question survives reopen, refresh and a late quiz result");

  note=await readFile(path,"utf8");
  await writeFile(path,note.replace(questionChunks(note)[0],""));
  assert.equal(target(await read(),"learn").attempts.length,0);
  const newHost=await host("learn");
  assert.ok(!(await newHost.call("new",{...quizInput,question:"A new question after intentional deletion."})).some(x=>x?.block));
  assert.equal(target(await read(),"learn").attempts.length,1);
  pass("deleting answered history is permanent and does not prevent asking a new question");

  const stale=await read();
  let release,entered;
  const gate=new Promise(r=>{release=r}); const started=new Promise(r=>{entered=r});
  const saving=service.mutateBook(book.id,async state=>{target(state,"learn").keyPoints.push("An in-flight change");entered();await gate;});
  await started;
  note=await readFile(path,"utf8");
  const edited=note.replace(questionChunks(note)[0],"")+"\nMY OBSIDIAN EDIT\n";
  await writeFile(path,edited); release();
  await assert.rejects(saving,/note changed while answering/);
  assert.equal(await readFile(path,"utf8"),edited);
  assert.equal(target(await read(),"learn").attempts.length,0);
  pass("an Obsidian deletion during an answer wins over an in-flight save");

  const cancelled={id:"cancelled",kind:"conceptual",format:"open",question:"Old cancelled question",outcome:"cancelled",createdAt:now};
  const answered={...cancelled,id:"answered",question:"Already answered",outcome:"pass",feedback:"Correct"};
  assert.equal(domain.unansweredQuestion([cancelled,answered]),undefined);
  assert.equal(domain.unansweredQuestion([{...cancelled,outcome:"pending"},answered]),undefined);
  assert.equal(domain.unansweredQuestion([answered,{...cancelled,outcome:"pending"}]).id,"cancelled");
  assert.deepEqual(migrateVisibleQuestions("## Questions\n\n### Question 2 · Conceptual\n\nRepeated question\n\n*Awaiting response*\n<!-- scholar:generated:end -->",[
    {...cancelled,question:"Repeated question"},{...cancelled,id:"actual-pending",question:"Repeated question",outcome:"pending"},
  ]).map(attempt=>attempt.id),["actual-pending"]);
  pass("resume checks the last actual question and never searches backward for cancelled work");

  // Simulate an old book with two JSON attempts but only one question left in Obsidian.
  const legacyBook=structuredClone(book); legacyBook.id="d".repeat(64); legacyBook.source.fingerprint.sha256=legacyBook.id;
  legacyBook.instanceId="legacy-visible"; legacyBook.noteDirectory="Legacy visible fixture"; legacyBook.metadata.title="Legacy visible fixture";
  target(legacyBook,"learn").attempts=[answered,{...cancelled,id:"pending",question:"Keep only this visible question",outcome:"pending"}];
  const legacyDir=join(config.obsidianRoot,"Scholar","Books",legacyBook.noteDirectory);
  const legacyState=join(legacyDir,".scholar"); await mkdir(legacyState,{recursive:true});
  await writeFile(join(legacyState,"book.json"),JSON.stringify(legacyBook)); await writeFile(join(legacyState,"book.prev.json"),JSON.stringify(legacyBook));
  await writeFile(join(legacyState,"old-answer-paper.md"),"Keep my written answer.");
  const legacyNote=sectionNotePath(config,legacyBook,legacyBook.chapters[0],target(legacyBook,"learn")); await mkdir(dirname(legacyNote),{recursive:true});
  await writeFile(legacyNote,'---\ntype: scholar-section\n---\n<!-- scholar:generated:start -->\n## Lesson\n\nMy edited visible lesson with $$x=2$$.\n\n## Questions\n\n### Question 2 · Conceptual\n\nKeep only this visible question\n\n*Awaiting response*\n<!-- scholar:generated:end -->\n');
  const migrated=await storage.loadBookState(config,legacyBook.id);
  assert.deepEqual(target(migrated,"learn").attempts.map(a=>a.id),["pending"]);
  assert.equal(target(migrated,"learn").transcript[0].markdown,"My edited visible lesson with $$x=2$$.");
  assert.doesNotMatch(await readFile(legacyNote,"utf8"),/Already answered/);
  assert.ok(!(await fileList(legacyDir)).some(p=>p.includes(".scholar")));
  assert.equal(await readFile(join(legacyDir,"Legacy notes","old-answer-paper.md"),"utf8"),"Keep my written answer.");
  assert.equal(domain.unansweredQuestion(target(migrated,"learn").attempts).question,"Keep only this visible question");
  pass("migration keeps only questions still visible and removes old JSON plus its backup");

  const fresh=await read(); const question={...cancelled,id:"metadata",question:"A malformed edit must stop safely",outcome:"pending"};
  await service.mutateBook(book.id,state=>target(state,"learn").attempts.push(question));
  note=await readFile(path,"utf8"); await writeFile(path,note.replace('"format": "scholar-notes-v1"','"format": BAD_JSON'));
  await assert.rejects(read(),/Invalid Scholar/);
  assert.equal(await readFile(path,"utf8"),note.replace('"format": "scholar-notes-v1"','"format": BAD_JSON'));
  await writeFile(path,note);
  pass("malformed note metadata stops safely instead of reconstructing an old version");
  const exam={id:"frozen",questions:[{id:"q1",prompt:"Which mechanism applies?",options:[{value:"a",label:"First"},{value:"b",label:"Second"}],correctAnswers:["b"]}],transcript:[]};
  const examNote=examDocument("<!-- scholar:generated:start -->\n<!-- scholar:generated:end -->",exam);
  assert.deepEqual(readExamDocument(examNote),exam);
  assert.throws(()=>readExamDocument(examNote.replace("Which mechanism applies?","An edited question?")),/outdated grading key/);
  assert.throws(()=>readExamDocument(examNote.replace("1. First","1. Changed choice")),/outdated grading key/);
  pass("edited exam prompts or choices cannot silently reuse an old answer key");
  console.log(checks+" visible-note verifications passed.");
} finally { await rm(root,{recursive:true,force:true}); }
