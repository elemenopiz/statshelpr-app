import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "../types";

export const health = new Hono<{ Bindings: Env }>();

health.use("*", cors({ origin: "*" }));

health.get("/", (c) =>
  c.json({
    ok: true,
    version: "1.0.0",
    provider: "gemini",
    geminiConfigured: Boolean(c.env.GEMINI_API_KEY),
    openaiConfigured: Boolean(c.env.OPENAI_API_KEY),
    lemonsqueezyConfigured: Boolean(c.env.LEMONSQUEEZY_API_KEY),
    time: new Date().toISOString(),
  }),
);
