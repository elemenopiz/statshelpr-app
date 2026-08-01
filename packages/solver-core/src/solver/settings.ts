import { DEFAULT_MODEL, IMAGE_MODEL as PROVIDER_IMAGE_MODEL, isLunaModel } from "../core/providers";

export const MODEL = DEFAULT_MODEL;
export const IMAGE_MODEL = PROVIDER_IMAGE_MODEL;
export const MAX_TOKENS_FIRST = 6000;
export const MAX_TOKENS_SECOND = 1500;

/** Pick the model for a request: an explicit per-request `model` (eval/benchmark)
 * wins; otherwise image questions go to the vision-reliable IMAGE_MODEL and
 * everything else to the cheap default MODEL. Exception: when the default is
 * Luna (`gpt-*`), image questions stay on it — Luna handles vision natively in
 * the same model, so the Gemini text→vision switch (and its separate pricing
 * row) doesn't apply. */
export function resolveModel(body: { model?: string; images?: unknown[] }): string {
  if (body.model) return body.model;
  if (isLunaModel(MODEL)) return MODEL;
  return (body.images?.length ?? 0) > 0 ? IMAGE_MODEL : MODEL;
}
