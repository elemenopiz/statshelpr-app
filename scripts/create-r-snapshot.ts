/**
 * One-time script to build a Vercel Sandbox snapshot with R + tidyverse +
 * mosaic + moderndive + infer + broom + ggplot2 pre-installed. The resulting
 * snapshot ID goes into R_SANDBOX_SNAPSHOT_ID so production /api/solve calls
 * boot in <1s instead of installing R from scratch every request.
 *
 * Run from web/ directory:
 *   pnpm tsx scripts/create-r-snapshot.ts
 *
 * Required env (or `vercel link` first so OIDC works):
 *   VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID
 */

import { Sandbox } from "@vercel/sandbox";

const SYSTEM_DEPS = [
  "R",
  "openssl-devel",
  "libxml2-devel",
  "libcurl-devel",
  "fontconfig-devel",
  "freetype-devel",
  "harfbuzz-devel",
  "fribidi-devel",
  "libpng-devel",
  "libtiff-devel",
  "libjpeg-turbo-devel",
];

const R_PACKAGES = [
  "tidyverse",
  "mosaic",
  "moderndive",
  "infer",
  "broom",
  "ggplot2",
  "openssl",
  "base64enc",
];

function getCredentials() {
  if (
    process.env["VERCEL_TOKEN"] &&
    process.env["VERCEL_TEAM_ID"] &&
    process.env["VERCEL_PROJECT_ID"]
  ) {
    return {
      token: process.env["VERCEL_TOKEN"],
      teamId: process.env["VERCEL_TEAM_ID"],
      projectId: process.env["VERCEL_PROJECT_ID"],
    };
  }
  return {};
}

async function main() {
  console.log("→ booting fresh sandbox…");
  const sandbox = await Sandbox.create({
    ...getCredentials(),
    runtime: "node24",
    timeout: 1_800_000, // 30 min — R package installs are slow
  });

  console.log("→ installing system dependencies…");
  const sysResult = await sandbox.runCommand("sh", [
    "-c",
    `sudo dnf clean all 2>&1 && sudo dnf install -y --skip-broken ${SYSTEM_DEPS.join(" ")} 2>&1 && sudo ldconfig 2>&1`,
  ]);
  if ((sysResult.exitCode ?? 0) !== 0) {
    console.error(await sysResult.stderr());
    throw new Error(`dnf install failed (exit ${sysResult.exitCode})`);
  }

  console.log("→ verifying R is available…");
  const rVer = await sandbox.runCommand("R", ["--version"]);
  console.log(await rVer.stdout());

  console.log("→ ensuring system R library is writable for sudo install…");
  await sandbox.runCommand("sh", [
    "-c",
    "sudo mkdir -p /usr/local/lib/R/site-library && sudo chmod -R a+w /usr/local/lib/R /usr/lib64/R/library 2>/dev/null || true",
  ]);

  console.log(`→ installing ${R_PACKAGES.length} R packages (this takes 10–20 min)…`);
  const installScript = [
    `options(repos = c(CRAN = 'https://cloud.r-project.org'))`,
    `.libPaths(c('/usr/local/lib/R/site-library', .libPaths()))`,
    `install.packages(c(${R_PACKAGES.map((p) => `'${p}'`).join(", ")}), lib = '/usr/local/lib/R/site-library', Ncpus = 4)`,
    `for (p in c(${R_PACKAGES.map((p) => `'${p}'`).join(", ")})) {`,
    `  if (!requireNamespace(p, quietly = TRUE)) stop('FAILED: ', p)`,
    `}`,
    `cat('all packages OK\\n')`,
  ].join("; ");

  const installResult = await sandbox.runCommand("sudo", [
    "Rscript",
    "-e",
    installScript,
  ]);
  console.log(await installResult.stdout());
  if ((installResult.exitCode ?? 0) !== 0) {
    console.error(await installResult.stderr());
    throw new Error(`R package install failed (exit ${installResult.exitCode})`);
  }

  console.log("→ snapshotting sandbox…");
  const snapshot = await sandbox.snapshot();
  console.log("");
  console.log("=================================================");
  console.log(`Snapshot created: ${snapshot.snapshotId}`);
  console.log("");
  console.log("Add this to your Vercel project env:");
  console.log(`  R_SANDBOX_SNAPSHOT_ID=${snapshot.snapshotId}`);
  console.log("=================================================");

  await sandbox.stop();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
