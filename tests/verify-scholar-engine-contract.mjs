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
  // The four universal engines plus the one interactive-surface block. Every engine must be
  // defined once and composed by every mode; the surface block only by the modes that ask
  // interactive questions.
  const ENGINES = {
    teaching: "TEACHING_ENGINE_POLICY",
    explanation: "EXPLANATION_POLICY",
    presentation: "PRESENTATION_POLICY",
    question: "QUESTION_ENGINE_POLICY",
    "question-safety": "QUESTION_GROUNDING_POLICY",
  };
  const SURFACE = { "short-question": "SHORT_QUESTION_POLICY" };
  const engineTemplates = Object.entries(ENGINES).map(([label, name]) => ({ label, name, templates: definitions(source, name) }));
  const surfaceTemplates = Object.entries(SURFACE).map(([label, name]) => ({ label, name, templates: definitions(source, name) }));

  for (const item of [...engineTemplates, ...surfaceTemplates]) {
    check(
      `one ${item.label} definition`,
      item.templates.length === 1,
      `${item.templates.length} ${item.name} template definition(s) in ${policiesPath}`,
    );
  }

  if ([...engineTemplates, ...surfaceTemplates].every((item) => item.templates.length === 1)) {
    const { createJiti } = await import(pathToFileURL(jitiPath).href);
    const jiti = createJiti(import.meta.url, {
      moduleCache: false,
      alias: {
        "@earendil-works/pi-coding-agent": join(piPackageRoot, "dist", "index.js"),
      },
    });
    const policies = await jiti.import(policiesPath);
    const templateOf = (name) => [...engineTemplates, ...surfaceTemplates].find((item) => item.name === name).templates[0];
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
      policies.QUESTION_ENGINE_POLICY === templateOf("QUESTION_ENGINE_POLICY"),
      "the exported runtime value is byte-identical to the single source template",
    );
    for (const item of engineTemplates) {
      for (const mode of ["Learn", "Exam", "Tutor"]) {
        const count = occurrences(rendered[mode], item.templates[0]);
        check(
          `${mode} includes every ${item.label} engine identically`,
          count === 1,
          `exact shared template occurrences=${count}`,
        );
      }
    }
    for (const item of surfaceTemplates) {
      for (const mode of ["Learn", "Exam", "Tutor"]) {
        const count = occurrences(rendered[mode], item.templates[0]);
        check(
          mode === "Exam" ? "Exam asks no interactive questions" : `${mode} includes the ${item.label} block identically`,
          count === (mode === "Exam" ? 0 : 1),
          `exact shared template occurrences=${count}`,
        );
      }
    }
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
