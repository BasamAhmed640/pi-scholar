import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { learnReviewHash, lessonHash, validLessonEntries } from "./lesson.ts";
import {
  isReviewReceipt,
  matchesLessonId,
  reviewGateIssues,
  type ReviewBatchPass,
  type ReviewReceipt,
  type ReviewRole,
  type ReviewerVerdict,
  type ReviewFailure,
  type SourceCoverageItem,
} from "./learn-quality.ts";
import {
  DEFAULT_REVIEWER_LIMITS,
  type ReviewerProgress,
} from "./review-runtime.ts";
import type { ScholarBook, ScholarConfig, ScholarSection, ScholarSnapshot } from "./types.ts";
import {
  ReviewPacket,
  ReviewPacketRole,
  ReviewEvidence,
  createReviewEvidence,
  REVIEW_CONCURRENCY,
  REVIEW_CHECKPOINT_MESSAGE,
  REVIEW_INSTRUCTIONS,
  reviewOne,
  runReviewPass,
  aggregateReviews,
  blocking,
  pageRuns,
  planExamReviewPackets,
  planTutorExplanationPacket,
  reviewTargetQuestion,
  type ReviewRunnerOptions,
} from "./review-layer.ts";

export {
  ReviewPacket,
  ReviewPacketRole,
  ReviewEvidence,
  createReviewEvidence,
  REVIEW_CONCURRENCY,
  REVIEW_CHECKPOINT_MESSAGE,
  REVIEW_INSTRUCTIONS,
  reviewOne,
  runReviewPass,
  aggregateReviews,
  blocking,
  pageRuns,
  planExamReviewPackets,
  planTutorExplanationPacket,
  reviewTargetQuestion,
};

export type LessonReviewRole = "source" | "teaching" | "visual";
export type ReviewAssignment = ReviewPacket;
export type ReviewOptions = ReviewRunnerOptions & {
  section: ScholarSection;
};

const SOURCE_WINDOW_PAGES = 4;
const VISUAL_PACKET_IMAGES = 6;
const instructions = REVIEW_INSTRUCTIONS;

/** Replaced/unused crops remain in the note's history but are not current review work. */
export function currentReviewSnapshots(section: ScholarSection, sourceHash: string) {
  const ids = new Set(validLessonEntries(section, sourceHash).flatMap(entry => entry.lesson!.embeddedSnapshotIds || []));
  for (const page of section.figureCoverage?.pages || []) {
    for (const figure of page.review?.figures || []) if (figure.snapshotId) ids.add(figure.snapshotId);
  }
  return (section.snapshots || []).filter(snapshot => ids.has(snapshot.id));
}

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
 * topic, a visual/math packet per topic figure set, leftover pages and crops, and one
 * whole-lesson coherence check. Every page is read and viewed, and every current crop
 * inspected, by at least one packet, so the aggregate keeps full evidence coverage.
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
  topics.forEach((topic, index) => add("teaching", `teaching:${index + 1}`, `Crew assignment: topic ${index + 1} of ${topics.length}, "${topic.heading}". Review only this topic's explanation against its source pages; the outline shows where it sits, and earlier topics may already define terms. The objective check plan and whole-lesson flow are reviewed by a separate coherence check.`,
    { reads: topic.pages }, { topic: { index: index + 1, heading: topic.heading, markdown: topic.markdown }, checklist: topic.coverage }));
  add("teaching", "teaching:coherence", "Crew assignment: whole-lesson coherence. Using the outline, checklist, recap, key points and key equations, check topic order, gaps or repetition between topics, consistent notation and terminology, and the objective check plan. Other crew members check each topic against its pages; do not demand passages you cannot see.",
    {}, { checks: section.objectiveChecks, requiredChecks: section.requiredChecks, recap: section.synthesis, keyPoints: section.keyPoints,
      checklist: coverage.map(({ id, kind, description, sourcePages, objective }) => ({ id, kind, description, sourcePages, objective })),
      keyEquations: topics.flatMap(topic => topic.markdown.match(/^> \[!note\][+-]? Key equation[^\n]*(?:\n>[^\n]*)*/gm) || []) });

  const packets: Array<{ pages: number[]; crops: ScholarSnapshot[]; topic?: Topic }> = [];
  // A crop always travels with its full page; a crowded page repeats in each packet.
  const pack = (topic: Topic | undefined, viewPages: number[], packetCrops: ScholarSnapshot[]) => {
    let current = { pages: [] as number[], crops: [] as ScholarSnapshot[], topic };
    const size = () => current.pages.length + current.crops.length;
    const flush = () => { if (current.pages.length) packets.push(current); current = { pages: [], crops: [], topic }; };
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
  for (const topic of topics) {
    const topicCrops = crops.filter(crop => topic.cropIds.includes(crop.id)), math = topic.markdown.includes("$$");
    if (topicCrops.length || math) pack(topic, sorted([...topicCrops.map(crop => crop.page), ...(math ? topic.pages : [])]), topicCrops);
  }
  const viewed = new Set(packets.flatMap(packet => packet.pages)), placed = new Set(packets.flatMap(packet => packet.crops.map(crop => crop.id)));
  const loose = crops.filter(crop => !placed.has(crop.id));
  pack(undefined, sorted([...pages.filter(page => !viewed.has(page)), ...loose.map(crop => crop.page)]), loose);
  packets.forEach((packet, index) => add("visual", `visual:${index + 1}`, packet.topic
    ? `Crew assignment: figures and equations for topic "${packet.topic.heading}" (pages ${packet.pages.join(", ")}). Compare the listed full pages and crops with this topic's captions, explanations and Key equation callouts. Other crew members review the other topics and pages.`
    : `Crew assignment: full source pages ${packet.pages.join(", ")} and crops not placed in a lesson topic. Check crop completeness and labels, and whether the figure inventory observations match these pages. Other crew members review placed figures and equations.`,
    { views: packet.pages, cropIds: packet.crops.map(crop => crop.id) },
    packet.topic ? { topic: { heading: packet.topic.heading, markdown: packet.topic.markdown }, figures: packet.crops }
      : { pages: packet.pages, figureInventory: (section.figureCoverage?.pages || []).filter(page => packet.pages.includes(page.page)), figures: packet.crops }));
  return assignments;
}

function uniqueBatches(batches: ReviewBatchPass[]): ReviewBatchPass[] {
  return [...new Map(batches.map(batch => [batch.key, batch])).values()].slice(0, 128);
}

/** A saved in-progress receipt: never approval, only a carrier for finished checks. */
export function reviewCheckpoint(section: ScholarSection, book: ScholarBook, ctx: ExtensionContext, role: LessonReviewRole, batches: ReviewBatchPass[]): ReviewReceipt {
  return { ...blocking(REVIEW_CHECKPOINT_MESSAGE), role, contentHash: learnReviewHash(section), sourceHash: book.source.fingerprint.sha256,
    model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unavailable", createdAt: new Date().toISOString(),
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
