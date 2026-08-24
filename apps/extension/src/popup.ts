import {
  UT_PRESET_ID,
  isInstalled,
  loadPresetsState,
  resolveActivePreset,
  createPreset,
  deletePreset,
  setActivePresetId,
  type PresetsState,
} from "./r-packages";
import { getInstallId } from "./install-id";
import { startClaiming, tryClaimLicense } from "./claim-license";
// Dev logger — type-only import so the module is excluded from the production
// bundle. Runtime symbols are accessed via dynamic import inside the
// if(STATSHELPR_DEV) block below.
import type { DevEntry } from "./dev-logger";

// Compile-time flag — same define as content.ts. False in production → the
// entire dev mode UI block below is dead-code-eliminated by esbuild.
declare const STATSHELPR_DEV: boolean;
/** Bypass key baked into the dev build at compile time — "" in production. */
declare const STATSHELPR_DEV_KEY: string;

interface StoredConfig {
  apiUrl?: string;
  licenseKey?: string;
  buttonOpacity?: number;
  /** Telemetry OPT-OUT flag (see the telemetry section below). Unset/false
   * means the content-free beacon is sent; true suppresses it. Written only
   * by this popup, read only by content.ts's getConfig(). */
  telemetryDisabled?: boolean;
}

// Fully visible by default — a first-install user has to be able to FIND the
// button before discreet mode means anything to them (fading is opt-in).
const DEFAULT_OPACITY = 1;
const API_URL = "https://api.statshelpr.com";

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
const FREE_DAILY_LIMIT = 7;
interface SolveStats {
  count: number;
  resetAt: number;
}

/** Written by content.ts: never-resets all-time solve count. Gates the
 * Unlimited pitch (CTA button + "cancel anytime" subtext) so a first-install
 * user can try the product a few times before ever seeing a price — once
 * unlocked it stays unlocked (checked as >=, not tied to today's count).
 * METER_UNLOCK_AFTER gates something narrower and earlier: even the bare
 * "n of 7 left" count + gauge (no price, no CTA) still tells a brand-new
 * user "this is capped" before they've felt any value. Hidden until their
 * FIRST real solve — a popup opened right after install shows just "Free
 * plan," nothing metered. */
const STORAGE_KEY_LIFETIME_SOLVES = "statshelpr.lifetimeSolves";
const METER_UNLOCK_AFTER = 1;
const UPGRADE_PITCH_UNLOCK_AFTER = 3;

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
const solvesMeterFillEl = document.getElementById("solves-meter-fill") as HTMLDivElement;
const upgradeCtaEl = document.getElementById("upgrade-cta") as HTMLAnchorElement;
const planSubEl = document.getElementById("plan-sub") as HTMLDivElement;
const planNoteEl = document.getElementById("plan-note") as HTMLDivElement;
const versionEl = document.getElementById("ext-version") as HTMLSpanElement;
const telemetryToggle = document.getElementById("telemetry-toggle") as HTMLInputElement | null;
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
// settings + health + plan
// =============================================================================

// The slider is a 0–100 integer PERCENT (step 1); the stored `buttonOpacity`
// is that percent / 100 in [0, 1]. content.ts turns it into the rendered
// opacity via a perceptual gamma curve (see applyButtonOpacity there) — the
// popup just reports the position, it doesn't do the curve itself.
function dialToPercent(dial: number): number {
  return Math.round(Math.min(1, Math.max(0, dial)) * 100);
}

const SYNC_KEYS = ["apiUrl", "licenseKey", "buttonOpacity", "telemetryDisabled"];

chrome.storage.sync.get(SYNC_KEYS, (cfg: StoredConfig) => {
  const dial = typeof cfg.buttonOpacity === "number" ? cfg.buttonOpacity : DEFAULT_OPACITY;
  const pct = dialToPercent(dial);
  if (opacityInput) opacityInput.value = String(pct);
  if (opacityValueEl) opacityValueEl.textContent = `${pct}%`;
  // Polarity flip: the box says "send stats", the flag says "disabled".
  // Unset (a fresh install) = telemetry on = box checked.
  if (telemetryToggle) telemetryToggle.checked = cfg.telemetryDisabled !== true;
  void pingHealth(API_URL);
  // In dev builds: use the compile-time bypass key so the popup shows
  // "Unlimited" immediately, mirroring what content.ts sends to the worker.
  const effectiveLicenseKey = (STATSHELPR_DEV && STATSHELPR_DEV_KEY)
    ? STATSHELPR_DEV_KEY
    : (cfg.licenseKey ?? "");
  void refreshPlan(API_URL, effectiveLicenseKey);
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

// -----------------------------------------------------------------------------
// telemetry opt-out
// -----------------------------------------------------------------------------
//
// The write side of the content-free usage beacon's opt-out. content.ts already
// owns the read side: getConfig() pulls `telemetryDisabled` out of
// chrome.storage.sync on every solve and fireTelemetryBeacon() returns early
// when it's true, so nothing is sent. This checkbox is the only thing that ever
// writes that key.
//
// MIND THE POLARITY — the checkbox and the stored flag are inverted:
//   checked   → "send anonymous usage stats" → telemetryDisabled = false
//   unchecked → opted out                    → telemetryDisabled = true
// Unset (fresh install) reads back as `!== true`, i.e. checked / telemetry on,
// which matches content.ts's "default/unset = enabled" behavior.
//
// Persisted to storage.sync rather than .local so the choice follows the
// student across their signed-in Chrome profiles, like the other settings here.
telemetryToggle?.addEventListener("change", () => {
  void chrome.storage.sync.set({ telemetryDisabled: !telemetryToggle.checked });
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
  // The card is visible in both states and swaps its contents (.plan-free vs
  // .plan-paid) off its own data-plan. The copy on <body> is what shows the
  // footer's cancel-subscription link, which lives outside the card.
  planCardEl.dataset["plan"] = plan;
  document.body.dataset["plan"] = plan;
}

function setPlanNote(msg: string) {
  planNoteEl.textContent = msg;
  planNoteEl.style.display = msg ? "block" : "none";
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
      // A downgrade (cancellation, device reset, payment failure) must clear
      // any PERSISTED dim value too, not just this popup's display — the
      // free-tier slider's "change" handler below only ever live-previews,
      // it never writes to storage, so without this a user who dimmed the
      // button while paid keeps a dim/invisible on-page button forever with
      // no way to undo it after losing paid status.
      void resetPersistedOpacityIfDimmed();
    }
  }
  if (opacityLockEl) {
    opacityLockEl.style.display = plan === "free" ? "flex" : "none";
  }
}

async function resetPersistedOpacityIfDimmed(): Promise<void> {
  const stored = (await chrome.storage.sync.get(["buttonOpacity"])) as { buttonOpacity?: number };
  if (typeof stored.buttonOpacity === "number" && stored.buttonOpacity !== 1) {
    await chrome.storage.sync.set({ buttonOpacity: 1 });
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

/** Render the "n of 7 left today" meter from the local counter that
 * content.ts maintains. Best-effort mirror of the server's rolling window. */
async function renderSolvesLeft() {
  let remaining = FREE_DAILY_LIMIT;
  let resetAt = 0;
  let pitchUnlocked = false;
  let meterUnlocked = false;
  try {
    const r = await chrome.storage.local.get([STORAGE_KEY_SOLVE_STATS, STORAGE_KEY_LIFETIME_SOLVES]);
    const stats = r[STORAGE_KEY_SOLVE_STATS] as SolveStats | undefined;
    if (stats && stats.resetAt > Date.now()) {
      remaining = Math.max(0, FREE_DAILY_LIMIT - stats.count);
      resetAt = stats.resetAt;
    }
    const lifetime = (r[STORAGE_KEY_LIFETIME_SOLVES] as number | undefined) ?? 0;
    pitchUnlocked = lifetime >= UPGRADE_PITCH_UNLOCK_AFTER;
    meterUnlocked = lifetime >= METER_UNLOCK_AFTER;
  } catch {
    /* no data — meter/pitch both stay locked */
  }
  upgradeCtaEl.style.display = pitchUnlocked ? "" : "none";
  planSubEl.style.display = pitchUnlocked ? "" : "none";
  planSolvesEl.style.display = meterUnlocked ? "" : "none";
  solvesMeterEl.style.display = meterUnlocked ? "" : "none";

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

  solvesMeterFillEl.style.width = `${Math.round((remaining / FREE_DAILY_LIMIT) * 100)}%`;

  // Tasteful conversion nudge: intensify once the user is down to their
  // last solve (styling only — pulse, error-tint). The pitch itself was
  // already unlocked earlier (UPGRADE_PITCH_UNLOCK_AFTER solves in), so by
  // the time this fires the CTA is always showing; only its subtext swaps
  // to the specific, actionable reason ("you're out today") instead of the
  // generic value-prop line.
  const urgent = remaining <= 1;
  planSolvesEl.classList.toggle("urgent", urgent);
  upgradeCtaEl.classList.toggle("urgent", urgent);
  solvesMeterEl.classList.toggle("urgent", urgent);
  if (pitchUnlocked) {
    planSubEl.textContent =
      urgent && remaining === 0
        ? "Out of free solves today — go Unlimited to keep going"
        : "Unlimited solves + discreet mode · cancel anytime";
  }
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

/** "2h ago" / "3d ago" — coarse enough for a hover tooltip, not a clock. */
function relativeAge(addedAt: number): string {
  const mins = Math.max(0, Math.round((Date.now() - addedAt) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function renderFilesList() {
  while (filesList.firstChild) filesList.removeChild(filesList.firstChild);
  if (dataFiles.length === 0) {
    filesEmpty.style.display = "";
    return;
  }
  filesEmpty.style.display = "none";
  for (const f of dataFiles) {
    // Same .chip pill as the R package list (#preset-pkg-chips) — one
    // pattern for "removable tag" instead of two. Size/added-at move from
    // always-visible text to a hover tooltip to keep the pill compact.
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.title = `${(f.size / 1024).toFixed(1)} kb · added ${relativeAge(f.addedAt)}`;
    const label = document.createElement("span");
    label.className = "chip-label";
    label.textContent = f.filename;
    const rm = document.createElement("button");
    rm.className = "rm";
    rm.type = "button";
    rm.textContent = "×";
    rm.setAttribute("aria-label", `remove ${f.filename}`);
    rm.addEventListener("click", async () => {
      dataFiles = dataFiles.filter((d) => d.filename !== f.filename);
      await saveFiles();
      renderFilesList();
    });
    chip.appendChild(label);
    chip.appendChild(rm);
    filesList.appendChild(chip);
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
// Course preset picker (course-topic branch — replaces the old flat
// per-package chip picker entirely)
// =============================================================================
//
// The active preset's package list is POSTed with each solve (see
// content.ts) and shapes which R packages the tutor's generated code reaches
// for; for a preset explicitly marked as NOT based on UT STA 301, the solve
// also carries `courseProfile: "generic"`, swapping the tutor's course
// conventions too — see r-packages.ts's resolveActivePreset for the exact
// derivation table. "UT Austin STA 301" is a reserved, always-first, never-
// deletable entry — selecting it (the default; nothing here has to be
// touched) sends a solve request byte-identical to before this feature
// existed. A preset's NAME is free text shown ONLY in this UI — see
// r-packages.ts's module doc for the privacy contract; it never leaves the
// device.

const presetSelectEl = document.getElementById("preset-select") as HTMLSelectElement;
const presetPkgChipsEl = document.getElementById("preset-pkg-chips") as HTMLDivElement;
const presetPkgEmptyEl = document.getElementById("preset-pkg-empty") as HTMLDivElement;
const presetNewBtn = document.getElementById("preset-new-btn") as HTMLButtonElement;
const presetDeleteBtn = document.getElementById("preset-delete-btn") as HTMLButtonElement;
const presetCreateForm = document.getElementById("preset-create-form") as HTMLDivElement;
const presetNameInput = document.getElementById("preset-name-input") as HTMLInputElement;
const presetBasedOnUtCheckbox = document.getElementById("preset-based-on-ut") as HTMLInputElement;
const presetPkgsInput = document.getElementById("preset-pkgs-input") as HTMLInputElement;
const presetCreateSaveBtn = document.getElementById("preset-create-save") as HTMLButtonElement;
const presetCreateCancelBtn = document.getElementById("preset-create-cancel") as HTMLButtonElement;
const presetCreateStatusEl = document.getElementById("preset-create-status") as HTMLDivElement;

let presetsState: PresetsState = { presets: [], activePresetId: UT_PRESET_ID };

void loadPresetsState().then((s) => {
  presetsState = s;
  renderPresetSelect();
  renderActivePresetChips();
});

function renderPresetSelect(): void {
  // The UT Austin STA 301 <option> is HARD-CODED in popup.html (not built
  // here) specifically so it's already selected on first paint, before
  // chrome.storage even resolves — a UT student must never see an empty
  // dropdown, even for one frame. This function therefore only ever manages
  // the options AFTER it: strip everything from index 1 onward and rebuild
  // from presetsState, but NEVER touch/remove options[0].
  while (presetSelectEl.options.length > 1) {
    presetSelectEl.remove(1);
  }
  for (const p of presetsState.presets) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name || "(untitled preset)";
    presetSelectEl.appendChild(opt);
  }
  // A stale reference (the active preset was deleted elsewhere) normalizes to
  // UT_PRESET_ID so the select never displays blank and the delete button stays hidden.
  const hasActivePreset =
    presetsState.activePresetId === UT_PRESET_ID ||
    presetsState.presets.some((p) => p.id === presetsState.activePresetId);
  const effectiveActiveId = hasActivePreset ? presetsState.activePresetId : UT_PRESET_ID;
  if (!hasActivePreset) {
    presetsState = { ...presetsState, activePresetId: UT_PRESET_ID };
  }
  presetSelectEl.value = effectiveActiveId;
  presetDeleteBtn.style.display = effectiveActiveId === UT_PRESET_ID ? "none" : "";
}

function renderActivePresetChips(): void {
  while (presetPkgChipsEl.firstChild) presetPkgChipsEl.removeChild(presetPkgChipsEl.firstChild);
  const resolved = resolveActivePreset(presetsState.presets, presetsState.activePresetId);
  presetPkgEmptyEl.style.display = resolved.list.length === 0 ? "" : "none";
  for (const pkg of resolved.list) {
    const installed = isInstalled(pkg);
    const chip = document.createElement("span");
    chip.className = installed ? "chip" : "chip unknown";
    if (!installed) chip.title = "Not pre-installed on the server yet — may not run.";
    chip.textContent = pkg;
    presetPkgChipsEl.appendChild(chip);
  }
}

presetSelectEl.addEventListener("change", () => {
  const id = presetSelectEl.value;
  presetsState = { ...presetsState, activePresetId: id };
  renderPresetSelect();
  renderActivePresetChips();
  void setActivePresetId(id);
});

presetNewBtn.addEventListener("click", () => {
  presetNameInput.value = "";
  presetPkgsInput.value = "";
  // "default ON when duplicating, OFF for from-scratch": this control is
  // reached via the preset SELECT, so "duplicating" means the currently
  // active/visible preset is UT STA 301 — the common on-ramp for a first
  // custom preset. If a different (already-custom) preset is active, default
  // to OFF instead, since there's no single obvious course to inherit from.
  presetBasedOnUtCheckbox.checked = presetsState.activePresetId === UT_PRESET_ID;
  setCreateStatus("", "");
  presetCreateForm.style.display = "block";
  presetNameInput.focus();
});

presetCreateCancelBtn.addEventListener("click", () => {
  presetCreateForm.style.display = "none";
});

presetCreateSaveBtn.addEventListener("click", () => void saveNewPreset());
presetNameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    void saveNewPreset();
  }
});
presetPkgsInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    void saveNewPreset();
  }
});

async function saveNewPreset(): Promise<void> {
  const name = presetNameInput.value.trim();
  if (!name) {
    setCreateStatus("Give the preset a name.", "err");
    return;
  }
  const { presets, preset } = await createPreset(
    presetsState.presets,
    name,
    presetPkgsInput.value,
    presetBasedOnUtCheckbox.checked,
  );
  presetsState = { presets, activePresetId: preset.id };
  presetCreateForm.style.display = "none";
  renderPresetSelect();
  renderActivePresetChips();
}

presetDeleteBtn.addEventListener("click", () => void deleteActivePreset());

async function deleteActivePreset(): Promise<void> {
  const { presets, activePresetId } = await deletePreset(
    presetsState.presets,
    presetsState.activePresetId,
    presetsState.activePresetId,
  );
  presetsState = { presets, activePresetId };
  renderPresetSelect();
  renderActivePresetChips();
}

function setCreateStatus(msg: string, kind: "ok" | "err" | ""): void {
  presetCreateStatusEl.textContent = msg;
  presetCreateStatusEl.className = `status${kind ? ` ${kind}` : ""}`;
  presetCreateStatusEl.style.display = msg ? "block" : "none";
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

// =============================================================================
// Dev mode — practice test session inspector
// Only active when built with `pnpm build:dev` (STATSHELPR_DEV = true).
// esbuild eliminates the entire block in production builds (STATSHELPR_DEV =
// false at compile time → if(false) → tree-shaken). The HTML section is
// hidden by default via CSS; we show it here only in dev builds.
// =============================================================================

if (STATSHELPR_DEV) {
  // Reveal the dev panel (hidden by default in popup.html so it's invisible
  // even if somehow loaded in a production context).
  const devDetailsEl = document.getElementById("dev-details") as HTMLDetailsElement | null;
  if (devDetailsEl) devDetailsEl.style.display = "";

  const devToggle = document.getElementById("dev-mode-toggle") as HTMLInputElement | null;
  const devBadge = document.getElementById("dev-badge") as HTMLSpanElement | null;
  const devLogEl = document.getElementById("dev-session-log") as HTMLDivElement | null;
  const devEmptyEl = document.getElementById("dev-empty") as HTMLDivElement | null;
  const devExportBtn = document.getElementById("dev-export-btn") as HTMLButtonElement | null;
  const devClearBtn = document.getElementById("dev-clear-btn") as HTMLButtonElement | null;

  function renderDevEntry(entry: DevEntry): HTMLDivElement {
    const isErr = Boolean(entry.error);
    const el = document.createElement("div");
    el.className = "dev-entry" + (isErr ? " dev-err" : "");

    const modeIcon = isErr ? "❌" : entry.mode === "calc" ? "📊" : "💡";
    const stem = entry.questionText.slice(0, 60).replace(/\n/g, " ");
    const confClass = entry.lowConfidence ? " low" : "";
    const confLabel = entry.confidence ? `<span class="dev-entry-conf${confClass}">${entry.confidence}</span>` : "";

    const timeStr = new Date(entry.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

    const answerLine = isErr
      ? `<div class="dev-entry-answer">Error: ${entry.error?.slice(0, 120) ?? "unknown"}</div>`
      : `<div class="dev-entry-answer">${entry.answer.slice(0, 120)}${confLabel}</div>`;

    const rcodeLine = entry.rCode
      ? `<pre class="dev-entry-rcode">${entry.rCode.slice(0, 600)}</pre>`
      : "";

    el.innerHTML = [
      `<div class="dev-entry-head">`,
      `  <span class="dev-entry-mode">${modeIcon}</span>`,
      `  <span class="dev-entry-stem" title="${stem}">${stem}…</span>`,
      `  <span class="dev-entry-ms">${entry.latencyMs}ms &middot; ${timeStr}</span>`,
      `</div>`,
      answerLine,
      rcodeLine,
    ].join("");

    return el;
  }

  async function refreshDevLog(): Promise<void> {
    if (!devLogEl || !devEmptyEl || !devExportBtn || !devClearBtn) return;
    const { getDevLog } = await import("./dev-logger");
    const log = await getDevLog();
    devLogEl.innerHTML = "";
    if (log.length === 0) {
      devEmptyEl.style.display = "";
      devExportBtn.disabled = true;
      devClearBtn.disabled = true;
    } else {
      devEmptyEl.style.display = "none";
      log.forEach((entry) => devLogEl.appendChild(renderDevEntry(entry)));
      devExportBtn.disabled = false;
      devClearBtn.disabled = false;
    }
  }

  async function syncDevToggle(): Promise<void> {
    if (!devToggle || !devBadge) return;
    const { isDevModeActive } = await import("./dev-logger");
    const active = await isDevModeActive();
    devToggle.checked = active;
    devBadge.textContent = active ? "on" : "off";
    devBadge.classList.toggle("active", active);
  }

  void syncDevToggle();
  void refreshDevLog();

  if (devToggle) {
    devToggle.addEventListener("change", async () => {
      const { toggleDevMode } = await import("./dev-logger");
      const next = await toggleDevMode();
      if (devBadge) {
        devBadge.textContent = next ? "on" : "off";
        devBadge.classList.toggle("active", next);
      }
      await refreshDevLog();
    });
  }

  if (devExportBtn) {
    devExportBtn.addEventListener("click", async () => {
      const { getDevLog, exportDevLog } = await import("./dev-logger");
      const log = await getDevLog();
      exportDevLog(log);
    });
  }

  if (devClearBtn) {
    devClearBtn.addEventListener("click", async () => {
      const { clearDevLog } = await import("./dev-logger");
      await clearDevLog();
      await refreshDevLog();
    });
  }

  if (devDetailsEl) {
    devDetailsEl.addEventListener("toggle", () => {
      if (devDetailsEl.open) void refreshDevLog();
    });
  }
}
