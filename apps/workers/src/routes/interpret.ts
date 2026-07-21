import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "../types";

import { buildDataContext, buildSystemPrompt, parseResponse } from "@statshelpr/solver-core/core";
import { chatStream } from "@statshelpr/solver-core/core/providers";
import { summarizeCsv } from "@/lib/data-summary";
import { validateLicense } from "@/lib/license";
import { makeSseStream, sseHeaders } from "@/lib/sse";
import {
  buildFollowupContent,
  buildQuestionPrompt,
  buildUserContent,
  deriveBlankAnswers,
  deriveSelectedChoices,
  MAX_TOKENS_SECOND,
  resolveModel,
  type DataFile,
  type SolveBody,
} from "@statshelpr/solver-core/solver";

/**
 * Called by the extension after WebR runs R code locally. Takes the R stdout
 * plus the original question context and asks the LLM to interpret + emit a
 * final answer.
 *
 * No rate-limit increment here — /api/solve already counted this solve.
 */
interface InterpretBody extends SolveBody {
  rCode: string;
  stdout: string;
  exitCode?: number;
  durationMs?: number;
  /** Assistant message body from /api/solve (contains the R code + PLAN comment). */
  assistantBody: string;
}

export const interpret = new Hono<{ Bindings: Env }>();

interpret.use("*", cors({
  origin: "*",
  allowMethods: ["POST", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "X-Install-Id"],
}));

interpret.post("/", async (c) => {
  const apiKey = c.env.GEMINI_API_KEY;
  if (!apiKey) return c.json({ error: "GEMINI_API_KEY not configured" }, 500);

  const auth = c.req.header("authorization") ?? "";
  const licenseKey = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const lic = await validateLicense(c.env, licenseKey);
  if (!lic.ok) return c.json({ error: lic.reason ?? "Unauthorized" }, 401);

  let body: InterpretBody;
  try {
    body = (await c.req.json()) as InterpretBody;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.rCode || body.stdout === undefined) {
    return c.json({ error: "Provide rCode and stdout." }, 400);
  }

  const dataFiles: DataFile[] = body.dataFiles ?? [];
  const dataContext = dataFiles.length
    ? buildDataContext(
        dataFiles.map((f) => summarizeCsv(stripExt(f.filename), f.content)),
      )
    : "";

  const stream = makeSseStream(async (write) => {
    try {
      const hasImage = (body.images?.length ?? 0) > 0;
      const system = buildSystemPrompt({ dataContext, imageMode: hasImage });
      const questionPrompt = buildQuestionPrompt(body);
      const userContent = buildUserContent(questionPrompt, body.images);

      await write({ type: "phase", label: "Interpreting result…" });

      let fbuf = "";
      let fSent = "";
      for await (const delta of chatStream(apiKey, {
        model: resolveModel(body),
        system,
        messages: [
          { role: "user", content: userContent },
          { role: "assistant", content: body.assistantBody },
          {
            role: "user",
            content: buildFollowupContent(body, body.rCode, body.stdout),
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
          rCode: body.rCode,
          rOutput: body.stdout,
          rExitCode: body.exitCode ?? 0,
          rDurationMs: body.durationMs ?? 0,
          answer: finalParsed.body,
          selectedChoices: deriveSelectedChoices(finalParsed.body, body.choices),
          ...(finalBlanks.length ? { blanks: finalBlanks } : {}),
          confidence: finalParsed.confidence,
          lowConfidence: finalParsed.lowConfidence,
        },
      });
    } catch (e) {
      const msg = (e as Error).message ?? "Interpret failed";
      await write({ type: "error", message: msg });
    }
  });

  return new Response(stream, {
    status: 200,
    headers: { ...sseHeaders(), "Access-Control-Allow-Origin": "*" },
  });
});

function stripExt(name: string) {
  return name.replace(/\.(csv|tsv|txt)$/i, "");
}
