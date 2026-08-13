# Targets & Run Config

Drives scoring, hard filters, and the run caps. Edit freely — the loop re-reads this every
iteration, so changes take effect without restarting.

---

## Roles

**Target tier: Associate Product Manager and entry-level / junior Product Manager.**

This is settled, not a preference. Dennis submitted 180+ applications through July 2026 with
zero interviews, and applying to **full PM roles was diagnosed as one of the causes** — the
other two being ATS filtering and thin per-application tailoring, which this rig exists to fix.

**Primary titles**
- Associate Product Manager / APM
- Product Manager, entry-level or junior explicitly
- Product Manager, New Grad / Rotational / APM program
- Product Owner (intern or entry) — he applied to Zenyt.ai at this level
- Associate Product Operations

**Hard filter — auto-skip:** any posting for a **full/mid/senior PM role**. Signals: "3+ years
product management required", "own a product line", "manage a team of PMs", Senior/Staff/Lead/
Principal/Group in the title. Applying to these is the known failure mode; do not re-enter it
to raise volume.

**Not interested in:** pure software engineering roles (see the AI-builder constraint in
`master-resume.md` — not interview-defensible), sales, QA.

## Location

- **Base:** New York City (Fresh Meadows, Queens — ZIP 11365)
- **Remote / hybrid / onsite:** all three acceptable, no stated preference `[jobright 2026-08-10]`
- **Acceptable metros:** New York, NY within a 25-mile radius `[jobright 2026-08-10]`.
  Remote-anywhere-in-US postings also acceptable.
- **Relocation:** TODO

## Compensation

- **Floor (hard filter — below this, auto-skip):** $80,000/yr `[jobright 2026-08-10]`
- **Target:** TODO
- **If no salary is posted:** TODO — `skip` or `proceed` (recommend `proceed`; most postings omit it)

## Hard filters — checked before scoring, auto-skip on match

- **Full / mid / senior PM role** (see Roles above — this is the big one)
- Requires more than ~1 year of product management experience
- Requires a skill on the excluded list in `master-resume.md` as a **hard** requirement —
  SQL, A/B testing, Amplitude, Mixpanel, Google Analytics, Jira, C++, Java, Unity, Python.
  Those never go on the resume, so a role gating on them is not honestly winnable.

  **Soft-ask carve-out, decided 2026-08-11.** Only a hard requirement skips. Language like
  "some first hand experience with", "familiarity with", "exposure to", "nice to have",
  "a plus", or "preferred" does **not** skip the role. Language like "proficiency in",
  "strong", "expert", "required", or a named years-of-experience minimum still does.

  This changes *which jobs are worth applying to*, and nothing else. The resume and every
  free-text answer still never claim any of the ten. Those two rules are independent: not
  claiming a skill is an honesty boundary, while skipping a posting was only ever a
  cost-benefit judgment, and the automatic skip was costing the most relevant postings found.
- Requires security clearance
- Requires work authorization Dennis doesn't have (see `answers.md`)
- Company appears in the blocklist below
- Posted salary below the floor
- Location outside the acceptable set and not remote
- TODO: add your own

## Company blocklist

One per line. Never applied to, never scored, never shown.

```
TODO — e.g. previous employers, companies you've been rejected from recently, anywhere you
simply don't want to work
```

## Must-haves and nice-to-haves (scoring signal)

**Boosts the score** — these are where Dennis's real story lands hardest:
- AI-native product, or a team that treats AI-assisted building as a plus
- Early-stage or startup, comfort with ambiguity, product ownership from day one
- 0→1 / MVP scoping rather than optimizing a mature surface
- Small team where one person owns discovery through delivery
- Explicit APM / new-grad / rotational program

**Drags the score:**
- Heavy quantitative analytics ownership (the excluded-skills list bites here)
- Enterprise sales support, heavy on-call, pure backlog administration
- Large org where an APM is one seat in a long chain

**TODO:** anything you'd add.

---

## Run config

```yaml
# Scoring
fit_threshold: 70          # below this, log as skipped and move on

# Caps
max_open_tabs: 8           # filled forms left waiting for your Submit click
max_applications_per_day: 10
max_applications_per_batch: 3   # raise after the first clean unattended run

# Loop
poll_interval_minutes: 25

# Token budget (see scripts/token-watch.mjs)
token_budget: 2000000      # set 2026-08-10 to a sane default so the 75%/90% safety toasts can
                           # actually fire; was TODO, which disabled them entirely. Adjust freely.
warn_at_percent: 75        # toast here
halt_at_percent: 90        # stop taking new jobs, finish in-flight, write handoff

# Behavior
require_answers_complete: true   # any TODO in answers.md blocks that application
```

### Fully-auto mode

Two modes. **Assist** is the default and the resting state: fill everything, stop before
Submit. **Auto** additionally clicks Submit — for when Dennis is away and a queue of tabs
would be useless.

Auto mode is never on by default. It must be armed explicitly, always with an expiry:

```
node scripts/arm-auto.mjs arm --hours 48 --max 20
node scripts/arm-auto.mjs status
node scripts/arm-auto.mjs disarm
```

Arming self-expires. A single window is capped at 72 hours — re-arm if you need longer, which
is deliberate friction. `scripts/arm-auto.mjs status` is the only authority on whether
submission is permitted; nothing else decides.

**Emergency stop:** create an empty file named `HALT` in `job-hunt/`. Checked every iteration
and before every submit; its presence disarms auto mode and stops the loop regardless of
arming state. Delete it to resume.

```yaml
# Auto mode
auto_submit_min_score: 75        # separate, higher bar than fit_threshold (70)
auto_submit_max_per_window: 20   # default --max when arming
auto_submit_max_per_day: 10
```

**Never auto-submit to these companies** — always saved for review no matter the score. Use
for dream roles where one shot is all you get, or anywhere a mistake would be costly.

```
(none)
```

**Dennis elected on 2026-08-10 to auto-submit everywhere.** No company is shielded, including
Anthropic, OpenAI, Figma and Stripe. Adding a slug above re-protects it immediately; the list
is re-read every iteration.

#### Preconditions — every one must hold, or it gets saved instead of submitted

1. `arm-auto.mjs status` exits 0 (armed, unexpired, under the window cap)
2. No `HALT` file
3. Fit score ≥ `auto_submit_min_score`
4. Zero `TODO` values among the fields this form actually needs
5. Both PDFs rendered and passed `render-pdf.mjs` validation
6. No abort condition triggered (see RUNBOOK)
7. Company not on the never-auto-submit list
8. Under `auto_submit_max_per_day`
9. Post-fill verification passed: every filled value re-read off the page and matched against
   its source, character for character
10. Any free-text answer was generated from `profile/voice-profile.md` **and** re-checked
    against `master-resume.md` for invented claims

Failing any of these is not an error — it routes the application to the save-for-review path.
Nothing is lost; it just waits for Dennis.

#### Near-miss handling while away

An application that qualifies but doesn't clear the auto bar is **saved, not left open**:
tailor the materials, record every field into `filled-fields.json`, close the tab. ATS
sessions expire in roughly 30–60 minutes, so a tab left open during a weekend away is a dead
tab. On return, the rig re-opens each one and re-fills it live from the record for review.
