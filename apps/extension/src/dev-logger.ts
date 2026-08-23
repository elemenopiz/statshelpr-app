/**
 * Dev Logger — practice-test session capture.
 *
 * Activated only when chrome.storage.local["statshelpr.devMode"] === true.
 * When active every `logSolve()` call:
 *   1. Appends a DevEntry to chrome.storage.local["statshelpr.devLog"]
 *   2. Prints a collapsible console.group with full detail
 *
 * Nothing here runs in the hot path of a production solve — all calls are
 * guarded by `if (!DEV_ACTIVE)` at the call site in content.ts.
 *
 * Popup.ts reads/renders the session via getDevLog(), clearDevLog(), and
 * exportDevLog().
 */

export const DEV_MODE_KEY = "statshelpr.devMode";
const DEV_LOG_KEY = "statshelpr.devLog";

/** One captured solve round-trip. */
export interface DevEntry {
  id: string;             // crypto.randomUUID()
  ts: number;             // Date.now() at solve start
  latencyMs: number;      // wall-clock ms from solve click to result written

  // ── input ──────────────────────────────────────────────────────────────
  questionText: string;
  choices: Array<{ label: string; text: string }>;
  blanks: Array<{ key: string; label: string; options: string[] }>;
  /** base64 data-URLs of any images scraped from the question */
  images: string[];
  /** CSV filenames that were sent with the request */
  dataFilenames: string[];

  // ── output ─────────────────────────────────────────────────────────────
  mode: "concept" | "calc";
  answer: string;
  selectedChoices: string[];
  confidence: string;
  lowConfidence: boolean;

  /** Calc-only fields */
  rCode?: string;
  rOutput?: string;
  rExitCode?: number;
  rDurationMs?: number;
  dataMissing?: boolean;

  writeCount: number;
  error?: string;   // set when the solve failed before a result arrived
}

/** Read the active dev-mode flag. */
export async function isDevModeActive(): Promise<boolean> {
  try {
    const r = await chrome.storage.local.get(DEV_MODE_KEY);
    return r[DEV_MODE_KEY] === true;
  } catch {
    return false;
  }
}

/** Toggle dev mode on/off. Returns the new state. */
export async function toggleDevMode(): Promise<boolean> {
  const current = await isDevModeActive();
  const next = !current;
  await chrome.storage.local.set({ [DEV_MODE_KEY]: next });
  return next;
}

/** Read the full session log (newest-first). */
export async function getDevLog(): Promise<DevEntry[]> {
  try {
    const r = await chrome.storage.local.get(DEV_LOG_KEY);
    return (r[DEV_LOG_KEY] as DevEntry[] | undefined) ?? [];
  } catch {
    return [];
  }
}

/** Clear the session log. */
export async function clearDevLog(): Promise<void> {
  await chrome.storage.local.remove(DEV_LOG_KEY);
}

/** Append one entry and emit a console group. Silently no-ops on error. */
export async function logSolve(entry: DevEntry): Promise<void> {
  try {
    const r = await chrome.storage.local.get(DEV_LOG_KEY);
    const log: DevEntry[] = (r[DEV_LOG_KEY] as DevEntry[] | undefined) ?? [];
    log.unshift(entry); // newest first
    // Cap at 100 entries so storage doesn't grow unbounded across tests
    if (log.length > 100) log.splice(100);
    await chrome.storage.local.set({ [DEV_LOG_KEY]: log });
  } catch {
    /* tracking only — never surface */
  }

  // Console group — only useful when DevTools is open
  try {
    const badge = entry.error ? "❌ FAILED" : entry.mode === "calc" ? "📊 CALC" : "💡 CONCEPT";
    const stem = entry.questionText.slice(0, 80).replace(/\n/g, " ");
    console.groupCollapsed(
      `%c[statshelpr dev] %c${badge}%c ${stem}… %c${entry.latencyMs}ms`,
      "color:#2742C8;font-weight:700",
      entry.error ? "color:#C24029;font-weight:700" : "color:#0B7A4B;font-weight:700",
      "color:inherit",
      "color:#6E6B5F;font-size:11px",
    );

    console.group("📄 Question");
    console.log("Text:", entry.questionText);
    if (entry.choices.length) console.table(entry.choices);
    if (entry.blanks.length) console.log("Blanks:", entry.blanks);
    if (entry.images.length) {
      console.log(`Images (${entry.images.length}):`);
      entry.images.forEach((src, i) => {
        console.log(`  [${i}]`, src.slice(0, 80) + "…");
      });
    }
    if (entry.dataFilenames.length) console.log("CSV files:", entry.dataFilenames);
    console.groupEnd();

    if (entry.error) {
      console.group("❌ Error");
      console.error(entry.error);
      console.groupEnd();
    } else {
      console.group("🎯 Answer");
      console.log("Mode:", entry.mode);
      console.log("Answer:", entry.answer);
      console.log("Selected choices:", entry.selectedChoices);
      console.log("Confidence:", entry.confidence, entry.lowConfidence ? "(LOW)" : "");
      console.log("Write count:", entry.writeCount);
      if (entry.dataMissing) console.warn("⚠️ Dataset was missing — answer reasoned, not computed");
      console.groupEnd();

      if (entry.mode === "calc") {
        console.group("💻 R Code");
        console.log(entry.rCode ?? "(none)");
        console.group("Output");
        console.log(entry.rOutput ?? "(none)");
        console.log("Exit code:", entry.rExitCode, "  R duration:", entry.rDurationMs + "ms");
        console.groupEnd();
        console.groupEnd();
      }
    }

    console.group("⏱️ Performance");
    console.log("Latency (client wall-clock):", entry.latencyMs + "ms");
    console.log("Timestamp:", new Date(entry.ts).toLocaleTimeString());
    console.groupEnd();

    console.log("📦 Full entry →", entry);

    console.groupEnd(); // outer
  } catch {
    /* DevTools not open or console blocked */
  }
}

/** Trigger a .json download of the full session log in the popup context. */
export function exportDevLog(log: DevEntry[]): void {
  const json = JSON.stringify(log, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `statshelpr-session-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
