/**
 * Pure COGS (cost of goods sold) helpers for the Gemini API. No I/O, no Env
 * dependency — safe to unit-test directly (see
 * apps/workers/scripts/self-test-metrics.ts) and safe to import from the
 * pure aggregation layer (metrics-aggregate.ts).
 *
 * Rate table is USD per 1,000,000 tokens, keyed by the exact model id string
 * `resolveModel()` returns (packages/solver-core/src/solver/settings.ts):
 *   - `gemini-3.5-flash-lite` (DEFAULT_MODEL) — the large majority of solves
 *     (everything without an image).
 *   - `gemini-3.6-flash` (IMAGE_MODEL) — image/vision questions only.
 * Each recorded event carries ITS OWN model id (whatever `resolveModel(body)`
 * returned for that call), so an image solve is costed at the Flash rate and
 * a text solve at the cheaper Flash-Lite rate — never one blended rate
 * applied across all events. See routes/solve.ts (each calc leg — first
 * pass, optional repair, interpret — records its own event).
 *
 * *** VERIFY-AND-EDIT CONFIG — pricing changes; re-check before trusting ***
 * Source: https://ai.google.dev/gemini-api/docs/pricing (fetched 2026-07-22),
 * cross-checked against a second independent web search hit for
 * "Gemini 3.6 Flash" pricing (2026-07-22) that landed on the identical
 * $1.50 / $7.50 / $0.15-cached figures. gemini-3.5-flash-lite's $0.30/$2.50
 * was likewise corroborated by a second source (openrouter.ai /
 * artificialanalysis.ai). Both model ids now have 2-source agreement — higher
 * confidence than a single lookup, but still: several unrelated third-party
 * aggregator pages quoted wildly different numbers for similarly-named
 * "3.5/3.6 Flash" models (e.g. $0.75/$4.50, $1.50/$9.00) that did NOT
 * corroborate anything, so this is a snapshot, not a verified invoice —
 * re-pull before using this for real margin/pricing decisions.
 *
 * Flash-Lite's context caching isn't offered as a paid/explicit tier per the
 * source above, so — per "use pessimistic COGS assumptions" — its cached-token
 * rate is conservatively set equal to its full input rate (assume ZERO
 * caching discount) rather than guessing at an implicit-cache rate.
 */

export interface ModelRate {
  inputPer1M: number;
  outputPer1M: number;
  cachedInputPer1M: number;
}

/** The primary/headline text model — everything without an image. Mirrors
 *  packages/solver-core/src/core/providers/gemini.ts DEFAULT_MODEL, kept as
 *  a plain string (not imported) so this module stays dependency-free; if
 *  that default ever changes, update this constant to match. Used as the
 *  fixed `economics.model` in GET /api/metrics (the per-question headline
 *  math is always framed against this model, even if a handful of eval
 *  requests used a different `body.model` override that week). */
export const PRIMARY_TEXT_MODEL = "gemini-3.5-flash-lite";

/** Image/vision model — packages/solver-core/src/core/providers/gemini.ts
 *  IMAGE_MODEL. Kept in sync manually for the same reason as above. */
export const IMAGE_VISION_MODEL = "gemini-3.6-flash";

export const MODEL_RATES: Readonly<Record<string, ModelRate>> = {
  [PRIMARY_TEXT_MODEL]: { inputPer1M: 0.3, outputPer1M: 2.5, cachedInputPer1M: 0.3 },
  [IMAGE_VISION_MODEL]: { inputPer1M: 1.5, outputPer1M: 7.5, cachedInputPer1M: 0.15 },
};

/**
 * Fallback for any model id not in the table above (e.g. a per-request
 * `body.model` eval/benchmark override — see solver-core's SolveBody.model).
 * Deliberately set to the pricier of the two known rates so an unrecognized
 * model doesn't silently under-report cost.
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
 * all per-1M. Gemini's `promptTokenCount` is inclusive of cached tokens (per
 * `cachedContentTokenCount` semantics — see providers/gemini.ts mapUsage), so
 * we subtract cached out of prompt before applying the full input rate —
 * otherwise cached tokens would be billed twice (once at the cached rate,
 * once folded into the full-rate prompt count).
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
