# AGENTS.md — pi-scholar

One Pi extension. `index.ts` is the entry point (`package.json` → `pi.extensions`).
Learn, Exam, and Tutor are **independent entry points for the same selected PDF book**;
none requires another to be completed first.

## Verify before claiming done

```bash
npm ci --ignore-scripts     # uses the committed npm-shrinkwrap.json
npm test                    # 58 verifiers; currently all pass
npm run test:list           # list checks without loading Pi
npm run test:preflight      # confirm Pi SDK + test deps import
npm run pack:check          # preview the npm archive file list
```

`npm test` is the only evidence that counts. It generates synthetic PDFs and
disposable vaults, so it needs no real book or vault — but it does need
**Poppler on PATH**: `pdfinfo`, `pdftotext`, `pdftoppm`. A run reporting
"blocked" prerequisites is not a pass.

There is **no `tsconfig.json` and no typecheck step.** The language server
(`tsc --lsp`) still reports type errors per file. If you add a config, do not
enable `strict` wholesale — this codebase has never been type-checked and it
will bury real defects in noise.

## Invariants — do not break these

- **`tool-controller.ts` alone saves review receipts and commits approved
  delivery.** Nothing else writes approval. Keep it the single writer.
- **Approval is hash-bound.** The hash covers lesson, coverage, recap,
  assessment plan, and figure metadata. Any content change invalidates approval
  — that is intended, not a bug to route around.
- Audit-as-you-go; one audit pass per saved unit revision; no re-review of unchanged work. Delivery remains controller-owned and hash-bound.
- **Modes are isolated.** They share the PDF and its validated outline, never
  each other's learner history. A Tutor answer must not move Learn progress;
  Exam generation must not read Learn or Tutor performance.
- **Reviewers are scoped and read-only.** They cannot reach another mode's
  history, write notes, change progress, run shell commands, or grade. They are
  fresh in-memory conversations, not extension-loaded Pi sessions.
- **Engines are universal.** Teach, question, presentation, and review are
  defined once (`policies.ts`, `review-layer.ts`, `render/`, `quiz-contract.ts`)
  and every mode uses all four; a mode may add only its own surface rules.
- **Review is deliberately shallow and cheap.** Reviewers run at a fixed low
  reasoning level in one prepared request per packet (`REVIEWER_THINKING_LEVEL`,
  `DEFAULT_REVIEWER_LIMITS`), and the visual role judges saved crops and the
  figure inventory, never full page renders. Do not restore session-level
  thinking, full-page images, or long tool loops to "improve" review quality.
- **Review must actually look.** A unit's audit reads bounded windows over the
  pages that unit cites and inspects only that unit's current saved crops. Never
  accept a summary of evidence in place of the evidence, and never use a page
  render for review.
- **No fixed model or provider.** Do not hardcode a vendor anywhere in review
  or authoring paths.
- **Stable entry IDs prevent duplicate retries.** IDs of deleted entries stay in
  the note's details purely to reject stale retries; they must contain no lesson
  text. An intentional revision reads `status` with `lessonId` first, then
  supplies the current `expectedContentHash` — never overwrite a user edit.

## Layout

| Area | Files |
|---|---|
| Entry / commands | `index.ts`, `commands.ts`, `command-syntax.ts`, `modes.ts` |
| Teach | `policies.ts` (engine contracts), `lesson.ts`, `lesson-figures.ts` |
| Question | `quiz.ts`, `quiz-contract.ts`, `exam.ts`, `exam-paper.ts` |
| Presentation | `render/`, `scholar.css`, `equation-presentation.ts` |
| Review | `review-layer.ts`, `review-runtime.ts`, `learn-review.ts`, `learn-quality.ts` |
| Contract / state | `tool-controller.ts`, `tool-contract.ts`, `state-schema.ts`, `runtime-coordinator.ts` |
| Obsidian | `obsidian.ts`, `obsidian-paths.ts`, `note-records.ts`, `note-storage.ts` |
| Source PDFs | `ingest.ts`, `page-scope.ts`, `figure-capture.ts`, `figure-coverage.ts` |
| Tool actions | `tool-actions/` |

Architecture narrative: `docs/architecture.md`. Note hierarchy: `docs/hierarchy.mmd`.

## Environment

- Poppler (`pdfinfo`, `pdftotext`, `pdftoppm`) must be on `PATH`. Windows may
  also fall back to Calibre's bundled copies.
- Interactive hosts must implement `getEditorComponent` / `setEditorComponent`.
  Scholar **refuses to start a protected operation** if it cannot install its
  chat lock rather than continuing unlocked. Only `hasUI: false` bypasses it.
- For unusual installs, point at the SDK with `PI_SCHOLAR_PI_PACKAGE`, and pick
  a specific extension with `PI_SCHOLAR_EXTENSION`.
- **Keep the global TypeScript on 5.x.** The language server is
  `typescript-language-server`, which drives TypeScript's JS `lib/tsserver.js`.
  TypeScript 7 dropped that file, and the server then fails at initialize with
  **no output on stdout or stderr and exit code 1** — a silent failure, not a
  visible error. Verify with
  `typescript-language-server --version` (expect a 6.x server driving a 5.x
  TypeScript).

## Privacy rules

The PDF stays in its configured library and is **never copied into Obsidian**.
Book text is read in bounded page ranges on demand — not pre-indexed into a
vector database. Model conversations and credentials are never written into
notes; reviewer findings live in the section note's collapsible details.

## Before any public release

`package.json` is `private` + `UNLICENSED`. The quiz adaptation's upstream
permission is unresolved and a license for Scholar's original work is unchosen.
Both must be settled and the notices/metadata updated first.
