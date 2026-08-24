/**
 * Self-test for the pure/near-pure logic behind the security-audit fixes:
 * lib/rate-limit.ts's options-driven bucketing + optimistic recheck, and
 * lib/kill-switch.ts's global ceiling.
 *
 * Also covers lib/license-activation.ts's keyed activation hash (privacy fix,
 * 2026-07-27): that its hash space stays DISJOINT from rate-limit.ts's
 * hashBucket — the values that end up in lib/metrics-store.ts's daily
 * `installHashes` sets — that it fails closed without its secret, and that
 * activations written under the old unsalted hash still migrate instead of
 * logging a paying customer out.
 *
 * Used to also cover a signed hand-off token's sign/verify contract (the
 * primary fix for the old /api/interpret unbounded-LLM-cost hole) — that
 * module and its tests were removed when /api/interpret itself was retired
 * by the Cloud Run R-execution migration: the interpret pass is now an
 * internal leg of /api/solve, covered by that one request's own
 * auth/license/rate-limit gates, so the hand-off token this used to sign no
 * longer has a separate call to bind together (see
 * docs/cloud-run-r-migration.md §3). The per-install + per-IP + global
 * kill-switch limits below still apply to /api/solve and are still
 * exercised here.
 *
 * 2026-08-04 (owner directive — caps rework) added three more sections,
 * still against the SAME FakeCountersNamespace (now extended to mirror
 * counters-do.ts's `incr`/`setConfig` additions exactly, not just
 * `gate`/`addSpend`):
 *  - lib/kill-switch.ts's computeEffectiveSpendLimitUsd (pure formula) and
 *    checkGlobalKillSwitch's end-to-end pickup of a cron-persisted
 *    subscriber-scaled ceiling, including the floor/stale/corrupt-value
 *    fallback paths — CHANGE 2.
 *  - lib/kill-switch.ts's decidePaidSoftThrottle (pure threshold arithmetic)
 *    and counters-do.ts's `incr` op (always applies, even when a blocking
 *    check in the same gate call fails) — CHANGE 3.
 *  - fail-open behavior for BOTH of the above when the DO is unreachable
 *    (a BrokenCountersNamespace whose fetch always throws).
 *
 * Same plain-tsx pattern as self-test-metrics.ts (no vitest in this
 * workspace) — run via:
 *
 *   <repo-root>/node_modules/.pnpm/node_modules/.bin/tsx apps/workers/scripts/self-test-security.ts
 *
 * rate-limit.ts / kill-switch.ts need a KVNamespace — faked in-memory below
 * (just the get/put subset these modules actually call) rather than pulled
 * in from a real Cloudflare account, so this needs nothing else running.
 *
 * Exit code is 0 if every check passes, 1 otherwise (CI-friendly).
 */

import type { Context } from "hono";
import { doGate, doSetConfig } from "../src/lib/counters-do";
import {
  GLOBAL_SPEND_KEY,
  GLOBAL_SPEND_LIMIT_CFG_KEY,
  SPEND_LIMIT_STALENESS_MS,
  buildPaidSoftCapIncrItems,
  checkGlobalKillSwitch,
  computeEffectiveSpendLimitUsd,
  decidePaidSoftThrottle,
  globalCallLimit,
  globalSpendLimitUsd,
  perSubDailySpendUsd,
  persistEffectiveSpendLimit,
} from "../src/lib/kill-switch";
import {
  activateForInstall,
  activationHash,
  legacyActivationHash,
} from "../src/lib/license-activation";
import { checkAndIncrement, getClientIp, hashBucket } from "../src/lib/rate-limit";
import type { Env } from "../src/types";

let pass = 0;
let fail = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

async function main() {
  // ---------------------------------------------------------------------------
  // In-memory fake of just the KVNamespace subset checkAndIncrement actually
  // calls (get with "json" type, put with an expirationTtl option) — enough
  // to exercise the real get/recheck/put logic without a real KV binding.
  // ---------------------------------------------------------------------------
  class FakeKv {
    private store = new Map<string, string>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal test double, not the full KVNamespace surface
    async get(key: string, type?: unknown): Promise<any> {
      const v = this.store.get(key);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    }
    async put(key: string, value: string): Promise<void> {
      this.store.set(key, value);
    }
    async delete(key: string): Promise<void> {
      this.store.delete(key);
    }
    has(key: string): boolean {
      return this.store.has(key);
    }
  }

  // ---------------------------------------------------------------------------
  // In-memory fake of the CountersDO fetch contract (DO switch, 2026-07-29;
  // extended 2026-08-04 for the caps-rework `incr`/`setConfig` ops) —
  // lib/kill-switch.ts's checkGlobalKillSwitch now gates through
  // lib/counters-do.ts's doGate instead of KV, so the kill-switch checks
  // below need a namespace whose stub answers the {op:"gate"} /
  // {op:"addSpend"} / {op:"setConfig"} JSON ops with the SAME
  // in-order/stop-at-first-failure/unconditional-incr semantics the real
  // SQLite-backed class implements (mirrors CountersDO.touch/resolveSpendLimit/
  // incr/setConfig in ../src/lib/counters-do.ts line for line — keep the two
  // in sync on any future change to that file). Tsx runs outside the workers
  // runtime, so this replicates the row semantics over a Map — the REAL
  // class's SQL execution itself is NOT exercised by this file (no SQLite
  // available outside the Workers runtime); see the report for what's only
  // statically reviewed and the post-deploy verification plan for closing
  // that gap.
  // ---------------------------------------------------------------------------
  class FakeCountersNamespace {
    private rows = new Map<string, { count: number; resetAt: number }>();
    idFromName(_name: string): unknown {
      return "fake-id";
    }
    get(_id: unknown): { fetch: (url: string, init?: { body?: string }) => Promise<Response> } {
      return {
        fetch: async (_url, init) => {
          const body = JSON.parse(init?.body ?? "{}") as {
            op: string;
            checks?: { key: string; limit: number }[];
            spend?: { key: string; limitUsd: number; cfgKey?: string };
            incr?: { key: string; resetAtIfFresh: number }[];
            key?: string;
            usd?: number;
            value?: number;
            staleAfterMs?: number;
          };
          const now = Date.now();
          // Mirrors CountersDO.touch, including the 2026-08-04
          // caller-chosen `freshResetAt` param.
          const touch = (key: string, freshResetAt = now + 86_400_000) => {
            const row = this.rows.get(key);
            if (!row || row.resetAt < now) return { count: 0, resetAt: freshResetAt };
            return row;
          };
          const upsert = (key: string, count: number, resetAt: number) => {
            this.rows.set(key, { count, resetAt });
          };
          // Mirrors CountersDO.resolveSpendLimit.
          const resolveSpendLimit = (spend: { limitUsd: number; cfgKey?: string }): number => {
            if (!spend.cfgKey) return spend.limitUsd;
            const cfg = touch(spend.cfgKey);
            return Math.max(spend.limitUsd, cfg.count);
          };
          // Mirrors CountersDO.incr.
          const incr = (key: string, resetAtIfFresh: number) => {
            const cur = touch(key, resetAtIfFresh);
            const newCount = cur.count + 1;
            upsert(key, newCount, cur.resetAt);
            return { count: newCount, resetAt: cur.resetAt };
          };

          if (body.op === "gate") {
            const results: { count: number; limit: number; resetAt: number }[] = [];
            let failedAt: number | "spend" | undefined;
            for (let i = 0; i < (body.checks ?? []).length; i++) {
              const check = body.checks![i]!;
              const cur = touch(check.key);
              if (cur.count >= check.limit) {
                results.push({ count: cur.count, limit: check.limit, resetAt: cur.resetAt });
                failedAt = i;
                break;
              }
              const next = { count: cur.count + 1, resetAt: cur.resetAt };
              upsert(check.key, next.count, next.resetAt);
              results.push({ count: next.count, limit: check.limit, resetAt: next.resetAt });
            }
            let spendUsd: number | undefined;
            if (failedAt === undefined && body.spend) {
              const spendRow = touch(body.spend.key);
              const limitUsd = resolveSpendLimit(body.spend);
              spendUsd = spendRow.count;
              if (spendRow.count >= limitUsd) failedAt = "spend";
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double; mirrors GateResponse loosely
            const response: any =
              failedAt !== undefined
                ? { allowed: false, failed: failedAt, results, ...(spendUsd !== undefined ? { spendUsd } : {}) }
                : { allowed: true, results, ...(spendUsd !== undefined ? { spendUsd } : {}) };
            // Unconditional — applies regardless of `failedAt` above, same
            // as the real gate()'s incr step (2026-08-04).
            if (body.incr && body.incr.length > 0) {
              response.incrResults = body.incr.map((item) => incr(item.key, item.resetAtIfFresh));
            }
            return Response.json(response);
          }
          if (body.op === "addSpend") {
            const cur = touch(body.key!);
            upsert(body.key!, cur.count + (body.usd ?? 0), cur.resetAt);
            return Response.json({ ok: true });
          }
          if (body.op === "setConfig") {
            // Mirrors CountersDO.setConfig's defensive non-finite/non-positive
            // guard exactly — a bad value is silently never written, not
            // clamped or corrected.
            if (Number.isFinite(body.value) && (body.value as number) > 0) {
              upsert(body.key!, body.value as number, Date.now() + Math.max(0, body.staleAfterMs ?? 0));
            }
            return Response.json({ ok: true });
          }
          return Response.json({ error: "unknown op" }, { status: 400 });
        },
      };
    }
    /** Test hook: seed the spend row directly (the worker-side addSpend path
     *  is fire-and-forget via waitUntil, awkward to await from here). */
    seedSpend(key: string, usd: number): void {
      this.rows.set(key, { count: usd, resetAt: Date.now() + 86_400_000 });
    }
    /** Test hook (2026-08-04): seed an arbitrary row directly — used to set
     *  up a deliberately STALE (resetAt already in the past) or CORRUPT
     *  (non-positive count) config row, which the normal write path
     *  (doSetConfig -> op:"setConfig") can't produce since setConfig itself
     *  refuses bad values and always stamps a fresh future resetAt. */
    seedRow(key: string, count: number, resetAt: number): void {
      this.rows.set(key, { count, resetAt });
    }
  }

  /** A COUNTERS_DO stub whose fetch always throws — exercises doGate's
   *  fail-open catch path (counters-do.ts) end-to-end, including the
   *  2026-08-04 `incrResults` fallback, and therefore
   *  checkGlobalKillSwitch's / the paid-soft-cap path's behavior on a DO
   *  outage. */
  class BrokenCountersNamespace {
    idFromName(_name: string): unknown {
      return "broken-id";
    }
    get(_id: unknown): { fetch: (url: string, init?: { body?: string }) => Promise<Response> } {
      return {
        fetch: async () => {
          throw new Error("simulated CountersDO outage");
        },
      };
    }
  }

  function fakeEnv(overrides: Partial<Env> = {}): Env & { COUNTERS_DO: FakeCountersNamespace } {
    return {
      OPENAI_API_KEY: "test-key",
      LLM_PROVIDER: "openai",
      FREE_TIER_DAILY_LIMIT: "7",
      // Required fields added by the Cloud Run R-execution migration (see
      // docs/cloud-run-r-migration.md §3) — not exercised by any check in
      // this file, but Env now requires both, so fakeEnv needs a value for
      // each to stay a valid Env.
      R_RUNNER_URL: "https://fake-r-runner.example.com",
      R_RUNNER_SECRET: "fake-runner-secret",
      // Keyed-hash secret for lib/license-activation.ts (privacy fix,
      // 2026-07-27). Deliberately NOT equal to any other secret here — the
      // hash-separation checks below would be meaningless if it were.
      ACTIVATION_HASH_SECRET: "fake-activation-hash-secret",
      STATSHELPR_KV: new FakeKv() as unknown as Env["STATSHELPR_KV"],
      COUNTERS_DO: new FakeCountersNamespace() as unknown as Env["COUNTERS_DO"],
      ...overrides,
    } as Env & { COUNTERS_DO: FakeCountersNamespace };
  }

  function fakeContext(headers: Record<string, string>): Context<{ Bindings: Env }> {
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      req: { header: (name: string) => lower[name.toLowerCase()] },
    } as unknown as Context<{ Bindings: Env }>;
  }

  // ---------------------------------------------------------------------------
  console.log("rate-limit.ts (checkAndIncrement options + optimistic recheck)");

  {
    const env = fakeEnv();
    const r1 = await checkAndIncrement(env, "install-A");
    const r2 = await checkAndIncrement(env, "install-A");
    check("default call: first hit allowed at count 1", r1.allowed === true && r1.count === 1, JSON.stringify(r1));
    check("default call: second hit increments to count 2", r2.allowed === true && r2.count === 2, JSON.stringify(r2));
    check("default call: limit comes from FREE_TIER_DAILY_LIMIT (7)", r1.limit === 7 && r2.limit === 7);
  }

  {
    // Custom limit via options — blocks at the CUSTOM limit, not the env default.
    const env = fakeEnv();
    let last;
    for (let i = 0; i < 3; i++) {
      last = await checkAndIncrement(env, "install-B", { limit: 2, keyPrefix: "rl:custom:" });
    }
    check("custom limit=2: 3rd call is blocked", last?.allowed === false, JSON.stringify(last));
    check("custom limit=2: blocked count reflects the cap, not beyond it", last?.count === 2, JSON.stringify(last));
  }

  {
    // Prefix isolation: the SAME raw bucket id under two different
    // keyPrefixes must be tracked independently — this is how
    // routes/solve.ts's per-install counter ("rl:", the default) stays
    // separate from its own per-IP counter ("rl:ip:solve:") even on inputs
    // that could otherwise collide.
    const env = fakeEnv();
    await checkAndIncrement(env, "shared-id", { limit: 5, keyPrefix: "rl:scope-a:" });
    await checkAndIncrement(env, "shared-id", { limit: 5, keyPrefix: "rl:scope-a:" });
    const scopeB = await checkAndIncrement(env, "shared-id", { limit: 5, keyPrefix: "rl:scope-b:" });
    check(
      "same bucket id, different keyPrefix -> independent counters (scope-b still at count 1)",
      scopeB.count === 1,
      JSON.stringify(scopeB),
    );
  }

  {
    // Empty/undefined bucket id falls back to a shared "anon" bucket rather
    // than throwing or hashing an empty string differently each time.
    const env = fakeEnv();
    const a = await checkAndIncrement(env, "");
    const b = await checkAndIncrement(env, "anon");
    check("empty bucket id and literal \"anon\" share one bucket", a.count === 1 && b.count === 2, `${a.count}, ${b.count}`);
  }
  {
    // hashBucket: verifies 32 hex chars (128-bit slice of SHA-256)
    const hash = await hashBucket("test-identifier-12345");
    check("hashBucket produces exactly 32 hex chars (128-bit slice)", /^[0-9a-f]{32}$/.test(hash) && hash.length === 32, hash);
    const hash2 = await hashBucket("test-identifier-12345");
    check("hashBucket is deterministic", hash === hash2);
  }
  {
    // Defensive fallback: negative FREE_TIER_DAILY_LIMIT string falls back to default (7)
    const env = fakeEnv({ FREE_TIER_DAILY_LIMIT: "-5" });
    const r = await checkAndIncrement(env, "install-defensive");
    check("negative FREE_TIER_DAILY_LIMIT falls back to default 7", r.limit === 7, `got ${r.limit}`);
  }

  // ---------------------------------------------------------------------------
  console.log("rate-limit.ts (getClientIp)");

  {
    const c = fakeContext({ "CF-Connecting-IP": "1.2.3.4", "X-Forwarded-For": "9.9.9.9" });
    check("cf-connecting-ip wins over x-forwarded-for", getClientIp(c) === "1.2.3.4");
  }
  {
    const c = fakeContext({ "X-Forwarded-For": "9.9.9.9, 8.8.8.8" });
    check("falls back to the FIRST hop of x-forwarded-for", getClientIp(c) === "9.9.9.9");
  }
  {
    const c = fakeContext({});
    check("falls back to \"unknown\" with neither header present", getClientIp(c) === "unknown");
  }

  // ---------------------------------------------------------------------------
  console.log("kill-switch.ts (spend/call limit arithmetic validation)");

  {
    check("globalCallLimit: valid positive string parses", globalCallLimit(fakeEnv({ GLOBAL_DAILY_CALL_LIMIT: "500" })) === 500);
    check("globalCallLimit: negative string falls back to 1000", globalCallLimit(fakeEnv({ GLOBAL_DAILY_CALL_LIMIT: "-10" })) === 1000);
    check("globalCallLimit: zero string falls back to 1000", globalCallLimit(fakeEnv({ GLOBAL_DAILY_CALL_LIMIT: "0" })) === 1000);
    check("globalCallLimit: non-numeric string falls back to 1000", globalCallLimit(fakeEnv({ GLOBAL_DAILY_CALL_LIMIT: "garbage" })) === 1000);

    check("globalSpendLimitUsd: valid positive string parses", globalSpendLimitUsd(fakeEnv({ GLOBAL_DAILY_SPEND_LIMIT_USD: "50" })) === 50);
    check("globalSpendLimitUsd: negative string falls back to 25", globalSpendLimitUsd(fakeEnv({ GLOBAL_DAILY_SPEND_LIMIT_USD: "-25" })) === 25);
    check("globalSpendLimitUsd: zero string falls back to 25", globalSpendLimitUsd(fakeEnv({ GLOBAL_DAILY_SPEND_LIMIT_USD: "0" })) === 25);
    check("globalSpendLimitUsd: non-numeric string falls back to 25", globalSpendLimitUsd(fakeEnv({ GLOBAL_DAILY_SPEND_LIMIT_USD: "abc" })) === 25);

    check("perSubDailySpendUsd: valid positive string parses", perSubDailySpendUsd(fakeEnv({ PER_SUB_DAILY_SPEND_USD: "4.5" })) === 4.5);
    check("perSubDailySpendUsd: negative string falls back to 2", perSubDailySpendUsd(fakeEnv({ PER_SUB_DAILY_SPEND_USD: "-5" })) === 2);
    check("perSubDailySpendUsd: zero string falls back to 2", perSubDailySpendUsd(fakeEnv({ PER_SUB_DAILY_SPEND_USD: "0" })) === 2);
    check("perSubDailySpendUsd: non-numeric string falls back to 2", perSubDailySpendUsd(fakeEnv({ PER_SUB_DAILY_SPEND_USD: "invalid" })) === 2);
  }

  // ---------------------------------------------------------------------------
  console.log("kill-switch.ts (checkGlobalKillSwitch)");

  {
    const env = fakeEnv({ GLOBAL_DAILY_CALL_LIMIT: "2" });
    const r1 = await checkGlobalKillSwitch(env);
    const r2 = await checkGlobalKillSwitch(env);
    const r3 = await checkGlobalKillSwitch(env);
    check("global switch: allows up to the configured ceiling", r1.allowed && r2.allowed, `${r1.allowed}, ${r2.allowed}`);
    check("global switch: trips on the call past the ceiling", r3.allowed === false, JSON.stringify(r3));
  }
  {
    const env = fakeEnv(); // no GLOBAL_DAILY_CALL_LIMIT set
    const r1 = await checkGlobalKillSwitch(env);
    check("global switch: falls back to the documented default (1000) when unset", r1.limit === 1000, `got ${r1.limit}`);
  }
  {
    // routes/solve.ts now calls checkGlobalKillSwitch multiple times per
    // request for a calc question (first pass, optional repair, interpret —
    // see docs/cloud-run-r-migration.md §3), but it's the SAME global
    // counter every time — confirm three sequential calls sharing one KV do
    // in fact share state (same bucket id/prefix regardless of which leg is
    // calling), by reusing one env/KV.
    const env = fakeEnv({ GLOBAL_DAILY_CALL_LIMIT: "3" });
    await checkGlobalKillSwitch(env); // simulates the first-pass leg
    await checkGlobalKillSwitch(env); // simulates the repair leg
    const third = await checkGlobalKillSwitch(env); // simulates the interpret leg
    check("global switch: every leg shares ONE combined counter", third.count === 3, JSON.stringify(third));
  }
  {
    // Dollar ceiling (DO switch, 2026-07-29): once the day's accumulated
    // REAL spend crosses GLOBAL_DAILY_SPEND_LIMIT_USD, the gate refuses even
    // with the call count far under its own ceiling. Spend is seeded via the
    // fake's test hook — the production write path (doAddSpendInBackground)
    // is fire-and-forget behind waitUntil, so a direct seed keeps this check
    // deterministic.
    const env = fakeEnv({ GLOBAL_DAILY_CALL_LIMIT: "100", GLOBAL_DAILY_SPEND_LIMIT_USD: "5" });
    env.COUNTERS_DO.seedSpend(GLOBAL_SPEND_KEY, 6);
    const r = await checkGlobalKillSwitch(env);
    check(
      "global switch: dollar ceiling refuses independently of the call count",
      r.allowed === false,
      JSON.stringify(r),
    );
  }

  // ---------------------------------------------------------------------------
  console.log("kill-switch.ts (computeEffectiveSpendLimitUsd — subscriber-scaled ceiling formula, CHANGE 2)");

  {
    const env = fakeEnv(); // default floor $25, default per-sub $2/day
    check(
      "0 subscribers: effective ceiling is exactly the floor (today's behavior, unchanged)",
      computeEffectiveSpendLimitUsd(env, 0) === 25,
      `got ${computeEffectiveSpendLimitUsd(env, 0)}`,
    );
  }
  {
    const env = fakeEnv();
    // 5 subs x $2 = $10, well under the $25 floor -> floor wins.
    check(
      "a handful of subscribers: scaled amount under the floor -> floor still wins",
      computeEffectiveSpendLimitUsd(env, 5) === 25,
      `got ${computeEffectiveSpendLimitUsd(env, 5)}`,
    );
  }
  {
    const env = fakeEnv();
    // 100 subs x $2 = $200 > $25 floor -> scaled wins (the brief's worked example).
    check(
      "100 subscribers: max(25, 100 x 2) = $200/day",
      computeEffectiveSpendLimitUsd(env, 100) === 200,
      `got ${computeEffectiveSpendLimitUsd(env, 100)}`,
    );
  }
  {
    const env = fakeEnv({ GLOBAL_DAILY_SPEND_LIMIT_USD: "50", PER_SUB_DAILY_SPEND_USD: "3" });
    check(
      "custom floor + per-sub rate, below crossover: max(50, 10 x 3) = 50",
      computeEffectiveSpendLimitUsd(env, 10) === 50,
      `got ${computeEffectiveSpendLimitUsd(env, 10)}`,
    );
    check(
      "custom floor + per-sub rate, above crossover: max(50, 30 x 3) = 90",
      computeEffectiveSpendLimitUsd(env, 30) === 90,
      `got ${computeEffectiveSpendLimitUsd(env, 30)}`,
    );
  }
  {
    const env = fakeEnv();
    check(
      "a negative/garbage subscriber count floors at 0 -- never pulls the ceiling below the floor",
      computeEffectiveSpendLimitUsd(env, -5) === 25,
      `got ${computeEffectiveSpendLimitUsd(env, -5)}`,
    );
  }

  // ---------------------------------------------------------------------------
  console.log("kill-switch.ts (checkGlobalKillSwitch — cron -> CountersDO -> gate ceiling override, CHANGE 2)");

  {
    // End-to-end through the REAL write path (persistEffectiveSpendLimit ->
    // doSetConfig -> {op:"setConfig"}) and the REAL read path
    // (checkGlobalKillSwitch -> doGate -> {op:"gate", spend:{cfgKey}}) — not
    // just the fake's seed hooks. This is the closest this tsx harness can
    // get to exercising the actual cron -> storage -> gate flow without the
    // real Workers/DO runtime.
    const env = fakeEnv({ GLOBAL_DAILY_SPEND_LIMIT_USD: "25", GLOBAL_DAILY_CALL_LIMIT: "1000" });
    env.COUNTERS_DO.seedSpend(GLOBAL_SPEND_KEY, 30); // $30 spent today

    const before = await checkGlobalKillSwitch(env);
    check(
      "MISSING config (cron never ran): $30 spend trips the bare $25 floor",
      before.allowed === false,
      JSON.stringify(before),
    );

    const persisted = await persistEffectiveSpendLimit(env, 100); // 100 subs x $2 = $200
    check("persistEffectiveSpendLimit computes and returns the scaled ceiling", persisted === 200, `got ${persisted}`);

    const after = await checkGlobalKillSwitch(env);
    check(
      "after persisting: the SAME $30 spend no longer trips the now-$200 effective ceiling",
      after.allowed === true,
      JSON.stringify(after),
    );
  }
  {
    // STALE: a config row whose OWN staleness deadline (its resetAt) has
    // already passed — simulates a cron that stopped running >48h ago.
    // Can't be produced via the normal write path (setConfig always stamps
    // a fresh future resetAt), so this seeds the row directly.
    const env = fakeEnv();
    env.COUNTERS_DO.seedSpend(GLOBAL_SPEND_KEY, 30);
    env.COUNTERS_DO.seedRow(GLOBAL_SPEND_LIMIT_CFG_KEY, 200, Date.now() - 1_000);
    const r = await checkGlobalKillSwitch(env);
    check(
      "STALE cron-persisted ceiling (past its own staleness deadline) falls back to the floor",
      r.allowed === false,
      JSON.stringify(r),
    );
  }
  {
    // CORRUPT: a non-positive value sitting in a row with a FRESH resetAt —
    // simulates storage corruption bypassing setConfig's own guard. Math.max
    // against the floor must still win.
    const env = fakeEnv();
    env.COUNTERS_DO.seedSpend(GLOBAL_SPEND_KEY, 30);
    env.COUNTERS_DO.seedRow(GLOBAL_SPEND_LIMIT_CFG_KEY, -50, Date.now() + 999_999);
    const r = await checkGlobalKillSwitch(env);
    check(
      "CORRUPT (non-positive) cron-persisted value never lowers the ceiling below the floor",
      r.allowed === false,
      JSON.stringify(r),
    );
  }
  {
    // setConfig's OWN defensive guard (distinct from resolveSpendLimit's
    // Math.max safety net above) — a bad value passed through the REAL
    // doSetConfig write path must never even be written, so a later gate
    // call sees "missing", not "corrupt-but-present".
    const env = fakeEnv();
    env.COUNTERS_DO.seedSpend(GLOBAL_SPEND_KEY, 30);
    await doSetConfig(env, GLOBAL_SPEND_LIMIT_CFG_KEY, -10, SPEND_LIMIT_STALENESS_MS);
    const r = await checkGlobalKillSwitch(env);
    check(
      "doSetConfig/setConfig refuse to persist a non-positive value at write time",
      r.allowed === false,
      JSON.stringify(r),
    );
  }

  // ---------------------------------------------------------------------------
  console.log("kill-switch.ts (decidePaidSoftThrottle — paid-tier soft-cap threshold arithmetic, CHANGE 3)");

  {
    check("at the daily threshold exactly (100): not throttled", decidePaidSoftThrottle(100, 0).throttle === false);
    const d101 = decidePaidSoftThrottle(101, 0);
    check(
      "one past the daily threshold (101): throttled, reason 'daily'",
      d101.throttle === true && d101.reason === "daily",
      JSON.stringify(d101),
    );
    check("at the monthly threshold exactly (600): not throttled", decidePaidSoftThrottle(0, 600).throttle === false);
    const m601 = decidePaidSoftThrottle(0, 601);
    check(
      "one past the monthly threshold (601): throttled, reason 'monthly'",
      m601.throttle === true && m601.reason === "monthly",
      JSON.stringify(m601),
    );
    const both = decidePaidSoftThrottle(150, 700);
    check(
      "past BOTH thresholds: daily takes precedence (checked first)",
      both.throttle === true && both.reason === "daily",
      JSON.stringify(both),
    );
    check("under both thresholds: not throttled", decidePaidSoftThrottle(50, 300).throttle === false);
  }

  // ---------------------------------------------------------------------------
  console.log("kill-switch.ts / counters-do.ts (buildPaidSoftCapIncrItems + incr — CHANGE 3)");

  {
    const items = buildPaidSoftCapIncrItems("install-hash-x");
    const now = Date.now();
    check(
      "daily resetAtIfFresh is ~24h out",
      items.daily.resetAtIfFresh > now && items.daily.resetAtIfFresh <= now + 86_400_000 + 1_000,
    );
    check(
      "monthly resetAtIfFresh is in the future, within one calendar month",
      items.monthly.resetAtIfFresh > now && items.monthly.resetAtIfFresh <= now + 31 * 86_400_000,
    );
    check(
      "daily/monthly keys use distinct prefixes (paid:d: / paid:m:)",
      items.daily.key.startsWith("paid:d:") && items.monthly.key.startsWith("paid:m:"),
    );
    check(
      "both keys are scoped to the SAME install hash",
      items.daily.key.endsWith("install-hash-x") && items.monthly.key.endsWith("install-hash-x"),
    );
  }
  {
    // incr counts up across calls, exactly, via the SAME doGate round trip
    // solve.ts uses.
    const env = fakeEnv();
    const items = buildPaidSoftCapIncrItems("install-hash-1");
    const g1 = await doGate(env, [], undefined, [items.daily, items.monthly]);
    const g2 = await doGate(env, [], undefined, [items.daily, items.monthly]);
    check(
      "incr counts up across calls (daily): 1, then 2",
      g1.incrResults?.[0]?.count === 1 && g2.incrResults?.[0]?.count === 2,
      JSON.stringify([g1.incrResults, g2.incrResults]),
    );
    check(
      "incr counts up across calls (monthly): 1, then 2",
      g1.incrResults?.[1]?.count === 1 && g2.incrResults?.[1]?.count === 2,
      JSON.stringify([g1.incrResults, g2.incrResults]),
    );
  }
  {
    // incr is UNCONDITIONAL: it still applies even when a BLOCKING check in
    // the SAME gate call fails — a paid solve past some OTHER ceiling still
    // needs an exact soft-cap count (see gate()'s doc in counters-do.ts).
    const env = fakeEnv();
    const items = buildPaidSoftCapIncrItems("install-hash-2");
    const g = await doGate(env, [{ key: "some:blocking:check", limit: 0 }], undefined, [items.daily]);
    check(
      "incr applies even when a blocking check in the SAME call fails",
      g.allowed === false && g.incrResults?.[0]?.count === 1,
      JSON.stringify(g),
    );
  }

  // ---------------------------------------------------------------------------
  console.log("counters-do.ts / kill-switch.ts (fail-open on counter error)");

  {
    const env = fakeEnv({ COUNTERS_DO: new BrokenCountersNamespace() as unknown as Env["COUNTERS_DO"] });
    const r = await checkGlobalKillSwitch(env);
    check("checkGlobalKillSwitch fails OPEN (allowed) when the DO is unreachable", r.allowed === true, JSON.stringify(r));
  }
  {
    const env = fakeEnv({ COUNTERS_DO: new BrokenCountersNamespace() as unknown as Env["COUNTERS_DO"] });
    const items = buildPaidSoftCapIncrItems("install-broken");
    const g = await doGate(env, [], undefined, [items.daily, items.monthly]);
    check(
      "doGate fails open on a DO outage even with incr requested",
      g.allowed === true && g.failOpen === true,
      JSON.stringify(g),
    );
    const [dailyRes, monthlyRes] = g.incrResults ?? [];
    check(
      "failed-open incrResults are zeroed, never undefined/missing",
      dailyRes?.count === 0 && monthlyRes?.count === 0,
      JSON.stringify(g.incrResults),
    );
    const decision = decidePaidSoftThrottle(dailyRes?.count ?? 0, monthlyRes?.count ?? 0);
    check(
      "a zeroed fail-open count correctly decides 'do not throttle' (fail OPEN, not fail-throttle)",
      decision.throttle === false,
      JSON.stringify(decision),
    );
  }

  // ---------------------------------------------------------------------------
  console.log("license-activation.ts (activation vs. metrics hash-space separation)");

  {
    // The bug this closes: activationHash and hashBucket were the SAME
    // unsalted sha256(x).slice(0,32). Because lib/metrics-store.ts's daily
    // `installHashes` sets are hashBucket values, anyone holding a raw
    // license key (and therefore the buyer email on the `license:` record)
    // could recompute that customer's install hash and read off which days
    // they were active. The two spaces must not intersect.
    const env = fakeEnv();
    const installId = "3f9c1b7e-0000-4a11-9c2d-abcdefabcdef";

    const keyed = await activationHash(env, installId);
    const metrics = await hashBucket(installId);
    check(
      "same install id hashes DIFFERENTLY on the activation vs. metrics side",
      keyed !== metrics,
      `activation=${keyed} metrics=${metrics}`,
    );

    // Same check for a license key, the other input this module hashes.
    const licKeyed = await activationHash(env, "LIC-ABC-123");
    check(
      "same license key hashes differently on the activation vs. metrics side",
      licKeyed !== (await hashBucket("LIC-ABC-123")),
      licKeyed,
    );

    check(
      "activation hash is still a 128-bit hex string (KV key shape unchanged)",
      /^[0-9a-f]{32}$/.test(keyed),
      keyed,
    );
    check(
      "activation hash is deterministic for a given secret",
      (await activationHash(env, installId)) === keyed,
    );
    check(
      "activation hash changes with the secret (it is genuinely keyed, not salted-in-name-only)",
      (await activationHash(fakeEnv({ ACTIVATION_HASH_SECRET: "other-secret" }), installId)) !== keyed,
    );

    // The migration fallback only works if the legacy hash is still exactly
    // what the old code wrote — i.e. still byte-identical to hashBucket. If
    // this check ever fails, live pre-migration activations became
    // unreachable and paying customers would be forced through LS /activate
    // again (and could hit the at-limit path).
    check(
      "legacy migration hash still matches hashBucket exactly (old keys remain findable)",
      (await legacyActivationHash(installId)) === metrics,
      `${await legacyActivationHash(installId)} vs ${metrics}`,
    );
  }

  {
    // Fail-closed: no secret means no activation, NOT a silent fallback to
    // the old unsalted hash (which would quietly re-open the hole above).
    const env = fakeEnv({ LEMONSQUEEZY_API_KEY: "ls-key", ACTIVATION_HASH_SECRET: undefined });
    const r = await activateForInstall(env, "LIC-ABC-123", "install-Z");
    check(
      "activation fails closed when ACTIVATION_HASH_SECRET is unset",
      r.ok === false && /ACTIVATION_HASH_SECRET/.test(r.reason ?? ""),
      JSON.stringify(r),
    );
  }

  {
    // Migration: a customer activated BEFORE the keyed-hash cutover has a
    // live record under the legacy keys (400-day TTL). Their next request
    // must succeed from KV alone — no LS /activate call (this fake env has
    // no network, so any attempt to call LS would throw or return not-ok) —
    // and must leave the record under the NEW keys with the legacy ones
    // gone.
    const kv = new FakeKv();
    const env = fakeEnv({
      LEMONSQUEEZY_API_KEY: "ls-key",
      STATSHELPR_KV: kv as unknown as Env["STATSHELPR_KV"],
    });
    const licenseKey = "LIC-LEGACY-999";
    const installId = "install-legacy-1";

    const oldLic = await legacyActivationHash(licenseKey);
    const oldInstall = await legacyActivationHash(installId);
    const oldKey = `activation:${oldLic}:${oldInstall}`;
    await kv.put(oldKey, JSON.stringify({ instanceId: "inst-legacy", licenseKeyId: 42, activatedAt: 1 }));
    await kv.put(
      `activation-current:${oldLic}`,
      JSON.stringify({ instanceId: "inst-legacy", installIdHash: oldInstall, activatedAt: 1 }),
    );

    const r = await activateForInstall(env, licenseKey, installId);
    check(
      "pre-migration activation still succeeds after the hash change (no customer logged out)",
      r.ok === true && r.activated === true,
      JSON.stringify(r),
    );

    const newLic = await activationHash(env, licenseKey);
    const newInstall = await activationHash(env, installId);
    const migrated = (await kv.get(`activation:${newLic}:${newInstall}`, "json")) as {
      instanceId?: string;
    } | null;
    check(
      "migrated record is rewritten under the keyed hash, preserving the LS instance id",
      migrated?.instanceId === "inst-legacy",
      JSON.stringify(migrated),
    );
    check("legacy activation key is deleted after migration", !kv.has(oldKey));
    check(
      "legacy activation-current key is deleted after migration",
      !kv.has(`activation-current:${oldLic}`),
    );
    check(
      "activation-current is rewritten under the keyed hash too",
      kv.has(`activation-current:${newLic}`),
    );

    // Second call is the steady state: pure keyed-hash cache hit.
    const again = await activateForInstall(env, licenseKey, installId);
    check("post-migration repeat activation is an idempotent cache hit", again.ok === true, JSON.stringify(again));
  }

  // ---------------------------------------------------------------------------
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main();
