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
 */

import { WebR, type WebRError } from "@r-wasm/webr";

/** Packages preloaded (installed + attached) so generated R code can call
 * their functions directly without its own library() calls — mirrors how
 * the old server-side sandbox environment was pre-sourced. */
const PACKAGES = [
  "tidyverse",
  "mosaic",
  "moderndive",
  "infer",
  "broom",
  "ggplot2",
  "openssl",
  "base64enc",
];

let webRPromise: Promise<WebR> | null = null;

/** Internal: lazily create + boot the shared WebR instance. Only ever
 * called once — subsequent callers all await the same promise. */
function getWebR(): Promise<WebR> {
  if (!webRPromise) {
    webRPromise = bootWebR();
  }
  return webRPromise;
}

async function bootWebR(): Promise<WebR> {
  const webR = new WebR({
    baseUrl: chrome.runtime.getURL("webr/"),
  });
  await webR.init();

  // Install then attach every package we need so R code can reference their
  // functions (e.g. %>%, gf_histogram, prop_test) without an explicit
  // library() call.
  await webR.installPackages(PACKAGES, true);
  for (const pkg of PACKAGES) {
    await webR.evalRVoid(`suppressMessages(suppressWarnings(library(${pkg})))`);
  }

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
