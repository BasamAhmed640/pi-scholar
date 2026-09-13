import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

type ProgressContext = Pick<ExtensionContext, "ui"> & { hasUI?: boolean };
type Outcome = "ready" | "paused" | "stopped";
type ProgressRun = {
  token: symbol;
  title: string;
  stages: readonly string[];
  stage: number;
  detail: string;
  started: number;
  lastActivity: number;
  pausedAt?: number;
  pausedMs: number;
  inputWaits: number;
  ended?: number;
  outcome?: Outcome;
};
const KEY = "scholar-progress";
const plain = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

export function elapsedLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/** A stage bar, never a time estimate. Its timer measures work, not learner input.
 * Tokens protect a handed-off run from stale navigation/abort cleanup.
 * This UI has no storage, model calls, or influence over Scholar's decisions.
 */
export class ScholarLoadingProgress {
  private run?: ProgressRun;
  private context?: ProgressContext;
  private refresh?: () => void;
  private timer?: ReturnType<typeof setInterval>;
  private unbind?: () => void;
  private signal?: AbortSignal;
  private widget = false;
  private readonly inputOrigins = new WeakMap<object, ExtensionContext["ui"]>();

  constructor(private readonly now = () => performance.now(), private readonly ascii = process.env.TERM === "dumb") {}

  get active(): boolean { return Boolean(this.run && this.run.ended === undefined); }
  get token(): symbol | undefined { return this.run?.token; }

  start(ctx: ProgressContext, title: string, stages: readonly string[], carryElapsed = false): symbol {
    const elapsed = carryElapsed && this.active ? this.elapsed() : 0;
    this.clear();
    const token = Symbol("scholar-loading");
    this.run = { token, title: plain(title), stages: stages.length ? stages : ["Working"], stage: 0, detail: "",
      started: this.now() - elapsed, lastActivity: this.now(), pausedMs: 0, inputWaits: 0 };
    this.context = ctx;
    if (ctx.hasUI) {
      try {
        if (typeof ctx.ui.setWidget === "function") {
          this.widget = true;
          ctx.ui.setWidget(KEY, (tui, theme) => {
            this.refresh = () => tui.requestRender();
            return { render: (width) => this.lines(width, theme), invalidate() {} };
          });
        }
        this.paint();
        this.startTimer();
      } catch { /* A missing or disconnected display cannot fail book loading. */ }
    }
    return token;
  }

  update(stage: number, detail = "", token = this.token): void {
    if (!this.active || token !== this.token) return;
    // The current segment stays animated until saved readiness is verified.
    this.run!.stage = Math.max(0, Math.min(this.run!.stages.length - 1, stage));
    this.run!.detail = plain(detail);
    this.activity(token);
    this.paint();
  }

  activity(token = this.token): void {
    if (this.active && token === this.token) this.run!.lastActivity = this.now();
  }

  private elapsed(): number {
    const run = this.run;
    return run ? Math.max(0, (run.ended ?? run.pausedAt ?? this.now()) - run.started - run.pausedMs) : 0;
  }

  async withUserInput<T>(work: () => Promise<T>): Promise<T> {
    const run = this.run;
    if (run && this.active) {
      if (run.inputWaits++ === 0) { run.pausedAt = this.now(); this.clearTimer(); this.paint(); }
    }
    try { return await work(); }
    finally {
      if (run && this.run === run && this.active && --run.inputWaits === 0) {
        run.pausedMs += this.now() - (run.pausedAt ?? this.now());
        run.pausedAt = undefined;
        this.activity(); this.startTimer(); this.paint();
      }
    }
  }

  /** Wrap only Scholar's context; never replace the shared Pi UI globally. */
  inputContext<T extends ProgressContext>(ctx: T): T {
    const ui = Object.create(ctx.ui);
    this.inputOrigins.set(ui, this.inputOrigins.get(ctx.ui) || ctx.ui);
    for (const name of ["select", "input", "confirm"] as const) {
      const method = ctx.ui[name];
      if (typeof method === "function") Object.defineProperty(ui, name, { value: (...args: unknown[]) =>
        this.withUserInput(() => Reflect.apply(method, ctx.ui, args)) });
    }
    return { ...ctx, ui };
  }

  inputLockContext<T extends ProgressContext>(ctx: T): T {
    const original = this.inputOrigins.get(ctx.ui);
    return original ? { ...ctx, ui: original } : ctx;
  }

  bindSignal(signal?: AbortSignal): void {
    if (!this.active || !signal || this.signal === signal) return;
    this.unbind?.();
    const token = this.token;
    const aborted = () => this.finish("stopped", "Interrupted", token);
    this.signal = signal;
    this.unbind = () => { signal.removeEventListener("abort", aborted); this.signal = undefined; };
    if (signal.aborted) aborted();
    else signal.addEventListener("abort", aborted, { once: true });
  }

  finish(outcome: Outcome, detail = "", token = this.token): void {
    if (!this.active || token !== this.token) return;
    this.run!.ended = this.run!.pausedAt ?? this.now();
    this.run!.outcome = outcome;
    if (outcome === "ready") this.run!.stage = this.run!.stages.length - 1;
    this.run!.detail = plain(detail);
    this.stopTimer();
    this.paint();
  }

  clear(token = this.token): void {
    if (token !== this.token) return;
    this.stopTimer();
    const ctx = this.context;
    this.run = undefined;
    this.refresh = undefined;
    this.context = undefined;
    try {
      if (ctx?.hasUI) {
        if (this.widget) ctx.ui.setWidget(KEY, undefined);
        else ctx.ui.setStatus(KEY, undefined);
      }
    } catch { /* Best-effort cleanup after reload/shutdown. */ }
    this.widget = false;
  }

  private stopTimer(): void {
    this.clearTimer();
    this.unbind?.();
    this.unbind = undefined;
  }

  private clearTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private startTimer(): void {
    if (this.timer || !this.context?.hasUI || !this.active || this.run?.pausedAt !== undefined) return;
    this.timer = setInterval(() => this.paint(), 1000);
    this.timer.unref?.();
  }

  private paint(): void {
    try {
      if (!this.context?.hasUI) return;
      if (this.widget) this.refresh?.();
      else this.context.ui.setStatus(KEY, this.lines(160).join(" · "));
    } catch { /* UI is observational only. */ }
  }

  lines(width: number, theme?: Pick<Theme, "fg">): string[] {
    const run = this.run;
    if (!run || width < 1) return [];
    const elapsed = this.elapsed();
    const color = (name: "accent" | "muted" | "success" | "warning", text: string) => theme ? theme.fg(name, text) : text;
    const pulse = (this.ascii ? [">..", ".>.", "..>"] : ["▸··", "·▸·", "··▸"])[Math.floor(elapsed / 1000) % 3];
    const bar = run.stages.map((_, index) => index < run.stage || run.outcome === "ready"
      ? color(run.outcome === "ready" ? "success" : "accent", this.ascii ? "===" : "━━━")
      : index === run.stage && !run.outcome && run.pausedAt === undefined ? color("accent", pulse) : color("muted", this.ascii ? "..." : "···")).join(" ");
    const stage = run.pausedAt !== undefined && !run.outcome ? "Waiting for you" : run.outcome === "paused" ? "Incomplete" : run.outcome === "stopped" ? "Stopped" : run.stages[run.stage];
    const quiet = !run.outcome && run.pausedAt === undefined && this.now() - run.lastActivity >= 60_000
      ? ` · No new activity for ${elapsedLabel(this.now() - run.lastActivity)}` : "";
    const label = run.outcome === "ready" ? "Ready" : `Stage ${run.stage + 1}/${run.stages.length}`;
    return [
      `${color("accent", "Scholar")} · ${color("accent", elapsedLabel(elapsed))} elapsed${quiet || ` · ${run.title}`}`,
      `${bar}  ${label} · ${stage}${run.detail ? ` · ${run.detail}` : ""}`,
    ].map(line => truncateToWidth(line, width));
  }
}
