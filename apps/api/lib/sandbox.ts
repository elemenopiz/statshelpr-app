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
    const scriptB64 = Buffer.from(rCode, "utf-8").toString("base64");
    await sandbox.runCommand("sh", [
      "-c",
      `echo ${JSON.stringify(scriptB64)} | base64 -d > ${scriptPath}`,
    ]);

    const result = await sandbox.runCommand("sh", [
      "-c",
      `cd /tmp/work && Rscript --vanilla script.R`,
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
