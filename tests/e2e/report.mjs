#!/usr/bin/env node
// Per-stage timing/count report for a Scholar end-to-end run.
//
//   node tests/e2e/report.mjs <run-dir> [--compare <other report.json>]
//
// Rebuilds logs/report.{md,json} from logs/events.jsonl + logs/run-state.json.
// The harness calls buildReport()/writeReport() directly at the end of a run.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIALOG = new Set(["select", "confirm", "input", "editor"]);
const DONT_KNOW = /^\s*(?:\d+[.)]\s*)?i\s+(?:do not|don['’]t)\s+know\s*$/i;

function resultText(result) {
  const content = result?.content;
  if (!Array.isArray(content)) return typeof result === "string" ? result : "";
  return content.filter((item) => item?.type === "text").map((item) => item.text).join("\n");
}

const median = (values) => {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};
const max = (values) => (values.length ? Math.max(...values) : undefined);
const sum = (values) => values.reduce((total, value) => total + (value || 0), 0);

export function formatMs(ms) {
  if (ms === undefined || ms === null || Number.isNaN(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 90) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(Math.round(seconds - minutes * 60)).padStart(2, "0")}s`;
}

function isQuizDialog(entry) {
  const rec = entry.rec;
  if (rec.type !== "extension_ui_request") return false;
  if (rec.method === "select") return (rec.options || []).some((option) => DONT_KNOW.test(String(option)));
  if (rec.method === "input") return /numbers|e\.g\.\s*1\s*,\s*3/i.test(`${rec.title ?? ""} ${rec.placeholder ?? ""}`);
  return false;
}

/** Metrics for the events between two sequence numbers. */
export function stageMetrics(events, stage) {
  const inStage = events.filter((entry) => entry.seq > stage.startSeq && entry.seq <= (stage.endSeq ?? Infinity));
  const out = inStage.filter((entry) => entry.dir === "out");
  const metrics = {
    turns: 0, assistantMessages: 0, stopReasons: {}, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
    modelStreamingMs: 0, tools: {}, scholarActions: {}, scholarActionMs: {}, retries: 0, retrySamples: [], scholarErrors: 0, errorSamples: [],
    toolErrors: 0, generationStopped: 0, reviewIncomplete: 0, notifications: [], dialogs: 0, quizDialogs: 0, quizAnswered: 0, quizCancelled: 0,
    lessonCompleteCalls: [], examBuildCalls: [], questionPreReviewMs: [], answerToFeedbackMs: [], answerToNextQuestionMs: [],
    agentRuns: 0, aborts: 0, providerErrors: [],
  };
  const messageStarts = new Map();
  const toolStarts = new Map();
  const openQuizCalls = [];
  for (const entry of out) {
    const rec = entry.rec;
    switch (rec.type) {
      case "agent_start": metrics.agentRuns += 1; break;
      case "turn_end": metrics.turns += 1; break;
      case "message_start":
        if (rec.message?.role === "assistant") messageStarts.set(messageStarts.size, entry.at);
        break;
      case "message_end": {
        const message = rec.message || {};
        if (message.role !== "assistant") break;
        metrics.assistantMessages += 1;
        const startedAt = [...messageStarts.values()].at(-1);
        if (startedAt) metrics.modelStreamingMs += entry.at - startedAt;
        messageStarts.clear();
        metrics.stopReasons[message.stopReason || "?"] = (metrics.stopReasons[message.stopReason || "?"] || 0) + 1;
        if (message.stopReason === "aborted") metrics.aborts += 1;
        if (message.stopReason === "error" && message.errorMessage) metrics.providerErrors.push(String(message.errorMessage).slice(0, 200));
        const usage = message.usage || {};
        for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) metrics.usage[key] += Number(usage[key] || 0);
        metrics.usage.cost += Number(usage.cost?.total || 0);
        break;
      }
      case "tool_execution_start": {
        toolStarts.set(rec.toolCallId, { at: entry.at, name: rec.toolName, args: rec.args, seq: entry.seq });
        metrics.tools[rec.toolName] = (metrics.tools[rec.toolName] || 0) + 1;
        if (rec.toolName === "scholar") {
          const action = `${rec.args?.action || "?"}${rec.args?.action === "notes" && rec.args?.lessonComplete === true ? "+lessonComplete" : ""}`;
          metrics.scholarActions[action] = (metrics.scholarActions[action] || 0) + 1;
        }
        if (rec.toolName === "scholar_quiz") openQuizCalls.push({ toolCallId: rec.toolCallId, at: entry.at, seq: entry.seq, dialogs: 0 });
        break;
      }
      case "tool_execution_end": {
        const start = toolStarts.get(rec.toolCallId);
        const text = resultText(rec.result);
        if (rec.isError) metrics.toolErrors += 1;
        if (/Generation stopped/i.test(text)) metrics.generationStopped += 1;
        if (/review incomplete/i.test(text)) metrics.reviewIncomplete += 1;
        if (rec.toolName === "scholar") {
          const action = start?.args?.action || "?";
          const label = `${action}${action === "notes" && start?.args?.lessonComplete === true ? "+lessonComplete" : ""}`;
          if (start) metrics.scholarActionMs[label] = (metrics.scholarActionMs[label] || 0) + (entry.at - start.at);
          if (text.startsWith("Scholar retry")) { metrics.retries += 1; if (metrics.retrySamples.length < 6) metrics.retrySamples.push(`${action}: ${text.slice(15, 260)}`); }
          if (text.startsWith("Scholar error")) { metrics.scholarErrors += 1; if (metrics.errorSamples.length < 6) metrics.errorSamples.push(`${action}: ${text.slice(14, 260)}`); }
          if (action === "notes" && start?.args?.lessonComplete === true) metrics.lessonCompleteCalls.push({ ms: entry.at - start.at, result: text.slice(0, 220) });
          if (action === "exam_build") metrics.examBuildCalls.push({ ms: entry.at - start.at, result: text.slice(0, 220) });
        }
        const quiz = openQuizCalls.find((call) => call.toolCallId === rec.toolCallId);
        if (quiz) quiz.endAt = entry.at;
        break;
      }
      case "extension_ui_request": {
        if (rec.method === "notify") {
          metrics.notifications.push({ at: entry.at, type: rec.notifyType || "info", message: String(rec.message || "").slice(0, 300) });
          if (/Generation stopped/i.test(rec.message || "")) metrics.generationStopped += 1;
        }
        if (DIALOG.has(rec.method)) {
          metrics.dialogs += 1;
          if (isQuizDialog(entry)) {
            metrics.quizDialogs += 1;
            const call = [...openQuizCalls].reverse().find((candidate) => candidate.seq < entry.seq && (candidate.endAt === undefined || candidate.endAt >= entry.at));
            if (call && call.dialogs === 0) metrics.questionPreReviewMs.push(entry.at - call.at);
            if (call) call.dialogs += 1;
          }
        }
        break;
      }
      default: break;
    }
  }

  // Answer -> feedback / next question, from the learner's responses.
  const requests = new Map(inStage.filter((entry) => entry.dir === "out" && entry.rec.type === "extension_ui_request" && DIALOG.has(entry.rec.method)).map((entry) => [entry.rec.id, entry]));
  const quizRequests = inStage.filter((entry) => entry.dir === "out" && isQuizDialog(entry));
  for (const response of inStage.filter((entry) => entry.dir === "in" && entry.rec.type === "extension_ui_response")) {
    const request = requests.get(response.rec.id);
    if (!request || !isQuizDialog(request)) continue;
    if (response.rec.cancelled) { metrics.quizCancelled += 1; continue; }
    metrics.quizAnswered += 1;
    const after = inStage.filter((entry) => entry.seq > response.seq);
    const feedback = after.find((entry) => entry.dir === "out" && ((entry.rec.type === "extension_ui_request" && entry.rec.method === "notify") || (entry.rec.type === "tool_execution_end" && entry.rec.toolName === "scholar_quiz")));
    if (feedback) metrics.answerToFeedbackMs.push(feedback.at - response.at);
    const next = quizRequests.find((entry) => entry.seq > response.seq);
    if (next) metrics.answerToNextQuestionMs.push(next.at - response.at);
  }

  const marks = inStage.filter((entry) => entry.dir === "mark");
  const lessonReady = marks.find((entry) => entry.rec.name === "lesson_ready");
  const firstQuiz = quizRequests[0];
  metrics.lessonReadyMs = lessonReady ? lessonReady.at - stage.startAt : undefined;
  metrics.lessonReadySource = lessonReady?.rec.source;
  metrics.firstQuestionMs = firstQuiz ? firstQuiz.at - stage.startAt : undefined;
  metrics.durationMs = (stage.endAt ?? Date.now()) - stage.startAt;
  metrics.usage.cost = Number(metrics.usage.cost.toFixed(6));
  return metrics;
}

export function buildReport({ run, stages, events, learner, vault, failures, checks, compare }) {
  const stageReports = stages.map((stage) => ({
    name: stage.name, status: stage.status, startedAt: new Date(stage.startAt).toISOString(), durationMs: (stage.endAt ?? Date.now()) - stage.startAt,
    notes: stage.notes || [], checks: stage.checks || [], metrics: stageMetrics(events, stage),
  }));
  const totals = {
    durationMs: (run.finishedAt ?? Date.now()) - run.startedAt,
    turns: sum(stageReports.map((stage) => stage.metrics.turns)),
    assistantMessages: sum(stageReports.map((stage) => stage.metrics.assistantMessages)),
    retries: sum(stageReports.map((stage) => stage.metrics.retries)),
    scholarErrors: sum(stageReports.map((stage) => stage.metrics.scholarErrors)),
    generationStopped: sum(stageReports.map((stage) => stage.metrics.generationStopped)),
    tokens: {
      input: sum(stageReports.map((stage) => stage.metrics.usage.input)), output: sum(stageReports.map((stage) => stage.metrics.usage.output)),
      cacheRead: sum(stageReports.map((stage) => stage.metrics.usage.cacheRead)), total: sum(stageReports.map((stage) => stage.metrics.usage.totalTokens)),
      cost: Number(sum(stageReports.map((stage) => stage.metrics.usage.cost)).toFixed(6)),
    },
    scholarActions: stageReports.reduce((all, stage) => {
      for (const [action, count] of Object.entries(stage.metrics.scholarActions)) all[action] = (all[action] || 0) + count;
      return all;
    }, {}),
  };
  return {
    run, result: failures.length ? "FAIL" : "PASS", failures, checks, totals, stages: stageReports,
    dialogs: learner?.dialogs || [], unexpectedDialogs: learner?.unexpected || [], vault, compare,
  };
}

function table(headers, rows) {
  const escape = (value) => String(value ?? "—").replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`, ...rows.map((row) => `| ${row.map(escape).join(" | ")} |`)].join("\n");
}

const listStats = (values) => (values.length ? `${formatMs(median(values))} / ${formatMs(max(values))} (n=${values.length})` : "—");

export function reportMarkdown(report) {
  const { run } = report;
  const lines = [
    `# Scholar e2e report — ${run.scenario} — ${report.result}`, "",
    `- Run: \`${run.runId}\` · ${run.startedAtIso} · total ${formatMs(report.totals.durationMs)}`,
    `- Extension: \`${run.extensionDir}\`${run.git ? ` · ${run.git}` : ""}`,
    `- Pi ${run.piVersion} (\`${run.piCli}\`) · model \`${run.model}\` · thinking \`${run.thinking}\` · seed ${run.seed}`,
    `- Scratch: \`${run.runDir}\`${run.kept ? " (kept)" : " (library/vault/sessions/state removed; logs kept)"}`,
    `- Owner Scholar pointer untouched: ${run.ownerPointerUntouched === undefined ? "n/a" : run.ownerPointerUntouched ? "yes" : "**NO**"}`,
    `- Totals: ${report.totals.assistantMessages} model responses in ${report.totals.turns} turns · ${report.totals.retries} Scholar retries · ${report.totals.scholarErrors} Scholar errors · ${report.totals.generationStopped} "Generation stopped" · tokens in ${report.totals.tokens.input} / out ${report.totals.tokens.output} / cache ${report.totals.tokens.cacheRead} · cost ${report.totals.tokens.cost}`,
    "",
    "## Stage timings", "",
    table(["Stage", "Status", "Wall", "Lesson ready", "First question", "Model resp.", "Model stream", "Scholar calls", "Retries", "Tokens in/out"],
      report.stages.map((stage) => [stage.name, stage.status, formatMs(stage.durationMs), formatMs(stage.metrics.lessonReadyMs), formatMs(stage.metrics.firstQuestionMs),
        stage.metrics.assistantMessages, formatMs(stage.metrics.modelStreamingMs), sum(Object.values(stage.metrics.scholarActions)), stage.metrics.retries,
        `${stage.metrics.usage.input}/${stage.metrics.usage.output}`])),
    "",
    "## Learner-facing latencies (median / max)", "",
  ];
  const latencyStages = report.stages.filter((stage) => stage.metrics.quizDialogs || stage.metrics.lessonCompleteCalls.length);
  lines.push(latencyStages.length ? table(["Stage", "Quiz dialogs (answered/cancelled)", "Tool start → question shown", "Answer → feedback", "Answer → next question", "lessonComplete waits"],
    latencyStages.map((stage) => [
      stage.name, `${stage.metrics.quizDialogs} (${stage.metrics.quizAnswered}/${stage.metrics.quizCancelled})`, listStats(stage.metrics.questionPreReviewMs),
      listStats(stage.metrics.answerToFeedbackMs), listStats(stage.metrics.answerToNextQuestionMs),
      stage.metrics.lessonCompleteCalls.map((call) => formatMs(call.ms)).join(", ") || "—"])) : "No quiz dialogs or lesson commits in this run.",
  "",
  "## Scholar tool calls by action", "",
  table(["Stage", "Actions (count · total time)"], report.stages.map((stage) => [stage.name,
    Object.entries(stage.metrics.scholarActions).map(([action, count]) => `${action}×${count}${stage.metrics.scholarActionMs[action] ? ` (${formatMs(stage.metrics.scholarActionMs[action])})` : ""}`).join(", ") || "—"])),
  "");
  const failures = report.failures || [];
  lines.push("## Failures", "", failures.length ? failures.map((failure) => `- **${failure.stage}** — ${failure.reason}`).join("\n") : "None.", "");
  const checks = report.stages.flatMap((stage) => (stage.checks || []).map((check) => [stage.name, check.ok ? "ok" : "FAIL", check.name, check.detail ?? ""]));
  if (checks.length) lines.push("## Checks", "", table(["Stage", "Result", "Check", "Detail"], checks), "");
  const outcomeLines = report.stages.flatMap((stage) => [
    ...stage.metrics.lessonCompleteCalls.map((call) => `- ${stage.name} · lessonComplete (${formatMs(call.ms)}): ${call.result}`),
    ...stage.metrics.examBuildCalls.map((call) => `- ${stage.name} · exam_build (${formatMs(call.ms)}): ${call.result}`),
    ...stage.metrics.retrySamples.map((sample) => `- ${stage.name} · retry: ${sample}`),
    ...stage.metrics.errorSamples.map((sample) => `- ${stage.name} · error: ${sample}`),
    ...stage.metrics.providerErrors.map((sample) => `- ${stage.name} · provider error: ${sample}`),
  ]);
  if (outcomeLines.length) lines.push("## Notable tool outcomes", "", ...outcomeLines, "");
  const warnings = report.stages.flatMap((stage) => stage.metrics.notifications.filter((note) => note.type !== "info").map((note) => `- ${stage.name} · ${note.type}: ${note.message}`));
  if (warnings.length) lines.push("## Warning/error notifications", "", ...warnings, "");
  if (report.dialogs.length) {
    lines.push("## Dialogs shown", "", table(["Stage", "Kind", "Title", "Choice", "Intended"],
      report.dialogs.map((dialog) => [dialog.stage, dialog.kind, String(dialog.title || "").slice(0, 90), String(dialog.choice || "").slice(0, 70), dialog.intended || ""])), "");
  }
  if (report.unexpectedDialogs.length) lines.push("## Unexpected dialogs (cancelled)", "", ...report.unexpectedDialogs.map((dialog) => `- ${dialog.method}: ${dialog.title}`), "");
  const notes = report.stages.flatMap((stage) => (stage.notes || []).map((note) => `- ${stage.name}: ${note}`));
  if (notes.length) lines.push("## Stage notes", "", ...notes, "");
  if (report.vault) {
    const vault = report.vault;
    lines.push("## Vault inspection", "",
      `- ${vault.counts.notes} notes, ${vault.counts.assets} assets · types: ${Object.entries(vault.types).map(([type, count]) => `${type}×${count}`).join(", ")}`,
      `- Links: ${vault.links.total} (${vault.links.embeds} embeds) · unresolved: ${vault.links.unresolved.length}`,
      `- Mermaid: ${vault.mermaid.total} (${Object.entries(vault.mermaid.byKind).map(([kind, count]) => `${kind}×${count}`).join(", ") || "none"}) · lint errors: ${vault.mermaid.lintErrors.length}`,
      `- Math delimiter issues: ${vault.math.issues.length} · callouts: ${Object.entries(vault.callouts).map(([type, count]) => `${type}×${count}`).join(", ")}`,
      `- Duplicates: question blocks ${vault.duplicates.questionBlocks.length}, question ids ${vault.duplicates.questionIds.length}, lesson entry ids ${vault.duplicates.lessonEntryIds.length}, notes ${vault.duplicates.notes.length}`,
      "");
    if (vault.book) {
      lines.push(`- Book outline (${vault.book.outlineStatus}): ${vault.book.chapters.map((chapter) => `Ch ${chapter.number} p${chapter.startPage}-${chapter.endPage} [${chapter.sections.map((section) => `${section.number} p${section.startPage}-${section.endPage}`).join(", ")}]`).join("; ")}`, "");
    }
    if (vault.sections.length) {
      lines.push(table(["Section", "Status", "Committed", "Units", "Questions", "Outcomes", "Mermaid", "Embeds", "Review failures"],
        vault.sections.map((section) => [section.number || section.path, section.status, section.lessonCommitted ? "yes" : "no", section.lessonUnits, section.questions,
          Object.entries(section.outcomes).map(([outcome, count]) => `${outcome}×${count}`).join(", "), `${section.mermaid}${section.mermaidKinds.length ? ` (${section.mermaidKinds.join(",")})` : ""}`, section.embeds,
          (section.reviewFailures || []).join(", ") || "—"])), "");
    }
    for (const tutor of vault.tutors) lines.push(`- Tutor ${tutor.tutorId}: ${tutor.lessonUnits} units, ${tutor.questions} questions, mermaid ${tutor.mermaid} (${tutor.mermaidKinds.join(",")})`);
    for (const exam of vault.exams) lines.push(`- Exam ${exam.examId}: ${exam.status}, ${exam.questions} questions, score ${exam.earnedPoints ?? "—"}/${exam.maxPoints ?? "—"} (${exam.percent ?? "—"}%)`);
    for (const key of vault.answerKeys) lines.push(`- Answer key ${key.examId}: score ${key.score}, mermaid ${key.mermaid}`);
    const problems = [
      ...vault.links.unresolved.slice(0, 20).map((item) => `- unresolved link in ${item.note}:${item.line} ${item.link}`),
      ...vault.mermaid.lintErrors.slice(0, 20).map((item) => `- mermaid lint ${item.note}:${item.line} (${item.kind}): ${item.errors.join("; ")}`),
      ...vault.math.issues.slice(0, 20).map((item) => `- math ${item.note}:${item.line} ${item.problem}${item.snippet ? ` — ${item.snippet}` : ""}`),
      ...vault.duplicates.questionBlocks.map((item) => `- duplicate question block ${item.note} Q${item.question} = Q${item.duplicateOf}: ${item.prompt}`),
      ...vault.duplicates.questionIds.map((item) => `- duplicate question id ${item.id}: ${item.places.join(", ")}`),
      ...vault.duplicates.lessonEntryIds.map((item) => `- duplicate lesson entry ids in ${item.note}: ${item.ids.join(", ")}`),
      ...vault.duplicates.notes.map((item) => `- duplicate notes for ${item.record}: ${item.paths.join(", ")}`),
    ];
    if (problems.length) lines.push("", "### Vault problems", "", ...problems);
    lines.push("");
  }
  if (report.compare) {
    const baseline = report.compare;
    lines.push("## Comparison with baseline", "", `Baseline: \`${baseline.run?.runId}\` (${baseline.run?.scenario}, thinking ${baseline.run?.thinking})`, "");
    const rows = [];
    for (const stage of report.stages) {
      const other = baseline.stages?.find((candidate) => candidate.name === stage.name);
      if (!other) continue;
      const delta = (now, then) => (now !== undefined && then !== undefined && then > 0 ? `${Math.round((1 - now / then) * 100)}% faster` : "—");
      rows.push([stage.name, formatMs(other.durationMs), formatMs(stage.durationMs), delta(stage.durationMs, other.durationMs),
        formatMs(other.metrics.lessonReadyMs), formatMs(stage.metrics.lessonReadyMs), delta(stage.metrics.lessonReadyMs, other.metrics.lessonReadyMs),
        formatMs(other.metrics.firstQuestionMs), formatMs(stage.metrics.firstQuestionMs)]);
    }
    lines.push(table(["Stage", "Wall (base)", "Wall (now)", "Δ wall", "Lesson ready (base)", "Lesson ready (now)", "Δ ready", "1st question (base)", "1st question (now)"], rows), "");
  }
  return `${lines.join("\n")}\n`;
}

export function writeReport(logsDir, report) {
  writeFileSync(join(logsDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(logsDir, "report.md"), reportMarkdown(report));
  return { json: join(logsDir, "report.json"), markdown: join(logsDir, "report.md") };
}

/** Reads logs/events.jsonl back into the in-memory event shape. */
export function readEventLog(filePath, startedAt) {
  const events = [];
  for (const line of readFileSync(filePath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.seq === undefined) continue; // compact message deltas carry no seq
    events.push({ seq: entry.seq, t: entry.t, at: startedAt + entry.t, proc: entry.proc, dir: entry.dir, rec: entry.rec });
  }
  return events;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const runDir = process.argv[2];
  if (!runDir) { console.error("Usage: node tests/e2e/report.mjs <run-dir> [--compare <report.json>]"); process.exit(2); }
  const logs = join(resolve(runDir), "logs");
  const state = JSON.parse(readFileSync(join(logs, "run-state.json"), "utf8"));
  const events = readEventLog(join(logs, "events.jsonl"), state.run.startedAt);
  const compareIndex = process.argv.indexOf("--compare");
  const compare = compareIndex > 0 && existsSync(process.argv[compareIndex + 1]) ? JSON.parse(readFileSync(process.argv[compareIndex + 1], "utf8")) : state.compare;
  const report = buildReport({ ...state, events, compare });
  const paths = writeReport(logs, report);
  console.log(`${report.result}: ${paths.markdown}`);
}
