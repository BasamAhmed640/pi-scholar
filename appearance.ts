import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { resolveScholarConfig, safePathWithinRoot, writeTextFileAtomic } from "./storage.ts";
import type { ScholarConfig } from "./types.ts";

const SNIPPET = "scholar";
const RECEIPT = "scholar-appearance.json";

interface AppearanceReceipt {
  schemaVersion: 1;
  installedCssSha256: string;
}

async function readOptional(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readOptionalBytes(path: string): Promise<Buffer | undefined> {
  try { return await readFile(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function parseAppearance(content: string | undefined): Record<string, unknown> {
  let appearance: Record<string, unknown>;
  try {
    const parsed: unknown = content === undefined ? {} : JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    appearance = parsed as Record<string, unknown>;
  } catch { throw new Error("Obsidian appearance.json is not a valid settings object; it was left unchanged."); }
  const enabled = appearance.enabledCssSnippets;
  if (enabled !== undefined && (!Array.isArray(enabled) || !enabled.every((item) => typeof item === "string"))) {
    throw new Error("Obsidian appearance.json enabledCssSnippets must be an array of names; it was left unchanged.");
  }
  return appearance;
}

function parseReceipt(content: string | undefined): AppearanceReceipt | undefined {
  if (content === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    const receipt = parsed as AppearanceReceipt;
    if (receipt.schemaVersion !== 1 || typeof receipt.installedCssSha256 !== "string" || !/^[a-f0-9]{64}$/.test(receipt.installedCssSha256)) throw new Error();
    return receipt;
  } catch { throw new Error("Scholar's appearance installation receipt is invalid; existing styling and settings were left unchanged."); }
}

function cssHash(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function assertOutsideLibrary(canonicalLibrary: string | undefined, paths: string[]): void {
  if (!canonicalLibrary) return;
  const key = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
  for (const path of paths) {
    const fromLibrary = relative(key(canonicalLibrary), key(path));
    if (fromLibrary === "" || (!isAbsolute(fromLibrary) && fromLibrary !== ".." && !fromLibrary.startsWith(`..${sep}`))) {
      throw new Error("Scholar note styling resolves into the read-only PDF library; no appearance settings were changed.");
    }
  }
}

/** Default presentation setup, separate from book-state transactions. */
export async function installScholarAppearance(config: ScholarConfig): Promise<void> {
  if (!config.obsidianRoot.trim()) return;
  const { obsidianRoot, libraryRoot } = resolveScholarConfig(config);
  if (!(await stat(obsidianRoot)).isDirectory()) throw new Error("The configured Obsidian vault is not a directory.");
  const settingsRoot = await safePathWithinRoot(obsidianRoot, resolve(obsidianRoot, ".obsidian"));
  const canonicalLibrary = libraryRoot ? await safePathWithinRoot(libraryRoot, libraryRoot) : undefined;
  assertOutsideLibrary(canonicalLibrary, [settingsRoot]);
  // Serialize Scholar setup calls, without recursively locking atomic file writes.
  await withFileMutationQueue(settingsRoot, async () => {
    const appearancePath = await safePathWithinRoot(obsidianRoot, resolve(settingsRoot, "appearance.json"));
    const snippetPath = await safePathWithinRoot(obsidianRoot, resolve(settingsRoot, "snippets", `${SNIPPET}.css`));
    const receiptPath = await safePathWithinRoot(obsidianRoot, resolve(settingsRoot, RECEIPT));
    // A settings subdirectory or file can independently be a junction/symlink.
    assertOutsideLibrary(canonicalLibrary, [appearancePath, snippetPath, receiptPath]);
    parseAppearance(await readOptional(appearancePath));
    const receipt = parseReceipt(await readOptional(receiptPath));
    const css = await readFile(new URL("./scholar.css", import.meta.url));
    const previousCss = await readOptionalBytes(snippetPath);
    const shippedHash = cssHash(css);
    if (previousCss !== undefined && !previousCss.equals(css) && (!receipt || cssHash(previousCss) !== receipt.installedCssSha256)) {
      // A header cannot establish ownership: users can edit a shipped snippet.
      // Receipt-free legacy installs are trusted only when their bytes match
      // this release. Unknown older versions require manual reconciliation.
      throw new Error("An existing scholar.css was customized or cannot be verified as an unmodified Scholar version; it and appearance settings were left unchanged. Keep your styling, or rename the snippet and remove Scholar's appearance receipt to reinstall the built-in styling.");
    }
    const firstInstall = receipt === undefined && previousCss === undefined;
    // Obsidian can edit its preferences while setup reads the shipped snippet.
    // Merge into its newest validated settings, rather than the earlier snapshot.
    parseAppearance(await readOptional(appearancePath));
    // Never churn preferences or the snippet on ordinary restarts.
    if (!previousCss?.equals(css)) {
      const latestCss = await readOptionalBytes(snippetPath);
      if (previousCss === undefined ? latestCss !== undefined : !latestCss?.equals(previousCss)) {
        throw new Error("scholar.css changed while installing styling; the newer snippet and appearance settings were left unchanged.");
      }
      await writeTextFileAtomic(obsidianRoot, snippetPath, css.toString("utf8"));
    }
    if (firstInstall) {
      // Enable once. Thereafter Obsidian owns the preference, including an
      // explicitly disabled snippet and receipt-free legacy installations.
      const latest = parseAppearance(await readOptional(appearancePath));
      const enabled = latest.enabledCssSnippets;
      if (!Array.isArray(enabled) || !enabled.includes(SNIPPET)) {
        latest.enabledCssSnippets = [...(Array.isArray(enabled) ? enabled : []), SNIPPET];
        await writeTextFileAtomic(obsidianRoot, appearancePath, `${JSON.stringify(latest, null, 2)}\n`);
      }
    }
    if (receipt?.installedCssSha256 !== shippedHash) {
      const nextReceipt: AppearanceReceipt = { schemaVersion: 1, installedCssSha256: shippedHash };
      await writeTextFileAtomic(obsidianRoot, receiptPath, `${JSON.stringify(nextReceipt, null, 2)}\n`);
    }
  });
}

/** Cosmetic setup failures must never prevent teaching or roll back a saved grade. */
export async function ensureScholarAppearance(config: ScholarConfig, warn: (message: string) => void): Promise<void> {
  try { await installScholarAppearance(config); }
  catch (error) {
    warn(`Scholar note styling could not be set up: ${error instanceof Error ? error.message : String(error)} Notes still work without it.`);
  }
}
