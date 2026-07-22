import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "../types";
import { hashBucket } from "@/lib/rate-limit";
import { recordClientEventInBackground } from "@/lib/metrics-store";

/**
 * POST /api/telemetry — content-free client beacon from the extension.
 * Reports HOW a solve ended (write-back outcome, question type, latency),
 * never WHAT was asked/answered — no question text, no answers, ever. No
 * license required: free users must be able to report too, or the aggregate
 * metrics would silently exclude most of the user base. CORS mirrors
 * routes/solve.ts (open origin — this is called directly from the
 * extension's content-script context, same as solve).
 *
 * Always responds 204 (even on a malformed/unparseable body) — this is a
 * fire-and-forget beacon, not a request the caller is expected to check or
 * retry on failure.
 */

interface TelemetryBody {
  mode?: unknown;
  questionType?: unknown;
  confidence?: unknown;
  outcome?: unknown;
  writeCount?: unknown;
  clientLatencyMs?: unknown;
}

const VALID_OUTCOMES = new Set(["written", "nowrite", "error"]);
const MAX_QUESTION_TYPE_LEN = 64;
const MAX_LATENCY_MS = 10 * 60_000; // 10 min ceiling — clamp obviously-bogus values

export const telemetry = new Hono<{ Bindings: Env }>();

telemetry.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "X-Install-Id"],
  }),
);

telemetry.post("/", async (c) => {
  let body: TelemetryBody;
  try {
    body = (await c.req.json()) as TelemetryBody;
  } catch {
    return c.body(null, 204); // malformed beacon — nothing to record, still 204
  }

  // Validate/clamp per the pinned wire contract. `mode`/`confidence`/
  // `writeCount` are validated for shape here (never trust the client) but
  // aren't currently folded into an aggregate — quality.modeSplit and
  // quality.confidence are server-derived instead (see metrics-store.ts's
  // DailyMetricsBucket doc: that split avoids double-counting a question
  // that's ALSO visible to solve.ts). Kept validated-but-mostly-
  // unused here, rather than dropped from the accepted shape, so the wire
  // contract stays exactly as pinned and a future aggregate can pick them up
  // without a client-side change.
  const outcome =
    typeof body.outcome === "string" && VALID_OUTCOMES.has(body.outcome)
      ? (body.outcome as "written" | "nowrite" | "error")
      : undefined;
  const questionType =
    typeof body.questionType === "string" && body.questionType
      ? body.questionType.slice(0, MAX_QUESTION_TYPE_LEN)
      : "unknown";
  const clientLatencyMs =
    typeof body.clientLatencyMs === "number" && Number.isFinite(body.clientLatencyMs)
      ? Math.max(0, Math.min(MAX_LATENCY_MS, Math.round(body.clientLatencyMs)))
      : 0;

  if (!outcome) {
    return c.body(null, 204); // nothing valid to record
  }

  const installId = c.req.header("x-install-id") ?? "";
  const installHash = await hashBucket(installId || "anon");

  recordClientEventInBackground(c, {
    questionType,
    outcome,
    clientLatencyMs,
    installHash,
  });

  return c.body(null, 204);
});
