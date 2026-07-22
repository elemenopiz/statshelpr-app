import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Env } from "../types";
import { timingSafeEqualStr } from "@/lib/timing-safe-equal";
import { loadMetrics } from "@/lib/metrics-load";
import { buildMockMetrics } from "@/lib/metrics-mock";
import type { MetricsResponse } from "@/lib/metrics-aggregate";
import { renderDashboardPage, renderUnavailablePage, renderLoginPage } from "@/lib/dashboard-render";

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
 * Access gate: a real login form, NOT a URL secret (that old `?key=`
 * pattern — ported from apps/api/proxy.ts — leaked the password via browser
 * history, bookmarks, and shared links, so it's gone; a stale `?key=`
 * query param is simply ignored now, it never authenticates). Auth lives in
 * two extra routes:
 *
 *   - POST /dashboard/login — reads `password` from an
 *     application/x-www-form-urlencoded body, constant-time-compares it to
 *     DASHBOARD_PASSWORD, and on success sets an httpOnly session cookie
 *     holding hex(SHA-256(DASHBOARD_PASSWORD)) (see sessionTokenFor below)
 *     — a derived token, never the raw password, so a stolen cookie can't
 *     be turned back into the secret and can't be forged without it. 302s
 *     to /dashboard on success; re-renders the login page at 401 on a bad
 *     password.
 *   - GET /dashboard/logout — clears the session cookie, 302s back to
 *     /dashboard (which then shows the login page, cookie gone).
 *
 * GET /dashboard itself just checks the session cookie: valid → render the
 * dashboard (unchanged; ?demo=1 still toggles mock data, still behind
 * auth); missing/invalid → serve the login page at 200 (a login prompt
 * isn't an error page, unlike a failed login POST, which is the only case
 * that 401s). Fails CLOSED — if DASHBOARD_PASSWORD is unset, no password
 * anyone types can ever succeed (see POST /login below), including
 * ?demo=1.
 */

export const dashboard = new Hono<{ Bindings: Env }>();

const COOKIE_NAME = "sh_dash_session";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // ~7 days
const COOKIE_PATH = "/dashboard";

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

/**
 * hex(SHA-256(password)) — the session-cookie value. One-way: the cookie
 * can't be turned back into DASHBOARD_PASSWORD (SHA-256 preimage
 * resistance), but the password always reproduces the same token, which is
 * all the session check needs to recompute and compare below. Deliberately
 * NOT truncated like the 128-bit KV-key hashes elsewhere in lib/
 * (rate-limit.ts's hashBucket, license-activation.ts's sha256Hex, etc.) —
 * those guard dedupe keys, this one substitutes for a login, so it keeps
 * the full 256 bits.
 */
async function sessionTokenFor(password: string): Promise<string> {
  const buf = new TextEncoder().encode(password);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Valid only when DASHBOARD_PASSWORD is set AND the cookie's token matches
 *  its derived digest — constant-time compare, same rationale as the old
 *  ?key= check this replaces (avoid leaking the token via response timing).
 *  An unset password always fails here, so no cookie is ever "valid" —
 *  that's the fail-closed contract in the doc comment above. */
async function hasValidSession(cookieVal: string, password: string | undefined): Promise<boolean> {
  if (!password || !cookieVal) return false;
  const expected = await sessionTokenFor(password);
  return timingSafeEqualStr(cookieVal, expected);
}

dashboard.get("/", async (c) => {
  const password = c.env.DASHBOARD_PASSWORD;
  const cookieVal = getCookie(c, COOKIE_NAME) ?? "";

  if (!(await hasValidSession(cookieVal, password))) {
    // Login prompt, not an error page — 200, per the doc comment above.
    return c.html(renderLoginPage({ notConfigured: !password }), 200);
  }

  const isDemo = c.req.query("demo") === "1";
  const result = await loadDashboardData(c.env, isDemo);

  if (!result.ok) {
    return c.html(renderUnavailablePage(result.reason));
  }

  return c.html(renderDashboardPage(result.data, isDemo));
});

dashboard.post("/login", async (c) => {
  const password = c.env.DASHBOARD_PASSWORD;

  // Fail CLOSED: an unset secret means login can never succeed for anyone
  // — same contract the old ?key= gate had, and METRICS_TOKEN in
  // routes/metrics.ts has. Don't even look at the submitted body.
  if (!password) {
    return c.html(renderLoginPage({ notConfigured: true }), 401);
  }

  const body = await c.req.parseBody();
  const submitted = typeof body.password === "string" ? body.password : "";

  if (!submitted || !timingSafeEqualStr(submitted, password)) {
    return c.html(renderLoginPage({ error: "Incorrect password." }), 401);
  }

  setCookie(c, COOKIE_NAME, await sessionTokenFor(password), {
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    maxAge: COOKIE_MAX_AGE_SECONDS,
    path: COOKIE_PATH,
  });

  return c.redirect("/dashboard", 302);
});

dashboard.get("/logout", (c) => {
  deleteCookie(c, COOKIE_NAME, {
    path: COOKIE_PATH,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  });
  return c.redirect("/dashboard", 302);
});
