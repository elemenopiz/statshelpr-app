import { extractRCode, parseResponse } from "@statshelpr/solver-core/core";
import { chat } from "@statshelpr/solver-core/core/providers";
import type { RunRResult } from "@/lib/sandbox";
import { MAX_TOKENS_FIRST, MODEL } from "@statshelpr/solver-core/solver";

export async function repairRCode(
  apiKey: string,
  system: string,
  questionPrompt: string,
  rCode: string,
  runResult: RunRResult,
): Promise<string | undefined> {
  const repair = await chat(apiKey, {
    model: MODEL,
    system,
    messages: [
      {
        role: "user",
        content: [
          "The R code for this statistics question failed. Return repaired runnable R code only.",
          "Keep the first line as a # PLAN: comment. Do not include markdown fences.",
          "Do not create plots; print text summaries and a final answer line.",
          "",
          "QUESTION:",
          questionPrompt,
          "",
          "FAILED R CODE:",
          rCode,
          "",
          "STDOUT:",
          runResult.stdout.slice(0, 3000),
          "",
          "STDERR:",
          runResult.stderr.slice(0, 3000),
          "",
          `EXIT CODE: ${runResult.exitCode}`,
        ].join("\n"),
      },
    ],
    maxTokens: MAX_TOKENS_FIRST,
    thinking: { type: "enabled" },
    cacheKey: null,
  });
  const parsed = parseResponse(repair.text);
  const candidate = extractRCode(parsed.body);
  return candidate || undefined;
}
