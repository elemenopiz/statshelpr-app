/**
 * Build the capture extension into dist/. No WebR, no API — just the content
 * script, popup, and static assets.
 *
 * esbuild is resolved leniently: normally from this package's node_modules
 * (after `pnpm install`), but if that's absent (e.g. building inside a fresh
 * git worktree that was never installed) we walk up to the nearest pnpm store.
 * Keeps the tool buildable without a full monorepo install.
 */

import { mkdir, cp, rm, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const out = path.resolve(root, "dist");
const watch = process.argv.includes("--watch");

const esbuild = await loadEsbuild(root);

if (existsSync(out)) await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(path.resolve(root, "public"), out, { recursive: true });
await bakeDatasets();

const buildOpts = {
  entryPoints: {
    "capture-content": path.resolve(root, "src/capture-content.ts"),
    popup: path.resolve(root, "src/popup.ts"),
  },
  bundle: true,
  format: "iife",
  target: "chrome120",
  outdir: out,
  sourcemap: watch ? "inline" : false,
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(buildOpts);
  await ctx.watch();
  console.log("watching…");
} else {
  await esbuild.build(buildOpts);
  console.log(`built → ${out}`);
}

/** Bake datasets/*.csv → dist/datasets.json ({ "scooby.csv": "<csv>" }). The map
 * is served as a web-accessible resource and inlined into fixtures at export.
 * Missing datasets/ (e.g. before convert-rdata is run) → empty map + a warning. */
async function bakeDatasets() {
  const dir = path.resolve(root, "datasets");
  const map = {};
  if (existsSync(dir)) {
    for (const name of (await readdir(dir)).filter((n) => n.endsWith(".csv")).sort()) {
      map[name] = await readFile(path.join(dir, name), "utf8");
    }
  }
  await writeFile(path.join(out, "datasets.json"), JSON.stringify(map));
  const n = Object.keys(map).length;
  if (n === 0) {
    console.warn("⚠ no datasets baked — run `pnpm --filter @statshelpr/extension-capture datasets <file.RData>`");
  } else {
    console.log(`baked ${n} datasets → dist/datasets.json`);
  }
}

/** Resolve esbuild from this package, else from the nearest ancestor pnpm store. */
async function loadEsbuild(from) {
  const require = createRequire(path.join(from, "noop.js"));
  try {
    return await import(require.resolve("esbuild"));
  } catch {
    /* not installed here — search upward */
  }
  let dir = from;
  while (true) {
    const direct = path.join(dir, "node_modules", "esbuild", "lib", "main.js");
    if (existsSync(direct)) return import(direct);
    const pnpm = path.join(dir, "node_modules", ".pnpm");
    if (existsSync(pnpm)) {
      const hit = (await readdir(pnpm)).find((n) => /^esbuild@/.test(n));
      if (hit) {
        const main = path.join(pnpm, hit, "node_modules", "esbuild", "lib", "main.js");
        if (existsSync(main)) return import(main);
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("esbuild not found — run `pnpm install` at the repo root first.");
}
