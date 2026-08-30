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
 *
 * This layer also owns the four cross-cutting enrichments that need either
 * KV, a second (prior) window, or an external API, and so can't live in the
 * pure aggregator (dashboard-v2 items 6, 8, 10; R-runner health phase 2):
 *   - the live active-subscriber count, scanned from the `sub:` KV keyspace;
 *   - window-over-window deltas, by aggregating the immediately-preceding
 *     window and diffing the two;
 *   - new-install + retention cohorts, computed over a 2×window lookback by
 *     the pure helpers in lib/cohort.ts and overlaid onto the response;
 *   - live Cloud Run infra metrics (free-tier burn, cold-start latency) for
 *     the R-runner service, fetched straight from GCP Cloud Monitoring (not
 *     KV) by lib/gcp-monitoring.ts and overlaid the same way.
 */

import type { Env } from "../types";
import { emptyBucket, lastNDatesUtc, readBucketsForRange } from "./metrics-store";
import { aggregateMetrics, type MetricsResponse } from "./metrics-aggregate";
import { computeCohorts, type CohortResult } from "./cohort";
import { fetchCloudRunMetrics } from "./gcp-monitoring";

export const METRICS_RANGE_DAYS = 30;

/** Fixed per the pinned contract's `priceMonthlyUsd: 15` — this is the
 *  product's subscription price, not something an env var should move. */
const PRICE_MONTHLY_USD = 14.99;
const DEFAULT_AVG_SOLVES_PER_USER_PER_MONTH = 110;

function complimentaryCustomerIds(env: Env): Set<string> {
  return new Set((env.COMPLIMENTARY_CUSTOMER_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean));
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Reads the last `days` daily KV buckets (default `METRICS_RANGE_DAYS`) and
 * aggregates them, then enriches with the live active-subscriber count,
 * window-over-window deltas, and new-install/retention cohorts.
 *
 * A second, immediately-preceding window of the same length is read too (so
 * the total KV read is `2 * days` buckets) to power the deltas and cohorts.
 *
 * Throws if the underlying KV reads fail — callers that must not crash on a
 * transient KV error (e.g. routes/dashboard.ts) should wrap this in a
 * try/catch and render a fallback state instead of letting it propagate.
 *
 * NOTE: signature `loadMetrics(env, days?)` is a contract the render + cron
 * agents depend on — do not change it. Omitting `days` reproduces the prior
 * default range (30 days).
 */
export async function loadMetrics(env: Env, days: number = METRICS_RANGE_DAYS): Promise<MetricsResponse> {
  const windowDays = Math.max(1, Math.floor(days) || METRICS_RANGE_DAYS);

  // 2×window lookback, most-recent-first. First `windowDays` = current window;
  // the rest = the immediately-preceding window (deltas + cohort baseline).
  const lookbackDates = lastNDatesUtc(2 * windowDays);
  const currentDates = lookbackDates.slice(0, windowDays);
  const priorDates = lookbackDates.slice(windowDays);
  const rawBuckets = await readBucketsForRange(env, lookbackDates);

  // Pre-launch dev/testing buckets are swapped for empty ones rather than
  // read out of KV differently, so cohorts/deltas below see a real (empty)
  // bucket per date instead of needing separate "hidden" branching.
  const launchDate = env.METRICS_LAUNCH_DATE;
  const allBuckets = launchDate
    ? rawBuckets.map((b, i) => {
        const date = lookbackDates[i] ?? b.date;
        return date < launchDate ? emptyBucket(date) : b;
      })
    : rawBuckets;

  const currentBuckets = allBuckets.slice(0, windowDays);
  const priorBuckets = allBuckets.slice(windowDays);

  const assumedSolvesPerUserPerMonth =
    Number(env.AVG_SOLVES_PER_USER_PER_MONTH ?? String(DEFAULT_AVG_SOLVES_PER_USER_PER_MONTH)) ||
    DEFAULT_AVG_SOLVES_PER_USER_PER_MONTH;

  const activeSubscribers = await countActiveSubscribers(env);
  const now = Date.now();

  const current = aggregateMetrics({
    now,
    days: windowDays,
    dates: currentDates,
    buckets: currentBuckets,
    priceMonthlyUsd: PRICE_MONTHLY_USD,
    assumedSolvesPerUserPerMonth,
    activeSubscribers,
  });

  // Prior window, for window-over-window deltas (item 10). We only store the
  // CURRENT point-in-time active count, never a historical one, so the prior
  // MRR/active figures are APPROXIMATED by walking back the 30d net-new flow:
  // priorActive = activeSubscribers - (created30d - cancelled30d), floored at
  // 0. Its churn/margin are indicative, not audited — good enough for a trend
  // arrow, not for accounting.
  const priorActive = Math.max(0, activeSubscribers - current.revenue.netNewSubs30d);
  const prior = aggregateMetrics({
    now,
    days: windowDays,
    dates: priorDates,
    buckets: priorBuckets,
    priceMonthlyUsd: PRICE_MONTHLY_USD,
    assumedSolvesPerUserPerMonth,
    activeSubscribers: priorActive,
  });

  current.comparison = {
    prevRangeDays: windowDays,
    deltaPct: buildDeltaPct(current, prior),
  };

  // New-install + retention cohorts over the whole 2×window lookback (item 8).
  const cohortDays = allBuckets.map((b, i) => ({
    date: lookbackDates[i] ?? b.date,
    installHashes: b.installHashes,
  }));
  const cohorts = computeCohorts(cohortDays, new Set(currentDates));
  overlayCohorts(current, cohorts);

  // Live GCP fetch (R-runner health phase 2) — fetchCloudRunMetrics is
  // documented to never throw, but this call is wrapped anyway (belt and
  // suspenders): a GCP-side failure of ANY kind must degrade to the
  // "unavailable" shape the renderer already knows how to show, never take
  // the rest of loadMetrics (and therefore the whole dashboard) down with it.
  try {
    current.cloudRun = await fetchCloudRunMetrics(env);
  } catch (e) {
    current.cloudRun = {
      available: false,
      unavailableReason: `unexpected error: ${(e as Error)?.message || "unknown"}`,
      billableInstanceTime: null,
      startupLatency: null,
    };
  }

  return current;
}

  /** Live active-subscriber count from the `sub:` KV keyspace (item 6). Follows
 *  the list cursor so it doesn't stop at the first KV page. Records that fail
 *  to parse are skipped rather than aborting the whole scan.
 *
 *  Exported (2026-08-04, owner directive) so src/index.ts's scheduled cron
 *  can reuse this SAME scan once/day to feed
 *  lib/kill-switch.ts's subscriber-scaled global spend ceiling
 *  (computeEffectiveSpendLimitUsd/persistEffectiveSpendLimit) — this is an
 *  O(subscriber-count) KV list+get walk, fine once/day, NOT something the
 *  per-solve hot path should ever call directly. */
export async function countActiveSubscribers(env: Env): Promise<number> {
  // Lemon Squeezy can emit more than one subscription record for the same
  // customer during migrations/retries. MRR is customer-based, so dedupe
  // active records by customerId; subscription key is only the fallback for
  // legacy records that lack a customer id.
  const activeCustomers = new Set<string>();
  const complimentary = complimentaryCustomerIds(env);
  let cursor: string | undefined = undefined;

  for (;;) {
    const page: KVNamespaceListResult<unknown, string> = await env.STATSHELPR_KV.list({
      prefix: "sub:",
      cursor,
    });
    for (const key of page.keys) {
      try {
        const rec = (await env.STATSHELPR_KV.get(key.name, "json")) as
          | { status?: string; customerId?: number }
          | null;
        if (rec?.status === "active") {
          const identity = rec.customerId !== undefined
            ? `customer:${rec.customerId}`
            : `subscription:${key.name}`;
          if (rec.customerId === undefined || !complimentary.has(String(rec.customerId))) {
            activeCustomers.add(identity);
          }
        }
      } catch {
        // Unparseable/corrupt record — skip, don't fail the scan.
      }
    }
    if (page.list_complete) break;
    cursor = page.cursor;
  }

  return activeCustomers.size;
}

/** (curr - prev)/prev * 100, rounded; null when prev is 0 (no baseline). */
function pctDelta(curr: number, prev: number): number | null {
  if (prev === 0) return null;
  return round2(((curr - prev) / prev) * 100);
}

/** Window-over-window percent change for the headline metrics (item 10). */
function buildDeltaPct(curr: MetricsResponse, prev: MetricsResponse): Record<string, number | null> {
  const pairs: Record<string, [number, number]> = {
    questionsAnswered: [curr.volume.questionsAnswered, prev.volume.questionsAnswered],
    apiCalls: [curr.volume.apiCalls, prev.volume.apiCalls],
    solveSuccessRate: [curr.quality.solveSuccessRate, prev.quality.solveSuccessRate],
    errorsTotal: [curr.quality.errorsTotal, prev.quality.errorsTotal],
    totalCostUsd: [curr.economics.totalCostUsd, prev.economics.totalCostUsd],
    avgCostPerQuestionUsd: [curr.economics.avgCostPerQuestionUsd, prev.economics.avgCostPerQuestionUsd],
    cacheHitRate: [curr.economics.cacheHitRate, prev.economics.cacheHitRate],
    dau: [curr.volume.dau, prev.volume.dau],
    wau: [curr.volume.wau, prev.volume.wau],
    mau: [curr.volume.mau, prev.volume.mau],
    mrrUsd: [curr.revenue.mrrUsd, prev.revenue.mrrUsd],
    activeSubscribers: [curr.revenue.activeSubscribers, prev.revenue.activeSubscribers],
    paywallHits30d: [curr.funnel.paywallHits30d, prev.funnel.paywallHits30d],
    writeBackSuccessRate: [curr.quality.writeBackSuccessRate, prev.quality.writeBackSuccessRate],
  };

  const out: Record<string, number | null> = {};
  for (const [metric, [a, b]] of Object.entries(pairs)) out[metric] = pctDelta(a, b);
  return out;
}

/** Overlay the cohort pass onto the current-window response in place: the
 *  daily new-install series + its total, the funnel's 30d new-installs, and
 *  the retention block (item 8). `daily` already holds exactly the current
 *  window, so its newInstalls sum IS the window total. */
function overlayCohorts(resp: MetricsResponse, cohorts: CohortResult): void {
  let totalNewInstalls = 0;
  for (const point of resp.volume.daily) {
    const n = cohorts.newInstallsByDate[point.date] ?? 0;
    point.newInstalls = n;
    totalNewInstalls += n;
  }
  resp.volume.newInstalls = totalNewInstalls;
  resp.funnel.newInstalls30d = totalNewInstalls;
  resp.retention = {
    nextDayRetentionPct: cohorts.nextDayRetentionPct,
    sevenDayRetentionPct: cohorts.sevenDayRetentionPct,
    returningSharePct: cohorts.returningSharePct,
  };
}
