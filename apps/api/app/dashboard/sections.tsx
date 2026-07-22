import styles from "./dashboard.module.css";
import {
  fmtInt,
  fmtMs,
  fmtPct,
  fmtPctValue,
  fmtUsd,
  fmtUsd4,
  prettyQuestionType,
  shortModelLabel,
} from "./format";
import type {
  EconomicsMetrics,
  PerformanceMetrics,
  QualityMetrics,
  VolumeMetrics,
} from "./types";
import { BarList, Card, DailyChart, Section, StatGrid, StatTile } from "./ui";

// ---------------------------------------------------------------------------
// headline — the number the founder actually cares about, up top
// ---------------------------------------------------------------------------

export function HeadlineBanner({ economics }: { economics: EconomicsMetrics }) {
  return (
    <div className={styles.headline}>
      <div className={styles.headlineFigure}>
        <span className={styles.headlineLabel}>Inference gross margin / user (COGS-only)</span>
        <span className={styles.headlineValue}>
          {fmtPctValue(economics.grossMarginPerUserPct)}
        </span>
      </div>
      <div className={styles.headlineSub}>
        <StatInline label="Price" value={fmtUsd(economics.priceMonthlyUsd, 0)} />
        <StatInline
          label="Break-even"
          value={`${fmtInt(economics.breakEvenQuestionsPerUser)} q/user`}
        />
        <StatInline label="Avg COGS / question" value={fmtUsd4(economics.avgCostPerQuestionUsd)} />
        <StatInline label="Total cost (30d)" value={fmtUsd(economics.totalCostUsd)} />
      </div>
      <p className={styles.headlineCaption}>
        Assumes {fmtInt(economics.assumedSolvesPerUserPerMonth)} solves/user/mo at{" "}
        {economics.model} rates — see the small print in Unit Economics below. Rates are
        configurable.
      </p>
      <p className={styles.headlineCaption}>
        Inference COGS only — not net/profit margin. All-in margin runs lower after payment
        processing (~5% + $0.50/txn) and free-tier bleed (~1 free user per 2 paid).
      </p>
    </div>
  );
}

function StatInline({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className={styles.headlineLabel}>{label}</div>
      <div style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums", fontSize: "1.1rem" }}>
        {value}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1. Volume
// ---------------------------------------------------------------------------

export function VolumeSection({ volume, days }: { volume: VolumeMetrics; days: number }) {
  const typeEntries = Object.entries(volume.byQuestionType)
    .map(([label, value]) => ({ label: prettyQuestionType(label), value }))
    .sort((a, b) => b.value - a.value);

  return (
    <Section title="Volume" description={`last ${days}d`}>
      <StatGrid>
        <StatTile label="Questions answered" value={fmtInt(volume.questionsAnswered)} tone="blue" />
        <StatTile label="API calls" value={fmtInt(volume.apiCalls)} />
        <StatTile label="DAU" value={fmtInt(volume.dau)} caption="daily active users" />
        <StatTile label="WAU" value={fmtInt(volume.wau)} caption="weekly active users" />
      </StatGrid>
      <div className={styles.twoCol}>
        <Card className={styles.chartCard}>
          <p className={styles.statLabel}>Daily activity</p>
          <DailyChart daily={volume.daily} />
        </Card>
        <Card>
          <p className={styles.statLabel}>By question type</p>
          <BarList entries={typeEntries} />
        </Card>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// 2. Quality
// ---------------------------------------------------------------------------

export function QualitySection({ quality }: { quality: QualityMetrics }) {
  const writeBackEntries = [
    { label: "Written", value: quality.writeBackByOutcome.written, tone: "green" as const },
    { label: "No write", value: quality.writeBackByOutcome.nowrite, tone: "amber" as const },
    { label: "Error", value: quality.writeBackByOutcome.error, tone: "red" as const },
  ];
  const confidenceEntries = [
    { label: "High", value: quality.confidence.High, tone: "green" as const },
    { label: "Med", value: quality.confidence.Med, tone: "amber" as const },
    { label: "Low", value: quality.confidence.Low, tone: "red" as const },
    { label: "Unset", value: quality.confidence[""], tone: "ink" as const },
  ];
  const modeEntries = [
    { label: "Concept", value: quality.modeSplit.concept, tone: "blue" as const },
    { label: "Calc", value: quality.modeSplit.calc, tone: "green" as const },
  ];
  const calcTotal = Math.max(1, quality.modeSplit.calc);

  return (
    <Section title="Quality">
      <StatGrid>
        <StatTile
          label="Solve success rate"
          value={fmtPct(quality.solveSuccessRate)}
          tone="blue"
        />
        <StatTile
          label="Write-back success rate"
          value={fmtPct(quality.writeBackSuccessRate)}
          caption="best-effort, client-reported"
          tone="blue"
        />
        <StatTile
          label="WebR usage"
          value={fmtInt(quality.webrUsage)}
          caption={`${fmtPct(quality.webrUsage / calcTotal, 0)} of calc-mode solves ran client-side`}
        />
      </StatGrid>
      <div className={styles.twoCol}>
        <Card>
          <p className={styles.statLabel}>Write-back outcome</p>
          <BarList entries={writeBackEntries} />
        </Card>
        <Card>
          <p className={styles.statLabel}>Confidence distribution</p>
          <BarList entries={confidenceEntries} />
        </Card>
      </div>
      <div className={styles.twoCol} style={{ marginTop: "0.9rem" }}>
        <Card>
          <p className={styles.statLabel}>Concept vs. calc</p>
          <BarList entries={modeEntries} />
        </Card>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// 3. Performance
// ---------------------------------------------------------------------------

export function PerformanceSection({ performance }: { performance: PerformanceMetrics }) {
  return (
    <Section title="Performance" description="response latency">
      <StatGrid>
        <StatTile label="Server p50" value={fmtMs(performance.serverLatencyMsP50)} />
        <StatTile label="Server p95" value={fmtMs(performance.serverLatencyMsP95)} tone="amber" />
        <StatTile label="Client p50" value={fmtMs(performance.clientLatencyMsP50)} />
        <StatTile label="Client p95" value={fmtMs(performance.clientLatencyMsP95)} tone="amber" />
      </StatGrid>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// 4. Unit economics — the full audit trail behind the headline banner
// ---------------------------------------------------------------------------

export function EconomicsSection({ economics }: { economics: EconomicsMetrics }) {
  const modelsUsedEntries = economics.modelsUsed ? Object.entries(economics.modelsUsed) : [];
  const otherModelId = modelsUsedEntries.map(([id]) => id).find((id) => id !== economics.model);
  const rateCaption = otherModelId
    ? `text: ${shortModelLabel(economics.model)} · images: ${shortModelLabel(otherModelId)} — the headline COGS/margin math above uses the text rate only.`
    : `text: ${shortModelLabel(economics.model)} · images use a separate, pricier vision model not shown here.`;

  return (
    <Section title="Unit Economics" description="auditable — model, rates, and assumptions below">
      <StatGrid>
        <StatTile label="Total cost (30d)" value={fmtUsd(economics.totalCostUsd)} />
        <StatTile label="Avg COGS / question" value={fmtUsd4(economics.avgCostPerQuestionUsd)} />
        <StatTile
          label="Avg COGS / calc question"
          value={fmtUsd4(economics.avgCostPerCalcQuestionUsd)}
        />
        <StatTile label="Monthly price" value={fmtUsd(economics.priceMonthlyUsd, 0)} />
        <StatTile
          label="Break-even"
          value={`${fmtInt(economics.breakEvenQuestionsPerUser)} q/user`}
          caption="questions/user/mo to cover price"
        />
        <StatTile
          label="Inference gross margin / user (COGS-only)"
          value={fmtPctValue(economics.grossMarginPerUserPct)}
          tone="green"
          caption="not net/profit margin — see caveat above"
        />
      </StatGrid>
      <div className={styles.twoCol}>
        <Card>
          <p className={styles.statLabel}>Text-solve rate (small print)</p>
          <table className={styles.rateTable}>
            <thead>
              <tr>
                <th>Model</th>
                <th>Input / 1M</th>
                <th>Cached input / 1M</th>
                <th>Output / 1M</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className={styles.mono}>{economics.model}</td>
                <td>{fmtUsd(economics.rates.inputPer1M, 3)}</td>
                <td>{fmtUsd(economics.rates.cachedInputPer1M, 3)}</td>
                <td>{fmtUsd(economics.rates.outputPer1M, 3)}</td>
              </tr>
            </tbody>
          </table>
          <p className={styles.caption}>{rateCaption}</p>
        </Card>
        {modelsUsedEntries.length > 0 && (
          <Card>
            <p className={styles.statLabel}>Cost by model (30d)</p>
            <table className={styles.rateTable}>
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Calls</th>
                  <th>Cost</th>
                  <th>$/call</th>
                </tr>
              </thead>
              <tbody>
                {modelsUsedEntries.map(([id, usage]) => (
                  <tr key={id}>
                    <td className={styles.mono}>{shortModelLabel(id)}</td>
                    <td>{fmtInt(usage.calls)}</td>
                    <td>{fmtUsd(usage.costUsd)}</td>
                    <td>{fmtUsd4(usage.calls > 0 ? usage.costUsd / usage.calls : 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>
      <p className={styles.caption} style={{ marginTop: "0.6rem" }}>
        Assumes {fmtInt(economics.assumedSolvesPerUserPerMonth)} solves/user/mo. Gross margin =
        (price − assumed solves × avg COGS/question) / price — inference COGS only, excludes
        payment processing and free-tier bleed. Rates and the solves/user assumption are
        configurable in the worker — treat this as directional, not audited accounting.
      </p>
    </Section>
  );
}
