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

import {
  costUsdForUsage,
  DEFAULT_RATE,
  GEMINI_TEXT_MODEL,
  IMAGE_VISION_MODEL,
  MODEL_RATES,
  PRIMARY_TEXT_MODEL,
  rateForModel,
} from "../src/lib/cost";
import {
  addToHistogram,
  emptyHistogram,
  LATENCY_BUCKET_BOUNDARIES_MS,
  percentileFromHistogram,
} from "../src/lib/histogram";
import { aggregateMetrics } from "../src/lib/metrics-aggregate";
import {
  addHostHash,
  addInstallSolveCount,
  applyPaidThrottle,
  applyRequestFacts,
  applyRRunnerEvent,
  applyServerEvent,
  applyTierAttribution,
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
import { fallbackRateTileDisplay, UTEXAS_HOST_HASH } from "../src/lib/dashboard-render";

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
console.log("metrics-store.ts (runtimeInstalledRPackages: normalize + apply)");
// Mirrors the missingRPackages block above EXACTLY -- same grammar, same
// per-day distinct-name cap pattern, same sanitize-at-the-write-boundary
// split -- just for the on-demand-install success signal instead of the
// missing-package gap signal. See DailyMetricsBucket.server's
// runtimeInstalledRPackages doc for how the two relate.

{
  // normalizeBucket: a bucket written by an OLDER schema version (before
  // runtimeInstalledRPackages existed) must backfill to {}, not throw/return
  // undefined.
  const legacyRaw = { date: "2026-08-01", server: { rRunner: { requestCount: 3 } }, client: {} };
  const normalized = normalizeBucket(legacyRaw, "2026-08-01");
  check(
    "normalizeBucket backfills missing runtimeInstalledRPackages to {} on an old-schema bucket",
    typeof normalized.server.runtimeInstalledRPackages === "object" &&
      Object.keys(normalized.server.runtimeInstalledRPackages).length === 0,
    JSON.stringify(normalized.server.runtimeInstalledRPackages),
  );
}

{
  // normalizeBucket: a well-formed record passes through untouched.
  const raw = { date: "2026-08-01", server: { runtimeInstalledRPackages: { pwr: 4, janitor: 2 } }, client: {} };
  const normalized = normalizeBucket(raw, "2026-08-01");
  check(
    "normalizeBucket passes through a well-formed runtimeInstalledRPackages record",
    normalized.server.runtimeInstalledRPackages["pwr"] === 4 &&
      normalized.server.runtimeInstalledRPackages["janitor"] === 2,
    JSON.stringify(normalized.server.runtimeInstalledRPackages),
  );
}

{
  // normalizeBucket: malformed (non-object) input degrades to {}, matching
  // okCountRecord's guard for every other Record<string, number> field.
  const raw = { date: "2026-08-01", server: { runtimeInstalledRPackages: "not an object" }, client: {} };
  const normalized = normalizeBucket(raw, "2026-08-01");
  check(
    "normalizeBucket degrades a malformed runtimeInstalledRPackages to {}, not a throw",
    Object.keys(normalized.server.runtimeInstalledRPackages).length === 0,
    JSON.stringify(normalized.server.runtimeInstalledRPackages),
  );
}

{
  // applyRRunnerEvent: a valid package name is recorded, and repeat
  // occurrences of the SAME name across separate calls increment rather
  // than being treated as a second distinct entry.
  const bucket = emptyBucket("2026-08-01");
  applyRRunnerEvent(bucket, { success: true, durationMs: 1200, installedPackages: ["pwr"] });
  applyRRunnerEvent(bucket, { success: true, durationMs: 900, installedPackages: ["pwr", "janitor"] });
  check(
    "applyRRunnerEvent counts repeat occurrences of the same name",
    bucket.server.runtimeInstalledRPackages["pwr"] === 2,
    JSON.stringify(bucket.server.runtimeInstalledRPackages),
  );
  check(
    "applyRRunnerEvent records a second distinct valid name",
    bucket.server.runtimeInstalledRPackages["janitor"] === 1,
    JSON.stringify(bucket.server.runtimeInstalledRPackages),
  );
  check(
    "applyRRunnerEvent still drives rRunner.requestCount/successCount as before",
    bucket.server.rRunner.requestCount === 2 && bucket.server.rRunner.successCount === 2,
  );
}

{
  // applyRRunnerEvent: names violating the R package grammar
  // (^[A-Za-z][A-Za-z0-9.]{0,40}$) are dropped outright -- same
  // security-critical sanitize path as missingRPackages, independently
  // re-checked here since installedPackages arrives via a different
  // channel (the runner's own JSON response, not R's error text).
  const bucket = emptyBucket("2026-08-01");
  applyRRunnerEvent(bucket, {
    success: true,
    installedPackages: [
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
    Object.keys(bucket.server.runtimeInstalledRPackages).length === 0,
    JSON.stringify(bucket.server.runtimeInstalledRPackages),
  );
}

{
  // applyRRunnerEvent: a name right AT the 41-char bound (1 letter + 40
  // letters/digits/dots) is accepted -- the boundary the {0,40} quantifier
  // pins.
  const bucket = emptyBucket("2026-08-01");
  const name41 = "a".repeat(41);
  applyRRunnerEvent(bucket, { success: true, installedPackages: [name41] });
  check(
    "applyRRunnerEvent accepts a name exactly at the 41-char bound",
    bucket.server.runtimeInstalledRPackages[name41] === 1,
  );
}

{
  // applyRRunnerEvent: the per-day DISTINCT-name cap (20) blocks brand-new
  // names once reached, but an existing name keeps incrementing past it.
  const bucket = emptyBucket("2026-08-01");
  for (let i = 0; i < 25; i++) {
    applyRRunnerEvent(bucket, { success: true, installedPackages: [`pkg${i}`] });
  }
  const distinctCount = Object.keys(bucket.server.runtimeInstalledRPackages).length;
  check("applyRRunnerEvent caps distinct names at 20/day", distinctCount === 20, `got ${distinctCount}`);
  check(
    "applyRRunnerEvent keeps the first-seen 20 distinct names, dropping the rest",
    bucket.server.runtimeInstalledRPackages["pkg0"] === 1 &&
      bucket.server.runtimeInstalledRPackages["pkg19"] === 1 &&
      bucket.server.runtimeInstalledRPackages["pkg20"] === undefined,
    JSON.stringify(bucket.server.runtimeInstalledRPackages),
  );

  // A 26th event for an ALREADY-recorded name still increments -- the cap
  // only blocks brand-new keys, never repeat occurrences of existing ones.
  applyRRunnerEvent(bucket, { success: true, installedPackages: ["pkg5"] });
  check(
    "applyRRunnerEvent still increments an existing name after the cap is reached",
    bucket.server.runtimeInstalledRPackages["pkg5"] === 2,
    `got ${bucket.server.runtimeInstalledRPackages["pkg5"]}`,
  );
}

{
  // applyRRunnerEvent: installedPackages on a FAILURE event is ignored --
  // matches missingPackages' own failure-event handling above (and
  // routes/solve.ts's recordRRunnerFailure, which never has a RunRResult to
  // read installedPackages from).
  const bucket = emptyBucket("2026-08-01");
  applyRRunnerEvent(bucket, { success: false, installedPackages: ["pwr"] });
  check(
    "applyRRunnerEvent ignores installedPackages when success is false",
    Object.keys(bucket.server.runtimeInstalledRPackages).length === 0,
    JSON.stringify(bucket.server.runtimeInstalledRPackages),
  );
  check("applyRRunnerEvent still counts the failure in rRunner.errorCount", bucket.server.rRunner.errorCount === 1);
}

{
  // applyRRunnerEvent: missingPackages and installedPackages are independent
  // fields on the SAME event -- a call can report both at once (e.g. 12
  // requested, 3 installed, the rest still missing for whatever reason) and
  // each lands in its own record without cross-contamination.
  const bucket = emptyBucket("2026-08-01");
  applyRRunnerEvent(bucket, {
    success: true,
    missingPackages: ["car"],
    installedPackages: ["pwr"],
  });
  check(
    "applyRRunnerEvent keeps missingRPackages and runtimeInstalledRPackages independent",
    bucket.server.missingRPackages["car"] === 1 &&
      bucket.server.missingRPackages["pwr"] === undefined &&
      bucket.server.runtimeInstalledRPackages["pwr"] === 1 &&
      bucket.server.runtimeInstalledRPackages["car"] === undefined,
    JSON.stringify({ missing: bucket.server.missingRPackages, installed: bucket.server.runtimeInstalledRPackages }),
  );
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
      runtimeInstalledRPackages: { pwr: 3, janitor: 1 },
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

  // Same merge for the success-side counterpart.
  check(
    "rRunner.runtimeInstalledRPackages passes through per-package counts",
    result.rRunner.runtimeInstalledRPackages["pwr"] === 3 && result.rRunner.runtimeInstalledRPackages["janitor"] === 1,
    JSON.stringify(result.rRunner.runtimeInstalledRPackages),
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
  // preset-package telemetry + tier-split work's tier/installHash).
  const bucket = emptyBucket("2026-08-04");
  const facts1: RequestFacts = {
    courseProfile: "sta301",
    imageAttached: true,
    rPackagesCustomized: false,
    tier: "paid",
    installHash: "h1",
  };
  const facts2: RequestFacts = {
    courseProfile: "generic",
    imageAttached: false,
    rPackagesCustomized: true,
    requestedPackages: ["car", "lme4", "tidyverse"],
    tier: "free",
    installHash: "h2",
  };
  // Old-client request: no rPackagesCustomized field sent at all. Same
  // installHash as facts1 (h1) — an install's SECOND request in the day.
  const facts3: RequestFacts = { courseProfile: "sta301", imageAttached: false, tier: "paid", installHash: "h1" };

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
  check(
    "solvesByTier tallies free vs paid, once per request (facts1+facts3 paid, facts2 free)",
    bucket.server.solvesByTier.paid === 2 && bucket.server.solvesByTier.free === 1,
    JSON.stringify(bucket.server.solvesByTier),
  );
  check(
    "installSolveCounts increments per request, h1's second request (facts3) adds to the SAME key",
    bucket.installSolveCounts["h1"] === 2 && bucket.installSolveCounts["h2"] === 1,
    JSON.stringify(bucket.installSolveCounts),
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
    tier: "free",
    installHash: "px",
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
    applyRequestFacts(bucket, {
      courseProfile: "sta301",
      imageAttached: false,
      requestedPackages: [`pkg${i}`],
      tier: "free",
      installHash: "px",
    });
  }
  applyRequestFacts(bucket, {
    courseProfile: "sta301",
    imageAttached: false,
    requestedPackages: ["car"],
    tier: "free",
    installHash: "px",
  }); // already-present key
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
console.log("metrics-store.ts (tier split: solvesByTier/costUsdByTier/byTopicByTier via applyTierAttribution)");

{
  // applyTierAttribution — the per-flush cost/topic cross-reference (see its
  // doc comment): sums a request's WHOLE server-events array into
  // costUsdByTier, and attributes the completing event's topic (if any) to
  // byTopicByTier, both keyed on the SAME tier the request's RequestFacts
  // carried. Exercised directly (no KV mock needed), same testability
  // precedent as applyServerEvent/applyRequestFacts above.
  const bucket = emptyBucket("2026-08-04");
  const baseEvent: Omit<ServerEventInput, "completedQuestion" | "costUsd" | "route"> = {
    success: true,
    model: PRIMARY_TEXT_MODEL,
    promptTokens: 100,
    completionTokens: 50,
    cachedTokens: 0,
    serverLatencyMs: 900,
    installHash: "h1",
  };
  // A calc-shaped request: first pass (no completedQuestion) + interpret leg
  // (completedQuestion set) — TWO events, ONE request, tier "paid".
  const paidEvents: ServerEventInput[] = [
    { ...baseEvent, route: "solve", costUsd: 0.01 },
    { ...baseEvent, route: "interpret", costUsd: 0.02, completedQuestion: { mode: "calc", topic: "bootstrap" } },
  ];
  applyTierAttribution(bucket, "paid", paidEvents);

  // A concept-shaped request: one event, tier "free".
  const freeEvents: ServerEventInput[] = [
    { ...baseEvent, route: "solve", costUsd: 0.005, completedQuestion: { mode: "concept", topic: "probability" } },
  ];
  applyTierAttribution(bucket, "free", freeEvents);

  check(
    "costUsdByTier sums EVERY event in the request's batch, not just the completing one",
    approxEqual(bucket.server.costUsdByTier.paid, 0.03, 1e-9),
    `got ${bucket.server.costUsdByTier.paid}`,
  );
  check(
    "costUsdByTier free leg",
    approxEqual(bucket.server.costUsdByTier.free, 0.005, 1e-9),
    `got ${bucket.server.costUsdByTier.free}`,
  );
  check(
    "byTopicByTier attributes the completing event's topic to its request's tier",
    bucket.server.byTopicByTier.paid["bootstrap"] === 1 && bucket.server.byTopicByTier.free["probability"] === 1,
    JSON.stringify(bucket.server.byTopicByTier),
  );
  check(
    "byTopicByTier never double-counts a non-completing leg (the first pass had no completedQuestion)",
    bucket.server.byTopicByTier.paid["probability"] === undefined &&
      Object.values(bucket.server.byTopicByTier.paid).reduce((s, v) => s + v, 0) === 1,
    JSON.stringify(bucket.server.byTopicByTier.paid),
  );
  check(
    "applyTierAttribution never touches byTopic itself (that's applyServerEvent's job)",
    Object.keys(bucket.server.byTopic).length === 0,
  );
}

{
  // A string outside the taxonomy collapses to "other" in byTopicByTier too
  // — same safeTopicKey re-validation applyServerEvent's byTopic uses.
  const bucket = emptyBucket("2026-08-04");
  const ev: ServerEventInput = {
    route: "interpret",
    success: true,
    model: PRIMARY_TEXT_MODEL,
    promptTokens: 10,
    completionTokens: 5,
    cachedTokens: 0,
    costUsd: 0.001,
    serverLatencyMs: 500,
    installHash: "h9",
    completedQuestion: { mode: "calc", topic: "some-made-up-topic" },
  };
  applyTierAttribution(bucket, "free", [ev]);
  check(
    "byTopicByTier whitelists an unrecognized topic string down to 'other'",
    bucket.server.byTopicByTier.free["other"] === 1 &&
      bucket.server.byTopicByTier.free["some-made-up-topic"] === undefined,
    JSON.stringify(bucket.server.byTopicByTier.free),
  );
}

{
  // flushMetricsBatch-shaped round trip: applyRequestFacts (once, for
  // solvesByTier/installSolveCounts) + applyTierAttribution (for
  // costUsdByTier/byTopicByTier), called in the SAME order flushMetricsBatch
  // uses — verifies the request-level fact and the per-event cross-reference
  // stay reconciled the way a real request would produce them.
  const bucket = emptyBucket("2026-08-04");
  const facts: RequestFacts = { courseProfile: "sta301", imageAttached: false, tier: "paid", installHash: "h5" };
  const events: ServerEventInput[] = [
    {
      route: "solve",
      success: true,
      model: PRIMARY_TEXT_MODEL,
      promptTokens: 200,
      completionTokens: 80,
      cachedTokens: 0,
      costUsd: 0.012,
      serverLatencyMs: 1100,
      installHash: "h5",
      completedQuestion: { mode: "concept", topic: "clt" },
    },
  ];
  applyRequestFacts(bucket, facts);
  applyTierAttribution(bucket, facts.tier, events);

  check("solvesByTier + costUsdByTier reconcile from the same request", bucket.server.solvesByTier.paid === 1);
  check(
    "costUsdByTier matches the request's total cost",
    approxEqual(bucket.server.costUsdByTier.paid, 0.012, 1e-9),
  );
  check("byTopicByTier.paid picked up the completed topic", bucket.server.byTopicByTier.paid["clt"] === 1);
  check("installSolveCounts picked up the SAME request's installHash", bucket.installSolveCounts["h5"] === 1);
}

// ---------------------------------------------------------------------------
console.log("metrics-store.ts (installSolveCounts — cap enforcement + normalize round-trip)");

{
  // cap enforcement: mirrors addHostHash's suite EXACTLY (see that suite
  // further down) — the 201st distinct key is dropped; an EXISTING key
  // keeps incrementing past the cap (a heavy user must never freeze).
  const b = emptyBucket("2026-08-04");
  for (let i = 0; i < 220; i++) addInstallSolveCount(b, `install-${i}`);
  check(
    "installSolveCounts caps at 200 distinct keys/day",
    Object.keys(b.installSolveCounts).length === 200,
    `got ${Object.keys(b.installSolveCounts).length}`,
  );
  check(
    "the first 200 keys were kept (insertion order)",
    b.installSolveCounts["install-0"] === 1 && b.installSolveCounts["install-199"] === 1,
  );
  check(
    "the 201st+ keys were dropped",
    b.installSolveCounts["install-200"] === undefined && b.installSolveCounts["install-219"] === undefined,
  );

  addInstallSolveCount(b, "install-0"); // an EXISTING key, added before the cap was hit
  check(
    "an existing key still increments past the cap",
    b.installSolveCounts["install-0"] === 2,
    `got ${b.installSolveCounts["install-0"]}`,
  );

  addInstallSolveCount(b, "install-999"); // a brand-new key after the cap is already full
  check("a brand-new key past the cap is dropped, not added", b.installSolveCounts["install-999"] === undefined);
  check("cap stays at exactly 200 keys after both calls above", Object.keys(b.installSolveCounts).length === 200);
}

{
  // empty-string hash is a safe no-op — defensive; every real caller always
  // supplies a real hashBucket() digest.
  const b = emptyBucket("2026-08-04");
  addInstallSolveCount(b, "");
  check("addInstallSolveCount('') is a no-op", Object.keys(b.installSolveCounts).length === 0);
}

{
  // normalize round-trip: counts survive a JSON-serialize -> normalizeBucket
  // pass unchanged (simulates a real KV get/put cycle).
  const b = emptyBucket("2026-08-04");
  addInstallSolveCount(b, "h1");
  addInstallSolveCount(b, "h1");
  addInstallSolveCount(b, "h2");
  const roundTripped = normalizeBucket(JSON.parse(JSON.stringify(b)), "2026-08-04");
  check(
    "installSolveCounts normalize round-trip preserves per-key counts",
    roundTripped.installSolveCounts["h1"] === 2 && roundTripped.installSolveCounts["h2"] === 1,
    JSON.stringify(roundTripped.installSolveCounts),
  );
}

{
  // a bucket written by an OLDER schema version (predates this field
  // entirely) must default to {}, not throw or return undefined.
  const legacy = normalizeBucket({ date: "2026-08-04" }, "2026-08-04");
  check(
    "normalizeBucket defaults a missing installSolveCounts to {} (pre-existing bucket)",
    typeof legacy.installSolveCounts === "object" && Object.keys(legacy.installSolveCounts).length === 0,
  );
}

{
  // corrupt/non-object installSolveCounts (KV corruption, or a bad manual
  // edit) must also default to {}, matching okCountRecord's contract for
  // every other Record<string, number> field in this bucket.
  const corrupt = normalizeBucket({ date: "2026-08-04", installSolveCounts: "not-an-object" }, "2026-08-04");
  check(
    "normalizeBucket defaults a corrupt installSolveCounts to {}",
    Object.keys(corrupt.installSolveCounts).length === 0,
  );
}

{
  // solvesByTier/costUsdByTier/byTopicByTier: normalizeBucket backfills all
  // three when reading a pre-tier-split bucket (fields absent entirely) —
  // same "pre-branch bucket" contract as the course-topic suite above.
  const preTierRaw = JSON.parse(JSON.stringify(emptyBucket("2026-08-02")));
  delete preTierRaw.server.solvesByTier;
  delete preTierRaw.server.costUsdByTier;
  delete preTierRaw.server.byTopicByTier;
  const normalized = normalizeBucket(preTierRaw, "2026-08-02");
  check(
    "normalizeBucket backfills solvesByTier/costUsdByTier/byTopicByTier when reading a pre-tier-split bucket",
    normalized.server.solvesByTier.free === 0 &&
      normalized.server.solvesByTier.paid === 0 &&
      normalized.server.costUsdByTier.free === 0 &&
      normalized.server.costUsdByTier.paid === 0 &&
      JSON.stringify(normalized.server.byTopicByTier) === '{"free":{},"paid":{}}',
    JSON.stringify(normalized.server),
  );
}

{
  // byTopicByTier with only ONE leg present (a malformed/partial write) —
  // must still normalize both legs independently rather than throwing or
  // losing the leg that WAS present.
  const partial = normalizeBucket(
    { date: "2026-08-04", server: { byTopicByTier: { paid: { bootstrap: 3 } } } },
    "2026-08-04",
  );
  check(
    "normalizeBucket handles byTopicByTier with only one leg present",
    partial.server.byTopicByTier.paid["bootstrap"] === 3 &&
      typeof partial.server.byTopicByTier.free === "object" &&
      Object.keys(partial.server.byTopicByTier.free).length === 0,
    JSON.stringify(partial.server.byTopicByTier),
  );
}

// ---------------------------------------------------------------------------
console.log("metrics-store.ts (byProvider — fallback-signal work: normalize backfill + applyServerEvent attribution)");

{
  // normalizeBucket: a bucket written BEFORE the fallback-signal rollout
  // (no byProvider field in the raw JSON at all — the exact shape every
  // real historical bucket predating this work has) must backfill to
  // {luna: 0, gemini: 0}, never throw/undefined — same "delete the field,
  // normalize, check the zero-default backfill" contract the course-topic
  // suite above already covers for byCourseProfile/imageAttachment/
  // rPackagesCustomized. This is the shape metrics-aggregate.ts's
  // fallbackRatePct treats as "no data yet" (null), not a real 0%.
  const preRolloutRaw = JSON.parse(JSON.stringify(emptyBucket("2026-08-02")));
  delete preRolloutRaw.server.byProvider;
  const normalized = normalizeBucket(preRolloutRaw, "2026-08-02");
  check(
    "normalizeBucket backfills a missing byProvider to {luna: 0, gemini: 0} on a pre-rollout bucket",
    normalized.server.byProvider.luna === 0 && normalized.server.byProvider.gemini === 0,
    JSON.stringify(normalized.server.byProvider),
  );
}

{
  // normalizeBucket: a well-formed byProvider record passes through untouched.
  const raw = { date: "2026-08-04", server: { byProvider: { luna: 41, gemini: 3 } } };
  const normalized = normalizeBucket(raw, "2026-08-04");
  check(
    "normalizeBucket passes through a well-formed byProvider record",
    normalized.server.byProvider.luna === 41 && normalized.server.byProvider.gemini === 3,
    JSON.stringify(normalized.server.byProvider),
  );
}

{
  // applyServerEvent: a successful event carrying provider:"luna" increments
  // ONLY byProvider.luna.
  const bucket = emptyBucket("2026-08-04");
  const lunaEvent: ServerEventInput = {
    route: "solve",
    success: true,
    model: PRIMARY_TEXT_MODEL,
    provider: "luna",
    promptTokens: 500,
    completionTokens: 200,
    cachedTokens: 0,
    costUsd: 0.001,
    serverLatencyMs: 900,
    installHash: "inst-luna",
  };
  applyServerEvent(bucket, lunaEvent);
  check(
    "applyServerEvent(provider: 'luna') increments byProvider.luna only",
    bucket.server.byProvider.luna === 1 && bucket.server.byProvider.gemini === 0,
    JSON.stringify(bucket.server.byProvider),
  );
}

{
  // applyServerEvent: a successful event carrying provider:"gemini"
  // (Luna failed over — lib/llm.ts's ServedBy) increments ONLY
  // byProvider.gemini, and both providers accumulate independently across
  // multiple events on the same bucket (mirrors a calc question's
  // first-pass + repair + interpret legs landing on different providers).
  const bucket = emptyBucket("2026-08-04");
  const base = {
    route: "solve" as const,
    success: true,
    promptTokens: 500,
    completionTokens: 200,
    cachedTokens: 0,
    costUsd: 0.002,
    serverLatencyMs: 900,
    installHash: "inst-mixed",
  };
  applyServerEvent(bucket, { ...base, model: GEMINI_TEXT_MODEL, provider: "gemini" });
  applyServerEvent(bucket, { ...base, model: PRIMARY_TEXT_MODEL, provider: "luna" });
  applyServerEvent(bucket, { ...base, model: PRIMARY_TEXT_MODEL, provider: "luna" });
  check(
    "applyServerEvent accumulates BOTH providers independently across events",
    bucket.server.byProvider.luna === 2 && bucket.server.byProvider.gemini === 1,
    JSON.stringify(bucket.server.byProvider),
  );
}

{
  // applyServerEvent: a request-level FAILURE event (kill-switch rejection,
  // R-runner failure, outer catch — routes/solve.ts sets `model` to the
  // request-level resolved model on these but deliberately omits
  // `provider`, since there's no single serving attempt left to attribute)
  // must NOT inflate either byProvider count — see ServerEventInput.
  // provider's doc for why `undefined` here is the correct, common case,
  // not an oversight.
  const bucket = emptyBucket("2026-08-04");
  const failureEvent: ServerEventInput = {
    route: "solve",
    success: false,
    model: PRIMARY_TEXT_MODEL, // request-level resolved model, no provider attached
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    costUsd: 0,
    serverLatencyMs: 500,
    installHash: "inst-fail",
    errorType: "quota",
  };
  applyServerEvent(bucket, failureEvent);
  check(
    "applyServerEvent on a providerless failure event leaves byProvider at {luna: 0, gemini: 0}",
    bucket.server.byProvider.luna === 0 && bucket.server.byProvider.gemini === 0,
    JSON.stringify(bucket.server.byProvider),
  );
}

// ---------------------------------------------------------------------------
console.log("metrics-aggregate.ts (tier split + fallback rate + top-consumer aggregation)");

{
  const day0 = emptyBucket("2026-08-04");
  day0.server.solvesByTier = { free: 6, paid: 14 };
  day0.server.costUsdByTier = { free: 0.03, paid: 0.09 };
  day0.server.byTopicByTier = { free: { probability: 4, bootstrap: 2 }, paid: { bootstrap: 9, clt: 5 } };
  day0.server.byModel = {
    [PRIMARY_TEXT_MODEL]: { calls: 30, costUsd: 0.1 },
    [GEMINI_TEXT_MODEL]: { calls: 2, costUsd: 0.006 },
  };
  // Deliberately NOT derived from byModel above (e.g. NOT "= the
  // GEMINI_TEXT_MODEL calls") -- byProvider is now an INDEPENDENT explicit
  // counter (fallback-signal work), not something read back out of the
  // model-id breakdown. See ServerEventInput.provider's doc.
  day0.server.byProvider = { luna: 25, gemini: 4 };
  day0.server.routes = {
    solve: { attempts: 30, successes: 29, errors: 1 },
    interpret: { attempts: 12, successes: 12, errors: 0 },
  };
  day0.installSolveCounts = { instA: 5, instB: 20 };

  const day1 = emptyBucket("2026-08-03");
  day1.server.solvesByTier = { free: 3, paid: 9 };
  day1.server.costUsdByTier = { free: 0.02, paid: 0.06 };
  day1.server.byTopicByTier = { free: { probability: 1 }, paid: { bootstrap: 3 } };
  day1.server.byModel = {
    [PRIMARY_TEXT_MODEL]: { calls: 18, costUsd: 0.08 },
    [IMAGE_VISION_MODEL]: { calls: 4, costUsd: 0.02 },
  };
  // day1's byModel has a 4-call IMAGE_VISION_MODEL slice and NO
  // GEMINI_TEXT_MODEL row at all -- exactly the shape that used to make the
  // OLD id-inference fallbackCalls over-count (it would have added this 4
  // to the fallback total even though byProvider below says only 1 call
  // this day was actually Gemini-served). Kept deliberately mismatched from
  // byProvider to prove the new field is truly independent of byModel.
  day1.server.byProvider = { luna: 15, gemini: 1 };
  day1.server.routes = {
    solve: { attempts: 18, successes: 18, errors: 0 },
    interpret: { attempts: 8, successes: 8, errors: 0 },
  };
  day1.installSolveCounts = { instA: 40, instC: 2 }; // instA repeats across days -> must SUM, not dedupe like installHashes

  const result = aggregateMetrics({
    now: Date.now(),
    days: 2,
    dates: ["2026-08-04", "2026-08-03"],
    buckets: [day0, day1],
    priceMonthlyUsd: 15,
    assumedSolvesPerUserPerMonth: 90,
  });

  check(
    "economics.tier.solvesFree/solvesPaid sum across days",
    result.economics.tier.solvesFree === 9 && result.economics.tier.solvesPaid === 23,
    JSON.stringify(result.economics.tier),
  );
  check(
    "economics.tier.costFreeUsd/costPaidUsd sum across days",
    approxEqual(result.economics.tier.costFreeUsd, 0.05, 1e-6) &&
      approxEqual(result.economics.tier.costPaidUsd, 0.15, 1e-6),
    JSON.stringify(result.economics.tier),
  );
  check(
    "economics.tier.freeCostSharePct = costFree/(costFree+costPaid)*100",
    approxEqual(result.economics.tier.freeCostSharePct, 25, 1e-6),
    `got ${result.economics.tier.freeCostSharePct}`,
  );
  check(
    "courseContext.byTopicByTier merges per-tier per-topic across days",
    result.courseContext.byTopicByTier.free["probability"] === 5 &&
      result.courseContext.byTopicByTier.paid["bootstrap"] === 12 &&
      result.courseContext.byTopicByTier.paid["clt"] === 5,
    JSON.stringify(result.courseContext.byTopicByTier),
  );
  check(
    "volume.byInstallSolveCount SUMS an install's count across days (not dedup like installHashes)",
    result.volume.byInstallSolveCount["instA"] === 45 &&
      result.volume.byInstallSolveCount["instB"] === 20 &&
      result.volume.byInstallSolveCount["instC"] === 2,
    JSON.stringify(result.volume.byInstallSolveCount),
  );
  check(
    "volume.maxSolvesByOneInstall picks the highest SUMMED count",
    result.volume.maxSolvesByOneInstall === 45,
    `got ${result.volume.maxSolvesByOneInstall}`,
  );

  // byProvider merge (fallback-signal work): day0 {luna:25,gemini:4} +
  // day1 {luna:15,gemini:1} -> {luna:40,gemini:5}. Both these days ALSO
  // carry byModel Gemini-id rows (day0's GEMINI_TEXT_MODEL: 2 calls, day1's
  // IMAGE_VISION_MODEL: 4 calls) that the OLD id-inference version of this
  // field would have summed instead (2+4=6, against apiCalls=68) -- the
  // checks below prove the new field ignores byModel entirely and uses
  // ONLY the explicit counter.
  const expectedLuna = 25 + 15;
  const expectedGemini = 4 + 1;
  const expectedFallbackServedCalls = expectedLuna + expectedGemini;
  check(
    "economics.byProvider sums BOTH luna and gemini across days",
    result.economics.byProvider.luna === expectedLuna && result.economics.byProvider.gemini === expectedGemini,
    JSON.stringify(result.economics.byProvider),
  );
  check(
    "economics.fallbackCalls === byProvider.gemini (explicit attribution, not the old byModel-id inference)",
    result.economics.fallbackCalls === expectedGemini,
    `got ${result.economics.fallbackCalls}, want ${expectedGemini}`,
  );
  check(
    "economics.fallbackRatePct = byProvider.gemini / (luna+gemini) * 100 -- NOT gemini/apiCalls",
    approxEqual(result.economics.fallbackRatePct ?? NaN, (expectedGemini / expectedFallbackServedCalls) * 100, 1e-2),
    `got ${result.economics.fallbackRatePct}`,
  );
  check(
    "economics.fallbackRatePct is NOT the old apiCalls-denominator figure (proves the denominator actually changed)",
    !approxEqual(result.economics.fallbackRatePct ?? NaN, (expectedGemini / (30 + 12 + 18 + 8)) * 100, 1e-2),
    `got ${result.economics.fallbackRatePct}`,
  );
}

{
  // All-empty buckets: every new ratio must degrade to 0, never NaN — same
  // "empty range" contract the pre-existing 30-day-aggregation suite already
  // covers for the rest of this response shape.
  const result = aggregateMetrics({
    now: Date.now(),
    days: 1,
    dates: ["2026-08-04"],
    buckets: [emptyBucket("2026-08-04")],
    priceMonthlyUsd: 15,
    assumedSolvesPerUserPerMonth: 90,
  });
  check("empty range: economics.tier.freeCostSharePct is 0, not NaN", result.economics.tier.freeCostSharePct === 0);
  // The critical "no byProvider data at all" contract (fallback-signal
  // work): an all-empty-bucket window is EXACTLY what every real
  // pre-cutover historical bucket normalizes to (normalizeBucket backfills
  // byProvider to {luna:0, gemini:0} when the field is missing entirely).
  // fallbackRatePct must be `null` here -- an explicit "unknown" -- NEVER
  // 0 (which would misread as "checked, nothing failed over") and NEVER
  // NaN. This is the aggregate-level half of that contract; dashboard-
  // render.ts's fallbackRateTileDisplay (tested separately below) is the
  // rendering-side half.
  check(
    "empty range: economics.fallbackRatePct is null (no byProvider data), NOT 0 -- the explicit no-data state",
    result.economics.fallbackRatePct === null,
    `got ${result.economics.fallbackRatePct}`,
  );
  check(
    "empty range: economics.fallbackCalls is 0 and economics.byProvider is {luna: 0, gemini: 0}",
    result.economics.fallbackCalls === 0 &&
      result.economics.byProvider.luna === 0 &&
      result.economics.byProvider.gemini === 0,
    JSON.stringify({ fallbackCalls: result.economics.fallbackCalls, byProvider: result.economics.byProvider }),
  );
  check("empty range: volume.maxSolvesByOneInstall is 0", result.volume.maxSolvesByOneInstall === 0);
  check(
    "empty range: economics.tier solves/cost all 0",
    result.economics.tier.solvesFree === 0 &&
      result.economics.tier.solvesPaid === 0 &&
      result.economics.tier.costFreeUsd === 0 &&
      result.economics.tier.costPaidUsd === 0,
  );
  check(
    "empty range: courseContext.byTopicByTier is empty on both legs",
    Object.keys(result.courseContext.byTopicByTier.free).length === 0 &&
      Object.keys(result.courseContext.byTopicByTier.paid).length === 0,
  );
}

// ---------------------------------------------------------------------------
console.log("dashboard-render.ts (fallbackRateTileDisplay — the 'no data -> no-data state, not 0%' rendering decision)");

{
  // The critical branch: economics.fallbackRatePct === null (this window
  // has zero byProvider data -- see the aggregate-level tests just above)
  // must render as an explicit "no data" state, NEVER "0%" (implies
  // "checked, nothing failed over" -- false, nothing was ever
  // instrumented) and NEVER a percentage computed some other way.
  const display = fallbackRateTileDisplay({ fallbackRatePct: null, fallbackCalls: 0 });
  check(
    "fallbackRateTileDisplay(null) renders the literal em-dash, not '0%' or 'NaN%'",
    display.value === "—",
    `got ${JSON.stringify(display)}`,
  );
  check(
    "fallbackRateTileDisplay(null) uses the neutral 'ink' tone, not a green/red health color",
    display.tone === "ink",
    `got ${display.tone}`,
  );
  check(
    "fallbackRateTileDisplay(null) captions it as no-data, not a fake call count",
    /no data/i.test(display.caption),
    `got ${JSON.stringify(display.caption)}`,
  );
}

{
  // Real-data branch: a genuine (non-null) rate still renders as a
  // percentage with the pre-existing green/amber/red health thresholds and
  // call-count caption -- this fix must not change that behavior for a
  // window that DOES have data.
  const healthy = fallbackRateTileDisplay({ fallbackRatePct: 0.5, fallbackCalls: 3 });
  check(
    "fallbackRateTileDisplay(0.5%) renders a percentage, not the no-data dash",
    healthy.value === "0.5%",
    `got ${JSON.stringify(healthy)}`,
  );
  check("fallbackRateTileDisplay(0.5%) is green (<=1%)", healthy.tone === "green", `got ${healthy.tone}`);
  check(
    "fallbackRateTileDisplay(0.5%) captions the real call count",
    healthy.caption === "3 calls · Luna failed → Gemini served",
    `got ${JSON.stringify(healthy.caption)}`,
  );

  const unhealthy = fallbackRateTileDisplay({ fallbackRatePct: 12, fallbackCalls: 40 });
  check("fallbackRateTileDisplay(12%) is red (>5%)", unhealthy.tone === "red", `got ${unhealthy.tone}`);

  // 0% is itself a legitimate, real answer (byProvider has data, and it's
  // ALL luna) -- must render as an actual "0.0%", not be conflated with
  // the null/no-data case above.
  const zero = fallbackRateTileDisplay({ fallbackRatePct: 0, fallbackCalls: 0 });
  check(
    "fallbackRateTileDisplay(0) renders a real '0.0%', distinct from the null no-data case",
    zero.value === "0.0%" && zero.tone === "green",
    `got ${JSON.stringify(zero)}`,
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
console.log("lib/metrics-store.ts (paidThrottleHits — owner directive 2026-08-04, CHANGE 3)");

{
  const b = emptyBucket("2026-08-04");
  check(
    "emptyBucket starts paidThrottleHits at {daily: 0, monthly: 0}",
    b.paidThrottleHits.daily === 0 && b.paidThrottleHits.monthly === 0,
    JSON.stringify(b.paidThrottleHits),
  );
}

{
  // applyPaidThrottle — the pure per-batch mutation flushMetricsBatch calls
  // (MetricsBatch.paidThrottle), same "exported so this file can exercise it
  // directly" reasoning as applyRequestFacts/applyServerEvent above.
  const b = emptyBucket("2026-08-04");
  applyPaidThrottle(b, "daily");
  applyPaidThrottle(b, "daily");
  applyPaidThrottle(b, "monthly");
  check(
    "applyPaidThrottle increments the right key, independently",
    b.paidThrottleHits.daily === 2 && b.paidThrottleHits.monthly === 1,
    JSON.stringify(b.paidThrottleHits),
  );
}

{
  // a bucket written by an OLDER schema version (predates this field
  // entirely, e.g. anything written before the caps-rework branch) must
  // default to {daily: 0, monthly: 0}, not throw or return undefined.
  const legacy = normalizeBucket({ date: "2026-08-04" }, "2026-08-04");
  check(
    "normalizeBucket backfills a missing paidThrottleHits to {daily: 0, monthly: 0}",
    legacy.paidThrottleHits.daily === 0 && legacy.paidThrottleHits.monthly === 0,
    JSON.stringify(legacy.paidThrottleHits),
  );
}

{
  // normalize round-trip: counts survive a JSON-serialize -> normalizeBucket
  // pass unchanged (simulates a real KV get/put cycle).
  const b = emptyBucket("2026-08-04");
  applyPaidThrottle(b, "daily");
  applyPaidThrottle(b, "monthly");
  applyPaidThrottle(b, "monthly");
  const roundTripped = normalizeBucket(JSON.parse(JSON.stringify(b)), "2026-08-04");
  check(
    "paidThrottleHits normalize round-trip preserves both counters",
    roundTripped.paidThrottleHits.daily === 1 && roundTripped.paidThrottleHits.monthly === 2,
    JSON.stringify(roundTripped.paidThrottleHits),
  );
}

{
  // a well-formed record passes through untouched (mirrors the
  // hostHashCounts "passes through a well-formed record" check above).
  const raw = { date: "2026-08-04", paidThrottleHits: { daily: 7, monthly: 42 } };
  const normalized = normalizeBucket(raw, "2026-08-04");
  check(
    "normalizeBucket passes through a well-formed paidThrottleHits record",
    normalized.paidThrottleHits.daily === 7 && normalized.paidThrottleHits.monthly === 42,
    JSON.stringify(normalized.paidThrottleHits),
  );
}

{
  // A partially-malformed paidThrottleHits (e.g. one key overwritten with a
  // non-number by a bad manual KV edit) must not throw. normalizeBucket
  // blind-spreads this fixed-shape object exactly like every sibling small
  // counts object in this bucket (confidence, revenue, courseProfile, etc. —
  // none of them individually type-check each field either, see their own
  // `{ ...empty.X, ...s.X }` lines above), so the malformed value passes
  // through as-is and only the ABSENT key (monthly, never supplied here)
  // gets the zero default.
  const corrupt = normalizeBucket(
    { date: "2026-08-04", paidThrottleHits: { daily: "not-a-number" } },
    "2026-08-04",
  );
  check(
    "normalizeBucket doesn't throw on a partially-malformed paidThrottleHits, and backfills the ABSENT key",
    corrupt.paidThrottleHits.monthly === 0,
    JSON.stringify(corrupt.paidThrottleHits),
  );
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
