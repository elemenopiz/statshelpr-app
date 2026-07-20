import { cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const WEBR_SRC = path.resolve(root, "node_modules/@r-wasm/webr/dist");
const WEBR_DEST = path.resolve(root, "public/webr");

/**
 * Copy the WebR runtime (JS glue + .wasm + .data, ~60MB) from
 * node_modules/@r-wasm/webr/dist into public/webr/ so it ends up bundled
 * into dist/ alongside the rest of public/ (see build.mjs) and is
 * reachable at runtime via chrome.runtime.getURL('webr/') — see the
 * bundling-contract comment atop src/webr-runner.ts.
 *
 * Called from two places:
 *   - `postinstall` (this file run directly) — so `pnpm install` alone
 *     leaves public/webr/ populated, even before a first build.
 *   - `scripts/build.mjs` — re-run on every build/watch rebuild so
 *     public/webr/ always matches whatever @r-wasm/webr version is
 *     installed, and so production builds get maps stripped.
 *
 * Exclusions:
 *   - dist/tests/ is always skipped — it's WebR's own test fixtures, not
 *     needed to boot the runtime in the browser.
 *   - `.map` files are skipped when `production` is true — they're only
 *     useful for debugging WebR's internals with source maps attached,
 *     which isn't a workflow this extension supports, and they roughly
 *     double the shipped size of the JS glue files.
 */
export async function copyWebR({ production = false } = {}) {
  if (!existsSync(WEBR_SRC)) {
    throw new Error(
      `WebR dist not found at ${WEBR_SRC} — is @r-wasm/webr installed? Run pnpm install in apps/extension/.`,
    );
  }

  await rm(WEBR_DEST, { recursive: true, force: true });
  await mkdir(WEBR_DEST, { recursive: true });

  await cp(WEBR_SRC, WEBR_DEST, {
    recursive: true,
    force: true,
    filter: (src) => {
      const rel = path.relative(WEBR_SRC, src);
      if (rel === "") return true; // the root dir itself
      if (rel === "tests" || rel.startsWith(`tests${path.sep}`)) return false;
      if (production && rel.endsWith(".map")) return false;
      return true;
    },
  });

  return WEBR_DEST;
}

// Allow running directly (`node scripts/copy-webr.mjs`), e.g. from
// `postinstall`. Not run as production there — build.mjs re-copies with
// production filtering applied at actual build time.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  copyWebR()
    .then((dest) => console.log(`webr → ${dest}`))
    .catch((err) => {
      console.error(`[copy-webr] ${err.message}`);
      process.exit(1);
    });
}
