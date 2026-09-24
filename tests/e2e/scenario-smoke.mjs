// Smoke: setup + one complete Learn section (lesson and all five questions).
import { stepFinalInspection, stepLearnSection, stepSetup } from "./steps.mjs";

export const description = "setup + Learn 1.1 (lesson and five questions)";
export const defaultMaxMinutes = 45;

export async function run(h) {
  await stepSetup(h);
  if (h.inspect().book?.outlineStatus === "ready") await stepLearnSection(h, "1.1");
  else h.fail("learn 1.1", "skipped: the outline is not ready");
  await stepFinalInspection(h);
}
