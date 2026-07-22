import {
  buildSystemPrompt,
  extractRCode,
  parseResponse,
} from "@statshelpr/solver-core/core";
import { chat } from "@statshelpr/solver-core/core/providers";
import { runR } from "@/lib/sandbox";
import {
  deriveBlankAnswers,
  deriveSelectedChoices,
  buildFollowupContent,
  buildQuestionPrompt,
  buildUserContent,
  MAX_TOKENS_FIRST,
  MAX_TOKENS_SECOND,
  resolveModel,
  type DataFile,
  type SolveBody,
} from "@statshelpr/solver-core/solver";
import { repairRCode } from "./r-repair";

interface NonStreamArgs {
  apiKey: string;
  body: SolveBody;
  dataContext: string;
  dataFiles: DataFile[];
}

export async function solveNonStreaming(args: NonStreamArgs) {
  const { apiKey, body, dataContext, dataFiles } = args;
  const model = resolveModel(body);
  const hasImage = (body.images?.length ?? 0) > 0;
  const hasBlanks = (body.blanks?.length ?? 0) >= 2;
  const system = buildSystemPrompt({ dataContext, imageMode: hasImage, hasBlanks });
  const questionPrompt = buildQuestionPrompt(body);
  const userContent = buildUserContent(questionPrompt, body.images);

  const first = await runFirstPass(apiKey, system, userContent, model);
  const parsed = parseResponse(first.text);

  if (parsed.mode === "concept") {
    const selectedChoices = deriveSelectedChoices(parsed.body, body.choices);
    const blanks = deriveBlankAnswers(parsed.body, body.blanks);
    return {
      mode: "concept",
      answer: parsed.body,
      selectedChoices,
      ...(blanks.length ? { blanks } : {}),
      confidence: parsed.confidence,
      lowConfidence: parsed.lowConfidence,
      usage: first.usage,
      ...(body.debug
        ? {
            debug: {
              route: "concept",
              rawFirst: first.text,
              selectedChoices,
              usage: first.usage,
            },
          }
        : {}),
    };
  }

  const { rCode, runResult, repairedRCode } = await runCalculationStage({
    apiKey,
    system,
    questionPrompt,
    initialRCode: extractRCode(parsed.body),
    dataFiles,
  });

  const interpret = await runInterpretStage({
    apiKey,
    system,
    body,
    userContent,
    firstAssistantContent: parsed.body,
    rCode,
    rOutput: runResult.stdout,
  });

  const finalParsed = parseResponse(interpret.text);
  const selectedChoices = deriveSelectedChoices(finalParsed.body, body.choices);
  const blanks = deriveBlankAnswers(finalParsed.body, body.blanks);

  return {
    mode: "calc",
    rCode,
    rOutput: runResult.stdout,
    rExitCode: runResult.exitCode,
    rDurationMs: runResult.durationMs,
    answer: finalParsed.body,
    selectedChoices,
    ...(blanks.length ? { blanks } : {}),
    confidence: finalParsed.confidence,
    lowConfidence: finalParsed.lowConfidence,
    usage: {
      first: first.usage,
      interpret: interpret.usage,
    },
    ...(body.debug
      ? {
          debug: {
            route: "calc",
            rawFirst: first.text,
            rawInterpret: interpret.text,
            selectedChoices,
            rCode,
            repairedRCode,
            rStdout: runResult.stdout,
            rStderr: runResult.stderr,
            rExitCode: runResult.exitCode,
            usage: {
              first: first.usage,
              interpret: interpret.usage,
            },
          },
        }
      : {}),
  };
}

async function runFirstPass(
  apiKey: string,
  system: string,
  userContent: Parameters<typeof chat>[1]["messages"][number]["content"],
  model: string,
) {
  return chat(apiKey, {
    model,
    system,
    messages: [{ role: "user", content: userContent }],
    maxTokens: MAX_TOKENS_FIRST,
    thinking: { type: "enabled" },
  });
}

interface CalculationStageArgs {
  apiKey: string;
  system: string;
  questionPrompt: string;
  initialRCode: string;
  dataFiles: DataFile[];
}

async function runCalculationStage({
  apiKey,
  system,
  questionPrompt,
  initialRCode,
  dataFiles,
}: CalculationStageArgs) {
  let rCode = initialRCode;
  let runResult = await runR(rCode, dataFiles.map(toSandboxFile));
  let repairedRCode: string | undefined;

  if (runResult.exitCode !== 0 && !isUnrecoverableMissingData(rCode, dataFiles)) {
    repairedRCode = await repairRCode(apiKey, system, questionPrompt, rCode, runResult);
    if (repairedRCode) {
      rCode = repairedRCode;
      runResult = await runR(rCode, dataFiles.map(toSandboxFile));
    }
  }
  // else: fast-fail — the R read a data file the student never uploaded, so a
  // repair could only re-emit code reading the same missing file. Skip the
  // repair Gemini call + second R run and let the interpret stage answer from
  // the question text. See isUnrecoverableMissingData.

  return { rCode, runResult, repairedRCode };
}

interface InterpretStageArgs {
  apiKey: string;
  system: string;
  body: SolveBody;
  userContent: Parameters<typeof chat>[1]["messages"][number]["content"];
  firstAssistantContent: string;
  rCode: string;
  rOutput: string;
}

async function runInterpretStage({
  apiKey,
  system,
  body,
  userContent,
  firstAssistantContent,
  rCode,
  rOutput,
}: InterpretStageArgs) {
  return chat(apiKey, {
    model: resolveModel(body),
    system,
    messages: [
      { role: "user", content: userContent },
      {
        role: "assistant",
        content: firstAssistantContent,
      },
      {
        role: "user",
        content: buildFollowupContent(body, rCode, rOutput),
      },
    ],
    temperature: 0.6,
    maxTokens: MAX_TOKENS_SECOND,
    thinking: { type: "disabled" },
  });
}

function toSandboxFile(file: DataFile) {
  return { filename: file.filename, content: file.content };
}

/** A calc failure is "unrecoverable" — not worth a repair round trip — when
 *  the model's R tries to READ a data file but the student uploaded NONE. The
 *  repair loop re-prompts the same model with the same (empty) data context,
 *  so it can only re-emit code that reads the same missing file and fail
 *  identically; skipping it saves a full Gemini call + a second R run and lets
 *  the interpret pass answer from the question text instead. Deliberately
 *  scoped to the zero-uploads case: when data WAS provided, a failure may be a
 *  fixable filename typo or wrong column, so we still repair there. Ideally the
 *  model routes these to [CONCEPT] in the first place (see the missing-dataset
 *  rule in core/system-prompt.ts) — this is the server-side backstop for when
 *  it still emits [RCODE]. */
function isUnrecoverableMissingData(rCode: string, dataFiles: DataFile[]): boolean {
  if (dataFiles.length > 0) return false;
  return /\bread[._](csv|table|delim2?)\s*\(|\bread_(csv|tsv|delim|table)\s*\(|\bfread\s*\(/i.test(rCode);
}
