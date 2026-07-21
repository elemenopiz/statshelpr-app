/**
 * Loader for the real capture dataset (evals/captures/captures-20260722.json)
 * — 146 REAL Canvas Classic quiz records scraped from live courses. Fixture
 * builders in canvas-classic.ts pull specific records out of this file (by
 * their stable `canvasQuestionId`, since `name` is a truncated stem prefix
 * and NOT unique across the 146 records) so the interactive DOM markup in
 * this test suite is driven by real captured choice/blank text — unicode,
 * currency, LaTeX remnants and all — rather than hand-typed strings that
 * might inadvertently only ever exercise the easy path.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// test/fixtures/ -> test/ -> apps/extension/ -> apps/ -> repo root
const CAPTURES_PATH = path.resolve(__dirname, "../../../../evals/captures/captures-20260722.json");

export interface CaptureChoice {
  label: string;
  text: string;
  type: "radio" | "checkbox" | "text";
}

export interface CaptureBlank {
  key: string;
  label: string;
  options: string[];
  selected: string;
  correct: string;
}

export interface CaptureRecord {
  name: string;
  questionText: string;
  choices: CaptureChoice[];
  selectedChoices: string[];
  correctChoices: string[];
  outcome: string;
  answerSource: string;
  verified: boolean;
  mode: string;
  templateId: string;
  url: string;
  capturedAt: number;
  blanks: CaptureBlank[];
  courseId: string;
  quizId: string;
  imageUrls: string[];
  questionHtml: string;
  questionType: string;
  canvasQuestionId: string;
  answerText?: string;
}

let cached: CaptureRecord[] | null = null;

/** All 146 captured records, loaded once and cached for the test run. */
export function loadCaptures(): CaptureRecord[] {
  if (!cached) {
    const raw = readFileSync(CAPTURES_PATH, "utf-8");
    cached = JSON.parse(raw) as CaptureRecord[];
  }
  return cached;
}

/** Look up one record by its stable Canvas question id (unique; `name` is
 * NOT — 146 records collapse to 115 unique truncated names). Throws loudly
 * if the dataset shape changes and the id disappears, so a stale fixture
 * reference fails fast instead of silently building an empty question. */
export function captureById(canvasQuestionId: string): CaptureRecord {
  const rec = loadCaptures().find((r) => r.canvasQuestionId === canvasQuestionId);
  if (!rec) {
    throw new Error(
      `captureById: no record with canvasQuestionId="${canvasQuestionId}" in captures-20260722.json`,
    );
  }
  return rec;
}

export function capturesByType(questionType: string): CaptureRecord[] {
  return loadCaptures().filter((r) => r.questionType === questionType);
}
