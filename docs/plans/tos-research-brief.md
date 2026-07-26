# Legal Research Brief — 6 parallel Sonnet subagents

**The owner's priority: his own exposure, in two capacities — (1) legally, as the operator of statshelpr, and (2) as an enrolled UT student subject to UT's Institutional Rules.** Agents 5 and 6 address these directly; Agents 1–4 address the document stack that sits underneath them. Weight your findings accordingly: a finding that changes the owner's personal exposure matters more than a drafting improvement.

Dispatch all six in parallel (read-only research; no file conflicts). Each returns findings with citations and a severity ranking. **Give each agent the SHARED CONTEXT block verbatim**, then its own section.

---

## SHARED CONTEXT (paste into every agent prompt)

You are researching the legal document stack for **statshelpr**, a paid Chrome extension. Findings must be concrete and cite `file:line`. Do not speculate about law you haven't verified — use WebSearch/WebFetch to confirm current statutes and rules, and say plainly when something is unsettled or when you're uncertain.

### The product, described accurately

statshelpr is a Chrome MV3 extension plus a landing site and an API. A student installs it, pays **$15/month on an auto-renewing subscription** through Lemon Squeezy (merchant of record; a migration to Dodo is planned at ~100 users), and receives a license key.

The extension's content script matches Canvas pages: `https://*.instructure.com/courses/*/quizzes/*`, `/assignments/*`, `/modules/*`, and `https://quizzes.next.instructure.com/*` (the New Quizzes runtime), on all frames. **This includes live graded quiz attempts** (`/quizzes/:id/take`). That was a deliberate, documented business decision, not an oversight.

The script is dormant on load. It renders nothing until the student clicks the toolbar icon for that page, and reads/transmits nothing until the student then clicks "solve" on a specific question. Activation is per-page-load. There is no background or automatic mode.

On solve: it scrapes the question stem, answer choices, and any images; POSTs to `/api/solve`; the server runs an LLM and, for calculation questions, R on a Cloud Run service; a finished answer streams back.

**How the answer reaches the page — be precise about this, it matters:**
- Radio / checkbox / dropdown: the extension **outlines** the correct choice. The student clicks it. (converted)
- Single text / numeric input: the extension renders a **chip** beside the field showing the answer. The student types it. (converted)
- **Matching and multiple-dropdowns ("blanks"): the extension still WRITES the answer into the `<select>` and fires input/change events so Canvas registers it.** This was scheduled for conversion and the owner cancelled it. It is current shipped behavior.

Do not describe the product as never entering answers. For those question types it does.

### Files

- `apps/landing/legal.html` — Terms of Service (18 sections), Privacy Policy (14), Refund Policy (6). All three in one page with tab switching.
- `apps/extension/src/` — `content.ts` (solve flow, telemetry), `canvas-dom.ts` (scraping + write-back), `popup.ts` (license, CSV data files, R export), `claim-license.ts` (license activation), `telemetry.ts` (content-free usage counters), `install-id.ts`.
- `docs/plans/2026-07-27-liability-reduction.md` — full risk analysis and decision record. Read it.

### Established, do not re-derive

- **Tex. Penal Code § 32.50** — Class C misdemeanor, fine-only, near-dead-letter. Element is "knows **or should reasonably have known**," a negligence standard, so contract language cannot reach it. Defense (e) requires conduct "solely" tutorial with no "substantial preparation."
- **UT Institutional Rules 11-402** — the owner is a UT student selling to UT students. (c)(4) prohibits *providing* aid "without authority" in conjunction with a test. UT is not a party to the ToS, so no clause binds anything between the owner and UT.
- **Config B decision (2026-07-27):** the product continues to operate on live graded attempts. This is settled. Do not recommend changing it — you are researching what documents can do, not what the product should do.
- The owner intends to operate pseudonymously ("statshelpr" as publisher/contact, no personal name public).

### The one hard limit for all six agents

**Do not propose language that describes the product inaccurately, or that is technically true but constructed to create a false impression of how it behaves.** A description engineered to mislead creates **Texas DTPA** exposure — private right of action, treble damages for a knowing violation — which is materially worse than anything it would address, and unlike § 32.50 it is a statute consumers actually use. This is a limit on *misdescription*, not on research.

Everything else is in scope, including the question of what documents and non-product measures can legitimately do about the academic-integrity and UT exposure. Prior analysis concluded they can do very little — a negligence standard doesn't yield to disclaimers, and UT is not a party to the contract. **You are not required to agree with that conclusion.** If there is a legitimate mechanism it missed, find it. Report honestly either way, including "confirmed, nothing available here," which is a useful result.

---

## AGENT 1 — Enforceability of the contract

Does this contract actually hold up?

1. **Assent.** How are the Terms currently presented and accepted? Look for whether there is affirmative assent (clickwrap) at install, at checkout, or at license activation — or only a footer link (browsewrap). Check `popup.ts`, `claim-license.ts`, `welcome.ts`, the landing page, and how the Lemon Squeezy hosted checkout is configured. **Browsewrap materially weakens arbitration enforceability.** Recommend the minimum change that establishes assent and an evidentiary record (who accepted, when, which version).
2. **§14 arbitration + class waiver.** Assess against current Texas and federal law and recent enforceability trends. Is the AAA Consumer Rules designation right? Is the 30-day opt-out helping or hurting? Is the small-claims and IP-injunction carve-out drafted correctly? Are there mass-arbitration risks worth addressing?
3. **§15 modification.** It was recently rewritten to fix an illusory-contract problem (unlimited unilateral modification can void the arbitration clause). Verify the fix is sufficient.
4. **§11 liability cap** and **§12 indemnification** — enforceable as drafted against a consumer? Flag anything likely to be struck, and whether a struck clause endangers neighbors.
5. **Missing party.** The contract names no legal entity — the owner intends pseudonymity, and no LLC or DBA exists. Analyze the consequences *for the owner*: can they compel arbitration as an unnamed counterparty? Is the cap enforceable by an unidentified party? Present the tradeoff honestly; do not assume pseudonymity must be abandoned.

## AGENT 2 — Subscription and consumer-protection compliance

**This is likely the highest-yield agent. The product auto-renews and the owner has not reviewed any of it.**

1. **Federal:** ROSCA and the FTC's negative-option/"click-to-cancel" rule as currently in force — verify current status, including any litigation or stays affecting it. Required disclosures, express informed consent, simple cancellation.
2. **State auto-renewal statutes:** California's ARL (applies to CA residents regardless of the business's location), plus New York, Florida, and any others reaching out-of-state sellers. Renewal reminders, cancellation mechanism, disclosure placement and conspicuousness.
3. **Compare requirements to what actually exists.** §8 (Payments/Auto-Renewal) and the Refund Policy in `legal.html`, plus the real cancellation path — where does a user actually cancel? Lemon Squeezy portal? Email? Is it as easy to cancel as to subscribe?
4. **Merchant-of-record allocation.** Lemon Squeezy is the seller of record. Determine what compliance obligations that shifts to LS versus what remains the owner's, and where LS's own terms impose requirements on the owner.
5. **Texas DTPA** — review all consumer-facing claims (ToS §2, the landing page, the Chrome Web Store listing at `docs/cws/listing.md`) for representations that don't match product behavior. Remember the blanks path still writes answers.

## AGENT 3 — Privacy and data

Audit the Privacy Policy against what the code actually does.

1. **Trace every data flow** in `content.ts`, `telemetry.ts`, `install-id.ts`, `claim-license.ts`, `popup.ts`: question text and images sent to `/api/solve`, images fetched with Canvas credentials, uploaded CSV data files, the install identifier, license key/email, and the content-free telemetry counters. Compare each against the Privacy Policy's 14 sections. **Report every gap in both directions** — undisclosed collection, and disclosed-but-inaccurate claims.
2. **Chrome Web Store data disclosures** — do the manifest permissions and the store listing's data-use declarations match reality? Mismatches are an enforcement trigger independent of anything else.
3. **Texas Data Privacy and Security Act** — applicability thresholds, and what changes at scale.
4. **CCPA/CPRA** if any California users; **GDPR/UK GDPR** if any EU/UK users.
5. **COPPA** — eligibility is stated as 13+. Assess exposure and whether the current gate is adequate.
6. **FERPA-adjacent** — the product processes student coursework. FERPA binds institutions, not vendors without an institutional agreement, but analyze whether anything creates such a relationship and what a university would demand if it asked.
7. **The install-id / billing-email separation.** The design deliberately keeps these in separate namespaces so no join produces a per-student activity history. Verify that holds in code, and assess its value for subpoena exposure and breach scope.

## AGENT 4 — Factual accuracy audit

Every factual claim in `legal.html` (all three policies), the landing page, and the Chrome Web Store listing, checked against the code. **This is the cheapest exposure to eliminate and the easiest to get wrong.**

For each claim, report: the claim with `file:line`, the code that implements or contradicts it with `file:line`, and a verdict of **accurate / inaccurate / unverifiable**.

Pay attention to:
- §2's description of what the Service does, and the two-step activation model — verify it against `content.ts`'s actual boot and activation logic, including whether the content script truly reads nothing before activation.
- §5's statement that the Service "never submits anything."
- §18's pointer to `/legal/archive/` — **this path does not currently exist**, which would make the clause false on deploy. Confirm and flag.
- Privacy claims about telemetry being content-free.
- Anything asserting what the Service does *not* do. Given that blanks still write answers, any such claim needs careful checking.

Flag inaccuracies as **DTPA risk**, not stylistic issues.

## AGENT 5 — The owner's personal exposure as a UT student

**Priority agent.** The owner is enrolled at UT Austin and building for a UT course (STA 301). Prior analysis flagged UT Institutional Rules 11-402 as his largest-magnitude risk. Test that conclusion rather than assuming it — it may be overstated, understated, or wrong.

Primary source: `https://deanofstudents.utexas.edu/sa/downloads/InstRulesCh11.pdf`. Read the whole chapter, not just 11-402.

1. **Jurisdictional scope — research this first, it may change everything.** Chapter 11 governs *students*. Does it reach a student's **off-campus commercial activity affecting other students' courses**, as opposed to dishonesty in the student's own coursework? Find the chapter's scope/applicability provision and read it carefully. Most of 11-402's subsections are framed around the actor's own academic work. If the rules do not reach conduct outside the actor's own coursework, the owner's UT exposure is much smaller than assumed. If they plainly do, it is confirmed. **Report which, with the governing text quoted.**
2. **11-402(c)(4)** — "providing aid or assistance to or receiving aid or assistance from another student or individual, without authority, in conjunction with a test, project, or other assignment." *Whose* test? Does the provision require the provider to be enrolled in that course, or connected to it at all? Is there interpretive guidance, published dispositions, or Dean of Students material on how it's applied to third-party providers?
3. **11-402(e) collusion** — "collaboration with another person to commit a violation of any section of the rules on academic dishonesty." Does an arm's-length commercial transaction constitute "collaboration"? Any authority either way?
4. **"Without authority" — the authorization pathway.** This is the most promising legitimate avenue and has not been explored. Could the aid be made *authorized*? Consider: instructor opt-in for specific assignments, a department or course adopting the tool, an institutional license, or a disclosed arrangement with the university. What would each actually require, has any comparable study tool done it, and does it change the analysis under (c)(4)?
5. **Precedent.** Find real cases of universities disciplining students who *built or sold* study/homework tools — at UT, elsewhere in Texas, or nationally. What happened, and what drove the outcome? If you find nothing, say so; absence of precedent is itself informative.
6. **Procedure and stakes** (subchapter 11-500): who initiates, standard of proof, hearing rights, advisor rights, sanction range, transcript notation, appeals, and any limitations period.
7. **Do documents help at all here?** Verify or refute the conclusion that ToS language cannot affect a UT proceeding, given UT is not a party.

## AGENT 6 — The owner's personal legal exposure as operator

**Priority agent.** Analyze exposure attaching to the owner personally. He currently operates as an unincorporated sole proprietor with no LLC and no DBA, intends to operate pseudonymously, and has no insurance.

1. **§ 32.50 element-by-element** against the product as actually built (including that blanks still write answers). Is a filled-in quiz answer an "academic product" under (a)(1) given the enumerated list is all substantial authored works? Does defense (e) reach any part of it? Confirm the current penalty class and check for amendments since 1999. Find any reported prosecution under this statute — prior research found none.
2. **Other Texas theories.** Is there any criminal or civil theory beyond § 32.50 reaching someone who facilitates academic dishonesty for profit — aiding/abetting, conspiracy, DTPA as applied by a *student* plaintiff, tortious interference with the student–university relationship, or unjust enrichment? Include theories a *university* might bring, not only a student.
3. **Computer-crime angles — not previously examined.** The extension writes into Canvas's DOM and, for blanks, dispatches synthetic events so Canvas registers them. Does that implicate **Tex. Penal Code § 33.02** (breach of computer security) or the **federal CFAA**? Expected answer is no — it runs in the user's own browser under the user's own authenticated session — but CFAA theories have been pressed against browser automation before, and Instructure's terms may matter. Verify properly and report your confidence.
4. **Entity and insurance.** What would an LLC actually change for each exposure identified above (criminal, civil, UT)? What does tech E&O / cyber cover and, importantly, what does it exclude — specifically whether intentional-acts exclusions would void coverage here. Is any of it worth buying at near-zero revenue?
5. **Pseudonymity, assessed honestly.** The owner intends to operate without his name public. Given Google and Lemon Squeezy both hold verified identity and both comply with lawful process, what does pseudonymity actually protect against and what does it not? Identify the realistic paths by which identity becomes known, including referral from a university to law enforcement. **Do not advise on how to strengthen concealment** — assess what the posture is worth so he can price it.
6. **Enforcing his own contract.** Can an unnamed, pseudonymous party compel arbitration, enforce the liability cap, or invoke §12 indemnification against a student? This cuts against him, not for him — analyze it.

---

## Output

Each agent returns:
1. Findings ranked Critical / Important / Minor, each with `file:line` and a concrete recommended change.
2. Anything discovered that is **out of scope but worth the owner knowing**.
3. An explicit list of what was checked and found clean — negative results matter here.
4. Anything the agent could not verify, stated as such rather than guessed.
