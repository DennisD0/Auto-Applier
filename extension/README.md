# Auto-Apply — Jobright to ATS

Two things, usable independently:

1. **Tailor for this page** — reads the job posting in front of you on any site, scores it against
   your hard filters, and hands Claude Code a brief that produces a tailored one-page resume.
   Works whether or not autofill does. No API key.
2. **Autofill** — reads your Jobright recommendations, opens the real application page, fills it
   from your profile, and submits **only** when auto mode is explicitly armed.

---

## Tailoring — "This page"

Open any job posting, click the extension, press **Tailor for this page**. Nothing is sent
anywhere; extraction and scoring are plain DOM and string work in `content/lib/jd-extract.js` and
`content/lib/jd-parse.js`.

**Reading the posting** runs three tiers, first hit wins:

| Tier | Source | Notes |
|---|---|---|
| `jsonld` | schema.org `JobPosting` | Cleanest. **Verified working on Lever.** |
| `meta` | OpenGraph / `<meta description>` | Declined when under 200 chars, which is most teasers |
| `dom` | text-density heuristic | The fallback that carries Greenhouse and Ashby |

**Greenhouse and Ashby publish no JSON-LD** — checked against live pages 2026-08-13, so the DOM
tier is not a rare path, it is the common one. The popup always shows which tier produced the read
so a rough one is visible rather than silent.

**Scoring** applies the rules from `profile/master-resume.md` and `RUNBOOK.md` at read time:

- The ten excluded skills, with the 2026-08-11 hard-vs-soft carve-out. A hard ask is a skip; a
  soft ask is not. Either way the skill never reaches the resume.
- APM / entry-level only. Bare "APM" is deliberately **not** an entry-level signal, since it also
  expands to Application Performance Monitoring — the collision that rescued a Senior Staff
  Engineer posting from the senior filter on 2026-08-10.
- Keyword overlap against the honest skill vocabulary only, so a suggestion can never imply a
  claim Dennis cannot defend.

Verdicts are `Worth tailoring` / `Read it first` / `Skip`, always with the reason named.
`node scripts/test-jd-parse.mjs` covers all of the above, including the APM collision.

**Then the zero-cost rewrite loop**, same shape as the pending-questions loop below:

1. **Copy tailoring brief** → paste into a Claude Code session → `/tailor`.
2. It reads `master-resume.md`, re-checks the verdict itself, writes a spec, and runs
   `node scripts/render-tailored.mjs`, which **hard-fails if the PDF is not exactly one page**.
3. It emits `applications/<date>-<company>-<role>/` with `resume.pdf`, `posting.md`, and
   `trace.md` — every emitted clause mapped back to its source line. A clause that cannot be
   traced is a fabrication, and the trace is what makes that checkable rather than aspirational.
4. **Attach PDF** in the popup. It is stored against the company it was built for, and
   `pickResume()` uses it only when that company matches the job being applied to.

---

## Autofill

Replaces the CLI + Chrome-extension-driven-by-Claude workflow, which took 30+ minutes per
application because every click was a round trip through the model. Here the model is called
at most **once per application**, and only for fields the rules table doesn't recognize.

## Install

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select `job-hunt/extension`
3. Open **Options** and set:
   - **the three resume PDFs** — generate with `node scripts/resume-variants.mjs`, then attach
     from `templates/variants/`. Required; without them every application routes to review.
   - review the profile JSON — it is seeded from `profile/answers.md`
   - **leave the API key blank.** It is optional. See below.

## Use

Open your Jobright recommendations tab, then click the extension. There are **two modes**:

| | Assist (default) | Full auto |
|---|---|---|
| Finds jobs | yes | yes |
| Fills the application | yes | yes |
| Submits | **never** | yes |
| Afterwards | leaves the tab open and moves on | submits, closes the tab, moves on |
| Stops when | `maxOpenTabs` is reached (default 8) | the time frame expires or the cap fills |

Full auto always carries a time frame and a submit cap — there is no way to reach it without
both. It expires on its own. **Halt** overrides everything including an active window.

**Run on Jobright list** scrolls the whole recommendations list (it paginates by infinite
scroll), takes everything at or above your match threshold, sorts by match descending, and works
down it. The threshold control shows how many jobs currently qualify so the number means
something.

## How it stays fast

`content/lib/rules.js` matches on **question text**, not DOM structure. "Are you legally
authorized to work in the United States?" reads the same on Ashby, Greenhouse and Lever, so one
rules table covers all three and per-site code shrinks to almost nothing. On the Amplify form it
resolved 21 of 25 fields with no model involved at all.

## Unrecognized questions — the zero-cost loop

**No API key required.** Anthropic API billing is separate from a Claude Pro subscription, so the
default path costs nothing:

1. Fields no rule recognizes are queued in Options under **Pending questions**, deduped by text
   with their options and a seen-count.
2. Click **Copy for Claude Code** — it puts the questions plus your profile on the clipboard.
3. Paste into a Claude Code session. Answers come back as `{"question": "answer"}`.
4. Paste those into the answers box and click **Save answers**.

Answered questions land in `profile.learnedAnswers`, which `apply.js` checks *before* treating
anything as unmapped — so each question is only ever asked once. Application questions repeat
heavily across companies, so the manual tail converges rather than recurring.

A `null` answer means the profile genuinely doesn't support one. That question stays pending
rather than getting an invented answer.

**Optional:** set an Anthropic API key in Options and this becomes automatic — one batched call
per application instead of the manual round trip. The model is `claude-haiku-4-5-20251001`, set
in `resolveUnknown()` in `background.js`.

## Two things that make it work at all

- **React ignores `el.value = x`.** Ashby and Greenhouse are React apps; a naive assignment
  leaves the field looking filled and submitting empty. `lib/setters.js` calls the prototype's
  native setter and dispatches the events React listens for.
- **`input.files` is read-only**, but a `DataTransfer` FileList is accepted, which is how the
  resume attaches with no native file dialog.

## Safety

Ported from `RUNBOOK.md` rather than reinvented:

- `armStatus()` in `background.js` is the **sole authority** on submitting, as
  `arm-auto.mjs status` is for the CLI. Assist never submits.
- Arming requires an expiry (72h ceiling) and a submit cap. Daily cap applies on top.
- `HALT` overrides everything.
- The never-fill list — SSN, date of birth, driver's license, bank details, passwords,
  background-check consent, signatures, ID uploads — **aborts the whole application** rather
  than guessing.
- The AI call is instructed to return `null` rather than invent, and a `null` routes the
  application to the review queue.
- Every filled value is re-read off the page **after a settle delay** and compared against what
  was committed. React forms revert controlled values on validation, so a field can report a
  successful write and be empty a moment later; this catches that. Any mismatch blocks
  submission. Ashby-style Yes/No `<button>`s carry no readable state and are counted as
  `unverifiable` rather than quietly passed.

## Resume variants

`node scripts/resume-variants.mjs` renders **two** one-page PDFs from `templates/resume-pm.tex`,
differing only in the Summary. Picked by job title in `pickResume()` (`content/apply.js`):

| Variant | Matches |
|---|---|
| `tailored` | a posting at the same company it was built for. Beats both of the below |
| `product` | default |
| `project` | project manager, program manager, TPM, technical program, scrum, delivery |

The company match on `tailored` is required rather than assumed. `resumes.tailored` is a single
slot, so without it a resume tailored to one posting would silently attach to every posting after
it — worse than the generic variant, because it reads as targeted and names the wrong problem.

`templates/resume-proj.tex` is deliberately **not** used — it predates the 2026-08-09 resume
update and contains no Linear/MCP framing, which is the strongest positioning available.

Re-run the script after any resume edit. It fails loudly if a variant spills to two pages.

## Not yet verified

**The extension has never completed a run.** Everything below is inference from reading code.

- Jobright card selectors are inferred from one page read. The `/jobs/info/<id>` links are
  stable; the per-card match % and salary parsing is not yet confirmed against a live DOM. If
  the match-% selector breaks, `runQueue` now errors by name rather than silently reporting
  zero eligible jobs.
- Ashby is verified against the Amplify form. **Every other platform is extrapolated** — submit
  button text, the Apply-button click-through, and combobox behavior all need a real run.
- Assist several jobs and read the run log before arming anything.

## Known limitations

- Tailoring is coarser than the CLI's per-JD Summary rewrite. For a role that really matters,
  run the CLI path instead.
- The resolver loop is free but not unattended — each new crop of unrecognized questions needs a
  round trip through a Claude Code session. It shrinks with every batch.
- If you do set an API key, it is stored in `chrome.storage.local` in plaintext.
- Automating Jobright may conflict with their terms. `RUNBOOK.md` already excludes LinkedIn and
  Indeed for the same reason.
- Unpacked only. The Web Store would reject an auto-submitting job applier.
