import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LessonReviewUnit } from "./lesson.ts";
import { matchesLessonId, type ReviewBatchPass, type ReviewReceipt } from "./learn-quality.ts";
import {
  REVIEW_CHECKPOINT_MESSAGE,
  blocking,
  currentReviewSnapshots,
  reviewTargetQuestion,
  reviewerModelName,
  uniqueBatches,
  type ReviewPacket,
  type ReviewRunnerOptions,
} from "./review-layer.ts";
import type { ScholarSection } from "./types.ts";

export type LessonReviewRole = "source" | "teaching" | "visual";
export type ReviewOptions = ReviewRunnerOptions & {
  section: ScholarSection;
};

const SOURCE_WINDOW_PAGES = 4;
const KEY_EQUATION_BLOCK = /^> \[!note\][+-]? Key equation[^\n]*(?:\n>[^\n]*)*/gm;

/**
 * One saved revision is one audit unit. Its packets are the unit's own bounded source
 * windows, one explanation check, and — only when it embeds saved crops that still exist —
 * a visual check over exactly those crops. No packet renders a full page.
 */
export function planLessonUnitPackets(unit: LessonReviewUnit, section: ScholarSection, sourceHash: string, contextWindow?: number): ReviewPacket[] {
  const smallWindow = typeof contextWindow === "number" && contextWindow > 0 && contextWindow < 64_000;
  const windowPages = smallWindow ? 2 : SOURCE_WINDOW_PAGES;
  const bound = (values: number[]) => [...new Set(values.filter(page => Number.isSafeInteger(page) && page >= section.startPage && page <= section.endPage))].sort((a, b) => a - b);
  const checklist = (section.learnQuality?.coverage || []).filter(item => item.lessonId && matchesLessonId(unit.entryId, item.lessonId));
  const cited = bound([...unit.sourcePages, ...checklist.flatMap(item => item.sourcePages)]);
  // A unit whose declared pages fall outside the current section still gets its explanation
  // checked; source evidence then falls back to the section's own bounded page range.
  const pages = cited.length ? cited : bound(Array.from({ length: section.endPage - section.startPage + 1 }, (_, index) => section.startPage + index));
  const crops = currentReviewSnapshots(section, sourceHash).filter(crop => unit.snapshotIds.includes(crop.id));
  const lesson = { id: unit.entryId, title: unit.title, markdown: unit.markdown };
  const base = { source: { startPage: section.startPage, endPage: section.endPage }, objectives: section.objectives, outline: [unit.title] };
  const packets: ReviewPacket[] = [];
  for (let index = 0; index < pages.length; index += windowPages) {
    const window = pages.slice(index, index + windowPages);
    packets.push({
      role: "source",
      id: `${unit.key}:source:${window[0]}`,
      instruction: `Unit check for saved explanation ${unit.entryId} (pages ${window.join(", ")}). Compare that explanation against these pages and report essential content on them that it omits or misstates. Other units and the section-wide coverage plan have their own audits.`,
      reads: window,
      views: [],
      cropIds: [],
      payload: { ...base, lesson, checklist: checklist.filter(item => item.sourcePages.some(page => window.includes(page))) },
    });
  }
  packets.push({
    role: "teaching",
    id: `${unit.key}:teaching`,
    instruction: `Unit check for saved explanation ${unit.entryId}. Judge this explanation as instruction for its declared pages; the section recap, the objective check plan and the other units have their own audits.`,
    reads: pages,
    views: [],
    cropIds: [],
    payload: { ...base, lesson, checklist, checks: section.objectiveChecks, recap: section.synthesis, keyPoints: section.keyPoints },
  });
  if (crops.length) {
    packets.push({
      role: "visual",
      id: `${unit.key}:visual`,
      instruction: `Unit check for saved explanation ${unit.entryId}. Inspect only the saved crops it embeds, judging them against its captions, its Key equation callouts and the figure inventory below. A saved crop must show its complete source figure with its labels, arrows and units; you never see a full page render.`,
      reads: [],
      views: [],
      cropIds: crops.map(crop => crop.id),
      payload: { ...base, lesson, figures: crops,
        figureInventory: (section.figureCoverage?.pages || []).filter(page => crops.some(crop => crop.page === page.page)),
        keyEquations: unit.markdown.match(KEY_EQUATION_BLOCK) || [] },
    });
  }
  return packets;
}

/** A saved in-progress receipt: never approval, only a carrier for finished checks. */
export function reviewCheckpoint(contentHash: string, sourceHash: string, ctx: ExtensionContext, role: LessonReviewRole, batches: ReviewBatchPass[]): ReviewReceipt {
  return { ...blocking(REVIEW_CHECKPOINT_MESSAGE), role, contentHash, sourceHash, model: reviewerModelName(ctx), createdAt: new Date().toISOString(),
    failure: { code: "cancelled", message: REVIEW_CHECKPOINT_MESSAGE }, batches: uniqueBatches(batches) };
}

export async function reviewLearnQuestion(options: ReviewOptions, value: unknown, sourcePages: number[]): Promise<(current: ScholarSection) => void> {
  const verify = await reviewTargetQuestion({ ...options, target: options.section }, value, sourcePages);
  return current => verify(current);
}
