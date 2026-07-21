import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";

interface Choice {
  label: string;
  text: string;
  type?: "radio" | "checkbox";
}

interface SolveBlank {
  key: string;
  label: string;
  options: string[];
}

interface SolveRequest {
  questionText?: string;
  choices?: Choice[];
  blanks?: SolveBlank[];
  images?: unknown[];
  dataFiles?: Array<{ filename: string; content: string }>;
  stream?: boolean;
  debug?: boolean;
}

interface BlankAnswer {
  key: string;
  answer: string;
}

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cached_tokens?: number;
}

interface SolveResponse {
  mode?: string;
  answer?: string;
  selectedChoices?: string[];
  blanks?: BlankAnswer[];
  rCode?: string;
  rOutput?: string;
  rExitCode?: number;
  /** Concept returns a flat Usage; calc returns { first, interpret }. */
  usage?: Usage | { first?: Usage; interpret?: Usage };
  debug?: unknown;
  error?: string;
}

interface ExpectedBlank {
  key: string;
  label?: string;
  correct: string;
}

interface EvalFixture {
  name: string;
  request: SolveRequest;
  expected: {
    mode: "concept" | "calc";
    selectedChoices: string[];
    answerContains?: string[];
    blanks?: ExpectedBlank[];
  };
}

interface CheckResult {
  label: string;
  pass: boolean;
  expected: string;
  actual: string;
  /** Informational checks (e.g. mode) are shown but don't affect pass/fail. */
  counted?: boolean;
}

const scriptPath = process.argv[1] ? path.resolve(process.cwd(), process.argv[1]) : __filename;
const scriptDir = path.dirname(scriptPath);
const repoRoot = path.resolve(scriptDir, "..");

const args = parseArgs(process.argv.slice(2));
const baseUrl =
  args["base-url"] ?? process.env["EVAL_BASE_URL"] ?? "http://localhost:3030";
const fixturesDir = path.resolve(
  repoRoot,
  args["fixtures"] ?? "evals/solve-fixtures",
);
const timeoutMs = Number(args["timeout-ms"] ?? process.env["EVAL_TIMEOUT_MS"] ?? 90_000);
const licenseKey = args["license-key"] ?? process.env["EVAL_LICENSE_KEY"];

async function main() {
  const fixtures = await loadFixtures(fixturesDir);
  if (fixtures.length === 0) {
    throw new Error(`No eval fixtures found in ${fixturesDir}`);
  }

  if (args["dry-run"] === "true") {
    console.log(`Loaded ${fixtures.length} solve eval fixtures from ${fixturesDir}`);
    for (const fixture of fixtures) {
      console.log(`ok ${fixture.name}`);
    }
    return;
  }

  console.log(`Running ${fixtures.length} solve evals against ${baseUrl}`);
  const results: FixtureResult[] = [];

  for (const fixture of fixtures) {
    const result = await runFixture(fixture);
    results.push(result);
    printFixtureResult(result);
  }

  const failed = results.filter(
    (result) => result.error || result.checks.some((c) => c.counted !== false && !c.pass),
  );
  console.log("");
  console.log(`${results.length - failed.length}/${results.length} fixtures passed`);

  await writeRunArtifacts(results, failed);

  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

interface TokenTotals {
  prompt: number;
  /** Visible answer tokens (Gemini's candidatesTokenCount). */
  completion: number;
  /** prompt + completion + thinking — the only place thinking tokens show up. */
  total: number;
  cached: number;
}

/** Sum a response's usage (concept = flat, calc = { first, interpret }). */
function sumUsage(u: SolveResponse["usage"]): TokenTotals {
  const acc: TokenTotals = { prompt: 0, completion: 0, total: 0, cached: 0 };
  const add = (x?: Usage) => {
    if (!x) return;
    acc.prompt += x.prompt_tokens ?? 0;
    acc.completion += x.completion_tokens ?? 0;
    acc.total += x.total_tokens ?? 0;
    acc.cached += x.cached_tokens ?? 0;
  };
  if (u && ("first" in u || "interpret" in u)) {
    add((u as { first?: Usage }).first);
    add((u as { interpret?: Usage }).interpret);
  } else {
    add(u as Usage);
  }
  return acc;
}

// Per-M token prices (USD), Jul 2026. Output covers completion + thinking, both
// billed at the output rate. Keyed by the model the server runs (GEMINI_MODEL).
const MODEL_PRICES: Record<string, { in: number; out: number; cached: number }> = {
  "gemini-3.5-flash-lite": { in: 0.3, out: 2.5, cached: 0.03 },
  "gemini-3.5-flash": { in: 1.5, out: 9, cached: 0.15 },
  "gemini-3.6-flash": { in: 1.5, out: 7.5, cached: 0.15 },
};
const evalModel = process.env["GEMINI_MODEL"] ?? "gemini-3.5-flash-lite";
const price = MODEL_PRICES[evalModel] ?? MODEL_PRICES["gemini-3.5-flash-lite"]!;

/** Billable cost. Output = total − prompt (= completion + thinking); the cached
 * slice of the prompt bills at the cheaper cache rate. */
function costUsd(t: TokenTotals): number {
  const output = Math.max(0, t.total - t.prompt);
  const uncachedInput = Math.max(0, t.prompt - t.cached);
  return (uncachedInput * price.in + t.cached * price.cached + output * price.out) / 1e6;
}

/**
 * Persist a per-run artifact under evals/_debug/: full request/response/debug
 * for every FAILED fixture (so a miss can be triaged later with zero further
 * API calls), plus a token/cost summary from the usage the API reports. This
 * is the "diagnose misses for free" record.
 */
async function writeRunArtifacts(results: FixtureResult[], failed: FixtureResult[]) {
  const totals: TokenTotals = { prompt: 0, completion: 0, total: 0, cached: 0 };
  for (const r of results) {
    const u = sumUsage(r.response?.usage);
    totals.prompt += u.prompt;
    totals.completion += u.completion;
    totals.total += u.total;
    totals.cached += u.cached;
  }
  const cost = costUsd(totals);
  const withUsage = results.filter((r) => r.response?.usage).length;
  const output = Math.max(0, totals.total - totals.prompt);
  const thinking = Math.max(0, output - totals.completion);

  console.log("");
  if (withUsage > 0) {
    console.log(
      `[${evalModel}] tokens: prompt ${totals.prompt.toLocaleString()} (cached ${totals.cached.toLocaleString()}), ` +
        `output ${output.toLocaleString()} (thinking ${thinking.toLocaleString()}) | ` +
        `est. cost $${cost.toFixed(4)} (~$${(cost / Math.max(1, withUsage)).toFixed(5)}/solve over ${withUsage})`,
    );
  }

  const debugDir = path.resolve(repoRoot, "evals/_debug");
  await mkdir(debugDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(debugDir, `run-${stamp}.json`);
  const artifact = {
    ranAt: new Date().toISOString(),
    model: evalModel,
    baseUrl,
    fixturesDir,
    summary: {
      total: results.length,
      passed: results.length - failed.length,
      failed: failed.length,
      tokens: { ...totals, output, thinking },
      estCostUsd: Number(cost.toFixed(4)),
    },
    failures: failed.map((r) => ({
      name: r.fixture.name,
      error: r.error,
      expected: r.fixture.expected,
      checks: r.checks.filter((c) => c.counted !== false && !c.pass),
      question: r.fixture.request.questionText,
      response: r.response && {
        mode: r.response.mode,
        selectedChoices: r.response.selectedChoices,
        blanks: r.response.blanks,
        answer: r.response.answer,
        rCode: r.response.rCode,
        rOutput: r.response.rOutput,
        rExitCode: r.response.rExitCode,
        usage: r.response.usage,
        debug: r.response.debug,
      },
    })),
  };
  await writeFile(outPath, JSON.stringify(artifact, null, 2) + "\n", "utf8");
  console.log(`debug artifact: ${path.relative(process.cwd(), outPath)} (${failed.length} failures with full detail)`);
}

async function loadFixtures(dir: string): Promise<EvalFixture[]> {
  const names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  const fixtures = await Promise.all(
    names.map(async (name) => {
      const fullPath = path.join(dir, name);
      const raw = await readFile(fullPath, "utf8");
      return validateFixture(JSON.parse(raw), fullPath);
    }),
  );
  return fixtures;
}

interface FixtureResult {
  fixture: EvalFixture;
  checks: CheckResult[];
  error?: string;
  response?: SolveResponse;
}

async function runFixture(fixture: EvalFixture): Promise<FixtureResult> {
  let response: SolveResponse;
  try {
    response = await postSolve(fixture.request);
  } catch (error) {
    return {
      fixture,
      checks: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }

  // mode is informational only: the capture's concept/calc label is a weak
  // heuristic (it mislabels data-computation MCQs as "concept"), while the
  // model routes at runtime. Answer correctness is what decides pass/fail.
  const modeCheck = checkEqual("mode", fixture.expected.mode, response.mode ?? "");
  modeCheck.counted = false;
  const checks: CheckResult[] = [modeCheck];

  if (fixture.request.blanks?.length) {
    // Matching / multiple-dropdowns: score each blank against its known answer.
    checks.push(checkBlanks(fixture.expected.blanks ?? [], response.blanks ?? []));
  } else {
    checks.push(checkChoices(fixture.expected.selectedChoices, response.selectedChoices ?? []));
    checks.push(...checkAnswerContains(fixture.expected.answerContains ?? [], response.answer ?? ""));
  }

  return { fixture, checks, response };
}

async function postSolve(request: SolveRequest): Promise<SolveResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (licenseKey) headers["Authorization"] = `Bearer ${licenseKey}`;

    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/solve`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ...request, stream: false, debug: true }),
      signal: controller.signal,
    });

    const text = await res.text();
    const json = text ? (JSON.parse(text) as SolveResponse) : {};
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${json.error ?? text}`);
    }
    return json;
  } finally {
    clearTimeout(timeout);
  }
}

function checkEqual(label: string, expected: string, actual: string): CheckResult {
  return { label, pass: expected === actual, expected, actual };
}

function checkChoices(expected: string[], actual: string[]): CheckResult {
  const normExpected = normalizeChoices(expected);
  const normActual = normalizeChoices(actual);
  return {
    label: "selectedChoices",
    pass: arraysEqual(normExpected, normActual),
    expected: normExpected.join(", "),
    actual: normActual.join(", "),
  };
}

/** Score a matching / multiple-dropdowns answer: every blank's chosen option
 * (from the API's deriveBlankAnswers) must equal its known-correct option,
 * compared case-insensitively and whitespace-normalized. */
function checkBlanks(expected: ExpectedBlank[], actual: BlankAnswer[]): CheckResult {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const byKey = new Map(actual.map((b) => [b.key, b.answer]));
  const misses: string[] = [];
  for (const e of expected) {
    const got = byKey.get(e.key) ?? "";
    if (norm(got) !== norm(e.correct)) {
      misses.push(`${e.label ?? e.key}: want "${e.correct}", got "${got || "∅"}"`);
    }
  }
  return {
    label: `blanks (${expected.length})`,
    pass: expected.length > 0 && misses.length === 0,
    expected: `${expected.length}/${expected.length} correct`,
    actual: misses.length ? misses.join(" · ") : "all correct",
  };
}

function checkAnswerContains(expected: string[], answer: string): CheckResult[] {
  // Drop thousands separators on both sides so a "2,087" key still matches a
  // model that prints "2087" (a common false-negative on numerical questions).
  const dropThousands = (s: string) => s.replace(/,(?=\d)/g, "");
  const lower = dropThousands(answer.toLowerCase());
  return expected.map((snippet) => ({
    label: `answer contains "${snippet}"`,
    pass: lower.includes(dropThousands(snippet.toLowerCase())),
    expected: snippet,
    actual: answer.length > 140 ? `${answer.slice(0, 137)}...` : answer,
  }));
}

function normalizeChoices(choices: string[]): string[] {
  return choices.map((choice) => choice.trim().toUpperCase()).filter(Boolean).sort();
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function validateFixture(value: unknown, fullPath: string): EvalFixture {
  const fixture = value as EvalFixture;
  if (!fixture || typeof fixture.name !== "string") {
    throw new Error(`Fixture ${fullPath} is missing a string name`);
  }
  if (!fixture.request || typeof fixture.request !== "object") {
    throw new Error(`Fixture ${fullPath} is missing a request object`);
  }
  if (
    !fixture.expected ||
    (fixture.expected.mode !== "concept" && fixture.expected.mode !== "calc") ||
    !Array.isArray(fixture.expected.selectedChoices)
  ) {
    throw new Error(`Fixture ${fullPath} is missing expected mode/selectedChoices`);
  }
  return fixture;
}

function printFixtureResult(result: {
  fixture: EvalFixture;
  checks: CheckResult[];
  error?: string;
}) {
  if (result.error) {
    console.log(`\nFAIL ${result.fixture.name}`);
    console.log(`  request failed: ${result.error}`);
    return;
  }

  const passed = result.checks.every((check) => check.counted === false || check.pass);
  console.log(`\n${passed ? "PASS" : "FAIL"} ${result.fixture.name}`);
  for (const check of result.checks) {
    const info = check.counted === false;
    const marker = check.pass ? "ok" : info ? "info" : "not ok";
    console.log(`  ${marker} ${check.label}${info && !check.pass ? " (informational)" : ""}`);
    if (!check.pass) {
      console.log(`    expected: ${check.expected}`);
      console.log(`    actual:   ${check.actual}`);
    }
  }
}

function parseArgs(argv: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg?.startsWith("--")) continue;

    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    if (!rawKey) continue;
    if (inlineValue !== undefined) {
      parsed[rawKey] = inlineValue;
      continue;
    }

    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      parsed[rawKey] = next;
      i += 1;
    } else {
      parsed[rawKey] = "true";
    }
  }
  return parsed;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
