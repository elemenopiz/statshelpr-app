/**
 * Convert an R `.RData` file into datasets/<name>.csv — one CSV per data frame.
 * The extension only records dataset *names* in its export;
 * scripts/import-captures.ts reads these CSVs to inline the content when it
 * builds the runnable eval fixtures.
 *
 * Usage:
 *   node scripts/convert-rdata.mjs <path/to/file.RData>
 *   pnpm --filter @statshelpr/extension-capture datasets <path/to/file.RData>
 *
 * Requires R on PATH (Rscript). Re-run whenever the course data changes.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, "..");
const outDir = path.resolve(pkgRoot, "datasets");

const input = process.argv[2];
if (!input) {
  console.error("usage: node scripts/convert-rdata.mjs <path/to/file.RData>");
  process.exit(1);
}
const rdata = path.resolve(process.cwd(), input);
if (!existsSync(rdata)) {
  console.error(`not found: ${rdata}`);
  process.exit(1);
}

try {
  execFileSync("Rscript", ["--version"], { stdio: "ignore" });
} catch {
  console.error("Rscript not found on PATH. Install R (https://www.r-project.org/) and retry.");
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });

// R writes each data.frame in the file to <name>.csv. Non-data-frame objects
// are skipped. row.names=FALSE keeps the CSV clean for downstream R re-reads.
const rScript = `
e <- new.env()
load(${JSON.stringify(rdata)}, envir = e)
out <- ${JSON.stringify(outDir)}
n <- 0
for (nm in ls(e)) {
  x <- get(nm, envir = e)
  if (is.data.frame(x)) {
    write.csv(x, file.path(out, paste0(nm, ".csv")), row.names = FALSE)
    n <- n + 1
  }
}
cat(sprintf("wrote %d dataset(s) to %s\\n", n, out))
`;

execFileSync("Rscript", ["-e", rScript], { stdio: "inherit" });
console.log("done — these CSVs are read by scripts/import-captures.ts when building fixtures");
