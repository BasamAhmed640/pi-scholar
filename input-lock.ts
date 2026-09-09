import { CustomEditor, type ExtensionContext, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  type EditorTheme,
  type KeybindingsManager,
  type TUI,
} from "@earendil-works/pi-tui";

type InputLockRequest = {
  interrupt: () => void;
  label: string;
};

export type InputLockContext = Pick<ExtensionContext, "ui"> & {
  hasUI?: boolean;
  abort?: () => void | Promise<void>;
};

/**
 * A real editor lock, not a post-submit filter. Pi transfers the existing
 * draft into this editor and back into the prior editor when it is restored.
 * Escape/Ctrl+C remain available so a user can interrupt the active run.
 */
class ScholarLockedEditor extends CustomEditor {
  constructor(
    tui: TUI,
    theme: EditorTheme,
    private readonly appKeys: KeybindingsManager,
    private readonly interrupt: () => void,
    private readonly label: () => string,
  ) {
    super(tui, theme, appKeys);
  }

  handleInput(data: string): void {
    if (this.appKeys.matches(data, "app.interrupt") || matchesKey(data, "escape")) this.interrupt();
  }

  render(width: number): string[] {
    return [this.borderColor(truncateToWidth(` Scholar · ${this.label()} · input paused · Esc interrupts `, Math.max(1, width), ""))];
  }
}

export type ScholarInputLockController = {
  acquireInputLock: (ctx: InputLockContext | ExtensionContext, label?: string) => () => void;
  releaseAllInputLocks: () => void;
};

/**
 * Owns one Scholar extension instance's editor lock. Each acquisition receives
 * an idempotent release closure; the exact prior editor factory is restored
 * only after the final live token releases and only while Scholar still owns
 * the editor slot.
 */
export function createScholarInputLockController(): ScholarInputLockController {
  const requests = new Map<symbol, InputLockRequest>();
  let lockUi: ExtensionUIContext | undefined;
  let previousEditorFactory: ReturnType<ExtensionUIContext["getEditorComponent"]>;
  let installedEditorFactory: ReturnType<ExtensionUIContext["getEditorComponent"]>;

  const latestRequest = (): InputLockRequest | undefined => {
    let latest: InputLockRequest | undefined;
    for (const request of requests.values()) latest = request;
    return latest;
  };

  const restorePreviousEditor = (): void => {
    const restoreUi = lockUi;
    const restoreFactory = previousEditorFactory;
    lockUi = undefined;
    previousEditorFactory = undefined;
    const installedFactory = installedEditorFactory;
    installedEditorFactory = undefined;
    if (
      typeof restoreUi?.setEditorComponent === "function"
      && restoreUi.getEditorComponent() === installedFactory
    ) {
      restoreUi.setEditorComponent(restoreFactory);
    }
  };

  const acquireInputLock = (ctx: InputLockContext | ExtensionContext, label = "loading"): (() => void) => {
    if (ctx?.hasUI === false) return () => undefined;
    const ui = ctx?.ui;
    if (
      typeof ui?.setEditorComponent !== "function"
      || typeof ui?.getEditorComponent !== "function"
    ) throw new Error("Scholar requires Pi's getEditorComponent/setEditorComponent APIs to pause interactive chat input. Update to a compatible Pi host and restart, then retry.");

    // Reject a second UI or replaced lock before adding a token: neither is
    // protected by this controller's existing editor ownership.
    let currentFactory: ReturnType<ExtensionUIContext["getEditorComponent"]>;
    try {
      currentFactory = ui.getEditorComponent();
    } catch (error) {
      throw new Error("Scholar could not inspect the chat editor to pause input. Restart the Pi host and retry.", { cause: error });
    }
    if (requests.size > 0 && (ui !== lockUi || currentFactory !== installedEditorFactory)) {
      throw new Error("Scholar cannot acquire another input lock after its chat editor changed. Finish or interrupt the current Scholar run, then retry.");
    }

    const token = Symbol("scholar-input-lock");
    requests.set(token, {
      label,
      interrupt: () => { if (typeof ctx.abort === "function") void ctx.abort(); },
    });
    if (requests.size === 1) {
      lockUi = ui;
      previousEditorFactory = currentFactory;
      installedEditorFactory = (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) =>
        new ScholarLockedEditor(
          tui,
          theme,
          keybindings,
          () => latestRequest()?.interrupt(),
          () => latestRequest()?.label || "loading",
        );
      try {
        ui.setEditorComponent(installedEditorFactory);
        if (ui.getEditorComponent() !== installedEditorFactory) {
          throw new Error("The Pi host did not install Scholar's input lock.");
        }
      } catch (error) {
        requests.delete(token);
        // Some hosts can throw after swapping the editor. Restore only our
        // own factory; a failed acquisition must not retain a live token.
        try {
          restorePreviousEditor();
        } catch (restoreError) {
          throw new Error("Scholar could not install or restore the chat input lock. Restart the Pi host before retrying.", {
            cause: new AggregateError([error, restoreError]),
          });
        }
        throw new Error("Scholar could not pause chat input. Restart with a compatible Pi host, then retry.", { cause: error });
      }
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (!requests.delete(token) || requests.size !== 0) return;
      restorePreviousEditor();
    };
  };

  const releaseAllInputLocks = (): void => {
    if (requests.size === 0) return;
    requests.clear();
    restorePreviousEditor();
  };

  return { acquireInputLock, releaseAllInputLocks };
}
