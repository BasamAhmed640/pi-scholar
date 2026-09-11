# How Scholar fits together

Scholar is one Pi extension, not three separate agents or services. Learn,
Exam, and Tutor are independent entry points for the same selected PDF book.
You do not have to finish Learn before taking an Exam or opening Tutor.

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
revision checks protect committed work. `transcript-recovery.ts` reconciles
missed assistant events when a study target is explicitly reopened and after
active study turns; users do not need sync/backfill commands. Pi startup leaves
Scholar closed. Its inactive hooks do not access the vault or replace the editor.
An inactive Pi-session marker closes any old study transcript segment on resume.

## Where information lives

Both paths start blank and must be explicitly configured.

| Location | Responsibility |
| --- | --- |
| User-selected PDF library | Original PDF files; not a progress database |
| User-selected Obsidian vault | All durable Scholar book state, lessons, exams, tutoring records, notes and captured figures |
| `<vault>/Scholar/Books/<book>/.scholar/book.json` | Authoritative structured book state; the adjacent previous revision is recovery-only |
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
