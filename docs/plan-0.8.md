# Scholar 0.8 — plan: fast, reliable, diagram-rich study

Source of the goals: the owner's `SCHOLAR_UPDATE` brief (2026-09-23). Grading order:
**reliability (pass/fail) → speed → quality → beauty.** Scholar exists to get the
knowledge out of a book faster than reading it.

## 0. What the evidence says today (baseline, 0.7.1 + attribution fix)

- `npm test`: 58/58 verifiers pass in ~2 min 11 s.
- Real sessions (2026-09-17/18, Griffiths 1.4 and 1.5, deepseek flash, thinking=max):
  source preparation 40–60 s, lesson writing 3–5 min (8–19 `notes` calls, several
  gate retries, 20–60 k thinking tokens per big call), then `lessonComplete` waited
  47–99 s for reviewers and **every attempt ended "review incomplete (limit)" →
  "Generation stopped"**. The learner never received the lesson; re-running hit the
  same wall. This is the #1 reliability defect ("forever reviews").
- Each Learn/Tutor question costs a reviewer model call *before* it appears plus a
  full author turn afterwards: 5 questions ≈ 10 sequential model round trips.
- Scholar cannot run in Pi's RPC host at all (the editor lock throws when
  `setEditorComponent` is a no-op) and its quiz picker needs `ui.custom()`, which RPC
  lacks, so every question would read as "cancelled" there.
- Mermaid is "optional, no quota" in the presentation policy → diagrams rarely appear.
- `/scholar exam "<scope>"` re-prompts with an input dialog on a near miss; bare
  `/scholar learn` / `/scholar tutor` refuse instead of choosing a sensible target.

## 1. Goals and acceptance criteria

| # | Goal | Accepted when |
|---|------|---------------|
| G1 | **Reliability — it just works** | A real Pi run (RPC, real model, disposable vault) completes: open book → Learn 2 sections → Tutor → Exam → submit → grade, with restart + interruptions, and no "Generation stopped" caused by review. Every interruption point resumes cleanly (§5). Zero duplicated attempts/notes, zero lost answers, zero resurrected deleted content, zero cross-book leakage. |
| G1a | No forever loops | Review can delay delivery at most once per preparation and at most `REVIEW_WAIT_MS` per wait. Reviewer execution failures (limit/timeout/provider/invalid-output) never block delivery. Runaway guards (8 consecutive rejections, 250 actions, 4 delivery-gap rejections) stay. |
| G1b | Never ask on load | Loading a section, exam, or tutor never opens a dialog. Bare commands pick a sensible target and say what they picked. (Submission keeps its one confirm — the learner must submit.) |
| G1c | Works in any Pi host | TUI unchanged; RPC/other hosts: questions via `ui.select`, no editor-lock failure (the `input` hook still blocks stray chat). |
| G2 | **Speed** | Learn questions: one model turn produces the whole 5-question set; each answer's feedback is instant (no model call between questions). No reviewer call before a question appears. Section preparation measured before/after in the e2e run; target ≥ 40 % faster wall time to "questions ready", and never blocked > `REVIEW_WAIT_MS` by review. Exams: concise (default 4–12 items), one bounded review, frozen in one build. |
| G3 | **Quality** | Every Learn lesson contains ≥ 1 relevant Mermaid diagram; every source item that is a *system* (mapping logic), *workflow*, or *sequence* (interactions over time) has its own diagram. Tutor follows the Alvar method (probe → mermaid path → one node → lock-in quiz). Questions follow retrieval-practice science (one idea each, misconception distractors, elaborative feedback). Exams cover every scoped subsection and several cognitive dimensions. Grounding gates unchanged. |
| G4 | **Beauty** | Consistent callouts: status, lesson, key equation, figure, diagram, question, answer; exam paper and answer key read like a real exam; diagrams render (lint-clean Mermaid subset); light/dark CSS. |

Hard-fail list (from the brief) — must never happen: invented source support,
lost/duplicated progress, incorrect grading, cross-book contamination, deleted content
reappearing. **Do not weaken grounding, completion gates or persistence rules to make
tests pass.** When a verifier asserts behaviour this plan deliberately changes, update
that assertion to the new behaviour and keep every unrelated assertion.

## 2. Shared contracts (all workstreams build to these)

### C1 · Quiz sets (`scholar_quiz`)
```
scholar_quiz({ questions: [Item, …] })     // 1–5 items, one set, one tool call
scholar_quiz({ …Item })                     // legacy single question = set of 1
scholar_quiz({ resumeAttemptId })           // reopens every still-pending item of that set, in order
Item = { kind, question, details?, difficulty?, grounding, options:[{label,value?,description?,misconception?}],
         multiSelect?, correctAnswer, explanation, shuffle? }
```
- Attempt ids: item 1 `quiz-<toolCallId>`, item n≥2 `quiz-<toolCallId>-<n>`; optional
  schema field `quizSet: { id: <toolCallId>, index: n, size: N }`.
- All items are validated (short-question shape, grounding, one-objective mastery MCQ,
  figure coverage) and frozen (shuffled) **before** the picker opens, and persisted
  atomically as pending attempts. **No model review before presentation.**
- `unansweredQuestion(attempts)` returns the **first** attempt of the trailing run of
  pending attempts (single-question behaviour unchanged).
- Each answer is persisted the moment it is given (not only at `tool_result`); a late
  or repeated event can never change a finalized answer.
- TUI picker: "Question i of N", after each answer an in-picker feedback panel
  (✓/✗, correct answer, explanation) → Enter for next, Esc pauses (rest stay pending).
- Non-TUI (`ctx.mode !== "tui"` or `ui.custom` unavailable): `ui.select` with the
  option labels + "I don't know" (multi-select via `ui.input` "numbers, e.g. 1,3");
  feedback via `ui.notify`.

### C2 · Notes additions (Learn and Tutor)
```
notes({ lessons: [LessonInput, …] })        // up to 8 units in one call; `lesson` still accepted; not both
LessonInput.diagrams?: LessonDiagram[]      // placed by own-line [[scholar-diagram:ID]]
LessonDiagram = { id, title, kind: "flowchart"|"sequence"|"state"|"class"|"mindmap"|"timeline",
                  mermaid, takeaway, sourcePages }
sourceCoverage.kind += "system" | "workflow" | "sequence"   // each needs diagramId rendered in its unit
SourceCoverageItem.diagramId?  ·  lesson receipt gains diagramIds
```
- Scholar renders each diagram as a `> [!scholar-diagram] Diagram · <title>` callout
  containing a `mermaid` fence, a **Takeaway** line and a source-pages line.
- Mermaid is linted to a safe subset before saving (header matches kind, ≤ 40 nodes,
  ≤ 80 lines, no `click`/`href`/`%%{init`/HTML/script, balanced brackets/quotes, labels
  with punctuation auto-quoted). A lint failure names the line.
- Learn commit requires ≥ 1 diagram in the lesson.
- Coverage `evidence` matching is normalized (whitespace, `*`/`_` emphasis, `>` quote
  markers, trailing punctuation) but must still be explanatory body text of that unit.

### C3 · Bounded review
- Audit-as-you-go stays: one audit per saved unit revision, concurrent with authoring,
  unchanged content never re-audited, receipts saved as they finish.
- `lessonComplete` waits for outstanding audits of current revisions for at most
  `REVIEW_WAIT_MS` (45 s). Still-running audits continue in the background and land
  as advisory notes; they never revoke readiness.
- Execution failures are recorded ("review incomplete · limit") and **never block**.
- Unresolved blocking findings block **at most once per section preparation**. The next
  `lessonComplete` commits; open findings are shown in a collapsed
  `> [!warning]- Reviewer notes` callout in the section note.
- `lessonReady` depends on the commit hash + deterministic coverage, **not** on review
  receipts. The commit hash still binds lesson, coverage, recap, plan, figures.
- No `stopDelivery` on review outcomes. Exam form: same bounded wait (60 s), one repair
  round, failures non-blocking. Tutor explanation audits are advisory only.
- `tool-controller.ts` stays the only approval writer.

### C4 · Exams
- Default length: ≈ 2 items per scoped subsection, clamped to 4–12; hard cap 16.
- Keep the mixed-form rules; written answers stay one line / two sentences.
- Paper: header callout (items · points · ≈ minutes), `[!question]` per item with
  checkboxes or a writing area, final `[!tip] Submit` callout with the exact command.
  Answer key: score banner, outcome Mermaid `pie`, "where to look first", competency
  table, per-question callouts.
- `/scholar exam submit` with exactly one active exam skips the picker (confirm stays).

### C5 · Tutor = Alvar method (Eero Alvar, *How I Use AI to Learn Things*)
1. **Probe** — first turn, no setup questions: one `scholar_quiz` set of ≤ 3 MCQs
   (Scholar adds "I don't know") spanning the prerequisite strands of the request.
2. **Plan** — save a "Learning path" unit with a Mermaid `flowchart TD` DAG of 3–7 nodes,
   each one reasoning step, starting at the learner's edge; mark known/edge/next.
3. **Teach one node** per turn (short saved unit; diagram/figure when it locks the idea).
4. **Lock-in** — a 1–3 item quiz set on that node; advance only on pass; on a miss insert
   a prerequisite node or re-explain differently; update the path.
5. **Verify** — facts that matter and are not plainly in the PDF may be checked on the
   web with `scholar_web` (`search`/`read`); saved text labels them
   "External source: title (url)". The PDF remains the authority for grounding.

### C6 · Host compatibility
- Editor lock: when `ctx.mode` is set and is not `"tui"`, return a no-op release; the
  `input` hook keeps blocking chat during Scholar turns. TUI behaviour unchanged.

### C7 · Speed levers
- `view` accepts `startPage..endPage` (≤ 4 pages) rendered concurrently, one receipt
  per page; guidance allows up to 6 independent source calls per message.
- Clearer first-time guidance to cut gate retries (snapshot coordinates, exact
  evidence, figure accounting) and a one-call delivery path (plan + lessons + recap +
  figureReviews + checks + `lessonComplete`).
- Thinking level: measured in the e2e run; a preparation-only cap is added only if the
  measurement shows a large win at acceptable quality.

## 3. Workstreams, owners, files (parallel, isolated git worktrees)

| Agent | Scope | Owns (only these files) |
|---|---|---|
| **Q** Quiz sets + host compat | C1, C6 | `quiz.ts`, `quiz-contract.ts`, `index.ts`, `domain.ts`, `state-schema.ts` (attempt fields), `input-lock.ts`, `runtime-coordinator.ts` (quiz registration/loading region only), `note-records.ts`/`question-grounding*.ts` if needed, their verifiers |
| **R** Bounded review + source speed | C3, C7 (view ranges) | `tool-controller.ts`, `review-layer.ts`, `review-runtime.ts`, `learn-review.ts`, `lesson.ts` (readiness/commit/review-issue functions only), `learn-quality.ts` (review-gate half only), `render/section.ts`, `tool-actions/source.ts`, `tool-actions/visuals.ts`, `figure-coverage.ts`, `loading-progress.ts`, their verifiers |
| **D** Diagrams + authoring ergonomics | C2 | new `diagram-presentation.ts`, `lesson.ts` (save/patch/receipt/coverage-issue functions), `learn-quality.ts` (coverage half), `tool-contract.ts`, `tool-actions/learning.ts`, `equation-presentation.ts`, `render/callouts.ts`, `scholar.css`, their verifiers |
| **E** Exams | C4 | `exam.ts`, `exam-paper.ts`, `render/assessment.ts`, `tool-actions/exam.ts`, their verifiers |
| **P** Prompts, navigation, Tutor web | C5, G1b, policy text for C1–C4 | `policies.ts`, `commands.ts`, `command-syntax.ts`, `modes.ts`, `runtime-coordinator.ts` (kickoff text, tool sync, web-tool registration), new `tutor-web.ts`, their verifiers |
| **X** End-to-end harness | §5 | new `tests/e2e/**` only |
| **A** Advisor | reviews plan, each branch before merge, final result | read-only |

Coordinator (main session): dispatches, merges branches in order D → R → Q → E → P,
resolves conflicts, runs the full suite, runs the e2e scenario, loops fixes, updates
docs (`README.md`, `AGENTS.md`, `docs/architecture.md`), bumps to 0.8.0, commits,
pushes `main`, and refreshes the live extension.

## 4. Verification (all must pass)

1. `npm test`, `npm run test:preflight`, `npm run pack:check` (new files added to
   `package.json#files`).
2. New deterministic verifiers: quiz sets (partial set resume, immediate persistence,
   no duplicates, select fallback), bounded review (limit failure delivers, one repair
   round, wait cap, readiness independent of receipts), diagrams (lint, render,
   coverage kinds, ≥1 per lesson), exam length/beauty, no-prompt loading, Tutor web
   (mocked fetch), RPC editor-lock bypass.
3. Real e2e (§5) on the Windows baseline with Poppler, disposable library + vault.
4. Manual inspection of generated notes: source pages, figures, math, diagrams, links,
   callouts, resume behaviour, no resurrection of deleted content.

## 5. End-to-end scenario (real Pi, RPC, real model)

Synthetic textbook (2 chapters, ~10 pages: control-system block diagram, a feedback
workflow, a request/response sequence, equations, a worked example). Steps:
1. Configure disposable vault + library (`PI_SCHOLAR_STATE_ROOT` isolates the pointer).
2. `/scholar open` → outline setup → ready.
3. `/scholar learn "section 1.1"` → lesson → 5-question set (answer some wrong).
4. **Abort mid-preparation** of 1.2 → re-run → resumes without duplicate units.
5. **Cancel mid-set** (after 2 answers) → kill Pi → restart (`--continue`) →
   `/scholar learn` resumes the 3 remaining questions only.
6. `/scholar tutor "1.2"` → probe set → path diagram → one node → lock-in set.
7. `/scholar exam "chapter 1"` → paper written in the vault → harness fills answers →
   `/scholar exam submit` → confirm → **abort during grading** → reopen → graded; key present.
8. Delete a question block and a lesson unit in the vault → restart → verify neither
   returns. Check wikilinks resolve, no duplicate notes/attempts, Mermaid lint-clean.
9. Timing report per stage vs. the 0.7.1 baseline.
