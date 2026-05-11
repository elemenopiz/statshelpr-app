import type { SolveImage } from "@/lib/core/types";

export interface DataFile {
  filename: string;
  content: string;
}

export interface AnswerChoice {
  label: string;
  text: string;
  type?: "radio" | "checkbox";
}

export interface SolveBody {
  questionText?: string;
  choices?: AnswerChoice[];
  images?: SolveImage[];
  dataFiles?: DataFile[];
  stream?: boolean;
  debug?: boolean;
}
