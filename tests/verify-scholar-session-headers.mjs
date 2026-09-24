import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { extensionPath, jitiPath, resolvePiImport, sdkAliases } from "./sdk.mjs";

const { createJiti } = await import(pathToFileURL(jitiPath).href);
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: sdkAliases });
const { runReviewer } = await jiti.import(join(dirname(extensionPath), "review-runtime.ts"));
const { registerSessionResourceCleanup } = await jiti.import(resolvePiImport("@earendil-works/pi-ai"));
const pass = { status: "pass", findings: [] };
const response = (stopReason = "stop") => ({
  role: "assistant", content: [{ type: "text", text: JSON.stringify(pass) }], stopReason,
  usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20 },
});
const baseModel = { id: "fixture", provider: "opencode-go", input: ["text"], contextWindow: 300_000, maxTokens: 32_000 };
const authHeaders = { "x-custom": "preserved", authorization: "fixture" };
let checks = 0;

for (const composed of [false, true]) {
  for (const selected of [
    { provider: "opencode" }, { provider: "opencode-go" },
    { provider: "custom", baseUrl: "https://opencode.ai/zen/go/v1" },
    { provider: "custom", baseUrl: "https://example.com/v1" },
    { provider: "custom", baseUrl: "https://opencode.ai.example.com/v1" },
    { provider: "custom", baseUrl: "invalid url" },
    ...(composed ? [{ provider: "custom", authUrl: "https://opencode.ai/zen/go/v1" }] : []),
  ]) {
    const { authUrl, ...modelOptions } = selected;
    const model = { ...baseModel, ...modelOptions };
    const openCode = selected.provider.startsWith("opencode") || selected.baseUrl === "https://opencode.ai/zen/go/v1" || Boolean(authUrl);
    const seen = [], cleaned = [];
    const unregister = registerSessionResourceCleanup(id => cleaned.push(id));
    const registry = {
      async complete(model, context, request) {
        assert.equal(composed, false);
        const headers = request.transformHeaders ? await request.transformHeaders(authHeaders) : authHeaders;
        seen.push({ request, headers });
        return response(seen.length === 1 ? "length" : "stop");
      },
      ...(composed ? {
        getApiKeyAndHeaders: async () => ({ ok: true, headers: authHeaders, baseUrl: authUrl }),
        getProvider: () => ({ streamSimple(model, context, request) {
          seen.push({ request, headers: request.headers });
          return { result: async () => response(seen.length === 1 ? "length" : "stop") };
        } }),
      } : {}),
    };
    try {
      assert.deepEqual(await runReviewer({
        role: "source", model, modelRegistry: registry, cwd: "fixture", prompt: "Review the evidence.", tools: [],
        sessionId: "host-session", ...(composed ? { thinkingLevel: "off" } : {}),
      }), pass);
      assert.equal(seen.length, 2, "truncated requests retry with the same routing identity");
      for (const { headers } of seen) {
        assert.deepEqual(headers, openCode
          ? { ...authHeaders, "x-opencode-session": "host-session", "x-opencode-client": "pi" }
          : authHeaders);
      }
      assert.equal(seen[0].request.sessionId, seen[1].request.sessionId);
      assert.notEqual(seen[0].request.sessionId, "host-session", "reviewer resources remain isolated");
      assert.deepEqual(cleaned, [seen[0].request.sessionId], "cleanup never tears down the host session");
      checks++;
    } finally { unregister(); }
  }

  const ids = [];
  for (let run = 0; run < 2; run++) {
    const capture = async request => {
      const headers = composed ? request.headers : await request.transformHeaders({});
      assert.ok(headers["x-opencode-session"]);
      assert.equal(headers["x-opencode-session"], request.sessionId);
      ids.push(headers["x-opencode-session"]);
      return response();
    };
    await runReviewer({
      role: "source", model: baseModel, cwd: "fixture", prompt: "Review the evidence.", tools: [],
      modelRegistry: {
        complete: (model, context, request) => capture(request),
        ...(composed ? {
          getApiKeyAndHeaders: async () => ({ ok: true }),
          getProvider: () => ({ streamSimple: (model, context, request) => ({ result: () => capture(request) }) }),
        } : {}),
      },
      ...(composed ? { thinkingLevel: "off" } : {}),
    });
  }
  assert.notEqual(ids[0], ids[1], "standalone reviewers get independent fallback identities");
  checks++;
}
assert.deepEqual(authHeaders, { "x-custom": "preserved", authorization: "fixture" });
console.log(`Scholar session headers: ${checks} checks passed; no paid model calls.`);
