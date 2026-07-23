/**
 * R library catalog + defaults, shared between the popup picker (popup.ts) and
 * the solve request (content.ts). No imports of its own — esbuild bundles each
 * entry point independently (see scripts/build.mjs), so this stays a tiny
 * constants module that both bundles inline.
 *
 * Background: before the Cloud Run migration, WebR ran R *in the browser* and
 * this list drove webr.installPackages(). Now R runs server-side with a fixed,
 * pre-baked image (r-runner/Dockerfile), so the picker no longer installs
 * anything — instead the user's selection is POSTed with /api/solve and steers
 * which packages the tutor's generated R code reaches for (see the server's
 * buildSystemPrompt rPackages option). A selected package only actually runs if
 * it is pre-installed on the runner, hence INSTALLED_CATALOG below.
 */

/** chrome.storage.sync key holding the user's chosen R package list (string[]).
 *  Unset (never opened the picker) is treated as DEFAULT_R_PACKAGES; an empty
 *  array is a deliberate "base R only" choice and is respected as-is. */
export const RPKG_STORAGE_KEY = "statshelpr.rPackages";

/** Removable presets seeded on first use — the intro-stats core (the initial
 *  UT Austin market). A user at another course can clear these and pick their
 *  own. Kept to packages that are genuinely central so the tutor's default
 *  behavior matches the server's historical "prioritize tidyverse, mosaic,
 *  moderndive" prompt directive. */
export const DEFAULT_R_PACKAGES: readonly string[] = [
  "tidyverse",
  "mosaic",
  "moderndive",
];

/** Packages that are actually installed on the runner, so the picker doesn't
 *  false-warn ("may not run") when one is typed. The intro-stats core plus the
 *  few adjacent packages that ship in the rocker/tidyverse base image and are
 *  common enough that a student might reference them. NOT an exhaustive list of
 *  the base image (it has hundreds) — just the ones worth recognizing. KEEP the
 *  Dockerfile-installed entries IN SYNC with r-runner/Dockerfile's install
 *  vector. Used only for the dashed flag; it never blocks adding a package. */
export const INSTALLED_CATALOG: readonly string[] = [
  // ships in the rocker/tidyverse base image
  "tidyverse",
  "ggplot2",
  "broom",
  // installed on top by r-runner/Dockerfile
  "mosaic",
  "moderndive",
  "infer",
];

/** Cap on how many packages we'll store/send — a sane bound so the list can't
 *  bloat the solve payload or the system prompt. */
export const MAX_R_PACKAGES = 40;

/** True when `name` is a syntactically plausible R package name. R package
 *  names are case-sensitive and are letters/digits/dots starting with a letter
 *  (CRAN policy also forbids a trailing dot, but we keep this lenient). This is
 *  the client-side gate; the server re-sanitizes since the list feeds a prompt. */
export function isValidPackageName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9.]*$/.test(name) && name.length <= 64;
}

/** True when `name` is known to be pre-installed on the runner (case-sensitive). */
export function isInstalled(name: string): boolean {
  return INSTALLED_CATALOG.includes(name);
}

/**
 * Read the effective package list from sync storage.
 *  - `customized: false` — the user has never touched the picker (key unset).
 *    `list` is the seeded defaults, used purely to POPULATE the popup. content.ts
 *    then omits the `packages` field entirely so the server keeps its historical
 *    prompt wording — i.e. no behavioral drift for anyone who leaves the picker
 *    alone (nothing to eval-gate for the default population).
 *  - `customized: true` — the user added/removed something (key present, even if
 *    an empty array). `list` is their exact selection and IS sent, steering the
 *    tutor. An empty array is a deliberate "base R only" choice.
 */
export async function loadRPackages(): Promise<{ list: string[]; customized: boolean }> {
  try {
    const r = await chrome.storage.sync.get(RPKG_STORAGE_KEY);
    const stored = r[RPKG_STORAGE_KEY] as string[] | undefined;
    if (Array.isArray(stored)) {
      return { list: stored.filter(isValidPackageName).slice(0, MAX_R_PACKAGES), customized: true };
    }
    return { list: [...DEFAULT_R_PACKAGES], customized: false };
  } catch {
    return { list: [...DEFAULT_R_PACKAGES], customized: false };
  }
}
