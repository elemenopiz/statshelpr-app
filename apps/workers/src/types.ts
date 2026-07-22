/**
 * Cloudflare Workers bindings + environment. All API routes receive this
 * via Hono's context (`c.env`), so we never touch `process.env` in Workers.
 */
export interface Env {
  // Secrets (set via `wrangler secret put`)
  GEMINI_API_KEY: string;
  LEMONSQUEEZY_API_KEY?: string;
  LEMONSQUEEZY_WEBHOOK_SECRET?: string;
  LEMONSQUEEZY_STORE_ID?: string;
  LEMONSQUEEZY_VARIANT_ID?: string;
  /** Required for POST /api/reset/request (Resend email-token reset flow) and
   *  for the scheduled founder-metrics alert emails (see lib/alerts.ts). */
  RESEND_API_KEY?: string;
  /** Recipient for scheduled founder-metrics threshold alerts (item 15).
   *  Set via `wrangler secret put ALERT_EMAIL`. Unset (or RESEND_API_KEY
   *  unset) means alerting is skipped silently — snapshots still roll up. */
  ALERT_EMAIL?: string;
  /** Bearer token gating GET /api/metrics — `wrangler secret put METRICS_TOKEN`.
   *  Unset means the route hard-fails closed (401 on every request), not open. */
  METRICS_TOKEN?: string;
  /** Access key gating GET /dashboard — `wrangler secret put DASHBOARD_PASSWORD`.
   *  Checked against `?key=` or the `sh_dash_key` cookie it sets on first use.
   *  Unset means the route hard-fails closed (401 on every request, including
   *  ?demo=1), not open. */
  DASHBOARD_PASSWORD?: string;
  /** HMAC key signing the short-lived token that binds /api/interpret to a
   *  prior /api/solve call — `wrangler secret put INTERPRET_SIGNING_SECRET`
   *  (e.g. `openssl rand -hex 32`). See lib/interpret-token.ts for the full
   *  rationale. Unset means /api/interpret hard-fails closed (403 on every
   *  request) — same fail-closed contract as DASHBOARD_PASSWORD/
   *  METRICS_TOKEN above. *** MUST BE SET BEFORE DEPLOY. *** */
  INTERPRET_SIGNING_SECRET?: string;

  // Vars (from wrangler.toml [vars])
  LLM_PROVIDER: string;
  FREE_TIER_DAILY_LIMIT: string;
  /** Assumed solves/user/month for the economics.grossMarginPerUserPct estimate
   *  in GET /api/metrics only — not a cap or rate limit. Default 110 (the
   *  documented paid-user usage assumption, ~10 solves / 2 weekdays). */
  AVG_SOLVES_PER_USER_PER_MONTH?: string;
  /** Independent free-tier daily cap on /api/interpret calls, per install id
   *  (security-audit item B) — defense-in-depth so a leaked/replayed
   *  interpret token can't be redeemed unboundedly even though it's valid.
   *  Deliberately separate from FREE_TIER_DAILY_LIMIT (solve's own counter);
   *  see routes/interpret.ts for how it's applied. Default 10 if unset. */
  INTERPRET_DAILY_LIMIT?: string;
  /** Per-IP daily cap (security-audit item C), applied on top of the
   *  per-install free-tier counters on BOTH /api/solve and /api/interpret
   *  (each route tracks its own independent per-IP counter) — a backstop
   *  against trivial install-id rotation (the install id is a client-picked
   *  crypto.randomUUID(), see apps/extension/src/install-id.ts, with no
   *  server issuance, so it resets for free). Only applied to free-tier
   *  callers, same as the per-install counters — paid licenses stay
   *  unlimited. Default 200 if unset. */
  IP_DAILY_LIMIT?: string;
  /** Global (not per-user) daily ceiling on combined solve+interpret Gemini
   *  calls (security-audit item D) — the real backstop: hard-stops the
   *  ENTIRE service with a 503 once crossed, regardless of caller or tier.
   *  See lib/kill-switch.ts for the $/day sizing math behind the default
   *  (1000 if unset). */
  GLOBAL_DAILY_CALL_LIMIT?: string;

  // KV binding
  STATSHELPR_KV: KVNamespace;
}
