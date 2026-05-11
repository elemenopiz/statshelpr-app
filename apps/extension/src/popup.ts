interface StoredConfig {
  apiUrl?: string;
  licenseKey?: string;
}

interface HealthResponse {
  ok?: boolean;
  version?: string;
  kimiConfigured?: boolean;
  moonshotConfigured?: boolean;
  sandboxConfigured?: boolean;
  lemonsqueezyConfigured?: boolean;
}

const apiUrlInput = document.getElementById("apiUrl") as HTMLInputElement;
const licenseKeyInput = document.getElementById("licenseKey") as HTMLInputElement;
const saveBtn = document.getElementById("save") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLDivElement;
const statusDot = document.getElementById("status-dot") as HTMLSpanElement;
const metaEl = document.getElementById("meta") as HTMLDivElement;

chrome.storage.sync.get(["apiUrl", "licenseKey"], (cfg: StoredConfig) => {
  apiUrlInput.value = cfg.apiUrl ?? "http://localhost:3030";
  licenseKeyInput.value = cfg.licenseKey ?? "";
  void pingHealth(apiUrlInput.value);
});

saveBtn.addEventListener("click", () => {
  const apiUrl = apiUrlInput.value.trim().replace(/\/$/, "");
  const licenseKey = licenseKeyInput.value.trim();
  chrome.storage.sync.set({ apiUrl, licenseKey }, () => {
    statusEl.textContent = "Saved.";
    statusEl.className = "status ok";
    setTimeout(() => {
      statusEl.textContent = "";
      statusEl.className = "status";
    }, 2000);
    void pingHealth(apiUrl);
  });
});

async function pingHealth(apiUrl: string) {
  setDot("checking…", "");
  metaEl.style.display = "none";
  if (!apiUrl) return setDot("not set", "err");

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`${apiUrl.replace(/\/$/, "")}/api/health`, {
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return setDot(`API ${res.status}`, "err");
    const data = (await res.json()) as HealthResponse;
    const kimiReady = data.kimiConfigured ?? data.moonshotConfigured ?? false;
    if (!kimiReady) {
      setDot("api key missing", "warn");
    } else {
      setDot("ready", "ok");
    }
    renderMeta(data);
  } catch {
    setDot("offline", "err");
  }
}

function setDot(label: string, kind: "ok" | "warn" | "err" | "") {
  statusDot.textContent = label;
  statusDot.className = `dot${kind ? ` ${kind}` : ""}`;
}

function renderMeta(data: HealthResponse) {
  while (metaEl.firstChild) metaEl.removeChild(metaEl.firstChild);
  const kimiReady = data.kimiConfigured ?? data.moonshotConfigured ?? false;
  const rows: Array<[string, string]> = [
    ["Version", data.version ?? "—"],
    ["Kimi", kimiReady ? "✓" : "✗"],
    ["R Sandbox", data.sandboxConfigured ? "✓" : "—"],
    ["Lemon Squeezy", data.lemonsqueezyConfigured ? "✓ gated" : "— ungated"],
  ];
  for (const [k, v] of rows) {
    const row = document.createElement("div");
    const b = document.createElement("b");
    b.textContent = `${k}: `;
    row.appendChild(b);
    row.appendChild(document.createTextNode(v));
    metaEl.appendChild(row);
  }
  metaEl.style.display = "";
}
