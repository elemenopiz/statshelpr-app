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
    // `geminiConfigured` alone (see apps/extension/src/popup.ts). Gemini is
    // wired back in as the automatic fallback (gemini-fallback work,
    // lib/llm.ts), so this now correctly reports "ready" whenever EITHER key
    // is configured — solves still work if only one of the two is set, just
    // in a degraded (single-provider) mode. Was `Boolean(c.env.
    // OPENAI_API_KEY)` alone right after the Luna swap, when GEMINI_API_KEY
    // genuinely wasn't read anywhere; that's no longer true.
    geminiConfigured: Boolean(c.env.OPENAI_API_KEY) || Boolean(c.env.GEMINI_API_KEY),
    // New, precise field (not read by any shipped extension build yet) for
    // anyone checking via curl whether the fallback is actually armed —
    // distinct from geminiConfigured's back-compat "ready at all" meaning.
    geminiFallbackConfigured: Boolean(c.env.GEMINI_API_KEY),
    lemonsqueezyConfigured: Boolean(c.env.LEMONSQUEEZY_API_KEY),
    time: new Date().toISOString(),
  }),
);
