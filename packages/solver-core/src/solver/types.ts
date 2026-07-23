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
  stream?: boolean;
  debug?: boolean;
  /** Optional per-request model override (for eval/benchmarking A/B); falls
   * back to the default MODEL when unset. */
  model?: string;
}
