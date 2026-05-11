import { moonshotProvider } from "./moonshot";
import type { LlmChatRequest } from "./types";

export {
  DEFAULT_CACHE_KEY,
  DEFAULT_MODEL,
  MOONSHOT_BASE_URL,
  moonshotProvider,
} from "./moonshot";

export const defaultLlmProvider = moonshotProvider;

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
