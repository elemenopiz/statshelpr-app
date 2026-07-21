/**
 * Package name list shared between the WebR boot sequence (webr-runner.ts,
 * which runs inside content.ts) and the popup UI (popup.ts).
 *
 * This file deliberately has no imports of its own so the popup bundle can
 * pull in UT_BUNDLE for display without dragging the WebR runtime
 * (@r-wasm/webr) into popup.js — see scripts/build.mjs, which bundles each
 * entry point (content/background/popup/welcome) independently.
 */

/** Default "UT bundle" — the seed list of stats packages used in two places:
 * (a) the popup pre-populates a user's editable "R libraries" list with this
 * on their very first install (see popup.ts), and (b) webr-runner.ts falls
 * back to this as the effective package list at boot if the user's stored
 * library list (chrome.storage.sync["extraPackages"]) is empty/unset. Once
 * seeded, users can freely add to or remove from their own list, including
 * these packages — this array is only ever a starting point, not a locked
 * core. */
export const UT_BUNDLE = [
  "tidyverse",
  "mosaic",
  "moderndive",
  "infer",
  "broom",
  "ggplot2",
];
