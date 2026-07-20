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
 * Contract (website -> extension):
 *   window.postMessage(
 *     { source: "statshelpr-web", type: "activate-license", licenseKey },
 *     window.location.origin,
 *   );
 *
 * Ack (extension -> website, sent once the key is stored):
 *   window.postMessage(
 *     { source: "statshelpr-ext", type: "license-activated" },
 *     window.location.origin,
 *   );
 *
 * Anything that doesn't match the contract exactly is ignored silently.
 */

interface ActivateLicenseMessage {
  source: "statshelpr-web";
  type: "activate-license";
  licenseKey: string;
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

  void chrome.storage.sync.set({ licenseKey: event.data.licenseKey }).then(() => {
    window.postMessage(
      { source: "statshelpr-ext", type: "license-activated" },
      window.location.origin,
    );
  });
});
