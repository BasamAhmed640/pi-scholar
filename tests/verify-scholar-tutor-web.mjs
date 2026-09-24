import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { extensionPath, jitiPath, sdkAliases } from "./sdk.mjs";

const { createJiti } = await import(pathToFileURL(jitiPath).href);
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: sdkAliases });
const web = await jiti.import(join(dirname(extensionPath), "tutor-web.ts"));
const publicAddress = [{ address: "93.184.216.34", family: 4 }];
const response = (status, body = "", headers = {}) => ({ status, body: Buffer.from(body), headers });

for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.1", "169.254.10.1", "100.64.0.1", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "2001:db8::1"]) {
  assert.equal(web.isPublicWebAddress(address), false, address);
}
for (const address of ["8.8.8.8", "93.184.216.34", "2606:4700::1111"]) assert.equal(web.isPublicWebAddress(address), true, address);
console.log("[PASS] private, loopback, link-local, reserved and mapped addresses are refused");

const hops = [];
const redirected = await web.boundedWebGet("https://source.example/start", 1000, undefined, {
  resolve: async host => { hops.push(`dns:${host}`); return publicAddress; },
  transport: async (url, address) => { hops.push(`get:${url.hostname}:${address.address}`); return url.hostname === "source.example"
    ? response(302, "", { location: "https://destination.example/final" })
    : response(200, "done", { "content-type": "text/plain" }); },
});
assert.equal(redirected.url, "https://destination.example/final");
assert.deepEqual(hops, ["dns:source.example", "get:source.example:93.184.216.34", "dns:destination.example", "get:destination.example:93.184.216.34"]);
await assert.rejects(web.boundedWebGet("https://public.example/", 1000, undefined, {
  resolve: async host => host === "private.example" ? [{ address: "127.0.0.1", family: 4 }] : publicAddress,
  transport: async () => response(302, "", { location: "https://private.example/secret" }),
}), /private|loopback|reserved/);
await assert.rejects(web.boundedWebGet("https://public.example/", 1000, undefined, {
  resolve: async () => [...publicAddress, { address: "10.0.0.2", family: 4 }],
  transport: async () => { throw new Error("must not connect"); },
}), /private|loopback|reserved/);
for (const input of ["http://public.example/", "https://user:password@public.example/", "https://public.example:8443/"]) {
  await assert.rejects(web.boundedWebGet(input, 1000, undefined, { resolve: async () => publicAddress }), /HTTPS|443/);
}
await assert.rejects(web.boundedWebGet("https://public.example/", 1000, undefined, {
  resolve: async () => publicAddress,
  transport: async () => response(302, "", { location: "/again" }),
}), /redirect limit/);
await assert.rejects(web.boundedWebGet("https://public.example/", 5, undefined, {
  resolve: async () => publicAddress, transport: async () => response(200, "too many bytes"),
}), /exceeds/);
console.log("[PASS] each redirect gets fresh DNS validation; only HTTPS port 443, three redirects and bounded bytes are allowed");

const rss = `<?xml version="1.0"?><rss><channel>
<item><title>Control &amp; stability</title><link>https://public.example/article</link><description>Feedback &lt;improves&gt; stability.</description></item>
<item><title>Unsafe</title><link>http://private.example/</link><description>Skip</description></item>
</channel></rss>`;
const search = await web.searchTutorWeb("feedback stability", undefined, {
  resolve: async () => publicAddress,
  transport: async () => response(200, rss, { "content-type": "application/rss+xml" }),
});
assert.deepEqual(search, [{ title: "Control & stability", url: "https://public.example/article", snippet: "Feedback <improves> stability." }]);
const read = await web.readTutorWeb("https://public.example/article", undefined, {
  resolve: async () => publicAddress,
  transport: async () => response(200, "<html><head><title>Stable loop</title><script>evil()</script></head><body><p>Feedback &amp; response.</p></body></html>", { "content-type": "text/html" }),
});
assert.equal(read.title, "Stable loop");
assert.match(read.text, /Feedback & response/);
assert.doesNotMatch(read.text, /evil\(\)/);
console.log("[PASS] mocked search/read return brief text and public links without embedded scripts");

let registered;
const pi = { registerTool: tool => { registered = tool; } };
let active = false;
web.registerScholarWeb(pi, async () => active, {
  resolve: async () => publicAddress,
  transport: async () => response(200, rss, { "content-type": "application/rss+xml" }),
});
assert.equal(registered.name, "scholar_web");
const denied = await registered.execute("call-1", { action: "search", query: "feedback" });
assert.equal(denied.isError, true);
assert.match(denied.content[0].text, /active Tutor/);
active = true;
const allowed = await registered.execute("call-2", { action: "search", query: "feedback" });
assert.match(allowed.content[0].text, /^UNTRUSTED EXTERNAL DATA/);
assert.match(allowed.content[0].text, /Control & stability/);
console.log("[PASS] the registered tool checks active Tutor authority and wraps results as untrusted data");

const { ScholarRuntimeCoordinator } = await jiti.import(join(dirname(extensionPath), "runtime-coordinator.ts"));
let activeTools = ["bash", "read"];
const runtime = new ScholarRuntimeCoordinator({
  getActiveTools: () => [...activeTools], setActiveTools: names => { activeTools = [...names]; },
}, () => () => {}, () => {});
runtime.scholarToolRegistered = true;
runtime.quizRegistered = true;
runtime.webRegistered = true;
runtime.runtimeSession.activate("a".repeat(64), "tutor", "tutor-001");
runtime.syncActiveTools();
assert.deepEqual(activeTools.sort(), ["scholar", "scholar_quiz", "scholar_web"].sort());
runtime.runtimeSession.activate("a".repeat(64), "learn", "s1");
runtime.syncActiveTools();
assert.deepEqual(activeTools.sort(), ["scholar", "scholar_quiz"].sort());
runtime.deactivateSession();
assert.deepEqual(activeTools.sort(), ["bash", "read"].sort());
console.log("[PASS] web research appears only in Tutor's active tools and host tools return after exit");
