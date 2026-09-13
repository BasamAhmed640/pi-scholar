import { normalizeObsidianMath } from "./math-formatting.ts";
import { callout } from "./render/callouts.ts";

/** Author-supplied meaning; Scholar owns the native Obsidian presentation. */
export type KeyEquation = {
  id: string;
  title: string;
  latex: string;
  symbols: Array<{ symbol: string; definition: string }>;
  assumptions: string;
  meaning: string;
  sourcePages: number[];
};

const equationKeys = ["id", "title", "latex", "symbols", "assumptions", "meaning", "sourcePages"];
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/;
const markerPrefix = "[[scholar-equation:";
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function content(value: unknown, label: string, oneLine = false): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Key equation ${label} must be populated.`);
  const result = value.replace(/\r\n?/g, "\n").trim();
  if ((oneLine && result.includes("\n")) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result)
    || /<!--|-->|\[\[scholar-|^\s*(?:>\s*)*\[!|^\s*(?:>\s*)*#{1,2}\s|^\s*(?:`{3,}|~{3,}|---\s*$)/mi.test(result)) {
    throw new Error(`Key equation ${label} must not contain record metadata, nested callouts, code fences, or structural Markdown.`);
  }
  return result;
}

function math(value: unknown, label: string, oneLine = false): string {
  const result = content(value, label, oneLine);
  // The renderer supplies delimiters. Existing delimiters could close the
  // equation early; accepting them would break both typesetting and framing.
  for (let index = 0; index < result.length; index++) {
    const escaped = (/(\\*)$/.exec(result.slice(0, index))![1]!.length % 2) === 1;
    if (result[index] === "`" || (!escaped && (result[index] === "$" || (result[index] === "\\" && /[()[\]]/.test(result[index + 1] || ""))))) {
      throw new Error(`Key equation ${label} needs raw LaTeX without math delimiters or backticks.`);
    }
  }
  return result;
}

function renderEquation(value: unknown, allowedPages: Set<number>): { id: string; markdown: string } {
  if (!record(value) || Object.keys(value).some(key => !equationKeys.includes(key)) || typeof value.id !== "string" || !idPattern.test(value.id)) {
    throw new Error("Each key equation needs a stable short id and only the declared presentation fields.");
  }
  const id = value.id as string;
  const title = content(value.title, `${id} title`, true).replace(/([\\`*_[\]<>])/g, "\\$1");
  const latex = math(value.latex, `${id} latex`);
  if (!Array.isArray(value.symbols) || !value.symbols.length) throw new Error(`Key equation ${id} needs symbol definitions.`);
  const symbols = new Set<string>();
  const definitions = value.symbols.map((entry: unknown) => {
    if (!record(entry) || Object.keys(entry).some(key => !["symbol", "definition"].includes(key))) throw new Error(`Key equation ${id} has malformed symbol definitions.`);
    const symbol = math(entry.symbol, `${id} symbol`, true);
    if (symbols.has(symbol)) throw new Error(`Key equation ${id} defines the same symbol more than once.`);
    symbols.add(symbol);
    const definition = normalizeObsidianMath(content(entry.definition, `${id} definition`, true));
    return `$${symbol}$ → ${definition}`;
  });
  const assumptions = normalizeObsidianMath(content(value.assumptions, `${id} assumptions`));
  const meaning = normalizeObsidianMath(content(value.meaning, `${id} physical meaning`));
  if (!Array.isArray(value.sourcePages) || !value.sourcePages.length
    || value.sourcePages.some(page => !Number.isSafeInteger(page) || !allowedPages.has(page))
    || new Set(value.sourcePages).size !== value.sourcePages.length) {
    throw new Error(`Key equation ${id} sourcePages must be unique pages in this lesson's source scope.`);
  }
  const body = ["$$", latex, "$$", "", `**Symbols:** ${definitions.join("; ")}`,
    "", `**Assumptions:** ${assumptions}`, "", `**Meaning:** ${meaning}`, "",
    `*Source: PDF ${value.sourcePages.length === 1 ? "page" : "pages"} ${value.sourcePages.join(", ")}.*`].join("\n");
  return { id, markdown: callout("note", `Key equation · ${title}`, body).trimEnd() };
}

/** Expand exactly one explicit placement per central equation, never guess from ordinary display math. */
export function renderKeyEquations(markdown: string, equations: KeyEquation[], allowedPages: number[]): string {
  if (typeof markdown !== "string" || !Array.isArray(equations) || !Array.isArray(allowedPages)
    || allowedPages.some(page => !Number.isSafeInteger(page) || page < 1)) throw new Error("Key equation presentation requires Markdown, equation records, and valid source pages.");
  if (/<!--\s*scholar:|^\s*>\s*\[!info\]- Scholar|^## (?:Questions|Lesson)\s*$/mi.test(markdown)) throw new Error("Equation presentation must not contain Scholar record metadata or reserved headings.");
  const pages = new Set(allowedPages);
  const rendered = new Map<string, string>();
  for (const equation of equations) {
    const result = renderEquation(equation, pages);
    if (rendered.has(result.id)) throw new Error(`Key equation ${result.id} is declared more than once.`);
    rendered.set(result.id, result.markdown);
  }
  const placed = new Set<string>();
  let fence = "";
  let comment = false;
  let display = false;
  const result = markdown.split(/\r?\n/).map(line => {
    const body = line.replace(/^(?: {0,3}> ?)+/, "");
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(body);
    if (line.includes(markerPrefix)) {
      if (fence || delimiter) throw new Error("Place each scholar-equation marker outside code fences.");
      if (comment || display) throw new Error("Place scholar-equation markers in visible prose, outside HTML comments and math blocks.");
      const marker = /^ {0,3}\[\[scholar-equation:([a-zA-Z0-9][a-zA-Z0-9._-]{0,119})\]\][ \t]*$/.exec(line);
      if (!marker) throw new Error("Put each complete [[scholar-equation:ID]] marker on its own line outside callouts and code.");
      const id = marker[1]!;
      if (!rendered.has(id)) throw new Error(`Key equation ${id} has no matching equation record.`);
      if (placed.has(id)) throw new Error(`Key equation ${id} is already placed; reference it in prose instead of duplicating the box.`);
      placed.add(id);
      // Blank lines prevent adjacent callouts and prose from merging.
      return `\n${rendered.get(id)}\n`;
    }
    if (fence) {
      if (delimiter && delimiter[1]![0] === fence[0] && delimiter[1]!.length >= fence.length && !delimiter[2]!.trim()) fence = "";
    } else if (delimiter) fence = delimiter[1]!;
    else {
      const visible = body.replace(/(`+)([^`]*?)\1(?!`)/g, "");
      for (let index = 0; index < visible.length; index++) {
        if (!comment && visible.startsWith("<!--", index)) { comment = true; index += 3; }
        else if (comment && visible.startsWith("-->", index)) { comment = false; index += 2; }
        else if (!comment && visible.startsWith("$$", index) && (/(\\*)$/.exec(visible.slice(0, index))![1]!.length % 2) === 0) {
          display = !display; index++;
        }
      }
    }
    return line;
  }).join("\n");
  for (const id of rendered.keys()) if (!placed.has(id)) throw new Error(`Place key equation ${id} exactly once using [[scholar-equation:${id}]].`);
  return result;
}
