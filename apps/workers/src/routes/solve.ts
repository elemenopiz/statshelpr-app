import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "../types";

import {
  buildDataContext,
  buildSystemPrompt,
  extractRCode,
  parseResponse,
} from "@statshelpr/solver-core/core";
import { chatStream, isLunaModel, type LlmChatUsage } from "@statshelpr/solver-core/core/providers";
import { classifyError } from "@/lib/classify-error";
import { doGate, type GateCheck } from "@/lib/counters-do";
import { costUsdForUsage, IMAGE_VISION_MODEL, LUNA_MODEL, PRIMARY_TEXT_MODEL } from "@/lib/cost";
import { summarizeCsv } from "@/lib/data-summary";
import {
  GLOBAL_CALLS_KEY,
  GLOBAL_SPEND_KEY,
  KILL_SWITCH_MESSAGE,
  checkGlobalKillSwitch,
  globalCallLimit,
  globalSpendLimitUsd,
  recordGlobalSpendInBackground,
} from "@/lib/kill-switch";
import { validateLicense } from "@/lib/license";
import { activateForInstall } from "@/lib/license-activation";
import {
  createMetricsBatch,
  flushMetricsBatchInBackground,
  recordPaywallHitInBackground,
} from "@/lib/metrics-store";
import { repairRCode } from "@/lib/r-repair";
import { runRRemote, type RunRResult } from "@/lib/r-runner";
import { getClientIp, hashBucket } from "@/lib/rate-limit";
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
  }
  // Free-tier rate limiting (the per-IP backstop + the per-install daily
  // cap) moved DOWN into the single combined CountersDO gate below (DO
  // switch, 2026-07-29) — one round trip now covers IP + install + global
  // count + global spend, in that order, with the same failure precedence
  // and response codes the old sequential KV checks produced.

  let body: SolveBody;
  try {
    body = (await c.req.json()) as SolveBody;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.questionText && !(body.images && body.images.length > 0)) {
    return c.json({ error: "Provide questionText or images." }, 400);
  }

  // Close the two cost-inflation doors the kill-switch sizing comment
  // (lib/kill-switch.ts) flags as NOT covered by a call-COUNT ceiling
  // (2026-07-29 capacity review):
  //  - `body.model` is honored verbatim by solver-core's resolveModel (it
  //    exists for eval/benchmark A/B runs against local builds) — on the
  //    PUBLIC route that let any caller bill arbitrary models, including
  //    Pro-class ones several times IMAGE_VISION_MODEL's rate, to our key.
  //    The extension never sends it; here it may only name the two models
  //    this service actually runs.
  //  - Unbounded payload fields let a single call stuff far more than the
  //    ~20k prompt tokens the $0.08/call worst-case math assumes (and giant
  //    dataFiles burn Worker CPU in summarizeCsv before any truncation).
  //    Caps are sized 4-10x above anything a real Canvas capture produces,
  //    so legitimate solves never see them.
  // Evals keep full model freedom — they call solver-core directly, not
  // this route.
  const invalid = validateSolveBody(body);
  if (invalid) return c.json({ error: invalid }, 400);

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

  // Model-string routing: solver-core's chatStream sends `gpt-*` models to
  // the OpenAI Luna provider (providers/index.ts providerForModel), so the
  // key must match the provider. Gemini stays the default; the Luna stub is
  // opt-in via body.model and 500s cleanly (plain JSON, before the SSE
  // stream starts — same contract as the GEMINI_API_KEY check above) when
  // its key isn't configured.
  const solveApiKey = isLunaModel(model) ? c.env.OPENAI_API_KEY : apiKey;
  if (!solveApiKey) return c.json({ error: "OPENAI_API_KEY not configured" }, 500);

  // Combined admission gate — ONE CountersDO round trip replacing what used
  // to be three sequential KV counters (DO switch, 2026-07-29). Check order
  // inside the gate preserves the old failure precedence exactly: per-IP
  // backstop first (audit item C — catches install-id rotation; 429, not
  // 402, and deliberately NOT a paywall hit: it's a network-level abuse
  // signal, not a real user at their cap), then the per-install free cap
  // (402 — the extension special-cases exactly 402 to sync its local
  // counter), then the global call ceiling + real-dollar ceiling (503, audit
  // item D). Earlier checks' increments persist when a later check rejects,
  // matching the old sequential-calls behavior.
  //
  // Placement AFTER body parse/validation keeps item D's property — only
  // requests that will actually reach Gemini bump the global counter — and
  // strengthens the per-caller gates a notch: junk requests (bad JSON,
  // over-cap payloads) used to burn the caller's IP/install counters
  // pre-parse; now they burn nothing.
  //
  // This gates the FIRST Gemini call only. A calc question may make up to
  // two MORE Gemini calls inside this same request (an R-repair retry, then
  // the interpret pass) — each is gated again individually right before it
  // fires via checkGlobalKillSwitch (one small DO gate each), so the global
  // ceilings still bound spend per-call, not per-request. See
  // docs/cloud-run-r-migration.md §3 and lib/kill-switch.ts.
  const gateChecks: GateCheck[] = [];
  let ipIdx = -1;
  let installIdx = -1;
  if (lic.tier !== "paid") {
    const ipHash = await hashBucket(getClientIp(c));
    const ipLimit = Number(c.env.IP_DAILY_LIMIT ?? "200") || 200;
    ipIdx = gateChecks.push({ key: `rl:ip:solve:${ipHash}`, limit: ipLimit }) - 1;
    const freeLimit = Number(c.env.FREE_TIER_DAILY_LIMIT ?? "5") || 5;
    installIdx = gateChecks.push({ key: `rl:${installHash}`, limit: freeLimit }) - 1;
  }
  gateChecks.push({ key: GLOBAL_CALLS_KEY, limit: globalCallLimit(c.env) });

  const gate = await doGate(c.env, gateChecks, {
    key: GLOBAL_SPEND_KEY,
    limitUsd: globalSpendLimitUsd(c.env),
  });
  if (!gate.allowed) {
    if (gate.failed === ipIdx) {
      const r = gate.results[ipIdx];
      return c.json(
        { error: "Too many requests from this network today. Try again later.", resetAt: r?.resetAt },
        429,
      );
    }
    if (gate.failed === installIdx) {
      // Paywall hit — the #1 leading indicator of conversion (item 7).
      recordPaywallHitInBackground(c, installHash);
      const r = gate.results[installIdx];
      return c.json(
        {
          error: `Daily limit reached (${r?.count ?? "?"}/${r?.limit ?? "?"}). Upgrade for unlimited.`,
          resetAt: r?.resetAt,
        },
        402,
      );
    }
    // Global call ceiling or dollar ceiling — either way, service-wide stop.
    return c.json({ error: KILL_SWITCH_MESSAGE }, 503);
  }

  // Every metrics event this request produces is buffered here and flushed
  // as ONE KV write when the stream finishes (DO switch part B — a calc
  // solve used to do 4–6 separate read-modify-write puts on the same daily
  // bucket key; see lib/metrics-store.ts's MetricsBatch doc). The paywall
  // path above keeps its immediate single-event write — it returns before
  // this batch exists.
  const metricsBatch = createMetricsBatch();

  const stream = makeSseStream(async (write) => {
    const startedAt = Date.now(); // wall time around the stream, for serverLatencyMs
    try {
      const hasImage = (body.images?.length ?? 0) > 0;
      const hasBlanks = (body.blanks?.length ?? 0) >= 2;
      const system = buildSystemPrompt({ dataContext, imageMode: hasImage, hasBlanks, rPackages: body.packages });
      const questionPrompt = buildQuestionPrompt(body);
      const userContent = buildUserContent(questionPrompt, body.images);

      await write({ type: "phase", label: "Thinking…" });

      let buf = "";
      let mode: "concept" | "calc" | "unknown" = "unknown";
      let userVisibleSent = "";
      let usage: LlmChatUsage | undefined;

      for await (const delta of chatStream(solveApiKey, {
        model,
        system,
        messages: [{ role: "user", content: userContent }],
        maxTokens: MAX_TOKENS_FIRST,
        thinking: { type: "enabled" },
        // A 429/5xx/network hiccup here retries transparently inside
        // chatStream (core/providers/retry.ts) — this leg has no heartbeat
        // of its own (unlike the R/repair block below), so a long backoff
        // wait would otherwise go SSE-silent long enough to trip the
        // extension's 30s idle-abort watchdog (content.ts's
        // SSE_IDLE_TIMEOUT_MS). Re-emit the same "phase" event already sent
        // above — an existing, already-ignored-by-the-UI event shape, not a
        // new one — every ~10s a retry is waiting, same cadence as the
        // R-pipeline heartbeat below.
        retry: {
          onWaiting: () => {
            write({ type: "phase", label: "Thinking…" }).catch(() => {
              // Stream already closing/closed — nothing else to do here.
            });
          },
        },
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
      // Every leg reports its REAL cost into the global dollar ceiling the
      // moment its usage is known — this (not the call count) is what makes
      // GLOBAL_DAILY_SPEND_LIMIT_USD a hard bound on a bad day. See
      // lib/kill-switch.ts.
      recordGlobalSpendInBackground(c, costUsd);

      if (parsed.mode === "concept") {
        const blanks = deriveBlankAnswers(parsed.body, body.blanks);
        metricsBatch.server.push({
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
      metricsBatch.server.push({
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
        metricsBatch.server.push({
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
        metricsBatch.rRunner.push({ success: false });
        await write({
          type: "error",
          message: "Couldn't run the R calculation — please try again.",
        });
      };
      // Real prod samples showed a clean bimodal split: warm calls finish
      // under ~7s, cold starts land at ~11.6s/~15.7s — 8s sits in the gap.
      const R_RUNNER_COLD_START_THRESHOLD_MS = 8_000;
      const runRSafe = async (code: string): Promise<RunRResult | undefined> => {
        try {
          const result = await runRRemote(c.env, code, dataFiles);
          metricsBatch.rRunner.push({
            success: true,
            durationMs: result.durationMs,
            coldStart: result.durationMs > R_RUNNER_COLD_START_THRESHOLD_MS,
          });
          return result;
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
            metricsBatch.server.push({
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

          // repairRCode routes through providers' chat(), so a 429/5xx/network
          // hiccup here retries transparently too (core/providers/retry.ts) —
          // no retry.onWaiting hook needed at this call site specifically: it
          // runs inside runCalcPipeline(), which the `heartbeat` interval
          // above already blankets with a "Computing…" phase tick every 10s
          // for exactly this "don't go SSE-silent too long" reason, so a
          // second heartbeat here would just be a redundant duplicate.
          const repair = await repairRCode(solveApiKey, model, system, questionPrompt, rCode, result);
          const repairUsageTokens = {
            promptTokens: repair.usage?.prompt_tokens ?? 0,
            completionTokens: repair.usage?.completion_tokens ?? 0,
            cachedTokens: repair.usage?.cached_tokens ?? 0,
          };
          const repairCostUsd = costUsdForUsage(model, repairUsageTokens);
          recordGlobalSpendInBackground(c, repairCostUsd);
          // Repair leg's own metrics event. route:"solve" (a continuation of
          // the solve leg, not the interpret leg) and deliberately NO
          // completedQuestion — same reasoning as the first-pass event above.
          metricsBatch.server.push({
            route: "solve",
            success: true,
            model,
            ...repairUsageTokens,
            costUsd: repairCostUsd,
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
        metricsBatch.server.push({
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
      for await (const delta of chatStream(solveApiKey, {
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
        // Same rationale as the first-pass leg above: this call sits after
        // the R-pipeline's heartbeat has already been cleared (its `finally`
        // ran once runCalcPipeline() returned), so a retry-backoff wait here
        // would otherwise be unheartbeated. Reuse the "Finalizing…" phase
        // label already written just above.
        retry: {
          onWaiting: () => {
            write({ type: "phase", label: "Finalizing…" }).catch(() => {
              // Stream already closing/closed — nothing else to do here.
            });
          },
        },
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
      const interpretCostUsd = costUsdForUsage(model, finalUsageTokens);
      recordGlobalSpendInBackground(c, interpretCostUsd);

      // Interpret leg's metrics — exactly what the old routes/interpret.ts
      // recorded. route:"interpret" is kept as the label even though the
      // public route is gone — it now means "the interpret LEG" — so
      // dashboard cost-by-route continuity holds (see lib/metrics-store.ts).
      // This is the ONE place modeSplit.calc increments (the first-pass
      // event above and the repair-leg event both deliberately omit
      // completedQuestion) — a calc question counts once, not two or three
      // times, across all the legs that now share a single request.
      metricsBatch.server.push({
        route: "interpret",
        success: true,
        model,
        ...finalUsageTokens,
        costUsd: interpretCostUsd,
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
      metricsBatch.server.push({
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
    } finally {
      // ONE bucket write for everything the request recorded, success or
      // failure — runs after the catch above has pushed its error event.
      flushMetricsBatchInBackground(c, metricsBatch);
    }
  });

  return new Response(stream, {
    status: 200,
    headers: { ...sseHeaders(), "Access-Control-Allow-Origin": "*" },
  });
});

/** Per-field ceilings for the public route — see the call site's comment for
 *  why these exist. Every number is far above real captures (a Canvas
 *  question is <2k chars, screenshots run 100-500KB, STA 301 course CSVs are
 *  a few hundred KB) but low enough to hold the worst-case per-call token
 *  math the global ceiling's dollar bound assumes. Violations 400 with a
 *  field-specific message rather than truncating silently — the only callers
 *  who can hit them are hand-rolled requests, and a truncated solve would
 *  just produce a confidently wrong answer. */
// LUNA_MODEL is allowlisted for stub testing only — it's priced in
// lib/cost.ts (cheaper than IMAGE_VISION_MODEL on both axes), so it doesn't
// reopen the arbitrary-model cost-inflation door this set exists to close.
const ALLOWED_MODELS = new Set([PRIMARY_TEXT_MODEL, IMAGE_VISION_MODEL, LUNA_MODEL]);
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_QUESTION_CHARS = 8_000;
const MAX_CHOICES = 30;
const MAX_CHOICE_CHARS = 1_000;
const MAX_BLANKS = 20;
const MAX_BLANK_OPTIONS = 30;
const MAX_BLANK_CHARS = 500;
const MAX_IMAGES = 4;
const MAX_IMAGE_B64_CHARS = 2_000_000; // ~1.5MB decoded per image
const MAX_DATA_FILES = 4;
const MAX_DATA_FILE_CHARS = 10_000_000; // 10MB per file
const MAX_DATA_TOTAL_CHARS = 20_000_000; // 20MB across files
const MAX_PACKAGES = 15;
const MAX_PACKAGE_CHARS = 60;

function validateSolveBody(body: SolveBody): string | null {
  if (body.model && !ALLOWED_MODELS.has(body.model)) {
    return "Unsupported model.";
  }
  if ((body.questionText?.length ?? 0) > MAX_QUESTION_CHARS) {
    return "questionText too long.";
  }
  const choices = body.choices ?? [];
  if (choices.length > MAX_CHOICES) return "Too many choices.";
  for (const ch of choices) {
    if ((ch.text?.length ?? 0) > MAX_CHOICE_CHARS || (ch.label?.length ?? 0) > 20) {
      return "Choice too long.";
    }
  }
  const blanks = body.blanks ?? [];
  if (blanks.length > MAX_BLANKS) return "Too many blanks.";
  for (const b of blanks) {
    if ((b.label?.length ?? 0) > MAX_BLANK_CHARS) return "Blank label too long.";
    if ((b.options?.length ?? 0) > MAX_BLANK_OPTIONS) return "Too many blank options.";
    for (const opt of b.options ?? []) {
      if (opt.length > MAX_BLANK_CHARS) return "Blank option too long.";
    }
  }
  const images = body.images ?? [];
  if (images.length > MAX_IMAGES) return "Too many images.";
  for (const img of images) {
    if (!ALLOWED_IMAGE_TYPES.has(img.mediaType)) return "Unsupported image type.";
    if ((img.data?.length ?? 0) > MAX_IMAGE_B64_CHARS) return "Image too large.";
  }
  const files = body.dataFiles ?? [];
  if (files.length > MAX_DATA_FILES) return "Too many data files.";
  let totalDataChars = 0;
  for (const f of files) {
    if ((f.filename?.length ?? 0) > 200) return "Data filename too long.";
    const len = f.content?.length ?? 0;
    if (len > MAX_DATA_FILE_CHARS) return "Data file too large.";
    totalDataChars += len;
  }
  if (totalDataChars > MAX_DATA_TOTAL_CHARS) return "Data files too large.";
  const packages = body.packages ?? [];
  if (packages.length > MAX_PACKAGES) return "Too many packages.";
  for (const p of packages) {
    if (p.length > MAX_PACKAGE_CHARS) return "Package name too long.";
  }
  // Aggregate bound on the prompt-contributing text. The per-field caps
  // above are individually generous, and blanks in particular multiply
  // (20 blanks × 30 options × 500 chars ≈ 300k chars would pass them all) —
  // this closes that product. 40k chars ≈ 10k tokens, far above any real
  // Canvas question (<2k chars) and the exact input scale the kill-switch
  // dollar math assumes.
  let totalTextChars = body.questionText?.length ?? 0;
  for (const ch of choices) totalTextChars += ch.text?.length ?? 0;
  for (const b of blanks) {
    totalTextChars += b.label?.length ?? 0;
    for (const opt of b.options ?? []) totalTextChars += opt.length;
  }
  if (totalTextChars > 40_000) return "Question content too long.";
  return null;
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
