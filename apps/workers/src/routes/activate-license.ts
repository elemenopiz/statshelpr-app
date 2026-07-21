import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "../types";
import { validateLicense } from "@/lib/license";
import { activateForInstall } from "@/lib/license-activation";

/**
 * Bind a paid license to exactly one install (activation_limit = 1 on the LS
 * product/variant — anti-sharing). Idempotent: a repeat call for the same
 * {licenseKey, installId} pair is a no-op success. See lib/license-activation.ts
 * for the verified LS License API shapes and the duplicate-instance guard.
 *
 * The same activateForInstall() call is also made inline by routes/solve.ts's
 * paid gate, so a license activates lazily on first solve even if nothing
 * ever calls this route directly — this route exists for callers (e.g. the
 * extension popup) that want to activate eagerly and surface atLimit
 * immediately, before the user tries to solve something.
 */
export const activateLicense = new Hono<{ Bindings: Env }>();

activateLicense.use(
  "*",
  cors({
    origin: [
      "https://statshelpr.com",
      "https://www.statshelpr.com",
      "http://localhost:4321",
    ],
    allowMethods: ["POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  }),
);

activateLicense.post("/", async (c) => {
  let body: { licenseKey?: unknown; installId?: unknown };
  try {
    body = (await c.req.json()) as { licenseKey?: unknown; installId?: unknown };
  } catch {
    return c.json({ ok: false, reason: "Invalid JSON body" }, 400);
  }

  const licenseKey = typeof body.licenseKey === "string" ? body.licenseKey.trim() : "";
  const installId = typeof body.installId === "string" ? body.installId.trim() : "";

  if (!licenseKey) return c.json({ ok: false, reason: "licenseKey is required" }, 400);
  if (!installId) return c.json({ ok: false, reason: "installId is required" }, 400);

  const lic = await validateLicense(c.env, licenseKey);
  if (!lic.ok) return c.json({ ok: false, reason: lic.reason ?? "Invalid license" }, 401);

  const result = await activateForInstall(c.env, licenseKey, installId);
  if (result.ok) return c.json({ ok: true, activated: true });
  if (result.atLimit) {
    return c.json({ ok: false, atLimit: true, reason: result.reason }, 409);
  }
  return c.json({ ok: false, reason: result.reason ?? "Activation failed" }, 400);
});
