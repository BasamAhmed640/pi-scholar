import { open } from "node:fs/promises";
import { validateExamAnswerNote } from "./exam.ts";
import { configuredVaultRoot, examAnswerNotePath, scholarWorkspaceRoot } from "./obsidian-paths.ts";
import { examAnswerNoteText } from "./render/assessment.ts";
import { safePathWithinRoot, writeTextFileIfAbsent } from "./storage.ts";
import type { ScholarBook, ScholarConfig, ScholarExam } from "./types.ts";

/** A saved Markdown exam is limited to 1 MiB, including the questions and visuals. */
export const MAX_EXAM_ANSWER_NOTE_BYTES = 1024 * 1024;

async function confinedPaperPath(config: ScholarConfig, book: ScholarBook, exam: ScholarExam): Promise<string> {
  const workspace = scholarWorkspaceRoot(config);
  await safePathWithinRoot(configuredVaultRoot(config), workspace);
  return safePathWithinRoot(workspace, examAnswerNotePath(config, book, exam));
}

/** Read a bounded snapshot from one file handle, then verify identity and regions. */
export async function readExamAnswerNote(config: ScholarConfig, book: ScholarBook, exam: ScholarExam): Promise<{ path: string; text: string }> {
  const path = await confinedPaperPath(config, book, exam);
  const handle = await open(path, "r");
  let text: string;
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`Scholar's answer paper is not a regular file: ${path}`);
    if (info.size > MAX_EXAM_ANSWER_NOTE_BYTES) throw new Error("The answer paper exceeds the 1 MiB limit. Shorten it before submitting.");
    // The extra byte detects a file that grew after stat without an unbounded read.
    const bytes = Buffer.alloc(MAX_EXAM_ANSWER_NOTE_BYTES + 1);
    let count = 0;
    while (count < bytes.length) {
      const { bytesRead } = await handle.read(bytes, count, bytes.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    if (count > MAX_EXAM_ANSWER_NOTE_BYTES) throw new Error("The answer paper exceeds the 1 MiB limit. Shorten it before submitting.");
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count));
  } finally {
    await handle.close();
  }
  validateExamAnswerNote(book, exam, text);
  return { path, text };
}

/** Existing papers are learner-owned and are validated, never rewritten. */
export async function ensureExamAnswerNote(config: ScholarConfig, book: ScholarBook, exam: ScholarExam): Promise<{ path: string; created: boolean }> {
  if (exam.status === "draft") throw new Error("Finish building this exam before creating its answer paper.");
  try {
    const existing = await readExamAnswerNote(config, book, exam);
    return { path: existing.path, created: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (exam.status !== "active") {
    throw new Error("The submitted answer paper is missing. Saved responses remain in the exam; Scholar will not recreate a blank paper after submission.");
  }
  const path = await confinedPaperPath(config, book, exam);
  const text = examAnswerNoteText(config, book, exam);
  validateExamAnswerNote(book, exam, text);
  if (Buffer.byteLength(text, "utf8") > MAX_EXAM_ANSWER_NOTE_BYTES) throw new Error("The frozen answer paper exceeds the 1 MiB limit and cannot be created.");
  const result = await writeTextFileIfAbsent(configuredVaultRoot(config), path, text);
  // An EEXIST collision or a failed earlier partial write is never success until
  // it passes exactly the same validation as a normal reopened paper.
  await readExamAnswerNote(config, book, exam);
  return { path, created: result === "written" };
}
