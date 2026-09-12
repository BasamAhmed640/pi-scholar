import { extensionPath as packagedExtensionPath, piPackageRoot as sdkRoot, jitiPath as sdkJitiPath, resolvePiDependency } from "./sdk.mjs";
// Regressions for the external marker-recovery audit.
// Every case here destroyed reader text or froze the vault before the fix.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const requested = resolve(process.env.PI_SCHOLAR_EXTENSION || packagedExtensionPath);
const extension = basename(requested).toLowerCase() === "index.ts" ? dirname(requested) : requested;
const packageRoot = sdkRoot;
const { createJiti } = await import(pathToFileURL(sdkJitiPath).href);
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: { "@earendil-works/pi-coding-agent": join(packageRoot, "dist", "index.js") } });
const common = await jiti.import(join(extension, "render/common.ts"));
const projection = await jiti.import(join(extension, "obsidian.ts"));
const storage = await jiti.import(join(extension, "storage.ts"));

const { GENERATED_START: START, GENERATED_END: END, QUARANTINE_START, preservedUserContent, quarantineBlock, GeneratedMarkerError } = common;
const root = await mkdtemp(join(tmpdir(), "scholar-marker-audit-"));
const saved = Object.fromEntries(["PI_SCHOLAR_LIBRARY_ROOT", "PI_SCHOLAR_OBSIDIAN_ROOT", "PI_SCHOLAR_STATE_ROOT"].map((key) => [key, process.env[key]]));
for (const key of Object.keys(saved)) delete process.env[key];
const now = "2026-09-05T12:00:00.000Z";
let checks = 0;
const passed = (name) => { checks++; console.log(`[PASS] ${name}`); };
const TAIL = "MY HANDWRITTEN NOTES";
const frontmatter = "---\ntype: scholar-section\n---\n";

// --- Finding 1: a real end marker the line scanner cannot see -----------------
// Each note below HAS an end marker and HAS reader text after it. Healing would
// have discarded that text silently; every one must be treated as ambiguous.
const unreadableEndMarker = {
  "an unclosed code fence swallows the end marker": `${frontmatter}${START}\nExample:\n\`\`\`python\ndef f(): pass\n${END}\n${TAIL}\n`,
  "trailing text on the end-marker line": `${frontmatter}${START}\ngen\n${END} #mytag\n${TAIL}\n`,
  "the reader's own tail contains a start marker": `${frontmatter}${START}\ngen\n${END}\nnotes:\n${START}\n${TAIL}\n`,
  "the end marker is indented four spaces": `${frontmatter}${START}\ngen\n    ${END}\n${TAIL}\n`,
  "a tilde fence swallows the end marker": `${frontmatter}${START}\n~~~\nunclosed\n${END}\n${TAIL}\n`,
  "an unclosed fence swallows an end marker with spacing variation": `${frontmatter}${START}\n\`\`\`\n<!--scholar:generated:end -->\n${TAIL}\n`,
  "an unclosed fence swallows an end marker with uppercase casing": `${frontmatter}${START}\n\`\`\`\n<!-- SCHOLAR:GENERATED:END -->\n${TAIL}\n`,
};
for (const [name, content] of Object.entries(unreadableEndMarker)) {
  assert.throws(() => preservedUserContent(content, true), GeneratedMarkerError, name);
  const rescued = quarantineBlock(content.replace(/^---\n[\s\S]*?\n---\n/, ""));
  assert(rescued.includes(TAIL), `${name}: reader text must survive in quarantine`);
}
passed("a note whose end marker the scanner cannot read is quarantined, never silently truncated");

// Only a note with no end delimiter anywhere is a genuine truncated write: a
// truncation removes trailing bytes, so it either takes the end marker with it
// or leaves the region balanced. Any other dangling start was hand-authored,
// and a note that still holds an end marker keeps its reader text by quarantine.
assert.equal(preservedUserContent(`${frontmatter}${START}\n> [!info] partial\n\n`, true), "");
assert.equal(
  preservedUserContent(`${frontmatter}${START}\ngen\n${END}\n`, true),
  "",
  "a closed note with no handwritten content returns an empty tail, matching an unclosed note",
);
assert.throws(
  () => preservedUserContent(`${frontmatter}${START}\ngen\n${END}\n\n${TAIL}\n\n${START}\ncut`, true),
  GeneratedMarkerError,
  "a complete region followed by a dangling start is not a truncation",
);
passed("a genuine truncation heals; a hand-authored dangling start below a real region does not");

// --- Finding 3: quarantine must not nest ------------------------------------
const once = quarantineBlock("reader text");
const twice = quarantineBlock(`${frontmatter}${START}\nfresh\n${END}\n\n${once}\n`);
assert.equal(twice.split(QUARANTINE_START).length - 1, 1, "repeated damage yields one block, not a Russian doll");
assert(twice.includes("reader text"), "the original rescued text is carried forward");
assert.equal(twice.split("[!warning] Recovered text").length - 1, 1, "the notice is not duplicated");
passed("quarantining an already-quarantined note keeps one block and loses nothing");

// --- Finding 3b: CRLF must round-trip byte-identically -----------------------
const generated = `---\ntype: scholar-section\n---\n${START}\ngen\n${END}`;
let crlf = `${frontmatter}${START}\ngen\n${END}\r\n\r\nCRLF reader text\r\n`;
for (let pass = 0; pass < 3; pass += 1) {
  const tail = preservedUserContent(crlf, true);
  const separator = tail && !/^\r?\n/.test(tail) ? "\n" : "";
  // The tail already opens with its own CRLF break, so the writer must add
  // nothing; the old startsWith("\n") test missed that and injected a lone LF.
  assert.equal(separator, "", "a CRLF tail needs no injected separator");
  const next = tail ? `${generated.trimEnd()}${separator}${tail}` : `${generated.trimEnd()}\n`;
  assert(next.endsWith("CRLF reader text\r\n"), "the CRLF tail survives verbatim");
  if (pass > 0) assert.equal(next, crlf, "a CRLF note must be byte-identical across projections");
  crlf = next;
}
// The pre-fix expression would have grown the note on the first projection.
assert.notEqual("\r\n\r\nx".startsWith("\n"), /^\r?\n/.test("\r\n\r\nx"), "the fix changes the CRLF decision");
passed("a CRLF note round-trips byte-identically without an injected line ending");

// --- Findings A and B: one damaged legacy note must not freeze the vault -----
function bookFixture(id, title, folder) {
  return { schemaVersion: 3, revision: 0, id, instanceId: `audit-${folder}`, source: {
    absolutePath: join(root, folder, "Library", `${folder}.pdf`), relativePath: `${folder}.pdf`, fileName: `${folder}.pdf`, format: "pdf",
    fingerprint: { sha256: id, size: 1, mtimeMs: 1 } },
    metadata: { title, authors: ["Audit"], pageCount: 1 }, outlineStatus: "ready",
    chapters: [{ id: "chapter-1", order: 1, number: "1", title: "Ch", startPage: 1, endPage: 1, status: "learning",
      sections: [{ id: "section-1", order: 1, number: "1.1", title: "Sec", startPage: 1, endPage: 1, objectives: [], coveredObjectives: [],
        requiredChecks: [], status: "learning", keyPoints: [], misconceptions: [], attempts: [], transcript: [], createdAt: now, updatedAt: now }] }],
    exams: [], tutorSessions: [], noteDirectory: title, createdAt: now, updatedAt: now };
}
const config = { schemaVersion: 3, obsidianRoot: join(root, "vault"), libraryRoot: join(root, "one", "Library"), stateRoot: join(root, "state"), updatedAt: now };
await mkdir(config.obsidianRoot, { recursive: true });
await mkdir(config.libraryRoot, { recursive: true });
const bookOne = bookFixture("a".repeat(64), "Audit One", "one");
const bookTwo = bookFixture("b".repeat(64), "Audit Two", "one");
bookTwo.source.absolutePath = join(config.libraryRoot, "two.pdf");
bookTwo.source.relativePath = bookTwo.source.fileName = "two.pdf";
await writeFile(bookOne.source.absolutePath, "one");
await writeFile(bookTwo.source.absolutePath, "two");
await storage.createBookState(config, bookOne);
await storage.createBookState(config, bookTwo);
await projection.renderScholarWorkspace(config, [bookOne, bookTwo]);

// A legacy hub whose markers cannot be read used to abort the entire projection.
const legacyHome = projection.legacyScholarHomePath(config);
const currentHome = projection.scholarHomePath(config);
const homeContent = await readFile(currentHome, "utf8");
await writeFile(legacyHome, `${homeContent}\n${END}\norphan\n${TAIL}\n`);
const twoNotePath = projection.bookHomePath(config, bookTwo);
const twoBefore = await readFile(twoNotePath, "utf8");
await writeFile(twoNotePath, twoBefore.replace("<!-- scholar:generated:start -->", "<!-- scholar:generated:start -->\nSTALE\n"));
const warnings = [];
await projection.renderScholarWorkspace(config, [bookOne, bookTwo], (warning) => warnings.push(warning));
assert.match(await readFile(twoNotePath, "utf8"), /STALE/, "projection must preserve edits in an authoritative note");
assert((await readFile(legacyHome, "utf8")).includes(TAIL), "a skipped migration must not delete or empty its source");
assert(warnings.some((warning) => /not moved or merged/.test(warning.reason)), "the skipped migration is reported");
passed("an unreadable legacy note skips its migration instead of freezing every other note");

// --- Finding 5: only the writer reports, and it reports the truth ------------
const sectionPath = projection.sectionNotePath(config, bookOne, bookOne.chapters[0], bookOne.chapters[0].sections[0]);
await rm(legacyHome);
const sectionOriginal = await readFile(sectionPath, "utf8");
await writeFile(sectionPath, `${sectionOriginal}\n${END}\norphan\n${TAIL}\n`);
const broken = await readFile(sectionPath, "utf8");
await projection.renderScholarWorkspace(config, [bookOne, bookTwo]);
assert.equal(await readFile(sectionPath, "utf8"), broken);
const editedBook = await storage.loadBookState(config, bookOne.id);
editedBook.revision++;
await assert.rejects(storage.saveBookState(config, editedBook, editedBook.revision - 1), /ambiguous end boundaries/);
assert.equal(await readFile(sectionPath, "utf8"), broken);
passed("projection preserves source-note damage; a save stops instead of reconstructing or discarding it");

console.log(`\nScholar marker audit: ${checks} passed, 0 failed.`);
await rm(root, { recursive: true, force: true });
for (const [key, value] of Object.entries(saved)) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}
