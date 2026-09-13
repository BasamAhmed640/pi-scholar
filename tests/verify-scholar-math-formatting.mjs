import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { extensionPath, jitiPath } from "./sdk.mjs";
const { createJiti } = await import(pathToFileURL(jitiPath));
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { normalizeObsidianMath: normalize } = await jiti.import(join(dirname(extensionPath), "math-formatting.ts"));
const { lessonMarkdownIssues: issues, saveLesson, lessonReady, commitLesson, lessonHash } = await jiti.import(join(dirname(extensionPath), "lesson.ts"));
const { transcriptBlock, readTranscript } = await jiti.import(join(dirname(extensionPath), "note-records.ts"));

const broken = String.raw`### Dot product

The magnitude of \(\mathbf A\) is \(|\mathbf A|\).
The dot product is
\[
\mathbf A\cdot\mathbf B=AB\cos\theta,
\]
where \(\theta\) is the angle between the vectors.`;
const expected = String.raw`### Dot product

The magnitude of $\mathbf A$ is $|\mathbf A|$.
The dot product is
$$
\mathbf A\cdot\mathbf B=AB\cos\theta,
$$
where $\theta$ is the angle between the vectors.`;
assert.equal(normalize(broken), expected);
assert.equal(normalize(expected), expected);
assert.equal(issues(expected).length, 0);
assert.ok(issues(broken).some(issue => /Obsidian math delimiters/.test(issue)));
console.log("[PASS] the actual Griffiths-style delimiter failure converts without changing any TeX expression");

for (const prefix of ["> ", "> > ", "  > "]) {
  const original = ["[!note] Key equation", String.raw`\[`, String.raw`t = \frac{\ell}{v}`, String.raw`\]`, String.raw`Symbols: \(t\) → delay.`].map(line => prefix + line).join("\n");
  const result = normalize(original);
  assert.equal(issues(result).length, 0, JSON.stringify(issues(result)));
  assert.ok(result.includes(prefix + "$$"));
  assert.ok(result.includes(prefix + "Symbols: $t$ → delay."));
}
console.log("[PASS] nested and indented callouts retain their boundaries during math conversion");

for (const code of ["```python\nvalue = '$5'\npattern = r'\\(x\\)'\n```", "> ```text\n> \\[\n> example\n> \\]\n> ```", "A filename `cost$5.txt` and assignment `x = 2`.", "Literal delimiters `\\(x\\)`.", "``literal `\\(x\\)` example``", String.raw`Already rendered: $\text{\(literal\)}$.`]) {
  assert.equal(normalize(code), code);
}
assert.equal(issues("```python\nvalue = '$5'\npattern = r'\\(x\\)'\n```\n\nUse `x = 2`. A book costs $5.").length, 0);
console.log("[PASS] existing native math, ordinary currency and genuine code examples are preserved");

for (const malformed of ["$\\theta", "$$x = 2", "$$\n\n$$", "> [!note] Key equation\n> ```latex\n> $$x=2$$\n> ```", "> [!note] Key equation\n> `$$x=2$$`", "The product is `A·B = AB cos(theta)`.", "The result is \\mathbf A.", "> $$\n> x=2\n$$", "\\(\\theta", "\\[\nx=2"]) {
  assert.ok(issues(normalize(malformed)).length, `broken math accepted: ${malformed}`);
}
for (const valid of ["$x$ and $y$", "$$x = 2$$", "> [!note] Key equation\n> $$t = \\frac{l}{v}$$", "```js\nconst f = x => x * 2;\n```", "A cost of \\$5 and a factor $2\\pi$."]) assert.equal(issues(valid).length, 0, `${valid}: ${issues(valid)}`);
console.log("[PASS] malformed delimiters and code-displayed equations are rejected while native equations pass");

const section = { id: "s1", startPage: 1, endPage: 1, objectives: ["Interpret dot product"], keyPoints: ["The product is a scalar"], synthesis: "The dot product combines magnitudes and angle into a scalar.", objectiveChecks: [{ objective: "Interpret dot product", checks: ["conceptual"] }], transcript: [] };
const book = { source: { fingerprint: { sha256: "a".repeat(64) } } };
const input = { id: "dot-product", title: "Dot product", markdown: broken, objectives: section.objectives, keyPoints: section.keyPoints, sourcePages: [1] };
saveLesson(section, book, input); commitLesson(section, book);
assert.equal(section.transcript[0].markdown, expected);
const first = structuredClone(section.transcript);
saveLesson(section, book, input);
assert.deepEqual(section.transcript, first);
section.transcript = readTranscript(transcriptBlock(section.transcript));
assert.equal(section.transcript[0].lesson.contentHash, lessonHash(expected));
assert.equal(lessonReady(section), true);
const beforeFailure = structuredClone(section);
assert.throws(() => saveLesson(section, book, { ...input, id: "broken", markdown: "$\\theta" }), /inline mathematics/);
assert.deepEqual(section, beforeFailure);
console.log("[PASS] saving normalizes before hashing, retries do not duplicate, reload preserves readiness, and rejection leaves state untouched");
