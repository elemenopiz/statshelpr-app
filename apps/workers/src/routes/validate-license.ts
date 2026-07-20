import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "../types";
import { validateLicense } from "@/lib/license";

export const validateLicenseRoute = new Hono<{ Bindings: Env }>();

validateLicenseRoute.use("*", cors({
  origin: "*",
  allowMethods: ["POST", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
}));

validateLicenseRoute.post("/", async (c) => {
  let body: { licenseKey?: string };
  try {
    body = (await c.req.json()) as { licenseKey?: string };
  } catch {
    return c.json({ ok: false, reason: "Invalid JSON" }, 400);
  }

  const result = await validateLicense(c.env, body.licenseKey ?? "");
  return c.json(result, result.ok ? 200 : 401);
});
