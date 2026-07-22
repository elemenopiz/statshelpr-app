import { Hono } from "hono";
import type { Env } from "./types";

import { solve } from "./routes/solve";
import { interpret } from "./routes/interpret";
import { health } from "./routes/health";
import { validateLicenseRoute } from "./routes/validate-license";
import { feedback } from "./routes/feedback";
import { user } from "./routes/user";
import { lsWebhook } from "./routes/lemonsqueezy-webhook";
import { licenseFromOrder } from "./routes/license-from-order";
import { activateLicense } from "./routes/activate-license";
import { reset } from "./routes/reset";
import { metrics } from "./routes/metrics";
import { telemetry } from "./routes/telemetry";
import { dashboard } from "./routes/dashboard";

import { loadMetrics } from "./lib/metrics-load";
import { readSnapshot, utcDateKey, writeDailySnapshot } from "./lib/metrics-snapshot";
import { evaluateAlerts, sendAlerts } from "./lib/alerts";

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.json({ ok: true, name: "statshelpr-api" }));

app.route("/api/health", health);
app.route("/api/solve", solve);
app.route("/api/interpret", interpret);
app.route("/api/auth/validate-license", validateLicenseRoute);
app.route("/api/feedback", feedback);
app.route("/api/user", user);
app.route("/api/webhooks/lemonsqueezy", lsWebhook);
app.route("/api/license-from-order", licenseFromOrder);
app.route("/api/activate-license", activateLicense);
app.route("/api/reset", reset);
app.route("/api/metrics", metrics);
app.route("/api/telemetry", telemetry);
app.route("/dashboard", dashboard);

app.notFound((c) => c.json({ error: "Not found" }, 404));

/**
 * Cron handler (wrangler.toml [triggers] crons — daily 08:00 UTC). Two
 * independent steps: (1) roll up today's compact KPI snapshot so trends
 * outlive the raw buckets' TTL, and (2) evaluate threshold alerts against the
 * latest metrics + yesterday's snapshot and email them via Resend. Each step
 * is wrapped so a failure in one never blocks the other and never escapes the
 * worker (a thrown scheduled handler would surface as a failed cron invocation).
 */
const scheduled: ExportedHandlerScheduledHandler<Env> = async (event, env, ctx) => {
  // 1) Daily snapshot rollup.
  try {
    await writeDailySnapshot(env);
  } catch (e) {
    console.error("scheduled: snapshot rollup failed:", (e as Error).message);
  }

  // 2) Threshold alerting, diffed against the previous day's snapshot.
  try {
    const metrics = await loadMetrics(env);
    const prev = await readSnapshot(env, utcDateKey(Date.now() - 24 * 60 * 60 * 1000));
    await sendAlerts(env, evaluateAlerts(metrics, prev));
  } catch (e) {
    console.error("scheduled: alert evaluation failed:", (e as Error).message);
  }
};

// Switch from `export default app` to the object form so the worker exposes
// both the (unchanged) Hono fetch handler and the new cron `scheduled` handler.
export default { fetch: app.fetch, scheduled };
