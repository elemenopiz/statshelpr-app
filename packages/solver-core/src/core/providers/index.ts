import { LUNA_MODEL, openaiProvider } from "./openai";
import type { LlmChatRequest } from "./types";

export { OPENAI_BASE_URL, openaiProvider, LUNA_MODEL } from "./openai";
// Retry/backoff helper the provider's chat()/chatStream() wraps its fetch()
// in (see openai.ts) — re-exported here so it's reachable via this package's
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

// OpenAI Luna is THE provider — there is no routing layer and no fallback.
// gemini.ts stays on disk for reference only; nothing imports it. (Removing
// this file's old providerForModel() branching was deliberate: one provider,
// one model, one pricing row — see apps/workers/src/lib/cost.ts.)
export const defaultLlmProvider = openaiProvider;
// Luna handles text AND vision in this one model, so unlike the old Gemini
// setup there is no separate IMAGE_MODEL. Overridable via OPENAI_MODEL (see
// openai.ts) for eval A/B runs.
export const DEFAULT_MODEL: string = LUNA_MODEL;

export function chat(apiKey: string, req: LlmChatRequest) {
  return defaultLlmProvider.chat(apiKey, req);
}

export function chatStream(apiKey: string, req: LlmChatRequest) {
  return defaultLlmProvider.chatStream(apiKey, req);
}

export function imagePart(data: string, mediaType: string) {
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
