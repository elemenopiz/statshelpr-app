/**
 * Pure aggregation: merges N daily KV buckets (lib/metrics-store.ts) into the
 * GET /api/metrics response shape. Deliberately takes plain data in (no KV/
 * Env access) so it's directly unit-testable with mock buckets — see
 * apps/workers/scripts/self-test-metrics.ts — and so routes/metrics.ts stays
 * a thin KV-fetch + auth wrapper around this.
 */

import {
  type ConfidenceCounts,
  type CourseProfileCounts,
  type DailyMetricsBucket,
  type ImageAttachmentCounts,
  type ModelUsage,
  type RPackagesCustomizedCounts,
  type WriteBackOutcomeCounts,
} from "./metrics-store";
import {
  emptyHistogram,
  LATENCY_BUCKET_BOUNDARIES_MS,
  mergeHistogramInto,
  percentileFromHistogram,
} from "./histogram";
import { IMAGE_VISION_MODEL, PRIMARY_TEXT_MODEL, rateForModel } from "./cost";

/** One day of the enriched time series (dashboard-v2 items 10 & 12). Every
 *  field is a per-DAY value so the renderer can draw trend lines / sparklines
 *  / stacked-area composition instead of only the 30-day totals. */
export interface DailyPoint {
  date: string;
  questions: number;
  apiCalls: number;
  errors: number;
  /** (solve+interpret successes)/attempts for THIS day, 0..1. */
  solveSuccessRate: number;
  costUsd: number;
  /** cachedTokens/promptTokens for THIS day, 0..1. */
  cacheHitRate: number;
  serverLatencyMsP50: number;
  concept: number;
  calc: number;
  imageCalls: number;
  /** Install hashes first seen on this day within the window (item 8). Filled
   *  by the cross-day cohort pass; 0 until then. */
  newInstalls: number;
  activeInstalls: number;
  paywallHits: number;
  revenueCreated: number;
  revenueCancelled: number;
}

/** Write-back tally plus its derived rate, per question type (item 4). */
export type WriteBackTypeStat = WriteBackOutcomeCounts & { writeBackRate: number };

export interface MetricsResponse {
  generatedAt: number;
  range: { days: number };
  /** Percent change vs the immediately-preceding window of the same length
   *  (dashboard-v2 item 10). Keyed by metric name; null when the prior window
   *  had no comparable data. Filled by metrics-load.ts (which aggregates the
   *  prior window too); aggregateMetrics alone leaves deltaPct empty. */
  comparison: {
    prevRangeDays: number;
    deltaPct: Record<string, number | null>;
  };
  volume: {
    questionsAnswered: number;
    apiCalls: number;
    byQuestionType: Record<string, number>;
    dau: number;
    wau: number;
    /** Distinct active installs across the whole window (item 8). */
    mau: number;
    /** Installs first seen within the window (item 7/8). */
    newInstalls: number;
    daily: DailyPoint[];
    /** /api/solve requests per hashed Canvas host domain, summed across the
     *  window (host-telemetry addition — "are these organic users even UT
     *  students?"). Keys are opaque hashBucket() digests or the fixed
     *  HOST_HASH_OTHER literal — see lib/metrics-store.ts's hostHashCounts
     *  doc. dashboard-render.ts is the only place a hash is ever labeled with
     *  a readable school name. */
    byHostHash: Record<string, number>;
  };
  quality: {
    solveSuccessRate: number;
    writeBackSuccessRate: number;
    writeBackByOutcome: WriteBackOutcomeCounts;
    /** Write-back outcome + rate per question type (item 4). */
    writeBackByQuestionType: Record<string, WriteBackTypeStat>;
    /** Concept-solve-path confidence. */
    confidence: ConfidenceCounts;
    /** Calc/interpret-path confidence (item 16). */
    confidenceCalc: ConfidenceCounts;
    modeSplit: { concept: number; calc: number };
    /** Calc solves that executed R — an alias of modeSplit.calc. The field
     *  name is legacy (R ran client-side via WebR before the Cloud Run
     *  migration, docs/cloud-run-r-migration.md); kept as "webrUsage" so the
     *  GET /api/metrics response shape stays stable across the migration. */
    webrUsage: number;
    /** Failed-call counts by error class (item 2). */
    byErrorType: Record<string, number>;
    /** Total failed solve+interpret calls in range (item 2). */
    errorsTotal: number;
    /** Client-reported solve attempts that died BEFORE any result existed
     *  (scrape/config/network/HTTP-reject/timeout), by failure category —
     *  the extension's failure beacon (2026-08 blind-spot fix). Server-side
     *  errors live in byErrorType; these never reached the solve pipeline
     *  at all (or were rejected/timed out at the HTTP layer). */
    byFailure: Record<string, number>;
  };
  performance: {
    serverLatencyMsP50: number;
    serverLatencyMsP95: number;
    clientLatencyMsP50: number;
    clientLatencyMsP95: number;
    /** Merged fixed-bucket histograms + their boundaries so the renderer can
     *  draw the full latency distribution, not just p50/p95 (item 11). */
    serverLatencyHistogram: number[];
    clientLatencyHistogram: number[];
    latencyBoundariesMs: number[];
  };
  /** Cloud Run R-execution service health (R-runner health tracking phase 1)
   *  — a distinct signal from `performance` above, which covers the Gemini
   *  solve/interpret legs, not the R-runner call itself. */
  rRunner: {
    requestCount: number;
    /** successCount/requestCount, 0..1 — same convention as
     *  quality.solveSuccessRate. */
    successRate: number;
    latencyMsP50: number;
    latencyMsP95: number;
    latencyHistogram: number[];
    /** coldStartCount/successCount*100, 0..100 (only successful calls have a
     *  durationMs to classify as cold-started). */
    coldStartRatePct: number;
    /** Distinct R package names requested (library()/require()) that aren't
     *  installed on the runner, summed across the range — already
     *  sanitized + capped at write time (lib/metrics-store.ts's
     *  addMissingRPackage), so this is a plain merge, not a re-validation.
     *  The evidence-based "which packages do users actually need" signal —
     *  see the dashboard's "Missing R packages requested" card. */
    missingRPackages: Record<string, number>;
  };
  economics: {
    model: string;
    rates: { inputPer1M: number; outputPer1M: number; cachedInputPer1M: number };
    totalCostUsd: number;
    avgCostPerQuestionUsd: number;
    avgCostPerCalcQuestionUsd: number;
    priceMonthlyUsd: number;
    assumedSolvesPerUserPerMonth: number;
    breakEvenQuestionsPerUser: number;
    /** COGS-only estimate: (price - avgCostPerQuestion*assumedSolves)/price*100.
     *  Gemini API spend vs. subscription price ONLY — does not model payment
     *  processor fees (LS/Dodo) or free-tier-user dilution. Label it as such
     *  wherever this is surfaced downstream. */
    grossMarginPerUserPct: number;
    /** Per-model audit trail: every model id actually seen in this range
     *  (each event costed at its OWN model's rate — see lib/cost.ts), not
     *  just the headline `model` above. Lets you see the text/image cost
     *  split instead of just the blended `totalCostUsd`. */
    modelsUsed: Record<string, ModelUsage>;
    /** Token totals + derived cache/efficiency ratios (item 1). */
    tokens: { promptTokens: number; completionTokens: number; cachedTokens: number };
    /** cachedTokens/promptTokens across the range, 0..1 — the main COGS lever. */
    cacheHitRate: number;
    tokensPerQuestion: number;
    /** promptTokens/completionTokens. */
    inputOutputRatio: number;
    /** Image/vision-model share of calls + cost (item 3). */
    imageCalls: number;
    imageCallSharePct: number;
    imageCostSharePct: number;
  };
  /** Real revenue (items 6 & 9). Point-in-time `activeSubscribers`/`mrrUsd`
   *  come from the `sub:` KV keyspace via metrics-load.ts (passed in as
   *  `activeSubscribers`); the 30d flow counts come from the daily buckets. */
  revenue: {
    activeSubscribers: number;
    mrrUsd: number;
    arpuUsd: number;
    created30d: number;
    cancelled30d: number;
    paymentFailed30d: number;
    netNewSubs30d: number;
    churnRatePct: number | null;
    /** Item 9: real blended margin = (MRR − 30d COGS)/MRR·100. null if no MRR. */
    realGrossMarginPct: number | null;
    cogsPerActiveUserUsd: number | null;
  };
  /** Conversion funnel (item 7): installs → active → paywalled → upgraded. */
  funnel: {
    newInstalls30d: number;
    activeInstalls30d: number;
    paywallHits30d: number;
    upgrades30d: number;
    paywallToUpgradeRatePct: number | null;
  };
  /** Retention/cohorts (item 8) — filled by the cross-day cohort pass in
   *  metrics-load.ts; null until then. */
  retention: {
    nextDayRetentionPct: number | null;
    sevenDayRetentionPct: number | null;
    returningSharePct: number | null;
  };
  /** course-topic branch: content-free course-context + cheap behavioral
   *  signals — counts and validated enum/package-name keys only, never
   *  question/answer text and never a preset's user-chosen NAME (that never
   *  leaves the device in the first place — see apps/extension/src/
   *  r-packages.ts). */
  courseContext: {
    /** Model self-reported topic tag per completed question (Part 2) —
     *  same shape/spirit as volume.byQuestionType, just keyed by
     *  solver-core's TOPICS taxonomy instead of DOM-scraped question shape. */
    byTopic: Record<string, number>;
    byCourseProfile: CourseProfileCounts;
    imageAttachment: ImageAttachmentCounts;
    rPackagesCustomized: RPackagesCustomizedCounts;
    /** Validated R package names requested via the preset picker's `packages`
     *  field (preset redesign) — "promote a popular preset to official"
     *  evidence. Capped server-side at 20 distinct names/day (see
     *  metrics-store.ts's REQUESTED_PACKAGE_CAP). */
    byRequestedPackage: Record<string, number>;
  };
  /** Cloud Run infra health for the R-runner service (R-runner health
   *  tracking phase 2) — live-fetched from GCP Cloud Monitoring on every
   *  metrics-load.ts call (see lib/gcp-monitoring.ts's fetchCloudRunMetrics),
   *  NOT event-sourced from our own KV buckets like the rest of this
   *  response. Distinct from `rRunner` above (our own Worker-side call
   *  instrumentation) — this is Cloud Run's own billing + cold-start
   *  telemetry for the same service. aggregateMetrics() only fills in the
   *  "not fetched yet" default below; metrics-load.ts overlays the real
   *  (or gracefully-unavailable) value afterward, same pattern as
   *  `comparison`/`retention` above. */
  cloudRun: {
    available: boolean;
    /** Why `available` is false — shown on the dashboard in place of the
     *  numbers. Always null when available. */
    unavailableReason: string | null;
    /** Free-tier burn for the current UTC calendar month vs. Cloud Run's
     *  always-free allotment (180,000 vCPU-sec, 360,000 GiB-sec/mo). */
    billableInstanceTime: {
      vcpuSeconds: number;
      gibSeconds: number;
      vcpuFreeTierBurnPct: number;
      gibFreeTierBurnPct: number;
    } | null;
    /** Cold-start duration alone (container startup), a more precise signal
     *  than `rRunner.coldStartRatePct`'s durationMs > 8000 heuristic. */
    startupLatency: {
      p50Ms: number;
      p95Ms: number;
    } | null;
  };
}

export interface AggregateMetricsInput {
  now: number;
  days: number;
  /** Most-recent-first date keys, e.g. [today, today-1, ..., today-(days-1)]. */
  dates: string[];
  /** Same length/order as `dates`. */
  buckets: DailyMetricsBucket[];
  priceMonthlyUsd: number;
  assumedSolvesPerUserPerMonth: number;
  /** Live active-subscriber count from the `sub:` KV scan (metrics-load.ts).
   *  Drives the real revenue/MRR block (items 6 & 9). Defaults to 0 when the
   *  caller can't/didn't scan (e.g. pure unit tests). */
  activeSubscribers?: number;
}

/** Rounds away float noise for display. `decimals` is chosen per field below
 *  so 0..1 rates and 0..100 percentages both land at hundredths-of-a-percent
 *  resolution (4dp vs 2dp respectively), and money gets sub-cent precision
 *  (6dp — this product's per-question cost is a small fraction of a cent). */
function round(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

const roundMoney = (n: number): number => round(n, 6);
const roundRate = (n: number): number => round(n, 4);
const roundPct = (n: number): number => round(n, 2);

export function aggregateMetrics(input: AggregateMetricsInput): MetricsResponse {
  const { now, days, dates, buckets, priceMonthlyUsd, assumedSolvesPerUserPerMonth } = input;
  const activeSubscribers = Math.max(0, input.activeSubscribers ?? 0);

  let questionsAnswered = 0;
  let apiCalls = 0;
  let solveAttempts = 0;
  let solveSuccesses = 0;
  let interpretAttempts = 0;
  let interpretSuccesses = 0;
  let errorsTotal = 0;
  let paywallHits30d = 0;
  const byQuestionType: Record<string, number> = {};
  const byHostHash: Record<string, number> = {};
  const confidence: ConfidenceCounts = { High: 0, Med: 0, Low: 0, "": 0 };
  const confidenceCalc: ConfidenceCounts = { High: 0, Med: 0, Low: 0, "": 0 };
  const byErrorType: Record<string, number> = {};
  const byTopic: Record<string, number> = {};
  const byCourseProfile: CourseProfileCounts = { sta301: 0, generic: 0 };
  const imageAttachment: ImageAttachmentCounts = { withImages: 0, withoutImages: 0 };
  const rPackagesCustomized: RPackagesCustomizedCounts = { customized: 0, default: 0 };
  const byRequestedPackage: Record<string, number> = {};
  const modeSplit = { concept: 0, calc: 0 };
  const writeBackByOutcome: WriteBackOutcomeCounts = { written: 0, nowrite: 0, error: 0 };
  const byFailure: Record<string, number> = {};
  const writeBackByType: Record<string, WriteBackOutcomeCounts> = {};
  const modelsUsed: Record<string, ModelUsage> = {};
  const tokens = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
  const revenueFlow = { created: 0, cancelled: 0, paymentFailed: 0 };
  let totalCostUsd = 0;
  const costUsdByMode = { concept: 0, calc: 0 };
  const serverHist = emptyHistogram();
  const clientHist = emptyHistogram();
  const rRunnerHist = emptyHistogram();
  let rRunnerRequestCount = 0;
  let rRunnerSuccessCount = 0;
  let rRunnerColdStartCount = 0;
  const rRunnerMissingPackages: Record<string, number> = {};
  const dailyByDate = new Map<string, DailyPoint>();
  const mauSet = new Set<string>();

  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i];
    const date = dates[i];
    if (!b || !date) continue;

    const sAttempts = b.server.routes.solve.attempts;
    const sSucc = b.server.routes.solve.successes;
    const iAttempts = b.server.routes.interpret.attempts;
    const iSucc = b.server.routes.interpret.successes;
    const dayErrors = b.server.routes.solve.errors + b.server.routes.interpret.errors;
    const dayCalls = sAttempts + iAttempts;
    const daySucc = sSucc + iSucc;

    questionsAnswered += sAttempts;
    apiCalls += dayCalls;
    solveAttempts += sAttempts;
    solveSuccesses += sSucc;
    interpretAttempts += iAttempts;
    interpretSuccesses += iSucc;
    errorsTotal += dayErrors;
    paywallHits30d += b.paywallHits;

    for (const [k, v] of Object.entries(b.client.byQuestionType)) {
      byQuestionType[k] = (byQuestionType[k] ?? 0) + v;
    }
    for (const [k, v] of Object.entries(b.hostHashCounts)) {
      byHostHash[k] = (byHostHash[k] ?? 0) + v;
    }
    (Object.keys(confidence) as Array<keyof ConfidenceCounts>).forEach((k) => {
      confidence[k] += b.server.confidence[k] ?? 0;
      confidenceCalc[k] += b.server.confidenceCalc[k] ?? 0;
    });
    for (const [cls, n] of Object.entries(b.server.byErrorType)) {
      byErrorType[cls] = (byErrorType[cls] ?? 0) + n;
    }
    for (const [topic, n] of Object.entries(b.server.byTopic)) {
      byTopic[topic] = (byTopic[topic] ?? 0) + n;
    }
    byCourseProfile.sta301 += b.server.byCourseProfile.sta301;
    byCourseProfile.generic += b.server.byCourseProfile.generic;
    imageAttachment.withImages += b.server.imageAttachment.withImages;
    imageAttachment.withoutImages += b.server.imageAttachment.withoutImages;
    rPackagesCustomized.customized += b.server.rPackagesCustomized.customized;
    rPackagesCustomized.default += b.server.rPackagesCustomized.default;
    for (const [pkg, n] of Object.entries(b.server.byRequestedPackage)) {
      byRequestedPackage[pkg] = (byRequestedPackage[pkg] ?? 0) + n;
    }
    modeSplit.concept += b.server.modeSplit.concept;
    modeSplit.calc += b.server.modeSplit.calc;
    writeBackByOutcome.written += b.client.writeBackByOutcome.written;
    writeBackByOutcome.nowrite += b.client.writeBackByOutcome.nowrite;
    writeBackByOutcome.error += b.client.writeBackByOutcome.error;
    for (const [k, v] of Object.entries(b.client.byFailure)) {
      byFailure[k] = (byFailure[k] ?? 0) + v;
    }
    for (const [type, o] of Object.entries(b.client.writeBackByQuestionType)) {
      const acc = writeBackByType[type] ?? { written: 0, nowrite: 0, error: 0 };
      acc.written += o.written;
      acc.nowrite += o.nowrite;
      acc.error += o.error;
      writeBackByType[type] = acc;
    }

    for (const [model, usage] of Object.entries(b.server.byModel)) {
      const acc = modelsUsed[model] ?? { calls: 0, costUsd: 0 };
      acc.calls += usage.calls;
      acc.costUsd += usage.costUsd;
      modelsUsed[model] = acc;
    }

    tokens.promptTokens += b.server.tokens.promptTokens;
    tokens.completionTokens += b.server.tokens.completionTokens;
    tokens.cachedTokens += b.server.tokens.cachedTokens;
    totalCostUsd += b.server.costUsd;
    costUsdByMode.concept += b.server.costUsdByMode.concept;
    costUsdByMode.calc += b.server.costUsdByMode.calc;
    revenueFlow.created += b.revenue.created;
    revenueFlow.cancelled += b.revenue.cancelled;
    revenueFlow.paymentFailed += b.revenue.paymentFailed;
    mergeHistogramInto(serverHist, b.server.latencyHistogram);
    mergeHistogramInto(clientHist, b.client.latencyHistogram);
    mergeHistogramInto(rRunnerHist, b.server.rRunner.latencyHistogram);
    rRunnerRequestCount += b.server.rRunner.requestCount;
    rRunnerSuccessCount += b.server.rRunner.successCount;
    rRunnerColdStartCount += b.server.rRunner.coldStartCount;
    for (const [name, n] of Object.entries(b.server.missingRPackages)) {
      rRunnerMissingPackages[name] = (rRunnerMissingPackages[name] ?? 0) + n;
    }

    for (const h of b.installHashes) mauSet.add(h);

    dailyByDate.set(date, {
      date,
      questions: sAttempts,
      apiCalls: dayCalls,
      errors: dayErrors,
      solveSuccessRate: dayCalls > 0 ? roundRate(daySucc / dayCalls) : 0,
      costUsd: roundMoney(b.server.costUsd),
      cacheHitRate:
        b.server.tokens.promptTokens > 0
          ? roundRate(b.server.tokens.cachedTokens / b.server.tokens.promptTokens)
          : 0,
      serverLatencyMsP50: Math.round(
        percentileFromHistogram(b.server.latencyHistogram, LATENCY_BUCKET_BOUNDARIES_MS, 0.5),
      ),
      concept: b.server.modeSplit.concept,
      calc: b.server.modeSplit.calc,
      imageCalls: b.server.byModel[IMAGE_VISION_MODEL]?.calls ?? 0,
      newInstalls: 0, // cross-day cohort pass (metrics-load.ts) fills this
      activeInstalls: b.installHashes.length,
      paywallHits: b.paywallHits,
      revenueCreated: b.revenue.created,
      revenueCancelled: b.revenue.cancelled,
    });
  }

  const daily = [...dates]
    .reverse()
    .map((d) => dailyByDate.get(d))
    .filter((x): x is DailyPoint => !!x);

  // dates[0]/buckets[0] = today (most-recent-first).
  const dau = buckets[0]?.installHashes.length ?? 0;
  const wauSet = new Set<string>();
  for (let i = 0; i < Math.min(7, buckets.length); i++) {
    for (const h of buckets[i]?.installHashes ?? []) wauSet.add(h);
  }
  const wau = wauSet.size;
  const mau = mauSet.size;

  const totalAttempts = solveAttempts + interpretAttempts;
  const totalSuccesses = solveSuccesses + interpretSuccesses;
  const solveSuccessRate = totalAttempts > 0 ? totalSuccesses / totalAttempts : 0;

  const writeBackTotal = writeBackByOutcome.written + writeBackByOutcome.nowrite + writeBackByOutcome.error;
  const writeBackSuccessRate = writeBackTotal > 0 ? writeBackByOutcome.written / writeBackTotal : 0;

  const writeBackByQuestionType: Record<string, WriteBackTypeStat> = {};
  for (const [type, o] of Object.entries(writeBackByType)) {
    const total = o.written + o.nowrite + o.error;
    writeBackByQuestionType[type] = { ...o, writeBackRate: total > 0 ? roundRate(o.written / total) : 0 };
  }

  const serverLatencyMsP50 = Math.round(percentileFromHistogram(serverHist, LATENCY_BUCKET_BOUNDARIES_MS, 0.5));
  const serverLatencyMsP95 = Math.round(percentileFromHistogram(serverHist, LATENCY_BUCKET_BOUNDARIES_MS, 0.95));
  const clientLatencyMsP50 = Math.round(percentileFromHistogram(clientHist, LATENCY_BUCKET_BOUNDARIES_MS, 0.5));
  const clientLatencyMsP95 = Math.round(percentileFromHistogram(clientHist, LATENCY_BUCKET_BOUNDARIES_MS, 0.95));
  const rRunnerLatencyMsP50 = Math.round(percentileFromHistogram(rRunnerHist, LATENCY_BUCKET_BOUNDARIES_MS, 0.5));
  const rRunnerLatencyMsP95 = Math.round(percentileFromHistogram(rRunnerHist, LATENCY_BUCKET_BOUNDARIES_MS, 0.95));
  const rRunnerSuccessRate = rRunnerRequestCount > 0 ? rRunnerSuccessCount / rRunnerRequestCount : 0;
  const rRunnerColdStartRatePct =
    rRunnerSuccessCount > 0 ? (rRunnerColdStartCount / rRunnerSuccessCount) * 100 : 0;

  const rate = rateForModel(PRIMARY_TEXT_MODEL);
  const avgCostPerQuestionUsd = questionsAnswered > 0 ? totalCostUsd / questionsAnswered : 0;
  const avgCostPerCalcQuestionUsd = modeSplit.calc > 0 ? costUsdByMode.calc / modeSplit.calc : 0;
  const breakEvenQuestionsPerUser = avgCostPerQuestionUsd > 0 ? priceMonthlyUsd / avgCostPerQuestionUsd : 0;
  const grossMarginPerUserPct =
    priceMonthlyUsd > 0
      ? ((priceMonthlyUsd - avgCostPerQuestionUsd * assumedSolvesPerUserPerMonth) / priceMonthlyUsd) * 100
      : 0;

  const roundedModelsUsed: Record<string, ModelUsage> = {};
  for (const [model, usage] of Object.entries(modelsUsed)) {
    roundedModelsUsed[model] = { calls: usage.calls, costUsd: roundMoney(usage.costUsd) };
  }

  // --- item 1: token/cache economics ---
  const cacheHitRate = tokens.promptTokens > 0 ? tokens.cachedTokens / tokens.promptTokens : 0;
  const tokensPerQuestion =
    questionsAnswered > 0 ? (tokens.promptTokens + tokens.completionTokens) / questionsAnswered : 0;
  const inputOutputRatio = tokens.completionTokens > 0 ? tokens.promptTokens / tokens.completionTokens : 0;

  // --- item 3: image/vision share ---
  const imageUsage = modelsUsed[IMAGE_VISION_MODEL] ?? { calls: 0, costUsd: 0 };
  const imageCallSharePct = apiCalls > 0 ? (imageUsage.calls / apiCalls) * 100 : 0;
  const imageCostSharePct = totalCostUsd > 0 ? (imageUsage.costUsd / totalCostUsd) * 100 : 0;

  // --- items 6 & 9: real revenue (activeSubscribers passed in from KV scan) ---
  const mrrUsd = activeSubscribers * priceMonthlyUsd;
  const netNewSubs30d = revenueFlow.created - revenueFlow.cancelled;
  const churnRatePct =
    activeSubscribers > 0 ? roundPct((revenueFlow.cancelled / activeSubscribers) * 100) : null;
  const realGrossMarginPct = mrrUsd > 0 ? roundPct(((mrrUsd - totalCostUsd) / mrrUsd) * 100) : null;
  const cogsPerActiveUserUsd = activeSubscribers > 0 ? roundMoney(totalCostUsd / activeSubscribers) : null;

  // --- item 7: funnel ---
  const paywallToUpgradeRatePct =
    paywallHits30d > 0 ? roundPct((revenueFlow.created / paywallHits30d) * 100) : null;

  return {
    generatedAt: now,
    range: { days },
    comparison: { prevRangeDays: 0, deltaPct: {} },
    volume: { questionsAnswered, apiCalls, byQuestionType, dau, wau, mau, newInstalls: 0, daily, byHostHash },
    quality: {
      solveSuccessRate: roundRate(solveSuccessRate),
      writeBackSuccessRate: roundRate(writeBackSuccessRate),
      writeBackByOutcome,
      writeBackByQuestionType,
      confidence,
      confidenceCalc,
      modeSplit,
      webrUsage: modeSplit.calc,
      byErrorType,
      errorsTotal,
      byFailure,
    },
    performance: {
      serverLatencyMsP50,
      serverLatencyMsP95,
      clientLatencyMsP50,
      clientLatencyMsP95,
      serverLatencyHistogram: serverHist,
      clientLatencyHistogram: clientHist,
      latencyBoundariesMs: [...LATENCY_BUCKET_BOUNDARIES_MS],
    },
    rRunner: {
      requestCount: rRunnerRequestCount,
      successRate: roundRate(rRunnerSuccessRate),
      latencyMsP50: rRunnerLatencyMsP50,
      latencyMsP95: rRunnerLatencyMsP95,
      latencyHistogram: rRunnerHist,
      coldStartRatePct: roundPct(rRunnerColdStartRatePct),
      missingRPackages: rRunnerMissingPackages,
    },
    economics: {
      model: PRIMARY_TEXT_MODEL,
      rates: rate,
      totalCostUsd: roundMoney(totalCostUsd),
      avgCostPerQuestionUsd: roundMoney(avgCostPerQuestionUsd),
      avgCostPerCalcQuestionUsd: roundMoney(avgCostPerCalcQuestionUsd),
      priceMonthlyUsd,
      assumedSolvesPerUserPerMonth,
      breakEvenQuestionsPerUser: roundMoney(breakEvenQuestionsPerUser),
      grossMarginPerUserPct: roundPct(grossMarginPerUserPct),
      modelsUsed: roundedModelsUsed,
      tokens,
      cacheHitRate: roundRate(cacheHitRate),
      tokensPerQuestion: Math.round(tokensPerQuestion),
      inputOutputRatio: roundRate(inputOutputRatio),
      imageCalls: imageUsage.calls,
      imageCallSharePct: roundPct(imageCallSharePct),
      imageCostSharePct: roundPct(imageCostSharePct),
    },
    revenue: {
      activeSubscribers,
      mrrUsd: roundMoney(mrrUsd),
      arpuUsd: activeSubscribers > 0 ? roundMoney(mrrUsd / activeSubscribers) : 0,
      created30d: revenueFlow.created,
      cancelled30d: revenueFlow.cancelled,
      paymentFailed30d: revenueFlow.paymentFailed,
      netNewSubs30d,
      churnRatePct,
      realGrossMarginPct,
      cogsPerActiveUserUsd,
    },
    funnel: {
      newInstalls30d: 0, // cross-day cohort pass (metrics-load.ts) fills this
      activeInstalls30d: mau,
      paywallHits30d,
      upgrades30d: revenueFlow.created,
      paywallToUpgradeRatePct,
    },
    retention: {
      nextDayRetentionPct: null,
      sevenDayRetentionPct: null,
      returningSharePct: null,
    },
    courseContext: {
      byTopic,
      byCourseProfile,
      imageAttachment,
      rPackagesCustomized,
      byRequestedPackage,
    },
    cloudRun: {
      available: false,
      unavailableReason: "not fetched", // metrics-load.ts overlays the real value
      billableInstanceTime: null,
      startupLatency: null,
    },
  };
}
