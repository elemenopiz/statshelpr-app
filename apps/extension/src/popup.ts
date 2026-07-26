import {
  RPKG_STORAGE_KEY,
  MAX_R_PACKAGES,
  isValidPackageName,
  isInstalled,
  loadRPackages,
} from "./r-packages";
import { getInstallId } from "./install-id";
import { startClaiming, tryClaimLicense } from "./claim-license";

interface StoredConfig {
  apiUrl?: string;
  licenseKey?: string;
  buttonOpacity?: number;
}

// Fully visible by default — a first-install user has to be able to FIND the
// button before discreet mode means anything to them (fading is opt-in).
const DEFAULT_OPACITY = 1;
const API_URL = "https://api.statshelpr.com";

/** Manual light/dark override — unset means "follow the OS", same as the
 * CSS's default @media (prefers-color-scheme: dark) behavior. */
const STORAGE_KEY_THEME = "statshelpr.theme";
type Theme = "light" | "dark";

interface HealthResponse {
  ok?: boolean;
  version?: string;
  /** Current worker field (see apps/workers/src/routes/health.ts) — the
   * active AI provider is Gemini as of this field's introduction. */
  geminiConfigured?: boolean;
  /** Legacy fields from a prior AI provider. The worker no longer sends
   * these, but a stale/pinned worker deployment might still be running the
   * old response shape, so we keep reading them as a fallback — see
   * aiTutorReady's backward-tolerant lookup below. */
  kimiConfigured?: boolean;
  moonshotConfigured?: boolean;
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
const planCardEl = document.getElementById("plan-card") as HTMLDivElement;
const planSolvesEl = document.getElementById("plan-solves") as HTMLSpanElement;
const solvesMeterEl = document.getElementById("solves-meter") as HTMLDivElement;
const upgradeCtaEl = document.getElementById("upgrade-cta") as HTMLAnchorElement;
const planNoteEl = document.getElementById("plan-note") as HTMLDivElement;
const versionEl = document.getElementById("ext-version") as HTMLSpanElement;
const themeToggleEl = document.getElementById("theme-toggle") as HTMLButtonElement | null;
const deviceLimitNoteEl = document.getElementById("device-limit-note") as HTMLDivElement;
const resetDeviceBtn = document.getElementById("reset-device-btn") as HTMLButtonElement;
const resetStatusEl = document.getElementById("reset-status") as HTMLDivElement;

let dataFiles: DataFile[] = [];

// Current entitlement, set by applyOpacityGate() once refreshPlan() resolves.
// Gates whether a slider drag PERSISTS (paid) or just previews then reverts
// (free) — see the "change" handler below. Defaults to "free" so that until
// the plan check comes back we treat the user as free (never accidentally
// persist a discreet setting for someone who hasn't paid).
let currentPlan: "free" | "paid" = "free";

// =============================================================================
// theme (light/dark toggle, next to the status dot)
// =============================================================================

// Dark is the product default — it's what the popup is designed around, and it
// sits better over Canvas. The OS preference no longer decides; a user who
// wants light picks it with the toggle and that choice is what persists.
function defaultTheme(): Theme {
  return "dark";
}

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

// Hand-drawn (not a system emoji font) so it renders identically and crisply
// across platforms, and inherits --ink-3 / hover --blue via currentColor.
// The crescent is a circle with a second, offset circle masked out of it —
// no fragile arc-path math.
function buildMoonIcon(): SVGSVGElement {
  const svg = svgEl("svg", { width: "16", height: "16", viewBox: "0 0 24 24", "aria-hidden": "true" });
  const mask = svgEl("mask", { id: "sh-moon-mask" });
  mask.appendChild(svgEl("rect", { width: "24", height: "24", fill: "#fff" }));
  mask.appendChild(svgEl("circle", { cx: "15", cy: "9", r: "7", fill: "#000" }));
  svg.appendChild(mask);
  svg.appendChild(
    svgEl("circle", { cx: "12", cy: "12", r: "9", fill: "currentColor", mask: "url(#sh-moon-mask)" }),
  );
  return svg;
}

function buildSunIcon(): SVGSVGElement {
  const svg = svgEl("svg", {
    width: "16",
    height: "16",
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "aria-hidden": "true",
  });
  svg.appendChild(svgEl("circle", { cx: "12", cy: "12", r: "5", fill: "currentColor", stroke: "none" }));
  const rays: [string, string, string, string][] = [
    ["12", "2", "12", "5"],
    ["12", "19", "12", "22"],
    ["2", "12", "5", "12"],
    ["19", "12", "22", "12"],
    ["4.9", "4.9", "7", "7"],
    ["17", "17", "19.1", "19.1"],
    ["4.9", "19.1", "7", "17"],
    ["17", "7", "19.1", "4.9"],
  ];
  for (const [x1, y1, x2, y2] of rays) {
    svg.appendChild(svgEl("line", { x1, y1, x2, y2 }));
  }
  return svg;
}

function applyTheme(theme: Theme) {
  document.documentElement.setAttribute("data-theme", theme);
  if (themeToggleEl) {
    const next: Theme = theme === "dark" ? "light" : "dark";
    themeToggleEl.replaceChildren(theme === "dark" ? buildMoonIcon() : buildSunIcon());
    themeToggleEl.setAttribute("aria-label", `Switch to ${next} theme`);
    themeToggleEl.title = "Switch theme";
  }
}

(async () => {
  let theme = defaultTheme();
  try {
    const r = await chrome.storage.local.get(STORAGE_KEY_THEME);
    const stored = r[STORAGE_KEY_THEME] as Theme | undefined;
    if (stored === "light" || stored === "dark") theme = stored;
  } catch {
    /* file:// preview — fall back to the system theme computed above */
  }
  applyTheme(theme);
})();

themeToggleEl?.addEventListener("click", () => {
  const current: Theme = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  const next: Theme = current === "dark" ? "light" : "dark";
  applyTheme(next);
  try {
    void chrome.storage.local.set({ [STORAGE_KEY_THEME]: next });
  } catch {
    /* file:// preview — theme choice just won't persist */
  }
});

// =============================================================================
// settings + health + plan
// =============================================================================

// The slider is a 0–100 integer PERCENT (step 1); the stored `buttonOpacity`
// is that percent / 100 in [0, 1]. content.ts turns it into the rendered
// opacity via a perceptual gamma curve (see applyButtonOpacity there) — the
// popup just reports the position, it doesn't do the curve itself.
function dialToPercent(dial: number): number {
  return Math.round(Math.min(1, Math.max(0, dial)) * 100);
}

chrome.storage.sync.get(["apiUrl", "licenseKey", "buttonOpacity"], (cfg: StoredConfig) => {
  const dial = typeof cfg.buttonOpacity === "number" ? cfg.buttonOpacity : DEFAULT_OPACITY;
  const pct = dialToPercent(dial);
  if (opacityInput) opacityInput.value = String(pct);
  if (opacityValueEl) opacityValueEl.textContent = `${pct}%`;
  void pingHealth(API_URL);
  void refreshPlan(API_URL, cfg.licenseKey ?? "");
  // One-shot zero-click claim check: if an upgrade was started from this
  // popup and the purchase webhook has landed, this stores the license key
  // right now — the storage.onChanged listener below then re-runs
  // refreshPlan, so an open popup flips to Unlimited live.
  void tryClaimLicense();
});

// Bake this install's id into the checkout links so the license can
// auto-claim onto exactly this browser with zero clicks (see
// src/claim-license.ts).
//
// The links point at https://statshelpr.com/checkout, NOT straight at the
// Lemon Squeezy hosted checkout. That page is where the required
// Terms/Privacy/Refund assent checkbox lives — routing both CTAs through it
// is what makes the gate cover the popup path, which is the primary way
// people actually buy. checkout.html then appends
// `checkout[custom][install_id]=<id>` to the LS URL itself, byte-for-byte
// the param this file used to append, so the purchase webhook still echoes
// it back and zero-click activation is unchanged.
//
// The id travels in the URL FRAGMENT, not a query param: fragments are never
// sent to the server, so this hop doesn't start writing install ids into
// Cloudflare Pages access logs.
void getInstallId().then((id) => {
  const frag = "#install_id=" + encodeURIComponent(id);
  [upgradeCtaEl, opacityLockEl].forEach((a) => {
    if (!a) return;
    const href = a.getAttribute("href");
    if (!href || href.includes("#")) return;
    a.href = href + frag;
  });
});

// Wake up the solve buttons on whichever Canvas tab is active. content.ts
// boots dormant (see its `activated` flag) specifically so the extension
// never passively surfaces itself on every quiz for every course — the
// student has to deliberately reach for the toolbar icon before the API can
// be used on that page. Fire-and-forget: if the active tab isn't a matching
// Canvas page there's no listener and we swallow the lastError, same as
// previewOpacityOnActiveTab below.
try {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const id = tabs[0]?.id;
    if (id == null) return;
    chrome.tabs.sendMessage(id, { type: "sh-activate" }, () => {
      void chrome.runtime.lastError; // no content script on this tab — ignore
    });
  });
} catch {
  /* file:// popup preview or no active tab — nothing to activate */
}

/** Push a live opacity value to the on-page solve button in the active tab so
 *  it dims IN REAL TIME as the slider is dragged. Fire-and-forget: the active
 *  tab is usually the Canvas quiz whose content script is listening, but if it
 *  isn't (a non-Canvas tab, or the popup opened over chrome://) sendMessage
 *  has no receiver and we swallow the lastError. Needs no "tabs" permission —
 *  active/currentWindow returns the tab id, and delivery rides our existing
 *  instructure.com host permission. */
function previewOpacityOnActiveTab(dial: number): void {
  try {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const id = tabs[0]?.id;
      if (id == null) return;
      chrome.tabs.sendMessage(id, { type: "sh-preview-opacity", value: dial }, () => {
        void chrome.runtime.lastError; // no content script on this tab — ignore
      });
    });
  } catch {
    /* file:// popup preview or no active tab — live preview just won't fire */
  }
}

// While DRAGGING: update the % readout and live-dim the on-page button, but
// don't touch storage yet (its write-rate limit would throttle a drag).
opacityInput?.addEventListener("input", () => {
  const pct = Number(opacityInput.value);
  if (!Number.isFinite(pct)) return;
  if (opacityValueEl) opacityValueEl.textContent = `${Math.round(pct)}%`;
  previewOpacityOnActiveTab(pct / 100);
});

// On RELEASE:
//  - paid: persist the settled value (content.ts's storage.onChanged then
//    applies it to every open Canvas tab, and it survives across sessions).
//  - free: this was a live PREVIEW only. Snap the button back to fully
//    visible and pulse the upgrade nudge — the taste of discreet mode is the
//    conversion hook, keeping it is the paid feature. Nothing is persisted,
//    so the on-page button returns to full on the next page load regardless.
opacityInput?.addEventListener("change", () => {
  const pct = Number(opacityInput.value);
  if (currentPlan !== "paid") {
    if (opacityInput) opacityInput.value = "100";
    if (opacityValueEl) opacityValueEl.textContent = "100%";
    previewOpacityOnActiveTab(1); // restore the on-page button immediately
    flashOpacityLock();
    return;
  }
  void chrome.storage.sync.set({
    buttonOpacity: Number.isFinite(pct) ? Math.min(1, Math.max(0, pct / 100)) : DEFAULT_OPACITY,
  });
});

/** Briefly pull attention to the "Unlimited unlocks discreet mode" nudge when
 *  a free user lets go of the slider — restarts a short CSS pulse (see
 *  popup.html's .opacity-lock.pulse). */
let lockPulseTimer: ReturnType<typeof setTimeout> | undefined;
function flashOpacityLock(): void {
  if (!opacityLockEl) return;
  opacityLockEl.classList.remove("pulse");
  void opacityLockEl.offsetWidth; // force reflow so re-adding the class restarts the animation
  opacityLockEl.classList.add("pulse");
  if (lockPulseTimer) clearTimeout(lockPulseTimer);
  lockPulseTimer = setTimeout(() => opacityLockEl?.classList.remove("pulse"), 1000);
}

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
    const aiTutorReady = data.geminiConfigured ?? data.kimiConfigured ?? data.moonshotConfigured ?? false;
    if (!aiTutorReady) {
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
  const aiTutorReady = data.geminiConfigured ?? data.kimiConfigured ?? data.moonshotConfigured ?? false;
  const rows: Array<[string, string, "ok" | "warn" | ""]> = [
    ["version", data.version ?? "—", ""],
    ["ai tutor", aiTutorReady ? "ready" : "not set", aiTutorReady ? "ok" : "warn"],
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

// Open checkout in a tab and get the popup out of the way. Arm the
// zero-click claim poll FIRST (awaited — the popup is about to close, and a
// fire-and-forget storage write could lose the race with teardown).
function openCheckout(anchor: HTMLAnchorElement): void {
  void (async () => {
    try {
      await startClaiming();
    } catch {
      /* claim is best-effort — checkout still works via redirect/email */
    }
    try {
      await chrome.tabs.create({ url: anchor.href });
    } catch {
      window.open(anchor.href, "_blank", "noopener");
    }
    window.close();
  })();
}

upgradeCtaEl.addEventListener("click", (e) => {
  e.preventDefault();
  openCheckout(upgradeCtaEl);
});

// Discreet-mode lock CTA (free plan only) does the same thing as the plan
// card's upgrade CTA — open checkout and get out of the way.
opacityLockEl?.addEventListener("click", (e) => {
  e.preventDefault();
  openCheckout(opacityLockEl);
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
  // Paid hides the whole card and shows the header badge instead — the CSS
  // keys off <body>, since the badge lives outside the card.
  document.body.dataset["plan"] = plan;
}

function setPlanNote(msg: string) {
  planNoteEl.textContent = msg;
  planNoteEl.style.display = msg ? "block" : "none";
  syncPlanNoteFlag();
}

/** Paid users get no card — except when one of the two notes has something to
 *  say, in which case the card reappears carrying only that note. */
function syncPlanNoteFlag() {
  const shown = planNoteEl.style.display === "block" || deviceLimitNoteEl.style.display === "block";
  if (shown) planCardEl.dataset["note"] = "on";
  else delete planCardEl.dataset["note"];
}

/** Discreet mode (persisting a dimmed solve button) is a paid feature — but
 *  free users can still DRAG the slider to preview it live on the page (see
 *  the "input"/"change" handlers). The slider is always interactive now; what
 *  differs is whether release persists (paid) or reverts with an upgrade nudge
 *  (free). Free users see the lock CTA; paid users don't. */
function applyOpacityGate(plan: "free" | "paid") {
  currentPlan = plan;
  if (opacityInput) {
    opacityInput.disabled = false; // draggable for everyone (free = preview only)
    if (plan === "free") {
      opacityInput.value = "100";
      if (opacityValueEl) opacityValueEl.textContent = "100%";
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
// single-device activation + reset
// =============================================================================
//
// Paid licenses are good on one device at a time. activate.ts sets
// chrome.storage.local.activationBlocked when POST /api/activate-license
// comes back { ok:false, atLimit:true }; content.ts sets the same flag when
// a solve gets a 403 with atLimit:true. Either way, this popup is the one
// place that surfaces it and offers a way out: POST /api/reset/request frees
// the license so it can be activated on a (new) device again. activate.ts
// clears the flag itself once a fresh activation is confirmed.

const STORAGE_KEY_ACTIVATION_BLOCKED = "activationBlocked";

void refreshDeviceLimitState();

async function refreshDeviceLimitState() {
  try {
    const r = await chrome.storage.local.get(STORAGE_KEY_ACTIVATION_BLOCKED);
    setDeviceLimitBlocked(Boolean(r[STORAGE_KEY_ACTIVATION_BLOCKED]));
  } catch {
    /* file:// preview — leave hidden */
  }
}

function setDeviceLimitBlocked(blocked: boolean) {
  deviceLimitNoteEl.style.display = blocked ? "block" : "none";
  syncPlanNoteFlag();
  if (!blocked) setResetStatus("", "");
}

function setResetStatus(msg: string, kind: "ok" | "err" | "") {
  resetStatusEl.textContent = msg;
  resetStatusEl.className = `status${kind ? ` ${kind}` : ""}`;
  resetStatusEl.style.display = msg ? "block" : "none";
}

resetDeviceBtn.addEventListener("click", () => {
  void requestReset();
});

async function requestReset() {
  resetDeviceBtn.disabled = true;
  setResetStatus("Requesting reset…", "");
  try {
    const cfg = await chrome.storage.sync.get("licenseKey");
    const licenseKey = (cfg["licenseKey"] as string | undefined) ?? "";
    if (!licenseKey) {
      setResetStatus("No license key found — activate first.", "err");
      return;
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(`${API_URL.replace(/\/$/, "")}/api/reset/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ licenseKey }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      setResetStatus("Couldn't request a reset — try again shortly.", "err");
      return;
    }

    const data = (await res.json()) as { ok?: boolean; method?: "portal" | "email"; url?: string };
    if (data.ok && data.method === "portal" && data.url) {
      void chrome.tabs.create({ url: data.url });
      setResetStatus("Opened the reset page in a new tab.", "ok");
    } else if (data.ok && data.method === "email") {
      setResetStatus("Check your email for a reset link.", "ok");
    } else {
      setResetStatus("Couldn't request a reset — try again shortly.", "err");
    }
  } catch {
    setResetStatus("Network error — check your connection and try again.", "err");
  } finally {
    resetDeviceBtn.disabled = false;
  }
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
// R libraries picker (folded; steers the tutor's package choice server-side)
// =============================================================================
//
// The chosen list is POSTed with each solve (see content.ts) and shapes which
// R packages the tutor's generated code reaches for. Defaults are the intro-
// stats core and are fully REMOVABLE — a user in another course clears them and
// adds their own. Only packages pre-installed on the runner actually run, so a
// typed-in one outside INSTALLED_CATALOG is kept but flagged (dashed chip).

const rpkgChipsEl = document.getElementById("rpkg-chips") as HTMLDivElement;
const rpkgInput = document.getElementById("rpkg-input") as HTMLInputElement;
const rpkgAddBtn = document.getElementById("rpkg-add") as HTMLButtonElement;
const rpkgEmptyEl = document.getElementById("rpkg-empty") as HTMLDivElement;

let rPackages: string[] = [];

void loadRPackages().then(({ list }) => {
  rPackages = list;
  renderRPackages();
});

rpkgAddBtn.addEventListener("click", () => void addRPackagesFromInput());
rpkgInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    void addRPackagesFromInput();
  }
});

function renderRPackages() {
  while (rpkgChipsEl.firstChild) rpkgChipsEl.removeChild(rpkgChipsEl.firstChild);
  rpkgEmptyEl.style.display = rPackages.length === 0 ? "" : "none";
  for (const pkg of rPackages) {
    const installed = isInstalled(pkg);
    const chip = document.createElement("span");
    chip.className = installed ? "chip" : "chip unknown";
    if (!installed) chip.title = "Not pre-installed on the server yet — may not run.";
    const label = document.createElement("span");
    label.textContent = pkg;
    const rm = document.createElement("button");
    rm.className = "rm";
    rm.textContent = "×";
    rm.title = `remove ${pkg}`;
    rm.setAttribute("aria-label", `remove ${pkg}`);
    rm.addEventListener("click", () => {
      rPackages = rPackages.filter((p) => p !== pkg);
      void saveRPackages();
      renderRPackages();
    });
    chip.appendChild(label);
    chip.appendChild(rm);
    rpkgChipsEl.appendChild(chip);
  }
}

async function addRPackagesFromInput() {
  // Split on commas/whitespace so pasting a list ("car, lme4 psych") in one go
  // works, not just a single name.
  const candidates = rpkgInput.value
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  rpkgInput.value = "";
  if (candidates.length === 0) return;

  let changed = false;
  for (const pkg of candidates) {
    if (!isValidPackageName(pkg)) continue; // silently drop junk tokens
    if (rPackages.includes(pkg)) continue; // case-sensitive: MASS != mass
    if (rPackages.length >= MAX_R_PACKAGES) break;
    rPackages.push(pkg);
    changed = true;
  }
  if (changed) {
    await saveRPackages();
    renderRPackages();
  }
}

async function saveRPackages() {
  try {
    await chrome.storage.sync.set({ [RPKG_STORAGE_KEY]: rPackages });
  } catch {
    /* file:// preview — selection just won't persist */
  }
}

// =============================================================================
// live updates while the popup is open
// =============================================================================

try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STORAGE_KEY_SOLVE_STATS]) {
      void renderSolvesLeft();
    }
    if (area === "local" && changes[STORAGE_KEY_FILES]) {
      void loadFiles().then(() => renderFilesList());
    }
    // activate.ts / content.ts flip this when the single-device limit is hit
    // (or cleared) — reflect it live without requiring a popup reopen.
    if (area === "local" && changes[STORAGE_KEY_ACTIVATION_BLOCKED]) {
      setDeviceLimitBlocked(Boolean(changes[STORAGE_KEY_ACTIVATION_BLOCKED]?.newValue));
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

// =============================================================================
// R code export ("copy R code for this quiz")
// =============================================================================
//
// content.ts buffers each solved calc question's raw R code for the page
// load's lifetime (see r-export.ts's privacy contract — no question text, no
// comments, no identifiers). The buffer only exists there, so on every popup
// open we ask the active tab's content script for the current bundle via a
// `sh-get-r-export` message and cache the response here. The copy button then
// writes the cached string directly in its own click handler (not after an
// async round-trip) so the clipboard write stays inside the user-gesture
// context Chrome requires.

const rcodeCopyBtn = document.getElementById("rcode-copy") as HTMLButtonElement;
const rcodeEmptyEl = document.getElementById("rcode-empty") as HTMLDivElement;

let cachedRCodeBundle = "";

function setRCodeAvailable(available: boolean): void {
  rcodeCopyBtn.disabled = !available;
  rcodeEmptyEl.style.display = available ? "none" : "";
}

try {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const id = tabs[0]?.id;
    if (id == null) return;
    chrome.tabs.sendMessage(id, { type: "sh-get-r-export" }, (response) => {
      if (chrome.runtime.lastError) return; // no content script on this tab
      const hasCode = Boolean(response?.hasCode);
      cachedRCodeBundle = typeof response?.bundle === "string" ? response.bundle : "";
      setRCodeAvailable(hasCode);
    });
  });
} catch {
  /* file:// popup preview or no active tab — leave the empty state showing */
}

rcodeCopyBtn.addEventListener("click", () => {
  if (!cachedRCodeBundle) return;
  void navigator.clipboard.writeText(cachedRCodeBundle).then(() => {
    const original = rcodeCopyBtn.textContent;
    rcodeCopyBtn.textContent = "Copied!";
    setTimeout(() => {
      rcodeCopyBtn.textContent = original;
    }, 1500);
  });
});
