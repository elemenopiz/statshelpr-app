/**
 * Daily KPI snapshot rollup (dashboard-v2 item 15).
 *
 * The raw per-day metric buckets (`metrics:YYYY-MM-DD`, lib/metrics-store.ts)
 * expire on their own TTL, so the derived KPIs computed over them are lost
 * once the buckets age out. This module persists a COMPACT snapshot of those
 * derived KPIs once a day (driven by the `scheduled` cron handler in
 * src/index.ts) under `snapshot:YYYY-MM-DD`, with a long TTL, so long-range
 * trend history survives even after the raw buckets are gone.
 *
 * Snapshots are write-only for now — surfacing them in the dashboard UI is a
 * deliberate follow-up. `readSnapshot` exists so the alerting path can diff
 * today against a prior snapshot (see lib/alerts.ts), and for that later UI.
 *
 * Depends on Env/KV, so it lives here rather than in the pure aggregator.
 */

import type { Env } from "../types";
import { loadMetrics } from "./metrics-load";
import type { MetricsResponse } from "./metrics-aggregate";

/** ~400 days, so a full year of daily snapshots is always readable for
 *  year-over-year trends with headroom. Comfortably longer than the raw
 *  buckets' TTL, which is the whole point of rolling these up. */
export const SNAPSHOT_TTL_SECONDS = 400 * 24 * 60 * 60;

/** UTC `YYYY-MM-DD` for a timestamp (default: now). Matches the date format
 *  used for the raw metric buckets (lib/metrics-store.ts `dateKeyUtc`). */
export function utcDateKey(ts: number = Date.now()): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** KV key for a given day's snapshot. */
export function snapshotKey(date: string): string {
  return `snapshot:${date}`;
}

/**
 * Compact, derived KPIs preserved per day. Deliberately a small subset of the
 * full MetricsResponse — just the headline health/economics/revenue figures
 * whose trend we want to outlive the raw buckets. `paymentFailed30d` is kept
 * here (beyond the pure trend set) specifically so the alerting path can
 * detect a day-over-day rise against the previous snapshot (lib/alerts.ts).
 */
export interface Snapshot {
  /** UTC `YYYY-MM-DD` this snapshot summarizes. */
  date: string;
  /** Unix ms when the snapshot was taken. */
  capturedAt: number;
  solveSuccessRate: number;
  errorsTotal: number;
  totalCostUsd: number;
  avgCostPerQuestionUsd: number;
  cacheHitRate: number;
  dau: number;
  wau: number;
  mau: number;
  questionsAnswered: number;
  writeBackSuccessRate: number;
  revenue: {
    activeSubscribers: number;
    mrrUsd: number;
    realGrossMarginPct: number | null;
    churnRatePct: number | null;
    /** Carried for the "payment-failed" alert's day-over-day diff. */
    paymentFailed30d: number;
  };
}

/** Project the full metrics response down to the compact snapshot. Pure. */
export function toSnapshot(date: string, capturedAt: number, m: MetricsResponse): Snapshot {
  return {
    date,
    capturedAt,
    solveSuccessRate: m.quality.solveSuccessRate,
    errorsTotal: m.quality.errorsTotal,
    totalCostUsd: m.economics.totalCostUsd,
    avgCostPerQuestionUsd: m.economics.avgCostPerQuestionUsd,
    cacheHitRate: m.economics.cacheHitRate,
    dau: m.volume.dau,
    wau: m.volume.wau,
    mau: m.volume.mau,
    questionsAnswered: m.volume.questionsAnswered,
    writeBackSuccessRate: m.quality.writeBackSuccessRate,
    revenue: {
      activeSubscribers: m.revenue.activeSubscribers,
      mrrUsd: m.revenue.mrrUsd,
      realGrossMarginPct: m.revenue.realGrossMarginPct,
      churnRatePct: m.revenue.churnRatePct,
      paymentFailed30d: m.revenue.paymentFailed30d,
    },
  };
}

/**
 * Load the current metrics, project them to a compact snapshot, and persist it
 * under today's `snapshot:YYYY-MM-DD` key (UTC) with a ~400-day TTL. Returns
 * the snapshot that was written. Throws only if `loadMetrics` or the KV write
 * fails — the cron handler wraps this so a failure never escapes the worker.
 */
export async function writeDailySnapshot(env: Env): Promise<Snapshot> {
  const capturedAt = Date.now();
  const date = utcDateKey(capturedAt);
  const metrics = await loadMetrics(env);
  const snapshot = toSnapshot(date, capturedAt, metrics);
  await env.STATSHELPR_KV.put(snapshotKey(date), JSON.stringify(snapshot), {
    expirationTtl: SNAPSHOT_TTL_SECONDS,
  });
  return snapshot;
}

/** Read a persisted snapshot by UTC date (`YYYY-MM-DD`). Null if none. */
export async function readSnapshot(env: Env, date: string): Promise<Snapshot | null> {
  return (await env.STATSHELPR_KV.get(snapshotKey(date), "json")) as Snapshot | null;
}
