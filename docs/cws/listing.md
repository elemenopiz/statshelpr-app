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
public summary IS the manifest description. As of v1.1.1 that is:
> Stats quiz tutor — worked solutions with runnable R code, shown inline on your quiz questions.
To change the summary, edit `apps/extension/public/manifest.json` `description`
and re-upload — do NOT expect a summary field in the dashboard. ("Canvas" is
kept out of it for the trademark reason; it lives only in the long Description
body below.)

## Category / language
Education · English

## Full description

statshelpr adds a solve button to statistics questions on Canvas quiz pages. Click it and you get a worked solution: the answer and, for calculation questions, the exact R code that produces the result — executed on a real R runtime on our servers.

Built for intro statistics courses (inference, regression, confidence intervals, probability), statshelpr turns quiz questions into worked examples:

- **See the R behind the answer** — every calculation shows runnable code using the libraries your course teaches (tidyverse, mosaic, moderndive, infer).
- **Use your course data** — upload the CSV your class provides and solutions are computed on your actual dataset, not a lookalike.
- **Review where you went wrong** — open a graded quiz and step through the solution for each question you missed.
- **Pick your libraries** — tell statshelpr which R packages your course uses and solutions follow that style.
- **Confidence signal** — every answer carries a High/Med/Low confidence indicator, so you know when to double-check.

Free plan: 5 solves per day. Unlimited: $15/month.

Privacy: question content is sent to our servers only when you click solve, and used only to generate the answer. Usage telemetry is content-free and can be disabled. Full policy: https://statshelpr.com/legal

statshelpr is a study aid. Use it in accordance with your institution's academic integrity policies.

Not affiliated with, endorsed by, or sponsored by Instructure or Canvas. "Canvas" is a trademark of Instructure, Inc., used here only to describe compatibility.

## Notes (not part of the listing)
- The integrity note and the non-affiliation line are both standard for this category and materially help review approval; keep both. The non-affiliation disclaimer is the direct mitigation for the trademark risk — it makes the descriptive use of "Canvas" in the body unambiguous.
- Functionality statement ("solve button on quiz pages, compatible with Canvas") is required by CWS metadata policy — the listing must state what the extension does. Stated in the description body, not the name/summary.
- Store assets needed at upload time: at least 1 screenshot 1280×800 (see `docs/cws/screenshots/`), optional promo tile 440×280.
- Support email + website fields: use the statshelpr.com contact address.
