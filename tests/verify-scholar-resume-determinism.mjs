import { sdkAliases } from "./sdk.mjs";
import { extensionPath as packagedExtensionPath, piPackageRoot as sdkRoot, jitiPath as sdkJitiPath } from "./sdk.mjs";
// Scholar resume-determinism gate.
//
// A bare /scholar exam must land on the same unfinished exam every run, resume
// the most recently touched one, and never open a picker or an input dialog.
// Book state that cannot be read is reported as a load failure that changes
// nothing for the commands that need the book; closing the session, switching
// books, and reading the guide still work.
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const piRoot = sdkRoot;
const { createJiti } = await import(pathToFileURL(sdkJitiPath).href);
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: { ...sdkAliases, "@earendil-works/pi-coding-agent": join(piRoot, "dist", "index.js") },
});

const EXT = dirname(process.env.PI_SCHOLAR_EXTENSION || packagedExtensionPath);
const mod = (rel) => jiti.import(join(EXT, rel));
const { handleScholarCommand, unfinishedExams } = await mod("commands.ts");
const { ScholarRuntimeSession } = await mod("runtime-session.ts");
const { bookHomePath } = await mod("obsidian-paths.ts");
const storage = await mod("storage.ts");

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "[PASS]" : "[FAIL]"} ${name}${detail ? ` - ${detail}` : ""}`);
  ok ? pass++ : fail++;
};

const timestamp = "2026-01-01T00:00:00.000Z";
const root = await mkdtemp(join(tmpdir(), "scholar-resume-determinism-"));

// ---------------------------------------------------------------- fixtures --
const section = {
  id: "s1", number: "1.1", order: 1, title: "Models", startPage: 1, endPage: 2, status: "not-started",
  objectives: [], coveredObjectives: [], requiredChecks: ["conceptual"], keyPoints: [], misconceptions: [], attempts: [], transcript: [],
  createdAt: timestamp, updatedAt: timestamp,
};

/** One exam as it lives in book state. Drafts keep Obsidian presentation out of this gate. */
function candidate(id, title, times = {}) {
  return {
    id, title, scope: { chapterIds: ["c1"], sectionIds: ["s1"], description: "Chapter 1" },
    status: times.status || "draft", questions: [], rawResponses: [], itemResults: [], breakdown: [],
    earnedPoints: 0, maxPoints: 0, percent: 0, transcript: [],
    createdAt: times.createdAt || timestamp, updatedAt: times.updatedAt ?? times.createdAt ?? timestamp,
  };
}

function fixture(config, exams) {
  const id = createHash("sha256").update("resume-determinism-fixture").digest("hex");
  return {
    schemaVersion: 3, revision: 0, id, instanceId: "resume-determinism-fixture",
    source: {
      absolutePath: join(config.libraryRoot, "fixture.pdf"), relativePath: "fixture.pdf", fileName: "fixture.pdf", format: "pdf",
      fingerprint: { sha256: id, size: 1, mtimeMs: 0 },
    },
    metadata: { title: "Resume Determinism Fixture", authors: [], pageCount: 2 },
    outlineStatus: "ready", noteDirectory: "Resume Determinism Fixture",
    chapters: [{ id: "c1", number: "1", order: 1, title: "Models", startPage: 1, endPage: 2, status: "not-started", sections: [section] }],
    exams, tutorSessions: [], createdAt: timestamp, updatedAt: timestamp,
  };
}

let sequence = 0;
async function harness(label, exams, allowCreation = false) {
  const folder = join(root, `${++sequence}-${label}`);
  const config = { schemaVersion: 3, libraryRoot: join(folder, "library"), obsidianRoot: join(folder, "vault"), stateRoot: join(folder, "bootstrap"), updatedAt: timestamp };
  await Promise.all([mkdir(config.libraryRoot, { recursive: true }), mkdir(config.obsidianRoot, { recursive: true })]);
  const book = fixture(config, exams);
  config.currentBookId = book.id;
  await storage.createBookState(config, book);
  await storage.updateCatalog(config, (catalog) => { catalog.currentBookId = book.id; });

  const notices = [], inputs = [], selects = [], mutations = [], activations = [], turns = [];
  const calls = { deactivations: 0, persists: 0, renders: 0, submits: 0, presents: 0 };
  const session = new ScholarRuntimeSession();
  const coordinator = {
    getConfig: () => config,
    loadFreshConfig: async () => config,
    runtimeSession: session,
    hasConfiguredLibrary: () => true,
    hasConfiguredObsidian: () => true,
    librarySetupMessage: "Set the library", obsidianSetupMessage: "Set the vault",
    ownsActiveAuthority: () => true,
    deactivateSession: () => { calls.deactivations += 1; session.deactivate(); },
    persistSessionPointer: () => { calls.persists += 1; },
    setStatus: async () => {},
    beginNavigation: () => () => {},
    getSetupRun: () => undefined,
    getScholarTurnRun: () => undefined,
    getNavigationRun: () => undefined,
    renderAll: async () => { calls.renders += 1; },
    mutateBook: async (_id, update) => {
      if (!allowCreation) { mutations.push(true); throw new Error("no exam may be created by this command"); }
      const state = structuredClone(book);
      const result = await update(state);
      mutations.push(state);
      return { book: state, result };
    },
    activateBook: async (activated, _ctx, mode, recordId) => { activations.push({ bookId: activated.id, mode, recordId }); },
    startScholarModeTurn: async (_activated, mode, target) => { turns.push({ mode, id: target.id }); },
    toolController: {
      presentExam: async () => { calls.presents += 1; throw new Error("presentExam must not run for a draft resume"); },
      submitExam: async () => { calls.submits += 1; throw new Error("submitExam must not run in this gate"); },
      resetTransientState: () => {},
    },
  };
  const ctx = {
    hasUI: true, isIdle: () => true, cwd: folder,
    sessionManager: { getBranch: () => [], getEntries: () => [], getSessionId: () => label, getSessionFile: () => join(folder, "session.jsonl") },
    ui: {
      notify: (message, level) => { notices.push({ message, level }); },
      setStatus() {}, setWorkingMessage() {},
      input: async () => { inputs.push(true); throw new Error("no input dialog may open"); },
      select: async () => { selects.push(true); throw new Error("no select picker may open"); },
      confirm: async () => false,
      editor: async () => { throw new Error("no editor may open"); },
    },
  };
  const lastNotice = () => notices.at(-1)?.message || "";
  const storedExamIds = async () => (await storage.loadBookState(config, book.id))?.exams.map((exam) => exam.id).join(", ") || "none";
  return { config, book, coordinator, ctx, session, calls, notices, inputs, selects, mutations, activations, turns, lastNotice, storedExamIds };
}

/** A second copy of the book hub is a real load failure: duplicate authority. */
async function duplicateAuthority(h) {
  const home = bookHomePath(h.config, h.book);
  await copyFile(home, join(dirname(home), "duplicate-authority.md"));
}

try {
  // ------------------------------------------------- 1. deterministic order --
  const graded = candidate("exam-009", "Exam 09 — graded", { status: "graded", updatedAt: "2026-06-01T00:00:00.000Z" });
  const older = candidate("exam-001", "Exam 01 — chapter 1", { createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-05T00:00:00.000Z" });
  const middle = candidate("exam-002", "Exam 02 — chapter 2", { createdAt: "2026-01-03T00:00:00.000Z", updatedAt: "2026-01-06T00:00:00.000Z" });
  const newest = candidate("exam-003", "Exam 03 — chapter 3", { createdAt: "2026-01-04T00:00:00.000Z", updatedAt: "2026-01-07T00:00:00.000Z" });

  check("no unfinished exam means no candidates",
    unfinishedExams({ exams: [graded] }).length === 0, "graded exams are excluded");
  check("a single unfinished exam is the only candidate",
    unfinishedExams({ exams: [graded, older] }).map((exam) => exam.id).join(", ") === "exam-001", "one candidate");
  check("candidates order by activity, newest first",
    unfinishedExams({ exams: [graded, older, newest, middle] }).map((exam) => exam.id).join(", ") === "exam-003, exam-002, exam-001",
    unfinishedExams({ exams: [graded, older, newest, middle] }).map((exam) => exam.id).join(", "));
  check("input order never changes the order",
    unfinishedExams({ exams: [newest, older, graded, middle] }).map((exam) => exam.id).join(", ")
      === unfinishedExams({ exams: [middle, graded, newest, older] }).map((exam) => exam.id).join(", "),
    "two different array orders agree");

  const tied = ["exam-001", "exam-002", "exam-003"].map((id) => candidate(id, `Exam ${id}`, { createdAt: timestamp, updatedAt: timestamp }));
  const tiedOrder = () => unfinishedExams({ exams: [...tied] }).map((exam) => exam.id).join(", ");
  check("identical timestamps fall back to the ID, newest first",
    tiedOrder() === "exam-003, exam-002, exam-001", tiedOrder());
  check("the same state always produces the same order",
    [0, 1, 2, 3, 4].every(() => unfinishedExams({ exams: [...tied].reverse() }).map((exam) => exam.id).join(", ") === tiedOrder()),
    tiedOrder());
  const legacy = candidate("exam-004", "Exam 04 — legacy timestamps", { createdAt: "2026-02-01T00:00:00.000Z" });
  delete legacy.updatedAt;
  check("a missing updatedAt falls back to createdAt",
    unfinishedExams({ exams: [older, legacy] }).map((exam) => exam.id).join(", ") === "exam-004, exam-001",
    unfinishedExams({ exams: [older, legacy] }).map((exam) => exam.id).join(", "));

  // ------------------------------------------- 2. bare command resumes one ---
  {
    const h = await harness("bare-multiple", [older, newest, middle]);
    await handleScholarCommand("exam", h.ctx, h.coordinator);
    check("without a scope the most recently touched exam resumes",
      h.activations.at(-1)?.recordId === "exam-003" && h.activations.at(-1)?.mode === "exam",
      h.activations.at(-1)?.recordId || "nothing activated");
    check("the resume notice names the exam it resumed",
      /Resuming Exam 03 — chapter 3 \[exam-003\]/.test(h.lastNotice()), h.lastNotice().split("\n")[0]);
    check("the notice lists the other unfinished exams by ID and title",
      h.lastNotice().includes("Exam 02 — chapter 2 [exam-002]") && h.lastNotice().includes("Exam 01 — chapter 1 [exam-001]"),
      h.lastNotice().split("\n")[1]);
    check("the resumed exam is the one the mode turn opens",
      h.turns.at(-1)?.id === "exam-003" && h.turns.at(-1)?.mode === "exam", h.turns.at(-1)?.id || "no turn");
  }
  {
    const h = await harness("bare-single", [older]);
    await handleScholarCommand("exam", h.ctx, h.coordinator);
    check("a single unfinished exam resumes without being offered a choice",
      h.activations.at(-1)?.recordId === "exam-001" && /Resuming Exam 01/.test(h.lastNotice()), h.lastNotice().split("\n")[0]);
    check("a single candidate is not listed as an alternative",
      !/Other unfinished exams/.test(h.lastNotice()), "no alternatives line");
  }

  // ----------------------------------------- 3. no picker, no prompt, ever ----
  {
    const h = await harness("no-prompt", [older, newest]);
    await handleScholarCommand("exam", h.ctx, h.coordinator);
    check("a bare exam with an unfinished exam never opens a picker", h.selects.length === 0, `${h.selects.length} select(s)`);
    check("  ...and never opens an input dialog", h.inputs.length === 0, `${h.inputs.length} input(s)`);
    check("  ...and creates nothing", h.mutations.length === 0 && h.notices.every((item) => !/could not continue/.test(item.message)),
      `${h.mutations.length} mutation(s)`);
  }
  {
    const h = await harness("same-state", tied);
    for (let run = 0; run < 3; run += 1) await handleScholarCommand("exam", h.ctx, h.coordinator);
    const chosen = h.activations.map((item) => item.recordId);
    check("identical timestamps resume the same exam on every run",
      chosen.join(", ") === "exam-003, exam-003, exam-003", chosen.join(", "));
    check("  ...and the same state produces the same notice",
      new Set(h.notices.map((item) => item.message)).size === 1, `${new Set(h.notices.map((item) => item.message)).size} distinct notice(s)`);
  }

  // ----------------------------------------------- 4. nothing to resume ------
  {
    const h = await harness("nothing-to-resume", [], true);
    await handleScholarCommand("exam", h.ctx, h.coordinator);
    check("no unfinished exam starts a default chapter exam without prompting",
      h.mutations.length === 1 && h.selects.length === 0 && h.inputs.length === 0,
      `${h.mutations.length} mutation(s), ${h.selects.length} select(s), ${h.inputs.length} input(s)`);
    check("  ...naming the chapter it selected",
      h.notices.some(item => /Bare Exam selected chapter 1/.test(item.message)), h.notices.map(item => item.message).join(" | "));
    check("  ...and activating the new frozen target",
      h.mutations[0]?.exams?.[0]?.scope.description === "chapter 1"
      && h.activations.at(-1)?.recordId === "exam-001" && h.turns.at(-1)?.id === "exam-001",
      h.activations.at(-1)?.recordId || "nothing activated");
  }
  {
    const h = await harness("bare-learn", [], true);
    await handleScholarCommand("learn", h.ctx, h.coordinator);
    check("bare Learn selects and starts its section without a prompt",
      h.inputs.length === 0 && h.selects.length === 0 && h.turns.at(-1)?.mode === "learn" && h.turns.at(-1)?.id === "s1",
      `${h.inputs.length} input(s), ${h.selects.length} select(s), ${h.turns.at(-1)?.id || "no turn"}`);
    check("  ...and tells the learner which section was selected",
      h.notices.some(item => /Bare Learn selected.*1\.1/.test(item.message)), h.notices.map(item => item.message).join(" | "));
  }
  {
    const h = await harness("bare-tutor", [], true);
    await handleScholarCommand("tutor", h.ctx, h.coordinator);
    check("bare Tutor creates a scoped session without a prompt",
      h.inputs.length === 0 && h.selects.length === 0 && h.mutations[0]?.tutorSessions?.[0]?.scope?.sectionIds?.[0] === "s1"
        && h.turns.at(-1)?.mode === "tutor",
      `${h.inputs.length} input(s), ${h.selects.length} select(s), ${h.turns.at(-1)?.id || "no turn"}`);
    check("  ...and tells the learner which section was selected",
      h.notices.some(item => /Bare Tutor selected.*1\.1/.test(item.message)), h.notices.map(item => item.message).join(" | "));
  }

  // ------------------------------------------------- 5. load failures --------
  {
    const h = await harness("dispatch-load-failure", [older]);
    await duplicateAuthority(h);
    await handleScholarCommand("exam", h.ctx, h.coordinator);
    check("an unreadable book state is reported as a load failure",
      /^Scholar could not load the selected book: /.test(h.lastNotice()), h.lastNotice());
    check("  ...never as a missing selection", !/no selected book/i.test(h.lastNotice()), "no book-selection advice");
    check("  ...and no exam work starts",
      h.mutations.length === 0 && h.activations.length === 0 && h.turns.length === 0, `${h.activations.length} activation(s)`);
    check("  ...while the selected book pointer stays put",
      h.config.currentBookId === h.book.id && (await storage.loadCatalog(h.config)).currentBookId === h.book.id,
      String((await storage.loadCatalog(h.config)).currentBookId));
    check("  ...and the inactive session stays inactive",
      h.calls.deactivations === 0 && h.calls.persists === 0 && !h.session.active, `${h.calls.deactivations} deactivation(s)`);
  }
  {
    const h = await harness("guard-load-failure", [older]);
    h.session.activate(h.book.id);
    await duplicateAuthority(h);
    await handleScholarCommand("exam", h.ctx, h.coordinator);
    check("an unreadable active book is reported as a load failure",
      /^Scholar could not load the active book: /.test(h.lastNotice()), h.lastNotice());
    check("  ...and the session is not deactivated or rewritten",
      h.calls.deactivations === 0 && h.calls.persists === 0 && h.session.active && h.session.bookId === h.book.id,
      `${h.calls.deactivations} deactivation(s), ${h.calls.persists} pointer write(s)`);
    check("  ...and nothing else runs",
      h.mutations.length === 0 && h.activations.length === 0 && h.selects.length === 0
        && h.notices.length === 1 && h.notices[0].level === "warning", "no exam work, one failure notice");
  }

  // The guard is scoped to the commands that need the book: a broken active
  // book must not lock the learner out of closing, switching, or the guide.
  {
    const h = await harness("guard-scoped-help", [older]);
    h.session.activate(h.book.id);
    await duplicateAuthority(h);
    await handleScholarCommand("help", h.ctx, h.coordinator);
    check("help still reaches the guide when the active book cannot be read",
      /Scholar Tools & Workflows:/.test(h.lastNotice())
        && h.lastNotice().includes("Selected book: state could not be read."),
      h.lastNotice().split("\n")[0]);
    check("  ...after reporting the unreadable book once",
      h.notices.length === 2 && h.notices[0].level === "warning"
        && /^Scholar could not load the selected book: /.test(h.notices[0].message),
      h.notices[0]?.message || "no warning");
    check("  ...and leaving the active session untouched",
      h.calls.deactivations === 0 && h.calls.persists === 0 && h.session.active && h.session.bookId === h.book.id,
      `${h.calls.deactivations} deactivation(s), ${h.calls.persists} pointer write(s)`);
  }
  {
    const h = await harness("guard-scoped-close", [older]);
    h.session.activate(h.book.id);
    await duplicateAuthority(h);
    await handleScholarCommand("close", h.ctx, h.coordinator);
    check("close still runs when the active book cannot be read",
      h.lastNotice() === "Scholar mode is closed in this Pi session. Progress was kept."
        && !h.notices.some((item) => /could not load/.test(item.message)),
      h.lastNotice());
    check("  ...and close itself, not the guard, ends the session",
      h.calls.deactivations === 1 && h.calls.persists === 1 && !h.session.active,
      `${h.calls.deactivations} deactivation(s), ${h.calls.persists} pointer write(s)`);
  }
  {
    const h = await harness("guard-scoped-obsidian", [older]);
    h.session.activate(h.book.id);
    await duplicateAuthority(h);
    await handleScholarCommand("obsidian", h.ctx, h.coordinator);
    check("bare obsidian still reports the vault when the active book cannot be read",
      /^Scholar Obsidian vault: /.test(h.lastNotice()) && !h.notices.some((item) => /could not load/.test(item.message)),
      h.lastNotice());
    check("  ...without deactivating the session or rewriting its pointer",
      h.calls.deactivations === 0 && h.calls.persists === 0 && h.session.active && h.session.bookId === h.book.id,
      `${h.calls.deactivations} deactivation(s), ${h.calls.persists} pointer write(s)`);
  }
  {
    const h = await harness("guard-scoped-library", [older]);
    h.session.activate(h.book.id);
    await duplicateAuthority(h);
    await handleScholarCommand("library", h.ctx, h.coordinator);
    check("bare library still reports the folder when the active book cannot be read",
      /^Scholar library: /.test(h.lastNotice()) && !h.notices.some((item) => /could not load/.test(item.message)),
      h.lastNotice());
    check("  ...without deactivating the session or rewriting its pointer",
      h.calls.deactivations === 0 && h.calls.persists === 0 && h.session.active && h.session.bookId === h.book.id,
      `${h.calls.deactivations} deactivation(s), ${h.calls.persists} pointer write(s)`);
  }
  {
    const h = await harness("guard-scoped-open", [older]);
    let chooser = 0;
    h.coordinator.chooseCandidate = async () => { chooser += 1; return undefined; };
    h.session.activate(h.book.id);
    await duplicateAuthority(h);
    await handleScholarCommand("open", h.ctx, h.coordinator);
    check("open still reaches book selection when the active book cannot be read",
      chooser === 1 && h.notices.length === 0, `${chooser} chooser call(s), ${h.notices.length} notice(s)`);
    check("  ...without touching the active session",
      h.calls.deactivations === 0 && h.calls.persists === 0 && h.session.active && h.session.bookId === h.book.id,
      `${h.calls.deactivations} deactivation(s), ${h.calls.persists} pointer write(s)`);
  }
  {
    const h = await harness("help-load-failure", [older]);
    await duplicateAuthority(h);
    await handleScholarCommand("help", h.ctx, h.coordinator);
    check("help with an unreadable selected book still shows the guide",
      /Scholar Tools & Workflows:/.test(h.lastNotice()), h.lastNotice().split("\n")[0]);
    check("  ...naming the unreadable book instead of a missing selection",
      /^Scholar could not load the selected book: /.test(h.notices[0]?.message || "")
        && !/No book currently selected/.test(h.lastNotice()),
      h.notices[0]?.message || "no warning");
    check("  ...and mutating nothing",
      h.calls.deactivations === 0 && h.calls.persists === 0 && !h.session.active, `${h.calls.deactivations} deactivation(s)`);
  }
  {
    const h = await harness("default-load-failure", [older]);
    h.session.activate(h.book.id);
    await duplicateAuthority(h);
    await handleScholarCommand("", h.ctx, h.coordinator);
    check("bare /scholar still reaches the guide when the active book cannot be read",
      /Scholar Tools & Workflows:/.test(h.lastNotice())
        && h.lastNotice().includes("Selected book: state could not be read."),
      h.lastNotice().split("\n")[0]);
    check("  ...without deactivating the session",
      h.calls.deactivations === 0 && h.calls.persists === 0 && h.session.active, `${h.calls.deactivations} deactivation(s)`);
  }
  {
    const h = await harness("missing-book", [older]);
    await rm(bookHomePath(h.config, h.book));
    await handleScholarCommand("exam", h.ctx, h.coordinator);
    check("a selected book with no state file keeps the existing message",
      h.lastNotice() === "Scholar has no selected book. Open one explicitly with /scholar open; no PDF is chosen automatically.",
      h.lastNotice());
    check("  ...and is not reported as a load failure", !/could not load/.test(h.lastNotice()), "plain selection message");
  }
  {
    const h = await harness("deleted-active-book", [older]);
    h.session.activate(h.book.id);
    await rm(bookHomePath(h.config, h.book));
    await handleScholarCommand("exam", h.ctx, h.coordinator);
    check("a deleted active book still clears the session as before",
      h.calls.deactivations === 1 && h.calls.persists === 1 && !h.session.active, `${h.calls.deactivations} deactivation(s)`);
    check("  ...and then reports no selected book", /no selected book/.test(h.lastNotice()), h.lastNotice());
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(`\nScholar resume-determinism summary: ${pass} passed, ${fail} failed.`);
process.exitCode = fail ? 1 : 0;
