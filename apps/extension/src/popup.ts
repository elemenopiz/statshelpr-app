import { UT_BUNDLE } from "./packages";

interface StoredConfig {
  apiUrl?: string;
  licenseKey?: string;
  buttonOpacity?: number;
}

const DEFAULT_OPACITY = 0.2;
const API_URL = "https://api.statshelpr.com";

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

/** Full active R-library list (UT bundle defaults + any user edits). Every
 * chip — including the 6 defaults — is addable/removable from here on. */
const STORAGE_KEY_EXTRA_PACKAGES = "extraPackages";

/** Written by webr-runner.ts after boot: which libraries failed to load. */
const STORAGE_KEY_PACKAGE_ERRORS = "packageErrors";
interface PackageError {
  pkg: string;
  message: string;
}

/** Written by content.ts: local mirror of the free tier's daily solve count. */
const STORAGE_KEY_SOLVE_STATS = "statshelpr.solveStats";
const FREE_DAILY_LIMIT = 5;
interface SolveStats {
  count: number;
  resetAt: number;
}

/** Last successful license validation, so a paid user who opens the popup
 * offline isn't shown the free-tier upsell. */
const STORAGE_KEY_PLAN_CACHE = "statshelpr.planCache";
const PLAN_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
interface PlanCache {
  paid: boolean;
  at: number;
}

const opacityInput = document.getElementById("buttonOpacity") as HTMLInputElement | null;
const opacityValueEl = document.getElementById("opacityValue") as HTMLSpanElement | null;
const opacityLockEl = document.getElementById("opacity-lock") as HTMLAnchorElement | null;
const statusEl = document.getElementById("status") as HTMLDivElement;
const statusDot = document.getElementById("status-dot") as HTMLSpanElement;
const metaEl = document.getElementById("meta") as HTMLDivElement;
const dropzone = document.getElementById("dropzone") as HTMLDivElement;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
const filesList = document.getElementById("files-list") as HTMLDivElement;
const filesEmpty = document.getElementById("files-empty") as HTMLDivElement;
const pkgInput = document.getElementById("pkg-input") as HTMLInputElement;
const pkgAddBtn = document.getElementById("pkg-add") as HTMLButtonElement;
const libraryChipsEl = document.getElementById("library-chips") as HTMLDivElement;
const pkgEmptyEl = document.getElementById("pkg-empty") as HTMLDivElement;
const pkgErrorsEl = document.getElementById("pkg-errors") as HTMLDivElement;
const planCardEl = document.getElementById("plan-card") as HTMLDivElement;
const planSolvesEl = document.getElementById("plan-solves") as HTMLSpanElement;
const solvesMeterEl = document.getElementById("solves-meter") as HTMLDivElement;
const upgradeCtaEl = document.getElementById("upgrade-cta") as HTMLAnchorElement;
const planNoteEl = document.getElementById("plan-note") as HTMLDivElement;
const versionEl = document.getElementById("ext-version") as HTMLSpanElement;

let dataFiles: DataFile[] = [];
let libraries: string[] = [];
let packageErrors: PackageError[] = [];

// =============================================================================
// settings + health + plan
// =============================================================================

chrome.storage.sync.get(["apiUrl", "licenseKey", "buttonOpacity"], (cfg: StoredConfig) => {
  const opacity = typeof cfg.buttonOpacity === "number" ? cfg.buttonOpacity : DEFAULT_OPACITY;
  if (opacityInput) opacityInput.value = String(opacity);
  if (opacityValueEl) opacityValueEl.textContent = opacity.toFixed(2);
  void pingHealth(API_URL);
  void refreshPlan(API_URL, cfg.licenseKey ?? "");
});

// Live-preview the opacity readout as the user drags the slider.
opacityInput?.addEventListener("input", () => {
  if (!opacityValueEl) return;
  const v = Number(opacityInput.value);
  opacityValueEl.textContent = Number.isFinite(v) ? v.toFixed(2) : String(opacityInput.value);
});

// No Save button anymore — persist the moment the slider settles.
opacityInput?.addEventListener("change", () => {
  const v = Number(opacityInput.value);
  void chrome.storage.sync.set({
    buttonOpacity: Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : DEFAULT_OPACITY,
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
    ["ai tutor", kimiReady ? "ready" : "not set", kimiReady ? "ok" : "warn"],
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

// Show the real installed version instead of a hardcoded string.
try {
  versionEl.textContent = `v${chrome.runtime.getManifest().version}`;
} catch {
  /* file:// preview — keep the placeholder */
}

// Open checkout in a tab and get the popup out of the way.
upgradeCtaEl.addEventListener("click", (e) => {
  try {
    e.preventDefault();
    void chrome.tabs.create({ url: upgradeCtaEl.href });
    window.close();
  } catch {
    /* fall back to the plain <a target="_blank"> navigation */
  }
});

// Discreet-mode lock CTA (free plan only) does the same thing as the plan
// card's upgrade CTA — open checkout and get out of the way.
opacityLockEl?.addEventListener("click", (e) => {
  try {
    e.preventDefault();
    void chrome.tabs.create({ url: opacityLockEl.href });
    window.close();
  } catch {
    /* fall back to the plain <a target="_blank"> navigation */
  }
});

// =============================================================================
// plan state (free-tier funnel vs. Unlimited)
// =============================================================================
//
// Free vs. paid is decided by the license key + POST /api/auth/validate-license
// (the same endpoint the API uses to gate /api/solve). No key -> free funnel.
// Valid key -> calm "Unlimited" card. Invalid key -> free funnel plus an
// inline note explaining why. A last-good result is cached so a paid user
// opening the popup offline isn't shown the upsell.

function setPlan(plan: "free" | "paid") {
  planCardEl.dataset["plan"] = plan;
}

function setPlanNote(msg: string) {
  planNoteEl.textContent = msg;
  planNoteEl.style.display = msg ? "block" : "none";
}

/** Discreet mode (solve-button opacity) is a paid-only feature. Free users
 * get a disabled slider pinned to fully-visible plus an upgrade nudge. */
function applyOpacityGate(plan: "free" | "paid") {
  if (opacityInput) {
    if (plan === "free") {
      opacityInput.disabled = true;
      opacityInput.value = "1";
      if (opacityValueEl) opacityValueEl.textContent = "1.00";
    } else {
      opacityInput.disabled = false;
    }
  }
  if (opacityLockEl) {
    opacityLockEl.style.display = plan === "free" ? "flex" : "none";
  }
}

async function refreshPlan(apiUrl: string, licenseKey: string) {
  setPlanNote("");
  void renderSolvesLeft();

  if (!licenseKey) {
    setPlan("free");
    applyOpacityGate("free");
    await writePlanCache(false);
    return;
  }

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`${apiUrl.replace(/\/$/, "")}/api/auth/validate-license`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ licenseKey }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const data = (await res.json()) as { ok?: boolean; reason?: string };
    if (data.ok) {
      setPlan("paid");
      applyOpacityGate("paid");
      await writePlanCache(true);
    } else {
      setPlan("free");
      applyOpacityGate("free");
      const reason = data.reason ?? "license invalid";
      setPlanNote(`License issue: ${reason} — you're on the free plan for now.`);
      await writePlanCache(false);
    }
  } catch {
    // Network failure — fall back to the last confirmed state.
    const cached = await readPlanCache();
    if (cached?.paid) {
      setPlan("paid");
      applyOpacityGate("paid");
    } else {
      setPlan("free");
      applyOpacityGate("free");
    }
  }
}

async function readPlanCache(): Promise<PlanCache | null> {
  try {
    const r = await chrome.storage.local.get(STORAGE_KEY_PLAN_CACHE);
    const c = r[STORAGE_KEY_PLAN_CACHE] as PlanCache | undefined;
    if (!c || Date.now() - c.at > PLAN_CACHE_TTL_MS) return null;
    return c;
  } catch {
    return null;
  }
}

async function writePlanCache(paid: boolean) {
  try {
    await chrome.storage.local.set({
      [STORAGE_KEY_PLAN_CACHE]: { paid, at: Date.now() } satisfies PlanCache,
    });
  } catch {
    /* cache only */
  }
}

/** Render the "n of 5 left today" meter from the local counter that
 * content.ts maintains. Best-effort mirror of the server's rolling window. */
async function renderSolvesLeft() {
  let remaining = FREE_DAILY_LIMIT;
  let resetAt = 0;
  try {
    const r = await chrome.storage.local.get(STORAGE_KEY_SOLVE_STATS);
    const stats = r[STORAGE_KEY_SOLVE_STATS] as SolveStats | undefined;
    if (stats && stats.resetAt > Date.now()) {
      remaining = Math.max(0, FREE_DAILY_LIMIT - stats.count);
      resetAt = stats.resetAt;
    }
  } catch {
    /* no data — show a full meter */
  }

  while (planSolvesEl.firstChild) planSolvesEl.removeChild(planSolvesEl.firstChild);
  const b = document.createElement("b");
  b.textContent = String(remaining);
  planSolvesEl.appendChild(b);
  if (remaining === 0 && resetAt) {
    const hrs = Math.max(1, Math.ceil((resetAt - Date.now()) / 3_600_000));
    planSolvesEl.appendChild(
      document.createTextNode(` of ${FREE_DAILY_LIMIT} left — resets in ~${hrs}h`),
    );
  } else {
    planSolvesEl.appendChild(
      document.createTextNode(` of ${FREE_DAILY_LIMIT} solves left today`),
    );
  }

  const segs = solvesMeterEl.querySelectorAll("span");
  segs.forEach((seg, i) => seg.classList.toggle("on", i < remaining));

  // Tasteful conversion nudge: intensify once the user is down to their
  // last solve. Copy stays identical — only the styling escalates.
  const urgent = remaining <= 1;
  planSolvesEl.classList.toggle("urgent", urgent);
  upgradeCtaEl.classList.toggle("urgent", urgent);
}

// =============================================================================
// data files (drag-drop / click to upload)
// =============================================================================

void loadFiles().then(() => renderFilesList());

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fileInput.click();
  }
});
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
    rm.setAttribute("aria-label", `remove ${f.filename}`);
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
// R libraries (one unified, fully editable list — defaults included)
// =============================================================================

void loadLibraries().then(async () => {
  await loadPackageErrors();
  renderLibraryChips();
});

pkgAddBtn.addEventListener("click", async () => {
  await addPackagesFromInput();
});
pkgInput.addEventListener("keydown", async (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    await addPackagesFromInput();
  }
});

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
    if (!libraries.includes(pkg)) {
      libraries.push(pkg);
      changed = true;
    }
  }
  if (changed) {
    await saveLibraries();
    renderLibraryChips();
  }
}

function renderLibraryChips() {
  while (libraryChipsEl.firstChild) libraryChipsEl.removeChild(libraryChipsEl.firstChild);
  const errByPkg = new Map(packageErrors.map((e) => [e.pkg, e.message]));

  if (libraries.length === 0) {
    pkgEmptyEl.style.display = "";
  } else {
    pkgEmptyEl.style.display = "none";
    for (const pkg of libraries) {
      const chip = document.createElement("span");
      const failed = errByPkg.has(pkg);
      chip.className = failed ? "chip extra pkg-err" : "chip extra";
      if (failed) chip.title = errByPkg.get(pkg) ?? "failed to load";
      const label = document.createElement("span");
      label.textContent = failed ? `${pkg} !` : pkg;
      const rm = document.createElement("button");
      rm.className = "remove";
      rm.textContent = "×";
      rm.title = "remove";
      rm.setAttribute("aria-label", `remove ${pkg}`);
      rm.addEventListener("click", async () => {
        libraries = libraries.filter((p) => p !== pkg);
        await saveLibraries();
        renderLibraryChips();
      });
      chip.appendChild(label);
      chip.appendChild(rm);
      libraryChipsEl.appendChild(chip);
    }
  }

  renderPackageErrors(errByPkg);
}

/** Inline list of libraries that failed to install at the last WebR boot
 * (written by webr-runner.ts). Only errors for packages still in the list. */
function renderPackageErrors(errByPkg: Map<string, string>) {
  while (pkgErrorsEl.firstChild) pkgErrorsEl.removeChild(pkgErrorsEl.firstChild);
  const relevant = libraries.filter((p) => errByPkg.has(p));
  if (relevant.length === 0) {
    pkgErrorsEl.style.display = "none";
    return;
  }
  pkgErrorsEl.style.display = "block";
  for (const pkg of relevant) {
    const line = document.createElement("div");
    const b = document.createElement("b");
    b.textContent = pkg;
    line.appendChild(b);
    line.appendChild(document.createTextNode(`: ${errByPkg.get(pkg) ?? "failed to load"}`));
    pkgErrorsEl.appendChild(line);
  }
}

async function loadLibraries() {
  const r = await chrome.storage.sync.get(STORAGE_KEY_EXTRA_PACKAGES);
  const stored = r[STORAGE_KEY_EXTRA_PACKAGES] as string[] | undefined;
  if (stored === undefined) {
    // First-ever load: seed with the UT bundle defaults and persist
    // immediately so a fresh install still shows/uses the 6 defaults, and
    // this becomes the source of truth from here on.
    libraries = [...UT_BUNDLE];
    await saveLibraries();
  } else {
    libraries = stored;
  }
}

async function loadPackageErrors() {
  try {
    const r = await chrome.storage.local.get(STORAGE_KEY_PACKAGE_ERRORS);
    packageErrors = (r[STORAGE_KEY_PACKAGE_ERRORS] as PackageError[] | undefined) ?? [];
  } catch {
    packageErrors = [];
  }
}

async function saveLibraries() {
  await chrome.storage.sync.set({ [STORAGE_KEY_EXTRA_PACKAGES]: libraries });
}

// =============================================================================
// live updates while the popup is open
// =============================================================================

try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STORAGE_KEY_SOLVE_STATS]) {
      void renderSolvesLeft();
    }
    if (area === "local" && changes[STORAGE_KEY_PACKAGE_ERRORS]) {
      void loadPackageErrors().then(() => renderLibraryChips());
    }
    if (area === "local" && changes[STORAGE_KEY_FILES]) {
      void loadFiles().then(() => renderFilesList());
    }
    // activate.ts writes a fresh licenseKey after checkout completes on
    // statshelpr.com — pick it up live without requiring a popup reopen.
    if (area === "sync" && changes["licenseKey"]) {
      const newKey = (changes["licenseKey"].newValue as string | undefined) ?? "";
      void refreshPlan(API_URL, newKey);
    }
  });
} catch {
  /* file:// preview */
}
