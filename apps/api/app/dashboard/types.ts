/**
 * Shape of `GET {METRICS_API_URL}/api/metrics`, served by the Cloudflare
 * Worker (apps/workers). This dashboard is a read-only server-side consumer
 * — keep this file in sync with the worker's response shape, not the other
 * way around.
 */

export interface DailyVolumePoint {
  date: string; // YYYY-MM-DD
  questions: number;
  apiCalls: number;
}

export interface VolumeMetrics {
  questionsAnswered: number;
  apiCalls: number;
  byQuestionType: Record<string, number>;
  dau: number;
  wau: number;
  daily: DailyVolumePoint[];
}

export interface WriteBackByOutcome {
  written: number;
  nowrite: number;
  error: number;
}

export interface ConfidenceBreakdown {
  High: number;
  Med: number;
  Low: number;
  "": number;
}

export interface ModeSplit {
  concept: number;
  calc: number;
}

export interface QualityMetrics {
  solveSuccessRate: number; // 0..1
  writeBackSuccessRate: number; // 0..1, best-effort / client-reported
  writeBackByOutcome: WriteBackByOutcome;
  confidence: ConfidenceBreakdown;
  modeSplit: ModeSplit;
  webrUsage: number;
}

export interface PerformanceMetrics {
  serverLatencyMsP50: number;
  serverLatencyMsP95: number;
  clientLatencyMsP50: number;
  clientLatencyMsP95: number;
}

export interface EconomicsRates {
  inputPer1M: number;
  outputPer1M: number;
  cachedInputPer1M: number;
}

export interface ModelUsage {
  calls: number;
  costUsd: number;
}

export interface EconomicsMetrics {
  /** Primary (text-solve) model — the one `rates` describes and the one the
   * headline COGS/margin math is computed from. Image solves route to a
   * different, pricier model; see `modelsUsed` for the actual per-model
   * split when the worker provides it. */
  model: string;
  rates: EconomicsRates;
  totalCostUsd: number;
  avgCostPerQuestionUsd: number;
  avgCostPerCalcQuestionUsd: number;
  priceMonthlyUsd: number;
  assumedSolvesPerUserPerMonth: number;
  breakEvenQuestionsPerUser: number;
  /** Inference-COGS-only margin — excludes payment processing fees and
   * free-tier bleed. Not net/profit margin. */
  grossMarginPerUserPct: number;
  /** Optional: per-model call count + cost breakdown, e.g.
   * `{ "gemini-3.5-flash-lite": { calls, costUsd }, "gemini-3.6-flash": {...} }`.
   * May be absent on older worker responses — render defensively. */
  modelsUsed?: Record<string, ModelUsage>;
}

export interface MetricsPayload {
  generatedAt: number; // ms epoch
  range: { days: number };
  volume: VolumeMetrics;
  quality: QualityMetrics;
  performance: PerformanceMetrics;
  economics: EconomicsMetrics;
}
