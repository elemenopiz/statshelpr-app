/**
 * One-time script to build a Vercel Sandbox snapshot with R + tidyverse +
 * mosaic + moderndive + infer + broom + ggplot2 pre-installed. The resulting
 * snapshot ID goes into R_SANDBOX_SNAPSHOT_ID so production /api/solve calls
 * boot in <1s instead of installing R from scratch every request.
 *
 * Run from repo root:
 *   pnpm tsx scripts/create-r-snapshot.ts
 *
 * Required env (or `vercel link` first so OIDC works):
 *   VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID
 *
 * Strategy: tidyverse + friends takes ~15 min to install, longer than any
 * single HTTP runCommand can stay open. We start the install as a detached
 * job inside the VM, then poll a sentinel file via short runCommand calls.
 */

import { Sandbox } from "@vercel/sandbox";

const SYSTEM_DEPS = [
  "R",
  // Build tools (some R packages need C/C++ compiler headers)
  "gcc",
  "gcc-c++",
  "make",
  "cmake",
  "pkgconf",
  "pkgconf-pkg-config",
  // Network / crypto
  "openssl-devel",
  "libxml2-devel",
  "libcurl-devel",
  "libssh2-devel",
  // Compression
  "zlib-devel",
  "bzip2-devel",
  "xz-devel",
  // Fonts / text shaping (ragg, systemfonts, textshaping)
  "fontconfig-devel",
  "freetype-devel",
  "harfbuzz-devel",
  "fribidi-devel",
  // Image formats (ragg, magick)
  "libpng-devel",
  "libtiff-devel",
  "libjpeg-turbo-devel",
  "libwebp-devel",
  // Cairo (svglite, ragg)
  "cairo-devel",
  // ICU (stringi)
  "libicu-devel",
  // libuv (fs package)
  "libuv-devel",
  // Sodium (auth-related crypto)
  "libsodium-devel",
  // GMP / MPFR (some stats packages)
  "gmp-devel",
  "mpfr-devel",
  // Git (git2r if any package needs it)
  "libgit2-devel",
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
    timeout: 2_700_000, // 45 min — install + verification + snapshot
  });

  console.log(`→ installing ${SYSTEM_DEPS.length} system dependencies…`);
  // Don't use --skip-broken: silently skipping freetype-devel etc. is what
  // burned us on the prior attempt. Fail loud if a required dep can't install.
  const sysResult = await sandbox.runCommand("sh", [
    "-c",
    `sudo dnf clean all 2>&1 && sudo dnf install -y ${SYSTEM_DEPS.join(" ")} 2>&1 && sudo ldconfig 2>&1`,
  ]);
  if ((sysResult.exitCode ?? 0) !== 0) {
    const tail = (await sysResult.stdout()).split("\n").slice(-30).join("\n");
    console.error("--- dnf tail ---\n" + tail);
    console.error("--- stderr ---\n" + (await sysResult.stderr()));
    throw new Error(`dnf install failed (exit ${sysResult.exitCode})`);
  }
  // Sanity check: confirm freetype headers are actually on disk
  const headerCheck = await sandbox.runCommand("sh", [
    "-c",
    "ls /usr/include/freetype2/ft2build.h && pkg-config --exists freetype2 && echo OK_FREETYPE; pkg-config --exists libwebp && echo OK_WEBP",
  ]);
  console.log((await headerCheck.stdout()).trim());

  console.log("→ verifying R is available…");
  const rVer = await sandbox.runCommand("R", ["--version"]);
  console.log((await rVer.stdout()).split("\n")[0]);

  console.log("→ preparing writable site-library + install script…");
  await sandbox.runCommand("sh", [
    "-c",
    "sudo mkdir -p /usr/local/lib/R/site-library && sudo chmod -R a+w /usr/local/lib/R 2>/dev/null || true",
  ]);

  // Install script: writes DONE / FAILED:<pkg> to a sentinel file when complete.
  const installR = [
    `options(repos = c(CRAN = 'https://cloud.r-project.org'))`,
    `.libPaths(c('/usr/local/lib/R/site-library', .libPaths()))`,
    // Fallback: build libuv from source if missing system lib
    `Sys.setenv(USE_BUNDLED_LIBUV = '1')`,
    `pkgs <- c(${R_PACKAGES.map((p) => `'${p}'`).join(", ")})`,
    `tryCatch({`,
    `  install.packages(pkgs, lib = '/usr/local/lib/R/site-library', Ncpus = 4)`,
    `  for (p in pkgs) {`,
    `    if (!requireNamespace(p, quietly = TRUE)) {`,
    `      writeLines(paste0('FAILED:', p), '/tmp/install.done'); quit(save='no', status=1)`,
    `    }`,
    `  }`,
    `  writeLines('DONE', '/tmp/install.done')`,
    `}, error = function(e) {`,
    `  writeLines(paste0('FAILED:', conditionMessage(e)), '/tmp/install.done')`,
    `  quit(save='no', status=1)`,
    `})`,
  ].join("\n");

  const installB64 = Buffer.from(installR, "utf-8").toString("base64");
  await sandbox.runCommand("sh", [
    "-c",
    `echo ${JSON.stringify(installB64)} | base64 -d > /tmp/install.R`,
  ]);

  console.log("→ starting R install (will run for 10–20 min)…");
  // Strategy: run install synchronously. The HTTP connection will probably
  // time out before it finishes, but the process keeps running in the VM.
  // Once the runCommand call resolves OR throws, we poll the sentinel file.
  await sandbox.runCommand("sh", [
    "-c",
    "rm -f /tmp/install.done /tmp/install.log",
  ]);

  // Fire and forget: kick off install, don't wait for the HTTP response
  const installPromise = sandbox
    .runCommand("sh", [
      "-c",
      "sudo Rscript /tmp/install.R > /tmp/install.log 2>&1; echo $? > /tmp/install.exit",
    ])
    .catch((e) => {
      console.log(`  (install runCommand connection dropped: ${(e as Error).message.slice(0, 100)})`);
      return null;
    });

  // Don't await installPromise — it may never resolve cleanly. Just poll.
  void installPromise;

  console.log(`→ polling for completion (typically 10–20 min)…`);
  const startTime = Date.now();
  let done = false;
  let lastReportSec = 0;
  let result = "";

  while (!done) {
    await sleep(30_000);

    try {
      const probe = await sandbox.runCommand("sh", [
        "-c",
        `cat /tmp/install.done 2>/dev/null || echo RUNNING`,
      ]);
      result = (await probe.stdout()).trim();
    } catch (e) {
      // Transient socket error during a poll — keep going. The install runs
      // independently inside the VM regardless.
      console.log(`  (poll error, will retry: ${(e as Error).message.slice(0, 80)})`);
      continue;
    }

    const elapsedSec = Math.round((Date.now() - startTime) / 1000);
    if (elapsedSec - lastReportSec >= 60) {
      lastReportSec = elapsedSec;
      console.log(`  …${Math.floor(elapsedSec / 60)}m${elapsedSec % 60}s elapsed, status: ${result}`);
    }

    if (result === "DONE") {
      done = true;
    } else if (result.startsWith("FAILED:")) {
      // Pull the install log so we can see what blew up
      try {
        const logProbe = await sandbox.runCommand("sh", [
          "-c",
          "tail -60 /tmp/install.log",
        ]);
        console.error("--- install log tail ---");
        console.error(await logProbe.stdout());
      } catch {
        /* ignore */
      }
      throw new Error(`R install ${result}`);
    }
    // else still RUNNING — keep polling
  }

  console.log("→ all packages installed; snapshotting sandbox…");
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
