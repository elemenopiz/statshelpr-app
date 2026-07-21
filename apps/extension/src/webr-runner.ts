/**
 * WebR (R compiled to WebAssembly) runner — executes R code client-side
 * inside the Chrome extension instead of a server-side sandbox.
 *
 * Flow:
 *   1. `initWebR()` boots a single shared WebR instance (lazy, cached, safe
 *      to call many times — every caller awaits the same boot promise).
 *   2. `runR(code, dataFiles)` writes any CSV data files into WebR's virtual
 *      filesystem, evaluates the R code with output capture, and returns
 *      stdout/exitCode/timing for the caller to POST to /api/interpret.
 *
 * Asset bundling note (see apps/extension/scripts/build.mjs): the WebR
 * runtime (JS glue + .wasm + .data, ~65MB) is copied from
 * node_modules/@r-wasm/webr/dist into public/webr/ as part of `pnpm build`,
 * then copied verbatim into dist/ alongside the rest of public/. We point
 * WebR at chrome.runtime.getURL('webr/') instead of its default CDN
 * (webr.r-wasm.org) so booting the runtime never requires a cross-origin
 * fetch — everything loads from chrome-extension://<id>/webr/, which keeps
 * things working under the extension_pages CSP
 * (script-src 'self' 'wasm-unsafe-eval') added to manifest.json.
 *
 * R package binaries (tidyverse, mosaic, etc.) are NOT vendored the same
 * way — WebR still downloads those on demand from its default package repo
 * (repo.r-wasm.org) via installPackages(). That's a separate, larger effort
 * (vendoring an R package repo) that's out of scope here; if that repo
 * becomes a CSP/offline concern later, mirror it and pass `repoUrl` in the
 * WebROptions below.
 *
 * Package set at boot = INFRA (small internal-only list, e.g.
 * openssl/base64enc — fatal if it fails to install) + the user's library
 * list (fully editable in the popup's "R libraries" section, persisted to
 * chrome.storage.sync under `extraPackages`; defaults to UT_BUNDLE from
 * ./packages when that storage key is empty/unset). Every package in the
 * library list is installed best-effort — a bad or removed package never
 * aborts boot, only INFRA failures do — see bootWebR() below.
 */

import { WebR, type WebRError } from "@r-wasm/webr";
import { UT_BUNDLE } from "./packages";

/** Packages the extension itself depends on internally (not shown in the
 * popup's "R libraries" section, not user-configurable) — always loaded
 * alongside the user's library list. A failure here is a real boot error,
 * same as this whole list was treated before user-editable libraries
 * existed. */
const INFRA = ["openssl", "base64enc"];

/** chrome.storage.sync key for the user's full, freely-editable library
 * list, edited in the popup's "R libraries" section — see popup.ts. The key
 * name is a historical holdover from when it only held additions on top of
 * a fixed core; it now holds the complete list. */
const STORAGE_KEY_EXTRA_PACKAGES = "extraPackages";

/** chrome.storage.local key we mirror extra-package failures to, so the
 * popup (a separate execution context that never imports this module) can
 * read which of the user's extras failed to load. */
const STORAGE_KEY_PACKAGE_ERRORS = "packageErrors";

/** One user-added package that failed to install/attach during boot. */
export interface PackageError {
  pkg: string;
  message: string;
}

let webRPromise: Promise<WebR> | null = null;

/** Internal: lazily create + boot the shared WebR instance. Only ever
 * called once — subsequent callers all await the same promise. */
function getWebR(): Promise<WebR> {
  if (!webRPromise) {
    webRPromise = bootWebR();
  }
  return webRPromise;
}

/** Read the user's full library list (editable in the popup's "R libraries"
 * section) from sync storage. Falls back to UT_BUNDLE if the key is
 * empty/unset — either this content script or the popup could be the first
 * context to ever touch that storage key, and both need to agree on the
 * same default so a user who never opens the popup still gets the default
 * bundle at boot. */
async function getLibraries(): Promise<string[]> {
  const stored = await chrome.storage.sync.get(STORAGE_KEY_EXTRA_PACKAGES);
  const raw = stored[STORAGE_KEY_EXTRA_PACKAGES];
  const libraries = Array.isArray(raw) ? raw.filter((p): p is string => typeof p === "string") : [];
  return libraries.length > 0 ? libraries : UT_BUNDLE;
}

/** Install then attach a single package so R code can reference its
 * functions without an explicit library() call. */
async function installAndAttach(webR: WebR, pkg: string): Promise<void> {
  await webR.installPackages([pkg], true);
  await webR.evalRVoid(`suppressMessages(suppressWarnings(library(${pkg})))`);
}

async function bootWebR(): Promise<WebR> {
  const webR = new WebR({
    baseUrl: chrome.runtime.getURL("webr/"),
  });
  await webR.init();

  // Install then attach our own internal dependencies (INFRA) so R code can
  // rely on them being present. This is a real boot error — failure here
  // means the extension itself can't function, unlike the user's own
  // library list below.
  await webR.installPackages(INFRA, true);
  for (const pkg of INFRA) {
    await webR.evalRVoid(`suppressMessages(suppressWarnings(library(${pkg})))`);
  }

  // The user's library list (editable in the popup's "R libraries" section,
  // defaulting to UT_BUNDLE when storage is empty) is best-effort: WebR's
  // package repo (repo.r-wasm.org) doesn't mirror every CRAN package, users
  // can mistype a name, and — now that the list is fully user-editable —
  // any package including former "defaults" can be removed or broken. One
  // bad package must never abort the whole boot, so each is installed
  // independently and a failure is only logged + recorded, never thrown.
  const packageErrors: PackageError[] = [];
  const libraries = await getLibraries();
  for (const pkg of libraries) {
    try {
      await installAndAttach(webR, pkg);
    } catch (e) {
      const message = (e as WebRError | Error).message ?? "install failed";
      console.warn(`[webr] library "${pkg}" failed to load: ${message}`);
      packageErrors.push({ pkg, message });
    }
  }
  // Mirror to storage so the popup — a separate execution context that
  // never shares this module's state — can surface which libraries failed.
  await chrome.storage.local.set({ [STORAGE_KEY_PACKAGE_ERRORS]: packageErrors });

  // Data files are written to the FS root (see runR below). Set the working
  // directory to match so R code that does read.csv("file.csv") with a bare
  // relative filename resolves against the same place we wrote it.
  await webR.evalRVoid('setwd("/")');

  return webR;
}

/**
 * Boot WebR (if not already booted/booting) and wait for it to be ready.
 * Safe to call many times — returns the same cached promise. Callers don't
 * need to call this explicitly before runR(); runR() calls it internally.
 * It's exposed separately so content.ts can trigger the (slow, ~15s first
 * time) boot early and update the UI status while it happens.
 */
export function initWebR(): Promise<void> {
  return getWebR().then(() => undefined);
}

export interface RunRResult {
  stdout: string;
  exitCode: number;
  durationMs: number;
}

interface DataFileInput {
  filename: string;
  content: string;
}

/** Shape of each entry in Shelter.captureR()'s `output` array at runtime. */
interface CaptureOutputItem {
  type: "stdout" | "stderr" | "message" | "warning" | "error" | string;
  data: string | { message?: string; call?: unknown } | unknown;
}

/**
 * Run R code inside WebR and capture its output.
 *
 * - Writes each data file to WebR's virtual FS at `/<filename>` before
 *   evaluating the code.
 * - Captures stdout/stderr (and R conditions — messages/warnings/errors)
 *   via a fresh Shelter, so R objects created during the run don't leak
 *   between solves. The shelter is purged after every run, win or lose.
 * - Returns stdout if it has content; falls back to stderr with
 *   exitCode=1 if stdout is empty but stderr/conditions were produced.
 */
export async function runR(code: string, dataFiles: DataFileInput[]): Promise<RunRResult> {
  const start = performance.now();
  const webR = await getWebR();
  const shelter = await new webR.Shelter();

  try {
    for (const f of dataFiles) {
      const bytes = new TextEncoder().encode(f.content);
      await webR.FS.writeFile(`/${f.filename}`, bytes);
    }

    const { output } = await shelter.captureR(code, {
      captureStreams: true,
      captureConditions: true,
      withAutoprint: false,
      // Don't let R errors throw a JS exception — we want the error message
      // captured as stderr (with exitCode=1) so the caller can still POST
      // it to /api/interpret for the model to reason about, same as the old
      // sandbox's non-zero-exit-code behavior.
      throwJsException: false,
    });

    const { stdout, stderr } = formatCaptureOutput(output as CaptureOutputItem[]);
    const durationMs = performance.now() - start;

    if (stdout.trim()) {
      return { stdout, exitCode: 0, durationMs };
    }
    if (stderr.trim()) {
      return { stdout: stderr, exitCode: 1, durationMs };
    }
    return { stdout: "", exitCode: 0, durationMs };
  } catch (e) {
    const durationMs = performance.now() - start;
    const message = (e as WebRError | Error).message ?? "R execution failed.";
    return { stdout: message, exitCode: 1, durationMs };
  } finally {
    await shelter.purge();
  }
}

function formatCaptureOutput(output: CaptureOutputItem[]): { stdout: string; stderr: string } {
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];

  for (const item of output) {
    switch (item.type) {
      case "stdout":
        stdoutLines.push(String(item.data));
        break;
      case "stderr":
        stderrLines.push(String(item.data));
        break;
      case "message":
      case "warning":
      case "error": {
        const data = item.data as { message?: string } | string | undefined;
        const msg = typeof data === "string" ? data : data?.message ?? "";
        if (msg) stderrLines.push(`${item.type}: ${msg}`);
        break;
      }
      default:
        break;
    }
  }

  return { stdout: stdoutLines.join("\n"), stderr: stderrLines.join("\n") };
}
