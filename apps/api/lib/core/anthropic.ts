import Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt } from "./system-prompt";
import { parseResponse, type ParsedResponse } from "./parse-response";

export const DEFAULT_MODEL = "claude-sonnet-4-6";
export const DEFAULT_MAX_TOKENS = 14_000;
export const DEFAULT_THINKING_BUDGET = 10_000;

export interface SolveImage {
  data: string; // base64 (no data URL prefix)
  mediaType: "image/png" | "image/jpeg" | "image/webp";
}

export interface SolveInput {
  questionText?: string;
  images?: SolveImage[];
  dataContext?: string;
  apiKey: string;
  model?: string;
}

export async function solveQuestion(input: SolveInput): Promise<ParsedResponse> {
  const client = new Anthropic({ apiKey: input.apiKey });

  const hasImage = (input.images?.length ?? 0) > 0;
  const system = buildSystemPrompt({
    dataContext: input.dataContext,
    imageMode: hasImage,
  });

  const userContent: Anthropic.ContentBlockParam[] = [];
  for (const img of input.images ?? []) {
    userContent.push({
      type: "image",
      source: {
        type: "base64",
        media_type: img.mediaType,
        data: img.data,
      },
    });
  }
  const text =
    (input.questionText?.trim() ||
      (hasImage ? "Read the image and answer according to the routing/tag rules." : ""));
  if (text) userContent.push({ type: "text", text });

  const response = await callWithRetry(() =>
    client.messages.create({
      model: input.model ?? DEFAULT_MODEL,
      max_tokens: DEFAULT_MAX_TOKENS,
      temperature: 1.0,
      system,
      thinking: { type: "enabled", budget_tokens: DEFAULT_THINKING_BUDGET },
      messages: [{ role: "user", content: userContent }],
    }),
  );

  const rawText = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  if (!rawText) throw new Error("Empty response from model.");
  return parseResponse(rawText);
}

async function callWithRetry<T>(fn: () => Promise<T>, maxTries = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < maxTries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const status = (e as { status?: number })?.status;
      const transient = status === 429 || status === 500 || status === 502 || status === 503 || status === 529;
      if (!transient || i === maxTries - 1) throw e;
      await new Promise((r) => setTimeout(r, 600 * (i + 1)));
    }
  }
  throw lastErr;
}
