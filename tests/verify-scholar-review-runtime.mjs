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
const { runReviewer, ReviewerRunError, DEFAULT_REVIEWER_LIMITS } = await jiti.import(join(dirname(extensionPath), "review-runtime.ts"));
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
    assert.equal(request.maxTokens, 12_000);
    assert.equal(request.maxRetries, 0);
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
  })] })), "tool");
  assert.equal(requests, 1, "A repeated tool ID is rejected before a second execution");
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

await check("Invalid configuration and accounting fail before misleading completion", async () => {
  for (const limits of [{ maxTurns: 0 }, { timeoutMs: Infinity }, { timeoutMs: 2 ** 40 }, { maxImages: -1 }, { surprise: 1 }]) {
    await rejectCode(runReviewer(options(undefined, { limits })), "configuration");
  }
  await rejectCode(runReviewer(options(undefined, { tools: [{ ...reader(), name: "bash" }] })), "configuration");
  await rejectCode(runReviewer(options(undefined, { tools: [reader(), reader()] })), "configuration");
  await rejectCode(runReviewer(options(async () => message(undefined, "stop", { usage: { ...usage, output: -1 } }))), "invalid-output");
  assert.ok(Object.isFrozen(DEFAULT_REVIEWER_LIMITS));
});

console.log(`Scholar reviewer runtime: ${checks} checks passed with the installed Pi SDK; no paid model calls.`);
