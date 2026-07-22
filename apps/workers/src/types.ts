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
  /** Required only for POST /api/reset/request (Resend email-token reset flow). */
  RESEND_API_KEY?: string;
  /** Bearer token gating GET /api/metrics — `wrangler secret put METRICS_TOKEN`.
   *  Unset means the route hard-fails closed (401 on every request), not open. */
  METRICS_TOKEN?: string;

  // Vars (from wrangler.toml [vars])
  LLM_PROVIDER: string;
  FREE_TIER_DAILY_LIMIT: string;
  /** Assumed solves/user/month for the economics.grossMarginPerUserPct estimate
   *  in GET /api/metrics only — not a cap or rate limit. Default 110 (the
   *  documented paid-user usage assumption, ~10 solves / 2 weekdays). */
  AVG_SOLVES_PER_USER_PER_MONTH?: string;

  // KV binding
  STATSHELPR_KV: KVNamespace;
}
