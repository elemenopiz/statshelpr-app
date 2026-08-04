/**
 * Re-prompt the model with an R run's stdout/stderr when it exited non-zero,
 * asking for repaired runnable R code. Ported from
 * apps/api/lib/solver/r-repair.ts (read-only reference, not imported — see
 * docs/cloud-run-r-migration.md §0/§3.2) with three Worker-specific changes:
 *
 *   1. Takes the resolved `model` as a parameter instead of importing the
 *      `MODEL` constant — routes/solve.ts already computed
 *      `resolveModel(body)` once for the whole request (text vs. image
 *      model) and passes it in here, so the repair call is costed/attributed
 *      to the SAME model as the rest of the request instead of always the
 *      default text model.
 *   2. Returns `{ code, usage }` instead of just `code` — the caller
 *      (routes/solve.ts) needs the repair call's own token usage to record
 *      its own metrics event (a repair round-trip is a real, separate LLM
 *      call and must be counted/costed on its own, not folded silently into
 *      the first pass's numbers).
 *   3. (gemini-fallback work) Routes through lib/llm.ts's chatWithFallback
 *      instead of calling a provider's chat() directly, so a repair call
 *      falls back to Gemini exactly like the first-pass/interpret legs —
 *      returns `servedBy` too, since a repair call can independently end up
 *      served by either provider.
 *
 * The prompt text itself is byte-identical to the apps/api version.
 */

import { extractRCode, parseResponse } from "@statshelpr/solver-core/core";
import type { LlmChatUsage } from "@statshelpr/solver-core/core/providers";
import { MAX_TOKENS_FIRST } from "@statshelpr/solver-core/solver";
import { chatWithFallback, type FallbackEnv, type FallbackOpts, type ServedBy } from "./llm";
import type { RunRResult } from "./r-runner";

export interface RepairResult {
  code: string | undefined;
  usage: LlmChatUsage | undefined;
  servedBy: ServedBy;
}

export async function repairRCode(
  env: FallbackEnv,
  model: string,
  system: string,
  questionPrompt: string,
  rCode: string,
  runResult: RunRResult,
  fallback: Pick<FallbackOpts, "geminiModel" | "authorizeFallback">,
): Promise<RepairResult> {
  const { result: repair, servedBy } = await chatWithFallback(env, {
    model,
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
    // Moonshot-specific field on the shared LlmChatRequest type; the Gemini
    // provider this Worker uses ignores it (Google handles caching
    // implicitly server-side — see core/providers/gemini.ts's
    // buildRequestBody comment). Kept only for parity with the apps/api
    // original; harmless no-op here.
    cacheKey: null,
  }, fallback);
  const parsed = parseResponse(repair.text);
  const candidate = extractRCode(parsed.body);
  return { code: candidate || undefined, usage: repair.usage, servedBy };
}
