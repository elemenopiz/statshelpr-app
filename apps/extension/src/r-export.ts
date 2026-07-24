/**
 * In-memory R-code export buffer — content-script-instance-scoped (resets on
 * page reload, same lifetime as the rest of content.ts's state). Buffers the
 * server-generated R for each CALC question solved this page load so the
 * student can download them as one bundle whenever they like.
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

/** Whether there's anything to export yet — gates the export affordance's
 * visible/enabled state so an empty bundle is never offered for download. */
export function hasExportableCode(): boolean {
  return buffer.length > 0;
}

/** Wrap each buffered snippet in its own `local({ ... })` block and join
 * with a blank line — no header, no footer, no comment dividers, just the
 * wrapped blocks back to back. Returns "" if the buffer is empty. */
export function buildExportBundle(): string {
  return buffer.map((code) => `local({\n${code}\n})`).join("\n\n");
}

/** Trigger a save-as-file download of the current bundle via Blob + a
 * temporary <a download>, deliberately NOT chrome.downloads.download (that
 * needs a "downloads" manifest permission this feature doesn't want to add).
 * No-op if the buffer is empty. */
export function downloadExportBundle(): void {
  const bundle = buildExportBundle();
  if (!bundle) return;
  const blob = new Blob([bundle], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "statshelpr-r-code.R";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
