import { extensionPath as packagedExtensionPath, piPackageRoot as sdkRoot, jitiPath as sdkJitiPath, resolvePiDependency } from "./sdk.mjs";
// Current-v3 contract for Scholar's shared question and teaching engines.
// This verifier reads and loads the selected live extension; it never rewrites it.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const requestedPath = resolve(
  process.env.PI_SCHOLAR_EXTENSION
    || packagedExtensionPath,
);
const extensionDirectory = basename(requestedPath).toLowerCase() === "index.ts"
  ? dirname(requestedPath)
  : requestedPath;
const policiesPath = join(extensionDirectory, "policies.ts");
const quizPath = join(extensionDirectory, "quiz.ts");
const piPackageRoot = sdkRoot;
const jitiPath = sdkJitiPath;

const checks = [];
function check(name, condition, detail) {
  const passed = Boolean(condition);
  checks.push({ name, passed, detail });
  console.log(`[${passed ? "PASS" : "FAIL"}] ${name} - ${detail}`);
}

function definitions(source, name) {
  const pattern = new RegExp(
    "(?:export\\s+)?const\\s+" + name + "\\s*=\\s*`([\\s\\S]*?)`;",
    "g",
  );
  return [...source.matchAll(pattern)].map((match) => match[1]);
}

function occurrences(text, exactValue) {
  if (!exactValue) return 0;
  return text.split(exactValue).length - 1;
}

try {
  const source = await readFile(policiesPath, "utf8");
  const quizSource = await readFile(quizPath, "utf8");
  const questionDefinitions = definitions(source, "QUESTION_ENGINE_POLICY");
  const teachingDefinitions = definitions(source, "TEACHING_ENGINE_POLICY");

  check(
    "one question-engine definition",
    questionDefinitions.length === 1,
    `${questionDefinitions.length} QUESTION_ENGINE_POLICY template definition(s) in ${policiesPath}`,
  );
  check(
    "one teaching-engine definition",
    teachingDefinitions.length === 1,
    `${teachingDefinitions.length} TEACHING_ENGINE_POLICY template definition(s) in ${policiesPath}`,
  );

  if (questionDefinitions.length === 1 && teachingDefinitions.length === 1) {
    const { createJiti } = await import(pathToFileURL(jitiPath).href);
    const jiti = createJiti(import.meta.url, {
      moduleCache: false,
      alias: {
        "@earendil-works/pi-coding-agent": join(piPackageRoot, "dist", "index.js"),
      },
    });
    const policies = await jiti.import(policiesPath);
    const questionPolicy = questionDefinitions[0];
    const teachingPolicy = teachingDefinitions[0];
    const book = {
      metadata: { title: "Engine Contract Fixture" },
      chapters: [{
        number: "1",
        sections: [{
          id: "section-1",
          number: "1.1",
          title: "Identity",
          order: 1,
          startPage: 1,
          endPage: 2,
          transcript: [],
        }],
      }],
    };
    const section = book.chapters[0].sections[0];
    const exam = {
      id: "exam-1",
      status: "draft",
      scope: { description: "fixture scope", chapterIds: [], sectionIds: [] },
    };
    const tutor = {
      id: "tutor-1",
      scope: { description: "fixture scope", chapterIds: [], sectionIds: [] },
      transcript: [],
    };
    const rendered = {
      Learn: policies.learnInstructions(book, section),
      Exam: policies.examInstructions(book, exam),
      Tutor: policies.tutorInstructions(book, tutor),
    };

    check(
      "exported question engine matches its sole definition",
      policies.QUESTION_ENGINE_POLICY === questionPolicy,
      "the exported runtime value is byte-identical to the single source template",
    );
    for (const mode of ["Learn", "Exam", "Tutor"]) {
      const count = occurrences(rendered[mode], questionPolicy);
      check(
        `${mode} includes the shared question engine identically`,
        count === 1,
        `exact shared template occurrences=${count}`,
      );
    }
    for (const mode of ["Learn", "Tutor"]) {
      const count = occurrences(rendered[mode], teachingPolicy);
      check(
        `${mode} includes the shared teaching engine identically`,
        count === 1,
        `exact shared template occurrences=${count}`,
      );
    }
    const examTeachingCount = occurrences(rendered.Exam, teachingPolicy);
    check(
      "Exam excludes the teaching engine",
      examTeachingCount === 0,
      `exact teaching-template occurrences=${examTeachingCount}`,
    );
    const duplicateQuizPolicy = /distractor design|plausible, specific misconception|Avoid tricks|parallel in length|adapt later checks/i.test(quizSource);
    check(
      "quiz tool contains mechanics, not a second question engine",
      !duplicateQuizPolicy,
      duplicateQuizPolicy
        ? "quiz.ts contains local question-authoring policy"
        : "question quality and adaptation remain centralized in policies.ts",
    );
  }
} catch (error) {
  check(
    "engine-contract harness execution",
    false,
    error instanceof Error ? error.stack || error.message : String(error),
  );
}

const failures = checks.filter((item) => !item.passed);
console.log(`\nScholar engine-contract summary: ${checks.length - failures.length} passed, ${failures.length} failed.`);
process.exitCode = failures.length ? 1 : 0;
