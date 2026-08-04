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
import {
  addHostHash,
  applyRequestFacts,
  applyRRunnerEvent,
  applyServerEvent,
  emptyBucket,
  HOST_HASH_OTHER,
  normalizeBucket,
  type DailyMetricsBucket,
  type RequestFacts,
  type ServerEventInput,
} from "../src/lib/metrics-store";
import { classifyError } from "../src/lib/classify-error";
import { computeCohorts, type CohortDay } from "../src/lib/cohort";
import { extractCanvasHost, hashBucket } from "../src/lib/rate-limit";
import { UTEXAS_HOST_HASH } from "../src/lib/dashboard-render";

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
console.log("metrics-store.ts (missingRPackages: normalize + apply)");

{
  // normalizeBucket: a bucket written by an OLDER schema version (before
  // missingRPackages existed) must backfill to {}, not throw/return
  // undefined -- the exact defensive-backfill guarantee normalizeBucket's
  // own doc comment describes ("protects reads against a bucket written by
  // an older/newer version of this schema").
  const legacyRaw = { date: "2026-08-01", server: { rRunner: { requestCount: 3 } }, client: {} };
  const normalized = normalizeBucket(legacyRaw, "2026-08-01");
  check(
    "normalizeBucket backfills missing missingRPackages to {} on an old-schema bucket",
    typeof normalized.server.missingRPackages === "object" &&
      Object.keys(normalized.server.missingRPackages).length === 0,
    JSON.stringify(normalized.server.missingRPackages),
  );
}

{
  // normalizeBucket: a well-formed record passes through untouched.
  const raw = { date: "2026-08-01", server: { missingRPackages: { MatchIt: 3, effectsize: 1 } }, client: {} };
  const normalized = normalizeBucket(raw, "2026-08-01");
  check(
    "normalizeBucket passes through a well-formed missingRPackages record",
    normalized.server.missingRPackages["MatchIt"] === 3 && normalized.server.missingRPackages["effectsize"] === 1,
    JSON.stringify(normalized.server.missingRPackages),
  );
}

{
  // normalizeBucket: malformed (non-object) input degrades to {}, matching
  // okCountRecord's guard for every other Record<string, number> field on
  // this bucket (byErrorType, byFailure, ...).
  const raw = { date: "2026-08-01", server: { missingRPackages: "not an object" }, client: {} };
  const normalized = normalizeBucket(raw, "2026-08-01");
  check(
    "normalizeBucket degrades a malformed missingRPackages to {}, not a throw",
    Object.keys(normalized.server.missingRPackages).length === 0,
    JSON.stringify(normalized.server.missingRPackages),
  );
}

{
  // applyRRunnerEvent: a valid package name is recorded, and repeat
  // occurrences of the SAME name across separate calls increment rather
  // than being treated as a second distinct entry.
  const bucket = emptyBucket("2026-08-01");
  applyRRunnerEvent(bucket, { success: true, durationMs: 1200, missingPackages: ["MatchIt"] });
  applyRRunnerEvent(bucket, { success: true, durationMs: 900, missingPackages: ["MatchIt", "effectsize"] });
  check(
    "applyRRunnerEvent counts repeat occurrences of the same name",
    bucket.server.missingRPackages["MatchIt"] === 2,
    JSON.stringify(bucket.server.missingRPackages),
  );
  check(
    "applyRRunnerEvent records a second distinct valid name",
    bucket.server.missingRPackages["effectsize"] === 1,
    JSON.stringify(bucket.server.missingRPackages),
  );
  check(
    "applyRRunnerEvent still drives rRunner.requestCount/successCount as before",
    bucket.server.rRunner.requestCount === 2 && bucket.server.rRunner.successCount === 2,
  );
}

{
  // applyRRunnerEvent: names violating the R package grammar
  // (^[A-Za-z][A-Za-z0-9.]{0,40}$) are dropped outright -- the
  // security-critical sanitize path (this repo has already hit one
  // client-string-poisoning incident from an unsanitized model-name field,
  // hence the explicit "gemini-9.9-ultra-pro"-shaped case below).
  const bucket = emptyBucket("2026-08-01");
  applyRRunnerEvent(bucket, {
    success: true,
    missingPackages: [
      "gemini-9.9-ultra-pro", // hyphens -- the exact junk-model-row shape
      "123abc", // must start with a letter
      "", // empty
      "a".repeat(42), // one past the 41-char bound
      "<script>alert(1)</script>",
      "rm -rf /",
    ],
  });
  check(
    "applyRRunnerEvent drops every grammar-invalid candidate name",
    Object.keys(bucket.server.missingRPackages).length === 0,
    JSON.stringify(bucket.server.missingRPackages),
  );
}

{
  // applyRRunnerEvent: a name right AT the 41-char bound (1 letter + 40
  // letters/digits/dots) is accepted -- the boundary the {0,40} quantifier
  // pins.
  const bucket = emptyBucket("2026-08-01");
  const name41 = "a".repeat(41);
  applyRRunnerEvent(bucket, { success: true, missingPackages: [name41] });
  check("applyRRunnerEvent accepts a name exactly at the 41-char bound", bucket.server.missingRPackages[name41] === 1);
}

{
  // applyRRunnerEvent: the per-day DISTINCT-name cap (20) blocks brand-new
  // names once reached, but an existing name keeps incrementing past it --
  // mirrors addInstallHash's documented undercount tradeoff.
  const bucket = emptyBucket("2026-08-01");
  for (let i = 0; i < 25; i++) {
    applyRRunnerEvent(bucket, { success: true, missingPackages: [`pkg${i}`] });
  }
  const distinctCount = Object.keys(bucket.server.missingRPackages).length;
  check("applyRRunnerEvent caps distinct names at 20/day", distinctCount === 20, `got ${distinctCount}`);
  check(
    "applyRRunnerEvent keeps the first-seen 20 distinct names, dropping the rest",
    bucket.server.missingRPackages["pkg0"] === 1 &&
      bucket.server.missingRPackages["pkg19"] === 1 &&
      bucket.server.missingRPackages["pkg20"] === undefined,
    JSON.stringify(bucket.server.missingRPackages),
  );

  // A 26th event for an ALREADY-recorded name still increments -- the cap
  // only blocks brand-new keys, never repeat occurrences of existing ones.
  applyRRunnerEvent(bucket, { success: true, missingPackages: ["pkg5"] });
  check(
    "applyRRunnerEvent still increments an existing name after the cap is reached",
    bucket.server.missingRPackages["pkg5"] === 2,
    `got ${bucket.server.missingRPackages["pkg5"]}`,
  );
}

{
  // applyRRunnerEvent: missingPackages on a FAILURE event is ignored --
  // matches routes/solve.ts's recordRRunnerFailure, which never has R
  // output to extract from (runRRemote threw before any RunRResult existed).
  const bucket = emptyBucket("2026-08-01");
  applyRRunnerEvent(bucket, { success: false, missingPackages: ["MatchIt"] });
  check(
    "applyRRunnerEvent ignores missingPackages when success is false",
    Object.keys(bucket.server.missingRPackages).length === 0,
    JSON.stringify(bucket.server.missingRPackages),
  );
  check("applyRRunnerEvent still counts the failure in rRunner.errorCount", bucket.server.rRunner.errorCount === 1);
}

// ---------------------------------------------------------------------------
console.log("metrics-aggregate.ts (30-day aggregation over mock buckets)");

function mockBucket(
  date: string,
  overrides: { server?: object; client?: object; installHashes?: string[]; paywallHits?: number; revenue?: object },
): DailyMetricsBucket {
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
console.log("metrics-aggregate.ts (dashboard-v2 enriched fields)");

{
  // One rich day exercising every dashboard-v2 aggregate: error classes,
  // calc-path confidence, per-type write-back rates, token/cache economics,
  // image share, and the real-revenue/funnel blocks (activeSubscribers = 4).
  const day = mockBucket("2026-07-22", {
    server: {
      ...emptyBucket("x").server,
      routes: { solve: { attempts: 10, successes: 8, errors: 2 }, interpret: { attempts: 5, successes: 4, errors: 1 } },
      modeSplit: { concept: 6, calc: 4 },
      confidence: { High: 4, Med: 2, Low: 0, "": 0 },
      confidenceCalc: { High: 3, Med: 1, Low: 1, "": 0 },
      byErrorType: { quota: 2, upstream: 1 },
      missingRPackages: { car: 2, psych: 1 },
      tokens: { promptTokens: 1_000_000, completionTokens: 200_000, cachedTokens: 400_000 },
      costUsd: 0.5,
      costUsdByMode: { concept: 0.25, calc: 0.25 },
      byModel: {
        [PRIMARY_TEXT_MODEL]: { calls: 12, costUsd: 0.3 },
        [IMAGE_VISION_MODEL]: { calls: 3, costUsd: 0.2 },
      },
    },
    client: {
      ...emptyBucket("x").client,
      byQuestionType: { multiple_choice_question: 10, essay_question: 2 },
      writeBackByOutcome: { written: 8, nowrite: 1, error: 3 },
      writeBackByQuestionType: {
        multiple_choice_question: { written: 8, nowrite: 1, error: 1 },
        essay_question: { written: 0, nowrite: 0, error: 2 },
      },
    },
    installHashes: ["h1", "h2", "h3"],
    paywallHits: 5,
    revenue: { created: 3, cancelled: 1, paymentFailed: 1 },
  });

  const result = aggregateMetrics({
    now: 1_753_142_400_000,
    days: 1,
    dates: ["2026-07-22"],
    buckets: [day],
    priceMonthlyUsd: 15,
    assumedSolvesPerUserPerMonth: 110,
    activeSubscribers: 4,
  });

  // item 2: error classification
  check("errorsTotal sums solve+interpret errors", result.quality.errorsTotal === 3, `got ${result.quality.errorsTotal}`);
  check(
    "byErrorType passes through per-class counts",
    result.quality.byErrorType["quota"] === 2 && result.quality.byErrorType["upstream"] === 1,
    JSON.stringify(result.quality.byErrorType),
  );

  // R-runner health: missingRPackages merges the same way byErrorType does
  // (single-day passthrough here; the earlier "metrics-store.ts" section
  // covers the sanitize+cap logic that runs BEFORE anything reaches this
  // aggregation step).
  check(
    "rRunner.missingRPackages passes through per-package counts",
    result.rRunner.missingRPackages["car"] === 2 && result.rRunner.missingRPackages["psych"] === 1,
    JSON.stringify(result.rRunner.missingRPackages),
  );

  // item 16: calc-path confidence, kept separate from concept confidence
  check(
    "confidenceCalc tracked separately",
    result.quality.confidenceCalc.High === 3 && result.quality.confidenceCalc.Med === 1 && result.quality.confidenceCalc.Low === 1,
    JSON.stringify(result.quality.confidenceCalc),
  );
  check(
    "concept confidence unaffected by calc confidence",
    result.quality.confidence.High === 4 && result.quality.confidence.Med === 2,
    JSON.stringify(result.quality.confidence),
  );

  // item 4: per-question-type write-back rate
  check(
    "writeBackByQuestionType rate = written/(written+nowrite+error)",
    approxEqual(result.quality.writeBackByQuestionType["multiple_choice_question"]?.writeBackRate ?? -1, 0.8, 1e-9) &&
      (result.quality.writeBackByQuestionType["essay_question"]?.writeBackRate ?? -1) === 0,
    JSON.stringify(result.quality.writeBackByQuestionType),
  );

  // item 1: token/cache economics
  check("cacheHitRate = cachedTokens/promptTokens", approxEqual(result.economics.cacheHitRate, 0.4, 1e-9), `got ${result.economics.cacheHitRate}`);
  check("tokensPerQuestion = (prompt+completion)/questions", result.economics.tokensPerQuestion === 120000, `got ${result.economics.tokensPerQuestion}`);
  check("inputOutputRatio = prompt/completion", approxEqual(result.economics.inputOutputRatio, 5, 1e-9), `got ${result.economics.inputOutputRatio}`);

  // item 3: image/vision share
  check("imageCalls = vision-model calls", result.economics.imageCalls === 3, `got ${result.economics.imageCalls}`);
  check("imageCallSharePct = imageCalls/apiCalls*100", approxEqual(result.economics.imageCallSharePct, 20, 1e-9), `got ${result.economics.imageCallSharePct}`);
  check("imageCostSharePct = imageCost/totalCost*100", approxEqual(result.economics.imageCostSharePct, 40, 1e-9), `got ${result.economics.imageCostSharePct}`);

  // items 6 & 9: real revenue given activeSubscribers
  check("revenue.mrrUsd = activeSubscribers*price", approxEqual(result.revenue.mrrUsd, 60, 1e-9), `got ${result.revenue.mrrUsd}`);
  check("revenue.arpuUsd = mrr/activeSubscribers", approxEqual(result.revenue.arpuUsd, 15, 1e-9), `got ${result.revenue.arpuUsd}`);
  check("revenue.netNewSubs30d = created-cancelled", result.revenue.netNewSubs30d === 2, `got ${result.revenue.netNewSubs30d}`);
  check("revenue.churnRatePct = cancelled/active*100", approxEqual(result.revenue.churnRatePct ?? -1, 25, 1e-9), `got ${result.revenue.churnRatePct}`);
  check(
    "revenue.realGrossMarginPct = (mrr-cost)/mrr*100",
    approxEqual(result.revenue.realGrossMarginPct ?? -1, 99.17, 1e-9),
    `got ${result.revenue.realGrossMarginPct}`,
  );
  check(
    "revenue.cogsPerActiveUserUsd = totalCost/active",
    approxEqual(result.revenue.cogsPerActiveUserUsd ?? -1, 0.125, 1e-9),
    `got ${result.revenue.cogsPerActiveUserUsd}`,
  );

  // item 7: funnel
  check("funnel.paywallHits30d sums paywall hits", result.funnel.paywallHits30d === 5, `got ${result.funnel.paywallHits30d}`);
  check("funnel.upgrades30d = created", result.funnel.upgrades30d === 3, `got ${result.funnel.upgrades30d}`);
  check(
    "funnel.paywallToUpgradeRatePct = created/paywallHits*100",
    approxEqual(result.funnel.paywallToUpgradeRatePct ?? -1, 60, 1e-9),
    `got ${result.funnel.paywallToUpgradeRatePct}`,
  );
}

{
  // Revenue/funnel must degrade to null (never NaN) with no subs / no paywall.
  const result = aggregateMetrics({
    now: Date.now(),
    days: 1,
    dates: ["2026-07-22"],
    buckets: [emptyBucket("2026-07-22")],
    priceMonthlyUsd: 15,
    assumedSolvesPerUserPerMonth: 110,
  });
  check("no activeSubscribers: mrr/arpu are 0", result.revenue.mrrUsd === 0 && result.revenue.arpuUsd === 0);
  check("no activeSubscribers: churnRatePct null", result.revenue.churnRatePct === null);
  check("no activeSubscribers: realGrossMarginPct null", result.revenue.realGrossMarginPct === null);
  check("no activeSubscribers: cogsPerActiveUserUsd null", result.revenue.cogsPerActiveUserUsd === null);
  check("no paywall hits: paywallToUpgradeRatePct null", result.funnel.paywallToUpgradeRatePct === null);
}

// ---------------------------------------------------------------------------
console.log("metrics-store.ts (course-topic: byTopic/byCourseProfile/behavioral counters)");

{
  // applyServerEvent's byTopic whitelist (safeTopicKey) — exercised directly
  // against a fresh bucket, no KV mock needed (see applyServerEvent's export
  // doc comment). Covers: a real taxonomy member, the parser's "unknown"
  // fallback (must stay its OWN distinct key, not merged into "other"), and a
  // string that is neither (the defense-in-depth case the client-string-
  // poisoning incident this comment references was about — see
  // routes/telemetry.ts's VALID_FAILURES doc).
  const bucket = emptyBucket("2026-08-04");
  const baseEvent: Omit<ServerEventInput, "completedQuestion"> = {
    route: "solve",
    success: true,
    model: PRIMARY_TEXT_MODEL,
    promptTokens: 100,
    completionTokens: 50,
    cachedTokens: 0,
    costUsd: 0.001,
    serverLatencyMs: 900,
    installHash: "h1",
  };
  applyServerEvent(bucket, { ...baseEvent, completedQuestion: { mode: "concept", topic: "bootstrap" } });
  applyServerEvent(bucket, { ...baseEvent, completedQuestion: { mode: "concept", topic: "bootstrap" } });
  applyServerEvent(bucket, { ...baseEvent, completedQuestion: { mode: "concept", topic: "unknown" } });
  applyServerEvent(bucket, {
    ...baseEvent,
    completedQuestion: { mode: "concept", topic: "some-made-up-topic-that-does-not-exist" },
  });

  check("a real taxonomy member increments its OWN key", bucket.server.byTopic["bootstrap"] === 2, JSON.stringify(bucket.server.byTopic));
  check(
    "'unknown' (the parser's missing/invalid-line fallback) is kept as its OWN distinct key, not merged into 'other'",
    bucket.server.byTopic["unknown"] === 1,
    JSON.stringify(bucket.server.byTopic),
  );
  check(
    "a string that is neither a taxonomy member nor 'unknown' collapses to 'other' — NEVER becomes its own raw key",
    bucket.server.byTopic["other"] === 1 && bucket.server.byTopic["some-made-up-topic-that-does-not-exist"] === undefined,
    JSON.stringify(bucket.server.byTopic),
  );
  check("modeSplit still increments once per completedQuestion event, same as before this branch", bucket.server.modeSplit.concept === 4);
}

{
  // applyRequestFacts — the batch-level, once-per-request counters (Part 3 +
  // preset-package telemetry).
  const bucket = emptyBucket("2026-08-04");
  const facts1: RequestFacts = { courseProfile: "sta301", imageAttached: true, rPackagesCustomized: false };
  const facts2: RequestFacts = {
    courseProfile: "generic",
    imageAttached: false,
    rPackagesCustomized: true,
    requestedPackages: ["car", "lme4", "tidyverse"],
  };
  // Old-client request: no rPackagesCustomized field sent at all.
  const facts3: RequestFacts = { courseProfile: "sta301", imageAttached: false };

  applyRequestFacts(bucket, facts1);
  applyRequestFacts(bucket, facts2);
  applyRequestFacts(bucket, facts3);

  check(
    "byCourseProfile tallies sta301 vs generic",
    bucket.server.byCourseProfile.sta301 === 2 && bucket.server.byCourseProfile.generic === 1,
    JSON.stringify(bucket.server.byCourseProfile),
  );
  check(
    "imageAttachment tallies withImages vs withoutImages",
    bucket.server.imageAttachment.withImages === 1 && bucket.server.imageAttachment.withoutImages === 2,
    JSON.stringify(bucket.server.imageAttachment),
  );
  check(
    "rPackagesCustomized: an old-client request with the field absent counts toward NEITHER bucket",
    bucket.server.rPackagesCustomized.customized === 1 && bucket.server.rPackagesCustomized.default === 1,
    JSON.stringify(bucket.server.rPackagesCustomized),
  );
  check(
    "byRequestedPackage records every valid package name from facts2",
    bucket.server.byRequestedPackage["car"] === 1 &&
      bucket.server.byRequestedPackage["lme4"] === 1 &&
      bucket.server.byRequestedPackage["tidyverse"] === 1,
    JSON.stringify(bucket.server.byRequestedPackage),
  );
}

{
  // byRequestedPackage: server-side grammar re-validation (never trust the
  // client) + the REQUESTED_PACKAGE_CAP distinct-name ceiling.
  const bucket = emptyBucket("2026-08-04");
  applyRequestFacts(bucket, {
    courseProfile: "sta301",
    imageAttached: false,
    requestedPackages: ["car", "not a valid name", "-badstart", "a".repeat(50), "MASS"],
  });
  check(
    "grammar-invalid package names (spaces, bad leading char, too long) never become keys",
    bucket.server.byRequestedPackage["not a valid name"] === undefined &&
      bucket.server.byRequestedPackage["-badstart"] === undefined &&
      bucket.server.byRequestedPackage["a".repeat(50)] === undefined,
    JSON.stringify(bucket.server.byRequestedPackage),
  );
  check(
    "grammar-valid names (including a real capitalized package like MASS) DO become keys",
    bucket.server.byRequestedPackage["car"] === 1 && bucket.server.byRequestedPackage["MASS"] === 1,
    JSON.stringify(bucket.server.byRequestedPackage),
  );

  // Push 25 distinct valid names across separate requests — only the first
  // REQUESTED_PACKAGE_CAP (20) distinct names should ever get a key; the 2
  // that are already present (car, MASS) keep incrementing past the cap.
  for (let i = 0; i < 25; i++) {
    applyRequestFacts(bucket, { courseProfile: "sta301", imageAttached: false, requestedPackages: [`pkg${i}`] });
  }
  applyRequestFacts(bucket, { courseProfile: "sta301", imageAttached: false, requestedPackages: ["car"] }); // already-present key
  const distinctCount = Object.keys(bucket.server.byRequestedPackage).length;
  check(
    "distinct byRequestedPackage keys never exceed REQUESTED_PACKAGE_CAP (20), even across many requests",
    distinctCount <= 20,
    `got ${distinctCount} distinct keys: ${JSON.stringify(Object.keys(bucket.server.byRequestedPackage))}`,
  );
  check(
    "a key already under the cap keeps incrementing after the cap is reached",
    bucket.server.byRequestedPackage["car"] === 2,
    `got ${bucket.server.byRequestedPackage["car"]}`,
  );
}

{
  // metrics-aggregate.ts: byTopic/byCourseProfile/imageAttachment/
  // rPackagesCustomized/byRequestedPackage all sum correctly across days, and
  // normalizeBucket backfills them when reading an OLDER bucket that predates
  // this branch (no course-topic fields in the raw JSON at all).
  const day0 = emptyBucket("2026-08-04");
  day0.server.byTopic = { bootstrap: 3, unknown: 1 };
  day0.server.byCourseProfile = { sta301: 4, generic: 0 };
  day0.server.imageAttachment = { withImages: 1, withoutImages: 3 };
  day0.server.rPackagesCustomized = { customized: 1, default: 3 };
  day0.server.byRequestedPackage = { tidyverse: 2 };

  const day1 = emptyBucket("2026-08-03"); // pre-course-topic bucket: fields stay at emptyBucket's zero defaults

  const result = aggregateMetrics({
    now: Date.now(),
    days: 2,
    dates: ["2026-08-04", "2026-08-03"],
    buckets: [day0, day1],
    priceMonthlyUsd: 15,
    assumedSolvesPerUserPerMonth: 90,
  });

  check(
    "courseContext.byTopic sums across days",
    result.courseContext.byTopic["bootstrap"] === 3 && result.courseContext.byTopic["unknown"] === 1,
    JSON.stringify(result.courseContext.byTopic),
  );
  check(
    "courseContext.byCourseProfile sums across days",
    result.courseContext.byCourseProfile.sta301 === 4 && result.courseContext.byCourseProfile.generic === 0,
    JSON.stringify(result.courseContext.byCourseProfile),
  );
  check(
    "courseContext.imageAttachment sums across days",
    result.courseContext.imageAttachment.withImages === 1 && result.courseContext.imageAttachment.withoutImages === 3,
  );
  check(
    "courseContext.rPackagesCustomized sums across days",
    result.courseContext.rPackagesCustomized.customized === 1 && result.courseContext.rPackagesCustomized.default === 3,
  );
  check(
    "courseContext.byRequestedPackage sums across days",
    result.courseContext.byRequestedPackage["tidyverse"] === 2,
    JSON.stringify(result.courseContext.byRequestedPackage),
  );

  // normalizeBucket: a raw KV blob with NO course-topic fields at all (an
  // actual pre-branch bucket) must still normalize to safe empty defaults,
  // never throw/undefined.
  const preBranchRaw = JSON.parse(JSON.stringify(emptyBucket("2026-08-02")));
  delete preBranchRaw.server.byTopic;
  delete preBranchRaw.server.byCourseProfile;
  delete preBranchRaw.server.imageAttachment;
  delete preBranchRaw.server.rPackagesCustomized;
  delete preBranchRaw.server.byRequestedPackage;
  const normalized = normalizeBucket(preBranchRaw, "2026-08-02");
  check(
    "normalizeBucket backfills all 5 course-topic fields when reading a pre-branch bucket",
    JSON.stringify(normalized.server.byTopic) === "{}" &&
      normalized.server.byCourseProfile.sta301 === 0 &&
      normalized.server.imageAttachment.withImages === 0 &&
      normalized.server.rPackagesCustomized.customized === 0 &&
      JSON.stringify(normalized.server.byRequestedPackage) === "{}",
    JSON.stringify(normalized.server),
  );
}

// ---------------------------------------------------------------------------
console.log("cohort.ts (new installs + retention)");

{
  // A<->E installs across 4 days; current window = the last two days.
  //   07-01 [A,B]  07-02 [A,C]  07-03 [A,D]  07-04 [C,D,E]
  const days: CohortDay[] = [
    { date: "2026-07-01", installHashes: ["A", "B"] },
    { date: "2026-07-02", installHashes: ["A", "C"] },
    { date: "2026-07-03", installHashes: ["A", "D"] },
    { date: "2026-07-04", installHashes: ["C", "D", "E"] },
  ];
  const r = computeCohorts(days, new Set(["2026-07-03", "2026-07-04"]));

  check("newInstalls: oldest day counts all as new", r.newInstallsByDate["2026-07-01"] === 2, JSON.stringify(r.newInstallsByDate));
  check(
    "newInstalls: already-seen hashes are not new",
    r.newInstallsByDate["2026-07-02"] === 1 && r.newInstallsByDate["2026-07-03"] === 1 && r.newInstallsByDate["2026-07-04"] === 1,
    JSON.stringify(r.newInstallsByDate),
  );
  const currentNew = (r.newInstallsByDate["2026-07-03"] ?? 0) + (r.newInstallsByDate["2026-07-04"] ?? 0);
  check("current-window new-install total = 2 (D on 07-03, E on 07-04)", currentNew === 2, `got ${currentNew}`);

  // 07-01{A,B}: A back 07-02 -> .5 ; 07-02{C}: absent 07-03 -> 0 ; 07-03{D}: back 07-04 -> 1 ; avg = .5
  check("nextDayRetentionPct averages per-cohort next-day fractions", approxEqual(r.nextDayRetentionPct ?? -1, 50, 1e-9), `got ${r.nextDayRetentionPct}`);
  // 7-day: 07-01{A,B}->.5 ; 07-02{C}->1 (07-04) ; 07-03{D}->1 (07-04) ; avg = .8333
  check("sevenDayRetentionPct averages per-cohort 7-day fractions", approxEqual(r.sevenDayRetentionPct ?? -1, 83.33, 1e-9), `got ${r.sevenDayRetentionPct}`);
  // current actives {A,C,D,E} vs prior {A,B,C}: overlap {A,C} = 2/4
  check("returningSharePct = current actives also seen prior", approxEqual(r.returningSharePct ?? -1, 50, 1e-9), `got ${r.returningSharePct}`);
}

{
  const r = computeCohorts([], new Set<string>());
  check("empty cohorts: no new installs", Object.keys(r.newInstallsByDate).length === 0);
  check(
    "empty cohorts: retention all null",
    r.nextDayRetentionPct === null && r.sevenDayRetentionPct === null && r.returningSharePct === null,
  );
}

// ---------------------------------------------------------------------------
console.log("classify-error.ts");

check("credit-balance message -> quota", classifyError({ message: "Your credit balance is too low" }) === "quota");
check("resource-exhausted message -> quota", classifyError({ message: "Gemini resource exhausted" }) === "quota");
check("status 401 -> auth", classifyError({ status: 401 }) === "auth");
check("status 403 -> auth", classifyError({ status: 403 }) === "auth");
check("status 429 -> rate_limit", classifyError({ status: 429 }) === "rate_limit");
check("timeout message -> timeout", classifyError({ message: "socket timeout" }) === "timeout");
check("aborted message -> timeout", classifyError({ message: "The operation was aborted" }) === "timeout");
check("AbortError name -> timeout", classifyError({ name: "AbortError", message: "boom" }) === "timeout");
check("status 400 -> bad_input", classifyError({ status: 400 }) === "bad_input");
check("other status -> upstream", classifyError({ status: 503 }) === "upstream");
check("no signal -> unknown", classifyError({ message: "weird failure" }) === "unknown");
check("null -> unknown", classifyError(null) === "unknown");
check("Error instance reads its message", classifyError(new Error("quota exceeded")) === "quota");
check("quota regex wins over a 429 status", classifyError({ status: 429, message: "quota exhausted" }) === "quota");

// ---------------------------------------------------------------------------
console.log("lib/rate-limit.ts (extractCanvasHost — host-telemetry origin validation)");

// --- accept cases ---
check(
  "accepts a plain school subdomain",
  extractCanvasHost("https://utexas.instructure.com") === "utexas.instructure.com",
);
check(
  "lowercases before matching (mixed-case Origin)",
  extractCanvasHost("https://UTexas.Instructure.COM") === "utexas.instructure.com",
);
check(
  "accepts hyphenated/numeric school ids",
  extractCanvasHost("https://some-school-2.instructure.com") === "some-school-2.instructure.com",
);
check(
  "accepts a single-character school id (lower length bound)",
  extractCanvasHost("https://a.instructure.com") === "a.instructure.com",
);

// --- reject cases -> caller must fall back to HOST_HASH_OTHER, never the raw string ---
check("rejects a missing Origin (undefined)", extractCanvasHost(undefined) === null);
check("rejects a missing Origin (null)", extractCanvasHost(null) === null);
check("rejects an empty Origin", extractCanvasHost("") === null);
check("rejects http (not https)", extractCanvasHost("http://utexas.instructure.com") === null);
check("rejects a path suffix", extractCanvasHost("https://utexas.instructure.com/courses/1") === null);
check("rejects a bare trailing slash", extractCanvasHost("https://utexas.instructure.com/") === null);
check("rejects an unrelated domain", extractCanvasHost("https://evil.com") === null);
check(
  "rejects an instructure.com-lookalike suffix attack",
  extractCanvasHost("https://utexas.instructure.com.evil.com") === null,
);
check(
  "rejects instructure.com prefixed as a path on another host",
  extractCanvasHost("https://evil.com/utexas.instructure.com") === null,
);
check("rejects a multi-level Canvas subdomain", extractCanvasHost("https://sub.utexas.instructure.com") === null);
check("rejects an explicit port", extractCanvasHost("https://utexas.instructure.com:443") === null);
check(
  "rejects an oversized school-id label (past the 63-char DNS bound)",
  extractCanvasHost(`https://${"a".repeat(64)}.instructure.com`) === null,
);
check(
  "rejects a giant garbage Origin without throwing (length cap holds)",
  (() => {
    try {
      return extractCanvasHost(`https://${"a".repeat(100_000)}.instructure.com`) === null;
    } catch {
      return false;
    }
  })(),
);

// ---------------------------------------------------------------------------
console.log("lib/metrics-store.ts (hostHashCounts — cap enforcement + normalize round-trip)");

{
  // cap enforcement: the 51st distinct key is dropped; an EXISTING key keeps
  // incrementing past the cap (a popular school must never freeze).
  const b = emptyBucket("2026-08-04");
  for (let i = 0; i < 60; i++) addHostHash(b, `hash-${i}`);
  check(
    "hostHashCounts caps at 50 distinct keys/day",
    Object.keys(b.hostHashCounts).length === 50,
    `got ${Object.keys(b.hostHashCounts).length}`,
  );
  check("the first 50 keys were kept (insertion order)", b.hostHashCounts["hash-0"] === 1 && b.hostHashCounts["hash-49"] === 1);
  check("the 51st+ keys were dropped", b.hostHashCounts["hash-50"] === undefined && b.hostHashCounts["hash-59"] === undefined);

  addHostHash(b, "hash-0"); // an EXISTING key, added before the cap was hit
  check("an existing key still increments past the cap", b.hostHashCounts["hash-0"] === 2, `got ${b.hostHashCounts["hash-0"]}`);

  addHostHash(b, "hash-999"); // a brand-new key after the cap is already full
  check("a brand-new key past the cap is dropped, not added", b.hostHashCounts["hash-999"] === undefined);
  check("cap stays at exactly 50 keys after both calls above", Object.keys(b.hostHashCounts).length === 50);
}

{
  // undefined key is a safe no-op — defensive; every real caller always
  // supplies HOST_HASH_OTHER or a real hash, never "".
  const b = emptyBucket("2026-08-04");
  addHostHash(b, undefined);
  check("addHostHash(undefined) is a no-op", Object.keys(b.hostHashCounts).length === 0);
}

{
  // normalize round-trip: counts survive a JSON-serialize -> normalizeBucket
  // pass unchanged (simulates a real KV get/put cycle).
  const b = emptyBucket("2026-08-04");
  addHostHash(b, UTEXAS_HOST_HASH);
  addHostHash(b, UTEXAS_HOST_HASH);
  addHostHash(b, HOST_HASH_OTHER);
  const roundTripped = normalizeBucket(JSON.parse(JSON.stringify(b)), "2026-08-04");
  check(
    "hostHashCounts normalize round-trip preserves per-key counts",
    roundTripped.hostHashCounts[UTEXAS_HOST_HASH] === 2 && roundTripped.hostHashCounts[HOST_HASH_OTHER] === 1,
    JSON.stringify(roundTripped.hostHashCounts),
  );
}

{
  // a bucket written by an OLDER schema version (predates this field
  // entirely) must default to {}, not throw or return undefined.
  const legacy = normalizeBucket({ date: "2026-08-04" }, "2026-08-04");
  check(
    "normalizeBucket defaults a missing hostHashCounts to {} (pre-existing bucket)",
    typeof legacy.hostHashCounts === "object" && Object.keys(legacy.hostHashCounts).length === 0,
  );
}

{
  // corrupt/non-object hostHashCounts (KV corruption, or a bad manual edit)
  // must also default to {}, matching okCountRecord's contract for every
  // other Record<string, number> field in this bucket.
  const corrupt = normalizeBucket({ date: "2026-08-04", hostHashCounts: "not-an-object" }, "2026-08-04");
  check("normalizeBucket defaults a corrupt hostHashCounts to {}", Object.keys(corrupt.hostHashCounts).length === 0);
}

// ---------------------------------------------------------------------------
// This is the one async check in the file — placed LAST, after every
// synchronous check above has already run, so a single top-level `await`
// here (apps/workers is an ESM package, "type": "module") only delays the
// final summary below, never reorders anything. hashBucket is the sole
// async primitive host-telemetry depends on (crypto.subtle.digest), and this
// is the guard against dashboard-render.ts's hardcoded UTEXAS_HOST_HASH
// silently drifting from what hashBucket() would actually compute.
console.log("lib/rate-limit.ts + dashboard-render.ts (UTEXAS_HOST_HASH matches a live hashBucket computation)");
{
  const live = await hashBucket("utexas.instructure.com");
  check(
    "UTEXAS_HOST_HASH constant matches hashBucket('utexas.instructure.com') today",
    live === UTEXAS_HOST_HASH,
    `got ${live}, want ${UTEXAS_HOST_HASH}`,
  );
}

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
