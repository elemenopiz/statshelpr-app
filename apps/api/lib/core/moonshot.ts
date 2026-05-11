import { moonshotProvider } from "./providers/moonshot";
import type {
  LlmChatMessage,
  LlmChatRequest,
  LlmChatResult,
  LlmChatUsage,
  LlmContentPart,
  LlmImagePart,
  LlmStreamDelta,
  LlmTextPart,
} from "./providers/types";

export {
  DEFAULT_CACHE_KEY,
  DEFAULT_MODEL,
  MOONSHOT_BASE_URL,
  moonshotProvider,
} from "./providers/moonshot";

export type TextPart = LlmTextPart;
export type ImagePart = LlmImagePart;
export type ContentPart = LlmContentPart;
export type ChatMessage = LlmChatMessage;
export type ChatRequest = LlmChatRequest;
export type ChatUsage = LlmChatUsage;
export type ChatResult = LlmChatResult;
export type StreamDelta = LlmStreamDelta;

export function chat(apiKey: string, req: ChatRequest): Promise<ChatResult> {
  return moonshotProvider.chat(apiKey, req);
}

/**
 * Streaming chat. Yields incremental text deltas as they arrive plus a final
 * delta with `done: true` and usage stats.
 */
export function chatStream(
  apiKey: string,
  req: ChatRequest,
): AsyncGenerator<StreamDelta> {
  return moonshotProvider.chatStream(apiKey, req);
}

/** Build an `image_url` content part from raw base64 + media type. */
export function imagePart(data: string, mediaType: string): ImagePart {
  return moonshotProvider.imagePart(data, mediaType);
}
