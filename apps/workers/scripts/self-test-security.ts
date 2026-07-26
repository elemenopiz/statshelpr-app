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
 * Same plain-tsx pattern as self-test-metrics.ts (no vitest in this
 * workspace) — run via:
 *
 *   pnpm --filter @statshelpr/api exec tsx ../workers/scripts/self-test-security.ts
 *
 * rate-limit.ts / kill-switch.ts need a KVNamespace — faked in-memory below
 * (just the get/put subset these modules actually call) rather than pulled
 * in from a real Cloudflare account, so this needs nothing else running.
 *
 * Exit code is 0 if every check passes, 1 otherwise (CI-friendly).
 */

import type { Context } from "hono";
import { checkGlobalKillSwitch } from "../src/lib/kill-switch";
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

  function fakeEnv(overrides: Partial<Env> = {}): Env {
    return {
      GEMINI_API_KEY: "test-key",
      LLM_PROVIDER: "gemini",
      FREE_TIER_DAILY_LIMIT: "5",
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
      ...overrides,
    } as Env;
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
    check("default call: limit comes from FREE_TIER_DAILY_LIMIT (5)", r1.limit === 5 && r2.limit === 5);
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
