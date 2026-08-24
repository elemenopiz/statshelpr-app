import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "../types";

import {
  buildDataContext,
  buildSystemPrompt,
  extractRCode,
  parseResponse,
} from "@statshelpr/solver-core/core";
import {
  openaiProvider,
  type LlmChatUsage,
} from "@statshelpr/solver-core/core/providers";
import { classifyError } from "../lib/classify-error";
import { doGate, type GateCheck } from "../lib/counters-do";
import { costUsdForUsage, LUNA_MODEL } from "../lib/cost";
import { summarizeCsv } from "../lib/data-summary";
import {
  GLOBAL_CALLS_KEY,
  GLOBAL_SPEND_KEY,
  GLOBAL_SPEND_LIMIT_CFG_KEY,
  KILL_SWITCH_MESSAGE,
  PAID_SOFT_THROTTLE_DELAY_MS,
  buildPaidSoftCapIncrItems,
  checkGlobalKillSwitch,
  decidePaidSoftThrottle,
  globalCallLimit,
  globalSpendLimitUsd,
  recordGlobalSpendInBackground,
} from "../lib/kill-switch";
import { validateLicense } from "../lib/license";
import { activateForInstall } from "../lib/license-activation";
import {
  createMetricsBatch,
  flushMetricsBatchInBackground,
  HOST_HASH_OTHER,
  recordPaywallHitInBackground,
} from "../lib/metrics-store";
import { repairRCode } from "../lib/r-repair";
import { runRRemote, type RunRResult } from "../lib/r-runner";
import { extractCanvasHost, getClientIp, hashBucket } from "../lib/rate-limit";
import { makeSseStream, sseHeaders } from "../lib/sse";
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

// Interactive solves are latency-sensitive. The old first pass enabled high
// reasoning and inherited the provider retry defaults (15s per connection,
// up to 60s total), so one unusually slow reasoning request could sit silent
// until the extension showed the raw AbortSignal timeout. A short, explicit
// budget keeps the customer-facing path bounded; the R-repair and interpret
// legs use the same bounded OpenAI retry policy.
const FIRST_PASS_MAX_ELAPSED_MS = 8_500;
const FIRST_PASS_HEARTBEAT_MS = 3_000;

solve.use("*", cors({
  origin: "*",
  allowMethods: ["POST", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "X-Install-Id"],
}));

solve.post("/", async (c) => {
  // Luna (OPENAI_API_KEY) is the sole solver provider.
  if (!c.env.OPENAI_API_KEY) {
    return c.json({ error: "OPENAI_API_KEY not configured" }, 500);
  }

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

  // Host-domain telemetry (2026-08, owner question: "are these organic users
  // even UT students?"). The extension's content script fetch()es this
  // endpoint directly from the Canvas page context (apps/extension/src/
  // content.ts's onSolve, injected only on *.instructure.com pages per
  // manifest.json's content_scripts), so the browser attaches the school's
  // own Canvas origin as this request's Origin header with NO extension
  // changes needed — this is a worker-only data change. Read + validated
  // ONCE per request, here; only ever a hashBucket() digest of the accepted
  // hostname or the fixed HOST_HASH_OTHER literal reaches metrics storage
  // (via metricsBatch.hostHash below) — an unvalidated Origin string is
  // NEVER used as a key itself. See lib/rate-limit.ts's extractCanvasHost and
  // lib/metrics-store.ts's hostHashCounts doc.
  const canvasHost = extractCanvasHost(c.req.header("origin"));
  const hostBucketKey = canvasHost ? await hashBucket(canvasHost) : HOST_HASH_OTHER;

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
    const parsed = await c.req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return c.json({ error: "Request body must be a JSON object." }, 400);
    }
    body = parsed as SolveBody;
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
  //    Pro-class ones many times Luna's rate, to our key. The extension
  //    never sends it; here it may only name the one model this service
  //    actually runs.
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
  // CHANGE 3 (owner directive, 2026-08-04): paid solves are still never
  // blocked here (see the `if (lic.tier !== "paid")` gate below, unchanged)
  // — but they ARE exactly counted, so a rare paid install way outside
  // normal usage can be gently throttled (not rejected) past a generous
  // daily/monthly threshold. `paidSoftCap` rides the SAME doGate round trip
  // below via its `incr` param — zero extra DO fetches for this. See
  // lib/kill-switch.ts's buildPaidSoftCapIncrItems/decidePaidSoftThrottle.
  let paidSoftCap: ReturnType<typeof buildPaidSoftCapIncrItems> | undefined;
  if (lic.tier !== "paid") {
    const ipHash = await hashBucket(getClientIp(c));
    const ipLimit = Number(c.env.IP_DAILY_LIMIT ?? "1000") || 1000;
    ipIdx = gateChecks.push({ key: `rl:ip:solve:${ipHash}`, limit: ipLimit }) - 1;
    const freeLimit = Number(c.env.FREE_TIER_DAILY_LIMIT ?? "7") || 7;
    installIdx = gateChecks.push({ key: `rl:${installHash}`, limit: freeLimit }) - 1;
  } else {
    paidSoftCap = buildPaidSoftCapIncrItems(installHash);
  }
  gateChecks.push({ key: GLOBAL_CALLS_KEY, limit: globalCallLimit(c.env) });

  const gate = await doGate(
    c.env,
    gateChecks,
    {
      key: GLOBAL_SPEND_KEY,
      limitUsd: globalSpendLimitUsd(c.env),
      // Subscriber-scaled ceiling override (CHANGE 2) — CountersDO resolves
      // max(limitUsd, this cfg row) internally, in the SAME fetch. See
      // lib/kill-switch.ts's computeEffectiveSpendLimitUsd section doc.
      cfgKey: GLOBAL_SPEND_LIMIT_CFG_KEY,
    },
    paidSoftCap ? [paidSoftCap.daily, paidSoftCap.monthly] : undefined,
  );
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

  // CHANGE 3 continued: decide the soft-throttle outcome from THIS SAME gate
  // call's incrResults (order matches buildPaidSoftCapIncrItems: [daily,
  // monthly]) — a fail-open doGate response (DO outage) fabricates zeroed
  // counts here, which decidePaidSoftThrottle correctly reads as "don't
  // throttle" (see that function's fail-open doc in lib/kill-switch.ts).
  // The delay itself is applied later, inside the SSE stream (so a polite
  // phase note can accompany it) — see makeSseStream's callback below.
  let paidThrottleReason: "daily" | "monthly" | undefined;
  if (paidSoftCap) {
    const [dailyRes, monthlyRes] = gate.incrResults ?? [];
    paidThrottleReason = decidePaidSoftThrottle(dailyRes?.count ?? 0, monthlyRes?.count ?? 0).reason;
  }

  // Every metrics event this request produces is buffered here and flushed
  // as ONE KV write when the stream finishes (DO switch part B — a calc
  // solve used to do 4–6 separate read-modify-write puts on the same daily
  // bucket key; see lib/metrics-store.ts's MetricsBatch doc). The paywall
  // path above keeps its immediate single-event write — it returns before
  // this batch exists.
  const metricsBatch = createMetricsBatch();
  // CHANGE 3: rides this SAME batch/flush too — zero new KV writes for the
  // paid-tier soft-throttle counter (see lib/metrics-store.ts's
  // paidThrottleHits doc).
  if (paidThrottleReason) metricsBatch.paidThrottle = paidThrottleReason;
  // Rides this SAME batch/flush — zero new independent KV writes for host
  // telemetry (see hostBucketKey's computation above).
  metricsBatch.hostHash = hostBucketKey;

  // Computed here (not inside the stream closure below) so it's available for
  // both the prompt build AND requestFacts without being computed twice.
  // Request-level facts (course-topic Part 3 + preset-package telemetry):
  // known up front from `body`, unlike the model's self-reported TOPIC, so
  // they're recorded ONCE per request — see RequestFacts's doc in
  // lib/metrics-store.ts for why this can't just ride each per-leg
  // ServerEventInput (a calc question's repair/interpret legs would
  // otherwise double- or triple-count a single request's facts). Recorded
  // regardless of whether the request goes on to succeed or fail.
  const hasImage = (body.images?.length ?? 0) > 0;
  metricsBatch.requestFacts = {
    courseProfile: body.courseProfile === "generic" ? "generic" : "sta301",
    imageAttached: hasImage,
    ...(typeof body.rPackagesCustomized === "boolean"
      ? { rPackagesCustomized: body.rPackagesCustomized }
      : {}),
    ...(body.packages && body.packages.length ? { requestedPackages: body.packages } : {}),
    // Free-vs-paid split (owner's #1 dashboard ask) + top-consumer/fair-use
    // evidence — both from state already resolved above (the license gate,
    // `lic`, and installHash), never re-derived from anything client-
    // supplied. `lic.tier` is optional in its type but always populated for
    // an ok:true result in practice (lib/license.ts); default defensively
    // to "free" rather than trust that invariant blindly. See
    // lib/metrics-store.ts's RequestFacts.tier/installHash docs.
    tier: lic.tier === "paid" ? "paid" : "free",
    installHash,
  };

  const stream = makeSseStream(async (write) => {
    const startedAt = Date.now(); // wall time around the stream, for serverLatencyMs
    try {
      // CHANGE 3 (owner directive, 2026-08-04): the paid-tier soft-cap delay
      // lives HERE (inside the open SSE stream), not before it, so a polite
      // note can ride the existing `{type:"phase", label}` shape — the SAME
      // shape already used for heartbeats/retries elsewhere in this file —
      // rather than inventing a new pinned event. A phase write right before
      // AND right after the sleep keeps the connection well under the
      // extension's 30s SSE idle-abort watchdog (content.ts's
      // SSE_IDLE_TIMEOUT_MS): PAID_SOFT_THROTTLE_DELAY_MS (15s) is half that
      // budget. Deliberately placed AFTER `startedAt` is captured, so a
      // throttled request's own serverLatencyMs honestly reflects the full
      // wall time this request actually took, delay included.
      if (paidThrottleReason) {
        await write({
          type: "phase",
          label: "High usage today — pausing briefly to keep things fair for everyone…",
        });
        await new Promise((resolve) => setTimeout(resolve, PAID_SOFT_THROTTLE_DELAY_MS));
      }

      const hasBlanks = (body.blanks?.length ?? 0) >= 2;
      // PINNED MODEL-OUTPUT-CONTRACT CHANGE (course-topic branch): `courseProfile`
      // swaps course-specific guidance for `body.courseProfile === "generic"`
      // requests, and — for EVERY request, both profiles — the prompt now
      // additionally instructs a trailing `TOPIC: <topic>` output line (see
      // solver-core's TOPIC_INSTRUCTION_LINE). Gated on a post-funding eval
      // re-run (scripts/run-evals.ts, cleaned set — denominators 130/85/48,
      // excluding all 23 known-leaky matching-question fixtures) before any
      // deploy — see packages/solver-core/scripts/self-test-prompt.ts's golden
      // test, which locks the default (courseProfile omitted) profile's prompt
      // to byte-identical except for that one added TOPIC block.
      const system = buildSystemPrompt({
        dataContext,
        imageMode: hasImage,
        hasBlanks,
        rPackages: body.packages,
        courseProfile: body.courseProfile,
      });
      const questionPrompt = buildQuestionPrompt(body);
      const userContent = buildUserContent(questionPrompt, body.images);

      await write({ type: "phase", label: "Thinking…" });

      let buf = "";
      let mode: "concept" | "calc" | "unknown" = "unknown";
      let userVisibleSent = "";
      let usage: LlmChatUsage | undefined;

      const firstPassStream = openaiProvider.chatStream(c.env.OPENAI_API_KEY, {
        model,
        system,
        messages: [{ role: "user", content: userContent }],
        maxTokens: MAX_TOKENS_FIRST,
        // Low reasoning is enough for the structured [CONCEPT]/[RCODE]
        // routing decision and keeps the first pass inside the interactive
        // latency budget. The R execution and final interpretation still
        // provide the calculation-specific accuracy check.
        reasoningEffort: "low",
        // A 429/5xx/network hiccup here retries transparently inside
        // chatStream (core/providers/retry.ts). The heartbeat below keeps the
        // SSE stream alive while a retry/backoff or slow reasoning interval
        // is in flight, preventing the
        // extension's 30s idle-abort watchdog (content.ts's
        // SSE_IDLE_TIMEOUT_MS). Re-emit the same "phase" event already sent
        // above — an existing, already-ignored-by-the-UI event shape, not a
        // new one — while the request is still active.
        retry: {
          // Retry transient connection/429/5xx failures inside the same
          // interactive budget. This is OpenAI-only resilience; it never
          // switches providers and never emits a retry message to Canvas.
          maxRetries: 2,
          maxElapsedMs: FIRST_PASS_MAX_ELAPSED_MS,
          connectTimeoutMs: 4_000,
          streamTimeoutMs: FIRST_PASS_MAX_ELAPSED_MS,
          waitingIntervalMs: 1_500,
          onWaiting: () => {
            write({ type: "phase", label: "Thinking…" }).catch(() => {
              // Stream already closing/closed — nothing else to do here.
            });
          },
        },
      });

      // OpenAI can send reasoning/in-progress events without user-visible
      // text. Keep the SSE stream alive while the bounded first pass is
      // working so a proxy/browser never mistakes that normal gap for a dead
      // request. This is deliberately shorter than the extension watchdog.
      const thinkingHeartbeat = setInterval(() => {
        write({ type: "phase", label: "Thinking…" }).catch(() => {});
      }, FIRST_PASS_HEARTBEAT_MS);
      try {
        for await (const delta of firstPassStream) {
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
          // course-topic: TOPIC now streams in as a THIRD trailing line, after
          // CONFIDENCE (see solver-core's TOPIC_INSTRUCTION_LINE). Strip it
          // FIRST — while it's (partially or fully) trailing — so CONFIDENCE
          // becomes the new trailing line again and the second replace below
          // still hides it exactly as it always has. Without this, once TOPIC
          // starts streaming in, the CONFIDENCE regex would stop matching
          // (CONFIDENCE is no longer at the string's end) and both lines would
          // flash into `display` for one chunk. No consumer currently renders
          // `delta` text (content.ts ignores it — see its module doc), so this
          // is currently latent, but it's the same append-only bug either way.
          const display = cleaned
            .replace(/\n?TOPIC:\s*\w*\s*$/i, "")
            .replace(/\n?CONFIDENCE:\s*\w+\s*$/i, "");
          const newSlice = display.slice(userVisibleSent.length);
          if (newSlice) {
            userVisibleSent = display;
            await write({ type: "delta", text: newSlice });
          }
        }
        }
      } finally {
        clearInterval(thinkingHeartbeat);
      }

      const parsed = parseResponse(buf);
      const usageTokens = {
        promptTokens: usage?.prompt_tokens ?? 0,
        completionTokens: usage?.completion_tokens ?? 0,
        cachedTokens: usage?.cached_tokens ?? 0,
      };
      const costUsd = costUsdForUsage(model, usageTokens);
      recordGlobalSpendInBackground(c, costUsd);

      if (parsed.mode === "concept") {
        const blanks = deriveBlankAnswers(parsed.body, body.blanks);
        metricsBatch.server.push({
          route: "solve",
          success: true,
          model,
          provider: "luna",
          ...usageTokens,
          costUsd,
          serverLatencyMs: Date.now() - startedAt,
          installHash,
          costMode: "concept",
          completedQuestion: { mode: "concept", confidence: parsed.confidence, topic: parsed.topic },
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

      metricsBatch.server.push({
        route: "solve",
        success: true,
        model,
        provider: "luna",
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
      // This is also what makes lib/r-runner.ts's extended timeout SAFE for
      // a `packages`-carrying request (up to 180s worst case vs. the normal
      // 30s — see runRRemote's INSTALL_TIMEOUT_MS): this interval wraps the
      // ENTIRE runCalcPipeline() below via the try/finally further down,
      // which is what both runRSafe() call sites (the initial run and the
      // post-repair rerun) run inside — so it keeps ticking every 10s
      // regardless of how long any single awaited runRRemote call takes.
      // Verified this covers the packages-present path specifically (not
      // just asserted): runCalcPipeline's first statement is
      // `runRSafe(rCode)`, which is the SAME closure that now forwards
      // body.packages into runRRemote — there is no separate, unheartbeated
      // call path for a customized request. No new heartbeat was needed for
      // on-demand installs; this pre-existing one already covers it.
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
          message: "The calculation could not be completed.",
        });
      };
      const recordMissingDataFailure = async (): Promise<void> => {
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
          errorType: "data_missing",
        });
        metricsBatch.rRunner.push({ success: false });
        await write({
          type: "error",
          message: "The required dataset is missing.",
        });
      };
      // Real prod samples showed a clean bimodal split: warm calls finish
      // under ~7s, cold starts land at ~11.6s/~15.7s — 8s sits in the gap.
      const R_RUNNER_COLD_START_THRESHOLD_MS = 8_000;
      // body.packages is undefined for every request without a customized
      // picker selection (the default preset — see solver-core's SolveBody
      // doc and apps/extension/src/r-packages.ts, which omits the field
      // entirely rather than sending an empty array in that case) —
      // runRRemote's own doc comment is explicit that passing `undefined`
      // through here is what keeps that path byte-identical to before
      // on-demand installs existed (unchanged body shape, unchanged 30s
      // timeout). Shared by BOTH runRRemote call sites this closure serves
      // (the initial run and the post-repair rerun below), so one edit here
      // covers both — matches this function's existing "shared by both call
      // sites" framing for the failure-recording behavior above.
      const runRSafe = async (code: string): Promise<RunRResult | undefined> => {
        try {
          const result = await runRRemote(c.env, code, dataFiles, body.packages);
          // Evidence-based "which packages do users actually need" signal —
          // see extractMissingRPackageNames' doc below. Raw candidates only;
          // metrics-store.ts's applyRRunnerEvent/addMissingRPackage is what
          // actually sanitizes before anything is persisted.
          const missingPackages = extractMissingRPackageNames(result.stderr);
          // Runtime-installed packages (r-runner/plumber.R's
          // install_missing_packages, only ever populated when body.packages
          // was sent above) — same "raw candidates in, sanitize at the KV
          // write boundary" split as missingPackages: metrics-store.ts's
          // applyRRunnerEvent/addRuntimeInstalledRPackage does the actual
          // grammar-check + cap before anything is persisted.
          const installedPackages = result.installedPackages ?? [];
          metricsBatch.rRunner.push({
            success: true,
            durationMs: result.durationMs,
            coldStart: result.durationMs > R_RUNNER_COLD_START_THRESHOLD_MS,
            ...(missingPackages.length > 0 ? { missingPackages } : {}),
            ...(installedPackages.length > 0 ? { installedPackages } : {}),
          });
          return result;
        } catch {
          await recordRRunnerFailure();
          return undefined;
        }
      };

      // Steps d/e/f (docs/cloud-run-r-migration.md §3.2) collapsed into one
      // closure so the heartbeat's try/finally below has a single `await` to
      // wrap, and `runResult`'s definite-assignment stays trivial
      // (RunRResult | undefined, checked once right after the try).
      const runCalcPipeline = async (): Promise<RunRResult | undefined> => {
        let result = await runRSafe(rCode);
        if (!result) return undefined; // recordRRunnerFailure already handled it

        if (result.exitCode !== 0 && isUnrecoverableMissingData(rCode, dataFiles)) {
          // A data-derived answer is not valid without the required dataset.
          // Do not send failed R output to the interpret model as a guess.
          await recordMissingDataFailure();
          return undefined;
        }

        if (result.exitCode !== 0) {
          // The repair leg is a NEW OpenAI call, so gate it exactly like the
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

          const repair = await repairRCode(c.env.OPENAI_API_KEY, model, system, questionPrompt, rCode, result);
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
            provider: "luna",
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

        if (result.exitCode !== 0) {
          // Never interpret a failed calculation as if it were a valid one.
          await recordRRunnerFailure();
          return undefined;
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
      const interpretStream = openaiProvider.chatStream(c.env.OPENAI_API_KEY, {
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
        retry: {
          maxRetries: 2,
          maxElapsedMs: FIRST_PASS_MAX_ELAPSED_MS,
          connectTimeoutMs: 4_000,
          streamTimeoutMs: FIRST_PASS_MAX_ELAPSED_MS,
          waitingIntervalMs: 1_500,
          onWaiting: () => {
            write({ type: "phase", label: "Finalizing…" }).catch(() => {});
          },
        },
      });

      for await (const delta of interpretStream) {
        if (delta.usage) finalUsage = delta.usage;
        if (!delta.text) continue;
        fbuf += delta.text;
        const cleaned = fbuf.replace(/^\s*\[(CONCEPT|RCODE|CALC)\]\s*\n?/i, "");
        const display = cleaned
          .replace(/\n?TOPIC:\s*\w*\s*$/i, "")
          .replace(/\n?CONFIDENCE:\s*\w+\s*$/i, "");
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

      metricsBatch.server.push({
        route: "interpret",
        success: true,
        model,
        provider: "luna",
        ...finalUsageTokens,
        costUsd: interpretCostUsd,
        serverLatencyMs: Date.now() - startedAt,
        installHash,
        costMode: "calc",
        completedQuestion: { mode: "calc", confidence: finalParsed.confidence, topic: finalParsed.topic },
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
// The one model this service runs. `body.model` exists only so eval builds
// can name it explicitly — anything else 400s, keeping the arbitrary-model
// cost-inflation door closed.
const ALLOWED_MODELS = new Set([LUNA_MODEL]);
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
// course-topic: strict enum whitelist for the course-content profile — absent
// means UT Austin STA 301 (the historical default; see solver-core's
// buildSystemPrompt CourseProfile option), and "generic" is the ONLY other
// accepted value. Anything else 400s rather than silently falling back, so a
// typo/future-client-bug can never quietly serve the wrong prompt content.
const ALLOWED_COURSE_PROFILES = new Set(["generic"]);

function validateSolveBody(body: SolveBody): string | null {
  if (body.questionText !== undefined && typeof body.questionText !== "string") {
    return "questionText must be a string.";
  }
  if (body.choices !== undefined && !Array.isArray(body.choices)) {
    return "choices must be an array.";
  }
  if (body.blanks !== undefined && !Array.isArray(body.blanks)) {
    return "blanks must be an array.";
  }
  if (body.images !== undefined && !Array.isArray(body.images)) {
    return "images must be an array.";
  }
  if (body.dataFiles !== undefined && !Array.isArray(body.dataFiles)) {
    return "dataFiles must be an array.";
  }
  if (body.packages !== undefined && !Array.isArray(body.packages)) {
    return "packages must be an array.";
  }
  if (body.model && !ALLOWED_MODELS.has(body.model)) {
    return "Unsupported model.";
  }
  if (body.courseProfile !== undefined && !ALLOWED_COURSE_PROFILES.has(body.courseProfile)) {
    return "Unsupported courseProfile.";
  }
  if (body.rPackagesCustomized !== undefined && typeof body.rPackagesCustomized !== "boolean") {
    return "Invalid rPackagesCustomized.";
  }
  if ((body.questionText?.length ?? 0) > MAX_QUESTION_CHARS) {
    return "questionText too long.";
  }
  const choices = body.choices ?? [];
  if (choices.length > MAX_CHOICES) return "Too many choices.";
  for (const ch of choices) {
    if (!ch || typeof ch !== "object" || typeof ch.label !== "string" || typeof ch.text !== "string") {
      return "Each choice must include a label and text.";
    }
    if ((ch.text?.length ?? 0) > MAX_CHOICE_CHARS || (ch.label?.length ?? 0) > 20) {
      return "Choice too long.";
    }
  }
  const blanks = body.blanks ?? [];
  if (blanks.length > MAX_BLANKS) return "Too many blanks.";
  for (const b of blanks) {
    if (!b || typeof b !== "object" || typeof b.key !== "string" || typeof b.label !== "string" || !Array.isArray(b.options)) {
      return "Each blank must include a key, label, and options array.";
    }
    if ((b.label?.length ?? 0) > MAX_BLANK_CHARS) return "Blank label too long.";
    if ((b.options?.length ?? 0) > MAX_BLANK_OPTIONS) return "Too many blank options.";
    for (const opt of b.options ?? []) {
      if (opt.length > MAX_BLANK_CHARS) return "Blank option too long.";
    }
  }
  const images = body.images ?? [];
  if (images.length > MAX_IMAGES) return "Too many images.";
  for (const img of images) {
    if (!img || typeof img !== "object" || typeof img.mediaType !== "string" || typeof img.data !== "string") {
      return "Each image must include a mediaType and data.";
    }
    if (!ALLOWED_IMAGE_TYPES.has(img.mediaType)) return "Unsupported image type.";
    if ((img.data?.length ?? 0) > MAX_IMAGE_B64_CHARS) return "Image too large.";
  }
  const files = body.dataFiles ?? [];
  if (files.length > MAX_DATA_FILES) return "Too many data files.";
  let totalDataChars = 0;
  for (const f of files) {
    if (!f || typeof f !== "object" || typeof f.filename !== "string" || typeof f.content !== "string") {
      return "Each data file must include a filename and content.";
    }
    if ((f.filename?.length ?? 0) > 200) return "Data filename too long.";
    const len = f.content?.length ?? 0;
    if (len > MAX_DATA_FILE_CHARS) return "Data file too large.";
    totalDataChars += len;
  }
  if (totalDataChars > MAX_DATA_TOTAL_CHARS) return "Data files too large.";
  const packages = body.packages ?? [];
  if (packages.length > MAX_PACKAGES) return "Too many packages.";
  for (const p of packages) {
    if (typeof p !== "string") return "Each package name must be a string.";
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

/** Provider-neutral on purpose (gemini-fallback work): this fires for
 *  whichever provider's error reaches the outer catch last — Luna alone
 *  (no GEMINI_API_KEY configured), or Gemini's own failure after a Luna
 *  fallback — so a message naming one specific provider would be actively
 *  wrong roughly half the time. Previously hardcoded "Gemini" unconditionally
 *  even for Luna failures (pre-existing bug from the fc35aa5 provider swap,
 *  fixed here rather than left for the fallback work to inherit). */
function humanizeError(e: unknown): string {
  const obj = e as { status?: number; message?: string };
  const msg = obj?.message ?? "Unknown error";
  if (/credit balance|insufficient|quota|resource exhausted/i.test(msg))
    return "The AI tutor is temporarily unavailable.";
  if (obj?.status === 401 || obj?.status === 403)
    return "The AI tutor's API key is invalid, revoked, or missing permissions.";
  if (obj?.status === 429)
    return "The AI tutor is temporarily unavailable.";
  if (/timeout|abort/i.test(msg))
    return "The solve could not be completed.";
  return msg;
}

function stripExt(name: string) {
  return name.replace(/\.(csv|tsv|txt)$/i, "").replace(/[^A-Za-z0-9_]/g, "_");
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

/** Detects R's fixed "package not installed" error text so it can feed the
 *  missingRPackages telemetry (lib/metrics-store.ts) — an evidence-based
 *  signal for which packages the tutor's generated R code actually reaches
 *  for that the runner doesn't have installed (r-runner/Dockerfile), distinct
 *  from the prompt's hardcoded recommendations (packages/solver-core/src/
 *  core/stats-reference.ts).
 *
 *  Scoped to `stderr` alone, not `stdout` too: r-runner/plumber.R's
 *  run_r_code() always returns the bare error/warning text as `stderr` — for
 *  a terminal library() error, `stderr` IS that text exactly; for a
 *  non-terminal require() warning, `stderr` is the accumulated
 *  warning/message text. `stdout` on a terminal error is that SAME text
 *  combined with any prior printed output, so also scanning it would just
 *  re-match the identical occurrence a second time (see run_r_code's doc
 *  comment in plumber.R for the exact stdout/stderr construction). Results
 *  are deduped (Set) so one call can only contribute each distinct name once
 *  — metrics-store.ts's cap is on distinct names/day, but a single request
 *  (or one hostile script printing the same phrase repeatedly) should never
 *  itself inflate one name's count.
 *
 *  Untrusted input: this is R's OWN error text, but the package name inside
 *  it came from whatever the model's R code tried to library()/require(),
 *  which is downstream of free-form user input (r-runner/README.md's
 *  "Sandbox model" — assume every script is hostile). This function only
 *  extracts candidate substrings; it does NOT decide what's safe to persist
 *  — the allow-list grammar check + per-day cap live in
 *  lib/metrics-store.ts's addMissingRPackage, the actual KV-write boundary. */
function extractMissingRPackageNames(stderr: string): string[] {
  const re = /there is no package called\s*[‘’'"`]([^‘’'"`]*)[‘’'"`]/g;
  const names = new Set<string>();
  for (const m of stderr.matchAll(re)) {
    if (m[1]) names.add(m[1]);
  }
  return [...names];
}
