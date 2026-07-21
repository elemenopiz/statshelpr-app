/**
 * Shared types for the training-data capture extension.
 *
 * A `Capture` is a superset of the eval fixture that carries provenance (how
 * the correct answer was obtained, the source URL, etc.). `store.ts` converts
 * a Capture into a `Fixture` — the exact shape `evals/solve-fixtures/*.json`
 * and `scripts/run-evals.ts` already consume — at export time.
 */

export interface ImageBlock {
  data: string; // base64 (no data: prefix), matching /api/solve's contract
  mediaType: "image/png" | "image/jpeg" | "image/webp";
}

/** Mirrors the choice `type` the production content script sends to /api/solve. */
export type ChoiceType = "radio" | "checkbox" | "dropdown" | "text";

export interface ApiChoice {
  label: string; // "A", "B", …
  text: string;
  type: ChoiceType;
}

export type CaptureMode = "concept" | "calc";
export type CaptureSource = "answer-key" | "manual";

/** One labeled question, keyed by `id` (a stable hash of the question text). */
export interface Capture {
  id: string;
  name: string;
  questionText: string;
  choices: ApiChoice[];
  images: ImageBlock[];
  /** Correct-answer labels, e.g. ["A"] or ["A","C"] for select-all. */
  correctChoices: string[];
  mode: CaptureMode;
  /** How `correctChoices` was determined. */
  source: CaptureSource;
  url: string;
  courseId?: string;
  quizId?: string;
  capturedAt: number;
}

/** Exactly the fixture shape `scripts/run-evals.ts` validates and runs. */
export interface Fixture {
  name: string;
  request: {
    questionText: string;
    choices: ApiChoice[];
    images?: ImageBlock[];
    dataFiles?: Array<{ filename: string; content: string }>;
  };
  expected: {
    mode: CaptureMode;
    selectedChoices: string[];
    answerContains?: string[];
  };
  /** Provenance — ignored by the eval runner, handy for auditing the set. */
  meta?: {
    source: CaptureSource;
    url: string;
    capturedAt: number;
  };
}

export interface CaptureSettings {
  /** Default mode stamped onto new captures. */
  defaultMode: CaptureMode;
  /** Whether to embed scraped images in captures (larger, but needed for
   * graph/figure questions). */
  includeImages: boolean;
}

export const DEFAULT_SETTINGS: CaptureSettings = {
  defaultMode: "concept",
  includeImages: true,
};
