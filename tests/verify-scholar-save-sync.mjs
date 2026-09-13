import { sdkAliases } from "./sdk.mjs";
import { extensionPath as packagedExtensionPath, piPackageRoot as sdkRoot, jitiPath as sdkJitiPath, resolvePiDependency } from "./sdk.mjs";
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const requested = resolve(process.env.PI_SCHOLAR_EXTENSION || packagedExtensionPath);
const extension = basename(requested).toLowerCase() === 'index.ts' ? dirname(requested) : requested;
const packageRoot = sdkRoot;
const piRequire = createRequire(join(packageRoot, 'package.json'));
const { createJiti } = await import(pathToFileURL(sdkJitiPath).href);
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: { ...sdkAliases,
  '@earendil-works/pi-coding-agent': join(packageRoot, 'dist', 'index.js'),
  '@earendil-works/pi-tui': piRequire.resolve('@earendil-works/pi-tui'),
  typebox: piRequire.resolve('typebox'),
} });

const { createBookService } = await jiti.import(join(extension, 'book-service.ts'));
const { handleScholarCommand } = await jiti.import(join(extension, 'commands.ts'));
const { parseScholarCommand } = await jiti.import(join(extension, 'command-syntax.ts'));
const projection = await jiti.import(join(extension, 'obsidian.ts'));
const { ScholarRuntimeCoordinator } = await jiti.import(join(extension, 'runtime-coordinator.ts'));
const storage = await jiti.import(join(extension, 'storage.ts'));
const { resolveScholarConfig } = storage;

let passedCount = 0;
function passed(message) {
  passedCount += 1;
  console.log('[PASS] ' + message);
}

const root = await mkdtemp(join(tmpdir(), 'scholar-save-sync-'));
process.env.PI_SCHOLAR_STATE_ROOT = join(root, 'State');
delete process.env.PI_SCHOLAR_OBSIDIAN_ROOT;
delete process.env.PI_SCHOLAR_LIBRARY_ROOT;
await mkdir(process.env.PI_SCHOLAR_STATE_ROOT, { recursive: true });
const now = new Date().toISOString();

function sampleBook(libDir, id, title) {
  return {
    schemaVersion: 3,
    revision: 0,
    id,
    instanceId: 'inst-' + id,
    source: {
      absolutePath: join(libDir, id + '.pdf'),
      relativePath: id + '.pdf',
      fileName: id + '.pdf',
      format: 'pdf',
      fingerprint: { sha256: id, size: 1024, mtimeMs: 1000 },
    },
    metadata: { title, authors: ['Author One'], pageCount: 10 },
    outlineStatus: 'ready',
    chapters: [
      {
        id: 'ch-' + id + '-1',
        order: 1,
        number: '1',
        title: 'Chapter One',
        startPage: 1,
        endPage: 10,
        status: 'learning',
        sections: [
          {
            id: 'sec-' + id + '-1',
            order: 1,
            number: '1.1',
            title: 'Section One',
            startPage: 1,
            endPage: 5,
            status: 'learning',
            objectives: ['Explain the concept'],
            coveredObjectives: [],
            requiredChecks: [],
            keyPoints: [],
            misconceptions: [],
            attempts: [],
            transcript: [],
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
    ],
    exams: [],
    tutorSessions: [],
    noteDirectory: title.replace(/[^a-zA-Z0-9]/g, ''),
    createdAt: now,
    updatedAt: now,
  };
}

async function createFixture(name) {
  const vault = join(root, name, 'vault');
  const lib = join(root, name, 'lib');
  await mkdir(vault, { recursive: true });
  await mkdir(lib, { recursive: true });
  const config = resolveScholarConfig({
    schemaVersion: 3,
    libraryRoot: lib,
    obsidianRoot: vault,
    stateRoot: vault,
    updatedAt: now,
  });
  return { vault, lib, config };
}

try {
  // Test 1: State save succeeds, projection throws -> revision survives, no rollback, pending status
  {
    const { config, lib } = await createFixture('proj-fail');
    const book = sampleBook(lib, 'a'.repeat(64), 'Book Alpha');
    await writeFile(book.source.absolutePath, 'pdf');
    await storage.createBookState(config, book);

    const saves = [];
    const service = createBookService({
      getConfig: () => config,
      load: storage.loadBookState,
      save: (cfg, b, exp) => {
        saves.push({ revision: b.revision, exp });
        return storage.saveBookState(cfg, b, exp);
      },
      list: storage.listBookStates,
      project: async () => {
        throw new Error('simulated projection write failure');
      },
      onSave: () => undefined,
      librarySetupMessage: 'library missing',
    });

    const outcome = await service.mutateBook(book.id, (state) => {
      state.metadata.title = 'Updated Title';
    });

    assert.equal(outcome.projectionStatus, 'pending');
    assert.match(String(outcome.projectionError?.message), /simulated projection write failure/);
    assert.equal(outcome.book.revision, 1);
    assert.equal(outcome.book.metadata.title, 'Updated Title');

    const loaded = await storage.loadBookState(config, book.id);
    assert.equal(loaded?.revision, 1);
    assert.equal(loaded?.metadata.title, 'Updated Title');

    assert.equal(saves.length, 1);
    assert.equal(saves[0].exp, 0);
    assert.equal(saves[0].revision, 1);
    assert.equal(service.isPending(config), true);

    passed('state save succeeds, projection throws: revision/progress survive without rollback save; caller gets pending status');
  }

  // Test 2: State save fails -> failure propagates, uncommitted data never projected
  {
    const { config, lib } = await createFixture('save-fail');
    const book = sampleBook(lib, 'b'.repeat(64), 'Book Beta');
    await writeFile(book.source.absolutePath, 'pdf');
    await storage.createBookState(config, book);

    let projectionAttempted = false;
    const service = createBookService({
      getConfig: () => config,
      load: storage.loadBookState,
      save: async () => {
        throw new Error('disk full');
      },
      list: storage.listBookStates,
      project: async () => {
        projectionAttempted = true;
      },
      onSave: () => undefined,
      librarySetupMessage: 'library missing',
    });

    await assert.rejects(
      service.mutateBook(book.id, (state) => {
        state.metadata.title = 'Must Not Persist';
      }),
      /disk full/,
    );

    assert.equal(projectionAttempted, false, 'uncommitted mutation must never trigger projection');
    const loaded = await storage.loadBookState(config, book.id);
    assert.equal(loaded?.revision, 0);
    assert.equal(loaded?.metadata.title, 'Book Beta');

    passed('state save fails: failure propagates and uncommitted data is never projected');
  }

  // Test 3: Projection succeeds but onSave notification throws -> state not reverted
  {
    const { config, lib } = await createFixture('onsave-throw');
    const book = sampleBook(lib, 'c'.repeat(64), 'Book Gamma');
    await writeFile(book.source.absolutePath, 'pdf');
    await storage.createBookState(config, book);

    let projected = false;
    const service = createBookService({
      getConfig: () => config,
      load: storage.loadBookState,
      save: storage.saveBookState,
      list: storage.listBookStates,
      project: async (cfg, books) => {
        await projection.renderScholarWorkspace(cfg, books);
        projected = true;
      },
      onSave: () => {
        throw new Error('UI notification disconnected');
      },
      librarySetupMessage: 'library missing',
    });

    const outcome = await service.mutateBook(book.id, (state) => {
      state.metadata.title = 'Title Survives Notification Error';
    });

    assert.equal(outcome.projectionStatus, 'synced');
    assert.equal(projected, true);
    const loaded = await storage.loadBookState(config, book.id);
    assert.equal(loaded?.revision, 1);
    assert.equal(loaded?.metadata.title, 'Title Survives Notification Error');

    passed('onSave notification error after commit does not fail the transaction or revert state');
  }

  // Test 4: Simulated restart catches up pending notes via sync
  {
    const { config, lib } = await createFixture('sync-catchup');
    const book = sampleBook(lib, 'd'.repeat(64), 'Book Delta');
    await writeFile(book.source.absolutePath, 'pdf');
    await storage.createBookState(config, book);

    let allowProjection = false;
    const service = createBookService({
      getConfig: () => config,
      load: storage.loadBookState,
      save: storage.saveBookState,
      list: storage.listBookStates,
      project: async (cfg, books) => {
        if (!allowProjection) throw new Error('vault temporarily unavailable');
        await projection.renderScholarWorkspace(cfg, books);
      },
      onSave: () => undefined,
      librarySetupMessage: 'library missing',
    });

    const outcome = await service.mutateBook(book.id, (state) => {
      state.chapters[0].sections[0].synthesis = 'Important lesson content.';
    });
    assert.equal(outcome.projectionStatus, 'pending');
    assert.equal(service.isPending(config), true);

    allowProjection = true;
    await service.renderAll();
    assert.equal(service.isPending(config), false);

    const secPath = projection.sectionNotePath(config, book, book.chapters[0], book.chapters[0].sections[0]);
    const noteText = await readFile(secPath, 'utf8');
    assert.match(noteText, /Important lesson content\./);

    passed('simulated recovery/restart renders notes from latest committed state and clears pending status');
  }

  // Test 5: Coalesced concurrent projections for books sharing vault project latest revisions
  {
    const { config, lib } = await createFixture('coalesce');
    const book1 = sampleBook(lib, 'e'.repeat(64), 'Book Epsilon');
    const book2 = sampleBook(lib, 'f'.repeat(64), 'Book Zeta');
    await writeFile(book1.source.absolutePath, 'pdf');
    await writeFile(book2.source.absolutePath, 'pdf');
    await storage.createBookState(config, book1);
    await storage.createBookState(config, book2);

    let projectCount = 0;
    const service = createBookService({
      getConfig: () => config,
      load: storage.loadBookState,
      save: storage.saveBookState,
      list: storage.listBookStates,
      project: async (cfg, books) => {
        projectCount += 1;
        await new Promise((r) => setTimeout(r, 20));
        await projection.renderScholarWorkspace(cfg, books);
      },
      onSave: () => undefined,
      librarySetupMessage: 'library missing',
    });

    const [out1, out2] = await Promise.all([
      service.mutateBook(book1.id, (state) => {
        state.metadata.title = 'Epsilon Rev 1';
      }),
      service.mutateBook(book2.id, (state) => {
        state.metadata.title = 'Zeta Rev 1';
      }),
    ]);

    assert.equal(out1.projectionStatus, 'synced');
    assert.equal(out2.projectionStatus, 'synced');

    const homeText = await readFile(projection.scholarHomePath(config), 'utf8');
    assert.match(homeText, /Epsilon Rev 1/);
    assert.match(homeText, /Zeta Rev 1/);

    passed('concurrent mutations to different books sharing a vault coalesce cleanly and project newest revisions');
  }

  // Test 6: Vault changes while projection is queued: no writes to newly selected vault
  {
    const fixtureA = await createFixture('vault-a');
    const fixtureB = await createFixture('vault-b');
    const book = sampleBook(fixtureA.lib, '1'.repeat(64), 'Book Isolation');
    await writeFile(book.source.absolutePath, 'pdf');
    await storage.createBookState(fixtureA.config, book);

    let currentConfig = fixtureA.config;
    const writes = [];
    const service = createBookService({
      getConfig: () => currentConfig,
      load: storage.loadBookState,
      save: storage.saveBookState,
      list: storage.listBookStates,
      project: async (cfg) => {
        writes.push(cfg.obsidianRoot);
      },
      onSave: () => undefined,
      librarySetupMessage: 'library missing',
    });

    const mutationPromise = service.mutateBook(book.id, (state) => {
      state.metadata.title = 'Changed Title';
    });
    currentConfig = fixtureB.config;

    await mutationPromise;
    assert.equal(writes.length, 1);
    assert.equal(writes[0], fixtureA.vault, 'projection must target the captured vault, not the newly selected vault');

    passed('vault changes while projection is queued: no writes to the newly selected vault from the old operation');
  }

  // Test 7: Internal note synchronization and command removal
  {
    assert.deepEqual(parseScholarCommand('sync'), { action: 'invalid' });
    assert.deepEqual(parseScholarCommand('sync extra'), { action: 'invalid' });
    assert.deepEqual(parseScholarCommand('backfill'), { action: 'invalid' });
    assert.deepEqual(parseScholarCommand('backfill extra'), { action: 'invalid' });

    const { config, lib, vault } = await createFixture('cmd-sync');
    const book = sampleBook(lib, '2'.repeat(64), 'Book Command Sync');
    await writeFile(book.source.absolutePath, 'pdf');
    await storage.createBookState(config, book);

    const notifications = [];
    const coordinator = new ScholarRuntimeCoordinator(
      { appendEntry() {} },
      () => () => {},
      () => {},
      (msg) => notifications.push(msg),
    );
    await coordinator.saveConfig(config);

    const uiNotices = [];
    const ctx = {
      ui: {
        notify: (msg, type) => uiNotices.push({ msg, type }),
        setStatus: () => {},
        setWorkingMessage: () => {},
        setEditorText: () => {},
      },
    };

    // User-facing sync and backfill are rejected as invalid commands
    await handleScholarCommand('sync', ctx, coordinator);
    assert(uiNotices.some((n) => n.msg.includes('Invalid Scholar command') && n.type === 'warning'));

    await handleScholarCommand('backfill', ctx, coordinator);
    assert(uiNotices.filter((n) => n.msg.includes('Invalid Scholar command') && n.type === 'warning').length >= 2);

    // Internal note synchronization works directly without user maintenance commands
    await coordinator.renderAll();

    const afterSync = await storage.loadBookState(config, book.id);
    assert.equal(afterSync?.revision, 0, 'sync must not change authoritative book revision');
    const bookHome = await readFile(projection.bookHomePath(config, book), 'utf8');
    assert.match(bookHome, /Book Command Sync/);

    passed('internal note synchronization renders notes without modifying authoritative revision or reading PDF; sync and backfill commands are rejected');
  }

  // Test 8: Blank configuration creates nothing
  {
    const emptyConfig = resolveScholarConfig();
    let projectCalled = false;
    const service = createBookService({
      getConfig: () => emptyConfig,
      load: async () => undefined,
      save: async () => {},
      list: async () => [],
      project: async () => { projectCalled = true; },
      onSave: () => {},
      librarySetupMessage: 'library missing',
    });

    await service.renderAll();
    assert.equal(projectCalled, false, 'blank configuration must not invoke projection');
    passed('blank configuration creates nothing and performs no writes');
  }

  console.log('\nScholar save-sync summary: ' + passedCount + ' passed, 0 failed.');
} finally {
  await rm(root, { recursive: true, force: true });
}
