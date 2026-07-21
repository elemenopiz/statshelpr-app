import { Sandbox } from "@vercel/sandbox";

export interface RFile {
  filename: string;
  content: string;
}

export interface RunRResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

const SYSTEM_DEPS = [
  "R",
  "R-devel",
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
    process.env.VERCEL_TOKEN &&
    process.env.VERCEL_TEAM_ID &&
    process.env.VERCEL_PROJECT_ID
  ) {
    return {
      token: process.env.VERCEL_TOKEN,
      teamId: process.env.VERCEL_TEAM_ID,
      projectId: process.env.VERCEL_PROJECT_ID,
    };
  }
  return {};
}

/**
 * Run an R script with optional data files. Uses a pre-built snapshot if
 * R_SANDBOX_SNAPSHOT_ID is set; otherwise installs R + packages on the fly
 * (slow — only for the snapshot-creation script or a one-off dev test).
 */
export async function runR(rCode: string, files: RFile[] = []): Promise<RunRResult> {
  // Local eval backend (`pnpm eval`): run R via the WebR sidecar — the same
  // engine production uses client-side — instead of the Vercel sandbox, which
  // needs cloud creds the local rig lacks and which production never uses.
  // Unset R_WEBR_URL in production, where the Vercel path below runs.
  if (process.env.R_WEBR_URL) return runRViaWebr(process.env.R_WEBR_URL, rCode, files);

  const snapshotId = process.env.R_SANDBOX_SNAPSHOT_ID;
  const credentials = getCredentials();

  const sandbox = snapshotId
    ? await Sandbox.create({
        ...credentials,
        source: { type: "snapshot", snapshotId },
        timeout: 120_000,
      })
    : await Sandbox.create({ ...credentials, runtime: "node24", timeout: 300_000 });

  const start = Date.now();

  try {
    if (!snapshotId) await installROnSandbox(sandbox);

    // Write data files into /tmp/work so R scripts can read them by name
    await sandbox.runCommand("mkdir", ["-p", "/tmp/work"]);
    for (const f of files) {
      const safeName = f.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
      const path = `/tmp/work/${safeName}`;
      const b64 = Buffer.from(f.content, "utf-8").toString("base64");
      await sandbox.runCommand("sh", [
        "-c",
        `echo ${JSON.stringify(b64)} | base64 -d > ${path}`,
      ]);
    }

    const scriptPath = "/tmp/work/script.R";
    const wrappedRCode = [
      "options(warn = 1)",
      "options(width = 160)",
      "set.seed(123)",
      dataPreamble(files, (f) => f.filename.replace(/[^a-zA-Z0-9._-]/g, "_")),
      rCode,
    ]
      .filter(Boolean)
      .join("\n");
    const scriptB64 = Buffer.from(wrappedRCode, "utf-8").toString("base64");
    await sandbox.runCommand("sh", [
      "-c",
      `echo ${JSON.stringify(scriptB64)} | base64 -d > ${scriptPath}`,
    ]);

    // Snapshot installs packages to /usr/local/lib/R/site-library (a writable
    // path). With --vanilla R skips Rprofile.site, so set R_LIBS_SITE explicitly
    // so installed packages are found at runtime.
    const result = await sandbox.runCommand("sh", [
      "-c",
      `cd /tmp/work && R_LIBS_SITE=/usr/local/lib/R/site-library Rscript --vanilla script.R`,
    ]);

    return {
      stdout: await result.stdout(),
      stderr: await result.stderr(),
      exitCode: result.exitCode ?? 0,
      durationMs: Date.now() - start,
    };
  } finally {
    await sandbox.stop();
  }
}

/**
 * Load each provided data file into a variable named after its file stem
 * (ads.csv -> `ads`), so R code can reference the dataframe by the same name
 * the model is shown in the "R ENVIRONMENT CONTEXT" (buildDataContext) without
 * an explicit read.csv. The context advertises these frames as already present,
 * so the model routinely writes `mean(ads$views)` assuming they're loaded;
 * this makes that assumption true and deterministic. Uses assign() so any stem
 * is valid, and tryCatch so a missing/bad file yields NULL (a clear downstream
 * error the repair loop can act on) rather than aborting the whole script.
 * `readName` maps a file to its on-disk name (sanitized for the Vercel sandbox,
 * verbatim for the WebR sidecar).
 */
function dataPreamble(files: RFile[], readName: (f: RFile) => string): string {
  if (files.length === 0) return "";
  const lines = files.map((f) => {
    const stem = f.filename.replace(/\.(csv|tsv|txt)$/i, "");
    return `assign(${jsq(stem)}, tryCatch(read.csv(${jsq(readName(f))}, stringsAsFactors = FALSE), error = function(e) NULL))`;
  });
  return ["# auto-loaded datasets (available by name, per the R environment context)", ...lines].join("\n");
}

function jsq(s: string): string {
  return JSON.stringify(s);
}

/**
 * Local eval R backend: POST the script to the WebR sidecar
 * (scripts/webr-eval-server.cjs). Wraps the code identically to the Vercel
 * path so output/formatting/seed match.
 */
async function runRViaWebr(baseUrl: string, rCode: string, files: RFile[]): Promise<RunRResult> {
  const wrappedRCode = [
    "options(warn = 1)",
    "options(width = 160)",
    "set.seed(123)",
    dataPreamble(files, (f) => f.filename), // sidecar writes each file verbatim at FS root
    rCode,
  ]
    .filter(Boolean)
    .join("\n");
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/runR`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: wrappedRCode, files }),
  });
  if (!res.ok) {
    throw new Error(`WebR sidecar ${res.status}: ${await res.text()}`);
  }
  const j = (await res.json()) as Partial<RunRResult>;
  return {
    stdout: j.stdout ?? "",
    stderr: j.stderr ?? "",
    exitCode: j.exitCode ?? 0,
    durationMs: j.durationMs ?? 0,
  };
}

/** One-time install — used by the snapshot creation script. */
export async function installROnSandbox(sandbox: Sandbox): Promise<void> {
  await sandbox.runCommand("sh", [
    "-c",
    `sudo dnf clean all 2>&1 && sudo dnf install -y --skip-broken ${SYSTEM_DEPS.join(" ")} 2>&1 && sudo ldconfig 2>&1`,
  ]);

  const installScript =
    `options(repos = c(CRAN = 'https://cloud.r-project.org')); ` +
    `install.packages(c(${R_PACKAGES.map((p) => `'${p}'`).join(", ")}), Ncpus = 4)`;

  await sandbox.runCommand("Rscript", ["-e", installScript]);
}
