import type { SolveImage } from "../core/types";

export interface DataFile {
  filename: string;
  content: string;
}

export interface AnswerChoice {
  label: string;
  text: string;
  type?: "radio" | "checkbox" | "dropdown" | "text";
}

/** One dropdown of a matching / multiple-dropdowns question. Unlike `choices`
 * (a single answer over shared options), each blank is answered independently
 * from its own option list. `label` is the row's prompt (the term being
 * matched, or the surrounding sentence) so the model can tell blanks apart. */
export interface SolveBlank {
  key: string;
  label: string;
  options: string[];
}

/** The model's answer for one blank: the chosen option text. */
export interface BlankAnswer {
  key: string;
  answer: string;
}

export interface SolveBody {
  questionText?: string;
  choices?: AnswerChoice[];
  /** Present for matching / multiple-dropdowns questions (2+ blanks). When set,
   * `choices` is empty — the two are mutually exclusive answer shapes. */
  blanks?: SolveBlank[];
  images?: SolveImage[];
  dataFiles?: DataFile[];
  /** R packages the user selected in the extension popup's library picker.
   * Steers which packages the tutor's generated R code prioritizes (see
   * buildSystemPrompt's rPackages option). Only packages pre-installed on the
   * runner actually execute. Absent → the prompt keeps its historical default
   * wording; empty array → base R only. */
  packages?: string[];
  /** Which course-content profile to steer the tutor's prompt with (see
   * solver-core's buildSystemPrompt CourseProfile option). Absent — the
   * default, and the ONLY value a stock/untouched install ever sends — keeps
   * UT Austin STA 301's historical prompt content byte-identical. "generic"
   * is the only other accepted value; the extension's R-preset picker sends
   * it only for a custom preset explicitly marked as NOT based on UT STA 301
   * (see apps/extension/src/r-packages.ts's resolveActivePreset). Strictly
   * whitelisted server-side (routes/solve.ts's validateSolveBody) — anything
   * else 400s. */
  courseProfile?: "generic";
  /** Content-free behavioral signal: true when the active R-preset is NOT the
   * built-in UT STA 301 preset (i.e. `packages` above reflects a real user
   * choice, not the seeded default) — independent of whether `packages`
   * happens to equal the defaults verbatim. Optional/absent for older
   * extension builds; telemetry only, never read by the prompt builder. */
  rPackagesCustomized?: boolean;
  stream?: boolean;
  debug?: boolean;
  /** Optional per-request model override (for eval/benchmarking A/B); falls
   * back to the default MODEL when unset. */
  model?: string;
}
