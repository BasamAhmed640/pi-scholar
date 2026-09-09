import { extensionPath as packagedExtensionPath, piPackageRoot as sdkRoot, jitiPath as sdkJitiPath, resolvePiDependency } from "./sdk.mjs";
// Focused verification suite for Scholar transcript recovery & routing (Stage 2)
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = sdkRoot;
const { createJiti } = await import(pathToFileURL(sdkJitiPath).href);
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: {
    "@earendil-works/pi-coding-agent": join(packageRoot, "dist", "index.js"),
  },
});

const extensionRoot = dirname(packagedExtensionPath);
const {
  freezeRecoveryTarget,
  freezeExplicitTarget,
  recoverTranscriptTarget,
  isSameVaultPath,
} = await jiti.import(join(extensionRoot, "transcript-recovery.ts"));
const { SCHOLAR_SESSION_STATE_TYPE } = await jiti.import(join(extensionRoot, "runtime-session.ts"));
const { SCHOLAR_QUIZ_TOOL_NAME } = await jiti.import(join(extensionRoot, "quiz-contract.ts"));
const { appendTranscript, messageTranscriptEntry } = await jiti.import(join(extensionRoot, "domain.ts"));

function createTestBook(id = "a".repeat(64), instanceId = "instance-test-1") {
  return {
    schemaVersion: 3,
    revision: 1,
    id,
    instanceId,
    source: {
      absolutePath: "C:/fake/book.pdf",
      relativePath: "book.pdf",
      fileName: "book.pdf",
      format: "pdf",
      fingerprint: { sha256: id, size: 1024, mtimeMs: 12345 },
    },
    metadata: { title: "Test Book", authors: ["Author"] },
    outlineStatus: "ready",
    chapters: [{
      id: "chapter-1",
      number: "1",
      title: "Chapter 1",
      order: 1,
      startPage: 1,
      endPage: 20,
      sections: [
        {
          id: "sec-1",
          number: "1.1",
          title: "Section 1",
          order: 1,
          startPage: 1,
          endPage: 10,
          status: "learning",
          progress: 0,
          objectives: ["Obj 1"],
          coveredObjectives: [],
          requiredChecks: ["conceptual"],
          keyPoints: ["Point 1"],
          misconceptions: [],
          attempts: [],
          transcript: [],
          snapshots: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "sec-2",
          number: "1.2",
          title: "Section 2",
          order: 2,
          startPage: 11,
          endPage: 20,
          status: "learning",
          progress: 0,
          objectives: ["Obj 2"],
          coveredObjectives: [],
          requiredChecks: ["conceptual"],
          keyPoints: ["Point 2"],
          misconceptions: [],
          attempts: [],
          transcript: [],
          snapshots: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }],
    exams: [{
      id: "exam-1",
      title: "Exam 1",
      scope: { chapterIds: ["chapter-1"], sectionIds: ["sec-1"], description: "Exam 1" },
      status: "active",
      questions: [],
      rawResponses: [],
      itemResults: [],
      breakdown: [],
      earnedPoints: 0,
      maxPoints: 0,
      percent: 0,
      transcript: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }],
    tutorSessions: [{
      id: "tutor-1",
      title: "Tutor 1",
      scope: { chapterIds: ["chapter-1"], sectionIds: ["sec-1"], description: "Tutor 1" },
      status: "active",
      keyPoints: ["Keypoint 1"],
      attempts: [],
      transcript: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }],
    noteDirectory: "test-book-notes",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// 9. A missed assistant message is recovered once on resume; a second resume is a no-op.
test("Req 9: missed assistant message is recovered once on resume; second resume is a no-op", async () => {
  const book = createTestBook();
  let savedBook = structuredClone(book);
  const target = {
    vaultPath: "C:/Vault",
    bookId: book.id,
    instanceId: book.instanceId,
    mode: "learn",
    recordId: "sec-1",
  };

  const branch = [
    {
      id: "entry-0",
      type: "custom",
      customType: SCHOLAR_SESSION_STATE_TYPE,
      data: { active: true, vaultPath: "C:/Vault", bookId: book.id, instanceId: book.instanceId, mode: "learn", recordId: "sec-1" },
    },
    {
      id: "entry-1",
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Important lesson content." }],
        timestamp: 1700000000000,
      },
    },
  ];

  const mutateBook = async (id, mutator) => {
    mutator(savedBook);
    savedBook.revision++;
    return { book: savedBook, result: undefined, projectionStatus: "synced" };
  };
  const loadBook = async () => structuredClone(savedBook);

  const res1 = await recoverTranscriptTarget({ target, branch, loadBook, mutateBook, isAutomatic: true });
  assert.equal(res1.kind, "success");
  assert.equal(res1.writtenCount, 1);
  assert.equal(savedBook.chapters[0].sections[0].transcript.length, 1);
  assert.equal(savedBook.chapters[0].sections[0].transcript[0].markdown, "Important lesson content.");
  assert.ok(savedBook.recoveryCheckpoints?.["learn:sec-1"]);
  assert.equal(savedBook.recoveryCheckpoints["learn:sec-1"].lastProcessedEntryId, "entry-1");
  const revAfterFirst = savedBook.revision;

  const res2 = await recoverTranscriptTarget({ target, branch, loadBook, mutateBook, isAutomatic: true });
  assert.equal(res2.kind, "noop");
  assert.equal(savedBook.revision, revAfterFirst, "Revision must not bump on no-op recovery");
});

// 10. Live capture followed by recovery does not duplicate the same response or quiz result.
test("Req 10: live capture followed by recovery does not duplicate response or quiz result", async () => {
  const book = createTestBook();
  const target = {
    vaultPath: "C:/Vault",
    bookId: book.id,
    instanceId: book.instanceId,
    mode: "learn",
    recordId: "sec-1",
  };

  const assistantMsg = {
    role: "assistant",
    content: [{ type: "text", text: "Already captured lesson." }],
    timestamp: 1700000000000,
  };
  const liveEntry = messageTranscriptEntry(assistantMsg, "entry-1");
  appendTranscript(book.chapters[0].sections[0].transcript, liveEntry);

  let savedBook = structuredClone(book);
  const mutateBook = async (id, mutator) => {
    mutator(savedBook);
    savedBook.revision++;
    return { book: savedBook, result: undefined, projectionStatus: "synced" };
  };
  const loadBook = async () => structuredClone(savedBook);

  const branch = [
    {
      id: "entry-0",
      type: "custom",
      customType: SCHOLAR_SESSION_STATE_TYPE,
      data: { active: true, vaultPath: "C:/Vault", bookId: book.id, instanceId: book.instanceId, mode: "learn", recordId: "sec-1" },
    },
    {
      id: "entry-1",
      type: "message",
      message: assistantMsg,
    },
  ];

  const res = await recoverTranscriptTarget({ target, branch, loadBook, mutateBook, isAutomatic: true });
  assert.equal(res.kind, "noop");
  assert.equal(savedBook.chapters[0].sections[0].transcript.length, 1);
  assert.equal(savedBook.revision, 1, "Revision unchanged when already up to date");
});

// 11. History beyond the former cap is retained without repeated reinsertion.
test("Req 11: long history remains durable and recovery is idempotent", async () => {
  const book = createTestBook();
  const section = book.chapters[0].sections[0];
  for (let i = 0; i < 60; i++) {
    section.transcript.push({
      id: `old-${i}`,
      kind: "assistant",
      markdown: `Old ${i}`,
      createdAt: new Date(1700000000000 + i * 1000).toISOString(),
    });
  }
  book.recoveryCheckpoints = {
    "learn:sec-1": {
      lastProcessedEntryId: "entry-59",
      updatedAt: new Date().toISOString(),
    },
  };

  let savedBook = structuredClone(book);
  const mutateBook = async (id, mutator) => {
    mutator(savedBook);
    savedBook.revision++;
    return { book: savedBook, result: undefined, projectionStatus: "synced" };
  };
  const loadBook = async () => structuredClone(savedBook);

  const branch = [
    {
      id: "entry-0",
      type: "custom",
      customType: SCHOLAR_SESSION_STATE_TYPE,
      data: { active: true, vaultPath: "C:/Vault", bookId: book.id, instanceId: book.instanceId, mode: "learn", recordId: "sec-1" },
    },
  ];
  for (let i = 1; i <= 65; i++) {
    branch.push({
      id: `entry-${i}`,
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: `Msg ${i}` }], timestamp: 1700000000000 + i * 1000 },
    });
  }

  const target = {
    vaultPath: "C:/Vault",
    bookId: book.id,
    instanceId: book.instanceId,
    mode: "learn",
    recordId: "sec-1",
  };

  const res1 = await recoverTranscriptTarget({ target, branch, loadBook, mutateBook, isAutomatic: true });
  assert.equal(res1.kind, "success");
  assert.equal(res1.writtenCount, 6);
  assert.equal(savedBook.chapters[0].sections[0].transcript.length, 66, "Retains all original and recovered entries");
  assert.equal(savedBook.chapters[0].sections[0].transcript[0].markdown, "Old 0");
  assert.equal(savedBook.recoveryCheckpoints["learn:sec-1"].lastProcessedEntryId, "entry-65");

  const res2 = await recoverTranscriptTarget({ target, branch, loadBook, mutateBook, isAutomatic: true });
  assert.equal(res2.kind, "noop");
});

// 12. A transient save failure leaves the checkpoint unchanged; recovery succeeds after storage recovers.
test("Req 12: transient save failure leaves checkpoint unchanged; recovery succeeds after storage recovers", async () => {
  const book = createTestBook();
  let savedBook = structuredClone(book);
  let shouldFail = true;

  const mutateBook = async (id, mutator) => {
    if (shouldFail) throw new Error("EACCES: disk write error");
    mutator(savedBook);
    savedBook.revision++;
    return { book: savedBook, result: undefined, projectionStatus: "synced" };
  };
  const loadBook = async () => structuredClone(savedBook);

  const target = {
    vaultPath: "C:/Vault",
    bookId: book.id,
    instanceId: book.instanceId,
    mode: "learn",
    recordId: "sec-1",
  };

  const branch = [
    {
      id: "entry-0",
      type: "custom",
      customType: SCHOLAR_SESSION_STATE_TYPE,
      data: { active: true, vaultPath: "C:/Vault", bookId: book.id, instanceId: book.instanceId, mode: "learn", recordId: "sec-1" },
    },
    {
      id: "entry-1",
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "Missed lesson." }], timestamp: 1700000000000 },
    },
  ];

  await assert.rejects(
    async () => recoverTranscriptTarget({ target, branch, loadBook, mutateBook, isAutomatic: true }),
    /EACCES/,
  );
  assert.equal(savedBook.recoveryCheckpoints, undefined, "Checkpoint must remain undefined on failure");

  shouldFail = false;
  const res = await recoverTranscriptTarget({ target, branch, loadBook, mutateBook, isAutomatic: true });
  assert.equal(res.kind, "success");
  assert.equal(res.writtenCount, 1);
  assert.equal(savedBook.recoveryCheckpoints["learn:sec-1"].lastProcessedEntryId, "entry-1");
});

// 13. Out-of-order/incomplete quiz events do not advance recovery beyond needed data or publish an unearned answer key.
test("Req 13: incomplete quiz event does not advance checkpoint past unresolved toolCall", async () => {
  const book = createTestBook();
  let savedBook = structuredClone(book);
  const mutateBook = async (id, mutator) => {
    mutator(savedBook);
    savedBook.revision++;
    return { book: savedBook, result: undefined, projectionStatus: "synced" };
  };
  const loadBook = async () => structuredClone(savedBook);

  const target = {
    vaultPath: "C:/Vault",
    bookId: book.id,
    instanceId: book.instanceId,
    mode: "learn",
    recordId: "sec-1",
  };

  const branch = [
    {
      id: "entry-0",
      type: "custom",
      customType: SCHOLAR_SESSION_STATE_TYPE,
      data: { active: true, vaultPath: "C:/Vault", bookId: book.id, instanceId: book.instanceId, mode: "learn", recordId: "sec-1" },
    },
    {
      id: "entry-1",
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Check your understanding." },
          { type: "toolCall", id: "call-1", name: SCHOLAR_QUIZ_TOOL_NAME, arguments: { question: "What is 2+2?" } },
        ],
        timestamp: 1700000000000,
      },
    },
  ];

  const res = await recoverTranscriptTarget({ target, branch, loadBook, mutateBook, isAutomatic: true });
  assert.equal(res.kind, "noop");
  assert.equal(savedBook.recoveryCheckpoints, undefined, "Must not advance checkpoint past unresolved toolCall");
});

// 14. Shuffled MCQ feedback matches the displayed answer; cancellation/error leaks no key.
test("Req 14: shuffled MCQ matches displayed answer; cancellation/error leaks no key", async () => {
  const book = createTestBook();
  const section = book.chapters[0].sections[0];
  section.attempts.push({
    id: "quiz-call-err",
    toolCallId: "call-err",
    kind: "quiz",
    format: "multiple-choice",
    question: "Test question",
    grounding: { purpose: "diagnostic", chapterId: "chapter-1", sectionId: "sec-1" },
    outcome: "pending",
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  let savedBook = structuredClone(book);
  const mutateBook = async (id, mutator) => {
    mutator(savedBook);
    savedBook.revision++;
    return { book: savedBook, result: undefined, projectionStatus: "synced" };
  };
  const loadBook = async () => structuredClone(savedBook);

  const target = {
    vaultPath: "C:/Vault",
    bookId: book.id,
    instanceId: book.instanceId,
    mode: "learn",
    recordId: "sec-1",
  };

  const branch = [
    {
      id: "entry-0",
      type: "custom",
      customType: SCHOLAR_SESSION_STATE_TYPE,
      data: { active: true, vaultPath: "C:/Vault", bookId: book.id, instanceId: book.instanceId, mode: "learn", recordId: "sec-1" },
    },
    {
      id: "entry-1",
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call-err", name: SCHOLAR_QUIZ_TOOL_NAME, arguments: { question: "Q1" } },
        ],
        timestamp: 1700000000000,
      },
    },
    {
      id: "entry-2",
      type: "message",
      message: {
        role: "toolResult",
        toolName: SCHOLAR_QUIZ_TOOL_NAME,
        toolCallId: "call-err",
        isError: true,
        details: { status: "unavailable", message: "User cancelled" },
        timestamp: 1700000001000,
      },
    },
  ];

  const res = await recoverTranscriptTarget({ target, branch, loadBook, mutateBook, isAutomatic: true });
  assert.equal(res.kind, "success");
  const att = savedBook.chapters[0].sections[0].attempts[0];
  assert.equal(att.outcome, "unavailable");
  assert.equal(att.correctAnswer, undefined, "Error/cancellation must never leak answer key");
  const lastResult = savedBook.chapters[0].sections[0].transcript.find((t) => t.id === "quiz-result-call-err");
  assert.ok(!lastResult.markdown.includes("Correct answer:"), "Result markdown must not leak answer key");
});

// 15. Learn A -> Tutor B -> Learn C, close/reopen, and vault changes do not mix transcripts.
test("Req 15: mode switching and vault boundaries do not mix transcripts", async () => {
  const book = createTestBook();
  let savedBook = structuredClone(book);
  const mutateBook = async (id, mutator) => {
    mutator(savedBook);
    savedBook.revision++;
    return { book: savedBook, result: undefined, projectionStatus: "synced" };
  };
  const loadBook = async () => structuredClone(savedBook);

  const branch = [
    // Learn sec-1
    {
      id: "p-learn-1",
      type: "custom",
      customType: SCHOLAR_SESSION_STATE_TYPE,
      data: { active: true, vaultPath: "C:/Vault", bookId: book.id, instanceId: book.instanceId, mode: "learn", recordId: "sec-1" },
    },
    {
      id: "m-learn-1",
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "Text for Sec 1" }], timestamp: 1700000000000 },
    },
    // Tutor tutor-1
    {
      id: "p-tutor",
      type: "custom",
      customType: SCHOLAR_SESSION_STATE_TYPE,
      data: { active: true, vaultPath: "C:/Vault", bookId: book.id, instanceId: book.instanceId, mode: "tutor", recordId: "tutor-1" },
    },
    {
      id: "m-tutor",
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "Text for Tutor" }], timestamp: 1700000001000 },
    },
    // Learn sec-2
    {
      id: "p-learn-2",
      type: "custom",
      customType: SCHOLAR_SESSION_STATE_TYPE,
      data: { active: true, vaultPath: "C:/Vault", bookId: book.id, instanceId: book.instanceId, mode: "learn", recordId: "sec-2" },
    },
    {
      id: "m-learn-2",
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "Text for Sec 2" }], timestamp: 1700000002000 },
    },
  ];

  // Target Learn sec-2
  const targetSec2 = { vaultPath: "C:/Vault", bookId: book.id, instanceId: book.instanceId, mode: "learn", recordId: "sec-2" };
  const resSec2 = await recoverTranscriptTarget({ target: targetSec2, branch, loadBook, mutateBook, isAutomatic: true });
  assert.equal(resSec2.kind, "success");
  const sec2Transcript = savedBook.chapters[0].sections[1].transcript;
  assert.equal(sec2Transcript.length, 1);
  assert.equal(sec2Transcript[0].markdown, "Text for Sec 2");

  // Sec 1 transcript must remain empty
  assert.equal(savedBook.chapters[0].sections[0].transcript.length, 0);
  // Tutor transcript must remain empty
  assert.equal(savedBook.tutorSessions[0].transcript.length, 0);
});

// 16. Book deleted/recreated from the same PDF with a new instance ID: no resurrection or old-history import.
test("Req 16: book recreated with new instance ID does not resurrect or import old history", async () => {
  const book = createTestBook();
  let savedBook = structuredClone(book);
  const mutateBook = async (id, mutator) => {
    mutator(savedBook);
    return { book: savedBook, result: undefined, projectionStatus: "synced" };
  };
  const loadBook = async () => structuredClone(savedBook);

  const targetWithNewInstance = {
    vaultPath: "C:/Vault",
    bookId: book.id,
    instanceId: "instance-new-2",
    mode: "learn",
    recordId: "sec-1",
  };

  const branch = [
    {
      id: "entry-0",
      type: "custom",
      customType: SCHOLAR_SESSION_STATE_TYPE,
      data: { active: true, vaultPath: "C:/Vault", bookId: book.id, instanceId: "instance-old-1", mode: "learn", recordId: "sec-1" },
    },
    {
      id: "entry-1",
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "Old history." }], timestamp: 1700000000000 },
    },
  ];

  const res = await recoverTranscriptTarget({ target: targetWithNewInstance, branch, loadBook, mutateBook, isAutomatic: true });
  assert.equal(res.kind, "skipped");
  assert.equal(savedBook.chapters[0].sections[0].transcript.length, 0, "No old history must be imported into new instance");
});

// 17. Fork/compaction/missing checkpoint/legacy ambiguous pointer: safe skip, not full-history ingestion.
test("Req 17: compaction missing checkpoint or legacy pointer without vaultPath causes safe skip", async () => {
  const book = createTestBook();
  book.recoveryCheckpoints = {
    "learn:sec-1": {
      lastProcessedEntryId: "entry-missing-after-compaction",
      updatedAt: new Date().toISOString(),
    },
  };
  let savedBook = structuredClone(book);
  const mutateBook = async (id, mutator) => {
    mutator(savedBook);
    return { book: savedBook, result: undefined, projectionStatus: "synced" };
  };
  const loadBook = async () => structuredClone(savedBook);

  const target = {
    vaultPath: "C:/Vault",
    bookId: book.id,
    instanceId: book.instanceId,
    mode: "learn",
    recordId: "sec-1",
  };

  const branchWithCompactedHistory = [
    {
      id: "entry-0",
      type: "custom",
      customType: SCHOLAR_SESSION_STATE_TYPE,
      data: { active: true, vaultPath: "C:/Vault", bookId: book.id, instanceId: book.instanceId, mode: "learn", recordId: "sec-1" },
    },
    {
      id: "entry-recent",
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "Recent msg" }], timestamp: 1700000000000 },
    },
  ];

  const resCompacted = await recoverTranscriptTarget({ target, branch: branchWithCompactedHistory, loadBook, mutateBook, isAutomatic: true });
  assert.equal(resCompacted.kind, "skipped");
  assert.equal(resCompacted.reason, "checkpoint-entry-missing-after-compaction-or-fork");

  // Legacy pointer without vaultPath skipped automatically
  delete savedBook.recoveryCheckpoints;
  const legacyBranch = [
    {
      id: "entry-0",
      type: "custom",
      customType: SCHOLAR_SESSION_STATE_TYPE,
      data: { active: true, bookId: book.id, instanceId: book.instanceId, mode: "learn", recordId: "sec-1" },
    },
    {
      id: "entry-1",
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "Legacy msg" }], timestamp: 1700000000000 },
    },
  ];

  const resLegacyAuto = await recoverTranscriptTarget({ target, branch: legacyBranch, loadBook, mutateBook, isAutomatic: true });
  assert.equal(resLegacyAuto.kind, "skipped");
  assert.equal(resLegacyAuto.reason, "legacy-pointer-ambiguous");

  // Manual backfill allowed for legacy pointer
  const resLegacyManual = await recoverTranscriptTarget({ target, branch: legacyBranch, loadBook, mutateBook, isAutomatic: false });
  assert.equal(resLegacyManual.kind, "success");
  assert.equal(resLegacyManual.writtenCount, 1);
});

// 18. Completed lesson or graded exam can recover eligible final content without reopening its mode; exam privacy remains intact.
test("Req 18: completed lesson or graded exam recovers final content without reopening; exam privacy intact", async () => {
  const book = createTestBook();
  const section = book.chapters[0].sections[0];
  section.status = "complete";

  const exam = book.exams[0];
  exam.status = "active";

  let savedBook = structuredClone(book);
  const mutateBook = async (id, mutator) => {
    mutator(savedBook);
    savedBook.revision++;
    return { book: savedBook, result: undefined, projectionStatus: "synced" };
  };
  const loadBook = async () => structuredClone(savedBook);

  // Case A: completed section recovers final wrap-up prose
  const targetLearn = { vaultPath: "C:/Vault", bookId: book.id, instanceId: book.instanceId, mode: "learn", recordId: "sec-1" };
  const branchLearn = [
    {
      id: "p-1",
      type: "custom",
      customType: SCHOLAR_SESSION_STATE_TYPE,
      data: { active: true, vaultPath: "C:/Vault", bookId: book.id, instanceId: book.instanceId, mode: "learn", recordId: "sec-1" },
    },
    {
      id: "m-final",
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "Congratulations on completing section 1.1!" }], timestamp: 1700000000000 },
    },
  ];

  const resLearn = await recoverTranscriptTarget({ target: targetLearn, branch: branchLearn, loadBook, mutateBook, isAutomatic: true });
  assert.equal(resLearn.kind, "success");
  assert.equal(savedBook.chapters[0].sections[0].status, "complete", "Must not reactivate complete lesson");
  assert.equal(savedBook.chapters[0].sections[0].transcript[0].markdown, "Congratulations on completing section 1.1!");

  // Case B: active exam leaks NO transcript prose
  const targetExam = { vaultPath: "C:/Vault", bookId: book.id, instanceId: book.instanceId, mode: "exam", recordId: "exam-1" };
  const branchExam = [
    {
      id: "p-exam",
      type: "custom",
      customType: SCHOLAR_SESSION_STATE_TYPE,
      data: { active: true, vaultPath: "C:/Vault", bookId: book.id, instanceId: book.instanceId, mode: "exam", recordId: "exam-1" },
    },
    {
      id: "m-exam-gen",
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "Generating exam questions with secret rubric..." }], timestamp: 1700000000000 },
    },
  ];

  const resExamActive = await recoverTranscriptTarget({ target: targetExam, branch: branchExam, loadBook, mutateBook, isAutomatic: true });
  assert.equal(resExamActive.kind, "noop");
  assert.equal(savedBook.exams[0].transcript.length, 0, "Active exam must never leak transcript content");

  // Case C: graded exam recovers grading feedback
  savedBook.exams[0].status = "graded";
  savedBook.exams[0].gradedAt = "2026-01-01T00:00:00.000Z";
  const resExamGraded = await recoverTranscriptTarget({ target: targetExam, branch: branchExam, loadBook, mutateBook, isAutomatic: true });
  assert.equal(resExamGraded.kind, "success");
  assert.equal(savedBook.exams[0].transcript.length, 1);
});

// 20. Simultaneous live and recovery callbacks remain idempotent under revision checks.
test("Req 20: concurrent live and recovery attempts remain idempotent", async () => {
  const book = createTestBook();
  let savedBook = structuredClone(book);
  let revision = 1;

  // Queue to simulate serialized storage mutation lock
  let lock = Promise.resolve();
  const mutateBook = async (id, mutator) => {
    return new Promise((resolve, reject) => {
      lock = lock.then(async () => {
        try {
          mutator(savedBook);
          revision++;
          savedBook.revision = revision;
          resolve({ book: savedBook, result: undefined, projectionStatus: "synced" });
        } catch (e) {
          reject(e);
        }
      });
    });
  };
  const loadBook = async () => structuredClone(savedBook);

  const target = {
    vaultPath: "C:/Vault",
    bookId: book.id,
    instanceId: book.instanceId,
    mode: "learn",
    recordId: "sec-1",
  };

  const branch = [
    {
      id: "entry-0",
      type: "custom",
      customType: SCHOLAR_SESSION_STATE_TYPE,
      data: { active: true, vaultPath: "C:/Vault", bookId: book.id, instanceId: book.instanceId, mode: "learn", recordId: "sec-1" },
    },
    {
      id: "entry-1",
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "Concurrent msg" }], timestamp: 1700000000000 },
    },
  ];

  // Run two recoveries in parallel
  const [r1, r2] = await Promise.all([
    recoverTranscriptTarget({ target, branch, loadBook, mutateBook, isAutomatic: true }),
    recoverTranscriptTarget({ target, branch, loadBook, mutateBook, isAutomatic: true }),
  ]);

  const successes = [r1, r2].filter((r) => r.kind === "success").length;
  const noops = [r1, r2].filter((r) => r.kind === "noop").length;
  assert.equal(successes, 1, "Exactly one recovery should write content");
  assert.equal(noops, 1, "Second concurrent recovery should see noop");
  assert.equal(savedBook.chapters[0].sections[0].transcript.length, 1);
});

let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`[PASS] ${t.name}`);
    passed++;
  } catch (err) {
    console.error(`[FAIL] ${t.name}`);
    console.error(err);
    failed++;
  }
}

console.log(`\nScholar transcript recovery summary: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
