import { buildStatsReference } from "./stats-reference";
import { TOPICS } from "./topics";

/** Which course-content profile to build the prompt for. undefined (the
 *  default, matching every request before this option existed) = UT Austin
 *  STA 301 — this app's original/home course. "generic" = a course-neutral
 *  swap of ONLY the STA-301-specific blocks (see buildRoutingRules and
 *  stats-reference.ts's buildStatsReference); everything else in the prompt
 *  is shared verbatim across both profiles. */
export type CourseProfile = "generic";

/**
 * Sanitize a user-supplied R package list before it goes into the system
 * prompt. The list originates in the extension's library picker (untrusted
 * free text), so we keep only syntactically plausible R package tokens
 * (letters/digits/dots, starting with a letter — R names are case-sensitive),
 * dedupe, and cap the count. This is defense-in-depth against prompt injection
 * via a crafted "package name" — the picker validates too, but the server must
 * not trust that.
 */
function sanitizePackageNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = typeof raw === "string" ? raw.trim() : "";
    if (!/^[A-Za-z][A-Za-z0-9.]*$/.test(name) || name.length > 64) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= 40) break;
  }
  return out;
}

/**
 * The [RCODE] package-priority directive, dynamic from the picker selection:
 *   - undefined  → historical default wording (old clients + evals unaffected)
 *   - []         → base R only (the user deliberately cleared every package)
 *   - [a, b, …]  → "prioritize <a>, <b>, and base R"
 */
function rcodePackageDirective(rPackages?: readonly string[]): string {
  if (rPackages === undefined) {
    return "For [RCODE], prioritize tidyverse, mosaic, moderndive, and base R — use whichever is most appropriate.";
  }
  const clean = sanitizePackageNames(rPackages);
  if (clean.length === 0) {
    return "For [RCODE], prioritize base R — use whichever base function is most appropriate.";
  }
  return `For [RCODE], prioritize ${clean.join(", ")}, and base R — use whichever is most appropriate.`;
}

/**
 * STA301's answer-key convention for sampling-distribution select-alls — see
 * GENERIC_SAMPLING_DISTRIBUTION_LINE below for the course-neutral replacement
 * used when courseProfile is "generic". Kept as its own named constant (not
 * inlined in the array below) so the golden test in
 * packages/solver-core/scripts/self-test-prompt.ts can assert against it by
 * reference instead of duplicating the literal string.
 */
export const STA301_SAMPLING_DISTRIBUTION_LINE =
  "Course convention for sampling-distribution select-alls: when a select-all question asks which statistics or estimators generally have approximately normal (unimodal and symmetric) sampling distributions, treat ALL standard summary estimators as approximately normal — means, medians, proportions, differences of means or proportions, regression coefficients, standard deviations, interquartile ranges, and regression model fit statistics — and select EVERY listed option of these kinds. Do not exclude medians, standard deviations, or IQRs on advanced asymptotic-theory grounds; this course's answer keys count them all as approximately normal.";

/**
 * Course-neutral replacement for STA301_SAMPLING_DISTRIBUTION_LINE. Standard
 * asymptotic theory, not any one course's answer-key convention: the CLT
 * guarantees an approximately normal sampling distribution (for large n) for
 * means, proportions, differences of means/proportions, and regression
 * coefficients. Medians, standard deviations, and IQRs are deliberately left
 * OUT of that guarantee — their sampling distributions depend on the shape of
 * the underlying population (skew, kurtosis, tail weight) and generally need
 * stronger conditions or larger samples than the mean does, so a generic
 * course should not get credit for assuming them normal by default.
 */
export const GENERIC_SAMPLING_DISTRIBUTION_LINE =
  "Sampling-distribution select-alls: when a select-all question asks which statistics or estimators generally have approximately normal (unimodal and symmetric) sampling distributions for large n, apply standard asymptotic theory. Means, proportions, differences of means or proportions, and regression coefficients are approximately normal for large n by the Central Limit Theorem / standard asymptotic theory — select these. Medians, standard deviations, and interquartile ranges are NOT generally guaranteed to be approximately normal — their sampling distributions depend on the shape of the underlying population and typically need stronger conditions or larger samples than the mean does — do not select these unless the question gives a specific reason to.";

/**
 * TOPIC output-line instruction, shared verbatim by both course profiles.
 * Built from solver-core's TOPICS taxonomy (topics.ts) so the prompt's listed
 * tokens and parse-response.ts's accepted tokens can never drift apart.
 *
 * PINNED MODEL-OUTPUT-CONTRACT CHANGE: adding this line means every future
 * response carries one more trailing line the model must produce. Gated on a
 * post-funding eval re-run before deploy (scripts/run-evals.ts against the
 * cleaned eval set — denominators 130/85/48 — excluding the 23 known-leaky
 * matching-question fixtures) — see the buildSystemPrompt call site's comment
 * and packages/solver-core/scripts/self-test-prompt.ts's golden test.
 */
export const TOPIC_INSTRUCTION_LINE =
  `After the CONFIDENCE line, append one more line: TOPIC: <topic>, where <topic> is exactly one lowercase token from this fixed list: ${TOPICS.join(", ")}. Pick the single closest match to what the question is actually testing. Use "non_stats" when the question has no statistics/data-analysis content at all, and "other" only when genuinely none of the listed topics fit.`;

/** The QUICK_REFERENCE reinforcement bullet for the same TOPIC contract —
 *  exported so the golden test can reconstruct the expected QUICK_REFERENCE
 *  block without re-typing the literal string a second time. */
export const TOPIC_QUICK_REFERENCE_LINE =
  "7. TOPIC line goes after CONFIDENCE, on its own line: exactly one token from the fixed topic list above.";

function buildRoutingRules(rPackages?: readonly string[], courseProfile?: CourseProfile): string[] {
  return [
  "Your first non-empty line must be exactly one routing tag: [CONCEPT] or [RCODE].",
  "Use [CONCEPT] for multiple choice, true/false, dropdown, definitions, interpretation, or explanation questions.",
  "Use [RCODE] when the answer requires any computation, statistical test, plotting, data wrangling, or code.",
  "A question may NAME a dataset (e.g. 'the data frame in scooby.csv', 'the survey data') that is NOT actually available to you. Choose [RCODE] only when the data you would compute on is present in your R ENVIRONMENT CONTEXT, OR when the question itself supplies every number you need inline. If a question refers to a dataset that is absent from your environment context, you cannot run code on it — choose [CONCEPT] and answer with statistical reasoning (for example, infer a distribution's likely shape/skew, center, or spread from what the variable measures and how such data typically behaves).",
  "Questions of the form 'the distribution of X is best described as…' (skewed left/right, symmetric, bimodal, uniform) are [CONCEPT] whenever the underlying data is not available to compute on — reason from what X measures (e.g. durations, counts, and incomes are usually right-skewed; bounded percentages near a ceiling are left-skewed).",
  "If [CONCEPT], internally reason in a structured way before finalizing and keep that reasoning private.",
  "Before finalizing any [CONCEPT] answer, silently reason through the strongest argument for each alternative option and confirm why your chosen answer is still correct.",
  "For [CONCEPT], never reveal your analysis, option-by-option reasoning, or hidden scratch work. Output only the final answer line and confidence line unless the question explicitly asks for an explanation.",
  "For TRUE/FALSE and Yes/No questions: internally identify every absolute qualifier word (every, all, always, only, never, none) and test whether a single counterexample exists. Only claim TRUE/Yes if no counterexample can be found.",
  "If [CONCEPT], return exactly:",
  "Answer: <best answer>",
  "CONFIDENCE: <High/Med/Low>",
  "If [RCODE], return complete runnable R code only after the tag.",
  "For [RCODE], do not include markdown fences, response banners, or question restatement.",
  "For [RCODE], every line after the tag must be valid R code, an R comment, or a blank line.",
  "For [RCODE], the first line must be an R comment: # PLAN: <test or function>, <column(s)>, <key arguments>. Example: # PLAN: prop.test, smoker (yes), n=total, correct=TRUE. State the plan explicitly before writing any code.",
  "For [RCODE], do not output bare prose labels like 'Final answer:' outside R syntax.",
  rcodePackageDirective(rPackages),
  "For [RCODE], avoid creating plots or graphics. The sandbox returns text output, so answer graph-style questions by printing numerical summaries that support the visual conclusion: counts, proportions, mean, median, sd, min/max, quartiles, skew direction, group summaries, correlations, slopes, or model tables as appropriate.",
  "If a question asks what a plot would show, compute and print the values needed to infer it instead of calling ggplot(), plot(), hist(), boxplot(), or ggsave().",
  "For inference, consult the statistics reference for exact function signatures and argument defaults.",
  "When selecting which category of a column to count, reason carefully from the question wording — do not assume 'yes' always means the event of interest. Use the counts in the data context to inform your choice.",
  "Use exact dataframe/column/value names from provided environment context when relevant.",
  "Ignore provided data context when it is not relevant to the question.",
  "Never hardcode dataset-derived statistics or results; always compute from data in code.",
  "After calculations, print one unambiguous final answer line as: Final answer: ...",
  "When the question asks which of several numbered or lettered statements are true, evaluate each statement as a named logical variable (s1 <- ..., s2 <- ...) derived from computed values — never hardcode TRUE/FALSE. Then build the answer string programmatically: true_stmts <- which(c(s1, s2, s3)); answer <- if(length(true_stmts)==0) 'None of the above' else if(length(true_stmts)==length(c(s1,s2,s3))) 'All of the above' else paste(true_stmts, collapse=' and '). Print each statement result and end with cat('Final answer:', answer, '\\n').",
  "When checking whether a difference (diff_prop, diffmean, slope, etc.) is 'approximately X%' or 'approximately X', always check the magnitude: abs(abs(diff) - X) < tolerance. NEVER use abs(diff - X) — this fails when the difference is negative due to arbitrary subtraction order. Example: abs(abs(diff_prop) - 0.04) < 0.03 correctly catches both +3.8% and -3.8% as 'approximately 4%'.",
  "When reporting direction (increase/decrease) for a computed value, always derive the label from the sign: direction <- if(value > 0) 'an increase' else 'a decrease'. Report abs(value) for the magnitude. Never hardcode 'an increase' when the computed value could be negative (e.g., net interaction effects: main_effect + interaction_coef may be negative even if the main effect alone is positive).",
  "Avoid verbose intermediate output unless explicitly requested.",
  "If required data is missing, add a short comment at top explaining what is missing.",
  courseProfile === "generic" ? GENERIC_SAMPLING_DISTRIBUTION_LINE : STA301_SAMPLING_DISTRIBUTION_LINE,
  "After your answer (whether [CONCEPT] or [RCODE]), append on a new line: CONFIDENCE: High, CONFIDENCE: Med, or CONFIDENCE: Low. Use Low only when genuinely uncertain or the question is ambiguous.",
  TOPIC_INSTRUCTION_LINE,
  ];
}

/**
 * Regression-table interpretation guidance. SCOPED by its own opening clause so
 * it only bites on "which interpretation is accurate?" questions that show a
 * regression table — it is inert on every other question type, which is the
 * main reason it can't backfire broadly.
 *
 * Why it exists: on an interaction model, the vision model (gemini-3.6-flash)
 * over-reasoned a MAIN-effect interpretation — it rejected a statement that
 * correctly described the FarAway coefficient's own CI (20-75 ms) purely
 * because the interaction terms make the combined effect differ by scene, and
 * so answered "1 and 2 only" instead of the key's "all of the above". flash-lite
 * (text) got it right; adding this guidance flips 3.6-flash to the correct
 * answer in a single pass (POC verified). See the session's regression-eval.
 *
 * Two-sided on purpose: it defuses ONLY the "differs at non-reference levels"
 * objection, and still tells the model to reject a statement that misstates the
 * row's value/sign/interval — so it doesn't turn into a blanket "accept every
 * interpretation" rule. Eval-gated against target + backfire-candidate fixtures
 * before shipping.
 *
 * v3 (2026-07-23): v1 was validated only single-run on the variant whose
 * statement referenced a specific level ("SceneLetter: a"); the sibling wording
 * "when comparing the same scene letter" failed 2/3 runs on 3.6-flash. v2 added
 * the "comparing the same X / holding X constant" defusal (target went 3/3) but
 * the scene-a variant then failed 0/2 — the model's objection there is
 * different: the named level doesn't exist in the data, so it called the
 * statement meaningless. v3 adds the no-interaction-row clause: a level with no
 * interaction row (reference level, or absent from the data) gets no
 * adjustment, so the main-effect row alone IS its effect — which is also just
 * correct model arithmetic, not only a course convention. Both clauses keep the
 * two-sided guard, and the subgroup-Z distinction (quick-reference rule 5)
 * stays intact for levels that DO have an interaction row. Validated multi-run
 * per wording + backfire set (stochastic family — single-run validation is
 * what let v1 ship half-covered).
 */
const REGRESSION_INTERPRETATION =
  "When a regression table (columns like term, estimate, lower_ci, upper_ci) is shown and the question asks which interpretation(s) are accurate, judge each statement against the specific coefficient row it refers to: its stated direction, rough magnitude, and interval should match that row, and an interval that excludes 0 supports a 'with 95% confidence' claim in that direction. A statement that correctly describes a coefficient's own interval is accurate even for a MAIN-effect coefficient in a model with interactions — that coefficient is the effect at the reference level — so do not call it inaccurate merely because the interaction terms make the combined effect differ for other categories. The same applies when such a statement pins the comparison within a category of the interacting variable: phrasings like 'when comparing the same <other variable>' or 'holding <other variable> constant' describe the main-effect coefficient's own row (the holding-others-fixed reading), and a statement naming a specific category that has NO interaction row in the table (the reference level, or a level not present in the data) also reduces to the main-effect row alone, since no interaction adjustment applies to it. In all of these cases judge the statement against that coefficient row's estimate and interval, and do not reject it because interaction terms change the effect at OTHER category levels, and do not reject it because the named category is the reference or absent from the data. (This is distinct from 'does Y change for subgroup Z?' when Z HAS an interaction row — there, combine main + interaction. A statement is still inaccurate if it misstates the row's value, sign, or interval.)";

const QUICK_REFERENCE = [
  "=== QUICK REFERENCE (re-read before answering) ===",
  "1. First non-empty line MUST be [CONCEPT] or [RCODE] — nothing else before it.",
  "2. [CONCEPT] output: Answer: <answer>  CONFIDENCE: <High/Med/Low>",
  "3. [RCODE] output: code only. First line must be # PLAN: comment. Last substantive line: cat('Final answer:', ...)",
  "4. If question asks which numbered/lettered statements are true: evaluate each independently, print TRUE/FALSE for each, then Final answer: [choice].",
  "5. Interaction wording matters: 'decrease after accounting for main effects' = check interaction CI alone. 'Does Y decrease for subgroup Z?' = check main + interaction total. Same table, different calculations depending on exact wording.",
  "6. CONFIDENCE line goes after the answer on its own line. Low confidence prints a warning.",
  TOPIC_QUICK_REFERENCE_LINE,
  "===",
].join("\n");

export interface SystemPromptOptions {
  dataContext?: string;
  imageMode?: boolean;
  /** The question is a matching / multiple-dropdowns question whose blanks are
   * all provided as text (see buildQuestionPrompt). Suppresses the image-mode
   * "answer only the open dropdown" guidance, which would otherwise tell the
   * model to leave the other blanks blank. */
  hasBlanks?: boolean;
  /** R packages the user selected in the extension's library picker, steering
   * the [RCODE] package-priority directive. Undefined (old clients / evals)
   * keeps the historical default wording; [] means base R only. */
  rPackages?: readonly string[];
  /** undefined (old clients / evals) or "sta301" -> UT Austin STA 301's
   *  historical prompt content, byte-identical to before this option existed
   *  (see the golden test). "generic" swaps ONLY the STA-301-specific blocks
   *  for course-neutral guidance — see CourseProfile's doc comment above. */
  courseProfile?: CourseProfile;
}

export function buildSystemPrompt({
  dataContext = "",
  imageMode = false,
  hasBlanks = false,
  rPackages,
  courseProfile,
}: SystemPromptOptions = {}): string {
  const roleLines: string[] = [
    "You are a statistics quiz assistant.",
    imageMode
      ? "You are answering from an uploaded image."
      : "You are answering a text question.",
    "Keep the final answer concise and accurate.",
    "Do not refer to yourself by name or as an AI assistant.",
    "If you cannot confidently determine the answer, say you are not confident instead of guessing.",
    "Pay close attention to qualifier words like 'every', 'all', 'always', 'only', 'never', 'none' in TRUE/FALSE and yes/no questions — these change which options are correct. For 'select all that apply' questions, do not be overly conservative; include all options that are generally or approximately true.",
  ];

  // When every blank is supplied as text (hasBlanks), the model must answer all
  // of them — so we drop the image-only "focus on the open dropdown" rule.
  // Wording stays generic across dropdown blanks (matching / multiple-dropdowns,
  // each listed with its own options line) and free-text blanks (Classic
  // fill_in_multiple_blanks_question, no options line) — buildQuestionPrompt's
  // buildBlanksPrompt spells out the per-blank format either way.
  const imageOnlyLines: string[] = hasBlanks
    ? ["This question has multiple blanks. Answer EVERY blank — give one answer per blank in order, using its listed options if any are given."]
    : imageMode
      ? [
          "If the question text says 'Select TRUE or FALSE' or 'Select Yes or No' for each option, you MUST answer every blank in the question — do not answer only the open dropdown. List your answer for each statement in order.",
          "If the image shows a dropdown currently open with visible options but the question does NOT use TRUE/FALSE or Yes/No for all blanks, focus ONLY on the open dropdown and answer that one blank. Do not attempt to answer closed '[Select]' or '[Choose]' dropdowns.",
        ]
      : [];

  const parts: string[] = [
    ...roleLines,
    ...imageOnlyLines,
    ...buildRoutingRules(rPackages, courseProfile),
    REGRESSION_INTERPRETATION,
    buildStatsReference(courseProfile),
  ];

  if (dataContext.trim()) {
    parts.push("", dataContext.trim());
  }

  parts.push("", QUICK_REFERENCE);

  return parts.join("\n");
}
