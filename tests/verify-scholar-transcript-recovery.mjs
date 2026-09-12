import { extensionPath as packagedExtensionPath, piPackageRoot as sdkRoot, jitiPath as sdkJitiPath, resolvePiDependency } from "./sdk.mjs";
// Focused verification suite for Scholar transcript recovery & routing (Stage 2)
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = sdkRoot;
const { createJiti } = await import(pathToFileURL(sdkJitiPath).href);
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: {
    "@earendil-works/pi-coding-agent": join(packageRoot, "dist", "index.js"),
  },
});

const extensionRoot = dirname(packagedExtensionPath);
const {
  freezeRecoveryTarget,
  freezeExplicitTarget,
  recoverTranscriptTarget,
  isSameVaultPath,
} = await jiti.import(join(extensionRoot, "transcript-recovery.ts"));
const { SCHOLAR_SESSION_STATE_TYPE } = await jiti.import(join(extensionRoot, "runtime-session.ts"));
const { SCHOLAR_QUIZ_TOOL_NAME } = await jiti.import(join(extensionRoot, "quiz-contract.ts"));
const { appendTranscript, messageTranscriptEntry } = await jiti.import(join(extensionRoot, "domain.ts"));


let reads=0,writes=0;
for (const isAutomatic of [true,false]) for (const branch of [[],[{type:"message",message:{role:"assistant",content:[{type:"text",text:"DELETED QUESTION"}]}}],[{type:"custom",customType:SCHOLAR_SESSION_STATE_TYPE,data:{active:true,bookId:"a".repeat(64),instanceId:"same",mode:"learn",recordId:"s1"}},{type:"message",message:{role:"toolResult",toolName:SCHOLAR_QUIZ_TOOL_NAME,toolCallId:"old",details:{status:"answered",correct:true}}}]]) {
 const result=await recoverTranscriptTarget({target:{vaultPath:"C:/vault",bookId:"a".repeat(64),instanceId:"same",mode:"learn",recordId:"s1"},branch,isAutomatic,loadBook:async()=>{reads++;},mutateBook:async()=>{writes++;}});
 assert.equal(result.kind,"noop");
}
assert.equal(reads,0);assert.equal(writes,0);
assert.equal(freezeExplicitTarget("", "a", "i", "learn", "s"),undefined);
assert.equal(freezeExplicitTarget("C:/vault", "a", "i", "learn", "s").recordId,"s");
console.log("[PASS] Pi history never reads, reconstructs, or grades a visible note, automatically or explicitly.");
