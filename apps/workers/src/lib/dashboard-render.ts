/**
 * Server-rendered HTML for GET /dashboard (routes/dashboard.ts). Plain
 * template-literal functions — no React, no client JS, no external assets.
 * This is a faithful port of the old apps/api/app/dashboard/{page,sections,
 * ui,dashboard.module.css} (Next.js dashboard, now removed): same 4
 * sections, same headline banner, same bar lists / stat cards / inline-SVG
 * daily sparkline, same copy, same light/dark theming.
 *
 * Every dynamic string (model ids, question-type keys — both ultimately
 * client-reported via routes/telemetry.ts, hence untrusted) is passed
 * through escapeHtml before interpolation. Numbers are formatted via
 * dashboard-format.ts's fmt* helpers first, then escaped too (a no-op for
 * their output, but cheap and keeps the "escape everything dynamic" rule
 * exceptionless).
 */

import type { MetricsResponse } from "./metrics-aggregate";
import {
  escapeHtml,
  fmtDateShort,
  fmtDateTime,
  fmtInt,
  fmtMs,
  fmtPct,
  fmtPctValue,
  fmtUsd,
  fmtUsd4,
  prettyQuestionType,
  shortModelLabel,
} from "./dashboard-format";

type Tone = "blue" | "green" | "red" | "amber" | "ink";

type VolumeMetrics = MetricsResponse["volume"];
type QualityMetrics = MetricsResponse["quality"];
type PerformanceMetrics = MetricsResponse["performance"];
type EconomicsMetrics = MetricsResponse["economics"];

function cx(...parts: Array<string | undefined | false | null>): string {
  return parts.filter((p): p is string => Boolean(p)).join(" ");
}

// ---------------------------------------------------------------------------
// design tokens + component styles — ported 1:1 from dashboard.module.css.
// No CSS Modules here, so class names are used literally (they're already
// scoped under .page, same as the source file's local names). The one
// `:global(...)` selector in the source becomes a plain selector.
// ---------------------------------------------------------------------------

const DASHBOARD_CSS = `
.page {
  --paper: #faf9f5;
  --card: #ffffff;
  --ink: #1d1c17;
  --ink-2: #55534a;
  --ink-3: #8d8a7e;
  --line: rgba(29, 28, 23, 0.12);
  --line-soft: rgba(29, 28, 23, 0.07);
  --blue: #2742c8;
  --blue-deep: #1c31a2;
  --blue-tint: rgba(39, 66, 200, 0.08);
  --green: #0b7a4b;
  --green-tint: rgba(11, 122, 75, 0.1);
  --red: #c24029;
  --red-tint: rgba(194, 64, 41, 0.1);
  --amber: #92650f;
  --amber-tint: rgba(176, 128, 26, 0.12);
  --shadow-card: 0 1px 2px rgba(29, 28, 23, 0.05), 0 8px 24px rgba(29, 28, 23, 0.06);
  --r-sm: 8px;
  --r-md: 12px;
  --r-lg: 18px;

  background: var(--paper);
  color: var(--ink);
  min-height: 100vh;
  font-family: -apple-system, "Segoe UI", system-ui, sans-serif;
  padding: 2rem 1.25rem 4rem;
}

@media (prefers-color-scheme: dark) {
  .page {
    --paper: #131310;
    --card: #1c1b17;
    --ink: #f2f0e8;
    --ink-2: #c8c4b6;
    --ink-3: #8f8b7c;
    --line: rgba(242, 240, 232, 0.14);
    --line-soft: rgba(242, 240, 232, 0.08);
    --blue: #7f96ff;
    --blue-deep: #a9b8ff;
    --blue-tint: rgba(127, 150, 255, 0.14);
    --green: #4fd08a;
    --green-tint: rgba(79, 208, 138, 0.14);
    --red: #ff8066;
    --red-tint: rgba(255, 128, 102, 0.14);
    --amber: #e8b54a;
    --amber-tint: rgba(232, 181, 74, 0.16);
    --shadow-card: 0 1px 2px rgba(0, 0, 0, 0.3), 0 8px 24px rgba(0, 0, 0, 0.35);
  }
}

html[data-theme="dark"] .page {
  --paper: #131310;
  --card: #1c1b17;
  --ink: #f2f0e8;
  --ink-2: #c8c4b6;
  --ink-3: #8f8b7c;
  --line: rgba(242, 240, 232, 0.14);
  --line-soft: rgba(242, 240, 232, 0.08);
  --blue: #7f96ff;
  --blue-deep: #a9b8ff;
  --blue-tint: rgba(127, 150, 255, 0.14);
  --green: #4fd08a;
  --green-tint: rgba(79, 208, 138, 0.14);
  --red: #ff8066;
  --red-tint: rgba(255, 128, 102, 0.14);
  --amber: #e8b54a;
  --amber-tint: rgba(232, 181, 74, 0.16);
}

.wrap {
  max-width: 1080px;
  margin: 0 auto;
}

.header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.5rem 1.5rem;
  margin-bottom: 1.5rem;
}

.title {
  font-size: 1.5rem;
  font-weight: 700;
  letter-spacing: -0.01em;
  margin: 0;
}

.subtitle {
  color: var(--ink-3);
  font-size: 0.85rem;
  font-variant-numeric: tabular-nums;
}

.demoBanner {
  background: var(--amber-tint);
  color: var(--amber);
  border: 1px solid rgba(146, 101, 15, 0.25);
  border-radius: var(--r-sm);
  padding: 0.5rem 0.85rem;
  font-size: 0.8rem;
  font-weight: 600;
  margin-bottom: 1.25rem;
  display: inline-block;
}

/* ---------- headline (unit-economics banner) ---------- */

.headline {
  background: linear-gradient(135deg, var(--blue-tint), transparent 65%);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow-card);
  padding: 1.5rem 1.75rem;
  margin-bottom: 2rem;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 1.5rem 2.5rem;
}

.headlineFigure {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.headlineLabel {
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--ink-3);
  font-weight: 600;
}

.headlineValue {
  font-size: 2.6rem;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--blue-deep);
  font-variant-numeric: tabular-nums;
  line-height: 1;
}

.headlineSub {
  display: flex;
  gap: 1.75rem;
  flex-wrap: wrap;
  margin-left: auto;
}

.headlineCaption {
  flex-basis: 100%;
  color: var(--ink-3);
  font-size: 0.78rem;
}

/* ---------- sections ---------- */

.section {
  margin-bottom: 2.25rem;
}

.sectionHead {
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
  margin-bottom: 0.9rem;
}

.sectionTitle {
  font-size: 1.05rem;
  font-weight: 700;
  margin: 0;
}

.sectionDesc {
  color: var(--ink-3);
  font-size: 0.8rem;
}

/* ---------- grids / cards ---------- */

.statGrid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 0.9rem;
  margin-bottom: 1rem;
}

.card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  box-shadow: var(--shadow-card);
  padding: 1.1rem 1.25rem;
}

.twoCol {
  display: grid;
  grid-template-columns: 1.3fr 1fr;
  gap: 0.9rem;
}

@media (max-width: 720px) {
  .twoCol {
    grid-template-columns: 1fr;
  }
}

.statLabel {
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--ink-3);
  font-weight: 600;
  margin: 0 0 0.35rem;
}

.statValue {
  font-size: 1.65rem;
  font-weight: 700;
  letter-spacing: -0.01em;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}

.statCaption {
  color: var(--ink-3);
  font-size: 0.75rem;
  margin-top: 0.3rem;
}

.tone-blue { color: var(--blue-deep); }
.tone-green { color: var(--green); }
.tone-red { color: var(--red); }
.tone-amber { color: var(--amber); }

/* ---------- bar list ---------- */

.barList {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}

.barRow {
  display: grid;
  grid-template-columns: minmax(90px, 34%) 1fr auto;
  align-items: center;
  gap: 0.6rem;
  font-size: 0.8rem;
}

.barRowLabel {
  color: var(--ink-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.barTrack {
  background: var(--line-soft);
  border-radius: 999px;
  height: 9px;
  overflow: hidden;
}

.barFill {
  height: 100%;
  border-radius: 999px;
  background: var(--blue);
}

.barFill.green { background: var(--green); }
.barFill.red { background: var(--red); }
.barFill.amber { background: var(--amber); }
.barFill.ink { background: var(--ink-3); }

.barRowValue {
  font-variant-numeric: tabular-nums;
  color: var(--ink-2);
  font-size: 0.76rem;
  min-width: 3.6rem;
  text-align: right;
}

/* ---------- daily chart ---------- */

.chartCard {
  overflow-x: auto;
}

.chartSvgWrap {
  min-width: 560px;
}

.barQuestions { fill: var(--blue); }
.barApiCalls { fill: var(--blue-tint); }
.axisLabel { fill: var(--ink-3); font-size: 9px; font-family: inherit; }
.axisLine { stroke: var(--line); stroke-width: 1; }

.chartLegend {
  display: flex;
  gap: 1.1rem;
  font-size: 0.72rem;
  color: var(--ink-3);
  margin-top: 0.5rem;
}

.legendSwatch {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 2px;
  margin-right: 0.35rem;
  vertical-align: middle;
}

/* ---------- rate table / small print ---------- */

.rateTable {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.78rem;
  margin-top: 0.5rem;
}

.rateTable th,
.rateTable td {
  text-align: left;
  padding: 0.3rem 0.6rem 0.3rem 0;
  border-bottom: 1px solid var(--line-soft);
  color: var(--ink-2);
}

.rateTable th {
  color: var(--ink-3);
  font-weight: 600;
  text-transform: uppercase;
  font-size: 0.66rem;
  letter-spacing: 0.04em;
}

.rateTable td:not(:first-child),
.rateTable th:not(:first-child) {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.mono {
  font-family: ui-monospace, "SF Mono", Consolas, monospace;
}

.caption {
  color: var(--ink-3);
  font-size: 0.78rem;
  margin-top: 0.6rem;
}

.footer {
  margin-top: 2.5rem;
  padding-top: 1rem;
  border-top: 1px solid var(--line-soft);
  color: var(--ink-3);
  font-size: 0.75rem;
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.5rem;
}

/* ---------- unavailable / empty state ---------- */

.centerState {
  max-width: 480px;
  margin: 10vh auto;
  text-align: center;
}

.centerState h1 {
  font-size: 1.2rem;
  margin-bottom: 0.6rem;
}

.centerState p {
  color: var(--ink-2);
  font-size: 0.88rem;
  line-height: 1.5;
}

.centerState code {
  background: var(--line-soft);
  border-radius: 4px;
  padding: 0.1rem 0.35rem;
}
`;

// ---------------------------------------------------------------------------
// layout primitives
// ---------------------------------------------------------------------------

function renderSection(title: string, description: string | undefined, innerHtml: string): string {
  return `<section class="section">
    <div class="sectionHead">
      <h2 class="sectionTitle">${escapeHtml(title)}</h2>
      ${description ? `<span class="sectionDesc">${escapeHtml(description)}</span>` : ""}
    </div>
    ${innerHtml}
  </section>`;
}

function renderCard(innerHtml: string, extraClass?: string): string {
  return `<div class="${cx("card", extraClass)}">${innerHtml}</div>`;
}

// ---------------------------------------------------------------------------
// stat tiles
// ---------------------------------------------------------------------------

function renderStatTile(opts: { label: string; value: string; caption?: string; tone?: Tone }): string {
  const { label, value, caption, tone } = opts;
  return `<div class="card">
    <p class="statLabel">${escapeHtml(label)}</p>
    <div class="${cx("statValue", tone && `tone-${tone}`)}">${escapeHtml(value)}</div>
    ${caption ? `<p class="statCaption">${escapeHtml(caption)}</p>` : ""}
  </div>`;
}

function renderStatGrid(tiles: string[]): string {
  return `<div class="statGrid">${tiles.join("")}</div>`;
}

// ---------------------------------------------------------------------------
// horizontal bar list (breakdowns)
// ---------------------------------------------------------------------------

interface BarListEntry {
  label: string;
  value: number;
  tone?: Tone;
}

function renderBarList(
  entries: BarListEntry[],
  opts: { formatValue?: (v: number) => string; showPct?: boolean } = {},
): string {
  const { formatValue = fmtInt, showPct = true } = opts;
  const max = Math.max(1, ...entries.map((e) => e.value));
  const total = entries.reduce((s, e) => s + e.value, 0) || 1;

  const rows = entries
    .map((e) => {
      const widthPct = Math.max(2, (e.value / max) * 100);
      // Mirrors ui.tsx's BarList: fill tone class is the bare tone name
      // (`.barFill.green` etc.) — NOT the `tone-*` naming StatTile uses for
      // text color. "blue" is the default fill, so it's skipped.
      const fillClass = cx("barFill", e.tone && e.tone !== "blue" ? e.tone : undefined);
      const valueText = `${formatValue(e.value)}${showPct ? ` · ${fmtPct(e.value / total, 0)}` : ""}`;
      return `<div class="barRow">
        <div class="barRowLabel" title="${escapeHtml(e.label)}">${escapeHtml(e.label)}</div>
        <div class="barTrack">
          <div class="${fillClass}" style="width: ${widthPct}%"></div>
        </div>
        <div class="barRowValue">${escapeHtml(valueText)}</div>
      </div>`;
    })
    .join("");

  return `<div class="barList">${rows}</div>`;
}

// ---------------------------------------------------------------------------
// daily volume chart — dependency-free inline SVG, paired bars per day
// (API calls as a pale context bar behind, questions as the solid bar).
// Native <title> elements give hover tooltips with no client JS.
// ---------------------------------------------------------------------------

function renderDailyChart(daily: VolumeMetrics["daily"]): string {
  if (daily.length === 0) {
    return `<p class="caption">No daily data in range.</p>`;
  }

  const slotW = 18;
  const padX = 12;
  const padTop = 8;
  const plotH = 100;
  const width = daily.length * slotW + padX * 2;
  const height = padTop + plotH + 22;
  const baselineY = padTop + plotH;

  const sharedMax = Math.max(1, ...daily.map((d) => Math.max(d.questions, d.apiCalls)));

  const tickIdx = new Set(
    [0, Math.floor((daily.length - 1) / 2), daily.length - 1].filter((i) => i >= 0 && i < daily.length),
  );

  const bars = daily
    .map((d, i) => {
      const barCx = padX + i * slotW + slotW / 2;
      const callsH = (d.apiCalls / sharedMax) * plotH;
      const qH = (d.questions / sharedMax) * plotH;
      const tick = tickIdx.has(i)
        ? `<text x="${barCx}" y="${height - 4}" text-anchor="middle" class="axisLabel">${escapeHtml(
            fmtDateShort(d.date),
          )}</text>`
        : "";
      const tooltip = `${d.date}: ${fmtInt(d.questions)} questions, ${fmtInt(d.apiCalls)} API calls`;
      return `<g>
        <title>${escapeHtml(tooltip)}</title>
        <rect class="barApiCalls" x="${barCx - (slotW * 0.7) / 2}" y="${baselineY - callsH}" width="${slotW * 0.7}" height="${Math.max(0.5, callsH)}" rx="1.5" />
        <rect class="barQuestions" x="${barCx - (slotW * 0.36) / 2}" y="${baselineY - qH}" width="${slotW * 0.36}" height="${Math.max(0.5, qH)}" rx="1.5" />
        ${tick}
      </g>`;
    })
    .join("");

  return `<div class="chartSvgWrap">
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="Questions answered and API calls per day">
      <line x1="${padX}" y1="${baselineY}" x2="${width - padX}" y2="${baselineY}" class="axisLine" />
      ${bars}
    </svg>
    <div class="chartLegend">
      <span><span class="legendSwatch" style="background: var(--blue)"></span>Questions answered</span>
      <span><span class="legendSwatch" style="background: var(--blue-tint)"></span>API calls</span>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// misc
// ---------------------------------------------------------------------------

function renderDemoBanner(): string {
  return `<div class="demoBanner">DEMO MODE — showing a hardcoded mock payload, not live metrics.</div>`;
}

function renderCenterState(title: string, bodyHtml: string): string {
  return `<div class="page">
    <div class="centerState">
      <h1>${escapeHtml(title)}</h1>
      ${bodyHtml}
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// headline — the number the founder actually cares about, up top
// ---------------------------------------------------------------------------

function renderStatInline(label: string, value: string): string {
  return `<div>
    <div class="headlineLabel">${escapeHtml(label)}</div>
    <div style="font-weight: 700; font-variant-numeric: tabular-nums; font-size: 1.1rem">${escapeHtml(value)}</div>
  </div>`;
}

function renderHeadlineBanner(economics: EconomicsMetrics): string {
  return `<div class="headline">
    <div class="headlineFigure">
      <span class="headlineLabel">Inference gross margin / user (COGS-only)</span>
      <span class="headlineValue">${escapeHtml(fmtPctValue(economics.grossMarginPerUserPct))}</span>
    </div>
    <div class="headlineSub">
      ${renderStatInline("Price", fmtUsd(economics.priceMonthlyUsd, 0))}
      ${renderStatInline("Break-even", `${fmtInt(economics.breakEvenQuestionsPerUser)} q/user`)}
      ${renderStatInline("Avg COGS / question", fmtUsd4(economics.avgCostPerQuestionUsd))}
      ${renderStatInline("Total cost (30d)", fmtUsd(economics.totalCostUsd))}
    </div>
    <p class="headlineCaption">
      Assumes ${fmtInt(economics.assumedSolvesPerUserPerMonth)} solves/user/mo at
      ${escapeHtml(economics.model)} rates — see the small print in Unit Economics below. Rates are
      configurable.
    </p>
    <p class="headlineCaption">
      Inference COGS only — not net/profit margin. All-in margin runs lower after payment
      processing (~5% + $0.50/txn) and free-tier bleed (~1 free user per 2 paid).
    </p>
  </div>`;
}

// ---------------------------------------------------------------------------
// 1. Volume
// ---------------------------------------------------------------------------

function renderVolumeSection(volume: VolumeMetrics, days: number): string {
  const typeEntries: BarListEntry[] = Object.entries(volume.byQuestionType)
    .map(([label, value]) => ({ label: prettyQuestionType(label), value }))
    .sort((a, b) => b.value - a.value);

  const inner = `${renderStatGrid([
    renderStatTile({ label: "Questions answered", value: fmtInt(volume.questionsAnswered), tone: "blue" }),
    renderStatTile({ label: "API calls", value: fmtInt(volume.apiCalls) }),
    renderStatTile({ label: "DAU", value: fmtInt(volume.dau), caption: "daily active users" }),
    renderStatTile({ label: "WAU", value: fmtInt(volume.wau), caption: "weekly active users" }),
  ])}
  <div class="twoCol">
    ${renderCard(
      `<p class="statLabel">Daily activity</p>${renderDailyChart(volume.daily)}`,
      "chartCard",
    )}
    ${renderCard(`<p class="statLabel">By question type</p>${renderBarList(typeEntries)}`)}
  </div>`;

  return renderSection("Volume", `last ${days}d`, inner);
}

// ---------------------------------------------------------------------------
// 2. Quality
// ---------------------------------------------------------------------------

function renderQualitySection(quality: QualityMetrics): string {
  const writeBackEntries: BarListEntry[] = [
    { label: "Written", value: quality.writeBackByOutcome.written, tone: "green" },
    { label: "No write", value: quality.writeBackByOutcome.nowrite, tone: "amber" },
    { label: "Error", value: quality.writeBackByOutcome.error, tone: "red" },
  ];
  const confidenceEntries: BarListEntry[] = [
    { label: "High", value: quality.confidence.High, tone: "green" },
    { label: "Med", value: quality.confidence.Med, tone: "amber" },
    { label: "Low", value: quality.confidence.Low, tone: "red" },
    { label: "Unset", value: quality.confidence[""], tone: "ink" },
  ];
  const modeEntries: BarListEntry[] = [
    { label: "Concept", value: quality.modeSplit.concept, tone: "blue" },
    { label: "Calc", value: quality.modeSplit.calc, tone: "green" },
  ];
  const calcTotal = Math.max(1, quality.modeSplit.calc);

  const inner = `${renderStatGrid([
    renderStatTile({ label: "Solve success rate", value: fmtPct(quality.solveSuccessRate), tone: "blue" }),
    renderStatTile({
      label: "Write-back success rate",
      value: fmtPct(quality.writeBackSuccessRate),
      caption: "best-effort, client-reported",
      tone: "blue",
    }),
    renderStatTile({
      label: "WebR usage",
      value: fmtInt(quality.webrUsage),
      caption: `${fmtPct(quality.webrUsage / calcTotal, 0)} of calc-mode solves ran client-side`,
    }),
  ])}
  <div class="twoCol">
    ${renderCard(`<p class="statLabel">Write-back outcome</p>${renderBarList(writeBackEntries)}`)}
    ${renderCard(`<p class="statLabel">Confidence distribution</p>${renderBarList(confidenceEntries)}`)}
  </div>
  <div class="twoCol" style="margin-top: 0.9rem">
    ${renderCard(`<p class="statLabel">Concept vs. calc</p>${renderBarList(modeEntries)}`)}
  </div>`;

  return renderSection("Quality", undefined, inner);
}

// ---------------------------------------------------------------------------
// 3. Performance
// ---------------------------------------------------------------------------

function renderPerformanceSection(performance: PerformanceMetrics): string {
  const inner = renderStatGrid([
    renderStatTile({ label: "Server p50", value: fmtMs(performance.serverLatencyMsP50) }),
    renderStatTile({ label: "Server p95", value: fmtMs(performance.serverLatencyMsP95), tone: "amber" }),
    renderStatTile({ label: "Client p50", value: fmtMs(performance.clientLatencyMsP50) }),
    renderStatTile({ label: "Client p95", value: fmtMs(performance.clientLatencyMsP95), tone: "amber" }),
  ]);
  return renderSection("Performance", "response latency", inner);
}

// ---------------------------------------------------------------------------
// 4. Unit economics — the full audit trail behind the headline banner
// ---------------------------------------------------------------------------

function renderEconomicsSection(economics: EconomicsMetrics): string {
  const modelsUsedEntries = economics.modelsUsed ? Object.entries(economics.modelsUsed) : [];
  const otherModelId = modelsUsedEntries.map(([id]) => id).find((id) => id !== economics.model);
  const rateCaption = otherModelId
    ? `text: ${shortModelLabel(economics.model)} · images: ${shortModelLabel(otherModelId)} — the headline COGS/margin math above uses the text rate only.`
    : `text: ${shortModelLabel(economics.model)} · images use a separate, pricier vision model not shown here.`;

  const modelsUsedCard =
    modelsUsedEntries.length > 0
      ? renderCard(`<p class="statLabel">Cost by model (30d)</p>
        <table class="rateTable">
          <thead>
            <tr><th>Model</th><th>Calls</th><th>Cost</th><th>$/call</th></tr>
          </thead>
          <tbody>
            ${modelsUsedEntries
              .map(
                ([id, usage]) => `<tr>
                  <td class="mono">${escapeHtml(shortModelLabel(id))}</td>
                  <td>${escapeHtml(fmtInt(usage.calls))}</td>
                  <td>${escapeHtml(fmtUsd(usage.costUsd))}</td>
                  <td>${escapeHtml(fmtUsd4(usage.calls > 0 ? usage.costUsd / usage.calls : 0))}</td>
                </tr>`,
              )
              .join("")}
          </tbody>
        </table>`)
      : "";

  const inner = `${renderStatGrid([
    renderStatTile({ label: "Total cost (30d)", value: fmtUsd(economics.totalCostUsd) }),
    renderStatTile({ label: "Avg COGS / question", value: fmtUsd4(economics.avgCostPerQuestionUsd) }),
    renderStatTile({
      label: "Avg COGS / calc question",
      value: fmtUsd4(economics.avgCostPerCalcQuestionUsd),
    }),
    renderStatTile({ label: "Monthly price", value: fmtUsd(economics.priceMonthlyUsd, 0) }),
    renderStatTile({
      label: "Break-even",
      value: `${fmtInt(economics.breakEvenQuestionsPerUser)} q/user`,
      caption: "questions/user/mo to cover price",
    }),
    renderStatTile({
      label: "Inference gross margin / user (COGS-only)",
      value: fmtPctValue(economics.grossMarginPerUserPct),
      tone: "green",
      caption: "not net/profit margin — see caveat above",
    }),
  ])}
  <div class="twoCol">
    ${renderCard(`<p class="statLabel">Text-solve rate (small print)</p>
      <table class="rateTable">
        <thead>
          <tr><th>Model</th><th>Input / 1M</th><th>Cached input / 1M</th><th>Output / 1M</th></tr>
        </thead>
        <tbody>
          <tr>
            <td class="mono">${escapeHtml(economics.model)}</td>
            <td>${escapeHtml(fmtUsd(economics.rates.inputPer1M, 3))}</td>
            <td>${escapeHtml(fmtUsd(economics.rates.cachedInputPer1M, 3))}</td>
            <td>${escapeHtml(fmtUsd(economics.rates.outputPer1M, 3))}</td>
          </tr>
        </tbody>
      </table>
      <p class="caption">${escapeHtml(rateCaption)}</p>`)}
    ${modelsUsedCard}
  </div>
  <p class="caption" style="margin-top: 0.6rem">
    Assumes ${fmtInt(economics.assumedSolvesPerUserPerMonth)} solves/user/mo. Gross margin =
    (price − assumed solves × avg COGS/question) / price — inference COGS only, excludes
    payment processing and free-tier bleed. Rates and the solves/user assumption are
    configurable in the worker — treat this as directional, not audited accounting.
  </p>`;

  return renderSection("Unit Economics", "auditable — model, rates, and assumptions below", inner);
}

// ---------------------------------------------------------------------------
// document assembly
// ---------------------------------------------------------------------------

function renderDocument(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${escapeHtml(title)}</title>
<style>${DASHBOARD_CSS}</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

/** Full dashboard document for the authorized, data-available path. */
export function renderDashboardPage(data: MetricsResponse, isDemo: boolean): string {
  const m = data;
  const source = isDemo
    ? "mock payload (?demo=1)"
    : "worker KV — direct read, last 30d (no HTTP hop)";

  const body = `<div class="page">
  <div class="wrap">
    ${isDemo ? renderDemoBanner() : ""}
    <header class="header">
      <h1 class="title">statshelpr metrics</h1>
      <span class="subtitle">generated ${escapeHtml(fmtDateTime(m.generatedAt))} · last ${fmtInt(m.range.days)}d</span>
    </header>

    ${renderHeadlineBanner(m.economics)}

    ${renderVolumeSection(m.volume, m.range.days)}
    ${renderQualitySection(m.quality)}
    ${renderPerformanceSection(m.performance)}
    ${renderEconomicsSection(m.economics)}

    <footer class="footer">
      <span>Internal dashboard — not for public distribution.</span>
      <span>Source: ${escapeHtml(source)}</span>
    </footer>
  </div>
</div>`;

  return renderDocument("Metrics — statshelpr", body);
}

/** Rendered when the live KV read/aggregate fails — mirrors the old page's
 * CenterState fallback. Never crashes the route. */
export function renderUnavailablePage(reason: string): string {
  const body = renderCenterState(
    "Metrics unavailable",
    `<p>${escapeHtml(reason)}</p>
    <p>
      Reload to retry, or append <code>?demo=1</code> (plus your access key) to preview the
      layout with mock data instead.
    </p>`,
  );
  return renderDocument("Metrics — statshelpr", body);
}

/** Standalone 401 page for the access gate — ported from apps/api/proxy.ts's
 * `unauthorized()`. Deliberately independent of the dashboard CSS tokens
 * above (small, self-contained, dark-only) since it must render even when
 * DASHBOARD_PASSWORD is unset / everything else about the request is
 * untrusted. */
export function renderUnauthorizedPage(reason: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>401 — Unauthorized</title>
<style>
  body { font-family: -apple-system, "Segoe UI", system-ui, sans-serif; background: #131310; color: #f2f0e8; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 1.5rem; }
  main { max-width: 30rem; }
  h1 { font-size: 1.1rem; margin: 0 0 0.75rem; }
  p { color: #c8c4b6; font-size: 0.9rem; line-height: 1.5; }
  code { background: rgba(242,240,232,0.1); border-radius: 4px; padding: 0.1rem 0.35rem; }
</style>
</head>
<body>
<main>
<h1>401 — Unauthorized</h1>
<p>${escapeHtml(reason)}</p>
</main>
</body>
</html>`;
}
