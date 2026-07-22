import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "../types";

import {
  buildDataContext,
  buildSystemPrompt,
  parseResponse,
} from "@statshelpr/solver-core/core";
import { chatStream, type LlmChatUsage } from "@statshelpr/solver-core/core/providers";
import { classifyError } from "@/lib/classify-error";
import { costUsdForUsage } from "@/lib/cost";
import { summarizeCsv } from "@/lib/data-summary";
import { issueInterpretToken } from "@/lib/interpret-token";
import { KILL_SWITCH_MESSAGE, checkGlobalKillSwitch } from "@/lib/kill-switch";
import { validateLicense } from "@/lib/license";
import { activateForInstall } from "@/lib/license-activation";
import { recordPaywallHitInBackground, recordServerEventInBackground } from "@/lib/metrics-store";
import { checkAndIncrement, getClientIp, hashBucket } from "@/lib/rate-limit";
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

  // Computed BEFORE the rate-limit check (dashboard-v2 item 7) so a free user
  // who gets paywalled at the daily cap still counts as an ACTIVE install for
  // the day — recordPaywallHit adds this hash to the active set. Only depends
  // on the install id, so it's safe to hoist above body parsing / resolveModel.
  const installHash = await hashBucket(installId || "anon");

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
    // Security-audit item C: per-IP backstop, checked BEFORE the per-install
    // counter so a caller rotating install ids specifically to dodge their
    // own cap (the install id is just a client-picked crypto.randomUUID(),
    // see apps/extension/src/install-id.ts, with no server issuance) still
    // gets caught here even though each fresh id starts its own bucket at 0.
    // Deliberately NOT recorded as a paywall hit below — this is a network-
    // level abuse signal, not an individual free user hitting their real
    // cap, and folding it into that metric would misrepresent conversion
    // data. 429, not 402: the extension only special-cases exactly 402 to
    // sync its local per-install counter (apps/extension/src/content.ts),
    // which doesn't apply here.
    const ip = getClientIp(c);
    const ipLimit = Number(c.env.IP_DAILY_LIMIT ?? "200") || 200;
    const rlIp = await checkAndIncrement(c.env, ip, { limit: ipLimit, keyPrefix: "rl:ip:solve:" });
    if (!rlIp.allowed) {
      return c.json(
        { error: "Too many requests from this network today. Try again later.", resetAt: rlIp.resetAt },
        429,
      );
    }

    const rl = await checkAndIncrement(c.env, installId || "anon");
    if (!rl.allowed) {
      // Paywall hit — the #1 leading indicator of conversion (item 7).
      recordPaywallHitInBackground(c, installHash);
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
  // (installHash is computed earlier, above the rate-limit check — item 7.)
  const model = resolveModel(body);

  // Security-audit item D: global (not per-caller) daily volume ceiling.
  // Placed HERE — after every per-caller auth/license/rate-limit gate and
  // immediately before the Gemini stream — NOT at the top of the route, so
  // only requests that will actually incur Gemini cost count toward the
  // global ceiling. (A top-of-route check-and-increment let cheap rejected
  // requests — bad/empty auth, over-IP-limit, malformed body — bump the
  // global counter too, so ~GLOBAL_DAILY_CALL_LIMIT junk requests from a
  // single IP could trip a service-wide 503 for the rest of the UTC day.
  // The per-IP + per-install gates above now absorb that before we reach
  // here.) Atomic check-and-increment; a trip 503s without starting the stream.
  const kill = await checkGlobalKillSwitch(c.env);
  if (!kill.allowed) return c.json({ error: KILL_SWITCH_MESSAGE }, 503);

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
      // Security-audit item A: mint the token that proves to /api/interpret
      // that a real, rate-limited /api/solve call preceded it. Omitted
      // entirely (not an empty string) when INTERPRET_SIGNING_SECRET isn't
      // configured — see lib/interpret-token.ts's fail-closed contract.
      const interpretToken = await issueInterpretToken(c.env, installId);
      await write({
        type: "result",
        result: {
          mode: "rcode",
          rCode,
          assistantBody: parsed.body,
          ...(interpretToken ? { interpretToken } : {}),
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
        errorType: classifyError(e),
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
