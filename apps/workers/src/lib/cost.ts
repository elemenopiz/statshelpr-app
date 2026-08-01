/**
 * Pure COGS (cost of goods sold) helpers for the LLM API. No I/O, no Env
 * dependency — safe to unit-test directly (see
 * apps/workers/scripts/self-test-metrics.ts) and safe to import from the
 * pure aggregation layer (metrics-aggregate.ts).
 *
 * Rate table is USD per 1,000,000 tokens, keyed by the exact model id string
 * `resolveModel()` returns (packages/solver-core/src/solver/settings.ts).
 * There is exactly ONE active model: `gpt-5.6-luna` (LUNA_MODEL) — natively
 * multimodal, so text and image solves cost at the same row. Each recorded
 * event still carries ITS OWN model id (whatever `resolveModel(body)`
 * returned for that call) so an eval `body.model` override is costed as
 * itself, never blended. See routes/solve.ts (each calc leg — first pass,
 * optional repair, interpret — records its own event).
 *
 * *** VERIFY-AND-EDIT CONFIG — pricing changes; re-check before trusting ***
 * Luna rates are the post-2026-07-30 OpenAI price cut — $0.20/M input,
 * $1.20/M output, ~$0.02/M cached input — supplied directly by the project
 * owner on 2026-08-01, NOT independently verified against a second source.
 * Re-check https://openai.com/api/pricing before making any margin decisions
 * off this number. Billing semantics that make the math below work
 * unchanged: OpenAI bills reasoning tokens at the output rate and its
 * `usage.output_tokens` already includes them (see solver-core's
 * providers/openai.ts mapUsage), and `input_tokens` is inclusive of
 * `cached_tokens` — exactly the prompt-inclusive-of-cached semantics
 * costUsdForUsage's subtraction assumes.
 */

export interface ModelRate {
  inputPer1M: number;
  outputPer1M: number;
  cachedInputPer1M: number;
}

/** THE solver model — mirrors solver-core's providers/openai.ts LUNA_MODEL,
 *  kept as a plain string (not imported) so this module stays
 *  dependency-free; if that default ever changes, update this constant to
 *  match. Natively multimodal: text AND image solves both cost at this one
 *  rate — there is no separate vision model or row. */
export const LUNA_MODEL = "gpt-5.6-luna";

/** The primary/headline model — used as the fixed `economics.model` in
 *  GET /api/metrics (the per-question headline math is always framed against
 *  this model, even if a handful of eval requests used a different
 *  `body.model` override that week). The name predates the Luna migration
 *  (there used to be a separate vision model); kept because the metrics
 *  layer keys off it. */
export const PRIMARY_TEXT_MODEL = LUNA_MODEL;

/** LEGACY model id — the retired Gemini-era vision model. No new event will
 *  ever carry this id (resolveModel never returns it); it exists solely so
 *  metrics-aggregate.ts can keep attributing HISTORICAL daily buckets whose
 *  `byModel` maps recorded image solves under it. The dashboard's image-cost
 *  panel reads 0 for all post-migration days, which is truthful: image
 *  solves no longer have a distinct model or rate. */
export const IMAGE_VISION_MODEL = "gemini-3.6-flash";

export const MODEL_RATES: Readonly<Record<string, ModelRate>> = {
  [LUNA_MODEL]: { inputPer1M: 0.2, outputPer1M: 1.2, cachedInputPer1M: 0.02 },
};

/**
 * Fallback for any model id not in the table above (a per-request
 * `body.model` eval/benchmark override — see solver-core's SolveBody.model —
 * or a legacy Gemini id in a historical bucket). Deliberately pessimistic
 * (the retired Gemini vision model's old rate, several times Luna's) so an
 * unrecognized model doesn't silently under-report cost.
 */
export const DEFAULT_RATE: ModelRate = { inputPer1M: 1.5, outputPer1M: 7.5, cachedInputPer1M: 0.15 };

export function rateForModel(model: string): ModelRate {
  return MODEL_RATES[model] ?? DEFAULT_RATE;
}

export interface UsageTokens {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

/**
 * costUsd = nonCachedPrompt*input + completion*output + cached*cachedInput,
 * all per-1M. OpenAI's `input_tokens` is inclusive of cached tokens (see
 * providers/openai.ts mapUsage), so we subtract cached out of prompt before
 * applying the full input rate — otherwise cached tokens would be billed
 * twice (once at the cached rate, once folded into the full-rate prompt
 * count).
 */
export function costUsdForUsage(model: string, usage: UsageTokens): number {
  const rate = rateForModel(model);
  const promptTokens = Math.max(0, usage.promptTokens || 0);
  const completionTokens = Math.max(0, usage.completionTokens || 0);
  const cachedTokens = Math.max(0, Math.min(usage.cachedTokens || 0, promptTokens));
  const nonCachedPrompt = promptTokens - cachedTokens;

  const cost =
    (nonCachedPrompt / 1_000_000) * rate.inputPer1M +
    (completionTokens / 1_000_000) * rate.outputPer1M +
    (cachedTokens / 1_000_000) * rate.cachedInputPer1M;

  return Number.isFinite(cost) && cost > 0 ? cost : 0;
}
