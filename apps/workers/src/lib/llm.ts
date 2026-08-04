/**
 * Luna-primary / Gemini-fallback orchestration (gemini-fallback work,
 * 2026-08-04).
 *
 * Every solve leg (first pass, R-repair, interpret — see routes/solve.ts and
 * lib/r-repair.ts) calls chatWithFallback()/chatStreamWithFallback() here
 * instead of calling a provider's chat()/chatStream() directly. Both:
 *   1. Try OpenAI Luna first, on OPENAI_API_KEY.
 *   2. On failure, ask the caller's `authorizeFallback` gate for permission,
 *      then fall back to Gemini on GEMINI_API_KEY — see shouldFallback()
 *      below for exactly which failures qualify, and authorizeFallback's doc
 *      for why this is a GATE (can refuse), not just a notification.
 *   3. Report back WHICH provider/model actually served the call (`servedBy`)
 *      so the caller can cost/attribute/log against the real answer, not the
 *      request as originally addressed to Luna.
 *
 * Deliberately NOT a generic multi-provider framework: there are exactly two
 * hardcoded providers in a fixed try-A-then-B order, no config-driven
 * provider list, no retry-the-fallback-too loop. Luna stays primary — Gemini
 * only ever fires when Luna's own retry policy (core/providers/retry.ts,
 * which every provider's chat()/chatStream() already wraps its fetch() in)
 * has been exhausted, or OPENAI_API_KEY is missing/invalid.
 *
 * "Transparent" per the brief means transparent to the STUDENT — the SSE
 * event shapes this produces are byte-identical whichever provider served,
 * so routes/solve.ts's write() calls need no branching. It is NOT transparent
 * to the OWNER: every fallback is costed/recorded under the real Gemini model
 * id it used (lib/cost.ts's MODEL_RATES has both Gemini rows), which flows
 * through unchanged into GET /api/metrics' economics.modelsUsed and the
 * /dashboard "Cost by model" card — a non-Luna row appearing there, with a
 * real call count and real cost, IS the content-free fallback signal the
 * owner watches. No separate counter/alert type was added for this; see
 * routes/solve.ts's PR notes for why that was a deliberate scope call, not an
 * oversight.
 *
 * SECURITY (2026-07-28 whitelist-bypass incident — see routes/solve.ts's
 * ALLOWED_MODELS): `opts.geminiModel` below is always a plain server-chosen
 * constant (routes/solve.ts computes it ONCE from a boolean — whether the
 * request has images — never from a client-supplied string), and the Gemini
 * call always OVERRIDES `req.model` with it (`{ ...req, model: opts.
 * geminiModel }`) rather than forwarding whatever model the client originally
 * asked Luna for. There is no code path here through which a request body
 * field reaches the Gemini provider's `model`. This module also never calls
 * a provider before its caller's own admission/validation gates have run —
 * see routes/solve.ts, which only ever calls into this file from deep inside
 * its SSE producer, well after validateSolveBody() and the CountersDO gate.
 */

import {
  geminiProvider,
  openaiProvider,
  LUNA_MODEL,
  type LlmChatRequest,
  type LlmChatResult,
  type LlmStreamDelta,
} from "@statshelpr/solver-core/core/providers";
import type { Env } from "../types";

/** Only the two secrets this module touches — lets self-tests build a
 *  minimal fake env instead of a full Env. */
export type FallbackEnv = Pick<Env, "OPENAI_API_KEY" | "GEMINI_API_KEY">;

export type ProviderId = "luna" | "gemini";

export interface ServedBy {
  provider: ProviderId;
  /** The exact model id the serving provider actually used — feed this
   *  (never a pre-resolved/requested model string) into lib/cost.ts's
   *  costUsdForUsage and into the metrics event's `model` field, so cost and
   *  byModel/modelsUsed always reflect the real answer. */
  model: string;
}

/** Thrown instead of the original Luna error when `authorizeFallback`
 *  refuses the Gemini attempt (global kill-switch tripped — see
 *  routes/solve.ts's gateFallback). routes/solve.ts's outer catch recognizes
 *  this (via `instanceof`) and writes the same KILL_SWITCH_MESSAGE/"quota"
 *  errorType a same-leg primary-call kill-switch rejection already produces,
 *  instead of surfacing a confusing "OPENAI_API_KEY not configured"-shaped
 *  message to the student when the REAL reason is the service-wide ceiling. */
export class FallbackGateRejectedError extends Error {
  constructor() {
    super("Gemini fallback refused by the global kill-switch gate");
    this.name = "FallbackGateRejectedError";
  }
}

export interface FallbackOpts {
  /** Which Gemini model to use IF this call falls back — the caller
   *  precomputes this ONCE per request (hasImage ? GEMINI_IMAGE_MODEL :
   *  GEMINI_DEFAULT_MODEL, see routes/solve.ts), the same "one model
   *  decision, reused across every leg of the request including the
   *  text-only repair leg" precedent the pre-fc35aa5 code used (see
   *  lib/r-repair.ts's doc comment) — kept identical rather than inventing a
   *  new per-leg-content-aware policy. ALWAYS a server-side constant — see
   *  this module's top-of-file SECURITY note. */
  geminiModel: string;
  /** Called once Luna has definitively failed, BEFORE the Gemini call is
   *  attempted — and awaited. Must resolve `true` to actually let the Gemini
   *  attempt fire, or `false` to refuse it (chatWithFallback/
   *  chatStreamWithFallback then throw FallbackGateRejectedError instead of
   *  calling Gemini).
   *
   *  REQUIRED, not optional, and NOT merely observational: a real Luna
   *  failure means one gated call's worth of "budget" (the top-of-route
   *  CountersDO gate, or a leg's own checkGlobalKillSwitch pre-check) has
   *  already been spent on the FAILED attempt — the Gemini call this module
   *  is about to make is a SECOND, NEW outbound paid-API call and must be
   *  gated again on its own, the same way routes/solve.ts already re-gates
   *  its repair/interpret legs' own first attempts via checkGlobalKillSwitch
   *  before each one. Without this, a forced-failure attack (e.g. spamming
   *  requests until Luna's own rate limit trips on every one of them) would
   *  route one full extra real provider call per request through the
   *  fallback leg while only ever consuming ONE unit of the call-count
   *  ceiling — i.e. unmetered volume against GLOBAL_DAILY_CALL_LIMIT even
   *  though GLOBAL_DAILY_SPEND_LIMIT_USD still (separately) catches the real
   *  dollars. Making this required (not an optional hook a call site could
   *  forget) closes that off structurally: every real call site MUST decide
   *  before Gemini ever fires. Self-tests that don't care about gating pass
   *  `() => true`. */
  authorizeFallback: (lunaError: unknown) => Promise<boolean> | boolean;
}

/** Whether a failed Luna attempt should trigger the Gemini fallback (subject
 *  to authorizeFallback's gate above still being satisfied). Currently
 *  unconditional: every Luna failure is eligible, including a 400/422
 *  "bad_input" rejection from OpenAI's API and a missing/empty
 *  OPENAI_API_KEY (treated as an immediate failure before any HTTP call).
 *
 *  JUDGMENT CALL, flagged rather than silently narrowed: the task brief's
 *  own trigger list ("5xx, timeouts, 429/quota, or missing/invalid
 *  OPENAI_API_KEY") reads as illustrative examples of "ultimately fails"
 *  rather than an exhaustive whitelist — "missing/invalid...KEY" itself
 *  isn't even a transient-failure class the way the others are. Falling back
 *  unconditionally means a genuine request-shape bug in openai.ts (still
 *  stub-grade — see that file's own doc, "has not been exercised against the
 *  live API yet") degrades to "answered by Gemini" instead of hard-failing
 *  every solve, at the cost of masking such a bug behind a slower/pricier
 *  answer until someone notices the byModel/dashboard signal. If that
 *  tradeoff is wrong, narrow this to
 *  `classifyError(err) !== "bad_input"` (apps/workers/src/lib/classify-error.ts) —
 *  one line, not imported here to keep this module dependency-light and
 *  because classifyError's message-sniffing is tuned for the FINAL
 *  user-facing error, not this internal routing decision. */
function shouldFallback(_lunaError: unknown): boolean {
  return true;
}

function missingKeyError(): Error {
  return new Error("OPENAI_API_KEY not configured");
}

/**
 * Non-streaming chat with fallback — used by lib/r-repair.ts. Tries Luna on
 * `env.OPENAI_API_KEY`; on failure (see shouldFallback), asks
 * `opts.authorizeFallback`, then — if authorized — tries Gemini on
 * `env.GEMINI_API_KEY` at `opts.geminiModel`. Rethrows the ORIGINAL Luna
 * error when Gemini isn't configured, fallback isn't authorized, or Gemini
 * itself fails to call — a Gemini-specific (or gate-rejection-specific, see
 * FallbackGateRejectedError) error would be a strictly less useful
 * diagnostic than "the primary provider failed" when there was never a real
 * fallback attempt, and when Gemini WAS attempted and also failed, its own
 * thrown error (complete with its own `.status` for classify-error.ts)
 * propagates instead.
 */
export async function chatWithFallback(
  env: FallbackEnv,
  req: LlmChatRequest,
  opts: FallbackOpts,
): Promise<{ result: LlmChatResult; servedBy: ServedBy }> {
  const lunaKey = env.OPENAI_API_KEY;
  let lunaError: unknown;

  if (lunaKey) {
    try {
      const result = await openaiProvider.chat(lunaKey, req);
      return { result, servedBy: { provider: "luna", model: req.model ?? LUNA_MODEL } };
    } catch (err) {
      lunaError = err;
    }
  } else {
    lunaError = missingKeyError();
  }

  if (!shouldFallback(lunaError)) throw lunaError;
  const geminiKey = env.GEMINI_API_KEY;
  if (!geminiKey) throw lunaError; // no fallback configured — surface the original Luna failure

  const authorized = await opts.authorizeFallback(lunaError);
  if (!authorized) throw new FallbackGateRejectedError();

  const result = await geminiProvider.chat(geminiKey, { ...req, model: opts.geminiModel });
  return { result, servedBy: { provider: "gemini", model: opts.geminiModel } };
}

/**
 * Streaming chat with fallback — used by routes/solve.ts's first-pass and
 * interpret legs. Same policy as chatWithFallback, with one additional rule
 * specific to streaming: fallback is only attempted if Luna fails BEFORE
 * yielding its first delta. Once even one delta has reached the caller (and,
 * in routes/solve.ts, been written to the SSE client), the two providers'
 * partial answers can no longer be safely spliced — same "once committed,
 * don't retry" principle core/providers/retry.ts's own chatStream doc
 * already applies one layer down for mid-stream drops. A post-first-delta
 * failure rethrows normally; routes/solve.ts's existing catch handles it like
 * any other solve error.
 *
 * Returns a `servedBy()` accessor rather than a plain field because the
 * decision isn't known until the generator actually runs — read it only
 * AFTER fully draining `stream` (routes/solve.ts's `for await` loops already
 * do this naturally).
 */
export function chatStreamWithFallback(
  env: FallbackEnv,
  req: LlmChatRequest,
  opts: FallbackOpts,
): { stream: AsyncGenerator<LlmStreamDelta>; servedBy: () => ServedBy } {
  const servedBy: ServedBy = { provider: "luna", model: req.model ?? LUNA_MODEL };

  async function* run(): AsyncGenerator<LlmStreamDelta> {
    const lunaKey = env.OPENAI_API_KEY;
    let lunaError: unknown;

    if (lunaKey) {
      let yielded = false;
      try {
        for await (const delta of openaiProvider.chatStream(lunaKey, req)) {
          yielded = true;
          yield delta;
        }
        return; // Luna finished cleanly — no fallback.
      } catch (err) {
        if (yielded) throw err; // already streamed partial output — can't safely fall back now
        lunaError = err;
      }
    } else {
      lunaError = missingKeyError();
    }

    if (!shouldFallback(lunaError)) throw lunaError;
    const geminiKey = env.GEMINI_API_KEY;
    if (!geminiKey) throw lunaError; // no fallback configured — surface the original Luna failure

    const authorized = await opts.authorizeFallback(lunaError);
    if (!authorized) throw new FallbackGateRejectedError();

    servedBy.provider = "gemini";
    servedBy.model = opts.geminiModel;
    for await (const delta of geminiProvider.chatStream(geminiKey, { ...req, model: opts.geminiModel })) {
      yield delta;
    }
  }

  return { stream: run(), servedBy: () => servedBy };
}
