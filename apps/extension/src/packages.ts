/**
 * Package name list shared between the WebR boot sequence (webr-runner.ts,
 * which runs inside content.ts) and the popup UI (popup.ts).
 *
 * This file deliberately has no imports of its own so the popup bundle can
 * pull in UT_BUNDLE for display without dragging the WebR runtime
 * (@r-wasm/webr) into popup.js — see scripts/build.mjs, which bundles each
 * entry point (content/background/popup/welcome) independently.
 */

/** Default "UT bundle" — the stats packages installed + attached for every
 * user at WebR boot (see webr-runner.ts). Shown as read-only chips in the
 * popup's "R libraries" section; users can't remove these, only add their
 * own extras on top. */
export const UT_BUNDLE = [
  "tidyverse",
  "mosaic",
  "moderndive",
  "infer",
  "broom",
  "ggplot2",
];
