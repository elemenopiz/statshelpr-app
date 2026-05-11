import type {
  LlmChatMessage,
  LlmChatRequest,
  LlmChatResult,
  LlmChatUsage,
  LlmImagePart,
  LlmProvider,
  LlmStreamDelta,
} from "./types";

/**
 * Moonshot AI (Kimi) chat-completions provider.
 *
 * Uses the OpenAI-compatible /v1/chat/completions endpoint. Supports:
 *   - non-streaming requests
 *   - streaming via SSE (yields text deltas)
 *   - Kimi-specific `prompt_cache_key` for caching the large system prompt
 *   - Kimi K2.6 `thinking` mode for harder routing / answer selection
 *
 * Docs: https://platform.moonshot.ai/docs/api/chat
 */

export const MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1";
export const DEFAULT_MODEL = "kimi-k2.6";

// Prompt-cache key. Setting this to a stable constant means Kimi reuses the
// cached prefix (system prompt) across requests.
export const DEFAULT_CACHE_KEY = "statshelpr-system-v1";

function makeBody(apiKey: string, req: LlmChatRequest, stream: boolean): RequestInit {
  const messages: LlmChatMessage[] = [
    { role: "system", content: req.system },
    ...req.messages,
  ];

  const body: Record<string, unknown> = {
    model: req.model ?? DEFAULT_MODEL,
    messages,
    max_tokens: req.maxTokens ?? 4096,
    stream,
    thinking: req.thinking ?? { type: "disabled" },
  };

  if ((req.thinking?.type ?? "disabled") === "disabled") {
    body["temperature"] = req.temperature ?? 0.6;
  }

  if (req.cacheKey !== null) {
    body["prompt_cache_key"] = req.cacheKey ?? DEFAULT_CACHE_KEY;
  }

  return {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

async function rejectIfBad(res: Response): Promise<void> {
  if (res.ok) return;
  const text = await res.text();
  let inner: string | undefined;
  try {
    const j = JSON.parse(text) as { error?: { message?: string } | string };
    inner = typeof j.error === "string" ? j.error : j.error?.message;
  } catch {
    /* not json */
  }
  const err = new Error(inner ?? `Moonshot API ${res.status}: ${text.slice(0, 240)}`);
  (err as Error & { status?: number }).status = res.status;
  throw err;
}

async function chat(apiKey: string, req: LlmChatRequest): Promise<LlmChatResult> {
  const res = await fetch(`${MOONSHOT_BASE_URL}/chat/completions`, makeBody(apiKey, req, false));
  await rejectIfBad(res);

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    usage?: LlmChatUsage;
  };
  const choice = json.choices?.[0];
  return {
    text: choice?.message?.content ?? "",
    finishReason: choice?.finish_reason ?? "stop",
    usage: json.usage,
  };
}

async function* chatStream(
  apiKey: string,
  req: LlmChatRequest,
): AsyncGenerator<LlmStreamDelta> {
  const res = await fetch(`${MOONSHOT_BASE_URL}/chat/completions`, makeBody(apiKey, req, true));
  await rejectIfBad(res);
  if (!res.body) throw new Error("Empty Moonshot stream body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let lastUsage: LlmChatUsage | undefined;
  let lastFinish: string | undefined;

  outer: while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line || !line.startsWith("data:")) continue;

      const payload = line.slice(5).trim();
      if (payload === "[DONE]") break outer;

      let evt: {
        choices?: Array<{ delta?: { content?: string }; finish_reason?: string }>;
        usage?: LlmChatUsage;
      };
      try {
        evt = JSON.parse(payload);
      } catch {
        continue;
      }

      const ch = evt.choices?.[0];
      const text = ch?.delta?.content;
      if (text) yield { text };
      if (ch?.finish_reason) lastFinish = ch.finish_reason;
      if (evt.usage) lastUsage = evt.usage;
    }
  }

  yield { done: true, finishReason: lastFinish, usage: lastUsage };
}

function imagePart(data: string, mediaType: string): LlmImagePart {
  return {
    type: "image_url",
    image_url: { url: `data:${mediaType};base64,${data}` },
  };
}

export const moonshotProvider: LlmProvider = {
  chat,
  chatStream,
  imagePart,
};
