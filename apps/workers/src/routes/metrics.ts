import { Hono } from "hono";
import type { Env } from "../types";
import { timingSafeEqualStr } from "@/lib/timing-safe-equal";
import { loadMetrics } from "@/lib/metrics-load";

/**
 * GET /api/metrics — bearer-token-gated read of the last 30 days of product
 * metrics (volume/quality/performance/economics), aggregated from the daily
 * KV buckets lib/metrics-store.ts writes (populated by routes/solve.ts,
 * routes/interpret.ts, and routes/telemetry.ts). The actual read+aggregate
 * lives in lib/metrics-load.ts, shared with routes/dashboard.ts (the
 * server-rendered HTML view) so both stay in sync off one code path.
 *
 * No CORS middleware here: this is a server-to-server / dashboard-fetch
 * endpoint gated by METRICS_TOKEN, not something the extension calls from a
 * page origin — contrast with /api/telemetry, which explicitly needs open
 * CORS since it IS called from the extension's content-script context.
 */

export const metrics = new Hono<{ Bindings: Env }>();

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

  // Optional ?days= override (dashboard-v2 item 14). Pass a positive integer
  // through to loadMetrics; anything else falls back to its default window.
  const rawDays = Number(c.req.query("days"));
  const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.floor(rawDays) : undefined;

  const result = await loadMetrics(c.env, days);
  return c.json(result);
});
