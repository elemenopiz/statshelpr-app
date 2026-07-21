import type {
  LlmChatMessage,
  LlmChatRequest,
  LlmChatResult,
  LlmChatUsage,
  LlmContentPart,
  LlmImagePart,
  LlmProvider,
  LlmStreamDelta,
} from "./types";

/**
 * Google Gemini (Generative Language API) provider.
 *
 * Uses the `:generateContent` and `:streamGenerateContent` endpoints on
 * `generativelanguage.googleapis.com/v1beta`. Supports:
 *   - non-streaming requests
 *   - SSE streaming (`?alt=sse`, yields text deltas)
 *   - system prompt via `system_instruction`
 *   - Gemini 3.5 thinking via `generationConfig.thinkingConfig.thinkingLevel`
 *   - implicit prompt caching (server-side dedup — no client action needed)
 *
 * Auth: API key on `x-goog-api-key` header.
 *
 * Docs:
 *   https://ai.google.dev/gemini-api/docs/models
 *   https://ai.google.dev/api/generate-content
 *   https://ai.google.dev/gemini-api/docs/generate-content/whats-new-gemini-3.5
 */

export const GEMINI_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta";
export const DEFAULT_MODEL = "gemini-3.5-flash-lite";
// Image/vision questions route here — Flash-Lite is unreliable at reading figures,
// while 3.6 Flash is reliable. (Workers runtime has no process.env; set at deploy.)
export const IMAGE_MODEL = "gemini-3.6-flash";

// Gemini role names differ from OpenAI-style: user → "user", assistant → "model".
type GeminiRole = "user" | "model";

interface GeminiTextPart {
  text: string;
}

interface GeminiInlineDataPart {
  inline_data: { mime_type: string; data: string };
}

type GeminiPart = GeminiTextPart | GeminiInlineDataPart;

interface GeminiContent {
  role: GeminiRole;
  parts: GeminiPart[];
}

interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
}

interface GeminiStreamChunk {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  usageMetadata?: GeminiUsageMetadata;
}

/**
 * Convert a `data:<mime>;base64,<data>` URL into Gemini's `inline_data` part.
 * If the URL isn't a data URL, we still wrap it — Gemini will reject non-inline
 * URLs, which will surface via `rejectIfBad`.
 */
function imageUrlToInlineData(url: string): GeminiInlineDataPart {
  const match = url.match(/^data:([^;,]+);base64,(.*)$/);
  if (match) {
    return { inline_data: { mime_type: match[1]!, data: match[2]! } };
  }
  // Fallback: assume PNG. Gemini will error if this isn't base64 data.
  return { inline_data: { mime_type: "image/png", data: url } };
}

function partToGemini(part: LlmContentPart): GeminiPart {
  if (part.type === "text") return { text: part.text };
  return imageUrlToInlineData(part.image_url.url);
}

function messageToGemini(msg: LlmChatMessage): GeminiContent | null {
  if (msg.role === "system") return null; // handled via system_instruction
  const role: GeminiRole = msg.role === "assistant" ? "model" : "user";
  const parts: GeminiPart[] =
    typeof msg.content === "string"
      ? [{ text: msg.content }]
      : msg.content.map(partToGemini);
  return { role, parts };
}

function mapUsage(u?: GeminiUsageMetadata): LlmChatUsage | undefined {
  if (!u) return undefined;
  return {
    prompt_tokens: u.promptTokenCount,
    completion_tokens: u.candidatesTokenCount,
    total_tokens: u.totalTokenCount,
    cached_tokens: u.cachedContentTokenCount,
  };
}

function buildRequestBody(req: LlmChatRequest): Record<string, unknown> {
  const contents = req.messages
    .map(messageToGemini)
    .filter((c): c is GeminiContent => c !== null);

  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: req.maxTokens ?? 4096,
  };

  if ((req.thinking?.type ?? "disabled") === "disabled") {
    generationConfig["temperature"] = req.temperature ?? 0.6;
    // Gemini 3.5 replaced `thinkingBudget` with `thinkingLevel`.
    // "minimal" disables sustained reasoning; equivalent to legacy budget=0.
    generationConfig["thinkingConfig"] = { thinkingLevel: "minimal" };
  } else {
    // "medium" is Gemini 3.5's default and, per Google, best-quality for the
    // vast majority of tasks; "high" (hard math/coding) roughly doubles the
    // thinking-token output for marginal gain on our question shape. Kept at
    // medium to control COGS — revisit to "high" if an eval shows a real
    // accuracy drop on hard calc questions.
    generationConfig["thinkingConfig"] = { thinkingLevel: "medium" };
  }

  const body: Record<string, unknown> = {
    contents,
    generationConfig,
  };

  if (req.system) {
    body["system_instruction"] = { parts: [{ text: req.system }] };
  }

  // req.cacheKey is Moonshot-specific; Google handles caching implicitly on the
  // server. Deliberately ignored — sending it would be rejected as unknown.

  return body;
}

function fetchInit(body: Record<string, unknown>, apiKey: string): RequestInit {
  return {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

function modelPath(req: LlmChatRequest): string {
  return `models/${req.model ?? DEFAULT_MODEL}`;
}

async function rejectIfBad(res: Response): Promise<void> {
  if (res.ok) return;
  const text = await res.text();
  let inner: string | undefined;
  try {
    const j = JSON.parse(text) as {
      error?: { message?: string; status?: string } | string;
    };
    inner = typeof j.error === "string" ? j.error : j.error?.message;
  } catch {
    /* not json */
  }
  const err = new Error(inner ?? `Gemini API ${res.status}: ${text.slice(0, 240)}`);
  (err as Error & { status?: number }).status = res.status;
  throw err;
}

function extractTextFromParts(parts?: GeminiPart[]): string {
  if (!parts) return "";
  let out = "";
  for (const p of parts) {
    if ("text" in p && typeof p.text === "string") out += p.text;
  }
  return out;
}

async function chat(apiKey: string, req: LlmChatRequest): Promise<LlmChatResult> {
  const body = buildRequestBody(req);
  const url = `${GEMINI_BASE_URL}/${modelPath(req)}:generateContent`;
  const res = await fetch(url, fetchInit(body, apiKey));
  await rejectIfBad(res);

  const json = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: GeminiPart[] };
      finishReason?: string;
    }>;
    usageMetadata?: GeminiUsageMetadata;
  };
  const cand = json.candidates?.[0];
  return {
    text: extractTextFromParts(cand?.content?.parts),
    finishReason: cand?.finishReason ?? "STOP",
    usage: mapUsage(json.usageMetadata),
  };
}

async function* chatStream(
  apiKey: string,
  req: LlmChatRequest,
): AsyncGenerator<LlmStreamDelta> {
  const body = buildRequestBody(req);
  const url = `${GEMINI_BASE_URL}/${modelPath(req)}:streamGenerateContent?alt=sse`;
  const res = await fetch(url, fetchInit(body, apiKey));
  await rejectIfBad(res);
  if (!res.body) throw new Error("Empty Gemini stream body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let lastUsage: GeminiUsageMetadata | undefined;
  let lastFinish: string | undefined;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line || !line.startsWith("data:")) continue;

      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;

      let evt: GeminiStreamChunk;
      try {
        evt = JSON.parse(payload);
      } catch {
        continue;
      }

      const cand = evt.candidates?.[0];
      const text = extractTextFromParts(cand?.content?.parts);
      if (text) yield { text };
      if (cand?.finishReason) lastFinish = cand.finishReason;
      if (evt.usageMetadata) lastUsage = evt.usageMetadata;
    }
  }

  yield { done: true, finishReason: lastFinish, usage: mapUsage(lastUsage) };
}

/**
 * Returns an OpenAI-shaped `image_url` part. The provider translates this to
 * Gemini's `inline_data` shape internally when building the request body,
 * keeping the `LlmImagePart` type stable across providers.
 */
function imagePart(data: string, mediaType: string): LlmImagePart {
  return {
    type: "image_url",
    image_url: { url: `data:${mediaType};base64,${data}` },
  };
}

export const geminiProvider: LlmProvider = {
  chat,
  chatStream,
  imagePart,
};
