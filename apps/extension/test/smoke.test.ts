/**
 * DOM-environment smoke check — run BEFORE trusting any other test in this
 * suite. canvas-dom.ts leans on three low-level DOM behaviors that jsdom and
 * happy-dom have historically diverged on:
 *   1. input.click() actually toggling `checked` (selectChoice's primary path).
 *   2. label[for=id] + document.querySelector(label[for="..."]) resolving
 *      (getChoiceText's primary path).
 *   3. The native property setter on the HTMLInputElement/HTMLSelectElement
 *      prototype existing, so React-aware writes
 *      (Object.getOwnPropertyDescriptor(proto, "value").set) work.
 * If any of these fail under happy-dom, canvas-dom.ts's core write-back
 * mechanism cannot be tested faithfully in this environment and the suite
 * must switch to jsdom instead (see vitest.config.ts).
 */
import { describe, expect, it } from "vitest";
import { h } from "./fixtures/dom";

describe("DOM environment smoke check (happy-dom)", () => {
  it("input.click() toggles `checked` on a radio input", () => {
    const input = h("input", { type: "radio", name: "g", id: "r1" }) as HTMLInputElement;
    document.body.appendChild(input);
    expect(input.checked).toBe(false);
    input.click();
    expect(input.checked).toBe(true);
  });

  it("input.click() toggles `checked` on a checkbox input", () => {
    const input = h("input", { type: "checkbox", id: "c1" }) as HTMLInputElement;
    document.body.appendChild(input);
    expect(input.checked).toBe(false);
    input.click();
    expect(input.checked).toBe(true);
  });

  it("label[for] resolves via document.querySelector", () => {
    const input = h("input", { type: "radio", id: "answer_1" });
    const label = h("label", { for: "answer_1" }, [h("span", { class: "answer_text" }, ["Choice text"])]);
    document.body.appendChild(input);
    document.body.appendChild(label);
    const found = document.querySelector('label[for="answer_1"]');
    expect(found).not.toBeNull();
    expect(found?.textContent).toBe("Choice text");
  });

  it("native `value` setter exists on HTMLInputElement prototype", () => {
    const input = h("input", { type: "text", id: "t1" }) as HTMLInputElement;
    document.body.appendChild(input);
    const proto = Object.getPrototypeOf(input);
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    expect(typeof setter).toBe("function");
    setter?.call(input, "hello");
    expect(input.value).toBe("hello");
  });

  it("native `checked` setter exists on HTMLInputElement prototype", () => {
    const input = h("input", { type: "checkbox", id: "c2" }) as HTMLInputElement;
    document.body.appendChild(input);
    const proto = Object.getPrototypeOf(input);
    const setter = Object.getOwnPropertyDescriptor(proto, "checked")?.set;
    expect(typeof setter).toBe("function");
    setter?.call(input, true);
    expect(input.checked).toBe(true);
  });

  it("native `value` setter exists on HTMLSelectElement prototype", () => {
    const sel = h("select", { id: "s1" }, [
      h("option", { value: "a" }, ["A"]),
      h("option", { value: "b" }, ["B"]),
    ]) as HTMLSelectElement;
    document.body.appendChild(sel);
    const proto = Object.getPrototypeOf(sel);
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    expect(typeof setter).toBe("function");
    setter?.call(sel, "b");
    expect(sel.value).toBe("b");
  });

  it("dispatched input/change events bubble and are observable", () => {
    const input = h("input", { type: "text", id: "t2" }) as HTMLInputElement;
    document.body.appendChild(input);
    let inputFired = false;
    let changeFired = false;
    input.addEventListener("input", () => (inputFired = true));
    input.addEventListener("change", () => (changeFired = true));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(inputFired).toBe(true);
    expect(changeFired).toBe(true);
  });

  it("disabled inputs report `.disabled` correctly", () => {
    const input = h("input", { type: "radio", id: "r2", disabled: true }) as HTMLInputElement;
    document.body.appendChild(input);
    expect(input.disabled).toBe(true);
  });

  it("classList.add applies a class (statshelpr-suggested marker path)", () => {
    const row = h("div", { id: "row" });
    document.body.appendChild(row);
    row.classList.add("statshelpr-suggested");
    expect(row.classList.contains("statshelpr-suggested")).toBe(true);
  });
});
