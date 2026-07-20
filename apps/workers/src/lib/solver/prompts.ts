import { imagePart, type LlmContentPart } from "@/lib/core/providers";
import type { SolveImage } from "@/lib/core/types";
import { normalizeChoices } from "./choices";
import type { SolveBody } from "./types";

export function buildUserContent(
  text: string | undefined,
  images: SolveImage[] | undefined,
): string | LlmContentPart[] {
  const t = text?.trim();
  const imgs = images ?? [];
  if (imgs.length === 0) return t ?? "";

  const parts: LlmContentPart[] = [];
  for (const img of imgs) {
    parts.push(imagePart(img.data, img.mediaType));
  }
  if (t) parts.push({ type: "text", text: t });
  return parts;
}

export function buildQuestionPrompt(body: SolveBody): string {
  const base = body.questionText?.trim() || "(see image)";
  const choices = normalizeChoices(body.choices);
  if (choices.length === 0) return base;

  // Text-fill (numerical / short-answer) — no labeled choices, just one slot
  if (choices.length === 1 && choices[0]?.type === "text") {
    return [
      base,
      "",
      "This is a FILL-IN answer (no multiple choice).",
      "Return the final value on the last line as: Answer: <value>",
      "For numerical answers, give the number with no units (e.g. `Answer: 42.5`).",
    ].join("\n");
  }

  const isDropdown = choices.every((c) => c.type === "dropdown");
  const multi = choices.some((c) => c.type === "checkbox");
  const choiceLines = choices.map((c) => `${c.label}. ${c.text}`);
  // Dropdown options can be any text (numbers, ranges, statistical test names,
  // T/F, etc.) — don't bias the model toward any particular set of values.
  const header = isDropdown ? "Dropdown options (pick exactly one):" : "Answer choices:";
  return [
    base,
    "",
    header,
    ...choiceLines,
    "",
    multi
      ? "Return the correct choice letter(s) in the final Answer line, for example: Answer: A, C."
      : "Return the correct choice letter in the final Answer line, for example: Answer: B.",
  ].join("\n");
}

export function buildFollowupContent(
  body: SolveBody,
  rCode: string,
  rOutput: string,
): string {
  const questionPrompt = buildQuestionPrompt(body);
  return `QUESTION:
${questionPrompt}

The R code below was executed. Use its output to choose the correct answer.

R CODE:
\`\`\`r
${rCode}
\`\`\`

R OUTPUT:
\`\`\`
${rOutput.slice(0, 6000)}
\`\`\`

Now respond with the routing tag [CONCEPT] followed by:
Answer: <best answer>
CONFIDENCE: <High/Med/Low>`;
}
