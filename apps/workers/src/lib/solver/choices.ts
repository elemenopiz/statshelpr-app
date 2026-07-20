import type { AnswerChoice } from "./types";

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
