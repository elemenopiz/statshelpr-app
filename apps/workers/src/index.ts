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

export default app;
