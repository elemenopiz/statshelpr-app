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

import type { DailyPoint, MetricsResponse, WriteBackTypeStat } from "./metrics-aggregate";
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
import { LATENCY_BUCKET_BOUNDARIES_MS } from "./histogram";

type Tone = "blue" | "green" | "red" | "amber" | "ink";

type VolumeMetrics = MetricsResponse["volume"];
type QualityMetrics = MetricsResponse["quality"];
type PerformanceMetrics = MetricsResponse["performance"];
type RRunnerMetrics = MetricsResponse["rRunner"];
type CloudRunMetrics = MetricsResponse["cloudRun"];
type EconomicsMetrics = MetricsResponse["economics"];
type RevenueMetrics = MetricsResponse["revenue"];
type FunnelMetrics = MetricsResponse["funnel"];
type RetentionMetrics = MetricsResponse["retention"];
type ComparisonMetrics = MetricsResponse["comparison"];

/** Time-range options for the ?range= selector (item 14). */
const RANGE_OPTIONS = [7, 30, 90] as const;

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
  --shadow-card: 0 1px 2px rgba(0, 0, 0, 0.3), 0 8px 24px rgba(0, 0, 0, 0.35);
}

/* Explicit light override so the "Light" toggle forces light even when the
   OS/browser prefers dark (the @media dark block above would otherwise win).
   Values mirror the .page base. */
html[data-theme="light"] .page {
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
}

.wrap {
  max-width: 1080px;
  margin: 0 auto;
}

.header {
  display: flex;
  align-items: center;
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

.footer a {
  color: var(--ink-3);
  text-decoration: underline;
}

.footer a:hover {
  color: var(--ink-2);
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

/* ---------- time-range selector (item 14) ---------- */

.headerControls {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.rangeSel {
  display: inline-flex;
  gap: 0.2rem;
  background: var(--line-soft);
  border-radius: 999px;
  padding: 0.2rem;
}

.rangeOpt {
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--ink-2);
  text-decoration: none;
  padding: 0.25rem 0.7rem;
  border-radius: 999px;
  line-height: 1.2;
}

.rangeOpt:hover { color: var(--ink); }

.rangeOpt.active {
  background: var(--card);
  color: var(--ink);
  box-shadow: var(--shadow-card);
}

/* ---------- delta badge + value row (item 10) ---------- */

.statValueRow {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.delta {
  display: inline-flex;
  align-items: center;
  gap: 0.15rem;
  font-size: 0.72rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  padding: 0.05rem 0.4rem;
  border-radius: 999px;
  line-height: 1.5;
  white-space: nowrap;
}

.delta.good { color: var(--green); background: var(--green-tint); }
.delta.bad { color: var(--red); background: var(--red-tint); }
.delta.flat { color: var(--ink-3); background: var(--line-soft); }

.deltaInline {
  font-size: 0.72rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.deltaInline.good { color: var(--green); }
.deltaInline.bad { color: var(--red); }
.deltaInline.flat { color: var(--ink-3); }

/* ---------- sparkline (item 10) ---------- */

.spark { display: block; margin-top: 0.5rem; }

.sparkSvg { display: block; width: 100%; height: 30px; }

/* ---------- histograms + composition (items 11, 12) ---------- */

.histBar { fill: var(--blue); }
.histBarAlt { fill: var(--green); }
.histBarR { fill: var(--amber); }
.compConcept { fill: var(--blue); }
.compCalc { fill: var(--green); }

.stack {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
}

/* ---------- funnel (revenue & funnel panel) ---------- */

.funnel {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-top: 0.4rem;
}

.funnelRow {
  display: grid;
  grid-template-columns: minmax(92px, 30%) 1fr auto;
  align-items: center;
  gap: 0.6rem;
  font-size: 0.8rem;
}

.funnelLabel {
  color: var(--ink-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.funnelTrack {
  background: var(--line-soft);
  border-radius: var(--r-sm);
  height: 20px;
  overflow: hidden;
}

.funnelBar {
  height: 100%;
  border-radius: var(--r-sm);
  background: var(--blue);
}

.funnelValue {
  font-variant-numeric: tabular-nums;
  color: var(--ink-2);
  font-size: 0.78rem;
  min-width: 3.6rem;
  text-align: right;
}

/* ---------- data-table tone spans ---------- */

.rateTable td .tone-red,
.rateTable td .tone-amber,
.rateTable td .tone-green { font-weight: 700; }

.tableScroll { overflow-x: auto; }
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

function renderStatTile(opts: {
  label: string;
  value: string;
  caption?: string;
  tone?: Tone;
  /** Pre-rendered, trusted HTML (renderDeltaBadge output) — NOT escaped. */
  deltaHtml?: string;
  /** Pre-rendered, trusted HTML (renderSparkline output) — NOT escaped. */
  sparklineHtml?: string;
}): string {
  const { label, value, caption, tone, deltaHtml, sparklineHtml } = opts;
  return `<div class="card">
    <p class="statLabel">${escapeHtml(label)}</p>
    <div class="statValueRow">
      <div class="${cx("statValue", tone && `tone-${tone}`)}">${escapeHtml(value)}</div>
      ${deltaHtml ?? ""}
    </div>
    ${sparklineHtml ?? ""}
    ${caption ? `<p class="statCaption">${escapeHtml(caption)}</p>` : ""}
  </div>`;
}

function renderStatGrid(tiles: string[]): string {
  return `<div class="statGrid">${tiles.join("")}</div>`;
}

// ---------------------------------------------------------------------------
// formatting helpers for the new null-heavy / signed fields
// ---------------------------------------------------------------------------

/** "+3" / "−1" / "0". Non-finite → "—". */
function fmtIntSigned(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "0";
  return `${n > 0 ? "+" : "−"}${fmtInt(Math.abs(n))}`;
}

/** "3.07:1" — input:output token ratio. Non-finite → "—". */
function fmtRatio(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return `${n.toFixed(2)}:1`;
}

/** Prettify an arbitrary snake_case key (error classes are client-reported,
 *  hence untrusted — the renderBarList/table sites still escapeHtml this). */
function prettyKey(key: string): string {
  const cleaned = key.replace(/_/g, " ").trim();
  if (!cleaned) return "Unknown";
  return cleaned
    .split(" ")
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

// ---------------------------------------------------------------------------
// health-threshold tones (item 13) — green/amber/red, null → neutral ink.
// ---------------------------------------------------------------------------

/** Tone for a "higher is better" metric: >= greenAt green, >= amberAt amber,
 *  else red. null/NaN → "ink" (neutral, no color). */
function toneHigherBetter(v: number | null | undefined, greenAt: number, amberAt: number): Tone {
  if (v == null || !Number.isFinite(v)) return "ink";
  if (v >= greenAt) return "green";
  if (v >= amberAt) return "amber";
  return "red";
}

/** Tone for a "lower is better" metric: <= greenBelow green, <= amberBelow
 *  amber, else red. null/NaN → "ink". */
function toneLowerBetter(v: number | null | undefined, greenBelow: number, amberBelow: number): Tone {
  if (v == null || !Number.isFinite(v)) return "ink";
  if (v <= greenBelow) return "green";
  if (v <= amberBelow) return "amber";
  return "red";
}

// ---------------------------------------------------------------------------
// delta badge (item 10) — arrow shows the ACTUAL direction of change; color
// shows whether that direction is GOOD for this metric (semantic, per key).
// ---------------------------------------------------------------------------

type GoodWhen = "up" | "down";

/** Per-metric semantics: for these, a DECREASE is the good/green direction
 *  (cost/errors/churn/paywall hits). Everything else defaults to "up = good"
 *  (success rates, revenue, users, cache hits). Keyed by comparison.deltaPct
 *  metric name. */
const DELTA_GOOD_WHEN: Record<string, GoodWhen> = {
  errorsTotal: "down",
  totalCostUsd: "down",
  avgCostPerQuestionUsd: "down",
  paywallHits30d: "down",
  churnRatePct: "down",
};

function renderDeltaBadge(
  deltaPct: number | null | undefined,
  goodWhen: GoodWhen,
  opts: { inline?: boolean } = {},
): string {
  if (deltaPct == null || !Number.isFinite(deltaPct)) return "";
  const cls = opts.inline ? "deltaInline" : "delta";
  const rounded = Math.round(deltaPct * 10) / 10;
  const magnitude = escapeHtml(fmtPctValue(Math.abs(rounded)));
  if (rounded === 0) {
    return `<span class="${cls} flat" title="No change vs prior window">±0.0%</span>`;
  }
  const up = rounded > 0;
  const good = (up && goodWhen === "up") || (!up && goodWhen === "down");
  const arrow = up ? "▲" : "▼";
  const title = escapeHtml(`${up ? "Up" : "Down"} ${fmtPctValue(Math.abs(rounded))} vs prior window`);
  return `<span class="${cls} ${good ? "good" : "bad"}" title="${title}">${arrow} ${magnitude}</span>`;
}

/** Look up a metric's semantic direction and render its window-over-window
 *  delta badge from `comparison.deltaPct`. Missing/null keys render nothing. */
function renderDeltaFor(
  comparison: ComparisonMetrics,
  key: string,
  opts: { inline?: boolean } = {},
): string {
  const goodWhen = DELTA_GOOD_WHEN[key] ?? "up";
  return renderDeltaBadge(comparison.deltaPct[key], goodWhen, opts);
}

// ---------------------------------------------------------------------------
// sparkline (item 10) — dependency-free inline SVG line + faint area fill,
// fed by a per-day series from volume.daily. Colors via a CSS var passed as
// `colorVar` (applied through style="" so var() actually evaluates — it does
// NOT in a bare fill="var(...)" presentation attribute).
// ---------------------------------------------------------------------------

function renderSparkline(values: number[], colorVar: string, opts: { label?: string } = {}): string {
  const pts = values.filter((v) => Number.isFinite(v));
  if (pts.length < 2) return "";
  const w = 240;
  const h = 30;
  const pad = 2;
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const stepX = (w - pad * 2) / (pts.length - 1);
  const coords = pts.map((v, i) => {
    const x = pad + i * stepX;
    const y = pad + (1 - (v - min) / span) * (h - pad * 2);
    return [x, y] as const;
  });
  const first = coords[0]!;
  const last = coords[coords.length - 1]!;
  const line = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const area =
    `M${first[0].toFixed(1)} ${(h - pad).toFixed(1)} ` +
    coords.map(([x, y]) => `L${x.toFixed(1)} ${y.toFixed(1)}`).join(" ") +
    ` L${last[0].toFixed(1)} ${(h - pad).toFixed(1)} Z`;
  const aria = opts.label
    ? ` role="img" aria-label="${escapeHtml(opts.label)}"`
    : ` role="img" aria-hidden="true"`;
  const titleEl = opts.label ? `<title>${escapeHtml(opts.label)}</title>` : "";
  return `<span class="spark"><svg class="sparkSvg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"${aria}>${titleEl}<path d="${area}" style="fill: ${colorVar}; fill-opacity: 0.13; stroke: none" /><path d="${line}" style="fill: none; stroke: ${colorVar}; stroke-width: 1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round" /></svg></span>`;
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
// composition over time (item 12) — one stacked bar per day: concept (bottom)
// + calc (top), scaled to the busiest day. Native <title> tooltips, no JS.
// ---------------------------------------------------------------------------

function renderCompositionChart(daily: DailyPoint[]): string {
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
  const max = Math.max(1, ...daily.map((d) => d.concept + d.calc));

  const tickIdx = new Set(
    [0, Math.floor((daily.length - 1) / 2), daily.length - 1].filter((i) => i >= 0 && i < daily.length),
  );

  const bars = daily
    .map((d, i) => {
      const barCx = padX + i * slotW + slotW / 2;
      const barW = slotW * 0.62;
      const conceptH = (d.concept / max) * plotH;
      const calcH = (d.calc / max) * plotH;
      const tick = tickIdx.has(i)
        ? `<text x="${barCx}" y="${height - 4}" text-anchor="middle" class="axisLabel">${escapeHtml(
            fmtDateShort(d.date),
          )}</text>`
        : "";
      const tooltip = `${d.date}: ${fmtInt(d.concept)} concept, ${fmtInt(d.calc)} calc`;
      const x = (barCx - barW / 2).toFixed(1);
      const bw = barW.toFixed(1);
      return `<g>
        <title>${escapeHtml(tooltip)}</title>
        <rect class="compCalc" x="${x}" y="${(baselineY - conceptH - calcH).toFixed(1)}" width="${bw}" height="${Math.max(0.5, calcH).toFixed(1)}" rx="1.5" />
        <rect class="compConcept" x="${x}" y="${(baselineY - conceptH).toFixed(1)}" width="${bw}" height="${Math.max(0.5, conceptH).toFixed(1)}" rx="1.5" />
        ${tick}
      </g>`;
    })
    .join("");

  return `<div class="chartSvgWrap">
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="Concept vs calc questions per day">
      <line x1="${padX}" y1="${baselineY}" x2="${width - padX}" y2="${baselineY}" class="axisLine" />
      ${bars}
    </svg>
    <div class="chartLegend">
      <span><span class="legendSwatch" style="background: var(--blue)"></span>Concept</span>
      <span><span class="legendSwatch" style="background: var(--green)"></span>Calc</span>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// latency distribution (item 11) — vertical bar chart over the fixed latency
// buckets, labeled with human ranges ("1–2s"). Native <title> per bar.
// ---------------------------------------------------------------------------

/** Compact single-boundary label: 250 → "250ms", 1000 → "1s", 1500 → "1.5s". */
function compactMs(n: number): string {
  if (n >= 1000) {
    const s = n / 1000;
    return `${Number.isInteger(s) ? s : s.toFixed(1)}s`;
  }
  return `${n}ms`;
}

/** Bucket range label from the boundaries array, sharing the unit where it
 *  reads cleanly ("1–2s", "250–500ms", "500ms–1s", "32s+"). */
function latencyBucketLabel(boundaries: number[], i: number): string {
  const lo = boundaries[i] ?? 0;
  const hi = boundaries[i + 1];
  if (hi === undefined) return `${compactMs(lo)}+`;
  if (lo >= 1000 && hi >= 1000) {
    const a = lo / 1000;
    const b = hi / 1000;
    return `${Number.isInteger(a) ? a : a.toFixed(1)}–${Number.isInteger(b) ? b : b.toFixed(1)}s`;
  }
  if (lo < 1000 && hi < 1000) return `${lo}–${hi}ms`;
  return `${compactMs(lo)}–${compactMs(hi)}`;
}

function renderLatencyHistogram(
  hist: number[],
  boundaries: number[],
  barClass: string,
  ariaLabel: string,
): string {
  const total = hist.reduce((s, n) => s + (n || 0), 0);
  if (total <= 0) {
    return `<p class="caption">No latency samples in range.</p>`;
  }

  const slotW = 64;
  const padX = 6;
  const padTop = 14;
  const plotH = 104;
  const labelH = 26;
  const width = hist.length * slotW + padX * 2;
  const height = padTop + plotH + labelH;
  const baselineY = padTop + plotH;
  const max = Math.max(1, ...hist);

  const bars = hist
    .map((count, i) => {
      const cx = padX + i * slotW + slotW / 2;
      const barW = slotW * 0.6;
      const barH = (count / max) * plotH;
      const label = latencyBucketLabel(boundaries, i);
      const share = total > 0 ? count / total : 0;
      const tooltip = `${label}: ${fmtInt(count)} (${fmtPct(share, 1)})`;
      const countLabel =
        count > 0
          ? `<text x="${cx}" y="${(baselineY - barH - 3).toFixed(1)}" text-anchor="middle" class="axisLabel">${escapeHtml(
              fmtInt(count),
            )}</text>`
          : "";
      return `<g>
        <title>${escapeHtml(tooltip)}</title>
        <rect class="${barClass}" x="${(cx - barW / 2).toFixed(1)}" y="${(baselineY - barH).toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0.5, barH).toFixed(1)}" rx="2" />
        ${countLabel}
        <text x="${cx}" y="${baselineY + 12}" text-anchor="middle" class="axisLabel">${escapeHtml(label)}</text>
      </g>`;
    })
    .join("");

  return `<div class="chartSvgWrap" style="min-width: ${width}px">
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="${escapeHtml(ariaLabel)}">
      <line x1="${padX}" y1="${baselineY}" x2="${width - padX}" y2="${baselineY}" class="axisLine" />
      ${bars}
    </svg>
  </div>`;
}

// ---------------------------------------------------------------------------
// conversion funnel (revenue & funnel panel) — 4 stage bars scaled to the
// biggest stage. Not forced monotonic: active installs count everyone active
// in-window, so it can exceed the new-install cohort (captioned honestly).
// ---------------------------------------------------------------------------

function renderFunnel(funnel: FunnelMetrics): string {
  const stages: Array<{ label: string; value: number; color: string }> = [
    { label: "New installs", value: funnel.newInstalls30d, color: "var(--blue)" },
    { label: "Active installs", value: funnel.activeInstalls30d, color: "var(--blue-deep)" },
    { label: "Paywall hits", value: funnel.paywallHits30d, color: "var(--amber)" },
    { label: "Upgrades", value: funnel.upgrades30d, color: "var(--green)" },
  ];
  const max = Math.max(1, ...stages.map((s) => s.value));
  const rows = stages
    .map((s) => {
      const widthPct = Math.max(2, (s.value / max) * 100);
      return `<div class="funnelRow">
        <div class="funnelLabel" title="${escapeHtml(s.label)}">${escapeHtml(s.label)}</div>
        <div class="funnelTrack"><div class="funnelBar" style="width: ${widthPct.toFixed(1)}%; background: ${s.color}"></div></div>
        <div class="funnelValue">${escapeHtml(fmtInt(s.value))}</div>
      </div>`;
    })
    .join("");
  const conv = funnel.paywallToUpgradeRatePct;
  const convCaption = `<p class="caption">Paywall → upgrade: <strong>${escapeHtml(
    fmtPctValue(conv ?? NaN),
  )}</strong>${
    conv == null ? " (no paywall hits in range)" : ""
  }. Active installs count everyone active in-window, so it can exceed the new-install cohort.</p>`;
  return `<div class="funnel">${rows}</div>${convCaption}`;
}

// ---------------------------------------------------------------------------
// write-back by question type (the "what to fix" view) — one row per type,
// sorted WORST write-back rate first, low rates in red. Type keys are
// client-reported/untrusted, so every one is escaped.
// ---------------------------------------------------------------------------

function renderWriteBackByTypeTable(byType: Record<string, WriteBackTypeStat>): string {
  const rows = Object.entries(byType)
    .map(([type, stat]) => ({ type, stat, total: stat.written + stat.nowrite + stat.error }))
    .filter((r) => r.total > 0)
    .sort((a, b) => a.stat.writeBackRate - b.stat.writeBackRate);

  if (rows.length === 0) {
    return `<p class="caption">No write-back data in range.</p>`;
  }

  const body = rows
    .map(({ type, stat, total }) => {
      const tone = toneHigherBetter(stat.writeBackRate, 0.9, 0.75);
      return `<tr>
        <td>${escapeHtml(prettyQuestionType(type))}</td>
        <td><span class="${cx(`tone-${tone}`)}">${escapeHtml(fmtPct(stat.writeBackRate))}</span></td>
        <td>${escapeHtml(fmtInt(stat.written))}</td>
        <td>${escapeHtml(fmtInt(stat.nowrite))}</td>
        <td>${escapeHtml(fmtInt(stat.error))}</td>
        <td>${escapeHtml(fmtInt(total))}</td>
      </tr>`;
    })
    .join("");

  return `<div class="tableScroll"><table class="rateTable">
    <thead>
      <tr><th>Question type</th><th>Write-back</th><th>Written</th><th>No write</th><th>Error</th><th>Total</th></tr>
    </thead>
    <tbody>${body}</tbody>
  </table></div>`;
}

// ---------------------------------------------------------------------------
// time-range selector (item 14) — links only (no client JS), preserving the
// demo flag. Cookie-based auth means there is NO key param to carry.
// ---------------------------------------------------------------------------

function renderRangeSelector(selected: number, isDemo: boolean): string {
  const demoQ = isDemo ? "&demo=1" : "";
  const opts = RANGE_OPTIONS.map((d) => {
    if (d === selected) {
      return `<span class="rangeOpt active" aria-current="true">${d}d</span>`;
    }
    return `<a class="rangeOpt" href="/dashboard?range=${d}${demoQ}">${d}d</a>`;
  }).join("");
  return `<div class="rangeSel" role="group" aria-label="Time range">${opts}</div>`;
}

// ---------------------------------------------------------------------------
// theme toggle (Auto/Light/Dark) — links only, no client JS, same segmented
// styling as the range selector. The chosen value is persisted in the
// sh_dash_theme cookie (set server-side in routes/dashboard.ts) and applied
// as <html data-theme="..."> by renderDocument; "auto" emits no attribute so
// the page follows the OS/browser prefers-color-scheme.
// ---------------------------------------------------------------------------

export type Theme = "auto" | "light" | "dark";

/** Validate an untrusted theme string (query param or cookie) — returns null
 *  for anything not in the allowed set so the caller can apply its default. */
export function parseTheme(raw: string | undefined | null): Theme | null {
  return raw === "auto" || raw === "light" || raw === "dark" ? raw : null;
}

function renderThemeSelector(current: Theme, selectedRange: number, isDemo: boolean): string {
  const demoQ = isDemo ? "&demo=1" : "";
  const opts: Array<{ v: Theme; label: string }> = [
    { v: "auto", label: "Auto" },
    { v: "light", label: "Light" },
    { v: "dark", label: "Dark" },
  ];
  const items = opts
    .map(({ v, label }) =>
      v === current
        ? `<span class="rangeOpt active" aria-current="true">${label}</span>`
        : `<a class="rangeOpt" href="/dashboard?theme=${v}&range=${selectedRange}${demoQ}">${label}</a>`,
    )
    .join("");
  return `<div class="rangeSel" role="group" aria-label="Theme">${items}</div>`;
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

function renderStatInline(label: string, value: string, deltaHtml?: string): string {
  return `<div>
    <div class="headlineLabel">${escapeHtml(label)}</div>
    <div style="display: flex; align-items: baseline; gap: 0.4rem">
      <div style="font-weight: 700; font-variant-numeric: tabular-nums; font-size: 1.1rem">${escapeHtml(value)}</div>
      ${deltaHtml ?? ""}
    </div>
  </div>`;
}

function renderHeadlineBanner(economics: EconomicsMetrics, comparison: ComparisonMetrics, days: number): string {
  return `<div class="headline">
    <div class="headlineFigure">
      <span class="headlineLabel">Inference gross margin / user (COGS-only)</span>
      <span class="headlineValue">${escapeHtml(fmtPctValue(economics.grossMarginPerUserPct))}</span>
    </div>
    <div class="headlineSub">
      ${renderStatInline("Price", fmtUsd(economics.priceMonthlyUsd, 0))}
      ${renderStatInline("Break-even", `${fmtInt(economics.breakEvenQuestionsPerUser)} q/user`)}
      ${renderStatInline(
        "Avg COGS / question",
        fmtUsd4(economics.avgCostPerQuestionUsd),
        renderDeltaFor(comparison, "avgCostPerQuestionUsd", { inline: true }),
      )}
      ${renderStatInline(
        `Total cost (${days}d)`,
        fmtUsd(economics.totalCostUsd),
        renderDeltaFor(comparison, "totalCostUsd", { inline: true }),
      )}
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
// 0. Revenue & Funnel — the founder's headline business numbers, up top.
// ---------------------------------------------------------------------------

function renderRevenueSection(
  revenue: RevenueMetrics,
  funnel: FunnelMetrics,
  comparison: ComparisonMetrics,
  days: number,
): string {
  const churnTone = toneLowerBetter(revenue.churnRatePct, 3, 6);
  const marginTone = toneHigherBetter(revenue.realGrossMarginPct, 70, 45);
  const netTone: Tone = revenue.netNewSubs30d > 0 ? "green" : revenue.netNewSubs30d < 0 ? "red" : "ink";

  const tiles = renderStatGrid([
    renderStatTile({
      label: "MRR",
      value: fmtUsd(revenue.mrrUsd, 0),
      tone: "green",
      caption: "active subs × monthly price",
      deltaHtml: renderDeltaFor(comparison, "mrrUsd"),
    }),
    renderStatTile({
      label: "Active subscribers",
      value: fmtInt(revenue.activeSubscribers),
      caption: "live count from sub: keyspace",
      deltaHtml: renderDeltaFor(comparison, "activeSubscribers"),
    }),
    renderStatTile({ label: "ARPU", value: fmtUsd(revenue.arpuUsd), caption: "revenue / active sub" }),
    renderStatTile({
      label: "Net new subs",
      value: fmtIntSigned(revenue.netNewSubs30d),
      tone: netTone,
      caption: `${fmtInt(revenue.created30d)} created · ${fmtInt(revenue.cancelled30d)} cancelled`,
    }),
    renderStatTile({
      label: "Churn rate",
      value: fmtPctValue(revenue.churnRatePct ?? NaN),
      tone: churnTone,
      caption: `cancelled / active · last ${days}d`,
    }),
    renderStatTile({
      label: "Real gross margin",
      value: fmtPctValue(revenue.realGrossMarginPct ?? NaN),
      tone: marginTone,
      caption: "(MRR − COGS) / MRR",
    }),
  ]);

  const funnelCard = renderCard(
    `<p class="statLabel">Conversion funnel · last ${days}d</p>${renderFunnel(funnel)}`,
  );
  const flowCard = renderCard(
    `<p class="statLabel">Subscription flow · last ${days}d</p>${renderBarList(
      [
        { label: "Created", value: revenue.created30d, tone: "green" },
        { label: "Cancelled", value: revenue.cancelled30d, tone: "red" },
        { label: "Payment failed", value: revenue.paymentFailed30d, tone: "amber" },
      ],
      { showPct: false },
    )}`,
  );

  const inner = `${tiles}<div class="twoCol">${funnelCard}${flowCard}</div>`;
  return renderSection("Revenue & Funnel", "real revenue, subscribers, and the install → upgrade funnel", inner);
}

// ---------------------------------------------------------------------------
// 1. Volume
// ---------------------------------------------------------------------------

function renderVolumeSection(volume: VolumeMetrics, comparison: ComparisonMetrics, days: number): string {
  const typeEntries: BarListEntry[] = Object.entries(volume.byQuestionType)
    .map(([label, value]) => ({ label: prettyQuestionType(label), value }))
    .sort((a, b) => b.value - a.value);

  const daily = volume.daily;

  const inner = `${renderStatGrid([
    renderStatTile({
      label: "Questions answered",
      value: fmtInt(volume.questionsAnswered),
      tone: "blue",
      deltaHtml: renderDeltaFor(comparison, "questionsAnswered"),
      sparklineHtml: renderSparkline(daily.map((d) => d.questions), "var(--blue)", { label: "Questions per day" }),
    }),
    renderStatTile({
      label: "API calls",
      value: fmtInt(volume.apiCalls),
      deltaHtml: renderDeltaFor(comparison, "apiCalls"),
      sparklineHtml: renderSparkline(daily.map((d) => d.apiCalls), "var(--ink-3)", { label: "API calls per day" }),
    }),
    renderStatTile({
      label: "DAU",
      value: fmtInt(volume.dau),
      caption: "daily active users",
      deltaHtml: renderDeltaFor(comparison, "dau"),
      sparklineHtml: renderSparkline(daily.map((d) => d.activeInstalls), "var(--green)", {
        label: "Active installs per day",
      }),
    }),
    renderStatTile({
      label: "WAU",
      value: fmtInt(volume.wau),
      caption: "weekly active users",
      deltaHtml: renderDeltaFor(comparison, "wau"),
    }),
    renderStatTile({
      label: "MAU",
      value: fmtInt(volume.mau),
      caption: "distinct active installs in window",
      deltaHtml: renderDeltaFor(comparison, "mau"),
    }),
    renderStatTile({
      label: "New installs",
      value: fmtInt(volume.newInstalls),
      caption: `first seen · last ${days}d`,
      sparklineHtml: renderSparkline(daily.map((d) => d.newInstalls), "var(--blue)", { label: "New installs per day" }),
    }),
  ])}
  <div class="twoCol">
    ${renderCard(`<p class="statLabel">Daily activity</p>${renderDailyChart(daily)}`, "chartCard")}
    ${renderCard(`<p class="statLabel">By question type</p>${renderBarList(typeEntries)}`)}
  </div>
  ${renderCard(
    `<p class="statLabel">Concept vs. calc over time</p>${renderCompositionChart(daily)}`,
    "chartCard",
  )}`;

  return renderSection("Volume", `last ${days}d`, inner);
}

// ---------------------------------------------------------------------------
// Retention — cohort block (item 8 data), null-safe (— when not yet computed).
// ---------------------------------------------------------------------------

function renderRetentionSection(retention: RetentionMetrics, days: number): string {
  const inner = renderStatGrid([
    renderStatTile({
      label: "Next-day retention",
      value: fmtPctValue(retention.nextDayRetentionPct ?? NaN),
      tone: toneHigherBetter(retention.nextDayRetentionPct, 30, 15),
      caption: "installs active again the next day",
    }),
    renderStatTile({
      label: "7-day retention",
      value: fmtPctValue(retention.sevenDayRetentionPct ?? NaN),
      tone: toneHigherBetter(retention.sevenDayRetentionPct, 20, 10),
      caption: "active ~7 days after first seen",
    }),
    renderStatTile({
      label: "Returning share",
      value: fmtPctValue(retention.returningSharePct ?? NaN),
      tone: toneHigherBetter(retention.returningSharePct, 50, 30),
      caption: "of active installs that are returning",
    }),
  ]);
  return renderSection("Retention", `cohorts · last ${days}d`, inner);
}

// ---------------------------------------------------------------------------
// 2. Quality
// ---------------------------------------------------------------------------

function renderConfidenceEntries(counts: QualityMetrics["confidence"]): BarListEntry[] {
  return [
    { label: "High", value: counts.High, tone: "green" },
    { label: "Med", value: counts.Med, tone: "amber" },
    { label: "Low", value: counts.Low, tone: "red" },
    { label: "Unset", value: counts[""], tone: "ink" },
  ];
}

function renderQualitySection(quality: QualityMetrics, comparison: ComparisonMetrics, apiCalls: number): string {
  const writeBackEntries: BarListEntry[] = [
    { label: "Written", value: quality.writeBackByOutcome.written, tone: "green" },
    { label: "No write", value: quality.writeBackByOutcome.nowrite, tone: "amber" },
    { label: "Error", value: quality.writeBackByOutcome.error, tone: "red" },
  ];
  const modeEntries: BarListEntry[] = [
    { label: "Concept", value: quality.modeSplit.concept, tone: "blue" },
    { label: "Calc", value: quality.modeSplit.calc, tone: "green" },
  ];
  const errorEntries: BarListEntry[] = Object.entries(quality.byErrorType)
    .map(([label, value]) => ({ label: prettyKey(label), value, tone: "red" as Tone }))
    .sort((a, b) => b.value - a.value);
  const calcTotal = Math.max(1, quality.modeSplit.calc);
  const errorRate = apiCalls > 0 ? quality.errorsTotal / apiCalls : 0;

  const inner = `${renderStatGrid([
    renderStatTile({
      label: "Solve success rate",
      value: fmtPct(quality.solveSuccessRate),
      tone: toneHigherBetter(quality.solveSuccessRate, 0.95, 0.9),
      deltaHtml: renderDeltaFor(comparison, "solveSuccessRate"),
    }),
    renderStatTile({
      label: "Write-back success rate",
      value: fmtPct(quality.writeBackSuccessRate),
      caption: "best-effort, client-reported",
      tone: toneHigherBetter(quality.writeBackSuccessRate, 0.9, 0.75),
      deltaHtml: renderDeltaFor(comparison, "writeBackSuccessRate"),
    }),
    renderStatTile({
      label: "Errors",
      value: fmtInt(quality.errorsTotal),
      caption: `${fmtPct(errorRate)} of API calls`,
      tone: toneLowerBetter(errorRate, 0.03, 0.07),
      deltaHtml: renderDeltaFor(comparison, "errorsTotal"),
    }),
    renderStatTile({
      label: "Calc R runs",
      value: fmtInt(quality.webrUsage),
      caption: `${fmtPct(quality.webrUsage / calcTotal, 0)} of calc-mode solves executed R server-side`,
    }),
  ])}
  <div class="twoCol">
    ${renderCard(
      `<p class="statLabel">Write-back by question type</p><p class="statCaption" style="margin: 0 0 0.4rem">Worst first — the "what to fix" view. Rates under 75% in red.</p>${renderWriteBackByTypeTable(
        quality.writeBackByQuestionType,
      )}`,
    )}
    ${renderCard(
      `<p class="statLabel">Errors by type</p>${
        quality.errorsTotal > 0
          ? `${renderBarList(errorEntries)}<p class="caption">${escapeHtml(
              fmtInt(quality.errorsTotal),
            )} failed solve/interpret calls in range.</p>`
          : `<p class="caption">No errors in range.</p>`
      }`,
    )}
  </div>
  <div class="twoCol" style="margin-top: 0.9rem">
    ${renderCard(`<p class="statLabel">Write-back outcome</p>${renderBarList(writeBackEntries)}`)}
    ${renderCard(`<p class="statLabel">Concept vs. calc</p>${renderBarList(modeEntries)}`)}
  </div>
  <div class="twoCol" style="margin-top: 0.9rem">
    ${renderCard(
      `<p class="statLabel">Confidence — concept path</p>${renderBarList(renderConfidenceEntries(quality.confidence))}`,
    )}
    ${renderCard(
      `<p class="statLabel">Confidence — calc path</p>${renderBarList(renderConfidenceEntries(quality.confidenceCalc))}`,
    )}
  </div>`;

  return renderSection("Quality", undefined, inner);
}

// ---------------------------------------------------------------------------
// 3. Performance
// ---------------------------------------------------------------------------

function renderPerformanceSection(performance: PerformanceMetrics): string {
  const tiles = renderStatGrid([
    renderStatTile({ label: "Server p50", value: fmtMs(performance.serverLatencyMsP50) }),
    renderStatTile({ label: "Server p95", value: fmtMs(performance.serverLatencyMsP95), tone: "amber" }),
    renderStatTile({ label: "Client p50", value: fmtMs(performance.clientLatencyMsP50) }),
    renderStatTile({ label: "Client p95", value: fmtMs(performance.clientLatencyMsP95), tone: "amber" }),
  ]);

  const serverCard = renderCard(
    `<p class="statLabel">Server latency distribution</p>${renderLatencyHistogram(
      performance.serverLatencyHistogram,
      performance.latencyBoundariesMs,
      "histBar",
      "Server latency distribution by bucket",
    )}`,
    "chartCard",
  );
  const clientCard = renderCard(
    `<p class="statLabel">Client latency distribution</p><p class="statCaption" style="margin: 0 0 0.4rem">End-to-end, includes the full solve round trip + write-back</p>${renderLatencyHistogram(
      performance.clientLatencyHistogram,
      performance.latencyBoundariesMs,
      "histBarAlt",
      "Client latency distribution by bucket",
    )}`,
    "chartCard",
  );

  const inner = `${tiles}<div class="stack">${serverCard}${clientCard}</div>`;
  return renderSection("Performance", "response latency + full distribution", inner);
}

// ---------------------------------------------------------------------------
// 3b. R-runner health — Cloud Run R-execution service (a distinct signal from
// the Gemini solve/interpret latency above)
// ---------------------------------------------------------------------------

function renderRRunnerSection(rRunner: RRunnerMetrics): string {
  const tiles = renderStatGrid([
    renderStatTile({ label: "Requests", value: fmtInt(rRunner.requestCount) }),
    renderStatTile({
      label: "Success rate",
      value: fmtPct(rRunner.successRate),
      tone: toneHigherBetter(rRunner.successRate, 0.95, 0.9),
    }),
    renderStatTile({ label: "p50", value: fmtMs(rRunner.latencyMsP50) }),
    renderStatTile({ label: "p95", value: fmtMs(rRunner.latencyMsP95), tone: "amber" }),
    renderStatTile({
      label: "Cold-start rate",
      value: fmtPctValue(rRunner.coldStartRatePct),
      tone: toneLowerBetter(rRunner.coldStartRatePct, 10, 25),
    }),
  ]);

  const histCard = renderCard(
    `<p class="statLabel">R-runner latency distribution</p><p class="statCaption" style="margin: 0 0 0.4rem">Cloud Run R-execution service — durationMs self-reported by the runner</p>${renderLatencyHistogram(
      rRunner.latencyHistogram,
      [...LATENCY_BUCKET_BOUNDARIES_MS],
      "histBarR",
      "R-runner latency distribution by bucket",
    )}`,
    "chartCard",
  );

  const inner = `${tiles}<div class="stack">${histCard}</div>`;
  return renderSection("R-Runner Health", "Cloud Run R-execution service — volume, latency, cold starts", inner);
}

// ---------------------------------------------------------------------------
// 3c. Cloud Run infra (GCP) — free-tier burn + cold-start latency pulled
// live from GCP Cloud Monitoring (R-runner health tracking phase 2), a
// distinct data source from the Worker-side rRunner section above.
// ---------------------------------------------------------------------------

function renderCloudRunSection(cloudRun: CloudRunMetrics): string {
  if (!cloudRun.available || !cloudRun.billableInstanceTime) {
    const inner = renderCard(`<p class="statLabel">GCP metrics unavailable</p>
      <p class="statCaption">${escapeHtml(cloudRun.unavailableReason ?? "unknown reason")}</p>`);
    return renderSection(
      "Cloud Run Infra (GCP)",
      "free-tier burn + cold-start latency, live from Cloud Monitoring",
      inner,
    );
  }

  const { vcpuSeconds, gibSeconds, vcpuFreeTierBurnPct, gibFreeTierBurnPct } = cloudRun.billableInstanceTime;
  const startup = cloudRun.startupLatency;

  const tiles = renderStatGrid([
    renderStatTile({
      label: "vCPU-sec this month",
      value: fmtInt(vcpuSeconds),
      caption: `of 180,000 free-tier/mo`,
    }),
    renderStatTile({
      label: "vCPU free-tier burn",
      value: fmtPctValue(vcpuFreeTierBurnPct),
      tone: toneLowerBetter(vcpuFreeTierBurnPct, 50, 80),
    }),
    renderStatTile({
      label: "GiB-sec this month",
      value: fmtInt(gibSeconds),
      caption: `of 360,000 free-tier/mo`,
    }),
    renderStatTile({
      label: "GiB free-tier burn",
      value: fmtPctValue(gibFreeTierBurnPct),
      tone: toneLowerBetter(gibFreeTierBurnPct, 50, 80),
    }),
    renderStatTile({
      label: "Cold-start p50",
      value: startup ? fmtMs(startup.p50Ms) : "—",
      caption: "container startup only",
    }),
    renderStatTile({
      label: "Cold-start p95",
      value: startup ? fmtMs(startup.p95Ms) : "—",
      tone: "amber",
      caption: "container startup only",
    }),
  ]);

  const inner = `${tiles}<p class="caption" style="margin-top: 0.6rem">
    vCPU-sec and GiB-sec burn tracking closely is expected: this service is allocated 1 vCPU / 2Gi,
    the same 1:2 ratio as the free-tier allotment itself (180,000 / 360,000 per month). Cold-start
    figures come from Cloud Run's own <span class="mono">startup_latencies</span> metric — a more
    precise signal than the R-Runner Health section's inferred cold-start rate above, which only
    approximates it from request duration.
  </p>`;

  return renderSection(
    "Cloud Run Infra (GCP)",
    "free-tier burn + cold-start latency, live from Cloud Monitoring",
    inner,
  );
}

// ---------------------------------------------------------------------------
// 4. Unit economics — the full audit trail behind the headline banner
// ---------------------------------------------------------------------------

function renderEconomicsSection(
  economics: EconomicsMetrics,
  revenue: RevenueMetrics,
  comparison: ComparisonMetrics,
  days: number,
): string {
  const modelsUsedEntries = economics.modelsUsed ? Object.entries(economics.modelsUsed) : [];
  const otherModelId = modelsUsedEntries.map(([id]) => id).find((id) => id !== economics.model);
  const rateCaption = otherModelId
    ? `text: ${shortModelLabel(economics.model)} · images: ${shortModelLabel(otherModelId)} — the headline COGS/margin math above uses the text rate only.`
    : `text: ${shortModelLabel(economics.model)} · images use a separate, pricier vision model not shown here.`;

  const cacheTone = toneHigherBetter(economics.cacheHitRate, 0.25, 0.12);
  const realMarginTone = toneHigherBetter(revenue.realGrossMarginPct, 70, 45);

  const modelsUsedCard =
    modelsUsedEntries.length > 0
      ? renderCard(`<p class="statLabel">Cost by model (${days}d)</p>
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

  // Reconcile the assumption-based headline margin against the real blended
  // margin from live MRR + actual spend (items 1 & 9).
  const reconcileCard = renderCard(`<p class="statLabel">Assumption vs. reality</p>
    <table class="rateTable">
      <tbody>
        <tr>
          <td>Headline margin (COGS-only, assumption-based)</td>
          <td>${escapeHtml(fmtPctValue(economics.grossMarginPerUserPct))}</td>
        </tr>
        <tr>
          <td>Real blended margin (live MRR − ${days}d COGS)</td>
          <td><span class="${cx(`tone-${realMarginTone}`)}">${escapeHtml(
            fmtPctValue(revenue.realGrossMarginPct ?? NaN),
          )}</span></td>
        </tr>
        <tr><td>MRR (live)</td><td>${escapeHtml(fmtUsd(revenue.mrrUsd, 0))}</td></tr>
        <tr><td>COGS this window</td><td>${escapeHtml(fmtUsd(economics.totalCostUsd))}</td></tr>
        <tr><td>Real COGS / active user</td><td>${escapeHtml(fmtUsd4(revenue.cogsPerActiveUserUsd ?? NaN))}</td></tr>
      </tbody>
    </table>
    <p class="caption">The headline banner assumes ${fmtInt(
      economics.assumedSolvesPerUserPerMonth,
    )} solves/user/mo; this reconciles it against live revenue and actual spend.</p>`);

  const inner = `${renderStatGrid([
    renderStatTile({
      label: `Total cost (${days}d)`,
      value: fmtUsd(economics.totalCostUsd),
      deltaHtml: renderDeltaFor(comparison, "totalCostUsd"),
    }),
    renderStatTile({
      label: "Avg COGS / question",
      value: fmtUsd4(economics.avgCostPerQuestionUsd),
      deltaHtml: renderDeltaFor(comparison, "avgCostPerQuestionUsd"),
    }),
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
  <p class="statLabel" style="margin: 0.5rem 0 0.6rem">Real usage &amp; blended margin</p>
  ${renderStatGrid([
    renderStatTile({
      label: "Cache hit rate",
      value: fmtPct(economics.cacheHitRate),
      tone: cacheTone,
      caption: "cached / prompt tokens — main COGS lever",
      deltaHtml: renderDeltaFor(comparison, "cacheHitRate"),
    }),
    renderStatTile({
      label: "Tokens / question",
      value: fmtInt(economics.tokensPerQuestion),
      caption: "prompt + completion",
    }),
    renderStatTile({
      label: "Input : output ratio",
      value: fmtRatio(economics.inputOutputRatio),
      caption: "prompt : completion tokens",
    }),
    renderStatTile({
      label: "Image call share",
      value: fmtPctValue(economics.imageCallSharePct),
      caption: `${fmtInt(economics.imageCalls)} vision-model calls`,
    }),
    renderStatTile({
      label: "Image cost share",
      value: fmtPctValue(economics.imageCostSharePct),
      tone: "amber",
      caption: "of total COGS",
    }),
    renderStatTile({
      label: "Real blended margin",
      value: fmtPctValue(revenue.realGrossMarginPct ?? NaN),
      tone: realMarginTone,
      caption: "MRR-based, from live revenue",
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
  <div class="twoCol" style="margin-top: 0.9rem">
    ${reconcileCard}
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

function renderDocument(title: string, bodyHtml: string, theme: Theme = "auto"): string {
  // "auto" emits no attribute so the page follows prefers-color-scheme; an
  // explicit light/dark forces that theme via the html[data-theme=...] CSS.
  const themeAttr = theme === "auto" ? "" : ` data-theme="${theme}"`;
  return `<!doctype html>
<html lang="en"${themeAttr}>
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

/**
 * Full dashboard document for the authorized, data-available path.
 *
 * `selectedRange` drives only the time-range selector's active highlight and
 * defaults to the data's own window, so the existing two-arg call
 * `renderDashboardPage(data, isDemo)` (and the demo QA harness) keeps working
 * unchanged. In demo mode the mock is always a 30d payload regardless of the
 * selected range — the label text follows the data (`m.range.days`).
 */
export function renderDashboardPage(
  data: MetricsResponse,
  isDemo: boolean,
  selectedRange: number = data.range.days,
  theme: Theme = "dark",
): string {
  const m = data;
  const days = m.range.days;
  const source = isDemo
    ? "mock payload (?demo=1)"
    : `worker KV — direct read, last ${days}d (no HTTP hop)`;

  const body = `<div class="page">
  <div class="wrap">
    ${isDemo ? renderDemoBanner() : ""}
    <header class="header">
      <div>
        <h1 class="title">statshelpr metrics</h1>
        <div class="subtitle">generated ${escapeHtml(fmtDateTime(m.generatedAt))} · last ${fmtInt(days)}d</div>
      </div>
      <div class="headerControls">
        ${renderThemeSelector(theme, selectedRange, isDemo)}
        ${renderRangeSelector(selectedRange, isDemo)}
      </div>
    </header>

    ${renderHeadlineBanner(m.economics, m.comparison, days)}

    ${renderRevenueSection(m.revenue, m.funnel, m.comparison, days)}
    ${renderVolumeSection(m.volume, m.comparison, days)}
    ${renderRetentionSection(m.retention, days)}
    ${renderQualitySection(m.quality, m.comparison, m.volume.apiCalls)}
    ${renderPerformanceSection(m.performance)}
    ${renderRRunnerSection(m.rRunner)}
    ${renderCloudRunSection(m.cloudRun)}
    ${renderEconomicsSection(m.economics, m.revenue, m.comparison, days)}

    <footer class="footer">
      <span>Internal dashboard — not for public distribution.</span>
      <span>Source: ${escapeHtml(source)} · <a href="/dashboard/logout">Log out</a></span>
    </footer>
  </div>
</div>`;

  return renderDocument("Metrics — statshelpr", body, theme);
}

/** Rendered when the live KV read/aggregate fails — mirrors the old page's
 * CenterState fallback. Never crashes the route. */
export function renderUnavailablePage(reason: string): string {
  const body = renderCenterState(
    "Metrics unavailable",
    `<p>${escapeHtml(reason)}</p>
    <p>
      Reload to retry, or append <code>?demo=1</code> to preview the layout with mock data
      instead.
    </p>`,
  );
  return renderDocument("Metrics — statshelpr", body);
}

export interface LoginPageOptions {
  /** Shown as a red error banner — e.g. "Incorrect password." after a
   *  failed POST /dashboard/login. Omitted on a plain GET with no session. */
  error?: string;
  /** DASHBOARD_PASSWORD is unset on this worker, so login can never
   *  succeed. Shown as a persistent amber note and disables the form. */
  notConfigured?: boolean;
}

/**
 * Login page for the access gate — served at GET /dashboard whenever there's
 * no valid session cookie, and re-rendered by POST /dashboard/login on
 * failure. Replaces the old renderUnauthorizedPage 401 page from the
 * `?key=` era (a login prompt on GET is no longer treated as an error page;
 * see routes/dashboard.ts's doc comment). Deliberately independent of the
 * dashboard CSS tokens above (small, self-contained, dark-only) since it
 * must render even when DASHBOARD_PASSWORD is unset / everything else about
 * the request is untrusted. Styling ported 1:1 from the old
 * renderUnauthorizedPage (same bg/ink/card colors) with a card + form added.
 */
export function renderLoginPage(opts: LoginPageOptions = {}): string {
  const { error, notConfigured } = opts;
  const disabledAttr = notConfigured ? " disabled" : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>Log in — statshelpr metrics</title>
<style>
  body { font-family: -apple-system, "Segoe UI", system-ui, sans-serif; background: #131310; color: #f2f0e8; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 1.5rem; }
  main.card { width: 100%; max-width: 22rem; background: #1c1b17; border: 1px solid rgba(242, 240, 232, 0.14); border-radius: 18px; box-shadow: 0 1px 2px rgba(0,0,0,0.3), 0 8px 24px rgba(0,0,0,0.35); padding: 2rem 1.75rem; box-sizing: border-box; }
  h1 { font-size: 1.1rem; margin: 0 0 0.4rem; }
  p.lede { color: #c8c4b6; font-size: 0.85rem; margin: 0 0 1.4rem; line-height: 1.5; }
  label { display: block; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em; color: #8f8b7c; font-weight: 600; margin-bottom: 0.4rem; }
  input[type="password"] { width: 100%; box-sizing: border-box; background: #131310; border: 1px solid rgba(242, 240, 232, 0.16); border-radius: 8px; color: #f2f0e8; font-size: 0.95rem; padding: 0.65rem 0.75rem; margin-bottom: 1.15rem; }
  input[type="password"]:focus { outline: none; border-color: #7f96ff; }
  input[type="password"]:disabled { opacity: 0.5; }
  button { width: 100%; background: #7f96ff; color: #131310; border: none; border-radius: 8px; font-size: 0.9rem; font-weight: 700; padding: 0.7rem 0.75rem; cursor: pointer; }
  button:hover { background: #a9b8ff; }
  button:disabled { background: #55534a; color: #8f8b7c; cursor: not-allowed; }
  .error { background: rgba(255, 128, 102, 0.14); color: #ff8066; border: 1px solid rgba(255, 128, 102, 0.3); border-radius: 8px; padding: 0.55rem 0.75rem; font-size: 0.82rem; margin-bottom: 1.15rem; }
  .note { background: rgba(232, 181, 74, 0.16); color: #e8b54a; border: 1px solid rgba(232, 181, 74, 0.3); border-radius: 8px; padding: 0.55rem 0.75rem; font-size: 0.8rem; margin-top: 1.4rem; line-height: 1.5; }
  code { background: rgba(242,240,232,0.1); border-radius: 4px; padding: 0.1rem 0.35rem; }
</style>
</head>
<body>
<main class="card">
  <h1>statshelpr metrics</h1>
  <p class="lede">Enter the dashboard password to continue.</p>
  ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
  <form method="POST" action="/dashboard/login">
    <label for="password">Password</label>
    <input type="password" name="password" id="password" autofocus autocomplete="current-password"${disabledAttr} />
    <button type="submit"${disabledAttr}>Log in</button>
  </form>
  ${notConfigured ? `<p class="note">Dashboard not configured: DASHBOARD_PASSWORD is unset on this worker, so login is disabled. Set it with <code>wrangler secret put DASHBOARD_PASSWORD</code> (see wrangler.toml) to enable access.</p>` : ""}
</main>
</body>
</html>`;
}
