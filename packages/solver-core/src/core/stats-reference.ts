/** The UT Austin STA 301 default reference block — unchanged export, still the
 *  historical default any existing importer gets. `buildStatsReference` below
 *  is what buildSystemPrompt actually calls; it swaps ONLY the one course-
 *  branded line (the de Moivre jargon flag) for the "generic" course profile
 *  and returns this exact string untouched otherwise. */
export const STATS_REFERENCE = `
--- STATISTICS REFERENCE (DSGI Textbook) ---

## DATA TYPES & IMPORT
- Numerical variable: arithmetic is meaningful (height, price, test score)
- Categorical variable: arithmetic is meaningless; values are labels/groups (gender, color, yes/no)
- read.csv('file.csv', header=TRUE) — import data; do NOT open .csv in Excel first
- Unit of analysis matters: group-level correlations can contradict individual-level correlations. This reversal is SIMPSON'S PARADOX (aka ecological fallacy) — always suspect a lurking group-level variable.

## PROBABILITY (L3)
- P(A) = frequency / total (plug-in principle)
- P(A,B) = joint probability; P(A|B) = conditional = P(A,B)/P(B)
- Independence: P(A|B) = P(A) — knowing B gives no information about A
- xtabs(~var, data=df) — frequency table (single variable)
- xtabs(~var1 + var2, data=df) — two-way frequency table
- prop.table(table) — overall proportions (all cells sum to 1)
- prop.table(table, margin=1) — row proportions (each row sums to 1; condition on row var)
- prop.table(table, margin=2) — column proportions (each column sums to 1; condition on column var)
- addmargins(table) — append row/column totals

## PLOTS (L4) — ggplot2 grammar: data + geom + aes mapping
- Scatter (2 numerical): geom_point(aes(x=, y=))
- Line (sequential/time): geom_line(aes(x=, y=))
- Histogram (1 numerical distribution): geom_histogram(aes(x=), binwidth=)
- Histogram density: geom_histogram(aes(x=, y=after_stat(density)), binwidth=)
- Boxplot (distribution by group): geom_boxplot(aes(x=group, y=numerical))
- Boxplot ANATOMY: box spans Q1 to Q3 (middle 50% = IQR); the center line is the MEDIAN, NOT the mean; whiskers reach the furthest point within 1.5×IQR; dots past the whiskers are outliers. Whiskers are NOT the min/max.
- Bar (pre-computed summaries): geom_col(aes(x=, y=))
- Bar (count automatically): geom_bar(aes(x=))
- Facets: facet_wrap(~variable) or facet_wrap(~variable, nrow=N)
- Labels: labs(x='', y='', title='')
- Jitter (small dataset, discrete x): geom_jitter(aes(x=, y=), width=0.1)
- Color inside aes() only when mapped to a variable; otherwise outside aes()

## SUMMARY STATISTICS (L5)
- mean(x) — arithmetic average; sensitive to outliers
- median(x) — middle value; robust to outliers; use for skewed data
- sd(x) — standard deviation (average spread from mean)
- IQR(x) — Q75-Q25; robust spread measure; use with median when data is skewed
- quantile(x, p) — pth percentile (e.g., quantile(x, 0.25) = Q1)
- For skewed distributions: prefer median + IQR over mean + sd
- Skew moves the MEAN toward the long tail: right-skewed (tail on the right) ⇒ mean > median; left-skewed ⇒ mean < median; symmetric ⇒ mean ≈ median. The median stays in the bulk.
- Z-score: z = (x - mean) / sd; |z|>2 is unusual; |z|>3 is very unusual

## DATA WRANGLING (L6) — tidyverse pipe %>% or |>
- filter(condition) — keep rows matching condition; use == for exact match (case-sensitive)
- select(var1, var2) or select(-var_to_drop) — choose columns
- mutate(new_var = expression) — create/modify column; ifelse(cond, val_true, val_false)
- group_by(var) — split by group (use before summarize)
- summarize(stat = function(var)) — compute summaries; n() for count; sum() for total
- arrange(var) / arrange(desc(var)) — sort ascending/descending
- Mosaic shortcuts: mean(~var, data=df); mean(var~group, data=df); favstats(var~group, data=df)
- prop(~var, data=df) — proportion; diffmean(var~group, data=df) — difference of means

## LINEAR REGRESSION (L7, L14, L15)
- lm(y ~ x, data=df) — fit simple linear model
- lm(y ~ x1 + x2, data=df) — multiple regression
- lm(y ~ x1 + x2 + x1:x2, data=df) — with interaction
- coef(model) — extract intercept and slope(s)
- fitted(model) — predicted values; resid(model) — residuals (actual - predicted)
- predict(model, newdata=df) — predictions; column names in newdata must match model
- rsquared(model) — R² (mosaic); proportion of variation in y explained by model
- confint(model, level=0.95) — CI for each coefficient
- get_regression_table(model) — moderndive; columns: term, estimate, std_error, statistic, p_value, lower_ci, upper_ci
- geom_smooth(method='lm') — add regression line to ggplot
- Intercept: predicted y when all predictors = 0
- Slope (single predictor): change in predicted y for 1-unit increase in x
- Partial slope (multiple regression): change in y per unit increase in that predictor, HOLDING OTHERS CONSTANT
- Dummy variable: R creates dummies automatically for categorical predictors in lm(); baseline = alphabetically first level
- Interaction term coefficient: DIFFERENCE IN SLOPES between groups, NOT the slope itself
- Interaction statements -- read the exact wording: 'Does the interaction imply a decrease after accounting for main effects?' asks about the interaction coefficient alone -- check its CI. 'Does Y decrease for subgroup Z?' without that qualifier asks about net direction -- compute main_effect + interaction. The same regression output answers different questions depending on how the question is worded.
- Main effect of X = its effect when all other predictors are at their REFERENCE level (categorical: alphabetically first; numeric: zero).
- When a statement gives a specific CI range, identify which coefficient it belongs to by matching the numbers, then ask: is the described condition the one where that coefficient applies?
- Non-linear — exponential: lm(log(y) ~ x) → slope = growth rate
- Non-linear — power law: lm(log(y) ~ log(x)) → slope = elasticity (% change in y per 1% change in x)
- R² limitations: high R² does not guarantee good future predictions; correlation ≠ causation
- Correlation r = cor(x, y): ranges −1 to +1, UNITLESS, SYMMETRIC (r_xy = r_yx), measures LINEAR association ONLY — r ≈ 0 does NOT mean "no relationship" (a strong curve gives r ≈ 0). Simple regression: R² = r²; the slope's SIGN equals r's sign; a bigger slope does NOT mean a stronger correlation (slope has units, r does not).
- Residual standard error (sigma / RMSE) = the TYPICAL prediction error: the typical size of a residual, in y's own units. "Typical/expected model error" questions want THIS — never a coefficient CI or the point estimate. A ~95% prediction bound ≈ fit ± 2·sigma.
- Confidence interval = uncertainty about the MEAN response at x; PREDICTION interval = the range for ONE new individual observation and is ALWAYS WIDER (it adds the residual error). predict(model, newdata, interval='confidence' | 'prediction', level=0.95).
- Judge a model by OUT-OF-SAMPLE (test) error, NEVER in-sample: training RMSE is optimistically biased and ALWAYS drops when you add predictors. Overfitting = low training error but high test error.

## STATISTICAL UNCERTAINTY & CLT (L8, L11)
- Estimand: fact about world you want to learn; Estimator: statistic that estimates it
- Sampling distribution: distribution of an estimator across repeated samples
- Standard error (SE): standard deviation of the sampling distribution
- CLT: for large n, sampling distributions converge to Normal regardless of population shape
  - Means: x̄ ~ N(μ, σ/√n); use when n≥30 (rough guideline)
  - Proportions: p̂ ~ N(p, √(p(1-p)/n)); use when np≥10 AND n(1-p)≥10
  - CLT applies to: means, medians, proportions, differences, regression coefficients
- SE formulas:
  - SE(x̄) = s/√n (sample) or σ/√n (population known)
  - "De Moivre's equation" (this course's term) = SE of the MEAN = σ/√n. It is a function of n (number of data points averaged) and σ (variability of a single data point). It concerns MEANS — a CI "using de Moivre's equation" is a CI for a population mean from a sample mean, NOT a proportion.
  - SE(p̂) = √(p̂(1-p̂)/n)
  - SE(x̄₁-x̄₂) = √(s₁²/n₁ + s₂²/n₂)
  - SE(p̂₁-p̂₂) = √(p̂₁(1-p̂₁)/n₁ + p̂₂(1-p̂₂)/n₂)
- Inference is valid for: random samples, randomized experiments, future predictions (with stability assumption)
- Statistical uncertainty / margin of error captures ONLY random sampling error — it does NOT include selection bias, nonresponse, measurement error, or loaded/leading question wording. It therefore ALWAYS UNDERSTATES true real-world uncertainty; reported uncertainty is a floor, never the whole story.
- 95% CI ≈ estimate ± 2×SE (or ± 1.96×SE for large samples)

## BOOTSTRAP (L9)
- resample(df) — one bootstrap sample (same size, WITH replacement) [mosaic]
- do(n)*mean(~var, data=resample(df)) — repeat n times, store all means
- confint(bootstrap_result, level=0.95) — CI from bootstrap distribution
- Bootstrap gives empirical sampling distribution; works for means, medians, proportions, differences, regression coefs
- CORRECT CI interpretation: 'We are 95% confident the true [parameter] lies in [L, U]'
- WRONG: '95% of data falls in this interval' or '95% probability the parameter is in this range'
- "95% confidence" is a property of the PROCEDURE: over many repeated samples, ~95% of the intervals built this way contain the true parameter. Any single interval either contains the truth or it does NOT — there is no "95% probability" for one interval.
- A CI expresses the precision of the ESTIMATE (the spread of the sampling distribution), NOT the spread of the individual data values.
- Higher confidence ⇒ WIDER interval (99% is wider than 95%); you CANNOT narrow an interval without either lowering the confidence level (worse coverage) or collecting more data.
- Bootstrap fails for: min/max, extreme quantiles with small n
- Terminology: 'model estimates' = regression coefficients (slope, intercept) — bootstrap with do(n)*coef(lm(...))[...]; 'model fit statistics' = R-squared — bootstrap with do(n)*rsquared(lm(...)). When a question asks to bootstrap BOTH, generate code that bootstraps BOTH separately.
- Bootstrap slope code pattern: boot_coef <- do(5000)*coef(lm(y~x, data=resample(df))); ci_coef <- confint(boot_coef, level=0.95)
- Bounded claims use CI ENDPOINTS, not the point estimate — for ANY estimand (slope, difference of means/proportions, mean, coefficient), not just slopes: 'at least X' / 'no less than X' → the LOWER bound; 'at most X' / 'no more than X' / 'up to X' → the UPPER bound. Multiply by any stated unit change (e.g., lower slope-CI bound × 1000 for a 1000-meter question). For a decrease (negative estimate), use the magnitude (absolute value) of the relevant endpoint — a 'decrease of at most X' is the more-negative endpoint's magnitude.

## P-VALUES & HYPOTHESIS TESTING (L10, L11)
- Null hypothesis (H0): 'no effect' or 'no difference' assumption
- p-value: probability of observing data this extreme or more extreme, IF H0 were true
  - Small p-value → strong evidence AGAINST H0 (data unlikely under H0)
  - Large p-value → data consistent with H0 (not strong evidence against it)
- CORRECT: p-value measures evidence against H0
- WRONG: p-value is NOT P(H0 is true); NOT P(data occurred); NOT P(false rejection)
- Test statistic: a standardized measure of the STRENGTH OF EVIDENCE against H0 (how many standard errors the estimate sits from the null value). Larger |test statistic| → stronger evidence against H0. It is NOT a probability, and NOT the quantity compared to 0.05 — that is the p-value.
- Decision: reject H0 when p-value < α (typically 0.05); 'fail to reject' ≠ 'accept H0'
- Type I error (α): reject a true H0; Type II error (β): fail to reject a false H0
- Power = 1 − β; increases with: larger n, larger effect size, larger α
- Statistical significance ≠ practical importance; always assess effect size
- SIGNIFICANCE STRAIGHT FROM A CI: a 95% CI that EXCLUDES the null value (0 for a difference/slope/coefficient, or the stated no-effect value) ⇒ statistically significant / REJECT H0. A CI that CONTAINS the null ⇒ fail to reject / not significant. Decide significance by whether the null value is inside the interval — do not require a separate p-value.

## LARGE-SAMPLE INFERENCE IN R (L11)
- One-sample mean CI/test: t.test(~var, data=df, mu=μ₀)
  - or: t.test(df$var, mu=μ₀)
  - Default mu=0; always specify mu= for one-sample tests
  - Extract: $conf.int, $p.value, $statistic
- Two-sample means: t.test(var ~ group, data=df) [Welch, unequal variance — default in R]
  - or: t.test(x, y)
- Paired: t.test(x, y, paired=TRUE)
- One-sample proportion: prop.test(x, n, p=p0)
  - x = count of successes, n = total
  - correct=FALSE for large-sample (continuity correction OFF); correct=TRUE is the R default
  - Use correct=FALSE unless textbook/question explicitly requires continuity correction
- Two-proportion: prop.test(c(x1, x2), c(n1, n2))
  - Add correct=FALSE for large-sample z-interval
- Proportion z-TEST uses the NULL value p0 in the SE: z = (p̂ − p0) / √(p0(1−p0)/n). The proportion CI instead uses p̂ in the SE: p̂ ± z*·√(p̂(1−p̂)/n). These are DIFFERENT SEs — NEVER use p̂ in the test's SE or p0 in the CI's SE.
- confint(lm_object) — CI for all regression coefficients (uses t-distribution)
- 68-95-99.7 rule: 68% within ±1 SE, 95% within ±2 SE, >99% within ±3 SE

## EXPERIMENTS & CAUSATION (L12)
- Causal inference requires randomized experiment; observational data shows association only
- Confounder: variable that affects both treatment and outcome; creates spurious associations
- Randomization balances known AND unknown confounders
- Placebo effect: response from belief in treatment, not treatment itself
- Block design: group similar units, randomize within blocks (controls measured confounders)
- Observational → association; Experimental → causation
- Matching (MatchIt) pairs treated and control units on CONFOUNDERS ONLY (NEVER the outcome) to compare like-with-like. It removes only MEASURED confounders, so it is NOT equivalent to a randomized experiment — unmeasured confounders still remain.

## PROBABILITY MODELS (L17)
EXPECTATION & VARIANCE ALGEBRA:
  E(aX+b) = a·E(X) + b; E(X+Y) = E(X) + E(Y) ALWAYS (even if X,Y are dependent).
  Var(aX+b) = a²·Var(X) (the constant b drops out; the coefficient a is SQUARED).
  Var(X+Y) = Var(X) + Var(Y) ONLY if X,Y are INDEPENDENT. VARIANCES add — standard deviations do NOT.

BINOMIAL (discrete, count of successes):
  Required: N independent trials, binary outcome (yes/no), constant probability P
  E(X) = NP; sd(X) = √(NP(1-P))
  - dbinom(k, size=N, prob=P) — P(X = k) exactly
  - pbinom(k, size=N, prob=P) — P(X ≤ k) cumulative
  - pbinom(k, size=N, prob=P, lower.tail=FALSE) — P(X > k)

NORMAL (continuous):
  X ~ N(μ, σ) — symmetric, bell-shaped; ~68% within ±1σ, ~95% within ±2σ
  - pnorm(x, mean=μ, sd=σ) — P(X ≤ x)
  - pnorm(x, mean=μ, sd=σ, lower.tail=FALSE) — P(X > x)
  - qnorm(p, mean=μ, sd=σ) — value at pth quantile (inverse of pnorm)
  - rnorm(n, mean=μ, sd=σ) — generate n random normal values
  - dnorm(x, mean=μ, sd=σ) — density at x
  Normal applies when outcome is sum of many small independent effects (CLT)
  Normal fails for: single-stock daily returns (fat tails)

MONTE CARLO SIMULATION:
  do(10000)*{...} — repeat 10,000 times, collect results
  Histogram of results = empirical sampling distribution

## MULTIPLE REGRESSION & CONFOUNDING (L15)

PARTIAL vs. OVERALL RELATIONSHIPS:
- Partial relationship: change in y per unit increase in x, HOLDING OTHER PREDICTORS CONSTANT
- Overall relationship: change in y per unit increase in x, ignoring other variables
- These differ substantially when predictors are correlated with each other
- Confounding: a variable that affects the outcome AND correlates with a predictor creates spurious associations
- Unmeasured confounders: variables with no data, that affect outcome, and correlate with predictors → unresolvable causal confusion

WHEN OVERALL ≠ PARTIAL:
- Overall stronger than partial → confounder inflates the relationship (e.g. neighborhood confounds house size → price)
- Overall weaker than partial → confounder suppresses the relationship (e.g. SAT participation rate suppresses spending → SAT score)
- Solution: include the confounder as an additional predictor in lm()

CORRELATED PREDICTORS:
- Correlated predictors → wide confidence intervals → high uncertainty about individual coefficients
- Cannot isolate effects precisely; this is causal confusion, NOT the same as an interaction
- Interaction = relationship between x and y DEPENDS ON another variable's value (causal complexity)
- Correlation among predictors ≠ interaction

DUMMY VARIABLES & INTERACTIONS (recap):
- Categorical predictor in lm() → R creates dummies automatically; baseline = alphabetically first level
- Dummy coefficient = shift in INTERCEPT for that category; slopes remain parallel (no interaction)
- Interaction term coefficient = offset to SLOPE for non-baseline category (NOT the slope itself)
- Slope for non-baseline group = main effect coefficient + interaction coefficient
- With an interaction (numeric × categorical), the categorical MAIN-EFFECT coefficient is the group-vs-baseline difference HOLDING THE OTHER PREDICTOR CONSTANT (i.e., at the same value of the numeric predictor). It is a partial/adjusted difference — always keep the 'holding the other predictor constant' / 'at the same [X]' qualifier; the interpretation without that qualifier is incorrect.
- Visual check for interaction: plot separate trend lines per group — same slopes → no interaction; different slopes → add interaction term

SCALING:
- Divide predictors by meaningful units (e.g. miles/1000, SAT.Q/100) to make coefficients interpretable
- mutate(df, miles1K = mileage/1000) then use miles1K in lm()

EFFECT SIZE:
- eta_squared(model, partial=FALSE) from effectsize package — proportion of variance explained by each predictor
- R² = overall proportion of variance in y explained by all predictors combined

KEY WARNINGS:
- Multiple regression provides STATISTICAL control only; not the same as experimental randomization
- Omitting a confounder changes coefficient estimates; including extra variables changes standard errors
- Wide CIs with correlated predictors = data cannot distinguish individual effects, not a model error
- Always ask: what other variable could explain this relationship before interpreting any coefficient

R CODE PATTERNS:
- lm(y ~ x1 + x2, data=df) — multiple regression, two predictors
- lm(y ~ x1 + x2 + x1:x2, data=df) — with interaction
- coef(model) — extract all coefficients
- confint(model, level=0.95) — CI for all coefficients
- get_regression_table(model) — moderndive; term, estimate, std_error, statistic, p_value, lower_ci, upper_ci
- cut_number(var, 4) — split numerical variable into quartiles for stratified plotting
- str_detect(col, pattern='text') — create binary indicator from text column
- ggplot + geom_smooth(aes(color=group), method='lm') — visualize separate trend lines per group

--- END STATISTICS REFERENCE ---
`;

/** The exact STA301 line being swapped, and its "generic" replacement — pulled
 *  out as named constants (rather than inlined in the .replace() call below)
 *  so the golden test in packages/solver-core/scripts/self-test-prompt.ts can
 *  import and assert against them directly instead of re-deriving the swap by
 *  hand. Only the course-branded parenthetical changes; the SE formula and its
 *  interpretation guidance — genuinely course-agnostic content — stay intact
 *  either way. */
export const DE_MOIVRE_LINE_STA301 =
  `  - "De Moivre's equation" (this course's term) = SE of the MEAN = σ/√n. It is a function of n (number of data points averaged) and σ (variability of a single data point). It concerns MEANS — a CI "using de Moivre's equation" is a CI for a population mean from a sample mean, NOT a proportion.`;

export const DE_MOIVRE_LINE_GENERIC =
  `  - "De Moivre's equation" (a term some courses use) = SE of the MEAN = σ/√n. It is a function of n (number of data points averaged) and σ (variability of a single data point). It concerns MEANS — a CI "using de Moivre's equation" is a CI for a population mean from a sample mean, NOT a proportion.`;

/**
 * Course-profile-aware reference block. "generic" (a student outside UT Austin
 * STA 301) gets the identical reference text EXCEPT the de Moivre line's
 * "(this course's term)" flag, which wrongly implies THEIR course uses that
 * name — swapped for a course-neutral "(a term some courses use)" framing.
 * Everything else (the SE formulas, CLT guidance, every other section) is
 * genuinely course-agnostic and stays byte-identical.
 *
 * undefined/"sta301" -> STATS_REFERENCE verbatim (byte-identical to the
 * pre-course-topic prompt — see the golden test).
 */
export function buildStatsReference(courseProfile?: "generic"): string {
  if (courseProfile !== "generic") return STATS_REFERENCE;
  return STATS_REFERENCE.replace(DE_MOIVRE_LINE_STA301, DE_MOIVRE_LINE_GENERIC);
}
