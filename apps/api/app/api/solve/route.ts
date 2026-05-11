import { NextRequest, NextResponse } from "next/server";
import {
  buildDataContext,
  buildSystemPrompt,
  extractRCode,
  parseResponse,
} from "@/lib/core";
import { chatStream } from "@/lib/core/providers";
import { summarizeCsv } from "@/lib/data-summary";
import { runR } from "@/lib/sandbox";
import { validateLicense } from "@/lib/license";
import { makeSseStream, sseHeaders } from "@/lib/sse";
import {
  buildFollowupContent,
  buildQuestionPrompt,
  buildUserContent,
  deriveSelectedChoices,
  MAX_TOKENS_FIRST,
  MAX_TOKENS_SECOND,
  MODEL,
  repairRCode,
  solveNonStreaming,
  type DataFile,
  type SolveBody,
} from "@/lib/solver";

export const runtime = "nodejs";
export const maxDuration = 300;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(req: NextRequest) {
  // Allow either MOONSHOT_API_KEY (preferred) or KIMI_API_KEY as alias.
  const apiKey =
    process.env["MOONSHOT_API_KEY"] || process.env["KIMI_API_KEY"];
  if (!apiKey) {
    return jsonError("MOONSHOT_API_KEY not configured", 500);
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
      await solveStreaming({ write, apiKey, body, dataContext, dataFiles });
    });
    return new Response(stream, {
      status: 200,
      headers: { ...CORS_HEADERS, ...sseHeaders() },
    });
  }

  try {
    const result = await solveNonStreaming({
      apiKey,
      body,
      dataContext,
      dataFiles,
    });
    return NextResponse.json(result, { status: 200, headers: CORS_HEADERS });
  } catch (e) {
    return jsonError(humanizeError(e), kimiStatus(e) ?? 500);
  }
}

// =============================================================================
// streaming path (Server-Sent Events)
// =============================================================================

interface StreamArgs {
  write: (evt: import("@/lib/sse").SseEvent) => Promise<void>;
  apiKey: string;
  body: SolveBody;
  dataContext: string;
  dataFiles: DataFile[];
}

async function solveStreaming({
  write,
  apiKey,
  body,
  dataContext,
  dataFiles,
}: StreamArgs) {
  try {
    const hasImage = (body.images?.length ?? 0) > 0;
    const system = buildSystemPrompt({ dataContext, imageMode: hasImage });
    const questionPrompt = buildQuestionPrompt(body);
    const userContent = buildUserContent(questionPrompt, body.images);

    await write({ type: "phase", label: "Thinking…" });

    let buf = "";
    let mode: "concept" | "calc" | "unknown" = "unknown";
    let userVisibleSent = "";

    for await (const delta of chatStream(apiKey, {
      model: MODEL,
      system,
      messages: [{ role: "user", content: userContent }],
      maxTokens: MAX_TOKENS_FIRST,
      thinking: { type: "enabled" },
    })) {
      if (!delta.text) continue;
      buf += delta.text;

      if (mode === "unknown") {
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
          if (mode === "unknown" && buf.includes("\n")) mode = "concept";
        }
      }

      if (mode === "concept") {
        const cleaned = buf.replace(/^\s*\[(CONCEPT|RCODE|CALC)\]\s*\n?/i, "");
        const display = cleaned.replace(/\n?CONFIDENCE:\s*\w+\s*$/i, "");
        const newSlice = display.slice(userVisibleSent.length);
        if (newSlice) {
          userVisibleSent = display;
          await write({ type: "delta", text: newSlice });
        }
      }
    }

    const parsed = parseResponse(buf);

    if (parsed.mode === "concept") {
      await write({
        type: "result",
        result: {
          mode: "concept",
          answer: parsed.body,
          selectedChoices: deriveSelectedChoices(parsed.body, body.choices),
          confidence: parsed.confidence,
          lowConfidence: parsed.lowConfidence,
        },
      });
      return;
    }

    // Calc path
    const rCode = extractRCode(parsed.body);
    let finalRCode = rCode;
    await write({ type: "phase", label: "Running R…" });

    let runResult;
    try {
      runResult = await runR(
        finalRCode,
        dataFiles.map((f) => ({ filename: f.filename, content: f.content })),
      );
      if (runResult.exitCode !== 0) {
        await write({ type: "phase", label: "Repairing R…" });
        const repaired = await repairRCode(
          apiKey,
          system,
          buildQuestionPrompt(body),
          finalRCode,
          runResult,
        );
        if (repaired) {
          finalRCode = repaired;
          runResult = await runR(
            finalRCode,
            dataFiles.map((f) => ({
              filename: f.filename,
              content: f.content,
            })),
          );
        }
      }
    } catch (e) {
      await write({
        type: "error",
        message: `R execution failed: ${(e as Error).message}`,
      });
      return;
    }

    await write({ type: "phase", label: "Interpreting result…" });

    let fbuf = "";
    let fSent = "";
    for await (const delta of chatStream(apiKey, {
      model: MODEL,
      system,
      messages: [
        { role: "user", content: userContent },
        { role: "assistant", content: parsed.body },
        {
          role: "user",
          content: buildFollowupContent(body, finalRCode, runResult.stdout),
        },
      ],
      temperature: 0.6,
      maxTokens: MAX_TOKENS_SECOND,
      thinking: { type: "disabled" },
    })) {
      if (!delta.text) continue;
      fbuf += delta.text;
      const cleaned = fbuf.replace(/^\s*\[(CONCEPT|RCODE|CALC)\]\s*\n?/i, "");
      const display = cleaned.replace(/\n?CONFIDENCE:\s*\w+\s*$/i, "");
      const newSlice = display.slice(fSent.length);
      if (newSlice) {
        fSent = display;
        await write({ type: "delta", text: newSlice });
      }
    }

    const finalParsed = parseResponse(fbuf);
    await write({
      type: "result",
      result: {
        mode: "calc",
        rCode: finalRCode,
        rOutput: runResult.stdout,
        rExitCode: runResult.exitCode,
        rDurationMs: runResult.durationMs,
        answer: finalParsed.body,
        selectedChoices: deriveSelectedChoices(finalParsed.body, body.choices),
        confidence: finalParsed.confidence,
        lowConfidence: finalParsed.lowConfidence,
      },
    });
  } catch (e) {
    await write({ type: "error", message: humanizeError(e) });
  }
}

function kimiStatus(e: unknown): number | undefined {
  const obj = e as { status?: number };
  return typeof obj?.status === "number" ? obj.status : undefined;
}

function humanizeError(e: unknown): string {
  const obj = e as { status?: number; message?: string };
  const msg = obj?.message ?? "Unknown error";
  if (/credit balance|insufficient|quota/i.test(msg))
    return "Moonshot account out of credits — top up at platform.moonshot.ai.";
  if (obj?.status === 401) return "Moonshot API key invalid or revoked.";
  if (obj?.status === 429) return "Rate limited by Moonshot — wait a moment and retry.";
  return msg;
}

function jsonError(msg: string, status: number) {
  return NextResponse.json({ error: msg }, { status, headers: CORS_HEADERS });
}

function stripExt(name: string) {
  return name.replace(/\.(csv|tsv|txt)$/i, "");
}
