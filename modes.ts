import type { ScholarMode } from "./types.ts";

/**
 * One declarative description of what each Scholar mode may do.
 *
 * Modes differ in capability, not merely in name, and those differences used to
 * live as string comparisons scattered across the runtime, the tool layer and
 * the grounding gate — `mode === "learn" || mode === "tutor"` repeated in seven
 * places, with nothing to tell you which of them a fourth mode would have to
 * join. TypeScript cannot check a disjunction of string literals for
 * exhaustiveness, so those sites drift silently.
 *
 * Capability questions belong here. Identity questions — which record type a
 * mode freezes onto, which renderer it uses — deliberately stay explicit at
 * their call sites, because those are type-directed and the compiler does check
 * them.
 */
export type ModeCapabilities = {
  /** Teaches interactively in Pi and may save source-grounded teaching notes. */
  interactiveTeaching: boolean;
  /** Asks graded questions through the quiz and two-phase assess paths in Pi. */
  interactiveQuestions: boolean;
  /** May cite the learner's Learn objectives as a question basis. */
  citesLearnObjectives: boolean;
  /** May select freely licensed web images as optional presentation aids. */
  usesWebImages: boolean;
  /** May retain exact PDF figures in its own section, exam, or tutor record. */
  capturesSourceFigures: boolean;
  /** Materializes a section note on disk while it is the active target. */
  materializesSections: boolean;
};

export const MODE_CAPABILITIES: Readonly<Record<ScholarMode, Readonly<ModeCapabilities>>> = Object.freeze({
  // Learn teaches interactively and owns section progress; it is barred from the
  // internet: the book is its only visual source.
  learn: Object.freeze({
    interactiveTeaching: true,
    interactiveQuestions: true,
    citesLearnObjectives: true,
    usesWebImages: false,
    capturesSourceFigures: true,
    materializesSections: true,
  }),
  // Exam delivers through a frozen paper in Obsidian: no interactive teaching or
  // questions in Pi; its teaching artifact is the graded answer key.
  exam: Object.freeze({
    interactiveTeaching: false,
    interactiveQuestions: false,
    citesLearnObjectives: false,
    usesWebImages: true,
    capturesSourceFigures: true,
    materializesSections: false,
  }),
  // Tutor teaches and assesses in Pi, but its evidence is assisted practice, so it
  // may never borrow what Learn certified.
  tutor: Object.freeze({
    interactiveTeaching: true,
    interactiveQuestions: true,
    citesLearnObjectives: false,
    usesWebImages: true,
    capturesSourceFigures: true,
    materializesSections: false,
  }),
});

/** The four engines are universal: every mode uses every engine. Only the delivery surface differs. */
export type ModeEngines = { teaching: boolean; question: boolean; presentation: boolean; review: boolean };
export const MODE_ENGINES: Readonly<Record<ScholarMode, Readonly<ModeEngines>>> = Object.freeze({
  learn: Object.freeze({ teaching: true, question: true, presentation: true, review: true }),
  exam: Object.freeze({ teaching: true, question: true, presentation: true, review: true }),
  tutor: Object.freeze({ teaching: true, question: true, presentation: true, review: true }),
});

export const SCHOLAR_MODES = Object.keys(MODE_CAPABILITIES) as ScholarMode[];

/** Accepts a persisted or user-supplied value only if it names a real mode. */
export function isScholarMode(value: unknown): value is ScholarMode {
  return typeof value === "string" && Object.hasOwn(MODE_CAPABILITIES, value);
}

/** Capability test that tolerates "no active mode" without a separate guard. */
export function modeCan(mode: ScholarMode | undefined, capability: keyof ModeCapabilities): boolean {
  return mode !== undefined && isScholarMode(mode) && MODE_CAPABILITIES[mode][capability];
}
