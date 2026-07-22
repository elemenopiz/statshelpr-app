/**
 * Self-test for the pure/near-pure logic behind the security-audit fixes
 * (closing the /api/interpret unbounded-LLM-cost hole): lib/rate-limit.ts's
 * options-driven bucketing + optimistic recheck, lib/kill-switch.ts's global
 * ceiling, and lib/interpret-token.ts's sign/verify contract.
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
  base64UrlEncode,
  hmacHex,
  issueInterpretToken,
  verifyInterpretToken,
  type InterpretTokenPayload,
} from "../src/lib/interpret-token";
import { checkAndIncrement, getClientIp } from "../src/lib/rate-limit";
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
  }

  function fakeEnv(overrides: Partial<Env> = {}): Env {
    return {
      GEMINI_API_KEY: "test-key",
      LLM_PROVIDER: "gemini",
      FREE_TIER_DAILY_LIMIT: "5",
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
    // keyPrefixes must be tracked independently (this is exactly how
    // interpret's per-install counter stays separate from solve's, and how
    // solve's per-IP counter stays separate from interpret's per-IP counter
    // — see routes/solve.ts / routes/interpret.ts).
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
    // Solve and interpret each call checkGlobalKillSwitch independently per
    // request, but it's the SAME global counter either way — confirm two
    // separate fakeEnv() instances sharing one KV would in fact share state
    // (same bucket id/prefix regardless of caller), by reusing one env/KV.
    const env = fakeEnv({ GLOBAL_DAILY_CALL_LIMIT: "3" });
    await checkGlobalKillSwitch(env); // simulates a solve.ts call
    await checkGlobalKillSwitch(env); // simulates an interpret.ts call
    const third = await checkGlobalKillSwitch(env); // simulates another solve.ts call
    check("global switch: solve+interpret share ONE combined counter", third.count === 3, JSON.stringify(third));
  }

  // ---------------------------------------------------------------------------
  console.log("interpret-token.ts (issue/verify)");

  {
    const env = fakeEnv({ INTERPRET_SIGNING_SECRET: "test-secret-please-ignore" });
    const token = await issueInterpretToken(env, "install-X");
    check("issue: returns a token when the secret is configured", typeof token === "string" && token.length > 0);

    const ok = await verifyInterpretToken(env, token, "install-X");
    check("verify: a freshly issued token verifies for the SAME caller install id", ok.ok === true, JSON.stringify(ok));

    const wrongCaller = await verifyInterpretToken(env, token, "install-Y");
    check("verify: rejects when the caller's install id differs from the minted one", wrongCaller.ok === false);
  }

  {
    // Fail-closed contract (must match DASHBOARD_PASSWORD/METRICS_TOKEN):
    // an unset secret rejects EVERY verify call, and issue emits nothing to
    // verify in the first place.
    const env = fakeEnv(); // INTERPRET_SIGNING_SECRET unset
    const token = await issueInterpretToken(env, "install-X");
    check("issue: returns undefined when INTERPRET_SIGNING_SECRET is unset (fail closed)", token === undefined);

    const verifyWithoutSecret = await verifyInterpretToken(env, "anything.at-all", "install-X");
    check(
      "verify: rejects outright when INTERPRET_SIGNING_SECRET is unset, even given SOME token string",
      verifyWithoutSecret.ok === false,
    );

    const verifyMissingToken = await verifyInterpretToken(
      fakeEnv({ INTERPRET_SIGNING_SECRET: "s" }),
      undefined,
      "install-X",
    );
    check("verify: rejects a missing token even when the secret IS configured", verifyMissingToken.ok === false);
  }

  {
    const env = fakeEnv({ INTERPRET_SIGNING_SECRET: "test-secret-please-ignore" });
    const token = await issueInterpretToken(env, "install-X");
    const tampered = token ? token.slice(0, -1) + (token.endsWith("a") ? "b" : "a") : "";
    const result = await verifyInterpretToken(env, tampered, "install-X");
    check("verify: a single flipped signature character is rejected", result.ok === false);
  }

  {
    const result = await verifyInterpretToken(
      fakeEnv({ INTERPRET_SIGNING_SECRET: "s" }),
      "not-a-well-formed-token-at-all",
      "install-X",
    );
    check("verify: a malformed token (no '.' separator) is rejected, not thrown", result.ok === false);
  }

  {
    // Hand-build an already-expired token using the exported primitives —
    // issueInterpretToken's real TTL is 10 minutes, too long to wait out in
    // a test, so this constructs the exact same shape with `exp` in the past.
    const secret = "test-secret-please-ignore";
    const env = fakeEnv({ INTERPRET_SIGNING_SECRET: secret });
    const payload: InterpretTokenPayload = { iid: "install-X", nonce: "test-nonce", exp: Date.now() - 1000 };
    const payloadJson = JSON.stringify(payload);
    const sig = await hmacHex(secret, payloadJson);
    const expiredToken = `${base64UrlEncode(payloadJson)}.${sig}`;

    const result = await verifyInterpretToken(env, expiredToken, "install-X");
    check("verify: an expired (but otherwise validly signed) token is rejected", result.ok === false, JSON.stringify(result));
  }

  {
    // A token signed with a DIFFERENT secret than the one currently
    // configured must fail — simulates a secret rotation, or simply
    // confirms the signature actually depends on the secret at all.
    const payload: InterpretTokenPayload = { iid: "install-X", nonce: "n", exp: Date.now() + 60_000 };
    const payloadJson = JSON.stringify(payload);
    const sig = await hmacHex("wrong-secret", payloadJson);
    const forged = `${base64UrlEncode(payloadJson)}.${sig}`;

    const result = await verifyInterpretToken(fakeEnv({ INTERPRET_SIGNING_SECRET: "real-secret" }), forged, "install-X");
    check("verify: a token signed with a different secret is rejected", result.ok === false);
  }

  {
    // "anon" fallback parity: an install-id-less /api/solve call mints a
    // token bound to "anon", and an install-id-less /api/interpret call
    // must verify against that SAME "anon" fallback (both routes use
    // `installId || "anon"` — see routes/solve.ts / routes/interpret.ts).
    const env = fakeEnv({ INTERPRET_SIGNING_SECRET: "test-secret-please-ignore" });
    const token = await issueInterpretToken(env, "");
    const result = await verifyInterpretToken(env, token, "");
    check("issue('') and verify('') both fall back to \"anon\" and match", result.ok === true, JSON.stringify(result));
  }

  // ---------------------------------------------------------------------------
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main();
