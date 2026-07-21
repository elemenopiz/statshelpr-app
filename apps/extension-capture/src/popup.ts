/**
 * Popup dashboard — manage the captured set: review, re-label (concept/calc),
 * delete, export, and set capture defaults. The on-page panel handles quick
 * capture; this is the management surface.
 */

import {
  getAllCaptures,
  removeCapture,
  clearCaptures,
  upsertCapture,
  getSettings,
  saveSettings,
  toFixtureBundle,
  toJsonl,
  downloadText,
} from "./store";
import type { Capture, CaptureMode } from "./types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function render() {
  const captures = await getAllCaptures();
  const settings = await getSettings();

  $("count").textContent = String(captures.length);
  const keyed = captures.filter((c) => c.source === "answer-key").length;
  const calc = captures.filter((c) => c.mode === "calc").length;
  $("breakdown").textContent = captures.length
    ? `${keyed} from answer key · ${captures.length - keyed} manual · ${calc} calc · ${captures.length - calc} concept`
    : "nothing captured yet";

  ($("mode") as HTMLSelectElement).value = settings.defaultMode;
  ($("images") as HTMLInputElement).checked = settings.includeImages;

  ($("export-json") as HTMLButtonElement).disabled = captures.length === 0;
  ($("export-jsonl") as HTMLButtonElement).disabled = captures.length === 0;
  ($("clear") as HTMLButtonElement).disabled = captures.length === 0;

  renderList(captures);
}

function renderList(captures: Capture[]) {
  const list = $("list");
  const empty = $("empty");
  const label = $("list-label");
  list.textContent = "";
  empty.style.display = captures.length === 0 ? "block" : "none";
  label.textContent = captures.length ? `captured questions (${captures.length})` : "captured questions";

  for (const c of captures) {
    const qText = el("div", { className: "q-text", text: c.questionText });

    const sourceTag = el("span", {
      className: `tag ${c.source === "answer-key" ? "key" : "manual"}`,
      text: c.source === "answer-key" ? "key" : "manual",
    });
    const ansTag = el("span", { className: "tag ans", text: c.correctChoices.join("") || "—" });

    const modeSel = el("select") as HTMLSelectElement;
    modeSel.appendChild(el("option", { value: "concept", text: "concept" }));
    modeSel.appendChild(el("option", { value: "calc", text: "calc" }));
    modeSel.value = c.mode;
    modeSel.addEventListener("change", async () => {
      await upsertCapture({ ...c, mode: modeSel.value as CaptureMode });
      await render();
    });

    const meta = el("div", { className: "q-meta" }, [sourceTag, ansTag, modeSel]);
    const q = el("div", { className: "q" }, [qText, meta]);

    const del = el("button", { className: "del", type: "button", title: "Delete", text: "✕" });
    del.addEventListener("click", async () => {
      await removeCapture(c.id);
      await render();
    });

    list.appendChild(el("div", { className: "item" }, [q, del]));
  }
}

async function exportBundle(kind: "json" | "jsonl") {
  const captures = await getAllCaptures();
  if (captures.length === 0) return;
  const s = stamp();
  if (kind === "json") downloadText(`statshelpr-fixtures-${s}.json`, toFixtureBundle(captures));
  else downloadText(`statshelpr-fixtures-${s}.jsonl`, toJsonl(captures));
  toast(`Exported ${captures.length} fixtures`);
}

function wire() {
  $("export-json").addEventListener("click", () => void exportBundle("json"));
  $("export-jsonl").addEventListener("click", () => void exportBundle("jsonl"));
  ($("mode") as HTMLSelectElement).addEventListener("change", async (e) => {
    await saveSettings({ defaultMode: (e.target as HTMLSelectElement).value as CaptureMode });
  });
  ($("images") as HTMLInputElement).addEventListener("change", async (e) => {
    await saveSettings({ includeImages: (e.target as HTMLInputElement).checked });
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
