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
    && optional(value, "equationId", id) && optional(value, "snapshotId", id)
    && (!("equationId" in value) || value.kind === "equation")
    && (!("snapshotId" in value) || value.kind === "figure");
}

export function isSourceCoverageLedger(value: unknown): value is SourceCoverageItem[] {
  return Array.isArray(value) && value.every(isSourceCoverageItem) && new Set(value.map(item => item.id)).size === value.length;
}

const matchesLessonId = (saved: string, input: string) => saved === input || saved === `lesson-${input}`
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
    if (item.kind === "equation" && (!item.equationId || !lesson.keyEquationIds?.includes(item.equationId))) {
      issues.push(`${prefix} needs a designated Key equation ID actually rendered in this lesson unit.`);
    }
    if (item.kind === "figure" && (!item.snapshotId || !lesson.embeddedSnapshotIds?.includes(item.snapshotId))) {
      issues.push(`${prefix} needs a saved snapshot ID actually embedded in this lesson unit.`);
    }
  }
  if (delivered) issues.push(...sourceAssessmentIssues(value, context.objectiveChecks));
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
export type ReviewReceipt = ReviewResult & {
  role: ReviewRole;
  contentHash: string;
  sourceHash: string;
  /** Provider/model identity returned by the runner, with no provider restriction. */
  model: string;
  createdAt: string;
};

export function isReviewFinding(value: unknown): value is ReviewFinding {
  return object(value) && keys(value, ["severity", "target", "sourcePages", "issue", "repair"])
    && (value.severity === "blocking" || value.severity === "advice")
    && text(value.target, 1000) && pages(value.sourcePages) && value.sourcePages.length <= 100
    && text(value.issue) && text(value.repair);
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

/** A malformed or contradictory answer is a failed review, never an implicit pass. */
export function parseReviewerVerdict(raw: string): ReviewerVerdict {
  if (typeof raw !== "string" || raw.length > 360000) throw new Error("Reviewer output is missing or too large.");
  let json = raw.trim();
  const fenced = /^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i.exec(json);
  if (fenced) json = fenced[1]!.trim();
  let value: unknown;
  try { value = JSON.parse(json); }
  catch { throw new Error("Reviewer output must be one complete JSON verdict."); }
  if (!isReviewResult(value)) throw new Error("Reviewer verdict has invalid fields or a status that contradicts its findings.");
  return value;
}

export function isReviewReceipt(value: unknown): value is ReviewReceipt {
  if (!object(value) || !keys(value, ["role", "contentHash", "sourceHash", "model", "createdAt", "status", "findings"])
    || !validReviewFields(value) || !REVIEW_ROLES.includes(value.role as ReviewRole)
    || !sha256(value.contentHash) || !sha256(value.sourceHash) || !text(value.model, 300)
    || typeof value.createdAt !== "string") return false;
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
    else if (latest.status !== "pass") issues.push(`Repair the blocking ${role} findings and recheck the revised lesson.`);
  }
  return issues;
}
