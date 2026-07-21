/**
 * WebR eval sidecar — runs R locally via WebR (R compiled to WebAssembly),
 * the SAME engine the production extension uses client-side. It exists so the
 * eval harness can exercise calc questions WITHOUT the Vercel sandbox
 * (@vercel/sandbox), which needs cloud credentials the local rig doesn't have
 * and which production never uses anyway.
 *
 * apps/api/lib/sandbox.ts routes runR() here when R_WEBR_URL is set (see
 * `pnpm eval`); production leaves R_WEBR_URL unset and uses its own path.
 *
 * Boots ONE shared WebR instance, installs the same package bundle as
 * apps/extension/src/packages.ts (UT_BUNDLE) + internal deps, then serves:
 *   POST /runR  { code, files: [{filename, content}] }
 *     -> { stdout, stderr, exitCode, durationMs }
 * Output handling mirrors apps/extension/src/webr-runner.ts exactly.
 *
 * Usage: node scripts/webr-eval-server.cjs [--port 3031]
 * Must run from a cwd where @r-wasm/webr resolves (repo root works).
 */

const http = require("node:http");
const path = require("node:path");

// Resolve @r-wasm/webr (a dep of apps/extension) and its local dist dir, which
// holds webr-worker.js + R.bin.{wasm,data} — WebR in Node needs a filesystem
// baseUrl (it can't fetch the CDN worker through worker_threads).
const webrEntry = require.resolve("@r-wasm/webr", {
  paths: [path.join(__dirname, "..", "apps", "extension"), path.join(__dirname, "..")],
});
const { WebR } = require(webrEntry);
const DIST = path.dirname(webrEntry);

// Same bundle production seeds (apps/extension/src/packages.ts UT_BUNDLE) plus
// the extension's internal deps (webr-runner.ts INFRA). All best-effort.
const UT_BUNDLE = ["tidyverse", "mosaic", "moderndive", "infer", "broom", "ggplot2"];
const INFRA = ["openssl", "base64enc"];

const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]) || Number(process.env.WEBR_PORT) || 3031;

const t0 = Date.now();
const log = (m) => console.log(`[webr +${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

let webR = null;
let queue = Promise.resolve(); // serialize runs — one WebR instance is not concurrent-safe

async function boot() {
  log(`booting WebR from ${DIST}`);
  webR = new WebR({ baseUrl: DIST.endsWith("/") ? DIST : DIST + "/" });
  await webR.init();
  log("init done — installing packages (one-time, best-effort)");
  for (const pkg of [...INFRA, ...UT_BUNDLE]) {
    const s = Date.now();
    try {
      await webR.installPackages([pkg], true);
      await webR.evalRVoid(`suppressMessages(suppressWarnings(library(${pkg})))`);
      log(`  ✓ ${pkg} (${((Date.now() - s) / 1000).toFixed(1)}s)`);
    } catch (e) {
      log(`  ✗ ${pkg}: ${(e && e.message) || "install failed"} (best-effort, continuing)`);
    }
  }
  await webR.evalRVoid('setwd("/")'); // data files are written to FS root
  log("READY");
}

/** Mirror of apps/extension/src/webr-runner.ts formatCaptureOutput. */
function formatCaptureOutput(output) {
  const stdoutLines = [];
  const stderrLines = [];
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
        const data = item.data;
        const msg = typeof data === "string" ? data : (data && data.message) || "";
        if (msg) stderrLines.push(`${item.type}: ${msg}`);
        break;
      }
      default:
        break;
    }
  }
  return { stdout: stdoutLines.join("\n"), stderr: stderrLines.join("\n") };
}

/** Mirror of apps/extension/src/webr-runner.ts runR. */
async function runR(code, files) {
  const start = Date.now();
  const shelter = await new webR.Shelter();
  try {
    for (const f of files || []) {
      await webR.FS.writeFile(`/${f.filename}`, new TextEncoder().encode(f.content));
    }
    const { output } = await shelter.captureR(code, {
      captureStreams: true,
      captureConditions: true,
      withAutoprint: false,
      throwJsException: false,
    });
    const { stdout, stderr } = formatCaptureOutput(output);
    // WebR-in-Node reports error conditions with an empty `data` object, so the
    // message never reaches stderr above. Detect the error and recover its text
    // from R's last-error state, returning exitCode 1 so /api/solve's repair
    // loop kicks in — matching production's browser WebR, which surfaces the
    // message directly and lets the model fix (e.g. add a missing read.csv).
    const hadError = output.some((o) => o.type === "error");
    const durationMs = Date.now() - start;
    if (hadError) {
      let errText = stderr.trim();
      if (!errText) {
        try {
          errText = (await webR.evalRString("geterrmessage()")).trim();
        } catch {
          errText = "R error";
        }
      }
      const combined = [stdout.trim(), errText].filter(Boolean).join("\n");
      return { stdout: combined || "R error", stderr: errText, exitCode: 1, durationMs };
    }
    if (stdout.trim()) return { stdout, stderr, exitCode: 0, durationMs };
    if (stderr.trim()) return { stdout: stderr, stderr, exitCode: 1, durationMs };
    return { stdout: "", stderr: "", exitCode: 0, durationMs };
  } catch (e) {
    return { stdout: (e && e.message) || "R execution failed.", stderr: "", exitCode: 1, durationMs: Date.now() - start };
  } finally {
    await shelter.purge();
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(webR ? 200 : 503).end(webR ? "ready" : "booting");
    return;
  }
  if (req.method !== "POST" || req.url !== "/runR") {
    res.writeHead(404).end("not found");
    return;
  }
  try {
    const { code, files } = JSON.parse(await readBody(req));
    // Serialize: chain onto the queue so only one runR touches WebR at a time.
    const result = await (queue = queue.then(() => runR(code, files)).catch((e) => ({
      stdout: (e && e.message) || "sidecar error",
      stderr: "",
      exitCode: 1,
      durationMs: 0,
    })));
    const head = (result.stdout || "").replace(/\s+/g, " ").slice(0, 60);
    log(`runR exit=${result.exitCode} ${result.durationMs}ms files=[${(files || []).map((f) => f.filename).join(",")}] → ${head}`);
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
  } catch (e) {
    res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: String(e && e.message) }));
  }
});

boot()
  .then(() => server.listen(port, () => log(`listening on http://localhost:${port} (POST /runR)`)))
  .catch((e) => {
    log("FATAL boot error: " + (e && e.message));
    process.exit(1);
  });
