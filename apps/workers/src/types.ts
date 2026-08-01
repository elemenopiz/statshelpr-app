/**
 * Cloudflare Workers bindings + environment. All API routes receive this
 * via Hono's context (`c.env`), so we never touch `process.env` in Workers.
 */
export interface Env {
  // Secrets (set via `wrangler secret put`)
  GEMINI_API_KEY: string;
  /** Only needed while testing the Luna (gpt-5.6-luna) stub provider —
   *  routes/solve.ts picks this over GEMINI_API_KEY when resolveModel
   *  returns a `gpt-*` model. Unset means Luna solves 500 with a clear
   *  "not configured" error; the Gemini path is unaffected. */
  OPENAI_API_KEY?: string;
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
  /** HMAC key for every license-activation KV hash (lib/license-activation.ts's
   *  activationHash) — `wrangler secret put ACTIVATION_HASH_SECRET`, generate
   *  with e.g. `openssl rand -hex 32`. Its ONLY job is to keep the activation
   *  hash space disjoint from lib/rate-limit.ts's unkeyed hashBucket (and so
   *  from lib/metrics-store.ts's daily `installHashes` sets), which otherwise
   *  lets anyone holding a raw license key — and thus the buyer email on the
   *  `license:` record — recompute that customer's install hash and read their
   *  daily activity out of the metrics buckets. Never share this value with
   *  R_RUNNER_SECRET or any other secret here; a shared value would re-create
   *  the join it exists to prevent. Rotating it is safe but forces one LS
   *  /activate round-trip per active install (the keyed lookups miss and the
   *  legacy-hash fallback no longer matches), so treat it as set-once.
   *  Unset means activation fails closed with a clear "Activation not
   *  configured" reason — same contract as R_RUNNER_SECRET above — so
   *  *** MUST BE SET BEFORE DEPLOY ***. Dev licenses (`{"dev":true}` KV
   *  records) and the LEMONSQUEEZY_API_KEY-unset dev path both bypass
   *  activation entirely and are unaffected. */
  ACTIVATION_HASH_SECRET: string;
  /** Full JSON key file (verbatim) for the read-only
   *  statshelpr-monitoring-reader@... service account (roles/monitoring.viewer
   *  ONLY) — `wrangler secret put GCP_MONITORING_SA_KEY`. Used by
   *  lib/gcp-monitoring.ts to self-sign a JWT and pull two Cloud Run infra
   *  metrics (billable_instance_time, startup_latencies) straight from GCP
   *  Cloud Monitoring for the /dashboard "Cloud Run Infra" panel (R-runner
   *  health tracking phase 2). Optional and NOT fail-closed like the secrets
   *  above: unset (the normal case in local dev — this is not in any
   *  .dev.vars) just renders that one panel as "unavailable", the rest of
   *  the dashboard is unaffected. Never logged; see that module's doc
   *  comment for the auth flow. */
  GCP_MONITORING_SA_KEY?: string;

  // Vars (from wrangler.toml [vars])
  LLM_PROVIDER: string;
  FREE_TIER_DAILY_LIMIT: string;
  /** Assumed solves/user/month for the economics.grossMarginPerUserPct estimate
   *  in GET /api/metrics only — not a cap or rate limit. Default 110 (the
   *  documented paid-user usage assumption, ~10 solves / 2 weekdays). */
  AVG_SOLVES_PER_USER_PER_MONTH?: string;
  /** UTC date ("YYYY-MM-DD") before which daily metrics buckets are excluded
   *  from dashboard aggregation — lets pre-launch dev/testing data be hidden
   *  from the live dashboard without deleting the underlying KV buckets.
   *  Unset = no filtering (all stored history shown). */
  METRICS_LAUNCH_DATE?: string;
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
  /** Global daily ceiling on ACTUAL Gemini dollars spent (2026-07-29
   *  capacity review) — the direct answer to "what's the most a bad day can
   *  cost me". Sits alongside GLOBAL_DAILY_CALL_LIMIT on the same
   *  kill-switch check: calls cap volume, this caps dollars, and either one
   *  tripping 503s the service for the rest of the UTC day. Accumulated
   *  from the exact per-leg costUsd solve.ts already computes (lib/cost.ts
   *  rates on real usage counts), so it holds no matter how an abuser
   *  shapes payloads — cheap calls trip the call cap first, stuffed calls
   *  trip this first. Worst-case daily spend ≈ the cap + a few dollars of
   *  in-flight overshoot (calls that started before the trip). Default 25
   *  if unset. See lib/kill-switch.ts. */
  GLOBAL_DAILY_SPEND_LIMIT_USD?: string;

  // KV binding
  STATSHELPR_KV: KVNamespace;

  /** SQLite-backed Durable Object holding every hot counter (per-install
   *  free cap, per-IP backstop, global call + dollar ceilings) — see
   *  lib/counters-do.ts's module doc for why these left KV (free-plan write
   *  caps + same-key contention). One instance, idFromName("global"). */
  COUNTERS_DO: DurableObjectNamespace;
}
