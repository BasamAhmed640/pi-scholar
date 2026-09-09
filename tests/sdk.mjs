// Test-only SDK discovery. Runtime extensions never import this module.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const extensionPath = resolve(process.env.PI_SCHOLAR_EXTENSION || fileURLToPath(new URL("../index.ts", import.meta.url)));
const requireHere = createRequire(import.meta.url);
const packageName = "@earendil-works/pi-coding-agent";

function isPiPackage(directory) {
  try { return JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).name === packageName; }
  catch { return false; }
}

function findPiPackage() {
  if (process.env.PI_SCHOLAR_PI_PACKAGE) {
    const explicit = resolve(process.env.PI_SCHOLAR_PI_PACKAGE);
    if (!isPiPackage(explicit)) throw new Error(`PI_SCHOLAR_PI_PACKAGE is not the ${packageName} package directory: ${explicit}`);
    return explicit;
  }
  const candidates = new Set();
  for (const anchor of [import.meta.url, join(dirname(extensionPath), "package.json"), join(process.cwd(), "package.json")]) {
    const requireFrom = createRequire(anchor);
    for (const modules of requireFrom.resolve.paths(packageName) || []) candidates.add(join(modules, packageName));
    try {
      let directory = dirname(requireFrom.resolve(packageName));
      while (dirname(directory) !== directory) {
        if (isPiPackage(directory)) return directory;
        directory = dirname(directory);
      }
    } catch { /* The package may expose import-only entry points. */ }
  }
  candidates.add(join(dirname(process.execPath), "node_modules", packageName));
  candidates.add(join(dirname(process.execPath), "..", "lib", "node_modules", packageName));
  for (const candidate of candidates) if (isPiPackage(candidate)) return resolve(candidate);
  try {
    const globalModules = execFileSync(process.platform === "win32" ? "cmd.exe" : "npm",
      process.platform === "win32" ? ["/d", "/s", "/c", "npm root --global"] : ["root", "--global"],
      { encoding: "utf8", timeout: 10000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
    const candidate = join(globalModules, packageName);
    if (isPiPackage(candidate)) return resolve(candidate);
  } catch { /* Explicit configuration works without npm on PATH. */ }
  throw new Error(`Cannot locate ${packageName}. Install Pi, or set PI_SCHOLAR_PI_PACKAGE to its package directory (the one containing package.json).`);
}

export const piPackageRoot = findPiPackage();
export const piRequire = createRequire(join(piPackageRoot, "package.json"));
export const loaderPath = join(piPackageRoot, "dist", "core", "extensions", "loader.js");
// Resolve dependencies from Pi so npm hoisting and nonstandard install prefixes work.
export const jitiPath = join(dirname(piRequire.resolve("jiti/package.json")), "lib", "jiti-static.mjs");
export const resolvePiDependency = (name) => piRequire.resolve(name);
export const piVersion = JSON.parse(readFileSync(join(piPackageRoot, "package.json"), "utf8")).version;

export function checkSdkFiles() {
  for (const path of [extensionPath, loaderPath, jitiPath]) {
    if (!existsSync(path)) throw new Error(`Required test input is missing: ${path}. Install or repair Pi; the verified SDK version is 0.85.1.`);
  }
  try { requireHere.resolve("marked"); }
  catch { throw new Error("The test-only Markdown parser is missing. Run npm ci --ignore-scripts in the Scholar package directory."); }
}
