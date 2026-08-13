// Orchestrator. Runs on Ashby / Greenhouse / Lever application pages.
//
// Flow: discover -> abort-check -> rule match -> one batched AI call for the leftovers ->
// fill -> verify -> report. Submit happens ONLY when background says auto mode is armed AND
// the verification pass came back clean.

(function () {
  'use strict';

  const { setText, setChecked, setSelect, setCombobox, setFile, readBack, sleep, waitFor } = window.__aa_set;
  const { discover, findSubmit, findApplyButton, clean } = window.__aa_discover;
  const { match, checkAbort } = window.__aa_rules;

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg.type !== 'AA_APPLY') return;
    // One structured line per application, on the ATS page's own console, covering every return
    // path in run(). This is the diagnostic channel: read it with read_console_messages filtered
    // on AA-RESULT. Cheap, and it works on an ordinary https page with no extension access.
    run(msg).then(report).catch((e) => report({ ok: false, error: String(e?.stack || e) })).then(respond);

    function report(r) {
      try { console.log('[AA-RESULT]', JSON.stringify(r)); } catch (e) { console.log('[AA-RESULT] unserializable', String(e)); }
      return r;
    }
    return true; // async
  });

  async function run({ profile, mode, armed, jobContext }) {
    const started = Date.now();
    const log = { url: location.href, mode, armed, fields: [], unmapped: [], filled: 0, skipped: 0 };

    const found = await resolveForm(profile);
    let fields = found.fields;
    if (found.clickedApply) log.clickedApply = found.clickedApply;

    // The apply control was a link to another page. Clicking it here would navigate out from
    // under this content script and kill the run, so hand the URL back and let the service
    // worker drive the hop and re-run us there.
    if (found.retryAt) {
      return { ok: false, retryAt: found.retryAt, reason: 'application form is behind an apply link', log };
    }

    // Workday, Oracle HCM, Taleo and SuccessFactors gate applications behind an account. Creating
    // accounts and typing passwords is out of scope and stays that way - abort and hand it over.
    //
    // Checked AFTER the form is resolved, and only against a *visible* input. Plenty of ATS
    // hosts render a collapsed login form in the page header on every page; matching those
    // aborted good applications before they were ever attempted.
    if ([...document.querySelectorAll('input[type=password]')].some((el) => el.offsetParent)) {
      return { ok: false, aborted: true, needsReview: true,
        reason: 'sign-in wall - this ATS needs an account, apply manually', log };
    }

    if (!fields.length) {
      return { ok: false, needsReview: true,
        reason: log.clickedApply
          ? `no form fields found after clicking "${log.clickedApply}" - the form may be on another page`
          : 'no form fields found and no apply button to click - the application may be on another page',
        log };
    }

    // --- 1. abort conditions, checked before anything is typed -----------
    for (const f of fields) {
      const why = checkAbort(f.question);
      if (why) return { ok: false, aborted: true, reason: why, log };
    }

    // --- 2. rule matching -------------------------------------------------
    const learned = profile.learnedAnswers || {};
    const plan = [];
    for (const f of fields) {
      let m = match(f.question, profile);
      // Questions answered in a previous Claude Code session are permanent - check them before
      // treating anything as unmapped, so the manual tail shrinks with every batch.
      if (!m && learned[f.question] != null && learned[f.question] !== '') {
        m = { id: 'learned', value: String(learned[f.question]) };
      }
      if (!m) {
        if (f.required) log.unmapped.push({ question: f.question, kind: f.kind, options: optTexts(f) });
        else log.skipped++;
        plan.push({ f, m: null });
        continue;
      }
      plan.push({ f, m });
    }

    // --- 3. one batched AI call for unmapped REQUIRED fields --------------
    let aiAnswers = {};
    if (log.unmapped.length) {
      const res = await chrome.runtime.sendMessage({
        type: 'AA_RESOLVE_UNKNOWN',
        questions: log.unmapped,
        jobContext,
      });
      if (!res?.ok) {
        return { ok: false, needsReview: true, reason: `unmapped fields and AI resolve failed: ${res?.error || 'no response'}`, log };
      }
      aiAnswers = res.answers || {};
      log.aiUsed = Object.keys(aiAnswers).length;
    }

    // --- 4. fill ----------------------------------------------------------
    for (const { f, m } of plan) {
      const spec = m || (aiAnswers[f.question] ? { value: aiAnswers[f.question], id: 'ai' } : null);
      if (!spec || spec.skip) continue;
      if (spec.value === '@RESUME' || spec.value === '@COVER_LETTER') {
        const doc = spec.value === '@RESUME'
          ? pickResume(profile, jobContext?.title, jobContext?.company)
          : profile.coverLetterFile;
        if (!doc?.b64) {
          const missing = spec.value === '@RESUME';
          log.fields.push({ q: f.question, want: spec.value, got: null, ok: !missing, note: missing ? 'no resume stored - set one in Options' : 'no cover letter stored (optional)' });
          continue;
        }
        const ok = setFile(f.el, doc);
        log.fields.push({ q: f.question, want: doc.name, got: readBack(f.el), ok, rule: spec.id, kind: f.kind, el: f.el });
        if (ok) log.filled++;
        continue;
      }
      const r = await fillOne(f, spec.value);
      log.fields.push({
        q: f.question, want: spec.value, got: r.got, ok: r.ok, rule: spec.id, note: r.note,
        kind: f.kind, el: f.el, group: f.options,
      });
      if (r.ok) log.filled++;
    }

    // --- 5. verification pass --------------------------------------------
    //
    // A real re-read, not a re-check of the flags set at fill time. React forms revert
    // controlled values on validation and blur, so a field can report a successful write and be
    // empty a moment later. log.verified gates the auto-mode submit below, so this has to look
    // at the page rather than at its own bookkeeping.
    await sleep(800);
    const mismatches = [];
    for (const rec of log.fields) {
      if (!rec.ok) { mismatches.push(rec); continue; }
      const v = reverify(rec);
      rec.verified = v.status;
      if (v.status === 'changed') {
        rec.ok = false;
        rec.got = v.got;
        rec.note = `value did not stick - page now reads "${v.got}"`;
        mismatches.push(rec);
      }
    }

    // DOM nodes are not structured-cloneable and this crosses a message boundary to the
    // service worker. Drop the references now that verification is done.
    log.fields = log.fields.map(({ el, group, ...rest }) => rest);
    log.mismatches = mismatches.map(({ el, group, ...rest }) => rest);
    log.verified = mismatches.length === 0;
    log.unverifiable = log.fields.filter((f) => f.verified === 'unverifiable').length;
    log.ms = Date.now() - started;

    // --- 6. submit gate ---------------------------------------------------
    const requiredUnfilled = plan.filter(({ f, m }) => f.required && !m && !aiAnswers[f.question]);

    // A run that typed nothing is not a success, whatever the verifier concludes - with no
    // fields written there is nothing to mismatch, so verification passes vacuously. On
    // 2026-08-10 two jobs resolved to a LinkedIn page instead of an ATS, matched no rules,
    // filled zero fields and reported "filled and saved - submit is yours". A broken
    // destination has to look different from a working one.
    const filledNothing = log.filled === 0;
    const canSubmit = mode === 'auto' && armed && log.verified && !filledNothing
      && requiredUnfilled.length === 0;

    if (!canSubmit) {
      return {
        ok: true,
        submitted: false,
        needsReview: !log.verified || requiredUnfilled.length > 0 || filledNothing,
        reason: reasonNotSubmitted({ mode, armed, verified: log.verified, requiredUnfilled, filledNothing }),
        log,
      };
    }

    const btn = findSubmit();
    if (!btn) return { ok: true, submitted: false, needsReview: true, reason: 'submit button not found', log };
    btn.click();
    await sleep(3500);
    const confirmation = clean(document.body.innerText).slice(0, 600);
    const looksSubmitted = /success|submitted|thank you|received your application/i.test(confirmation);
    return {
      ok: true,
      submitted: true,
      confirmed: looksSubmitted,
      confirmation,
      log,
    };
  }

  /**
   * Assist mode used to return "filled and saved - submit is yours" for every outcome, including
   * ones flagged for review, so the run log said the same thing whether the fill had worked or
   * not. Assist now reports its own problems.
   */
  function reasonNotSubmitted({ mode, armed, verified, requiredUnfilled, filledNothing }) {
    const unanswered = () => requiredUnfilled.map((x) => x.f.question).join(' | ');

    if (filledNothing) {
      return 'nothing was filled - no field on this page matched the profile, so this is probably not the application form';
    }
    if (mode !== 'auto') {
      if (!verified) return 'filled, but some values did not stick - check the form before submitting';
      if (requiredUnfilled.length) return `filled, but still unanswered: ${unanswered()}`;
      return 'filled and saved - submit is yours';
    }
    if (!armed) return 'full auto expired or capped';
    if (!verified) return 'verification mismatch';
    if (requiredUnfilled.length) return `required fields unanswered: ${unanswered()}`;
    return 'unknown';
  }

  /**
   * Get to the actual application form.
   *
   * Three things this has to survive, all seen on real pages:
   *
   *  - **Late hydration.** The service worker waits for `complete` plus 900ms, which is not
   *    enough for a slow careers site. One look found nothing on a Ralph Lauren job page that
   *    demonstrably had an Apply link. Poll instead of glancing.
   *  - **Page chrome that looks like a form.** A job description page can carry a search box, a
   *    language picker and a cookie dialog. Counting fields is therefore the wrong test; the
   *    right one is whether any field matches something we can actually answer.
   *  - **Apply controls that are links.** Clicking an `<a href>` navigates, which tears down this
   *    content script mid-run. Those are handed back to the service worker as `retryAt` instead.
   */
  async function resolveForm(profile) {
    const learned = profile.learnedAnswers || {};
    const answerable = (fs) => fs.filter((f) => match(f.question, profile) || learned[f.question] != null);

    let fields = await waitFor(() => { const f = discover(); return f.length ? f : null; }, 6000) || [];
    if (answerable(fields).length) return { fields, clickedApply: null };

    const btn = await waitFor(() => findApplyButton(), 3000);
    if (!btn) return { fields, clickedApply: null };

    const label = clean(btn.textContent) || 'apply';
    const href = btn.tagName === 'A' ? btn.href : null;
    if (href && !/^javascript:/i.test(href) && href.split('#')[0] !== location.href.split('#')[0]) {
      return { fields, clickedApply: label, retryAt: href };
    }

    btn.click();
    await sleep(1200);
    const after = await waitFor(() => {
      const f = discover();
      return answerable(f).length ? f : null;
    }, 9000);
    return { fields: after || discover(), clickedApply: label };
  }

  /**
   * Read a filled field back off the page and say whether it still holds what was committed.
   *
   * Compares against what was actually committed (`rec.got`), not what was asked for (`rec.want`).
   * A combobox gazetteer legitimately resolves "Fresh Meadows" to "New York City"; that was
   * accepted at fill time and must not be re-flagged here.
   *
   * Returns 'unverifiable' rather than 'ok' where the DOM genuinely cannot be read back -
   * Ashby-style Yes/No <button>s carry no checked state. Those are counted separately so the
   * run log never implies a verification that did not happen.
   */
  function reverify(rec) {
    const txt = (s) => String(s ?? '').trim().toLowerCase();
    // Loose compare for the second pass: forms reformat what you type. Greenhouse stored
    // "917-887-1991" as "9178871991", which a strict compare reported as a value that did not
    // stick. Same characters in the same order still counts as stuck.
    const loose = (s) => txt(s).replace(/[^a-z0-9]/g, '');
    const same = (a, b) => txt(a) === txt(b) || (loose(a) !== '' && loose(a) === loose(b));

    if (rec.kind === 'buttonpair') return { status: 'unverifiable' };

    if (rec.kind === 'radio') {
      const picked = (rec.group || []).find((o) => o.el?.checked);
      if (!picked) return { status: 'changed', got: '(nothing selected)' };
      return same(picked.text, rec.got) ? { status: 'ok' } : { status: 'changed', got: picked.text };
    }

    if (!rec.el || !rec.el.isConnected) return { status: 'unverifiable' };

    const now = readBack(rec.el);
    return same(now, rec.got) ? { status: 'ok' } : { status: 'changed', got: now };
  }

  async function fillOne(f, value) {
    try {
      if (f.kind === 'text') {
        const ok = setText(f.el, value);
        return { ok, got: readBack(f.el) };
      }
      if (f.kind === 'select') {
        const ok = setSelect(f.el, value);
        return { ok, got: readBack(f.el) };
      }
      if (f.kind === 'combobox') {
        const r = await setCombobox(f.el, value);
        // A gazetteer may legitimately resolve to a broader place. Record what was committed.
        return { ok: r.ok, got: r.committed, note: r.ok && !r.exact ? `resolved to "${r.committed}"` : r.reason };
      }
      if (f.kind === 'checkbox') {
        const want = /^(yes|true|1)$/i.test(value);
        const ok = setChecked(f.el, want);
        return { ok, got: String(f.el.checked) };
      }
      if (f.kind === 'radio' || f.kind === 'buttonpair') {
        const target = pickOption(f.options, value);
        if (!target) return { ok: false, got: null, note: `no option matching "${value}"` };
        if (f.kind === 'radio') {
          const ok = setChecked(target.el, true);
          return { ok, got: target.text };
        }
        target.el.click();
        await sleep(120);
        return { ok: true, got: target.text };
      }
      return { ok: false, got: null, note: `unhandled kind ${f.kind}` };
    } catch (e) {
      return { ok: false, got: null, note: String(e) };
    }
  }

  /**
   * Pick a pre-rendered resume variant by job title. All are one page and all pass the
   * anti-fabrication check; only the Summary differs. Falls back to product, then to any variant
   * that exists, so a partially-configured profile still attaches something real.
   *
   * A tailored PDF wins when it was built for THIS job. The company match is required rather
   * than assumed: `resumes.tailored` is a single slot, so without the check a resume tailored to
   * one posting would silently attach to every posting after it - worse than the generic variant,
   * because it reads as targeted and names the wrong problem.
   */
  function pickResume(profile, title = '', company = '') {
    const r = profile.resumes || {};
    const t = String(title).toLowerCase();

    const tailored = r.tailored;
    if (tailored?.b64) {
      const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const a = norm(tailored.forCompany);
      const b = norm(company);
      // Substring either way: "Zocdoc" against "Zocdoc, Inc." must still match.
      if (a && b && (a.includes(b) || b.includes(a))) return tailored;
    }

    const isProject = /project manager|program manager|\btpm\b|scrum|delivery manager|program\/project|technical program/.test(t);
    const key = isProject ? 'project' : 'product';
    return r[key]?.b64 ? r[key] : (r.product?.b64 ? r.product : Object.values(r).find((v) => v?.b64) || null);
  }

  /** Match an answer to one of the presented options, tolerantly. */
  function pickOption(options, value) {
    const norm = (s) => String(s).trim().toLowerCase();
    const v = norm(value);
    return (
      options.find((o) => norm(o.text) === v) ||
      options.find((o) => norm(o.text).startsWith(v)) ||
      options.find((o) => norm(o.text).includes(v)) ||
      // "No, I don't have a disability..." should match a plain "No"
      options.find((o) => norm(o.text).split(/[,.]/)[0].trim() === v) ||
      null
    );
  }

  const optTexts = (f) => (f.options || []).map((o) => o.text);
})();
