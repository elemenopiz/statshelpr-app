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

  const choiceLines = choices.map((c) => `${c.label}. ${c.text}`);
  const multi = choices.some((c) => c.type === "checkbox");
  return [
    base,
    "",
    "Answer choices:",
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
