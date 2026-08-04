/**
 * Self-test for the gemini-fallback work (2026-08-04):
 *   - apps/workers/src/lib/llm.ts's chatWithFallback/chatStreamWithFallback —
 *     Luna-primary/Gemini-fallback routing, the "already yielded, don't fall
 *     back" streaming rule, the authorizeFallback gate, and that a client
 *     never influences which Gemini model gets used.
 *   - lib/cost.ts's restored Gemini MODEL_RATES rows (a silent fallthrough to
 *     DEFAULT_RATE would mis-cost every fallback-served call).
 *   - That the SAME provider-agnostic image content part (solver-core's
 *     imagePart()) is correctly consumed by BOTH providers' own request
 *     builders ("image-input requests must work on both providers").
 *   - routes/solve.ts's ALLOWED_MODELS whitelist gate (2026-07-28
 *     whitelist-bypass-incident hardening): a non-Luna `body.model` must
 *     still 400 with ZERO provider calls and ZERO metrics/KV writes, on BOTH
 *     the Luna-configured and Gemini-fallback-only paths — i.e. the gate
 *     runs unconditionally in front of BOTH providers, not just Luna's.
 *
 * Same plain-tsx pattern as the other self-test-*.ts scripts (no vitest in
 * this workspace) — run via:
 *
 *   pnpm --filter @statshelpr/api exec tsx --tsconfig ../workers/tsconfig.json ../workers/scripts/self-test-fallback.ts
 *
 * The explicit --tsconfig (unlike the other self-test-*.ts files' plain
 * invocation) is required here specifically because this file is the only
 * self-test that imports routes/solve.ts directly (for the route-level
 * whitelist test below) — solve.ts uses the "@/*" -> "src/*" path alias
 * (apps/workers/tsconfig.json), which tsx only resolves when explicitly
 * pointed at that tsconfig; running from apps/api's directory without this
 * flag fails with ERR_MODULE_NOT_FOUND on the first "@/lib/..." import.
 *
 * Exit code is 0 if every check passes, 1 otherwise (CI-friendly).
 */

import {
  geminiProvider,
  openaiProvider,
  imagePart,
  LUNA_MODEL,
  GEMINI_DEFAULT_MODEL,
  GEMINI_IMAGE_MODEL,
  type LlmChatRequest,
  type LlmStreamDelta,
} from "@statshelpr/solver-core/core/providers";
import {
  chatWithFallback,
  chatStreamWithFallback,
  FallbackGateRejectedError,
  type FallbackEnv,
} from "../src/lib/llm";
import {
  costUsdForUsage,
  MODEL_RATES,
  GEMINI_TEXT_MODEL,
  IMAGE_VISION_MODEL,
} from "../src/lib/cost";
import { solve } from "../src/routes/solve";
import type { Env } from "../src/types";

let pass = 0;
let fail = 0;

function check(name: string, condition: boolean, detail?: string): void {
  if (condition) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

// ===========================================================================
// Fake fetch dispatcher — routes by host to independently-scripted OpenAI /
// Gemini responders, and records every call (URL + parsed JSON body) each
// side actually received. This is how "gemini never called" / "the model id
// in the captured request is X" get asserted below.
// ===========================================================================

interface CapturedCall {
  url: string;
  body: unknown;
}

let openaiCalls: CapturedCall[] = [];
let geminiCalls: CapturedCall[] = [];
const realFetch = globalThis.fetch;

type Responder = (callNumber: number) => Response | Promise<Response>;

function installFetch(opts: { openai?: Responder; gemini?: Responder }): void {
  openaiCalls = [];
  geminiCalls = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    let parsedBody: unknown;
    if (init?.body) {
      try {
        parsedBody = JSON.parse(String(init.body));
      } catch {
        parsedBody = String(init.body);
      }
    }
    if (url.includes("api.openai.com")) {
      openaiCalls.push({ url, body: parsedBody });
      if (!opts.openai) throw new Error(`unexpected OpenAI call in this test: ${url}`);
      return opts.openai(openaiCalls.length);
    }
    if (url.includes("generativelanguage.googleapis.com")) {
      geminiCalls.push({ url, body: parsedBody });
      if (!opts.gemini) throw new Error(`unexpected Gemini call in this test: ${url}`);
      return opts.gemini(geminiCalls.length);
    }
    throw new Error(`unexpected fetch host in this test: ${url}`);
  }) as typeof fetch;
}

function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

// --- response builders -----------------------------------------------------

function openaiOkResponse(text: string): Response {
  return Response.json({
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
    usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
  });
}

function openaiErrorResponse(status: number, message: string): Response {
  return Response.json({ error: { message } }, { status });
}

function geminiOkResponse(text: string): Response {
  return Response.json({
    candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 15, totalTokenCount: 105 },
  });
}

function geminiErrorResponse(status: number, message: string): Response {
  return Response.json({ error: { message } }, { status });
}

/** A ReadableStream that emits each `lines` entry as its own SSE `data:`
 *  frame, one per pull() — mirrors a real chunked SSE response closely
 *  enough for openai.ts's/gemini.ts's line-buffering reader loops. */
function sseBody(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= lines.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(`${lines[i]}\n`));
      i++;
    },
  });
}

function openaiSseResponse(deltas: string[]): Response {
  const lines = [
    ...deltas.map((d) => `data: ${JSON.stringify({ type: "response.output_text.delta", delta: d })}`),
    `data: ${JSON.stringify({
      type: "response.completed",
      response: { status: "completed", usage: { input_tokens: 50, output_tokens: 10, total_tokens: 60 } },
    })}`,
  ];
  return new Response(sseBody(lines), { status: 200 });
}

function geminiSseResponse(deltas: string[]): Response {
  const lines = deltas.map((d, idx) => {
    const isLast = idx === deltas.length - 1;
    return `data: ${JSON.stringify({
      candidates: [{ content: { parts: [{ text: d }] }, ...(isLast ? { finishReason: "STOP" } : {}) }],
      ...(isLast ? { usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 8, totalTokenCount: 48 } } : {}),
    })}`;
  });
  return new Response(sseBody(lines), { status: 200 });
}

/** Yields exactly ONE valid delta, then the underlying stream errors on the
 *  next pull — simulates a mid-stream drop AFTER content has already reached
 *  the caller, for the "don't fall back once something's been yielded" rule. */
function openaiSseThenDropResponse(firstDelta: string): Response {
  const encoder = new TextEncoder();
  let sent = false;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: firstDelta })}\n`),
          );
          return;
        }
        controller.error(new Error("simulated mid-stream drop"));
      },
    }),
    { status: 200 },
  );
}

async function drain(
  stream: AsyncGenerator<LlmStreamDelta>,
): Promise<{ deltas: LlmStreamDelta[]; error?: unknown }> {
  const deltas: LlmStreamDelta[] = [];
  try {
    for await (const d of stream) deltas.push(d);
  } catch (error) {
    return { deltas, error };
  }
  return { deltas };
}

const bothKeys: FallbackEnv = { OPENAI_API_KEY: "luna-key", GEMINI_API_KEY: "gemini-key" };
const alwaysAllow = () => true;
const baseReq: LlmChatRequest = {
  system: "You are a stats tutor.",
  messages: [{ role: "user", content: "What is a p-value?" }],
};

async function main() {
  // =========================================================================
  console.log("lib/llm.ts: chatWithFallback (non-streaming — repair leg)");

  {
    installFetch({ openai: () => openaiOkResponse("Luna answer") });
    const { result, servedBy } = await chatWithFallback(bothKeys, baseReq, {
      geminiModel: GEMINI_DEFAULT_MODEL,
      authorizeFallback: alwaysAllow,
    });
    check(
      "Luna succeeds: result text + servedBy is luna, gemini never called",
      result.text === "Luna answer" &&
        servedBy.provider === "luna" &&
        servedBy.model === LUNA_MODEL &&
        openaiCalls.length === 1 &&
        geminiCalls.length === 0,
      JSON.stringify({ text: result.text, servedBy, openai: openaiCalls.length, gemini: geminiCalls.length }),
    );
    restoreFetch();
  }

  {
    installFetch({
      openai: () => openaiErrorResponse(401, "Invalid API key"),
      gemini: () => geminiOkResponse("Gemini answer"),
    });
    const { result, servedBy } = await chatWithFallback(bothKeys, baseReq, {
      geminiModel: GEMINI_DEFAULT_MODEL,
      authorizeFallback: alwaysAllow,
    });
    check(
      "Luna 401 (invalid key): falls back, Gemini serves, servedBy is gemini",
      result.text === "Gemini answer" &&
        servedBy.provider === "gemini" &&
        servedBy.model === GEMINI_DEFAULT_MODEL &&
        openaiCalls.length === 1 &&
        geminiCalls.length === 1,
      JSON.stringify({ text: result.text, servedBy }),
    );
    restoreFetch();
  }

  {
    // JUDGMENT CALL under test: shouldFallback() in llm.ts is unconditional —
    // even a 400 "bad_input" (which the brief's own trigger list didn't
    // explicitly name) falls back. See llm.ts's shouldFallback doc.
    installFetch({
      openai: () => openaiErrorResponse(400, "Invalid request body"),
      gemini: () => geminiOkResponse("Gemini answer"),
    });
    const { servedBy } = await chatWithFallback(bothKeys, baseReq, {
      geminiModel: GEMINI_DEFAULT_MODEL,
      authorizeFallback: alwaysAllow,
    });
    check(
      "Luna 400 (bad_input) also falls back (documented judgment call, not narrowed)",
      servedBy.provider === "gemini",
      JSON.stringify(servedBy),
    );
    restoreFetch();
  }

  {
    installFetch({ gemini: () => geminiOkResponse("Gemini answer") });
    const env: FallbackEnv = { OPENAI_API_KEY: "", GEMINI_API_KEY: "gemini-key" };
    const { result, servedBy } = await chatWithFallback(env, baseReq, {
      geminiModel: GEMINI_DEFAULT_MODEL,
      authorizeFallback: alwaysAllow,
    });
    check(
      "OPENAI_API_KEY missing/empty: Luna never attempted, straight to Gemini",
      result.text === "Gemini answer" && servedBy.provider === "gemini" && openaiCalls.length === 0,
      JSON.stringify({ servedBy, openaiCalls: openaiCalls.length }),
    );
    restoreFetch();
  }

  {
    installFetch({ openai: () => openaiErrorResponse(401, "Invalid API key") });
    const env: FallbackEnv = { OPENAI_API_KEY: "luna-key", GEMINI_API_KEY: undefined };
    let threw: unknown;
    try {
      await chatWithFallback(env, baseReq, { geminiModel: GEMINI_DEFAULT_MODEL, authorizeFallback: alwaysAllow });
    } catch (e) {
      threw = e;
    }
    check(
      "Luna fails + no GEMINI_API_KEY configured: rethrows the ORIGINAL Luna error, gemini never called",
      threw instanceof Error && /Invalid API key/.test((threw as Error).message) && geminiCalls.length === 0,
      String(threw),
    );
    restoreFetch();
  }

  {
    installFetch({ openai: () => openaiErrorResponse(429, "Rate limited") });
    let threw: unknown;
    try {
      await chatWithFallback(bothKeys, baseReq, { geminiModel: GEMINI_DEFAULT_MODEL, authorizeFallback: () => false });
    } catch (e) {
      threw = e;
    }
    check(
      "authorizeFallback refuses: throws FallbackGateRejectedError, gemini never called",
      threw instanceof FallbackGateRejectedError && geminiCalls.length === 0,
      String(threw),
    );
    restoreFetch();
  }

  {
    installFetch({
      openai: () => openaiErrorResponse(500, "Upstream error"),
      gemini: () => geminiErrorResponse(403, "Gemini key revoked"),
    });
    let threw: unknown;
    try {
      await chatWithFallback(bothKeys, baseReq, { geminiModel: GEMINI_DEFAULT_MODEL, authorizeFallback: alwaysAllow });
    } catch (e) {
      threw = e;
    }
    check(
      "Luna AND Gemini both fail: Gemini's own error propagates (its own .status)",
      threw instanceof Error &&
        /Gemini key revoked/.test((threw as Error).message) &&
        (threw as Error & { status?: number }).status === 403,
      String(threw),
    );
    restoreFetch();
  }

  {
    // SECURITY: the Gemini fallback model is ALWAYS the server-chosen
    // opts.geminiModel constant, never req.model (which — on this call —
    // deliberately still names a Luna-shaped id, to prove it gets
    // overridden rather than forwarded).
    installFetch({
      openai: () => openaiErrorResponse(401, "Invalid API key"),
      gemini: () => geminiOkResponse("Gemini vision answer"),
    });
    await chatWithFallback(bothKeys, { ...baseReq, model: LUNA_MODEL }, {
      geminiModel: GEMINI_IMAGE_MODEL,
      authorizeFallback: alwaysAllow,
    });
    const call = geminiCalls[0];
    check(
      "Gemini fallback URL names opts.geminiModel (GEMINI_IMAGE_MODEL), never req.model (LUNA_MODEL)",
      !!call && call.url.includes(GEMINI_IMAGE_MODEL) && !call.url.includes(LUNA_MODEL),
      call?.url,
    );
    restoreFetch();
  }

  // =========================================================================
  console.log("\nlib/llm.ts: chatStreamWithFallback (streaming — first-pass/interpret legs)");

  {
    installFetch({ openai: () => openaiSseResponse(["Hello", " world"]) });
    const { stream, servedBy } = chatStreamWithFallback(bothKeys, baseReq, {
      geminiModel: GEMINI_DEFAULT_MODEL,
      authorizeFallback: alwaysAllow,
    });
    const { deltas, error } = await drain(stream);
    const text = deltas.map((d) => d.text ?? "").join("");
    check(
      "Luna streams successfully: full text + usage, servedBy luna, gemini never called",
      !error &&
        text === "Hello world" &&
        deltas[deltas.length - 1]?.usage?.total_tokens === 60 &&
        servedBy().provider === "luna" &&
        geminiCalls.length === 0,
      JSON.stringify({ text, error, servedBy: servedBy() }),
    );
    restoreFetch();
  }

  {
    installFetch({
      openai: () => openaiErrorResponse(429, "Rate limited"),
      gemini: () => geminiSseResponse(["Gemini", " streamed", " answer"]),
    });
    const { stream, servedBy } = chatStreamWithFallback(bothKeys, baseReq, {
      geminiModel: GEMINI_DEFAULT_MODEL,
      authorizeFallback: alwaysAllow,
    });
    const { deltas, error } = await drain(stream);
    const text = deltas.map((d) => d.text ?? "").join("");
    check(
      "Luna fails before any yield: falls back, Gemini streams the full answer",
      !error && text === "Gemini streamed answer" && servedBy().provider === "gemini",
      JSON.stringify({ text, error, servedBy: servedBy() }),
    );
    restoreFetch();
  }

  {
    // The critical safety rule: once Luna has already streamed a delta to
    // the caller, a mid-stream drop must NOT fall back (would splice two
    // providers' partial answers together) — it must surface as a normal
    // error, and Gemini must never be touched even though it's configured
    // and would happily answer.
    installFetch({
      openai: () => openaiSseThenDropResponse("Partial Luna text"),
      gemini: () => geminiSseResponse(["should never be reached"]),
    });
    const { stream, servedBy } = chatStreamWithFallback(bothKeys, baseReq, {
      geminiModel: GEMINI_DEFAULT_MODEL,
      authorizeFallback: alwaysAllow,
    });
    const { deltas, error } = await drain(stream);
    check(
      "Luna yields once then drops mid-stream: NO fallback — error surfaces, gemini never called",
      deltas.length === 1 &&
        deltas[0]?.text === "Partial Luna text" &&
        !!error &&
        geminiCalls.length === 0 &&
        servedBy().provider === "luna",
      JSON.stringify({ deltas, error, geminiCalls: geminiCalls.length }),
    );
    restoreFetch();
  }

  {
    installFetch({ openai: () => openaiErrorResponse(500, "Upstream error") });
    const { stream } = chatStreamWithFallback(bothKeys, baseReq, {
      geminiModel: GEMINI_DEFAULT_MODEL,
      authorizeFallback: () => false,
    });
    const { deltas, error } = await drain(stream);
    check(
      "authorizeFallback refuses mid-stream: FallbackGateRejectedError surfaces, gemini never called",
      deltas.length === 0 && error instanceof FallbackGateRejectedError && geminiCalls.length === 0,
      JSON.stringify({ deltas, error }),
    );
    restoreFetch();
  }

  // =========================================================================
  console.log("\nlib/cost.ts: Gemini MODEL_RATES rows restored (not silently DEFAULT_RATE)");

  check(
    "GEMINI_TEXT_MODEL has its OWN explicit MODEL_RATES row",
    Object.prototype.hasOwnProperty.call(MODEL_RATES, GEMINI_TEXT_MODEL),
  );
  check(
    "IMAGE_VISION_MODEL has its OWN explicit MODEL_RATES row (not a DEFAULT_RATE coincidence)",
    Object.prototype.hasOwnProperty.call(MODEL_RATES, IMAGE_VISION_MODEL),
  );
  {
    // gemini-3.5-flash-lite: $0.30/M in, $2.50/M out, no cache discount.
    // 10,000 non-cached prompt + 2,000 completion tokens.
    const got = costUsdForUsage(GEMINI_TEXT_MODEL, { promptTokens: 10_000, completionTokens: 2_000, cachedTokens: 0 });
    const want = (10_000 / 1_000_000) * 0.3 + (2_000 / 1_000_000) * 2.5;
    check(
      `costUsdForUsage(${GEMINI_TEXT_MODEL}) matches the restored $0.30/$2.50 rate`,
      Math.abs(got - want) < 1e-9,
      `got ${got}, want ${want}`,
    );
  }
  {
    const got = costUsdForUsage(LUNA_MODEL, { promptTokens: 10_000, completionTokens: 2_000, cachedTokens: 0 });
    const want = (10_000 / 1_000_000) * 0.2 + (2_000 / 1_000_000) * 1.2;
    check(
      "costUsdForUsage(LUNA_MODEL) unchanged at $0.20/$1.20 (no regression from restoring Gemini rows)",
      Math.abs(got - want) < 1e-9,
      `got ${got}, want ${want}`,
    );
  }

  // =========================================================================
  console.log("\nimage content parity: the SAME imagePart() output works on BOTH providers");

  {
    const png1x1Base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const part = imagePart(png1x1Base64, "image/png");
    const req: LlmChatRequest = {
      system: "sys",
      messages: [{ role: "user", content: [part, { type: "text", text: "What's in this image?" }] }],
    };

    installFetch({ openai: () => openaiOkResponse("ok") });
    await openaiProvider.chat("k", req);
    const openaiBody = openaiCalls[0]?.body as {
      input?: Array<{ content?: Array<{ type: string; image_url?: string }> }>;
    };
    const openaiImagePart = openaiBody?.input?.[0]?.content?.find((p) => p.type === "input_image");
    check(
      "openaiProvider request carries input_image with the exact data URL",
      openaiImagePart?.image_url === `data:image/png;base64,${png1x1Base64}`,
      JSON.stringify(openaiImagePart),
    );
    restoreFetch();

    installFetch({ gemini: () => geminiOkResponse("ok") });
    await geminiProvider.chat("k", req);
    const geminiBody = geminiCalls[0]?.body as {
      contents?: Array<{ parts?: Array<{ inline_data?: { mime_type: string; data: string } }> }>;
    };
    const geminiImagePart = geminiBody?.contents?.[0]?.parts?.find((p) => p.inline_data);
    check(
      "geminiProvider translates the SAME imagePart() output into inline_data with matching mime/data",
      geminiImagePart?.inline_data?.mime_type === "image/png" && geminiImagePart?.inline_data?.data === png1x1Base64,
      JSON.stringify(geminiImagePart),
    );
    restoreFetch();
  }

  // =========================================================================
  console.log(
    "\nroutes/solve.ts: ALLOWED_MODELS whitelist (2026-07-28 incident hardening) — " +
      "must 400 with zero provider calls / zero metrics writes, on BOTH provider configs",
  );

  await runWhitelistTest("Luna configured, Gemini unset (primary-only path)", {
    OPENAI_API_KEY: "luna-key",
  });
  await runWhitelistTest("Luna UNSET, Gemini configured (fallback-only path)", {
    OPENAI_API_KEY: undefined,
    GEMINI_API_KEY: "gemini-key",
  });

  // ---------------------------------------------------------------------------
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

// ===========================================================================
// Route-level whitelist test helpers
// ===========================================================================

class CountingFakeKv {
  putCalls = 0;
  getCalls = 0;
  private store = new Map<string, string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal test double
  async get(key: string, type?: unknown): Promise<any> {
    this.getCalls++;
    const v = this.store.get(key);
    if (v === undefined) return null;
    return type === "json" ? JSON.parse(v) : v;
  }
  async put(key: string, value: string): Promise<void> {
    this.putCalls++;
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

class CountingFakeCountersNamespace {
  gateCalls = 0;
  idFromName(_name: string): unknown {
    return "fake-id";
  }
  get(_id: unknown): { fetch: (url: string, init?: { body?: string }) => Promise<Response> } {
    return {
      fetch: async () => {
        this.gateCalls++;
        return Response.json({ allowed: true, results: [] });
      },
    };
  }
}

async function runWhitelistTest(label: string, keyOverrides: Partial<Pick<Env, "OPENAI_API_KEY" | "GEMINI_API_KEY">>) {
  const kv = new CountingFakeKv();
  const counters = new CountingFakeCountersNamespace();
  const env = {
    OPENAI_API_KEY: "luna-key",
    LLM_PROVIDER: "openai",
    FREE_TIER_DAILY_LIMIT: "5",
    R_RUNNER_URL: "https://fake-r-runner.example.com",
    R_RUNNER_SECRET: "fake-runner-secret",
    ACTIVATION_HASH_SECRET: "fake-activation-hash-secret",
    STATSHELPR_KV: kv as unknown as Env["STATSHELPR_KV"],
    COUNTERS_DO: counters as unknown as Env["COUNTERS_DO"],
    ...keyOverrides,
  } as Env;

  installFetch({}); // no provider host is expected to be hit AT ALL in this test
  const req = new Request("https://api.statshelpr.com/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      questionText: "What is a p-value?",
      // The exact fabricated id from the 2026-07-28 probe this whitelist closed.
      model: "gemini-9.9-ultra-pro",
    }),
  });

  let res: Response;
  let threw: unknown;
  try {
    res = await solve.fetch(req, env);
  } catch (e) {
    threw = e;
    res = new Response(null, { status: 599 });
  }
  const json = threw ? undefined : await res.json().catch(() => undefined);

  check(
    `[${label}] non-whitelisted body.model -> 400 "Unsupported model."`,
    !threw && res.status === 400 && (json as { error?: string })?.error === "Unsupported model.",
    threw ? String(threw) : JSON.stringify({ status: res.status, json }),
  );
  check(
    `[${label}] zero provider calls (openai=${openaiCalls.length}, gemini=${geminiCalls.length})`,
    openaiCalls.length === 0 && geminiCalls.length === 0,
  );
  check(
    `[${label}] zero KV writes (put) and zero CountersDO gate calls — validation ran before ANY admission/metrics I/O`,
    kv.putCalls === 0 && counters.gateCalls === 0,
    `kv.putCalls=${kv.putCalls}, counters.gateCalls=${counters.gateCalls}`,
  );
  restoreFetch();
}

void main();
