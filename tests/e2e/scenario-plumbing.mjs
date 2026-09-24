// Plumbing: exercises the harness itself (RPC framing, commands, notifications,
// graceful stop, hard kill + --continue restart, vault inspection) WITHOUT any
// model call. Use it to check a checkout or Pi upgrade before paying for a run.
import { stepFinalInspection } from "./steps.mjs";

export const description = "no model calls: configure vault + library, help, restart twice, inspect";
export const defaultMaxMinutes = 5;

export async function run(h) {
  await h.stage("plumbing · configure + help", async (stage) => {
    let since = h.client.seq;
    await h.command(stage, `/scholar obsidian "${h.vaultDir}"`, { timeoutMs: 60_000 });
    h.check(stage, "vault configured", h.notificationsSince(since).some((note) => /Obsidian vault set to/i.test(note.message)));
    since = h.client.seq;
    await h.command(stage, `/scholar library "${h.libraryDir}"`, { timeoutMs: 60_000 });
    h.check(stage, "library configured with one PDF", h.notificationsSince(since).some((note) => /\(1 PDF book\)/.test(note.message)));
    since = h.client.seq;
    await h.command(stage, "/scholar help", { timeoutMs: 60_000 });
    h.check(stage, "help shown", h.notificationsSince(since).some((note) => /Scholar Tools & Workflows/i.test(note.message)));
    const state = await h.client.getState();
    h.check(stage, "Pi idle after extension commands", !state.isStreaming, `model ${state.model?.provider}/${state.model?.id} · thinking ${state.thinkingLevel}`);
    h.check(stage, "no model call made", !h.client.events.some((entry) => entry.dir === "out" && entry.rec?.type === "agent_start"));
  });
  await h.stage("plumbing · stop, kill, restart --continue", async (stage) => {
    await h.client.stop();
    h.check(stage, "graceful stop", !h.client.running, `exit ${JSON.stringify(h.client.exitInfo)}`);
    await h.client.start({ continueSession: true });
    await h.client.kill();
    h.check(stage, "hard kill", !h.client.running);
    await h.client.start({ continueSession: true });
    const since = h.client.seq;
    await h.command(stage, `/scholar library`, { timeoutMs: 60_000 });
    h.check(stage, "vault pointer survives restarts (isolated state root)", h.notificationsSince(since).some((note) => note.message.includes(h.libraryDir)));
  });
  await stepFinalInspection(h, { soft: true });
}
