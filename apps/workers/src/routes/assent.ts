import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "../types";

/**
 * POST /api/assent — evidentiary record of clickwrap acceptance.
 *
 * WHY THIS EXISTS: the Terms of Service (apps/landing/legal.html) contain an
 * arbitration clause (§14). Presented as browsewrap — a link under a button —
 * that clause is exposed to a "no contract was ever formed" argument, not
 * merely a weak-notice one. apps/landing/checkout.html now gates the purchase
 * link behind an unchecked-by-default checkbox, and calls this route the
 * moment the gated button is used. THIS RECORD IS THE ONLY PURPOSE OF THE
 * ROUTE: it is what turns "the terms were linked somewhere" into "this
 * subject affirmatively accepted version X at time T".
 *
 * Wire contract:
 *   POST { installId, tosVersion, timestamp? }
 *     -> 200 { ok: true }            (recorded, or already on file)
 *     -> 400 { ok: false, error }    (malformed — same shape as claim-license)
 *
 * `installId` is the subject key. Normally it is the extension's install id
 * (apps/extension/src/install-id.ts), forwarded from the popup through
 * checkout.html — that is the same value that rides to Lemon Squeezy as
 * `checkout[custom][install_id]`, so the record joins to the resulting order.
 * A visitor who reaches /checkout without the extension has no install id, so
 * checkout.html mints a per-page-load `web-<uuid>` instead and forwards it to
 * LS as `checkout[custom][assent_id]` — same joinability, no persistent
 * identifier stored in that visitor's browser.
 *
 * TRUST: the client's clock is not authoritative. `acceptedAt` is stamped
 * here, server-side, and is the field to rely on; the browser's own claim is
 * kept separately as `clientTimestamp` (unparsed, capped) only so a large
 * skew is visible rather than hidden. Same split for the version string:
 * `tosVersion` is what the page said it displayed, `serverTosVersion` is what
 * this Worker believed was current at the time.
 *
 * NEVER store or log the license key here. Assent happens BEFORE payment —
 * no key exists yet — and this namespace must not become a place one appears.
 */
export const assent = new Hono<{ Bindings: Env }>();

assent.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  }),
);

/**
 * The ToS version this Worker believes is current. Mirrors the prose in
 * apps/landing/legal.html ("Version 2.0 — effective 27 July 2026", the
 * Terms' closing paragraph). Bump BOTH together — see the TOS_VERSION
 * constant in apps/landing/checkout.html, which is what the buyer's browser
 * actually reports.
 */
const SERVER_TOS_VERSION = "2.0";

/** `1.0`, `2.0`, `10.3` — nothing else gets written into the record. */
const VERSION_RE = /^\d{1,3}\.\d{1,3}$/;
const MAX_CLIENT_TS_LEN = 40;
const MAX_UA_LEN = 256;

/**
 * Seven years. Deliberate, and deliberately long: the record's ONLY job is to
 * still exist when someone disputes that a contract was formed. It has to
 * outlive the longest limitations period that could reach the transaction it
 * documents — Texas's 4-year statute for breach of contract (Tex. Civ. Prac.
 * & Rem. Code § 16.004), plus headroom for discovery-rule tolling and for the
 * lag between a dispute arising and a demand landing. A short operational TTL
 * (48h, 30d) would make this route worthless: the record would reliably be
 * gone by the time anything needed it. Seven years also lines up with the
 * usual retention floor for the billing records it sits beside.
 */
const RETENTION_TTL_SECONDS = 7 * 365 * 24 * 60 * 60; // 220,752,000s ≈ 7 years

interface AssentBody {
  installId?: unknown;
  tosVersion?: unknown;
  timestamp?: unknown;
}

interface AssentRecord {
  /** Subject key — extension install id, or a `web-` id for extension-less visitors. */
  installId: string;
  /** Server-stamped. THE authoritative time of acceptance. */
  acceptedAt: string;
  /** What the buyer's browser claimed. Never trusted; kept for skew visibility. */
  clientTimestamp: string | null;
  /** Version string the page reported showing. */
  tosVersion: string;
  /** Version this Worker held as current when the record was written. */
  serverTosVersion: string;
  /** Truncated UA — part of what makes a clickwrap record credible as evidence. */
  userAgent: string;
  /** Cloudflare's two-letter country. Coarse by design; no IP is stored. */
  country: string;
}

assent.post("/", async (c) => {
  let body: AssentBody;
  try {
    body = (await c.req.json()) as AssentBody;
  } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const installId = typeof body.installId === "string" ? body.installId.trim() : "";
  if (installId.length < 8 || installId.length > 128) {
    return c.json({ ok: false, error: "installId is required" }, 400);
  }

  const tosVersion = typeof body.tosVersion === "string" ? body.tosVersion.trim() : "";
  if (!VERSION_RE.test(tosVersion)) {
    return c.json({ ok: false, error: "tosVersion is required" }, 400);
  }

  const clientTimestamp =
    typeof body.timestamp === "string" && body.timestamp
      ? body.timestamp.slice(0, MAX_CLIENT_TS_LEN)
      : null;

  // One record per (subject, version): the evidentiary unit is "this subject
  // accepted version X". First write wins, so re-visiting /checkout and
  // re-accepting the SAME version can never push the recorded time later than
  // the earliest acceptance — the earliest is the one that matters, since it
  // is the one that precedes the purchase. (Two truly concurrent first-time
  // accepts could race here; the loser is discarded and the surviving
  // timestamp is off by milliseconds, which is immaterial.)
  const key = `assent:${installId}:${tosVersion}`;
  const existing = await c.env.STATSHELPR_KV.get(key);
  if (existing) {
    return c.json({ ok: true }, 200);
  }

  const record: AssentRecord = {
    installId,
    acceptedAt: new Date().toISOString(),
    clientTimestamp,
    tosVersion,
    serverTosVersion: SERVER_TOS_VERSION,
    userAgent: (c.req.header("user-agent") ?? "").slice(0, MAX_UA_LEN),
    country: (c.req.header("cf-ipcountry") ?? "").slice(0, 8),
  };

  await c.env.STATSHELPR_KV.put(key, JSON.stringify(record), {
    expirationTtl: RETENTION_TTL_SECONDS,
  });

  return c.json({ ok: true }, 200);
});
