import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { extensionPath, jitiPath } from "./sdk.mjs";
const { createJiti } = await import(pathToFileURL(jitiPath).href);
const jiti = createJiti(import.meta.url, { moduleCache: false });
const root = dirname(extensionPath);
const lesson = await jiti.import(join(root, "lesson.ts"));
const { handleNotes } = await jiti.import(join(root, "tool-actions/learning.ts"));
const domain = await jiti.import(join(root, "domain.ts"));
const { questionGroundingIssues } = await jiti.import(join(root, "question-grounding.ts"));
const { transcriptBlock, readTranscript } = await jiti.import(join(root, "note-records.ts"));
const now = "2026-09-12T00:00:00.000Z";
function fixture() {
  const section = { id:"s1", order:1, title:"Vector algebra", startPage:1, endPage:1, objectives:["Interpret direction", "Compute components"], coveredObjectives:[], requiredChecks:["conceptual"],
    status:"learning", synthesis:"A summary is a recap, never a substitute for the instructional explanation.", keyPoints:["Direction changes under reversal"], misconceptions:[], attempts:[], transcript:[], createdAt:now, updatedAt:now,
    figureCoverage:{pages:[{page:1,read:true,viewed:{width:100,height:100},candidates:[],review:{page:1,observation:"No source figures on this test page.",figures:[]}}]},
    objectiveChecks:[{objective:"Interpret direction",checks:["conceptual"]},{objective:"Compute components",checks:["computation"]}] };
  const book = {id:"a".repeat(64), source:{fingerprint:{sha256:"a".repeat(64)}}, chapters:[{id:"c1",startPage:1,endPage:1,sections:[section]}]};
  return {section,book};
}
function input(id, objective, text="Swapping the inputs reverses the resulting arrow. A minus sign represents that reversal, while its length stays unchanged.") {
  return {id,title:objective,markdown:text,objectives:[objective],keyPoints:["Direction changes under reversal"],sourcePages:[1]};
}
function grounding(objective, kind="mastery") { return {purpose:kind,competency:objective,requiredEvidence:["Show the requested reasoning"],sourcePages:[1],basis:[{kind:"objective",value:objective,supports:[1]}]}; }
function pass(objective, kind, id) { return {id,kind,format:"open",outcome:"pass",question:"Explain this result.",grounding:grounding(objective),createdAt:now}; }
let {section,book}=fixture();
section.coveredObjectives=[...section.objectives];
assert(questionGroundingIssues(grounding(section.objectives[0]),book,{mode:"learn",section}).some(x=>/complete Learn explanation/.test(x)));
section.attempts.push(pass(section.objectives[0],"conceptual","one"));
domain.recomputeProgress(book,section);
assert.notEqual(section.status,"complete");
assert.throws(()=>lesson.commitLesson(section,book),/not ready/);
console.log("[PASS] Griffiths summary + coverage + one conceptual pass cannot substitute for instruction");

({section,book}=fixture());
const mutate=async (_id, fn)=> {const copy=structuredClone(book);const result=await fn(copy);Object.assign(book,copy);section=book.chapters[0].sections[0];return {book,result};};
const save= params=>handleNotes(book,{mode:"learn",recordId:"s1"},params,b=>b.chapters[0].sections[0],mutate,(action,summary)=>({content:[{type:"text",text:summary}],details:{action,summary}}));
await save({lesson:input("direction","Interpret direction")});
assert.equal(section.transcript.length,1);
assert.deepEqual(section.coveredObjectives,["Interpret direction"]);
await assert.rejects(save({lessonComplete:true}),/Compute components/);
await save({lesson:input("components","Compute components","Resolve an arrow into horizontal and vertical contributions. Calculate each contribution separately, then recombine them to check the original arrow.")});
await save({lessonComplete:true});
assert(lesson.lessonReady(section,book.source.fingerprint.sha256));
assert.equal(questionGroundingIssues(grounding(section.objectives[0]),book,{mode:"learn",section}).length,0);
const rendered=transcriptBlock(section.transcript);
section.transcript=readTranscript(rendered);
assert(lesson.lessonReady(section));
assert.equal(section.transcript.length,2);
await save({lesson:input("direction","Interpret direction")});
assert.equal(section.transcript.length,2);
domain.appendTranscript(section.transcript,{id:"echo",kind:"assistant",markdown:section.transcript[0].markdown,createdAt:now});
assert.equal(section.transcript.length,2);
console.log("[PASS] explicit partial saves, commit, visible-note round trip, idempotent retry and echo deduplication");

section.attempts=[pass("Interpret direction","conceptual","a")];
domain.recomputeProgress(book,section);assert.notEqual(section.status,"complete");
section.attempts.push(pass("Compute components","computation","b"));
domain.recomputeProgress(book,section);assert.equal(section.status,"complete");
section.attempts[0].outcome="review";
section.attempts.push(pass("Compute components","conceptual","c"));
domain.recomputeProgress(book,section);assert.notEqual(section.status,"complete");
console.log("[PASS] competency evidence cannot be borrowed from an unrelated objective");

section.transcript[0].markdown += "\n\nA learner's own clarification.";
assert(!lesson.lessonReady(section));
assert.throws(()=>lesson.saveLesson(section,book,input("direction","Interpret direction")),/changed/);
const expectedContentHash=lesson.lessonHash(section.transcript[0].markdown);
lesson.saveLesson(section,book,{...input("direction","Interpret direction","A deliberately revised explanation preserves the intended meaning and improves the reasoning between the input order and direction."),expectedContentHash});
assert(!lesson.lessonReady(section));
lesson.commitLesson(section,book);assert(lesson.lessonReady(section));
section.transcript=readTranscript(transcriptBlock(section.transcript).replace(/> \[!info\]- Scholar entry details[\s\S]*?<!-- scholar:entry:end -->/,""));
assert.equal(section.transcript.length,1);assert(!lesson.lessonReady(section));
assert.throws(()=>lesson.saveLesson(section,book,{...input("direction","Interpret direction"),expectedContentHash}),/deleted/);
console.log("[PASS] edits and deletion invalidate readiness, stale retries cannot overwrite or restore them");

assert.throws(()=>lesson.saveLesson(section,book,input("broken","Interpret direction","```mermaid\nflowchart LR\nA-->B")),/fence/);
assert.throws(()=>lesson.saveLesson(section,book,input("reserved","Interpret direction","<!-- scholar:entry:end -->")),/boundaries/);
assert.throws(()=>lesson.saveLesson(section,book,input("code-math","Interpret direction","> [!note] Key equation\n> `t = l / v`")),/display math/);
assert.throws(()=>lesson.saveLesson(section,book,input("h1","Interpret direction","# Duplicate page title\n\nAn explanation.")),/top-level page title/);
assert.equal(lesson.lessonMarkdownIssues("> [!note] Key equation\n> $$\n> t = \\frac{l}{v}\n> $$\n> Meaning: a longer path takes longer.").length,0);
assert.throws(()=>lesson.saveLesson(section,book,{...input("scope","Interpret direction"),sourcePages:[2]}),/scope/);
assert.throws(()=>lesson.saveLesson(section,book,input("figure","Interpret direction","A figure illustrates the reversal.\n\n[[scholar-figure:missing]]")),/vault configuration/);
console.log("[PASS] malformed formatting, scope errors and missing figures are rejected before saving");

({section,book}=fixture());section.status="complete";section.objectiveChecks=undefined;section.attempts=[pass("Interpret direction","conceptual","old")];section.coveredObjectives=[...section.objectives];
domain.migrateLegacyCompletion(book);domain.recomputeProgress(book,section);assert.equal(section.status,"complete");
assert.equal(domain.learnQuestionGrounding(section,grounding("Interpret direction")).purpose,"practice");
console.log("[PASS] previously completed work stays complete and follow-ups remain practice");
