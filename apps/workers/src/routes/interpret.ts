import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "../types";

import { buildDataContext, buildSystemPrompt, parseResponse } from "@statshelpr/solver-core/core";
import { chatStream, type LlmChatUsage } from "@statshelpr/solver-core/core/providers";
import { classifyError } from "@/lib/classify-error";
import { costUsdForUsage } from "@/lib/cost";
import { summarizeCsv } from "@/lib/data-summary";
import { verifyInterpretToken } from "@/lib/interpret-token";
import { KILL_SWITCH_MESSAGE, checkGlobalKillSwitch } from "@/lib/kill-switch";
import { validateLicense } from "@/lib/license";
import { recordServerEventInBackground } from "@/lib/metrics-store";
import { checkAndIncrement, getClientIp, hashBucket } from "@/lib/rate-limit";
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
 * Security-audit fix (this route used to have ZERO rate limiting, on the
 * mistaken assumption that "/api/solve already counted this solve" — nothing
 * actually LINKED an interpret call to a prior solve, so anyone could POST
 * fabricated rCode/stdout/questionText straight here for unlimited free
 * Gemini-billed completions). Now gated by three independent layers, all
 * checked before Gemini is ever touched:
 *   1. The global kill switch (lib/kill-switch.ts — item D).
 *   2. A required, signed, short-lived token proving a real /api/solve call
 *      just happened for this exact install id (lib/interpret-token.ts —
 *      item A, the primary fix).
 *   3. This route's OWN independent per-install + per-IP rate limit
 *      (lib/rate-limit.ts — items B/C), defense-in-depth against a
 *      leaked/replayed token, skipped for verified paid licenses (unlimited,
 *      same as /api/solve).
 */
interface InterpretBody extends SolveBody {
  rCode: string;
  stdout: string;
  exitCode?: number;
  durationMs?: number;
  /** Assistant message body from /api/solve (contains the R code + PLAN comment). */
  assistantBody: string;
  /** Signed token from /api/solve's "rcode" result, proving this call is a
   *  legitimate follow-up to a real, already-rate-limited solve — REQUIRED,
   *  see lib/interpret-token.ts. */
  interpretToken?: string;
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
  const installId = c.req.header("x-install-id") ?? "";
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

  // Security-audit item A (the primary fix): require + verify the token
  // /api/solve minted for this exact install id, BEFORE calling Gemini.
  // Rejects fabricated direct-to-/api/interpret calls that never went
  // through a real, rate-limited /api/solve — see lib/interpret-token.ts.
  const tokenCheck = await verifyInterpretToken(c.env, body.interpretToken, installId);
  if (!tokenCheck.ok) {
    return c.json({ error: tokenCheck.reason ?? "Invalid or missing interpret token." }, 403);
  }

  // Security-audit items B/C: independent rate limiting, defense-in-depth
  // even with a cryptographically valid token (bounds a leaked/replayed
  // token to a small, known daily ceiling instead of unlimited redemptions).
  // Skipped for verified paid licenses, matching /api/solve's unlimited-tier
  // model — a paid license is already bound to one device
  // (lib/license-activation.ts) and already had to call /api/solve to get
  // here at all. IP checked before install id, same order as routes/solve.ts.
  if (lic.tier !== "paid") {
    const ip = getClientIp(c);
    const ipLimit = Number(c.env.IP_DAILY_LIMIT ?? "200") || 200;
    const rlIp = await checkAndIncrement(c.env, ip, { limit: ipLimit, keyPrefix: "rl:ip:interpret:" });
    if (!rlIp.allowed) {
      return c.json(
        { error: "Too many requests from this network today. Try again later.", resetAt: rlIp.resetAt },
        429,
      );
    }

    const interpretLimit = Number(c.env.INTERPRET_DAILY_LIMIT ?? "10") || 10;
    const rl = await checkAndIncrement(c.env, installId || "anon", {
      limit: interpretLimit,
      keyPrefix: "rl:interpret:",
    });
    if (!rl.allowed) {
      return c.json(
        { error: `Interpret daily limit reached (${rl.count}/${rl.limit}).`, resetAt: rl.resetAt },
        429,
      );
    }
  }

  const dataFiles: DataFile[] = body.dataFiles ?? [];
  const dataContext = dataFiles.length
    ? buildDataContext(
        dataFiles.map((f) => summarizeCsv(stripExt(f.filename), f.content)),
      )
    : "";

  // Computed once and reused for both the LLM call and metrics recording
  // below, so the event we record always reflects the model actually used.
  // (installId was already read above, before body parsing, for the token
  // check + rate limits.)
  const model = resolveModel(body);
  const installHash = await hashBucket(installId || "anon");

  // Security-audit item D: global daily volume ceiling — same placement
  // rationale as routes/solve.ts: after the token + per-caller rate gates and
  // immediately before the Gemini stream, so only genuinely Gemini-bound
  // calls count toward the global ceiling and cheap rejected requests can't
  // trip a service-wide 503. Atomic check-and-increment; a trip 503s here.
  const kill = await checkGlobalKillSwitch(c.env);
  if (!kill.allowed) return c.json({ error: KILL_SWITCH_MESSAGE }, 503);

  const stream = makeSseStream(async (write) => {
    const startedAt = Date.now(); // wall time around the stream, for serverLatencyMs
    try {
      const hasImage = (body.images?.length ?? 0) > 0;
      const system = buildSystemPrompt({ dataContext, imageMode: hasImage });
      const questionPrompt = buildQuestionPrompt(body);
      const userContent = buildUserContent(questionPrompt, body.images);

      await write({ type: "phase", label: "Interpreting result…" });

      let fbuf = "";
      let fSent = "";
      let usage: LlmChatUsage | undefined;
      for await (const delta of chatStream(apiKey, {
        model,
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
        // Usage arrives on the final chunk, which has no `text` — capture it
        // before the text-only `continue` below would otherwise skip it.
        if (delta.usage) usage = delta.usage;
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

      // interpret.ts is always the finishing move for a calc question (solve.ts
      // already handed off RCODE and recorded its own leg as costMode:"calc";
      // this is the second leg). This is the ONE place modeSplit.calc
      // increments — not at solve.ts's handoff — so a calc question counts
      // once, not twice (see lib/metrics-store.ts's DailyMetricsBucket doc).
      // Calc-path confidence (dashboard-v2 item 16): `finalParsed.confidence`
      // is passed through and routed by the store into `confidenceCalc` (kept
      // separate from the concept-path `confidence`), so low-confidence views
      // cover the calc path too instead of being blind to it.
      recordServerEventInBackground(c, {
        route: "interpret",
        success: true,
        model,
        promptTokens: usage?.prompt_tokens ?? 0,
        completionTokens: usage?.completion_tokens ?? 0,
        cachedTokens: usage?.cached_tokens ?? 0,
        costUsd: costUsdForUsage(model, {
          promptTokens: usage?.prompt_tokens ?? 0,
          completionTokens: usage?.completion_tokens ?? 0,
          cachedTokens: usage?.cached_tokens ?? 0,
        }),
        serverLatencyMs: Date.now() - startedAt,
        installHash,
        costMode: "calc",
        completedQuestion: { mode: "calc", confidence: finalParsed.confidence },
      });

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
      recordServerEventInBackground(c, {
        route: "interpret",
        success: false,
        model,
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
        costUsd: 0,
        serverLatencyMs: Date.now() - startedAt,
        installHash,
        errorType: classifyError(e),
      });
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
