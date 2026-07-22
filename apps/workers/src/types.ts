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
  /** Shared-secret auth between this Worker and the Cloud Run R-runner
   *  service (r-runner/plumber.R's `@filter auth`) —
   *  `wrangler secret put R_RUNNER_SECRET`, the SAME value passed to Cloud
   *  Run as its own `R_RUNNER_SECRET` env var at `gcloud run deploy` (see
   *  r-runner/README.md and docs/cloud-run-r-migration.md §2.3/§3.4). Sent
   *  as the `X-Runner-Secret` header on every POST /runR (lib/r-runner.ts).
   *  Unset means lib/r-runner.ts's runRRemote fails closed with a clear
   *  "R runner not configured" error — calc questions error, concept
   *  questions are unaffected — same fail-closed contract this codebase uses
   *  for DASHBOARD_PASSWORD/METRICS_TOKEN above. *** MUST BE SET BEFORE
   *  DEPLOY (alongside R_RUNNER_URL in [vars] below). *** */
  R_RUNNER_SECRET: string;

  // Vars (from wrangler.toml [vars])
  LLM_PROVIDER: string;
  FREE_TIER_DAILY_LIMIT: string;
  /** Assumed solves/user/month for the economics.grossMarginPerUserPct estimate
   *  in GET /api/metrics only — not a cap or rate limit. Default 110 (the
   *  documented paid-user usage assumption, ~10 solves / 2 weekdays). */
  AVG_SOLVES_PER_USER_PER_MONTH?: string;
  /** Base URL of the Cloud Run R-runner service (r-runner/), e.g.
   *  `https://statshelpr-r-runner-xxxx.run.app` — non-secret, set in
   *  wrangler.toml's [vars] (the URL alone grants nothing without
   *  R_RUNNER_SECRET above). Filled in with the real Cloud Run URL after the
   *  first `gcloud run deploy` (see r-runner/README.md and
   *  docs/cloud-run-r-migration.md §2.3/§3.4) — the wrangler.toml placeholder
   *  is an obviously-fake host so a forgotten placeholder fails loudly
   *  (DNS/connection error) instead of silently. lib/r-runner.ts's
   *  runRRemote POSTs `${R_RUNNER_URL}/runR`; unset (or R_RUNNER_SECRET
   *  unset) fails closed — see that field's doc above. */
  R_RUNNER_URL: string;
  /** Per-IP daily cap (security-audit item C), applied on top of the
   *  per-install free-tier counter on /api/solve — a backstop against
   *  trivial install-id rotation (the install id is a client-picked
   *  crypto.randomUUID(), see apps/extension/src/install-id.ts, with no
   *  server issuance, so it resets for free). Only applied to free-tier
   *  callers, same as the per-install counter — paid licenses stay
   *  unlimited. Default 200 if unset. (Used to also gate the now-deleted
   *  /api/interpret route independently — see docs/cloud-run-r-migration.md
   *  §3; the interpret pass is an internal leg of /api/solve now, already
   *  covered by this same per-IP check on the one request.) */
  IP_DAILY_LIMIT?: string;
  /** Global (not per-user) daily ceiling on every Gemini call this Worker
   *  makes (security-audit item D) — the real backstop: hard-stops the
   *  ENTIRE service with a 503 once crossed, regardless of caller or tier.
   *  Checked before EACH Gemini call individually, not once per request — a
   *  calc question can make up to three (first pass, an optional R-repair
   *  retry, interpret), all inside one /api/solve call now that the
   *  interpret pass is no longer a separate route (see
   *  docs/cloud-run-r-migration.md §3). See lib/kill-switch.ts for the
   *  $/day sizing math behind the default (1000 if unset). */
  GLOBAL_DAILY_CALL_LIMIT?: string;

  // KV binding
  STATSHELPR_KV: KVNamespace;
}
