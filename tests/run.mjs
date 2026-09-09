import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const files = (await readdir(directory)).filter((name) => /^verify-scholar-[a-z0-9-]+\.mjs$/.test(name)).sort();
const args = process.argv.slice(2);
if (args.includes("--list")) {
  console.log(files.join("\n"));
  console.log(`${files.length} packaged verifiers`);
  process.exit(0);
}
if (args.some((argument) => argument !== "--preflight")) {
  console.error("Usage: npm test [-- --list | --preflight]");
  process.exit(1);
}

let sdk;
try {
  sdk = await import("./sdk.mjs");
  sdk.checkSdkFiles();
  await import(pathToFileURL(sdk.loaderPath).href);
  await import(pathToFileURL(sdk.jitiPath).href);
  if (files.length === 0) throw new Error("No packaged verifiers were found.");
} catch (error) {
  console.error(`[BLOCKED] Test environment: ${error.message}`);
  console.error("No Scholar checks ran. Install the prerequisites described in README.md, then retry.");
  process.exit(1);
}
console.log(`Scholar: ${sdk.extensionPath}`);
console.log(`Pi SDK: ${sdk.piVersion} (${sdk.piPackageRoot})`);
if (sdk.piVersion !== "0.85.1") console.warn("This SDK version is outside the verified 0.85.1 baseline; results also test SDK compatibility.");
if (args.includes("--preflight")) {
  console.log("[PASS] SDK and test dependencies load.");
  process.exit(0);
}

const temporary = await mkdtemp(join(tmpdir(), "scholar-packaged-tests-"));
let failures = 0;
try {
  for (const file of files) {
    console.log(`\n=== ${file} ===`);
    const env = { ...process.env, PI_SCHOLAR_EXTENSION: sdk.extensionPath, PI_SCHOLAR_PI_PACKAGE: sdk.piPackageRoot,
      PI_SCHOLAR_STATE_ROOT: join(temporary, "bootstrap") };
    delete env.PI_SCHOLAR_LIBRARY_ROOT;
    delete env.PI_SCHOLAR_OBSIDIAN_ROOT;
    delete env.SCHOLAR_DESIGN_PREVIEW;
    const passed = await new Promise((done) => {
      const child = spawn(process.execPath, [join(directory, file)], { cwd: temporary, env, stdio: "inherit", windowsHide: true });
      child.once("error", (error) => { console.error(error.message); done(false); });
      child.once("exit", (code) => done(code === 0));
    });
    if (!passed) failures++;
    console.log(`[${passed ? "PASS" : "FAIL"}] ${file}`);
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
console.log(`\nScholar: ${files.length - failures} verifier(s) passed, ${failures} failed.`);
process.exitCode = failures ? 1 : 0;
