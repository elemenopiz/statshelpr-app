import type { AnswerChoice, BlankAnswer, SolveBlank } from "./types";

export function normalizeChoices(
  choices: AnswerChoice[] | undefined,
): AnswerChoice[] {
  return (choices ?? [])
    .map((choice) => ({
      label: choice.label.trim().toUpperCase(),
      text: choice.text.replace(/\s+/g, " ").trim(),
      type: choice.type,
    }))
    .filter((choice) => choice.label && choice.text);
}

export function deriveSelectedChoices(
  answer: string,
  rawChoices: AnswerChoice[] | undefined,
): string[] {
  const choices = normalizeChoices(rawChoices);
  if (choices.length === 0) return [];

  const byLabel = new Map(choices.map((choice) => [choice.label, choice]));
  const labels = choices.map((choice) => escapeRegExp(choice.label)).join("|");
  const allowMultiple = choices.some((choice) => choice.type === "checkbox");
  const answerLine =
    answer.match(/^\s*Answer\s*:?\s*(.+)$/im)?.[1] ??
    answer.match(/correct(?:\s+interpretation)?(?:\(s\))?\s*:?\s*(.+)$/im)?.[1] ??
    answer;

  const selected = new Set<string>();
  const labelRe = new RegExp(`(?:^|[^A-Za-z0-9])(${labels})(?=$|[^A-Za-z0-9])`, "gi");
  for (const match of answerLine.matchAll(labelRe)) {
    const label = match[1]?.toUpperCase();
    if (label && byLabel.has(label)) {
      selected.add(label);
      if (!allowMultiple) return [label];
    }
  }

  const answerLower = answer.toLowerCase();
  for (const choice of choices) {
    const choiceLower = choice.text.toLowerCase();
    if (choiceLower.length >= 12 && answerLower.includes(choiceLower)) {
      selected.add(choice.label);
      if (!allowMultiple) return [choice.label];
    }
  }

  return [...selected];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Map the model's answer text to one chosen option per blank, in blank order.
 * The prompt asks for `Blank <n>: <option>` lines; we read those first, then
 * fall back to matching by the blank's label, then to any single option the
 * answer mentions. Each blank's `answer` is "" when nothing matched (the
 * client just leaves that dropdown untouched).
 */
export function deriveBlankAnswers(
  answer: string,
  blanks: SolveBlank[] | undefined,
): BlankAnswer[] {
  if (!blanks?.length) return [];
  const lines = answer.split("\n");
  return blanks.map((blank, i) => {
    // 1) "Blank <n>: <option>" anywhere on a line — the exact format
    //    buildBlanksPrompt asks for. Tolerant of a leading "Answer:" prefix
    //    (e.g. "Answer: Blank 1: $8.60") and of several blanks packed on one
    //    line (captures up to the next "Blank <m>" or line end). This is the
    //    model's most common, most reliable output; without it a fully-correct
    //    answer parses to nothing and the dropdown is left blank.
    const byBlank = answer.match(
      new RegExp(`blank\\s*${i + 1}\\s*[:.)\\-]\\s*(.+?)(?=\\s+blank\\s*\\d\\b|$)`, "im"),
    );
    let picked = byBlank?.[1] ? matchOption(byBlank[1], blank.options) : "";
    // 1b) bare "<n>. <option>" / "Answer <n> - <option>" / "#<n>: <option>" at
    //     the start of a line (formats without the word "Blank")
    if (!picked) {
      const byIndex = answer.match(
        new RegExp(`^\\s*(?:answer|item|#)?\\s*${i + 1}\\s*[:.)\\-]\\s*(.+?)\\s*$`, "im"),
      );
      if (byIndex?.[1]) picked = matchOption(byIndex[1], blank.options);
    }
    // 2) a line that echoes this blank's label, then names an option
    if (!picked && blank.label) {
      const key = blank.label.toLowerCase().slice(0, 24);
      const labelLine = lines.find((ln) => ln.toLowerCase().includes(key));
      if (labelLine) picked = matchOption(labelLine, blank.options);
    }
    // 3) last resort: the single option the answer text mentions
    if (!picked) picked = soleMentionedOption(answer, blank.options);
    return { key: blank.key, answer: picked };
  });
}

/** Best option for a chunk of answer text: exact (case-insensitive) wins, then
 * the longest option that appears as a substring either way. */
function matchOption(text: string, options: string[]): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "";
  const tl = t.toLowerCase();
  for (const o of options) if (o.toLowerCase() === tl) return o;
  let best = "";
  for (const o of options) {
    const ol = o.toLowerCase();
    if (!ol) continue;
    const hit = tl.includes(ol) || (ol.length >= 3 && ol.includes(tl));
    if (hit && o.length > best.length) best = o;
  }
  return best;
}

/** If exactly one option is named anywhere in the answer, use it; ambiguous or
 * none → "". Guards short options (T/F, numbers) that would false-match. */
function soleMentionedOption(answer: string, options: string[]): string {
  const al = answer.toLowerCase();
  const hits = options.filter((o) => o.length >= 4 && al.includes(o.toLowerCase()));
  return hits.length === 1 ? hits[0]! : "";
}
