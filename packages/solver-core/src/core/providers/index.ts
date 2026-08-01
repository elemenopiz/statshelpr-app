import { geminiProvider, DEFAULT_MODEL as GEMINI_DEFAULT_MODEL, IMAGE_MODEL as GEMINI_IMAGE_MODEL } from "./gemini";
import { isLunaModel, openaiProvider } from "./openai";
import type { LlmChatRequest, LlmProvider } from "./types";

export { GEMINI_BASE_URL, geminiProvider } from "./gemini";
export { OPENAI_BASE_URL, openaiProvider, LUNA_MODEL, isLunaModel } from "./openai";
// Retry/backoff helper every provider's chat()/chatStream() wraps its fetch()
// in (see gemini.ts) — re-exported here so it's reachable via this package's
// existing "./core/providers" export path instead of adding a new one, and so
// it's directly unit-testable (apps/workers/scripts/self-test-retry.ts).
export {
  fetchWithRetry,
  parseDurationHeaderMs,
  parseRetryAfterMs,
  retryDelayFromHeaders,
  RETRYABLE_STATUSES,
  type FetchWithRetryOptions,
  type RetryEvent,
} from "./retry";

// Same `globalThis` reach-through as gemini.ts/openai.ts — `process.env`
// only exists under Node/Next; Workers have no such global.
const env: Record<string, string | undefined> =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env ?? {};

export const defaultLlmProvider = geminiProvider;
// SOLVER_MODEL=gpt-5.6-luna toggles Luna as the default solver model in Node
// runtimes (eval harness) — providerForModel below routes on the model string,
// so flipping the default flips the provider too. Workers can't read
// process.env at module scope, so there the toggle is a per-request
// `body.model` instead (see routes/solve.ts).
export const DEFAULT_MODEL: string = env["SOLVER_MODEL"] ?? GEMINI_DEFAULT_MODEL;
export const IMAGE_MODEL: string = GEMINI_IMAGE_MODEL;

/** Model-string routing keeps the provider toggle in one place: a `gpt-*`
 *  model (per-request `body.model`, or SOLVER_MODEL above) sends the whole
 *  call to the OpenAI Luna provider; everything else stays on Gemini. */
export function providerForModel(model: string | undefined): LlmProvider {
  return model && isLunaModel(model) ? openaiProvider : geminiProvider;
}

export function chat(apiKey: string, req: LlmChatRequest) {
  return providerForModel(req.model).chat(apiKey, req);
}

export function chatStream(apiKey: string, req: LlmChatRequest) {
  return providerForModel(req.model).chatStream(apiKey, req);
}

export function imagePart(data: string, mediaType: string) {
  // No routing needed — both providers return the identical OpenAI-shaped
  // `image_url` part (LlmImagePart IS the OpenAI shape; Gemini translates it
  // internally when building its request body).
  return defaultLlmProvider.imagePart(data, mediaType);
}

export type {
  LlmChatMessage,
  LlmChatRequest,
  LlmChatResult,
  LlmChatUsage,
  LlmContentPart,
  LlmImagePart,
  LlmProvider,
  LlmRetryHooks,
  LlmStreamDelta,
  LlmTextPart,
  LlmThinkingOptions,
} from "./types";
export type {
  LlmChatMessage as ChatMessage,
  LlmChatRequest as ChatRequest,
  LlmChatResult as ChatResult,
  LlmChatUsage as ChatUsage,
  LlmContentPart as ContentPart,
  LlmImagePart as ImagePart,
  LlmStreamDelta as StreamDelta,
  LlmTextPart as TextPart,
} from "./types";
