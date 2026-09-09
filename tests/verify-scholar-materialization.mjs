import { extensionPath as packagedExtensionPath, piPackageRoot as sdkRoot, jitiPath as sdkJitiPath, resolvePiDependency } from "./sdk.mjs";
// Scholar materialization-contract gate.
//
// An unstarted section has no note on disk, so no projection may link to one.
// Three projections must agree on that: the disk writer (obsidian.ts), the
// chapter checklist (render/navigation.ts) and exam/tutor scope lines
// (render/assessment.ts). They once disagreed — an exam's frozen scope
// materialized every section it covered, sprouting phantom graph nodes — so
// this asserts the shared predicate holds across all three.
//
// Uses synthetic in-memory books; never reads a configured vault or skips for
// lack of user progress.
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const piPackageRoot = sdkRoot;
const jitiPath = sdkJitiPath;
const { createJiti } = await import(pathToFileURL(jitiPath).href);
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: { "@earendil-works/pi-coding-agent": join(piPackageRoot, "dist", "index.js") },
});

const EXT = dirname(process.env.PI_SCHOLAR_EXTENSION || packagedExtensionPath);
const mod = (rel) => jiti.import(join(EXT, rel));

const { isSectionMaterialized } = await mod("render/common.ts");
const { renderChapter } = await mod("render/navigation.ts");
const { renderExam, renderTutorSession, scopeLines } = await mod("render/assessment.ts");

const now = "2026-09-09T12:00:00.000Z";
const fixtureRoot = join(tmpdir(), "scholar-materialization-in-memory");
const config = { schemaVersion: 3, libraryRoot: join(fixtureRoot, "library"), obsidianRoot: join(fixtureRoot, "vault"), stateRoot: "", updatedAt: now };
const section = (id, number, status) => ({ id, number, order: Number(number.split(".")[1]), title: `Section ${number}`, startPage: 1, endPage: 2,
  status, objectives: [], coveredObjectives: [], requiredChecks: [], keyPoints: [], misconceptions: [], attempts: [], transcript: [], createdAt: now, updatedAt: now });
const books = [{ schemaVersion: 3, revision: 1, id: "a".repeat(64), instanceId: "materialization-fixture", noteDirectory: "Books/Materialization",
  source: { absolutePath: join(config.libraryRoot, "fixture.pdf"), relativePath: "fixture.pdf", fileName: "fixture.pdf", format: "pdf", fingerprint: { sha256: "a".repeat(64), size: 1, mtimeMs: 1 } },
  metadata: { title: "Synthetic materialization book", authors: [], pageCount: 4 }, outlineStatus: "ready", currentSectionId: "s3", createdAt: now, updatedAt: now,
  chapters: [
    { id: "c1", number: "1", order: 1, title: "Unstarted chapter", startPage: 1, endPage: 2, status: "not-started", sections: [section("s1", "1.1", "not-started"), section("s2", "1.2", "not-started")] },
    { id: "c2", number: "2", order: 2, title: "Started chapter", startPage: 3, endPage: 4, status: "learning", sections: [section("s3", "2.1", "not-started"), section("s4", "2.2", "complete")] },
  ],
  exams: [{ id: "exam-1", title: "Unstarted scope", status: "building", scope: { chapterIds: ["c1"], sectionIds: ["s1", "s2"], description: "chapter 1" }, questions: [], itemResults: [], transcript: [], createdAt: now, updatedAt: now }], tutorSessions: [] }];

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? ` - ${detail}` : ""}`);
  ok ? pass++ : fail++;
};
const sectionLinks = (markdown) => (markdown.match(/\[\[[^\]]*Sections\//g) || []).length;

// ------------------------------------------------------------- the contract --
for (const book of books) {
  const label = book.metadata?.title || "book";
  const sections = book.chapters.flatMap((chapter) => chapter.sections);
  if (sections.length === 0) { console.log(`[SKIP] ${label} has no outline yet.`); continue; }

  // 1. The predicate. Only a started section, or the current one, materializes.
  const leaked = sections.filter((s) => s.status === "not-started" && s.id !== book.currentSectionId && isSectionMaterialized(book, s));
  check(`${label}: unstarted sections never materialize`, leaked.length === 0,
    leaked.length ? `leaked ${leaked.map((s) => s.number).join(", ")}` : `${sections.length} section(s) checked`);

  const started = sections.filter((s) => s.status !== "not-started" || s.id === book.currentSectionId);
  check(`${label}: started sections do materialize`, started.every((s) => isSectionMaterialized(book, s)),
    started.length ? `${started.length} started` : "none started yet");

  // 2. Chapter checklists never wikilink an unstarted section.
  const linkedChapters = book.chapters.filter((chapter) => {
    const unstartedOnly = chapter.sections.every((s) => s.status === "not-started" && s.id !== book.currentSectionId);
    return unstartedOnly && sectionLinks(renderChapter(config, book, chapter)) > 0;
  });
  check(`${label}: chapter checklists keep unstarted sections plain`, linkedChapters.length === 0,
    linkedChapters.length ? `linked in ${linkedChapters.map((c) => c.number).join(", ")}` : `${book.chapters.length} chapter(s)`);

  // 3. Exam notes — the original trigger for the phantom nodes.
  for (const exam of book.exams || []) {
    const unstarted = exam.scope.sectionIds.filter((id) => {
      const section = sections.find((s) => s.id === id);
      return section && section.status === "not-started" && section.id !== book.currentSectionId;
    });
    check(`${label}: exam "${exam.title}" emits no unstarted section links`,
      sectionLinks(renderExam(config, book, exam)) === 0,
      `${exam.scope.sectionIds.length} scoped, ${unstarted.length} unstarted`);
  }

  // 4. Tutor scope — the latent second path, which renders sections by default.
  const probeChapter = book.chapters.find((chapter) =>
    chapter.sections.some((s) => s.status === "not-started" && s.id !== book.currentSectionId));
  if (probeChapter) {
    const probe = {
      id: "tutor-materialization-probe", title: "Materialization probe", status: "active",
      scope: { chapterIds: [probeChapter.id], sectionIds: probeChapter.sections.map((s) => s.id), description: `chapter ${probeChapter.number}` },
      keyPoints: [], attempts: [], transcript: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    check(`${label}: tutor scope lines emit no unstarted section links`,
      sectionLinks(scopeLines(config, book, "probe.md", probe.scope).join("\n")) === 0,
      `chapter ${probeChapter.number}, ${probe.scope.sectionIds.length} section(s)`);
    check(`${label}: full tutor note emits no unstarted section links`,
      sectionLinks(renderTutorSession(config, book, probe)) === 0, "rendered probe session");
  }

  // 5. A materialized section must still be linkable, or scope lines are useless.
  const materialized = sections.find((s) => isSectionMaterialized(book, s));
  if (materialized) {
    const scope = scopeLines(config, book, "probe.md", { chapterIds: [], sectionIds: [materialized.id], description: "" }).join("\n");
    check(`${label}: a materialized section is still linked from scope`, sectionLinks(scope) > 0,
      `${materialized.number} status=${materialized.status}`);
  }
}

console.log(`\nMaterialization contract: ${pass} passed, ${fail} failed.`);
process.exitCode = fail ? 1 : 0;
