/** Convert model-style math delimiters to Obsidian's native delimiters.
 * Only the wrappers change. Code and existing dollar-delimited math are preserved.
 */
export function normalizeObsidianMath(markdown: string): string {
  let fence = "";
  let display = false;
  let legacyDisplayDepth: number | undefined;
  const escaped = (line: string, i: number) => (/(\\*)$/.exec(line.slice(0, i))![1]!.length % 2) === 1;
  return markdown.split(/\r?\n/).map(raw => {
    const prefix = /^(?: {0,3}> ?)+/.exec(raw)?.[0] || "";
    const line = raw.slice(prefix.length);
    const depth = (prefix.match(/>/g) || []).length;
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (delimiter && delimiter[1]![0] === fence[0] && delimiter[1]!.length >= fence.length && !delimiter[2]!.trim()) fence = "";
      return raw;
    }
    if (delimiter && !display && legacyDisplayDepth === undefined) { fence = delimiter[1]!; return raw; }
    let result = "", inline = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === "`" && !display && !inline && legacyDisplayDepth === undefined) {
        const ticks = /^`+/.exec(line.slice(i))![0];
        let end = line.indexOf(ticks, i + ticks.length);
        while (end >= 0 && (line[end - 1] === "`" || line[end + ticks.length] === "`")) end = line.indexOf(ticks, end + ticks.length);
        if (end >= 0) { result += line.slice(i, end + ticks.length); i = end + ticks.length - 1; continue; }
      }
      if (line[i] === "$" && !escaped(line, i) && legacyDisplayDepth === undefined) {
        if (line[i + 1] === "$") { display = !display; result += "$$"; i++; continue; }
        if (!display) inline = !inline;
      }
      if (line[i] === "\\" && !escaped(line, i) && !display && !inline) {
        const next = line[i + 1];
        if (next === "(" && legacyDisplayDepth === undefined) {
          let end = line.indexOf("\\)", i + 2);
          while (end >= 0 && escaped(line, end)) end = line.indexOf("\\)", end + 2);
          if (end >= 0) { result += `$${line.slice(i + 2, end).trim()}$`; i = end + 1; continue; }
        }
        if (next === "[" && legacyDisplayDepth === undefined) {
          legacyDisplayDepth = depth; result += "$$"; i++; continue;
        }
        if (next === "]" && legacyDisplayDepth === depth) {
          legacyDisplayDepth = undefined; result += "$$"; i++; continue;
        }
      }
      result += line[i];
    }
    return prefix + result;
  }).join("\n");
}
