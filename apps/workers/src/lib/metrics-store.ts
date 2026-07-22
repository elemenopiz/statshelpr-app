/**
 * KV-backed daily metrics buckets: server-side call counters/cost/latency
 * plus client-reported write-back outcomes, merged at read time by
 * lib/metrics-aggregate.ts (called from routes/metrics.ts). Written by
 * routes/solve.ts, routes/interpret.ts (server events) and
 * routes/telemetry.ts (client beacon events).
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
 * without touching solve.ts/interpret.ts/telemetry.ts's call sites.
 */

import type { Context } from "hono";
import type { Env } from "../types";
import { addToHistogram, emptyHistogram, LATENCY_BUCKET_BOUNDARIES_MS } from "./histogram";

const KV_PREFIX = "metrics:";
const BUCKET_TTL_SEC = 40 * 86_400; // 30-day read window + margin
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

export interface DailyMetricsBucket {
  date: string;
  server: {
    routes: { solve: RouteCounters; interpret: RouteCounters };
    /** Completed-question counts (NOT raw call counts — see recordServerEvent's
     *  `completedQuestion` doc below). `concept` increments once per concept
     *  answer (solve.ts). `calc` increments once per completed calc answer,
     *  at interpret.ts's success — NOT at solve.ts's RCODE handoff, which
     *  would double-count (a calc question spans two LLM calls). */
    modeSplit: { concept: number; calc: number };
    /** Solve-concept-path confidence only, per the pinned contract's explicit
     *  "(solve concept path)" scoping — calc-path confidence isn't folded in
     *  here (interpret.ts's own confidence isn't wired into this counter). */
    confidence: ConfidenceCounts;
    tokens: { promptTokens: number; completionTokens: number; cachedTokens: number };
    /** Grand total of every event's costUsd, success or error (errors cost
     *  ~0 anyway since there's no usage to bill). */
    costUsd: number;
    /** Same total, split by which question-mode the spend is attributable
     *  to. A calc question costs two LLM calls (solve.ts's RCODE generation
     *  + interpret.ts's interpretation); both legs' cost land in `calc` so
     *  avgCostPerCalcQuestionUsd reflects the true pipeline cost. */
    costUsdByMode: { concept: number; calc: number };
    /** Per-model call count + cost, keyed on the exact model id
     *  `resolveModel(body)` returned for that call (see lib/cost.ts —
     *  gemini-3.5-flash-lite for text, gemini-3.6-flash for image
     *  questions). Each event is costed at ITS OWN model's rate, never a
     *  blended rate — this is the audit trail for that split. */
    byModel: Record<string, ModelUsage>;
    latencyHistogram: number[];
  };
  client: {
    byQuestionType: Record<string, number>;
    writeBackByOutcome: { written: number; nowrite: number; error: number };
    latencyHistogram: number[];
  };
  /** Distinct SHA-256 install-id hashes seen today, from EITHER a server
   *  event (solve/interpret) or a client telemetry beacon — capped at
   *  INSTALL_HASH_CAP. Feeds DAU/WAU. Never raw install ids (see
   *  lib/rate-limit.ts's hashBucket, reused here for the exact same hash so
   *  the same install id dedupes across both event sources). */
  installHashes: string[];
}

function emptyRouteCounters(): RouteCounters {
  return { attempts: 0, successes: 0, errors: 0 };
}

function emptyConfidence(): ConfidenceCounts {
  return { High: 0, Med: 0, Low: 0, "": 0 };
}

export function emptyBucket(date: string): DailyMetricsBucket {
  return {
    date,
    server: {
      routes: { solve: emptyRouteCounters(), interpret: emptyRouteCounters() },
      modeSplit: { concept: 0, calc: 0 },
      confidence: emptyConfidence(),
      tokens: { promptTokens: 0, completionTokens: 0, cachedTokens: 0 },
      costUsd: 0,
      costUsdByMode: { concept: 0, calc: 0 },
      byModel: {},
      latencyHistogram: emptyHistogram(),
    },
    client: {
      byQuestionType: {},
      writeBackByOutcome: { written: 0, nowrite: 0, error: 0 },
      latencyHistogram: emptyHistogram(),
    },
    installHashes: [],
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

  return {
    date,
    server: {
      routes: {
        solve: { ...empty.server.routes.solve, ...routes.solve },
        interpret: { ...empty.server.routes.interpret, ...routes.interpret },
      },
      modeSplit: { ...empty.server.modeSplit, ...s.modeSplit },
      confidence: { ...empty.server.confidence, ...s.confidence },
      tokens: { ...empty.server.tokens, ...s.tokens },
      costUsd: typeof s.costUsd === "number" ? s.costUsd : 0,
      costUsdByMode: { ...empty.server.costUsdByMode, ...s.costUsdByMode },
      byModel: okByModel(s.byModel),
      latencyHistogram: okHist(s.latencyHistogram, empty.server.latencyHistogram.length),
    },
    client: {
      byQuestionType: typeof cl.byQuestionType === "object" && cl.byQuestionType ? { ...cl.byQuestionType } : {},
      writeBackByOutcome: { ...empty.client.writeBackByOutcome, ...cl.writeBackByOutcome },
      latencyHistogram: okHist(cl.latencyHistogram, empty.client.latencyHistogram.length),
    },
    installHashes: Array.isArray(r.installHashes)
      ? r.installHashes.filter((h: unknown) => typeof h === "string")
      : [],
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
  route: "solve" | "interpret";
  success: boolean;
  /** Exact model id this call used (resolveModel(body) — text vs image). */
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  /** Pre-computed via lib/cost.ts's costUsdForUsage(model, ...) — this
   *  event's own model, never a blended rate. */
  costUsd: number;
  serverLatencyMs: number;
  installHash: string;
  /** Which cost/token bucket this call's spend belongs to. Omit on error
   *  (no spend to attribute — usage is 0 anyway when a call fails). */
  costMode?: "concept" | "calc";
  /** Set only at the call that finishes a question end-to-end (see the
   *  DailyMetricsBucket.server.modeSplit doc above for why). */
  completedQuestion?: {
    mode: "concept" | "calc";
    /** Per the pinned contract, confidence is recorded "(solve concept
     *  path)" only — interpret.ts's completedQuestion omits this. */
    confidence?: "High" | "Med" | "Low" | "";
  };
}

export async function recordServerEvent(env: Env, input: ServerEventInput): Promise<void> {
  try {
    const bucket = await readBucket(env, todayUtc());

    const r = bucket.server.routes[input.route];
    r.attempts += 1;
    if (input.success) r.successes += 1;
    else r.errors += 1;

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
      bucket.server.modeSplit[input.completedQuestion.mode] += 1;
      const conf = input.completedQuestion.confidence;
      if (conf !== undefined) {
        bucket.server.confidence[conf] = (bucket.server.confidence[conf] ?? 0) + 1;
      }
    }

    addToHistogram(bucket.server.latencyHistogram, LATENCY_BUCKET_BOUNDARIES_MS, input.serverLatencyMs);
    addInstallHash(bucket, input.installHash);

    await writeBucket(env, bucket);
  } catch {
    // Best-effort — metrics must never break or delay a solve.
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
