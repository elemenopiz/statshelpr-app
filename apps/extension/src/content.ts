/**
 * Canvas content script — tiny inline "solve" button next to each question.
 *
 * Flow on click:
 *   1. Set button to spinner (visual "thinking" feedback)
 *   2. Scrape question text + answer choices + any images
 *   3. POST /api/solve (SSE) — a single round trip. The server runs the
 *      whole pipeline itself (LLM, then for calc questions R on a Cloud Run
 *      service, then an LLM interpret pass) and streams back one terminal
 *      "concept" or "calc" result — see onSolve() for the full parse.
 *   4. Parse the answer letter, find the matching radio/checkbox, click it
 *   5. Set button to ✓ briefly, then back to "solve" (re-clickable) — or, if
 *      nothing in the page could actually be written to, a "?" instead, with
 *      the answer itself in the hover title.
 *
 * No answer card, no explanation, no R code display, and no code execution
 * of any kind in this content script — calc questions now run their R
 * server-side (see docs/cloud-run-r-migration.md) and arrive as a plain
 * finished answer, identical in shape to a concept result.
 *
 * A small floating CSV widget in the bottom-right manages course-wide data
 * files, persisted in chrome.storage.local across sessions.
 *
 * DOM scraping and write-back (reading the question, clicking/filling the
 * answer into the page) live in ./canvas-dom, which is chrome-free — this
 * file is boot, button injection/state, the solve flow + SSE plumbing, and
 * storage.
 */

import { getInstallId } from "./install-id";
import {
  type BlankAnswer,
  type ScrapedQuestion,
  choiceTypeForApi,
  findStem,
  scrapeQuestion,
  selectAnswerChoice,
  writeBlanks,
} from "./canvas-dom";
import { type QuestionType, buildTelemetryBody, deriveOutcome, deriveQuestionType } from "./telemetry";

interface DataFile {
  filename: string;
  content: string;
  size: number;
  addedAt: number;
}

// =============================================================================
// /api/solve streams Server-Sent Events. "phase" and "delta" events exist for
// a richer streaming UI; the inline button UX here doesn't render them (no
// panel to update) so they're consumed and ignored — only the terminal
// "result"/"error" event matters to onSolve. On a calc question, "phase"
// events double as heartbeats while the server runs R remotely and
// interprets its output (see SSE_IDLE_TIMEOUT_MS below) — still nothing this
// UI renders, just keep-alive so the idle watchdog doesn't fire mid-solve.
// =============================================================================

interface ConceptResult {
  mode: "concept";
  answer: string;
  selectedChoices?: string[];
  /** Present for matching / multiple-dropdowns questions — one entry per blank,
   * written back into its own <select>. */
  blanks?: BlankAnswer[];
  confidence: "High" | "Med" | "Low" | "";
  lowConfidence: boolean;
}

/** Final answer for a calc question. The server ran the R itself (Cloud Run)
 * and interpreted its output into an answer before ever responding — the
 * rCode/rOutput/rExitCode/rDurationMs fields are metadata about that server-
 * side run, carried along for potential future display, not something this
 * client acts on or executes. */
interface CalcResult {
  mode: "calc";
  rCode: string;
  rOutput: string;
  rExitCode: number;
  rDurationMs: number;
  answer: string;
  selectedChoices?: string[];
  blanks?: BlankAnswer[];
  confidence: "High" | "Med" | "Low" | "";
  lowConfidence: boolean;
}

type SolveResult = ConceptResult | CalcResult;

type SseEvent =
  | { type: "phase"; label: string }
  | { type: "delta"; text: string }
  | { type: "result"; result: SolveResult }
  | { type: "error"; message: string };

const FIRST_HINT_KEY = "statshelpr.firstHintShown";

const SELECTORS_QUESTION = [
  ".question_holder",
  ".display_question",
  "[data-testid='question-container']",
  "[data-testid='quiz-question']",
  ".question-container",
  ".QuestionItem",
  ".item-body",
];

// Where to place the tiny button relative to the question. We try these in
// order — first match wins. Fall back to prepending into the question container.
const SELECTORS_HEADER = [
  ".question_name",                  // Classic Quizzes — the "Question 1" span
  ".header .question_name",
  ".question .header",
  "[data-testid='question-number']", // New Quizzes (guess)
  "[data-testid='question-header']",
];

const QUESTION_SELECTOR = SELECTORS_QUESTION.join(",");

const STORAGE_KEY_FILES = "statshelpr.files";
const FILE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Local mirror of the server's 24h rolling solve counter so the popup can
 * show "n of 5 left today" without an extra endpoint. Server stays the
 * authority — on a 402 we sync to its resetAt. */
const STORAGE_KEY_SOLVE_STATS = "statshelpr.solveStats";
const FREE_DAILY_LIMIT = 5;
const SOLVE_WINDOW_MS = 24 * 60 * 60 * 1000;

interface SolveStats {
  count: number;
  resetAt: number;
}

let dataFiles: DataFile[] = [];

// =============================================================================
// boot
// =============================================================================

function boot() {
  void loadFiles().then(() => scanAndInject());

  // Load user's button-opacity preference and apply it as a CSS variable
  // (--sh-idle-opacity) that panel.css reads. The variable is set on the
  // document root so it applies to every injected button, and re-applied
  // whenever the user drags the popup slider.
  void applyButtonOpacityFromStorage();

  // Re-load CSVs (and re-apply opacity) whenever the popup updates them so
  // freshly-uploaded files / settings changes are picked up without reload.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STORAGE_KEY_FILES]) {
      void loadFiles();
    }
    if (area === "sync" && changes["buttonOpacity"]) {
      const next = changes["buttonOpacity"].newValue;
      if (typeof next === "number") applyButtonOpacity(next);
    }
  });

  const observer = new MutationObserver(() => scanAndInject());
  observer.observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}

// =============================================================================
// per-question button injection
// =============================================================================

let pendingScan = false;
function scanAndInject() {
  if (pendingScan) return;
  pendingScan = true;
  setTimeout(() => {
    pendingScan = false;
    for (const sel of SELECTORS_QUESTION) {
      document.querySelectorAll<HTMLElement>(sel).forEach(injectButtonFor);
    }
  }, 100);
}

function injectButtonFor(question: HTMLElement) {
  if (question.dataset["statshelprAttached"] === "1") return;
  if (hasQuestionAncestor(question)) return;
  if (!findStem(question)) return;

  const btn = mkEl("button", {
    className: "statshelpr-btn-tutor",
    type: "button",
    text: "·",
    title: "",
  });
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    void onSolve(question, btn);
  });

  const anchor = findHeader(question);
  if (anchor) {
    // Inline next to "Question 1" — append after the header text node
    anchor.appendChild(document.createTextNode(" "));
    anchor.appendChild(btn);
  } else {
    // Fallback: small wrapper at top of question container
    const wrap = mkEl("div", { className: "statshelpr-tutor-wrap" });
    wrap.appendChild(btn);
    question.insertBefore(wrap, question.firstChild);
  }

  question.dataset["statshelprAttached"] = "1";
}

function findHeader(question: HTMLElement): HTMLElement | null {
  for (const sel of SELECTORS_HEADER) {
    const el = question.querySelector<HTMLElement>(sel);
    if (el) return el;
  }
  return null;
}

function hasQuestionAncestor(question: HTMLElement): boolean {
  const ancestor = question.parentElement?.closest<HTMLElement>(QUESTION_SELECTOR);
  return Boolean(ancestor && findStem(ancestor));
}

// =============================================================================
// solve flow
// =============================================================================
//
// /api/solve always streams SSE down to exactly one terminal result: mode
// "concept" or mode "calc". Both are done the instant they arrive — for
// calc, the server has already run the R (on Cloud Run) and interpreted its
// output into an answer, so there's nothing left for the client to do but
// render/write it back, same as concept.

/** No SSE activity — not even the initial connection — for this long aborts
 * the request. Neither fetch() nor a stalled ReadableStream reject on their
 * own when a connection dies silently (dead proxy, hung server), so without
 * this the button spins forever. Generous vs. the 4-6s timeout used
 * elsewhere (activate.ts, popup.ts) for quick non-streaming calls, since a
 * legitimate solve keeps emitting phase/delta events throughout a slow model
 * response — see solve/route.ts's write() calls. That includes calc
 * questions: the server emits a "phase" heartbeat at least every 10s while
 * the remote R run and any repair/interpret passes are in flight, so this
 * stays comfortably above the real gap between events even on a slow calc
 * solve. */
const SSE_IDLE_TIMEOUT_MS = 30_000;

/** Idle/connect watchdog for a streamed fetch: call the returned `poke()` on
 * every sign of life (it's called once immediately, covering the initial
 * connect, and again by consumeSseResult on every chunk). If `poke()` isn't
 * called again within `ms`, aborts `ctrl`. */
function armIdleAbort(ctrl: AbortController, ms: number) {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const poke = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, ms);
  };
  poke();
  return {
    poke,
    clear: () => {
      if (timer) clearTimeout(timer);
    },
    get timedOut() {
      return timedOut;
    },
  };
}

async function onSolve(question: HTMLElement, btn: HTMLButtonElement) {
  if (btn.disabled) return;
  // Wall-clock start for the telemetry beacon's clientLatencyMs — captured
  // here (solve click) so it includes the full round trip through to a
  // written/nowrite/error result below.
  const solveStartedAt = performance.now();
  setBtnState(btn, "loading");
  // Clear any prior visual marker on this question
  question.querySelectorAll(".statshelpr-suggested").forEach((el) =>
    el.classList.remove("statshelpr-suggested"),
  );

  // Refresh CSVs from storage in case the popup uploaded a file while we
  // were already on the Canvas page. Guarded because a long-lived tab whose
  // extension auto-updated mid-session throws "Extension context
  // invalidated" here — left unguarded, that throw was unhandled and the
  // button never left its loading spinner.
  try {
    await loadFiles();
  } catch (e) {
    setBtnState(btn, "error", (e as Error).message);
    return;
  }

  let scraped: ScrapedQuestion;
  try {
    scraped = await scrapeQuestion(question);
  } catch (e) {
    setBtnState(btn, "error", (e as Error).message);
    return;
  }

  let cfg: Awaited<ReturnType<typeof getConfig>>;
  let installId: string;
  try {
    cfg = await getConfig();
    installId = await getInstallId();
  } catch (e) {
    setBtnState(btn, "error", (e as Error).message);
    return;
  }
  const apiUrl = (cfg.apiUrl ?? "https://api.statshelpr.com").replace(/\/$/, "");
  const licenseKey = cfg.licenseKey ?? "";
  // Sent with /api/solve below — the install id lets the server bucket the
  // free-tier rate limit per install (see install-id.ts).
  const headers: HeadersInit = {
    "Content-Type": "application/json",
    "X-Install-Id": installId,
    ...(licenseKey ? { Authorization: `Bearer ${licenseKey}` } : {}),
  };
  const apiChoices = scraped.choices.map((c) => ({
    label: c.label,
    text: c.text,
    type: choiceTypeForApi(c),
  }));
  const apiBlanks = scraped.blanks.map((b) => ({
    key: b.key,
    label: b.label,
    options: b.options.map((o) => o.text),
  }));
  const apiDataFiles = dataFiles.map((f) => ({ filename: f.filename, content: f.content }));

  const solveCtrl = new AbortController();
  const solveIdle = armIdleAbort(solveCtrl, SSE_IDLE_TIMEOUT_MS);

  let final: ConceptResult | CalcResult;
  try {
    const solveRes = await fetch(`${apiUrl}/api/solve`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        questionText: scraped.text,
        choices: apiChoices,
        ...(apiBlanks.length ? { blanks: apiBlanks } : {}),
        images: scraped.images,
        dataFiles: apiDataFiles,
      }),
      signal: solveCtrl.signal,
    });
    if (!solveRes.ok) {
      const bodyText = await solveRes.text();
      if (solveRes.status === 402) {
        // Daily limit — sync the local counter to the server's window.
        let resetAt: number | undefined;
        try {
          resetAt = (JSON.parse(bodyText) as { resetAt?: number }).resetAt;
        } catch {
          /* body wasn't JSON — keep our own resetAt */
        }
        void recordSolveLimitHit(resetAt);
      } else if (solveRes.status === 403) {
        // Single-device license limit — same flag activate.ts sets on a
        // blocked activation, so the popup's reset flow shows up either way.
        let atLimit = false;
        try {
          atLimit = (JSON.parse(bodyText) as { atLimit?: boolean }).atLimit === true;
        } catch {
          /* body wasn't JSON */
        }
        if (atLimit) void recordActivationBlocked();
      }
      throw new Error(extractErrorMsg(bodyText));
    }
    // Passed the rate limiter — the server counted this solve, mirror it.
    void recordSolveUse();
    // A solve went through, so this device holds the activation — clear any
    // stale device-limit flag so the popup stops showing the reset prompt once
    // the user has reset onto this device.
    void clearActivationBlocked();
    const solveResult = await consumeSseResult(solveRes, solveIdle.poke);

    // Both live modes are already a finished answer — a calc result arrives
    // with its R already run and interpreted server-side, identical in shape
    // (from this client's perspective) to a concept result. Anything else is
    // a contract break with the server and should surface as a hard error
    // rather than silently doing nothing.
    if (solveResult.mode === "concept" || solveResult.mode === "calc") {
      final = solveResult;
    } else {
      throw new Error("Unexpected response from solve.");
    }
  } catch (e) {
    const message = solveIdle.timedOut
      ? `No response for ${SSE_IDLE_TIMEOUT_MS / 1000}s — check your connection and try again.`
      : (e as Error).message;
    setBtnState(btn, "error", message);
    return;
  } finally {
    solveIdle.clear();
  }

  const cleaned = stripTags(final.answer);

  // Fields shared by every telemetry beacon fired below — built once `final`
  // is known so each call site only supplies what varies (writeCount/threw).
  const telemetryBase = {
    apiUrl,
    installId,
    telemetryDisabled: cfg.telemetryDisabled === true,
    mode: final.mode,
    confidence: final.confidence,
    questionType: deriveQuestionType(scraped),
    startedAt: solveStartedAt,
  };

  // Matching / multiple-dropdowns: write each blank into its own <select>.
  // Otherwise select/fill from the flat choice list. Both report back how
  // many elements they actually touched, so a total miss (writeCount === 0)
  // can be surfaced distinctly from a real success below.
  let writeCount: number;
  try {
    writeCount =
      final.blanks && final.blanks.length > 0 && scraped.blanks.length > 0
        ? writeBlanks(question, final.blanks)
        : selectAnswerChoice(question, cleaned, final.selectedChoices ?? [], scraped.choices);
  } catch (e) {
    // A result came back but the write-back call itself threw. This catch
    // exists ONLY to report that fact to telemetry — it deliberately
    // rethrows immediately after so control flow (today: an uncaught
    // rejection, since onSolve() is invoked as `void onSolve(...)` from the
    // click handler and had no try/catch around this block before) is
    // byte-for-byte unchanged from before this beacon existed.
    fireTelemetryBeacon({ ...telemetryBase, writeCount: 0, threw: true });
    throw e;
  }

  if (writeCount === 0) {
    // Nothing in the page could be auto-selected/filled (e.g. no scrapable
    // inputs, or every matcher missed) — don't claim success. Surface the
    // answer itself via the tooltip so the student can still apply it by hand.
    setBtnState(btn, "nowrite", `Couldn't auto-select — answer: ${cleaned.slice(0, 200)}`);
  } else {
    setBtnState(btn, "success");
  }
  fireTelemetryBeacon({ ...telemetryBase, writeCount, threw: false });
}

/**
 * Fire-and-forget content-free write-back OUTCOME beacon — see the PINNED
 * CONTRACT this shipped under. Never blocks the button state update (callers
 * invoke this AFTER setBtnState), never surfaces an error to the user, and
 * never throws. Skips entirely when the user has opted out via
 * chrome.storage.sync's telemetryDisabled (default/unset = enabled).
 *
 * Question/choice/answer TEXT never reaches this function — only counts,
 * enums, and DOM element kinds (via telemetryBase.questionType, already
 * derived by telemetry.ts's chrome-free deriveQuestionType before this is
 * called) — see telemetry.ts's module doc comment for the full contract.
 */
function fireTelemetryBeacon(args: {
  apiUrl: string;
  installId: string;
  telemetryDisabled: boolean;
  mode: "concept" | "calc";
  confidence: "High" | "Med" | "Low" | "";
  questionType: QuestionType;
  startedAt: number;
  writeCount: number;
  threw: boolean;
}): void {
  if (args.telemetryDisabled) return;

  const body = buildTelemetryBody({
    mode: args.mode,
    questionType: args.questionType,
    confidence: args.confidence,
    outcome: deriveOutcome(args.writeCount, args.threw),
    writeCount: args.writeCount,
    clientLatencyMs: Math.round(performance.now() - args.startedAt),
  });

  void fetch(`${args.apiUrl}/api/telemetry`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Install-Id": args.installId },
    body: JSON.stringify(body),
  }).catch(() => {
    // Fire-and-forget — a 404 (e.g. a local dev API with no telemetry route
    // yet) or any network failure is silently ignored, never surfaced.
  });
}

function extractErrorMsg(body: string): string {
  // Try to extract the {error: "..."} field from a JSON error response
  let msg = body.slice(0, 200);
  try {
    const parsed = JSON.parse(body) as { error?: string };
    if (parsed.error) msg = parsed.error;
  } catch {
    /* not JSON — use raw body */
  }
  return msg;
}

function stripTags(s: string): string {
  return s.replace(/^\s*\[(CONCEPT|RCODE|CALC)\]\s*\n?/i, "").trim();
}

/** Mirror one counted solve into chrome.storage.local for the popup meter.
 * Fire-and-forget: never lets bookkeeping break a solve. */
async function recordSolveUse(): Promise<void> {
  try {
    const r = await chrome.storage.local.get(STORAGE_KEY_SOLVE_STATS);
    const prev = r[STORAGE_KEY_SOLVE_STATS] as SolveStats | undefined;
    const now = Date.now();
    const next: SolveStats =
      !prev || prev.resetAt < now
        ? { count: 1, resetAt: now + SOLVE_WINDOW_MS }
        : { count: prev.count + 1, resetAt: prev.resetAt };
    await chrome.storage.local.set({ [STORAGE_KEY_SOLVE_STATS]: next });
  } catch {
    /* tracking only */
  }
}

/** The server said the daily cap is hit — pin the local mirror to it. */
async function recordSolveLimitHit(resetAt?: number): Promise<void> {
  try {
    const next: SolveStats = {
      count: FREE_DAILY_LIMIT,
      resetAt: resetAt ?? Date.now() + SOLVE_WINDOW_MS,
    };
    await chrome.storage.local.set({ [STORAGE_KEY_SOLVE_STATS]: next });
  } catch {
    /* tracking only */
  }
}

/** The server said this license is active on another device (403 atLimit) —
 * mirror activate.ts's flag so popup.ts's reset flow shows up here too. */
async function recordActivationBlocked(): Promise<void> {
  try {
    await chrome.storage.local.set({ activationBlocked: true });
  } catch {
    /* tracking only */
  }
}

/** A solve succeeded, so this device is the activated one — remove any stale
 * activationBlocked flag (set after a device-limit 403) so popup.ts stops
 * showing the reset prompt once the user has reset onto this device. Only
 * writes when the flag is actually set, so it doesn't churn storage (and fire
 * the popup's onChanged listener) on every ordinary solve. */
async function clearActivationBlocked(): Promise<void> {
  try {
    const r = await chrome.storage.local.get("activationBlocked");
    if (r["activationBlocked"]) await chrome.storage.local.remove("activationBlocked");
  } catch {
    /* tracking only */
  }
}

/**
 * Read an SSE response stream down to its terminal "result" event.
 * "phase"/"delta" events are consumed and ignored — this button-only UI has no
 * panel to stream text into, only the button's spinner/title. `poke` is
 * called on every chunk received so the caller's idle watchdog (see
 * armIdleAbort) knows the connection is still alive.
 */
async function consumeSseResult(res: Response, poke: () => void): Promise<SolveResult> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("Empty response stream.");
  const decoder = new TextDecoder();
  let buf = "";
  let result: SolveResult | null = null;
  let errorMsg: string | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    poke();
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop() ?? "";
    for (const frame of frames) {
      const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) continue;
      const jsonStr = dataLine.slice(5).trim();
      if (!jsonStr) continue;
      let evt: SseEvent;
      try {
        evt = JSON.parse(jsonStr) as SseEvent;
      } catch {
        continue; // malformed frame — skip it
      }
      if (evt.type === "result") result = evt.result;
      else if (evt.type === "error") errorMsg = evt.message;
    }
  }

  if (errorMsg) throw new Error(errorMsg);
  if (!result) throw new Error("No result received from server.");
  return result;
}

type BtnState = "default" | "loading" | "success" | "error" | "nowrite";

function setBtnState(btn: HTMLButtonElement, state: BtnState, msg?: string) {
  btn.classList.remove("loading", "success", "error", "nowrite");
  btn.removeAttribute("title");

  switch (state) {
    case "loading":
      btn.classList.add("loading");
      btn.disabled = true;
      clear(btn);
      btn.appendChild(mkEl("span", { className: "statshelpr-spinner" }));
      return;
    case "success":
      btn.classList.add("success");
      btn.disabled = false;
      btn.textContent = "✓";
      // Revert to default state after a moment so it's re-clickable
      setTimeout(() => {
        if (btn.classList.contains("success")) setBtnState(btn, "default");
      }, 1800);
      return;
    case "error":
      btn.classList.add("error");
      btn.disabled = false;
      btn.textContent = "!";
      btn.setAttribute("title", msg ?? "");
      return;
    case "nowrite":
      // Answer came back but nothing in the page could be auto-written —
      // stays put (no auto-revert) so the student has time to read the
      // answer off the tooltip instead of it vanishing like "success" does.
      btn.classList.add("nowrite");
      btn.disabled = false;
      btn.textContent = "?";
      btn.setAttribute("title", msg ?? "");
      return;
    default:
      btn.disabled = false;
      btn.textContent = "·";
      btn.setAttribute("title", "");
  }
}

// =============================================================================
// storage
// =============================================================================
//
// Data files are managed in the extension popup (drag-drop or file picker) and
// stored in chrome.storage.local. The content script reads them whenever a
// Solve fires, and listens for storage changes so a freshly-uploaded CSV is
// visible without reloading the Canvas tab.

async function loadFiles() {
  const r = await chrome.storage.local.get(STORAGE_KEY_FILES);
  const stored = (r[STORAGE_KEY_FILES] as DataFile[] | undefined) ?? [];
  const now = Date.now();
  dataFiles = stored.filter((f) => now - f.addedAt < FILE_TTL_MS);
}

async function applyButtonOpacityFromStorage(): Promise<void> {
  const r = (await chrome.storage.sync.get(["buttonOpacity"])) as {
    buttonOpacity?: number;
  };
  applyButtonOpacity(typeof r.buttonOpacity === "number" ? r.buttonOpacity : 0.2);
}

function applyButtonOpacity(value: number): void {
  // Clamp to a sane range so a bad stored value can't blow past 1.0 or go
  // negative. Paid users can drag the popup slider to 0 (fully invisible) —
  // gating who's allowed to write a low value is the popup's job, not ours.
  const clamped = Math.min(1, Math.max(0, value));
  document.documentElement.style.setProperty("--sh-idle-opacity", String(clamped));
}

async function getConfig(): Promise<{ apiUrl?: string; licenseKey?: string; telemetryDisabled?: boolean }> {
  const r = await chrome.storage.sync.get(["apiUrl", "licenseKey", "telemetryDisabled"]);
  return r as { apiUrl?: string; licenseKey?: string; telemetryDisabled?: boolean };
}

// =============================================================================
// helpers
// =============================================================================

interface ElOptions {
  className?: string;
  id?: string;
  text?: string;
  title?: string;
  type?: string;
  style?: string;
}

function mkEl<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts: ElOptions = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (opts.className) node.className = opts.className;
  if (opts.id) node.id = opts.id;
  if (opts.title) node.title = opts.title;
  if (opts.style) node.setAttribute("style", opts.style);
  if (opts.type && tag === "button")
    (node as HTMLButtonElement).type = opts.type as HTMLButtonElement["type"];
  if (opts.text !== undefined) node.textContent = opts.text;
  for (const c of children) {
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

function clear(node: HTMLElement) {
  while (node.firstChild) node.removeChild(node.firstChild);
}
