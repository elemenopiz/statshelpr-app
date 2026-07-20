# statshelpr — planning & decisions

Living record of product decisions, unit economics, model choices, and research done so far. Update this file as things settle. Last major update: 2026-07-20.

---

## 1. Product positioning

**Current state.** Chrome extension + Next.js API that auto-answers Canvas quiz questions and auto-selects the matching answer choice. Kimi K2.6 does classification (CONCEPT vs RCODE), then either answers directly or writes R code, runs it in a Vercel Sandbox microVM, and interprets the output.

**Direction.** Reframe as a *study/practice tutor*, not an exam auto-answerer, so it can pass Chrome Web Store review and survive the first university complaint. This is a genuine reframe, not a listing lie — the code needs to match.

**Non-negotiables for the tutor build:**
- Default behavior shows explanation + R code + reasoning; auto-selecting the answer choice is behind an off-by-default toggle labeled "for practice / ungraded assignments only."
- Remove all "stealth"/"discreet"/"undetectable" language from code, commits, and UI. Visible branding on the injected panel.
- Icons: 16/32/48/128 PNGs, same mark on landing page and popup.
- Privacy policy + ToS with academic-honesty clause on `statshelpr.com`.

---

## 2. Pricing

- **Monthly subscription only. $15/mo. Locked.** Not $20 — that puts us in ChatGPT Plus territory ($20) and crosses the "teens → twenties" psychological threshold. $15 is Netflix-adjacent, safer conversion.
- No yearly, no semester (churn cycles reset anyway).
- **Free tier: 5 solves per rolling 24h, unrestricted (CONCEPT + RCODE).** Conservative bleed math at 1:2 free:paid ratio is absorbed by paid net. Wider funnel + full-value demonstration > gate-then-upgrade friction. Revisit if actual free:paid ratio comes in worse than 1:2.
- Cancel = one click in popup. Renewal receipt emailed every cycle. Normal SaaS; not designed for forgotten cancellations.

---

## 3. Payment stack

**Migration path by scale** (payment fee is now our biggest COGS line after LLM):

| Paid users | Provider | Fee on $15 | Reason |
|---|---|---|---|
| 0–100 | **Lemon Squeezy** (current) | $1.25 (5% + $0.50) | Already integrated; savings <$50/mo not worth switching |
| 100–1,000 | **Dodo Payments** (MoR) | $1.00 (4% + $0.40) | Same MoR simplicity, saves ~$0.25/user. At 500 users: ~$125/mo saved |
| 1,000+ | **Stripe direct + Stripe Tax** | $0.74 + tax handling | Saves ~$400+/mo at 1k users; complexity worth it |

**Considered and rejected:**
- Polar — was 4% + $0.40, raised to 5% + $0.50 in 2026 update on free plan. Now same as LS. Paid plans ($20-$400/mo flat) only pencil out at large scale.
- Paddle — same fee as LS, no advantage.
- Gumroad — 10% + processing, far worse.

**Chargeback exposure**: LS/Dodo/Paddle: $15 per dispute deducted. Stripe: $15 dispute-received + $15 counter fee if you fight and lose. All MoR providers handle the admin work; Stripe you handle yourself.

**Stripe acquired Lemon Squeezy in 2024** — they're converging. Migration LS → Stripe direct is now cleaner than it used to be.

**Free Stripe fees**: GitHub Student Developer Pack waives Stripe fees on first $1,000 processed. If you claim it and route first ~65 transactions through Stripe direct, savings ~$50. Marginal but free.

---

## 4. Alt-account abuse prevention

Layered signals, ship gradually. Goal: stop casual "reinstall in incognito," not determined attackers.

1. **Email verification** with disposable-domain blocklist ([disposable-email-domains](https://github.com/disposable-email-domains/disposable-email-domains)).
2. **Persistent install ID** in `chrome.storage.sync` (syncs with Google account).
3. **Browser fingerprint** via open-source [FingerprintJS](https://github.com/fingerprintjs/fingerprintjs).
4. **Server-side aggregation**: on free-tier cap hit, log `(fingerprint, IP subnet, install_id, email_domain)`. Match 2+ dims on next signup → shadow-cap.
5. **Rolling 24h counter**, not calendar-day resets.
6. Optional escalation if abuse metrics justify: Twilio Verify phone verification (~$0.05/verify).

Expect 10–20% leakage regardless. Price the free tier assuming leakage.

---

## 5. LLM model routing

**Decision: needs benchmark on eval fixtures — three-way race not resolvable from leaderboards.**

Three real candidates after 2026-07-20 sweep (Kimi K3, Gemini 3.5 Flash, K2.7 all changed the picture):

| Model | Verdict |
|---|---|
| **Gemini 3.5 Flash** ($1.50/$9) | Highest GPQA (92.2), best-in-class Google vision, beats 3.1 Pro on coding. Google's "new default" as of I/O 2026. Adopt if eval wins. |
| **Kimi K2.7** ($0.66-0.95/$3.41-4, cache $0.10) | 30% fewer thinking tokens than K2.6, coding-focused, +21.8% on Moonshot's benchmarks. Cheapest cached-input tier. Vision + 1M context. |
| **GPT-5.6 Luna medium** ($1/$6, cache $0.10) | Fast TTFT (1.3s), adjustable reasoning. Weaker GPQA (~87 vs 92) than the other two. Fallback. |

**If forced to pick blind: Gemini 3.5 Flash primary, K2.7 fallback, Luna third.**

**Concrete next step:** extend `apps/api/lib/core/providers/` for all three, add `MODEL` env var, run `scripts/run-evals.ts` against each on the same fixture set. Pick on accuracy → cost → TTFT in that order.

Do not route per-phase until $500/mo spend. Single model everywhere.

### Rejected on this sweep (updated from previous round)
- **Kimi K3** ($3/$15) — Fable-tier performance but Sonnet-tier price. Keep in mind for future "Pro Max" tier.
- **Qwen 3.7-Max** — top benchmarks but vision "limited" is a deal-risk for image scraping. Test OCR quality if reconsidered.
- **Mistral Small 4** ($0.15/$0.60) — Intelligence Index 27, below Sonnet 4.5's 29.3 bar.
- **Step 3.5 Flash** ($0.10/$0.30) — insane pricing, AIME 97.3, but vision unclear and unproven.
- **Haiku 4.5** — 17.5s TTFT with reasoning is dead on arrival for streaming UX.
- Everything from prior round still rejected: Fable 5, Opus 4.8, Sonnet 5, GPT-5.6 Sol/Terra, Gemini 3.1 Pro, Grok 4.5, DeepSeek V4 Pro/Flash/R1, GLM-5.1, MiniMax M2.5, Sonnet 4.5, Kimi K2.6.

**Head-to-head rationale (2026-07-20 sweep, second pass):**

Gemini 3.5 Flash and Kimi K2.7 emerged as genuine competitors after the first sweep missed them. Full comparison:

- **Gemini 3.5 Flash vs Luna**: 3.5 Flash has higher GPQA (92.2 vs ~87), beats 3.1 Pro on coding, best-in-class Google vision. 50% more expensive on output ($9 vs $6). Vision matters for image scraping. **Likely wins on quality; may lose on cost if traffic scales.**
- **Kimi K2.7 vs Luna**: K2.7 has cheaper cached input ($0.10 same tier but higher raw quality), 30% fewer mandatory thinking tokens vs K2.6, coding-focused. Already on Moonshot SDK (zero migration friction). **Best cost-per-quality if benchmarks hold.**
- **Luna's remaining edges**: fastest TTFT (1.3s), adjustable reasoning-effort knob, OpenAI ecosystem/SDK. Not enough on its own to overcome the reasoning gap.

**Reasoning effort setting (if Luna wins eval): `medium`.** `low` leaves quality on the table; `high` doubles output tokens with marginal accuracy gain on our question shape.

**Prior sweep detail (still relevant for context):** Luna beat Haiku 4.5 (TTFT), Kimi K2.6 (K2.7 is the successor), Sonnet 4.5 (price), Grok 4.5 (price), DeepSeek V4 (no vision), Gemini 3 Flash (weaker reasoning), all Fable/Opus/Sonnet 5/Sol tier (overkill).

**Why not per-phase routing (Luna classifier + Nano interpret, or client-side OCR + text-only model):**

- Savings ~$0.001/solve at current scale.
- Complexity cost: Tesseract WASM for OCR mangles statistical notation → wrong answers → refunds.
- Codepath complexity for two-model routing not worth $1/day of savings.
- Revisit at ~$500/mo LLM spend.

**Prompt caching is load-bearing.** Every request sends the ~200-line DSGI textbook reference + 35+ routing rules from `apps/api/lib/core/`. ~5k tokens cached at 90% off = $0.10/M effective. Without caching, cost blows up. Luna supports 90% cache discount.

**Decision rule for future model swaps:** Run any candidate against `evals/solve-fixtures/` before migrating. Accuracy on that eval set is the deciding metric, not the price sheet.

---

## 6. R execution — WebR migration

**Decision: migrate to WebR (client-side R in WebAssembly).**

**Confirmed** (2026-07-20): all needed packages have WebR builds at `repo.r-wasm.org` for R 4.4/4.5/4.6:
`tidyverse, mosaic, moderndive, infer, broom, ggplot2, openssl, base64enc`.

**Architecture change:**
- Kept: Vercel `/api/solve` for LLM proxy, license validation, streaming.
- Removed: `@vercel/sandbox`, `lib/sandbox.ts`, `R_SANDBOX_SNAPSHOT_ID`, `scripts/create-r-snapshot.ts`, all Vercel OIDC/token wiring.
- New flow: extension → Vercel writes R → extension runs R in WebR (Web Worker) → sends output back → Vercel interprets.

**Practical impact:**
- Zero server-side R cost.
- ~20MB WASM download, once, cached forever.
- First-load latency ~2–3s to boot the R VM; subsequent solves instant.

---

## 7. Serverless hosting

**Committed: full Cloudflare migration.** Detailed plan at [cloudflare-migration.md](cloudflare-migration.md).

- Workers for API endpoints (Hono, replacing Next.js routes)
- Pages for `statshelpr.com` landing (static)
- KV for state (rate limiting, licenses, feedback)
- Optionally CF AI Gateway in front of Gemini for analytics + retry
- Timeline: 5–7 focused days
- Cost: **~$0/mo at launch, ~$5–10/mo at 50k users**. No surprise bills.

Vercel deprecated end-to-end. WebR moves in as part of this migration (client-side R eliminates Vercel Sandbox dependency).

---

## 8. Unit economics — conservative

Prior estimates were optimistic. This section uses conservative assumptions across the board; treat the resulting margin as the **floor**, not the expected value.

### Conservative assumptions

- **Model**: Gemini 3.5 Flash ($1.50/M input, $9/M output, cache $0.15/M @ 90% — all confirmed via Google docs). Leading candidate for accuracy; final pick pending eval-fixture benchmark vs Kimi K2.7 and Sonnet 4.5.
- **Cache hit rate**: 80% (not 100%). Google implicit caching has TTL and prefix-drift limits.
- **System prompt**: 5,000 tokens per request. Cached at 80% hit rate → effective input cost $0.42/M blended.
- **New input per request**: 1,500 tokens (question text + choice list + image tokens ~1k).
- **Output tokens per solve** (including hidden reasoning trace):
  - CONCEPT: 800 tokens
  - RCODE call 1 (write R): 900 tokens
  - RCODE call 2 (interpret): 600 tokens
- **R repair loop**: 20% of RCODE questions trigger a repair (extra ~$0.012 call).
- **Blended split**: 40% RCODE / 60% CONCEPT.
- **Usage**: paid user avg **110 solves/mo** (10 per 2 weekdays over a semester).
- **Free : paid ratio**: 1 free per 2 paid at steady state.

### Conservative per-solve cost

| Path | Cost |
|---|---|
| CONCEPT | ~$0.012 |
| RCODE (2 calls + 20% repair overhead) | ~$0.025 |
| **Blended (40/60)** | **~$0.017** |

### Conservative per-user monthly

| Line item | $ |
|---|---|
| LLM (110 × $0.017) | $1.87 |
| Lemon Squeezy (5% + $0.50) | $1.25 |
| Vercel + infra amortized | $0.30 |
| Refunds/support (5% of revenue) | $0.75 |
| **Total COGS/user** | **$4.17** |
| Revenue | $15.00 |
| **Net profit/user** | **$10.83** |
| **Margin** | **~72%** |

**Reality range: 72–85%.** Above 72% is upside from cache hit rate exceeding 80%, repair rate under 20%, and refund rate under 5%.

### Free tier (5/day unrestricted)

- Realistic active free user: ~60 solves/mo (not everyone maxes 150).
- COGS per active free user: 60 × $0.017 = ~$1.02/mo.
- At 1:2 free:paid: bleed is negligible relative to paid net.

### Conservative scale scenarios (Gemini 3.5 Flash, 5/day free, 1:2 ratio)

| Paid | Free | Revenue | Paid net | Free bleed | **Overall net** |
|---|---|---|---|---|---|
| 100 | 50 | $1,500 | $1,083 | $51 | **$1,032** |
| 500 | 250 | $7,500 | $5,415 | $255 | **$5,160** |
| 1,000 | 500 | $15,000 | $10,830 | $510 | **$10,320** |
| 5,000 | 2,500 | $75,000 | $54,150 | $2,550 | **$51,600** |

### Kimi K2.7 alternative (for comparison, same conservative assumptions)

If K2.7 wins the eval, its blended $/solve is ~$0.010 conservative → per-user COGS ~$3.35 → net $11.65 → margin ~78%. ~$800/mo better at 1000 paid users than Gemini 3.5 Flash. Only worth it if accuracy holds — do not switch on price alone.

---

## 9. Blockers to Web Store submission

- [ ] Icons (16/32/48/128) in `apps/extension/public/icons/`, wired in manifest.
- [ ] Default API URL → production Vercel URL (currently `localhost:3030` in 3 places: [popup.ts:45](../apps/extension/src/popup.ts), [background.ts:53](../apps/extension/src/background.ts), [content.ts:191](../apps/extension/src/content.ts)).
- [ ] Privacy policy at `statshelpr.com/privacy`.
- [ ] Terms of service with academic-honesty clause.
- [ ] Reframe user-visible strings (remove "stealth"/"solve" → "explain"/"show work").
- [ ] Move auto-answer-selection behind an off-by-default toggle.
- [ ] Version drift: `health/route.ts` reports 0.2.0 vs manifest 0.4.0. Wire from a shared constant.
- [ ] Delete empty `apps/api/app/api/run-r/` directory.
- [ ] `optional_host_permissions: ["https://*/*"]` — either move behind opt-in in popup or drop.
- [ ] Data-deletion endpoint (`DELETE /api/user`) for CCPA/GDPR.

---

## 10. Known feature gaps

- Per-license rate limiting (leaked keys currently = unlimited Moonshot spend).
- Conversation follow-ups (single-shot only today).
- New Quizzes DOM selectors (manifest matches the URL, selectors target Classic Quizzes only).
- Unit tests on `lib/solver/*`.
- CI wiring for eval fixtures.
- Structured logs on `/api/solve` (licenseHash, mode, tokens, latency).

---

## 11. Model pricing snapshot (July 2026)

Kept here so future sessions don't have to re-search. Verify at provider before hardcoding — these move.

| Model | Input $/M | Output $/M | Cached | Vision |
|---|---|---|---|---|
| Claude Opus 4.8 | 5.00 | 25.00 | ~0.50 | Yes |
| Claude Sonnet 5 | 3.00 (2.00 intro→Aug 31) | 15.00 (10.00 intro) | ~0.30 | Yes |
| Claude Haiku 4.5 | 1.00 | 5.00 | ~0.10 | Yes |
| Claude Fable 5 | 10.00 | 50.00 | — | Yes |
| GPT-5.6 Sol | 5.00 | 30.00 | 90% off | Yes |
| GPT-5.6 Terra | 2.50 | 15.00 | 90% off | Yes |
| GPT-5.6 Luna | 1.00 | 6.00 | 90% off | Yes |
| GPT-5 Nano | 0.05 | 0.40 | 90% off | Limited |
| Gemini 3.1 Pro | 2.00 | 12.00 | — | Yes |
| Gemini 3 Flash | 0.50 | 3.00 | — | Yes |
| Grok 4.5 | 2.00 | 6.00 | 0.50 (75%) | Yes |
| Grok 4.1 Fast | 0.20 | 0.50 | — | — |
| Kimi K2.6 (current) | 0.66–0.95 | 3.41–4.00 | 0.10–0.16 | Yes |
| Qwen 3.6 Flash | 0.19 | 1.13 | — | — |
| DeepSeek V4 Flash | 0.14 | 0.28 | 0.028 | No |

---

## 12. Build plan — Cloudflare migration + launch

Full platform migration is now the launch scope. Model committed: **Gemini 3.5 Flash**. Platform committed: **Cloudflare** (Workers + Pages + KV). R execution: **WebR client-side**.

Detailed migration steps in [cloudflare-migration.md](cloudflare-migration.md). High-level phases:

### Day 1: Foundation

- [ ] Apply for GitHub Student Pack (@utexas.edu) — 30 min
- [ ] Cloudflare account + payment method + DNS for statshelpr.com — 30 min
- [ ] `wrangler login`, create KV namespace — 30 min
- [ ] Populate `evals/solve-fixtures/` with **200 real Canvas questions** hand-labeled — bulk of day

### Days 2–3: Workers API rewrite (migration Phase 1)

- [ ] Scaffold `apps/workers/` with wrangler.toml, Hono setup
- [ ] Move `apps/api/lib/*` → `apps/workers/src/lib/*`
- [ ] Rewrite route handlers as Hono handlers (solve, health, validate-license)
- [ ] Add new routes: `/api/interpret`, `/api/webhooks/lemonsqueezy`, `/api/feedback`, `/api/user` (DELETE)
- [ ] Adapt `providers/index.ts` to read env from Workers `Env` binding instead of `process.env`
- [ ] Delete `apps/api/lib/sandbox.ts`, `scripts/create-r-snapshot.ts`, empty `run-r/` dir
- [ ] `wrangler dev` locally, run eval fixtures against it → establish accuracy baseline

### Days 3–5: WebR client migration (migration Phase 2)

- [ ] Add `@r-wasm/webr` to extension, bundle runtime into `public/webr/`
- [ ] New `webr-runner.ts` with Web Worker + preload of 8 packages
- [ ] Pre-warm on extension install/startup in `background.ts`
- [ ] Split `content.ts` streaming — after R code arrives, run WebR then POST to `/api/interpret`
- [ ] Manifest: add `web_accessible_resources` for `webr/*` + CSP `wasm-unsafe-eval`

### Day 6: Landing page (migration Phase 3) — parallelizable with WebR work

- [ ] `apps/landing/` — static HTML+CSS or Astro; hero, features, $15/mo pricing, FAQ, privacy/ToS links
- [ ] `wrangler pages deploy apps/landing/dist`
- [ ] DNS: `statshelpr.com` → Pages, `api.statshelpr.com` → Workers

### Day 7: KV state + LS webhook (migration Phase 4)

- [ ] `src/lib/rate-limit.ts` — KV-backed 24h rolling counter, 5/day free tier
- [ ] Wire rate limit into `/api/solve` before Gemini call
- [ ] `/api/webhooks/lemonsqueezy` — HMAC verify, generate license, store to KV
- [ ] Rewrite `lib/license.ts` to read/write KV
- [ ] End-to-end purchase test: buy → email → paste key → activate → solve

### Day 8: Extension polish + sideload distribution setup

- [ ] Update extension API URL to `https://api.statshelpr.com`
- [ ] Add retry with exponential backoff around solve fetch (Workers can 5xx briefly during deploys)
- [ ] Build extension zip v1.0.0
- [ ] Add `statshelpr.com/download` page with sideload instructions

### Day 9: Cutover + go live (migration Phase 5)

- [ ] Deploy Workers app to `api.statshelpr.com` (production)
- [ ] Deploy Pages landing to `statshelpr.com` (production)
- [ ] End-to-end verification with real solves (CONCEPT + RCODE)
- [ ] Publish extension for sideload download from statshelpr.com
- [ ] Keep Vercel project alive but idle for 2-week fallback window

### Days 10+: Private beta + iterate

- [ ] Invite ~20 UT stats students to sideload
- [ ] Thumbs up/down feedback capture (already in Workers, add UI in extension)
- [ ] Watch accuracy metrics; add beta questions to `evals/solve-fixtures/`
- [ ] Fix bugs surfaced in beta

### Post-launch triggers

- [ ] 100 paid users: evaluate Dodo Payments migration (4% + $0.40 vs LS 5% + $0.50)
- [ ] 2 weeks stable on Cloudflare: delete `apps/api/` directory + shut down Vercel project
- [ ] Free-tier abuse metrics justify → add email verification + FingerprintJS
- [ ] Accuracy plateaus → consider Kimi K2.7 or Sonnet 5 swap

### Explicitly deferred

- Conversation follow-ups (`ask()`) — single-shot solves fine for v1
- New Quizzes DOM selectors — verify UT uses New Quizzes first; if Classic, defer
- FingerprintJS Pro — only if abuse metrics justify
- Structured analytics dashboard — after 50 users

## 13. Working style notes (for future me)

- User wants me to look up current LLM/pricing data via WebSearch, not answer from memory — prices change monthly.
- Direct answers with concrete numbers. Skip disclaimers, skip repeating context.
- Conservative estimates on costs/margins. Give ranges, never inflate.
- No help with Chrome Web Store review-evasion / masking strategies. Path forward is genuine tutor reframe.
- Comfortable with TS, ships code, doesn't need hand-holding on architecture.
