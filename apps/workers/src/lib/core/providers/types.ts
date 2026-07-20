export type LlmTextPart = { type: "text"; text: string };

export type LlmImagePart = {
  type: "image_url";
  image_url: { url: string; detail?: "low" | "high" | "auto" };
};

export type LlmContentPart = LlmTextPart | LlmImagePart;

export interface LlmChatMessage {
  role: "system" | "user" | "assistant";
  content: string | LlmContentPart[];
}

export interface LlmThinkingOptions {
  type: "enabled" | "disabled";
  keep?: "all";
}

export interface LlmChatRequest {
  model?: string;
  system: string;
  messages: LlmChatMessage[];
  temperature?: number;
  maxTokens?: number;
  cacheKey?: string | null;
  /** Defaults to disabled. Enable for harder first-pass reasoning. */
  thinking?: LlmThinkingOptions;
}

export interface LlmChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cached_tokens?: number;
}

export interface LlmChatResult {
  text: string;
  finishReason: string;
  usage?: LlmChatUsage;
}

export interface LlmStreamDelta {
  text?: string;
  done?: boolean;
  finishReason?: string;
  usage?: LlmChatUsage;
}

export interface LlmProvider {
  chat(apiKey: string, req: LlmChatRequest): Promise<LlmChatResult>;
  chatStream(apiKey: string, req: LlmChatRequest): AsyncGenerator<LlmStreamDelta>;
  imagePart(data: string, mediaType: string): LlmImagePart;
}
