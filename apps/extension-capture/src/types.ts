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
/** Whether the student got the question right, read off the graded page. */
export type CaptureOutcome = "correct" | "incorrect" | "unknown";
/** How the correct answer (if any) was established.
 *  - answer-key   : Canvas showed the correct answer inline (.correct_answer).
 *  - self-correct : answers hidden, but the question is marked full-marks, so
 *                   the student's own selected answer IS the correct one.
 *  - manual       : live quiz — the user asserted the answer by selecting it.
 *  - none         : correct answer unknown (wrong answer + answers hidden). */
export type AnswerSource = "answer-key" | "self-correct" | "manual" | "none";

/** One captured question, keyed by `id` (a stable hash of the question text).
 * A capture is "verified" when we trust `correctChoices`; unverified captures
 * (a missed question on an answers-hidden quiz) still carry the question and
 * the student's pick, for the separate question-pool export. */
export interface Capture {
  id: string;
  /** Hash of the question text with numbers stripped, so templated numeric
   * variants of one question group together for near-duplicate pruning. */
  templateId: string;
  name: string;
  questionText: string;
  choices: ApiChoice[];
  images: ImageBlock[];
  /** What the student selected, e.g. ["B"]. */
  selectedChoices: string[];
  /** The trusted correct answer; empty when unknown (unverified). */
  correctChoices: string[];
  /** Fill-in / numerical answer value (e.g. "0.073"). When verified, the
   * correct answer; otherwise the student's entry. Absent for choice questions. */
  answerText?: string;
  outcome: CaptureOutcome;
  answerSource: AnswerSource;
  /** True when `correctChoices` is trusted (goes in the eval fixtures). */
  verified: boolean;
  /** Filenames of datasets the question references, e.g. ["scooby.csv"]. The
   * CSV content is packaged separately (datasets.json) and inlined at export;
   * storing only refs keeps chrome.storage lean across many captures. */
  datasetRefs: string[];
  mode: CaptureMode;
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
    answerSource: AnswerSource;
    outcome: CaptureOutcome;
    url: string;
    capturedAt: number;
  };
}

/** A row in the full question-pool export — every capture, verified or not,
 * with the student's pick and outcome. For the "hard questions / label later"
 * use case; kept out of the eval fixtures. */
export interface PoolItem {
  name: string;
  questionText: string;
  choices: ApiChoice[];
  images?: ImageBlock[];
  dataFiles?: Array<{ filename: string; content: string }>;
  selectedChoices: string[];
  correctChoices: string[];
  answerText?: string;
  outcome: CaptureOutcome;
  answerSource: AnswerSource;
  verified: boolean;
  mode: CaptureMode;
  templateId: string;
  url: string;
  courseId?: string;
  quizId?: string;
  capturedAt: number;
}
