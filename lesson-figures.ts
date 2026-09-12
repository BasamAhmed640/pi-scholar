import { sectionNotePath, snapshotAssetPath, tutorNotePath } from "./obsidian-paths.ts";
import { callout } from "./render/callouts.ts";
import { markdownText, neutralizeScholarMarkers, wikiEmbed } from "./render/common.ts";
import type { ScholarBook, ScholarConfig, ScholarSection, TutorSession } from "./types.ts";

/** Resolve explicit placements before saving, so the visible note holds native Markdown. */
export function resolveLessonFigures(markdown: string, record: ScholarSection | TutorSession, book: ScholarBook,
  sourcePages: number[], config?: ScholarConfig): string {
  if (!markdown.includes("[[scholar-figure:")) return markdown;
  if (!config) throw new Error("Figure placement requires the active vault configuration.");
  const chapter = "objectives" in record ? book.chapters.find(item => item.sections.some(section => section.id === record.id)) : undefined;
  if ("objectives" in record && !chapter) throw new Error("The active lesson section is not in this book.");
  const notePath = "objectives" in record ? sectionNotePath(config, book, chapter!, record) : tutorNotePath(config, book, record);
  const placed = new Set<string>();
  const callouts = new Map<number, string>();
  let fence: { marker: string; length: number } | undefined;
  return markdown.split(/\r?\n/).map(line => {
    const [, prefix, body] = /^((?: {0,3}> ?)*)(.*)$/.exec(line)!;
    const depth = (prefix!.match(/>/g) || []).length;
    for (const level of callouts.keys()) if (level > depth || depth === 0) callouts.delete(level);
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(body!);
    if (fence) {
      if (line.includes("[[scholar-figure:")) throw new Error("Place each scholar-figure marker on its own line outside code fences.");
      if (delimiter && delimiter[1]![0] === fence.marker && delimiter[1]!.length >= fence.length && !delimiter[2]!.trim()) fence = undefined;
      return line;
    }
    if (delimiter) {
      if (line.includes("[[scholar-figure:")) throw new Error("Place each scholar-figure marker on its own line outside code fences.");
      fence = { marker: delimiter[1]![0]!, length: delimiter[1]!.length };
      return line;
    }
    const header = /^\[!([\w-]+)\]/.exec(body!.trimStart());
    if (depth && header) callouts.set(depth, header[1]!.toLowerCase());
    if (!line.includes("[[scholar-figure:")) return line;
    const marker = /^ {0,3}\[\[scholar-figure:([^\]\r\n]+)\]\]\s*$/.exec(body!);
    if (!marker) throw new Error("Put each complete [[scholar-figure:ID]] marker on its own line, optionally inside a callout.");
    const snapshot = record.snapshots?.find(item => item.id === marker[1]);
    if (!snapshot || !sourcePages.includes(snapshot.page)) throw new Error(`Lesson figure ${marker[1]} must be a saved snapshot on one of this entry's sourcePages.`);
    if (placed.has(snapshot.id)) throw new Error(`Figure ${snapshot.id} is already placed in this explanation; refer to its label instead of repeating the image.`);
    placed.add(snapshot.id);
    const caption = neutralizeScholarMarkers(markdownText(snapshot.caption)).replace(/\[!info\]- Scholar/g, "\\[!info]- Scholar");
    const figure = [wikiEmbed(notePath, snapshotAssetPath(config, book, snapshot), 720), "",
      caption, "", `*Source: PDF viewer page ${snapshot.page}.*`].join("\n");
    const alreadyFramed = depth > 0 && ["example", "figure"].includes(callouts.get(depth) || "");
    const expanded = alreadyFramed ? figure : callout("example", `Figure · PDF page ${snapshot.page}`, figure).trimEnd();
    return expanded.split("\n").map(part => `${prefix}${part}`.trimEnd()).join("\n");
  }).join("\n");
}
