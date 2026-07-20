import { UT_BUNDLE } from "./packages";

interface StoredConfig {
  apiUrl?: string;
  licenseKey?: string;
  buttonOpacity?: number;
}

const DEFAULT_OPACITY = 0.2;

interface HealthResponse {
  ok?: boolean;
  version?: string;
  kimiConfigured?: boolean;
  moonshotConfigured?: boolean;
  sandboxConfigured?: boolean;
  lemonsqueezyConfigured?: boolean;
}

interface DataFile {
  filename: string;
  content: string;
  size: number;
  addedAt: number;
}

const STORAGE_KEY_FILES = "statshelpr.files";
const FILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;     // 5MB per file
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;    // chrome.storage.local has ~10MB

const STORAGE_KEY_EXTRA_PACKAGES = "extraPackages";

const apiUrlInput = document.getElementById("apiUrl") as HTMLInputElement;
const licenseKeyInput = document.getElementById("licenseKey") as HTMLInputElement;
const opacityInput = document.getElementById("buttonOpacity") as HTMLInputElement | null;
const opacityValueEl = document.getElementById("opacityValue") as HTMLSpanElement | null;
const saveBtn = document.getElementById("save") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLDivElement;
const statusDot = document.getElementById("status-dot") as HTMLSpanElement;
const metaEl = document.getElementById("meta") as HTMLDivElement;
const dropzone = document.getElementById("dropzone") as HTMLDivElement;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const filesList = document.getElementById("files-list") as HTMLDivElement;
const filesEmpty = document.getElementById("files-empty") as HTMLDivElement;
const utBundleChipsEl = document.getElementById("ut-bundle-chips") as HTMLDivElement;
const pkgInput = document.getElementById("pkg-input") as HTMLInputElement;
const pkgAddBtn = document.getElementById("pkg-add") as HTMLButtonElement;
const extraPkgChipsEl = document.getElementById("extra-pkg-chips") as HTMLDivElement;
const pkgEmptyEl = document.getElementById("pkg-empty") as HTMLDivElement;

let dataFiles: DataFile[] = [];
let extraPackages: string[] = [];

// =============================================================================
// settings + health
// =============================================================================

chrome.storage.sync.get(["apiUrl", "licenseKey", "buttonOpacity"], (cfg: StoredConfig) => {
  apiUrlInput.value = cfg.apiUrl ?? "https://api.statshelpr.com";
  licenseKeyInput.value = cfg.licenseKey ?? "";
  const opacity = typeof cfg.buttonOpacity === "number" ? cfg.buttonOpacity : DEFAULT_OPACITY;
  if (opacityInput) opacityInput.value = String(opacity);
  if (opacityValueEl) opacityValueEl.textContent = opacity.toFixed(2);
  void pingHealth(apiUrlInput.value);
});

// Live-preview the opacity readout as the user drags the slider — the
// actual value is persisted on Save (same as the other fields).
opacityInput?.addEventListener("input", () => {
  if (!opacityValueEl) return;
  const v = Number(opacityInput.value);
  opacityValueEl.textContent = Number.isFinite(v) ? v.toFixed(2) : String(opacityInput.value);
});

saveBtn.addEventListener("click", () => {
  const apiUrl = apiUrlInput.value.trim().replace(/\/$/, "");
  const licenseKey = licenseKeyInput.value.trim();
  const rawOpacity = opacityInput ? Number(opacityInput.value) : DEFAULT_OPACITY;
  const buttonOpacity = Number.isFinite(rawOpacity)
    ? Math.min(1, Math.max(0.05, rawOpacity))
    : DEFAULT_OPACITY;
  chrome.storage.sync.set({ apiUrl, licenseKey, buttonOpacity }, () => {
    statusEl.textContent = "saved";
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
    ["version", data.version ?? "—", ""],
    ["kimi", kimiReady ? "ready" : "not set", kimiReady ? "ok" : "warn"],
    ["r sandbox", data.sandboxConfigured ? "ready" : "not set", data.sandboxConfigured ? "ok" : ""],
    ["license", data.lemonsqueezyConfigured ? "gated" : "open", data.lemonsqueezyConfigured ? "ok" : ""],
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

document.getElementById("open-tutorial")?.addEventListener("click", (e) => {
  e.preventDefault();
  void chrome.runtime.sendMessage({ type: "openWelcome" });
  window.close();
});

// =============================================================================
// data files (drag-drop / click to upload)
// =============================================================================

void loadFiles().then(() => renderFilesList());

dropzone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", async () => {
  if (fileInput.files) await ingestFiles([...fileInput.files]);
  fileInput.value = "";
});
dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("drag-over");
});
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag-over"));
dropzone.addEventListener("drop", async (e) => {
  e.preventDefault();
  dropzone.classList.remove("drag-over");
  if (e.dataTransfer?.files) await ingestFiles([...e.dataTransfer.files]);
});

async function ingestFiles(files: File[]) {
  let warnedSize = false;
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES) {
      if (!warnedSize) {
        flashStatus(`${f.name} is too large (>5MB)`, "err");
        warnedSize = true;
      }
      continue;
    }
    const text = await f.text();
    dataFiles = dataFiles.filter((d) => d.filename !== f.name);
    dataFiles.push({
      filename: f.name,
      content: text,
      size: text.length,
      addedAt: Date.now(),
    });
  }
  // Enforce total budget — drop oldest files until under cap
  let total = dataFiles.reduce((sum, d) => sum + d.size, 0);
  while (total > MAX_TOTAL_BYTES && dataFiles.length > 0) {
    const oldest = dataFiles.reduce((a, b) => (a.addedAt < b.addedAt ? a : b));
    dataFiles = dataFiles.filter((d) => d !== oldest);
    total -= oldest.size;
  }
  await saveFiles();
  renderFilesList();
}

function renderFilesList() {
  while (filesList.firstChild) filesList.removeChild(filesList.firstChild);
  if (dataFiles.length === 0) {
    filesEmpty.style.display = "";
    return;
  }
  filesEmpty.style.display = "none";
  for (const f of dataFiles) {
    const row = document.createElement("div");
    row.className = "row";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = f.filename;
    name.title = f.filename;
    const size = document.createElement("span");
    size.className = "size";
    size.textContent = `${(f.size / 1024).toFixed(1)} kb`;
    const rm = document.createElement("button");
    rm.className = "remove";
    rm.textContent = "×";
    rm.title = "remove";
    rm.addEventListener("click", async () => {
      dataFiles = dataFiles.filter((d) => d.filename !== f.filename);
      await saveFiles();
      renderFilesList();
    });
    row.appendChild(name);
    row.appendChild(size);
    row.appendChild(rm);
    filesList.appendChild(row);
  }
}

async function loadFiles() {
  const r = await chrome.storage.local.get(STORAGE_KEY_FILES);
  const stored = (r[STORAGE_KEY_FILES] as DataFile[] | undefined) ?? [];
  const now = Date.now();
  dataFiles = stored.filter((f) => now - f.addedAt < FILE_TTL_MS);
  if (dataFiles.length !== stored.length) await saveFiles();
}

async function saveFiles() {
  await chrome.storage.local.set({ [STORAGE_KEY_FILES]: dataFiles });
}

function flashStatus(msg: string, kind: "ok" | "err") {
  statusEl.textContent = msg;
  statusEl.className = `status ${kind}`;
  setTimeout(() => {
    statusEl.textContent = "";
    statusEl.className = "status";
  }, 2400);
}

// =============================================================================
// R libraries (UT bundle + user extras)
// =============================================================================

renderUtBundleChips();
void loadExtraPackages().then(() => renderExtraPackages());

pkgAddBtn.addEventListener("click", async () => {
  await addPackagesFromInput();
});
pkgInput.addEventListener("keydown", async (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    await addPackagesFromInput();
  }
});

function renderUtBundleChips() {
  for (const pkg of UT_BUNDLE) {
    const chip = document.createElement("span");
    chip.className = "chip locked";
    chip.textContent = pkg;
    utBundleChipsEl.appendChild(chip);
  }
}

async function addPackagesFromInput() {
  // Split on commas/whitespace so pasting a list ("dplyr, rpart car") in one
  // go works, not just a single name.
  const candidates = pkgInput.value
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  pkgInput.value = "";
  if (candidates.length === 0) return;

  let changed = false;
  for (const pkg of candidates) {
    if (!extraPackages.includes(pkg) && !UT_BUNDLE.includes(pkg)) {
      extraPackages.push(pkg);
      changed = true;
    }
  }
  if (changed) {
    await saveExtraPackages();
    renderExtraPackages();
  }
}

function renderExtraPackages() {
  while (extraPkgChipsEl.firstChild) extraPkgChipsEl.removeChild(extraPkgChipsEl.firstChild);
  if (extraPackages.length === 0) {
    pkgEmptyEl.style.display = "";
    return;
  }
  pkgEmptyEl.style.display = "none";
  for (const pkg of extraPackages) {
    const chip = document.createElement("span");
    chip.className = "chip extra";
    const label = document.createElement("span");
    label.textContent = pkg;
    const rm = document.createElement("button");
    rm.className = "remove";
    rm.textContent = "×";
    rm.title = "remove";
    rm.addEventListener("click", async () => {
      extraPackages = extraPackages.filter((p) => p !== pkg);
      await saveExtraPackages();
      renderExtraPackages();
    });
    chip.appendChild(label);
    chip.appendChild(rm);
    extraPkgChipsEl.appendChild(chip);
  }
}

async function loadExtraPackages() {
  const r = await chrome.storage.sync.get(STORAGE_KEY_EXTRA_PACKAGES);
  extraPackages = (r[STORAGE_KEY_EXTRA_PACKAGES] as string[] | undefined) ?? [];
}

async function saveExtraPackages() {
  await chrome.storage.sync.set({ [STORAGE_KEY_EXTRA_PACKAGES]: extraPackages });
}
