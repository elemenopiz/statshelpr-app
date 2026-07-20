import { Hono } from "hono";
import type { Env } from "./types";

import { solve } from "./routes/solve";
import { interpret } from "./routes/interpret";
import { health } from "./routes/health";
import { validateLicenseRoute } from "./routes/validate-license";
import { feedback } from "./routes/feedback";
import { user } from "./routes/user";
import { lsWebhook } from "./routes/lemonsqueezy-webhook";

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.json({ ok: true, name: "statshelpr-api" }));

app.route("/api/health", health);
app.route("/api/solve", solve);
app.route("/api/interpret", interpret);
app.route("/api/auth/validate-license", validateLicenseRoute);
app.route("/api/feedback", feedback);
app.route("/api/user", user);
app.route("/api/webhooks/lemonsqueezy", lsWebhook);

app.notFound((c) => c.json({ error: "Not found" }, 404));

export default app;
