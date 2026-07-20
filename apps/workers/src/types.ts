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

  // Vars (from wrangler.toml [vars])
  LLM_PROVIDER: string;
  FREE_TIER_DAILY_LIMIT: string;

  // KV binding
  STATSHELPR_KV: KVNamespace;
}
