import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "../types";

/**
 * Zero-click license claim — the polling half of auto-activation.
 *
 * The extension popup appends `checkout[custom][install_id]=<installId>` to
 * the Lemon Squeezy checkout link (LS "Passing Custom Data": custom fields on
 * a checkout link flow into every webhook for the resulting order). When the
 * subscription_created webhook lands, lemonsqueezy-webhook.ts writes
 * `claim:{installId}` -> { licenseKey } to KV (48h TTL) and pre-binds the
 * license to that install. The extension polls THIS route (background alarm,
 * ~30s cadence for 45min after the upgrade click) and stores the key the
 * moment it appears — no confirmation-button click, no copy-paste, no tab
 * needed.
 *
 * SECURITY: the install id is a client-generated crypto.randomUUID() known
 * only to the browser profile that started the checkout — a claim is only
 * readable by whoever already knows that UUID (i.e. the purchasing browser).
 * The entry stays until TTL so repeat polls are idempotent; handing the same
 * key to the same install twice is a no-op, and the license itself is bound
 * to one install (activation_limit=1), so a leaked key can't fan out.
 * Never log the key.
 */
export const claimLicense = new Hono<{ Bindings: Env }>();

claimLicense.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  }),
);

interface ClaimRecord {
  licenseKey?: string;
}

claimLicense.post("/", async (c) => {
  let body: { installId?: unknown };
  try {
    body = (await c.req.json()) as { installId?: unknown };
  } catch {
    return c.json({ ok: false, error: "Invalid JSON body" }, 400);
  }

  const installId = typeof body.installId === "string" ? body.installId.trim() : "";
  if (installId.length < 8 || installId.length > 128) {
    return c.json({ ok: false, error: "installId is required" }, 400);
  }

  const rec = (await c.env.STATSHELPR_KV.get(`claim:${installId}`, "json")) as ClaimRecord | null;
  if (!rec?.licenseKey) {
    // Nothing (yet) for this install — the webhook may simply not have
    // landed. 200 so the extension's poll loop treats it as "keep waiting",
    // mirroring license-from-order's contract.
    return c.json({ ok: false }, 200);
  }

  return c.json({ ok: true, licenseKey: rec.licenseKey }, 200);
});
