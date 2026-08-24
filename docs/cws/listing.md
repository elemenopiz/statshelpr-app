# Chrome Web Store listing — statshelpr

## Name
**statshelpr — stats quiz tutor**
(alt, shortest form: `statshelpr`)

NOTE: "Canvas" is deliberately NOT in the name or summary — it's a registered
trademark of Instructure, and putting it in listing metadata is the most common
trademark/impersonation rejection. It appears ONLY in the description body as
descriptive ("works on Canvas quiz pages"), which is accepted nominative use.

## Summary (max 132 chars) — NOT a pasteable field
The store title AND summary are pulled READ-ONLY "from package" (the manifest
`name` and `description`) — the listing form has no editable summary box. So the
public summary IS the manifest description. As of v1.1.5 that is:
> Stats quiz tutor — fills in the answer on your quiz questions, with the R code behind it in the extension popup.

It must describe only what the extension actually does: it WRITES the answer
into the page — it checks the radio/checkbox, sets the dropdown, and fills the
text field (see selectChoice / setSelectValue / fillTextInput in canvas-dom.ts),
downgrading to a highlight-only mark when the field is disabled or read-only.
It does not submit the quiz. The R code is reachable ONLY via the popup's "Copy
R code for this quiz" button. The content script renders no answer card, no
explanation and no R code, so the summary must not claim anything is "shown
inline".

Do NOT reword this to "suggests" or "marks" — a suggestion-only build was
written and deliberately not shipped, and that wording is false for what ships.
Any claim about entering answers must be checked against canvas-dom.ts.
To change the summary, edit `apps/extension/public/manifest.json` `description`
and re-upload — do NOT expect a summary field in the dashboard. ("Canvas" is
kept out of it for the trademark reason; it lives only in the long Description
body below.)

## Category / language
Education · English

## Full description

statshelpr adds a solve button to statistics questions on Canvas quiz pages. Click it and you get a worked solution: the answer and, for calculation questions, the exact R code that produces the result — executed on a real R runtime on our servers. statshelpr enters its answer into the question for you; review it before you submit. It never submits a quiz for you.

Built for intro statistics courses (inference, regression, confidence intervals, probability), statshelpr turns quiz questions into worked examples:

- **See the R behind the answer** — every calculation shows runnable code using the libraries your course teaches (tidyverse, mosaic, moderndive, infer).
- **Use your course data** — upload the CSV your class provides and solutions are computed on your actual dataset, not a lookalike.
- **Review where you went wrong** — open a graded quiz and step through the solution for each question you missed.
- **Pick your libraries** — tell statshelpr which R packages your course uses and solutions follow that style.

Free plan: 7 solves per day. Unlimited: $11.99/month.

Privacy: question content is sent to our servers only when you click solve, and used only to generate the answer. Usage telemetry is content-free and can be turned off under "Privacy" in the extension popup. Full policy: https://statshelpr.com/legal

statshelpr is a study aid. Use it in accordance with your institution's academic integrity policies.

Not affiliated with, endorsed by, or sponsored by Instructure or Canvas. "Canvas" is a trademark of Instructure, Inc., used here only to describe compatibility.

## Notes (not part of the listing)
- Every bullet above must map to something a user can actually see or do. A
  "Confidence signal — High/Med/Low indicator" bullet was removed because the
  `confidence` field is parsed only to populate the content-free telemetry
  beacon and is never rendered anywhere in the UI. Don't re-add it unless the
  indicator is actually shipped.
- The telemetry opt-out claimed here (and in `privacy-form.md`, already
  submitted to review) is the "Send anonymous usage stats" checkbox under
  Privacy in the popup — it writes `telemetryDisabled` to `chrome.storage.sync`,
  which content.ts reads before firing each beacon.
- The integrity note and the non-affiliation line are both standard for this category and materially help review approval; keep both. The non-affiliation disclaimer is the direct mitigation for the trademark risk — it makes the descriptive use of "Canvas" in the body unambiguous.
- Functionality statement ("solve button on quiz pages, compatible with Canvas") is required by CWS metadata policy — the listing must state what the extension does. Stated in the description body, not the name/summary.
- Store assets needed at upload time: at least 1 screenshot 1280×800 (see `docs/cws/screenshots/`), optional promo tile 440×280.
- Support email + website fields: use the statshelpr.com contact address.
