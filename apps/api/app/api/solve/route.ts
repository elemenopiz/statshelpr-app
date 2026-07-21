import { NextRequest, NextResponse } from "next/server";
import {
  buildDataContext,
  buildSystemPrompt,
  extractRCode,
  parseResponse,
} from "@statshelpr/solver-core/core";
import { chatStream } from "@statshelpr/solver-core/core/providers";
import { resolveApiKey } from "@/lib/resolve-api-key";
import { summarizeCsv } from "@/lib/data-summary";
import { runR } from "@/lib/sandbox";
import { validateLicense } from "@/lib/license";
import { makeSseStream, sseHeaders } from "@/lib/sse";
import {
  buildFollowupContent,
  buildQuestionPrompt,
  buildUserContent,
  deriveBlankAnswers,
  deriveSelectedChoices,
  MAX_TOKENS_FIRST,
  MAX_TOKENS_SECOND,
  resolveModel,
  type DataFile,
  type SolveBody,
} from "@statshelpr/solver-core/solver";
import { repairRCode } from "@/lib/solver/r-repair";
import { solveNonStreaming } from "@/lib/solver/non-streaming";

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
  const { apiKey, envName } = resolveApiKey();
  if (!apiKey) {
    return jsonError(`${envName} not configured`, 500);
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
    return jsonError(humanizeError(e), providerHttpStatus(e) ?? 500);
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
    const hasBlanks = (body.blanks?.length ?? 0) >= 2;
    const model = resolveModel(body); // image → 3.6 Flash, else Flash-Lite
    const system = buildSystemPrompt({ dataContext, imageMode: hasImage, hasBlanks });
    const questionPrompt = buildQuestionPrompt(body);
    const userContent = buildUserContent(questionPrompt, body.images);

    await write({ type: "phase", label: "Thinking…" });

    let buf = "";
    let mode: "concept" | "calc" | "unknown" = "unknown";
    let userVisibleSent = "";

    for await (const delta of chatStream(apiKey, {
      model,
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
      const blanks = deriveBlankAnswers(parsed.body, body.blanks);
      await write({
        type: "result",
        result: {
          mode: "concept",
          answer: parsed.body,
          selectedChoices: deriveSelectedChoices(parsed.body, body.choices),
          ...(blanks.length ? { blanks } : {}),
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
      model,
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
    const finalBlanks = deriveBlankAnswers(finalParsed.body, body.blanks);
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
        ...(finalBlanks.length ? { blanks: finalBlanks } : {}),
        confidence: finalParsed.confidence,
        lowConfidence: finalParsed.lowConfidence,
      },
    });
  } catch (e) {
    await write({ type: "error", message: humanizeError(e) });
  }
}

function providerHttpStatus(e: unknown): number | undefined {
  const obj = e as { status?: number };
  return typeof obj?.status === "number" ? obj.status : undefined;
}

function humanizeError(e: unknown): string {
  const obj = e as { status?: number; message?: string };
  const msg = obj?.message ?? "Unknown error";
  if (/credit balance|insufficient|quota|resource exhausted/i.test(msg))
    return "Gemini quota exhausted — check billing at aistudio.google.com.";
  if (obj?.status === 401 || obj?.status === 403)
    return "Gemini API key invalid, revoked, or missing permissions.";
  if (obj?.status === 429)
    return "Rate limited by Gemini — wait a moment and retry.";
  return msg;
}

function jsonError(msg: string, status: number) {
  return NextResponse.json({ error: msg }, { status, headers: CORS_HEADERS });
}

function stripExt(name: string) {
  return name.replace(/\.(csv|tsv|txt)$/i, "");
}
