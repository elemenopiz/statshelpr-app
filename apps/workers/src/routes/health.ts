import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "../types";

export const health = new Hono<{ Bindings: Env }>();

health.use("*", cors({ origin: "*" }));

health.get("/", (c) =>
  c.json({
    ok: true,
    version: "1.0.0",
    provider: "openai",
    openaiConfigured: Boolean(c.env.OPENAI_API_KEY),
    // Back-compat alias: shipped extension popups (dist/popup.js ≤ v1.1.4,
    // already in users' browsers) light their "AI tutor ready" indicator off
    // `geminiConfigured` — keep it mirroring the ACTIVE provider key until
    // those builds age out. Do NOT read GEMINI_API_KEY here; that secret is
    // retired from the solve path.
    geminiConfigured: Boolean(c.env.OPENAI_API_KEY),
    lemonsqueezyConfigured: Boolean(c.env.LEMONSQUEEZY_API_KEY),
    time: new Date().toISOString(),
  }),
);
