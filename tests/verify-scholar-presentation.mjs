import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { marked } from "marked";
import { extensionPath, piPackageRoot, jitiPath } from "./sdk.mjs";
const { createJiti } = await import(pathToFileURL(jitiPath));
const extension = dirname(extensionPath);
const jiti = createJiti(import.meta.url, { moduleCache:false, alias:{"@earendil-works/pi-coding-agent":join(piPackageRoot,"dist/index.js")} });
const mod = file => jiti.import(join(extension,file));
const notes = await mod("note-records.ts"), storage = await mod("storage.ts"), paths = await mod("obsidian-paths.ts");
const { unframeQuestion } = await mod("render/callouts.ts");
const { ensureExamAnswerNote } = await mod("exam-paper.ts");
const { parseExamResponses, validateExamAnswerNote } = await mod("exam.ts");
const { renderScholarWorkspace } = await mod("obsidian.ts");
const { installScholarAppearance } = await mod("appearance.ts");
const preview = process.env.SCHOLAR_CALLOUT_PREVIEW;
const root = preview ? resolve(preview) : await mkdtemp(join(tmpdir(),"scholar-callout-test-"));
if(preview) assert.equal(root,resolve(preview),"preview path must be absolute");
const config = {schemaVersion:3,obsidianRoot:join(root,"Scholar Callout Preview"),libraryRoot:join(root,"library"),stateRoot:join(root,"bootstrap"),updatedAt:"2026-09-12T12:00:00.000Z"};
const now=config.updatedAt, hash=bytes=>createHash("sha256").update(bytes).digest("hex");
// Real PNG fixtures, built with Node only: wide and tall figures with white backgrounds.
function png(width,height) {
  const crc=bytes=>{let n=0xffffffff;for(const b of bytes){n^=b;for(let i=0;i<8;i++)n=(n>>>1)^((n&1)?0xedb88320:0);}return (n^0xffffffff)>>>0;};
  const chunk=(type,data)=>{const tag=Buffer.from(type),out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);tag.copy(out,4);data.copy(out,8);out.writeUInt32BE(crc(Buffer.concat([tag,data])),data.length+8);return out;};
  const raw=Buffer.alloc((width*3+1)*height,255);
  for(let y=0;y<height;y++){raw[y*(width*3+1)]=0;for(let x=0;x<width;x++){
    const axis=(x===35||y===height-30), wave=x>35&&x<width-20&&Math.abs(y-(height*.48-Math.sin((x-35)/35)*height*.2*Math.exp(-(x-35)/width)))<2;
    if(axis||wave){const offset=y*(width*3+1)+1+x*3;raw[offset]=axis?80:35;raw[offset+1]=axis?80:120;raw[offset+2]=axis?80:150;}
  }}
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",ihdr),chunk("IDAT",deflateSync(raw)),chunk("IEND",Buffer.alloc(0))]);
}
const wide=png(900,260),tall=png(380,760);
const snapshots=[wide,tall].map((bytes,i)=>({id:`snapshot-${hash(bytes).slice(0,16)}`,page:1,crop:{x:0,y:0,width:i?380:900,height:i?760:260,canvasWidth:1000,canvasHeight:1400},assetFile:`p0001-snapshot-${hash(bytes).slice(0,16)}.png`,sha256:hash(bytes),caption:`Figure 1.${i+1}. ${i?"Tall illustrative trace; all of the source image must remain visible.":"Illustrative travelling signal. Follow the changes along the path."}`,createdAt:now}));
const lesson=[
  "Physical length is only part of the timing story. A signal takes time to travel, so the receiving end responds after a propagation delay. The useful comparison depends on the path and the speed through its medium.",
  "> [!note] Key equation · Propagation delay\n> $$t_d = \\frac{\\ell}{v}$$\n>\n> **Symbols:** $t_d$ → delay; $\\ell$ → path length; $v$ → propagation speed.\n>\n> **Meaning:** For a uniform path with fixed speed, doubling its length doubles its delay.\n>\n> *Source: illustrative fixture, PDF page 1.*",
  "A longer path takes more time when the propagation speed stays fixed. Equal lengths alone do not establish equal delays when the media differ.",
  "> [!example] Explanatory schematic · What determines delay\n> ```mermaid\n> flowchart TD\n>   A[Path length] --> C[Propagation delay]\n>   B[Propagation speed] --> C\n> ```\n>\n> Read both inputs together: neither length nor speed alone determines the delay.\n> *Illustrative fixture, PDF page 1.*",
].join("\n\n");
const pending={id:"pending",kind:"conceptual",format:"open",question:"Using Figure 1.1, explain why a receiver cannot respond to a travelling signal instantly.",outcome:"pending",createdAt:now};
const passed={...pending,id:"passed",format:"multiple-choice",options:["The delay doubles.","The delay halves.","The delay is unchanged."],question:"If speed stays fixed, what happens to delay when the path doubles in length?",outcome:"pass",correctAnswer:"The delay doubles.",feedback:"Delay is proportional to length when propagation speed is fixed. The assumption matters: a change in medium can also change the speed."};
const section={id:"s1",order:1,number:"1.1",title:"Understanding propagation delay",startPage:1,endPage:1,status:"learning",objectives:[],coveredObjectives:[],requiredChecks:[],keyPoints:[],misconceptions:[],attempts:[passed,pending],transcript:[{id:"lesson-1",kind:"assistant",markdown:lesson,createdAt:now}],snapshots,createdAt:now,updatedAt:now};
const exam={id:"exam-001",title:"Exam 01 — Propagation",scope:{chapterIds:["c1"],sectionIds:["s1"],description:"Propagation delay"},status:"active",questions:[{id:"q1",sectionIds:["s1"],claim:"Relates length to delay",requiredEvidence:["Fixed speed"],dimensions:["Reasoning"],format:"multiple-choice",prompt:"Using Figure 1.1, what determines propagation delay?",options:[{value:"a",label:"Path length and propagation speed"},{value:"b",label:"Physical length alone"},{value:"c",label:"Clock frequency alone"}],correctAnswer:"a",explanation:"Delay depends on length and speed.",maxPoints:2}],rawResponses:[],itemResults:[],breakdown:[],earnedPoints:0,maxPoints:2,percent:0,transcript:[],snapshots,createdAt:now,startedAt:now,updatedAt:now};
const tutor={id:"t1",title:"Practice · Propagation delay",status:"active",scope:exam.scope,keyPoints:[],attempts:[passed,pending],transcript:section.transcript,snapshots,createdAt:now,updatedAt:now};
const book={schemaVersion:3,revision:0,id:"f".repeat(64),instanceId:"callout-fixture",source:{absolutePath:join(config.libraryRoot,"Fixture.pdf"),relativePath:"Fixture.pdf",fileName:"Fixture.pdf",format:"pdf",fingerprint:{sha256:"f".repeat(64),size:1,mtimeMs:1}},metadata:{title:"Signals · Presentation fixture",authors:[],pageCount:1},noteDirectory:"Signals Ω",outlineStatus:"ready",chapters:[{id:"c1",number:"1",order:1,title:"Signals",startPage:1,endPage:1,status:"learning",sections:[section]}],exams:[exam],tutorSessions:[tutor],currentSectionId:"s1",createdAt:now,updatedAt:now};
let count=0;const pass=message=>{count++;console.log(`[PASS] ${message}`);};
try {
  await mkdir(config.libraryRoot,{recursive:true});await mkdir(config.obsidianRoot,{recursive:true});await writeFile(book.source.absolutePath,"x");
  for(let i=0;i<snapshots.length;i++){const path=paths.snapshotAssetPath(config,book,snapshots[i]);await mkdir(dirname(path),{recursive:true});await writeFile(path,[wide,tall][i]);}
  await storage.createBookState(config,book);await renderScholarWorkspace(config,[book]);await installScholarAppearance(config);
  const path=paths.sectionNotePath(config,book,book.chapters[0],section),text=await readFile(path,"utf8");
  const reloaded=await storage.loadBookState(config,book.id),saved=reloaded.chapters[0].sections[0];
  assert.deepEqual(saved.attempts,section.attempts);assert.deepEqual(saved.transcript,section.transcript);
  assert.deepEqual(reloaded.exams[0],exam);assert.deepEqual(reloaded.tutorSessions[0].attempts,section.attempts);
  assert.equal(notes.questionChunks(text).length,2);assert.ok(text.includes("> > [!success] Correct"));
  assert.doesNotMatch(notes.questionChunks(text)[1],/Correct answer|\[!success\]/);
  pass("final saved Learn, Tutor and exam callouts round-trip without changing questions or teaching");
  const finalQuestion=notes.questionChunks(text)[1];assert.ok(finalQuestion.includes(snapshots[0].assetFile));assert.ok(!finalQuestion.includes(snapshots[1].assetFile));
  const blocks=marked.lexer(text).filter(t=>t.type==="blockquote");
  assert.ok(blocks.some(t=>t.text.startsWith("[!question] Question 2")&&t.text.includes(snapshots[0].assetFile)));
  assert.equal(blocks.filter(t=>t.text.startsWith("[!example] Figure")).length,0);
  const references=blocks.find(t=>t.text.startsWith("[!note]- Source references"));
  assert.ok(references);assert.equal((references.text.match(/\[!example\] Figure/g)||[]).length,2);
  assert.ok(text.includes("> $$t_d = \\frac{\\ell}{v}$$"));assert.ok(text.includes("> ```mermaid"));
  for(let i=0;i<snapshots.length;i++)assert.equal(hash(await readFile(paths.snapshotAssetPath(config,book,snapshots[i]))),snapshots[i].sha256);
  pass("explicit question figures share the question frame; equations and Mermaid stay expanded, supplemental captures stay collapsed");
  const legacy=text.replace(finalQuestion,unframeQuestion(finalQuestion));await writeFile(path,legacy);
  assert.deepEqual((await storage.loadBookState(config,book.id)).chapters[0].sections[0].attempts,section.attempts);
  await writeFile(path,text.replace(finalQuestion,""));assert.equal((await storage.loadBookState(config,book.id)).chapters[0].sections[0].attempts.length,1);
  await renderScholarWorkspace(config,await storage.listBookStates(config));assert.ok(!(await readFile(path,"utf8")).includes(pending.question));await writeFile(path,text);
  pass("old and new question formats coexist; deleting a whole question frame cannot restore it");
  const code={...pending,question:'Read this code:\n\n```text\n### Question 99\n## Questions\n```\n\nExplain it.'};
  assert.deepEqual(notes.readQuestions(`## Questions\n\n${notes.questionBlock(code,0)}\n<!-- scholar:generated:end -->`),[code]);
  pass("question-like headings inside a fenced example do not become additional questions");
  await ensureExamAnswerNote(config,book,exam);
  const paperPath=paths.examAnswerNotePath(config,book,exam),paper=await readFile(paperPath,"utf8");
  const filled=paper.replace("> - [ ] **a**","> - [x] **a**");validateExamAnswerNote(book,exam,filled);assert.equal(parseExamResponses(exam,filled)[0].response,"a");
  await writeFile(paperPath,filled);await installScholarAppearance(config);await renderScholarWorkspace(config,[book]);assert.equal(await readFile(paperPath,"utf8"),filled);
  pass("native checkboxes stay inside their question and an existing filled paper is never restyled by rewriting");
  const policy=await readFile(join(extension,"policies.ts"),"utf8");
  assert.match(policy,/notes\.lesson\.keyEquations/);assert.match(policy,/Optionally use a small fenced mermaid/);
  const exported=await mod("policies.ts");assert.match(exported.learnInstructions(book,section),/Key equation/);assert.match(exported.tutorInstructions(book,tutor),/mermaid/);assert.doesNotMatch(exported.examInstructions(book,exam),/Native Obsidian presentation/);
  pass("central equations are explicitly framed and Mermaid is optional in Learn/Tutor presentation guidance");
  if(preview){
    await writeFile(join(config.obsidianRoot,".obsidian","app.json"),JSON.stringify({livePreview:true,readableLineLength:true}));
    await writeFile(join(config.obsidianRoot,".obsidian","appearance.json"),JSON.stringify({theme:"obsidian",baseFontSize:18,enabledCssSnippets:["scholar"]}));
    await writeFile(join(config.obsidianRoot,"Callout preview.md"),"# Scholar callout preview\n\n[[1.1 - Understanding propagation delay]]\n\n[[Exam 01 — Propagation]]\n");
    console.log(`Native preview vault: ${config.obsidianRoot}`);
  }
  console.log(`${count} presentation checks passed.`);
} finally { if(!preview) await rm(root,{recursive:true,force:true}); }
