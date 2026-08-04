/**
 * Pure COGS (cost of goods sold) helpers for the LLM API. No I/O, no Env
 * dependency — safe to unit-test directly (see
 * apps/workers/scripts/self-test-metrics.ts) and safe to import from the
 * pure aggregation layer (metrics-aggregate.ts).
 *
 * Rate table is USD per 1,000,000 tokens, keyed by the exact model id string
 * that actually served a call — `resolveModel()` (packages/solver-core/src/
 * solver/settings.ts) for a Luna call, or lib/llm.ts's ServedBy.model for a
 * Gemini fallback call (gemini-fallback work, 2026-08-04): Luna
 * (`gpt-5.6-luna`) is primary and natively multimodal (text AND image solves
 * cost at the same row), but a Luna failure falls back to Gemini, which DOES
 * still split by content: `gemini-3.5-flash-lite` for text,
 * `gemini-3.6-flash` for image/vision (see core/providers/gemini.ts).  Each
 * recorded event carries ITS OWN model id (whatever actually served that
 * call), so a fallback-served event is costed at ITS provider's rate — never
 * blended into Luna's numbers. See routes/solve.ts (each calc leg — first
 * pass, optional repair, interpret — records its own event) and lib/llm.ts.
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
 *
 * Gemini rates below are UNCHANGED from the pre-fc35aa5 code (restored
 * verbatim, not re-verified this pass) — source: https://ai.google.dev/
 * gemini-api/docs/pricing (fetched 2026-07-22), cross-checked against a
 * second independent source at the time. gemini-3.5-flash-lite's caching
 * isn't offered as a paid/explicit tier per that source, so — per "use
 * pessimistic COGS assumptions" — its cached-token rate is conservatively set
 * equal to its full input rate (assume ZERO caching discount). Re-pull both
 * before trusting them for real margin/pricing decisions; they've had no
 * fresh price check since the original 2026-07-22 lookup.
 */

export interface ModelRate {
  inputPer1M: number;
  outputPer1M: number;
  cachedInputPer1M: number;
}

/** THE PRIMARY solver model — mirrors solver-core's providers/openai.ts
 *  LUNA_MODEL, kept as a plain string (not imported) so this module stays
 *  dependency-free; if that default ever changes, update this constant to
 *  match. Natively multimodal: text AND image solves both cost at this one
 *  rate when Luna serves — there is no separate vision model or row for it. */
export const LUNA_MODEL = "gpt-5.6-luna";

/** The primary/headline model — used as the fixed `economics.model` in
 *  GET /api/metrics (the per-question headline math is always framed against
 *  this model, even if a handful of eval requests used a different
 *  `body.model` override that week, or some of the window's calls were
 *  actually served by a Gemini fallback — see economics.modelsUsed for the
 *  full per-model split, which DOES include fallback-served rows). */
export const PRIMARY_TEXT_MODEL = LUNA_MODEL;

/** Gemini fallback text model (gemini-fallback work) — mirrors
 *  core/providers/gemini.ts's DEFAULT_MODEL, kept as a plain string for the
 *  same dependency-free reason as LUNA_MODEL above. Used for the Gemini
 *  fallback attempt on any solve WITHOUT an image; see lib/llm.ts /
 *  routes/solve.ts's `geminiModel` selection. */
export const GEMINI_TEXT_MODEL = "gemini-3.5-flash-lite";

/** Gemini fallback vision model — mirrors core/providers/gemini.ts's
 *  IMAGE_MODEL. Used for the Gemini fallback attempt on any solve WITH an
 *  image (Flash-Lite is unreliable on figures — see gemini.ts). Also the
 *  LEGACY model id historical (pre-Luna-migration) daily buckets used for
 *  image solves — metrics-aggregate.ts's imageCalls/imageCostSharePct keys
 *  off this same constant for both eras, so no separate "legacy" alias is
 *  needed: pre-migration days and post-migration Gemini-fallback days both
 *  correctly land here. */
export const IMAGE_VISION_MODEL = "gemini-3.6-flash";

export const MODEL_RATES: Readonly<Record<string, ModelRate>> = {
  [LUNA_MODEL]: { inputPer1M: 0.2, outputPer1M: 1.2, cachedInputPer1M: 0.02 },
  [GEMINI_TEXT_MODEL]: { inputPer1M: 0.3, outputPer1M: 2.5, cachedInputPer1M: 0.3 },
  [IMAGE_VISION_MODEL]: { inputPer1M: 1.5, outputPer1M: 7.5, cachedInputPer1M: 0.15 },
};

/**
 * Fallback for any model id not in the table above (a per-request
 * `body.model` eval/benchmark override — see solver-core's SolveBody.model —
 * or an even-older legacy id in a historical bucket that predates both
 * MODEL_RATES rows above). Deliberately pessimistic — same numbers as
 * IMAGE_VISION_MODEL's own row, several times Luna's rate — so an
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
