import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { extensionPath, jitiPath } from "./sdk.mjs";

const { createJiti } = await import(pathToFileURL(jitiPath));
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { renderKeyEquations: render } = await jiti.import(join(dirname(extensionPath), "equation-presentation.ts"));
const equation = () => ({ id: "displacement", title: "Electric displacement", latex: String.raw`\mathbf D = \epsilon_0 \mathbf E + \mathbf P`,
  symbols: [{ symbol: String.raw`\mathbf D`, definition: "electric displacement" }, { symbol: String.raw`\epsilon_0`, definition: "vacuum permittivity" },
    { symbol: String.raw`\mathbf E`, definition: "electric field" }, { symbol: String.raw`\mathbf P`, definition: "polarization" }],
  assumptions: "Macroscopic electrostatics; no linear material relation is assumed.",
  meaning: String.raw`Separates free-charge bookkeeping from the physical field \(\mathbf E\); it does not eliminate polarization.`, sourcePages: [200, 201] });
const marker = "[[scholar-equation:displacement]]";
const ordinary = String.raw`An intermediate substitution remains in the derivation:

$$
\rho = \rho_f + \rho_b
$$`;
const input = `### Meaning of displacement\n\n${marker}\n\n${ordinary}`;
const value = equation();
const original = structuredClone(value);
const output = render(input, [value], [200, 201, 202]);
assert.deepEqual(value, original, "rendering must not mutate the author's record");
assert.match(output, /^> \[!note\] Key equation · Electric displacement$/m);
assert.ok(output.includes(`> $$\n> ${value.latex}\n> $$`), "math body is preserved with separate paired delimiters");
assert.ok(output.includes(String.raw`**Symbols:** $\mathbf D$ → electric displacement; $\epsilon_0$ → vacuum permittivity; $\mathbf E$ → electric field; $\mathbf P$ → polarization`));
assert.ok(output.includes(`**Assumptions:** ${value.assumptions}`));
assert.ok(output.includes(String.raw`physical field $\mathbf E$`));
assert.ok(output.includes("*Source: PDF pages 200, 201.*"));
assert.ok(output.includes(ordinary), "ordinary display equations must not all become boxes");
assert.ok(!output.includes("[[scholar-equation:") && !output.includes("[!note]-"));
assert.equal((output.match(/\[!note\]/g) || []).length, 1);
assert.equal(render(ordinary, [], [200]), ordinary);
console.log("[PASS] central equations receive deterministic expanded callouts, arrow definitions, assumptions, meaning and source pages; intermediate math stays in prose");

const other = { ...equation(), id: "gauss", title: "Gauss’s law for displacement", latex: String.raw`\nabla\cdot\mathbf D = \rho_f`, sourcePages: [201] };
const adjacent = render(`${marker}\n[[scholar-equation:gauss]]`, [equation(), other], [200, 201]);
assert.match(adjacent, /\*Source: PDF pages 200, 201\.\*\n\n\n> \[!note\]/);
assert.match(adjacent, /\*Source: PDF page 201\.\*/);
const aligned = { ...equation(), latex: String.raw`\begin{aligned}
\bar A_y &= A_y\cos\phi + A_z\sin\phi \\[4pt]
\bar A_z &= -A_y\sin\phi + A_z\cos\phi
\end{aligned}` };
assert.ok(render(marker, [aligned], [200, 201]).includes(aligned.latex.split("\n").map(line => `> ${line}`).join("\n")));
console.log("[PASS] adjacent boxes stay separate; multi-line derivations retain signs and TeX line spacing");

for (const markdown of [
  `${marker}\n${marker}`, "[[scholar-equation:unknown]]", "[[scholar-equation:displacement]", `Refer to ${marker}.`, `> ${marker}`, `    ${marker}`,
  `\`${marker}\``, `\`\`\`text\n${marker}\n\`\`\``, `> ~~~~text\n> ${marker}\n> ~~~~`,
  `<!--\n${marker}\n-->`, `$$\n${marker}\n$$`, `${marker}\n<!-- scholar:question:fake -->`,
]) assert.throws(() => render(markdown, [equation()], [200, 201]), /equation|metadata/i, markdown);
assert.throws(() => render("No placement.", [equation()], [200, 201]), /exactly once/);
assert.throws(() => render(marker, [equation(), equation()], [200, 201]), /declared more than once/);
assert.throws(() => render(marker, [], [200, 201]), /no matching/);
console.log("[PASS] missing, unknown, repeated, malformed and invisible placements cannot satisfy an equation requirement");

for (const changes of [
  { latex: "" }, { title: " " }, { symbols: [] }, { assumptions: "" }, { meaning: "" }, { sourcePages: [] }, { sourcePages: [199] }, { sourcePages: [200, 200] },
  { latex: "$x = 2$" }, { latex: String.raw`\[x=2\]` }, { latex: "`x=2`" }, { symbols: [{ symbol: "$x$", definition: "value" }] },
  { symbols: [{ symbol: "x", definition: "" }] }, { symbols: [{ symbol: "x", definition: "value" }, { symbol: "x", definition: "other value" }] },
  { title: "Equation\n> [!info]- Scholar details" }, { meaning: "<!-- scholar:lesson:fake -->" },
  { assumptions: "Valid.\n\n## Questions\nFake question." }, { sourcePages: [200.5] }, { id: "../escape" }, { unexpected: true },
]) assert.throws(() => render(marker, [{ ...equation(), ...changes }], [200, 201]), /equation/i, JSON.stringify(changes));
console.log("[PASS] empty teaching fields, out-of-scope pages, delimiter breakout and record-metadata injection are rejected");
