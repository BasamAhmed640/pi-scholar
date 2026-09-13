import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extensionPath, jitiPath, sdkAliases } from './sdk.mjs';
const { createJiti } = await import(pathToFileURL(jitiPath));
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: sdkAliases });
const { ScholarLoadingProgress, elapsedLabel } = await jiti.import(join(dirname(extensionPath), 'loading-progress.ts'));
const { visibleWidth } = await import(pathToFileURL(sdkAliases['@earendil-works/pi-tui']));
let clock = 0, renders = 0, count = 0;
const widgets = new Map(), status = new Map();
const ctx = { hasUI: true, ui: {
  setWidget(key, factory) { if (!factory) widgets.delete(key); else widgets.set(key, factory({ requestRender() { renders++; } }, { fg: (_, value) => value })); },
  setStatus(key, value) { status.set(key, value); },
  async select() { clock += 600_000; return 'selection'; },
} };
const stages = ['Read', 'Write', 'Review', 'Save'];
const loader = new ScholarLoadingProgress(() => clock);
const pass = name => { count++; console.log(`[PASS] ${name}`); };
try {
  assert.deepEqual(loader.lines(80), []);
  assert.equal(widgets.size, 0);
  const first = loader.start(ctx, 'Learn 9.3', stages);
  clock = 65_000;
  let lines = loader.lines(160);
  assert.match(lines.join('\n'), /01:05 elapsed/);
  assert.match(lines.join('\n'), /No new activity for 01:05/);
  assert.match(lines[1], /Stage 1\/4/);
  assert.doesNotMatch(lines.join('\n'), /\d+%|ETA|Ready/);
  pass('elapsed ticks cannot invent stage progress or a time estimate; inactivity is explicit');

  loader.update(2, '2/3 checks returned');
  assert.match(loader.lines(160)[1], /Stage 3\/4.*Review/);
  clock += 120_000;
  loader.activity();
  assert.doesNotMatch(loader.lines(160).join('\n'), /No new activity/);
  loader.update(1, 'Repair round 2');
  assert.match(loader.lines(160)[1], /Stage 2\/4.*Repair round 2/);
  pass('real events update stages and a repair can return to writing without a fake percentage');

  const before = loader.lines(160)[0];
  const wrapped = loader.inputContext(ctx);
  assert.notEqual(wrapped.ui, ctx.ui);
  assert.equal(await wrapped.ui.select('Choose', ['selection']), 'selection');
  assert.equal(loader.lines(160)[0], before);
  let done;
  const waiting = loader.withUserInput(() => new Promise(resolve => { done = resolve; }));
  clock += 600_000;
  assert.match(loader.lines(160)[1], /Waiting for you/);
  assert.match(loader.lines(160)[0], /03:05 elapsed/);
  done(); await waiting;
  assert.match(loader.lines(160)[0], /03:05 elapsed/);
  pass('selection and learner waits pause elapsed time without replacing the shared Pi UI');

  const handed = loader.start(ctx, 'Review and save', stages, true);
  assert.match(loader.lines(160)[0], /03:05 elapsed/);
  loader.finish('stopped', 'Old cancellation', first);
  loader.clear(first);
  assert.equal(loader.token, handed);
  assert.equal(loader.active, true);
  pass('handoffs retain elapsed time and stale cleanup cannot stop the next operation');

  const stop = new AbortController();
  loader.bindSignal(stop.signal);
  stop.abort();
  assert.equal(loader.active, false);
  assert.match(loader.lines(160)[1], /Stopped.*Interrupted/);
  const frozen = loader.lines(160)[0]; clock += 900_000;
  assert.equal(loader.lines(160)[0], frozen);
  pass('cancellation freezes the timer and reports interruption, never success');

  loader.start(ctx, 'Checking a question', stages);
  clock += 2_000;
  loader.finish('ready', 'Question ready');
  clock += 600_000;
  assert.match(loader.lines(160)[0], /00:02 elapsed/);
  loader.start(ctx, 'Feedback', ['Check', 'Save']);
  clock += 3_000;
  assert.match(loader.lines(160)[0], /00:03 elapsed/);
  pass('question generation and subsequent feedback have separate clocks that exclude answering time');

  for (const width of [1, 15, 40, 80, 160]) {
    for (const line of loader.lines(width)) assert(visibleWidth(line) <= width);
  }
  loader.finish('paused', 'Draft saved · review incomplete: timeout');
  assert.match(loader.lines(160)[1], /Incomplete.*timeout/);
  assert.doesNotMatch(loader.lines(160)[1], /Ready/);
  loader.clear();
  assert.equal(widgets.size, 0);
  assert.deepEqual(loader.lines(80), []);
  pass('narrow terminals clip safely; incomplete reviews stay incomplete; close removes the widget');

  loader.start(ctx, 'An unusually long textbook section title that fills an entire terminal row', stages);
  clock += 65_000;
  assert.match(loader.lines(80)[0], /No new activity for 01:05/);
  loader.clear();

  const fallback = new ScholarLoadingProgress(() => clock, true);
  fallback.start({ hasUI: true, ui: { setStatus: ctx.ui.setStatus } }, 'Book', stages);
  assert.match(status.get('scholar-progress'), />\.\./);
  fallback.clear();
  assert.equal(status.get('scholar-progress'), undefined);
  const silent = new ScholarLoadingProgress(() => clock);
  silent.start({ hasUI: false, ui: {} }, 'Headless', stages);
  silent.update(99, 'Saved'); silent.finish('ready'); silent.clear();
  assert.equal(elapsedLabel(-1), '00:00');
  assert.equal(elapsedLabel(3_661_000), '1:01:01');
  assert(renders > 0);
  pass('status/ASCII fallback and headless runs work without cat-image or working-message APIs');
  console.log(`Scholar loading progress: ${count} passed, 0 failed.`);
} finally { loader.clear(); }
