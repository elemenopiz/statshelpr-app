/**
 * Signed, short-lived token binding a single /api/interpret call to a
 * /api/solve call that already ran (and was already rate-limited/counted).
 * Security-audit item A — the primary fix.
 *
 * THE HOLE THIS CLOSES: /api/interpret used to trust whatever
 * rCode/stdout/questionText a caller sent it directly — nothing linked an
 * interpret call to a prior solve, and lib/license.ts's validateLicense()
 * returns `{ok: true, tier: "free"}` for an EMPTY license key (correct,
 * by-design free-tier behavior for /api/solve, which then rate-limits that
 * caller) — but /api/interpret had NO rate limit of its own and no way to
 * tell a real hand-off apart from a fabricated direct POST. Anyone could
 * script fake rCode/stdout/questionText straight at /api/interpret and get
 * unlimited free Gemini-billed completions, entirely bypassing /api/solve's
 * daily cap.
 *
 * THE FIX: /api/solve mints one of these tokens ONLY at the moment it
 * legitimately hands off a "rcode" result (the one path that needs a
 * follow-up /api/interpret call — see routes/solve.ts), and includes it in
 * that SSE result event. /api/interpret then requires a valid, unexpired,
 * install-id-matching token before it will touch Gemini at all (see
 * routes/interpret.ts) — rejecting with 403 otherwise. Getting a usable
 * token therefore requires having just made a real, rate-limited, counted
 * /api/solve call.
 *
 * FORMAT: `${base64url(JSON.stringify(payload))}.${hex(HMAC-SHA256(secret, payloadJson))}`
 * — a compact, stateless, self-verifying token. No KV lookup is needed to
 * verify it, which is a deliberate choice: this token is NOT single-use /
 * NOT tracked server-side per-nonce. A leaked or replayed token is bounded
 * by two OTHER, independent layers — NOT this module:
 *   1. Its own short TTL (below).
 *   2. /api/interpret's own independent per-install AND per-IP rate limit
 *      (lib/rate-limit.ts, wired in routes/interpret.ts — security-audit
 *      item B/C), which caps how many times ANY token(s) can be redeemed by
 *      a given caller per day regardless of validity.
 * If single-use enforcement is ever wanted, the natural extension is a KV
 * `interpret-nonce:{payload.nonce}` write-once marker with a TTL matching
 * TOKEN_TTL_MS — not implemented here, to keep this module stateless (no KV
 * dependency, no new race window — see lib/rate-limit.ts's doc comment on
 * that class of problem) for what would be a marginal gain over the rate
 * limit that already exists.
 *
 * SECRET: INTERPRET_SIGNING_SECRET (`wrangler secret put
 * INTERPRET_SIGNING_SECRET`, e.g. generated with `openssl rand -hex 32`).
 * *** MUST BE SET BEFORE DEPLOY — see wrangler.toml. ***
 * FAILS CLOSED if unset: `issueInterpretToken` returns `undefined` (so
 * routes/solve.ts just omits the token from its response) and
 * `verifyInterpretToken` always rejects. Same fail-closed contract as
 * routes/dashboard.ts's DASHBOARD_PASSWORD and routes/metrics.ts's
 * METRICS_TOKEN: an unset secret must never silently open the gate, so the
 * calc/RCODE question path is simply unusable until this secret is set —
 * deliberate, so shipping this fix forces a conscious deploy step instead of
 * quietly leaving the hole open.
 */

import type { Env } from "../types";
import { timingSafeEqualStr } from "./timing-safe-equal";

/** 10 minutes. Long enough to cover WebR's one-time ~15s cold boot plus
 *  however long the R code itself takes to run client-side (see
 *  apps/extension/src/webr-runner.ts / content.ts's onSolve RCODE branch —
 *  that gap is entirely where the delay between minting this token and
 *  redeeming it comes from); short enough that a captured token is only a
 *  narrow window of exposure, per the audit's "5-10 min TTL" guidance. */
const TOKEN_TTL_MS = 10 * 60 * 1000;

export interface InterpretTokenPayload {
  /** The install id this token was minted for — the SAME raw value as the
   *  X-Install-Id header (not PII, see apps/extension/src/install-id.ts),
   *  not a hash: it's already sent in the clear on every request, so
   *  round-tripping it through this token exposes nothing new. "anon" when
   *  the minting request had no install id, matching lib/rate-limit.ts's
   *  fallback bucket convention. */
  iid: string;
  /** Unique per mint (crypto.randomUUID()). Not currently enforced
   *  single-use (see module doc) — kept so a future single-use upgrade has
   *  something to key a KV marker off without a token-format change. */
  nonce: string;
  /** Epoch ms after which this token is no longer valid. */
  exp: number;
}

export interface InterpretTokenCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Mint a token for `installId`. Returns `undefined` if
 * INTERPRET_SIGNING_SECRET isn't configured — routes/solve.ts should just
 * omit the token from its response in that case; routes/interpret.ts's
 * verify side fails closed on that same unset secret, so the net effect is
 * "calc/RCODE questions don't work until the secret is set", never "the hole
 * reopens because the check silently no-ops".
 */
export async function issueInterpretToken(env: Env, installId: string): Promise<string | undefined> {
  const secret = env.INTERPRET_SIGNING_SECRET;
  if (!secret) return undefined;

  const payload: InterpretTokenPayload = {
    iid: installId || "anon",
    nonce: crypto.randomUUID(),
    exp: Date.now() + TOKEN_TTL_MS,
  };
  const payloadJson = JSON.stringify(payload);
  const sig = await hmacHex(secret, payloadJson);
  return `${base64UrlEncode(payloadJson)}.${sig}`;
}

/**
 * Verify a token against the CALLER's install id — the X-Install-Id header
 * on the /api/interpret request itself, never read out of the token blindly
 * (that would let a stolen token be replayed under a different declared
 * install id and land in a fresh rate-limit bucket). Checks, in order:
 * secret configured, well-formed, signature, expiry, install-id match.
 */
export async function verifyInterpretToken(
  env: Env,
  token: string | undefined,
  callerInstallId: string,
): Promise<InterpretTokenCheck> {
  const secret = env.INTERPRET_SIGNING_SECRET;
  if (!secret) {
    return { ok: false, reason: "Interpret signing secret not configured on the server." };
  }
  if (!token) {
    return { ok: false, reason: "Missing interpret token — call /api/solve first." };
  }

  const dotIdx = token.indexOf(".");
  if (dotIdx <= 0 || dotIdx === token.length - 1) {
    return { ok: false, reason: "Malformed interpret token." };
  }
  const payloadPart = token.slice(0, dotIdx);
  const sigPart = token.slice(dotIdx + 1);

  let payloadJson: string;
  try {
    payloadJson = base64UrlDecode(payloadPart);
  } catch {
    return { ok: false, reason: "Malformed interpret token." };
  }

  const expectedSig = await hmacHex(secret, payloadJson);
  if (!timingSafeEqualStr(expectedSig, sigPart)) {
    return { ok: false, reason: "Invalid interpret token." };
  }

  let payload: InterpretTokenPayload;
  try {
    payload = JSON.parse(payloadJson) as InterpretTokenPayload;
  } catch {
    return { ok: false, reason: "Malformed interpret token payload." };
  }

  if (typeof payload.exp !== "number" || Date.now() > payload.exp) {
    return { ok: false, reason: "Interpret token expired — call /api/solve again." };
  }

  const callerIid = callerInstallId || "anon";
  if (payload.iid !== callerIid) {
    return { ok: false, reason: "Interpret token does not match this caller." };
  }

  return { ok: true };
}

/** Exported for apps/workers/scripts/self-test-security.ts, which hand-builds
 *  tokens (e.g. a pre-expired one) to test verifyInterpretToken's edge cases
 *  without waiting out a real 10-minute TTL. Also a perfectly reasonable
 *  general-purpose HMAC-hex helper otherwise (mirrors routes/
 *  lemonsqueezy-webhook.ts's private `verifySignature` helper, duplicated
 *  rather than imported to avoid coupling an unrelated route to this file). */
export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Exported for the same test-construction reason as hmacHex above. */
export function base64UrlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
