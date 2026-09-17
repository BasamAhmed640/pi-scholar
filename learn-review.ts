import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { learnReviewHash, validLessonEntries } from "./lesson.ts";
import {
  matchesLessonId,
  reviewGateIssues,
  type ReviewBatchPass,
  type ReviewReceipt,
  type ReviewRole,
  type SourceCoverageItem,
} from "./learn-quality.ts";
import {
  DEFAULT_REVIEWER_LIMITS,
  type ReviewerProgress,
} from "./review-runtime.ts";
import type { ScholarBook, ScholarConfig, ScholarSection, ScholarSnapshot } from "./types.ts";
import {
  REVIEW_CHECKPOINT_MESSAGE,
  blocking,
  currentReviewSnapshots,
  reviewTargetQuestion,
  reviewerModelName,
  runReviewPass,
  uniqueBatches,
  type ReviewPacket,
  type ReviewRunnerOptions,
} from "./review-layer.ts";

export type LessonReviewRole = "source" | "teaching" | "visual";
export type ReviewAssignment = ReviewPacket;
export type ReviewOptions = ReviewRunnerOptions & {
  section: ScholarSection;
};

const SOURCE_WINDOW_PAGES = 4;
const VISUAL_PACKET_IMAGES = 6;
/** Independent topics share one explanation check while their combined load stays reviewable. */
const TEACHING_TOPICS_PER_PACKET = 4;

/** Topic boundaries are ### headings outside code fences; every line belongs to exactly one topic. */
function splitTopics(markdown: string): Array<{ heading: string; markdown: string }> {
  const parts: Array<{ heading: string; lines: string[] }> = [];
  let fence = "";
  for (const line of markdown.replace(/\r\n/g, "\n").split("\n")) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (!fence && !marker && /^###\s+\S/.test(line)) parts.push({ heading: line.replace(/^###\s+/, "").trim(), lines: [] });
    else if (fence && marker && marker[0] === fence[0] && marker.length >= fence.length) fence = "";
    else if (!fence && marker) fence = marker;
    (parts.at(-1) ?? parts[parts.push({ heading: "Introduction", lines: [] }) - 1]!).lines.push(line);
  }
  return parts.map(part => ({ heading: part.heading, markdown: part.lines.join("\n").trim() })).filter(part => part.markdown);
}

type Topic = { heading: string; markdown: string; pages: number[]; cropIds: string[]; coverage: SourceCoverageItem[] };

/**
 * Plan the crew: a fidelity check per source-page window, an explanation check per
 * group of topics, a visual/math packet per packed figure set, leftover pages and
 * crops, and one whole-lesson coherence check. Every required page is read, and
 * every current crop inspected, by exactly one packet, so the aggregate keeps full
 * evidence coverage without one request per topic.
 */
export function planReviewAssignments(section: ScholarSection, sourceHash: string, contextWindow?: number): ReviewAssignment[] {
  const smallWindow = typeof contextWindow === "number" && contextWindow > 0 && contextWindow < 64_000;
  const sourceWindowPages = smallWindow ? 2 : SOURCE_WINDOW_PAGES;
  const visualPacketImages = smallWindow ? 2 : VISUAL_PACKET_IMAGES;
  const pages = Array.from({ length: section.endPage - section.startPage + 1 }, (_, i) => section.startPage + i);
  const sorted = (values: number[]) => [...new Set(values.filter(page => pages.includes(page)))].sort((a, b) => a - b);
  const coverage = section.learnQuality?.coverage || [];
  const crops = currentReviewSnapshots(section, sourceHash);
  const topics: Topic[] = validLessonEntries(section, sourceHash).flatMap(entry => splitTopics(entry.markdown).map(part => {
    const mapped = coverage.filter(item => item.lessonId && item.evidence && matchesLessonId(entry.id, item.lessonId)
      && part.markdown.includes(item.evidence.replace(/\r\n/g, "\n").trim()));
    const placed = crops.filter(crop => part.markdown.includes(crop.assetFile));
    const cited = sorted([...mapped.flatMap(item => item.sourcePages), ...placed.map(crop => crop.page)]);
    const fallback = sorted(entry.lesson!.sourcePages);
    return { heading: part.heading, markdown: part.markdown, coverage: mapped, cropIds: placed.map(crop => crop.id),
      pages: cited.length ? cited : fallback.length ? fallback : pages };
  }));
  const base = { source: { startPage: section.startPage, endPage: section.endPage }, objectives: section.objectives, outline: topics.map(topic => topic.heading) };
  const assignments: ReviewAssignment[] = [];
  const add = (role: LessonReviewRole, id: string, instruction: string, scope: Partial<Pick<ReviewAssignment, "reads" | "views" | "cropIds">>, payload: Record<string, unknown>) =>
    assignments.push({ role, id, instruction, reads: scope.reads || [], views: scope.views || [], cropIds: scope.cropIds || [], payload: { ...base, ...payload } });

  for (let index = 0; index < pages.length; index += sourceWindowPages) {
    const window = pages.slice(index, index + sourceWindowPages), touches = (list: number[]) => list.some(page => window.includes(page));
    add("source", `source:${window[0]}`, `Crew assignment: source pages ${window.join(", ")}. Check that the lesson passages below deliver these pages faithfully, and report essential content on these pages that no passage explains. Other crew members cover the other pages, and a coherence check covers the whole lesson.`,
      { reads: window }, { checklist: coverage.filter(item => touches(item.sourcePages)), passages: topics.filter(topic => touches(topic.pages)).map(({ heading, markdown }) => ({ heading, markdown })) });
  }
  for (let index = 0; index < topics.length; index += TEACHING_TOPICS_PER_PACKET) {
    const group = topics.slice(index, index + TEACHING_TOPICS_PER_PACKET);
    add("teaching", `teaching:${index / TEACHING_TOPICS_PER_PACKET + 1}`,
      `Crew assignment: topics ${index + 1}-${index + group.length} of ${topics.length}, ${group.map(topic => `"${topic.heading}"`).join(", ")}. Review only these topics' explanations against their source pages; the outline shows where they sit, and earlier topics may already define terms. The objective check plan and whole-lesson flow are reviewed by a separate coherence check.`,
      { reads: sorted(group.flatMap(topic => topic.pages)) },
      { topics: group.map((topic, offset) => ({ index: index + offset + 1, heading: topic.heading, markdown: topic.markdown })), checklist: group.flatMap(topic => topic.coverage) });
  }
  add("teaching", "teaching:coherence", "Crew assignment: whole-lesson coherence. Using the outline, checklist, recap, key points and key equations, check topic order, gaps or repetition between topics, consistent notation and terminology, and the objective check plan. Other crew members check each topic against its pages; do not demand passages you cannot see.",
    {}, { checks: section.objectiveChecks, requiredChecks: section.requiredChecks, recap: section.synthesis, keyPoints: section.keyPoints,
      checklist: coverage.map(({ id, kind, description, sourcePages, objective }) => ({ id, kind, description, sourcePages, objective })),
      keyEquations: topics.flatMap(topic => topic.markdown.match(/^> \[!note\][+-]? Key equation[^\n]*(?:\n>[^\n]*)*/gm) || []) });

  const packets: Array<{ pages: number[]; crops: ScholarSnapshot[]; topics: Topic[] }> = [];
  // A crop always travels with its full page; a crowded page repeats in each packet.
  const pack = (packetTopics: Topic[], viewPages: number[], packetCrops: ScholarSnapshot[]) => {
    let current = { pages: [] as number[], crops: [] as ScholarSnapshot[], topics: packetTopics };
    const size = () => current.pages.length + current.crops.length;
    const flush = () => { if (current.pages.length) packets.push(current); current = { pages: [], crops: [], topics: packetTopics }; };
    for (const page of viewPages) {
      const own = packetCrops.filter(crop => crop.page === page);
      if (size() && size() + 1 + Math.min(own.length, visualPacketImages - 1) > visualPacketImages) flush();
      current.pages.push(page);
      for (const crop of own) {
        if (size() >= visualPacketImages) { flush(); current.pages.push(page); }
        current.crops.push(crop);
      }
    }
    flush();
  };
  // One unit per topic that carries a figure or an equation. Independent topics share a
  // packet while the page+crop budget holds, so a figure-heavy section plans a few broad
  // visual checks instead of one request per topic.
  const units = topics.flatMap(topic => {
    const topicCrops = crops.filter(crop => topic.cropIds.includes(crop.id)), math = topic.markdown.includes("$$");
    if (!topicCrops.length && !math) return [];
    return [{ topic, pages: sorted([...topicCrops.map(crop => crop.page), ...(math ? topic.pages : [])]), crops: topicCrops }];
  });
  for (let index = 0; index < units.length;) {
    const group = { topics: [] as Topic[], pages: [] as number[], crops: [] as ScholarSnapshot[] };
    while (index < units.length) {
      const unit = units[index]!;
      const fits = group.pages.length + group.crops.length + unit.pages.length + unit.crops.length <= visualPacketImages;
      // A single oversized unit still forms a group; the filler below splits it by page.
      if (!fits && group.topics.length) break;
      group.topics.push(unit.topic);
      group.pages.push(...unit.pages);
      group.crops.push(...unit.crops);
      index += 1;
    }
    pack(group.topics, sorted(group.pages), group.crops);
  }
  const viewed = new Set(packets.flatMap(packet => packet.pages)), placed = new Set(packets.flatMap(packet => packet.crops.map(crop => crop.id)));
  const loose = crops.filter(crop => !placed.has(crop.id));
  // The visual role always closes with an inventory check, so every section has one visual
  // receipt: it judges the saved figure observations and the lesson's key equations where no
  // topic packet reaches them, and it carries any crop no topic placed. Pages no topic packet
  // named are listed as inventory context, never rendered.
  const strayPages = pages.filter(page => !viewed.has(page));
  for (let index = 0; index < Math.max(1, Math.ceil(loose.length / visualPacketImages)); index++) {
    const chunk = loose.slice(index * visualPacketImages, (index + 1) * visualPacketImages);
    packets.push({ pages: chunk.length ? sorted(chunk.map(crop => crop.page)) : strayPages, crops: chunk, topics: [] });
  }
  packets.forEach((packet, index) => add("visual", `visual:${index + 1}`, packet.topics.length
    ? `Crew assignment: figures and equations for topic(s) ${packet.topics.map(topic => `"${topic.heading}"`).join(", ")} (pages ${packet.pages.join(", ")}). Compare the listed crops with each topic's captions, explanations and Key equation callouts. Other crew members review the other topics and pages.`
    : `Crew assignment: figure inventory and equation check for pages ${packet.pages.join(", ")}.${packet.crops.length ? " Inspect each listed crop against its figure's observation and the lesson text; a saved crop must show its complete source figure with its labels, arrows and units." : ""} Check that every listed page's visual observation accounts for its figures, and that central equations appear in expanded native Key equation callouts with definitions, assumptions and meaning. You see no page render: judge only the listed evidence. Other crew members review the placed figures and equations topic by topic.`,
    // No full-page renders: the visual check judges the saved crops, their captions and the
    // inventory observations. Crops are the largest remaining image cost, so a page is bundled
    // only when one of its figures is actually placed in a topic.
    { cropIds: packet.crops.map(crop => crop.id) },
    packet.topics.length
      ? { topics: packet.topics.map(({ heading, markdown }) => ({ heading, markdown })), figures: packet.crops }
      : { pages: packet.pages, figureInventory: (section.figureCoverage?.pages || []).filter(page => packet.pages.includes(page.page)), figures: packet.crops,
        keyEquations: topics.flatMap(topic => topic.markdown.match(/^> \[!note\][+-]? Key equation[^\n]*(?:\n>[^\n]*)*/gm) || []) }));
  return assignments;
}

/** A saved in-progress receipt: never approval, only a carrier for finished checks. */
export function reviewCheckpoint(section: ScholarSection, book: ScholarBook, ctx: ExtensionContext, role: LessonReviewRole, batches: ReviewBatchPass[]): ReviewReceipt {
  return { ...blocking(REVIEW_CHECKPOINT_MESSAGE), role, contentHash: learnReviewHash(section), sourceHash: book.source.fingerprint.sha256,
    model: reviewerModelName(ctx), createdAt: new Date().toISOString(),
    failure: { code: "cancelled", message: REVIEW_CHECKPOINT_MESSAGE }, batches: uniqueBatches(batches) };
}

/**
 * Scholar coordinates a crew of small, isolated reviewers running in parallel. Each
 * passing check is cached by the exact packet it saw (instructions, evidence, crop
 * bytes, model and reasoning level), so edits and interruptions re-run only affected checks.
 */
export async function reviewLearnDraft(options: ReviewOptions): Promise<ReviewReceipt[]> {
  const timeoutMs = options.reviewTimeoutMs ?? DEFAULT_REVIEWER_LIMITS.timeoutMs;
  options = { ...options, prepared: true, deadlineAt: Date.now() + timeoutMs };
  const { section, book, ctx } = options;
  const hash = learnReviewHash(section), sourceHash = book.source.fingerprint.sha256;
  const roles = ["source", "teaching", "visual"] as const;
  const existing = section.learnQuality?.reviews || [];
  const report = (event: ReviewerProgress) => { try { options.onProgress?.(event); } catch { /* display only */ } };
  const reused = new Map<LessonReviewRole, ReviewReceipt>();
  for (const role of roles) {
    const receipts = existing.filter(item => item.role === role);
    if (!reviewGateIssues(receipts, { contentHash: hash, sourceHash, roles: [role] }).length) {
      reused.set(role, [...receipts].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!);
    }
  }
  for (const role of reused.keys()) report({ role, stage: "complete", outcome: "pass", turn: 0, toolCalls: 0, reused: true });
  const assignments = planReviewAssignments(section, sourceHash, ctx.model?.contextWindow).filter(item => !reused.has(item.role as LessonReviewRole));
  const runResults = assignments.length
    ? await runReviewPass(
        {
          ...options,
          snapshots: currentReviewSnapshots(section, sourceHash),
          sourceHash,
          contentHash: hash,
          existingReviews: existing,
        },
        assignments,
      )
    : [];
  const resultMap = new Map(runResults.map(r => [r.role, r]));
  return roles.map(role => {
    const receipt = reused.get(role) || resultMap.get(role);
    if (!receipt) throw new Error(`Scholar did not finish every planned ${role} check.`);
    return receipt;
  });
}

export async function reviewLearnQuestion(options: ReviewOptions, value: unknown, sourcePages: number[]): Promise<(current: ScholarSection) => void> {
  const verify = await reviewTargetQuestion({ ...options, target: options.section }, value, sourcePages);
  return current => verify(current);
}
