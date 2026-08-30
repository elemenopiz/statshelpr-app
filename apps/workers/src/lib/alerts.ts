/**
 * Threshold alerting (dashboard-v2 item 15).
 *
 * `evaluateAlerts` is intentionally PURE — it takes an already-loaded
 * MetricsResponse plus (optionally) the previous day's Snapshot and returns
 * the alerts that should fire, with no KV/Env/network access. That keeps the
 * thresholds unit-testable with hand-built fixtures (see the smoke test) and
 * keeps all the side effects in `sendAlerts`.
 *
 * `sendAlerts` emails the fired alerts via Resend (reusing the license-reset
 * integration's pattern) with per-type/per-day dedupe so the same alert type
 * is never emailed twice in one UTC day. If `ALERT_EMAIL` or `RESEND_API_KEY`
 * is unset, alerting is skipped silently — never a crash.
 */

import type { Env } from "../types";
import type { MetricsResponse } from "./metrics-aggregate";
import { type Snapshot, utcDateKey } from "./metrics-snapshot";
import { sendAlertEmail } from "./resend";

export type AlertSeverity = "warning" | "critical";

export type AlertType =
  | "success-rate-low"
  | "error-spike"
  | "subscription-churned"
  | "payment-failed";

export interface Alert {
  type: AlertType;
  severity: AlertSeverity;
  message: string;
}

// --- thresholds (single source of truth) ---------------------------------
/** Solve+interpret success rate below this (fraction 0..1) is critical. */
export const SUCCESS_RATE_FLOOR = 0.9;
/** Today's errors must exceed this multiple of the trailing daily average. */
export const ERROR_SPIKE_MULTIPLE = 2;
/** ...and clear this absolute floor, so tiny counts don't trip a "spike". */
export const ERROR_SPIKE_NOISE_FLOOR = 5;
/** Trailing window (days, excluding today) for the error-spike baseline. */
export const ERROR_SPIKE_TRAILING_DAYS = 7;

/** ~2 days: long enough that a same-day retry can't re-send, short enough to
 *  self-clean. The dedupe key is per UTC day, so the marker only needs to
 *  outlive the day it stamps. */
const ALERT_MARKER_TTL_SECONDS = 2 * 24 * 60 * 60;

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

/**
 * PURE: decide which alerts fire for `metrics`, optionally diffing against the
 * previous day's `prev` snapshot. No side effects — safe to unit-test.
 *
 * Fires:
 *  - success-rate-low  : quality.solveSuccessRate < SUCCESS_RATE_FLOOR
 *                        (this is an LLM-leg rate, not a question rate).
 *  - error-spike       : today's daily errors > 2× the trailing-7-day daily
 *                        average AND >= the noise floor (5).
 *  - subscription-churned : a cancellation posted today (daily[last]
 *                        .revenueCancelled > 0).
 *  - payment-failed    : revenue.paymentFailed30d rose vs `prev` snapshot.
 */
export function evaluateAlerts(metrics: MetricsResponse, prev?: Snapshot | null): Alert[] {
  const alerts: Alert[] = [];

  // 1) LLM call success rate below the floor.
  if (metrics.quality.solveSuccessRate < SUCCESS_RATE_FLOOR) {
    alerts.push({
      type: "success-rate-low",
      severity: "critical",
      message:
        `LLM call success rate ${pct(metrics.quality.solveSuccessRate)} is below the ` +
        `${pct(SUCCESS_RATE_FLOOR)} floor over the last ${metrics.range.days}d.`,
    });
  }

  // daily[] is oldest-first (see metrics-aggregate.ts), so the last element is
  // today. Guard for empty windows (noUncheckedIndexedAccess).
  const daily = metrics.volume.daily;
  const today = daily.length > 0 ? daily[daily.length - 1] : undefined;

  // 2) Error spike vs the trailing daily average (excluding today itself).
  if (today) {
    const trailing = daily.slice(0, daily.length - 1).slice(-ERROR_SPIKE_TRAILING_DAYS);
    if (trailing.length > 0) {
      const avg = trailing.reduce((s, d) => s + d.errors, 0) / trailing.length;
      if (today.errors >= ERROR_SPIKE_NOISE_FLOOR && today.errors > ERROR_SPIKE_MULTIPLE * avg) {
        alerts.push({
          type: "error-spike",
          severity: "warning",
          message:
            `Errors today (${today.errors}) exceed ${ERROR_SPIKE_MULTIPLE}× the trailing ` +
            `${trailing.length}-day average (${avg.toFixed(1)}/day).`,
        });
      }
    }
  }

  // 3) A subscription cancellation posted today.
  if (today && today.revenueCancelled > 0) {
    alerts.push({
      type: "subscription-churned",
      severity: "warning",
      message:
        `${today.revenueCancelled} subscription cancellation(s) recorded today ` +
        `(${metrics.revenue.activeSubscribers} active subscribers remaining).`,
    });
  }

  // 4) 30-day payment failures rose vs the previous snapshot.
  if (prev && metrics.revenue.paymentFailed30d > prev.revenue.paymentFailed30d) {
    const delta = metrics.revenue.paymentFailed30d - prev.revenue.paymentFailed30d;
    alerts.push({
      type: "payment-failed",
      severity: "warning",
      message:
        `30-day payment failures rose by ${delta} ` +
        `(${prev.revenue.paymentFailed30d} → ${metrics.revenue.paymentFailed30d}) ` +
        `since the ${prev.date} snapshot.`,
    });
  }

  return alerts;
}

/**
 * Email the fired alerts via Resend, with per-type/per-day dedupe. No-ops
 * (silently) when there's nothing to send or when alerting isn't configured
 * (`ALERT_EMAIL` or `RESEND_API_KEY` unset). Never throws for a config gap;
 * transient KV/email errors are swallowed so the cron handler stays green.
 */
export async function sendAlerts(env: Env, alerts: Alert[]): Promise<void> {
  if (alerts.length === 0) return;

  const to = env.ALERT_EMAIL;
  const apiKey = env.RESEND_API_KEY;
  // Not configured for alerting → skip silently (no crash, no throw).
  if (!to || !apiKey) return;

  const today = utcDateKey();

  // Dedupe: drop any alert type already emailed today.
  const fresh: Alert[] = [];
  for (const alert of alerts) {
    const marker = alertMarkerKey(alert.type, today);
    let alreadySent = false;
    try {
      alreadySent = (await env.STATSHELPR_KV.get(marker)) !== null;
    } catch {
      // KV read failed — err toward delivering rather than dropping the alert.
      alreadySent = false;
    }
    if (!alreadySent) fresh.push(alert);
  }
  if (fresh.length === 0) return;

  const subject = `statshelpr alerts (${today}): ${fresh.map((a) => a.type).join(", ")}`;
  const result = await sendAlertEmail(apiKey, to, subject, renderAlertsHtml(fresh, today));

  // Only stamp dedupe markers once the email actually went out, so a failed
  // send is retried on the next cron tick rather than suppressed.
  if (result.ok) {
    for (const alert of fresh) {
      try {
        await env.STATSHELPR_KV.put(alertMarkerKey(alert.type, today), "1", {
          expirationTtl: ALERT_MARKER_TTL_SECONDS,
        });
      } catch {
        // Best-effort marker; a missed marker only risks a duplicate email.
      }
    }
  }
}

function alertMarkerKey(type: AlertType, date: string): string {
  return `alert:${type}:${date}`;
}

function renderAlertsHtml(alerts: Alert[], date: string): string {
  const items = alerts
    .map(
      (a) =>
        `<li><strong>[${a.severity}] ${escapeHtml(a.type)}</strong> — ${escapeHtml(a.message)}</li>`,
    )
    .join("");
  return `
    <p>statshelpr founder metrics detected ${alerts.length} alert(s) on ${escapeHtml(date)} (UTC):</p>
    <ul>${items}</ul>
    <p>Open the /dashboard for full context.</p>
  `.trim();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
