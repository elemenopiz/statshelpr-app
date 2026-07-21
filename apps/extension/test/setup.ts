/**
 * Global test setup: fixtures attach themselves to `document.body` (required
 * — canvas-dom.ts's `getChoiceText()` resolves `label[for=id]` via a
 * document-wide querySelector, not scoped to the fixture subtree, so a
 * detached fixture would silently fail that lookup). Reset between tests so
 * one test's leftover nodes can never be picked up by another's queries.
 */
import { afterEach } from "vitest";

afterEach(() => {
  document.body.replaceChildren();
});
