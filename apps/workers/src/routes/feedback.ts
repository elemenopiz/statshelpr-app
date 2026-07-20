import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "../types";
import { validateLicense } from "@/lib/license";

/**
 * Thumbs-up/down capture from the extension answer card. Stored to KV keyed by
 * a random UUID; feeds the eval-fixtures set later.
 */

interface FeedbackBody {
  solveId?: string;
  verdict: "up" | "down";
  comment?: string;
  question?: string;
  answer?: string;
  mode?: "concept" | "calc";
}

export const feedback = new Hono<{ Bindings: Env }>();

feedback.use("*", cors({
  origin: "*",
  allowMethods: ["POST", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
}));

feedback.post("/", async (c) => {
  const auth = c.req.header("authorization") ?? "";
  const licenseKey = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const lic = await validateLicense(c.env, licenseKey);
  if (!lic.ok) return c.json({ error: lic.reason ?? "Unauthorized" }, 401);

  let body: FeedbackBody;
  try {
    body = (await c.req.json()) as FeedbackBody;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (body.verdict !== "up" && body.verdict !== "down") {
    return c.json({ error: "verdict must be 'up' or 'down'" }, 400);
  }

  const id = crypto.randomUUID();
  const record = {
    id,
    ...body,
    createdAt: Date.now(),
    // Hash license key for privacy — never store the raw key.
    licenseHash: await hashKey(licenseKey),
  };

  // 90-day retention on feedback
  await c.env.STATSHELPR_KV.put(
    `feedback:${id}`,
    JSON.stringify(record),
    { expirationTtl: 90 * 86_400 },
  );

  return c.json({ ok: true, id });
});

async function hashKey(key: string): Promise<string> {
  const buf = new TextEncoder().encode(key || "anon");
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}
