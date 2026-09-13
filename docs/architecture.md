# How Scholar fits together

Scholar is one Pi extension. Learn,
Exam, and Tutor are independent entry points for the same selected PDF book.
You do not have to finish Learn before taking an Exam or opening Tutor.

New Learn delivery uses the selected Pi model as lead author and four independent
review responsibilities. Source, teaching and math/visual reviewers run after
the saved draft is prepared; the assessment reviewer checks a new proposed
question before the interactive form is persisted. These are fresh in-memory
conversations with scoped, read-only source/image tools, not extension-loaded
Pi sessions. They cannot access other modes' history, write notes, change progress,
run shell commands, or grade the learner. No fixed model/provider is assumed.

## The Obsidian hierarchy

The [README diagram](../README.md#your-learning-workspace) shows the visible
note hierarchy. Its editable Mermaid source is [hierarchy.mmd](hierarchy.mmd).
These are logical note relationships, not an extra set of folders to create.

- **Scholar Home** links the books in the selected vault.
- **Each book's actual title** is its hub: chapter notes, exams, and tutoring
  sessions link to that book.
- **Learn** keeps lessons, exact source figures, progress, and understanding
  checks in subsection notes beneath their chapters. Interactive answers are
  entered in Pi.
- **Exam** holds a complete paper answered in Obsidian. Explicit submission
  freezes the responses; grading produces the answer key and topic breakdown.
- **Tutor** keeps its own explanations, source figures, and practice record.
  Interactive answers are entered in Pi, as in Learn.

The modes share the PDF and its validated outline, not each other's learner
history. A Tutor answer does not change Learn progress, and Exam generation
does not use Learn or Tutor performance to alter the test.

## Code boundaries

`learn-quality.ts` defines coverage and review contracts. `equation-presentation.ts`
builds equation callouts from validated fields and explicit placement markers.
`learn-review.ts` binds reviewers to the saved section and its source evidence;
`review-runtime.ts` bounds their tool loops and uses Pi's active model registry,
authentication and supported reasoning interface. Source review must actually
read every scoped page; visual review must see each full page and saved crop.
Large visual sets are inspected in sequential batches to avoid silently dropping
images from context. The model still judges semantic fidelity and readability.

`tool-controller.ts` alone saves review receipts and commits approved delivery.
Network review runs outside the book's mutation queue. It then reloads and checks
the active vault/section, source identity, actual figure bytes and the exact draft
hash before saving approval. The hash includes the lesson, coverage, recap,
assessment plan and figure metadata. Changed content invalidates approval.
Reviewer findings live in the same section note's collapsible details; model
conversations and credentials are never written there. New Learn authoring
activates this contract automatically; legacy delivered lessons remain usable.
Once reviewed delivery and every required mastery check pass, a small earned
delivery receipt preserves that achievement through later practice annotations.
It is bound to the source, section scope and assessment plan. Deleting mastery
answers still removes their evidence; adding a clarification does not erase them.

Explicit lesson delivery uses `lesson.ts` and `lesson-figures.ts`. `notes.lesson`
saves instructional Markdown once in the visible section or Tutor note; its small
receipt associates that text with objectives, key points and source pages. Stable
entry IDs prevent duplicate retries. IDs of deleted entries remain in the same
note's details solely to reject stale retries; they contain no lesson text.
An intentional revision first reads `status` with `lessonId`, then supplies the
current `expectedContentHash`. User edits cannot be overwritten by a stale save.

Learn's `lessonComplete` commit fingerprints the saved explanation and objective
check plan. Editing or deleting its explanation invalidates readiness for new
confirmation questions. Both question formats use this gate. Source inspection
and source-figure files are checked on commitment; this step does not award mastery.
The per-objective checks require evidence for that objective and kind, rather than
borrowing a passing conceptual answer from another topic. One mastery MCQ targets
one objective; integrated open questions may assess several with explicit evidence.

`open-assessment.ts` binds a response to the current book, mode, question, scoring
contract and input turn. Typed evidence must occur in the actual response; image
references must name an attached image. These checks cannot judge whether a quote
or drawing demonstrates the claimed concept. The model evaluates that meaning.
Raw responses, attachment bytes and evidence excerpts are not copied into Scholar
notes. Only the submission fingerprint, criterion outcomes and derived feedback
are retained. On restart, unanswered questions resume; an ungraded answer must be
submitted again. Exam continues to use its own explicit submission and frozen form.

Prompt policies are authoring guidance. Code verifies state, source scope, saved
content, references and response binding; a real generated lesson still needs
review for accuracy, understandable terminology and connected reasoning.

```mermaid
flowchart TB
    PI(["Pi host"])
    ENTRY["Lifecycle and commands<br/>index.ts · commands.ts"]
    RUNTIME["Mode coordination and input lock<br/>runtime-coordinator.ts · input-lock.ts"]
    TOOLS["Tool contracts and action handlers<br/>tool-controller.ts · tool-actions/"]
    ENGINES["Shared engine guidance<br/>policies.ts"]
    RULES["Domain rules<br/>Scope, grounding and validation"]
    PDF["PDF access<br/>ingest.ts · Poppler"]
    SAVE["Validated book updates<br/>book-service.ts · storage.ts"]
    NOTES["Obsidian projection<br/>obsidian.ts · render/"]
    VAULT[("User-selected vault<br/>Book state, notes and figures")]

    PI --> ENTRY --> RUNTIME --> TOOLS
    ENGINES -.-> RUNTIME
    TOOLS --> RULES
    TOOLS --> PDF
    TOOLS --> SAVE
    SAVE --> NOTES
    SAVE --> VAULT
    NOTES --> VAULT
```

The arrows summarize responsibilities rather than every import or event.
There is deliberately one definition of each engine:

| Shared policy | Learn | Exam | Tutor |
| --- | --- | --- | --- |
| Teaching Engine | Yes | No | Yes |
| Question Engine | Yes | Yes | Yes |

`modes.ts` defines capabilities, `types.ts` defines shared contracts, and
`state-schema.ts` validates persisted records. Durable-history checks and
revision checks protect committed work. `note-storage.ts` reloads the visible records before each operation.
Conversation history cannot restore deleted note content. Pi startup leaves
Scholar closed. Its inactive hooks do not access the vault or replace the editor.
An inactive Pi-session marker closes any old study transcript segment on resume.

## Where information lives

Both paths start blank and must be explicitly configured.

| Location | Responsibility |
| --- | --- |
| User-selected PDF library | Original PDF files; not a progress database |
| User-selected Obsidian vault | All durable Scholar book state, lessons, exams, tutoring records, notes and captured figures |
| Book, section, Tutor and Exam Markdown notes | Authoritative study records with inspectable same-note details |
| `Scholar/Scholar Settings.md` | Visible vault settings and source catalog |
| Local Scholar configuration | Pointer to the chosen vault, not a second book database |
| Pi process memory | Temporary active mode, input locks and pending work |

Pi's own chat/session storage is host-managed and separate from Scholar's book
authority. Deleting a book's workspace from the vault means it no longer exists
to Scholar. Opening its PDF again starts a fresh import; switching vaults does
not copy learning history.

## Source-only repository

This repository contains implementation, CSS, documentation and synthetic tests.
It must not contain PDFs, personal vaults, exam responses, credentials, session
logs, dependencies or machine-specific configuration. Runtime use adds no npm
dependencies; developer tests have their own pinned dependency.

Public redistribution is not yet cleared; see
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). The diagram documents the
current system, not a claim of cross-platform validation or release readiness.
