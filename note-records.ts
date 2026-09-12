/** Visible Markdown records. No prompt or transcript is duplicated in metadata. */
import { createHash } from "node:crypto";
import type { AssessmentAttempt, ScholarBook, ScholarSection, TutorSession, TranscriptEntry, ScholarExam } from "./types.ts";
import { GENERATED_START, GENERATED_END, collapsedRecord, markdownText } from "./render/common.ts";

export const NOTE_FORMAT = "scholar-notes-v1";
const ENTRY_END = "<!-- scholar:entry:end -->";
export function details(kind: string, data: unknown): string {
  return collapsedRecord(`Scholar ${kind} details`, ["```json", JSON.stringify({ format: NOTE_FORMAT, kind, data }, null, 2), "```"], "info").join("\n");
}

export function readDetails(text: string, kind: string): any | undefined {
  const records = [...text.matchAll(/^> \[!info\]- Scholar ([\w-]+) details\r?\n((?:>[^\n]*(?:\n|$))*)/gm)]
    .filter((match) => match[1] === kind);
  if (records.length > 1) throw new Error(`Duplicate Scholar ${kind} details. Resolve the duplicate in the note before continuing.`);
  if (!records.length) return undefined;
  const body = records[0]![2]!.replace(/^> ?/gm, "").trim();
  const match = /^```json\s*\n([\s\S]*)\n```$/.exec(body);
  if (!match) throw new Error(`Incomplete Scholar ${kind} details. Finish saving the note before continuing.`);
  let value;
  try { value = JSON.parse(match[1]!); } catch { throw new Error(`Invalid Scholar ${kind} details. Fix the JSON in the note before continuing.`); }
  if (value.format !== NOTE_FORMAT || value.kind !== kind || !value.data || typeof value.data !== "object") throw new Error(`Unsupported Scholar ${kind} record.`);
  return value.data;
}

export function attachDetails(document: string, kind: string, data: unknown): string {
  return document.replace(GENERATED_START, () => `${GENERATED_START}\n${details(kind, data)}`);
}

function field(name: string, content: string | undefined): string {
  return content?.trim() ? `#### ${name}\n\n${markdownText(content)}\n\n` : "";
}
function readField(text: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^#### ${escaped}\\r?\\n([\\s\\S]*?)(?=^#### |^> \\[!info\\]- Scholar |^\\*(?:Awaiting response|Cancelled|pending|pass|review|unsure|unavailable)\\*\\s*$|$(?![\\s\\S]))`, "m").exec(text)?.[1]?.trim() || undefined;
}

/** Full question blocks are editable/deletable units; only their visible order matters. */
export function questionBlock(attempt: AssessmentAttempt, index: number): string {
  const { question, options, quiz, answerSummary, feedback, correctAnswer, outcome, ...metadata } = attempt;
  const quizMetadata = quiz && {
    ...quiz, question: undefined, options: quiz.options.map(({ label, ...option }) => option),
  };
  return [
    `### Question ${index + 1} · ${attempt.kind}${attempt.grounding?.purpose === "practice" ? " · Practice" : ""}`, "",
    markdownText(question), "",
    field("Choices", options?.map((option, i) => `${i + 1}. ${option.replace(/\n/g, "\n   ")}`).join("\n")),
    field("Your answer", answerSummary),
    field("Correct answer", correctAnswer),
    field("Feedback", feedback),
    attempt.outcome === "pending" ? "*Awaiting response*" : `*${attempt.outcome === "cancelled" ? "Cancelled" : attempt.outcome}*`, "",
    details("question", { ...metadata, ...(quizMetadata ? { quiz: quizMetadata, formHash: contentHash(JSON.stringify([question, options])) } : {}) }), "",
  ].join("\n");
}

export function questionChunks(text: string): string[] {
  const questions = /^## Questions\r?\n([\s\S]*?)(?=^## |<!-- scholar:generated:end -->|$(?![\s\S]))/m.exec(text)?.[1] || "";
  return questions.split(/(?=^### Question \d+\b)/m).filter((chunk) => /^### Question \d+\b/.test(chunk));
}

function questionText(chunk: string): string {
  return chunk.replace(/^### Question[^\n]*\n/, "").split(/^#### |^> \[!info\]- Scholar |^\*(?:Awaiting response|Cancelled|pending|pass|review|unsure|unavailable)\*\s*$/m)[0]!.trim();
}
function choices(text: string): string[] | undefined {
  const body = readField(text, "Choices");
  if (!body) return undefined;
  return body.split(/(?=^\d+\. )/m).map((line) => line.replace(/^\d+\. /, "").replace(/^   /gm, "").trim()).filter(Boolean);
}

export function readQuestions(text: string): AssessmentAttempt[] {
  const attempts: AssessmentAttempt[] = [];
  for (const chunk of questionChunks(text)) {
    const question = questionText(chunk);
    if (!question) continue; // A deliberately emptied prompt is gone, even if its details remain.
    const data = readDetails(chunk, "question");
    if (!data) throw new Error("A question is missing its Scholar question details. Delete its entire block to remove it, or undo the incomplete edit.");
    const options = choices(chunk);
    const { formHash, ...metadata } = data;
    const status = /^\*(Awaiting response|Cancelled|pending|pass|review|unsure|unavailable)\*\s*$/m.exec(chunk)?.[1];
    if (!status) throw new Error("A question is missing its visible answer status. Restore the status or delete the entire question block.");
    const outcome = status === "Awaiting response" ? "pending" : status.toLowerCase();
    const attempt = { ...metadata, question, outcome, ...(options ? { options } : {}) } as AssessmentAttempt;
    for (const [key, label] of [["answerSummary", "Your answer"], ["correctAnswer", "Correct answer"], ["feedback", "Feedback"]] as const) {
      const content = readField(chunk, label)?.replace(/\n\n\*(?:Awaiting response|Cancelled|pending|pass|review|unsure|unavailable)\*\s*$/, "").trim();
      if (content) attempt[key] = content;
    }
    if (data.quiz) {
      if (formHash !== contentHash(JSON.stringify([question, options]))) throw new Error("The saved quiz prompt or choices changed. Remove the whole question to request a new one; Scholar will not reuse an outdated grading key.");
      if (!options || options.length !== data.quiz.options?.length) throw new Error("A quiz's choices were added or removed. Delete the whole question to replace it; Scholar will not guess a grading key.");
      attempt.quiz = { ...data.quiz, question, options: data.quiz.options.map((option: object, i: number) => ({ ...option, label: options[i]! })) };
    }
    if (attempts.some((item) => item.id === attempt.id)) throw new Error("Duplicate question ID in the note. Remove the duplicate question block.");
    attempts.push(attempt);
  }
  return attempts;
}

export function transcriptBlock(entries: TranscriptEntry[], attempts: AssessmentAttempt[] = []): string {
  const compare = (text: string) => text.replace(/^\*\*|\*\*$/g, "").replace(/\s+/g, " ").trim();
  const prompts = new Set(attempts.map((attempt) => compare(attempt.question)));
  return entries.filter((entry) => entry.kind === "assistant").flatMap(({ markdown, ...metadata }) => {
    const paragraphs = markdownText(markdown).split(/\n\s*\n/);
    if (prompts.has(compare(paragraphs.at(-1)!))) paragraphs.pop();
    if (!paragraphs.length) return [];
    return [`${details("entry", metadata)}\n\n${paragraphs.join("\n\n").replaceAll(ENTRY_END, "&lt;!-- scholar:entry:end --&gt;")}\n${ENTRY_END}\n`];
  }).join("\n");
}
export function readTranscript(text: string): TranscriptEntry[] {
  const chunks = text.split(/(?=^> \[!info\]- Scholar entry details)/m);
  return chunks.flatMap((chunk) => {
    if (!chunk.startsWith("> [!info]- Scholar entry details")) return [];
    const entry = readDetails(chunk, "entry");
    if (!entry) return [];
    if (!chunk.includes(ENTRY_END)) throw new Error("A lesson entry is missing its end boundary. Finish the edit before continuing.");
    const markdown = chunk.replace(/^> \[!info\]- Scholar entry details\r?\n(?:>[^\n]*(?:\n|$))*/, "").split(ENTRY_END)[0]!.trim();
    return markdown ? [{ ...entry, markdown }] : [];
  });
}

export function studyDocument(document: string, kind: "section" | "tutor", record: ScholarSection | TutorSession): string {
  const { attempts, transcript, ...metadata } = record;
  // Synthesis/coverage are explicitly inspectable in this note's details, never a second database.
  document = attachDetails(document, kind, metadata);
  document = document.replace(/^## Questions\r?\n[\s\S]*?(?=^## |<!-- scholar:generated:end -->)/m, "");
  // All questions are in note order. New questions are appended; cancellation never shuffles them.
  if (attempts.length) document = document.replace(GENERATED_END, () => `## Questions\n\n${attempts.map(questionBlock).join("\n")}\n${GENERATED_END}`);
  return document;
}

export function readStudyDocument(text: string, kind: "section" | "tutor"): ScholarSection | TutorSession {
  const data = readDetails(text, kind);
  if (!data) throw new Error(`Missing Scholar ${kind} details; the note will not be rebuilt from history.`);
  return { ...data, attempts: readQuestions(text), transcript: readTranscript(text) };
}

/** The book note contains its source/outline, never any section's saved questions or lesson. */
export function bookMetadata(book: ScholarBook): unknown {
  const { chapters, exams, tutorSessions, recoveryCheckpoints, ...metadata } = book;
  return { ...metadata, chapters: chapters.map(({ sections, ...chapter }) => ({ ...chapter, sections: sections.map((section) => ({
    id: section.id, order: section.order, number: section.number, title: section.title, startPage: section.startPage, endPage: section.endPage,
    objectives: section.objectives, requiredChecks: section.requiredChecks, createdAt: section.createdAt,
  })) })) };
}

export function blankSection(outline: any): ScholarSection {
  return { ...outline, status: "not-started", coveredObjectives: [], keyPoints: [], misconceptions: [], attempts: [], transcript: [], updatedAt: outline.createdAt };
}

export function examDocument(document: string, exam: ScholarExam): string {
  const { questions, transcript, ...metadata } = exam;
  document = attachDetails(document, "exam", metadata);
  // The visible exam record retains its grading contract, with prompts stored only in their blocks.
  const blocks = questions.map(({ prompt, options, ...question }, index) => [
    `### Question ${index + 1}`, "", prompt, "",
    field("Choices", options?.map((option, i) => `${i + 1}. ${option.label}`).join("\n")),
    details("exam-question", { ...question, formHash: contentHash(JSON.stringify([prompt, options?.map(option => option.label)])), ...(options ? { options: options.map(({ label, ...option }) => option) } : {}) }), "",
  ].join("\n"));
  return document.replace(GENERATED_END, () => `${transcript.length ? `## Lesson\n\n${transcriptBlock(transcript)}\n` : ""}## Questions\n\n${blocks.join("\n")}\n${GENERATED_END}`);
}

export function readExamDocument(text: string): ScholarExam {
  const data = readDetails(text, "exam");
  if (!data) throw new Error("Missing Scholar exam details.");
  const questions = questionChunks(text).flatMap((chunk) => {
    const prompt = questionText(chunk);
    if (!prompt) return [];
    const record = readDetails(chunk, "exam-question");
    if (!record) throw new Error("Missing Scholar exam-question details.");
    const { formHash, ...question } = record;
    const labels = choices(chunk);
    if (formHash !== contentHash(JSON.stringify([prompt, labels]))) throw new Error("The saved exam prompt or choices changed. Restore its frozen wording before submission; Scholar will not reuse an outdated grading key.");
    if (question.options && labels?.length !== question.options.length) throw new Error("Exam choices changed; restore the complete exam item before submission.");
    return [{ ...question, prompt, ...(labels ? { options: question.options.map((option: object, i: number) => ({ ...option, label: labels[i] })) } : {}) }];
  });
  return { ...data, questions, transcript: readTranscript(text) };
}

/** Migration uses visible question text/order; missing legacy prompts are intentionally not imported. */
export function migrateVisibleQuestions(text: string, attempts: AssessmentAttempt[]): AssessmentAttempt[] {
  const available = [...attempts];
  return questionChunks(text).flatMap((chunk) => {
    const originalIndex = Number(/^### Question (\d+)\b/.exec(chunk)?.[1]) - 1;
    const isVisible = (attempt: AssessmentAttempt) => chunk.includes(markdownText(attempt.question))
      && (!chunk.includes("*Awaiting response*") || attempt.outcome === "pending")
      && (!chunk.includes("*Cancelled*") || attempt.outcome === "cancelled");
    const original = attempts[originalIndex];
    const match = original && available.includes(original) && isVisible(original)
      ? available.indexOf(original) : available.findIndex(isVisible);
    if (match < 0) throw new Error("A visible legacy question cannot be matched safely. Its note was kept; restore its original wording before conversion.");
    return available.splice(match, 1);
  });
}

/** Keep the lesson the user can actually see, including their edits, not its old JSON copy. */
export function migrateVisibleTeaching(text: string | undefined, record: ScholarSection | TutorSession): TranscriptEntry[] {
  const markdown = /^## Lesson\r?\n([\s\S]*?)(?=^## (?:Source figures|Visual references|Questions)\r?$|^> \[!\w+\]- (?:Recap(?: and pitfalls)?|Learning record|Practice scope)\r?$|<!-- scholar:generated:end -->)/m.exec(text || "")?.[1]?.trim();
  return markdown ? [{ id: `visible-lesson-${record.id}-${contentHash(markdown).slice(0, 16)}`, kind: "assistant", markdown, createdAt: record.updatedAt }] : [];
}

export function contentHash(text: string): string { return createHash("sha256").update(text).digest("hex"); }
