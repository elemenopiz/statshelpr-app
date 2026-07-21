import type { SolveImage } from "@/lib/core/types";

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
  stream?: boolean;
  debug?: boolean;
}
