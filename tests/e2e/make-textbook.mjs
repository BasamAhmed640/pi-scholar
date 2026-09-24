#!/usr/bin/env node
// Builds a small, realistic textbook PDF for the Scholar end-to-end harness.
//
// The book is written as HTML with one fixed-size <section class="page"> per PDF
// page, so every heading lands on a known PDF page and the printed page numbers
// in the footers differ from PDF viewer pages by a fixed front-matter offset (2).
// Headless Microsoft Edge or Google Chrome prints it with --print-to-pdf.
//
//   node tests/e2e/make-textbook.mjs [out.pdf]
//
// Environment: SCHOLAR_E2E_BROWSER=<path to msedge/chrome> overrides discovery.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const TEXTBOOK_TITLE = "Feedback Control Fundamentals";
export const TEXTBOOK_FILE_NAME = "Feedback Control Fundamentals.pdf";

/** The outline Scholar should recover, in PDF viewer pages (printed page + 2). */
export const EXPECTED_OUTLINE = Object.freeze({
  pageCount: 11,
  printedOffset: 2,
  chapters: [
    {
      number: "1", title: "Feedback Control Systems", startPage: 3, endPage: 9,
      sections: [
        { number: "1.1", title: "Open-loop and closed-loop systems", startPage: 3, endPage: 4 },
        { number: "1.2", title: "The feedback equation", startPage: 5, endPage: 7 },
        { number: "1.3", title: "A request–response control sequence", startPage: 8, endPage: 9 },
      ],
    },
    {
      number: "2", title: "Stability", startPage: 10, endPage: 11,
      sections: [
        { number: "2.1", title: "Poles and the characteristic equation", startPage: 10, endPage: 10 },
        { number: "2.2", title: "Stability margins", startPage: 11, endPage: 11 },
      ],
    },
  ],
});

/** Text that must be extractable from specific PDF pages (sanity check of the layout). */
const PAGE_PROBES = [
  [1, "Feedback Control Fundamentals"],
  [2, "Contents"],
  [3, "1.1 Open-loop and closed-loop systems"],
  [4, "Figure 1.1"],
  [5, "1.2 The feedback equation"],
  [6, "Worked example 1.1"],
  [7, "tuning workflow"],
  [8, "1.3 A request"],
  [9, "Chapter summary"],
  [10, "2.1 Poles and the characteristic equation"],
  [11, "2.2 Stability margins"],
];

const i = (symbol) => `<i>${symbol}</i>`;
const sub = (symbol, index) => `<i>${symbol}</i><sub>${index}</sub>`;

function equation(body, number) {
  return `<div class="equation"><span class="math">${body}</span><span class="eqno">(${number})</span></div>`;
}

function page({ printed, running, body, className = "" }) {
  return `<section class="page ${className}">
  ${running ? `<div class="running-head">${running}</div>` : ""}
  <div class="content">${body}</div>
  ${printed ? `<div class="folio">${printed}</div>` : ""}
</section>`;
}

const BLOCK_DIAGRAM = `<svg class="figure-svg" viewBox="0 0 660 250" width="620" height="235" xmlns="http://www.w3.org/2000/svg" font-family="Georgia, serif" font-size="13">
  <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#222"/></marker></defs>
  <g stroke="#222" stroke-width="1.6" fill="none">
    <line x1="10" y1="80" x2="102" y2="80" marker-end="url(#arrow)"/>
    <circle cx="120" cy="80" r="17"/>
    <line x1="137" y1="80" x2="188" y2="80" marker-end="url(#arrow)"/>
    <rect x="190" y="55" width="100" height="50" rx="4"/>
    <line x1="290" y1="80" x2="338" y2="80" marker-end="url(#arrow)"/>
    <rect x="340" y="55" width="90" height="50" rx="4"/>
    <line x1="430" y1="80" x2="478" y2="80" marker-end="url(#arrow)"/>
    <rect x="480" y="55" width="80" height="50" rx="4"/>
    <line x1="520" y1="12" x2="520" y2="53" marker-end="url(#arrow)"/>
    <line x1="560" y1="80" x2="648" y2="80" marker-end="url(#arrow)"/>
    <line x1="610" y1="80" x2="610" y2="190"/>
    <line x1="610" y1="190" x2="422" y2="190" marker-end="url(#arrow)"/>
    <rect x="330" y="165" width="90" height="50" rx="4"/>
    <line x1="330" y1="190" x2="120" y2="190"/>
    <line x1="120" y1="190" x2="120" y2="99" marker-end="url(#arrow)"/>
  </g>
  <g fill="#111">
    <text x="113" y="85" font-size="16">Σ</text>
    <text x="90" y="72" font-size="14">+</text>
    <text x="128" y="116" font-size="16">−</text>
    <text x="10" y="70">r (reference)</text>
    <text x="156" y="70">e</text>
    <text x="212" y="85">Controller</text>
    <text x="296" y="70">u</text>
    <text x="356" y="85">Actuator</text>
    <text x="502" y="85">Plant</text>
    <text x="528" y="26">d (disturbance)</text>
    <text x="570" y="70">y (output)</text>
    <text x="350" y="195">Sensor</text>
    <text x="150" y="208">measurement y<tspan font-size="10" dy="4">m</tspan></text>
  </g>
</svg>`;

const S_PLANE = `<svg class="figure-svg" viewBox="0 0 420 250" width="400" height="238" xmlns="http://www.w3.org/2000/svg" font-family="Georgia, serif" font-size="12">
  <rect x="20" y="15" width="190" height="210" fill="#e3f1e3"/>
  <rect x="210" y="15" width="190" height="210" fill="#f6e0e0"/>
  <g stroke="#222" stroke-width="1.4">
    <line x1="20" y1="120" x2="400" y2="120"/>
    <line x1="210" y1="15" x2="210" y2="225"/>
  </g>
  <g stroke="#b00" stroke-width="2.2">
    <line x1="154" y1="54" x2="166" y2="66"/><line x1="166" y1="54" x2="154" y2="66"/>
    <line x1="154" y1="174" x2="166" y2="186"/><line x1="166" y1="174" x2="154" y2="186"/>
  </g>
  <g stroke="#666" stroke-dasharray="3,3"><line x1="160" y1="120" x2="160" y2="66"/><line x1="160" y1="120" x2="160" y2="174"/></g>
  <g fill="#111">
    <text x="28" y="216">stable region (left half-plane)</text>
    <text x="218" y="216">unstable region (right half-plane)</text>
    <text x="364" y="112">Re(s)</text>
    <text x="216" y="28">Im(s)</text>
    <text x="150" y="137">−1</text>
    <text x="216" y="64">j2</text>
    <text x="216" y="184">−j2</text>
    <text x="72" y="64">pole (K = 5)</text>
    <text x="72" y="184">pole (K = 5)</text>
  </g>
  <g stroke="#222" stroke-width="1"><line x1="206" y1="60" x2="214" y2="60"/><line x1="206" y1="180" x2="214" y2="180"/></g>
</svg>`;

export function textbookHtml() {
  const G = i("G"), H = i("H"), T = i("T"), r = i("r"), y = i("y"), e = i("e"), u = i("u"), L = i("L"), S = i("S"), s = i("s"), K = i("K");
  const ym = sub("y", "m");
  const pages = [];

  pages.push(page({
    className: "title-page",
    body: `<div class="title-block">
      <h1 class="book-title">Feedback Control Fundamentals</h1>
      <p class="subtitle">A Short Course in Closed-Loop Design</p>
      <p class="edition">First edition</p>
    </div>
    <div class="publisher">Scholar End-to-End Harness Press · 2026<br><span class="small">Original teaching text written for automated testing. Freely reusable.</span></div>`,
  }));

  pages.push(page({
    printed: "ii",
    body: `<h1 class="front-heading">Contents</h1>
    <table class="toc">
      <tr class="toc-chapter"><td>1</td><td>Feedback Control Systems</td><td>1</td></tr>
      <tr><td>1.1</td><td>Open-loop and closed-loop systems</td><td>1</td></tr>
      <tr><td>1.2</td><td>The feedback equation</td><td>3</td></tr>
      <tr><td>1.3</td><td>A request–response control sequence</td><td>6</td></tr>
      <tr class="toc-chapter"><td>2</td><td>Stability</td><td>8</td></tr>
      <tr><td>2.1</td><td>Poles and the characteristic equation</td><td>8</td></tr>
      <tr><td>2.2</td><td>Stability margins</td><td>9</td></tr>
    </table>
    <h2 class="front-heading small-heading">Notation</h2>
    <table class="notation">
      <tr><td>${r}</td><td>reference (set point): the desired value of the output</td></tr>
      <tr><td>${y}</td><td>controlled output of the plant</td></tr>
      <tr><td>${ym}</td><td>measured output reported by the sensor</td></tr>
      <tr><td>${e}</td><td>error, the reference minus the measured output</td></tr>
      <tr><td>${u}</td><td>command sent by the controller to the actuator</td></tr>
      <tr><td>${G}</td><td>forward-path gain (controller, actuator and plant combined)</td></tr>
      <tr><td>${H}</td><td>feedback-path (sensor) gain</td></tr>
      <tr><td>${sub("T", "s")}</td><td>sampling period of a digital controller</td></tr>
    </table>
    <p class="front-note">Page numbers in this book are printed at the foot of each page. Chapter 1 begins on printed page 1.</p>`,
  }));

  // ---- Printed page 1 (PDF 3): chapter opener and 1.1 ----
  pages.push(page({
    printed: "1",
    body: `<div class="chapter-label">Chapter 1</div>
    <h1 class="chapter-title">Feedback Control Systems</h1>
    <p>A control system makes a physical quantity follow a desired value despite disturbances and uncertainty in the equipment. This chapter introduces the vocabulary of feedback, derives the equation that governs a single feedback loop, and follows the messages that a digital controller exchanges with its sensor and actuator during one sampling period.</p>
    <h2>1.1 Open-loop and closed-loop systems</h2>
    <p>Every control system has four components. The <b>plant</b> is the process being controlled — the water in an electric kettle, the speed of a conveyor motor, or the temperature of a room. The <b>actuator</b> is the device that changes the plant: a heater, a motor drive or a valve. The <b>sensor</b> measures the controlled output ${y}, such as a temperature or a shaft speed. The <b>controller</b> decides which command ${u} to send to the actuator.</p>
    <p>The desired value of the output is called the <b>reference</b> or set point, ${r}. In an <b>open-loop system</b> the controller computes ${u} from ${r} alone, using a fixed rule worked out in advance. A toaster is open-loop: it heats the bread for a set time and never measures how brown the bread actually is. Open-loop control is simple and cannot become unstable through its own action, but it cannot correct anything its rule did not anticipate: a colder kitchen, a thicker slice or an ageing heating element all change the result.</p>
    <p>In a <b>closed-loop system</b> the sensor output is fed back and compared with the reference. The difference ${e} = ${r} − ${ym}, where ${ym} is the measured output, is the <b>error</b>. The controller acts on the error, so a disturbance that pushes the output away from the reference produces an error that the controller then works to remove. This comparison is the defining feature of feedback control: the system corrects itself using its own measurement of the result.</p>`,
    running: "",
  }));

  // ---- Printed page 2 (PDF 4): figure 1.1, comparison ----
  pages.push(page({
    printed: "2",
    running: "Chapter 1 · Feedback Control Systems",
    body: `<figure>${BLOCK_DIAGRAM}
      <figcaption><b>Figure 1.1</b> Block diagram of a closed-loop control system. The sensor measurement ${ym} is subtracted from the reference ${r} at the summing junction to form the error ${e}.</figcaption></figure>
    <p>Figure 1.1 is read from left to right. The summing junction (the circle marked Σ) forms ${e} = ${r} − ${ym}. The controller converts the error into a command ${u}; the actuator turns the command into physical effort such as heat, torque or flow; the plant responds to that effort and to the disturbance <i>d</i>; and the sensor closes the loop by measuring ${y}. Because the measurement returns to the input side, a change anywhere in the loop is eventually seen at the summing junction.</p>
    <table class="data"><caption><b>Table 1.1</b> Open-loop and closed-loop control compared</caption>
      <tr><th>Property</th><th>Open loop</th><th>Closed loop</th></tr>
      <tr><td>Uses a measurement of the output</td><td>No</td><td>Yes</td></tr>
      <tr><td>Corrects unanticipated disturbances</td><td>No</td><td>Yes</td></tr>
      <tr><td>Sensitivity to changes in the plant</td><td>Full</td><td>Reduced by feedback</td></tr>
      <tr><td>Can become unstable through its own action</td><td>No</td><td>Yes, if the loop gain is too high</td></tr>
      <tr><td>Needs a sensor</td><td>No</td><td>Yes</td></tr>
    </table>
    <p>A closed-loop system pays for its accuracy with extra hardware, the sensor, and with a new risk: because the controller reacts to the consequences of its own past actions, an aggressive controller can over-correct and oscillate. Chapter 2 studies that risk.</p>
    <p><b>Example.</b> A room heater with a thermostat is closed-loop. The thermostat measures the air temperature, compares it with the set point and switches the heater according to the error. If a window is opened, the temperature falls, the error grows and the heater runs longer — without anyone recomputing the heating schedule.</p>`,
  }));

  // ---- Printed page 3 (PDF 5): 1.2 derivation ----
  pages.push(page({
    printed: "3",
    running: "Chapter 1 · Feedback Control Systems",
    body: `<h2>1.2 The feedback equation</h2>
    <p>For a first analysis, treat each block as a gain: the output of a block equals its input multiplied by the block's gain. Combine the controller, actuator and plant into one <b>forward-path gain</b> ${G}, and let ${H} be the gain of the sensor, the <b>feedback path</b>. With ${r} the reference, the loop of Figure 1.1 is described by two relations. The comparator subtracts the measured output ${H}${y}:</p>
    ${equation(`${e} = ${r} − ${H}${y}`, "1.1")}
    <p>and the forward path multiplies the error by ${G}:</p>
    ${equation(`${y} = ${G}${e}`, "1.2")}
    <p>Substituting (1.1) into (1.2) gives</p>
    ${equation(`${y} = ${G}(${r} − ${H}${y}) = ${G}${r} − ${G}${H}${y}`, "1.3")}
    <p>Collecting the terms in ${y} gives ${y}(1 + ${G}${H}) = ${G}${r}, and dividing by (1 + ${G}${H}) yields the <b>closed-loop gain</b> ${T} = ${y}/${r}:</p>
    ${equation(`${T} = ${y}/${r} = ${G} / (1 + ${G}${H})`, "1.4")}
    <p>Equation (1.4) is the <b>feedback equation</b>. The product ${L} = ${G}${H} is the <b>loop gain</b>: the gain experienced by a signal that travels once around the loop. The minus sign at the comparator is what makes the denominator 1 + ${G}${H} rather than 1 − ${G}${H}; this is <b>negative feedback</b>.</p>
    <p>Two limits show why feedback is useful. When the loop gain is large (${G}${H} ≫ 1), ${T} ≈ ${G}/(${G}${H}) = 1/${H}: the closed-loop gain is set almost entirely by the sensor, not by the plant. Sensors can be made precise and stable far more easily than motors, heaters or amplifiers, so feedback transfers the accuracy of the sensor to the whole system. When ${G}${H} ≪ 1, ${T} ≈ ${G} and feedback has little effect.</p>
    <p>The <b>sensitivity</b> of ${T} to a change in ${G} is the ratio of their fractional changes:</p>
    ${equation(`${S} = (d${T}/${T}) / (d${G}/${G}) = 1 / (1 + ${G}${H})`, "1.5")}
    <p>A fractional change in the plant gain therefore produces a fractional change in the closed-loop gain that is smaller by the factor 1 + ${G}${H}.</p>`,
  }));

  // ---- Printed page 4 (PDF 6): worked example ----
  pages.push(page({
    printed: "4",
    running: "Chapter 1 · Feedback Control Systems",
    body: `<p>The same algebra gives the error that remains at the comparator. Substituting ${y} = ${G}${e} into (1.1) gives ${e} = ${r} − ${G}${H}${e}, so</p>
    ${equation(`${e} = ${r} / (1 + ${G}${H})`, "1.6")}
    <p>A large loop gain makes the remaining error small, but for a finite ${G}${H} it never vanishes. Removing it completely needs integral action, introduced with the tuning workflow in the next pages.</p>
    <div class="example"><div class="example-title">Worked example 1.1 — a motor-speed loop</div>
    <p>An amplifier drives a motor whose speed is measured by a tachometer. The forward-path gain is ${G} = 100 and the sensor gain is ${H} = 0.1.</p>
    <ol>
      <li><b>Loop gain.</b> ${L} = ${G}${H} = 100 × 0.1 = 10.</li>
      <li><b>Closed-loop gain.</b> ${T} = 100 / (1 + 10) = 9.09 (three significant figures). The ideal value is 1/${H} = 10, so a loop gain of 10 keeps ${T} within 10 % of the ideal value.</li>
      <li><b>Sensitivity.</b> ${S} = 1 / (1 + 10) = 0.0909.</li>
      <li><b>Effect of an ageing motor.</b> Suppose ${G} falls by 20 % to 80. Then ${G}${H} = 8 and ${T} = 80 / 9 = 8.89. The closed-loop gain changes by (8.89 − 9.09)/9.09 = −2.2 %, although the plant changed by −20 %. The sensitivity predicts 0.0909 × (−20 %) ≈ −1.8 %; the small difference arises because a 20 % change is not a small change.</li>
      <li><b>Remaining error.</b> For a reference ${r} = 10 units, equation (1.6) gives ${e} = 10 / 11 = 0.909 units.</li>
    </ol></div>
    <p>The example shows the central trade of feedback: the loop gives up raw gain (${T} = 9.09 instead of ${G} = 100) and receives in exchange an output that barely depends on the plant.</p>`,
  }));

  // ---- Printed page 5 (PDF 7): tuning workflow ----
  pages.push(page({
    printed: "5",
    running: "Chapter 1 · Feedback Control Systems",
    body: `<h3>A tuning workflow</h3>
    <p>In practice the gains are not given; the engineer chooses the controller so that the loop meets its specification. A dependable tuning workflow for a proportional–integral (PI) loop proceeds as follows.</p>
    <ol class="workflow">
      <li><b>Write the specification:</b> the largest acceptable steady-state error, the settling time and the largest acceptable overshoot.</li>
      <li><b>Identify the plant:</b> with the loop open, apply a small step to the actuator and record the output. Estimate the plant gain and its dominant time constant from this step response.</li>
      <li><b>Choose the controller structure:</b> proportional (P) control if a small steady-state error is acceptable; add integral (I) action if the error must go to zero.</li>
      <li><b>Set the proportional gain:</b> raise ${sub("K", "p")} until the loop gain gives the required accuracy, using ${e} = ${r} / (1 + ${G}${H}) from equation (1.6), or until the response begins to overshoot.</li>
      <li><b>Add integral action:</b> start with a long integral time ${sub("T", "i")} and shorten it step by step; stop when the step response settles fastest without excessive overshoot.</li>
      <li><b>Check the stability margins</b> (Section 2.2). If the gain margin is below 6 dB or the phase margin is below 45°, reduce ${sub("K", "p")} or lengthen ${sub("T", "i")} and return to step 5.</li>
      <li><b>Verify on the real equipment:</b> close the loop and record a step response. If it meets the specification, document the gains; otherwise return to step 2 with the new data.</li>
    </ol>
    <p>The workflow is iterative. Two decisions send the engineer back to earlier steps: the margin check in step 6 returns to step 5, and the specification check in step 7 returns to step 2. Each pass uses better information than the one before.</p>
    <p>A common mistake is to tune on the plant model alone and skip step 7. Model errors are exactly what feedback is meant to absorb, but only a test on the real loop shows whether the stability margins survive them.</p>`,
  }));

  // ---- Printed page 6 (PDF 8): 1.3 sequence ----
  pages.push(page({
    printed: "6",
    running: "Chapter 1 · Feedback Control Systems",
    body: `<h2>1.3 A request–response control sequence</h2>
    <p>Modern controllers are digital: they execute the loop once every <b>sampling period</b> ${sub("T", "s")}. During each period the controller exchanges messages with the sensor and the actuator over a shared bus. Consider a conveyor-speed loop with ${sub("T", "s")} = 10 ms and three devices on the bus: the sensor node, the controller and the actuator node (the motor drive). One sampling period ${i("k")} proceeds as the following sequence of interactions:</p>
    <ol class="sequence">
      <li>At the start of period ${i("k")} the controller's timer fires and the controller sends a <b>READ request</b> to the sensor node.</li>
      <li>The sensor node samples the shaft speed and returns a <b>DATA response</b> containing the measurement ${y}[${i("k")}] and a timestamp.</li>
      <li>The controller computes the error ${e}[${i("k")}] = ${r} − ${y}[${i("k")}] and the new command ${u}[${i("k")}]; for proportional control, ${u}[${i("k")}] = ${sub("K", "p")} ${e}[${i("k")}].</li>
      <li>The controller sends a <b>WRITE request</b> carrying ${u}[${i("k")}] to the actuator node.</li>
      <li>The actuator node applies the command to the motor drive and returns an <b>ACK</b> (acknowledgement).</li>
      <li>The controller logs ${y}[${i("k")}] and ${u}[${i("k")}] and waits for the next timer tick.</li>
    </ol>
    <table class="data"><caption><b>Table 1.2</b> Timing budget for one sampling period</caption>
      <tr><th>Interaction</th><th>Typical time</th></tr>
      <tr><td>READ request → DATA response</td><td>2 ms</td></tr>
      <tr><td>Controller computation</td><td>1 ms</td></tr>
      <tr><td>WRITE request → ACK</td><td>3 ms</td></tr>
      <tr><td>Total per period</td><td>6 ms</td></tr>
      <tr><td>Sampling period ${sub("T", "s")}</td><td>10 ms</td></tr>
    </table>
    <p>The whole sequence must finish within the sampling period. Here it uses 6 ms of the 10 ms period, leaving 4 ms of slack for retries and jitter. The time between sampling ${y}[${i("k")}] and applying ${u}[${i("k")}] behaves like a small time delay inside the loop; Section 2.2 shows that such a delay reduces the phase margin.</p>`,
  }));

  // ---- Printed page 7 (PDF 9): faults and summary ----
  pages.push(page({
    printed: "7",
    running: "Chapter 1 · Feedback Control Systems",
    body: `<h3>When a response does not arrive</h3>
    <p>The sequence above assumes every request is answered. A robust controller never waits indefinitely, because waiting would stretch the sampling period and the loop would lose its timing. If the sensor has not answered within 3 ms, the controller re-uses the previous measurement, keeps the previous command ${u}[${i("k")} − 1] and increments a missed-sample counter. After three consecutive missed samples it commands the actuator into a safe state (motor stopped) and reports a sensor fault.</p>
    <p>A missing ACK is handled differently. A WRITE carries an absolute command value rather than a change, so sending it twice has the same effect as sending it once. The controller therefore re-sends the WRITE once within the same period and reports an actuator fault only if the second attempt also goes unanswered.</p>
    <h3>Chapter summary</h3>
    <ul>
      <li>A closed-loop system measures its output and acts on the error ${e} = ${r} − ${ym}; an open-loop system acts on the reference alone.</li>
      <li>The feedback equation ${T} = ${G} / (1 + ${G}${H}) shows that a large loop gain makes ${T} ≈ 1/${H} and divides the sensitivity to plant changes by 1 + ${G}${H}.</li>
      <li>The remaining error ${e} = ${r} / (1 + ${G}${H}) shrinks as the loop gain grows; integral action removes it.</li>
      <li>Tuning is an iterative workflow with explicit checks of the stability margins and of the real response.</li>
      <li>A digital loop is a timed request–response sequence between controller, sensor and actuator that must complete within the sampling period.</li>
    </ul>`,
  }));

  // ---- Printed page 8 (PDF 10): chapter 2, 2.1 ----
  pages.push(page({
    printed: "8",
    body: `<div class="chapter-label">Chapter 2</div>
    <h1 class="chapter-title">Stability</h1>
    <p>Feedback reduces sensitivity, but too much feedback — or too much delay inside the loop — can make a loop oscillate with growing amplitude. A system is <b>stable</b> if every bounded input produces a bounded output.</p>
    <h2>2.1 Poles and the characteristic equation</h2>
    <p>When the blocks are dynamic, their gains become transfer functions ${G}(${s}) and ${H}(${s}) of the complex frequency ${s}, and the feedback equation becomes ${T}(${s}) = ${G}(${s}) / (1 + ${G}(${s})${H}(${s})). The poles of ${T}(${s}) are the roots of the <b>characteristic equation</b></p>
    ${equation(`1 + ${G}(${s})${H}(${s}) = 0`, "2.1")}
    <p>A closed-loop system is stable when every pole lies in the left half of the complex ${s}-plane, that is, when every pole has a negative real part. A pole in the right half-plane produces a response that grows exponentially; a pair of poles on the imaginary axis produces a sustained oscillation.</p>
    <p><b>Example.</b> For ${G}(${s}) = ${K} / (${s}(${s} + 2)) and ${H}(${s}) = 1, equation (2.1) gives ${s}(${s} + 2) + ${K} = 0, that is ${s}<sup>2</sup> + 2${s} + ${K} = 0, with roots ${s} = −1 ± √(1 − ${K}). For 0 &lt; ${K} &lt; 1 both roots are real and negative; for ${K} &gt; 1 they are complex with real part −1. Every positive ${K} therefore gives a stable loop, but a larger ${K} gives a more oscillatory response.</p>
    <figure>${S_PLANE}
      <figcaption><b>Figure 2.1</b> Closed-loop poles in the ${s}-plane for ${G}(${s}) = ${K} / (${s}(${s} + 2)) and ${H} = 1. For ${K} = 5 the poles are at ${s} = −1 ± j2, inside the stable left half-plane.</figcaption></figure>`,
  }));

  // ---- Printed page 9 (PDF 11): 2.2 ----
  pages.push(page({
    printed: "9",
    running: "Chapter 2 · Stability",
    body: `<h2>2.2 Stability margins</h2>
    <p>Stability margins state how far a stable loop is from instability. Both are read from the loop gain ${L}(jω) = ${G}(jω)${H}(jω) evaluated at real frequencies ω.</p>
    <p>The <b>gain margin</b> (GM) is the factor by which the loop gain could be multiplied before the loop becomes unstable. It is measured at the phase-crossover frequency ω<sub>180</sub>, where the phase of ${L} is −180°, and is often stated in decibels:</p>
    ${equation(`GM = 1 / |${L}(jω<sub>180</sub>)|,&nbsp;&nbsp; GM<sub>dB</sub> = −20 log<sub>10</sub> |${L}(jω<sub>180</sub>)|`, "2.2")}
    <p>The <b>phase margin</b> (PM) is the additional phase lag the loop could tolerate at the gain-crossover frequency ω<sub>c</sub>, where |${L}(jω<sub>c</sub>)| = 1:</p>
    ${equation(`PM = 180° + ∠${L}(jω<sub>c</sub>)`, "2.3")}
    <p>A common design rule asks for GM ≥ 6 dB (a factor of 2) and PM ≥ 45°, which gives a well-damped response with modest overshoot.</p>
    <p><b>Example.</b> If |${L}| = 0.25 at the frequency where the phase of ${L} is −180°, then GM = 1/0.25 = 4, or 20 log<sub>10</sub> 4 = 12 dB. If the phase of ${L} at gain crossover is −140°, then PM = 180° − 140° = 40°, below the 45° rule. Reducing ${sub("K", "p")} lowers the gain-crossover frequency, where the phase lag is usually smaller, and so raises the phase margin.</p>
    <p><b>Delay and phase margin.</b> A time delay τ leaves |${L}| unchanged but adds a phase lag of ωτ radians. The 4 ms between sampling and actuation in Section 1.3 adds 0.004 × 50 = 0.2 rad ≈ 11.5° of lag at a gain-crossover frequency of 50 rad/s, so a loop with PM = 50° without delay keeps only about 38.5°.</p>`,
  }));

  const css = `
  @page { size: 8.5in 11in; margin: 0; }
  html, body { margin: 0; padding: 0; background: #fff; }
  body { font-family: Georgia, "Times New Roman", serif; font-size: 10.6pt; line-height: 1.42; color: #111; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .page { width: 8.5in; height: 10.98in; box-sizing: border-box; padding: 0.72in 0.9in 0.9in; position: relative; overflow: hidden; break-after: page; page-break-after: always; }
  .page:last-child { break-after: auto; page-break-after: auto; }
  .running-head { position: absolute; top: 0.38in; left: 0.9in; right: 0.9in; font-size: 8.5pt; font-variant: small-caps; letter-spacing: 0.04em; color: #555; border-bottom: 0.5pt solid #bbb; padding-bottom: 2pt; }
  .folio { position: absolute; bottom: 0.45in; left: 0; right: 0; text-align: center; font-size: 9.5pt; color: #333; }
  h1, h2, h3 { font-weight: bold; margin: 0.5em 0 0.35em; line-height: 1.2; }
  h2 { font-size: 13.5pt; } h3 { font-size: 11.5pt; }
  .chapter-label { font-size: 11pt; text-transform: uppercase; letter-spacing: 0.12em; color: #444; margin-top: 0.3in; }
  .chapter-title { font-size: 22pt; margin: 0.1em 0 0.6em; }
  p { margin: 0 0 0.6em; text-align: justify; hyphens: auto; }
  .equation { display: flex; justify-content: space-between; align-items: baseline; margin: 0.35em 0 0.55em; padding: 0 0.5in; }
  .equation .math { font-size: 11.5pt; }
  .eqno { font-size: 10.5pt; }
  figure { margin: 0.2em 0 0.7em; text-align: center; }
  figcaption { font-size: 9.4pt; text-align: left; margin: 0.3em 0.2in 0; }
  table.data { border-collapse: collapse; margin: 0.4em auto 0.8em; font-size: 9.6pt; }
  table.data caption { caption-side: top; text-align: left; padding-bottom: 3pt; }
  table.data th, table.data td { border: 0.6pt solid #888; padding: 2.5pt 8pt; text-align: left; }
  .example { border: 0.8pt solid #999; background: #f6f6f2; padding: 8pt 12pt; margin: 0.4em 0 0.8em; }
  .example-title { font-weight: bold; margin-bottom: 4pt; }
  ol, ul { margin: 0.2em 0 0.7em 1.2em; padding-left: 0.6em; } li { margin-bottom: 0.3em; }
  .title-page { display: flex; flex-direction: column; justify-content: space-between; padding-top: 2.2in; }
  .book-title { font-size: 30pt; text-align: center; margin: 0; }
  .subtitle { font-size: 15pt; text-align: center; margin-top: 0.3in; }
  .edition { text-align: center; font-style: italic; margin-top: 0.4in; }
  .publisher { text-align: center; font-size: 11pt; margin-bottom: 0.4in; }
  .small { font-size: 8.5pt; color: #555; }
  .front-heading { font-size: 20pt; margin-top: 0.3in; } .small-heading { font-size: 13pt; margin-top: 0.35in; }
  table.toc { width: 100%; border-collapse: collapse; font-size: 11.5pt; }
  table.toc td { padding: 3pt 4pt; } table.toc td:first-child { width: 0.6in; } table.toc td:last-child { text-align: right; width: 0.5in; }
  table.toc tr.toc-chapter td { font-weight: bold; padding-top: 9pt; }
  table.notation td { padding: 2pt 10pt 2pt 0; vertical-align: top; }
  .front-note { margin-top: 0.3in; font-size: 9.5pt; color: #444; }
  `;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${TEXTBOOK_TITLE}</title><style>${css}</style></head>
<body>
${pages.join("\n")}
</body></html>`;
}

const BROWSER_CANDIDATES = process.platform === "win32" ? [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
] : process.platform === "darwin" ? [
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
] : ["/usr/bin/microsoft-edge", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];

export function findBrowser() {
  const explicit = process.env.SCHOLAR_E2E_BROWSER;
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`SCHOLAR_E2E_BROWSER does not exist: ${explicit}`);
    return explicit;
  }
  const found = BROWSER_CANDIDATES.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`No headless-capable Chromium browser found (tried: ${BROWSER_CANDIDATES.join(", ")}). `
      + "Install Microsoft Edge or Google Chrome, or set SCHOLAR_E2E_BROWSER to its executable.");
  }
  return found;
}

function runBrowser(browser, args, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(browser, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Headless browser timed out after ${timeoutMs} ms.\n${output.slice(-2000)}`)); }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); resolvePromise({ code, output }); });
  });
}

function popplerText(pdfPath, page) {
  const result = spawnSync("pdftotext", ["-enc", "UTF-8", "-f", String(page), "-l", String(page), "-layout", pdfPath, "-"], { encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout;
}

function popplerPageCount(pdfPath) {
  const result = spawnSync("pdfinfo", [pdfPath], { encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) return undefined;
  const match = /^Pages:\s+(\d+)/m.exec(result.stdout);
  return match ? Number(match[1]) : undefined;
}

/** Checks page count and that each probe heading was extracted from its intended page. */
export function verifyTextbook(pdfPath) {
  const problems = [];
  const pages = popplerPageCount(pdfPath);
  if (pages === undefined) return { verified: false, problems: ["pdfinfo is unavailable; layout not verified"] };
  if (pages !== EXPECTED_OUTLINE.pageCount) problems.push(`expected ${EXPECTED_OUTLINE.pageCount} pages, found ${pages}`);
  for (const [pageNumber, probe] of PAGE_PROBES) {
    const text = popplerText(pdfPath, pageNumber);
    if (text === undefined) { problems.push("pdftotext is unavailable"); break; }
    const flat = text.replace(/\s+/g, " ").toLowerCase();
    if (!flat.includes(probe.toLowerCase())) problems.push(`PDF page ${pageNumber} lacks "${probe}"`);
  }
  return { verified: problems.length === 0, pages, problems };
}

/** Writes the HTML and PDF into outDir and returns their paths plus the expected outline. */
export async function makeTextbook(outDir, { fileName = TEXTBOOK_FILE_NAME, timeoutMs = 90_000 } = {}) {
  mkdirSync(outDir, { recursive: true });
  const browser = findBrowser();
  const workDir = mkdtempSync(join(tmpdir(), "scholar-e2e-print-"));
  const htmlPath = join(workDir, "textbook.html");
  const pdfPath = resolve(outDir, fileName);
  writeFileSync(htmlPath, textbookHtml(), "utf8");
  rmSync(pdfPath, { force: true });
  const args = [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    "--disable-sync", "--disable-background-networking", "--mute-audio", `--user-data-dir=${join(workDir, "profile")}`,
    "--no-pdf-header-footer", "--print-to-pdf-no-header", `--print-to-pdf=${pdfPath}`, pathToFileURL(htmlPath).href,
  ];
  try {
    const { code, output } = await runBrowser(browser, args, timeoutMs);
    // Edge can exit before its PDF writer flushes; wait briefly for the file.
    for (let attempt = 0; attempt < 40 && !(existsSync(pdfPath) && statSync(pdfPath).size > 1000); attempt++) {
      await new Promise((done) => setTimeout(done, 250));
    }
    if (!existsSync(pdfPath) || statSync(pdfPath).size < 1000) {
      throw new Error(`${basename(browser)} did not produce ${pdfPath} (exit ${code}).\n${output.slice(-2000)}`);
    }
  } finally {
    for (let attempt = 0; attempt < 5; attempt++) {
      try { rmSync(workDir, { recursive: true, force: true }); break; } catch { await new Promise((done) => setTimeout(done, 300)); }
    }
  }
  const verification = verifyTextbook(pdfPath);
  return { pdfPath, browser, title: TEXTBOOK_TITLE, expectedOutline: EXPECTED_OUTLINE, verification };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const target = resolve(process.argv[2] || join(process.cwd(), TEXTBOOK_FILE_NAME));
  const result = await makeTextbook(dirname(target), { fileName: basename(target) });
  console.log(JSON.stringify({ pdfPath: result.pdfPath, browser: result.browser, verification: result.verification }, null, 2));
  if (!result.verification.verified) process.exitCode = 1;
}
