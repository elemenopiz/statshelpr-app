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
 *
 * A blank with an empty `options` list (Classic `fill_in_multiple_blanks_question`
 * free-text blanks — see buildBlanksPrompt) has no option pool to snap to, so
 * its parsed chunk is accepted verbatim (cleaned) instead of run through
 * matchOption. The label-echo and sole-mentioned-option fallback stages (2, 3)
 * are option-pool-specific — they either search for an *option* by substring
 * or count how many *options* a line mentions, neither of which is meaningful
 * with no options — so they're skipped for option-less blanks; only the
 * `Blank N:` / bare `N.` forms (stages 1, 1b) can resolve a free-text blank.
 */
export function deriveBlankAnswers(
  answer: string,
  blanks: SolveBlank[] | undefined,
): BlankAnswer[] {
  if (!blanks?.length) return [];
  const lines = answer.split("\n");
  return blanks.map((blank, i) => {
    const hasOptions = blank.options.length > 0;
    const resolve = (chunk: string): string =>
      hasOptions ? matchOption(chunk, blank.options) : cleanFreeformValue(chunk);

    // 1) "Blank <n>: <option>" anywhere on a line — the exact format
    //    buildBlanksPrompt asks for. Tolerant of a leading "Answer:" prefix
    //    (e.g. "Answer: Blank 1: $8.60") and of several blanks packed on one
    //    line (captures up to the next "Blank <m>" or line end). This is the
    //    model's most common, most reliable output; without it a fully-correct
    //    answer parses to nothing and the dropdown is left blank.
    const byBlank = answer.match(
      new RegExp(`blank\\s*${i + 1}\\s*[:.)\\-]\\s*(.+?)(?=\\s+blank\\s*\\d\\b|$)`, "im"),
    );
    let picked = byBlank?.[1] ? resolve(byBlank[1]) : "";
    // 1b) bare "<n>. <option>" / "Answer <n> - <option>" / "#<n>: <option>" at
    //     the start of a line (formats without the word "Blank")
    if (!picked) {
      const byIndex = answer.match(
        new RegExp(`^\\s*(?:answer|item|#)?\\s*${i + 1}\\s*[:.)\\-]\\s*(.+?)\\s*$`, "im"),
      );
      if (byIndex?.[1]) picked = resolve(byIndex[1]);
    }
    // 2) a line that echoes this blank's label, then names an option
    //    (option-pool blanks only — see doc comment above). The answer is
    //    whatever FOLLOWS the echoed label, not the label itself — a
    //    matching/multiple-dropdowns option pool is shared across every
    //    blank, and a row's own label can legitimately name a DIFFERENT pool
    //    term (e.g. "Sample"'s captured label is "A specific selection of
    //    cases from the population.", which contains "population" — a
    //    different, longer option). Feeding the whole line (label text
    //    included) into matchOption lets that other term win on raw
    //    longest-substring. Stripping the echoed label out first removes the
    //    false signal at its source.
    if (!picked && hasOptions && blank.label) {
      const key = blank.label.toLowerCase().slice(0, 24);
      const labelLine = lines.find((ln) => ln.toLowerCase().includes(key));
      if (labelLine) picked = matchOption(stripLabelEcho(labelLine, blank.label), blank.options);
    }
    // 3) last resort: the single option the answer text mentions
    //    (option-pool blanks only — see doc comment above)
    if (!picked && hasOptions) picked = soleMentionedOption(answer, blank.options);
    return { key: blank.key, answer: picked };
  });
}

/** Clean a free-text blank's parsed chunk into a bare value: trim, drop one
 * layer of trailing sentence punctuation, strip wrapping quotes. Mirrors
 * canvas-dom.ts's fillTextInput() cleanup exactly, so a single-text-fill
 * answer and a fill-in-multiple-blanks answer end up formatted the same way. */
function cleanFreeformValue(text: string): string {
  let value = text.trim();
  if (!value) return "";
  value = value.replace(/[.,;]\s*$/, "").trim();
  value = value.replace(/^["'`]|["'`]$/g, "");
  return value;
}

/** Remove an echoed label from the FRONT of a matched line, keeping only what
 * follows it — the label-echo stage (2, above) only cares about the answer
 * that comes AFTER the label, never the label's own wording. Tries the full
 * label text first (an exact, case-insensitive match — the common case, since
 * the model usually restates the label verbatim before naming the answer);
 * falls back to stripping just the short key used to locate the line (its
 * first 24 chars) when the model paraphrased the label, so at minimum the
 * label's own opening words can't feed the scorer either. Never returns an
 * empty result when stripping would leave nothing usable — the caller's
 * matchOption still needs *something* to search. */
function stripLabelEcho(line: string, label: string): string {
  const lineLower = line.toLowerCase();
  const labelLower = label.toLowerCase();
  const idx = lineLower.indexOf(labelLower);
  if (idx >= 0) {
    const remainder = line.slice(idx + label.length).trim();
    if (remainder) return remainder;
  }
  const key = labelLower.slice(0, 24);
  const keyIdx = lineLower.indexOf(key);
  if (keyIdx >= 0) {
    const remainder = line.slice(keyIdx + key.length).trim();
    if (remainder) return remainder;
  }
  return line;
}

/** Best option for a chunk of answer text: exact (case-insensitive) wins.
 * Otherwise, the option with the strongest containment evidence — a
 * word-boundary substring match (the option appears as a whole token, not
 * embedded mid-word) beats a raw substring match — and only among matches of
 * EQUAL strength does the longest option win. This keeps a short option (e.g.
 * "Sample") from losing to an unrelated, longer option (e.g. "Population")
 * that happens to also appear as a same-strength substring elsewhere in the
 * text — length alone no longer overrides match quality. (Two options where
 * one is a raw substring of the other, e.g. a hypothetical "Sample"/"Sample
 * size", are covered by the same rule: the shorter one still needs a
 * word-boundary hit to beat a longer merely-contained rival, and a longer
 * option that only matches mid-word never beats a shorter boundary match.) */
function matchOption(text: string, options: string[]): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "";
  const tl = t.toLowerCase();
  for (const o of options) if (o.toLowerCase() === tl) return o;

  let best = "";
  let bestTier = -1;
  for (const o of options) {
    const ol = o.toLowerCase();
    if (!ol) continue;
    let tier = -1;
    if (tl.includes(ol)) tier = isWordBoundaryMatch(tl, ol) ? 1 : 0;
    else if (ol.length >= 3 && ol.includes(tl)) tier = isWordBoundaryMatch(ol, tl) ? 1 : 0;
    if (tier < 0) continue;
    if (tier > bestTier || (tier === bestTier && o.length > best.length)) {
      best = o;
      bestTier = tier;
    }
  }
  return best;
}

/** Whether `needle` appears in `haystack` (both already lowercased) bounded by
 * non-alphanumeric characters (or the string edges) on both sides — i.e. as a
 * whole token/phrase rather than embedded inside a longer word. */
function isWordBoundaryMatch(haystack: string, needle: string): boolean {
  if (!needle) return false;
  return new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(needle)}(?:$|[^a-z0-9])`).test(haystack);
}

/** If exactly one option is named anywhere in the answer, use it; ambiguous or
 * none → "". Guards short options (T/F, numbers) that would false-match. */
function soleMentionedOption(answer: string, options: string[]): string {
  const al = answer.toLowerCase();
  const hits = options.filter((o) => o.length >= 4 && al.includes(o.toLowerCase()));
  return hits.length === 1 ? hits[0]! : "";
}
