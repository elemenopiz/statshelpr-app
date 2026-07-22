/**
 * Env-dependent glue between lib/metrics-store.ts (KV reads) and
 * lib/metrics-aggregate.ts (pure aggregation): reads the last N daily
 * buckets and aggregates them into the GET /api/metrics response shape.
 *
 * Pulled out of routes/metrics.ts so both routes/metrics.ts (JSON API) and
 * routes/dashboard.ts (server-rendered HTML) call the exact same code path
 * instead of the dashboard re-implementing it or making an HTTP round-trip
 * to its own worker. Kept separate from metrics-aggregate.ts (rather than
 * added there) so that module can stay dependency-free/pure per its own
 * header doc — this one is the only piece that touches Env/KV.
 */

import type { Env } from "../types";
import { lastNDatesUtc, readBucketsForRange } from "./metrics-store";
import { aggregateMetrics, type MetricsResponse } from "./metrics-aggregate";

export const METRICS_RANGE_DAYS = 30;

/** Fixed per the pinned contract's `priceMonthlyUsd: 15` — this is the
 *  product's subscription price, not something an env var should move. */
const PRICE_MONTHLY_USD = 15;
const DEFAULT_AVG_SOLVES_PER_USER_PER_MONTH = 110;

/** Reads the last `METRICS_RANGE_DAYS` daily KV buckets and aggregates them.
 *  Throws if the underlying KV reads fail — callers that must not crash on a
 *  transient KV error (e.g. routes/dashboard.ts) should wrap this in a
 *  try/catch and render a fallback state instead of letting it propagate. */
export async function loadMetrics(env: Env): Promise<MetricsResponse> {
  const dates = lastNDatesUtc(METRICS_RANGE_DAYS); // most-recent-first
  const buckets = await readBucketsForRange(env, dates);

  const assumedSolvesPerUserPerMonth =
    Number(env.AVG_SOLVES_PER_USER_PER_MONTH ?? String(DEFAULT_AVG_SOLVES_PER_USER_PER_MONTH)) ||
    DEFAULT_AVG_SOLVES_PER_USER_PER_MONTH;

  return aggregateMetrics({
    now: Date.now(),
    days: METRICS_RANGE_DAYS,
    dates,
    buckets,
    priceMonthlyUsd: PRICE_MONTHLY_USD,
    assumedSolvesPerUserPerMonth,
  });
}
