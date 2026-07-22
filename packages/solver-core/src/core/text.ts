/**
 * Shared text-normalization helpers. Originally lived only in
 * apps/extension-capture/src/scrape.ts; moved here so apps/extension/src/canvas-dom.ts
 * (the production solve path) can apply the same doubled-equation-text cleanup
 * as the capture pipeline, without either app duplicating (and inevitably
 * drifting on) the logic.
 */

/** Collapse runs of whitespace to a single space and trim. */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Collapse an answer that Canvas rendered twice. Equation-bearing answers carry
 * both a visual-math rendering AND the raw LaTeX source, so a choice's
 * textContent can come out as the same sentence twice ("… β 1 … \beta_1"), and
 * enhanced-content answers can double verbatim ("X X"). If the text splits into
 * two halves that are the same sentence — exactly, or equal after stripping
 * LaTeX/punctuation — keep the first (rendered) half. Otherwise return it as-is,
 * so a legitimately repeated phrase is never truncated.
 */
export function dedupeDoubled(text: string): string {
  const t = normalizeText(text);
  if (t.length < 24) return t;
  const norm = (s: string) => s.replace(/\\[a-zA-Z]+/g, "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  const head = t.slice(0, 12);
  for (let from = 8; from < t.length; ) {
    const idx = t.indexOf(head, from);
    if (idx < 0) break;
    const a = t.slice(0, idx).trim();
    const b = t.slice(idx).trim();
    if (a && b && (a === b || (norm(a).length > 4 && norm(a) === norm(b)))) return a;
    from = idx + 1;
  }
  return t;
}
