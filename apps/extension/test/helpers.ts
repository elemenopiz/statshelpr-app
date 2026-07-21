/**
 * Shared round-trip plumbing — mirrors the exact wiring in
 * apps/extension/src/content.ts (see its onSolve(), around the
 * scraped.choices.map / scraped.blanks.map calls and the final
 * writeBlanks/selectAnswerChoice dispatch) so every test in this suite drives
 * canvas-dom.ts + @statshelpr/solver-core the same way production does:
 *   scrapeQuestion/collectAnswerChoices/collectBlanks (canvas-dom.ts)
 *     -> choiceTypeForApi (canvas-dom.ts) to build the wire-shaped payload
 *     -> deriveSelectedChoices / deriveBlankAnswers (solver-core, the
 *        "server") to turn a model answer string into labels/blank answers
 *     -> selectAnswerChoice / writeBlanks (canvas-dom.ts) to write back
 */
import type { AnswerChoice as ApiAnswerChoice, SolveBlank } from "@statshelpr/solver-core/solver";
import { choiceTypeForApi, type AnswerChoice, type ScrapedBlank } from "../src/canvas-dom";

export function toApiChoices(choices: AnswerChoice[]): ApiAnswerChoice[] {
  return choices.map((c) => ({ label: c.label, text: c.text, type: choiceTypeForApi(c) }));
}

export function toApiBlanks(blanks: ScrapedBlank[]): SolveBlank[] {
  return blanks.map((b) => ({ key: b.key, label: b.label, options: b.options.map((o) => o.text) }));
}

/** Attach input/change listeners to every input/select under `root` BEFORE
 * a write-back call, so the test can assert canvas-dom.ts actually dispatches
 * them (React-controlled Canvas inputs only pick up a write via these events).
 * Returns a Set of elements that fired at least one of each. */
export function trackEvents(root: HTMLElement): {
  firedInput: Set<Element>;
  firedChange: Set<Element>;
} {
  const firedInput = new Set<Element>();
  const firedChange = new Set<Element>();
  const targets = [...root.querySelectorAll<HTMLElement>("input, select")];
  for (const el of targets) {
    el.addEventListener("input", () => firedInput.add(el));
    el.addEventListener("change", () => firedChange.add(el));
  }
  return { firedInput, firedChange };
}

/** Every leading word that would make canvas-dom.ts's `pickByLetterOrText`
 * regex (`/^\s*(?:Answer\s*:?\s*)?\(?([A-Za-z]|\d{1,2})\)?[\s.,)]?/`) treat
 * the FIRST character as a letter/digit choice-index token. Any fallback-path
 * ("client-side text matching") test answer must NOT let that short-circuit
 * land on a valid index within the fixture's choice pool, or the test would
 * pass for the wrong reason (index luck, not real text matching). "Working"
 * starts with 'W' -> index 22, safely out of range for every fixture in this
 * suite (max ~9 options), so every fallback-path answer below is prefixed
 * with it. */
export const FALLBACK_PREFIX = "Working through this step by step, ";
