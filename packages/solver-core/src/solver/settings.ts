import { DEFAULT_MODEL } from "../core/providers";

export const MODEL = DEFAULT_MODEL;
export const MAX_TOKENS_FIRST = 6000;
export const MAX_TOKENS_SECOND = 1500;

/** Pick the model for a request: an explicit per-request `model`
 * (eval/benchmark) wins; everything else — text AND image questions alike —
 * uses the one default MODEL. Luna is natively multimodal, so the old
 * text→vision model switch (and its separate pricing row) no longer exists. */
export function resolveModel(body: { model?: string; images?: unknown[] }): string {
  return body.model ?? MODEL;
}
