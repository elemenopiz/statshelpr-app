import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";

interface Choice {
  label: string;
  text: string;
  type?: "radio" | "checkbox";
}

interface SolveRequest {
  questionText?: string;
  choices?: Choice[];
  images?: unknown[];
  dataFiles?: Array<{ filename: string; content: string }>;
  stream?: boolean;
  debug?: boolean;
}

interface SolveResponse {
  mode?: string;
  answer?: string;
  selectedChoices?: string[];
  error?: string;
}

interface EvalFixture {
  name: string;
  request: SolveRequest;
  expected: {
    mode: "concept" | "calc";
    selectedChoices: string[];
    answerContains?: string[];
  };
}

interface CheckResult {
  label: string;
  pass: boolean;
  expected: string;
  actual: string;
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
  const results: Array<{ fixture: EvalFixture; checks: CheckResult[]; error?: string }> = [];

  for (const fixture of fixtures) {
    const result = await runFixture(fixture);
    results.push(result);
    printFixtureResult(result);
  }

  const failed = results.filter((result) => result.error || result.checks.some((c) => !c.pass));
  console.log("");
  console.log(`${results.length - failed.length}/${results.length} fixtures passed`);

  if (failed.length > 0) {
    process.exitCode = 1;
  }
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

async function runFixture(
  fixture: EvalFixture,
): Promise<{ fixture: EvalFixture; checks: CheckResult[]; error?: string }> {
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

  const checks = [
    checkEqual("mode", fixture.expected.mode, response.mode ?? ""),
    checkChoices(fixture.expected.selectedChoices, response.selectedChoices ?? []),
    ...checkAnswerContains(fixture.expected.answerContains ?? [], response.answer ?? ""),
  ];

  return { fixture, checks };
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
      body: JSON.stringify({ ...request, stream: false }),
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

function checkAnswerContains(expected: string[], answer: string): CheckResult[] {
  const lower = answer.toLowerCase();
  return expected.map((snippet) => ({
    label: `answer contains "${snippet}"`,
    pass: lower.includes(snippet.toLowerCase()),
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

  const passed = result.checks.every((check) => check.pass);
  console.log(`\n${passed ? "PASS" : "FAIL"} ${result.fixture.name}`);
  for (const check of result.checks) {
    const marker = check.pass ? "ok" : "not ok";
    console.log(`  ${marker} ${check.label}`);
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
