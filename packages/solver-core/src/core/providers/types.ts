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

/** Optional hooks into a provider's built-in transient-failure retry (see
 *  core/providers/retry.ts). Every provider retries 429/5xx/network errors on
 *  its own even when this is omitted — these hooks are purely observational,
 *  for a caller that wants to react to a retry happening (e.g. solve.ts
 *  emitting an SSE "still working" heartbeat during a long backoff wait so
 *  the connection doesn't look idle — see retry.ts's `onWaiting` doc). */
export interface LlmRetryHooks {
  /** Optional total retry wall-clock budget, honored by providers that
   * implement bounded retry configuration. */
  maxElapsedMs?: number;
  /** Optional per-attempt connection timeout. */
  connectTimeoutMs?: number;
  /** Optional per-stream timeout. */
  streamTimeoutMs?: number;
  /** Optional heartbeat cadence while waiting between retries. */
  waitingIntervalMs?: number;
  /** Optional maximum retries after the initial attempt. */
  maxRetries?: number;
  /** Fires once right before each retry's backoff sleep begins. */
  onRetry?: (info: { attempt: number; delayMs: number; status?: number }) => void;
  /** Fires every ~10s while a single backoff sleep is still in progress. */
  onWaiting?: () => void;
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
  /** Provider-specific reasoning effort hint used by supported models. */
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
  /** See LlmRetryHooks. Optional; omit for silent automatic retry. */
  retry?: LlmRetryHooks;
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
