import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "../types";

import {
  buildDataContext,
  buildSystemPrompt,
  extractRCode,
  parseResponse,
} from "@statshelpr/solver-core/core";
import { chatStream, type LlmChatUsage } from "@statshelpr/solver-core/core/providers";
import { classifyError } from "@/lib/classify-error";
import { costUsdForUsage } from "@/lib/cost";
import { summarizeCsv } from "@/lib/data-summary";
import { KILL_SWITCH_MESSAGE, checkGlobalKillSwitch } from "@/lib/kill-switch";
import { validateLicense } from "@/lib/license";
import { activateForInstall } from "@/lib/license-activation";
import { recordPaywallHitInBackground, recordServerEventInBackground } from "@/lib/metrics-store";
import { repairRCode } from "@/lib/r-repair";
import { runRRemote, type RunRResult } from "@/lib/r-runner";
import { checkAndIncrement, getClientIp, hashBucket } from "@/lib/rate-limit";
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
  //
  // NOTE: this is the gate for the FIRST Gemini call only. A calc question
  // may make up to two MORE Gemini calls inside this same request (an
  // R-repair retry, then the interpret pass) — each of those is gated again,
  // individually, right before it fires (see the repair-leg and interpret-leg
  // kill-switch checks further down) so GLOBAL_DAILY_CALL_LIMIT still bounds
  // total Gemini spend per-call, not per-request. See
  // docs/cloud-run-r-migration.md §3 and lib/kill-switch.ts.
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

      // First leg of the calc pipeline is done (Gemini wrote R code instead
      // of a concept answer) — record its own cost now. costMode:"calc", but
      // deliberately NO completedQuestion: the question isn't answered yet
      // (R hasn't even run). modeSplit.calc increments exactly ONCE, at the
      // interpret leg's success further down (see lib/metrics-store.ts's
      // DailyMetricsBucket doc) — the same invariant the old two-route split
      // preserved (this route recorded the hand-off leg's cost here; the old
      // /api/interpret route incremented modeSplit.calc at ITS success), just
      // all three legs (first pass, optional repair, interpret) now run
      // inside this ONE /api/solve request instead of two separate ones —
      // see docs/cloud-run-r-migration.md §3.
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

      // --- server-side calc pipeline ----------------------------------
      // Was: hand rCode + an interpret token to the browser, which ran WebR
      // client-side then POSTed /api/interpret. Now the R execution and the
      // interpret pass both happen HERE, and the extension only ever gets a
      // FINAL answer for calc questions too — same shape as concept. See
      // docs/cloud-run-r-migration.md §1/§3.2.
      let rCode = extractRCode(parsed.body);

      await write({ type: "phase", label: "Computing…" });

      // Heartbeat — the extension aborts a solve stream after 30s with no
      // SSE bytes on the wire (SSE_IDLE_TIMEOUT_MS, apps/extension/src/
      // content.ts). The R call below, an optional repair-on-error round
      // trip (a full extra Gemini call), and a second R call can together
      // silently blow past that budget. Re-emit the SAME phase event every
      // 10s for as long as this block is in flight so the connection never
      // looks idle. Scope: ONLY the R/repair pipeline below — the interpret
      // leg further down streams its own `delta` events as tokens arrive, so
      // it never goes quiet on its own and doesn't need this.
      //
      // Why a tick can never write after the stream has closed: `write`
      // bottoms out in lib/sse.ts's makeSseStream at `controller.enqueue`,
      // which throws once the stream is closed — and the ONLY thing that
      // closes it is makeSseStream's own `finally`, which runs after this
      // entire `produce` callback (our `async (write) => {...}` body) has
      // returned or thrown. Our OWN `finally` below runs synchronously as
      // part of that same return/throw (no `await` in between), so
      // `clearInterval` there is sufficient by itself to guarantee no tick
      // fires post-close. `heartbeatClosed` plus the inner `.catch(() => {})`
      // are pure defense in depth on top of that — a timer callback must
      // never let an unhandled rejection escape, no matter how the stream
      // ends up closing.
      let heartbeatClosed = false;
      const heartbeat = setInterval(() => {
        if (heartbeatClosed) return;
        write({ type: "phase", label: "Computing…" }).catch(() => {
          // Stream already closing/closed — clearInterval in the `finally`
          // below stops further ticks; nothing else to do here.
        });
      }, 10_000);

      // Shared by both runRRemote call sites below (the initial run and the
      // post-repair rerun): on failure, records a metrics event under a
      // distinct "r_runner" errorType — deliberately NOT routed through
      // classify-error.ts's classifyError(), which is tuned for Gemini-shaped
      // failures (quota/auth/rate_limit/timeout/bad_input/upstream); a Cloud
      // Run R-service failure is a different operational signal, and
      // byErrorType is an open Record specifically so a new class like this
      // never needs a schema bump (see lib/metrics-store.ts) — then writes a
      // user-readable error event and returns `undefined` so the caller can
      // bail with a plain `if` check instead of threading exceptions through
      // the whole calc pipeline below.
      const recordRRunnerFailure = async (): Promise<void> => {
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
          errorType: "r_runner",
        });
        await write({
          type: "error",
          message: "Couldn't run the R calculation — please try again.",
        });
      };
      const runRSafe = async (code: string): Promise<RunRResult | undefined> => {
        try {
          return await runRRemote(c.env, code, dataFiles);
        } catch {
          await recordRRunnerFailure();
          return undefined;
        }
      };

      // Set by the fast-fail branch below when the calc pipeline bailed
      // because the R referenced a data file the student never uploaded. The
      // interpret leg still produces a best-effort answer from the question
      // text, but we flag it on the final result so the extension can show the
      // student a "dataset not found — upload the CSV" notice (content.ts).
      let dataMissingBackstop = false;

      // Steps d/e/f (docs/cloud-run-r-migration.md §3.2) collapsed into one
      // closure so the heartbeat's try/finally below has a single `await` to
      // wrap, and `runResult`'s definite-assignment stays trivial
      // (RunRResult | undefined, checked once right after the try).
      const runCalcPipeline = async (): Promise<RunRResult | undefined> => {
        let result = await runRSafe(rCode);
        if (!result) return undefined; // recordRRunnerFailure already handled it

        if (result.exitCode !== 0 && isUnrecoverableMissingData(rCode, dataFiles)) {
          // Fast-fail: the R reads a data file the student never uploaded, so a
          // repair could only re-emit code reading the same missing file and
          // fail identically. Skip the repair Gemini call + second R run and let
          // the interpret leg answer from the question text. Ideally the model
          // routes these to [CONCEPT] up front (core/system-prompt.ts's
          // missing-dataset rule) — this is the server-side backstop. Matches
          // apps/api/lib/solver/non-streaming.ts's isUnrecoverableMissingData.
          dataMissingBackstop = true;
          return result;
        }

        if (result.exitCode !== 0) {
          // The repair leg is a NEW Gemini call, so gate it exactly like the
          // pre-stream kill-switch check above solve.post — item D's ceiling
          // is sized in per-Gemini-call dollars (lib/kill-switch.ts), and the
          // old /api/interpret route incremented it separately from
          // /api/solve; per-call increments here (this repair leg, and the
          // interpret leg further down) preserve that same cost bound now
          // that all three legs live inside one request. See
          // docs/cloud-run-r-migration.md §3.
          const repairKill = await checkGlobalKillSwitch(c.env);
          if (!repairKill.allowed) {
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
              // "quota" is classify-error.ts's closest existing bucket for a
              // self-imposed global volume-ceiling trip — the same semantic
              // slot a Gemini "resource exhausted" error lands in, just
              // tripped by our OWN counter instead of Gemini's.
              errorType: "quota",
            });
            await write({ type: "error", message: KILL_SWITCH_MESSAGE });
            return undefined;
          }

          const repair = await repairRCode(apiKey, model, system, questionPrompt, rCode, result);
          const repairUsageTokens = {
            promptTokens: repair.usage?.prompt_tokens ?? 0,
            completionTokens: repair.usage?.completion_tokens ?? 0,
            cachedTokens: repair.usage?.cached_tokens ?? 0,
          };
          // Repair leg's own metrics event. route:"solve" (a continuation of
          // the solve leg, not the interpret leg) and deliberately NO
          // completedQuestion — same reasoning as the first-pass event above.
          recordServerEventInBackground(c, {
            route: "solve",
            success: true,
            model,
            ...repairUsageTokens,
            costUsd: costUsdForUsage(model, repairUsageTokens),
            serverLatencyMs: Date.now() - startedAt,
            installHash,
            costMode: "calc",
          });

          if (repair.code) {
            rCode = repair.code;
            result = await runRSafe(rCode);
            if (!result) return undefined;
          }
        }

        return result;
      };

      let runResult: RunRResult | undefined;
      try {
        runResult = await runCalcPipeline();
      } finally {
        heartbeatClosed = true;
        clearInterval(heartbeat);
      }
      if (!runResult) return; // failure already recorded + error event already written

      await write({ type: "phase", label: "Finalizing…" });

      // The interpret leg is also a NEW Gemini call -> same kill-switch gate
      // as the repair leg above, same rationale. Labeled route:"interpret"
      // (not "solve") on trip so a failure here is attributed to the LEG
      // that actually failed — matches the interpret leg's own success event
      // below, which also keeps route:"interpret" as its label.
      const interpretKill = await checkGlobalKillSwitch(c.env);
      if (!interpretKill.allowed) {
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
          errorType: "quota",
        });
        await write({ type: "error", message: KILL_SWITCH_MESSAGE });
        return;
      }

      // Interpret leg — nearly verbatim port of the old routes/interpret.ts
      // chatStream block (see docs/cloud-run-r-migration.md §3.2). One
      // conscious deviation: REUSE the first-pass `system` (built above,
      // includes hasBlanks) instead of rebuilding a fresh one without it like
      // interpret.ts did — this matches the ORIGINAL apps/api/lib/solver/
      // non-streaming.ts template (runInterpretStage reuses the SAME
      // `system` solveNonStreaming built once) and keeps blank-format
      // instructions available to the interpret pass for blanks/matching
      // questions.
      let fbuf = "";
      let fSent = "";
      let finalUsage: LlmChatUsage | undefined;
      for await (const delta of chatStream(apiKey, {
        model,
        system,
        messages: [
          { role: "user", content: userContent },
          { role: "assistant", content: parsed.body },
          { role: "user", content: buildFollowupContent(body, rCode, runResult.stdout) },
        ],
        temperature: 0.6,
        maxTokens: MAX_TOKENS_SECOND,
        thinking: { type: "disabled" },
      })) {
        // Usage arrives on the final chunk, which has no `text` — capture it
        // before the text-only `continue` below would otherwise skip it.
        if (delta.usage) finalUsage = delta.usage;
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
      const finalUsageTokens = {
        promptTokens: finalUsage?.prompt_tokens ?? 0,
        completionTokens: finalUsage?.completion_tokens ?? 0,
        cachedTokens: finalUsage?.cached_tokens ?? 0,
      };

      // Interpret leg's metrics — exactly what the old routes/interpret.ts
      // recorded. route:"interpret" is kept as the label even though the
      // public route is gone — it now means "the interpret LEG" — so
      // dashboard cost-by-route continuity holds (see lib/metrics-store.ts).
      // This is the ONE place modeSplit.calc increments (the first-pass
      // event above and the repair-leg event both deliberately omit
      // completedQuestion) — a calc question counts once, not two or three
      // times, across all the legs that now share a single request.
      recordServerEventInBackground(c, {
        route: "interpret",
        success: true,
        model,
        ...finalUsageTokens,
        costUsd: costUsdForUsage(model, finalUsageTokens),
        serverLatencyMs: Date.now() - startedAt,
        installHash,
        costMode: "calc",
        completedQuestion: { mode: "calc", confidence: finalParsed.confidence },
      });

      // Final result — PINNED shape (the extension is being updated against
      // exactly this event; see docs/cloud-run-r-migration.md §1/§3.2).
      await write({
        type: "result",
        result: {
          mode: "calc",
          rCode,
          rOutput: runResult.stdout,
          rExitCode: runResult.exitCode,
          rDurationMs: runResult.durationMs,
          answer: finalParsed.body,
          selectedChoices: deriveSelectedChoices(finalParsed.body, body.choices),
          ...(finalBlanks.length ? { blanks: finalBlanks } : {}),
          confidence: finalParsed.confidence,
          lowConfidence: finalParsed.lowConfidence,
          // Answered without the dataset the question referenced — the extension
          // surfaces a transient "dataset not found, upload the CSV" notice so a
          // reasoned-not-computed answer isn't mistaken for a data-backed one.
          ...(dataMissingBackstop ? { dataMissing: true } : {}),
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

/** A calc failure isn't worth a repair round trip when the model's R tries to
 *  READ a data file but the student uploaded NONE — the repair loop re-prompts
 *  the same (empty) data context and can only re-emit code reading the same
 *  missing file. Skipping it saves a Gemini call + a second R run. Scoped to
 *  the zero-uploads case (with data present, a failure may be a fixable typo,
 *  so we still repair). Mirrors apps/api/lib/solver/non-streaming.ts. */
function isUnrecoverableMissingData(rCode: string, files: DataFile[]): boolean {
  if (files.length > 0) return false;
  return /\bread[._](csv|table|delim2?)\s*\(|\bread_(csv|tsv|delim|table)\s*\(|\bfread\s*\(/i.test(rCode);
}
