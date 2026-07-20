import { geminiProvider, DEFAULT_MODEL as GEMINI_DEFAULT_MODEL } from "./gemini";
import type { LlmChatRequest } from "./types";

export { GEMINI_BASE_URL, geminiProvider } from "./gemini";

export const defaultLlmProvider = geminiProvider;
export const DEFAULT_MODEL: string = GEMINI_DEFAULT_MODEL;

/**
 * Resolve the Gemini API key. Kept as a function (rather than reading the env
 * inline at each caller) so tests and future providers can override it.
 */
export function resolveApiKey(): { apiKey: string | undefined; envName: string } {
  return {
    apiKey: process.env["GEMINI_API_KEY"],
    envName: "GEMINI_API_KEY",
  };
}

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
