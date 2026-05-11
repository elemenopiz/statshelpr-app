import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import {
  buildDataContext,
  buildSystemPrompt,
  extractRCode,
  parseResponse,
  type SolveImage,
} from "@/lib/core";
import { createAnthropicClient } from "@/lib/core/client";
import { summarizeCsv } from "@/lib/data-summary";
import { runR } from "@/lib/sandbox";
import { validateLicense } from "@/lib/license";
import { makeSseStream, sseHeaders } from "@/lib/sse";

export const runtime = "nodejs";
export const maxDuration = 300;

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 14_000;
const THINKING_BUDGET = 10_000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

interface DataFile {
  filename: string;
  content: string;
}

interface SolveBody {
  questionText?: string;
  images?: SolveImage[];
  dataFiles?: DataFile[];
  stream?: boolean;
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(req: NextRequest) {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    return jsonError("ANTHROPIC_API_KEY not configured", 500);
  }

  // License gate
  const auth = req.headers.get("authorization") ?? "";
  const licenseKey = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const lic = await validateLicense(licenseKey);
  if (!lic.ok) {
    return jsonError(lic.reason ?? "Unauthorized", 401);
  }

  let body: SolveBody;
  try {
    body = (await req.json()) as SolveBody;
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  if (!body.questionText && !(body.images && body.images.length > 0)) {
    return jsonError("Provide questionText or images.", 400);
  }

  const dataFiles = body.dataFiles ?? [];
  const dataContext = dataFiles.length
    ? buildDataContext(
        dataFiles.map((f) => summarizeCsv(stripExt(f.filename), f.content)),
      )
    : "";

  if (body.stream) {
    const stream = makeSseStream(async (write) => {
      await solveStreaming({
        write,
        apiKey,
        body,
        dataContext,
        dataFiles,
      });
    });
    return new Response(stream, { status: 200, headers: { ...CORS_HEADERS, ...sseHeaders() } });
  }

  // Non-streaming JSON path (used by the extension and curl)
  try {
    const result = await solveNonStreaming({ apiKey, body, dataContext, dataFiles });
    return NextResponse.json(result, { status: 200, headers: CORS_HEADERS });
  } catch (e) {
    return jsonError(humanizeError(e), anthropicStatus(e) ?? 500);
  }
}

function anthropicStatus(e: unknown): number | undefined {
  const obj = e as { status?: number };
  return typeof obj?.status === "number" ? obj.status : undefined;
}

function humanizeError(e: unknown): string {
  const obj = e as {
    status?: number;
    error?: { error?: { message?: string }; message?: string };
    message?: string;
  };
  const inner =
    obj?.error?.error?.message ??
    obj?.error?.message ??
    obj?.message ??
    "Unknown error";
  // Surface the most common ones with clearer language for the extension UI
  if (/credit balance is too low/i.test(inner)) {
    return "Anthropic account out of credits — top up at console.anthropic.com/settings/billing.";
  }
  if (obj?.status === 401) return "Anthropic API key invalid or revoked.";
  if (obj?.status === 429) return "Rate limited by Anthropic — wait a moment and retry.";
  if (obj?.status === 529) return "Anthropic overloaded — retry in a moment.";
  return inner;
}

interface StreamArgs {
  write: (evt: import("@/lib/sse").SseEvent) => Promise<void>;
  apiKey: string;
  body: SolveBody;
  dataContext: string;
  dataFiles: DataFile[];
}

async function solveStreaming({ write, apiKey, body, dataContext, dataFiles }: StreamArgs) {
  const client = createAnthropicClient(apiKey);
  const hasImage = (body.images?.length ?? 0) > 0;
  const system = buildSystemPrompt({ dataContext, imageMode: hasImage });
  const userContent = buildUserContent(body.questionText, body.images);

  await write({ type: "phase", label: "Thinking…" });

  // First pass — stream classification + answer (or R code).
  // We buffer the routing tag + one line so we can decide whether to keep streaming
  // text deltas to the client (concept path) or hide them (calc path → run R first).
  let buf = "";
  let mode: "concept" | "calc" | "unknown" = "unknown";
  let userVisibleSent = "";

  const stream = await client.messages.stream({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    temperature: 1.0,
    system,
    thinking: { type: "enabled", budget_tokens: THINKING_BUDGET },
    messages: [{ role: "user", content: userContent }],
  });

  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      buf += event.delta.text;

      if (mode === "unknown") {
        // Need first non-empty line to detect routing tag.
        const firstLineMatch = buf.match(/^\s*([^\n]+)/);
        if (firstLineMatch && firstLineMatch[1]) {
          const first = firstLineMatch[1].trim().toUpperCase();
          if (first === "[CONCEPT]" || first === "CONCEPT") mode = "concept";
          else if (
            first === "[RCODE]" ||
            first === "RCODE" ||
            first === "[CALC]" ||
            first === "CALC"
          )
            mode = "calc";
          // If line ended without matching tag, fall back to concept on stream end.
          if (mode === "unknown" && buf.includes("\n")) mode = "concept";
        }
      }

      if (mode === "concept") {
        // Stream cleaned text to user (strip tag, strip CONFIDENCE line for now)
        const cleaned = buf.replace(/^\s*\[(CONCEPT|RCODE|CALC)\]\s*\n?/i, "");
        const display = cleaned.replace(/\n?CONFIDENCE:\s*\w+\s*$/i, "");
        const newSlice = display.slice(userVisibleSent.length);
        if (newSlice) {
          userVisibleSent = display;
          await write({ type: "delta", text: newSlice });
        }
      }
      // calc: don't stream — student doesn't need to watch R code being typed
    }
  }

  await stream.finalMessage();
  const parsed = parseResponse(buf);

  if (parsed.mode === "concept") {
    await write({
      type: "result",
      result: {
        mode: "concept",
        answer: parsed.body,
        confidence: parsed.confidence,
        lowConfidence: parsed.lowConfidence,
      },
    });
    return;
  }

  // Calc path — run R, then stream interpretation
  const rCode = extractRCode(parsed.body);
  await write({ type: "phase", label: "Running R…" });

  let runResult;
  try {
    runResult = await runR(
      rCode,
      dataFiles.map((f) => ({ filename: f.filename, content: f.content })),
    );
  } catch (e) {
    await write({
      type: "error",
      message: `R execution failed: ${(e as Error).message}`,
    });
    return;
  }

  await write({ type: "phase", label: "Interpreting result…" });

  // Second pass — stream the final answer
  const followup = `The R code below was executed. Use the output to choose the correct answer to the question.

R CODE:
\`\`\`r
${rCode}
\`\`\`

R OUTPUT:
\`\`\`
${runResult.stdout.slice(0, 6000)}
\`\`\`

Now respond with the routing tag [CONCEPT] followed by:
Answer: <best answer>
CONFIDENCE: <High/Med/Low>`;

  const followupContent = buildUserContent(
    `${body.questionText ?? "(see image)"}\n\n${followup}`,
    body.images,
  );

  let fbuf = "";
  let fSent = "";
  const stream2 = await client.messages.stream({
    model: MODEL,
    max_tokens: 4_000,
    temperature: 0.5,
    system: buildSystemPrompt({ dataContext, imageMode: (body.images?.length ?? 0) > 0 }),
    messages: [{ role: "user", content: followupContent }],
  });

  for await (const event of stream2) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      fbuf += event.delta.text;
      const cleaned = fbuf.replace(/^\s*\[(CONCEPT|RCODE|CALC)\]\s*\n?/i, "");
      const display = cleaned.replace(/\n?CONFIDENCE:\s*\w+\s*$/i, "");
      const newSlice = display.slice(fSent.length);
      if (newSlice) {
        fSent = display;
        await write({ type: "delta", text: newSlice });
      }
    }
  }

  await stream2.finalMessage();
  const finalParsed = parseResponse(fbuf);

  await write({
    type: "result",
    result: {
      mode: "calc",
      rCode,
      rOutput: runResult.stdout,
      rExitCode: runResult.exitCode,
      rDurationMs: runResult.durationMs,
      answer: finalParsed.body,
      confidence: finalParsed.confidence,
      lowConfidence: finalParsed.lowConfidence,
    },
  });
}

interface NonStreamArgs {
  apiKey: string;
  body: SolveBody;
  dataContext: string;
  dataFiles: DataFile[];
}

async function solveNonStreaming({
  apiKey,
  body,
  dataContext,
  dataFiles,
}: NonStreamArgs) {
  const client = createAnthropicClient(apiKey);
  const hasImage = (body.images?.length ?? 0) > 0;
  const userContent = buildUserContent(body.questionText, body.images);

  const first = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    temperature: 1.0,
    system: buildSystemPrompt({ dataContext, imageMode: hasImage }),
    thinking: { type: "enabled", budget_tokens: THINKING_BUDGET },
    messages: [{ role: "user", content: userContent }],
  });

  const firstText = first.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const parsed = parseResponse(firstText);

  if (parsed.mode === "concept") {
    return {
      mode: "concept",
      answer: parsed.body,
      confidence: parsed.confidence,
      lowConfidence: parsed.lowConfidence,
    };
  }

  const rCode = extractRCode(parsed.body);
  const runResult = await runR(
    rCode,
    dataFiles.map((f) => ({ filename: f.filename, content: f.content })),
  );

  const followup = `The R code below was executed. Use the output to choose the correct answer.

R CODE:
\`\`\`r
${rCode}
\`\`\`

R OUTPUT:
\`\`\`
${runResult.stdout.slice(0, 6000)}
\`\`\`

Respond with [CONCEPT] then Answer: ... and CONFIDENCE: ...`;

  const followupContent = buildUserContent(
    `${body.questionText ?? "(see image)"}\n\n${followup}`,
    body.images,
  );

  const second = await client.messages.create({
    model: MODEL,
    max_tokens: 4_000,
    temperature: 0.5,
    system: buildSystemPrompt({ dataContext, imageMode: hasImage }),
    messages: [{ role: "user", content: followupContent }],
  });
  const secondText = second.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const finalParsed = parseResponse(secondText);

  return {
    mode: "calc",
    rCode,
    rOutput: runResult.stdout,
    rExitCode: runResult.exitCode,
    rDurationMs: runResult.durationMs,
    answer: finalParsed.body,
    confidence: finalParsed.confidence,
    lowConfidence: finalParsed.lowConfidence,
  };
}

function buildUserContent(
  text: string | undefined,
  images: SolveImage[] | undefined,
): Anthropic.ContentBlockParam[] {
  const out: Anthropic.ContentBlockParam[] = [];
  for (const img of images ?? []) {
    out.push({
      type: "image",
      source: { type: "base64", media_type: img.mediaType, data: img.data },
    });
  }
  const t = text?.trim();
  if (t) out.push({ type: "text", text: t });
  return out;
}

function jsonError(msg: string, status: number) {
  return NextResponse.json({ error: msg }, { status, headers: CORS_HEADERS });
}

function stripExt(name: string) {
  return name.replace(/\.(csv|tsv|txt)$/i, "");
}
