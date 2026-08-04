/**
 * KV-backed daily metrics buckets: server-side call counters/cost/latency
 * plus client-reported write-back outcomes, merged at read time by
 * lib/metrics-aggregate.ts (called from routes/metrics.ts). Written by
 * routes/solve.ts (server events — including its internal interpret LEG,
 * recorded under route:"interpret"; the standalone /api/interpret route this
 * used to come from was retired, see docs/cloud-run-r-migration.md §3 and
 * the `routes` field doc below) and routes/telemetry.ts (client beacon
 * events).
 *
 * Storage: one JSON blob per UTC day at key `metrics:YYYY-MM-DD`, updated via
 * a plain KV read-modify-write (get -> mutate in memory -> put) — the same
 * pattern as lib/rate-limit.ts. This is NOT atomic: two requests recording
 * into the same day's bucket at nearly the same instant can race (both read
 * the same starting JSON, both write back, the second write wins and
 * silently drops the first's increment). At current traffic (a pre-launch
 * product, single-digit-to-low-hundreds of requests/day) this is an
 * acceptable, occasional undercount — NOT acceptable if this ever needs to
 * be exact (billing, SLAs). If/when volume grows enough for that to matter,
 * migrate to Cloudflare D1 (real transactions) or Analytics Engine (built
 * for exactly this write pattern, no read-modify-write needed) — this
 * module's public functions (recordServerEvent/recordClientEvent/
 * readBucketsForRange) are the seam to swap the storage backend behind
 * without touching solve.ts/telemetry.ts's call sites.
 */

import type { Context } from "hono";
import type { Env } from "../types";
import { addToHistogram, emptyHistogram, LATENCY_BUCKET_BOUNDARIES_MS } from "./histogram";

const KV_PREFIX = "metrics:";
// Sized for the 2×window lookback metrics-load.ts now reads (a 30-day window
// PLUS its immediately-preceding 30-day comparison/cohort window = 60 days),
// with a ~10-day margin. Was 40 days when only a single 30-day window was
// read; bumped so window-over-window deltas (dashboard-v2 item 10) actually
// have a populated prior window instead of expired-to-empty buckets.
const BUCKET_TTL_SEC = 70 * 86_400;
const INSTALL_HASH_CAP = 5000; // per-day cap; see addInstallHash

export interface RouteCounters {
  attempts: number;
  successes: number;
  errors: number;
}

export interface ConfidenceCounts {
  High: number;
  Med: number;
  Low: number;
  "": number;
}

export interface ModelUsage {
  calls: number;
  costUsd: number;
}

/** Write-back outcome tally, reused for the overall daily count and for the
 *  per-question-type cross-tab (dashboard-v2 item 4). */
export interface WriteBackOutcomeCounts {
  written: number;
  nowrite: number;
  error: number;
}

/** Daily subscription-lifecycle FLOW counts (not point-in-time state — the
 *  live active-subscriber count is derived at read time from the `sub:` KV
 *  keyspace, see lib/metrics-load.ts). Written by
 *  routes/lemonsqueezy-webhook.ts (dashboard-v2 item 6). */
export interface RevenueFlowCounts {
  created: number;
  cancelled: number;
  paymentFailed: number;
}

// ===========================================================================
// === dashboard-v2 metrics contract (frozen) ================================
// Any agent editing this file MUST branch off the `dashboard-v2` commit that
// introduced this marker. If this comment is absent from your base, STOP —
// you have forked from a stale base (see project memory
// "worktree-agents-fork-stale"). The field NAMES/shapes below are the shared
// contract between the write path (solve/interpret/telemetry/webhook), the
// aggregator (metrics-aggregate.ts), and the renderer (dashboard-render.ts);
// change values, never rename/reshape these without updating all three.
// ===========================================================================

export interface DailyMetricsBucket {
  date: string;
  server: {
    /** Keyed by LEG, not necessarily by HTTP route anymore. "solve" covers
     *  the first Gemini pass and any R-repair retry; "interpret" covers the
     *  interpret pass. Both legs are recorded from inside routes/solve.ts —
     *  the standalone /api/interpret route that used to write the
     *  "interpret" counters was retired (see
     *  docs/cloud-run-r-migration.md §3) — the key is kept as "interpret" so
     *  dashboard cost-by-route continuity holds across the migration. */
    routes: { solve: RouteCounters; interpret: RouteCounters };
    /** Completed-question counts (NOT raw call counts — see recordServerEvent's
     *  `completedQuestion` doc below). `concept` increments once per concept
     *  answer (solve.ts). `calc` increments once per completed calc answer,
     *  at the interpret LEG's success — recorded from routes/solve.ts under
     *  route:"interpret" (see the `routes` field doc above) — NOT at the
     *  first pass's RCODE hand-off, which would double-count (a calc
     *  question can span up to three LLM calls: first pass, optional repair,
     *  interpret). */
    modeSplit: { concept: number; calc: number };
    /** Solve-CONCEPT-path confidence. Kept concept-only (its original pinned
     *  scope) so existing aggregates/tests are unchanged; the calc path is
     *  tracked separately in `confidenceCalc` below. */
    confidence: ConfidenceCounts;
    /** Solve-CALC-path confidence (dashboard-v2 item 16) — the interpret
     *  leg's `finalParsed.confidence` (recorded from routes/solve.ts under
     *  route:"interpret", see the `routes` field doc above), previously
     *  parsed-then-dropped. Split from `confidence` so "low-confidence"
     *  views can cover BOTH paths instead of being blind to calc. */
    confidenceCalc: ConfidenceCounts;
    /** Per-error-class counts for failed solve/interpret calls (dashboard-v2
     *  item 2) — keyed by the stable enum classifyError() returns
     *  ("quota"|"auth"|"rate_limit"|"timeout"|"bad_input"|"upstream"|
     *  "unknown"). Open Record so a new class never needs a schema bump. */
    byErrorType: Record<string, number>;
    tokens: { promptTokens: number; completionTokens: number; cachedTokens: number };
    /** Grand total of every event's costUsd, success or error (errors cost
     *  ~0 anyway since there's no usage to bill). */
    costUsd: number;
    /** Same total, split by which question-mode the spend is attributable
     *  to. A calc question can cost up to three LLM calls — the first pass,
     *  an optional R-repair retry, and the interpret pass (all three now run
     *  inside routes/solve.ts, see docs/cloud-run-r-migration.md §3); every
     *  leg's cost lands in `calc` so avgCostPerCalcQuestionUsd reflects the
     *  true pipeline cost. */
    costUsdByMode: { concept: number; calc: number };
    /** Per-model call count + cost, keyed on the exact model id that
     *  actually served the call — normally `resolveModel(body)`'s Luna id,
     *  but a leg that fell back to Gemini (gemini-fallback work, lib/llm.ts)
     *  keys under GEMINI_TEXT_MODEL/IMAGE_VISION_MODEL (lib/cost.ts)
     *  instead. Each event is costed at ITS OWN model's rate, never a
     *  blended rate — this is the audit trail for that split, AND (a
     *  non-Luna row appearing here at all) the content-free signal that
     *  fallback fired — see GET /api/metrics' economics.modelsUsed and the
     *  /dashboard "Cost by model" card, both fed straight from this field. */
    byModel: Record<string, ModelUsage>;
    latencyHistogram: number[];
    /** Cloud Run R-execution service health (R-runner health tracking phase
     *  1) — recorded from routes/solve.ts's runRSafe/recordRRunnerFailure on
     *  EVERY runRRemote call, success or failure, independent of the
     *  solve/interpret route counters above (those track the LLM legs, not
     *  the R-runner call itself). `latencyHistogram` uses `durationMs` as
     *  self-reported by the R-runner service (r-runner/plumber.R), NOT a
     *  Worker-side Date.now() measurement. `coldStartCount` is inferred
     *  Worker-side (durationMs > COLD_START_THRESHOLD_MS) since the R-runner
     *  doesn't report a cold-start flag itself. */
    rRunner: {
      requestCount: number;
      successCount: number;
      errorCount: number;
      coldStartCount: number;
      latencyHistogram: number[];
    };
  };
  client: {
    byQuestionType: Record<string, number>;
    writeBackByOutcome: WriteBackOutcomeCounts;
    /** Write-back outcome cross-tabbed BY question type (dashboard-v2 item 4).
     *  Same telemetry beacon as `byQuestionType` + `writeBackByOutcome`, just
     *  keyed together so "which question types write back badly?" is
     *  answerable. Keys are the client-reported questionType (untrusted —
     *  escape on render). */
    writeBackByQuestionType: Record<string, WriteBackOutcomeCounts>;
    latencyHistogram: number[];
    /** Solve attempts that FAILED BEFORE any result existed (scrape/config/
     *  network/HTTP-reject/timeout), by failure category — the blind spot
     *  writeBackByOutcome can't see (it only hears from attempts that got a
     *  result). Keys are whitelisted server-side in routes/telemetry.ts's
     *  VALID_FAILURES — never raw client strings. */
    byFailure: Record<string, number>;
  };
  /** Distinct SHA-256 install-id hashes seen today, from EITHER a server
   *  event (solve/interpret) or a client telemetry beacon — capped at
   *  INSTALL_HASH_CAP. Feeds DAU/WAU/MAU + retention. Never raw install ids
   *  (see lib/rate-limit.ts's hashBucket, reused here for the exact same hash
   *  so the same install id dedupes across both event sources). */
  installHashes: string[];
  /** Count of free-tier solves rejected at the daily cap (the HTTP 402 in
   *  solve.ts) — the paywall-hit event, the #1 leading indicator of
   *  conversion (dashboard-v2 item 7). Written by recordPaywallHit. */
  paywallHits: number;
  /** Daily subscription-lifecycle flow counts (dashboard-v2 item 6). */
  revenue: RevenueFlowCounts;
}

function emptyRouteCounters(): RouteCounters {
  return { attempts: 0, successes: 0, errors: 0 };
}

function emptyConfidence(): ConfidenceCounts {
  return { High: 0, Med: 0, Low: 0, "": 0 };
}

function emptyWriteBack(): WriteBackOutcomeCounts {
  return { written: 0, nowrite: 0, error: 0 };
}

function emptyRevenue(): RevenueFlowCounts {
  return { created: 0, cancelled: 0, paymentFailed: 0 };
}

export function emptyBucket(date: string): DailyMetricsBucket {
  return {
    date,
    server: {
      routes: { solve: emptyRouteCounters(), interpret: emptyRouteCounters() },
      modeSplit: { concept: 0, calc: 0 },
      confidence: emptyConfidence(),
      confidenceCalc: emptyConfidence(),
      byErrorType: {},
      tokens: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 },
      costUsd: 0,
      costUsdByMode: { concept: 0, calc: 0 },
      byModel: {},
      latencyHistogram: emptyHistogram(),
      rRunner: { requestCount: 0, successCount: 0, errorCount: 0, coldStartCount: 0, latencyHistogram: emptyHistogram() },
    },
    client: {
      byQuestionType: {},
      writeBackByOutcome: emptyWriteBack(),
      writeBackByQuestionType: {},
      latencyHistogram: emptyHistogram(),
      byFailure: {},
    },
    installHashes: [],
    paywallHits: 0,
    revenue: emptyRevenue(),
  };
}

/** Defensively backfills any missing nested fields — protects reads against
 *  a bucket written by an older/newer version of this schema, or KV
 *  corruption. `raw` is untyped by design: that's this function's whole job. */
export function normalizeBucket(raw: unknown, date: string): DailyMetricsBucket {
  const empty = emptyBucket(date);
  if (!raw || typeof raw !== "object") return empty;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- defensive JSON parse, shape is unknown/untrusted by definition
  const r = raw as any;
  const s = r.server ?? {};
  const routes = s.routes ?? {};
  const cl = r.client ?? {};

  const okHist = (h: unknown, want: number): number[] =>
    Array.isArray(h) && h.length === want ? (h as unknown[]).map((x) => Number(x) || 0) : new Array(want).fill(0);

  const okByModel = (v: unknown): Record<string, ModelUsage> => {
    if (!v || typeof v !== "object") return {};
    const out: Record<string, ModelUsage> = {};
    for (const [model, usage] of Object.entries(v as Record<string, unknown>)) {
      const u = (usage ?? {}) as Partial<ModelUsage>;
      out[model] = { calls: Number(u.calls) || 0, costUsd: Number(u.costUsd) || 0 };
    }
    return out;
  };

  /** Coerce an unknown blob into a flat Record<string, number> (byErrorType). */
  const okCountRecord = (v: unknown): Record<string, number> => {
    if (!v || typeof v !== "object") return {};
    const out: Record<string, number> = {};
    for (const [k, n] of Object.entries(v as Record<string, unknown>)) out[k] = Number(n) || 0;
    return out;
  };

  /** Coerce an unknown blob into Record<string, WriteBackOutcomeCounts>. */
  const okWriteBackByType = (v: unknown): Record<string, WriteBackOutcomeCounts> => {
    if (!v || typeof v !== "object") return {};
    const out: Record<string, WriteBackOutcomeCounts> = {};
    for (const [k, o] of Object.entries(v as Record<string, unknown>)) {
      const w = (o ?? {}) as Partial<WriteBackOutcomeCounts>;
      out[k] = {
        written: Number(w.written) || 0,
        nowrite: Number(w.nowrite) || 0,
        error: Number(w.error) || 0,
      };
    }
    return out;
  };

  return {
    date,
    server: {
      routes: {
        solve: { ...empty.server.routes.solve, ...routes.solve },
        interpret: { ...empty.server.routes.interpret, ...routes.interpret },
      },
      modeSplit: { ...empty.server.modeSplit, ...s.modeSplit },
      confidence: { ...empty.server.confidence, ...s.confidence },
      confidenceCalc: { ...empty.server.confidenceCalc, ...s.confidenceCalc },
      byErrorType: okCountRecord(s.byErrorType),
      tokens: { ...empty.server.tokens, ...s.tokens },
      costUsd: typeof s.costUsd === "number" ? s.costUsd : 0,
      costUsdByMode: { ...empty.server.costUsdByMode, ...s.costUsdByMode },
      byModel: okByModel(s.byModel),
      latencyHistogram: okHist(s.latencyHistogram, empty.server.latencyHistogram.length),
      rRunner: {
        ...empty.server.rRunner,
        ...s.rRunner,
        latencyHistogram: okHist(s.rRunner?.latencyHistogram, empty.server.rRunner.latencyHistogram.length),
      },
    },
    client: {
      byQuestionType: typeof cl.byQuestionType === "object" && cl.byQuestionType ? { ...cl.byQuestionType } : {},
      writeBackByOutcome: { ...empty.client.writeBackByOutcome, ...cl.writeBackByOutcome },
      writeBackByQuestionType: okWriteBackByType(cl.writeBackByQuestionType),
      latencyHistogram: okHist(cl.latencyHistogram, empty.client.latencyHistogram.length),
      byFailure: okCountRecord(cl.byFailure),
    },
    installHashes: Array.isArray(r.installHashes)
      ? r.installHashes.filter((h: unknown) => typeof h === "string")
      : [],
    paywallHits: typeof r.paywallHits === "number" ? r.paywallHits : 0,
    revenue: { ...empty.revenue, ...r.revenue },
  };
}

function dateKeyUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function todayUtc(): string {
  return dateKeyUtc(new Date());
}

/** Most-recent-first UTC date keys ending today, e.g. n=3 -> [today, today-1, today-2]. */
export function lastNDatesUtc(n: number, from: Date = new Date()): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(from.getTime());
    d.setUTCDate(d.getUTCDate() - i);
    out.push(dateKeyUtc(d));
  }
  return out;
}

async function readBucket(env: Env, date: string): Promise<DailyMetricsBucket> {
  const raw = await env.STATSHELPR_KV.get(`${KV_PREFIX}${date}`, "json");
  return normalizeBucket(raw, date);
}

async function writeBucket(env: Env, bucket: DailyMetricsBucket): Promise<void> {
  await env.STATSHELPR_KV.put(`${KV_PREFIX}${bucket.date}`, JSON.stringify(bucket), {
    expirationTtl: BUCKET_TTL_SEC,
  });
}

/** Parallel KV reads for GET /api/metrics's N-day window. Same order as `dates`. */
export async function readBucketsForRange(env: Env, dates: string[]): Promise<DailyMetricsBucket[]> {
  return Promise.all(dates.map((d) => readBucket(env, d)));
}

function addInstallHash(bucket: DailyMetricsBucket, hash: string): void {
  if (!hash) return;
  if (bucket.installHashes.includes(hash)) return;
  if (bucket.installHashes.length >= INSTALL_HASH_CAP) return; // cap reached for the day — DAU/WAU
  // undercount past this point; acceptable at current scale (see module header).
  bucket.installHashes.push(hash);
}

export interface ServerEventInput {
  /** Which LEG of the pipeline this event is for — not necessarily an HTTP
   *  route anymore. "solve" covers the first Gemini pass and any R-repair
   *  retry; "interpret" covers the interpret pass. Both are recorded from
   *  inside routes/solve.ts (the standalone /api/interpret route was
   *  retired — see docs/cloud-run-r-migration.md §3); "interpret" is kept
   *  as the label so dashboard cost-by-route continuity holds. */
  route: "solve" | "interpret";
  success: boolean;
  /** Exact model id that actually served this call — Luna's resolveModel(body)
   *  id normally, or the Gemini fallback model (lib/llm.ts's ServedBy.model)
   *  when Luna failed and Gemini answered instead. NEVER a raw/unvalidated
   *  client string either way: routes/solve.ts's ALLOWED_MODELS gate rejects
   *  any body.model other than Luna's before this event is ever constructed,
   *  and the Gemini id (when used) is always one of two server-side
   *  constants selected by a boolean (has an image or not) — see
   *  routes/solve.ts's `geminiModel` and lib/llm.ts's top-of-file SECURITY
   *  note. On a FAILURE event (success: false) this is the request-level
   *  resolved model, not a specific attempt's, since a fully-failed request
   *  has no single call left to attribute it to. */
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  /** Pre-computed via lib/cost.ts's costUsdForUsage(model, ...) — this
   *  event's own model, never a blended rate. */
  costUsd: number;
  serverLatencyMs: number;
  installHash: string;
  /** Stable error class for a FAILED call (dashboard-v2 item 2), from
   *  classifyError() in the route. Ignored when success is true. */
  errorType?: string;
  /** Which cost/token bucket this call's spend belongs to. Omit on error
   *  (no spend to attribute — usage is 0 anyway when a call fails). */
  costMode?: "concept" | "calc";
  /** Set only at the call that finishes a question end-to-end (see the
   *  DailyMetricsBucket.server.modeSplit doc above for why). */
  completedQuestion?: {
    mode: "concept" | "calc";
    /** Recorded per-path now: concept path -> `confidence`, calc path ->
     *  `confidenceCalc` (dashboard-v2 item 16). The interpret leg (recorded
     *  from routes/solve.ts under route:"interpret") should pass its parsed
     *  calc confidence here. */
    confidence?: "High" | "Med" | "Low" | "";
  };
}

/** Pure per-event mutation, shared by the single-event path below and the
 *  per-request batch (flushMetricsBatch) — extracted so batching can't drift
 *  from the one-event semantics. */
function applyServerEvent(bucket: DailyMetricsBucket, input: ServerEventInput): void {
  const r = bucket.server.routes[input.route];
  r.attempts += 1;
  if (input.success) r.successes += 1;
  else {
    r.errors += 1;
    const cls = input.errorType || "unknown";
    bucket.server.byErrorType[cls] = (bucket.server.byErrorType[cls] ?? 0) + 1;
  }

  const modelUsage = bucket.server.byModel[input.model] ?? { calls: 0, costUsd: 0 };
  modelUsage.calls += 1;
  modelUsage.costUsd += input.costUsd;
  bucket.server.byModel[input.model] = modelUsage;

  bucket.server.tokens.promptTokens += input.promptTokens;
  bucket.server.tokens.completionTokens += input.completionTokens;
  bucket.server.tokens.cachedTokens += input.cachedTokens;
  bucket.server.costUsd += input.costUsd;
  if (input.costMode) bucket.server.costUsdByMode[input.costMode] += input.costUsd;

  if (input.completedQuestion) {
    const { mode, confidence: conf } = input.completedQuestion;
    bucket.server.modeSplit[mode] += 1;
    if (conf !== undefined) {
      // Per-path confidence: concept -> `confidence`, calc -> `confidenceCalc`
      // (dashboard-v2 item 16) so low-confidence views cover both paths.
      const target = mode === "calc" ? bucket.server.confidenceCalc : bucket.server.confidence;
      target[conf] = (target[conf] ?? 0) + 1;
    }
  }

  addToHistogram(bucket.server.latencyHistogram, LATENCY_BUCKET_BOUNDARIES_MS, input.serverLatencyMs);
  addInstallHash(bucket, input.installHash);
}

export async function recordServerEvent(env: Env, input: ServerEventInput): Promise<void> {
  try {
    const bucket = await readBucket(env, todayUtc());
    applyServerEvent(bucket, input);
    await writeBucket(env, bucket);
  } catch {
    // Best-effort — metrics must never break or delay a solve.
  }
}

export interface RRunnerEventInput {
  success: boolean;
  /** The R-runner service's own self-reported durationMs (RunRResult.durationMs)
   *  — only present on success; a failed call (network error, 5xx, timeout)
   *  never reaches a durationMs. */
  durationMs?: number;
  /** Worker-side inference (durationMs > threshold — see routes/solve.ts),
   *  since the R-runner doesn't report a cold-start flag itself. Ignored when
   *  success is false. */
  coldStart?: boolean;
}

/** Records one Cloud Run R-execution service call (success or failure),
 *  independent of the solve/interpret route counters (R-runner health
 *  tracking phase 1). Best-effort, matches recordServerEvent's pattern. */
export async function recordRRunnerEvent(env: Env, input: RRunnerEventInput): Promise<void> {
  try {
    const bucket = await readBucket(env, todayUtc());
    applyRRunnerEvent(bucket, input);
    await writeBucket(env, bucket);
  } catch {
    // Best-effort — metrics must never break or delay a solve.
  }
}

/** Pure per-event mutation — see applyServerEvent's note. */
function applyRRunnerEvent(bucket: DailyMetricsBucket, input: RRunnerEventInput): void {
  const rr = bucket.server.rRunner;
  rr.requestCount += 1;
  if (input.success) {
    rr.successCount += 1;
    if (input.coldStart) rr.coldStartCount += 1;
    if (typeof input.durationMs === "number") {
      addToHistogram(rr.latencyHistogram, LATENCY_BUCKET_BOUNDARIES_MS, input.durationMs);
    }
  } else {
    rr.errorCount += 1;
  }
}

export function recordRRunnerEventInBackground(c: EnvContext, input: RRunnerEventInput): void {
  const p = recordRRunnerEvent(c.env, input);
  try {
    c.executionCtx.waitUntil(p);
  } catch {
    /* no ExecutionContext — promise is already running on its own */
  }
}

// ---------------------------------------------------------------------------
// Per-request batching (2026-07-29 DO switch, part B)
// ---------------------------------------------------------------------------

/** Buffers every metrics event one /api/solve request produces so the whole
 *  request costs ONE KV read-modify-write instead of one per event (a calc
 *  solve used to do 4–6). Motivation: the account's KV free plan allows
 *  1,000 writes/day total, and per-event writes made the shared daily bucket
 *  the write-volume majority AND a same-key contention hotspot under
 *  classroom bursts (writes to one key are limited to 1/sec). Batching also
 *  shrinks the read-modify-write race window to one racy write per request
 *  instead of several. Same silent-failure contract as every recorder here:
 *  a lost flush costs one request's events, never the solve. */
export interface MetricsBatch {
  server: ServerEventInput[];
  rRunner: RRunnerEventInput[];
}

export function createMetricsBatch(): MetricsBatch {
  return { server: [], rRunner: [] };
}

export async function flushMetricsBatch(env: Env, batch: MetricsBatch): Promise<void> {
  if (batch.server.length === 0 && batch.rRunner.length === 0) return;
  try {
    const bucket = await readBucket(env, todayUtc());
    for (const ev of batch.server) applyServerEvent(bucket, ev);
    for (const ev of batch.rRunner) applyRRunnerEvent(bucket, ev);
    await writeBucket(env, bucket);
  } catch {
    // Best-effort — metrics must never break or delay a solve.
  }
}

export function flushMetricsBatchInBackground(c: EnvContext, batch: MetricsBatch): void {
  const p = flushMetricsBatch(c.env, batch);
  try {
    c.executionCtx.waitUntil(p);
  } catch {
    /* no ExecutionContext — promise is already running on its own */
  }
}

export interface ClientEventInput {
  questionType: string;
  outcome: "written" | "nowrite" | "error";
  clientLatencyMs: number;
  installHash: string;
}

export async function recordClientEvent(env: Env, input: ClientEventInput): Promise<void> {
  try {
    const bucket = await readBucket(env, todayUtc());

    const type = input.questionType || "unknown";
    bucket.client.byQuestionType[type] = (bucket.client.byQuestionType[type] ?? 0) + 1;
    bucket.client.writeBackByOutcome[input.outcome] += 1;
    // Cross-tab: same outcome, also keyed by question type (dashboard-v2 item 4).
    const wb = bucket.client.writeBackByQuestionType[type] ?? emptyWriteBack();
    wb[input.outcome] += 1;
    bucket.client.writeBackByQuestionType[type] = wb;
    addToHistogram(bucket.client.latencyHistogram, LATENCY_BUCKET_BOUNDARIES_MS, input.clientLatencyMs);
    addInstallHash(bucket, input.installHash);

    await writeBucket(env, bucket);
  } catch {
    // Best-effort.
  }
}

type EnvContext = Context<{ Bindings: Env }>;

/** Fire-and-forget via the request's ExecutionContext so the KV write can't
 *  delay or fail the caller's response. Falls back to a bare fire-and-forget
 *  if no ExecutionContext is available (e.g. outside a real Workers fetch
 *  event) — recordServerEvent never throws, so there's nothing further to
 *  handle in that fallback path. */
export function recordServerEventInBackground(c: EnvContext, input: ServerEventInput): void {
  const p = recordServerEvent(c.env, input);
  try {
    c.executionCtx.waitUntil(p);
  } catch {
    /* no ExecutionContext — promise is already running on its own */
  }
}

export function recordClientEventInBackground(c: EnvContext, input: ClientEventInput): void {
  const p = recordClientEvent(c.env, input);
  try {
    c.executionCtx.waitUntil(p);
  } catch {
    /* no ExecutionContext — promise is already running on its own */
  }
}

export interface ClientFailureInput {
  failure: string;
  installHash: string;
}

/** Record a failure beacon — one bucket increment, the same single
 *  read-modify-write every client beacon already costs (no new KV write
 *  pattern). The failing install still counts as ACTIVE (same reasoning as
 *  recordPaywallHit: a user whose solve died is a user we'd otherwise
 *  undercount in DAU). Best-effort; never throws. */
export async function recordClientFailure(env: Env, input: ClientFailureInput): Promise<void> {
  try {
    const bucket = await readBucket(env, todayUtc());
    bucket.client.byFailure[input.failure] = (bucket.client.byFailure[input.failure] ?? 0) + 1;
    addInstallHash(bucket, input.installHash);
    await writeBucket(env, bucket);
  } catch {
    // Best-effort.
  }
}

export function recordClientFailureInBackground(c: EnvContext, input: ClientFailureInput): void {
  const p = recordClientFailure(c.env, input);
  try {
    c.executionCtx.waitUntil(p);
  } catch {
    /* no ExecutionContext — promise is already running on its own */
  }
}

/** Record a paywall hit — a free-tier solve rejected at the daily cap
 *  (dashboard-v2 item 7). `installHash`, when known, is added to the day's
 *  active-install set too: a user who hit the cap is an ACTIVE user even
 *  though no solve event fired for them. Best-effort; never throws. */
export async function recordPaywallHit(env: Env, installHash?: string): Promise<void> {
  try {
    const bucket = await readBucket(env, todayUtc());
    bucket.paywallHits += 1;
    if (installHash) addInstallHash(bucket, installHash);
    await writeBucket(env, bucket);
  } catch {
    // Best-effort — never break/delay the caller's 402 response.
  }
}

export function recordPaywallHitInBackground(c: EnvContext, installHash?: string): void {
  const p = recordPaywallHit(c.env, installHash);
  try {
    c.executionCtx.waitUntil(p);
  } catch {
    /* no ExecutionContext — promise already running */
  }
}

/** Bump one of today's subscription-lifecycle flow counters (dashboard-v2
 *  item 6), called from routes/lemonsqueezy-webhook.ts. Best-effort; the
 *  webhook's own idempotency guard prevents double-counting on LS retries. */
export async function recordRevenueEvent(env: Env, kind: keyof RevenueFlowCounts): Promise<void> {
  try {
    const bucket = await readBucket(env, todayUtc());
    bucket.revenue[kind] += 1;
    await writeBucket(env, bucket);
  } catch {
    // Best-effort.
  }
}
