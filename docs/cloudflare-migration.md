# Cloudflare migration plan

Full migration from Vercel → Cloudflare. Goal: $0/mo infra floor with scale-independent cost, one platform to manage, no surprise bills.

Committed 2026-07-20. Timeline: **5–7 focused days solo**.

---

## Target architecture

```
              statshelpr.com (Cloudflare Pages)
                    │  static landing + pricing + docs
                    ▼
              [buy CTA] → Lemon Squeezy checkout
                    │
                    ▼ (webhook)
    Chrome extension (sideload)
                    │
                    ▼
    ┌───────────────────────────────────────────┐
    │ Cloudflare Workers (Hono)                 │
    │   /api/solve         (write R or answer)  │
    │   /api/interpret     (interpret R output) │
    │   /api/health                             │
    │   /api/auth/validate-license              │
    │   /api/webhooks/lemonsqueezy              │
    │   /api/feedback                           │
    │   /api/user          (DELETE for GDPR)    │
    └───────────────────────────────────────────┘
              │                        │
              ▼                        ▼
    Cloudflare KV            Google Gemini API
    (licenses, rate limits,   (gemini-3.5-flash)
     feedback, usage counter)      │
                                   │
                            (optionally via CF AI Gateway
                             for analytics + retry)

              WebR (in extension Web Worker)
                    │  runs R client-side
                    │  no server involvement
                    ▼
           (stdout POST'd back to /api/interpret)
```

**Killed:**
- Vercel Functions / Fluid Compute
- Vercel Sandbox
- Vercel deployment pipeline
- `VERCEL_OIDC_TOKEN`, `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`
- `R_SANDBOX_SNAPSHOT_ID` and the snapshot itself
- `apps/api/lib/sandbox.ts`
- `scripts/create-r-snapshot.ts`
- Next.js dependency

**New:**
- `apps/workers/` — Hono app on Cloudflare Workers
- `apps/landing/` — static site on Cloudflare Pages
- `apps/extension/src/webr-runner.ts` — client-side R execution
- Cloudflare KV namespace for state
- `wrangler` CLI in dev workflow

---

## Cost projection

At any scale from launch to ~50k paid users:

| Component | Free tier | Paid tier trigger | Cost at 5k users | Cost at 50k users |
|---|---|---|---|---|
| Cloudflare Workers | 100k req/day (~3M/mo) | after 10M req/mo | $0 | $5 (base) |
| Cloudflare Pages | Unlimited requests, unlimited bandwidth | never for static | $0 | $0 |
| Cloudflare KV | 100k reads/day, 1k writes/day | over that | $0–5 | $5 |
| Cloudflare AI Gateway (optional) | Free with generous limits | pay-per-request analytics | $0 | $0 |
| **Total CF** | | | **~$0/mo** | **~$5–10/mo** |
| Gemini API (unchanged) | — | — | ~$27 (5k × $0.005 avg) | ~$270 |
| Lemon Squeezy | — | 5% + $0.50 per txn | ~$375/mo | ~$3,750/mo |
| **Total infra** | | | **~$400** | **~$4,000** |

Compare to Vercel: at 5k users you'd be on Pro ($20 base + sandbox usage + function-hours) = ~$40–60/mo. Cloudflare wins by ~$35–50/mo at that scale. At 50k users, savings compound.

More importantly: **no surprise bills.** Workers' pricing is boringly predictable.

---

## Migration phases

### Phase 0 — CF account + tooling setup (~1h)

- [ ] Create Cloudflare account, add payment method
- [ ] Add DNS for `statshelpr.com` to Cloudflare (or delegate NS)
- [ ] `npm i -g wrangler` and `wrangler login`
- [ ] Create KV namespace: `wrangler kv namespace create statshelpr` → save the ID
- [ ] Get Gemini API key from aistudio.google.com/apikey (if not already)
- [ ] Get Lemon Squeezy API key + webhook signing secret

### Phase 1 — Workers API rewrite (~1–2 days)

Set up the new app structure:

```
apps/workers/
├── package.json
├── wrangler.toml
├── tsconfig.json
├── src/
│   ├── index.ts              # Hono app entrypoint, route registration
│   ├── routes/
│   │   ├── solve.ts          # split from apps/api/app/api/solve/route.ts
│   │   ├── interpret.ts      # NEW — post-WebR interpret call
│   │   ├── health.ts
│   │   ├── validate-license.ts
│   │   ├── lemonsqueezy-webhook.ts  # NEW
│   │   ├── feedback.ts       # NEW
│   │   └── user.ts           # NEW — DELETE for GDPR
│   ├── lib/
│   │   ├── core/             # move apps/api/lib/core/ here
│   │   ├── solver/           # move apps/api/lib/solver/ here
│   │   ├── data-summary.ts
│   │   ├── license.ts        # rewrite to use KV
│   │   ├── rate-limit.ts     # NEW — KV-backed 5/day counter
│   │   └── sse.ts
│   └── types.ts              # Cloudflare Env bindings
```

`wrangler.toml`:
```toml
name = "statshelpr-api"
main = "src/index.ts"
compatibility_date = "2026-07-20"
compatibility_flags = ["nodejs_compat"]

[[kv_namespaces]]
binding = "STATSHELPR_KV"
id = "<from Phase 0>"

[vars]
LLM_PROVIDER = "gemini"

# Secrets set via: wrangler secret put GEMINI_API_KEY
# GEMINI_API_KEY, LEMONSQUEEZY_API_KEY, LEMONSQUEEZY_WEBHOOK_SECRET
```

**Code changes per file:**

- `lib/core/providers/gemini.ts` — **no changes needed**. Uses `fetch`, `TextDecoder`, streaming — all Workers-native.
- `lib/core/providers/index.ts` — replace `process.env["GEMINI_API_KEY"]` with `env.GEMINI_API_KEY` from Workers bindings. Pass `env` through call chain, or use `AsyncLocalStorage` for context.
- Route handlers — swap `NextRequest`/`NextResponse` for standard `Request`/`Response`. Hono handles routing.
- `lib/sandbox.ts` — **delete**. WebR replaces.
- `lib/license.ts` — rewrite to use `env.STATSHELPR_KV.get()` / `.put()` for license caching (currently in-memory cache).

Streaming SSE on Workers: use `new Response(stream, { headers: sseHeaders })` where `stream` is a `ReadableStream`. Works identically to current Vercel approach.

Example handler shape:
```typescript
// src/routes/solve.ts
import { Hono } from "hono";
import type { Env } from "../types";

export const solve = new Hono<{ Bindings: Env }>();

solve.post("/", async (c) => {
  const apiKey = c.env.GEMINI_API_KEY;
  if (!apiKey) return c.json({ error: "GEMINI_API_KEY not configured" }, 500);
  // ... rest matches current route.ts logic
});
```

**Dev loop**: `wrangler dev` runs locally at `http://localhost:8787` with live reload. Same feel as `next dev`.

### Phase 2 — WebR client-side R migration (~2–3 days)

Detailed flow in [planning.md §5](planning.md) and prior conversation.

- [ ] Add `@r-wasm/webr` to `apps/extension/package.json`
- [ ] Bundle WebR runtime into `apps/extension/public/webr/` (avoid remote fetch — safer for reviewers and reliability)
- [ ] New `apps/extension/src/webr-runner.ts` — Web Worker that boots WebR, preloads 8 packages, exposes `runR(code, dataFiles)`
- [ ] Pre-warm WebR on extension `background.ts` install/startup
- [ ] Split `content.ts` streaming handler: after receiving R code from `/api/solve`, run WebR locally, POST to `/api/interpret`
- [ ] Delete `apps/api/lib/sandbox.ts` and `scripts/create-r-snapshot.ts` (already moving/killed as part of Phase 1)
- [ ] Update `manifest.json` to add `web_accessible_resources` for `webr/*` and CSP `wasm-unsafe-eval`

### Phase 3 — Landing page on Pages (~1 day)

- [ ] `apps/landing/` — plain HTML + CSS or Astro. Not Next.js — no need for framework overhead on a marketing site.
- [ ] Hero, features (tutor framing), pricing card ($15/mo → LS checkout URL), FAQ, footer with privacy/ToS links
- [ ] `wrangler pages deploy apps/landing/dist --project-name statshelpr-landing`
- [ ] DNS: point `statshelpr.com` (apex) at the Pages project, `api.statshelpr.com` at the Workers app

### Phase 4 — KV-backed state (rate limiting, LS webhook, licenses) (~1 day)

**Rate limiting** (`src/lib/rate-limit.ts`):
```typescript
// Sliding-window 24h counter keyed on license hash
async function checkAndIncrement(kv: KVNamespace, licenseHash: string, limit: number): Promise<boolean> {
  const key = `rl:${licenseHash}`;
  const raw = await kv.get(key, "json") as { count: number; resetAt: number } | null;
  const now = Date.now();
  if (!raw || raw.resetAt < now) {
    await kv.put(key, JSON.stringify({ count: 1, resetAt: now + 86400_000 }), { expirationTtl: 86400 });
    return true;
  }
  if (raw.count >= limit) return false;
  await kv.put(key, JSON.stringify({ count: raw.count + 1, resetAt: raw.resetAt }), { expirationTtl: 86400 });
  return true;
}
```
Wire into `/api/solve` before Gemini call. Return 402 with upgrade CTA on cap. Default 5/day for free tier, unlimited for paid.

**Lemon Squeezy webhook** (`src/routes/lemonsqueezy-webhook.ts`):
- Verify HMAC signature (LS sends `X-Signature` header)
- Handle events: `subscription_created`, `subscription_updated`, `subscription_cancelled`, `subscription_payment_success`, `subscription_payment_failed`
- On create: generate license key, store to KV under `license:${key}`, email to buyer via LS's built-in flow
- On cancel: mark license as inactive in KV
- Idempotency: check event ID in KV before processing (LS retries failed webhooks)

**License validation** (rewrite of `apps/api/lib/license.ts`):
- Currently: in-memory cache with 10-min TTL, calls LS API to validate
- New: check KV first, fall back to LS API on miss, cache result in KV with 10-min TTL
- Faster (KV read ~5ms vs LS API ~200ms), works across cold starts

### Phase 5 — Cutover (~half day)

Zero-downtime switch:

- [ ] Deploy Workers app to `api.statshelpr.com` (or subdomain during testing)
- [ ] Deploy Pages landing to `statshelpr.com`
- [ ] Deploy new extension version (v1.0.0) with API URL pointing at `https://api.statshelpr.com`
- [ ] Sideload/distribute new extension via `statshelpr.com/download` (since going stealth-sideload)
- [ ] Verify with a real solve end-to-end (both CONCEPT and RCODE paths)
- [ ] Turn down Vercel deployments (keep code in monorepo for rollback, but stop serving)
- [ ] Cancel Vercel Pro if you'd upgraded (unlikely at this stage)

### Phase 6 — Post-cutover cleanup

- [ ] Delete `apps/api/` directory entirely (all migrated to `apps/workers/`)
- [ ] Update root `README.md` for new architecture
- [ ] Update `pnpm-workspace.yaml` to reflect new app structure
- [ ] Add `wrangler.toml` to `.gitignore` if you have separate dev/prod configs

---

## Env var mapping

| Vercel (old) | Cloudflare (new) | Notes |
|---|---|---|
| `GEMINI_API_KEY` | Wrangler secret `GEMINI_API_KEY` | `wrangler secret put GEMINI_API_KEY` |
| `LEMONSQUEEZY_API_KEY` | Wrangler secret same name | Same |
| `LEMONSQUEEZY_STORE_ID` | `[vars]` in wrangler.toml | Not sensitive |
| `LEMONSQUEEZY_VARIANT_ID` | `[vars]` in wrangler.toml | Not sensitive |
| `LEMONSQUEEZY_WEBHOOK_SECRET` (new) | Wrangler secret | For HMAC verification |
| `VERCEL_OIDC_TOKEN` | ❌ deleted | Not needed |
| `VERCEL_TOKEN` | ❌ deleted | Not needed |
| `VERCEL_TEAM_ID` | ❌ deleted | Not needed |
| `VERCEL_PROJECT_ID` | ❌ deleted | Not needed |
| `R_SANDBOX_SNAPSHOT_ID` | ❌ deleted | WebR replaces |
| KV namespace binding | `STATSHELPR_KV` in wrangler.toml | New |

---

## Deployment workflow

**Local dev:**
```bash
cd apps/workers
wrangler dev  # local server at :8787 with live reload
```

**Deploy to prod:**
```bash
cd apps/workers
wrangler deploy
```

**Deploy landing:**
```bash
cd apps/landing
npm run build
wrangler pages deploy dist --project-name statshelpr-landing
```

**Set secrets:**
```bash
wrangler secret put GEMINI_API_KEY
wrangler secret put LEMONSQUEEZY_API_KEY
wrangler secret put LEMONSQUEEZY_WEBHOOK_SECRET
```

**Read logs:**
```bash
wrangler tail  # live log stream from prod
```

---

## Rollback plan

If Cloudflare has an incident or something breaks:

1. Keep the Vercel deployment alive but idle for **2 weeks post-cutover** (costs $0 on Hobby).
2. In extension, ship a build with the API URL as a `chrome.storage.sync` value — user can flip between prod (`api.statshelpr.com`) and fallback (`vercel-fallback.statshelpr.com`) in the popup.
3. If CF goes down, push a silent extension update or DM users to switch the URL.
4. After 2 weeks of stable operation, delete `apps/api/` and shut down the Vercel project.

---

## Risks + mitigations

**Risk 1: Hono / Workers has different edge cases than Next.js.**
Mitigation: Hono is Next.js-like, well-documented, actively maintained. Streaming works identically. `fetch` works identically. Very few surprises expected.

**Risk 2: Workers CPU time limit (30s on paid, 10ms on free).**
Mitigation: our workload is I/O-bound (waiting for Gemini). Actual CPU is <10ms per request. Even free tier CPU cap is fine.

**Risk 3: KV eventual consistency.**
Mitigation: KV is eventually consistent globally (~60s), but within a region reads-after-writes are consistent. Rate limiting could allow a brief burst across regions — acceptable for our use case. Use Durable Objects only if strict consistency ever matters.

**Risk 4: WebR fails on some user browsers.**
Mitigation: Chrome extension = we control the browser (Chrome desktop). WebR requires WASM support, which Chrome has had for years. Add a graceful "R environment unavailable, refresh Chrome" error message as backstop.

**Risk 5: Migration bugs in cutover.**
Mitigation: 2-week Vercel warm standby (see rollback plan). Deploy Workers on a subdomain first, test with a personal extension build before pushing to users.

---

## What this doesn't change

- Model choice: still Gemini 3.5 Flash
- Payment provider: still Lemon Squeezy (migrate to Dodo at 100+ paid users)
- Pricing: still $15/mo monthly subscription
- Free tier: still 5 solves/day
- Extension distribution: still sideload from statshelpr.com
- Business logic: solver, classifier, R repair loop — all unchanged, just runs in a different runtime

---

## Total timeline

| Phase | Duration | Cumulative |
|---|---|---|
| 0. Setup | 1h | Day 1 |
| 1. API rewrite | 1–2 days | Day 1–3 |
| 2. WebR migration | 2–3 days | Day 3–6 |
| 3. Landing page | 1 day | Day 6–7 |
| 4. KV state (rate limit, webhook, license) | 1 day | Day 7 |
| 5. Cutover | half day | Day 7–8 |
| **Total** | **5–7 focused days** | |

Parallelizable if you deploy a second agent: Phase 3 (landing) can run alongside Phase 2 (WebR).
