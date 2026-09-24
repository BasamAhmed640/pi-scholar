// Scripted learner for the Scholar end-to-end harness.
//
// It answers Pi's extension dialogs the way a person would, deterministically:
//   * quiz `select` dialogs (recognised by Scholar's automatic "I don't know"
//     choice or a known question) — the correct option with probability
//     `pCorrect` when the key can be inferred from the scholar_quiz tool-call
//     arguments seen on the event stream, otherwise a seeded pseudo-random pick;
//     occasionally "I don't know";
//   * a planned Esc (`cancelled: true`) at a chosen quiz dialog, to pause mid-set;
//   * exam submission confirms; the book and exam pickers pick the obvious item;
//   * `input` dialogs get a brief answer (numbers for a multi-select fallback);
//   * anything unrecognised is cancelled and recorded as unexpected.
// Every dialog shown is recorded for the report.

/** mulberry32: small, fast, seedable. */
export function seededRandom(seed) {
  let state = (Number(seed) >>> 0) || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DONT_KNOW = /^\s*(?:\d+[.)]\s*)?i\s+(?:do not|don['’]t)\s+know\s*$/i;

/** Normalizes option/question text across math delimiters, numbering and spacing. */
export function normalizeText(value) {
  return String(value ?? "")
    .replace(/^\s*(?:\d+|[a-h])[.)]\s+/i, "")
    .replace(/\\\(|\\\)|\\\[|\\\]|\$/g, "")
    .replace(/\\(?:mathrm|text|operatorname)\{([^}]*)\}/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function truncate(value, length = 240) {
  const text = String(value ?? "");
  return text.length > length ? `${text.slice(0, length)}…` : text;
}

/** Quiz items (question, options, correct labels) announced by scholar_quiz tool calls. */
export function quizItemsFromArgs(args) {
  if (!args || typeof args !== "object") return [];
  const raw = Array.isArray(args.questions) ? args.questions : args.question ? [args] : [];
  return raw.filter((item) => item && typeof item.question === "string" && Array.isArray(item.options)).map((item) => {
    const options = item.options.map((option) => ({ label: String(option?.label ?? ""), value: String(option?.value ?? option?.label ?? "").trim() || String(option?.label ?? "") }));
    const correctValues = (Array.isArray(item.correctAnswer) ? item.correctAnswer : [item.correctAnswer])
      .filter((value) => value !== undefined && value !== null).map((value) => String(value).trim());
    const correctLabels = options.filter((option) => correctValues.includes(option.value) || correctValues.includes(option.label.trim())).map((option) => normalizeText(option.label));
    return { question: item.question, normalizedQuestion: normalizeText(item.question), options, normalizedOptions: options.map((option) => normalizeText(option.label)), correctLabels, multiSelect: item.multiSelect === true };
  });
}

/** Exam questions announced by scholar exam_build tool calls, keyed by question id. */
export function examQuestionsFromEvents(events) {
  const byId = new Map();
  for (const entry of events) {
    if (entry.dir !== "out" || entry.rec?.type !== "tool_execution_start" || entry.rec.toolName !== "scholar") continue;
    const args = entry.rec.args;
    if (args?.action !== "exam_build" || !Array.isArray(args.questions)) continue;
    for (const question of args.questions) if (question?.id) byId.set(String(question.id), question);
  }
  return byId;
}

const BRIEF_ANSWERS = [
  [/closed[- ]loop gain|feedback equation|\bT\s*=|\by\s*\/\s*r\b/i, "T = G/(1 + GH); with a large loop gain T is about 1/H.", "T = G/(1 - GH), so feedback raises the gain."],
  [/\bsensitiv/i, "S = 1/(1 + GH): feedback divides the fractional plant change by 1 + GH.", "Feedback makes the output fully sensitive to the plant gain."],
  [/remaining error|steady[- ]state error|\berror\b/i, "e = r/(1 + GH): the error shrinks as loop gain grows; integral action removes it.", "The error is zero for any finite loop gain."],
  [/\bopen[- ]loop\b/i, "Open loop never measures the output, so it cannot correct disturbances.", "Open loop measures the output but ignores it."],
  [/\bsensor\b|\bmeasur/i, "The sensor measures y and its measurement is subtracted from r to form the error.", "The sensor adds the measurement to the reference."],
  [/\b(?:sequence|READ|WRITE|ACK|sampl\w*|sampling period|bus)\b/i, "READ request, DATA response, compute u, WRITE request, ACK, all within Ts = 10 ms.", "The controller writes the command before reading the sensor."],
  [/\b(?:margin|phase|delay)\b/i, "Aim for GM of at least 6 dB and PM of at least 45 degrees; delay lowers the phase margin.", "Delay raises the phase margin."],
  [/\b(?:poles?|stab\w*|characteristic)\b/i, "Stable when every root of 1 + G(s)H(s) = 0 has a negative real part.", "Stable when a pole lies in the right half-plane."],
  [/\b(?:workflow|tun\w*|integral|proportional)\b/i, "Specify, identify the plant, choose PI, set Kp, add integral action, check margins, verify on the real loop.", "Tune only on the model and skip the real test."],
];

export function briefAnswer(prompt, { wrong = false } = {}) {
  for (const [pattern, right, wrongAnswer] of BRIEF_ANSWERS) {
    if (pattern.test(prompt || "")) return wrong ? wrongAnswer : right;
  }
  return wrong ? "I am not sure; maybe feedback is not involved here." : "Feedback compares the measurement with the reference and acts on the error.";
}

export class ScriptedLearner {
  constructor({ seed = 42, pCorrect = 0.7, pDontKnow = 0.1, bookFileName = "", confirmSubmit = true, log = () => {} } = {}) {
    this.random = seededRandom(seed);
    this.pCorrect = pCorrect;
    this.pDontKnow = pDontKnow;
    this.bookFileName = bookFileName;
    this.confirmSubmit = confirmSubmit;
    this.examScope = "chapter 1";
    this.examId = undefined;
    this.dialogs = [];         // every dialog shown, with the learner's choice
    this.unexpected = [];      // dialogs the learner did not recognise
    this.quizCounter = 0;      // quiz dialogs since the current plan was set
    this.plan = {};
    this.stage = "";
    this.log = log;
  }

  /** e.g. setPlan({ cancelAtQuiz: 3 }) cancels the 3rd quiz dialog from now; setPlan({ cancelAllQuizzes: true }). */
  setPlan(plan = {}) {
    this.plan = { ...plan };
    this.quizCounter = 0;
  }

  setStage(stage) { this.stage = stage; }

  quizDialogs(stage) { return this.dialogs.filter((dialog) => dialog.kind === "quiz" && (!stage || dialog.stage === stage)); }

  knowledgeFor(client, title, options) {
    const normalizedTitle = normalizeText(title);
    const dialogOptions = options.filter((option) => !DONT_KNOW.test(option)).map(normalizeText);
    let best;
    const events = client?.events || [];
    for (let index = events.length - 1, scanned = 0; index >= 0 && scanned < 4000; index--, scanned++) {
      const entry = events[index];
      if (entry.dir !== "out" || entry.rec?.type !== "tool_execution_start" || entry.rec.toolName !== "scholar_quiz") continue;
      for (const item of quizItemsFromArgs(entry.rec.args)) {
        const overlap = dialogOptions.length ? dialogOptions.filter((option) => item.normalizedOptions.includes(option)).length / dialogOptions.length : 0;
        const titleMatch = item.normalizedQuestion && (normalizedTitle.includes(item.normalizedQuestion) || item.normalizedQuestion.includes(normalizedTitle));
        const score = overlap + (titleMatch ? 1 : 0);
        if (score >= 0.6 && (!best || score > best.score)) best = { item, score };
      }
      if (best && best.score >= 1.99) break;
    }
    return best?.item;
  }

  record(dialog) {
    this.dialogs.push({ stage: this.stage, ...dialog });
    this.log(dialog);
  }

  async respond(request, client, entry) {
    const base = { at: entry?.at ?? Date.now(), seq: entry?.seq, id: request.id, method: request.method, title: truncate(request.title, 400) };
    const title = String(request.title ?? "");
    const options = Array.isArray(request.options) ? request.options.map(String) : [];

    if (request.method === "select") {
      const isQuiz = options.some((option) => DONT_KNOW.test(option)) || Boolean(this.knowledgeFor(client, title, options));
      if (isQuiz) return this.answerQuiz(request, client, base, title, options);
      if (/choose a scholar book/i.test(title)) {
        const choice = options.find((option) => this.bookFileName && option.toLowerCase().includes(this.bookFileName.toLowerCase())) || options[0];
        this.record({ ...base, kind: "book-picker", options, choice });
        return choice === undefined ? { cancelled: true } : { value: choice };
      }
      if (/submit an exam/i.test(title)) {
        const choice = options.find((option) => this.examId && option.includes(this.examId)) || options[0];
        this.record({ ...base, kind: "exam-picker", options, choice });
        return choice === undefined ? { cancelled: true } : { value: choice };
      }
      this.unexpected.push({ ...base, options });
      this.record({ ...base, kind: "unexpected", options, choice: "(cancelled)" });
      return { cancelled: true };
    }

    if (request.method === "confirm") {
      const message = String(request.message ?? "");
      if (/^submit\b/i.test(title) || /submitting is final/i.test(message)) {
        this.record({ ...base, kind: "exam-submit-confirm", message: truncate(message, 400), choice: this.confirmSubmit ? "confirm" : "decline" });
        return { confirmed: this.confirmSubmit };
      }
      this.unexpected.push({ ...base, message: truncate(message, 400) });
      this.record({ ...base, kind: "unexpected", message: truncate(message, 400), choice: "(declined)" });
      return { confirmed: false };
    }

    if (request.method === "input") {
      if (/numbers|e\.g\.\s*1\s*,\s*3|select all/i.test(`${title} ${request.placeholder ?? ""}`)) {
        return this.answerMultiSelectInput(request, client, base, title);
      }
      if (/exam|accepted formats|scope/i.test(title)) {
        this.record({ ...base, kind: "exam-scope-input", choice: this.examScope });
        return { value: this.examScope };
      }
      const wrong = this.random() >= this.pCorrect;
      const value = briefAnswer(title, { wrong });
      this.record({ ...base, kind: "input", choice: value, intended: wrong ? "wrong" : "right" });
      return { value };
    }

    this.unexpected.push({ ...base });
    this.record({ ...base, kind: "unexpected", choice: "(cancelled)" });
    return { cancelled: true };
  }

  answerQuiz(request, client, base, title, options) {
    this.quizCounter += 1;
    const item = this.knowledgeFor(client, title, options);
    const dialog = { ...base, kind: "quiz", options: options.map((option) => truncate(option, 160)), quizIndex: this.quizCounter, knownKey: Boolean(item?.correctLabels.length) };
    if (this.plan.cancelAllQuizzes || (this.plan.cancelAtQuiz && this.quizCounter === this.plan.cancelAtQuiz)) {
      this.record({ ...dialog, choice: "(Esc)", intended: "cancel" });
      if (this.plan.cancelAtQuiz === this.quizCounter) this.plan = { ...this.plan, cancelAtQuiz: undefined, cancelled: true };
      return { cancelled: true };
    }
    const answerable = options.filter((option) => !DONT_KNOW.test(option));
    const dontKnowOption = options.find((option) => DONT_KNOW.test(option));
    const correctOptions = item ? answerable.filter((option) => item.correctLabels.includes(normalizeText(option))) : [];
    const roll = this.random();
    let choice;
    let intended;
    if (dontKnowOption && roll < this.pDontKnow) {
      choice = dontKnowOption; intended = "dont-know";
    } else if (correctOptions.length && this.random() < this.pCorrect) {
      choice = correctOptions[0]; intended = "correct";
    } else if (correctOptions.length) {
      const wrong = answerable.filter((option) => !correctOptions.includes(option));
      choice = wrong.length ? wrong[Math.floor(this.random() * wrong.length)] : correctOptions[0];
      intended = wrong.length ? "wrong" : "correct";
    } else {
      choice = answerable[Math.floor(this.random() * answerable.length)] ?? dontKnowOption;
      intended = "random";
    }
    this.record({ ...dialog, choice: truncate(choice, 160), intended, correctOption: correctOptions[0] ? truncate(correctOptions[0], 160) : undefined });
    return choice === undefined ? { cancelled: true } : { value: choice };
  }

  answerMultiSelectInput(request, client, base, title) {
    this.quizCounter += 1;
    const lines = title.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^\d+[.)]\s+/.test(line));
    const labels = lines.map((line) => line.replace(/^\d+[.)]\s+/, ""));
    const item = this.knowledgeFor(client, title, labels);
    if (this.plan.cancelAllQuizzes || (this.plan.cancelAtQuiz && this.quizCounter === this.plan.cancelAtQuiz)) {
      this.record({ ...base, kind: "quiz", multiSelect: true, quizIndex: this.quizCounter, choice: "(Esc)", intended: "cancel" });
      if (this.plan.cancelAtQuiz === this.quizCounter) this.plan = { ...this.plan, cancelAtQuiz: undefined, cancelled: true };
      return { cancelled: true };
    }
    const correct = item ? labels.map((label, index) => (item.correctLabels.includes(normalizeText(label)) ? index + 1 : 0)).filter(Boolean) : [];
    let picks;
    let intended;
    if (correct.length && this.random() < this.pCorrect) { picks = correct; intended = "correct"; }
    else {
      const count = Math.max(1, Math.min(2, labels.length));
      picks = [...new Set(Array.from({ length: count }, () => 1 + Math.floor(this.random() * Math.max(1, labels.length))))];
      intended = correct.length ? "wrong-or-random" : "random";
    }
    const value = picks.sort((a, b) => a - b).join(",") || "1";
    this.record({ ...base, kind: "quiz", multiSelect: true, quizIndex: this.quizCounter, options: labels.map((label) => truncate(label, 160)), choice: value, intended, knownKey: correct.length > 0 });
    return { value };
  }

  /** One short typed answer for an open question asked in chat (Learn/Tutor open response). */
  openAnswer(prompt) {
    const wrong = this.random() >= this.pCorrect;
    const value = briefAnswer(prompt, { wrong });
    this.record({ at: Date.now(), method: "chat", kind: "open-answer", title: truncate(prompt, 400), choice: value, intended: wrong ? "wrong" : "right" });
    return value;
  }

  /**
   * Edits an exam answer paper like a learner in Obsidian: ticks one checkbox
   * (or a set, for select-all items) inside each multiple-choice answer region
   * and writes one line in each open-response region. Markers are untouched.
   * `examQuestions` (id -> exam_build question) supplies the key when known.
   */
  fillExamPaper(text, examQuestions = new Map()) {
    const lines = text.split("\n");
    const answers = [];
    const startPattern = /<!-- scholar:answer:(.+?):start -->/;
    for (let index = 0; index < lines.length; index++) {
      const start = startPattern.exec(lines[index]);
      if (!start) continue;
      const id = start[1];
      const endMarker = `<!-- /scholar:answer:${id}:end -->`;
      let end = index + 1;
      while (end < lines.length && !lines[end].includes(endMarker)) end++;
      if (end >= lines.length) { answers.push({ id, problem: "end marker missing" }); continue; }
      // The prompt is the callout text between the question header and this region.
      let header = index;
      while (header > 0 && !/\[!question\]/.test(lines[header])) header--;
      const prompt = lines.slice(header + 1, index).map((line) => line.replace(/^>\s?/, "")).join(" ").replace(/\s+/g, " ").trim();
      const selectAll = /select all that apply/i.test(prompt);
      const choiceRows = [];
      for (let row = index + 1; row < end; row++) {
        const match = /^(>\s?)?- \[ \] (.*) <!-- scholar:choice:(\d+) -->\s*$/.exec(lines[row]);
        if (match) choiceRows.push({ row, choice: Number(match[3]), label: match[2] });
      }
      const question = examQuestions.get(id);
      if (choiceRows.length) {
        const optionValues = Array.isArray(question?.options) ? question.options.map((option) => String(option.value)) : [];
        const correctValues = question ? (Array.isArray(question.correctAnswer) ? question.correctAnswer : [question.correctAnswer]).map(String) : [];
        const correctChoices = choiceRows.filter((choiceRow) => correctValues.includes(optionValues[choiceRow.choice])).map((choiceRow) => choiceRow.choice);
        let picks;
        let intended;
        if (correctChoices.length && this.random() < this.pCorrect) { picks = correctChoices; intended = "correct"; }
        else {
          const wrong = choiceRows.filter((choiceRow) => !correctChoices.includes(choiceRow.choice));
          const pool = wrong.length ? wrong : choiceRows;
          picks = [pool[Math.floor(this.random() * pool.length)].choice];
          if (selectAll && pool.length > 1 && this.random() < 0.5) picks.push(pool.find((choiceRow) => choiceRow.choice !== picks[0]).choice);
          intended = correctChoices.length ? "wrong" : "random";
        }
        if (!selectAll) picks = picks.slice(0, 1);
        for (const choiceRow of choiceRows) {
          if (picks.includes(choiceRow.choice)) lines[choiceRow.row] = lines[choiceRow.row].replace("- [ ]", "- [x]");
        }
        answers.push({ id, format: "multiple-choice", picks, intended, knownKey: correctChoices.length > 0, prompt: truncate(prompt, 200) });
      } else {
        const blank = lines.slice(index + 1, end).findIndex((line) => /^>?\s*$/.test(line));
        const wrong = this.random() >= this.pCorrect;
        const answer = briefAnswer(`${prompt} ${question?.prompt ?? ""}`, { wrong });
        if (blank >= 0) {
          const row = index + 1 + blank;
          const quoted = lines[index].trimStart().startsWith(">") || lines[row].startsWith(">");
          lines[row] = quoted ? `> ${answer}` : answer;
        } else {
          lines.splice(end, 0, lines[index].trimStart().startsWith(">") ? `> ${answer}` : answer);
        }
        answers.push({ id, format: "open", answer, intended: wrong ? "wrong" : "right", prompt: truncate(prompt, 200) });
      }
    }
    return { text: lines.join("\n"), answers };
  }
}
