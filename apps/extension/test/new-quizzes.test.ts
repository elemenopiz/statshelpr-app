import { describe, it } from "vitest";

// TODO: New Quizzes fixtures. No NQ markup exists to build fixtures from yet
// — the capture pipeline's new `questionDomHtml` field (which will carry
// full interactive NQ markup, unlike Classic's `questionHtml`, which is
// stem-only) is what will supply them. canvas-dom.ts already has some
// New-Quizzes-aware branches (e.g. selectChoice()'s native-setter fallback
// for React-controlled inputs that don't react to .click()) but nothing in
// this suite exercises the New Quizzes DOM shape (data-testid based
// selectors) at all yet.
describe.skip("New Quizzes question types", () => {
  it("TODO: once questionDomHtml captures exist, build NQ fixtures and mirror the Classic per-type suites here", () => {
    // intentionally empty
  });
});
