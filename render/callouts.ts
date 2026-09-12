/** Native Markdown framing only; never rewrites the mathematical or teaching content. */
export function callout(type: string, title: string, body: string): string {
  return `> [!${type}] ${title}\n>\n${body.replace(/\r\n/g, "\n").split("\n").map(line => line ? `> ${line}` : ">").join("\n")}\n`;
}

const OUTCOMES: Record<string, string> = { Correct: "pass", "Needs review": "review", "Knowledge gap": "unsure" };
export const FEEDBACK_START = "<!-- scholar:feedback:start -->";
export const FEEDBACK_END = "<!-- scholar:feedback:end -->";

/** Read both the original heading format and the new native question frame. */
export function unframeQuestion(chunk: string): string {
  if (!/^> \[!question\] Question \d+\b/.test(chunk)) return chunk;
  const lines = chunk.replace(/^> \[!question\] (Question[^\n]*)/, "### $1").split("\n");
  let feedback = false, result = false;
  return lines.map((line, index) => {
    if (index) line = line.replace(/^> ?/, "");
    if (line.trim() === FEEDBACK_START) { result = true; return ""; }
    if (line.trim() === FEEDBACK_END) { result = feedback = false; return ""; }
    const label = result && /^> \[!(?:success|warning)\] (Correct|Needs review|Knowledge gap)\s*$/.exec(line)?.[1];
    if (label) { feedback = true; return `*${OUTCOMES[label]}*`; }
    return feedback ? line.replace(/^> ?/, "") : line;
  }).join("\n");
}
