/**
 * In-memory R-code export buffer — content-script-instance-scoped (resets on
 * page reload, same lifetime as the rest of content.ts's state). Buffers the
 * server-generated R for each CALC question solved this page load so the
 * student can copy it all as one bundle from the popup ("copy R code for
 * this quiz") whenever they like. The popup fetches the current bundle via
 * a `sh-get-r-export` message to this content script (see content.ts's
 * onMessage listener) since the buffer only exists here, not in the popup.
 *
 * Privacy contract, same spirit as telemetry.ts's (see that file's module
 * doc): NOTHING but the raw R code string is ever stored here — no question
 * text, no answer, no choice text, no question/quiz identifier, no
 * timestamp. Each buffered snippet is later wrapped in its own
 * `local({ ... })` block (see buildExportBundle) purely so variable names
 * colliding across questions (e.g. two questions both defining `x`) don't
 * clobber each other once concatenated — that scope isolation is the ONLY
 * thing ever added to a snippet; no comments, labels, or identifiers are
 * added, on purpose. Code paired with question/quiz identity risks becoming
 * a reusable answer key if a question bank repeats across semesters/
 * sections — code alone doesn't. Do not add debugging comments here either;
 * strip anything you're tempted to add before shipping.
 *
 * This is a separate, purely in-memory construct from telemetry.ts — it is
 * not wired into the telemetry beacon and never should be.
 */

const buffer: string[] = [];

/** Push one calc question's R code onto the buffer. Call only when
 * solveResult.mode === "calc" — nothing else from the solve result belongs
 * here. */
export function recordCalcCode(rCode: string): void {
  buffer.push(rCode);
}

/** Whether there's anything to export yet — gates the popup's copy
 * affordance so an empty bundle is never offered. */
export function hasExportableCode(): boolean {
  return buffer.length > 0;
}

/** Wrap each buffered snippet in its own `local({ ... })` block and join
 * with a blank line — no header, no footer, no comment dividers, just the
 * wrapped blocks back to back. Returns "" if the buffer is empty. */
export function buildExportBundle(): string {
  return buffer.map((code) => `local({\n${code}\n})`).join("\n\n");
}
