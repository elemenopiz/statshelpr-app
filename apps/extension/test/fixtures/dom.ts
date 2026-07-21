/**
 * Minimal imperative DOM-builder helper used by every fixture in this test
 * suite. Built with `createElement`/`setAttribute`/`appendChild` rather than
 * parsing an HTML string — which also happens to be a more faithful stand-in
 * for how Canvas's own client-rendered markup lands in the DOM.
 */

type Attrs = Record<string, string | boolean | undefined>;
type Child = Node | string | null | undefined;

/** Build one element: `h("div", { class: "answer" }, [h("span", {}, ["text"])])`. */
export function h(tag: string, attrs: Attrs = {}, children: Child[] = []): HTMLElement {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (value === true) el.setAttribute(key, "");
    else el.setAttribute(key, value);
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    el.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return el;
}

/** `<option value=v>text</option>`. */
export function option(value: string, text: string): HTMLOptionElement {
  const o = document.createElement("option") as HTMLOptionElement;
  o.value = value;
  o.textContent = text;
  return o;
}

/** `<select>` built from a list of [value, text] pairs, first marked as the
 * Canvas "[ Select ]" placeholder unless `noPlaceholder` is set. */
export function selectEl(
  attrs: Attrs,
  options: Array<[value: string, text: string]>,
  opts: { noPlaceholder?: boolean } = {},
): HTMLSelectElement {
  const sel = h("select", attrs) as HTMLSelectElement;
  if (!opts.noPlaceholder) sel.appendChild(option("", "[ Select ]"));
  for (const [value, text] of options) sel.appendChild(option(value, text));
  return sel;
}

let uid = 0;
/** Stable-per-test-run unique id suffix, so fixtures never collide on id. */
export function nextId(prefix: string): string {
  uid += 1;
  return `${prefix}_${uid}`;
}
