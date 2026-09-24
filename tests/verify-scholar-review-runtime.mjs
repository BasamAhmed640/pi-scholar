import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { extensionPath, piPackageRoot, jitiPath, resolvePiDependency, resolvePiImport, sdkAliases } from "./sdk.mjs";

const { createJiti } = await import(pathToFileURL(jitiPath).href);
const piAiEntry = resolvePiImport("@earendil-works/pi-ai");
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: sdkAliases,
});
const { runReviewer, ReviewerRunError, DEFAULT_REVIEWER_LIMITS, MAX_CONCURRENT_REVIEW_REQUESTS, REVIEWER_REASONING_HEADROOM, REVIEW_TRUNCATION_RETRY_MESSAGE } = await jiti.import(join(dirname(extensionPath), "review-runtime.ts"));
const { Type } = await import(pathToFileURL(resolvePiDependency("typebox")).href);
// Use the actual SDK facade: its complete() delegates to the active runtime.
// The injected runtime below avoids any account/model request or auth file.
const { ModelRegistry } = await import(pathToFileURL(join(piPackageRoot, "dist/core/model-registry.js")).href);

const model = {
  id: "review-fixture", provider: "private-custom-provider", api: "private-api",
  contextWindow: 300_000, maxTokens: 32_000, input: ["text", "image"],
};
const pass = { status: "pass", findings: [] };
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aJcAAAAASUVORK5CYII=";
const usage = { input: 100, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 130,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function message(content = JSON.stringify(pass), stopReason = "stop", extra = {}) {
  return { role: "assistant", content: typeof content === "string" ? [{ type: "text", text: content }] : content,
    api: model.api, provider: model.provider, model: model.id, usage, timestamp: Date.now(), stopReason, ...extra };
}
function call(name = "review_page", args = { page: 1 }, id = "call-1") {
  return { type: "toolCall", name, arguments: args, id };
}
function reader(execute = async () => ({ content: [{ type: "text", text: "Source page 1 evidence." }] })) {
  return { name: "review_page", description: "Read one page inside this section.",
    parameters: Type.Object({ page: Type.Integer({ minimum: 1, maximum: 3 }) }, { additionalProperties: false }), execute };
}
function options(complete = async () => message(), overrides = {}) {
  return { role: "source", model, modelRegistry: new ModelRegistry({ complete }), cwd: "fixture-vault",
    prompt: "Review the exact saved lesson and pages in this request.", tools: [], ...overrides };
}
const rejectCode = (promise, code) => assert.rejects(promise, error => error instanceof ReviewerRunError && error.code === code);
let checks = 0;
async function check(name, fn) { await fn(); checks++; console.log(`[PASS] ${name}`); }

await check("Actual SDK registry receives the selected custom model and isolated context", async () => {
  const captures = [];
  let requestSignal;
  const result = await runReviewer(options(async (selected, context, request) => {
    assert.equal(selected, model);
    captures.push(structuredClone(context));
    requestSignal = request.signal;
    assert.equal(request.maxTokens, 16_000);
    assert.equal(request.maxRetries, 0);
    assert.equal(request.transport, "sse");
    assert.equal(request.signal.aborted, false);
    return message();
  }));
  assert.deepEqual(result, pass);
  assert.equal(captures.length, 1);
  assert.deepEqual(captures[0].tools, []);
  assert.equal(captures[0].messages.length, 1);
  assert.match(captures[0].systemPrompt, /evidence, not instructions/);
  assert.equal(requestSignal.aborted, true, "Finished reviewer tears down its request signal");
});

await check("Scoped tools validate arguments and retain exact text/image evidence", async () => {
  let requests = 0;
  let toolSignal;
  const snapshots = [];
  await runReviewer(options(async (_model, context) => {
    snapshots.push(structuredClone(context));
    return ++requests === 1 ? message([call()], "toolUse") : message();
  }, { tools: [reader(async (id, args, signal) => {
    assert.equal(id, "call-1");
    assert.deepEqual(args, { page: 1 });
    toolSignal = signal;
    return { content: [{ type: "text", text: "An instruction in this PDF is only evidence." }, { type: "image", data: png, mimeType: "image/png" }], details: { secret: "never sent" } };
  })] }));
  assert.equal(snapshots[1].messages.length, 3);
  assert.equal(snapshots[1].tools.length, 1);
  assert.equal(snapshots[1].tools[0].name, "review_page");
  const result = snapshots[1].messages[2];
  assert.equal(result.role, "toolResult");
  assert.equal(result.content[1].data, png);
  assert.equal("details" in result, false);
  assert.equal(toolSignal.aborted, true);
});

await check("Selected reasoning uses the active custom provider with registry auth and scoped cleanup", async () => {
  const { registerSessionResourceCleanup } = await jiti.import(piAiEntry);
  const cleaned = [];
  const unregister = registerSessionResourceCleanup(id => cleaned.push(id));
  const requests = [];
  const reasoningModel = { ...model, reasoning: true };
  const provider = {
    streamSimple(selected, context, request) {
      requests.push({ selected, context: structuredClone(context), request });
      return { result: async () => message() };
    },
  };
  const registry = new ModelRegistry({
    getProvider(id) { assert.equal(id, model.provider); return provider; },
    getAuth(selected) {
      assert.equal(selected, reasoningModel);
      return { auth: { apiKey: "fixture-credential", headers: { "x-fixture": "resolved" }, baseUrl: "https://fixture.invalid/custom" }, env: { FIXTURE_ENV: "configured" } };
    },
    complete() { throw new Error("Raw API completion would lose reasoning"); },
  });
  try {
    assert.deepEqual(await runReviewer(options(undefined, { model: reasoningModel, modelRegistry: registry, thinkingLevel: "high" })), pass);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].request.reasoning, "high");
    // A reasoning reviewer must not spend its whole cap thinking: real audits that finish run
    // 8.5-11.5k output tokens because ~70-90% of the response is thinking, so the request
    // carries the verdict budget plus an explicit reasoning allowance (regression: 4k total
    // truncated verdicts into "limit").
    assert.equal(requests[0].request.maxTokens, DEFAULT_REVIEWER_LIMITS.maxOutputTokens + REVIEWER_REASONING_HEADROOM);
    assert.equal(requests[0].request.transport, "sse");
    assert.equal(requests[0].selected.provider, model.provider);
    assert.equal(requests[0].selected.api, model.api);
    assert.equal(requests[0].selected.baseUrl, "https://fixture.invalid/custom");
    assert.equal(requests[0].request.apiKey, "fixture-credential");
    assert.deepEqual(requests[0].request.headers, { "x-fixture": "resolved" });
    assert.deepEqual(requests[0].request.env, { FIXTURE_ENV: "configured" });
    assert.equal(requests[0].request.signal.aborted, true);
    assert.deepEqual(cleaned, [requests[0].request.sessionId]);
  } finally { unregister(); }
});

await check("Reasoning auth/provider failures fail closed without a model or credential fallback", async () => {
  let streams = 0;
  let fallback = 0;
  for (const auth of [{ ok: false, error: "unavailable" }, Promise.reject(new Error("auth failed"))]) {
    const registry = {
      complete: async () => { fallback++; return message(); },
      getProvider: () => ({ streamSimple: () => { streams++; return { result: async () => message() }; } }),
      getApiKeyAndHeaders: async () => auth,
    };
    await rejectCode(runReviewer(options(undefined, { modelRegistry: registry, thinkingLevel: "high" })), "provider");
  }
  assert.equal(streams, 0);
  assert.equal(fallback, 0);
  await rejectCode(runReviewer(options(undefined, { thinkingLevel: "high" })), "provider");
});

await check("Reasoning is clamped by Pi and cancellation cannot start a late authenticated request", async () => {
  let reasoning;
  const restrictedModel = { ...model, reasoning: true, thinkingLevelMap: { off: null, high: "native-effort" } };
  const registry = {
    complete: async () => { throw new Error("Unexpected raw fallback"); },
    getApiKeyAndHeaders: async () => ({ ok: true }),
    getProvider: () => ({ streamSimple: (_model, _context, request) => {
      reasoning = request.reasoning; return { result: async () => message() };
    } }),
  };
  await runReviewer(options(undefined, { model: restrictedModel, modelRegistry: registry, thinkingLevel: "max" }));
  assert.equal(reasoning, "high");
  const owner = new AbortController();
  let streams = 0;
  let releaseAuth;
  registry.getApiKeyAndHeaders = async () => {
    owner.abort();
    return new Promise(resolve => { releaseAuth = resolve; });
  };
  registry.getProvider = () => ({ streamSimple: () => { streams++; return { result: async () => message() }; } });
  await rejectCode(runReviewer(options(undefined, { modelRegistry: registry, thinkingLevel: "high", signal: owner.signal })), "cancelled");
  releaseAuth({ ok: true });
  await Promise.resolve();
  assert.equal(streams, 0, "Late registry auth must never start a cancelled review's request");
});

await check("A verdict truncated by the output cap is retried once with the model's full allowance and an instruction to finish", async () => {
  const caps = [];
  const contexts = [];
  const truncating = (output) => message(JSON.stringify(pass).slice(0, 40), "length", { usage: { ...usage, output } });
  const complete = async (_selected, context, request) => {
    caps.push(request.maxTokens);
    contexts.push(structuredClone(context));
    return caps.length === 1 ? truncating(4_000) : message();
  };
  assert.deepEqual(await runReviewer(options(complete)), pass);
  assert.equal(caps.length, 2, "a truncated verdict is re-issued once");
  assert.equal(caps[0], DEFAULT_REVIEWER_LIMITS.maxOutputTokens, "the first attempt carries the verdict budget");
  assert.ok(caps[1] > caps[0], `the retry widens the output cap (${caps[0]} -> ${caps[1]})`);
  assert.equal(caps[1], model.maxTokens, "the retry spends the model's whole output allowance");
  assert.equal(contexts[0].messages.length, 1, "the first request carries only the prepared prompt");
  assert.equal(contexts[1].messages.length, 3, "the retry carries the truncated verdict and the finish instruction");
  assert.equal(contexts[1].messages[1].stopReason, "length");
  assert.equal(contexts[1].messages[2].role, "user");
  assert.equal(contexts[1].messages[2].content, REVIEW_TRUNCATION_RETRY_MESSAGE);
  // With no allowance left, the same truncation fails closed instead of looping or approving.
  const exhausted = async () => { caps.length = 0; await rejectCode(runReviewer(options(async () => truncating(8_000), { limits: { maxTotalOutputTokens: 8_000 } })), "limit"); };
  await exhausted();
  // A retry that is also cut off must fail closed after exactly one retry, never loop.
  const twiceTruncated = [];
  await rejectCode(runReviewer(options(async (_selected, _context, request) => {
    twiceTruncated.push(request.maxTokens);
    return truncating(4_000);
  })), "limit");
  assert.equal(twiceTruncated.length, 2, "a second truncation fails closed instead of starting another review");
  assert.ok(twiceTruncated[1] > twiceTruncated[0], "the single retry still widened the cap before failing closed");
});

await check("A truncated audit measured at ~12.5k thinking tokens is retried under the production default budget", async () => {
  // Reproduces the reported receipts: the first attempt is cut off at 12,461 output tokens
  // while still thinking. Under the old 8k/16k default budget only 3,539 remained, below the
  // 12,096 cap, so escalation could not fire and the section latched; the default budget in
  // force must retry. This check reads DEFAULT_REVIEWER_LIMITS, so it fails if the defaults
  // regress to the old values.
  const measured = message(JSON.stringify(pass).slice(0, 40), "length", { usage: { ...usage, output: 12_461 } });
  const caps = [];
  const complete = async (_s, _c, request) => { caps.push(request.maxTokens); return caps.length === 1 ? measured : message(); };
  assert.deepEqual(await runReviewer(options(complete)), pass);
  assert.equal(caps.length, 2, "the measured truncation is retried once under the widened budget");
  assert.ok(caps[1] > caps[0], "the retry carries more output allowance than the truncated attempt");
  // The same measured truncation under the old 8k/16k budget latched instead of escalating.
  const oldCaps = [];
  await rejectCode(runReviewer(options(async (_s, _c, request) => {
    oldCaps.push(request.maxTokens);
    return measured;
  }, { limits: { maxOutputTokens: 8_000, maxTotalOutputTokens: 16_000 } })), "limit");
  assert.equal(oldCaps.length, 1, "the old 8k/16k budget could not escalate and latched instead");
});

await check("Malformed and incomplete model verdicts fail closed", async () => {
  for (const raw of ["Looks good", '{"status":"pass"', '{"status":"pass","findings":[],"extra":true}', '{"status":"changes","findings":[]}']) {
    await rejectCode(runReviewer(options(async () => message(raw))), "invalid-output");
  }
  for (const reason of ["length", "error", "aborted", "deferred", "pending"]) {
    await rejectCode(runReviewer(options(async () => message(JSON.stringify(pass), reason))), reason === "length" ? "limit" : "provider");
  }
  await rejectCode(runReviewer(options(async () => message([], "toolUse"))), "invalid-output");
  await rejectCode(runReviewer(options(async () => message([call()], "stop"))), "invalid-output");
});

await check("Unavailable tools, invalid arguments, and failed readers cannot approve", async () => {
  let executions = 0;
  const tool = reader(async () => { executions++; return { content: [{ type: "text", text: "evidence" }] }; });
  for (const toolCall of [call("write"), call("review_page", { page: 4 }), call("review_page", { page: 1, path: "other-vault" })]) {
    await rejectCode(runReviewer(options(async () => message([toolCall], "toolUse"), { tools: [tool] })), "tool");
  }
  assert.equal(executions, 0);
  for (const execute of [async () => { throw new Error("failed reader"); }, async () => ({ content: [] }), async () => ({ content: [{ type: "text", text: "error" }], isError: true })]) {
    await rejectCode(runReviewer(options(async () => message([call()], "toolUse"), { tools: [reader(execute)] })), "tool");
  }
  let requests = 0;
  await rejectCode(runReviewer(options(async () => message([call()], "toolUse"), { tools: [reader(async () => {
    requests++; return { content: [{ type: "text", text: "ok" }] };
  })], limits: { maxTurns: 4 } })), "tool");
  assert.equal(requests, 1, "A repeated tool ID is rejected before a second execution");
  assert.deepEqual(
    { turns: DEFAULT_REVIEWER_LIMITS.maxTurns, tools: DEFAULT_REVIEWER_LIMITS.maxToolCalls, images: DEFAULT_REVIEWER_LIMITS.maxImages,
      output: DEFAULT_REVIEWER_LIMITS.maxOutputTokens, total: DEFAULT_REVIEWER_LIMITS.maxTotalOutputTokens, text: DEFAULT_REVIEWER_LIMITS.maxToolTextChars },
    { turns: 2, tools: 8, images: 8, output: 16_000, total: 48_000, text: 40_000 },
    "the default reviewer budget is one bounded prepared request");
});

await check("Prompt, context, output, turn, and tool-count limits stop extra work", async () => {
  let called = 0;
  const complete = async () => { called++; return message(); };
  await rejectCode(runReviewer(options(complete, { limits: { maxPromptChars: 3 } })), "limit");
  await rejectCode(runReviewer(options(complete, { model: { ...model, contextWindow: 4096 } })), "limit");
  assert.equal(called, 0);
  await rejectCode(runReviewer(options(async () => message(), { limits: { maxResponseChars: 5 } })), "limit");
  await rejectCode(runReviewer(options(async () => message(), { limits: { maxTotalOutputTokens: 256 }, model: { ...model, maxTokens: 512 },
    modelRegistry: new ModelRegistry({ complete: async () => message(undefined, "stop", { usage: { ...usage, output: 257 } }) }) })), "limit");
  let toolCount = 0;
  const tool = reader(async () => { toolCount++; return { content: [{ type: "text", text: "ok" }] }; });
  await rejectCode(runReviewer(options(async () => message([call()], "toolUse"), { tools: [tool], limits: { maxTurns: 1 } })), "limit");
  await rejectCode(runReviewer(options(async () => message([call(), call("review_page", { page: 2 }, "call-2")], "toolUse"), {
    tools: [tool], limits: { maxToolCalls: 1 },
  })), "limit");
  assert.equal(toolCount, 0);
});

await check("Evidence limits reject rather than silently truncating text or crops", async () => {
  for (const [content, limits] of [
    [[{ type: "text", text: "12345" }], { maxToolTextChars: 4 }],
    [[{ type: "image", data: png, mimeType: "image/png" }], { maxImageBytes: 1 }],
    [[{ type: "image", data: png, mimeType: "image/png" }, { type: "image", data: png, mimeType: "image/png" }], { maxImages: 1 }],
    [[{ type: "image", data: png, mimeType: "image/png" }], { maxTotalImageBytes: 1 }],
  ]) {
    await rejectCode(runReviewer(options(async () => message([call()], "toolUse"), {
      tools: [reader(async () => ({ content }))], limits,
    })), "limit");
  }
  await rejectCode(runReviewer(options(async () => message([call()], "toolUse"), {
    tools: [reader(async () => ({ content: [{ type: "image", data: png, mimeType: "image/png" }] }))], model: { ...model, input: ["text"] },
  })), "configuration");
});

await check("Observed context usage and accumulated reader output bound later turns", async () => {
  let requests = 0;
  await rejectCode(runReviewer(options(async () => {
    requests++;
    return message([call()], "toolUse", { usage: { ...usage, input: 280_000 } });
  }, { tools: [reader()] })), "limit");
  assert.equal(requests, 1, "Oversized provider-reported context blocks the second request");
  requests = 0;
  await rejectCode(runReviewer(options(async () => message([call("review_page", { page: 1 }, `call-${++requests}`)], "toolUse"), {
    tools: [reader(async () => ({ content: [{ type: "text", text: "abc" }] }))], limits: { maxToolTextChars: 5 },
  })), "limit");
  assert.equal(requests, 2, "The tool-text allowance applies across the entire isolated review");
});

await check("Cancellation before starting and during a provider request is final", async () => {
  const before = new AbortController();
  before.abort();
  let calls = 0;
  await rejectCode(runReviewer(options(async () => { calls++; return message(); }, { signal: before.signal })), "cancelled");
  assert.equal(calls, 0);
  const during = new AbortController();
  let captured;
  await rejectCode(runReviewer(options(async (_model, _context, request) => {
    captured = request.signal;
    during.abort();
    return new Promise(() => {}); // A noncooperating provider must not hang the owner.
  }, { signal: during.signal })), "cancelled");
  assert.equal(captured.aborted, true);
});

await check("Cancellation tears down readers and prevents a follow-up request", async () => {
  const owner = new AbortController();
  let calls = 0;
  let captured;
  await rejectCode(runReviewer(options(async () => { calls++; return message([call()], "toolUse"); }, {
    signal: owner.signal, tools: [reader(async (_id, _args, signal) => {
      captured = signal;
      owner.abort();
      return new Promise(() => {});
    })],
  })), "cancelled");
  assert.equal(calls, 1);
  assert.equal(captured.aborted, true);
});

await check("Timeout and progress-handler exceptions cannot become approval", async () => {
  let captured;
  await rejectCode(runReviewer(options(async (_model, _context, request) => {
    captured = request.signal;
    return new Promise(() => {});
  }, { limits: { timeoutMs: 20 } })), "timeout");
  assert.equal(captured.aborted, true);
  assert.deepEqual(await runReviewer(options(undefined, { onProgress() { throw new Error("UI is closed"); } })), pass);
  assert.deepEqual(await runReviewer(options(undefined, { onProgress: async () => { throw new Error("Async UI is closed"); } })), pass);
});

await check("Parallel review contexts never share messages or tool state", async () => {
  const snapshots = [];
  const registry = new ModelRegistry({ complete: async (_model, context) => {
    snapshots.push(structuredClone(context));
    return message();
  } });
  await Promise.all([
    runReviewer(options(undefined, { modelRegistry: registry, role: "source", prompt: "Only source draft A", tools: [reader()] })),
    runReviewer(options(undefined, { modelRegistry: registry, role: "teaching", prompt: "Only teaching draft B", tools: [] })),
  ]);
  assert.equal(snapshots[0].messages[0].content, "Only source draft A");
  assert.equal(snapshots[1].messages[0].content, "Only teaching draft B");
  assert.equal(snapshots[0].tools.length, 1);
  assert.equal(snapshots[1].tools.length, 0);
});

await check("reviewer requests share one process-wide four-slot semaphore", async () => {
  let active = 0, peak = 0, started = 0;
  const held = [];
  const registry = new ModelRegistry({ complete: async () => {
    active++; started++; peak = Math.max(peak, active);
    return new Promise(resolve => held.push(() => { active--; resolve(message()); }));
  } });
  const tasks = Array.from({ length: 9 }, (_, index) => runReviewer(options(undefined, {
    modelRegistry: registry, prompt: `Review independent unit ${index}.`,
  })));
  const until = async predicate => {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > 2_000) throw new Error("Reviewer semaphore did not advance");
      await new Promise(resolve => setTimeout(resolve, 2));
    }
  };
  await until(() => started === MAX_CONCURRENT_REVIEW_REQUESTS);
  assert.equal(active, 4);
  assert.equal(held.length, 4);
  for (let wave = 0; wave < 3; wave++) {
    const release = held.splice(0);
    release.forEach(done => done());
    if (started < 9) await until(() => held.length > 0);
  }
  await Promise.all(tasks);
  assert.equal(started, 9);
  assert.equal(peak, MAX_CONCURRENT_REVIEW_REQUESTS);
});

await check("Invalid configuration and accounting fail before misleading completion", async () => {
  for (const limits of [{ maxTurns: 0 }, { timeoutMs: Infinity }, { timeoutMs: 2 ** 40 }, { maxImages: -1 }, { surprise: 1 }]) {
    await rejectCode(runReviewer(options(undefined, { limits })), "configuration");
  }
  await rejectCode(runReviewer(options(undefined, { tools: [{ ...reader(), name: "bash" }] })), "configuration");
  await rejectCode(runReviewer(options(undefined, { tools: [reader(), reader()] })), "configuration");
  await rejectCode(runReviewer(options(async () => message(undefined, "stop", { usage: { ...usage, output: -1 } }))), "invalid-output");
  assert.ok(Object.isFrozen(DEFAULT_REVIEWER_LIMITS));
});

await check("Evidence preparation shares the deadline and cannot start a late model request", async () => {
  let requests=0, release;
  const pending=new Promise(resolve=>{release=resolve;});
  await rejectCode(runReviewer(options(async()=>{requests++;return message();},{prepareEvidence:()=>pending,limits:{timeoutMs:25}})),"timeout");
  release([{type:"text",text:"Late source evidence"}]);
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(requests,0);
});
await check("Provider failures retain safe category and execution counters without leaking request secrets", async () => {
  try { await runReviewer(options(async()=>message([],"error",{errorMessage:"WebSocket disconnected https://private.invalid?api_key=secret-test"})));assert.fail(); }
  catch(error){assert.equal(error.code,"provider");assert.match(error.message,/connection failure/);assert.match(error.message,/1 model turns/);assert.doesNotMatch(error.message,/secret-test|private.invalid/);}
});
await check("A response buffered across sleep cannot beat an overdue timer and approve", async () => {
  const realNow = Date.now; let now = realNow(); Date.now = () => now;
  try {
    await rejectCode(runReviewer(options(async () => { now += 60_000; return message(); }, { limits: { timeoutMs: 1000 } })), "timeout");
    let calls = 0;
    await rejectCode(runReviewer(options(async () => { calls++; return message(); }, {
      prepareEvidence: async () => { now += 60_000; return [{ type: "text", text: "late evidence" }]; }, limits: { timeoutMs: 1000 },
    })), "timeout");
    assert.equal(calls, 0);
  } finally { Date.now = realNow; }
});
await check("Actual SDK streams report liveness without leaking reasoning and still return one verdict", async () => {
  const { createAssistantMessageEventStream } = await jiti.import(piAiEntry);
  const events = [], requestIds = [];
  const registry = new ModelRegistry({ complete() { throw new Error("unexpected raw completion"); },
    getAuth() { return { auth: { apiKey: "fixture" } }; },
    getProvider() { return { streamSimple(_model, _context, request) {
      requestIds.push(request.sessionId);
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "thinking_delta", contentIndex: 0, delta: "PRIVATE REASONING", partial: message() });
        stream.push({ type: "done", reason: "stop", message: message() });
        stream.end();
      });
      return stream;
    } }; },
  });
  assert.deepEqual(await runReviewer(options(undefined, { model: { ...model, reasoning: true }, modelRegistry: registry,
    thinkingLevel: "high", onProgress: event => events.push(event) })), pass);
  assert.equal(requestIds.length, 1);
  assert.ok(events.some(event => event.stage === "stream" && event.toolName === "reasoning"));
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE/);
});
await check("Cancellation ends a stalled SDK stream observer and ignores its late verdict", async () => {
  const { createAssistantMessageEventStream } = await jiti.import(piAiEntry);
  const stream = createAssistantMessageEventStream(), owner = new AbortController(), events = [];
  const registry = new ModelRegistry({ complete() { throw new Error("unexpected raw completion"); },
    getAuth() { return { auth: { apiKey: "fixture" } }; },
    getProvider() { return { streamSimple() { setTimeout(() => owner.abort(), 10); return stream; } }; },
  });
  await rejectCode(runReviewer(options(undefined, { model: { ...model, reasoning: true }, modelRegistry: registry,
    thinkingLevel: "high", signal: owner.signal, onProgress: event => events.push(event) })), "cancelled");
  const count = events.length;
  stream.push({ type: "done", reason: "stop", message: message() }); stream.end();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(events.length, count);
  assert.equal(events.some(event => event.stage === "complete"), false);
});
console.log(`Scholar reviewer runtime: ${checks} checks passed with the installed Pi SDK; no paid model calls.`);
