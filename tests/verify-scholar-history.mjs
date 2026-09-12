import { extensionPath as packagedExtensionPath, piPackageRoot as sdkRoot, jitiPath as sdkJitiPath } from "./sdk.mjs";
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { saveFixtureLesson } from './lesson-fixture.mjs';

const extension = dirname(packagedExtensionPath);
const packageRoot = sdkRoot;
const { createJiti } = await import(pathToFileURL(sdkJitiPath).href);
const piRequire = createRequire(join(packageRoot, 'package.json'));
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: {
  '@earendil-works/pi-coding-agent': join(packageRoot, 'dist', 'index.js'),
  '@earendil-works/pi-tui': piRequire.resolve('@earendil-works/pi-tui'),
  typebox: piRequire.resolve('typebox'),
} });
const mod = (name) => jiti.import(join(extension, name));
const { appendTranscript } = await mod('domain.ts');
const { createBookService } = await mod('book-service.ts');
const storage = await mod('storage.ts');
const { renderScholarWorkspace } = await mod('obsidian.ts');
const { sectionNotePath, tutorNotePath, bookNoteDirectory } = await mod('obsidian-paths.ts');
const { learnInstructions, tutorInstructions } = await mod('policies.ts');
const { handleNotes } = await mod('tool-actions/learning.ts');
const lesson = await mod('lesson.ts');

const root = await mkdtemp(join(tmpdir(), 'scholar-durable-history-'));
const now = new Date().toISOString();
const config = { schemaVersion: 3, libraryRoot: join(root, 'pdfs'), obsidianRoot: join(root, 'vault'), stateRoot: join(root, 'bootstrap'), updatedAt: now };
let count = 0;
const passed = (name) => { count++; console.log(`[PASS] ${name}`); };
const sectionOf = (book) => book.chapters[0].sections[0];
const entry = (id, kind, markdown) => ({ id, kind, markdown, createdAt: now });
const scope = { chapterIds: ['ch1'], sectionIds: ['s1'], description: 'Chapter 1' };
const initial = {
  schemaVersion: 3, revision: 0, id: 'a'.repeat(64), instanceId: 'instance-history-original',
  source: { absolutePath: join(config.libraryRoot, 'history.pdf'), relativePath: 'history.pdf', fileName: 'history.pdf', format: 'pdf', fingerprint: { sha256: 'a'.repeat(64), size: 3, mtimeMs: 1000 } },
  metadata: { title: 'History fixture', authors: ['Test'], pageCount: 1 }, outlineStatus: 'ready',
  chapters: [{ id: 'ch1', number: '1', title: 'Chapter', order: 1, startPage: 1, endPage: 1, status: 'learning', sections: [{
    id: 's1', number: '1.1', title: 'Section', order: 1, startPage: 1, endPage: 1, status: 'learning',
    objectives: ['Explain cause'], coveredObjectives: ['Explain cause'], requiredChecks: ['conceptual', 'application'],
    synthesis: 'A substantive account of the causal model and its limits.', keyPoints: ['Cause leads to effect'], misconceptions: [], attempts: [], transcript: [], createdAt: now, updatedAt: now,
  }] }],
  exams: [], tutorSessions: [{ id: 'tutor-001', title: 'Tutor record', scope, status: 'active', keyPoints: ['Cause leads to effect'], attempts: [], transcript: [], createdAt: now, updatedAt: now }],
  noteDirectory: 'History fixture', createdAt: now, updatedAt: now,
};

let failSave = false, failProjection = false;
const newService = () => createBookService({
  getConfig: () => config, load: storage.loadBookState, list: storage.listBookStates,
  save: async (...args) => { if (failSave) throw new Error('simulated interrupted save'); return storage.saveBookState(...args); },
  project: async (...args) => { if (failProjection) throw new Error('simulated projection failure'); await renderScholarWorkspace(...args); },
  onSave: () => {}, librarySetupMessage: 'Configure library',
});

try {
  for (const path of [config.libraryRoot, config.obsidianRoot, config.stateRoot]) await mkdir(path, { recursive: true });
  await writeFile(initial.source.absolutePath, 'pdf'); // No extraction: this verifier exercises persistence only.
  await storage.createBookState(config, initial);
  let service = newService();
  await service.mutateBook(initial.id, (book) => {
    for (const [label, record] of [['Learn', sectionOf(book)], ['Tutor', book.tutorSessions[0]]]) {
      appendTranscript(record.transcript, entry(`${label}-first`, 'assistant', `${label} durable first explanation: cause and effect.`));
      for (let index = 0; index < 120; index++) {
        record.attempts.push({ id: `${label}-q${index}`, kind: 'application', format: 'multiple-choice', question: `${label} question ${index}: choose the causal model.`, options: ['A', 'B', 'C'], outcome: 'pass', correctAnswer: 'A', feedback: `Reason ${index}: cause precedes effect.`, answerSummary: 'PRIVATE_ANSWER_DO_NOT_PROJECT', createdAt: now });
        appendTranscript(record.transcript, entry(`${label}-question-${index}`, 'question', `${label} question ${index}`));
        appendTranscript(record.transcript, entry(`${label}-result-${index}`, 'result', `Reason ${index}: cause precedes effect.`));
      }
      appendTranscript(record.transcript, entry(`${label}-latest`, 'assistant', `${label} current explanation.`));
    }
  });
  let saved = await storage.loadBookState(config, initial.id);
  for (const record of [sectionOf(saved), saved.tutorSessions[0]]) {
    assert.equal(record.transcript.length, 2); // Question/result text exists once in its question block.
    assert.equal(record.attempts.length, 120);
  }
  passed('all 242 events and 120 attempts per mode survive real vault commit');

  for (const [label, file] of [
    ['Learn', sectionNotePath(config, saved, saved.chapters[0], sectionOf(saved))],
    ['Tutor', tutorNotePath(config, saved, saved.tutorSessions[0])],
  ]) {
    const note = await readFile(file, 'utf8');
    assert.ok(note.includes(`${label} durable first explanation`));
    assert.ok(note.includes(`${label} question 0:`));
    assert.ok(note.includes(`${label} question 119:`));
    assert.ok(note.includes('Reason 0:'));
    assert.ok(note.includes('PRIVATE_ANSWER_DO_NOT_PROJECT')); // Answers now belong to the visible record.
    assert.ok(!note.includes(`${label === 'Learn' ? 'Tutor' : 'Learn'} durable first explanation`));
  }
  passed('oldest and newest teaching, questions and feedback project without raw answers or cross-mode history');

  const compact = structuredClone(saved);
  sectionOf(compact).transcript = [sectionOf(compact).transcript.at(-1)];
  sectionOf(compact).attempts = [];
  compact.tutorSessions[0].transcript = [compact.tutorSessions[0].transcript.at(-1)];
  compact.tutorSessions[0].attempts = [];
  assert.equal(learnInstructions(saved, sectionOf(saved)), learnInstructions(compact, sectionOf(compact)));
  assert.equal(tutorInstructions(saved, saved.tutorSessions[0]), tutorInstructions(compact, compact.tutorSessions[0]));
  passed('long saved histories do not enlarge Learn/Tutor resume prompts');

  service = newService();
  await service.renderAll();
  assert.deepEqual(await storage.loadBookState(config, initial.id), saved);
  await service.mutateBook(initial.id, (book) => assert.equal(appendTranscript(sectionOf(book).transcript, sectionOf(book).transcript[0]), false));
  assert.deepEqual(await storage.loadBookState(config, initial.id), saved);
  passed('restart, regeneration and duplicate event replay preserve history and revision');

  const authority = storage.bookStatePath(config, saved);
  const beforeBytes = await readFile(authority, 'utf8');
  for (const change of [
    (book) => sectionOf(book).transcript.shift(),
    (book) => { sectionOf(book).transcript[0].markdown = 'rewritten'; },
    (book) => sectionOf(book).attempts.shift(),
    (book) => { sectionOf(book).attempts[0].question = 'different question'; },
    (book) => { sectionOf(book).attempts[0].outcome = 'review'; },
    (book) => { sectionOf(book).attempts[0].correctAnswer = 'B'; },
    (book) => { delete sectionOf(book).attempts[0].feedback; },
    (book) => { book.tutorSessions = []; },
    (book) => { book.chapters = []; },
  ]) {
    await assert.rejects(service.mutateBook(initial.id, change), /saved history/);
    assert.equal(await readFile(authority, 'utf8'), beforeBytes);
  }
  passed('commit boundary refuses silent trimming, rewritten questions/results and removal of records containing history');

  failSave = true;
  await assert.rejects(service.mutateBook(initial.id, (book) => appendTranscript(sectionOf(book).transcript, entry('failed-write', 'assistant', 'Should not survive failed save'))), /interrupted save/);
  failSave = false;
  assert.equal(await readFile(authority, 'utf8'), beforeBytes);
  passed('failed save leaves durable history and its revision unchanged');

  failProjection = true;
  const pending = await service.mutateBook(initial.id, (book) => appendTranscript(sectionOf(book).transcript, entry('pending-projection', 'assistant', 'Committed even when note rendering fails')));
  assert.equal(pending.projectionStatus, 'pending');
  const noop = await service.mutateBook(initial.id, () => {});
  assert.equal(noop.projectionStatus, 'pending');
  failProjection = false;
  assert.equal((await service.sync()).synced, true);
  saved = await storage.loadBookState(config, initial.id);
  assert.equal(sectionOf(saved).transcript.at(-1).id, 'pending-projection');
  passed('projection retry keeps saved teaching and no-op mutations do not falsely report synced');

  const notesParams = { synthesis: 'A substantive account of the causal model and its limits.', keyPoints: ['Cause leads to effect'], objectives: ['Explain cause'], coveredObjectives: ['Explain cause'] };
  const learn = { mode: 'learn', recordId: 's1' };
  const mutate = (id, update) => service.mutateBook(id, update);
  await service.mutateBook(initial.id, book => saveFixtureLesson(lesson, book, sectionOf(book)));
  saved = await storage.loadBookState(config, initial.id);
  await handleNotes(saved, learn, notesParams, sectionOf, mutate, () => ({}));
  saved = await storage.loadBookState(config, initial.id);
  assert.deepEqual(sectionOf(saved).requiredChecks, ['conceptual', 'application']);
  const beforeLowering = await readFile(authority, 'utf8');
  await assert.rejects(handleNotes(saved, learn, { ...notesParams, requiredChecks: ['conceptual'] }, sectionOf, mutate, () => ({})), /Keep these required checks: application/);
  assert.equal(await readFile(authority, 'utf8'), beforeLowering);
  passed('omitted checks are preserved and a started lesson cannot quietly lower completion requirements');

  const bookFolder = bookNoteDirectory(config, saved);
  assert.ok(!relative(root, bookFolder).startsWith('..'));
  await rename(bookFolder, join(root, 'removed-book-for-test'));
  await assert.rejects(service.mutateBook(initial.id, () => {}), /missing/);
  assert.equal(await storage.loadBookState(config, initial.id), undefined);
  const reimport = { ...structuredClone(initial), instanceId: 'instance-history-reimport' };
  await storage.createBookState(config, reimport);
  assert.equal(sectionOf(await storage.loadBookState(config, initial.id)).transcript.length, 0);
  passed('deleted book remains absent; explicit fresh import does not inherit old history');

  console.log(`Scholar history summary: ${count} passed, 0 failed.`);
} finally {
  const relativeRoot = relative(resolve(tmpdir()), resolve(root));
  if (!relativeRoot || relativeRoot.startsWith('..')) throw new Error('Unsafe test cleanup path');
  await rm(root, { recursive: true, force: true });
}
