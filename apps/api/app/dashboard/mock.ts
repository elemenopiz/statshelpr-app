import type { MetricsPayload } from "./types";

/**
 * Hardcoded realistic payload for `/dashboard?demo=1`, matching the exact
 * `GET /api/metrics` shape. Used for visual QA and for reviewing the layout
 * without a live worker/token. Numbers are deterministic (seeded PRNG) so
 * the page looks the same on every reload rather than jittering.
 *
 * Pricing basis (verified live, July 2026): Gemini 3.5 Flash-Lite —
 * $0.30 / 1M input tokens, $2.50 / 1M output tokens. Cached-input rate is
 * an illustrative ~25% of input (Gemini's typical implicit-cache discount);
 * confirm the exact figure against the live Google AI pricing page before
 * treating it as authoritative.
 */

// Deterministic PRNG (mulberry32) — fixed seed so demo numbers are stable
// across requests instead of re-randomizing on every render.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Split `total` across `weights` (must sum to ~1) as whole numbers that
 * add back up to exactly `total` — remainder goes to the largest bucket. */
function splitByWeights(
  total: number,
  weights: Record<string, number>,
): Record<string, number> {
  const keys = Object.keys(weights);
  const raw = keys.map((k) => ({ k, v: total * (weights[k] ?? 0) }));
  const floored = raw.map(({ k, v }) => ({ k, v: Math.floor(v), frac: v - Math.floor(v) }));
  let used = floored.reduce((s, x) => s + x.v, 0);
  let remainder = total - used;
  // Distribute leftover units to the entries with the largest fractional part.
  const byFrac = [...floored].sort((a, b) => b.frac - a.frac);
  const out: Record<string, number> = {};
  for (const f of floored) out[f.k] = f.v;
  for (let i = 0; i < byFrac.length && remainder > 0; i++) {
    const entry = byFrac[i];
    if (!entry) continue;
    out[entry.k] = (out[entry.k] ?? 0) + 1;
    remainder--;
  }
  return out;
}

function buildDaily(days: number) {
  const rand = mulberry32(20260722);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const points: { date: string; questions: number; apiCalls: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const dow = d.getUTCDay(); // 0 = Sun .. 6 = Sat
    const isWeekend = dow === 0 || dow === 6;
    const base = isWeekend ? 165 : 315;
    const jitter = 0.82 + rand() * 0.36; // 0.82x - 1.18x
    const questions = Math.max(20, Math.round(base * jitter));
    const callsPerQuestion = 1.28 + rand() * 0.14; // accounts for 2-call calc path
    const apiCalls = Math.round(questions * callsPerQuestion);
    const iso = d.toISOString().slice(0, 10);
    points.push({ date: iso, questions, apiCalls });
  }
  return points;
}

const RANGE_DAYS = 30;
const DAILY = buildDaily(RANGE_DAYS);
const QUESTIONS_ANSWERED = DAILY.reduce((s, p) => s + p.questions, 0);
const API_CALLS = DAILY.reduce((s, p) => s + p.apiCalls, 0);

const BY_QUESTION_TYPE = splitByWeights(QUESTIONS_ANSWERED, {
  multiple_choice_question: 0.42,
  numerical_question: 0.16,
  true_false_question: 0.12,
  fill_in_multiple_blanks_question: 0.1,
  multiple_dropdowns_question: 0.09,
  matching_question: 0.07,
  short_answer_question: 0.03,
  essay_question: 0.01,
});

const MODE_SPLIT_RAW = splitByWeights(QUESTIONS_ANSWERED, {
  concept: 0.726,
  calc: 0.274,
});
const MODE_SPLIT = { concept: MODE_SPLIT_RAW["concept"] ?? 0, calc: MODE_SPLIT_RAW["calc"] ?? 0 };

const WRITE_BACK_RAW = splitByWeights(QUESTIONS_ANSWERED, {
  written: 0.81,
  nowrite: 0.125,
  error: 0.065,
});
const WRITE_BACK_BY_OUTCOME = {
  written: WRITE_BACK_RAW["written"] ?? 0,
  nowrite: WRITE_BACK_RAW["nowrite"] ?? 0,
  error: WRITE_BACK_RAW["error"] ?? 0,
};

const CONFIDENCE_RAW = splitByWeights(QUESTIONS_ANSWERED, {
  High: 0.62,
  Med: 0.29,
  Low: 0.075,
  Unset: 0.015,
});
const CONFIDENCE = {
  High: CONFIDENCE_RAW["High"] ?? 0,
  Med: CONFIDENCE_RAW["Med"] ?? 0,
  Low: CONFIDENCE_RAW["Low"] ?? 0,
  "": CONFIDENCE_RAW["Unset"] ?? 0,
};

const WEBR_USAGE = Math.round(MODE_SPLIT.calc * 0.87);

const AVG_COST_PER_QUESTION_USD = 0.0186;
const AVG_COST_PER_CALC_QUESTION_USD = 0.0344;
const TOTAL_COST_USD = Number((QUESTIONS_ANSWERED * AVG_COST_PER_QUESTION_USD).toFixed(2));
const PRICE_MONTHLY_USD = 15;
const ASSUMED_SOLVES_PER_USER_PER_MONTH = 90;

// Two models in play: text solves route to the cheap/fast text model;
// image solves (full-question screenshots) route to a pricier vision model.
// Split API_CALLS between them and back into TOTAL_COST_USD so the per-model
// breakdown always reconciles with the headline total (see gemini.ts:
// DEFAULT_MODEL vs IMAGE_MODEL for the real routing logic this mirrors).
const TEXT_MODEL_ID = "gemini-3.5-flash-lite";
const IMAGE_MODEL_ID = "gemini-3.6-flash";
const IMAGE_CALL_SHARE = 0.18;
// gemini-3.6-flash is ~5x gemini-3.5-flash-lite on input tokens ($1.50 vs
// $0.30/1M) and ~3x on output ($7.50 vs $2.50/1M); blend to a rough
// per-call cost multiplier for this illustrative split.
const IMAGE_VS_TEXT_COST_MULTIPLIER = 4.2;

const IMAGE_CALLS = Math.round(API_CALLS * IMAGE_CALL_SHARE);
const TEXT_CALLS = API_CALLS - IMAGE_CALLS;
const TEXT_COST_PER_CALL =
  TOTAL_COST_USD / (TEXT_CALLS + IMAGE_VS_TEXT_COST_MULTIPLIER * IMAGE_CALLS);
const TEXT_MODEL_COST_USD = Number((TEXT_CALLS * TEXT_COST_PER_CALL).toFixed(2));
// Assign the remainder (not an independent recompute) so the two rows
// always sum to exactly TOTAL_COST_USD.
const IMAGE_MODEL_COST_USD = Number((TOTAL_COST_USD - TEXT_MODEL_COST_USD).toFixed(2));

/** Build the mock payload fresh on each call so `generatedAt` reflects "now"
 * (everything else is deterministic/seeded). */
export function buildMockMetrics(): MetricsPayload {
  return {
    generatedAt: Date.now(),
    range: { days: RANGE_DAYS },
    volume: {
      questionsAnswered: QUESTIONS_ANSWERED,
      apiCalls: API_CALLS,
      byQuestionType: BY_QUESTION_TYPE,
      dau: 58,
      wau: 241,
      daily: DAILY,
    },
    quality: {
      solveSuccessRate: 0.94,
      writeBackSuccessRate:
        WRITE_BACK_BY_OUTCOME.written /
        Math.max(1, WRITE_BACK_BY_OUTCOME.written + WRITE_BACK_BY_OUTCOME.nowrite + WRITE_BACK_BY_OUTCOME.error),
      writeBackByOutcome: WRITE_BACK_BY_OUTCOME,
      confidence: CONFIDENCE,
      modeSplit: MODE_SPLIT,
      webrUsage: WEBR_USAGE,
    },
    performance: {
      serverLatencyMsP50: 1420,
      serverLatencyMsP95: 4150,
      clientLatencyMsP50: 1890,
      clientLatencyMsP95: 5320,
    },
    economics: {
      model: TEXT_MODEL_ID,
      rates: {
        inputPer1M: 0.3,
        outputPer1M: 2.5,
        cachedInputPer1M: 0.075,
      },
      totalCostUsd: TOTAL_COST_USD,
      avgCostPerQuestionUsd: AVG_COST_PER_QUESTION_USD,
      avgCostPerCalcQuestionUsd: AVG_COST_PER_CALC_QUESTION_USD,
      priceMonthlyUsd: PRICE_MONTHLY_USD,
      assumedSolvesPerUserPerMonth: ASSUMED_SOLVES_PER_USER_PER_MONTH,
      breakEvenQuestionsPerUser: Math.round(PRICE_MONTHLY_USD / AVG_COST_PER_QUESTION_USD),
      grossMarginPerUserPct:
        ((PRICE_MONTHLY_USD - ASSUMED_SOLVES_PER_USER_PER_MONTH * AVG_COST_PER_QUESTION_USD) /
          PRICE_MONTHLY_USD) *
        100,
      modelsUsed: {
        [TEXT_MODEL_ID]: { calls: TEXT_CALLS, costUsd: TEXT_MODEL_COST_USD },
        [IMAGE_MODEL_ID]: { calls: IMAGE_CALLS, costUsd: IMAGE_MODEL_COST_USD },
      },
    },
  };
}
