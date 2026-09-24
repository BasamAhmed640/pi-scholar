#!/usr/bin/env node
// Structural inspection of a Scholar Obsidian vault for the end-to-end harness.
//
//   node tests/e2e/vault-inspect.mjs <vault> [--full]
//
// Reports: notes and their frontmatter types; unresolved [[wikilinks]] and
// ![[embeds]] (resolved relative to the note, then the vault root, then by
// unique basename — Obsidian's practical rules); Mermaid fences and a lint of
// each; unbalanced $ / $$ math outside code; duplicate question blocks,
// duplicate attempt/lesson ids and duplicate notes; callout types used; and a
// per-record summary (sections, tutor sessions, exams, answer keys, book outline).
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKIP_DIRECTORIES = new Set([".obsidian", ".trash", ".git"]);
const ASSET_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".pdf", ".mp3", ".mp4", ".webm", ".css", ".canvas"]);
const MERMAID_HEADERS = [
  [/^(?:flowchart|graph)\s+(?:TD|TB|LR|RL|BT)\b/, "flowchart"],
  [/^sequenceDiagram\b/, "sequence"],
  [/^stateDiagram(?:-v2)?\b/, "state"],
  [/^classDiagram\b/, "class"],
  [/^mindmap\b/, "mindmap"],
  [/^timeline\b/, "timeline"],
  [/^pie\b/, "pie"],
  [/^erDiagram\b/, "er"],
];
const MERMAID_FORBIDDEN = [/\bclick\s/i, /\bhref\b/i, /%%\{\s*init/i, /<\s*script/i, /javascript:/i];

function walk(root) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop();
    let entries = [];
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { if (!SKIP_DIRECTORIES.has(entry.name)) stack.push(path); }
      else if (entry.isFile() && !entry.name.startsWith(".")) files.push(path);
    }
  }
  return files.sort();
}

const portable = (path) => path.replace(/\\/g, "/");

export function parseFrontmatter(text) {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return {};
  const data = {};
  let listKey;
  for (const line of match[1].split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) { data[listKey].push(item[1].trim()); continue; }
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!pair) continue;
    const [, key, raw] = pair;
    if (!raw) { data[key] = []; listKey = key; continue; }
    listKey = undefined;
    let value = raw.trim();
    if (/^".*"$/.test(value)) { try { value = JSON.parse(value); } catch { /* keep raw */ } }
    else if (value === "true" || value === "false") value = value === "true";
    else if (/^-?\d+(?:\.\d+)?$/.test(value)) value = Number(value);
    data[key] = value;
  }
  return data;
}

/** Mirrors Scholar's note-records readDetails: `> [!info]- Scholar <kind> details` + a JSON fence. */
export function readDetails(text, kind) {
  const records = [...text.matchAll(/^> \[!info\]- Scholar ([\w-]+) details\r?\n((?:>[^\n]*(?:\n|$))*)/gm)].filter((match) => match[1] === kind);
  if (!records.length) return undefined;
  const body = records[0][2].replace(/^> ?/gm, "").trim();
  const json = /^```json\s*\n([\s\S]*)\n```$/.exec(body);
  if (!json) return { __error: "incomplete details" };
  try { return JSON.parse(json[1]).data; } catch { return { __error: "invalid JSON" }; }
}

export function allDetails(text, kind) {
  const out = [];
  for (const match of text.matchAll(/^> \[!info\]- Scholar ([\w-]+) details\r?\n((?:>[^\n]*(?:\n|$))*)/gm)) {
    if (match[1] !== kind) continue;
    const body = match[2].replace(/^> ?/gm, "").trim();
    const json = /^```json\s*\n([\s\S]*)\n```$/.exec(body);
    if (!json) continue;
    try { out.push(JSON.parse(json[1]).data); } catch { /* reported elsewhere */ }
  }
  return out;
}

/** Splits a line into its blockquote prefix and content. */
function unquote(line) {
  const match = /^((?:\s{0,3}>\s?)*)(.*)$/.exec(line);
  return { prefix: match[1], depth: (match[1].match(/>/g) || []).length, content: match[2] };
}

/**
 * Returns the note with fenced code (including fences inside callouts) and
 * inline code blanked out, preserving line numbers, plus the fences found.
 */
export function maskCode(text) {
  const lines = text.split(/\r?\n/);
  const fences = [];
  let open;
  const masked = lines.map((line, index) => {
    const { content, depth } = unquote(line);
    const delimiter = /^\s{0,3}(`{3,}|~{3,})\s*([^`\s]*)?.*$/.exec(content);
    if (open) {
      if (delimiter && delimiter[1][0] === open.marker[0] && delimiter[1].length >= open.marker.length && !content.trim().slice(delimiter[1].length).trim()) {
        open.endLine = index + 1;
        fences.push(open);
        open = undefined;
      } else {
        open.body.push(content);
      }
      return "";
    }
    if (delimiter) {
      open = { marker: delimiter[1], info: (delimiter[2] || "").toLowerCase(), startLine: index + 1, depth, body: [] };
      return "";
    }
    return line.replace(/(`+)([^`\n]*?)\1/g, (whole) => " ".repeat(whole.length));
  });
  if (open) { open.unclosed = true; fences.push(open); }
  return { masked, fences };
}

export function lintMermaid(body) {
  const errors = [];
  const lines = body.map((line) => line.replace(/\s+$/, ""));
  const first = lines.find((line) => line.trim() && !line.trim().startsWith("%%"));
  let kind = "unknown";
  if (!first) errors.push("empty diagram");
  else {
    const header = MERMAID_HEADERS.find(([pattern]) => pattern.test(first.trim()));
    if (header) kind = header[1];
    else errors.push(`unsupported or missing header: "${first.trim().slice(0, 60)}"`);
    if (lines.indexOf(first) !== lines.findIndex((line) => line.trim())) errors.push("header is not on the first line");
  }
  lines.forEach((line, index) => {
    for (const pattern of MERMAID_FORBIDDEN) if (pattern.test(line)) errors.push(`line ${index + 1}: forbidden construct ${pattern}`);
    if (((line.match(/"/g) || []).length % 2) !== 0) errors.push(`line ${index + 1}: unbalanced double quotes`);
  });
  const pairs = { ")": "(", "]": "[", "}": "{" };
  const stack = [];
  const joined = lines.join("\n").replace(/"[^"\n]*"/g, "\"\"");
  for (const character of joined) {
    if ("([{".includes(character)) stack.push(character);
    else if (character in pairs) {
      if (stack.at(-1) === pairs[character]) stack.pop();
      else { errors.push(`unbalanced bracket "${character}"`); break; }
    }
  }
  if (stack.length) errors.push(`unclosed bracket(s): ${stack.join("")}`);
  const nodeIds = new Set();
  if (kind === "flowchart") for (const match of joined.matchAll(/\b([A-Za-z][\w-]*)\s*(?:\[|\(|\{|>)/g)) nodeIds.add(match[1]);
  return { kind, lines: lines.length, nodes: nodeIds.size, errors };
}

/** $$ blocks must pair up; inline $ must pair within each paragraph. */
export function mathIssues(maskedLines) {
  const issues = [];
  const content = maskedLines.map((line) => unquote(line).content.replace(/\\\$/g, "  "));
  const text = content.join("\n");
  const displayCount = (text.match(/\$\$/g) || []).length;
  if (displayCount % 2) issues.push({ line: 0, problem: `odd number of $$ delimiters (${displayCount})` });
  const withoutDisplay = text.replace(/\$\$[\s\S]*?\$\$/g, (block) => block.replace(/[^\n]/g, " "));
  const paragraphs = withoutDisplay.split(/\n\s*\n/);
  let line = 1;
  for (const paragraph of paragraphs) {
    const count = (paragraph.match(/\$/g) || []).length;
    if (count % 2) issues.push({ line, problem: "odd number of inline $ in paragraph", snippet: paragraph.trim().replace(/\s+/g, " ").slice(0, 120) });
    line += paragraph.split("\n").length + 1;
  }
  return issues;
}

function questionChunks(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^## Questions\s*$/.test(line));
  if (start < 0) return [];
  const chunks = [];
  let current;
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index];
    if (/^(?:## |<!-- scholar:generated:end -->)/.test(line)) break;
    const header = /^(?:### |> \[!question\] )Question (\d+)\b(.*)$/.exec(line);
    if (header) { if (current) chunks.push(current); current = { number: Number(header[1]), header: line, line: index + 1, body: [] }; }
    else if (current) current.body.push(line);
  }
  if (current) chunks.push(current);
  return chunks.map((chunk) => {
    const bodyLines = chunk.body.map((line) => line.replace(/^> ?/, ""));
    const stop = bodyLines.findIndex((line) => /^#### |^> ?\[!info\]- Scholar |^\[!info\]- Scholar |^\*(?:Awaiting response|Cancelled|pending|pass|review|unsure|unavailable)\*\s*$|^<!-- scholar:feedback/.test(line));
    const prompt = (stop < 0 ? bodyLines : bodyLines.slice(0, stop)).join(" ").replace(/\s+/g, " ").trim();
    const raw = chunk.body.join("\n");
    const status = /^>?\s*\*(Awaiting response|Cancelled|pending|pass|review|unsure|unavailable)\*\s*$/m.exec(raw)?.[1]
      || (/\[!success\] Correct/.test(raw) ? "Correct" : /\[!warning\] (Needs review|Knowledge gap)/.exec(raw)?.[1]);
    const details = readDetails(raw.split("\n").map((line) => line.replace(/^> ?(?=>)/, "")).join("\n"), "question")
      || readDetails(`${chunk.body.map((line) => line.replace(/^> /, "")).join("\n")}`, "question");
    return { number: chunk.number, line: chunk.line, prompt, status: status || "unknown", id: details?.id, format: details?.format, kind: details?.kind, purpose: details?.grounding?.purpose };
  });
}

function resolveLink(target, noteDir, vaultRoot, byBasename) {
  // Inside Markdown tables the alias separator is escaped as `\|`.
  let clean = target.split(/\\?\|/)[0].split("#")[0].split("^")[0].trim();
  if (!clean) return { ok: true, self: true };
  try { clean = decodeURIComponent(clean); } catch { /* literal percent */ }
  const hasExtension = ASSET_EXTENSIONS.has(extname(clean).toLowerCase()) || extname(clean).toLowerCase() === ".md";
  const variants = hasExtension ? [clean] : [`${clean}.md`, clean];
  for (const variant of variants) {
    for (const base of [noteDir, vaultRoot]) {
      const candidate = resolve(base, variant);
      if (existsSync(candidate) && statSync(candidate).isFile()) return { ok: true, path: candidate };
    }
  }
  const name = basename(variants[0]).toLowerCase();
  const matches = byBasename.get(name) || [];
  if (matches.length === 1) return { ok: true, path: matches[0], viaBasename: true };
  return { ok: false, ambiguous: matches.length > 1 };
}

export function inspectVault(vaultRoot, { full = false } = {}) {
  const root = resolve(vaultRoot);
  const files = existsSync(root) ? walk(root) : [];
  const notes = files.filter((file) => extname(file).toLowerCase() === ".md");
  const byBasename = new Map();
  for (const file of files) {
    const key = basename(file).toLowerCase();
    if (!byBasename.has(key)) byBasename.set(key, []);
    byBasename.get(key).push(file);
  }
  const summary = {
    vault: root,
    counts: { files: files.length, notes: notes.length, assets: files.length - notes.length },
    types: {},
    links: { total: 0, embeds: 0, unresolved: [] },
    mermaid: { total: 0, byKind: {}, lintErrors: [] },
    math: { issues: [] },
    callouts: {},
    duplicates: { questionBlocks: [], questionIds: [], lessonEntryIds: [], notes: [], identicalContent: [] },
    sections: [],
    tutors: [],
    exams: [],
    answerKeys: [],
    examPapers: [],
    book: undefined,
    notes: full ? [] : undefined,
  };
  const questionIds = new Map();
  const recordKeys = new Map();
  const contentHashes = new Map();

  for (const file of notes) {
    const text = readFileSync(file, "utf8");
    const rel = portable(relative(root, file));
    const frontmatter = parseFrontmatter(text);
    const type = typeof frontmatter.type === "string" ? frontmatter.type : "(none)";
    summary.types[type] = (summary.types[type] || 0) + 1;
    if (full) summary.notes.push({ path: rel, type, bytes: Buffer.byteLength(text) });

    const hash = createHash("sha256").update(text).digest("hex");
    if (!contentHashes.has(hash)) contentHashes.set(hash, []);
    contentHashes.get(hash).push(rel);

    const recordId = frontmatter.section_id || frontmatter.tutor_id || frontmatter.exam_id || (type === "scholar-book" ? frontmatter.book_id : undefined);
    // Scholar's own migration archive keeps superseded copies on purpose.
    const archived = /(^|\/)Legacy notes\//.test(rel);
    if (recordId && type !== "(none)" && !archived) {
      const key = `${type}\u0000${frontmatter.book_id ?? ""}\u0000${recordId}`;
      if (!recordKeys.has(key)) recordKeys.set(key, []);
      recordKeys.get(key).push(rel);
    }

    const { masked, fences } = maskCode(text);

    // Links and embeds (outside code).
    for (const [lineIndex, line] of masked.entries()) {
      for (const match of line.matchAll(/(!?)\[\[([^\]\n]+?)\]\]/g)) {
        summary.links.total += 1;
        if (match[1]) summary.links.embeds += 1;
        const resolved = resolveLink(match[2], dirname(file), root, byBasename);
        if (!resolved.ok) summary.links.unresolved.push({ note: rel, line: lineIndex + 1, link: match[0].slice(0, 200), ambiguous: resolved.ambiguous || undefined });
      }
      for (const callout of line.matchAll(/^\s*(?:>\s*)+\[!([\w-]+)\]([+-]?)/g)) {
        summary.callouts[callout[1]] = (summary.callouts[callout[1]] || 0) + 1;
      }
    }

    // Mermaid fences.
    const mermaidInNote = [];
    for (const fence of fences) {
      if (fence.info !== "mermaid") continue;
      const lint = lintMermaid(fence.body);
      summary.mermaid.total += 1;
      summary.mermaid.byKind[lint.kind] = (summary.mermaid.byKind[lint.kind] || 0) + 1;
      if (fence.unclosed) lint.errors.push("unclosed fence");
      mermaidInNote.push({ line: fence.startLine, ...lint });
      if (lint.errors.length) summary.mermaid.lintErrors.push({ note: rel, line: fence.startLine, kind: lint.kind, errors: lint.errors });
    }

    // Math outside code.
    for (const issue of mathIssues(masked)) summary.math.issues.push({ note: rel, ...issue });

    // Questions: duplicate prompts within a note, duplicate ids across notes.
    const chunks = questionChunks(text);
    const seenPrompts = new Map();
    for (const chunk of chunks) {
      const key = chunk.prompt.toLowerCase();
      if (key && seenPrompts.has(key)) summary.duplicates.questionBlocks.push({ note: rel, question: chunk.number, duplicateOf: seenPrompts.get(key), prompt: chunk.prompt.slice(0, 160) });
      else if (key) seenPrompts.set(key, chunk.number);
      if (chunk.id) {
        if (!questionIds.has(chunk.id)) questionIds.set(chunk.id, []);
        questionIds.get(chunk.id).push(`${rel}#Q${chunk.number}`);
      }
    }

    // Lesson entry ids (Learn/Tutor units).
    const entries = allDetails(text, "entry");
    const entryIds = entries.map((entry) => entry?.id).filter(Boolean);
    const duplicateEntries = entryIds.filter((id, index) => entryIds.indexOf(id) !== index);
    if (duplicateEntries.length) summary.duplicates.lessonEntryIds.push({ note: rel, ids: [...new Set(duplicateEntries)] });
    const lessonTitles = entries.map((entry) => entry?.lesson?.title).filter(Boolean);

    const embeds = masked.reduce((count, line) => count + (line.match(/!\[\[/g) || []).length, 0);
    const outcomes = chunks.reduce((tally, chunk) => ({ ...tally, [chunk.status]: (tally[chunk.status] || 0) + 1 }), {});

    if (type === "scholar-section") {
      const details = readDetails(text, "section") || {};
      summary.sections.push({
        path: rel, sectionId: frontmatter.section_id, number: details.number, title: details.title, status: frontmatter.status,
        pages: details.startPage ? `${details.startPage}-${details.endPage}` : undefined,
        lessonCommitted: Boolean(details.lessonCommit), lessonUnits: entries.filter((entry) => entry?.lesson).length, lessonTitles,
        questions: chunks.length, outcomes, questionIds: chunks.map((chunk) => chunk.id).filter(Boolean),
        questionFormats: chunks.reduce((tally, chunk) => ({ ...tally, [chunk.format || "?"]: (tally[chunk.format || "?"] || 0) + 1 }), {}),
        mermaid: mermaidInNote.length, mermaidKinds: mermaidInNote.map((item) => item.kind), embeds,
        reviewReceipts: Array.isArray(details.learnQuality?.reviews) ? details.learnQuality.reviews.length : undefined,
        reviewFailures: Array.isArray(details.learnQuality?.reviews) ? details.learnQuality.reviews.filter((review) => review.failure).map((review) => `${review.role}:${review.failure.code}`) : undefined,
        figureReviewPages: Array.isArray(details.figureCoverage?.pages) ? details.figureCoverage.pages.length : undefined,
        snapshots: Array.isArray(details.snapshots) ? details.snapshots.length : undefined,
        bytes: Buffer.byteLength(text),
      });
    } else if (type === "scholar-tutor") {
      const details = readDetails(text, "tutor") || {};
      summary.tutors.push({ path: rel, tutorId: frontmatter.tutor_id, status: frontmatter.status, title: details.title, lessonUnits: entries.filter((entry) => entry?.lesson).length, lessonTitles,
        questions: chunks.length, outcomes, mermaid: mermaidInNote.length, mermaidKinds: mermaidInNote.map((item) => item.kind), embeds, bytes: Buffer.byteLength(text) });
    } else if (type === "scholar-exam") {
      const details = readDetails(text, "exam") || {};
      summary.exams.push({ path: rel, examId: frontmatter.exam_id, status: frontmatter.status, title: details.title, questions: chunks.length,
        earnedPoints: details.earnedPoints, maxPoints: details.maxPoints, percent: details.percent, submittedAt: details.submittedAt, gradedAt: details.gradedAt });
    } else if (type === "scholar-answer-key") {
      summary.answerKeys.push({ path: rel, examId: frontmatter.exam_id, score: frontmatter.score, mermaid: mermaidInNote.length, mermaidKinds: mermaidInNote.map((item) => item.kind) });
    } else if (type === "scholar-exam-paper") {
      const regions = [...text.matchAll(/<!-- scholar:answer:(.+?):start -->/g)].map((match) => match[1]);
      const checked = (text.match(/^>?\s*- \[[xX]\] /gm) || []).length;
      summary.examPapers.push({ path: rel, examId: frontmatter.exam_id, regions: regions.length, checkedBoxes: checked, complete: text.includes("<!-- scholar:exam-paper:complete -->") });
    } else if (type === "scholar-book") {
      const details = readDetails(text, "book") || {};
      summary.book = {
        path: rel, title: details.metadata?.title, outlineStatus: details.outlineStatus, revision: details.revision,
        chapters: (details.chapters || []).map((chapter) => ({ number: chapter.number, title: chapter.title, startPage: chapter.startPage, endPage: chapter.endPage,
          sections: (chapter.sections || []).map((section) => ({ id: section.id, number: section.number, title: section.title, startPage: section.startPage, endPage: section.endPage })) })),
      };
    }
  }

  for (const [id, places] of questionIds) if (places.length > 1) summary.duplicates.questionIds.push({ id, places });
  for (const [key, paths] of recordKeys) {
    if (paths.length < 2) continue;
    const [type, bookId, recordId] = key.split("\u0000");
    summary.duplicates.notes.push({ record: `${type} ${recordId}${bookId ? ` (book ${String(bookId).slice(0, 12)})` : ""}`, paths });
  }
  for (const [, paths] of contentHashes) if (paths.length > 1) summary.duplicates.identicalContent.push(paths);
  summary.ok = !summary.links.unresolved.length && !summary.mermaid.lintErrors.length && !summary.math.issues.length
    && !summary.duplicates.questionBlocks.length && !summary.duplicates.questionIds.length && !summary.duplicates.lessonEntryIds.length && !summary.duplicates.notes.length;
  return summary;
}

/** Finds the section note for a displayed number such as "1.1". */
export function findSectionNote(vaultRoot, number) {
  const root = resolve(vaultRoot);
  if (!existsSync(root)) return undefined;
  for (const file of walk(root)) {
    if (extname(file) !== ".md" || !/[\\/]Sections[\\/]/.test(file)) continue;
    const text = readFileSync(file, "utf8");
    if (parseFrontmatter(text).type !== "scholar-section") continue;
    const details = readDetails(text, "section");
    if (details?.number === number || basename(file).startsWith(`${number} - `)) return { path: file, text, details, frontmatter: parseFrontmatter(text) };
  }
  return undefined;
}

export function findNotesOfType(vaultRoot, type) {
  const root = resolve(vaultRoot);
  if (!existsSync(root)) return [];
  return walk(root).filter((file) => extname(file) === ".md").flatMap((file) => {
    const text = readFileSync(file, "utf8");
    const frontmatter = parseFrontmatter(text);
    return frontmatter.type === type ? [{ path: file, text, frontmatter }] : [];
  });
}

/** Parsed question blocks of a section/tutor note (prompt, status, id, format). */
export function sectionQuestions(text) { return questionChunks(text); }

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const vault = process.argv[2];
  if (!vault) { console.error("Usage: node tests/e2e/vault-inspect.mjs <vault> [--full]"); process.exit(2); }
  const summary = inspectVault(vault, { full: process.argv.includes("--full") });
  console.log(JSON.stringify(summary, null, process.argv.includes("--pretty") ? 2 : undefined));
  process.exitCode = summary.ok ? 0 : 1;
}
