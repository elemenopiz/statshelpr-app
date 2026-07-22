/**
 * Self-test for the pure functions behind GET /api/metrics: cost calc,
 * histogram->percentile, and 30-day aggregation over mock buckets. There's
 * no vitest in this workspace (see apps/workers/package.json) — this is a
 * plain tsx script instead, run via:
 *
 *   pnpm --filter @statshelpr/api exec tsx ../workers/scripts/self-test-metrics.ts
 *
 * (reuses @statshelpr/api's tsx devDependency — same pattern as the repo's
 * `pnpm eval` script at the root package.json). Every function under test is
 * pure (no KV/Env/network access), so this needs nothing else running.
 *
 * Exit code is 0 if every check passes, 1 otherwise (CI-friendly).
 */

import { costUsdForUsage, DEFAULT_RATE, IMAGE_VISION_MODEL, MODEL_RATES, PRIMARY_TEXT_MODEL, rateForModel } from "../src/lib/cost";
import {
  addToHistogram,
  emptyHistogram,
  LATENCY_BUCKET_BOUNDARIES_MS,
  percentileFromHistogram,
} from "../src/lib/histogram";
import { aggregateMetrics } from "../src/lib/metrics-aggregate";
import { emptyBucket, type DailyMetricsBucket } from "../src/lib/metrics-store";

let pass = 0;
let fail = 0;

function approxEqual(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) <= eps;
}

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
console.log("cost.ts");

{
  const rate = MODEL_RATES[PRIMARY_TEXT_MODEL];
  check(`${PRIMARY_TEXT_MODEL} rate is seeded`, !!rate);
  if (rate) {
    const cost = costUsdForUsage(PRIMARY_TEXT_MODEL, {
      promptTokens: 1_000_000,
      completionTokens: 0,
      cachedTokens: 0,
    });
    check(
      "1M non-cached prompt tokens costs exactly inputPer1M",
      approxEqual(cost, rate.inputPer1M),
      `got ${cost}, want ${rate.inputPer1M}`,
    );
  }
}

{
  const textRate = rateForModel(PRIMARY_TEXT_MODEL);
  const imageRate = rateForModel(IMAGE_VISION_MODEL);
  const imagePricier = imageRate.inputPer1M > textRate.inputPer1M && imageRate.outputPer1M > textRate.outputPer1M;
  check(`${IMAGE_VISION_MODEL} rate is seeded and pricier than ${PRIMARY_TEXT_MODEL}`, imagePricier);
}

{
  // 500k prompt tokens, half of them cached, plus 100k completion tokens.
  const rate = rateForModel(IMAGE_VISION_MODEL);
  const cost = costUsdForUsage(IMAGE_VISION_MODEL, {
    promptTokens: 500_000,
    completionTokens: 100_000,
    cachedTokens: 250_000,
  });
  const expected =
    (250_000 / 1_000_000) * rate.inputPer1M +
    (100_000 / 1_000_000) * rate.outputPer1M +
    (250_000 / 1_000_000) * rate.cachedInputPer1M;
  check(
    "cached tokens billed at cachedInputPer1M, not double-counted",
    approxEqual(cost, expected),
    `got ${cost}, want ${expected}`,
  );
}

{
  const cost = costUsdForUsage("some-unknown-future-model", {
    promptTokens: 1_000_000,
    completionTokens: 0,
    cachedTokens: 0,
  });
  check("unknown model id falls back to DEFAULT_RATE", approxEqual(cost, DEFAULT_RATE.inputPer1M), `got ${cost}`);
}

{
  const cost = costUsdForUsage(PRIMARY_TEXT_MODEL, { promptTokens: 0, completionTokens: 0, cachedTokens: 0 });
  check("zero usage costs exactly 0", cost === 0, `got ${cost}`);
}

{
  // cachedTokens > promptTokens shouldn't go negative / NaN — defensive clamp.
  const cost = costUsdForUsage(PRIMARY_TEXT_MODEL, { promptTokens: 10, completionTokens: 0, cachedTokens: 999 });
  check("cachedTokens > promptTokens doesn't produce NaN/negative", Number.isFinite(cost) && cost >= 0, `got ${cost}`);
}

// ---------------------------------------------------------------------------
console.log("histogram.ts");

{
  const hist = emptyHistogram();
  for (let i = 0; i < 10; i++) addToHistogram(hist, LATENCY_BUCKET_BOUNDARIES_MS, 100); // all in bucket 0 [0,250)
  const p50 = percentileFromHistogram(hist, LATENCY_BUCKET_BOUNDARIES_MS, 0.5);
  check("p50 of a single-bucket distribution lands within that bucket", p50 >= 0 && p50 < 250, `got ${p50}`);
}

{
  const hist = emptyHistogram();
  check(
    "empty histogram percentile is 0, not NaN/throw",
    percentileFromHistogram(hist, LATENCY_BUCKET_BOUNDARIES_MS, 0.5) === 0,
  );
}

{
  const hist = emptyHistogram();
  // 10 values at each bucket's lower edge, spread across all 9 buckets.
  for (let i = 0; i < LATENCY_BUCKET_BOUNDARIES_MS.length; i++) {
    const lower = LATENCY_BUCKET_BOUNDARIES_MS[i] ?? 0;
    for (let j = 0; j < 10; j++) addToHistogram(hist, LATENCY_BUCKET_BOUNDARIES_MS, lower);
  }
  const p95 = percentileFromHistogram(hist, LATENCY_BUCKET_BOUNDARIES_MS, 0.95);
  check("p95 of a spread distribution lands in the top bucket (>= 16000)", p95 >= 16000, `got ${p95}`);
}

{
  const hist = emptyHistogram();
  addToHistogram(hist, LATENCY_BUCKET_BOUNDARIES_MS, 999_999); // way past the last boundary
  const p50 = percentileFromHistogram(hist, LATENCY_BUCKET_BOUNDARIES_MS, 0.5);
  check("overflow bucket returns its lower edge (documented underestimate), not +inf/NaN", p50 === 32000, `got ${p50}`);
}

// ---------------------------------------------------------------------------
console.log("metrics-aggregate.ts (30-day aggregation over mock buckets)");

function mockBucket(date: string, overrides: { server?: object; client?: object; installHashes?: string[] }): DailyMetricsBucket {
  const b = emptyBucket(date);
  return {
    ...b,
    ...overrides,
    server: { ...b.server, ...overrides.server },
    client: { ...b.client, ...overrides.client },
  } as DailyMetricsBucket;
}

{
  // Two days of data: mixed text/image model calls, one shared install hash
  // (dedup check) plus one unique hash per day.
  const day0 = mockBucket("2026-07-22", {
    server: {
      ...emptyBucket("x").server,
      routes: { solve: { attempts: 10, successes: 9, errors: 1 }, interpret: { attempts: 4, successes: 4, errors: 0 } },
      modeSplit: { concept: 6, calc: 4 },
      confidence: { High: 5, Med: 1, Low: 0, "": 0 },
      costUsd: 0.02,
      costUsdByMode: { concept: 0.01, calc: 0.01 },
      byModel: {
        [PRIMARY_TEXT_MODEL]: { calls: 12, costUsd: 0.015 },
        [IMAGE_VISION_MODEL]: { calls: 2, costUsd: 0.005 },
      },
    },
    client: {
      byQuestionType: { multiple_choice_question: 5 },
      writeBackByOutcome: { written: 8, nowrite: 1, error: 1 },
      latencyHistogram: emptyHistogram(),
    },
    installHashes: ["hashA", "hashB"],
  });
  const day1 = mockBucket("2026-07-21", {
    server: {
      ...emptyBucket("x").server,
      routes: { solve: { attempts: 5, successes: 5, errors: 0 }, interpret: { attempts: 2, successes: 2, errors: 0 } },
      modeSplit: { concept: 3, calc: 2 },
      confidence: { High: 2, Med: 1, Low: 0, "": 0 },
      costUsd: 0.01,
      costUsdByMode: { concept: 0.006, calc: 0.004 },
      byModel: {
        [PRIMARY_TEXT_MODEL]: { calls: 7, costUsd: 0.01 },
      },
    },
    client: {
      byQuestionType: { true_false_question: 2 },
      writeBackByOutcome: { written: 4, nowrite: 1, error: 0 },
      latencyHistogram: emptyHistogram(),
    },
    installHashes: ["hashA", "hashC"], // hashA repeats -- must NOT double-count in WAU
  });

  const dates = ["2026-07-22", "2026-07-21"]; // most-recent-first
  const buckets = [day0, day1];

  const result = aggregateMetrics({
    now: 1_753_142_400_000,
    days: 2,
    dates,
    buckets,
    priceMonthlyUsd: 15,
    assumedSolvesPerUserPerMonth: 40,
  });

  check("questionsAnswered sums solve attempts across days", result.volume.questionsAnswered === 15, `got ${result.volume.questionsAnswered}`);
  check("apiCalls sums solve+interpret attempts across days", result.volume.apiCalls === 21, `got ${result.volume.apiCalls}`);
  check("dau counts only the most-recent day's install hashes", result.volume.dau === 2, `got ${result.volume.dau}`);
  check("wau dedupes install hashes across days (hashA counted once)", result.volume.wau === 3, `got ${result.volume.wau}`);
  check(
    "daily array is oldest-to-newest",
    result.volume.daily[0]?.date === "2026-07-21" && result.volume.daily[1]?.date === "2026-07-22",
    JSON.stringify(result.volume.daily),
  );
  check(
    "byQuestionType merges across days",
    result.volume.byQuestionType["multiple_choice_question"] === 5 && result.volume.byQuestionType["true_false_question"] === 2,
  );

  const expectedSolveSuccessRate = (9 + 4 + 5 + 2) / (10 + 4 + 5 + 2);
  check(
    "solveSuccessRate = (solve+interpret successes)/(solve+interpret attempts)",
    approxEqual(result.quality.solveSuccessRate, expectedSolveSuccessRate, 1e-4),
    `got ${result.quality.solveSuccessRate}, want ${expectedSolveSuccessRate}`,
  );

  const expectedWriteBackRate = (8 + 4) / (8 + 1 + 1 + 4 + 1);
  check(
    "writeBackSuccessRate = written/(written+nowrite+error)",
    approxEqual(result.quality.writeBackSuccessRate, expectedWriteBackRate, 1e-4),
    `got ${result.quality.writeBackSuccessRate}, want ${expectedWriteBackRate}`,
  );

  check(
    "modeSplit sums across days",
    result.quality.modeSplit.concept === 9 && result.quality.modeSplit.calc === 6,
    JSON.stringify(result.quality.modeSplit),
  );
  check("webrUsage aliases modeSplit.calc", result.quality.webrUsage === result.quality.modeSplit.calc);
  check(
    "confidence sums across days",
    result.quality.confidence.High === 7 && result.quality.confidence.Med === 2,
    JSON.stringify(result.quality.confidence),
  );

  check(
    "economics.model is the fixed primary text model, not dynamically chosen",
    result.economics.model === PRIMARY_TEXT_MODEL,
    `got ${result.economics.model}`,
  );
  check(
    "economics.rates matches the primary text model's rate",
    approxEqual(result.economics.rates.inputPer1M, rateForModel(PRIMARY_TEXT_MODEL).inputPer1M),
  );
  check("economics.totalCostUsd sums across days", approxEqual(result.economics.totalCostUsd, 0.03), `got ${result.economics.totalCostUsd}`);

  check(
    "economics.modelsUsed merges per-model calls across days",
    result.economics.modelsUsed[PRIMARY_TEXT_MODEL]?.calls === 19 && result.economics.modelsUsed[IMAGE_VISION_MODEL]?.calls === 2,
    JSON.stringify(result.economics.modelsUsed),
  );
  check(
    "economics.modelsUsed merges per-model cost across days",
    approxEqual(result.economics.modelsUsed[PRIMARY_TEXT_MODEL]?.costUsd ?? -1, 0.025, 1e-6) &&
      approxEqual(result.economics.modelsUsed[IMAGE_VISION_MODEL]?.costUsd ?? -1, 0.005, 1e-6),
    JSON.stringify(result.economics.modelsUsed),
  );

  const expectedAvgCost = 0.03 / 15;
  check(
    "avgCostPerQuestionUsd = totalCost/questionsAnswered",
    approxEqual(result.economics.avgCostPerQuestionUsd, expectedAvgCost, 1e-6),
    `got ${result.economics.avgCostPerQuestionUsd}, want ${expectedAvgCost}`,
  );
  const expectedAvgCalcCost = (0.01 + 0.004) / (4 + 2); // costUsdByMode.calc / modeSplit.calc
  check(
    "avgCostPerCalcQuestionUsd = costUsdByMode.calc/modeSplit.calc",
    approxEqual(result.economics.avgCostPerCalcQuestionUsd, expectedAvgCalcCost, 1e-6),
    `got ${result.economics.avgCostPerCalcQuestionUsd}, want ${expectedAvgCalcCost}`,
  );
  const expectedBreakEven = 15 / expectedAvgCost;
  check(
    "breakEvenQuestionsPerUser = priceMonthly/avgCostPerQuestion",
    approxEqual(result.economics.breakEvenQuestionsPerUser, expectedBreakEven, 1e-2),
    `got ${result.economics.breakEvenQuestionsPerUser}, want ${expectedBreakEven}`,
  );
  const expectedMargin = ((15 - expectedAvgCost * 40) / 15) * 100;
  check(
    "grossMarginPerUserPct matches the pinned formula",
    approxEqual(result.economics.grossMarginPerUserPct, expectedMargin, 1e-2),
    `got ${result.economics.grossMarginPerUserPct}, want ${expectedMargin}`,
  );
}

{
  // All-empty buckets: every ratio must degrade to 0 (or the mathematically
  // correct limit), never NaN/Infinity.
  const dates = ["2026-07-22"];
  const buckets = [emptyBucket("2026-07-22")];
  const result = aggregateMetrics({ now: Date.now(), days: 1, dates, buckets, priceMonthlyUsd: 15, assumedSolvesPerUserPerMonth: 110 });

  check("empty range: solveSuccessRate is 0, not NaN", result.quality.solveSuccessRate === 0);
  check("empty range: writeBackSuccessRate is 0, not NaN", result.quality.writeBackSuccessRate === 0);
  check("empty range: avgCostPerQuestionUsd is 0, not NaN/Infinity", result.economics.avgCostPerQuestionUsd === 0);
  check("empty range: avgCostPerCalcQuestionUsd is 0, not NaN/Infinity", result.economics.avgCostPerCalcQuestionUsd === 0);
  check("empty range: breakEvenQuestionsPerUser is 0, not Infinity", result.economics.breakEvenQuestionsPerUser === 0);
  check(
    "empty range: grossMarginPerUserPct is 100 (no cost incurred)",
    approxEqual(result.economics.grossMarginPerUserPct, 100),
    `got ${result.economics.grossMarginPerUserPct}`,
  );
  check(
    "empty range: economics.model is still the fixed primary text model",
    result.economics.model === PRIMARY_TEXT_MODEL,
    `got ${result.economics.model}`,
  );
  check(
    "empty range: economics.modelsUsed is empty (no calls recorded)",
    Object.keys(result.economics.modelsUsed).length === 0,
    JSON.stringify(result.economics.modelsUsed),
  );
  check("empty range: dau/wau are 0", result.volume.dau === 0 && result.volume.wau === 0);
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
