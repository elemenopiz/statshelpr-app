/**
 * Course-preset resolution coverage (course-topic branch). Pure logic only —
 * no chrome.* anywhere, mirroring telemetry.ts's chrome-free-by-design rule
 * (see r-packages.ts's module doc) — loadRPackages/loadPresetsState/
 * savePresets/etc. (the chrome.storage IO wrappers) are deliberately left
 * untested here, same as every other chrome-touching function in this
 * codebase; what's covered is the derivation table those wrappers call into.
 *
 * resolveActivePreset is THE most safety-critical function this branch adds:
 * it decides whether a solve request stays byte-identical to before this
 * feature existed (customized:false, no courseProfile) or opts a student out
 * of UT STA 301's course conventions (courseProfile:"generic"). Every branch
 * of the derivation table gets its own test below.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_R_PACKAGES,
  MAX_R_PACKAGES,
  UT_PRESET_ID,
  isInstalled,
  isValidPackageName,
  parsePackageInput,
  resolveActivePreset,
  type RPreset,
} from "../src/r-packages";

describe("isValidPackageName", () => {
  it("accepts plausible R package names", () => {
    expect(isValidPackageName("car")).toBe(true);
    expect(isValidPackageName("MASS")).toBe(true);
    expect(isValidPackageName("data.table")).toBe(true);
    expect(isValidPackageName("lme4")).toBe(true);
  });

  it("rejects a name starting with a digit or dot (R package names must start with a letter)", () => {
    expect(isValidPackageName("4stats")).toBe(false);
    expect(isValidPackageName(".hidden")).toBe(false);
  });

  it("rejects whitespace, punctuation outside dots, and empty strings", () => {
    expect(isValidPackageName("not a valid name")).toBe(false);
    expect(isValidPackageName("car;rm -rf")).toBe(false);
    expect(isValidPackageName("")).toBe(false);
  });

  it("accepts exactly 41 characters (1 + 40) and rejects 42", () => {
    const at41 = "a" + "b".repeat(40);
    const at42 = "a" + "b".repeat(41);
    expect(at41).toHaveLength(41);
    expect(at42).toHaveLength(42);
    expect(isValidPackageName(at41)).toBe(true);
    expect(isValidPackageName(at42)).toBe(false);
  });

  it("is case-sensitive (R package names are) — MASS and mass are different tokens", () => {
    expect(isValidPackageName("MASS")).toBe(true);
    expect(isValidPackageName("mass")).toBe(true);
  });
});

describe("isInstalled", () => {
  it("recognizes catalog members", () => {
    expect(isInstalled("tidyverse")).toBe(true);
    expect(isInstalled("mosaic")).toBe(true);
  });

  it("is false for anything not in the catalog, without blocking it elsewhere", () => {
    expect(isInstalled("car")).toBe(false);
    expect(isInstalled("some-made-up-package")).toBe(false);
  });
});

describe("parsePackageInput", () => {
  it("splits on commas and whitespace, so a pasted list works in one go", () => {
    expect(parsePackageInput("car, lme4 psych")).toEqual(["car", "lme4", "psych"]);
  });

  it("silently drops a grammar-invalid token instead of rejecting the whole input", () => {
    // A token that's invalid as one whitespace-delimited unit (leading digit,
    // a leading dot, or embedded punctuation) is dropped; everything else in
    // the same input still comes through.
    expect(parsePackageInput("car, 4bad, lme4")).toEqual(["car", "lme4"]);
    expect(parsePackageInput("car .hidden car; lme4")).toEqual(["car", "lme4"]);
  });

  it("dedupes case-sensitively within one input", () => {
    expect(parsePackageInput("car car MASS mass")).toEqual(["car", "MASS", "mass"]);
  });

  it("caps at MAX_R_PACKAGES", () => {
    const many = Array.from({ length: MAX_R_PACKAGES + 10 }, (_, i) => `pkg${i}`).join(",");
    expect(parsePackageInput(many)).toHaveLength(MAX_R_PACKAGES);
  });

  it("empty/whitespace-only input yields an empty list", () => {
    expect(parsePackageInput("")).toEqual([]);
    expect(parsePackageInput("   ")).toEqual([]);
  });
});

describe("resolveActivePreset — the course-profile derivation table", () => {
  const customBasedOnUT: RPreset = {
    id: "p1",
    name: "STA 371G extras",
    packages: ["car", "lme4"],
    basedOnUT: true,
  };
  const customGeneric: RPreset = {
    id: "p2",
    name: "Some other school",
    packages: ["ggplot2"],
    basedOnUT: false,
  };
  const presets: RPreset[] = [customBasedOnUT, customGeneric];

  it("UT_PRESET_ID -> the sacred default: DEFAULT_R_PACKAGES, customized:false, NO courseProfile", () => {
    const r = resolveActivePreset(presets, UT_PRESET_ID);
    expect(r.list).toEqual([...DEFAULT_R_PACKAGES]);
    expect(r.customized).toBe(false);
    expect(r.courseProfile).toBeUndefined();
    expect(Object.keys(r).sort()).toEqual(["customized", "list"].sort()); // courseProfile key ABSENT, not just undefined-valued
  });

  it("an unknown/stale active id (e.g. a preset deleted in another popup instance) falls back to the sacred default, not an empty list", () => {
    const r = resolveActivePreset(presets, "some-deleted-preset-id");
    expect(r.list).toEqual([...DEFAULT_R_PACKAGES]);
    expect(r.customized).toBe(false);
    expect(r.courseProfile).toBeUndefined();
  });

  it("custom preset with basedOnUT:true -> its OWN packages, customized:true, but STILL no courseProfile", () => {
    const r = resolveActivePreset(presets, "p1");
    expect(r.list).toEqual(["car", "lme4"]);
    expect(r.customized).toBe(true);
    expect(r.courseProfile).toBeUndefined();
  });

  it("custom preset with basedOnUT:false -> its OWN packages, customized:true, AND courseProfile:'generic'", () => {
    const r = resolveActivePreset(presets, "p2");
    expect(r.list).toEqual(["ggplot2"]);
    expect(r.customized).toBe(true);
    expect(r.courseProfile).toBe("generic");
  });

  it("an empty-package custom preset (basedOnUT:true) still reports customized:true with an empty list (deliberate base-R-only choice)", () => {
    const emptyPreset: RPreset = { id: "p3", name: "Base R only", packages: [], basedOnUT: true };
    const r = resolveActivePreset([emptyPreset], "p3");
    expect(r.list).toEqual([]);
    expect(r.customized).toBe(true);
    expect(r.courseProfile).toBeUndefined();
  });

  it("re-validates a preset's stored packages defensively (corrupted/hand-edited storage can't smuggle a bad token through)", () => {
    const corrupted: RPreset = {
      id: "p4",
      name: "corrupted",
      // @ts-expect-error -- deliberately simulating malformed storage content
      packages: ["car", 123, "not a valid name", null, "lme4"],
      basedOnUT: true,
    };
    const r = resolveActivePreset([corrupted], "p4");
    expect(r.list).toEqual(["car", "lme4"]);
  });

  it("caps a preset's package list at MAX_R_PACKAGES even if more were somehow stored", () => {
    const overstuffed: RPreset = {
      id: "p5",
      name: "overstuffed",
      packages: Array.from({ length: MAX_R_PACKAGES + 5 }, (_, i) => `pkg${i}`),
      basedOnUT: false,
    };
    const r = resolveActivePreset([overstuffed], "p5");
    expect(r.list).toHaveLength(MAX_R_PACKAGES);
  });

  it("resolveActivePreset never mutates its inputs (pure function)", () => {
    const before = JSON.stringify(presets);
    resolveActivePreset(presets, "p1");
    resolveActivePreset(presets, UT_PRESET_ID);
    expect(JSON.stringify(presets)).toBe(before);
  });
});
