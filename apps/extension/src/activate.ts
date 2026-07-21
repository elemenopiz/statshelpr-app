/**
 * License activation content script — runs on statshelpr.com only.
 *
 * Checkout on the website finishes with a Lemon Squeezy license key. Instead
 * of the user copy-pasting it into the popup, the website hands it off via a
 * same-origin window message and this script drops it straight into
 * chrome.storage.sync under "licenseKey" — the same key popup.ts reads and
 * writes, and background.ts sends as the /api/solve bearer token — so the
 * extension is "paid" the moment checkout completes.
 *
 * Once the key is stored, this script registers the activation with the
 * worker (POST /api/activate-license) so single-device enforcement can kick
 * in — a license is good on one device at a time. If this device gets
 * bumped, popup.ts surfaces a "reset this license" flow (POST
 * /api/reset/request) that lets the user free it up again.
 *
 * Contract (website -> extension):
 *   window.postMessage(
 *     { source: "statshelpr-web", type: "activate-license", licenseKey },
 *     window.location.origin,
 *   );
 *
 * Acks (extension -> website):
 *   Activated — POST /api/activate-license responded { ok:true, activated:true }:
 *     window.postMessage(
 *       { source: "statshelpr-ext", type: "license-activated" },
 *       window.location.origin,
 *     );
 *   Blocked — responded { ok:false, atLimit:true, reason } because this
 *   license is already active on another device:
 *     window.postMessage(
 *       { source: "statshelpr-ext", type: "activation-blocked", reason: "device-limit" },
 *       window.location.origin,
 *     );
 *     chrome.storage.local.activationBlocked is also set to true so popup.ts
 *     can show the reset flow even after this tab closes.
 *
 * Anything that doesn't match the contract exactly is ignored silently —
 * including a POST /api/activate-license that fails outright (offline,
 * worker down, etc.). The license key is stored locally either way; this
 * call is best-effort device-limit registration, not the only gate
 * (background.ts / content.ts / popup.ts all re-validate the license
 * independently on their own calls).
 */

import { getInstallId } from "./install-id";

const DEFAULT_API_URL = "https://api.statshelpr.com";

interface ActivateLicenseMessage {
  source: "statshelpr-web";
  type: "activate-license";
  licenseKey: string;
}

interface ActivateLicenseResponse {
  ok: boolean;
  activated?: boolean;
  atLimit?: boolean;
  reason?: string;
}

function isActivateLicenseMessage(data: unknown): data is ActivateLicenseMessage {
  if (typeof data !== "object" || data === null) return false;
  const msg = data as Record<string, unknown>;
  return (
    msg["source"] === "statshelpr-web" &&
    msg["type"] === "activate-license" &&
    typeof msg["licenseKey"] === "string" &&
    msg["licenseKey"].length > 0
  );
}

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) return;
  if (!isActivateLicenseMessage(event.data)) return;

  void handleActivation(event.data.licenseKey);
});

async function handleActivation(licenseKey: string): Promise<void> {
  await chrome.storage.sync.set({ licenseKey });

  const cfg = await chrome.storage.sync.get("apiUrl");
  const apiBase = ((cfg["apiUrl"] as string | undefined) ?? DEFAULT_API_URL).replace(/\/$/, "");
  const installId = await getInstallId();

  let data: ActivateLicenseResponse;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(`${apiBase}/api/activate-license`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ licenseKey, installId }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    data = (await res.json()) as ActivateLicenseResponse;
  } catch {
    // Worker unreachable — best-effort registration only, see file header.
    return;
  }

  if (data.ok && data.activated) {
    // Clear any stale block from a previous device-limit hit now that this
    // device has a confirmed, valid activation.
    await chrome.storage.local.set({ activationBlocked: false });
    window.postMessage(
      { source: "statshelpr-ext", type: "license-activated" },
      window.location.origin,
    );
    return;
  }

  if (data.atLimit) {
    await chrome.storage.local.set({ activationBlocked: true });
    window.postMessage(
      { source: "statshelpr-ext", type: "activation-blocked", reason: "device-limit" },
      window.location.origin,
    );
  }
}
