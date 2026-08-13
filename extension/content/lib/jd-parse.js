// Deterministic scoring of an extracted job description. No model, no API, no network.
//
// Everything here is a rule Dennis already decided, ported from profile/master-resume.md,
// profile/targets.md and RUNBOOK.md so it runs at read time instead of being remembered:
//
//   - the ten permanently excluded skills, with the 2026-08-11 hard-vs-soft carve-out
//   - APM / entry-level only, and never full, mid or senior PM
//   - keyword matching against the honest skill vocabulary, never an invented one
//
// The verdict is advisory for tailoring and blocking for applying. A `skip` means the posting is
// not worth a tailored resume, and the reason is always stated rather than implied.

(function () {
  'use strict';

  const lower = (s) => String(s || '').toLowerCase();

  // ---- the ten landmines -----------------------------------------------------
  //
  // master-resume.md:52. Never claimed on a resume regardless of what a JD asks for. Whether a
  // mention SKIPS the posting is a separate question, answered by the carve-out below.
  const EXCLUDED = [
    { id: 'sql', label: 'SQL', rx: /\bsql\b/i },
    { id: 'ab-testing', label: 'A/B testing', rx: /\ba\/?b test(ing)?\b|\bsplit test(ing)?\b/i },
    { id: 'amplitude', label: 'Amplitude', rx: /\bamplitude\b/i },
    { id: 'mixpanel', label: 'Mixpanel', rx: /\bmixpanel\b/i },
    { id: 'ga', label: 'Google Analytics', rx: /\bgoogle analytics\b|\bGA4\b/i },
    { id: 'jira', label: 'Jira', rx: /\bjira\b/i },
    { id: 'cpp', label: 'C++', rx: /\bc\+\+/i },
    { id: 'java', label: 'Java', rx: /\bjava\b(?!script)/i },
    { id: 'unity', label: 'Unity', rx: /\bunity\b/i },
    { id: 'python', label: 'Python', rx: /\bpython\b/i },
  ];

  // Soft-ask carve-out, recorded 2026-08-11 in RUNBOOK.md and targets.md. The automatic skip was
  // costing the most relevant postings found, so only a HARD requirement skips now. The honesty
  // rule is untouched and independent: the resume never claims the skill either way.
  const HARD_ASK = /\b(proficien\w*|strong|expert|advanced|deep|extensive|solid|required|requirement|must have|must[- ]haves?|demonstrated|hands[- ]on)\b|\b\d+\+?\s*(\+|or more)?\s*years?\b/i;
  const SOFT_ASK = /\b(familiar\w*|exposure|some first[- ]hand|nice[- ]to[- ]have|a plus|plus\b|bonus|preferred|preferably|desirable|helpful|willing(ness)? to learn|basic|working knowledge|comfortable)\b/i;

  // ---- seniority -------------------------------------------------------------
  //
  // Bare "APM" is deliberately NOT an entry-level signal. It also expands to Application
  // Performance Monitoring, and on the 2026-08-10 run that collision rescued a Senior Staff
  // Engineer posting from the senior filter because the logic was `if (SENIOR && !ENTRY) drop`.
  // Requiring a fuller phrase, and letting SENIOR win outright, closes both halves of that bug.
  const ENTRY = /\bassociate product manager\b|\bproduct manager\s*(i|1)\b|\bapm program\b|\bjunior\b|\bnew grad(uate)?\b|\bentry[- ]level\b|\bearly career\b|\bgraduate program\b|\brotational program\b|\bintern(ship)?\b|\bapprentice\b|\btrainee\b/i;
  const SENIOR = /\bsenior\b|\bsr\.?\b|\bstaff\b|\bprincipal\b|\blead\b|\bhead of\b|\bdirector\b|\bmanager of managers\b|\bvp\b|\bvice president\b|\bchief\b|\bgroup product manager\b|\bgpm\b|\bproduct manager\s*(ii|iii|iv|2|3|4)\b/i;
  const MID_PM = /\bproduct manager\b|\bproduct owner\b|\bprogram manager\b|\bproject manager\b|\btechnical program manager\b|\btpm\b/i;
  const NON_PRODUCT = /\bsoftware engineer\b|\bdeveloper\b|\bdata scientist\b|\bdata engineer\b|\bdesigner\b|\bsales\b|\baccount executive\b|\brecruiter\b|\bmarketing manager\b|\bforward deployed\b|\bsolutions architect\b/i;

  // ---- the honest vocabulary -------------------------------------------------
  //
  // master-resume.md:226-236 verbatim, grouped so the popup can say WHERE the overlap is. Nothing
  // is listed here that Dennis cannot defend in an interview, which is why matching against this
  // list can never produce a suggestion that would violate the anti-fabrication rule.
  const VOCAB = [
    { group: 'Product', terms: ['product discovery', 'user research', 'mvp', 'scoping', 'roadmap', 'prioritization', 'backlog', 'stakeholder', 'agile', 'scrum', 'go-to-market', 'gtm', 'prototyping', 'user stories', 'acceptance criteria', 'product requirements', 'prd', 'customer interviews', 'discovery'] },
    { group: 'Delivery', terms: ['scope definition', 'requirements gathering', 'sprint planning', 'milestone', 'risk mitigation', 'cross-functional', 'delivery', 'release', 'roadmapping', 'ceremonies', 'standup', 'retrospective'] },
    { group: 'AI building', terms: ['ai', 'llm', 'genai', 'generative', 'automation', 'agents', 'claude', 'copilot', 'mcp', 'prompt', 'workflow automation'] },
    { group: 'Stack', terms: ['react', 'next.js', 'nextjs', 'supabase', 'vercel', 'api', 'saas', 'full-stack', 'web app', 'ci/cd', 'github actions', 'google cloud', 'gcp'] },
    { group: 'Tools', terms: ['figma', 'git', 'linear', 'google workspace', 'notion', 'confluence', 'miro'] },
  ];

  const SECTION_RX = /^\s*(?:[#*\-•\s]*)((?:key )?responsibilit\w*|what you.?ll do|what you will do|what the role involves|what you.?ll be doing|day[- ]to[- ]day|the role|about the role|requirements?|qualifications?|what you.?ll need|what we.?re looking for|who you are|must[- ]haves?|minimum qualifications?|basic qualifications?|nice[- ]to[- ]haves?|preferred(?: qualifications?| experience| skills?)?|bonus points|benefits?|compensation|about us|equal opportunity)\b[:\s]*$/i;

  // Where a bare mention with no qualifying language still means the job requires it. A duty the
  // person will perform is at least as binding as a line in a Qualifications list.
  const REQUIRING_HEADING = /responsibilit|what you.?ll do|what you will do|what the role involves|what you.?ll be doing|day[- ]to[- ]day|the role|requirement|qualification|what you.?ll need|what we.?re looking for|who you are|must[- ]have/i;

  /** Split into labelled sections so a "nice to have" ask is never read as a requirement. */
  function sections(text) {
    const out = [{ heading: 'intro', body: [] }];
    for (const line of String(text || '').split('\n')) {
      const m = line.match(SECTION_RX);
      if (m && line.trim().length < 80) out.push({ heading: m[1].toLowerCase(), body: [] });
      else out[out.length - 1].body.push(line);
    }
    return out.map((s) => ({ heading: s.heading, text: s.body.join('\n').trim() })).filter((s) => s.text);
  }

  const PREFERRED_HEADING = /nice[- ]to[- ]have|preferred|bonus|desirable/i;

  /**
   * Classify each excluded-skill mention as hard, soft, or unclear.
   *
   * Judged on the sentence the mention sits in, not the whole document — "5+ years of product
   * management" three paragraphs away must not make a passing mention of SQL look like a hard
   * requirement. The section heading decides what the sentence itself leaves open.
   *
   * The default for a bare mention is deliberately NOT soft. Dennis's 2026-08-11 carve-out
   * exempted explicitly soft language ("familiarity with", "a plus", "preferred"), not the absence
   * of language. Volexity's Associate Product Manager proved why: its stated duty is "They will
   * write Python scripts", which carries no hard keyword at all, and treating that as a soft ask
   * produced a "review" verdict on a job whose day-to-day work is writing Python. So inside a
   * responsibilities or qualifications section a bare mention is HARD, and anywhere else it is
   * `unclear`, which never reaches an "apply" verdict on its own.
   *
   * Every sentence is scanned, not just the first: the intro often mentions a skill in passing
   * while the binding statement sits further down.
   */
  function excludedHits(secs) {
    const RANK = { soft: 0, unclear: 1, hard: 2 };
    const hits = [];

    for (const sec of secs) {
      const inPreferred = PREFERRED_HEADING.test(sec.heading);
      const isRequiring = REQUIRING_HEADING.test(sec.heading) && !inPreferred;
      const sentences = sec.text.split(/(?<=[.;!?])\s+|\n/);

      for (const skill of EXCLUDED) {
        for (const sentence of sentences) {
          if (!skill.rx.test(sentence)) continue;

          let strength;
          if (SOFT_ASK.test(sentence) || inPreferred) strength = 'soft';
          else if (HARD_ASK.test(sentence) || isRequiring) strength = 'hard';
          else strength = 'unclear';

          const rec = {
            id: skill.id, label: skill.label, strength,
            hard: strength === 'hard',
            section: sec.heading, quote: quote(sentence, skill.rx),
          };
          const existing = hits.find((h) => h.id === skill.id);
          // One entry per skill, keeping the strongest evidence found anywhere in the posting.
          if (!existing) hits.push(rec);
          else if (RANK[strength] > RANK[existing.strength]) Object.assign(existing, rec);
        }
      }
    }
    return hits;
  }

  /** A short excerpt centred on the match, so the popup shows evidence rather than a verdict. */
  function quote(sentence, rx) {
    const s = String(sentence).replace(/\s+/g, ' ').trim();
    if (s.length <= 160) return s;
    const at = s.search(rx);
    const from = Math.max(0, at - 60);
    return (from ? '…' : '') + s.slice(from, from + 160).trim() + (from + 160 < s.length ? '…' : '');
  }

  /** Which of the honest vocabulary the posting actually asks for, and which of it it never mentions. */
  function keywords(text) {
    const t = lower(text);
    const matched = [];
    const missing = [];
    for (const { group, terms } of VOCAB) {
      for (const term of terms) {
        // Word-boundary match so "api" does not fire inside "capital" and "ai" inside "email".
        const rx = new RegExp(`(^|[^a-z0-9+#.])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9+#]|$)`, 'i');
        (rx.test(t) ? matched : missing).push({ term, group });
      }
    }
    return { matched, missing };
  }

  /**
   * Title-first seniority read, falling back to the body only when the title is uninformative.
   * SENIOR always wins over ENTRY — a "Senior Associate Product Manager" is a senior role, and
   * the reverse reading is the exact bug that let a Senior Staff Engineer through.
   */
  function seniority(title, body) {
    const t = lower(title);
    if (SENIOR.test(t)) return { level: 'senior', why: `title reads as senior or above` };
    if (ENTRY.test(t)) return { level: 'entry', why: 'title carries an explicit entry-level signal' };
    if (NON_PRODUCT.test(t) && !MID_PM.test(t)) return { level: 'non-product', why: 'title is not a product or program role' };
    if (MID_PM.test(t)) {
      // No qualifier either way in the title. A years-of-experience floor in the body decides it.
      const yrs = String(body || '').match(/\b(\d+)\+?\s*(?:to\s*\d+\s*)?years?\b[^.]{0,40}\b(experience|product|pm)\b/i);
      if (yrs && Number(yrs[1]) >= 3) return { level: 'mid', why: `body requires ${yrs[1]}+ years of experience` };
      if (ENTRY.test(lower(body))) return { level: 'entry', why: 'body carries an entry-level signal' };
      return { level: 'unclear', why: 'product role with no seniority signal either way' };
    }
    return { level: 'non-product', why: 'no product or program role signal in the title' };
  }

  /**
   * Score, then decide. Three outcomes only:
   *   apply  — worth a tailored resume
   *   review — plausible but something needs a human read
   *   skip   — fails a rule Dennis already decided, with the rule named
   */
  function parse(jd) {
    const text = String(jd?.descriptionText || '');
    const title = String(jd?.title || '');
    const secs = sections(text);
    const excluded = excludedHits(secs);
    const kw = keywords(text);
    const sen = seniority(title, text);

    const blockers = [];
    const flags = [];

    // Standing instruction, Dennis 2026-08-13: apply even when requirements are not met, simply
    // without claiming the ones he does not have. So an excluded skill NO LONGER BLOCKS — it is
    // reported, loudly, and the application proceeds. This supersedes the earlier rule where a
    // hard ask was an automatic skip, and it narrows the 2026-08-11 hard-vs-soft carve-out to a
    // labelling distinction rather than a gate.
    //
    // The honesty half is untouched and is not negotiable: the skill never appears on a resume, in
    // a skills section, or in any free-text answer, whatever the posting asks for.
    let unclearSkill = false;
    for (const h of excluded) {
      if (h.strength === 'hard') flags.push(`requires ${h.label} — applying anyway, and it never goes on the resume`);
      else if (h.strength === 'soft') flags.push(`${h.label} is a soft ask, and it never goes on the resume`);
      else { unclearSkill = true; flags.push(`${h.label} mentioned without saying how firmly — it never goes on the resume`); }
    }
    if (sen.level === 'senior') blockers.push(`not entry level — ${sen.why}`);
    if (sen.level === 'mid') blockers.push(`not entry level — ${sen.why}`);
    if (sen.level === 'non-product') blockers.push(`not a product or program role — ${sen.why}`);
    if (sen.level === 'unclear') flags.push(`seniority unclear — ${sen.why}`);
    if (!text) blockers.push('no job description text could be read from this page');
    else if (text.length < 600) flags.push('description looks truncated — the page may render it lazily');
    if (jd?.source === 'dom') flags.push('read from page markup rather than structured data, so fields may be rough');

    // Overlap against the honest vocabulary. Deliberately not shown as a match percentage:
    // Jobright already gives a match number, and inventing a second one that means something
    // different would be read as the same thing.
    const strength = kw.matched.length;

    // An unclear excluded-skill mention can never reach "apply" on its own — the whole point of
    // surfacing it is that a human decides.
    const verdict = blockers.length ? 'skip'
      : (unclearSkill || flags.length || strength < 6) ? 'review'
      : 'apply';

    return {
      verdict,
      blockers,
      flags,
      seniority: sen,
      excluded,
      matched: kw.matched,
      missing: kw.missing.filter((m) => m.group === 'Product' || m.group === 'Delivery'),
      sections: secs.map((s) => s.heading),
      strength,
    };
  }

  window.__aa_jdParse = { parse, sections, excludedHits, keywords, seniority, EXCLUDED, VOCAB };
})();
