# CWS dashboard — Privacy practices form answers

Exact answers for the "Privacy practices" tab. All of these mirror
https://statshelpr.com/legal (Privacy Policy items 4–10), which is the
URL to enter as the privacy policy field.

## Single purpose description
> statshelpr provides worked solutions for statistics questions on Canvas LMS
> pages: when the user clicks its solve button on a quiz question, the question
> is sent to our server, which returns a step-by-step answer with the R code
> used to compute it.

## Permission justifications
- **storage** — stores the user's settings, uploaded course data files (7-day
  expiry), a random install identifier, and (paid plans) the license key, in
  Chrome sync storage.
- **alarms** — after the user starts an upgrade, a short-lived periodic check
  (every 30s, for at most 45 minutes) asks our API whether the purchase
  completed so the paid license can activate automatically. No alarms run
  outside that window.
- **Host: `https://*.instructure.com/*` and `https://quizzes.next.instructure.com/*`**
  — Canvas LMS domains where the content script renders the solve button and
  reads the question the user asks to solve. Quiz images that require the
  user's Canvas session are fetched from these hosts to include in the solve
  request.
- **Host: `https://api.statshelpr.com/*`** — our API: receives solve requests,
  validates licenses, and receives content-free telemetry events.
- **Remote code:** No. All executable code ships in the package; the server
  returns data (answers/R output) only.

## Data usage — types collected
Check exactly these:

| CWS category | Collected? | What / why |
|---|---|---|
| Personally identifiable information | **No** | The extension collects no name/email/address. (Checkout happens on lemonsqueezy.com, outside the extension.) |
| Health information | No | — |
| Financial and payment information | **No** | Payment handled entirely by Lemon Squeezy's site; the extension only ever receives the resulting license key. |
| Authentication information | **Yes** | Paid-plan license key, stored in sync storage and sent as an Authorization header to api.statshelpr.com to validate access. |
| Personal communications | No | — |
| Location | No | — |
| Web history | No | Content script runs only on matched Canvas quiz/assignment pages; no browsing data is recorded. |
| User activity | **Yes** | Content-free usage telemetry per solve (mode, coarse question-type, confidence level, timing, install id, and a one-way hashed Canvas school-domain identifier derived from the request's origin — never a readable school name). Never includes question text or answers. The per-solve mode/timing/install-id telemetry can be disabled in the popup; the hashed school-domain identifier is derived from every solve request's origin regardless of that setting. When the user starts an upgrade, the random install id is also attached to the Lemon Squeezy checkout as order metadata so the license can auto-activate on that install (disclosed in privacy policy item 7). |
| Website content | **Yes** | The quiz question's text, answer options, and attached images — sent only when the user clicks solve, only to generate the answer. User-uploaded CSV data files are included with solve requests for calculation questions. |

## Certifications (all three are true — check them)
- I do not sell or transfer user data to third parties, outside of the
  approved use cases (service providers: Google Gemini processes question
  content to generate the answer; Cloudflare and Google Cloud host our
  backend).
- I do not use or transfer user data for purposes unrelated to my item's
  single purpose.
- I do not use or transfer user data to determine creditworthiness or for
  lending purposes.

## Privacy policy URL
`https://statshelpr.com/legal`
(must be live and current at submission — redeploy landing before submitting)
