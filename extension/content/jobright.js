// Runs on jobright.ai. Two jobs:
//   1. On the recommendations list, harvest job cards into a queue.
//   2. On a job detail page, hand back the "Original Job Post" URL — the real ATS application.
//
// This reads the user's own logged-in recommendations in their own browser. It does not
// authenticate, scrape other users' data, or hit private endpoints.

(function () {
  'use strict';

  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  chrome.runtime.onMessage.addListener((msg, _s, respond) => {
    if (msg.type === 'AA_JR_HARVEST') {
      const jobs = harvest();
      console.log('[AA-HARVEST]', JSON.stringify({ n: jobs.length, jobs }));
      respond({ ok: true, jobs });
      return true;
    }
    if (msg.type === 'AA_JR_HARVEST_ALL') {
      harvestAll(msg.maxScrolls ?? 25).then((jobs) => respond({ ok: true, jobs }));
      return true;
    }
    if (msg.type === 'AA_JR_APPLY_URL') {
      applyUrl().then((r) => respond({ ok: Boolean(r.url || r.candidates.length), ...r }));
      return true;
    }
    if (msg.type === 'AA_JR_PROFILE_READ') {
      const profile = readProfile();
      respond(profile);
      return true;
    }
    return false;
  });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- debug bridge -------------------------------------------------------
  //
  // Content scripts run in an isolated world, so page-context JS cannot message them directly.
  // DOM events do cross that boundary, which makes an `AA_CMD` CustomEvent the one channel a
  // driving script can use. That is powerful enough to start real job applications, so it is
  // fenced twice:
  //
  //   1. `#aa-debug` must be in the tab's URL. Normal browsing never has it, so the bridge is
  //      inert during ordinary use.
  //   2. `bridgeOff` in storage kills it outright, from the Options page, regardless of the hash.
  //
  // Payloads are JSON strings in both directions. Objects created in one world are awkward to
  // read from the other; strings are not.
  document.addEventListener('AA_CMD', async (e) => {
    let req = {};
    try { req = JSON.parse(e.detail); } catch { /* replied to below */ }

    const reply = (payload) => {
      const out = JSON.stringify({ id: req.id ?? null, ...payload });
      console.log('[AA-BRIDGE]', out);
      document.dispatchEvent(new CustomEvent('AA_EVT', { detail: out }));
    };

    if (!/aa-debug/.test(location.hash)) {
      return reply({ ok: false, error: 'bridge inert — add #aa-debug to this tab’s URL to enable it' });
    }
    const { bridgeOff } = await chrome.storage.local.get('bridgeOff');
    if (bridgeOff) return reply({ ok: false, error: 'bridge switched off in Options' });
    if (!req.msg?.type) return reply({ ok: false, error: 'expected {id, msg:{type}} as a JSON string' });

    try {
      reply({ ok: true, result: await chrome.runtime.sendMessage(req.msg) });
    } catch (err) {
      reply({ ok: false, error: String(err?.message || err) });
    }
  });

  /**
   * Jobright paginates by infinite scroll inside its own scrollable div, not the window. Scroll
   * that container until it stops yielding new cards, so a run can work the whole list instead
   * of only what happened to be rendered.
   */
  async function harvestAll(maxScrolls) {
    const container = findScroller();
    let jobs = harvest();
    let stagnant = 0;

    for (let i = 0; i < maxScrolls && stagnant < 2; i++) {
      const before = jobs.length;
      if (container) container.scrollTop = container.scrollHeight;
      else window.scrollTo(0, document.body.scrollHeight);

      // Wait for lazy-loaded cards; bail early once the count moves.
      for (let w = 0; w < 12; w++) {
        await sleep(250);
        if (countCards() > before) break;
      }

      jobs = harvest();
      stagnant = jobs.length > before ? 0 : stagnant + 1;
    }
    return jobs;
  }

  const countCards = () =>
    new Set([...document.querySelectorAll('a[href*="/jobs/info/"]')]
      .map((a) => a.getAttribute('href'))).size;

  /** The nearest ancestor of the cards that actually scrolls. */
  function findScroller() {
    const a = document.querySelector('a[href*="/jobs/info/"]');
    if (!a) return null;
    let n = a.parentElement;
    while (n && n !== document.body) {
      const s = getComputedStyle(n);
      if (/auto|scroll/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 40) return n;
      n = n.parentElement;
    }
    return null;
  }

  /**
   * Scrape the recommendation cards. Keyed off the /jobs/info/<id> links, which are stable.
   *
   * Two things verified against the live DOM on 2026-08-10, both of which broke the first pass:
   *  - The match % lives in a SIBLING panel, not inside `job-card-main`. The container holding
   *    both is `index_job-card__<hash>`, so match on `[class*="job-card__"]`. Climbing further
   *    grabs the whole scrollable list and every card reads the first card's score.
   *  - `a.textContent` returns the entire card, not the title. The title is an <h2> inside it.
   */
  function harvest() {
    const seen = new Set();
    const jobs = [];
    for (const a of document.querySelectorAll('a[href*="/jobs/info/"]')) {
      const m = a.getAttribute('href').match(/\/jobs\/info\/([a-f0-9]+)/i);
      if (!m || seen.has(m[1])) continue;
      seen.add(m[1]);

      const card = a.closest('[class*="job-card__"]') || a.closest('[class*="job-card"]');
      const raw = card?.innerText || '';
      const text = clean(raw);
      const title = clean(a.querySelector('h1,h2,h3,h4,[class*="title"]')?.textContent)
        || clean(a.getAttribute('title'));

      jobs.push({
        id: m[1],
        title,
        detailUrl: `https://jobright.ai/jobs/info/${m[1]}`,
        matchPct: num(text.match(/(\d{1,3})\s*%\s*(?:STRONG|GOOD|FAIR)?\s*MATCH/i)?.[1]),
        company: companyFrom(raw, title),
        salary: raw.match(/\$[\d.]+K?\/(?:yr|hr)[^\n]*/i)?.[0] || null,
        level: (text.match(/\b(Intern|New Grad|Entry Level|Mid Level|Senior)\b/gi) || []).join(', ') || null,
        remote: /\bRemote\b/i.test(text),
        applicants: num(text.match(/(\d+)\+?\s*applicants/i)?.[1]),
        raw: text.slice(0, 600),
      });
    }
    return jobs;
  }

  /** Company is the first card line that isn't a badge, a timestamp, or the title itself. */
  function companyFrom(raw, title) {
    const skip = /ago$|applicant|early applicant|alumni|former colleague|work here|^\/$/i;
    for (const line of String(raw).split('\n')) {
      const t = clean(line);
      if (!t || t === title || skip.test(t)) continue;
      return t;
    }
    return null;
  }

  /**
   * On a detail page, resolve the outbound application URL.
   *
   * Returns `{ url, candidates }`. `url` is only set when the "Original Job Post" anchor is
   * present, which is the unambiguous answer. Everything else outbound comes back as ranked
   * candidates for the service worker to choose from, because ranking needs the ATS host list
   * and that list lives in background.js — a fallback list here is exactly what went stale
   * before (it only knew Ashby, Greenhouse and Lever, so an Oracle HCM posting resolved to
   * nothing and was logged as if Jobright had no link at all).
   */
  async function applyUrl() {
    const direct = [...document.querySelectorAll('a')].find((a) =>
      /original job post/i.test(clean(a.textContent)));
    if (direct?.href && isOutbound(direct.href)) return { url: direct.href, candidates: [] };

    // The link often resolves via a click that opens a new tab. Hand back every outbound href
    // on the page, deduped and in document order.
    const candidates = [...new Set(
      [...document.querySelectorAll('a[href]')].map((a) => a.href).filter(isOutbound),
    )];
    return { url: null, candidates };
  }

  // Junk that is never an application: Jobright's own pages, and the social, store and support
  // links that sit in nearly every page footer.
  const NOT_AN_APPLICATION =
    /(^|\.)(jobright\.ai|linkedin\.com|twitter\.com|x\.com|facebook\.com|instagram\.com|youtube\.com|tiktok\.com|reddit\.com|glassdoor\.com|indeed\.com|apple\.com|play\.google\.com|google\.com|crunchbase\.com|github\.com)$/i;

  function isOutbound(href) {
    let u;
    try { u = new URL(href, location.href); } catch { return false; }
    if (!/^https?:$/.test(u.protocol)) return false;
    return !NOT_AN_APPLICATION.test(u.hostname);
  }

  function readProfile() {
    if (!/\/jobs\/profile(?:[/?#]|$)/i.test(location.pathname + location.search + location.hash)) {
      return { ok: false, error: 'open your Jobright profile page at /jobs/profile first' };
    }

    const candidates = [...readFormCandidates(), ...readStaticCandidates()];
    const byKey = new Map();

    for (const candidate of candidates) {
      const mapped = mapProfileField(candidate.label, candidate.value);
      if (!mapped) continue;
      if (!mapped.value) continue;

      const existing = byKey.get(mapped.key);
      if (!existing || scoreCandidate(mapped) > scoreCandidate(existing)) {
        byKey.set(mapped.key, mapped);
      }
    }

    const fields = {};
    for (const [key, field] of byKey.entries()) {
      fields[key] = {
        value: field.value,
        label: field.label,
        source: field.source,
      };
    }

    return {
      ok: true,
      url: location.href,
      fields,
      seen: candidates.length,
      matched: Object.keys(fields).length,
    };
  }

  function readFormCandidates() {
    const out = [];
    for (const el of document.querySelectorAll('input, select, textarea')) {
      if (!isVisible(el)) continue;
      if (el.type === 'hidden' || el.type === 'password' || el.disabled) continue;

      const label = fieldLabel(el);
      const value = controlValue(el);
      if (!label || !value) continue;
      out.push({ label, value, source: 'form' });
    }
    return dedupeCandidates(out);
  }

  function readStaticCandidates() {
    const out = [];
    const selectors = [
      '[data-testid]',
      'section div',
      'li',
      '.ant-row',
      '.ant-descriptions-row',
      '.ant-form-item',
    ];
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (!isVisible(el)) continue;
        const pair = staticPair(el);
        if (!pair) continue;
        out.push({ ...pair, source: `static:${sel}` });
      }
    }
    return dedupeCandidates(out);
  }

  function staticPair(root) {
    const kids = [...root.children].filter(isVisible);
    if (kids.length < 2 || kids.length > 6) return null;

    const texts = kids.map((el) => clean(el.innerText || el.textContent || ''));
    const label = texts.find((t) => isLabelLike(t));
    if (!label) return null;

    const labelIndex = texts.indexOf(label);
    const value = texts.slice(labelIndex + 1).find((t) => t && t !== label && !isLabelLike(t));
    if (!value) return null;
    if (value.length > 280) return null;
    return { label, value };
  }

  function dedupeCandidates(list) {
    const seen = new Set();
    return list.filter((item) => {
      const key = `${item.source}|${item.label}|${item.value}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function fieldLabel(el) {
    const direct = el.labels?.[0]?.textContent;
    if (clean(direct)) return clean(direct);

    const aria = el.getAttribute('aria-label') || el.getAttribute('placeholder');
    if (clean(aria)) return clean(aria);

    const item = el.closest('label, .ant-form-item, [class*="form-item"], [class*="field"]');
    if (!item) return '';
    const text = clean(item.innerText || item.textContent || '');
    const value = clean(controlValue(el));
    return clean(value ? text.replace(value, '') : text);
  }

  function controlValue(el) {
    if (el.tagName === 'SELECT') {
      return clean(el.selectedOptions?.[0]?.textContent || el.value);
    }
    if (el.type === 'checkbox') {
      return el.checked ? 'Yes' : 'No';
    }
    return clean(el.value);
  }

  function mapProfileField(label, value) {
    const normLabel = clean(label).toLowerCase();
    const normValue = normalizeValue(value);
    if (!normValue) return null;

    const defs = [
      ['legalFirstName', /(legal )?first name|given name/],
      ['lastName', /last name|family name|surname/],
      ['preferredName', /preferred name|display name|nick ?name/],
      ['pronouns', /pronouns?/],
      ['email', /email/],
      ['phone', /phone|mobile/],
      ['streetAddress', /street|address line|mailing address/],
      ['city', /^city$/],
      ['cityForForms', /city.*form|preferred city/],
      ['state', /state|province|region/],
      ['zip', /\bzip\b|postal code/],
      ['country', /country/],
      ['authorizedToWorkUS', /authorized to work|work authorization/],
      ['requiresSponsorship', /require .*sponsorship|need .*sponsorship/],
      ['age18OrOver', /18 or over|at least 18/],
      ['visaStatus', /visa status/],
      ['subjectToRestrictiveAgreements', /restrictive agreement|non-?compete/],
      ['startDate', /start date|earliest start|available start/],
      ['noticePeriod', /notice period|notice time/],
      ['desiredSalaryNumber', /salary expectation|desired salary(?!.*text)|compensation expectation/],
      ['desiredSalaryText', /salary range|salary expectation text|desired compensation/],
      ['openToRelocation', /relocat/],
      ['canTravelToNY', /travel to new york|commute to new york/],
      ['travelWillingness', /travel willingness|willing to travel|travel requirement/],
      ['workModelPreference', /work model|remote.*hybrid|hybrid.*remote|work preference/],
      ['linkedin', /linkedin/],
      ['portfolio', /portfolio|website|personal site/],
      ['github', /github/],
      ['school', /school|university|college/],
      ['degree', /^degree$/],
      ['highestEducation', /highest education|education level/],
      ['fieldOfStudy', /field of study|major/],
      ['graduationDate', /graduation|graduated|end date/],
      ['gpa', /\bgpa\b/],
      ['howDidYouHear', /how did you hear|hear about us|source/],
      ['smsConsent', /sms consent|text message consent/],
      ['eeo.gender', /gender/],
      ['eeo.race', /race|ethnicity/],
      ['eeo.hispanic', /hispanic|latino/],
      ['eeo.veteran', /veteran/],
      ['eeo.disability', /disability/],
      ['eeo.lgbtq', /lgbtq|lgbt/],
      ['eeo.orientation', /sexual orientation|orientation/],
    ];

    const hit = defs.find(([, rx]) => rx.test(normLabel));
    if (!hit) return null;
    return { key: hit[0], value: castProfileValue(hit[0], normValue), label: clean(label), source: 'Jobright profile' };
  }

  function castProfileValue(key, value) {
    if ([
      'authorizedToWorkUS',
      'requiresSponsorship',
      'age18OrOver',
      'subjectToRestrictiveAgreements',
      'canTravelToNY',
      'smsConsent',
    ].includes(key)) return toBoolean(value);

    if (key === 'desiredSalaryNumber') {
      const digits = value.replace(/[^\d]/g, '');
      return digits || value;
    }
    return value;
  }

  function normalizeValue(value) {
    const v = clean(value)
      .replace(/\bEdit\b/gi, '')
      .replace(/\bSave\b/gi, '')
      .trim();
    return v;
  }

  function toBoolean(value) {
    return /^(yes|true|authorized|i am authorized|open|agree|consent|male)$/i.test(value)
      ? true
      : /^(no|false|not authorized|do not|decline)$/i.test(value)
        ? false
        : value;
  }

  function scoreCandidate(field) {
    const sourceScore = field.source === 'Jobright profile' ? 20 : 0;
    const formScore = field.label.length < 40 ? 3 : 0;
    const boolScore = typeof field.value === 'boolean' ? 2 : 0;
    return sourceScore + formScore + boolScore + field.value.length;
  }

  function isLabelLike(text) {
    const t = clean(text);
    if (!t || t.length > 90) return false;
    if (/^(edit|save|cancel|delete|add|remove|yes|no)$/i.test(t)) return false;
    return /[a-z]/i.test(t) && !/[.!?].+[.!?]/.test(t);
  }

  function isVisible(el) {
    if (!(el instanceof Element)) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && el.getClientRects().length > 0;
  }

  const num = (v) => (v == null ? null : Number(v));
})();
