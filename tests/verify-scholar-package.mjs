// Exercise Pi's directory discovery, including the package manifest boundary.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { extensionPath, loaderPath } from "./sdk.mjs";

const directory = dirname(extensionPath);
const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
assert.deepEqual(manifest.pi.extensions, ["./index.ts"]);
const { discoverAndLoadExtensions } = await import(pathToFileURL(loaderPath).href);
const temporary = await mkdtemp(join(tmpdir(), "scholar-package-discovery-"));
try {
  const result = await discoverAndLoadExtensions([directory], temporary, join(temporary, "agent"));
  assert.deepEqual(result.errors, [], "the packaged directory loads without dependency or manifest errors");
  assert.equal(result.extensions.length, 1, "runtime helpers and test dependencies must not become additional extensions");
  assert.ok(result.extensions[0].commands.has("scholar"), "the sole discovered entry point registers Scholar");
  console.log("[PASS] Pi discovers exactly one Scholar extension from the package directory.");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
