import { LUNA_MODEL, openaiProvider } from "./openai";
import {
  geminiProvider,
  DEFAULT_MODEL as GEMINI_DEFAULT_MODEL,
  IMAGE_MODEL as GEMINI_IMAGE_MODEL,
} from "./gemini";
import type { LlmChatRequest } from "./types";

export { OPENAI_BASE_URL, openaiProvider, LUNA_MODEL } from "./openai";
// Gemini is no longer the default, but it IS a real, wired second provider —
// apps/workers/src/lib/llm.ts uses it as the automatic server-side fallback
// when Luna's own retry policy (core/providers/retry.ts) is exhausted (5xx/
// timeout/429) or OPENAI_API_KEY is missing/invalid. Exported here (not just
// left on disk) so that Worker-side fallback code can reach it through this
// package's public "./core/providers" entry point instead of a deep import
// (see package.json's "exports" map, which only publishes this barrel).
export {
  GEMINI_BASE_URL,
  geminiProvider,
  DEFAULT_MODEL as GEMINI_DEFAULT_MODEL,
  IMAGE_MODEL as GEMINI_IMAGE_MODEL,
} from "./gemini";
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

// OpenAI Luna is THE PRIMARY provider for the plain chat()/chatStream()
// convenience functions below (unchanged — apps/api's /api/solve route still
// calls these directly and stays Luna-only, no fallback, out of scope for the
// gemini-fallback work). The Worker's OWN solve route does NOT use these
// three functions for its actual LLM calls anymore — it calls
// apps/workers/src/lib/llm.ts's chatWithFallback()/chatStreamWithFallback(),
// which try openaiProvider first and fall back to geminiProvider (imported
// directly above) on failure. Kept here, unchanged, for back-compat.
export const defaultLlmProvider = openaiProvider;
// Luna handles text AND vision in this one model, so unlike the old Gemini
// setup there is no separate IMAGE_MODEL for IT specifically. Overridable via
// OPENAI_MODEL (see openai.ts) for eval A/B runs. Gemini's own DEFAULT_MODEL/
// IMAGE_MODEL (re-exported above as GEMINI_DEFAULT_MODEL/GEMINI_IMAGE_MODEL)
// still keep their own text/image split — Flash-Lite is unreliable on figures
// (see gemini.ts) — used only when the Worker's fallback path picks Gemini.
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
