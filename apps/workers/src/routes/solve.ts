import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "../types";

import {
  buildDataContext,
  buildSystemPrompt,
  parseResponse,
} from "@statshelpr/solver-core/core";
import { chatStream, type LlmChatUsage } from "@statshelpr/solver-core/core/providers";
import { costUsdForUsage } from "@/lib/cost";
import { summarizeCsv } from "@/lib/data-summary";
import { validateLicense } from "@/lib/license";
import { activateForInstall } from "@/lib/license-activation";
import { recordServerEventInBackground } from "@/lib/metrics-store";
import { checkAndIncrement, hashBucket } from "@/lib/rate-limit";
import { makeSseStream, sseHeaders } from "@/lib/sse";
import {
  buildQuestionPrompt,
  buildUserContent,
  deriveBlankAnswers,
  deriveSelectedChoices,
  MAX_TOKENS_FIRST,
  resolveModel,
  type DataFile,
  type SolveBody,
} from "@statshelpr/solver-core/solver";

export const solve = new Hono<{ Bindings: Env }>();

solve.use("*", cors({
  origin: "*",
  allowMethods: ["POST", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "X-Install-Id"],
}));

solve.post("/", async (c) => {
  const apiKey = c.env.GEMINI_API_KEY;
  if (!apiKey) return c.json({ error: "GEMINI_API_KEY not configured" }, 500);

  const auth = c.req.header("authorization") ?? "";
  const licenseKey = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  // Persistent per-install id from the extension (chrome.storage.sync, see
  // apps/extension/src/install-id.ts). Falls back to "anon" for older
  // extension builds that don't send it yet.
  const installId = c.req.header("x-install-id") ?? "";
  const lic = await validateLicense(c.env, licenseKey);
  if (!lic.ok) return c.json({ error: lic.reason ?? "Unauthorized" }, 401);

  // Paid licenses are unlimited, but only once activated for *this* install —
  // activation_limit=1 on the LS side means a paid key is bound to a single
  // device (see lib/license-activation.ts). Free tier just hits the daily
  // counter, bucketed per install so the free cap is per-user, not global.
  if (lic.tier === "paid") {
    const activation = await activateForInstall(c.env, licenseKey, installId || "anon");
    if (!activation.ok) {
      return c.json(
        activation.atLimit
          ? { error: "This license is active on another device.", atLimit: true }
          : { error: activation.reason ?? "License activation failed." },
        403,
      );
    }
  } else {
    const rl = await checkAndIncrement(c.env, installId || "anon");
    if (!rl.allowed) {
      return c.json(
        {
          error: `Daily limit reached (${rl.count}/${rl.limit}). Upgrade for unlimited.`,
          resetAt: rl.resetAt,
        },
        402,
      );
    }
  }

  let body: SolveBody;
  try {
    body = (await c.req.json()) as SolveBody;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.questionText && !(body.images && body.images.length > 0)) {
    return c.json({ error: "Provide questionText or images." }, 400);
  }

  const dataFiles: DataFile[] = body.dataFiles ?? [];
  const dataContext = dataFiles.length
    ? buildDataContext(
        dataFiles.map((f) => summarizeCsv(stripExt(f.filename), f.content)),
      )
    : "";

  // Computed once and reused for both the LLM call and metrics recording
  // below, so the event we record always reflects the model actually used.
  const model = resolveModel(body);
  const installHash = await hashBucket(installId || "anon");

  const stream = makeSseStream(async (write) => {
    const startedAt = Date.now(); // wall time around the stream, for serverLatencyMs
    try {
      const hasImage = (body.images?.length ?? 0) > 0;
      const hasBlanks = (body.blanks?.length ?? 0) >= 2;
      const system = buildSystemPrompt({ dataContext, imageMode: hasImage, hasBlanks });
      const questionPrompt = buildQuestionPrompt(body);
      const userContent = buildUserContent(questionPrompt, body.images);

      await write({ type: "phase", label: "Thinking…" });

      let buf = "";
      let mode: "concept" | "calc" | "unknown" = "unknown";
      let userVisibleSent = "";
      let usage: LlmChatUsage | undefined;

      for await (const delta of chatStream(apiKey, {
        model,
        system,
        messages: [{ role: "user", content: userContent }],
        maxTokens: MAX_TOKENS_FIRST,
        thinking: { type: "enabled" },
      })) {
        // Usage arrives on the final chunk, which has no `text` — capture it
        // before the text-only `continue` below would otherwise skip it.
        if (delta.usage) usage = delta.usage;
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
      const usageTokens = {
        promptTokens: usage?.prompt_tokens ?? 0,
        completionTokens: usage?.completion_tokens ?? 0,
        cachedTokens: usage?.cached_tokens ?? 0,
      };
      const costUsd = costUsdForUsage(model, usageTokens);

      if (parsed.mode === "concept") {
        const blanks = deriveBlankAnswers(parsed.body, body.blanks);
        recordServerEventInBackground(c, {
          route: "solve",
          success: true,
          model,
          ...usageTokens,
          costUsd,
          serverLatencyMs: Date.now() - startedAt,
          installHash,
          costMode: "concept",
          completedQuestion: { mode: "concept", confidence: parsed.confidence },
        });
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

      // RCODE path — hand off to client. Client runs WebR then POSTs
      // /api/interpret with { question, images, dataFiles, rCode, stdout }.
      // We include assistantBody so /api/interpret can reconstruct the
      // exact conversation shape. This leg's own cost is attributed to
      // "calc" — the question isn't fully answered until interpret.ts
      // finishes, so modeSplit.calc increments there, not here (see
      // lib/metrics-store.ts's DailyMetricsBucket doc).
      recordServerEventInBackground(c, {
        route: "solve",
        success: true,
        model,
        ...usageTokens,
        costUsd,
        serverLatencyMs: Date.now() - startedAt,
        installHash,
        costMode: "calc",
      });
      const { extractRCode } = await import("@statshelpr/solver-core/core");
      const rCode = extractRCode(parsed.body);
      await write({
        type: "result",
        result: {
          mode: "rcode",
          rCode,
          assistantBody: parsed.body,
        },
      });
    } catch (e) {
      recordServerEventInBackground(c, {
        route: "solve",
        success: false,
        model,
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
        costUsd: 0,
        serverLatencyMs: Date.now() - startedAt,
        installHash,
      });
      await write({ type: "error", message: humanizeError(e) });
    }
  });

  return new Response(stream, {
    status: 200,
    headers: { ...sseHeaders(), "Access-Control-Allow-Origin": "*" },
  });
});

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

function stripExt(name: string) {
  return name.replace(/\.(csv|tsv|txt)$/i, "");
}
