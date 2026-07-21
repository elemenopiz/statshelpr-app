/**
 * Popup dashboard — review the captured set, fix the occasional inferred mode,
 * dedupe variants, export, and clear. Capture itself is automatic (the on-page
 * script), so there are no capture settings here.
 */

import {
  getAllCaptures,
  removeCapture,
  clearCaptures,
  upsertCapture,
  dedupeTemplates,
  toFixtureBundle,
  toPoolBundle,
  downloadText,
} from "./store";
import { loadDatasets } from "./datasets";
import type { Capture, CaptureMode } from "./types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function render() {
  const captures = await getAllCaptures();

  $("count").textContent = String(captures.length);
  const verified = captures.filter((c) => c.verified).length;
  const unsolved = captures.length - verified;
  const templates = new Set(captures.map((c) => c.templateId)).size;
  const variants = captures.length - templates;
  $("breakdown").textContent = captures.length
    ? `${verified} verified · ${unsolved} unsolved · ${templates} unique`
    : "nothing captured yet";

  ($("export-fixtures") as HTMLButtonElement).disabled = verified === 0;
  ($("export-pool") as HTMLButtonElement).disabled = unsolved === 0;
  ($("clear") as HTMLButtonElement).disabled = captures.length === 0;
  ($("dedupe") as HTMLButtonElement).disabled = variants === 0;
  ($("dedupe") as HTMLButtonElement).textContent = variants
    ? `Dedupe ${variants} variant${variants === 1 ? "" : "s"}`
    : "No variants";

  renderList(captures);
}

function renderList(captures: Capture[]) {
  const list = $("list");
  const empty = $("empty");
  const label = $("list-label");
  list.textContent = "";
  empty.style.display = captures.length === 0 ? "block" : "none";
  label.textContent = captures.length ? `captured questions (${captures.length})` : "captured questions";

  // templateIds that appear more than once → those captures are variants.
  const counts = new Map<string, number>();
  for (const c of captures) counts.set(c.templateId, (counts.get(c.templateId) ?? 0) + 1);

  for (const c of captures) {
    const qText = el("div", { className: "q-text", text: c.questionText });

    const meta = el("div", { className: "q-meta" });
    meta.appendChild(
      el("span", {
        className: `tag ${c.verified ? "key" : "manual"}`,
        title: `answer source: ${c.answerSource} · outcome: ${c.outcome}`,
        text: c.verified ? "verified" : "unsolved",
      }),
    );
    // verified → the correct answer; unsolved → the student's (wrong/unknown) pick.
    // Fill-in questions have no letter, so fall back to the entered value.
    const ansText =
      (c.verified ? c.correctChoices : c.selectedChoices).join("") || c.answerText || "—";
    meta.appendChild(
      el("span", {
        className: "tag ans",
        title: c.verified ? "correct answer" : `your pick (${c.outcome})`,
        text: ansText,
      }),
    );
    for (const ds of c.datasetRefs) meta.appendChild(el("span", { className: "tag data", text: ds }));
    if ((counts.get(c.templateId) ?? 0) > 1) {
      meta.appendChild(el("span", { className: "tag var", title: "Shares a template with another capture", text: "variant" }));
    }

    const modeSel = el("select") as HTMLSelectElement;
    modeSel.appendChild(el("option", { value: "concept", text: "concept" }));
    modeSel.appendChild(el("option", { value: "calc", text: "calc" }));
    modeSel.value = c.mode;
    modeSel.addEventListener("change", async () => {
      await upsertCapture({ ...c, mode: modeSel.value as CaptureMode });
      await render();
    });
    meta.appendChild(modeSel);

    const q = el("div", { className: "q" }, [qText, meta]);

    const del = el("button", { className: "del", type: "button", title: "Delete", text: "✕" });
    del.addEventListener("click", async () => {
      await removeCapture(c.id);
      await render();
    });

    list.appendChild(el("div", { className: "item" }, [q, del]));
  }
}

async function exportData(kind: "fixtures" | "pool") {
  const captures = await getAllCaptures();
  if (captures.length === 0) return;
  const datasets = await loadDatasets();
  const s = stamp();
  if (kind === "fixtures") {
    const verified = captures.filter((c) => c.verified).length;
    downloadText(`statshelpr-fixtures-${s}.json`, toFixtureBundle(captures, datasets, true));
    toast(`Exported ${verified} verified fixture${verified === 1 ? "" : "s"}`);
  } else {
    const unsolved = captures.filter((c) => !c.verified).length;
    downloadText(`statshelpr-unsolved-${s}.json`, toPoolBundle(captures, datasets));
    toast(`Exported ${unsolved} unsolved question${unsolved === 1 ? "" : "s"}`);
  }
}

function wire() {
  $("export-fixtures").addEventListener("click", () => void exportData("fixtures"));
  $("export-pool").addEventListener("click", () => void exportData("pool"));
  $("dedupe").addEventListener("click", async () => {
    const removed = await dedupeTemplates();
    await render();
    toast(removed ? `Removed ${removed} variant${removed === 1 ? "" : "s"}` : "No variants to remove");
  });
  $("clear").addEventListener("click", async () => {
    const captures = await getAllCaptures();
    if (captures.length === 0) return;
    if (!confirm(`Delete all ${captures.length} captured questions? Export first to keep them.`)) return;
    await clearCaptures();
    await render();
    toast("Cleared");
  });

  // Live-refresh if the on-page panel captures while the popup is open.
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === "local") void render();
  });
}

let toastTimer: number | undefined;
function toast(msg: string) {
  const t = $("toast");
  t.textContent = msg;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.textContent = ""), 2500);
}

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

interface ElProps {
  className?: string;
  text?: string;
  title?: string;
  type?: string;
  value?: string;
}
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps = {},
  children: Node[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.className) node.className = props.className;
  if (props.title) node.title = props.title;
  if (props.text !== undefined) node.textContent = props.text;
  if (props.type && "type" in node) (node as HTMLInputElement).type = props.type;
  if (props.value !== undefined && "value" in node) (node as HTMLOptionElement).value = props.value;
  for (const c of children) node.appendChild(c);
  return node;
}

wire();
void render();
