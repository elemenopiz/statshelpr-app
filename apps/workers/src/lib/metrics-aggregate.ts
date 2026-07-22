/**
 * Pure aggregation: merges N daily KV buckets (lib/metrics-store.ts) into the
 * GET /api/metrics response shape. Deliberately takes plain data in (no KV/
 * Env access) so it's directly unit-testable with mock buckets — see
 * apps/workers/scripts/self-test-metrics.ts — and so routes/metrics.ts stays
 * a thin KV-fetch + auth wrapper around this.
 */

import {
  type ConfidenceCounts,
  type DailyMetricsBucket,
  type ModelUsage,
} from "./metrics-store";
import {
  emptyHistogram,
  LATENCY_BUCKET_BOUNDARIES_MS,
  mergeHistogramInto,
  percentileFromHistogram,
} from "./histogram";
import { PRIMARY_TEXT_MODEL, rateForModel } from "./cost";

export interface MetricsResponse {
  generatedAt: number;
  range: { days: number };
  volume: {
    questionsAnswered: number;
    apiCalls: number;
    byQuestionType: Record<string, number>;
    dau: number;
    wau: number;
    daily: Array<{ date: string; questions: number; apiCalls: number }>;
  };
  quality: {
    solveSuccessRate: number;
    writeBackSuccessRate: number;
    writeBackByOutcome: { written: number; nowrite: number; error: number };
    confidence: ConfidenceCounts;
    modeSplit: { concept: number; calc: number };
    webrUsage: number;
  };
  performance: {
    serverLatencyMsP50: number;
    serverLatencyMsP95: number;
    clientLatencyMsP50: number;
    clientLatencyMsP95: number;
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

  let questionsAnswered = 0;
  let apiCalls = 0;
  let solveAttempts = 0;
  let solveSuccesses = 0;
  let interpretAttempts = 0;
  let interpretSuccesses = 0;
  const byQuestionType: Record<string, number> = {};
  const confidence: ConfidenceCounts = { High: 0, Med: 0, Low: 0, "": 0 };
  const modeSplit = { concept: 0, calc: 0 };
  const writeBackByOutcome = { written: 0, nowrite: 0, error: 0 };
  const modelsUsed: Record<string, ModelUsage> = {};
  let totalCostUsd = 0;
  const costUsdByMode = { concept: 0, calc: 0 };
  const serverHist = emptyHistogram();
  const clientHist = emptyHistogram();
  const dailyByDate = new Map<string, { date: string; questions: number; apiCalls: number }>();

  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i];
    const date = dates[i];
    if (!b || !date) continue;

    const sAttempts = b.server.routes.solve.attempts;
    const sSucc = b.server.routes.solve.successes;
    const iAttempts = b.server.routes.interpret.attempts;
    const iSucc = b.server.routes.interpret.successes;

    questionsAnswered += sAttempts;
    apiCalls += sAttempts + iAttempts;
    solveAttempts += sAttempts;
    solveSuccesses += sSucc;
    interpretAttempts += iAttempts;
    interpretSuccesses += iSucc;

    dailyByDate.set(date, { date, questions: sAttempts, apiCalls: sAttempts + iAttempts });

    for (const [k, v] of Object.entries(b.client.byQuestionType)) {
      byQuestionType[k] = (byQuestionType[k] ?? 0) + v;
    }
    (Object.keys(confidence) as Array<keyof ConfidenceCounts>).forEach((k) => {
      confidence[k] += b.server.confidence[k] ?? 0;
    });
    modeSplit.concept += b.server.modeSplit.concept;
    modeSplit.calc += b.server.modeSplit.calc;
    writeBackByOutcome.written += b.client.writeBackByOutcome.written;
    writeBackByOutcome.nowrite += b.client.writeBackByOutcome.nowrite;
    writeBackByOutcome.error += b.client.writeBackByOutcome.error;

    for (const [model, usage] of Object.entries(b.server.byModel)) {
      const acc = modelsUsed[model] ?? { calls: 0, costUsd: 0 };
      acc.calls += usage.calls;
      acc.costUsd += usage.costUsd;
      modelsUsed[model] = acc;
    }

    totalCostUsd += b.server.costUsd;
    costUsdByMode.concept += b.server.costUsdByMode.concept;
    costUsdByMode.calc += b.server.costUsdByMode.calc;
    mergeHistogramInto(serverHist, b.server.latencyHistogram);
    mergeHistogramInto(clientHist, b.client.latencyHistogram);
  }

  const daily = [...dates]
    .reverse()
    .map((d) => dailyByDate.get(d))
    .filter((x): x is { date: string; questions: number; apiCalls: number } => !!x);

  // dates[0]/buckets[0] = today (most-recent-first).
  const dau = buckets[0]?.installHashes.length ?? 0;
  const wauSet = new Set<string>();
  for (let i = 0; i < Math.min(7, buckets.length); i++) {
    for (const h of buckets[i]?.installHashes ?? []) wauSet.add(h);
  }
  const wau = wauSet.size;

  const totalAttempts = solveAttempts + interpretAttempts;
  const totalSuccesses = solveSuccesses + interpretSuccesses;
  const solveSuccessRate = totalAttempts > 0 ? totalSuccesses / totalAttempts : 0;

  const writeBackTotal = writeBackByOutcome.written + writeBackByOutcome.nowrite + writeBackByOutcome.error;
  const writeBackSuccessRate = writeBackTotal > 0 ? writeBackByOutcome.written / writeBackTotal : 0;

  const serverLatencyMsP50 = Math.round(percentileFromHistogram(serverHist, LATENCY_BUCKET_BOUNDARIES_MS, 0.5));
  const serverLatencyMsP95 = Math.round(percentileFromHistogram(serverHist, LATENCY_BUCKET_BOUNDARIES_MS, 0.95));
  const clientLatencyMsP50 = Math.round(percentileFromHistogram(clientHist, LATENCY_BUCKET_BOUNDARIES_MS, 0.5));
  const clientLatencyMsP95 = Math.round(percentileFromHistogram(clientHist, LATENCY_BUCKET_BOUNDARIES_MS, 0.95));

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

  return {
    generatedAt: now,
    range: { days },
    volume: { questionsAnswered, apiCalls, byQuestionType, dau, wau, daily },
    quality: {
      solveSuccessRate: roundRate(solveSuccessRate),
      writeBackSuccessRate: roundRate(writeBackSuccessRate),
      writeBackByOutcome,
      confidence,
      modeSplit,
      webrUsage: modeSplit.calc,
    },
    performance: { serverLatencyMsP50, serverLatencyMsP95, clientLatencyMsP50, clientLatencyMsP95 },
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
    },
  };
}
