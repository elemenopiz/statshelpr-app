/**
 * R course-preset catalog + resolution, shared between the popup picker
 * (popup.ts) and the solve request (content.ts). No imports of its own —
 * esbuild bundles each entry point independently (see scripts/build.mjs), so
 * this stays a tiny constants/logic module that both bundles inline.
 *
 * Background: before the Cloud Run migration, WebR ran R *in the browser* and
 * a flat per-package picker drove webr.installPackages(). Now R runs
 * server-side with a fixed, pre-baked image (r-runner/Dockerfile), and the
 * picker has been redesigned around named PRESETS (course-topic branch) — a
 * preset is a package list PLUS a `basedOnUT` flag that decides whether the
 * solve request also carries `courseProfile: "generic"` (see
 * resolveActivePreset's doc comment for the exact derivation). This is the
 * whole "default = UT STA 301, opt-out = an explicit preset choice"
 * mechanism — there is no separate course toggle anywhere else.
 *
 * PRIVACY: a preset's `name` is free text the user typed and is used ONLY to
 * populate this popup's UI. It is NEVER read by loadRPackages/
 * resolveActivePreset's return value and therefore never reaches content.ts's
 * solve request or any network call — only the preset's validated `packages`
 * array and the derived `courseProfile`/`customized` booleans do.
 */

/** chrome.storage.sync key holding the LEGACY flat per-package selection
 *  (string[]) from before the preset redesign. Read-only here — used solely
 *  by migrateLegacyPackagesIfNeeded to build an equivalent preset once, on
 *  first load after upgrading. Never written by this module anymore. */
const LEGACY_RPKG_STORAGE_KEY = "statshelpr.rPackages";

/** chrome.storage.sync keys for the preset system. */
const PRESETS_STORAGE_KEY = "statshelpr.rPresets";
const ACTIVE_PRESET_STORAGE_KEY = "statshelpr.activePresetId";

/** Reserved id for the built-in, non-deletable UT Austin STA 301 preset. It
 *  is NEVER stored in the presets array — "active preset id is this literal
 *  string (or unset)" IS the sacred default state. */
export const UT_PRESET_ID = "ut-sta301";

/** The UT STA 301 preset's package list — the intro-stats core (the initial
 *  UT Austin market). Also used to pre-fill a new preset created with "base
 *  on UT STA 301" checked. */
export const DEFAULT_R_PACKAGES: readonly string[] = ["tidyverse", "mosaic", "moderndive"];

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

/** Cap on packages per preset AND on the total sent per request — matches the
 *  worker's own MAX_PACKAGES ceiling (apps/workers/src/routes/solve.ts)
 *  exactly, so a preset can never silently exceed what the server will
 *  actually accept. */
export const MAX_R_PACKAGES = 15;

/** R package name grammar: letters/digits/dots, starting with a letter, capped
 *  at 41 characters total (1 + up to 40) — R names are case-sensitive. This is
 *  the client-side gate; the server re-validates independently both when
 *  building the prompt (solver-core's sanitizePackageNames) and when counting
 *  requested packages into metrics (apps/workers/src/lib/metrics-store.ts's
 *  REQUESTED_PACKAGE_NAME_RE) — never trust this check alone. */
export function isValidPackageName(name: string): boolean {
  // Explicit typeof guard: RegExp#test coerces a non-string argument via
  // ToString first (e.g. `null` -> the STRING "null", which matches this
  // pattern) — without this check, a corrupted/hand-edited storage value that
  // isn't a string could pass as if it were a valid, if odd-looking, package
  // name. Mirrors solver-core's sanitizePackageNames' own `typeof raw ===
  // "string"` guard (defense-in-depth against exactly this class of input).
  return typeof name === "string" && /^[A-Za-z][A-Za-z0-9.]{0,40}$/.test(name);
}

/** True when `name` is known to be pre-installed on the runner (case-sensitive). */
export function isInstalled(name: string): boolean {
  return INSTALLED_CATALOG.includes(name);
}

/** A user-created course preset. */
export interface RPreset {
  id: string;
  /** Free text the user typed — UI/local-storage only, see the module doc's
   *  PRIVACY note. Never included in resolveActivePreset's return value. */
  name: string;
  packages: string[];
  /** true = keep UT STA 301's course conventions (the solve request omits
   *  `courseProfile`, same as the sacred default) while still sending this
   *  preset's own `packages`. false = this course is NOT UT STA 301 — the
   *  solve request sends `courseProfile: "generic"` too. */
  basedOnUT: boolean;
}

export interface PresetsState {
  presets: RPreset[];
  /** UT_PRESET_ID or one of `presets[].id`. */
  activePresetId: string;
}

/** What content.ts needs to build a solve request from the active preset. */
export interface ActivePresetResolution {
  list: string[];
  /** false ONLY for the untouched UT STA 301 default — content.ts omits both
   *  `packages` and `courseProfile` from the wire body in that case, so a
   *  stock install's request stays byte-identical to before this feature
   *  existed. true for EVERY custom preset, regardless of basedOnUT. */
  customized: boolean;
  /** Present (always "generic") only for a custom preset with
   *  basedOnUT:false. Absent — including for basedOnUT:true custom presets —
   *  means the request omits `courseProfile`, i.e. STA 301's prompt content. */
  courseProfile?: "generic";
}

/**
 * Pure course-profile derivation table — the WHOLE "default = UT, opt-out =
 * explicit" mechanism now lives here:
 *
 *   active preset            | packages sent | courseProfile sent
 *   --------------------------|----------------|--------------------
 *   UT STA 301 (or unset/     | NO             | NO   <- sacred default,
 *     stale/deleted reference)|                |         byte-identical
 *   custom, basedOnUT: true   | YES            | NO   <- extra packages,
 *                             |                |         same conventions
 *   custom, basedOnUT: false  | YES            | "generic"
 *
 * No chrome.* calls — pure function of already-loaded data, so it's directly
 * unit-testable (see test/r-packages.test.ts) without a chrome storage mock,
 * mirroring telemetry.ts's chrome-free-by-design rule for exactly this
 * reason. loadRPackages() below is the IO wrapper that actually reads
 * storage and calls this.
 */
export function resolveActivePreset(
  presets: readonly RPreset[],
  activePresetId: string,
): ActivePresetResolution {
  if (activePresetId === UT_PRESET_ID) {
    return { list: [...DEFAULT_R_PACKAGES], customized: false };
  }
  const preset = presets.find((p) => p.id === activePresetId);
  if (!preset) {
    // Stale/unknown reference (e.g. the preset was deleted in another popup
    // instance) — fail back to the sacred default rather than silently
    // sending an empty or wrong package list.
    return { list: [...DEFAULT_R_PACKAGES], customized: false };
  }
  const list = preset.packages.filter(isValidPackageName).slice(0, MAX_R_PACKAGES);
  return {
    list,
    customized: true,
    ...(preset.basedOnUT ? {} : { courseProfile: "generic" as const }),
  };
}

function generatePresetId(): string {
  return `preset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * One-time best-effort migration: an install that customized the OLD flat
 * per-package picker (pre-course-topic) had its selection under
 * LEGACY_RPKG_STORAGE_KEY as a bare string[] with no course-profile concept
 * at all — which is EXACTLY basedOnUT:true's semantics (packages differ,
 * course conventions don't, since courseProfile didn't exist yet). Runs once:
 * only fires when the legacy key holds data AND the new preset keys are both
 * still untouched (this popup build has never run before for this user).
 * Leaves the legacy key in place afterward (inert, harmless) rather than
 * deleting it — a mid-migration failure just means this function retries the
 * exact same check next call, so it can never partially corrupt state.
 */
async function migrateLegacyPackagesIfNeeded(): Promise<void> {
  const r = await chrome.storage.sync.get([
    LEGACY_RPKG_STORAGE_KEY,
    PRESETS_STORAGE_KEY,
    ACTIVE_PRESET_STORAGE_KEY,
  ]);
  const legacy = r[LEGACY_RPKG_STORAGE_KEY] as string[] | undefined;
  if (!Array.isArray(legacy) || legacy.length === 0) return;

  const presetsAlreadyExist = Array.isArray(r[PRESETS_STORAGE_KEY]) && r[PRESETS_STORAGE_KEY].length > 0;
  const activeAlreadySet = typeof r[ACTIVE_PRESET_STORAGE_KEY] === "string";
  if (presetsAlreadyExist || activeAlreadySet) return;

  const migrated: RPreset = {
    id: generatePresetId(),
    name: "My R packages",
    packages: legacy.filter(isValidPackageName).slice(0, MAX_R_PACKAGES),
    basedOnUT: true,
  };
  await chrome.storage.sync.set({
    [PRESETS_STORAGE_KEY]: [migrated],
    [ACTIVE_PRESET_STORAGE_KEY]: migrated.id,
  });
}

/**
 * Solve-time IO wrapper: migrates legacy data if needed, reads the active
 * preset, and resolves it via resolveActivePreset. Falls back to the sacred
 * default on any storage error (e.g. a file:// popup preview with no
 * chrome.storage) — same defensive contract the pre-preset loadRPackages()
 * always had.
 */
export async function loadRPackages(): Promise<ActivePresetResolution> {
  try {
    await migrateLegacyPackagesIfNeeded();
    const r = await chrome.storage.sync.get([PRESETS_STORAGE_KEY, ACTIVE_PRESET_STORAGE_KEY]);
    const presets = Array.isArray(r[PRESETS_STORAGE_KEY]) ? (r[PRESETS_STORAGE_KEY] as RPreset[]) : [];
    const activePresetId = (r[ACTIVE_PRESET_STORAGE_KEY] as string | undefined) ?? UT_PRESET_ID;
    return resolveActivePreset(presets, activePresetId);
  } catch {
    return { list: [...DEFAULT_R_PACKAGES], customized: false };
  }
}

// =============================================================================
// popup-only IO — reading/writing the full preset list + active selection for
// the management UI. (loadRPackages() above is the solve-time resolver; these
// are the popup's own read/write helpers.)
// =============================================================================

export async function loadPresetsState(): Promise<PresetsState> {
  try {
    await migrateLegacyPackagesIfNeeded();
    const r = await chrome.storage.sync.get([PRESETS_STORAGE_KEY, ACTIVE_PRESET_STORAGE_KEY]);
    const presets = Array.isArray(r[PRESETS_STORAGE_KEY]) ? (r[PRESETS_STORAGE_KEY] as RPreset[]) : [];
    const activePresetId = (r[ACTIVE_PRESET_STORAGE_KEY] as string | undefined) ?? UT_PRESET_ID;
    return { presets, activePresetId };
  } catch {
    return { presets: [], activePresetId: UT_PRESET_ID };
  }
}

export async function setActivePresetId(id: string): Promise<void> {
  try {
    await chrome.storage.sync.set({ [ACTIVE_PRESET_STORAGE_KEY]: id });
  } catch {
    /* file:// preview — selection just won't persist */
  }
}

export async function savePresets(presets: RPreset[]): Promise<void> {
  try {
    await chrome.storage.sync.set({ [PRESETS_STORAGE_KEY]: presets });
  } catch {
    /* file:// preview — selection just won't persist */
  }
}

/**
 * Pure: free-text package input (comma/space separated, exactly like the old
 * add-row) -> a validated, deduped, capped package list. Invalid tokens are
 * silently dropped rather than rejecting the whole input, matching the old
 * flat picker's tolerant behavior (a pasted list like "car, lme4 psych" just
 * works). No chrome.* calls, so directly unit-testable — see
 * test/r-packages.test.ts.
 */
export function parsePackageInput(rawPackages: string): string[] {
  const candidates = rawPackages
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const packages: string[] = [];
  for (const pkg of candidates) {
    if (!isValidPackageName(pkg)) continue;
    if (packages.includes(pkg)) continue;
    if (packages.length >= MAX_R_PACKAGES) break;
    packages.push(pkg);
  }
  return packages;
}

/**
 * Build + persist a brand-new preset from the popup's create form, then make
 * it active. See parsePackageInput for how `rawPackages` is turned into a
 * validated list.
 */
export async function createPreset(
  currentPresets: readonly RPreset[],
  name: string,
  rawPackages: string,
  basedOnUT: boolean,
): Promise<{ presets: RPreset[]; preset: RPreset }> {
  const preset: RPreset = {
    id: generatePresetId(),
    name: name.trim(),
    packages: parsePackageInput(rawPackages),
    basedOnUT,
  };
  const presets = [...currentPresets, preset];
  await savePresets(presets);
  await setActivePresetId(preset.id);
  return { presets, preset };
}

/** Deletes a custom preset and falls back the active selection to UT STA 301
 *  if it was the one active. No-op (returns the input unchanged) for
 *  UT_PRESET_ID — the built-in preset can't be deleted. */
export async function deletePreset(
  currentPresets: readonly RPreset[],
  activePresetId: string,
  presetIdToDelete: string,
): Promise<{ presets: RPreset[]; activePresetId: string }> {
  if (presetIdToDelete === UT_PRESET_ID) {
    return { presets: [...currentPresets], activePresetId };
  }
  const presets = currentPresets.filter((p) => p.id !== presetIdToDelete);
  await savePresets(presets);
  const nextActive = activePresetId === presetIdToDelete ? UT_PRESET_ID : activePresetId;
  if (nextActive !== activePresetId) await setActivePresetId(nextActive);
  return { presets, activePresetId: nextActive };
}
