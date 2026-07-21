import { DEFAULT_MODEL, IMAGE_MODEL as PROVIDER_IMAGE_MODEL } from "../core/providers";

export const MODEL = DEFAULT_MODEL;
export const IMAGE_MODEL = PROVIDER_IMAGE_MODEL;
export const MAX_TOKENS_FIRST = 6000;
export const MAX_TOKENS_SECOND = 1500;

/** Pick the model for a request: an explicit per-request `model` (eval/benchmark)
 * wins; otherwise image questions go to the vision-reliable IMAGE_MODEL and
 * everything else to the cheap default MODEL. */
export function resolveModel(body: { model?: string; images?: unknown[] }): string {
  if (body.model) return body.model;
  return (body.images?.length ?? 0) > 0 ? IMAGE_MODEL : MODEL;
}
