import { fetchWithRetry, type RetryEvent } from "./retry";
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
 * OpenAI GPT-5.6 Luna — THE solver provider (Responses API). Every solve
 * call routes here (core/providers/index.ts); gemini.ts remains on disk for
 * reference only and is imported by nothing. NOTE: still stub-grade — the
 * request/response shapes follow the docs but have not been exercised
 * against the live API yet.
 *
 * Uses `POST /v1/responses` on `api.openai.com`. Supports:
 *   - non-streaming requests
 *   - SSE streaming (`stream: true`, yields text deltas)
 *   - system prompt via `instructions`
 *   - reasoning via `reasoning.effort` (reasoning tokens are billed at the
 *     OUTPUT rate and arrive inside `usage.output_tokens`, see mapUsage)
 *   - implicit prompt caching (server-side — no client action needed;
 *     discounted tokens surface as `input_tokens_details.cached_tokens`)
 *   - native vision: Luna reads images in the SAME model — there is no
 *     separate image/vision model anywhere in the solve path (see
 *     solver/settings.ts resolveModel)
 *
 * Auth: bearer token on the `Authorization` header.
 *
 * Docs:
 *   https://platform.openai.com/docs/api-reference/responses
 */

export const OPENAI_BASE_URL = "https://api.openai.com/v1";

// `process.env` only exists under Node/Next; Workers routes read secrets
// from Hono's `c.env` binding instead (see apps/workers/src/types.ts), and
// this package is imported by both runtimes — so reach through `globalThis`
// with a local cast rather than referencing `process` directly. Type-checks
// and runs safely with or without an ambient `process` (no `@types/node`
// dependency needed here), falling back to the hardcoded default when absent.
const env: Record<string, string | undefined> =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env ?? {};

// Overridable via OPENAI_MODEL so the eval harness can A/B model versions
// without code edits. This is the ONLY solver model — text and vision alike.
export const LUNA_MODEL = env["OPENAI_MODEL"] ?? "gpt-5.6-luna";

// Responses API content parts: user-side text/images are "input_*", assistant
// turns echo back as "output_text".
interface OpenAiInputTextPart {
  type: "input_text";
  text: string;
}

interface OpenAiOutputTextPart {
  type: "output_text";
  text: string;
}

interface OpenAiInputImagePart {
  type: "input_image";
  image_url: string;
}

type OpenAiContentPart =
  | OpenAiInputTextPart
  | OpenAiOutputTextPart
  | OpenAiInputImagePart;

interface OpenAiInputItem {
  role: "user" | "assistant";
  content: OpenAiContentPart[];
}

interface OpenAiUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

interface OpenAiOutputMessageItem {
  type: string; // "message" | "reasoning" | ...
  content?: Array<{ type: string; text?: string }>;
}

interface OpenAiResponse {
  status?: string; // "completed" | "incomplete" | "failed" | ...
  incomplete_details?: { reason?: string };
  output?: OpenAiOutputMessageItem[];
  usage?: OpenAiUsage;
}

// Streaming event envelope — discriminated by `type` in the SSE `data:` JSON.
interface OpenAiStreamEvent {
  type: string;
  delta?: string; // present on response.output_text.delta
  response?: OpenAiResponse; // present on response.completed/incomplete/failed
}

function partToOpenAi(part: LlmContentPart, assistant: boolean): OpenAiContentPart {
  if (part.type === "text") {
    return assistant
      ? { type: "output_text", text: part.text }
      : { type: "input_text", text: part.text };
  }
  // LlmImagePart already carries an OpenAI-shaped data URL; the Responses API
  // takes it as a plain string on `image_url`.
  return { type: "input_image", image_url: part.image_url.url };
}

function messageToOpenAi(msg: LlmChatMessage): OpenAiInputItem | null {
  if (msg.role === "system") return null; // handled via `instructions`
  const assistant = msg.role === "assistant";
  const parts: OpenAiContentPart[] =
    typeof msg.content === "string"
      ? [assistant ? { type: "output_text", text: msg.content } : { type: "input_text", text: msg.content }]
      : msg.content.map((p) => partToOpenAi(p, assistant));
  return { role: assistant ? "assistant" : "user", content: parts };
}

/**
 * `output_tokens` already INCLUDES reasoning tokens (OpenAI bills reasoning at
 * the output rate), and `input_tokens` is inclusive of `cached_tokens` — the
 * exact same semantics cost.ts already assumes for Gemini's promptTokenCount /
 * cachedContentTokenCount, so its cached-subtraction math needs no change.
 */
function mapUsage(u?: OpenAiUsage): LlmChatUsage | undefined {
  if (!u) return undefined;
  return {
    prompt_tokens: u.input_tokens,
    completion_tokens: u.output_tokens,
    total_tokens: u.total_tokens,
    cached_tokens: u.input_tokens_details?.cached_tokens,
  };
}

function buildRequestBody(req: LlmChatRequest): Record<string, unknown> {
  const input = req.messages
    .map(messageToOpenAi)
    .filter((m): m is OpenAiInputItem => m !== null);

  const body: Record<string, unknown> = {
    model: req.model ?? LUNA_MODEL,
    input,
    max_output_tokens: req.maxTokens ?? 4096,
    // Don't persist responses server-side; we never fetch them back by id.
    store: false,
  };

  // GPT-5-family reasoning models reject `temperature`, so unlike the Gemini
  // path (which sends it when thinking is disabled) req.temperature is
  // deliberately never forwarded.
  if ((req.thinking?.type ?? "disabled") === "disabled") {
    // "minimal" is the effort floor — the Responses-API analogue of Gemini's
    // thinkingLevel "minimal" / legacy budget=0.
    body["reasoning"] = { effort: "minimal" };
  } else {
    // "medium" mirrors the Gemini first-pass choice: best quality-per-token
    // for our question shape; "high" roughly doubles reasoning output for
    // marginal gain. Kept at medium to control COGS.
    body["reasoning"] = { effort: "medium" };
  }

  if (req.system) {
    body["instructions"] = req.system;
  }

  // req.cacheKey is Moonshot-specific; OpenAI prompt caching is implicit on
  // the server. Deliberately ignored — same stance as gemini.ts.

  return body;
}

function fetchInit(body: Record<string, unknown>, apiKey: string): RequestInit {
  return {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

/** Same shape-adapter as gemini.ts's retryOptsFor — forwards the two
 *  observational LlmRetryHooks callbacks into fetchWithRetry's options. */
function retryOptsFor(req: LlmChatRequest) {
  const hooks = req.retry;
  if (!hooks) return undefined;
  return {
    onRetry: hooks.onRetry
      ? (e: RetryEvent) => hooks.onRetry?.({ attempt: e.attempt, delayMs: e.delayMs, status: e.status })
      : undefined,
    onWaiting: hooks.onWaiting,
  };
}

async function rejectIfBad(res: Response): Promise<void> {
  if (res.ok) return;
  const text = await res.text();
  let inner: string | undefined;
  try {
    const j = JSON.parse(text) as {
      error?: { message?: string; type?: string } | string;
    };
    inner = typeof j.error === "string" ? j.error : j.error?.message;
  } catch {
    /* not json */
  }
  const err = new Error(inner ?? `OpenAI API ${res.status}: ${text.slice(0, 240)}`);
  (err as Error & { status?: number }).status = res.status;
  throw err;
}

function extractText(output?: OpenAiOutputMessageItem[]): string {
  if (!output) return "";
  let out = "";
  for (const item of output) {
    // `reasoning` items carry no user-facing text; only `message` items do.
    if (item.type !== "message" || !item.content) continue;
    for (const part of item.content) {
      if (part.type === "output_text" && typeof part.text === "string") {
        out += part.text;
      }
    }
  }
  return out;
}

/** Stub-level finish-reason mapping — callers only distinguish STOP vs not,
 *  so a completed response maps to Gemini-style "STOP" and anything else
 *  surfaces the incomplete/failed reason verbatim. */
function finishReasonOf(resp: OpenAiResponse): string {
  if (resp.status === "completed") return "STOP";
  return resp.incomplete_details?.reason ?? resp.status ?? "STOP";
}

async function chat(apiKey: string, req: LlmChatRequest): Promise<LlmChatResult> {
  const body = buildRequestBody(req);
  const url = `${OPENAI_BASE_URL}/responses`;
  // fetchWithRetry transparently absorbs 429/5xx/network errors with backoff
  // (see retry.ts) — same non-streaming eligibility note as gemini.ts.
  const res = await fetchWithRetry(url, fetchInit(body, apiKey), retryOptsFor(req));
  await rejectIfBad(res);

  const json = (await res.json()) as OpenAiResponse;
  return {
    text: extractText(json.output),
    finishReason: finishReasonOf(json),
    usage: mapUsage(json.usage),
  };
}

async function* chatStream(
  apiKey: string,
  req: LlmChatRequest,
): AsyncGenerator<LlmStreamDelta> {
  const body = buildRequestBody(req);
  body["stream"] = true;
  const url = `${OPENAI_BASE_URL}/responses`;
  // Retry covers ONLY the initial connection/status, exactly as in gemini.ts:
  // once the reader below has yielded a delta we're committed to this stream,
  // and a mid-stream drop surfaces as a thrown error rather than a retry
  // (which would risk duplicate output).
  const res = await fetchWithRetry(url, fetchInit(body, apiKey), retryOptsFor(req));
  await rejectIfBad(res);
  if (!res.body) throw new Error("Empty OpenAI stream body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let lastUsage: OpenAiUsage | undefined;
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

      let evt: OpenAiStreamEvent;
      try {
        evt = JSON.parse(payload);
      } catch {
        continue;
      }

      if (evt.type === "response.output_text.delta") {
        if (evt.delta) yield { text: evt.delta };
      } else if (
        evt.type === "response.completed" ||
        evt.type === "response.incomplete" ||
        evt.type === "response.failed"
      ) {
        if (evt.response) {
          lastFinish = finishReasonOf(evt.response);
          if (evt.response.usage) lastUsage = evt.response.usage;
        }
      }
      // All other event types (created, in_progress, item deltas for
      // reasoning, etc.) are deliberately ignored — text deltas and the
      // terminal event carry everything the solver consumes.
    }
  }

  yield { done: true, finishReason: lastFinish, usage: mapUsage(lastUsage) };
}

/**
 * Returns an OpenAI-shaped `image_url` part — identical to gemini.ts's
 * imagePart, since `LlmImagePart` IS the OpenAI shape; this provider passes
 * the data URL through to `input_image` untranslated.
 */
function imagePart(data: string, mediaType: string): LlmImagePart {
  return {
    type: "image_url",
    image_url: { url: `data:${mediaType};base64,${data}` },
  };
}

export const openaiProvider: LlmProvider = {
  chat,
  chatStream,
  imagePart,
};
