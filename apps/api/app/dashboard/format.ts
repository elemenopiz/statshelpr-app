/** Number/currency/percent formatting for the metrics dashboard. Kept
 * dependency-free (Intl is built into the Node/edge runtime). */

const intFmt = new Intl.NumberFormat("en-US");

export function fmtInt(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return intFmt.format(Math.round(n));
}

/** fraction is 0..1 */
export function fmtPct(fraction: number, digits = 1): string {
  if (!Number.isFinite(fraction)) return "—";
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** Already a percent value (0..100), e.g. grossMarginPerUserPct. */
export function fmtPctValue(pct: number, digits = 1): string {
  if (!Number.isFinite(pct)) return "—";
  return `${pct.toFixed(digits)}%`;
}

export function fmtUsd(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** For sub-cent COGS figures where 2 decimals round to $0.00. */
export function fmtUsd4(n: number): string {
  if (!Number.isFinite(n)) return "—";
  // Show as many decimals as needed to keep at least 2 significant digits,
  // capped at 4, so e.g. $0.0186 and $0.3400 both read sensibly.
  const digits = Math.abs(n) > 0 && Math.abs(n) < 0.01 ? 4 : 2;
  return fmtUsd(n, digits);
}

export function fmtMs(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1000) return `${(n / 1000).toFixed(2)}s`;
  return `${fmtInt(n)}ms`;
}

export function fmtDateShort(dateStr: string): string {
  // Avoid `new Date("YYYY-MM-DD")` UTC-midnight surprises by parsing manually.
  const parts = dateStr.split("-");
  const mo = Number(parts[1]);
  const d = Number(parts[2]);
  if (!mo || !d) return dateStr;
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${months[mo - 1] ?? ""} ${d}`;
}

export function fmtDateTime(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** "gemini-3.5-flash-lite" -> "3.5 Flash Lite". Cosmetic only. */
export function shortModelLabel(id: string): string {
  const stripped = id.replace(/^gemini-/i, "");
  return stripped
    .split(/[-_]/)
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** "multiple_choice_question" -> "Multiple Choice", "" -> "Unset". */
export function prettyQuestionType(key: string): string {
  const cleaned = key.replace(/_question$/i, "").replace(/_/g, " ").trim();
  if (!cleaned) return "Unset";
  return cleaned
    .split(" ")
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}
