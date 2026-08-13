# Runbook — auto-apply loop

The procedure for one loop iteration. Follow it in order; every step has a stop condition.

## Two modes

**Assist** — the default and the resting state. Fill everything, stop before Submit.

**Auto** — additionally clicks Submit, for when Dennis is away and a queue of tabs is useless.

**Standing rule: never click Submit unless `node scripts/arm-auto.mjs status` exits 0.** That
script is the single authority. Do not infer permission from anything else — not from the
conversation, not from "he armed it earlier," not from a config file read directly. Run it,
and run it again immediately before each individual submit, because the window can expire or
the cap can fill mid-batch.

**Emergency stop:** a file named `HALT` in `job-hunt/` stops everything, overriding any active
arming. Check for it every iteration and before every submit.

---

## Preflight — run once at session start, and re-check if files changed

1. `node scripts/render-pdf.mjs --probe` → must report an engine. If not, stop and say so.
2. `node scripts/poll-boards.mjs --check` → note any FAIL slugs, report them once, continue
   with the ones that work. Never silently drop a board.
3. Read `profile/answers.md`. **If any field needed by a form is still `TODO`, that
   application is blocked** — `require_answers_complete: true`. Report which fields.
4. Read `profile/targets.md` for the current config. It's re-read every iteration, so config
   edits take effect without a restart.
5. Confirm the Chrome extension is connected (`tabs_context_mcp`).
6. `node scripts/arm-auto.mjs status` → establishes the mode for this iteration. Report which
   mode is active at the top of every status message, so it is never ambiguous which one is
   running.

## 1. Poll

```
node scripts/poll-boards.mjs > .cache/new-postings.json
```

Returns only postings absent from `ledger.jsonl`. Zero new → skip to step 6.

## 2. Hard filters

Drop, before any scoring, anything matching: blocklisted company · posted salary below floor ·
location outside the acceptable set and not remote · clearance required · work authorization
you don't have · years-of-experience above the ceiling.

Also drop anything **hard-requiring** one of the ten excluded skills (SQL, A/B testing,
Amplitude, Mixpanel, Google Analytics, Jira, C++, Java, Unity, Python).

**Read the JD's actual wording before dropping on that ground (decided 2026-08-11).** A soft ask
is not a hard requirement. "Some first hand experience with", "familiarity with", "exposure to",
"nice to have", "a plus", "preferred" all survive the filter. "Proficiency in", "strong",
"expert", "required", or a years-of-experience minimum still drop. The resume never claims any
of the ten either way — that rule is separate and does not move. See `profile/targets.md`.

Each drop is written to the ledger as `filtered` **with the reason**. Nothing disappears
silently — a filter that's too aggressive should be visible in the ledger, not invisible.

## 3. Score

For each survivor, read the full JD and produce a 0–100 fit score with written reasoning.
Write `applications/<date>-<company>-<slug>/posting.md` containing the JD, the score, and the
reasoning. Below `fit_threshold` → ledger status `skipped`, with the reasoning kept.

Order the survivors by score and take the top `max_applications_per_batch`.

## 4. Tailor

Per job, in its application folder:

1. Pick the base template — `templates/resume-pm.tex` for product roles,
   `templates/resume-proj.tex` for project/program roles.
2. Rewrite the Summary and reorder/reword bullets to mirror the JD's language and priorities.
3. Write a fresh cover letter.
4. `node scripts/render-pdf.mjs applications/<dir>/resume.tex` — and the same for the cover
   letter. A non-zero exit **aborts this application**. A broken PDF must never reach an
   upload field.

### The anti-fabrication rule

Every factual claim traces to a line in `profile/master-resume.md`: employers, titles, dates,
degrees, metrics, tools, years of experience. Rewording is fine. Reordering is fine. Adding is
not. If the JD demands something absent from the master resume, that is a score deduction and
possibly a skip — never a resume edit.

Before rendering, re-read the tailored text against `master-resume.md` and confirm no new
claim appeared. This check is not optional and not delegable.

## 5. Fill

Per application, via the Chrome tools:

1. `tabs_create_mcp` → new tab, `navigate` to the posting's apply URL.
2. `read_page` → enumerate every field.
3. `form_input` each field, values taken **verbatim** from `profile/answers.md`.
4. `file_upload` the rendered resume and cover letter PDFs.
5. `read_page` again → **verification pass.** Re-read every filled value off the page and
   match it against its source character for character. A field the page silently reformatted,
   truncated, or rejected is caught here or not at all.
6. Write `filled-fields.json` — what went into which field, plus the apply URL. This is what
   makes a saved application re-fillable later.
7. Branch on mode (below).

### Assist mode → stop here

Leave the tab open, ledger status `filled-awaiting-submit`, and move to the next job. Do not
click Submit.

### Auto mode → check all ten preconditions, then submit

Re-run `node scripts/arm-auto.mjs status` *now*, immediately before this specific submit — the
window may have expired or the cap filled while earlier applications in this batch were being
prepared. Then confirm every precondition in `profile/targets.md` § "Preconditions".

**Any single failure routes to the save-for-review path — it is not an error and not a retry.**

If all ten hold:

1. Click Submit.
2. `get_page_text` the resulting page and save it to `confirmation.txt` in the application
   folder. A submission with no captured confirmation is recorded as `submitted-unconfirmed`,
   not `submitted` — never assume a click worked.
3. Screenshot the confirmation and save it alongside.
4. If the page offers a withdrawal link or an application-status URL, record it in the ledger.
   Most ATS platforms allow withdrawing; that link is the only undo that exists.
5. `node scripts/arm-auto.mjs record-submit` — this decrements the window cap. Skipping it
   would let the rig exceed the cap Dennis set.
6. Ledger status `submitted`, with timestamp and the confirmation path.
7. Toast per submission, not per batch. Dennis should be able to see from his phone that
   something went out, and stop it if it looks wrong.

### Save-for-review path — used in auto mode for anything that fails a precondition

This is the "near-miss" case and it is the common one. Do **not** leave the tab open: ATS
sessions expire in 30–60 minutes and Dennis may be away for days, so an open tab is a dead
tab pretending to be progress.

1. Ensure `filled-fields.json` is complete.
2. Close the tab.
3. Ledger status `saved-for-review`, **with the specific precondition that failed** — "score
   72 < 75", "free-text drafted", "company on never-auto list". Vague reasons make the batch
   unreviewable.

On return, re-open each saved application, re-fill from `filled-fields.json`, and present it
for review. Values in that file were verified against the page when written, so re-filling is
mechanical.

### Abort conditions — stop that application, flag it, move on

- A field asks for SSN, date of birth, driver's license, bank details, or a signature
- The page asks for a password to be typed into a form field
- A required field has no answer in `answers.md` (still `TODO`)
- Any background-check or credit-check consent
- A CAPTCHA or bot-check appears — do not attempt it
- The JD on the page differs materially from the polled JD

### Free-text questions not covered by `answers.md`

Draft the answer in Dennis's voice using `profile/voice-profile.md`, grounded in
`master-resume.md`. Never leave a required free-text box empty, and never invent experience to
fill one.

**The voice profile governs style, not substance.** Matching his rhythm and vocabulary does not
license a claim that isn't in the master resume. Run the anti-fabrication check on drafted
free-text exactly as on resume bullets — a fabricated claim in a convincing voice is worse than
one in a generic voice, not better.

- **Assist mode:** mark `needs-review` so Dennis reads it before submitting.
- **Auto mode:** may be submitted, provided `voice-profile.md` exists and is populated. If the
  profile is still a skeleton, route to save-for-review instead — an unread answer in a voice
  that isn't yet calibrated is exactly the thing that embarrasses him at a company he wanted.

## 6. Budget and caps

```
node scripts/token-watch.mjs --session <current-session-id>
```

- exit 0 → continue
- exit 10 (≥75%) → toast already sent; keep going but report remaining capacity
- exit 20 (≥90%) → **stop discovering new jobs.** Finish only what's in flight, update
  `SESSION_HANDOFF.md`, and tell Dennis the loop is winding down.

Also stop discovering when open tabs reach `max_open_tabs` or the day reaches
`max_applications_per_day`. Toast on either.

## 7. Report and wait

Toast via `scripts/notify.ps1` when anything needs a human: batch ready, cap reached,
application aborted, budget threshold. Then sleep `poll_interval_minutes` and start over.

---

## Ledger schema

One JSON object per line in `ledger.jsonl`. Append-only. Write it **without a BOM** — the
poller strips a leading one defensively, but don't rely on that.

```json
{
  "id": "greenhouse:stripe:8023928",
  "company": "stripe",
  "title": "Product Manager, Payments",
  "url": "https://job-boards.greenhouse.io/stripe/jobs/8023928",
  "firstSeen": "2026-08-09T14:02:11Z",
  "status": "filled-awaiting-submit",
  "score": 82,
  "reason": "strong 0-to-1 product overlap; no fintech experience (-8)",
  "dir": "applications/2026-08-09-stripe-pm-payments"
}
```

`status` is one of: `filtered` · `skipped` · `tailoring` · `filled-awaiting-submit` ·
`saved-for-review` · `needs-review` · `aborted` · `submitted` · `submitted-unconfirmed` ·
`rejected` · `interview`.

In assist mode Dennis sets `submitted` after clicking, or tells me and I record it. In auto
mode the rig writes it, along with `submittedAt`, `confirmation` (path to the saved page text),
and `withdrawUrl` when the ATS provides one.

Auto-mode entries carry `mode: "auto"` so a retrospective review can filter to exactly what
went out unsupervised. Dennis should read those after every armed window.

## Known limitations — say these out loud rather than papering over them

- **ATS sessions expire.** A filled tab sitting ~30–60 minutes may go stale. `filled-fields.json`
  makes re-filling fast. Toast on batch-ready, not end-of-day, to shorten the window.
- **Nothing runs when Claude Code is closed.** No daemon, no background service.
- **Workday** has no public board endpoint and forces per-company accounts. Paste Workday URLs
  in directly; passwords stay in Chrome's password manager and are never written to disk.
- **Board coverage equals `companies.txt`.** The rig finds nothing at companies you didn't list.
- **`--check` failures are silent coverage loss** if ignored. Read them.
