---
description: Tailor the resume to a job posting from a brief copied out of the extension
---

Tailor Dennis's resume to the posting below and render it to a one-page PDF.

The brief was produced by the Chrome extension's "Copy tailoring brief" button. If the user ran
`/tailor` with nothing after it, ask them to paste the brief and stop.

$ARGUMENTS

---

## Read these first, every time

1. `profile/master-resume.md` — the anti-fabrication boundary and the source of every claim.
2. `templates/resume-pm.tex` — the current approved resume. Bullets you do not rewrite stay
   exactly as they are here.

Do not work from the brief alone. The brief describes the *job*; those two files are the only
source for what may be said about *Dennis*.

## Step 1 — re-check the verdict yourself

The extension's scan is a regex pass and can be wrong in both directions. Read the posting text
in the brief and decide independently. Stop, and say why, if any of these hold:

- The posting **hard-requires** any of the ten excluded skills: SQL, A/B testing, Amplitude,
  Mixpanel, Google Analytics, Jira, C++, Java, Unity, Python. Hard means "proficiency in",
  "strong", "expert", "required", "must have", or a years-of-experience minimum. A soft ask
  ("familiarity with", "exposure to", "nice to have", "a plus", "preferred") does **not** stop
  the application — but the skill still never appears on the resume.
- The role is not entry level. Full, mid, or senior PM is a hard filter. Senior always wins over
  an entry-level signal in the same title. Bare "APM" proves nothing: it also expands to
  Application Performance Monitoring.
- The role is not a product or program role at all.

Stopping is a real outcome and the right one. Do not tailor a resume for a posting that fails a
filter Dennis already decided.

## Step 2 — write the tailoring spec

Select, reorder, and reword. **Never add** an employer, title, date, degree, metric, tool, or
skill that is not already in `master-resume.md`. The **Available, not currently on the resume**
lines in that file are approved material and are your main reserve — swapping one of those in for
a bullet the posting does not care about is the single highest-value move available.

Framing rules that apply without being restated in the brief:

- **Lead with directing Claude Code and Codex** as SWEs by writing user stories and managing
  Linear issues via MCP. This is the strongest and most defensible positioning available. It
  converts "does not hand-write code" into the value proposition.
- **NASA figures are modeled projections**, never achieved results. "Projected" or "modeled" stays
  in the sentence.
- **Scout is Product Designer.** Do not upgrade the title. Teammate count is 3 to 5.
- **En Hakkore Cafe** is unprompted initiative by a member of that church. He was not hired by it
  and did not "work with the church".
- **413 Youth Club and Research Foundation of CUNY are not claimed.** They are available material
  only; if their substance is used it folds into MavenStudio and is never a separate role.
- The "estimated 40%" order-error reduction keeps its hedge.
- Voice: no em-dashes, no colons in the body, open with the point, short, varied sentence length.

Write the spec to `applications/<YYYY-MM-DD>-<company>-<role-slug>/spec.json`:

```json
{
  "company": "...",
  "title": "...",
  "outDir": "applications/<YYYY-MM-DD>-<company>-<role-slug>",
  "summary": "plain text, no LaTeX wrapper, no manual escaping",
  "order": ["MavenStudio", "AutoBulletin", "En Hakkore Cafe", "Scout", "NASA L'SPACE"],
  "bullets": { "RoleName": ["...", "...", "..."] },
  "skills": { "Product Management": "..." }
}
```

Only `summary` is required. `order` must be a permutation of all five roles, never a subset.
Percent signs and ampersands are escaped for you; write plain text.

The Summary is where most of the tailoring lives, because it is the only block that can be
rewritten freely from approved material. Bullet edits should be surgical — swap in reserve
material, drop a clause the posting does not care about, lead a bullet with the phrasing the
posting uses. Rewriting all fifteen bullets is how a resume spills to two pages.

## Step 3 — render

```
node scripts/render-tailored.mjs applications/<slug>/spec.json
```

It hard-fails if the result is not exactly one page. If it fails, trim and re-run. Do not
override the gate, and do not hand back a two-page resume with a note.

## Step 4 — write the artifacts

In the same directory:

- `posting.md` — the job text from the brief, so the application is reproducible later.
- `trace.md` — **required.** Every clause you wrote in the summary and every bullet you changed,
  each mapped to the line in `master-resume.md` or `resume-pm.tex` it came from. Format:

  ```
  | Emitted | Source |
  |---|---|
  | "cutting order errors by an estimated 40%" | master-resume.md En Hakkore bullet 3 |
  ```

  A clause you cannot trace is a fabrication. Remove it and re-render rather than explaining it.

## Step 5 — report

Print the absolute path to `resume.pdf` and tell the user to attach it in the extension popup
under "This page" → "Attach PDF". Then summarise, in a few lines: what the tailoring changed,
what you deliberately left alone, and anything in the posting worth knowing before an interview.
