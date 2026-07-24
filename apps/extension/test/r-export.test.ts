/**
 * Coverage for r-export.ts's buffer + bundling — the "download my R code"
 * export. Each test re-imports the module after vi.resetModules() to get a
 * fresh in-memory buffer, since the buffer is module-level state (mirroring
 * the real one-instance-per-page-load lifetime).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

async function freshModule() {
  vi.resetModules();
  return import("../src/r-export");
}

describe("buildExportBundle", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("empty buffer -> empty string, and reports nothing exportable", async () => {
    const { buildExportBundle, hasExportableCode } = await freshModule();
    expect(hasExportableCode()).toBe(false);
    expect(buildExportBundle()).toBe("");
  });

  it("single snippet -> wrapped in one local({ ... }) block, no stray text", async () => {
    const { recordCalcCode, buildExportBundle, hasExportableCode } = await freshModule();
    recordCalcCode("x <- 1\nprint(x)");
    expect(hasExportableCode()).toBe(true);
    const bundle = buildExportBundle();
    expect(bundle).toBe("local({\nx <- 1\nprint(x)\n})");
    // No headers, footers, comments, or identifiers of any kind.
    expect(bundle).not.toMatch(/#/);
    expect(bundle.match(/local\(\{/g)).toHaveLength(1);
  });

  it("multiple snippets -> each isolated in its own local(), blank-line separated", async () => {
    const { recordCalcCode, buildExportBundle } = await freshModule();
    recordCalcCode("x <- 1");
    recordCalcCode("x <- 2");
    recordCalcCode("y <- mean(c(1, 2, 3))");
    const bundle = buildExportBundle();
    expect(bundle).toBe(
      "local({\nx <- 1\n})\n\nlocal({\nx <- 2\n})\n\nlocal({\ny <- mean(c(1, 2, 3))\n})",
    );
    expect(bundle.match(/local\(\{/g)).toHaveLength(3);
    // Each block is separately scoped, so two blocks both assigning `x`
    // don't collide when the whole bundle is run as one R script — verified
    // structurally here (each `x <-` sits inside its own local({...}) call);
    // running it through an actual R interpreter isn't available in this
    // test environment.
    const blocks = bundle.split("\n\n");
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toContain("x <- 1");
    expect(blocks[1]).toContain("x <- 2");
  });

  it("never includes question text, identifiers, or timestamps — only what was recorded", async () => {
    const { recordCalcCode, buildExportBundle } = await freshModule();
    recordCalcCode("t.test(c(1,2,3), mu = 0)");
    const bundle = buildExportBundle();
    expect(bundle).toBe("local({\nt.test(c(1,2,3), mu = 0)\n})");
  });
});
