// Node/Vercel-sandbox-coupled pieces (solveNonStreaming, repairRCode) are
// NOT re-exported here — they depend on server-side R execution
// (@vercel/sandbox), which only apps/api has. They stay app-local at
// apps/api/lib/solver/{non-streaming,r-repair}.ts and import the shared bits
// below directly from this package.
export { deriveSelectedChoices, deriveBlankAnswers, normalizeChoices } from "./choices";
export {
  buildFollowupContent,
  buildQuestionPrompt,
  buildUserContent,
} from "./prompts";
export { MAX_TOKENS_FIRST, MAX_TOKENS_SECOND, MODEL, IMAGE_MODEL, resolveModel } from "./settings";
export type { AnswerChoice, BlankAnswer, DataFile, SolveBlank, SolveBody } from "./types";
