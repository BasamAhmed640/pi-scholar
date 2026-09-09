import { extensionPath as packagedExtensionPath, loaderPath } from "./sdk.mjs";
// Focused input-lock capability/failure checks using Pi's real extension loader.
// Only a disposable copy of input-lock.ts is loaded; no vault or SDK is changed.
import assert from "node:assert/strict";
import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const sourcePath = packagedExtensionPath;
const extensionRoot = basename(sourcePath).toLowerCase() === "index.ts" ? dirname(sourcePath) : sourcePath;
const { createExtensionRuntime, loadExtensions } = await import(pathToFileURL(loaderPath).href);
const tempRoot = await mkdtemp(join(tmpdir(), "scholar-input-capability-"));
const hookName = `__scholarInputCapability_${process.pid}_${Date.now()}`;
let passed = 0;

class DraftEditor {
  text = "";
  getText() { return this.text; }
  setText(value) { this.text = value; }
}

function editorUi(draft = "preserved draft") {
  const tui = { requestRender() {} };
  const theme = { borderColor: (value) => value, fg: (_role, value) => value, bold: (value) => value };
  const keys = { matches: (data, action) => action === "app.interrupt" && data === "configured-interrupt" };
  const priorFactory = () => new DraftEditor();
  const state = {
    currentFactory: priorFactory,
    currentEditor: priorFactory(),
    priorFactory,
    reads: 0,
    writes: 0,
    failReads: new Set(),
    failBeforeWrites: new Set(),
    failAfterWrites: new Set(),
    ignoreWrites: false,
    takeOverAfterWrite: undefined,
    aborts: 0,
  };
  state.currentEditor.setText(draft);
  state.ui = {
    getEditorComponent() {
      if (state.failReads.has(++state.reads)) throw new Error("forced editor read failure");
      return state.currentFactory;
    },
    setEditorComponent(factory) {
      if (state.failBeforeWrites.has(++state.writes)) throw new Error("forced editor install failure");
      if (state.ignoreWrites) return;
      const text = state.currentEditor.getText();
      state.currentEditor = (factory || priorFactory)(tui, theme, keys);
      state.currentEditor.setText(text);
      state.currentFactory = state.takeOverAfterWrite || factory;
      if (state.failAfterWrites.has(state.writes)) throw new Error("forced post-install failure");
    },
  };
  state.ctx = { hasUI: true, ui: state.ui, abort: () => { state.aborts += 1; } };
  return state;
}

function prove(name, test) {
  test();
  passed += 1;
  console.log(`[PASS] ${name}`);
}

try {
  await copyFile(join(extensionRoot, "input-lock.ts"), join(tempRoot, "input-lock.ts"));
  const wrapper = join(tempRoot, "index.ts");
  await writeFile(wrapper, `import { createScholarInputLockController } from "./input-lock.ts";\n`
    + `export default function () { (globalThis as any)[${JSON.stringify(hookName)}] = createScholarInputLockController; }\n`);
  const loaded = await loadExtensions([wrapper], tempRoot, undefined, createExtensionRuntime());
  assert.deepEqual(loaded.errors, []);
  const createController = globalThis[hookName];
  assert.equal(typeof createController, "function");

  prove("interactive hosts missing either editor API fail actionably", () => {
    for (const ui of [undefined, {}, { getEditorComponent() {} }, { setEditorComponent() {} }]) {
      for (const hasUI of [true, undefined]) {
        assert.throws(() => createController().acquireInputLock({ hasUI, ui }),
          /requires Pi's getEditorComponent\/setEditorComponent APIs.*Update/);
      }
    }
  });

  prove("only explicit headless mode skips capability inspection", () => {
    const controller = createController();
    const release = controller.acquireInputLock({ hasUI: false, get ui() { throw new Error("must not inspect UI"); } });
    release();
    release();
    controller.releaseAllInputLocks();
    const state = editorUi();
    const liveRelease = controller.acquireInputLock(state.ctx);
    const factory = state.currentFactory;
    controller.acquireInputLock({ hasUI: false })();
    assert.equal(state.currentFactory, factory);
    liveRelease();
    assert.equal(state.currentFactory, state.priorFactory);
  });

  for (const [name, fault] of [
    ["initial editor inspection failure", { failReads: [1] }],
    ["editor install failure before swap", { failBeforeWrites: [1] }],
    ["editor install failure after swap", { failAfterWrites: [1] }],
    ["editor verification failure after swap", { failReads: [2] }],
  ]) {
    prove(`${name} leaves no token and allows a subsequent real lock`, () => {
      const controller = createController();
      const state = editorUi();
      for (const [key, values] of Object.entries(fault)) state[key] = new Set(values);
      assert.throws(() => controller.acquireInputLock(state.ctx), (error) => {
        assert.match(error.message, /Scholar could not/);
        assert.match(error.message, /Restart/);
        assert.ok(error.cause);
        return true;
      });
      assert.equal(state.currentFactory, state.priorFactory);
      assert.equal(state.currentEditor.getText(), "preserved draft");
      const release = controller.acquireInputLock(state.ctx, "retrying");
      assert.notEqual(state.currentFactory, state.priorFactory);
      assert.match(state.currentEditor.render(80)[0], /retrying/);
      release();
      assert.equal(state.currentFactory, state.priorFactory);
      assert.equal(state.currentEditor.getText(), "preserved draft");
    });
  }

  prove("interactive no-op setters cannot falsely report a lock", () => {
    const controller = createController();
    const state = editorUi();
    state.ignoreWrites = true;
    assert.throws(() => controller.acquireInputLock(state.ctx), /could not pause chat input/);
    assert.equal(state.currentFactory, state.priorFactory);
    state.ignoreWrites = false;
    const release = controller.acquireInputLock(state.ctx);
    release();
    assert.equal(state.currentFactory, state.priorFactory);
  });

  prove("failed installation never overwrites another extension's editor", () => {
    const controller = createController();
    const state = editorUi();
    const otherFactory = () => new DraftEditor();
    state.takeOverAfterWrite = otherFactory;
    assert.throws(() => controller.acquireInputLock(state.ctx), /could not pause chat input/);
    assert.equal(state.currentFactory, otherFactory);
    assert.equal(state.writes, 1);
    state.takeOverAfterWrite = undefined;
    const release = controller.acquireInputLock(state.ctx);
    release();
    assert.equal(state.currentFactory, otherFactory);
  });

  prove("nested locks restore once and preserve drafts, latest label, and interrupts", () => {
    const controller = createController();
    const state = editorUi();
    const firstRelease = controller.acquireInputLock(state.ctx, "outer");
    const factory = state.currentFactory;
    let innerAborts = 0;
    const secondRelease = controller.acquireInputLock({ ...state.ctx, abort: () => { innerAborts += 1; } }, "inner");
    assert.equal(state.currentFactory, factory);
    assert.equal(state.writes, 1);
    const editor = state.currentEditor;
    assert.match(editor.render(80)[0], /inner/);
    editor.handleInput("typing");
    editor.handleInput("\r");
    assert.equal(editor.getText(), "preserved draft");
    editor.handleInput("\x1b");
    editor.handleInput("configured-interrupt");
    assert.equal(innerAborts, 2);
    assert.equal(state.aborts, 0);
    secondRelease();
    secondRelease();
    assert.equal(state.currentFactory, factory);
    assert.match(editor.render(80)[0], /outer/);
    editor.handleInput("\x1b");
    assert.equal(state.aborts, 1);
    firstRelease();
    firstRelease();
    assert.equal(state.writes, 2);
    assert.equal(state.currentFactory, state.priorFactory);
    assert.equal(state.currentEditor.getText(), "preserved draft");
  });

  prove("nested UI changes or editor takeover grant no new token", () => {
    const controller = createController();
    const state = editorUi();
    const otherUi = editorUi();
    const release = controller.acquireInputLock(state.ctx);
    const factory = state.currentFactory;
    assert.throws(() => controller.acquireInputLock(otherUi.ctx), /chat editor changed/);
    assert.equal(otherUi.writes, 0);
    assert.equal(state.currentFactory, factory);
    const otherFactory = () => new DraftEditor();
    state.ui.setEditorComponent(otherFactory);
    assert.throws(() => controller.acquireInputLock(state.ctx), /chat editor changed/);
    const writes = state.writes;
    release();
    controller.releaseAllInputLocks();
    assert.equal(state.writes, writes);
    assert.equal(state.currentFactory, otherFactory);
    const laterRelease = controller.acquireInputLock(otherUi.ctx);
    laterRelease();
    assert.equal(otherUi.currentFactory, otherUi.priorFactory);
  });

  prove("releaseAll clears nested tokens and stale releases cannot unlock later ownership", () => {
    const controller = createController();
    const state = editorUi();
    const firstRelease = controller.acquireInputLock(state.ctx);
    const secondRelease = controller.acquireInputLock(state.ctx);
    controller.releaseAllInputLocks();
    controller.releaseAllInputLocks();
    assert.equal(state.currentFactory, state.priorFactory);
    const laterRelease = controller.acquireInputLock(state.ctx);
    const factory = state.currentFactory;
    firstRelease();
    secondRelease();
    assert.equal(state.currentFactory, factory);
    laterRelease();
    assert.equal(state.currentFactory, state.priorFactory);
  });

  console.log(`\n${passed} Scholar input-capability checks passed.`);
} finally {
  delete globalThis[hookName];
  await rm(tempRoot, { recursive: true, force: true });
}
