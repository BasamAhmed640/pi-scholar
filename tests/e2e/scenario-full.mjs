// Full plan §5 scenario (steps 1–9). Tolerant: a failed step is recorded with its
// reason and the run continues wherever the next step still makes sense.
//   1–2  configure disposable vault + library, open the book, outline ready
//   3    Learn 1.1: lesson → five questions (some answered wrong)
//   4    Learn 1.2: abort mid-preparation → re-run → no duplicate units
//   5    Esc after two answers → kill Pi → restart --continue → only the rest resume
//   6    Tutor 1.2: probe → path diagram → one node → lock-in (Learn unchanged)
//   7    Exam "chapter 1": paper in the vault → learner answers → submit → abort
//        during grading → reopen → graded, answer key present
//   8    delete a question block and a complete lesson unit → restart → neither returns;
//        links resolve, no duplicates, Mermaid lint-clean
//   9    timing report (run.mjs), optionally against a --compare baseline
import { stepAbortAndRerun, stepDeletion, stepExam, stepFinalInspection, stepLearnSection, stepSetup, stepTutor } from "./steps.mjs";

export const description = "plan §5 steps 1–9: setup, Learn ×2 with abort/Esc/kill-restart, Tutor, Exam with abort during grading, deletion test";
export const defaultMaxMinutes = 180;
export const strict = true;

export async function run(h) {
  await stepSetup(h);
  const ready = h.inspect().book?.outlineStatus === "ready";
  if (!ready) {
    h.fail("scenario", "outline not ready after setup; later steps skipped");
    await stepFinalInspection(h);
    return;
  }
  await stepLearnSection(h, "1.1");
  await stepAbortAndRerun(h, "1.2");
  await stepTutor(h, "1.2");
  await stepExam(h, "chapter 1");
  if (h.sectionState("1.1").exists) await stepDeletion(h, "1.1");
  else h.fail("deletion test", "skipped: section 1.1 has no note");
  await stepFinalInspection(h);
}
