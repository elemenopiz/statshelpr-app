# Legal research findings — consolidated

**Date:** 2026-07-27
**Method:** six parallel research agents (contract enforceability, subscription compliance, privacy/data, factual accuracy, UT student exposure, operator exposure) plus one implementation agent.
**Scope note:** research, not legal advice. Nobody here is licensed. UT Student Legal Services is free to enrolled students and is the right next stop for the § 32.50 and Chapter 11 questions.

Base: branch `liability-reduction`. Assent work is on `assent-gate` (commit `6453345`), unmerged.

---

## 0. Already done in this pass

| Change | Where | Status |
|---|---|---|
| Affirmative assent gate + evidentiary record | `assent-gate` `6453345` | built, verified, **not deployed** |
| Version bump 1.1.2 committed | `main` `285f390` | merged into `liability-reduction` and `assent-gate` |
| CWS listing version reference synced | `main` `39e7614` | merged |

The 1.1.2 bump had been sitting uncommitted since Jul 24 while `statshelpr-1.1.2.zip` was already packaged from it — the published artifact had no commit behind it.

---

## 1. Critical — false statements currently live

These are the cheapest exposure to eliminate and the only category where the fix is unambiguous. All are **DTPA risk** (private right of action, treble damages on a knowing violation), and two are also Chrome Web Store enforcement triggers.

### 1.1 Chrome Web Store summary describes a feature that does not exist
`apps/extension/public/manifest.json:5` — "worked solutions with runnable R code, **shown inline on your quiz questions**."

This string *is* the public, non-editable CWS title/summary (`docs/cws/listing.md:12-20`). R code is never rendered on the page — `apps/extension/src/content.ts:31-34` states it outright: "No answer card, no explanation, no R code display." R reaches the student only via the popup's "Copy R code" button (`popup.ts:892`, `popup.html:637`).

**Highest-visibility item of all findings** — it's what a buyer reads before installing. Fix: edit the manifest `description`, re-upload.

### 1.2 Store listing claims a confidence indicator that is never rendered
`docs/cws/listing.md:35` — "every answer carries a High/Med/Low confidence indicator."

`confidence`/`lowConfidence` are parsed (`content.ts:87-88,105-106`) and used **only** to build the internal telemetry beacon (`content.ts:511,621`; `telemetry.ts:38,112`). Grepped the whole extension `src/` — never rendered in any element, class, tooltip, or colour. The student never sees it.

### 1.3 Telemetry "can be disabled" — promised to Google, doesn't exist
`docs/cws/listing.md:39` (public) and `docs/cws/privacy-form.md:43` (**compliance form submitted to Google's reviewers**: "User can disable it in the popup").

`content.ts:598,608,616,837-839` only ever *reads* `telemetryDisabled` from `chrome.storage.sync`. Nothing anywhere writes it. `popup.ts` and `popup.html` don't mention telemetry at all.

Fix: **ship the toggle** rather than retract the claim — the read-side gate already works and needs only a checkbox that writes the flag. It's promised in two places, one of them a filing with Google.

### 1.4 ToS §5 "it never submits anything" is false for multi-blank questions
`apps/landing/legal.html:194`.

Contradicted by `canvas-dom.ts:620-639` (`writeBlanks`) → `setSelectValue` (`:217-230`) / `setTextInputValue` (`:322-335`), which set `.value` via the React-aware native setter **and** dispatch bubbling `input`/`change` events so Canvas registers them. Called from `content.ts:522-525` inside `onSolve()` — automatically, the instant the student clicks solve, with no further student action.

**Wider than previously understood.** `collectBlanks()`/`collectTextBlanks()` (`canvas-dom.ts:524-559`) also covers Classic `fill_in_multiple_blanks_question` (any 2+ free-text blanks), not just matching and multiple-dropdowns. `writeBlanks` writes both kinds identically.

Read together with §2, the documents tell a consumer "you always decide what goes in the field," which is false for a whole category. Fix: carve an explicit, accurate exception into §2/§5. Do **not** paper over it with language engineered to mislead — that trades a small problem for a worse one.

### 1.5 ToS §18 points at a URL that cannot exist
`legal.html:243` links `https://statshelpr.com/legal/archive/`. No such directory anywhere in the repo; `apps/landing/package.json:6` deploys via `wrangler pages deploy .`, a flat static push with **no build step that could generate it**. False on deploy, and it undermines §15's version-effective-date mechanism precisely when that mechanism would matter — a dispute over which version governed.

### 1.6 No cancellation path exists anywhere in the product
Marketed at `apps/landing/index.html:769` ("Cancel anytime from the Lemon Squeezy customer portal — one click, no phone call") and `:1042`; promised at `legal.html:205`. **None of them link to anything.** The only Lemon Squeezy URL in the entire repo is the checkout link.

The paid-user popup state (`popup.html:566-577`) shows the single word "Unlimited." The one account-looking control is "Reset license" — device reassignment (`apps/workers/src/routes/reset.ts:8-30`), not cancellation. Users hunting for cancel will click it.

**Legal status verified as of 2026-07-27:** the FTC's click-to-cancel rule was **vacated by the 8th Circuit on 2025-07-08** and is not in force. But **ROSCA was never vacated**, is federal, and independently requires cancellation as easy as signup through the same medium. Signup is one click; cancellation currently requires independently discovering LS's site.

This is **not avoided by selling only in Texas** — ROSCA is federal. (Separately: the Chrome Web Store restricts distribution by *country*, not US state, so "Texas only" is not a control that has been configured.)

Fix: real "Manage / Cancel subscription" link in the popup's `plan-paid` block, plus the same URL — not prose — in `legal.html:205` and `checkout.html`. `https://app.lemonsqueezy.com/my-orders/login` works as a floor.

---

## 2. Important

### 2.1 AAA will likely refuse to administer your arbitration clause
`legal.html:225` designates AAA Consumer Arbitration Rules. AAA's revised **Rule 12 (effective 2025-05-01)** requires businesses to register consumer clauses with the Consumer Clause Registry before AAA will administer. No evidence this was done, and the clause names AAA with **no fallback provider** — if AAA declines, the whole arbitration promise can evaporate.

Fix: (a) register — check `adr.org` directly, this could not be verified from the research environment; (b) regardless, add fallback language: *"…or, if AAA is unavailable or declines to administer, by another neutral arbitration provider selected under 9 U.S.C. § 5."* Costs nothing.

### 2.2 §12 indemnification is over-broad and not conspicuous
`legal.html:218-219`. The catch-all "any claim by a third party … resulting from **your use of the Service**" is broad enough to reach statshelpr's own negligence. Texas fair-notice doctrine (*Dresser Industries v. Page Petroleum*; *Ethyl Corp. v. Daniel Construction*) requires such scope to be both **expressly stated and conspicuous** — and nothing in `legal.html` is visually distinguished at all.

Fix: narrow to "resulting from your **breach of these Terms or misuse** of the Service," and bold the lead-in.

### 2.3 The shared hash space between licences and metrics
`apps/workers/src/lib/license-activation.ts:278-286` and `apps/workers/src/lib/rate-limit.ts:73-80` use a **byte-identical** unsalted `sha256(x).slice(0,32)`. So `activation:{sha256(licenseKey)}:{sha256(installId)}` (400-day TTL) shares a hash space with the metrics `installHashes` sets. Anyone holding a raw licence key — obtainable from the `license:` record, which carries the email — can compute the matching install hash and confirm which days that paying student was active.

Bounded: `metrics-store.ts:168-173` `installHashes` is a per-day **presence set** only, never a per-hash event log. Worst case is "active on these dates," not an activity trail.

Fix: give `license-activation.ts`'s hash its own HMAC secret, distinct from `hashBucket`. One-line-ish, closes it entirely.

### 2.4 Privacy Policy overstates what Gemini receives from CSV uploads
`legal.html:269` says the AI "can reference your data." In fact `apps/workers/src/routes/solve.ts:129-133` → `summarizeCsv` (`lib/data-summary.ts:8-28`) sends Gemini **only column statistics** (mean/median/sd/min/max/categorical counts). Raw rows go only to the Cloud Run R runner (`lib/r-runner.ts:84-106`), already named in the policy. Wrong in the owner's favour, but still wrong.

### 2.5 ToS §2 describes a web tool that doesn't exist
`legal.html:181` — "a Chrome extension **and web tool**… or accept a problem **you enter yourself**." No consumer-usable manual-entry surface exists anywhere: no form in `apps/landing`, `apps/api/app/page.tsx` is a bare dev stub, and `apps/extension-capture` is explicitly dev-only and undistributed (`apps/extension-capture/README.md:1-9`).

### 2.6 Dangling cross-reference
`legal.html:272,275` — Privacy §8/§9 point to the single-device limit "described in our Terms… in item 9." ToS §7 (`legal.html:201-202`) never states the one-active-device rule, though the rule is real and enforced (`activate.ts`, `content.ts` 403/`atLimit`, `popup.ts:564-640`).

### 2.7 State auto-renewal statutes (deprioritised, but not zero)
CA ARL annual reminder (AB 2863, eff. 2025-07-01, applies to **all** subscription cadences), NY GBL §527-a post-transaction acknowledgment (eff. 2025-11-05), FL §501.165. These key on **consumer residence**, not seller location. UT Austin enrols a large out-of-state cohort, so "no CA/NY customers" is an expectation, not a control.

No email-scheduling infrastructure exists at all (`apps/workers/src` has only webhook-triggered transactional sends), which also means §15's promised 30-day change notice has nothing to deliver it.

---

## 3. Minor

- `legal.html:183` §2 "reads … nothing until you request a solution" slightly overstates: activation runs `scanAndInject()` → `findStem()` (`canvas-dom.ts:810-816`), reading `innerText` off candidate containers to place buttons. Nothing transmitted, no answer content extracted. Fix: "doesn't read or transmit your quiz **content**."
- `content.ts:18-25` header doc describes write-back as universally suggestion-only, though the same file calls `writeBlanks` at `:524`. `canvas-dom.ts:12-13` gets it right. Not user-facing, but future copy drafted off the wrong file would inherit the error.
- `canvas-dom.ts:212-216,315-321` carry "SCHEDULED FOR REMOVAL (Task 5)" comments — stale since that conversion was cancelled. The code reads as a pending fix.
- Data files are sent on every solve when present, even for concept questions that never use them (`content.ts:425,446`). Disclosed, so not a gap — a minimisation opportunity.

---

## 4. Owner decisions — not code

### 4.1 The Gemini API tier (answer this first; it's binary and material)
Google's current terms: on the **paid** API, prompts are retained 7–55 days for abuse detection and not trained on. On the **free AI Studio quota, Google uses submitted content to improve its products.** `wrangler.toml` only shows `GEMINI_API_KEY` comes from `wrangler secret put` — the tier is not discoverable from code.

If that key is unbilled, every student's quiz content is Google training data and Privacy Policy items 5/11 are materially incomplete. **Check the Google Cloud console.**

### 4.2 Pseudonymity and enforceability are mutually exclusive
Google and Lemon Squeezy both hold verified identity and disclose on ordinary subpoena. **TRCP 28** permits filing under an assumed name but lets any party *or the court sua sponte* compel substitution of the true name. So compelling arbitration, enforcing the §11 cap, or invoking §12 all require the disclosure pseudonymity exists to prevent.

Separately, **Tex. Bus. & Com. Code § 71.201** bars *maintaining* suit on a contract made under an unfiled assumed name until the DBA is filed — curable at any time, so delay-and-cost, not fatal.

The likeliest deanonymisation path is not legal process. It is the campus social graph: a UT student selling to UT students in one required course.

### 4.3 LLC: little value at any scale, for a specific reason
Tex. Bus. Orgs. Code § 101.114 shields members from the **entity's** obligations, not from liability for **their own tortious conduct** committed through the entity. The owner personally writes the code and makes the representations, so DTPA/misrepresentation/negligence claims get pleaded as his own conduct. Zero effect on § 32.50 (criminal liability is always personal) or UT Chapter 11. Narrow real benefit: vendor/contract disputes not involving his own wrongdoing.

### 4.4 Insurance: do not buy at current scale
Tech E&O/cyber policies carry standard intentional-acts and criminal-acts exclusions that would void coverage for exactly the core risk. What they *would* cover — "the answer was wrong, I lost credit" — is already capped at ~$15 by the ToS. ~$800–1,300/yr. Revisit only if an institutional counterparty requires proof of insurance.

### 4.5 DTPA cannot be waived
Tex. Bus. & Com. Code § 17.42 makes waivers void unless the consumer had independent counsel — no $15/mo subscriber ever will. Arbitration of a DTPA claim is **not** a prohibited waiver and remains enforceable, so §14 keeps its procedural value. Whether the dollar cap survives DTPA treble damages is unresolved — **put this specifically in the attorney-review scope**, not just "general enforceability."

---

## 5. UT Chapter 11 — prior analysis was working from a dead document

**The source was stale.** `deanofstudents.utexas.edu/sa/downloads/InstRulesCh11.pdf` serves a **2013 snapshot**. Current in-force text is at `catalog.utexas.edu/general-information/appendices/appendix-c/student-conduct-and-academic-integrity/`, rewritten **effective 2025-09-01**. The section numbers the prior analysis relies on (`11-402(c)(4)`, `11-402(e)`) no longer exist.

New mapping: academic misconduct = **Sec. 11-401**; behavioural misconduct = **Sec. 11-402**; jurisdiction = **Sec. 11-102**.

The rewrite made exposure **broader**, not narrower — the opposite of what the jurisdictional question was testing for:

- **Sec. 11-102** expressly reaches off-campus conduct that "substantially affects a person's education … with the University." Aid delivered into a UT-run Canvas quiz clears this on either reading.
- **Sec. 11-401** unauthorised aid — "providing aid or assistance to … another individual or source without authorization, and pertaining to an academic assignment or course requirement" — has **no enrolment nexus**. Being outside STA 301 is not a defence. Giver and receiver independently chargeable.
- **Sec. 11-402** makes "any behavior that may violate any federal, state, or local law" a violation, importing § 32.50 into a UT proceeding at **preponderance**, with no prosecution required. Possibly UT's easier route.
- **Collusion was narrowed** to "unauthorized collaboration with another *student*" and no longer plainly reaches an arm's-length sale. Good news, but moot — 11-401 reaches directly.
- **Procedure:** preponderance standard; advisor is non-advocate only; sanctions to expulsion with **permanent transcript notation**; appeal limited to three grounds (procedural error, new information, disproportionate sanction) — not disagreement with the finding; **no binding limitations period**; Sec. 11-300 keeps a former student subject to discipline after leaving.

**Adverse precedent exists.** Columbia, Feb–Mar 2025: Roy Lee, creator of Interview Coder, found in violation for *creating the tool*, on a **weaker** fact pattern — it targeted third-party job interviews, not Columbia coursework. Probation for the tool; the separate one-year suspension was for leaking hearing recordings. statshelpr is built and marketed for the owner's own university's Canvas quizzes.

**Marketing copy is evidence.** Columbia reasoned from how the tool was designed and marketed. Precise product descriptions are ammunition in a Chapter 11 proceeding, not protection. Documents cannot help here — UT is not a party and Chapter 11 is not a contract proceeding.

**The authorisation pathway is real in the rule's text** ("without authorization") and unreachable in practice: instructor, department, or institutional sign-off would cure it, but obtaining it requires disclosing that the tool operates on live graded attempts.

---

## 6. § 32.50 and other operator theories

- **The blanks pathway is where the position degrades.** Defence (e) requires conduct consisting **solely** of tutorial assistance without substantial preparation. For outline-only and chip-only questions the student performs the act that produces the submission — a real, arguable fit. For blanks, the software completes the requirement without further student action. **(e) very likely does not reach it.** This is the direct legal cost of the cancelled Task 5.
- **"Academic product" is genuinely unresolved.** Every enumerated item in (a)(1) is a substantial authored work; *ejusdem generis* may exclude a dropdown selection. No court has construed it — analysis, not settled law.
- **No reported prosecution, ever.** No substantive amendment since 1997. Class C, fine-only, no jail.
- **CFAA: clean, high confidence.** *Van Buren v. United States*, 593 U.S. 374 (2021) — client-side, user's own authenticated session, no off-limits area. *hiQ* distinguishes: hiQ created accounts bound by the terms; statshelpr creates none.
- **Tex. Penal Code § 33.02: clean.** Session-authorised access only.
- **University civil claims: no footing.** No precedent for tortious interference or unjust enrichment; UT has no cognisable unjust-enrichment claim since money flows student → statshelpr, not university → statshelpr.
- **Instructure's AUP** binds the *student*, not statshelpr — no privity, no account. A tortious-interference theory against the developer is available in theory, unprecedented in practice.

---

## 7. Confirmed clean — negative results

- **ToS §15 modification fix is sufficient.** Tracks *In re 24R, Inc.* (Tex. 2014): prospective-only, 30-day notice, cancel-before-effective-date right.
- §14 carve-outs are **bilateral** ("either party may") — avoids the one-sided-carve-out unconscionability problem.
- §11 cap uses a savings clause rather than an absolute cap — won't read as an attempted DTPA waiver.
- Severability (§17 + §14's internal clause) is drafted so a struck clause doesn't endanger neighbours.
- **Canvas session never leaves the browser.** `canvas-dom.ts:866-889` fetches images with `credentials:"include"` but forwards only image bytes; the cookie is never read, stored, or transmitted.
- **Telemetry really is content-free**, verified on both ends (`telemetry.ts`, `apps/workers/src/routes/telemetry.ts`).
- **No server-side logging of request bodies** — only two `console.log` calls in `apps/workers/src`, both operational. No Sentry/Datadog/Logpush.
- **Manifest permissions match actual usage** — no unused or undisclosed permission.
- Privacy §7 file limits, §8 install-id, §9 licence key all match code exactly. §8's sync-storage disclosure is unusually candid and accurate.
- Free-tier 5/day and $15/mo consistent across code, ToS, and listing.
- ROSCA pre-billing disclosure on `checkout.html:197,206` is adequate; card handling correctly delegated and accurately described.

---

## 8. Could not be verified by research — owner action required

1. **Gemini API billing tier** (§4.1) — Google Cloud console.
2. **AAA Consumer Clause Registry registration** (§2.1) — `adr.org`.
3. **Lemon Squeezy receipt/renewal email content** — `docs.lemonsqueezy.com` blocks automated fetches; check the dashboard's receipt-email settings.
4. **Whether LS's seller agreement** (already accepted, not public) obligates surfacing a cancellation path on statshelpr's own site.
5. **Whether the Travis County DBA has been filed.**
6. **Whether `/api/solve` bodies are captured by platform-level logging** (Cloudflare) invisibly from source. The policy hedges ("may be logged"), so not false either way.
7. **Cloudflare edge-log retention of raw client IPs** — the Worker stores only a hashed bucket.
8. **Whether the 1.1.2 zip's contents match committed source** — it was packaged 2026-07-24 from a then-dirty tree.

---

## 9. Assent gate — residual items before deploy

Built on `assent-gate` (`6453345`), verified, **not deployed**.

- **Blocking: the Privacy Policy does not disclose the assent record.** It stores install id ↔ timestamp ↔ truncated user-agent ↔ two-letter country for **seven years** (justified against Texas's 4-year contract limitations period plus tolling). Item 8 (`legal.html:271`) covers the install id going to LS; item 13 describes retention only generally. Neither covers this. Shipping without a matching disclosure recreates exactly the inconsistency this pass set out to remove.
- The record adds a **deliberate join edge** — that's its evidentiary function. An LS order (carrying billing email) can be walked to a timestamped browser fingerprint for that install, for seven years. Longer-lived than anything else keyed on install id (`claim:` is 48h). Shortening the TTL is a one-line change.
- **New single point of failure:** `statshelpr.com/checkout` is now the only door to Lemon Squeezy. If Pages is down, nobody can buy.
- **Untested against live LS:** the second `checkout[custom][assent_id]` field for extension-less web visitors. Deleting two lines removes that surface at the cost of web-visitor joinability.
- A label-activation bug was found and fixed in verification: clicking "Terms of Service" inside the label ticked the checkbox in Chromium, manufacturing an "agreed" state for someone who only went to read. Fixed at `checkout.html:270-280`.
- **Recommended, not implemented:** a machine-readable `<meta name="tos-version">` in `legal.html`. The version currently lives in prose and is duplicated in two constants that can silently drift.
