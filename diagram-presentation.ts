import { callout } from "./render/callouts.ts";

/** Author-supplied meaning; Scholar validates and frames the Mermaid diagram. */
export type LessonDiagram = {
  id: string;
  title: string;
  kind: "flowchart" | "sequence" | "state" | "class" | "mindmap" | "timeline";
  mermaid: string;
  takeaway: string;
  sourcePages: number[];
};

const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/;
const kinds = new Set(["flowchart", "sequence", "state", "class", "mindmap", "timeline"]);
const keys = ["id", "title", "kind", "mermaid", "takeaway", "sourcePages"];
const markerPrefix = "[[scholar-diagram:";
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function oneLine(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\n") || value.length > 500
    || /[\u0000-\u001f\u007f]|<!--|-->|\[\[scholar-|^\s*(?:[>#]|`{3,}|~{3,})/.test(value)) {
    throw new Error(`Diagram ${label} must be one line of ordinary text.`);
  }
  return value.trim();
}

const header = (kind: LessonDiagram["kind"]): RegExp => ({
  flowchart: /^flowchart\s+(?:TD|TB|BT|LR|RL)\s*$/,
  sequence: /^sequenceDiagram\s*$/,
  state: /^stateDiagram-v2\s*$/,
  class: /^classDiagram\s*$/,
  mindmap: /^mindmap\s*$/,
  timeline: /^timeline\s*$/,
})[kind];

/** Quote unquoted flowchart labels that Mermaid can misparse as syntax. */
function quoteFlowchartLabels(line: string): string {
  return line.replace(/\b([A-Za-z][\w-]*)\s*(\[|\{|\(\()([^\]\}\n]*?)(\]|\}|\)\))/g,
    (whole, id: string, open: string, label: string, close: string) => {
      if ((open === "[" && close !== "]") || (open === "{" && close !== "}") || (open === "((" && close !== "))")) return whole;
      const trimmed = label.trim();
      if (!trimmed || /^"(?:[^"\\]|\\.)*"$/.test(trimmed) || !/[,:;?!()%]/.test(trimmed)) return whole;
      return `${id}${open}"${trimmed.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"${close}`;
    });
}

function syntaxIssue(line: string): string | undefined {
  const stack: string[] = [];
  let quoted = false, escaped = false;
  const closing: Record<string, string> = { "]": "[", "}": "{", ")": "(" };
  for (const char of line) {
    if (escaped) { escaped = false; continue; }
    if (char === "\\") { escaped = true; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if ("[{(".includes(char)) stack.push(char);
    else if ("]})".includes(char) && stack.pop() !== closing[char]) return "unbalanced brackets";
  }
  if (quoted) return "unbalanced quotes";
  if (stack.length) return "unbalanced brackets";
}

function nodeCount(lines: string[], kind: LessonDiagram["kind"]): number {
  if (kind === "mindmap" || kind === "timeline") return lines.slice(1).filter(line => line.trim() && !/^\s*%%/.test(line)).length;
  const ids = new Set<string>();
  for (const line of lines.slice(1)) {
    if (kind === "class" || kind === "state") {
      const declaration = /^\s*(?:class|state)\s+([A-Za-z][\w-]*)\b/.exec(line);
      if (declaration) ids.add(declaration[1]!);
    }
    if (/^\s*(?:classDef|class|state|style|linkStyle|direction|%%|Note\b|activate\b|deactivate\b)/i.test(line)) continue;
    const chunks = kind === "sequence"
      ? [...line.matchAll(/\b(?:participant|actor)\s+([A-Za-z][\w-]*)|\b([A-Za-z][\w-]*)\s*(?:--?|->>?|-->>|->>)[+x-]?\s*([A-Za-z][\w-]*)/g)]
      : [...line.matchAll(/(?:^|\s|[|;&])([A-Za-z][\w-]*)\s*(?=\[|\{|\(|-->|-.->|==>|---|<\|--|\*--|o--|:)|(?:-->|-.->|==>|---|<\|--|\*--|o--)\s*([A-Za-z][\w-]*)/g)];
    for (const chunk of chunks) for (const part of chunk.slice(1)) if (part) ids.add(part);
  }
  return ids.size;
}

/** Accept a small, documented Mermaid subset instead of saving arbitrary prose as a diagram. */
function diagramStatement(line: string, kind: LessonDiagram["kind"]): boolean {
  const value = line.trim();
  if (!value || value.startsWith("%%")) return true;
  if (kind === "flowchart") {
    if (/^(?:classDef\s+\S+\s+\S+|class\s+\S+\s+\S+|style\s+\S+\s+\S+|linkStyle\s+\d+\s+\S+|direction\s+(?:TD|TB|BT|LR|RL)|subgraph\s+\S.*|end)$/i.test(value)) return true;
    const node = String.raw`[A-Za-z][\w-]*(?::::[\w-]+)?(?:\[[^\]]+\]|\([^)]*\)|\{[^}]*\})?`;
    const edge = String.raw`(?:-->|-.->|==>|---)(?:\|[^|]+\|)?`;
    return new RegExp(`^${node}(?:\\s*${edge}\\s*${node})*;?$`).test(value);
  }
  if (kind === "sequence") return /^(?:(?:participant|actor)\s+[A-Za-z][\w-]*(?:\s+as\s+.+)?|[A-Za-z][\w-]*\s*(?:->>|-->>|->|-->|-x|--x)\s*[A-Za-z][\w-]*\s*:\s*.+|(?:Note\s+(?:over|left of|right of)\s+.+|activate\s+\S+|deactivate\s+\S+|autonumber|alt\s+.+|else\s+.+|opt\s+.+|loop\s+.+|par\s+.+|and\s+.+|end))$/i.test(value);
  if (kind === "state") return /^(?:\[\*\]|[A-Za-z][\w-]*)(?:\s*--?>\s*(?:\[\*\]|[A-Za-z][\w-]*)(?:\s*:\s*.+)?|\s*:\s*.+)$|^state\s+[A-Za-z][\w-]*(?:\s+as\s+.+)?$/i.test(value);
  if (kind === "class") return /^(?:class\s+[A-Za-z][\w-]*(?:\s*\{)?|\}|[A-Za-z][\w-]*\s*(?:<\|--|\*--|o--|-->|--|\.\.)\s*[A-Za-z][\w-]*(?:\s*:\s*.+)?|[+#~-]?[A-Za-z][\w-]*(?:\([^)]*\))?(?:\s*:\s*.+)?)$/.test(value);
  if (kind === "mindmap") return /^(?:root\(\(.+\)\)|[A-Za-z0-9][^<>`{}]*)$/.test(value);
  return /^(?:title\s+.+|section\s+.+|[^:]+\s*:\s*.+)$/.test(value);
}

/** Returns lint-clean Mermaid; all errors identify their source line. */
export function lintMermaid(value: unknown, kind: LessonDiagram["kind"]): string {
  if (typeof value !== "string" || !value.trim() || !kinds.has(kind)) throw new Error("Diagram needs Mermaid text and a supported kind.");
  const lines = value.replace(/\r\n?/g, "\n").trim().split("\n");
  if (lines.length > 80) throw new Error("Diagram line 81: Mermaid is limited to 80 lines.");
  if (!header(kind).test(lines[0]!.trim())) throw new Error(`Diagram line 1: header must match kind ${kind}.`);
  if (lines.length < 2) throw new Error("Diagram line 2: add at least one diagram statement.");
  const normalized = lines.map((raw, index) => {
    const line = kind === "flowchart" && index ? quoteFlowchartLabels(raw) : raw;
    if (/```|~~~|%%\s*\{|\[\[scholar-|<!--|\b(?:click|href|script|javascript)\b|<\s*\/?[a-z][^>]*>|\b(?:data|javascript):|\burl\s*\(/i.test(line)) {
      throw new Error(`Diagram line ${index + 1}: active links, directives, HTML, scripts and code fences are not allowed.`);
    }
    const issue = syntaxIssue(line);
    if (issue) throw new Error(`Diagram line ${index + 1}: ${issue}.`);
    if (index && !diagramStatement(line, kind)) throw new Error(`Diagram line ${index + 1}: unsupported or malformed ${kind} statement.`);
    return line;
  });
  const count = nodeCount(normalized, kind);
  if (!count) throw new Error("Diagram needs at least one node or event.");
  if (count > 40) throw new Error("Diagram exceeds 40 nodes.");
  return normalized.join("\n");
}

function renderDiagram(value: unknown, allowedPages: Set<number>): { id: string; markdown: string } {
  if (!record(value) || Object.keys(value).some(key => !keys.includes(key)) || !idPattern.test(String(value.id || ""))
    || !kinds.has(String(value.kind || ""))) throw new Error("Each diagram needs a stable short id, a supported kind and only the declared fields.");
  const diagram = value as LessonDiagram;
  const title = oneLine(diagram.title, `${diagram.id} title`).replace(/([\\`*_[\]<>])/g, "\\$1");
  const takeaway = oneLine(diagram.takeaway, `${diagram.id} takeaway`);
  if (!Array.isArray(diagram.sourcePages) || !diagram.sourcePages.length
    || diagram.sourcePages.some(page => !Number.isSafeInteger(page) || !allowedPages.has(page))
    || new Set(diagram.sourcePages).size !== diagram.sourcePages.length) {
    throw new Error(`Diagram ${diagram.id} sourcePages must be unique pages in this lesson's source scope.`);
  }
  const mermaid = lintMermaid(diagram.mermaid, diagram.kind);
  const body = ["```mermaid", mermaid, "```", "", `**Takeaway:** ${takeaway}`, "",
    `*Source: PDF ${diagram.sourcePages.length === 1 ? "page" : "pages"} ${diagram.sourcePages.join(", ")}.*`].join("\n");
  return { id: diagram.id, markdown: callout("scholar-diagram", `Diagram · ${title}`, body).trimEnd() };
}

/** Expand each own-line marker once; return IDs in saved visual order. */
export function renderLessonDiagrams(markdown: string, diagrams: LessonDiagram[], allowedPages: number[]): { markdown: string; diagramIds: string[] } {
  if (typeof markdown !== "string" || !Array.isArray(diagrams) || !Array.isArray(allowedPages)) throw new Error("Diagram presentation needs Markdown, diagrams and source pages.");
  if (/^ {0,3}>\s*\[!scholar-diagram\]/m.test(markdown)) throw new Error("Use diagram records and own-line markers; do not author Scholar diagram callouts directly.");
  const rendered = new Map<string, string>();
  for (const diagram of diagrams) {
    const result = renderDiagram(diagram, new Set(allowedPages));
    if (rendered.has(result.id)) throw new Error(`Diagram ${result.id} is declared more than once.`);
    rendered.set(result.id, result.markdown);
  }
  const placed: string[] = [];
  let fence = "", comment = false, display = false;
  const result = markdown.split(/\r?\n/).map(line => {
    const body = line.replace(/^(?: {0,3}> ?)+/, "");
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(body);
    if (line.includes(markerPrefix)) {
      if (fence || delimiter || comment || display) throw new Error("Place scholar-diagram markers in visible prose outside code, comments and math.");
      const marker = /^ {0,3}\[\[scholar-diagram:([a-zA-Z0-9][a-zA-Z0-9._-]{0,119})\]\][ \t]*$/.exec(line);
      if (!marker) throw new Error("Put each complete [[scholar-diagram:ID]] marker on its own line outside callouts.");
      const id = marker[1]!;
      if (!rendered.has(id)) throw new Error(`Diagram ${id} has no matching diagram record.`);
      if (placed.includes(id)) throw new Error(`Diagram ${id} is already placed.`);
      placed.push(id);
      return `\n${rendered.get(id)}\n`;
    }
    if (fence) {
      if (delimiter && delimiter[1]![0] === fence[0] && delimiter[1]!.length >= fence.length && !delimiter[2]!.trim()) fence = "";
    } else if (delimiter) fence = delimiter[1]!;
    else {
      for (let i = 0; i < body.length; i++) {
        if (!comment && body.startsWith("<!--", i)) { comment = true; i += 3; }
        else if (comment && body.startsWith("-->", i)) { comment = false; i += 2; }
        else if (!comment && body.startsWith("$$", i)) { display = !display; i++; }
      }
    }
    return line;
  }).join("\n");
  for (const id of rendered.keys()) if (!placed.includes(id)) throw new Error(`Place diagram ${id} exactly once using [[scholar-diagram:${id}]].`);
  return { markdown: result, diagramIds: placed };
}
