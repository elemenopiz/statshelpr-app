import { build, context } from "esbuild";
import { mkdir, cp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { copyWebR } from "./copy-webr.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const out = path.resolve(root, "dist");
const watch = process.argv.includes("--watch");

// Refresh public/webr/ from node_modules on every build (and every watch
// rebuild) before sweeping public/ into dist/ below, so the WebR runtime
// (JS glue + .wasm + .data) ships inside the extension bundle and loads
// from chrome.runtime.getURL('webr/') with no remote fetch. See
// src/webr-runner.ts for the runtime side of this contract.
await copyWebR({ production: !watch });

if (existsSync(out)) await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

await cp(path.resolve(root, "public"), out, { recursive: true });

const buildOpts = {
  entryPoints: {
    content: path.resolve(root, "src/content.ts"),
    activate: path.resolve(root, "src/activate.ts"),
    background: path.resolve(root, "src/background.ts"),
    popup: path.resolve(root, "src/popup.ts"),
    welcome: path.resolve(root, "src/welcome.ts"),
  },
  bundle: true,
  format: "iife",
  target: "chrome120",
  outdir: out,
  sourcemap: watch ? "inline" : false,
  logLevel: "info",
};

if (watch) {
  const ctx = await context(buildOpts);
  await ctx.watch();
  console.log("watching…");
} else {
  await build(buildOpts);
  console.log(`built → ${out}`);
}
