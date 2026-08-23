/**
 * Zero-click license claim — the extension half of auto-activation.
 *
 * popup.ts appends `checkout[custom][install_id]=<installId>` to the Lemon
 * Squeezy checkout link and calls startClaiming() when the upgrade CTA is
 * clicked. The purchase webhook parks the license key under that install id
 * (apps/workers/src/routes/lemonsqueezy-webhook.ts writeInstallClaim), and a
 * chrome.alarms poll (background.ts) calls tryClaimLicense() every ~30s until
 * the key appears — so the extension goes Unlimited with NO user action after
 * payment: no confirmation-button click, no copy-paste, no tab left open.
 * popup.ts also fires a one-shot tryClaimLicense() on open so checking the
 * popup right after paying feels instant.
 *
 * The other activation paths (confirmation-button redirect -> activate.ts,
 * and manual key paste in the popup) are unaffected — whichever lands first
 * wins; storing the same key twice is a no-op.
 *
 * Claim window: 45 minutes from the upgrade click, then the alarm cleans
 * itself up — the buyer who abandons checkout doesn't leave a poller running
 * forever, and a purchase completed after the window still activates via the
 * redirect/email paths.
 */

import { getInstallId } from "./install-id";

const DEFAULT_API_URL = "https://api.statshelpr.com";

export const CLAIM_ALARM = "statshelpr-claim-license";
const STORAGE_KEY_CLAIM_STARTED = "claimStartedAt";
const CLAIM_WINDOW_MS = 45 * 60_000;
/** chrome.alarms floor is 30s (periodInMinutes: 0.5). */
const CLAIM_PERIOD_MIN = 0.5;

interface ClaimResponse {
  ok?: boolean;
  licenseKey?: string;
}

/** Arm the claim poll — called from the popup when an upgrade CTA is clicked. */
export async function startClaiming(): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY_CLAIM_STARTED]: Date.now() });
  chrome.alarms.create(CLAIM_ALARM, {
    delayInMinutes: CLAIM_PERIOD_MIN,
    periodInMinutes: CLAIM_PERIOD_MIN,
  });
}

async function stopClaiming(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY_CLAIM_STARTED);
  await chrome.alarms.clear(CLAIM_ALARM);
}

/**
 * One poll attempt. "claimed" means the license key was fetched and stored —
 * the extension is paid from that moment (popup.ts's storage.onChanged
 * listener refreshes any open popup live).
 */
export async function tryClaimLicense(): Promise<"claimed" | "pending" | "none"> {
  const r = await chrome.storage.local.get(STORAGE_KEY_CLAIM_STARTED);
  const startedAt = r[STORAGE_KEY_CLAIM_STARTED] as number | undefined;
  if (!startedAt) {
    await stopClaiming();
    return "none";
  }
  if (Date.now() - startedAt > CLAIM_WINDOW_MS) {
    await stopClaiming();
    return "none";
  }

  const cfg = await chrome.storage.sync.get("apiUrl");
  const apiBase = ((cfg["apiUrl"] as string | undefined) ?? DEFAULT_API_URL).replace(/\/$/, "");
  const installId = await getInstallId();

  let data: ClaimResponse;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(`${apiBase}/api/claim-license`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ installId }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    data = (await res.json()) as ClaimResponse;
  } catch {
    return "pending"; // network blip — the next alarm tick retries
  }

  if (!data.ok || !data.licenseKey) return "pending";

  await chrome.storage.sync.set({ licenseKey: data.licenseKey });
  // The webhook pre-bound the license to this install — clear any stale
  // device-limit flag so the popup doesn't show the reset prompt.
  await chrome.storage.local.set({ activationBlocked: false });
  await stopClaiming();
  return "claimed";
}
