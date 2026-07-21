export type Mode = "concept" | "calc";

export interface ParsedResponse {
  mode: Mode;
  body: string;
  confidence: "High" | "Med" | "Low" | "";
  lowConfidence: boolean;
}

export function looksLikeRCode(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  const patterns: RegExp[] = [
    /<-/,
    /\blibrary\(/i,
    /\bggplot\(/i,
    /\bdplyr::/i,
    /\bmutate\(/i,
    /\bsummari[sz]e\(/i,
    /\bfilter\(/i,
    /\bgroup_by\(/i,
    /\btable\(/i,
    /\bwhich\.max\(/i,
    /\bdata\.frame\(/i,
  ];
  let score = 0;
  for (const p of patterns) if (p.test(t)) score += 1;
  return score >= 2;
}

function extractModeAndBody(taggedText: string): { mode: Mode; body: string } {
  const text = (taggedText ?? "").trim();
  if (!text) throw new Error("empty model response");

  const lines = text.split("\n");
  const firstIdx = lines.findIndex((ln) => ln.trim().length > 0);
  const firstLine = (firstIdx === -1 ? "" : (lines[firstIdx] ?? "")).trim().toUpperCase();

  let mode: Mode | null = null;
  if (firstLine === "[CONCEPT]" || firstLine === "CONCEPT") mode = "concept";
  else if (
    firstLine === "[RCODE]" ||
    firstLine === "RCODE" ||
    firstLine === "[CALC]" ||
    firstLine === "CALC"
  )
    mode = "calc";

  if (mode) {
    const body = lines.slice(firstIdx + 1).join("\n").trim();
    return { mode, body: body || text };
  }

  return { mode: looksLikeRCode(text) ? "calc" : "concept", body: text };
}

function extractConfidence(answer: string): {
  body: string;
  confidence: ParsedResponse["confidence"];
  lowConfidence: boolean;
} {
  const lines = (answer ?? "").trim().split("\n");
  if (lines.length === 0) return { body: answer, confidence: "", lowConfidence: false };
  const last = (lines[lines.length - 1] ?? "").trim();
  const m = last.match(/^CONFIDENCE:\s*(High|Med|Low)$/i);
  if (m && m[1]) {
    const conf = (m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase()) as
      | "High"
      | "Med"
      | "Low";
    const body = lines.slice(0, -1).join("\n").trim();
    return { body, confidence: conf, lowConfidence: conf === "Low" };
  }
  return { body: answer, confidence: "", lowConfidence: false };
}

export function parseResponse(rawText: string): ParsedResponse {
  const { mode, body } = extractModeAndBody(rawText);
  const conf = extractConfidence(body);
  return {
    mode,
    body: conf.body,
    confidence: conf.confidence,
    lowConfidence: conf.lowConfidence,
  };
}

export function extractRCode(text: string): string {
  let txt = (text ?? "").trim();
  const lines = txt.split("\n");
  const fenceIdxs: number[] = [];
  lines.forEach((ln, i) => {
    if (/^\s*```/.test(ln)) fenceIdxs.push(i);
  });

  if (fenceIdxs.length >= 2) {
    const code: string[] = [];
    let inside = false;
    for (const ln of lines) {
      if (/^\s*```/.test(ln)) {
        inside = !inside;
        continue;
      }
      if (inside) code.push(ln);
    }
    if (code.length > 0) txt = code.join("\n");
  }

  // Strip leaked routing/answer prose lines (preserve comments)
  const filtered = txt.split("\n").filter((ln) => {
    if (/^\s*#/.test(ln)) return true;
    return !/^\s*(\[(CONCEPT|RCODE|CALC)\]|(Final\s+answer|Answer|Why)\s*:)/i.test(ln);
  });

  // Strip stray fences
  return filtered
    .join("\n")
    .replace(/^```[rR]?\s*$/gm, "")
    .replace(/^```\s*$/gm, "")
    .trim();
}
