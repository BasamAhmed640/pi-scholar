// Baseline timing: setup + Learn 1.1 only. The learner answers two questions and
// pauses the third (Esc), so the run measures time to lesson ready, time to the
// first question and answer → next-question latency without paying for all five.
import { stepBaselineLearn, stepFinalInspection, stepSetup } from "./steps.mjs";

export const description = "setup + Learn 1.1 until the lesson is ready and two questions are answered (third paused)";
export const defaultMaxMinutes = 15;

export async function run(h) {
  await stepSetup(h);
  if (h.inspect().book?.outlineStatus === "ready" && h.remainingMs() > 30_000) await stepBaselineLearn(h, "1.1");
  else h.fail("learn 1.1", "skipped: the outline is not ready or the time budget is spent");
  await stepFinalInspection(h, { soft: true });
}
