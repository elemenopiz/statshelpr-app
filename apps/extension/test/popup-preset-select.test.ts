/**
 * Regression coverage for the "no flash of an empty Course preset dropdown"
 * fix: the UT Austin STA 301 <option> must be baked directly into
 * public/popup.html's STATIC markup (not built by popup.ts at runtime), so
 * it's already selected on the very first paint — before chrome.storage.sync
 * even resolves, let alone popup.ts's own JS running. A UT student opening
 * the popup must see their course already chosen with zero action and zero
 * flash of empty.
 *
 * This test reads the raw HTML source directly (not a live extension popup —
 * this repo has no browser-extension integration harness) and parses it with
 * DOMParser (available via vitest.config.ts's happy-dom environment), so it
 * exercises exactly what a browser's initial HTML parse would produce, before
 * any script executes. popup.ts's renderPresetSelect() is written to only
 * ever APPEND after this option (never rebuild/remove it) — see
 * popup.ts's own comment at that function — but that runtime behavior isn't
 * what's under test here; this test is the structural guarantee the JS
 * behavior depends on.
 */
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

// path.resolve against CWD rather than import.meta.url — under vitest's
// transform, import.meta.url isn't a plain file:// URL, and this test's only
// job is reading the real popup.html this package ships (vitest always runs
// from apps/extension, matching vitest.config.ts's own "test/**/*.test.ts"
// include path).
const popupHtml = readFileSync(path.resolve(process.cwd(), "public/popup.html"), "utf8");

describe("popup.html — Course preset <select> static markup", () => {
  it("the FIRST (and only baked-in) <option> is UT Austin STA 301, with value=ut-sta301", () => {
    const doc = new DOMParser().parseFromString(popupHtml, "text/html");
    const select = doc.getElementById("preset-select") as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    expect(select?.options.length).toBe(1);
    const first = select?.options[0];
    expect(first?.value).toBe("ut-sta301");
    expect(first?.textContent?.trim()).toBe("UT Austin STA 301");
  });

  it("that option is selected in the raw markup itself (the `selected` attribute is present in source, not applied later by script)", () => {
    // Checked against the SOURCE TEXT directly (not the parsed DOM's
    // .selected property, which a spec-compliant single-option <select>
    // would report as true regardless) — this is what actually distinguishes
    // "hard-coded in HTML" from "would only become true after popup.ts runs".
    const optionTagMatch = popupHtml.match(/<option\s+value="ut-sta301"[^>]*>/);
    expect(optionTagMatch).not.toBeNull();
    expect(optionTagMatch?.[0]).toMatch(/\bselected\b/);
  });

  it("the select sits inside the R details section, not gated behind any other hidden/collapsed state that would delay its first paint", () => {
    const doc = new DOMParser().parseFromString(popupHtml, "text/html");
    const select = doc.getElementById("preset-select");
    const details = select?.closest("details");
    expect(details?.id).toBe("rlibs-details");
    // <details> is collapsed by default (no `open` attribute) — that's fine,
    // it's the SAME disclosure pattern the R section always used; the point
    // under test is only that the option is present in markup the instant
    // the details element's content exists in the DOM, not synthesized late.
  });
});
