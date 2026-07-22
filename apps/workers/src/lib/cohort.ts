/**
 * Pure cohort / retention math for GET /api/metrics (dashboard-v2 item 8).
 *
 * Env/KV-free by design (takes plain {date, installHashes}[] in) so it's
 * directly unit-testable — see apps/workers/scripts/self-test-metrics.ts. The
 * Env-bound caller (lib/metrics-load.ts) reads the 2×window daily buckets,
 * hands their dates + installHashes here, and overlays the results onto the
 * aggregated response.
 *
 * "New install" is first-seen-in-lookback: a hash counts as new on the
 * earliest lookback day it appears. Doubling the lookback (2×window) is what
 * lets a CURRENT-window day's newInstalls exclude anyone already seen in the
 * PRIOR window — i.e. a genuine new-install signal relative to >= `window`
 * days of history. Caveat: the single OLDEST lookback day is unavoidably
 * inflated (everyone active then reads as "new", there being no earlier data),
 * but that day is always in the prior window, so it never lands in
 * current-window newInstalls; it can still nudge the retention averages, which
 * is acceptable at this scale.
 */

export interface CohortDay {
  date: string;
  installHashes: string[];
}

export interface CohortResult {
  /** New-install count keyed by date, for EVERY lookback day. The caller reads
   *  the current-window subset onto daily[].newInstalls + volume.newInstalls. */
  newInstallsByDate: Record<string, number>;
  /** Cohort next-day retention %, averaged over cohort days that have a day+1
   *  in the lookback. null when no such cohort exists. */
  nextDayRetentionPct: number | null;
  /** Cohort 7-day retention % (seen again within the next 7 days), averaged.
   *  null when no cohort has any look-forward day. */
  sevenDayRetentionPct: number | null;
  /** Share of current-window active installs that also appeared in the prior
   *  window, %. null when the current window had no active installs. */
  returningSharePct: number | null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Ascending-by-date copy; each day's hashes deduped into a Set. */
function sortedDays(days: CohortDay[]): Array<{ date: string; hashes: Set<string> }> {
  return [...days]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((d) => ({ date: d.date, hashes: new Set(d.installHashes) }));
}

/**
 * @param days              All lookback days (2×window). Order-independent —
 *                          sorted by date internally.
 * @param currentWindowDates Dates that belong to the current window; every
 *                          other supplied day is treated as the prior window
 *                          (drives returningSharePct).
 */
export function computeCohorts(days: CohortDay[], currentWindowDates: Set<string>): CohortResult {
  const ordered = sortedDays(days);

  // --- first-seen day per hash -> newInstallsByDate + per-day cohorts ---
  const seen = new Set<string>();
  const cohortByDate = new Map<string, Set<string>>();
  const newInstallsByDate: Record<string, number> = {};
  for (const { date, hashes } of ordered) {
    let n = 0;
    for (const h of hashes) {
      if (!seen.has(h)) {
        seen.add(h);
        let cohort = cohortByDate.get(date);
        if (!cohort) {
          cohort = new Set<string>();
          cohortByDate.set(date, cohort);
        }
        cohort.add(h);
        n++;
      }
    }
    newInstallsByDate[date] = n;
  }

  // --- next-day + 7-day retention, averaged over cohort days ---
  const nextDayFractions: number[] = [];
  const sevenDayFractions: number[] = [];
  for (let i = 0; i < ordered.length; i++) {
    const cohort = cohortByDate.get(ordered[i]!.date);
    if (!cohort || cohort.size === 0) continue;
    if (i + 1 >= ordered.length) continue; // no look-forward day at all

    // next-day: retained on day i+1.
    const nextHashes = ordered[i + 1]!.hashes;
    let nextRetained = 0;
    for (const h of cohort) if (nextHashes.has(h)) nextRetained++;
    nextDayFractions.push(nextRetained / cohort.size);

    // 7-day: retained on ANY of days i+1..i+7 (bounded by available data).
    let weekRetained = 0;
    for (const h of cohort) {
      for (let j = i + 1; j <= i + 7 && j < ordered.length; j++) {
        if (ordered[j]!.hashes.has(h)) {
          weekRetained++;
          break;
        }
      }
    }
    sevenDayFractions.push(weekRetained / cohort.size);
  }

  const avgPct = (xs: number[]): number | null =>
    xs.length > 0 ? round2((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) : null;

  // --- returning share: current-window actives that also appeared prior ---
  const currentActives = new Set<string>();
  const priorActives = new Set<string>();
  for (const { date, hashes } of ordered) {
    const target = currentWindowDates.has(date) ? currentActives : priorActives;
    for (const h of hashes) target.add(h);
  }
  let returningSharePct: number | null = null;
  if (currentActives.size > 0) {
    let both = 0;
    for (const h of currentActives) if (priorActives.has(h)) both++;
    returningSharePct = round2((both / currentActives.size) * 100);
  }

  return {
    newInstallsByDate,
    nextDayRetentionPct: avgPct(nextDayFractions),
    sevenDayRetentionPct: avgPct(sevenDayFractions),
    returningSharePct,
  };
}
