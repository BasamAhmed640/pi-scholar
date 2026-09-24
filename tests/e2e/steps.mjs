// Shared harness state and the plan §5 steps used by the scenario files.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { examQuestionsFromEvents } from "./learner.mjs";
import { findNotesOfType, findSectionNote, inspectVault, readDetails, sectionQuestions } from "./vault-inspect.mjs";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const ANSWERED = new Set(["Correct", "Needs review", "Knowledge gap", "pass", "review", "unsure", "Cancelled", "unavailable"]);
const LESSON_READY_TEXT = /Full lesson committed|lesson committed|lesson (?:is )?ready|Now ask \d+ short questions/i;

export function fileDigest(path) {
  try {
    const data = readFileSync(path);
    return { sha256: createHash("sha256").update(data).digest("hex"), bytes: data.length, mtimeMs: statSync(path).mtimeMs };
  } catch { return undefined; }
}

export class Harness {
  constructor({ runDir, extensionDir, client, learner, textbook, deadline, scenario, strict = false }) {
    this.runDir = runDir;
    this.extensionDir = extensionDir;
    this.libraryDir = join(runDir, "library");
    this.vaultDir = join(runDir, "vault");
    this.client = client;
    this.learner = learner;
    this.textbook = textbook;
    this.deadline = deadline;
    this.scenario = scenario;
    this.strict = strict;          // full scenario: 0.8 acceptance checks are hard failures
    this.stages = [];
    this.failures = [];
    this.facts = {};                // values carried between steps (exam id, deleted content, …)
  }

  remainingMs() { return Math.max(0, this.deadline - Date.now()); }
  budget(ms) { return Math.max(1_000, Math.min(ms, this.remainingMs())); }

  async stage(name, fn) {
    const stage = { name, startSeq: this.client.seq, startAt: Date.now(), status: "running", checks: [], notes: [] };
    this.stages.push(stage);
    this.client.mark("stage_start", { stage: name });
    this.learner.setStage(name);
    console.log(`\n▶ ${name}`);
    try {
      if (this.remainingMs() <= 0) throw new Error("run time budget exhausted before this stage");
      await fn(stage);
      if (stage.status === "running") stage.status = stage.checks.some((check) => !check.ok && !check.soft) ? "failed" : "passed";
    } catch (error) {
      stage.status = "failed";
      this.fail(stage, error instanceof Error ? error.message : String(error));
    } finally {
      stage.endSeq = this.client.seq;
      stage.endAt = Date.now();
      this.client.mark("stage_end", { stage: name, status: stage.status });
      console.log(`  ${stage.status === "passed" ? "✓" : "✗"} ${name} (${Math.round((stage.endAt - stage.startAt) / 1000)} s)`);
    }
    return stage;
  }

  fail(stage, reason) {
    const name = typeof stage === "string" ? stage : stage.name;
    this.failures.push({ stage: name, reason });
    console.log(`  ✗ ${reason}`);
  }

  check(stage, name, ok, detail, { soft = false } = {}) {
    const hard = !soft;
    stage.checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? undefined : String(detail), soft: soft || undefined });
    console.log(`  ${ok ? "ok " : soft ? "warn" : "FAIL"} ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
    if (!ok && hard) this.failures.push({ stage: stage.name, reason: `${name}${detail !== undefined ? `: ${detail}` : ""}` });
    return Boolean(ok);
  }

  note(stage, text) {
    stage.notes.push(text);
    console.log(`  · ${text}`);
  }

  /** Runs a prompt; on timeout interrupts Pi so later steps start idle. */
  async command(stage, text, { timeoutMs = 600_000 } = {}) {
    const limit = this.budget(timeoutMs);
    console.log(`  > ${text.length > 110 ? `${text.slice(0, 110)}…` : text}`);
    const result = await this.client.runCommand(text, { timeoutMs: limit });
    if (!result.ok) {
      this.note(stage, `${text.slice(0, 60)} → ${result.timedOut ? `timed out after ${Math.round(limit / 1000)} s; interrupting` : result.error}`);
      if (result.timedOut && this.client.running) await this.client.abort().catch(() => undefined);
    }
    return result;
  }

  notificationsSince(seq) {
    return this.client.events.filter((entry) => entry.seq > seq && entry.dir === "out" && entry.rec?.type === "extension_ui_request" && entry.rec.method === "notify")
      .map((entry) => ({ type: entry.rec.notifyType || "info", message: String(entry.rec.message || "") }));
  }

  quizDialogsSince(seq) {
    return this.learner.dialogs.filter((dialog) => dialog.kind === "quiz" && (dialog.seq ?? 0) > seq);
  }

  inspect() { return inspectVault(this.vaultDir); }

  sectionState(number) {
    const note = findSectionNote(this.vaultDir, number);
    if (!note) return { exists: false, questions: [], answered: 0, pending: [], lessonUnits: [], committed: false };
    const questions = sectionQuestions(note.text);
    const entries = [...note.text.matchAll(/^> \[!info\]- Scholar entry details\r?\n((?:>[^\n]*(?:\n|$))*)/gm)].map((match) => {
      try { return JSON.parse(/```json\s*\n([\s\S]*)\n```/.exec(match[1].replace(/^> ?/gm, ""))?.[1] || "null")?.data; } catch { return undefined; }
    }).filter(Boolean);
    return {
      exists: true, path: note.path, text: note.text, status: note.frontmatter.status, committed: Boolean(note.details?.lessonCommit),
      questions, answered: questions.filter((question) => ANSWERED.has(question.status)).length,
      pending: questions.filter((question) => question.status === "Awaiting response"),
      lessonUnits: entries.filter((entry) => entry.lesson).map((entry) => ({ id: entry.id, title: entry.lesson?.title })),
    };
  }

  /** Marks lesson readiness (vault lessonCommit or the commit tool result) and "Generation stopped". */
  watchLearn(stage, number) {
    let ready = false;
    let stops = 0;
    let lastStopAt = 0;
    const markReady = (source) => {
      if (ready) return;
      ready = true;
      stage.lessonReadyAt = Date.now();
      this.client.mark("lesson_ready", { stage: stage.name, section: number, source });
      console.log(`  · lesson ready after ${Math.round((Date.now() - stage.startAt) / 1000)} s (${source})`);
    };
    const markStopped = () => {
      if (Date.now() - lastStopAt < 15_000) return; // the tool result and its notification describe one stop
      lastStopAt = Date.now();
      stops += 1;
      stage.generationStopped = (stage.generationStopped || 0) + 1;
      this.client.mark("generation_stopped", { stage: stage.name });
      console.log("  · Scholar reported \"Generation stopped\"");
    };
    const listener = (entry) => {
      const rec = entry.rec;
      if (entry.dir !== "out" || !rec) return;
      if (rec.type === "tool_execution_end" && rec.toolName === "scholar") {
        const text = (rec.result?.content || []).filter((item) => item?.type === "text").map((item) => item.text).join("\n");
        if (LESSON_READY_TEXT.test(text) && !/not approved|rejected|Draft saved/i.test(text.slice(0, 80))) markReady("tool result");
        if (/Generation stopped/i.test(text)) markStopped();
      }
      if (rec.type === "extension_ui_request" && rec.method === "notify" && /Generation stopped/i.test(rec.message || "")) markStopped();
    };
    this.client.on("record", listener);
    if (this.sectionState(number).committed) ready = true; // already committed before this stage
    const timer = setInterval(() => {
      if (ready) return;
      try { if (this.sectionState(number).committed) markReady("vault lessonCommit"); } catch { /* note mid-write */ }
    }, 2000);
    return {
      get ready() { return ready; },
      get stops() { return stops; },
      stop: () => { clearInterval(timer); this.client.off("record", listener); },
    };
  }

  /**
   * Drives one Learn section: the command, then learner turns (open answers in
   * chat, bare `/scholar learn` resumes) until `questionTarget` questions are
   * answered, `stopWhen` holds, the learner paused on purpose, or the budget ends.
   */
  async learn(stage, number, { command = `/scholar learn "section ${number}"`, questionTarget = 5, stopWhen, maxRounds = 8, timeoutMs = 1_800_000, retryAfterStop = 0 } = {}) {
    const watcher = this.watchLearn(stage, number);
    const stageDeadline = Date.now() + this.budget(timeoutMs);
    const remaining = () => Math.max(1_000, stageDeadline - Date.now());
    let lastAnswered = -1;
    let stale = 0;
    let stopsHandled = 0;
    try {
      let result = await this.command(stage, command, { timeoutMs: remaining() });
      for (let round = 0; round < maxRounds; round++) {
        const state = this.sectionState(number);
        if (stopWhen?.(state, watcher)) break;
        if (state.answered >= questionTarget || state.status === "complete") break;
        if (Date.now() >= stageDeadline || this.remainingMs() <= 0) { this.note(stage, "stage budget exhausted"); break; }
        if (!this.client.running) { this.note(stage, "Pi is not running"); break; }
        if (this.learner.plan.cancelled && state.pending.length) break; // paused on purpose
        if (watcher.stops > stopsHandled) {
          stopsHandled = watcher.stops;
          if (retryAfterStop-- > 0) {
            this.note(stage, "Generation stopped; the learner re-runs the section command (as Scholar instructs)");
            result = await this.command(stage, `/scholar learn "section ${number}"`, { timeoutMs: remaining() });
            continue;
          }
          this.note(stage, "Generation stopped; not retrying");
          break;
        }
        if (state.answered === lastAnswered) stale += 1; else stale = 0;
        lastAnswered = state.answered;
        if (stale >= 3) { this.note(stage, `no progress after ${stale} learner turns; giving up`); break; }
        const pendingOpen = state.pending.find((question) => question.format === "open");
        if (pendingOpen) {
          result = await this.command(stage, this.learner.openAnswer(pendingOpen.prompt), { timeoutMs: remaining() });
        } else {
          result = await this.command(stage, "/scholar learn", { timeoutMs: remaining() });
        }
        if (!result.ok && result.timedOut) break;
      }
      return this.sectionState(number);
    } finally {
      watcher.stop();
      stage.lessonReady = watcher.ready;
    }
  }
}

// ---------------------------------------------------------------------------
// Steps

export async function stepSetup(h) {
  await h.stage("setup · configure vault + library", async (stage) => {
    let since = h.client.seq;
    await h.command(stage, `/scholar obsidian "${h.vaultDir}"`, { timeoutMs: 120_000 });
    h.check(stage, "vault configured", h.notificationsSince(since).some((note) => /Obsidian vault set to/i.test(note.message)), h.vaultDir);
    since = h.client.seq;
    await h.command(stage, `/scholar library "${h.libraryDir}"`, { timeoutMs: 120_000 });
    const libraryNote = h.notificationsSince(since).find((note) => /library set to/i.test(note.message));
    h.check(stage, "library configured", libraryNote && /\(1 PDF book\)/.test(libraryNote.message), libraryNote?.message);
  });

  await h.stage("setup · open book + outline", async (stage) => {
    const since = h.client.seq;
    await h.command(stage, `/scholar open "${h.textbook.fileName}"`, { timeoutMs: 1_200_000 });
    let book = h.inspect().book;
    if (book?.outlineStatus !== "ready" && h.remainingMs() > 120_000) {
      h.note(stage, `outline status ${book?.outlineStatus ?? "missing"}; re-running /scholar open once`);
      await h.command(stage, `/scholar open "${h.textbook.fileName}"`, { timeoutMs: 900_000 });
      book = h.inspect().book;
    }
    h.check(stage, "outline ready", book?.outlineStatus === "ready", book?.outlineStatus ?? "no book note");
    const expected = h.textbook.expectedOutline;
    const actual = book?.chapters || [];
    const summary = actual.map((chapter) => `${chapter.number}:${chapter.startPage}-${chapter.endPage}[${chapter.sections.map((section) => `${section.number}:${section.startPage}-${section.endPage}`).join(",")}]`).join(" ");
    h.note(stage, `outline: ${summary || "none"}`);
    const sectionsMatch = expected.chapters.every((chapter) => {
      const found = actual.find((candidate) => candidate.number === chapter.number);
      return found && chapter.sections.every((section) => found.sections.some((candidate) => candidate.number === section.number && candidate.startPage === section.startPage && candidate.endPage === section.endPage));
    });
    h.check(stage, "outline matches the book (PDF viewer pages)", sectionsMatch, "expected 1.1:3-4 1.2:5-7 1.3:8-9 2.1:10-10 2.2:11-11", { soft: true });
    const unexpected = h.quizDialogsSince(since).length;
    h.check(stage, "setup asked the learner nothing", unexpected === 0 && !h.learner.unexpected.length, `${unexpected} quiz dialogs, ${h.learner.unexpected.length} unexpected dialogs`, { soft: !h.strict });
  });
}

/** Learn one section end to end (lesson → five questions). */
export async function stepLearnSection(h, number, { name = `learn ${number}`, questionTarget = 5, timeoutMs = 2_400_000 } = {}) {
  return h.stage(name, async (stage) => {
    const since = h.client.seq;
    h.learner.setPlan({ forceWrongAtQuiz: 2 });
    const state = await h.learn(stage, number, { questionTarget, timeoutMs, retryAfterStop: 0 });
    h.check(stage, "lesson committed", state.committed, state.exists ? `section status ${state.status}` : "no section note");
    h.check(stage, "no \"Generation stopped\"", !stage.generationStopped, stage.generationStopped ? "stopped by Scholar" : "none", { soft: !h.strict });
    h.check(stage, `${questionTarget} questions answered`, state.answered >= questionTarget, `${state.answered} answered, ${state.pending.length} pending`);
    const deliberateMiss = h.quizDialogsSince(since).some((dialog) => dialog.intended === "wrong" || dialog.intended === "dont-know");
    h.check(stage, "learner gave a deliberately non-correct answer", deliberateMiss, deliberateMiss ? "wrong choice or I don't know" : "none", { soft: !h.strict });
    const ids = state.questions.map((question) => question.id).filter(Boolean);
    h.check(stage, "no duplicate question ids", new Set(ids).size === ids.length, `${ids.length} ids`);
    const titles = state.lessonUnits.map((unit) => unit.id);
    h.check(stage, "no duplicate lesson units", new Set(titles).size === titles.length, `${titles.length} units`);
    const mermaid = (state.text?.match(/```mermaid/g) || []).length;
    h.check(stage, "lesson has ≥ 1 Mermaid diagram (G3)", mermaid >= 1, `${mermaid} diagrams`, { soft: !h.strict });
  });
}

/** Baseline: setup, then Learn 1.1 until the lesson is ready and two questions are answered (third paused). */
export async function stepBaselineLearn(h, number = "1.1") {
  return h.stage(`learn ${number}`, async (stage) => {
    h.learner.setPlan({ cancelAtQuiz: 3 });
    const state = await h.learn(stage, number, {
      questionTarget: 5, timeoutMs: h.remainingMs(), retryAfterStop: 0,
      stopWhen: (current) => h.learner.plan.cancelled || current.answered >= 2 && current.pending.length > 0,
    });
    h.check(stage, "lesson committed", state.committed || stage.lessonReady, state.exists ? `section status ${state.status}` : "no section note");
    h.check(stage, "no \"Generation stopped\"", !stage.generationStopped, stage.generationStopped ? "stopped by Scholar" : "none", { soft: true });
    h.note(stage, `${state.answered} answered, ${state.pending.length} pending, ${state.lessonUnits.length} lesson units`);
  });
}

/** Plan §5 step 4: abort mid-preparation of a section, re-run, and verify units are not duplicated. */
export async function stepAbortAndRerun(h, number = "1.2") {
  await h.stage(`learn ${number} · abort mid-preparation`, async (stage) => {
    h.learner.setPlan({ cancelAllQuizzes: true });
    const savedUnit = (entry) => {
      if (entry.dir !== "out" || entry.rec?.type !== "tool_execution_end" || entry.rec.toolName !== "scholar" || entry.rec.isError) return false;
      const args = h.client.toolStart(entry.rec.toolCallId)?.args;
      const text = (entry.rec.result?.content || []).map((item) => item?.text || "").join(" ");
      return args?.action === "notes" && Boolean(args.lesson || args.lessons) && !/^Scholar (?:retry|error)/.test(text);
    };
    const trigger = h.client.abortAfter(savedUnit, { afterMs: 300_000, label: "first saved lesson unit" });
    await h.command(stage, `/scholar learn "section ${number}"`, { timeoutMs: 1_200_000 });
    trigger.disarm();
    const fired = await Promise.race([trigger.fired, sleep(2_000).then(() => undefined)]);
    const state = h.sectionState(number);
    h.facts.unitsBeforeAbort = state.lessonUnits;
    h.check(stage, "aborted after a saved lesson unit", Boolean(fired && !fired.timer), fired ? `abort after ${fired.timer ? "timer" : "a saved lesson unit"}` : "the run ended before the trigger");
    h.note(stage, `after abort: committed=${state.committed}, units=${state.lessonUnits.map((unit) => unit.id).join(", ") || "none"}`);
    h.check(stage, "interrupted before commit", !state.committed, state.committed ? "lesson was already committed" : "draft only");
    h.check(stage, "saved a unit before abort", state.lessonUnits.length > 0, `${state.lessonUnits.length} saved unit(s)`);
  });

  await h.stage(`learn ${number} · re-run, answer 2, Esc on the 3rd`, async (stage) => {
    h.learner.setPlan({ cancelAtQuiz: 3 });
    const state = await h.learn(stage, number, { questionTarget: 5, timeoutMs: 2_400_000, stopWhen: () => h.learner.plan.cancelled });
    h.check(stage, "lesson committed", state.committed, `status ${state.status}`);
    const ids = state.lessonUnits.map((unit) => unit.id);
    h.check(stage, "no duplicate lesson units after re-run", new Set(ids).size === ids.length, ids.join(", "));
    const titles = state.lessonUnits.map((unit) => String(unit.title || "").toLowerCase());
    h.check(stage, "no duplicate lesson titles after re-run", new Set(titles).size === titles.length, `${titles.length} units`, { soft: true });
    const kept = (h.facts.unitsBeforeAbort || []).every((unit) => ids.includes(unit.id));
    h.check(stage, "units saved before the abort were resumed, not re-created", kept && (h.facts.unitsBeforeAbort || []).length > 0,
      (h.facts.unitsBeforeAbort || []).map((unit) => unit.id).join(", ") || "none saved before abort");
    h.check(stage, "Esc paused the set after 2 answers", h.learner.plan.cancelled && state.answered === 2 && state.pending.length >= 1,
      `${state.answered} answered, ${state.pending.length} pending`);
    h.facts.pendingAfterEsc = state.pending.map((question) => question.id);
    h.facts.answeredBeforeRestart = state.answered;
  });

  await h.stage(`learn ${number} · kill Pi, restart --continue, resume`, async (stage) => {
    await h.client.kill();
    const state0 = await h.client.start({ continueSession: true });
    h.check(stage, "session continued after restart", (state0?.messageCount ?? 0) > 0, `${state0?.messageCount ?? 0} messages restored`);
    h.learner.setPlan({});
    const since = h.client.seq;
    const state = await h.learn(stage, number, { command: "/scholar learn", questionTarget: 5, timeoutMs: 1_500_000 });
    const answeredDialogs = h.quizDialogsSince(since).filter((dialog) => dialog.intended !== "cancel").length;
    const expected = 5 - (h.facts.answeredBeforeRestart ?? 2);
    h.check(stage, "resume asked only the remaining questions", answeredDialogs === expected, `${answeredDialogs} dialogs answered (expected ${expected})`);
    h.check(stage, "all five answered", state.answered >= 5, `${state.answered} answered, ${state.pending.length} pending`);
    const ids = state.questions.map((question) => question.id).filter(Boolean);
    h.check(stage, "no duplicate question ids", new Set(ids).size === ids.length, `${ids.length} ids`);
    const prompts = state.questions.map((question) => question.prompt.toLowerCase());
    h.check(stage, "no duplicate question blocks", new Set(prompts).size === prompts.length, `${prompts.length} blocks`);
    const resumedIds = (h.facts.pendingAfterEsc || []).filter(Boolean);
    h.check(stage, "paused questions resumed in place", resumedIds.every((id) => state.questions.some((question) => question.id === id && question.status !== "Awaiting response")),
      resumedIds.join(", ") || "no ids recorded", { soft: !h.strict });
  });
}

/** Plan §5 step 6: Tutor on 1.2 (probe → path → one node → lock-in); Learn progress must not move. */
export async function stepTutor(h, scope = "1.2") {
  return h.stage(`tutor ${scope}`, async (stage) => {
    const before = h.sectionState(scope);
    h.learner.setPlan({});
    const since = h.client.seq;
    await h.command(stage, `/scholar tutor "${scope}"`, { timeoutMs: 1_200_000 });
    for (let nudge = 0; nudge < 3 && h.remainingMs() > 60_000; nudge++) {
      const tutor = findNotesOfType(h.vaultDir, "scholar-tutor").at(-1);
      const questions = tutor ? sectionQuestions(tutor.text) : [];
      const pendingOpen = questions.find((question) => question.status === "Awaiting response" && question.format === "open");
      const answered = h.quizDialogsSince(since).filter((dialog) => dialog.intended !== "cancel").length;
      if (pendingOpen) { await h.command(stage, h.learner.openAnswer(pendingOpen.prompt), { timeoutMs: 900_000 }); continue; }
      if (answered >= 4) break; // probe (≤3) + at least one lock-in item
      await h.command(stage, "Continue with the next step of my learning path.", { timeoutMs: 900_000 });
    }
    const tutor = findNotesOfType(h.vaultDir, "scholar-tutor").at(-1);
    h.check(stage, "tutor note written", Boolean(tutor), tutor ? basename(tutor.path) : "none");
    const quizCount = h.quizDialogsSince(since).length;
    h.check(stage, "tutor asked questions (probe/lock-in)", quizCount >= 1, `${quizCount} quiz dialogs`);
    // Obsidian renders Scholar diagrams inside callouts, prefixing both fence
    // and Mermaid lines with ">". Count the rendered note form as well as a
    // plain fence; the original matcher missed every real Tutor diagram.
    const flowcharts = (tutor?.text.match(/^[ \t]*(?:>[ \t]*)*```mermaid[ \t]*\r?\n[ \t]*(?:>[ \t]*)*(?:flowchart|graph)\b/gm) || []).length;
    h.check(stage, "learning-path Mermaid flowchart saved (C5)", flowcharts >= 1, `${flowcharts} flowcharts`, { soft: !h.strict });
    const after = h.sectionState(scope);
    const snapshot = (state) => JSON.stringify(state.questions.map((question) => [question.id, question.status]));
    h.check(stage, "Learn progress unchanged by Tutor (mode isolation)", snapshot(before) === snapshot(after) && before.status === after.status, `${before.answered} → ${after.answered} answered`);
  });
}

/** Plan §5 step 7: exam paper → learner answers in the vault → submit → abort during grading → reopen → graded. */
export async function stepExam(h, scope = "chapter 1") {
  await h.stage(`exam "${scope}" · build paper`, async (stage) => {
    const papersBefore = new Set(findNotesOfType(h.vaultDir, "scholar-exam-paper").map((note) => note.path));
    const since = h.client.seq;
    await h.command(stage, `/scholar exam "${scope}"`, { timeoutMs: 1_500_000 });
    h.check(stage, "no dialog while building", h.client.events.filter((entry) => entry.seq > since && entry.dir === "out" && entry.rec?.type === "extension_ui_request" && ["select", "input", "confirm"].includes(entry.rec.method)).length === 0, "G1b never ask on load", { soft: !h.strict });
    const paper = findNotesOfType(h.vaultDir, "scholar-exam-paper").find((note) => !papersBefore.has(note.path));
    h.check(stage, "answer paper written in the vault", Boolean(paper), paper ? basename(paper.path) : "none");
    if (!paper) return;
    h.facts.examId = String(paper.frontmatter.exam_id);
    h.facts.paperPath = paper.path;
    const regions = (paper.text.match(/<!-- scholar:answer:.+?:start -->/g) || []).length;
    h.check(stage, "paper has answer regions", regions >= 1, `${regions} questions`);
    h.check(stage, "exam length within 4–12 (C4)", regions >= 4 && regions <= 12, `${regions} questions`, { soft: !h.strict });
  });

  await h.stage("exam · answer in Obsidian, submit, abort during grading", async (stage) => {
    if (!h.facts.paperPath) throw new Error("no answer paper from the previous step");
    const original = readFileSync(h.facts.paperPath, "utf8");
    const filled = h.learner.fillExamPaper(original, examQuestionsFromEvents(h.client.events));
    const regions = (original.match(/<!-- scholar:answer:.+?:start -->/g) || []).length;
    h.check(stage, "filled every exam answer region", filled.answers.length === regions && filled.answers.every((answer) =>
      !answer.problem && (answer.format === "open" ? Boolean(answer.answer?.trim()) : answer.picks?.length > 0)),
    `${filled.answers.length}/${regions} regions filled`);
    writeFileSync(h.facts.paperPath, filled.text, "utf8");
    h.facts.examAnswers = filled.answers;
    h.note(stage, `filled ${filled.answers.length} regions (${filled.answers.filter((answer) => answer.format === "open").length} written, ${filled.answers.filter((answer) => answer.intended === "correct").length} intended correct)`);
    h.learner.examId = h.facts.examId;
    const trigger = h.client.abortAfter((entry) => entry.dir === "out" && entry.rec?.type === "tool_execution_start" && entry.rec.toolName === "scholar"
      && ["exam_present", "exam_grade"].includes(entry.rec.args?.action), { afterMs: 60_000, label: "grading tool call" });
    const since = h.client.seq;
    await h.command(stage, `/scholar exam "${h.facts.examId}" submit`, { timeoutMs: 900_000 });
    trigger.disarm();
    const fired = await Promise.race([trigger.fired, sleep(2_000).then(() => undefined)]);
    const confirm = h.learner.dialogs.find((dialog) => dialog.kind === "exam-submit-confirm" && (dialog.seq ?? 0) > since);
    h.check(stage, "submission confirmed once", Boolean(confirm), confirm?.message?.split("\n")[0]);
    const exam = h.inspect().exams.find((candidate) => candidate.examId === h.facts.examId);
    h.check(stage, "grading was interrupted at a grading tool call", Boolean(fired && !fired.timer), fired ? `abort after ${fired.timer ? "timer" : "grading tool start"}` : `not interrupted (status ${exam?.status})`);
    h.note(stage, `exam status after abort: ${exam?.status}`);
    h.check(stage, "submission persisted", ["submitted", "graded"].includes(exam?.status), exam?.status);
  });

  await h.stage("exam · reopen and grade", async (stage) => {
    if (!h.facts.examId) throw new Error("no exam id");
    let exam = h.inspect().exams.find((candidate) => candidate.examId === h.facts.examId);
    if (exam?.status !== "graded") {
      await h.command(stage, `/scholar exam "${h.facts.examId}"`, { timeoutMs: 1_200_000 });
      exam = h.inspect().exams.find((candidate) => candidate.examId === h.facts.examId);
    }
    h.check(stage, "exam graded", exam?.status === "graded", `${exam?.status} · ${exam?.earnedPoints ?? "—"}/${exam?.maxPoints ?? "—"}`);
    const key = h.inspect().answerKeys.find((candidate) => candidate.examId === h.facts.examId);
    h.check(stage, "answer key note present", Boolean(key), key?.path);
    h.check(stage, "answer key has an outcome pie chart (C4)", (key?.mermaidKinds || []).includes("pie"), (key?.mermaidKinds || []).join(",") || "none", { soft: !h.strict });
  });
}

function removeQuestionBlock(text, index) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^## Questions\s*$/.test(line));
  const headers = [];
  for (let row = start + 1; row < lines.length; row++) {
    if (/^(?:## |<!-- scholar:generated:end -->)/.test(lines[row])) { headers.push({ row, end: true }); break; }
    if (/^(?:### |> \[!question\] )Question \d+\b/.test(lines[row])) headers.push({ row });
  }
  const target = headers.filter((header) => !header.end)[index];
  if (!target) return undefined;
  const next = headers.find((header) => header.row > target.row) || { row: lines.length };
  const removed = lines.slice(target.row, next.row).join("\n");
  lines.splice(target.row, next.row - target.row);
  return { text: lines.join("\n"), removed };
}

function removeLessonUnit(text) {
  const lines = text.split("\n");
  const lessonStart = lines.findIndex((line) => /^## Lesson\s*$/.test(line));
  if (lessonStart < 0) return undefined;
  for (let row = lessonStart + 1; row < lines.length; row++) {
    if (/^## /.test(lines[row])) break;
    if (!/^> \[!info\]- Scholar entry details/.test(lines[row])) continue;
    const end = lines.findIndex((line, index) => index > row && line.trim() === "<!-- scholar:entry:end -->");
    if (end < 0) return undefined;
    const entry = lines.slice(row, end + 1).join("\n");
    const details = readDetails(entry, "entry");
    if (!details?.lesson || !details.id) { row = end; continue; }
    const visible = entry.replace(/^> \[!info\]- Scholar entry details\r?\n(?:>[^\n]*(?:\n|$))*/, "")
      .replace("<!-- scholar:entry:end -->", "").trim();
    lines.splice(row, end - row + 1);
    return { text: lines.join("\n"), id: details.id, visible };
  }
  return undefined;
}

/** Plan §5 step 8: delete a question block and an entire lesson unit, then verify neither returns. */
export async function stepDeletion(h, number = "1.1") {
  return h.stage(`deletion test · section ${number}`, async (stage) => {
    const state = h.sectionState(number);
    if (!state.exists) throw new Error(`section ${number} has no note`);
    let text = state.text;
    const question = removeQuestionBlock(text, 1);
    if (question) text = question.text;
    const deletedQuestion = question ? state.questions[1] : undefined;
    const lessonUnit = removeLessonUnit(text);
    if (lessonUnit) text = lessonUnit.text;
    h.check(stage, "found a question block to delete", Boolean(question), question ? "Question 2" : "no question block");
    h.check(stage, "found a full saved lesson unit to delete", Boolean(lessonUnit), lessonUnit?.id || "no lesson unit");
    writeFileSync(state.path, text, "utf8");
    h.note(stage, `deleted Q2 (${deletedQuestion?.id ?? "?"}) and lesson unit ${lessonUnit?.id ?? "?"}`);
    const verify = (label) => {
      const now = h.sectionState(number);
      if (deletedQuestion?.id) h.check(stage, `${label}: deleted question id stays deleted`, !now.text.includes(deletedQuestion.id), deletedQuestion.id);
      if (deletedQuestion?.prompt) h.check(stage, `${label}: deleted question text stays deleted`, !now.questions.some((candidate) => candidate.prompt === deletedQuestion.prompt), deletedQuestion.prompt.slice(0, 80));
      if (lessonUnit) {
        h.check(stage, `${label}: deleted lesson unit id stays deleted`, !now.lessonUnits.some((unit) => unit.id === lessonUnit.id), lessonUnit.id);
        if (lessonUnit.visible) h.check(stage, `${label}: deleted lesson text stays deleted`, !now.text.includes(lessonUnit.visible), lessonUnit.visible.slice(0, 80));
      }
      return now;
    };
    await h.client.kill();
    await h.client.start({ continueSession: true });
    await h.command(stage, `/scholar open "${h.textbook.fileName}"`, { timeoutMs: 600_000 });
    verify("after restart + open");
    h.learner.setPlan({ cancelAllQuizzes: true });
    const trigger = h.client.abortAfter(() => false, { afterMs: 180_000, label: "reopen budget" });
    await h.command(stage, `/scholar learn "section ${number}"`, { timeoutMs: 600_000 });
    trigger.disarm();
    const after = verify("after reopening the section");
    h.check(stage, "note still parses (question blocks readable)", after.questions.every((candidate) => candidate.status !== "unknown"), `${after.questions.length} blocks`);
    h.learner.setPlan({});
  });
}

export async function stepFinalInspection(h, { soft = false } = {}) {
  return h.stage("final vault inspection", async (stage) => {
    const vault = h.inspect();
    h.facts.vault = vault;
    writeFileSync(join(h.runDir, "logs", "vault-summary.json"), `${JSON.stringify(vault, null, 2)}\n`);
    h.check(stage, "all wikilinks/embeds resolve", vault.links.unresolved.length === 0, `${vault.links.unresolved.length} unresolved of ${vault.links.total}`, { soft });
    h.check(stage, "Mermaid lint-clean", vault.mermaid.lintErrors.length === 0, `${vault.mermaid.total} diagrams, ${vault.mermaid.lintErrors.length} with errors`, { soft });
    h.check(stage, "no duplicate question blocks/ids", !vault.duplicates.questionBlocks.length && !vault.duplicates.questionIds.length, `${vault.duplicates.questionBlocks.length} blocks, ${vault.duplicates.questionIds.length} ids`, { soft });
    h.check(stage, "no duplicate lesson units", !vault.duplicates.lessonEntryIds.length, `${vault.duplicates.lessonEntryIds.length}`, { soft });
    h.check(stage, "no duplicate notes", !vault.duplicates.notes.length, `${vault.duplicates.notes.length}`, { soft });
    h.check(stage, "math delimiters balanced", vault.math.issues.length === 0, `${vault.math.issues.length} issues`, { soft: soft || !h.strict });
  });
}

export function ensureDirectories(runDir) {
  for (const directory of ["library", "vault", join("vault", ".obsidian"), "sessions", "state", "logs", "work"]) mkdirSync(join(runDir, directory), { recursive: true });
}

export function isInside(parent, child) {
  const a = resolve(parent).toLowerCase().replace(/[\\/]+$/, "");
  const b = resolve(child).toLowerCase();
  return b === a || b.startsWith(`${a}\\`) || b.startsWith(`${a}/`);
}

export { existsSync };
