/**
 * CountersDO — one SQLite-backed Durable Object holding every hot counter
 * that used to live in Workers KV (2026-07-29 capacity review, DO switch).
 *
 * Why it exists: the Cloudflare account is on the FREE plan, where KV allows
 * 1,000 writes/day TOTAL and only 1 write/second to the SAME key. The
 * counters this object now owns (per-install free cap, per-IP backstop,
 * global daily call ceiling, global daily dollar ceiling) were both the
 * write-volume majority (~4–6 KV writes per solve) and the same-key
 * contention hotspot (every solve worldwide hits the ONE `ks:` bucket, and a
 * whole campus NAT shares one `rl:ip:solve:` bucket). A classroom burst was
 * costing us 429-turned-500s and a class DAY was blowing the free plan's
 * daily write cap. Durable Objects are included in the free plan (SQLite
 * backend REQUIRED there — hence `new_sqlite_classes` in wrangler.toml's
 * migration, never `new_classes`), and a DO instance is single-threaded, so
 * this also upgrades every counter from "racy read-modify-write with an
 * optimistic recheck" (see the history in lib/rate-limit.ts) to genuinely
 * serialized, exact counting.
 *
 * Design:
 *  - ONE instance for the whole service (idFromName("global")) — the entire
 *    point is centralized exact counting; the request volume (a few thousand
 *    tiny ops/day) is ~50x under the free plan's 100k DO requests/day.
 *  - ONE table, `counters(key TEXT PK, count REAL, resetAt INTEGER)`. Count
 *    counters, the dollar-spend accumulator, cron-persisted config scalars
 *    (2026-08-04), and the paid-tier soft-cap counters (2026-08-04) all share
 *    it — `count` is a float, so it doubles as a dollar accumulator or a
 *    plain config value depending on which key is asking. Same 24h rolling
 *    window semantics as the KV counters this replaces BY DEFAULT: a row
 *    whose resetAt has passed is treated as empty on next touch — but the
 *    window a given row resets to is caller-chosen (see `touch`'s
 *    `freshResetAt` param), which is what lets a single generic table also
 *    back a calendar-month window or a 48h config-staleness window without
 *    any schema change.
 *  - Four ops over plain fetch+JSON (deliberately not RPC — zero dependence
 *    on workers-types RPC generics, trivially fakeable in the tsx self-tests):
 *      { op:"gate", checks:[{key,limit}...], spend?:{key,limitUsd,cfgKey?}, incr?:[{key,resetAtIfFresh}...] }
 *        Processes `checks` IN ORDER, incrementing each passing check
 *        immediately and stopping at the first failure — this preserves the
 *        exact sequential-KV-calls semantics routes/solve.ts had before
 *        (an earlier gate's increment persists even when a later gate
 *        rejects, e.g. the per-IP counter still counts a request that then
 *        trips the global ceiling). The spend check runs next (only if every
 *        check passed) and is otherwise read-only (spend only grows via
 *        addSpend) — its enforced limit is resolved via `resolveSpendLimit`
 *        below, which can raise it above `spend.limitUsd` using a
 *        cron-persisted config row (see `spend.cfgKey`, `setConfig`).
 *        Finally, `incr` (2026-08-04) is applied UNCONDITIONALLY, regardless
 *        of whether checks/spend passed — these are non-blocking counters
 *        (the paid-tier soft-cap daily/monthly counts, lib/kill-switch.ts)
 *        that must stay exact independent of any blocking decision made in
 *        the same call.
 *      { op:"addSpend", key, usd }
 *        Adds one Gemini/Luna leg's real cost to the spend row.
 *      { op:"setConfig", key, value, staleAfterMs } (2026-08-04)
 *        Persists a single scalar (e.g. the cron-computed subscriber-scaled
 *        spend ceiling) that a later gate's spend check can read back via
 *        `resolveSpendLimit`. Refuses to persist a non-finite/non-positive
 *        value — see `setConfig`'s doc.
 *  - Privacy invariant carried over from rate-limit.ts: callers hash
 *    install ids / IPs (hashBucket) BEFORE building keys — raw identifiers
 *    never reach this object.
 *  - Cleanup: a daily alarm deletes rows expired for >24h and re-arms
 *    itself; armed lazily on first use (SQLite rows don't TTL themselves the
 *    way KV entries did). This is unchanged by the 2026-08-04 additions —
 *    every new kind of row (config scalars, monthly counters) still uses the
 *    same (key, count, resetAt) shape and the same "expired means safe to
 *    delete, a later touch just starts fresh" invariant every existing row
 *    already relied on, so no cleanup special-casing was needed for them.
 *
 * The worker-side client (doGate / doAddSpendInBackground / doSetConfig
 * below) FAILS OPEN on any DO error: the enforcement read/decision is
 * best-effort by design — a counters outage must degrade to "uncounted
 * solves" (and, for the 2026-08-04 paid soft-cap, "un-throttled solves"),
 * never to 500s or to blocking a paid solve. Same philosophy as the
 * putCountFailOpen this replaces (lib/rate-limit.ts).
 */

import type { Context } from "hono";
import type { Env } from "../types";

const WINDOW_MS = 86_400_000;

export interface GateCheck {
  key: string;
  limit: number;
}

export interface GateSpend {
  key: string;
  limitUsd: number;
  /** Optional key of a persisted config row (see `setConfig` / `op:
   *  "setConfig"` above) — when present and the row is FRESH (its own
   *  resetAt hasn't passed) and holds a valid positive number, the ENFORCED
   *  limit for this call is `Math.max(limitUsd, storedValue)` instead of
   *  `limitUsd` alone. This is how a once-a-day cron-computed ceiling
   *  (lib/kill-switch.ts's subscriber-scaled global spend ceiling) overrides
   *  the static per-request floor (`limitUsd`) without adding any extra
   *  subrequest to the hot gate path — the DO reads its own local storage
   *  as part of the SAME fetch the gate call already makes; see
   *  `resolveSpendLimit`. A missing, stale, or invalid row is invisible —
   *  `resolveSpendLimit` transparently falls back to `limitUsd` alone. */
  cfgKey?: string;
}

/** A non-blocking counter to increment as part of a `gate` call — see the
 *  `incr` field on `GateRequestBody` and `resolveSpendLimit`'s sibling
 *  `incr` doc above. Added 2026-08-04 for the paid-tier soft-cap counters
 *  (lib/kill-switch.ts): unlike `GateCheck`, this never rejects the call —
 *  it only counts, and always applies. */
export interface IncrItem {
  key: string;
  /** Absolute ms epoch to reset THIS row to if its stored resetAt has
   *  already passed (or no row exists yet). Caller-computed rather than
   *  derived here because different counters need different window shapes
   *  (a rolling 24h window vs. a calendar-month-UTC boundary) and this
   *  class deliberately has no opinion on which — same "generic bucket
   *  store, caller decides semantics" split `touch`/`upsert` already
   *  follow for every other counter in this table. */
  resetAtIfFresh: number;
}

export interface IncrResult {
  count: number;
  resetAt: number;
}

export interface GateCheckResult {
  count: number;
  limit: number;
  resetAt: number;
}

export interface GateResponse {
  allowed: boolean;
  /** Index into `checks` of the first failing check, or "spend" when the
   *  dollar ceiling rejected. Absent when allowed. */
  failed?: number | "spend";
  /** Per-check state AFTER this call, aligned with `checks` up to and
   *  including the failing check (later checks were never evaluated). For a
   *  passing check this is the post-increment count. */
  results: GateCheckResult[];
  /** Spend row state when a spend check was requested and reached. */
  spendUsd?: number;
  /** Post-increment state of every `body.incr` item, aligned by index —
   *  present whenever `incr` was non-empty, REGARDLESS of `allowed`. These
   *  are unconditional counters (2026-08-04), not part of the block/allow
   *  decision — the caller (solve.ts) decides what to do with the counts. */
  incrResults?: IncrResult[];
}

interface GateRequestBody {
  op: "gate";
  checks: GateCheck[];
  spend?: GateSpend;
  incr?: IncrItem[];
}

interface AddSpendRequestBody {
  op: "addSpend";
  key: string;
  usd: number;
}

/** Persist a single scalar config value (2026-08-04) — see the module doc's
 *  `op: "setConfig"` entry and `CountersDO.setConfig`'s own doc. */
interface SetConfigRequestBody {
  op: "setConfig";
  key: string;
  value: number;
  staleAfterMs: number;
}

type RequestBody = GateRequestBody | AddSpendRequestBody | SetConfigRequestBody;

export class CountersDO {
  private sql: SqlStorage;
  private storage: DurableObjectStorage;

  constructor(state: DurableObjectState) {
    this.storage = state.storage;
    this.sql = state.storage.sql;
    // blockConcurrencyWhile: no request runs before the schema exists. The
    // alarm is armed here too (idempotent — only when none is pending) so
    // cleanup needs no cooperation from the request path.
    state.blockConcurrencyWhile(async () => {
      this.sql.exec(
        "CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, count REAL NOT NULL, resetAt INTEGER NOT NULL)",
      );
      if ((await this.storage.getAlarm()) === null) {
        await this.storage.setAlarm(Date.now() + WINDOW_MS);
      }
    });
  }

  async fetch(req: Request): Promise<Response> {
    let body: RequestBody;
    try {
      body = (await req.json()) as RequestBody;
    } catch {
      return Response.json({ error: "bad body" }, { status: 400 });
    }

    if (body.op === "gate") return Response.json(this.gate(body));
    if (body.op === "addSpend") {
      this.addSpend(body.key, body.usd);
      return Response.json({ ok: true });
    }
    if (body.op === "setConfig") {
      this.setConfig(body.key, body.value, body.staleAfterMs);
      return Response.json({ ok: true });
    }
    return Response.json({ error: "unknown op" }, { status: 400 });
  }

  /** Daily sweep of long-expired rows. Deleting only rows expired >24h keeps
   *  a just-rolled window's row around briefly, which is harmless (touch()
   *  resets it) and avoids any clock-skew edge with in-flight requests. */
  async alarm(): Promise<void> {
    this.sql.exec("DELETE FROM counters WHERE resetAt < ?", Date.now() - WINDOW_MS);
    await this.storage.setAlarm(Date.now() + WINDOW_MS);
  }

  private gate(body: GateRequestBody): GateResponse {
    const now = Date.now();
    const results: GateCheckResult[] = [];
    let failedAt: number | "spend" | undefined;

    for (let i = 0; i < body.checks.length; i++) {
      const check = body.checks[i]!;
      const cur = this.touch(check.key, now);
      if (cur.count >= check.limit) {
        results.push({ count: cur.count, limit: check.limit, resetAt: cur.resetAt });
        failedAt = i;
        break;
      }
      const newCount = cur.count + 1;
      this.upsert(check.key, newCount, cur.resetAt);
      results.push({ count: newCount, limit: check.limit, resetAt: cur.resetAt });
    }

    let spendUsd: number | undefined;
    if (failedAt === undefined && body.spend) {
      const spendRow = this.touch(body.spend.key, now);
      const limitUsd = this.resolveSpendLimit(body.spend, now);
      spendUsd = spendRow.count;
      if (spendRow.count >= limitUsd) failedAt = "spend";
    }

    const response: GateResponse =
      failedAt !== undefined
        ? { allowed: false, failed: failedAt, results, ...(spendUsd !== undefined ? { spendUsd } : {}) }
        : { allowed: true, results, ...(spendUsd !== undefined ? { spendUsd } : {}) };

    // Non-blocking counters (2026-08-04) — ALWAYS applied, regardless of
    // whether the blocking checks/spend above passed. See IncrItem's doc:
    // the paid-tier soft-cap counters (lib/kill-switch.ts) must stay exact
    // even for a request some OTHER, unrelated ceiling just rejected — the
    // counter answers "how many solve attempts has this install made",
    // independent of whether this particular one also got a 503.
    if (body.incr && body.incr.length > 0) {
      response.incrResults = body.incr.map((item) => this.incr(item.key, item.resetAtIfFresh));
    }

    return response;
  }

  /** Resolves the ENFORCED spend ceiling for this gate call: the caller's
   *  static floor (`spend.limitUsd` — kill-switch.ts's
   *  GLOBAL_DAILY_SPEND_LIMIT_USD), or the higher of that floor and a fresh
   *  cron-persisted config row (`spend.cfgKey`), whichever applies — see
   *  kill-switch.ts's computeEffectiveSpendLimitUsd/persistEffectiveSpendLimit
   *  for what writes that row and why. `touch()` already treats a missing OR
   *  expired row as `{count: 0, ...}`, and 0 never wins a Math.max against a
   *  real positive floor — so a config row that was never written, has gone
   *  stale (see `setConfig`'s `staleAfterMs`), or was somehow written
   *  non-positive (setConfig itself already refuses to persist one, but
   *  this is defense in depth) all transparently fall back to the floor
   *  with no special-casing needed here. This IS the fail-safe: the ONLY
   *  way to raise the ceiling above the floor is a fresh, valid, positive
   *  config row — everything else is silently ignored, never an error, and
   *  never resolves BELOW the caller's own floor either (Math.max can only
   *  raise it). */
  private resolveSpendLimit(spend: GateSpend, now: number): number {
    if (!spend.cfgKey) return spend.limitUsd;
    const cfg = this.touch(spend.cfgKey, now);
    return Math.max(spend.limitUsd, cfg.count);
  }

  private addSpend(key: string, usd: number): void {
    if (!(usd > 0)) return;
    const cur = this.touch(key, Date.now());
    this.upsert(key, cur.count + usd, cur.resetAt);
  }

  /** Persists a single scalar config value the gate can read back via
   *  `resolveSpendLimit` (currently the only reader) — written once/day by
   *  the scheduled cron (src/index.ts), NEVER on the request path.
   *  Defensive: silently refuses to persist a non-finite/non-positive value
   *  rather than writing garbage a later gate() call would then trust —
   *  same "a bad write here must degrade to the floor, never to unlimited"
   *  contract computeEffectiveSpendLimitUsd's doc describes.
   *  `staleAfterMs` controls how long this value stays "fresh" (see
   *  `resolveSpendLimit`) by reusing the SAME resetAt-based expiry every
   *  other row in this table already has — a config row that stops being
   *  refreshed (a broken cron) ages out and callers silently revert to
   *  their own floor, and it's swept by the EXISTING daily alarm exactly
   *  like any other stale row — no cleanup special-casing needed for this
   *  new kind of row either. */
  private setConfig(key: string, value: number, staleAfterMs: number): void {
    if (!Number.isFinite(value) || value <= 0) return;
    this.upsert(key, value, Date.now() + Math.max(0, staleAfterMs));
  }

  /** Unconditional increment with a CALLER-CHOSEN reset point (2026-08-04)
   *  — unlike the blocking `checks` in `gate()`, this never rejects; it
   *  just counts and always succeeds. See `IncrItem`'s doc for why the
   *  reset point is caller-computed rather than derived here. */
  private incr(key: string, resetAtIfFresh: number): IncrResult {
    const now = Date.now();
    const cur = this.touch(key, now, resetAtIfFresh);
    const newCount = cur.count + 1;
    this.upsert(key, newCount, cur.resetAt);
    return { count: newCount, resetAt: cur.resetAt };
  }

  /** Current live state of a key: the stored row if its window is still
   *  open, else a fresh zero row (not persisted until upsert). `freshResetAt`
   *  (2026-08-04) lets a caller pick what window a FRESH/expired row resets
   *  to — every pre-existing call site omits it and keeps getting the
   *  original rolling-24h-from-now behavior unchanged; `incr` and
   *  `resolveSpendLimit`'s config-row read are the only callers that ever
   *  pass a caller-computed window (a calendar-month boundary, or a config
   *  staleness window) instead. */
  private touch(
    key: string,
    now: number,
    freshResetAt: number = now + WINDOW_MS,
  ): { count: number; resetAt: number } {
    const row = this.sql
      .exec<{ count: number; resetAt: number }>(
        "SELECT count, resetAt FROM counters WHERE key = ?",
        key,
      )
      .toArray()[0];
    if (!row || row.resetAt < now) return { count: 0, resetAt: freshResetAt };
    return { count: row.count, resetAt: row.resetAt };
  }

  private upsert(key: string, count: number, resetAt: number): void {
    this.sql.exec(
      "INSERT INTO counters (key, count, resetAt) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET count = excluded.count, resetAt = excluded.resetAt",
      key,
      count,
      resetAt,
    );
  }
}

// ---------------------------------------------------------------------------
// Worker-side client
// ---------------------------------------------------------------------------

const DO_INSTANCE_NAME = "global";
// Host is ignored by DO routing — any syntactically valid URL works.
const DO_URL = "https://counters.do/";

function stub(env: Env): DurableObjectStub {
  return env.COUNTERS_DO.get(env.COUNTERS_DO.idFromName(DO_INSTANCE_NAME));
}

/** One batched, atomic-in-order gate call. FAILS OPEN on any DO error (see
 *  the module doc): the fallback fabricates passing results so callers'
 *  response-shaping code (402 bodies etc.) keeps working; `failOpen` is set
 *  so callers can tell real state from the fallback if they ever care.
 *  `incr` (2026-08-04) gets the same fail-open treatment: a zeroed
 *  `incrResults` entry per requested item, so a caller like solve.ts's
 *  paid-tier soft-cap check (lib/kill-switch.ts's decidePaidSoftThrottle)
 *  reads "0 solves counted" on a DO outage and correctly never throttles —
 *  fail open, not fail-throttle. */
export async function doGate(
  env: Env,
  checks: GateCheck[],
  spend?: GateSpend,
  incr?: IncrItem[],
): Promise<GateResponse & { failOpen?: boolean }> {
  try {
    const res = await stub(env).fetch(DO_URL, {
      method: "POST",
      body: JSON.stringify({ op: "gate", checks, spend, incr } satisfies GateRequestBody),
    });
    if (!res.ok) throw new Error(`CountersDO gate: HTTP ${res.status}`);
    return (await res.json()) as GateResponse;
  } catch {
    return {
      allowed: true,
      failOpen: true,
      results: checks.map((c) => ({ count: 0, limit: c.limit, resetAt: Date.now() + WINDOW_MS })),
      ...(incr && incr.length > 0
        ? { incrResults: incr.map((i) => ({ count: 0, resetAt: i.resetAtIfFresh })) }
        : {}),
    };
  }
}

/** Fire-and-forget spend accumulation — never throws, never blocks the
 *  stream (same waitUntil pattern as lib/metrics-store.ts's recorders). */
export function doAddSpendInBackground(
  c: Context<{ Bindings: Env }>,
  key: string,
  usd: number,
): void {
  if (!(usd > 0)) return;
  const p = stub(c.env)
    .fetch(DO_URL, {
      method: "POST",
      body: JSON.stringify({ op: "addSpend", key, usd } satisfies AddSpendRequestBody),
    })
    .then(
      () => undefined,
      () => undefined, // lost add = the trip lands marginally late; never the caller's problem
    );
  try {
    c.executionCtx.waitUntil(p);
  } catch {
    /* no ExecutionContext — promise is already running on its own */
  }
}

/** Persists a cron-computed config scalar (2026-08-04) — currently only
 *  used for lib/kill-switch.ts's subscriber-scaled spend ceiling, called
 *  ONCE/DAY from src/index.ts's scheduled handler, never from the request
 *  path. Awaited directly by the cron (not fire-and-forget/waitUntil —
 *  the scheduled handler has its own execution budget and nothing else is
 *  racing it), but still NEVER THROWS: a lost write just means
 *  `resolveSpendLimit` keeps using whatever was there before (or the floor,
 *  if this has never once succeeded) until tomorrow's tick — same
 *  best-effort contract as every other recorder in this codebase. */
export async function doSetConfig(
  env: Env,
  key: string,
  value: number,
  staleAfterMs: number,
): Promise<void> {
  try {
    await stub(env).fetch(DO_URL, {
      method: "POST",
      body: JSON.stringify({ op: "setConfig", key, value, staleAfterMs } satisfies SetConfigRequestBody),
    });
  } catch {
    // Best-effort, cron-only — see doc above.
  }
}
