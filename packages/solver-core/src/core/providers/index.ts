import { geminiProvider, DEFAULT_MODEL as GEMINI_DEFAULT_MODEL, IMAGE_MODEL as GEMINI_IMAGE_MODEL } from "./gemini";
import type { LlmChatRequest } from "./types";

export { GEMINI_BASE_URL, geminiProvider } from "./gemini";
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

export const defaultLlmProvider = geminiProvider;
export const DEFAULT_MODEL: string = GEMINI_DEFAULT_MODEL;
export const IMAGE_MODEL: string = GEMINI_IMAGE_MODEL;

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
