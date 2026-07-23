/**
 * Background service worker.
 *
 *  - Opens the welcome/tutorial page on first install.
 *  - Listens for an "openWelcome" message from the popup so the user can
 *    re-open the tutorial anytime.
 *  - Runs the zero-click license claim poll (chrome.alarms — MV3 service
 *    workers sleep, so a plain setInterval would die with the worker; each
 *    alarm tick wakes it just long enough for one claim attempt). Armed by
 *    popup.ts when an upgrade CTA is clicked; see src/claim-license.ts.
 *  - Legacy: proxies /api/solve calls (currently the content script fetches
 *    directly, but the proxy is kept as a fallback for restricted hosts).
 */

import { getInstallId } from "./install-id";
import { CLAIM_ALARM, tryClaimLicense } from "./claim-license";

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CLAIM_ALARM) void tryClaimLicense();
});

interface SolveRequest {
  type: "solve";
  payload: {
    questionText?: string;
    images?: { data: string; mediaType: string }[];
    dataFiles?: { filename: string; content: string }[];
  };
}

interface OpenWelcomeMessage {
  type: "openWelcome";
}

type ExtensionMessage = SolveRequest | OpenWelcomeMessage;

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    void chrome.tabs.create({
      url: chrome.runtime.getURL("welcome.html"),
    });
  }
});

chrome.runtime.onMessage.addListener(
  (msg: ExtensionMessage, _sender, sendResponse: (response: unknown) => void) => {
    if (msg.type === "openWelcome") {
      void chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === "solve") {
      handleSolve(msg.payload)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((e) => sendResponse({ ok: false, error: (e as Error).message }));
      return true; // async
    }
    return false;
  },
);

async function handleSolve(payload: SolveRequest["payload"]) {
  const cfg = await chrome.storage.sync.get(["apiUrl", "licenseKey"]);
  const apiUrl = (cfg["apiUrl"] as string | undefined) ?? "https://api.statshelpr.com";
  const licenseKey = (cfg["licenseKey"] as string | undefined) ?? "";
  const installId = await getInstallId();

  const res = await fetch(`${apiUrl}/api/solve`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Install-Id": installId,
      ...(licenseKey ? { Authorization: `Bearer ${licenseKey}` } : {}),
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body.slice(0, 300)}`);
  }
  return await res.json();
}
