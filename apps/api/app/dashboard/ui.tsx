import styles from "./dashboard.module.css";
import { fmtDateShort, fmtInt, fmtPct } from "./format";
import type { DailyVolumePoint } from "./types";

/** Join classNames, dropping falsy/undefined entries. Needed because CSS
 * Modules are typed as a bare index signature (`{ [key: string]: string }`),
 * so under `noUncheckedIndexedAccess` any bracket lookup is `string |
 * undefined` — this keeps that out of the DOM instead of stringifying to
 * the literal text "undefined". */
export function cx(...parts: Array<string | undefined | false | null>): string {
  return parts.filter((p): p is string => Boolean(p)).join(" ");
}

type Tone = "blue" | "green" | "red" | "amber" | "ink";

// ---------------------------------------------------------------------------
// layout primitives
// ---------------------------------------------------------------------------

export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>{title}</h2>
        {description && <span className={styles.sectionDesc}>{description}</span>}
      </div>
      {children}
    </section>
  );
}

export function Card({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cx(styles.card, className)}>{children}</div>;
}

// ---------------------------------------------------------------------------
// stat tiles
// ---------------------------------------------------------------------------

export function StatTile({
  label,
  value,
  caption,
  tone,
}: {
  label: string;
  value: string;
  caption?: string;
  tone?: Tone;
}) {
  return (
    <div className={styles.card}>
      <p className={styles.statLabel}>{label}</p>
      <div className={cx(styles.statValue, tone && styles[`tone-${tone}`])}>{value}</div>
      {caption && <p className={styles.statCaption}>{caption}</p>}
    </div>
  );
}

export function StatGrid({ children }: { children: React.ReactNode }) {
  return <div className={styles.statGrid}>{children}</div>;
}

// ---------------------------------------------------------------------------
// horizontal bar list (breakdowns)
// ---------------------------------------------------------------------------

export interface BarListEntry {
  label: string;
  value: number;
  tone?: Tone;
}

export function BarList({
  entries,
  formatValue = fmtInt,
  showPct = true,
}: {
  entries: BarListEntry[];
  formatValue?: (v: number) => string;
  showPct?: boolean;
}) {
  const max = Math.max(1, ...entries.map((e) => e.value));
  const total = entries.reduce((s, e) => s + e.value, 0) || 1;
  return (
    <div className={styles.barList}>
      {entries.map((e) => (
        <div className={styles.barRow} key={e.label}>
          <div className={styles.barRowLabel} title={e.label}>
            {e.label}
          </div>
          <div className={styles.barTrack}>
            <div
              className={cx(styles.barFill, e.tone && e.tone !== "blue" && styles[e.tone])}
              style={{ width: `${Math.max(2, (e.value / max) * 100)}%` }}
            />
          </div>
          <div className={styles.barRowValue}>
            {formatValue(e.value)}
            {showPct ? ` · ${fmtPct(e.value / total, 0)}` : ""}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// daily volume chart — dependency-free inline SVG, paired bars per day
// (API calls as a pale context bar behind, questions as the solid bar).
// Native <title> elements give hover tooltips with no client JS.
// ---------------------------------------------------------------------------

export function DailyChart({ daily }: { daily: DailyVolumePoint[] }) {
  if (daily.length === 0) {
    return <p className={styles.caption}>No daily data in range.</p>;
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
    [0, Math.floor((daily.length - 1) / 2), daily.length - 1].filter(
      (i) => i >= 0 && i < daily.length,
    ),
  );

  return (
    <div className={styles.chartSvgWrap}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label="Questions answered and API calls per day"
      >
        <line
          x1={padX}
          y1={baselineY}
          x2={width - padX}
          y2={baselineY}
          className={styles.axisLine}
        />
        {daily.map((d, i) => {
          const cx0 = padX + i * slotW + slotW / 2;
          const callsH = (d.apiCalls / sharedMax) * plotH;
          const qH = (d.questions / sharedMax) * plotH;
          return (
            <g key={d.date}>
              <title>
                {`${d.date}: ${fmtInt(d.questions)} questions, ${fmtInt(d.apiCalls)} API calls`}
              </title>
              <rect
                className={styles.barApiCalls}
                x={cx0 - (slotW * 0.7) / 2}
                y={baselineY - callsH}
                width={slotW * 0.7}
                height={Math.max(0.5, callsH)}
                rx={1.5}
              />
              <rect
                className={styles.barQuestions}
                x={cx0 - (slotW * 0.36) / 2}
                y={baselineY - qH}
                width={slotW * 0.36}
                height={Math.max(0.5, qH)}
                rx={1.5}
              />
              {tickIdx.has(i) && (
                <text
                  x={cx0}
                  y={height - 4}
                  textAnchor="middle"
                  className={styles.axisLabel}
                >
                  {fmtDateShort(d.date)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <div className={styles.chartLegend}>
        <span>
          <span className={styles.legendSwatch} style={{ background: "var(--blue)" }} />
          Questions answered
        </span>
        <span>
          <span className={styles.legendSwatch} style={{ background: "var(--blue-tint)" }} />
          API calls
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// misc
// ---------------------------------------------------------------------------

export function DemoBanner() {
  return (
    <div className={styles.demoBanner}>
      DEMO MODE — showing a hardcoded mock payload, not live metrics.
    </div>
  );
}

export function CenterState({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.page}>
      <div className={styles.centerState}>
        <h1>{title}</h1>
        {children}
      </div>
    </div>
  );
}
