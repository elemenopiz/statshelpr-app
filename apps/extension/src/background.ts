/**
 * Background service worker. Acts as the network proxy so the content script
 * can call our API without CORS preflight friction.
 */

interface SolveRequest {
  type: "solve";
  payload: {
    questionText?: string;
    images?: { data: string; mediaType: string }[];
    dataFiles?: { filename: string; content: string }[];
  };
}

type ExtensionMessage = SolveRequest;

chrome.runtime.onMessage.addListener(
  (msg: ExtensionMessage, _sender, sendResponse: (response: unknown) => void) => {
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
  const apiUrl = (cfg["apiUrl"] as string | undefined) ?? "http://localhost:3030";
  const licenseKey = (cfg["licenseKey"] as string | undefined) ?? "";

  const res = await fetch(`${apiUrl}/api/solve`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
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
