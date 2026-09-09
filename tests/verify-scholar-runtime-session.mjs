import { extensionPath as packagedExtensionPath, piPackageRoot as sdkRoot, jitiPath as sdkJitiPath, resolvePiDependency } from "./sdk.mjs";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const requestedExtension = resolve(
  process.env.PI_SCHOLAR_EXTENSION
    || packagedExtensionPath,
);
const extensionDirectory = basename(requestedExtension).toLowerCase() === "index.ts"
  ? dirname(requestedExtension)
  : requestedExtension;
const modulePath = resolve(
  process.env.PI_SCHOLAR_RUNTIME_SESSION
    || join(extensionDirectory, "runtime-session.ts"),
);
const {
  SCHOLAR_SESSION_STATE_TYPE,
  ScholarRuntimeSession,
  reconcileScholarRuntimeTarget,
  scholarSessionPointerKey,
} = await import(pathToFileURL(modulePath).href);

const book = { id: "book-1", instanceId: "instance-1", currentSectionId: "section-1" };
const session = new ScholarRuntimeSession();

assert.deepEqual(session.state, { kind: "inactive" });
assert.deepEqual(session.serialize(), { active: false });

session.activate(book.id);
assert.deepEqual(session.state, { kind: "selected", bookId: book.id });
assert.deepEqual(session.serialize(book), {
  active: true,
  bookId: book.id,
  instanceId: book.instanceId,
});

assert.throws(
  () => session.activate(book.id, "learn"),
  /requires an exact target record/,
);
session.activate(book.id, "learn", book.currentSectionId);
assert.deepEqual(session.serialize(book), {
  active: true,
  bookId: book.id,
  instanceId: book.instanceId,
  mode: "learn",
  recordId: book.currentSectionId,
  sectionId: book.currentSectionId,
});

const appended = [];
assert.equal(session.persist(book, (pointer) => appended.push(pointer)), true);
assert.equal(session.persist(book, (pointer) => appended.push(pointer)), false);
assert.equal(appended.length, 1);

session.activate(book.id, "exam", "exam-1");
assert.deepEqual(session.serialize(book), {
  active: true,
  bookId: book.id,
  instanceId: book.instanceId,
  mode: "exam",
  recordId: "exam-1",
});
assert.equal(session.persist(book, (pointer) => appended.push(pointer)), true);

session.deactivate();
assert.deepEqual(session.serialize(book), { active: false });
assert.equal(session.persist(undefined, (pointer) => appended.push(pointer)), true);
assert.equal(session.persist(undefined, (pointer) => appended.push(pointer)), false);

const branch = [
  { type: "custom", customType: SCHOLAR_SESSION_STATE_TYPE, data: { active: true, bookId: "old", mode: "tutor", recordId: "old-tutor" } },
  { type: "message" },
  {
    type: "custom",
    customType: SCHOLAR_SESSION_STATE_TYPE,
    data: {
      active: true,
      bookId: book.id,
      instanceId: book.instanceId,
      mode: "learn",
      sectionId: "restored-section",
    },
  },
];
const restored = session.restore(branch);
assert.deepEqual(restored, { found: true, instanceId: book.instanceId, sectionId: "restored-section" });
assert.deepEqual(session.state, { kind: "learn", bookId: book.id, recordId: "restored-section" });
const restoredKey = session.seedPersistedKey(book, restored.sectionId);
assert.equal(restoredKey, scholarSessionPointerKey({
  active: true,
  bookId: book.id,
  instanceId: book.instanceId,
  mode: "learn",
  recordId: "restored-section",
  sectionId: "restored-section",
}));

const targetlessMode = session.restore([{
  type: "custom",
  customType: SCHOLAR_SESSION_STATE_TYPE,
  data: { active: true, bookId: book.id, instanceId: book.instanceId, mode: "exam" },
}]);
assert.deepEqual(targetlessMode, { found: true, instanceId: book.instanceId });
assert.deepEqual(session.state, { kind: "selected", bookId: book.id });

const malformed = session.restore([{
  type: "custom",
  customType: SCHOLAR_SESSION_STATE_TYPE,
  data: { active: true, mode: "exam", recordId: "orphan" },
}]);
assert.deepEqual(malformed, { found: true });
assert.deepEqual(session.state, { kind: "inactive" });

const inactive = session.restore([{
  type: "custom",
  customType: SCHOLAR_SESSION_STATE_TYPE,
  data: { active: false, bookId: "ignored", mode: "tutor", recordId: "ignored" },
}]);
assert.deepEqual(inactive, { found: true });
assert.deepEqual(session.serialize(book), { active: false });

const timestamp = "2026-01-01T00:00:00.000Z";
const section = (id, status = "learning") => ({
  id,
  order: 1,
  number: "1.1",
  title: "Runtime target",
  startPage: 1,
  endPage: 1,
  objectives: ["Reconcile an exact target."],
  coveredObjectives: [],
  requiredChecks: ["conceptual"],
  status,
  keyPoints: [],
  misconceptions: [],
  attempts: [],
  transcript: [],
  createdAt: timestamp,
  updatedAt: timestamp,
});
const authority = {
  id: book.id,
  instanceId: book.instanceId,
  outlineStatus: "ready",
  chapters: [{ id: "chapter-1", sections: [section("section-1")] }],
  exams: [{ id: "exam-1", status: "active" }],
  tutorSessions: [{ id: "tutor-1", status: "active" }],
};

assert.deepEqual(
  reconcileScholarRuntimeTarget({ kind: "inactive" }, undefined, undefined),
  { kind: "inactive", state: { kind: "inactive" } },
);
assert.deepEqual(
  reconcileScholarRuntimeTarget({ kind: "selected", bookId: book.id }, undefined, book.instanceId),
  { kind: "invalid", reason: "book-missing", state: { kind: "inactive" } },
);
assert.deepEqual(
  reconcileScholarRuntimeTarget({ kind: "selected", bookId: book.id }, authority, undefined),
  { kind: "invalid", reason: "instance-missing", state: { kind: "inactive" } },
);
assert.deepEqual(
  reconcileScholarRuntimeTarget({ kind: "selected", bookId: book.id }, authority, "reimported-instance"),
  { kind: "invalid", reason: "instance-mismatch", state: { kind: "inactive" } },
);
assert.deepEqual(
  reconcileScholarRuntimeTarget({ kind: "selected", bookId: "different-book" }, authority, book.instanceId),
  { kind: "invalid", reason: "book-id-mismatch", state: { kind: "inactive" } },
);
assert.deepEqual(
  reconcileScholarRuntimeTarget({ kind: "selected", bookId: book.id }, authority, book.instanceId),
  { kind: "selected", state: { kind: "selected", bookId: book.id } },
);

const pendingAuthority = { ...authority, outlineStatus: "pending" };
assert.deepEqual(
  reconcileScholarRuntimeTarget({ kind: "learn", bookId: book.id, recordId: "section-1" }, pendingAuthority, book.instanceId),
  { kind: "setup", reason: "outline-not-ready", state: { kind: "selected", bookId: book.id } },
);
assert.deepEqual(
  reconcileScholarRuntimeTarget({ kind: "exam", bookId: book.id, recordId: "missing-exam" }, authority, book.instanceId),
  { kind: "stale", reason: "exam-target-missing", state: { kind: "selected", bookId: book.id } },
);
assert.deepEqual(
  reconcileScholarRuntimeTarget({ kind: "learn", bookId: book.id, recordId: "missing-section" }, authority, book.instanceId),
  { kind: "stale", reason: "learn-target-missing", state: { kind: "selected", bookId: book.id } },
);
assert.deepEqual(
  reconcileScholarRuntimeTarget(
    { kind: "learn", bookId: book.id, recordId: "section-1" },
    { ...authority, chapters: [{ id: "chapter-1", sections: [section("section-1", "not-started")] }] },
    book.instanceId,
  ),
  { kind: "stale", reason: "learn-target-not-started", state: { kind: "selected", bookId: book.id } },
);
assert.deepEqual(
  reconcileScholarRuntimeTarget({ kind: "tutor", bookId: book.id, recordId: "missing-tutor" }, authority, book.instanceId),
  { kind: "stale", reason: "tutor-target-missing", state: { kind: "selected", bookId: book.id } },
);

const activeLearn = reconcileScholarRuntimeTarget(
  { kind: "learn", bookId: book.id, recordId: "section-1" },
  authority,
  book.instanceId,
);
assert.equal(activeLearn.kind, "active");
assert.equal(activeLearn.target.id, "section-1");
assert.equal(activeLearn.terminal, undefined);
assert.equal(
  reconcileScholarRuntimeTarget({ kind: "exam", bookId: book.id, recordId: "exam-1" }, authority, book.instanceId).target.id,
  "exam-1",
);
assert.equal(
  reconcileScholarRuntimeTarget({ kind: "tutor", bookId: book.id, recordId: "tutor-1" }, authority, book.instanceId).target.id,
  "tutor-1",
);

const terminalAuthority = {
  ...authority,
  chapters: [{ id: "chapter-1", sections: [section("section-1", "complete")] }],
  exams: [{ id: "exam-1", status: "graded" }],
  tutorSessions: [{ id: "tutor-1", status: "closed" }],
};
assert.equal(
  reconcileScholarRuntimeTarget({ kind: "learn", bookId: book.id, recordId: "section-1" }, terminalAuthority, book.instanceId).terminal,
  "learn-complete",
);
assert.equal(
  reconcileScholarRuntimeTarget({ kind: "exam", bookId: book.id, recordId: "exam-1" }, terminalAuthority, book.instanceId).terminal,
  "exam-graded",
);
assert.equal(
  reconcileScholarRuntimeTarget({ kind: "tutor", bookId: book.id, recordId: "tutor-1" }, terminalAuthority, book.instanceId).terminal,
  "tutor-closed",
);

console.log("Scholar runtime-session smoke checks passed (selection, v3 restore, reconciliation, serialization, and dedupe).");
