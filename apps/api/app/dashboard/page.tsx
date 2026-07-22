import type { Metadata } from "next";
import { fmtDateTime } from "./format";
import styles from "./dashboard.module.css";
import { buildMockMetrics } from "./mock";
import {
  EconomicsSection,
  HeadlineBanner,
  PerformanceSection,
  QualitySection,
  VolumeSection,
} from "./sections";
import type { MetricsPayload } from "./types";
import { CenterState, DemoBanner } from "./ui";

export const metadata: Metadata = { title: "Metrics — statshelpr" };

// Access-gated by ../../proxy.ts (DASHBOARD_PASSWORD vs ?key=/cookie).
// Always request-time — the metrics fetch is `cache: "no-store"` and must
// never run at build time (no live endpoint during `next build`).
export const dynamic = "force-dynamic";

const DEFAULT_METRICS_API_URL = "https://api.statshelpr.com";

type LoadResult = { ok: true; data: MetricsPayload } | { ok: false; reason: string };

async function loadMetrics(isDemo: boolean): Promise<LoadResult> {
  if (isDemo) {
    return { ok: true, data: buildMockMetrics() };
  }

  const base = process.env["METRICS_API_URL"] || DEFAULT_METRICS_API_URL;
  const token = process.env["METRICS_TOKEN"];
  if (!token) {
    return { ok: false, reason: "METRICS_TOKEN is not set on this server." };
  }

  try {
    const res = await fetch(`${base}/api/metrics`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) {
      return {
        ok: false,
        reason: `Metrics endpoint responded ${res.status} ${res.statusText}.`,
      };
    }
    const data = (await res.json()) as MetricsPayload;
    return { ok: true, data };
  } catch (e) {
    return {
      ok: false,
      reason: `Could not reach metrics endpoint at ${base}: ${(e as Error).message}`,
    };
  }
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  const isDemo = sp["demo"] === "1";

  const result = await loadMetrics(isDemo);

  if (!result.ok) {
    return (
      <CenterState title="Metrics unavailable">
        <p>{result.reason}</p>
        <p>
          Configure <code>METRICS_API_URL</code> and <code>METRICS_TOKEN</code> as server-only
          env vars (Vercel project settings, or <code>apps/api/.env.local</code> for local dev),
          then reload. Append <code>?demo=1</code> (plus your access key) to preview the layout
          with mock data instead.
        </p>
      </CenterState>
    );
  }

  const m = result.data;
  const source = isDemo
    ? "mock payload (?demo=1)"
    : `${process.env["METRICS_API_URL"] || DEFAULT_METRICS_API_URL}/api/metrics`;

  return (
    <div className={styles.page}>
      <div className={styles.wrap}>
        {isDemo && <DemoBanner />}
        <header className={styles.header}>
          <h1 className={styles.title}>statshelpr metrics</h1>
          <span className={styles.subtitle}>
            generated {fmtDateTime(m.generatedAt)} · last {m.range.days}d
          </span>
        </header>

        <HeadlineBanner economics={m.economics} />

        <VolumeSection volume={m.volume} days={m.range.days} />
        <QualitySection quality={m.quality} />
        <PerformanceSection performance={m.performance} />
        <EconomicsSection economics={m.economics} />

        <footer className={styles.footer}>
          <span>Internal dashboard — not for public distribution.</span>
          <span>Source: {source}</span>
        </footer>
      </div>
    </div>
  );
}
