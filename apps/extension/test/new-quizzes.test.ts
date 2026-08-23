import { describe, expect, it, beforeEach } from "vitest";
import {
  scrapeQuestion,
  selectAnswerChoice,
  findStem,
} from "../src/canvas-dom";

describe("Canvas New Quizzes question interaction", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("scrapes and selects multiple choice questions on New Quizzes DOM", async () => {
    const q = document.createElement("div");
    q.className = "question-container";
    q.innerHTML = `
      <div data-testid="question-stem">
        <p>What is the p-value threshold for statistical significance at alpha = 0.05?</p>
      </div>
      <div class="choices-container">
        <label data-testid="choice-0">
          <input type="radio" name="nq-choice-1" value="0" />
          <span>0.01</span>
        </label>
        <label data-testid="choice-1">
          <input type="radio" name="nq-choice-1" value="1" />
          <span>0.05</span>
        </label>
        <label data-testid="choice-2">
          <input type="radio" name="nq-choice-1" value="2" />
          <span>0.10</span>
        </label>
      </div>
    `;
    document.body.appendChild(q);

    const stem = findStem(q);
    expect(stem).not.toBeNull();

    const scraped = await scrapeQuestion(q);
    expect(scraped.text).toContain("What is the p-value threshold");
    expect(scraped.choices).toHaveLength(3);
    expect(scraped.choices[0]?.text).toBe("0.01");
    expect(scraped.choices[1]?.text).toBe("0.05");

    const count = selectAnswerChoice(q, "Answer: B (0.05)", ["B"]);
    expect(count).toBe(1);

    const inputs = q.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    expect(inputs[1]?.checked).toBe(true);
    expect(inputs[0]?.checked).toBe(false);
  });

  it("scrapes and selects multiple answers (checkboxes) on New Quizzes DOM", async () => {
    const q = document.createElement("div");
    q.className = "question-container";
    q.innerHTML = `
      <div data-testid="question-text">
        <p>Select all valid assumptions of linear regression:</p>
      </div>
      <div class="choices-container">
        <label>
          <input type="checkbox" value="0" />
          <span>Linearity between predictors and outcome</span>
        </label>
        <label>
          <input type="checkbox" value="1" />
          <span>Independence of errors</span>
        </label>
        <label>
          <input type="checkbox" value="2" />
          <span>Errors must be strictly non-zero</span>
        </label>
        <label>
          <input type="checkbox" value="3" />
          <span>Homoscedasticity of residuals</span>
        </label>
      </div>
    `;
    document.body.appendChild(q);

    const scraped = await scrapeQuestion(q);
    expect(scraped.choices).toHaveLength(4);

    const count = selectAnswerChoice(q, "Answer: A, B, and D are valid assumptions.", ["A", "B", "D"]);
    expect(count).toBe(3);

    const inputs = q.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    expect(inputs[0]?.checked).toBe(true);
    expect(inputs[1]?.checked).toBe(true);
    expect(inputs[2]?.checked).toBe(false);
    expect(inputs[3]?.checked).toBe(true);
  });

  it("fills in numerical answer input on New Quizzes DOM", async () => {
    const q = document.createElement("div");
    q.className = "question-container";
    q.innerHTML = `
      <div class="question-text-container">
        <p>Compute the sample standard deviation for [2, 4, 4, 4, 5, 5, 7, 9]:</p>
      </div>
      <div class="input-container">
        <input type="text" class="question_input" value="" />
      </div>
    `;
    document.body.appendChild(q);

    const scraped = await scrapeQuestion(q);
    expect(scraped.choices).toHaveLength(1);
    expect(scraped.choices[0]?.kind).toBe("text-fill");

    const count = selectAnswerChoice(q, "Answer: 2.1381");
    expect(count).toBe(1);

    const input = q.querySelector<HTMLInputElement>('input[type="text"]');
    expect(input?.value).toBe("2.1381");
  });

  it("gracefully falls back to highlight-only mark when New Quizzes inputs are disabled", async () => {
    const q = document.createElement("div");
    q.className = "question-container";
    q.innerHTML = `
      <div data-testid="question-stem">
        <p>Reviewing a submitted quiz question.</p>
      </div>
      <div>
        <label class="answer_row">
          <input type="radio" name="disabled-q" disabled value="0" />
          <span>Option A</span>
        </label>
        <label class="answer_row">
          <input type="radio" name="disabled-q" disabled value="1" />
          <span>Option B</span>
        </label>
      </div>
    `;
    document.body.appendChild(q);

    const count = selectAnswerChoice(q, "Answer: A", ["A"]);
    expect(count).toBe(1);

    const row = q.querySelector(".answer_row");
    expect(row?.classList.contains("statshelpr-suggested")).toBe(true);
  });

  it("handles MathJax, KaTeX, and table cell spacing in stems and choices without numeral merging", async () => {
    const q = document.createElement("div");
    q.className = "question-container";
    q.innerHTML = `
      <div data-testid="question-stem">
        <p>Given the contingency table below:</p>
        <table>
          <tr><th>Group</th><th>Count</th></tr>
          <tr><td>10</td><td>20</td></tr>
        </table>
        <p>Find the test statistic for <span class="katex"><span class="katex-mathml"><math><semantics><annotation encoding="application/x-tex">H_0: \\mu = 0</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">H0: mu = 0</span></span></p>
      </div>
      <div class="choices-container">
        <label>
          <input type="radio" name="math-q" value="0" />
          <span><span class="katex"><annotation encoding="application/x-tex">z = -1.96</annotation></span></span>
        </label>
        <label>
          <input type="radio" name="math-q" value="1" />
          <span><script type="math/tex">z = 1.96</script></span>
        </label>
      </div>
    `;
    document.body.appendChild(q);

    const scraped = await scrapeQuestion(q);
    // Verify table spacing injected between 10 and 20 (not 1020)
    expect(scraped.text).toContain("10 20");
    expect(scraped.text).not.toContain("1020");
    // Verify KaTeX annotation extracted cleanly
    expect(scraped.text).toContain("H_0: \\mu = 0");
    // Verify choice math extraction
    expect(scraped.choices[0]?.text).toContain("z = -1.96");
    expect(scraped.choices[1]?.text).toContain("z = 1.96");
  });

  it("handles Unicode minus signs in numbers and choices (\\u2212, \\u2013, \\u2014)", async () => {
    const q = document.createElement("div");
    q.className = "question-container";
    q.innerHTML = `
      <div data-testid="question-stem">
        <p>What is the correlation coefficient?</p>
      </div>
      <div class="choices-container">
        <label>
          <input type="radio" name="minus-q" value="0" />
          <span>−0.85</span>
        </label>
        <label>
          <input type="radio" name="minus-q" value="1" />
          <span>0.85</span>
        </label>
      </div>
    `;
    document.body.appendChild(q);

    const scraped = await scrapeQuestion(q);
    // Choice with Unicode minus −0.85 (\u2212) should normalize to -0.85
    expect(scraped.choices[0]?.text).toBe("-0.85");

    // Server/client matching with ASCII hyphen -0.85 should select the Unicode minus choice
    const count = selectAnswerChoice(q, "Working through this...\n\nAnswer: A (-0.85)", ["A"]);
    expect(count).toBe(1);
    const input = q.querySelectorAll<HTMLInputElement>('input[type="radio"]')[0];
    expect(input?.checked).toBe(true);
  });

  it("supports multi-letter choice labels (e.g. AA, AB, AC) seamlessly", async () => {
    const q = document.createElement("div");
    q.className = "question-container";
    let choicesHtml = "";
    // Generate 28 choices: A through Z, then AA, AB
    for (let i = 0; i < 28; i++) {
      choicesHtml += `
        <label class="choice-row">
          <input type="radio" name="large-q" value="${i}" />
          <span>Choice ${i}</span>
        </label>
      `;
    }
    q.innerHTML = `
      <div data-testid="question-stem"><p>Large pool question</p></div>
      <div class="choices">${choicesHtml}</div>
    `;
    document.body.appendChild(q);

    const scraped = await scrapeQuestion(q);
    expect(scraped.choices).toHaveLength(28);
    expect(scraped.choices[0]?.label).toBe("A");
    expect(scraped.choices[25]?.label).toBe("Z");
    expect(scraped.choices[26]?.label).toBe("AA");
    expect(scraped.choices[27]?.label).toBe("AB");

    // Select AA by label
    const count = selectAnswerChoice(q, "Answer: AA", ["AA"]);
    expect(count).toBe(1);
    const inputs = q.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    expect(inputs[26]?.checked).toBe(true);
    expect(inputs[0]?.checked).toBe(false);
  });
});
