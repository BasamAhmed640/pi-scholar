import { extensionPath as packagedExtensionPath, piPackageRoot as sdkRoot, jitiPath as sdkJitiPath } from "./sdk.mjs";
// Built-in styling must be safe, portable, automatic and idempotent.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const piRoot = sdkRoot;
const { createJiti } = await import(pathToFileURL(sdkJitiPath).href);
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: {
  "@earendil-works/pi-coding-agent": join(piRoot, "dist", "index.js"),
} });
const extensionPath = resolve(process.env.PI_SCHOLAR_EXTENSION || packagedExtensionPath);
const { installScholarAppearance, ensureScholarAppearance } = await jiti.import(join(dirname(extensionPath), "appearance.ts"));
const { createExtensionRuntime, loadExtensions } = await import(pathToFileURL(join(piRoot, "dist", "core", "extensions", "loader.js")).href);
const root = await mkdtemp(join(tmpdir(), "scholar-appearance-"));
const library = join(root, "library");
await mkdir(library);
const envNames = ["PI_SCHOLAR_OBSIDIAN_ROOT", "PI_SCHOLAR_LIBRARY_ROOT", "PI_SCHOLAR_STATE_ROOT"];
const savedEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
for (const name of envNames) delete process.env[name];
const config = (vault) => ({ schemaVersion: 3, libraryRoot: library, obsidianRoot: vault, stateRoot: join(root, "bootstrap"), updatedAt: "2026-01-01T00:00:00.000Z" });
const settings = (vault) => join(vault, ".obsidian", "appearance.json");
const snippet = (vault) => join(vault, ".obsidian", "snippets", "scholar.css");
const receipt = (vault) => join(vault, ".obsidian", "scholar-appearance.json");
const shippedCss = await readFile(join(dirname(extensionPath), "scholar.css"), "utf8");
const cssHash = (css) => createHash("sha256").update(css).digest("hex");
const receiptFor = (css) => ({ schemaVersion: 1, installedCssSha256: cssHash(css) });
async function vault(name) { const path = join(root, name); await mkdir(path); return path; }
async function put(path, text) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, text); }
const exists = async (path) => stat(path).then(() => true, (error) => error.code === "ENOENT" ? false : Promise.reject(error));
const snapshots = (paths) => Promise.all(paths.map(async (path) => [await readFile(path), (await stat(path)).mtimeMs]));
let passed = 0, failed = 0;
async function check(name, test) {
  try { await test(); passed++; console.log(`[PASS] ${name}`); }
  catch (error) { failed++; console.error(`[FAIL] ${name}: ${error.stack}`); }
}

// Simulate Obsidian editing its own preferences at a deterministic I/O boundary
// after Scholar's initial validation. Only this test process's read is wrapped.
async function duringStylesRead(update, operation) {
  const originalRead = fsPromises.readFile;
  const cssUrl = pathToFileURL(join(dirname(extensionPath), "scholar.css")).href;
  let updated = false;
  fsPromises.readFile = async (target, ...args) => {
    const result = await originalRead(target, ...args);
    if (!updated && target?.href === cssUrl) {
      updated = true;
      await update();
    }
    return result;
  };
  syncBuiltinESMExports();
  try {
    const controlled = await jiti.import(join(dirname(extensionPath), "appearance.ts"));
    await operation(controlled);
    assert.ok(updated, "the concurrent edit was exercised");
  }
  finally { fsPromises.readFile = originalRead; syncBuiltinESMExports(); }
}

// Exercise genuine version changes through the installer, without editing the
// extension's shipped CSS or creating fixtures in any configured user vault.
async function withShippedStyles(css, operation) {
  const originalRead = fsPromises.readFile;
  const cssUrl = pathToFileURL(join(dirname(extensionPath), "scholar.css")).href;
  let read = false;
  fsPromises.readFile = async (target, ...args) => {
    if (target?.href === cssUrl) {
      read = true;
      return args[0] === "utf8" ? css : Buffer.from(css);
    }
    return originalRead(target, ...args);
  };
  syncBuiltinESMExports();
  try {
    const controlled = await jiti.import(join(dirname(extensionPath), "appearance.ts"));
    await operation(controlled);
    assert.ok(read, "the alternate shipped version was exercised");
  }
  finally { fsPromises.readFile = originalRead; syncBuiltinESMExports(); }
}
try {
  await check("blank initial vault does not create folders or invent paths", async () => {
    const before = await readdir(root);
    await installScholarAppearance(config(""));
    assert.deepEqual(await readdir(root), before);
  });
  const main = await vault("main");
  await check("first setup adds scoped snippet, enablement and vault-local receipt, preserving preferences", async () => {
    const original = { theme: "obsidian", baseFontSize: 17, custom: { retained: true }, enabledCssSnippets: ["my-notes"] };
    await put(settings(main), JSON.stringify(original));
    await installScholarAppearance(config(main));
    assert.deepEqual(JSON.parse(await readFile(settings(main), "utf8")), { ...original, enabledCssSnippets: ["my-notes", "scholar"] });
    assert.equal(await readFile(snippet(main), "utf8"), shippedCss);
    assert.deepEqual(JSON.parse(await readFile(receipt(main), "utf8")), receiptFor(shippedCss));
    assert.deepEqual(await readdir(main), [".obsidian"]);
    assert.deepEqual((await readdir(join(main, ".obsidian"))).sort(), ["appearance.json", "scholar-appearance.json", "snippets"]);
    assert.equal(await exists(join(root, "bootstrap")), false);
    assert.deepEqual(await readdir(library), []);
  });
  await check("repeated setup preserves snippet, preferences and receipt bytes and mtimes", async () => {
    const paths = [settings(main), snippet(main), receipt(main)];
    const before = await snapshots(paths);
    await Promise.all([installScholarAppearance(config(main)), installScholarAppearance(config(main))]);
    assert.deepEqual(await snapshots(paths), before);
  });
  await check("genuine installed styling upgrades without rewriting appearance bytes or enablement", async () => {
    const path = await vault("genuine-upgrade");
    const olderCss = "/* Scholar built-in note styling. Older shipped version */\n.markdown-preview-view.scholar-note { color: inherit; }\n";
    await withShippedStyles(olderCss, (controlled) => controlled.installScholarAppearance(config(path)));
    assert.deepEqual(JSON.parse(await readFile(receipt(path), "utf8")), receiptFor(olderCss));
    const appearanceBefore = await snapshots([settings(path)]);
    await installScholarAppearance(config(path));
    assert.deepEqual(await snapshots([settings(path)]), appearanceBefore);
    assert.equal(await readFile(snippet(path), "utf8"), shippedCss);
    assert.deepEqual(JSON.parse(await readFile(receipt(path), "utf8")), receiptFor(shippedCss));
  });
  for (const disabled of [[], ["personal"], undefined]) {
    await check(`disabled styling stays disabled across restarts and shipped upgrades (${JSON.stringify(disabled)})`, async () => {
      const path = await vault(`disabled-${String(disabled)}`);
      await installScholarAppearance(config(path));
      const prefs = { theme: "moonstone", ...(disabled === undefined ? {} : { enabledCssSnippets: disabled }) };
      await writeFile(settings(path), JSON.stringify(prefs));
      const before = await snapshots([settings(path)]);
      await Promise.all([installScholarAppearance(config(path)), installScholarAppearance(config(path))]);
      const newerCss = `${shippedCss}\n/* Next shipped release */\n`;
      await withShippedStyles(newerCss, (controlled) => controlled.installScholarAppearance(config(path)));
      assert.equal(await readFile(snippet(path), "utf8"), newerCss);
      assert.deepEqual(JSON.parse(await readFile(receipt(path), "utf8")), receiptFor(newerCss));
      await withShippedStyles(newerCss, (controlled) => controlled.installScholarAppearance(config(path)));
      assert.deepEqual(await snapshots([settings(path)]), before);
    });
  }
  await check("deleting appearance preferences after setup does not re-enable styling", async () => {
    const path = await vault("removed-preferences");
    await installScholarAppearance(config(path));
    await rm(settings(path));
    await installScholarAppearance(config(path));
    assert.equal(await exists(settings(path)), false);
  });
  for (const enabled of [[], ["personal"], ["scholar"], undefined]) {
    await check(`identical legacy CSS is adopted without changing preferences (${JSON.stringify(enabled)})`, async () => {
      const path = await vault(`legacy-${String(enabled)}`);
      await put(snippet(path), shippedCss);
      await put(settings(path), JSON.stringify({ theme: "obsidian", ...(enabled === undefined ? {} : { enabledCssSnippets: enabled }) }));
      const before = await snapshots([settings(path), snippet(path)]);
      await installScholarAppearance(config(path));
      assert.deepEqual(await snapshots([settings(path), snippet(path)]), before);
      assert.deepEqual(JSON.parse(await readFile(receipt(path), "utf8")), receiptFor(shippedCss));
      await installScholarAppearance(config(path));
      assert.deepEqual(await snapshots([settings(path), snippet(path)]), before);
    });
  }
  await check("legacy CSS with no appearance settings is adopted without enablement", async () => {
    const path = await vault("legacy-no-preferences");
    await put(snippet(path), shippedCss);
    await installScholarAppearance(config(path));
    assert.equal(await exists(settings(path)), false);
    assert.deepEqual(JSON.parse(await readFile(receipt(path), "utf8")), receiptFor(shippedCss));
  });
  await check("preferences changed during snippet setup are merged from the latest settings", async () => {
    const path = await vault("concurrent-settings");
    await put(settings(path), JSON.stringify({ theme: "old", enabledCssSnippets: [] }));
    const latest = { theme: "new", baseFontSize: 21, enabledCssSnippets: ["just-enabled"], custom: { preserved: true } };
    await duringStylesRead(
      () => writeFile(settings(path), JSON.stringify(latest)),
      (controlled) => controlled.installScholarAppearance(config(path)),
    );
    assert.deepEqual(JSON.parse(await readFile(settings(path), "utf8")), { ...latest, enabledCssSnippets: ["just-enabled", "scholar"] });
  });
  await check("preferences becoming malformed during setup remain untouched and nonfatal", async () => {
    const path = await vault("concurrent-malformed-settings");
    await put(settings(path), "{}");
    const warnings = [];
    await duringStylesRead(
      () => writeFile(settings(path), "{concurrent partial write"),
      (controlled) => controlled.ensureScholarAppearance(config(path), (message) => warnings.push(message)),
    );
    assert.equal(await readFile(settings(path), "utf8"), "{concurrent partial write");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /left unchanged.*Notes still work/);
  });
  for (const [name, text] of [["malformed JSON", "{broken"], ["non-object JSON", "[]"], ["malformed enablement", '{"enabledCssSnippets":"scholar"}']]) {
    await check(`${name} is preserved and never blocks learning`, async () => {
      const path = await vault(name.replaceAll(" ", "-"));
      await put(settings(path), text);
      const warnings = [];
      await ensureScholarAppearance(config(path), (message) => warnings.push(message));
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /left unchanged.*Notes still work/);
      assert.equal(await readFile(settings(path), "utf8"), text);
      assert.equal(await exists(snippet(path)), false);
    });
  }
  await check("unowned scholar.css is not overwritten or enabled", async () => {
    const path = await vault("custom-style");
    await put(snippet(path), "/* My personal styling */\n");
    await assert.rejects(() => installScholarAppearance(config(path)), /customized or cannot be verified/);
    assert.equal(await readFile(snippet(path), "utf8"), "/* My personal styling */\n");
    assert.equal(await exists(settings(path)), false);
    assert.equal(await exists(receipt(path)), false);
  });
  for (const legacy of [false, true]) {
    await check(`${legacy ? "legacy" : "receipted"} edits retaining the managed header are preserved on restart and upgrade`, async () => {
      const path = await vault(`custom-header-${legacy}`);
      if (legacy) await put(settings(path), '{"enabledCssSnippets":[]}');
      else await installScholarAppearance(config(path));
      const customCss = `${shippedCss}\n.scholar-note { color: magenta; }\n`;
      await put(snippet(path), customCss);
      const paths = [settings(path), snippet(path), ...(legacy ? [] : [receipt(path)])];
      const before = await snapshots(paths);
      const warnings = [];
      await ensureScholarAppearance(config(path), (message) => warnings.push(message));
      await withShippedStyles(`${shippedCss}\n/* Upgrade */\n`, (controlled) => controlled.ensureScholarAppearance(config(path), (message) => warnings.push(message)));
      assert.equal(warnings.length, 2);
      assert.ok(warnings.every((message) => /customized or cannot be verified.*left unchanged.*Notes still work/.test(message)));
      assert.deepEqual(await snapshots(paths), before);
      if (legacy) assert.equal(await exists(receipt(path)), false);
    });
  }
  await check("receipt-free unknown older styling is preserved even with a managed header", async () => {
    const path = await vault("unknown-legacy-version");
    const olderCss = "/* Scholar built-in note styling. Older version */\n";
    await put(snippet(path), olderCss);
    const before = await snapshots([snippet(path)]);
    await assert.rejects(() => installScholarAppearance(config(path)), /cannot be verified/);
    assert.deepEqual(await snapshots([snippet(path)]), before);
    assert.equal(await exists(settings(path)), false);
    assert.equal(await exists(receipt(path)), false);
  });
  await check("a snippet customized during an upgrade is rechecked before replacement", async () => {
    const path = await vault("concurrent-snippet-edit");
    await installScholarAppearance(config(path));
    const before = await snapshots([settings(path), receipt(path)]);
    const customCss = `${shippedCss}\n.scholar-note { color: cyan; }\n`;
    const originalRead = fsPromises.readFile;
    let preferenceReads = 0;
    fsPromises.readFile = async (target, ...args) => {
      const result = await originalRead(target, ...args);
      if (target === settings(path) && ++preferenceReads === 2) await writeFile(snippet(path), customCss);
      return result;
    };
    syncBuiltinESMExports();
    try {
      await withShippedStyles(`${shippedCss}\n/* Shipped upgrade */\n`, async (controlled) => {
        await assert.rejects(() => controlled.installScholarAppearance(config(path)), /changed while installing/);
      });
    } finally { fsPromises.readFile = originalRead; syncBuiltinESMExports(); }
    assert.equal(preferenceReads, 2);
    assert.equal(await readFile(snippet(path), "utf8"), customCss);
    assert.deepEqual(await snapshots([settings(path), receipt(path)]), before);
  });
  await check("an interrupted receipt update recovers when CSS already matches the shipped bytes", async () => {
    const path = await vault("interrupted-receipt-update");
    await put(snippet(path), shippedCss);
    await put(settings(path), '{"enabledCssSnippets":[]}');
    await put(receipt(path), JSON.stringify(receiptFor("previous shipped version")));
    const before = await snapshots([settings(path), snippet(path)]);
    await installScholarAppearance(config(path));
    assert.deepEqual(await snapshots([settings(path), snippet(path)]), before);
    assert.deepEqual(JSON.parse(await readFile(receipt(path), "utf8")), receiptFor(shippedCss));
  });
  for (const invalidReceipt of ["{broken", "[]", '{"schemaVersion":2,"installedCssSha256":"future"}', '{"schemaVersion":1,"installedCssSha256":"bad"}']) {
    await check(`invalid receipt prevents writes (${invalidReceipt})`, async () => {
      const path = await vault(`bad-receipt-${cssHash(invalidReceipt).slice(0, 8)}`);
      await put(receipt(path), invalidReceipt);
      const before = await snapshots([receipt(path)]);
      const warnings = [];
      await ensureScholarAppearance(config(path), (message) => warnings.push(message));
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /receipt is invalid.*left unchanged.*Notes still work/);
      assert.deepEqual(await snapshots([receipt(path)]), before);
      assert.equal(await exists(settings(path)), false);
      assert.equal(await exists(snippet(path)), false);
    });
  }
  await check("settings symlink outside selected vault is refused without external writes", async () => {
    const path = await vault("linked-settings"), outside = await vault("outside");
    await symlink(outside, join(path, ".obsidian"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(() => installScholarAppearance(config(path)), /outside|escapes|within|contained/i);
    assert.deepEqual(await readdir(outside), []);
  });
  await check("Obsidian settings cannot become a writable PDF library", async () => {
    const path = await vault("library-collision");
    await assert.rejects(() => installScholarAppearance({ ...config(path), libraryRoot: join(path, ".obsidian") }), /PDF library contains a Scholar write location/);
    assert.deepEqual(await readdir(path), []);
  });
  for (const target of ["settings", "snippets", "receipt"]) {
    await check(`${target} junction into an in-vault PDF library is refused before writes`, async () => {
      const path = await vault(`library-junction-${target}`);
      const pdfRoot = join(path, "PDFs");
      await mkdir(pdfRoot);
      await writeFile(join(pdfRoot, "source.pdf"), "SOURCE_BYTES");
      if (target !== "settings") await mkdir(join(path, ".obsidian"));
      const destination = target === "settings" ? join(path, ".obsidian") : target === "snippets" ? join(path, ".obsidian", "snippets") : receipt(path);
      await symlink(pdfRoot, destination, process.platform === "win32" ? "junction" : "dir");
      const before = await readdir(pdfRoot);
      await assert.rejects(() => installScholarAppearance({ ...config(path), libraryRoot: pdfRoot }), /read-only PDF library/);
      assert.deepEqual(await readdir(pdfRoot), before);
      assert.equal(await readFile(join(pdfRoot, "source.pdf"), "utf8"), "SOURCE_BYTES");
      assert.equal(await exists(settings(path)), false);
    });
  }
  await check("receipt junction outside selected vault is refused before any write", async () => {
    const path = await vault("receipt-outside"), outside = await vault("receipt-outside-target");
    await mkdir(join(path, ".obsidian"));
    await symlink(outside, receipt(path), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(() => installScholarAppearance(config(path)), /outside|escapes|within|contained/i);
    assert.deepEqual(await readdir(outside), []);
    assert.equal(await exists(snippet(path)), false);
    assert.equal(await exists(settings(path)), false);
  });
  await check("a PDF library configured through a junction is protected by its canonical location", async () => {
    const path = await vault("canonical-library");
    const pdfRoot = join(path, ".obsidian");
    const libraryAlias = join(root, "canonical-library-alias");
    await mkdir(pdfRoot);
    await writeFile(join(pdfRoot, "source.pdf"), "SOURCE_BYTES");
    await symlink(pdfRoot, libraryAlias, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(() => installScholarAppearance({ ...config(path), libraryRoot: libraryAlias }), /read-only PDF library/);
    assert.deepEqual(await readdir(pdfRoot), ["source.pdf"]);
    assert.equal(await readFile(join(pdfRoot, "source.pdf"), "utf8"), "SOURCE_BYTES");
  });
  await check("real Pi startup installs styling even with no selected book or active mode", async () => {
    const path = await vault("startup");
    process.env.PI_SCHOLAR_OBSIDIAN_ROOT = path;
    process.env.PI_SCHOLAR_LIBRARY_ROOT = library;
    process.env.PI_SCHOLAR_STATE_ROOT = join(root, "startup-bootstrap");
    const runtime = createExtensionRuntime();
    const loaded = await loadExtensions([extensionPath], root, undefined, runtime);
    assert.deepEqual(loaded.errors, []);
    const messages = [];
    let editorFactory;
    const ctx = { hasUI: true, sessionManager: { getBranch: () => [] }, ui: {
      notify: (message) => messages.push(message), setStatus: () => {},
      setEditorComponent: (factory) => { editorFactory = factory; },
      getEditorComponent: () => editorFactory,
    } };
    for (const handler of loaded.extensions[0].handlers.get("session_start")) await handler({}, ctx);
    assert.deepEqual(messages, []);
    assert.ok((JSON.parse(await readFile(settings(path), "utf8"))).enabledCssSnippets.includes("scholar"));
    assert.ok(await exists(snippet(path)));
    assert.ok(await exists(receipt(path)));
    await writeFile(settings(path), '{"enabledCssSnippets":[]}');
    const disabledBefore = await snapshots([settings(path), snippet(path), receipt(path)]);
    for (const handler of loaded.extensions[0].handlers.get("session_start")) await handler({}, ctx);
    assert.deepEqual(await snapshots([settings(path), snippet(path), receipt(path)]), disabledBefore);
    assert.deepEqual(messages, []);
    for (const name of envNames) delete process.env[name];
  });
  await check("choosing another vault enables styling there without copying books", async () => {
    const path = await vault("switch-target");
    await installScholarAppearance(config(path));
    assert.deepEqual(JSON.parse(await readFile(settings(path), "utf8")), { enabledCssSnippets: ["scholar"] });
    assert.deepEqual(await readdir(path), [".obsidian"]);
    assert.deepEqual(await readdir(library), []);
  });
} finally {
  for (const name of envNames) {
    if (savedEnv[name] === undefined) delete process.env[name]; else process.env[name] = savedEnv[name];
  }
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  assert.ok(basename(root).startsWith("scholar-appearance-"));
  await rm(root, { recursive: true, force: true });
}
console.log(`\nScholar appearance summary: ${passed} passed, ${failed} failed.`);
process.exitCode = failed ? 1 : 0;
