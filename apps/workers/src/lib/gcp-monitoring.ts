/**
 * Live read of two Cloud Run infra metrics from the GCP Cloud Monitoring API
 * (R-runner health tracking phase 2) — a separate signal from lib/r-runner.ts
 * (which instruments OUR OWN calls to the service) and from metrics-store.ts's
 * `rRunner` bucket (which is event-sourced from those calls into KV). This
 * module talks straight to GCP on every dashboard load instead; nothing here
 * touches KV or DailyMetricsBucket.
 *
 * Auth: GCP_MONITORING_SA_KEY (a Worker secret, see wrangler.toml) holds the
 * full JSON key for statshelpr-monitoring-reader@..., a service account
 * scoped to ONLY roles/monitoring.viewer. Workers has no google-auth-library,
 * so the service-account JWT-bearer OAuth flow (RFC 7523) is hand-rolled
 * here with Web Crypto (crypto.subtle) — this is a well-trodden pattern
 * (e.g. what @tsndr/cloudflare-worker-jwt implements for RS256), short
 * enough to vendor directly rather than pull in a dependency: parse the
 * PEM, RS256-sign a self-issued JWT, exchange it for a bearer token.
 *
 * Every entry point here is best-effort: fetchCloudRunMetrics never throws,
 * it returns `{ available: false, unavailableReason }` on ANY failure
 * (missing secret, malformed key, GCP outage, expired key, network error)
 * so a GCP hiccup never takes down the rest of the dashboard. Nothing here
 * ever logs or returns the private key or the bearer token, including in
 * error messages — thrown Error text is always our own literal strings
 * (missing fields, HTTP status codes), never GCP's response body.
 */

import type { Env } from "../types";
import type { MetricsResponse } from "./metrics-aggregate";

const GCP_PROJECT_ID = "gen-lang-client-0098892631";
const CLOUD_RUN_SERVICE_NAME = "statshelpr-r-runner";
const MONITORING_READ_SCOPE = "https://www.googleapis.com/auth/monitoring.read";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";

// Cloud Run's always-free monthly allotment (independent of billing account/
// region — see cloud.google.com/run/pricing).
const FREE_TIER_VCPU_SECONDS_PER_MONTH = 180_000;
const FREE_TIER_GIB_SECONDS_PER_MONTH = 360_000;

// This service's Cloud Run resource allocation (r-runner/README.md /
// `gcloud run deploy` flags) — billable_instance_time reports raw instance-
// seconds, which we scale by these to get vCPU-sec/GiB-sec. Because the
// free-tier allotment above is ALSO a 1:2 vCPU:GiB ratio, the two burn
// percentages computed below land on the same number — expected, not a bug.
const CLOUD_RUN_VCPU_ALLOCATION = 1;
const CLOUD_RUN_GIB_ALLOCATION = 2;

type CloudRunMetrics = MetricsResponse["cloudRun"];

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  private_key_id?: string;
  token_uri?: string;
}

function unavailable(reason: string): CloudRunMetrics {
  return { available: false, unavailableReason: reason, billableInstanceTime: null, startupLatency: null };
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// base64url + PEM helpers
// ---------------------------------------------------------------------------

function base64UrlEncode(data: string | ArrayBuffer): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** GCP service-account keys ship the private key as PKCS8 PEM. Web Crypto's
 *  importKey wants the raw DER bytes, so strip the header/footer/newlines
 *  (JSON.parse already turned the JSON's literal "\n" into real newlines)
 *  and base64-decode what's left. */
function pemToDer(pem: string): ArrayBuffer {
  const b64 = pem.replace(/-----BEGIN [^-]+-----/, "").replace(/-----END [^-]+-----/, "").replace(/\s+/g, "");
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    pemToDer(pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

// ---------------------------------------------------------------------------
// service-account JWT-bearer OAuth flow (RFC 7523)
// ---------------------------------------------------------------------------

async function fetchAccessToken(sa: ServiceAccountKey): Promise<string> {
  const tokenUri = sa.token_uri || DEFAULT_TOKEN_URI;
  const nowSec = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: sa.client_email,
    scope: MONITORING_READ_SCOPE,
    aud: tokenUri,
    exp: nowSec + 3600,
    iat: nowSec,
  };
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`;
  const key = await importPrivateKey(sa.private_key);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  const jwt = `${signingInput}.${base64UrlEncode(signature)}`;

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwt,
  });
  const resp = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!resp.ok) {
    // Deliberately just the status — never the response body, which could
    // (in principle) echo request detail back.
    throw new Error(`token exchange failed (HTTP ${resp.status})`);
  }
  const json = (await resp.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("token exchange returned no access_token");
  return json.access_token;
}

// ---------------------------------------------------------------------------
// Cloud Monitoring v3 timeSeries.list
// ---------------------------------------------------------------------------

interface TimeSeriesPoint {
  value?: { doubleValue?: number; int64Value?: string };
}
interface TimeSeriesEntry {
  points?: TimeSeriesPoint[];
}
interface TimeSeriesListResponse {
  timeSeries?: TimeSeriesEntry[];
}

async function queryTimeSeries(
  accessToken: string,
  opts: {
    metricType: string;
    startTime: string;
    endTime: string;
    alignmentPeriodSeconds: number;
    perSeriesAligner: string;
    crossSeriesReducer?: string;
  },
): Promise<TimeSeriesListResponse> {
  const filter =
    `metric.type="${opts.metricType}" AND resource.type="cloud_run_revision" AND ` +
    `resource.labels.service_name="${CLOUD_RUN_SERVICE_NAME}"`;
  const params = new URLSearchParams({
    filter,
    "interval.startTime": opts.startTime,
    "interval.endTime": opts.endTime,
    "aggregation.alignmentPeriod": `${opts.alignmentPeriodSeconds}s`,
    "aggregation.perSeriesAligner": opts.perSeriesAligner,
  });
  if (opts.crossSeriesReducer) params.set("aggregation.crossSeriesReducer", opts.crossSeriesReducer);

  const url = `https://monitoring.googleapis.com/v3/projects/${GCP_PROJECT_ID}/timeSeries?${params.toString()}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!resp.ok) throw new Error(`timeSeries.list failed for ${opts.metricType} (HTTP ${resp.status})`);
  return (await resp.json()) as TimeSeriesListResponse;
}

function sumDoubleValues(resp: TimeSeriesListResponse): number {
  let total = 0;
  for (const ts of resp.timeSeries ?? []) {
    for (const p of ts.points ?? []) {
      total += p.value?.doubleValue ?? Number(p.value?.int64Value ?? 0);
    }
  }
  return total;
}

/** Multiple time series can come back if more than one revision was live in
 *  the window (e.g. mid-deploy) — averaging their per-series percentiles is
 *  an approximation (you can't losslessly combine percentiles), acceptable
 *  here per the founder-dashboard "directional, not audited" bar the rest of
 *  this dashboard already holds itself to (see dashboard-render.ts). */
function averageDoubleValues(resp: TimeSeriesListResponse): number | null {
  const vals: number[] = [];
  for (const ts of resp.timeSeries ?? []) {
    for (const p of ts.points ?? []) {
      if (p.value?.doubleValue != null) vals.push(p.value.doubleValue);
    }
  }
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

// ---------------------------------------------------------------------------
// public entry point
// ---------------------------------------------------------------------------

/**
 * Fetches this-month billable_instance_time (free-tier burn) and
 * startup_latencies p50/p95 for the statshelpr-r-runner Cloud Run service.
 * Never throws — any failure (missing/malformed secret, GCP auth failure,
 * network error, non-2xx response) collapses to `{ available: false,
 * unavailableReason }` so a caller can always render SOMETHING.
 */
export async function fetchCloudRunMetrics(env: Env): Promise<CloudRunMetrics> {
  const rawKey = env.GCP_MONITORING_SA_KEY;
  if (!rawKey) {
    return unavailable("GCP_MONITORING_SA_KEY not set (expected in local dev — see wrangler.toml)");
  }

  try {
    let sa: ServiceAccountKey;
    try {
      sa = JSON.parse(rawKey) as ServiceAccountKey;
    } catch {
      return unavailable("GCP_MONITORING_SA_KEY is not valid JSON");
    }
    if (!sa.client_email || !sa.private_key) {
      return unavailable("GCP_MONITORING_SA_KEY is missing client_email/private_key");
    }

    const accessToken = await fetchAccessToken(sa);

    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const startTime = monthStart.toISOString();
    const endTime = now.toISOString();
    // A single alignment period spanning the whole window collapses each
    // query to one aligned point per series instead of a whole time series
    // we'd have to sum/percentile ourselves.
    const windowSeconds = Math.max(60, Math.round((now.getTime() - monthStart.getTime()) / 1000));

    const billableResp = await queryTimeSeries(accessToken, {
      metricType: "run.googleapis.com/container/billable_instance_time",
      startTime,
      endTime,
      alignmentPeriodSeconds: windowSeconds,
      perSeriesAligner: "ALIGN_SUM",
      crossSeriesReducer: "REDUCE_SUM",
    });
    const billableSeconds = sumDoubleValues(billableResp);

    // ALIGN_PERCENTILE_50/95 are only valid for DELTA/GAUGE distribution-
    // valued metrics and each request accepts exactly one aligner, hence two
    // separate calls rather than one.
    const [p50Resp, p95Resp] = await Promise.all([
      queryTimeSeries(accessToken, {
        metricType: "run.googleapis.com/container/startup_latencies",
        startTime,
        endTime,
        alignmentPeriodSeconds: windowSeconds,
        perSeriesAligner: "ALIGN_PERCENTILE_50",
      }),
      queryTimeSeries(accessToken, {
        metricType: "run.googleapis.com/container/startup_latencies",
        startTime,
        endTime,
        alignmentPeriodSeconds: windowSeconds,
        perSeriesAligner: "ALIGN_PERCENTILE_95",
      }),
    ]);
    const p50Ms = averageDoubleValues(p50Resp);
    const p95Ms = averageDoubleValues(p95Resp);

    const vcpuSeconds = billableSeconds * CLOUD_RUN_VCPU_ALLOCATION;
    const gibSeconds = billableSeconds * CLOUD_RUN_GIB_ALLOCATION;

    return {
      available: true,
      unavailableReason: null,
      billableInstanceTime: {
        vcpuSeconds: Math.round(vcpuSeconds),
        gibSeconds: Math.round(gibSeconds),
        vcpuFreeTierBurnPct: round2((vcpuSeconds / FREE_TIER_VCPU_SECONDS_PER_MONTH) * 100),
        gibFreeTierBurnPct: round2((gibSeconds / FREE_TIER_GIB_SECONDS_PER_MONTH) * 100),
      },
      startupLatency:
        p50Ms == null || p95Ms == null ? null : { p50Ms: Math.round(p50Ms), p95Ms: Math.round(p95Ms) },
    };
  } catch (e) {
    return unavailable(`GCP Monitoring fetch failed: ${(e as Error)?.message || "unknown error"}`);
  }
}
