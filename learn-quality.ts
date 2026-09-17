import { createHash } from "node:crypto";

/**
 * Pure Learn delivery contracts. These checks establish traceable evidence and
 * current review receipts; they cannot themselves certify scientific accuracy.
 * The coordinator, never the lesson author, records completed reviewer results.
 */
export const SOURCE_COVERAGE_KINDS = ["concept", "definition", "derivation", "equation", "assumption", "example", "counterexample", "figure"] as const;
export type SourceCoverageKind = typeof SOURCE_COVERAGE_KINDS[number];
export type SourceCoverageItem = {
  id: string;
  kind: SourceCoverageKind;
  description: string;
  sourcePages: number[];
  objective: string;
  // A source plan can be saved before a lesson exists. All delivery evidence is
  // required when committing the finished lesson, not during initial planning.
  lessonId?: string;
  evidence?: string;
  equationId?: string;
  snapshotId?: string;
};
export type CoverageUpdate = Pick<SourceCoverageItem, "id"> & Partial<Pick<SourceCoverageItem, "lessonId" | "evidence" | "equationId" | "snapshotId">>;

/** Change delivery pointers without retransmitting or shrinking the source plan. */
export function updateCoverageEvidence(ledger: SourceCoverageItem[], updates: CoverageUpdate[]): SourceCoverageItem[] {
  if (!Array.isArray(updates) || !updates.length || updates.length > 200
    || !updates.every(update => object(update) && keys(update, ["id", "lessonId", "evidence", "equationId", "snapshotId"]) && id(update.id)
      && Object.keys(update).length > 1) || new Set(updates.map(update => update.id)).size !== updates.length) {
    throw new Error("coverageUpdates needs unique existing item IDs and only lessonId/evidence/equationId/snapshotId fields.");
  }
  const result = ledger.map(item => ({ ...item }));
  for (const update of updates) {
    const index = result.findIndex(item => item.id === update.id);
    if (index < 0) throw new Error(`Unknown source item ${update.id}; coverageUpdates cannot add or remove source requirements.`);
    const next = { ...result[index]!, ...update };
    if (!isSourceCoverageItem(next)) throw new Error(`Invalid delivery evidence for source item ${update.id}.`);
    result[index] = next;
  }
  return result;
}
export type SourceCoverageLesson = {
  id: string;
  markdown: string;
  /** IDs extracted from the renderer's saved equation receipts. */
  keyEquationIds?: readonly string[];
  /** IDs resolved from actual embeds in this saved lesson, not author claims. */
  embeddedSnapshotIds?: readonly string[];
};
export type SourceObjectiveCheck = { objective: string; checks: readonly string[] };
export type SourceCoverageContext = {
  startPage: number;
  endPage: number;
  objectives: readonly string[];
  lessons: readonly SourceCoverageLesson[];
  objectiveChecks?: readonly SourceObjectiveCheck[];
};

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));
const text = (value: unknown, maximum = 4000): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
const id = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(value);
const pages = (value: unknown): value is number[] => Array.isArray(value) && value.every(page => Number.isSafeInteger(page) && page > 0) && new Set(value).size === value.length;
const sha256 = (value: unknown): value is string => typeof value === "string" && /^[a-f\d]{64}$/.test(value);
const optional = (value: Record<string, unknown>, key: string, check: (value: unknown) => boolean) => !(key in value) || check(value[key]);

export function isSourceCoverageItem(value: unknown): value is SourceCoverageItem {
  return object(value) && keys(value, ["id", "kind", "description", "sourcePages", "objective", "lessonId", "evidence", "equationId", "snapshotId"])
    && id(value.id) && SOURCE_COVERAGE_KINDS.includes(value.kind as SourceCoverageKind)
    && text(value.description) && pages(value.sourcePages) && value.sourcePages.length > 0 && text(value.objective)
    && optional(value, "lessonId", id) && optional(value, "evidence", item => text(item, 24000))
    && optional(value, "equationId", id) && optional(value, "snapshotId", id);
}

export function isSourceCoverageLedger(value: unknown): value is SourceCoverageItem[] {
  return Array.isArray(value) && value.every(isSourceCoverageItem) && new Set(value.map(item => item.id)).size === value.length;
}

export const matchesLessonId = (saved: string, input: string) => saved === input || saved === `lesson-${input}`
  || (!saved.startsWith("lesson-") && `lesson-${saved}` === input);
const normalizedLabel = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const comparableMarkdown = (value: string) => value.replace(/\r\n/g, "\n").trim();

/** Reject metadata labels posing as lesson evidence; the reviewer checks meaning. */
function hasBodyEvidence(evidence: string, item: SourceCoverageItem): boolean {
  const visible = evidence.split(/\r?\n/).map(line => line.replace(/^(?:\s*>\s?)+/, "").trim())
    .filter(line => line && !/^#{1,6}\s/.test(line) && !/^\[!/.test(line) && !/^<!--.*-->$/.test(line)
      && !/^!?(?:\[\[[^\]]+\]\]|\[[^\]]*\]\([^)]*\))$/.test(line) && !/^[-*_`~\s]+$/.test(line)).join(" ");
  const normalized = normalizedLabel(visible);
  return !!normalized && ![item.id, item.description, item.objective, item.kind].some(label => normalizedLabel(label) === normalized);
}

/** Derivation mastery needs applied reasoning or calculation, not recall alone. */
export function sourceAssessmentIssues(ledger: readonly SourceCoverageItem[], objectiveChecks: readonly SourceObjectiveCheck[] | undefined): string[] {
  const issues: string[] = [];
  for (const objective of new Set(ledger.filter(item => item.kind === "derivation").map(item => item.objective))) {
    const check = objectiveChecks?.find(item => item.objective === objective);
    if (!check?.checks.some(kind => kind === "application" || kind === "computation")) {
      issues.push(`Derivation objective "${objective}" needs an application or computation check that asks for its reasoning.`);
    }
  }
  return issues;
}

/**
 * Plan mode validates source scope. Delivery mode additionally links each item
 * to a verbatim, non-label excerpt in the actual saved lesson and verifies the
 * relevant saved equation/figure ID. This is evidence integrity, not a word quota.
 */
export function sourceCoverageIssues(value: unknown, context: SourceCoverageContext, options: { delivered?: boolean } = {}): string[] {
  if (!isSourceCoverageLedger(value)) return ["Provide a valid source-coverage ledger with unique IDs and supported fields."];
  const issues: string[] = [];
  const delivered = options.delivered === true;
  if (!value.length) issues.push("Build a source-based coverage plan before completing Learn.");
  for (const objective of context.objectives) {
    if (!value.some(item => item.objective === objective)) issues.push(`Add source coverage for objective: ${objective}`);
  }
  for (const item of value) {
    const prefix = `Source item ${item.id}`;
    if (!context.objectives.includes(item.objective)) issues.push(`${prefix} must name an exact declared objective.`);
    if (item.sourcePages.some(page => page < context.startPage || page > context.endPage)) issues.push(`${prefix} cites a page outside this section.`);
    if (!delivered) continue;
    if (!item.lessonId || !item.evidence) {
      issues.push(`${prefix} needs a lessonId and an exact explanatory excerpt from the saved lesson.`);
      continue;
    }
    // Public lesson input IDs omit the storage prefix; both forms resolve to the
    // same unit. Multiple matches are ambiguous and must not certify coverage.
    const matches = context.lessons.filter(lesson => matchesLessonId(lesson.id, item.lessonId!));
    if (matches.length !== 1) {
      issues.push(`${prefix} must resolve to one current saved lesson unit.`);
      continue;
    }
    const lesson = matches[0]!;
    if (!comparableMarkdown(lesson.markdown).includes(comparableMarkdown(item.evidence))) issues.push(`${prefix} evidence is not an exact excerpt of its saved lesson.`);
    if (!hasBodyEvidence(item.evidence, item)) issues.push(`${prefix} needs explanatory body evidence, not just a heading, label, or figure embed.`);
    if ((item.kind === "equation" || item.equationId) && (!item.equationId || !lesson.keyEquationIds?.includes(item.equationId))) {
      issues.push(`${prefix} needs a designated Key equation ID actually rendered in this lesson unit.`);
    }
    if ((item.kind === "figure" || item.snapshotId) && (!item.snapshotId || !lesson.embeddedSnapshotIds?.includes(item.snapshotId))) {
      issues.push(`${prefix} needs a saved snapshot ID actually embedded in this lesson unit.`);
    }
  }
  return [...new Set(issues)];
}

export const REVIEW_ROLES = ["source", "teaching", "visual", "assessment"] as const;
export type ReviewRole = typeof REVIEW_ROLES[number];
export type ReviewFinding = {
  severity: "blocking" | "advice";
  target: string;
  sourcePages: number[];
  issue: string;
  repair: string;
};
export type ReviewResult = { status: "pass" | "changes"; findings: ReviewFinding[] };
export type ReviewerVerdict = ReviewResult;
export const REVIEW_FAILURE_CODES = ["cancelled", "timeout", "limit", "provider", "tool", "invalid-output", "configuration", "evidence"] as const;
export type ReviewFailure = { code: typeof REVIEW_FAILURE_CODES[number]; message: string };
export type ReviewBatchPass = { key: string; findings: ReviewFinding[] };
export type ReviewReceipt = ReviewResult & {
  role: ReviewRole;
  contentHash: string;
  sourceHash: string;
  /** Provider/model identity returned by the runner, with no provider restriction. */
  model: string;
  createdAt: string;
  /** Runner-owned execution failure, never a model-authored content verdict. */
  failure?: ReviewFailure;
  /** Successful scoped work, stored with the parent lesson/source hashes in the vault. */
  batches?: ReviewBatchPass[];
  diagnostics?: { elapsedMs: number; modelTurns: number; toolCalls: number; inputTokens: number; outputTokens: number };
};

export function isReviewFinding(value: unknown): value is ReviewFinding {
  return object(value) && keys(value, ["severity", "target", "sourcePages", "issue", "repair"])
    && (value.severity === "blocking" || value.severity === "advice")
    && text(value.target, 1000) && pages(value.sourcePages) && value.sourcePages.length <= 100
    && text(value.issue) && text(value.repair);
}

export type FindingResponse = {
  key: string;
  action: "fixed" | "declined";
  note: string;
};

export function computeFindingKey(role: string, finding: Pick<ReviewFinding, "target" | "issue">): string {
  return createHash("sha256").update(`${role}\u0000${finding.target}\u0000${finding.issue}`).digest("hex").slice(0, 12);
}

export function isFindingResponse(value: unknown): value is FindingResponse {
  return object(value) && keys(value, ["key", "action", "note"])
    && typeof value.key === "string" && value.key.length >= 1 && value.key.length <= 64
    && (value.action === "fixed" || value.action === "declined")
    && typeof value.note === "string" && value.note.trim().length >= 1 && value.note.length <= 600;
}

function validReviewFields(value: Record<string, unknown>): boolean {
  if ((value.status !== "pass" && value.status !== "changes") || !Array.isArray(value.findings)
    || value.findings.length > 40 || !value.findings.every(isReviewFinding)) return false;
  const blocking = value.findings.some(finding => finding.severity === "blocking");
  return value.status === "pass" ? !blocking : blocking;
}

export function isReviewResult(value: unknown): value is ReviewResult {
  return object(value) && keys(value, ["status", "findings"]) && validReviewFields(value);
}

function extractStatusJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === "\\") {
      escape = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (char === "{") {
        if (depth === 0) start = i;
        depth++;
      } else if (char === "}") {
        if (depth > 0) {
          depth--;
          if (depth === 0 && start !== -1) {
            const candidate = text.slice(start, i + 1);
            if (candidate.includes('"status"')) {
              candidates.push(candidate);
            }
            start = -1;
          }
        }
      }
    }
  }
  return candidates;
}

/** A malformed or contradictory answer is a failed review, never an implicit pass. */
export function parseReviewerVerdict(raw: string): ReviewerVerdict {
  if (typeof raw !== "string" || raw.length > 360000) throw new Error("Reviewer output is missing or too large.");
  const trimmed = raw.trim();
  let candidate = trimmed;
  const fenced = /^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed);
  if (fenced) candidate = fenced[1]!.trim();

  let directParsed: unknown = undefined;
  try {
    directParsed = JSON.parse(candidate);
    if (isReviewResult(directParsed)) return directParsed;
  } catch {
    // strict direct parse failed, attempt balanced {...} extraction below
  }

  const candidates = extractStatusJsonCandidates(raw);
  let parsedCandidate: unknown = directParsed;
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(candidates[i]!);
      parsedCandidate = parsed;
      if (isReviewResult(parsed)) return parsed;
    } catch {
      // not valid JSON
    }
  }

  if (parsedCandidate !== undefined) {
    throw new Error("Reviewer verdict has invalid fields or a status that contradicts its findings.");
  }
  throw new Error("Reviewer output must be one complete JSON verdict.");
}

/**
 * Keep the receipts that still describe this target.
 *
 * Receipts from another source or reviewer model can never be reused. Within one role and
 * content hash only the newest completed check and the newest receipt overall survive: the
 * first is the evidence, the second is what the approval gate consumes. An interrupted
 * checkpoint is dropped once that role and content hash has a completed check, because the
 * checkpoint only ever carried finished checks forward.
 */
export function pruneReviewReceipts(receipts: ReviewReceipt[], current: { sourceHash: string; model: string }): ReviewReceipt[] {
  const currentOnly = receipts.filter(receipt => receipt.sourceHash === current.sourceHash && receipt.model === current.model);
  const groupOf = (receipt: ReviewReceipt) => `${receipt.role}:${receipt.contentHash}`;
  // Selection is by position, not object identity, so repeating an already-saved receipt
  // (the same object twice in one merge) collapses instead of surviving as a duplicate.
  const newest = new Map<string, number>();
  const completed = new Map<string, number>();
  currentOnly.forEach((receipt, index) => {
    const group = groupOf(receipt);
    const leader = newest.get(group);
    if (leader === undefined || receipt.createdAt > currentOnly[leader]!.createdAt) newest.set(group, index);
    if (receipt.failure) return;
    const finished = completed.get(group);
    if (finished === undefined || receipt.createdAt > currentOnly[finished]!.createdAt) completed.set(group, index);
  });
  return currentOnly.filter((receipt, index) => {
    const group = groupOf(receipt);
    // Only the checkpoint carrier writes this code, so `cancelled` identifies one unambiguously.
    if (receipt.failure?.code === "cancelled" && completed.has(group)) return false;
    return index === newest.get(group) || index === completed.get(group);
  });
}

export type ReviewPassContext = ReviewGateContext & {
  /** Author responses to earlier blocking findings; an answered finding no longer blocks. */
  responses?: readonly { key: string }[];
};

/**
 * The gate every mode uses before committing reviewed content.
 *
 * A strict pass approves immediately. Otherwise each role's newest receipt for this source is
 * the evidence: its blocking findings must be answered by the author, an unfinished check still
 * approves when it found nothing blocking (the failure is reported separately), and a receipt
 * older than the current content is stale. Receipts are never re-run to satisfy this gate;
 * answering a finding is what closes it.
 */
export function reviewPassIssues(value: unknown, context: ReviewPassContext): string[] {
  if (!Array.isArray(value) || !value.every(isReviewReceipt)) return ["Completed specialist reviews with valid coordinator receipts are required."];
  if (!sha256(context.contentHash) || !sha256(context.sourceHash)) return ["Review gating requires current lesson and source hashes."];
  const roles: readonly ReviewRole[] = context.roles || ["source", "teaching", "visual"];
  if (!roles.length || roles.some(role => !REVIEW_ROLES.includes(role)) || new Set(roles).size !== roles.length) return ["Specify distinct supported review roles."];
  if (!reviewGateIssues(value, { contentHash: context.contentHash, sourceHash: context.sourceHash, roles }).length) return [];
  const receipts = (value as ReviewReceipt[]).filter(receipt => receipt.sourceHash === context.sourceHash);
  const issues: string[] = [];
  const latestByRole = new Map<ReviewRole, ReviewReceipt>();
  for (const role of roles) {
    const roleReceipts = receipts.filter(receipt => receipt.role === role).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const latest = roleReceipts[0];
    if (!latest) { issues.push(`Complete the ${role} review.`); continue; }
    if (roleReceipts.some(receipt => receipt.createdAt === latest.createdAt && JSON.stringify(receipt) !== JSON.stringify(latest))) {
      issues.push(`The ${role} review has conflicting receipts; run a fresh review.`);
      continue;
    }
    latestByRole.set(role, latest);
  }
  if (issues.length) return issues;
  const responseKeys = new Set((context.responses || []).map(response => response.key));
  const blockingFindings = [...latestByRole].flatMap(([role, latest]) => latest.findings
    .filter(finding => finding.severity === "blocking")
    .map(finding => ({ role, key: computeFindingKey(role, finding), finding })));
  if (blockingFindings.length) {
    return blockingFindings.filter(item => !responseKeys.has(item.key))
      .map(item => `Respond to blocking finding [F-${item.key}] (${item.role}: ${item.finding.issue}).`);
  }
  if ([...latestByRole.values()].some(receipt => receipt.failure)) return [];
  return [...latestByRole].filter(([, latest]) => latest.contentHash !== context.contentHash)
    .map(([role]) => `The ${role} review is stale; review the current lesson and source.`);
}

export type UnitReviewFinding = { role: ReviewRole; key: string; finding: ReviewFinding };

/**
 * The approval evidence for one saved unit revision: the newest receipt per role bound to
 * this exact content revision and source. A receipt from another revision is never selected,
 * so an old pass can neither approve nor block the replacement.
 */
export function unitReviewRoles(value: unknown, context: { contentHash: string; sourceHash: string; roles: readonly ReviewRole[] }): Array<{ role: ReviewRole; receipt?: ReviewReceipt }> {
  const receipts = (Array.isArray(value) ? value : []).filter(isReviewReceipt);
  return context.roles.map(role => ({
    role,
    receipt: receipts.filter(receipt => receipt.role === role && receipt.contentHash === context.contentHash && receipt.sourceHash === context.sourceHash)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0],
  }));
}

/** The per-unit gate: only receipts of this revision are evidence for it. */
export function reviewUnitIssues(value: unknown, context: ReviewPassContext & { contentHash: string }): string[] {
  if (!Array.isArray(value) || !value.every(isReviewReceipt)) return ["Completed specialist reviews with valid coordinator receipts are required."];
  return reviewPassIssues(value.filter(receipt => receipt.contentHash === context.contentHash), context);
}

/** Blocking findings of this revision that the author has not answered. A receipt's own
 * execution-failure carrier is excluded: an unfinished check is retried, not answered. */
export function unitBlockingFindings(value: unknown, context: { contentHash: string; sourceHash: string; roles: readonly ReviewRole[]; responses?: readonly { key: string }[] }): UnitReviewFinding[] {
  const responses = new Set((context.responses || []).map(response => response.key));
  return unitReviewRoles(value, context).flatMap(({ role, receipt }) => !receipt || receipt.status !== "changes" ? []
    : receipt.findings.filter(finding => finding.severity === "blocking")
      .filter(finding => !(receipt.failure && finding.target === "review evidence" && finding.issue === receipt.failure.message))
      .map(finding => ({ role, key: computeFindingKey(role, finding), finding }))
      .filter(item => !responses.has(item.key)));
}

/** Runner-owned execution failures recorded for this revision. */
export function unitReviewFailures(value: unknown, context: { contentHash: string; sourceHash: string; roles: readonly ReviewRole[] }): ReviewFailure[] {
  return unitReviewRoles(value, context).flatMap(({ receipt }) => receipt?.failure ? [receipt.failure] : []);
}

export function isReviewReceipt(value: unknown): value is ReviewReceipt {
  if (!object(value) || !keys(value, ["role", "contentHash", "sourceHash", "model", "createdAt", "status", "findings", "failure", "batches", "diagnostics"])
    || !validReviewFields(value) || !REVIEW_ROLES.includes(value.role as ReviewRole)
    || !sha256(value.contentHash) || !sha256(value.sourceHash) || !text(value.model, 300)
    || typeof value.createdAt !== "string") return false;
  if (value.failure !== undefined && (value.status !== "changes" || !object(value.failure)
    || !keys(value.failure, ["code", "message"]) || !REVIEW_FAILURE_CODES.includes(value.failure.code as ReviewFailure["code"])
    || !text(value.failure.message))) return false;
  if (value.batches !== undefined && (!Array.isArray(value.batches) || value.batches.length > 128
    || !value.batches.every(batch => object(batch) && keys(batch, ["key", "findings"]) && sha256(batch.key)
      && Array.isArray(batch.findings) && batch.findings.length <= 40 && batch.findings.every(finding => isReviewFinding(finding) && finding.severity === "advice"))
    || new Set(value.batches.map(batch => batch.key)).size !== value.batches.length)) return false;
  if (value.diagnostics !== undefined && (!object(value.diagnostics) || !keys(value.diagnostics, ["elapsedMs", "modelTurns", "toolCalls", "inputTokens", "outputTokens"])
    || Object.keys(value.diagnostics).length !== 5 || Object.values(value.diagnostics).some(value => !Number.isSafeInteger(value) || Number(value) < 0))) return false;
  const time = new Date(value.createdAt);
  return Number.isFinite(time.getTime()) && time.toISOString() === value.createdAt;
}

export type ReviewGateContext = { contentHash: string; sourceHash: string; roles?: readonly ReviewRole[] };

/**
 * Only coordinator-created receipts belong here. Schema validation is not an
 * authentication boundary: author tools must not accept supplied review passes.
 */
export function reviewGateIssues(value: unknown, context: ReviewGateContext): string[] {
  if (!Array.isArray(value) || !value.every(isReviewReceipt)) return ["Completed specialist reviews with valid coordinator receipts are required."];
  if (!sha256(context.contentHash) || !sha256(context.sourceHash)) return ["Review gating requires current lesson and source hashes."];
  const roles: readonly ReviewRole[] = context.roles || ["source", "teaching", "visual"];
  if (!roles.length || roles.some(role => !REVIEW_ROLES.includes(role)) || new Set(roles).size !== roles.length) return ["Specify distinct supported review roles."];
  const issues: string[] = [];
  for (const role of roles) {
    const receipts = value.filter(receipt => receipt.role === role).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const latest = receipts[0];
    if (!latest) { issues.push(`Complete the ${role} review.`); continue; }
    const tied = receipts.filter(receipt => receipt.createdAt === latest.createdAt);
    if (tied.some(receipt => JSON.stringify(receipt) !== JSON.stringify(latest))) {
      issues.push(`The ${role} review has conflicting receipts; run a fresh review.`);
      continue;
    }
    if (latest.contentHash !== context.contentHash || latest.sourceHash !== context.sourceHash) issues.push(`The ${role} review is stale; review the current lesson and source.`);
    else if (latest.failure) issues.push(`Complete the ${role} review (${latest.failure.code}); the saved draft has not been approved. Resume the review, not a rewrite based on this execution failure alone.`);
    else if (latest.status !== "pass") issues.push(`Repair the blocking ${role} findings and recheck the revised lesson.`);
  }
  return issues;
}
