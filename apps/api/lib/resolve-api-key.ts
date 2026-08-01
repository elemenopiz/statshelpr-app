/**
 * Resolve the OpenAI API key (Luna is the sole solver provider). Kept as a
 * function (rather than reading the env inline at each caller) so tests and
 * future providers can override it.
 *
 * Node/Next-specific: reads directly from `process.env`. Workers has no such
 * global — its routes read OPENAI_API_KEY from Hono's `c.env` binding
 * instead (see apps/workers/src/types.ts), so this helper stays app-local
 * rather than living in the shared @statshelpr/solver-core package.
 */
export function resolveApiKey(): { apiKey: string | undefined; envName: string } {
  return {
    apiKey: process.env["OPENAI_API_KEY"],
    envName: "OPENAI_API_KEY",
  };
}
