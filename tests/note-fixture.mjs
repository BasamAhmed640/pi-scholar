// Test-only access to real Markdown storage, without assuming a hidden JSON database.
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { extensionPath, piPackageRoot, jitiPath } from "./sdk.mjs";
const { createJiti } = await import(pathToFileURL(jitiPath));
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: { "@earendil-works/pi-coding-agent": join(piPackageRoot, "dist/index.js") } });
const notes = await jiti.import(join(dirname(extensionPath), "note-storage.ts"));
const codec = await jiti.import(join(dirname(extensionPath), "note-records.ts"));
export async function findBookNotes(vault) {
  const root = join(vault, "Scholar", "Books"), result = [];
  for (const dir of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!dir.isDirectory()) continue;
    for (const name of await readdir(join(root, dir.name))) if (name.endsWith(".md")) {
      const path = join(root, dir.name, name);
      if (codec.readDetails(await readFile(path, "utf8"), "book")) result.push(path);
    }
  }
  return result;
}
function config(path) { return { schemaVersion: 3, obsidianRoot: resolve(dirname(path), "../../.."), libraryRoot: "", stateRoot: "", updatedAt: new Date().toISOString() }; }
export async function readFixtureBook(path) { return notes.readNoteBook(config(path), path); }
export async function writeFixtureBook(path, book) { const current = await readFixtureBook(path); return notes.writeNoteBook(config(path), book, current.revision); }
