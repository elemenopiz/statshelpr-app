import { Hono } from "hono";
import type { Env } from "../types";
import { timingSafeEqualStr } from "@/lib/timing-safe-equal";
import { lastNDatesUtc, readBucketsForRange } from "@/lib/metrics-store";
import { aggregateMetrics } from "@/lib/metrics-aggregate";

/**
 * GET /api/metrics — bearer-token-gated read of the last 30 days of product
 * metrics (volume/quality/performance/economics), aggregated from the daily
 * KV buckets lib/metrics-store.ts writes (populated by routes/solve.ts,
 * routes/interpret.ts, and routes/telemetry.ts).
 *
 * No CORS middleware here: this is a server-to-server / dashboard-fetch
 * endpoint gated by METRICS_TOKEN, not something the extension calls from a
 * page origin — contrast with /api/telemetry, which explicitly needs open
 * CORS since it IS called from the extension's content-script context.
 */

export const metrics = new Hono<{ Bindings: Env }>();

const RANGE_DAYS = 30;
/** Fixed per the pinned contract's `priceMonthlyUsd: 15` — this is the
 *  product's subscription price, not something an env var should move. */
const PRICE_MONTHLY_USD = 15;
const DEFAULT_AVG_SOLVES_PER_USER_PER_MONTH = 110;

metrics.get("/", async (c) => {
  const token = c.env.METRICS_TOKEN;
  const auth = c.req.header("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";

  // Constant-time-ish compare; also reject outright if the secret isn't
  // configured at all (never silently "allow" like validateLicense does for
  // LS — an unset METRICS_TOKEN should hard-fail closed, not open).
  if (!token || !provided || !timingSafeEqualStr(token, provided)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const dates = lastNDatesUtc(RANGE_DAYS); // most-recent-first
  const buckets = await readBucketsForRange(c.env, dates);

  const assumedSolvesPerUserPerMonth =
    Number(c.env.AVG_SOLVES_PER_USER_PER_MONTH ?? String(DEFAULT_AVG_SOLVES_PER_USER_PER_MONTH)) ||
    DEFAULT_AVG_SOLVES_PER_USER_PER_MONTH;

  const result = aggregateMetrics({
    now: Date.now(),
    days: RANGE_DAYS,
    dates,
    buckets,
    priceMonthlyUsd: PRICE_MONTHLY_USD,
    assumedSolvesPerUserPerMonth,
  });

  return c.json(result);
});
