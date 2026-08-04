import type { DailyPoint, MetricsResponse, WriteBackTypeStat } from "./metrics-aggregate";
import type { ModelUsage, WriteBackOutcomeCounts } from "./metrics-store";
import { IMAGE_VISION_MODEL, PRIMARY_TEXT_MODEL } from "./cost";
import { LATENCY_BUCKET_BOUNDARIES_MS, percentileFromHistogram } from "./histogram";

/**
 * Hardcoded realistic payload for `/dashboard?demo=1`, matching the exact
 * `MetricsResponse` shape aggregateMetrics() produces (dashboard-v2 contract).
 * Used for visual QA and for reviewing the layout without live KV data.
 * Numbers are deterministic (seeded PRNG) so the page looks the same on every
 * reload rather than jittering, and internally consistent (per-day series sum
 * to the 30d headline totals) so every new panel — trends, revenue, funnel,
 * retention, error breakdown, latency distribution — renders with plausible
 * data.
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
function splitByWeights(total: number, weights: Record<string, number>): Record<string, number> {
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

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Full per-day series (DailyPoint) so trend/sparkline/composition charts have
 *  real data in demo mode. Fields are internally consistent (concept+calc =
 *  questions, errors < apiCalls, etc.). */
function buildDaily(days: number): DailyPoint[] {
  const rand = mulberry32(20260722);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const points: DailyPoint[] = [];
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
    const concept = Math.round(questions * 0.726);
    const calc = questions - concept;
    const errors = Math.round(apiCalls * (0.03 + rand() * 0.045)); // 3-7.5%
    const solveSuccessRate = round4((apiCalls - errors) / Math.max(1, apiCalls));
    const costUsd = round6(questions * (0.016 + rand() * 0.006));
    const cacheHitRate = round4(0.18 + rand() * 0.16);
    const serverLatencyMsP50 = Math.round(1250 + rand() * 460);
    const imageCalls = Math.round(apiCalls * (0.15 + rand() * 0.07));
    const newInstalls = Math.round(4 + rand() * 13);
    const activeInstalls = Math.round(38 + rand() * 44);
    const paywallHits = Math.round(4 + rand() * 15);
    const revenueCreated = rand() < 0.38 ? 1 : 0;
    const revenueCancelled = rand() < 0.1 ? 1 : 0;
    points.push({
      date: d.toISOString().slice(0, 10),
      questions,
      apiCalls,
      errors,
      solveSuccessRate,
      costUsd,
      cacheHitRate,
      serverLatencyMsP50,
      concept,
      calc,
      imageCalls,
      newInstalls,
      activeInstalls,
      paywallHits,
      revenueCreated,
      revenueCancelled,
    });
  }
  return points;
}

const RANGE_DAYS = 30;
const DAILY = buildDaily(RANGE_DAYS);
const sum = (pick: (p: DailyPoint) => number): number => DAILY.reduce((s, p) => s + pick(p), 0);

const QUESTIONS_ANSWERED = sum((p) => p.questions);
const API_CALLS = sum((p) => p.apiCalls);
const ERRORS_TOTAL = sum((p) => p.errors);
const PAYWALL_HITS_30D = sum((p) => p.paywallHits);
const NEW_INSTALLS_30D = sum((p) => p.newInstalls);
const REVENUE_CREATED_30D = sum((p) => p.revenueCreated);
const REVENUE_CANCELLED_30D = sum((p) => p.revenueCancelled);

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
const WRITE_BACK_BY_OUTCOME: WriteBackOutcomeCounts = {
  written: WRITE_BACK_RAW["written"] ?? 0,
  nowrite: WRITE_BACK_RAW["nowrite"] ?? 0,
  error: WRITE_BACK_RAW["error"] ?? 0,
};

// Per-question-type write-back cross-tab (item 4). Each type gets its own
// plausible write-back rate — MC/true-false write back cleanly, matching and
// multi-blanks are the problem children — so the "what to fix" panel has signal.
const WRITE_RATE_BY_TYPE: Record<string, number> = {
  multiple_choice_question: 0.96,
  true_false_question: 0.97,
  numerical_question: 0.9,
  fill_in_multiple_blanks_question: 0.74,
  multiple_dropdowns_question: 0.71,
  matching_question: 0.6,
  short_answer_question: 0.83,
  essay_question: 0.55,
};
const WRITE_BACK_BY_QUESTION_TYPE: Record<string, WriteBackTypeStat> = {};
for (const [type, total] of Object.entries(BY_QUESTION_TYPE)) {
  const rate = WRITE_RATE_BY_TYPE[type] ?? 0.85;
  const written = Math.round(total * rate);
  const error = Math.round((total - written) * 0.4);
  const nowrite = total - written - error;
  WRITE_BACK_BY_QUESTION_TYPE[type] = {
    written,
    nowrite,
    error,
    writeBackRate: total > 0 ? round4(written / total) : 0,
  };
}

const CONFIDENCE_RAW = splitByWeights(MODE_SPLIT.concept, {
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

// Calc-path confidence (item 16) — separate distribution, a bit less confident
// than the concept path (numeric interpretation is harder).
const CONFIDENCE_CALC_RAW = splitByWeights(MODE_SPLIT.calc, {
  High: 0.51,
  Med: 0.34,
  Low: 0.12,
  Unset: 0.03,
});
const CONFIDENCE_CALC = {
  High: CONFIDENCE_CALC_RAW["High"] ?? 0,
  Med: CONFIDENCE_CALC_RAW["Med"] ?? 0,
  Low: CONFIDENCE_CALC_RAW["Low"] ?? 0,
  "": CONFIDENCE_CALC_RAW["Unset"] ?? 0,
};

// Error breakdown (item 2) — sums to ERRORS_TOTAL.
const BY_ERROR_TYPE = splitByWeights(ERRORS_TOTAL, {
  rate_limit: 0.44,
  quota: 0.19,
  upstream: 0.14,
  timeout: 0.11,
  bad_input: 0.07,
  auth: 0.03,
  unknown: 0.02,
});

// course-topic branch: course-context + behavioral demo data (Part 2 + 3, plus
// the preset-package telemetry that replaced the original per-package-picker
// design mid-flight). QUESTIONS_ANSWERED-scaled, internally consistent with
// the rest of this deterministic mock payload.
const BY_TOPIC = splitByWeights(QUESTIONS_ANSWERED, {
  probability: 0.09,
  plots: 0.06,
  summary_statistics: 0.08,
  data_wrangling: 0.07,
  linear_regression: 0.14,
  clt: 0.1,
  bootstrap: 0.08,
  hypothesis_testing: 0.13,
  large_sample_inference: 0.09,
  experiments_causation: 0.05,
  multiple_regression: 0.07,
  probability_models: 0.03,
  non_stats: 0.005,
  other: 0.005,
  unknown: 0.005,
});

// Pre-launch, single-course product: the overwhelming majority of installs
// have never touched the course preset — the UT STA 301 default IS the
// sacred, untouched path (see the golden test in packages/solver-core).
const COURSE_PROFILE_SPLIT = splitByWeights(QUESTIONS_ANSWERED, { sta301: 0.94, generic: 0.06 });
const BY_COURSE_PROFILE = {
  sta301: COURSE_PROFILE_SPLIT["sta301"] ?? 0,
  generic: COURSE_PROFILE_SPLIT["generic"] ?? 0,
};

const IMAGE_ATTACHMENT_SPLIT = splitByWeights(QUESTIONS_ANSWERED, { withImages: 0.22, withoutImages: 0.78 });
const IMAGE_ATTACHMENT = {
  withImages: IMAGE_ATTACHMENT_SPLIT["withImages"] ?? 0,
  withoutImages: IMAGE_ATTACHMENT_SPLIT["withoutImages"] ?? 0,
};

const RPKG_CUSTOMIZED_SPLIT = splitByWeights(QUESTIONS_ANSWERED, { customized: 0.15, default: 0.85 });
const RPACKAGES_CUSTOMIZED = {
  customized: RPKG_CUSTOMIZED_SPLIT["customized"] ?? 0,
  default: RPKG_CUSTOMIZED_SPLIT["default"] ?? 0,
};

// A handful of real intro-stats R package names, weighted toward the UT STA
// 301 defaults (tidyverse/mosaic/moderndive) with a long tail of one-off asks
// — the shape this "promote a popular preset to official" card exists to show.
const BY_REQUESTED_PACKAGE: Record<string, number> = {
  tidyverse: Math.round(QUESTIONS_ANSWERED * 0.04),
  mosaic: Math.round(QUESTIONS_ANSWERED * 0.032),
  moderndive: Math.round(QUESTIONS_ANSWERED * 0.024),
  ggplot2: Math.round(QUESTIONS_ANSWERED * 0.01),
  car: Math.round(QUESTIONS_ANSWERED * 0.006),
  broom: Math.round(QUESTIONS_ANSWERED * 0.004),
  lme4: Math.round(QUESTIONS_ANSWERED * 0.003),
  infer: Math.round(QUESTIONS_ANSWERED * 0.002),
};

const WEBR_USAGE = Math.round(MODE_SPLIT.calc * 0.87);

// Latency distributions (item 11) — 9 fixed buckets matching
// LATENCY_BUCKET_BOUNDARIES_MS, peaking around 1-2s; client is slightly slower
// (full solve round trip + write-back). Sum to API_CALLS so the histogram
// reconciles with volume.
const SERVER_LATENCY_HISTOGRAM = boundariesSplit(API_CALLS, [
  0.01, 0.05, 0.13, 0.27, 0.25, 0.16, 0.08, 0.035, 0.015,
]);
const CLIENT_LATENCY_HISTOGRAM = boundariesSplit(API_CALLS, [
  0.005, 0.03, 0.09, 0.2, 0.26, 0.2, 0.11, 0.06, 0.03,
]);

function boundariesSplit(total: number, weights: number[]): number[] {
  const keyed: Record<string, number> = {};
  weights.forEach((w, i) => (keyed[String(i)] = w));
  const out = splitByWeights(total, keyed);
  return LATENCY_BUCKET_BOUNDARIES_MS.map((_, i) => out[String(i)] ?? 0);
}

// Cloud Run R-runner health (R-runner health tracking phase 1) — one call per
// calc question (WEBR_USAGE), mostly warm (sub-2s), with a small cold-start
// tail out past the 8s bucket matching solve.ts's cold-start threshold.
const R_RUNNER_REQUEST_COUNT = WEBR_USAGE;
const R_RUNNER_ERROR_COUNT = Math.round(R_RUNNER_REQUEST_COUNT * 0.03);
const R_RUNNER_SUCCESS_COUNT = R_RUNNER_REQUEST_COUNT - R_RUNNER_ERROR_COUNT;
const R_RUNNER_COLD_START_COUNT = Math.round(R_RUNNER_SUCCESS_COUNT * 0.06);
const R_RUNNER_LATENCY_HISTOGRAM = boundariesSplit(R_RUNNER_SUCCESS_COUNT, [
  0.03, 0.22, 0.3, 0.22, 0.11, 0.05, 0.02, 0.03, 0.02,
]);

// Cloud Run infra (R-runner health tracking phase 2) — a modest month-to-date
// burn well under the free tier, plus a cold-start p50/p95 a bit tighter than
// the R-runner section's inferred (durationMs > 8000) heuristic above, since
// this is the more precise Cloud-Run-native signal.
const CLOUD_RUN_BILLABLE_SECONDS_THIS_MONTH = 14_200;
const CLOUD_RUN_VCPU_SECONDS = CLOUD_RUN_BILLABLE_SECONDS_THIS_MONTH * 1;
const CLOUD_RUN_GIB_SECONDS = CLOUD_RUN_BILLABLE_SECONDS_THIS_MONTH * 2;

const AVG_COST_PER_QUESTION_USD = 0.0186;
const AVG_COST_PER_CALC_QUESTION_USD = 0.0344;
const TOTAL_COST_USD = Number((QUESTIONS_ANSWERED * AVG_COST_PER_QUESTION_USD).toFixed(2));
const PRICE_MONTHLY_USD = 15;
const ASSUMED_SOLVES_PER_USER_PER_MONTH = 90;

// Token totals (item 1) — plausible per-question shape with a ~24% cache hit.
const PROMPT_TOKENS = Math.round(QUESTIONS_ANSWERED * 1320);
const COMPLETION_TOKENS = Math.round(QUESTIONS_ANSWERED * 430);
const CACHED_TOKENS = Math.round(PROMPT_TOKENS * 0.24);

// Two models in play: text solves route to the cheap/fast text model;
// image solves (full-question screenshots) route to a pricier vision model.
// Split API_CALLS between them and back into TOTAL_COST_USD so the per-model
// breakdown always reconciles with the headline total (see lib/cost.ts:
// PRIMARY_TEXT_MODEL vs IMAGE_VISION_MODEL for the real routing logic this
// mirrors).
const TEXT_MODEL_ID = PRIMARY_TEXT_MODEL;
const IMAGE_MODEL_ID = IMAGE_VISION_MODEL;
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

const MODELS_USED: Record<string, ModelUsage> = {
  [TEXT_MODEL_ID]: { calls: TEXT_CALLS, costUsd: TEXT_MODEL_COST_USD },
  [IMAGE_MODEL_ID]: { calls: IMAGE_CALLS, costUsd: IMAGE_MODEL_COST_USD },
};

// Revenue (items 6 & 9) — point-in-time active subs (from the `sub:` KV scan
// in prod). MRR = active × price. Real blended margin reconciles COGS vs
// actual revenue.
const ACTIVE_SUBSCRIBERS = 34;
const MRR_USD = ACTIVE_SUBSCRIBERS * PRICE_MONTHLY_USD;
const NET_NEW_SUBS_30D = REVENUE_CREATED_30D - REVENUE_CANCELLED_30D;
const DAU = 58;
const WAU = 241;
const MAU = 612;

/** Build the mock payload fresh on each call so `generatedAt` reflects "now"
 * (everything else is deterministic/seeded). */
export function buildMockMetrics(): MetricsResponse {
  return {
    generatedAt: Date.now(),
    range: { days: RANGE_DAYS },
    comparison: {
      prevRangeDays: RANGE_DAYS,
      deltaPct: {
        questionsAnswered: 12.4,
        apiCalls: 11.0,
        solveSuccessRate: 1.1,
        writeBackSuccessRate: 2.3,
        errorsTotal: -8.3,
        totalCostUsd: 9.6,
        avgCostPerQuestionUsd: -2.5,
        cacheHitRate: 4.2,
        dau: 6.7,
        wau: 8.9,
        mau: 9.4,
        mrrUsd: 18.2,
        activeSubscribers: 15.3,
        paywallHits30d: 22.5,
      },
    },
    volume: {
      questionsAnswered: QUESTIONS_ANSWERED,
      apiCalls: API_CALLS,
      byQuestionType: BY_QUESTION_TYPE,
      dau: DAU,
      wau: WAU,
      mau: MAU,
      newInstalls: NEW_INSTALLS_30D,
      daily: DAILY,
    },
    quality: {
      solveSuccessRate: round4((API_CALLS - ERRORS_TOTAL) / Math.max(1, API_CALLS)),
      writeBackSuccessRate: round4(
        WRITE_BACK_BY_OUTCOME.written /
          Math.max(
            1,
            WRITE_BACK_BY_OUTCOME.written + WRITE_BACK_BY_OUTCOME.nowrite + WRITE_BACK_BY_OUTCOME.error,
          ),
      ),
      writeBackByOutcome: WRITE_BACK_BY_OUTCOME,
      writeBackByQuestionType: WRITE_BACK_BY_QUESTION_TYPE,
      confidence: CONFIDENCE,
      confidenceCalc: CONFIDENCE_CALC,
      modeSplit: MODE_SPLIT,
      webrUsage: WEBR_USAGE,
      byErrorType: BY_ERROR_TYPE,
      byFailure: { scrape_failed: 4, timeout: 2, network_failed: 1 },
      errorsTotal: ERRORS_TOTAL,
    },
    performance: {
      serverLatencyMsP50: 1420,
      serverLatencyMsP95: 4150,
      clientLatencyMsP50: 1890,
      clientLatencyMsP95: 5320,
      serverLatencyHistogram: SERVER_LATENCY_HISTOGRAM,
      clientLatencyHistogram: CLIENT_LATENCY_HISTOGRAM,
      latencyBoundariesMs: [...LATENCY_BUCKET_BOUNDARIES_MS],
    },
    rRunner: {
      requestCount: R_RUNNER_REQUEST_COUNT,
      successRate: round4(R_RUNNER_SUCCESS_COUNT / Math.max(1, R_RUNNER_REQUEST_COUNT)),
      latencyMsP50: Math.round(
        percentileFromHistogram(R_RUNNER_LATENCY_HISTOGRAM, LATENCY_BUCKET_BOUNDARIES_MS, 0.5),
      ),
      latencyMsP95: Math.round(
        percentileFromHistogram(R_RUNNER_LATENCY_HISTOGRAM, LATENCY_BUCKET_BOUNDARIES_MS, 0.95),
      ),
      latencyHistogram: R_RUNNER_LATENCY_HISTOGRAM,
      coldStartRatePct: round2((R_RUNNER_COLD_START_COUNT / Math.max(1, R_RUNNER_SUCCESS_COUNT)) * 100),
    },
    cloudRun: {
      available: true,
      unavailableReason: null,
      billableInstanceTime: {
        vcpuSeconds: CLOUD_RUN_VCPU_SECONDS,
        gibSeconds: CLOUD_RUN_GIB_SECONDS,
        vcpuFreeTierBurnPct: round2((CLOUD_RUN_VCPU_SECONDS / 180_000) * 100),
        gibFreeTierBurnPct: round2((CLOUD_RUN_GIB_SECONDS / 360_000) * 100),
      },
      startupLatency: {
        p50Ms: 340,
        p95Ms: 2150,
      },
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
      modelsUsed: MODELS_USED,
      tokens: {
        promptTokens: PROMPT_TOKENS,
        completionTokens: COMPLETION_TOKENS,
        cachedTokens: CACHED_TOKENS,
      },
      cacheHitRate: round4(CACHED_TOKENS / PROMPT_TOKENS),
      tokensPerQuestion: Math.round((PROMPT_TOKENS + COMPLETION_TOKENS) / QUESTIONS_ANSWERED),
      inputOutputRatio: round4(PROMPT_TOKENS / COMPLETION_TOKENS),
      imageCalls: IMAGE_CALLS,
      imageCallSharePct: round2((IMAGE_CALLS / API_CALLS) * 100),
      imageCostSharePct: round2((IMAGE_MODEL_COST_USD / TOTAL_COST_USD) * 100),
    },
    revenue: {
      activeSubscribers: ACTIVE_SUBSCRIBERS,
      mrrUsd: MRR_USD,
      arpuUsd: PRICE_MONTHLY_USD,
      created30d: REVENUE_CREATED_30D,
      cancelled30d: REVENUE_CANCELLED_30D,
      paymentFailed30d: 2,
      netNewSubs30d: NET_NEW_SUBS_30D,
      churnRatePct: round2((REVENUE_CANCELLED_30D / ACTIVE_SUBSCRIBERS) * 100),
      realGrossMarginPct: round2(((MRR_USD - TOTAL_COST_USD) / MRR_USD) * 100),
      cogsPerActiveUserUsd: round6(TOTAL_COST_USD / ACTIVE_SUBSCRIBERS),
    },
    funnel: {
      newInstalls30d: NEW_INSTALLS_30D,
      activeInstalls30d: MAU,
      paywallHits30d: PAYWALL_HITS_30D,
      upgrades30d: REVENUE_CREATED_30D,
      paywallToUpgradeRatePct: round2((REVENUE_CREATED_30D / Math.max(1, PAYWALL_HITS_30D)) * 100),
    },
    retention: {
      nextDayRetentionPct: 38.4,
      sevenDayRetentionPct: 22.1,
      returningSharePct: 61.3,
    },
    courseContext: {
      byTopic: BY_TOPIC,
      byCourseProfile: BY_COURSE_PROFILE,
      imageAttachment: IMAGE_ATTACHMENT,
      rPackagesCustomized: RPACKAGES_CUSTOMIZED,
      byRequestedPackage: BY_REQUESTED_PACKAGE,
    },
  };
}
