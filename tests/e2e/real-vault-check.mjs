#!/usr/bin/env node
// Real-vault regression gate (plan-0.8 §6 "Backward compatibility"). NOT part of
// `npm test`: it reads the owner's personal vault, so its data never enters the repo.
//
//   node tests/e2e/real-vault-check.mjs [--vault <path>] [--extension <scholar checkout>] [--keep] [--json]
//
// 1. Byte-copies ONLY <vault>/Scholar plus .obsidian/snippets/scholar.css and
//    .obsidian/scholar-appearance.json (when present) into a fresh temp vault.
//    Source files are opened read-only; a before/after manifest (size, mtime,
//    sha256) checks that the copied Scholar files stayed unchanged.
// 2. Loads every book from the COPY with the extension's own modules
//    (storage.ts listBookStates/loadBookState through jiti, as tests/*.mjs do).
// 3. Records per book: section statuses, lessonCommit / earnedDelivery /
//    lessonReady, attempt ids + outcomes, the pending (unanswered) question of
//    each section and tutor session, exam statuses, and whether each active
//    exam's answer paper parses (exam.ts examAnswerProgress on the paper text).
// 4. Runs one full projection (renderScholarWorkspace on the copy), loads
//    again and reports every difference in those invariants (a render must not
//    change state), then renders a second time to report non-idempotent writes.
// 5. Prints a compact PASS/FAIL summary with load/render timings.
import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_VAULT = process.env.SCHOLAR_REAL_VAULT;
const EXTRA_FILES = [join(".obsidian", "snippets", "scholar.css"), join(".obsidian", "scholar-appearance.json")];

function projectedRealPath(path) {
  let parent = resolve(path);
  const missing = [];
  while (!existsSync(parent)) {
    missing.unshift(basename(parent));
    const next = dirname(parent);
    if (next === parent) throw new Error(`Cannot resolve scratch parent for ${path}`);
    parent = next;
  }
  return resolve(realpathSync(parent), ...missing);
}

function parseArgs(argv) {
  const options = { vault: DEFAULT_VAULT, keep: false, json: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = () => { const value = argv[++index]; if (value === undefined) throw new Error(`${arg} needs a value`); return value; };
    if (arg === "--vault") options.vault = next();
    else if (arg === "--extension") options.extension = next();
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "-h" || arg === "--help") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

/** Reads a file through a read-only descriptor (never a write-capable open). */
function readOnly(path) {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(fd, buffer, offset, size - offset, offset);
      if (!count) break;
      offset += count;
    }
    return buffer.subarray(0, offset);
  } finally { closeSync(fd); }
}

function listFiles(root) {
  const files = [];
  if (!existsSync(root)) return files;
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  return files.sort();
}

/** rel path -> {bytes, mtimeMs, sha256}, reading read-only. */
function manifest(vaultRoot) {
  const entries = {};
  const add = (path) => {
    const data = readOnly(path);
    entries[relative(vaultRoot, path).split(sep).join("/")] = { bytes: data.length, mtimeMs: lstatSync(path).mtimeMs, sha256: createHash("sha256").update(data).digest("hex") };
  };
  for (const path of listFiles(join(vaultRoot, "Scholar"))) add(path);
  for (const extra of EXTRA_FILES) if (existsSync(join(vaultRoot, extra))) add(join(vaultRoot, extra));
  return entries;
}

function hashTree(root) {
  const hashes = {};
  for (const path of listFiles(root)) hashes[relative(root, path).split(sep).join("/")] = createHash("sha256").update(readFileSync(path)).digest("hex");
  return hashes;
}

function changedFiles(before, after) {
  const changed = [];
  for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[path] !== after[path]) changed.push(`${before[path] === undefined ? "+" : after[path] === undefined ? "-" : "~"} ${path}`);
  }
  return changed.sort();
}

function diffValues(left, right, path = "", out = []) {
  if (out.length > 200) return out;
  if (JSON.stringify(left) === JSON.stringify(right)) return out;
  if (left && right && typeof left === "object" && typeof right === "object" && Array.isArray(left) === Array.isArray(right)) {
    if (Array.isArray(left) && left.every((item) => item && typeof item === "object" && "id" in item) && right.every((item) => item && typeof item === "object" && "id" in item)) {
      const byId = (items) => new Map(items.map((item) => [item.id, item]));
      const a = byId(left), b = byId(right);
      for (const id of new Set([...a.keys(), ...b.keys()])) diffValues(a.get(id), b.get(id), `${path}[${id}]`, out);
      return out;
    }
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) diffValues(left[key], right[key], path ? `${path}.${key}` : key, out);
    return out;
  }
  out.push(`${path}: ${JSON.stringify(left)?.slice(0, 160)} → ${JSON.stringify(right)?.slice(0, 160)}`);
  return out;
}

const elapsed = (start) => Math.round(performance.now() - start);

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); } catch (error) { console.error(error.message); return 2; }
  if (options.help) {
    console.log("Usage: node tests/e2e/real-vault-check.mjs [--vault <path>] [--extension <scholar checkout>] [--keep] [--json]");
    return 0;
  }
  if (!options.vault) { console.error("Specify --vault <path> or SCHOLAR_REAL_VAULT; there is no implicit personal vault."); return 2; }
  const requestedVault = resolve(options.vault);
  if (!existsSync(join(requestedVault, "Scholar"))) { console.error(`No Scholar folder in ${requestedVault}`); return 2; }
  const realVault = realpathSync(requestedVault);
  const extensionDir = resolve(options.extension || join(HERE, "..", ".."));
  if (!existsSync(join(extensionDir, "storage.ts"))) { console.error(`--extension is not a Scholar checkout: ${extensionDir}`); return 2; }

  const workRoot = projectedRealPath(join(tmpdir(), "claude", "scholar-e2e", `real-vault-${Date.now()}`));
  const overlaps = (left, right) => {
    const a = resolve(left).toLowerCase();
    const b = resolve(right).toLowerCase();
    return a === b || a.startsWith(`${b}${sep}`) || b.startsWith(`${a}${sep}`);
  };
  if (overlaps(realVault, workRoot)) { console.error(`Refusing: scratch ${workRoot} overlaps source vault ${realVault}.`); return 2; }
  if (existsSync(workRoot)) { console.error(`Scratch folder already exists: ${workRoot}`); return 2; }
  const copyVault = join(workRoot, "vault");
  const stateRoot = join(workRoot, "state");
  mkdirSync(copyVault, { recursive: true });
  mkdirSync(stateRoot, { recursive: true });
  // Environment overrides would win over the config below; never let them point at the real vault.
  delete process.env.PI_SCHOLAR_OBSIDIAN_ROOT;
  delete process.env.PI_SCHOLAR_LIBRARY_ROOT;
  process.env.PI_SCHOLAR_STATE_ROOT = stateRoot;

  const result = { vault: realVault, copy: copyVault, extension: extensionDir, timings: {}, books: [], failures: [], warnings: [] };
  const fail = (message) => result.failures.push(message);
  const warn = (message) => result.warnings.push(message);

  // 1. Manifest + read-only byte copy.
  let start = performance.now();
  const realBefore = manifest(realVault);
  for (const rel of Object.keys(realBefore)) {
    const source = join(realVault, ...rel.split("/"));
    const target = join(copyVault, ...rel.split("/"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readOnly(source), { flag: "wx" });
    const stats = lstatSync(source);
    utimesSync(target, stats.atime, stats.mtime);
  }
  result.timings.copyMs = elapsed(start);
  result.copiedFiles = Object.keys(realBefore).length;

  // 2. The extension's own modules, through jiti with the SDK aliases the verifiers use.
  const sdk = await import(pathToFileURL(join(HERE, "..", "sdk.mjs")).href);
  const { createJiti } = await import(pathToFileURL(sdk.jitiPath).href);
  const jiti = createJiti(import.meta.url, { moduleCache: false, alias: { ...sdk.sdkAliases } });
  const load = (name) => jiti.import(join(extensionDir, name));
  const storage = await load("storage.ts");
  const obsidian = await load("obsidian.ts");
  const domain = await load("domain.ts");
  const lesson = await load("lesson.ts");
  const exam = await load("exam.ts");
  const examPaper = await load("exam-paper.ts");
  const records = await load("note-records.ts");
  const appearance = await load("appearance.ts").catch(() => undefined);

  const config = storage.resolveScholarConfig({ obsidianRoot: copyVault, libraryRoot: "", stateRoot });
  if (resolve(config.obsidianRoot).toLowerCase() !== resolve(copyVault).toLowerCase() || resolve(config.obsidianRoot).toLowerCase().startsWith(realVault.toLowerCase())) {
    console.error(`Refusing: resolved vault ${config.obsidianRoot} is not the copy.`);
    return 2;
  }

  const bookNoteIds = () => listFiles(join(copyVault, "Scholar", "Books")).filter((path) => path.endsWith(".md")).flatMap((path) => {
    try { const details = records.readDetails(readFileSync(path, "utf8"), "book"); return details?.id ? [{ id: details.id, path }] : []; }
    catch (error) { return [{ id: undefined, path, error: error.message }]; }
  });

  async function loadAll(label) {
    const begin = performance.now();
    let books;
    try {
      books = await storage.listBookStates(config);
    } catch (error) {
      fail(`${label}: listBookStates failed: ${error.message}`);
      books = [];
      for (const note of bookNoteIds()) {
        if (!note.id) { fail(`${label}: unreadable book details in ${relative(copyVault, note.path)}: ${note.error}`); continue; }
        try { const book = await storage.loadBookState(config, note.id); if (book) books.push(book); }
        catch (bookError) { fail(`${label}: book ${note.id.slice(0, 12)} (${relative(copyVault, note.path)}) does not load: ${bookError.message}`); }
      }
    }
    return { books, ms: elapsed(begin) };
  }

  async function paperState(book, record) {
    try {
      const paper = await examPaper.readExamAnswerNote(config, book, record);
      const progress = exam.examAnswerProgress(record, paper.text);
      return progress.ok ? { parses: true, answered: progress.answered, total: progress.total } : { parses: false, problem: progress.problem };
    } catch (error) {
      return { parses: false, problem: error.message };
    }
  }

  async function snapshot(book) {
    const sourceHash = book.source?.fingerprint?.sha256;
    const pendingOf = (attempts) => {
      const attempt = domain.unansweredQuestion(attempts || []);
      return attempt ? { id: attempt.id, kind: attempt.quiz ? "multiple-choice (frozen form)" : attempt.format === "open" ? "open" : "legacy", resumable: Boolean(attempt.quiz || attempt.format === "open") } : null;
    };
    const safe = (fn) => { try { return fn(); } catch (error) { return `error: ${error.message}`; } };
    const sections = book.chapters.flatMap((chapter) => chapter.sections).map((section) => ({
      id: section.id, number: section.number, status: section.status,
      lessonCommit: Boolean(section.lessonCommit), commitHash: section.lessonCommit?.contentHash,
      earnedDelivery: Boolean(section.learnQuality?.earnedDelivery), lessonReady: safe(() => lesson.lessonReady(section, sourceHash)),
      legacyCompletion: Boolean(section.legacyCompletion),
      attempts: (section.attempts || []).map((attempt) => ({ id: attempt.id, outcome: attempt.outcome })),
      pending: pendingOf(section.attempts), lessonEntries: (section.transcript || []).filter((entry) => entry.lesson).length,
    }));
    const tutors = (book.tutorSessions || []).map((tutor) => ({ id: tutor.id, status: tutor.status, attempts: (tutor.attempts || []).map((attempt) => ({ id: attempt.id, outcome: attempt.outcome })), pending: pendingOf(tutor.attempts) }));
    const exams = [];
    for (const record of book.exams || []) {
      exams.push({ id: record.id, status: record.status, questions: record.questions.length, earnedPoints: record.earnedPoints, maxPoints: record.maxPoints, percent: record.percent,
        responses: (record.rawResponses || []).length, ...(record.status === "active" ? { paper: await paperState(book, record) } : {}) });
    }
    return { id: book.id, instanceId: book.instanceId, revision: book.revision, title: book.metadata?.title, outlineStatus: book.outlineStatus, sections, tutors, exams };
  }

  // 3. Load, record.
  const first = await loadAll("load #1");
  result.timings.load1Ms = first.ms;
  const before = [];
  for (const book of first.books) before.push(await snapshot(book));

  // 4. One full projection on the copy, then load again.
  const treeBefore = hashTree(copyVault);
  const projectionWarnings = [];
  start = performance.now();
  try {
    await obsidian.renderScholarWorkspace(config, first.books, (warning) => projectionWarnings.push(warning));
  } catch (error) {
    fail(`render #1 failed: ${error.message}`);
  }
  result.timings.render1Ms = elapsed(start);
  const treeAfterRender = hashTree(copyVault);
  result.renderChangedFiles = changedFiles(treeBefore, treeAfterRender);
  for (const warning of projectionWarnings) warn(`projection warning: ${warning.path ? relative(copyVault, warning.path) : "?"}: ${String(warning.reason).slice(0, 200)}`);

  const second = await loadAll("load #2");
  result.timings.load2Ms = second.ms;
  const after = [];
  for (const book of second.books) after.push(await snapshot(book));

  // 5. Render again: a projection of unchanged state should write nothing new.
  start = performance.now();
  try { await obsidian.renderScholarWorkspace(config, second.books, () => undefined); } catch (error) { fail(`render #2 failed: ${error.message}`); }
  result.timings.render2Ms = elapsed(start);
  const secondChanges = changedFiles(treeAfterRender, hashTree(copyVault));
  if (secondChanges.length) warn(`render is not idempotent: ${secondChanges.length} file(s) changed again (${secondChanges.slice(0, 5).join("; ")})`);

  // Optional: the appearance installer a Scholar command runs (copy only).
  if (appearance?.ensureScholarAppearance) {
    const messages = [];
    try { await appearance.ensureScholarAppearance(config, (message) => messages.push(message)); result.appearance = messages.length ? messages : "ok"; }
    catch (error) { result.appearance = `error: ${error.message}`; warn(`appearance: ${error.message}`); }
  }

  // Compare invariants.
  const ids = (list) => list.map((book) => book.id).sort().join(",");
  if (ids(before) !== ids(after)) fail(`the set of loadable books changed across render: ${ids(before)} → ${ids(after)}`);
  for (const book of before) {
    const other = after.find((candidate) => candidate.id === book.id);
    const differences = other ? diffValues(book, other) : ["book missing after render"];
    const pending = [...book.sections.filter((section) => section.pending), ...book.tutors.filter((tutor) => tutor.pending)];
    const papers = book.exams.filter((record) => record.paper);
    result.books.push({
      id: book.id.slice(0, 12), title: book.title, outlineStatus: book.outlineStatus, revision: book.revision,
      sections: book.sections.length, statuses: book.sections.reduce((tally, section) => ({ ...tally, [section.status]: (tally[section.status] || 0) + 1 }), {}),
      committed: book.sections.filter((section) => section.lessonCommit).length, earnedDelivery: book.sections.filter((section) => section.earnedDelivery).length,
      lessonReady: book.sections.filter((section) => section.lessonReady === true).length,
      attempts: book.sections.reduce((count, section) => count + section.attempts.length, 0) + book.tutors.reduce((count, tutor) => count + tutor.attempts.length, 0),
      pending: pending.map((record) => `${record.number || record.id}:${record.pending.id} (${record.pending.kind}${record.pending.resumable ? "" : ", NOT resumable"})`),
      tutors: book.tutors.length, exams: book.exams.map((record) => `${record.id}:${record.status}${record.paper ? record.paper.parses ? ` paper ${record.paper.answered}/${record.paper.total}` : " paper DOES NOT PARSE" : ""}`),
      differences,
    });
    for (const difference of differences) fail(`${book.title || book.id.slice(0, 12)}: render changed state: ${difference}`);
    for (const record of papers) if (!record.paper.parses) fail(`${book.title}: active exam ${record.id} answer paper does not parse: ${record.paper.problem}`);
    for (const record of pending) if (!record.pending.resumable) warn(`${book.title}: pending ${record.pending.id} is a legacy question without a frozen form`);
  }
  if (!before.length && !result.failures.length) fail("no books were found in the copy");

  // Verify only the source files copied above; unrelated vault files are outside this manifest.
  const realAfter = manifest(realVault);
  const realChanges = changedFiles(Object.fromEntries(Object.entries(realBefore).map(([path, entry]) => [path, `${entry.sha256}:${entry.mtimeMs}`])),
    Object.fromEntries(Object.entries(realAfter).map(([path, entry]) => [path, `${entry.sha256}:${entry.mtimeMs}`])));
  result.trackedSourceFilesUnchanged = realChanges.length === 0;
  if (realChanges.length) fail(`TRACKED SOURCE FILES CHANGED during the check: ${realChanges.slice(0, 10).join("; ")}`);

  result.result = result.failures.length ? "FAIL" : "PASS";
  const reportPath = join(workRoot, "real-vault-check.json");
  writeFileSync(reportPath, `${JSON.stringify({ ...result, before, after }, null, 2)}\n`);

  if (options.json) console.log(JSON.stringify({ ...result, before, after }, null, 2));
  else {
    console.log(`Real-vault check · ${result.result}`);
    console.log(`  vault ${realVault} → copy of ${result.copiedFiles} files (${result.timings.copyMs} ms) · extension ${extensionDir}`);
    console.log(`  load #1 ${result.timings.load1Ms} ms · render #1 ${result.timings.render1Ms} ms (${result.renderChangedFiles.length} files written/changed) · load #2 ${result.timings.load2Ms} ms · render #2 ${result.timings.render2Ms} ms`);
    for (const book of result.books) {
      console.log(`  • ${book.title} [${book.id}] outline ${book.outlineStatus} rev ${book.revision} · sections ${book.sections} ${JSON.stringify(book.statuses)} · committed ${book.committed} · earnedDelivery ${book.earnedDelivery} · lessonReady ${book.lessonReady} · attempts ${book.attempts} · tutors ${book.tutors}`);
      if (book.pending.length) console.log(`      pending: ${book.pending.join("; ")}`);
      if (book.exams.length) console.log(`      exams: ${book.exams.join("; ")}`);
      console.log(`      load → render → load: ${book.differences.length ? `${book.differences.length} DIFFERENCE(S)` : "identical"}`);
    }
    for (const warning of result.warnings) console.log(`  warn ${warning}`);
    for (const failure of result.failures) console.log(`  FAIL ${failure}`);
    console.log(`  copied source files unchanged: ${result.trackedSourceFilesUnchanged ? "yes" : "NO"}`);
  }
  if (!options.keep) rmSync(workRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  else console.log(`  kept: ${workRoot}`);
  return result.failures.length ? 1 : 0;
}

process.exitCode = await main();
