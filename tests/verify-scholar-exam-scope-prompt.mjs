import { extensionPath as packagedExtensionPath, piPackageRoot as sdkRoot, jitiPath as sdkJitiPath, resolvePiDependency } from "./sdk.mjs";
// Invalid scopes provide book-specific guidance without opening a dialog.
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const piPackageRoot = sdkRoot;
const jitiPath = sdkJitiPath;
const { createJiti } = await import(pathToFileURL(jitiPath).href);
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: { "@earendil-works/pi-coding-agent": join(piPackageRoot, "dist", "index.js") },
});

const EXT = dirname(process.env.PI_SCHOLAR_EXTENSION || packagedExtensionPath);
const { examScopeGuidance, resolveExamScope, defaultExamScope } = await jiti.import(join(EXT, "commands.ts"));

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? ` - ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

// ---------------------------------------------------------------- fixtures --
const section = (id, number, title, startPage, endPage) => ({
  id, number, title, order: 1, startPage, endPage, status: "not-started",
  objectives: [], coveredObjectives: [], requiredChecks: ["conceptual"],
  keyPoints: [], misconceptions: [], attempts: [], transcript: [],
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
});
const chapter = (id, number, title, sections) => ({
  id, number, title, order: Number(number), startPage: sections[0].startPage,
  endPage: sections.at(-1).endPage, status: "not-started", sections,
});
const book = {
  metadata: { title: "Signal and Power Integrity", authors: ["Bogatin"] },
  chapters: [
    chapter("chapter-001", "1", "Signal Integrity", [section("chapter-001-section-001", "1.1", "What Is SI", 31, 33)]),
    chapter("chapter-002", "2", "Time and Frequency", [section("chapter-002-section-001", "2.1", "Time Domain", 73, 78)]),
    chapter("chapter-003", "3", "Impedance", [section("chapter-003-section-001", "3.1", "Impedance", 111, 118)]),
    chapter("chapter-004", "4", "Resistance", [section("chapter-004-section-001", "4.1", "Resistance", 157, 163)]),
  ],
};

/** The input function fails if any loading path opens a dialog. */
function fakeCtx() {
  const prompts = [], notices = [];
  return {
    prompts, notices,
    ui: {
      input: async (title) => { prompts.push(title); throw new Error("loading must not prompt"); },
      notify: (message, level) => { notices.push({ message, level }); },
    },
  };
}
/** A host with no input dialog, to check the non-interactive path. */
function silentCtx() {
  const notices = [];
  return { notices, ui: { notify: (message, level) => notices.push({ message, level }) } };
}

// --------------------------------------------------------------- guidance --
const guidance = examScopeGuidance(book);
check("guidance names accepted formats", /Accepted formats:/.test(guidance), JSON.stringify(guidance.split("\n")[0]));
check("guidance uses this book's real chapter range", /1-3/.test(guidance) && /chapters 1-4/.test(guidance),
  guidance.split("\n").at(-1));
check("guidance shows a real subsection example", /1\.1/.test(guidance), "1.1 offered");
check("guidance offers the whole book", /\ball\b/.test(guidance), "all listed");

// ------------------------------------------------------------ happy paths --
for (const [name, input, expected] of [
  ["a range", "1-3", 3], ["a list", "1, 3", 2], ["one chapter", "chapter 2", 1],
  ["a subsection", "1.1", 1], ["the whole book", "all", 4],
]) {
  const ctx = fakeCtx();
  const scope = await resolveExamScope(book, input, ctx);
  check(`command-line scope accepted: ${name} (${JSON.stringify(input)})`,
    scope?.sectionIds.length === expected,
    `${scope?.sectionIds.length ?? "rejected"} section(s), expected ${expected}`);
  check(`  ...without prompting`, ctx.prompts.length === 0, `${ctx.prompts.length} prompt(s)`);
}

// ------------------------------------------------ invalid explicit scope --
for (const input of ["quantum tunnelling", "also nonsense", "bad one", "not a chapter", ""]) {
  const ctx = fakeCtx();
  const scope = await resolveExamScope(book, input, ctx);
  check(`invalid scope ${JSON.stringify(input)} gives one notice and no dialog`,
    scope === undefined && ctx.prompts.length === 0 && ctx.notices.length === 1,
    `${ctx.prompts.length} prompt(s), ${ctx.notices.length} notice(s)`);
  check("  ...with the failure reason and accepted formats",
    /Accepted formats:/.test(ctx.notices[0]?.message || "") && /No exam was created|No exam scope was given/.test(ctx.notices[0]?.message || ""),
    ctx.notices[0]?.message.split("\n")[0]);
}

// ------------------------------------------------------- non-interactive ---
{
  const ctx = silentCtx();
  const scope = await resolveExamScope(book, "not a chapter", ctx);
  check("without an input dialog it explains instead of looping", scope === undefined && ctx.notices.length === 1,
    ctx.notices[0]?.level);
  check("  ...and that message carries the guidance",
    /Accepted formats:/.test(ctx.notices[0]?.message || ""), "guidance included");
}

book.currentSectionId = "chapter-003-section-001";
check("bare Exam selects the current section's chapter", defaultExamScope(book)?.description === "chapter 3"
  && defaultExamScope(book)?.sectionIds.join() === "chapter-003-section-001", defaultExamScope(book)?.description);
delete book.currentSectionId;
check("without a current section, bare Exam selects the first chapter", defaultExamScope(book)?.description === "chapter 1");

console.log(`\nScholar exam-scope-prompt summary: ${pass} passed, ${fail} failed.`);
process.exitCode = fail ? 1 : 0;
