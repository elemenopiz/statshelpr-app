import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { Env } from "../types";
import { timingSafeEqualStr } from "@/lib/timing-safe-equal";
import { loadMetrics } from "@/lib/metrics-load";
import { buildMockMetrics } from "@/lib/metrics-mock";
import type { MetricsResponse } from "@/lib/metrics-aggregate";
import { renderDashboardPage, renderUnavailablePage, renderUnauthorizedPage } from "@/lib/dashboard-render";

/**
 * GET /dashboard — server-rendered founder metrics dashboard. Cloudflare
 * replacement for the old apps/api/app/dashboard (Next.js/Vercel, now
 * removed — see apps/api/.env.example's git history for the old
 * METRICS_API_URL/METRICS_TOKEN client-fetch config that this obsoletes).
 * Reads the last 30 daily KV buckets and aggregates them IN-PROCESS via
 * lib/metrics-load.ts (the same helper routes/metrics.ts's JSON API uses) —
 * no HTTP round-trip to our own /api/metrics, no bearer token needed here
 * since we already have the KV binding.
 *
 * Access gate ported from apps/api/proxy.ts: require `?key=<DASHBOARD_
 * PASSWORD>` OR a previously-set `sh_dash_key` cookie. On a valid ?key=,
 * set the cookie so later visits don't need the query param. Fails CLOSED —
 * if DASHBOARD_PASSWORD is unset, nobody gets in, including ?demo=1.
 */

export const dashboard = new Hono<{ Bindings: Env }>();

const COOKIE_NAME = "sh_dash_key";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

type LoadResult = { ok: true; data: MetricsResponse } | { ok: false; reason: string };

async function loadDashboardData(env: Env, isDemo: boolean): Promise<LoadResult> {
  if (isDemo) {
    return { ok: true, data: buildMockMetrics() };
  }
  try {
    const data = await loadMetrics(env);
    return { ok: true, data };
  } catch (e) {
    return {
      ok: false,
      reason: `Could not read metrics from KV: ${(e as Error)?.message || "unknown error"}`,
    };
  }
}

dashboard.get("/", async (c) => {
  const password = c.env.DASHBOARD_PASSWORD;

  // Fail CLOSED: an unset secret locks the route for everyone, not just
  // unauthenticated requests — same contract as METRICS_TOKEN in
  // routes/metrics.ts, extended here to cover ?demo=1 too.
  if (!password) {
    return c.html(
      renderUnauthorizedPage(
        "DASHBOARD_PASSWORD is not configured on this worker, so /dashboard is fully locked. " +
          "Set it with `wrangler secret put DASHBOARD_PASSWORD` (see wrangler.toml) to enable access.",
      ),
      401,
    );
  }

  const keyParam = c.req.query("key") ?? "";
  const cookieVal = getCookie(c, COOKIE_NAME) ?? "";
  // Constant-time-ish compare (same helper as METRICS_TOKEN) — avoid a
  // naive `===` leaking the secret's length/content via timing.
  const keyMatches = keyParam.length > 0 && timingSafeEqualStr(keyParam, password);
  const cookieMatches = cookieVal.length > 0 && timingSafeEqualStr(cookieVal, password);

  if (!keyMatches && !cookieMatches) {
    return c.html(
      renderUnauthorizedPage("Missing or invalid access key. Append ?key=<DASHBOARD_PASSWORD> to the URL."),
      401,
    );
  }

  // Persist the cookie once so links within the dashboard don't all need
  // ?key= appended on every request. Only set it when it isn't already
  // correctly set, to avoid rewriting the response header every time.
  if (keyMatches && !cookieMatches) {
    setCookie(c, COOKIE_NAME, password, {
      httpOnly: true,
      sameSite: "Lax",
      secure: true,
      maxAge: COOKIE_MAX_AGE_SECONDS,
      path: "/dashboard",
    });
  }

  const isDemo = c.req.query("demo") === "1";
  const result = await loadDashboardData(c.env, isDemo);

  if (!result.ok) {
    return c.html(renderUnavailablePage(result.reason));
  }

  return c.html(renderDashboardPage(result.data, isDemo));
});
