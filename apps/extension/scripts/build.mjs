import { build, context } from "esbuild";
import { mkdir, cp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const out = path.resolve(root, "dist");
const watch = process.argv.includes("--watch");
// --dev enables the practice-test Dev Mode panel (captured in the build at
// compile time via esbuild define so production bundles ship ZERO dev code).
const isDev = process.argv.includes("--dev");

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
  // Compile-time constant: esbuild substitutes the literal before bundling so
  // `if (STATSHELPR_DEV)` branches are either kept (dev) or dead-code-
  // eliminated entirely (production). Nothing dev-related ships to CWS.
  define: {
    STATSHELPR_DEV: isDev ? "true" : "false",
    // Compile-time bypass key \u2014 only baked into dev builds. Must match
    // DEV_BYPASS_KEY in wrangler.toml exactly. Empty string in production
    // so the if(STATSHELPR_DEV) guard around it is the only protection
    // needed (esbuild's dead-code elimination removes the whole branch).
    STATSHELPR_DEV_KEY: isDev
      ? "\"statshelpr-dev-founder-bypass-2026\""
      : "\"\"",
  },
  // Syntax-level dead-code elimination for production. Strips all
  // `if (false) { … }` branches (STATSHELPR_DEV blocks) without renaming
  // any identifiers, keeping the bundle readable during debugging.
  // Dev builds skip this so source maps stay intact.
  minifySyntax: !isDev,
};

if (watch) {
  const ctx = await context(buildOpts);
  await ctx.watch();
  console.log("watching…");
} else {
  await build(buildOpts);
  console.log(`built → ${out}`);
}
