// Job-description extraction — turn an arbitrary job posting page into a structured record.
//
// Same philosophy as discover.js: key off MEANING, not per-site DOM structure. The difference is
// that job pages hand us something forms never do — most of them publish schema.org JobPosting
// JSON-LD for Google Jobs indexing, which is exactly the data we want, already parsed. So the
// tiers run structured-first and only fall back to guessing at markup when nothing structured
// exists.
//
// Nothing here calls a model. This is DOM reading and string work, start to finish.

(function () {
  'use strict';

  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  /** Strip tags from the HTML fragments JSON-LD descriptions usually contain, keeping breaks. */
  function htmlToText(html) {
    const s = String(html || '');
    if (!/<[a-z!/]/i.test(s)) return s.replace(/\r/g, '').trim();
    const doc = new DOMParser().parseFromString(s, 'text/html');
    // <li> and block ends carry the structure jd-parse.js reads sections from. Preserve them as
    // newlines before textContent flattens everything into one run-on line.
    for (const el of doc.body.querySelectorAll('li')) el.prepend(doc.createTextNode('\n- '));
    for (const el of doc.body.querySelectorAll('p, div, br, h1, h2, h3, h4, h5, h6, tr')) {
      el.after(doc.createTextNode('\n'));
    }
    return normalizeBlock(doc.body.textContent);
  }

  /** Collapse runs of spaces within a line, and runs of blank lines between them. */
  const normalizeBlock = (s) => String(s || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // ---- tier 1: schema.org JobPosting JSON-LD --------------------------------

  /**
   * Walk every ld+json block looking for a JobPosting. They are routinely wrapped — in @graph,
   * in a bare array, or nested inside an ItemList — so this recurses rather than checking the
   * top level only, which is the usual reason a "JSON-LD not found" bug appears on a page that
   * demonstrably has one.
   */
  function findJobPosting(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 6) return null;
    if (Array.isArray(node)) {
      for (const item of node) {
        const hit = findJobPosting(item, depth + 1);
        if (hit) return hit;
      }
      return null;
    }
    const type = node['@type'];
    const types = Array.isArray(type) ? type : [type];
    if (types.some((t) => String(t).toLowerCase() === 'jobposting')) return node;
    for (const key of ['@graph', 'itemListElement', 'mainEntity', 'item']) {
      const hit = findJobPosting(node[key], depth + 1);
      if (hit) return hit;
    }
    return null;
  }

  function fromJsonLd() {
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      let parsed;
      // Sites ship malformed JSON-LD more often than you would hope. One bad block must not
      // stop us reading the next one.
      try { parsed = JSON.parse(script.textContent); } catch { continue; }
      const job = findJobPosting(parsed);
      if (!job) continue;

      const description = htmlToText(job.description);
      // A JobPosting with no usable description is worse than the DOM fallback, so decline it
      // and let the next tier run rather than returning a confident-looking empty record.
      if (description.length < 200) continue;

      return {
        source: 'jsonld',
        title: clean(job.title),
        company: clean(job.hiringOrganization?.name || job.hiringOrganization),
        location: locationFrom(job),
        employmentType: clean([].concat(job.employmentType || []).join(', ')),
        datePosted: clean(job.datePosted),
        descriptionText: [description, htmlToText(job.qualifications), htmlToText(job.responsibilities)]
          .filter(Boolean).join('\n\n'),
      };
    }
    return null;
  }

  function locationFrom(job) {
    if (job.jobLocationType && /telecommute|remote/i.test(String(job.jobLocationType))) return 'Remote';
    const loc = [].concat(job.jobLocation || [])[0];
    const a = loc?.address;
    if (!a) return '';
    return clean([a.addressLocality, a.addressRegion, a.addressCountry?.name || a.addressCountry]
      .filter(Boolean).join(', '));
  }

  // ---- tier 2: OpenGraph and meta tags --------------------------------------

  const meta = (sel) => clean(document.querySelector(sel)?.getAttribute('content'));

  function fromMeta() {
    const description = meta('meta[property="og:description"]') || meta('meta[name="description"]');
    if (description.length < 200) return null;   // meta descriptions are usually a teaser, not a JD
    return {
      source: 'meta',
      title: meta('meta[property="og:title"]') || clean(document.title),
      company: meta('meta[property="og:site_name"]'),
      location: '',
      employmentType: '',
      datePosted: '',
      descriptionText: normalizeBlock(description),
    };
  }

  // ---- tier 3: DOM density heuristic ----------------------------------------

  const CHROME_SEL = 'nav, header, footer, aside, form, script, style, noscript, '
    + '[role="navigation"], [role="banner"], [role="contentinfo"], [role="search"], [aria-hidden="true"]';

  /**
   * Score candidate containers and take the best one.
   *
   * A job description is long, list-heavy, and mostly not links. Page chrome is the opposite:
   * short, dense with anchors. Ranking on (text length + list weight - link text) separates them
   * without knowing anything about the site. The `offsetParent` guard matters here for the same
   * reason it does in discover.js — collapsed menus and off-screen drawers hold a lot of text and
   * would otherwise win on length alone.
   */
  function fromDom() {
    const scored = [];
    for (const el of document.body.querySelectorAll('div, section, article, main, [class*="description"], [class*="job"]')) {
      if (el.closest(CHROME_SEL) || !el.offsetParent) continue;
      const text = clean(el.textContent);
      if (text.length < 400 || text.length > 40000) continue;

      const linkChars = [...el.querySelectorAll('a')].reduce((n, a) => n + clean(a.textContent).length, 0);
      const bullets = el.querySelectorAll('li').length;
      // Prefer the innermost container that still holds the whole description: a parent scores
      // near-identically but drags in siblings, so penalise by descendant element count.
      const bloat = el.querySelectorAll('*').length;
      const score = (text.length - linkChars * 3) + bullets * 60 - bloat * 2;
      if (score > 0) scored.push({ el, score });
    }
    if (!scored.length) return null;

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0].el.cloneNode(true);
    for (const junk of best.querySelectorAll(CHROME_SEL)) junk.remove();
    for (const li of best.querySelectorAll('li')) li.prepend(document.createTextNode('- '));
    for (const el of best.querySelectorAll('p, div, li, br, h1, h2, h3, h4, h5, h6')) {
      el.after(document.createTextNode('\n'));
    }

    return {
      source: 'dom',
      title: bestTitle(),
      company: guessCompany(),
      location: '',
      employmentType: '',
      datePosted: '',
      descriptionText: normalizeBlock(best.textContent),
    };
  }

  /**
   * Best available job title.
   *
   * `document.title` is the last resort, not the second, because ATS platforms wrap it: Greenhouse
   * renders "Job Application for Senior Manager, Business Development at Zocdoc" for a role called
   * "Senior Manager, Business Development". That wrapper text reaches the seniority filter and the
   * tailoring brief, so strip it rather than pass it on.
   */
  function bestTitle() {
    const og = meta('meta[property="og:title"]');
    if (og) return stripTitleChrome(og);
    const h1 = clean(document.querySelector('h1')?.textContent);
    if (h1) return stripTitleChrome(h1);
    return stripTitleChrome(clean(document.title));
  }

  const stripTitleChrome = (s) => clean(String(s)
    .replace(/^job application for\s+/i, '')
    .replace(/^apply (for|to)\s+/i, '')
    .replace(/\s+[-–|]\s+(careers?|jobs?|job board|hiring)\b.*$/i, '')
    .replace(/\s+at\s+[^,]{1,40}$/i, ''));

  // The employer never appears in an ATS vendor's domain. On these hosts the first path segment is
  // the company slug (job-boards.greenhouse.io/zocdoc/jobs/123 -> "zocdoc"), so read the path.
  // Without this every Greenhouse posting is filed under "greenhouse", which would make the
  // tailored-resume company match in pickResume() fire on the wrong job.
  const ATS_HOST = /(greenhouse\.io|lever\.co|ashbyhq\.com|smartrecruiters\.com|workable\.com|breezy\.hr|recruitee\.com|teamtailor\.com|pinpointhq\.com|applytojob\.com|jobvite\.com|bamboohr\.com|join\.com|personio\.de)$/i;

  /** Last-resort company name. Structured data first, then the ATS path, then the domain. */
  function guessCompany() {
    const og = meta('meta[property="og:site_name"]');
    if (og && !ATS_HOST.test(location.hostname)) return og;

    if (ATS_HOST.test(location.hostname)) {
      const seg = location.pathname.split('/').filter(Boolean)[0];
      // "embed" and "jobs" are routing segments on some boards, not company slugs.
      if (seg && !/^(embed|jobs?|job|companies|o|search)$/i.test(seg)) {
        return seg.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      }
    }
    return og
      || clean(document.querySelector('[class*="company"]')?.textContent).slice(0, 60)
      || location.hostname.replace(/^(www|jobs|careers|boards|apply|job-boards)\./, '').split('.')[0];
  }

  // ---- entry point ----------------------------------------------------------

  /**
   * Returns a record, always. `source: 'none'` with an empty description means the page is not a
   * job posting (or is rendered in a way we cannot read), which the popup reports plainly rather
   * than presenting an empty scan as a successful one.
   */
  function extract() {
    const got = fromJsonLd() || fromMeta() || fromDom() || {
      source: 'none', title: '', company: '', location: '',
      employmentType: '', datePosted: '', descriptionText: '',
    };
    // The DOM often knows the title better than a stale og:title, and JSON-LD sometimes omits a
    // field entirely. Backfill without overwriting anything the structured tier was sure about.
    got.title = got.title || bestTitle();
    got.company = got.company || guessCompany();
    got.url = location.href;
    got.host = location.hostname;
    got.descriptionText = String(got.descriptionText || '').slice(0, 30000);
    return got;
  }

  window.__aa_jdExtract = { extract, htmlToText, normalizeBlock, clean };
})();
