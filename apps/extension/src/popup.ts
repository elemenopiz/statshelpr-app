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
  const rows: Array<[string, string, "ok" | "warn" | ""]> = [
    ["Version", data.version ?? "—", ""],
    ["Kimi", kimiReady ? "ready" : "not set", kimiReady ? "ok" : "warn"],
    ["R Sandbox", data.sandboxConfigured ? "ready" : "not set", data.sandboxConfigured ? "ok" : ""],
    ["License", data.lemonsqueezyConfigured ? "gated" : "open", data.lemonsqueezyConfigured ? "ok" : ""],
  ];
  for (const [k, v, kind] of rows) {
    const row = document.createElement("div");
    const b = document.createElement("b");
    b.textContent = k;
    row.appendChild(b);
    const val = document.createElement("span");
    val.className = `v${kind ? ` ${kind}` : ""}`;
    val.textContent = v;
    row.appendChild(val);
    metaEl.appendChild(row);
  }
  metaEl.style.display = "";
}

// Re-open tutorial
document.getElementById("open-tutorial")?.addEventListener("click", (e) => {
  e.preventDefault();
  void chrome.runtime.sendMessage({ type: "openWelcome" });
  window.close();
});
