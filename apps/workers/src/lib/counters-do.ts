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
 *    counters and the dollar-spend accumulator share it — `count` is a float
 *    holding dollars for the spend row. Same 24h rolling window semantics as
 *    the KV counters this replaces: a row whose resetAt has passed is
 *    treated as empty on next touch.
 *  - Two ops over plain fetch+JSON (deliberately not RPC — zero dependence
 *    on workers-types RPC generics, trivially fakeable in the tsx self-tests):
 *      { op:"gate", checks:[{key,limit}...], spend?:{key,limitUsd} }
 *        Processes checks IN ORDER, incrementing each passing check
 *        immediately and stopping at the first failure — this preserves the
 *        exact sequential-KV-calls semantics routes/solve.ts had before
 *        (an earlier gate's increment persists even when a later gate
 *        rejects, e.g. the per-IP counter still counts a request that then
 *        trips the global ceiling). The spend check is evaluated LAST and is
 *        read-only (spend only grows via addSpend).
 *      { op:"addSpend", key, usd }
 *        Adds one Gemini leg's real cost to the spend row.
 *  - Privacy invariant carried over from rate-limit.ts: callers hash
 *    install ids / IPs (hashBucket) BEFORE building keys — raw identifiers
 *    never reach this object.
 *  - Cleanup: a daily alarm deletes rows expired for >24h and re-arms
 *    itself; armed lazily on first use (SQLite rows don't TTL themselves the
 *    way KV entries did).
 *
 * The worker-side client (doGate / doAddSpendInBackground below) FAILS OPEN
 * on any DO error: the enforcement read/decision is best-effort by design —
 * a counters outage must degrade to "uncounted solves", never to 500s. Same
 * philosophy as the putCountFailOpen this replaces (lib/rate-limit.ts).
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
}

interface GateRequestBody {
  op: "gate";
  checks: GateCheck[];
  spend?: GateSpend;
}

interface AddSpendRequestBody {
  op: "addSpend";
  key: string;
  usd: number;
}

type RequestBody = GateRequestBody | AddSpendRequestBody;

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

    for (let i = 0; i < body.checks.length; i++) {
      const check = body.checks[i]!;
      const cur = this.touch(check.key, now);
      if (cur.count >= check.limit) {
        results.push({ count: cur.count, limit: check.limit, resetAt: cur.resetAt });
        return { allowed: false, failed: i, results };
      }
      const newCount = cur.count + 1;
      this.upsert(check.key, newCount, cur.resetAt);
      results.push({ count: newCount, limit: check.limit, resetAt: cur.resetAt });
    }

    if (body.spend) {
      const spendRow = this.touch(body.spend.key, now);
      if (spendRow.count >= body.spend.limitUsd) {
        return { allowed: false, failed: "spend", results, spendUsd: spendRow.count };
      }
      return { allowed: true, results, spendUsd: spendRow.count };
    }

    return { allowed: true, results };
  }

  private addSpend(key: string, usd: number): void {
    if (!(usd > 0)) return;
    const cur = this.touch(key, Date.now());
    this.upsert(key, cur.count + usd, cur.resetAt);
  }

  /** Current live state of a key: the stored row if its window is still
   *  open, else a fresh zero row (not persisted until upsert). */
  private touch(key: string, now: number): { count: number; resetAt: number } {
    const row = this.sql
      .exec<{ count: number; resetAt: number }>(
        "SELECT count, resetAt FROM counters WHERE key = ?",
        key,
      )
      .toArray()[0];
    if (!row || row.resetAt < now) return { count: 0, resetAt: now + WINDOW_MS };
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
 *  so callers can tell real state from the fallback if they ever care. */
export async function doGate(
  env: Env,
  checks: GateCheck[],
  spend?: GateSpend,
): Promise<GateResponse & { failOpen?: boolean }> {
  try {
    const res = await stub(env).fetch(DO_URL, {
      method: "POST",
      body: JSON.stringify({ op: "gate", checks, spend } satisfies GateRequestBody),
    });
    if (!res.ok) throw new Error(`CountersDO gate: HTTP ${res.status}`);
    return (await res.json()) as GateResponse;
  } catch {
    return {
      allowed: true,
      failOpen: true,
      results: checks.map((c) => ({ count: 0, limit: c.limit, resetAt: Date.now() + WINDOW_MS })),
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
