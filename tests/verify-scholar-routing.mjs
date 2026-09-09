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
const {
  assertPagesInModeScope,
  findQuizAttempt,
  resolveLearnSection,
  resolveScope,
  sectionsInModeScope,
} = await import(pathToFileURL(join(extensionDirectory, "domain.ts")).href);

const section = (id, number, title, startPage, endPage, status = "not-started") => ({
  id, number, title, order: 1, startPage, endPage, status, progress: 0,
  objectives: [], coveredObjectives: [], requiredChecks: ["conceptual"], keyPoints: [],
  misconceptions: [], attempts: [], transcript: [], snapshots: [], createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});
const localFour = section("chapter-001-section-004", "4", "A locally numbered section", 10, 12);
const chapterFourOne = section("chapter-004-section-001", "4.1", "The intended first section", 40, 44);
const chapterFourTwo = section("chapter-004-section-002", "4.2", "The intended second section", 45, 49);
const book = {
  id: "routing-book",
  currentSectionId: localFour.id,
  chapters: [
    { id: "chapter-001", number: "1", title: "Earlier material", order: 1, startPage: 1, endPage: 20, sections: [localFour] },
    { id: "chapter-004", number: "4", title: "Target chapter", order: 4, startPage: 40, endPage: 49, sections: [chapterFourOne, chapterFourTwo] },
  ],
  exams: [{
    id: "exam-001",
    scope: {
      chapterIds: ["chapter-004"],
      sectionIds: [chapterFourOne.id],
      description: "section 4.1",
    },
  }],
  tutorSessions: [{
    id: "tutor-001",
    scope: {
      chapterIds: ["chapter-004"],
      sectionIds: [chapterFourTwo.id],
      description: "section 4.2",
    },
  }, {
    id: "tutor-free-topic",
    scope: {
      chapterIds: [],
      sectionIds: [],
      description: "a free topic",
    },
  }],
};

assert.equal(resolveLearnSection(book, "chapter 4")?.id, chapterFourOne.id);
assert.equal(resolveLearnSection(book, `section ${localFour.id}`)?.id, localFour.id);
assert.throws(() => resolveLearnSection(book, "4"), /ambiguous/i);

const chapterScope = resolveScope(book, "chapter 4", false);
assert.deepEqual(chapterScope.chapterIds, ["chapter-004"]);
assert.deepEqual(chapterScope.sectionIds, [chapterFourOne.id, chapterFourTwo.id]);
assert.deepEqual(resolveScope(book, `section ${localFour.id}`, false).sectionIds, [localFour.id]);
assert.throws(() => resolveScope(book, "4", false), /ambiguous/i);

book.currentSectionId = localFour.id;
assert.deepEqual(
  sectionsInModeScope(book, "learn", chapterFourTwo.id)?.map((item) => item.id),
  [chapterFourTwo.id],
);
assert.doesNotThrow(() => assertPagesInModeScope(book, "learn", chapterFourTwo.id, 45, 49));
assert.throws(() => assertPagesInModeScope(book, "learn", chapterFourTwo.id, 10, 12), /outside/i);

assert.deepEqual(
  sectionsInModeScope(book, "exam", "exam-001")?.map((item) => item.id),
  [chapterFourOne.id],
);
assert.doesNotThrow(() => assertPagesInModeScope(book, "exam", "exam-001", 40, 44));
assert.throws(() => assertPagesInModeScope(book, "exam", "exam-001", 45, 49), /outside/i);

assert.deepEqual(
  sectionsInModeScope(book, "tutor", "tutor-001")?.map((item) => item.id),
  [chapterFourTwo.id],
);
assert.doesNotThrow(() => assertPagesInModeScope(book, "tutor", "tutor-001", 45, 49));
assert.throws(() => assertPagesInModeScope(book, "tutor", "tutor-001", 40, 44), /outside/i);

for (const mode of ["learn", "exam", "tutor"]) {
  assert.throws(
    () => sectionsInModeScope(book, mode, `missing-${mode}`),
    new RegExp(`Scholar ${mode} .*no valid`, "i"),
  );
  assert.throws(
    () => assertPagesInModeScope(book, mode, `missing-${mode}`, 1, 1),
    new RegExp(`Scholar ${mode} .*no valid`, "i"),
  );
}

assert.equal(sectionsInModeScope(book, "tutor", "tutor-free-topic"), undefined);
assert.doesNotThrow(() => assertPagesInModeScope(book, "tutor", "tutor-free-topic", 1, 49));

book.exams.push({
  id: "exam-stale-scope",
  scope: { chapterIds: [], sectionIds: ["deleted-section"], description: "deleted section" },
});
assert.throws(
  () => sectionsInModeScope(book, "exam", "exam-stale-scope"),
  /missing source sections.*deleted-section/i,
);

localFour.attempts.push({ toolCallId: "same-call", outcome: "pending" });
chapterFourTwo.attempts.push({ toolCallId: "same-call", outcome: "pending" });
assert.equal(findQuizAttempt(book, chapterFourTwo.id, "same-call")?.section.id, chapterFourTwo.id);

chapterFourOne.status = "complete";
chapterFourTwo.status = "complete";
assert.throws(() => resolveLearnSection(book, "chapter 4"), /complete.*specific section/i);
assert.equal(resolveLearnSection(book, `section ${chapterFourOne.id}`)?.id, chapterFourOne.id);

console.log("Scholar routing checks passed (explicit selectors, ambiguity rejection, fail-closed Learn/Exam/Tutor scopes, and exact quiz ownership).");
