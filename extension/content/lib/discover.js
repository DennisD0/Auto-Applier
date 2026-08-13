// Field discovery — turn an arbitrary ATS form into a list of {question, control(s), kind}.
//
// This is what makes the extension generic instead of per-company. Ashby, Greenhouse and Lever
// all render "Are you legally authorized to work in the United States?" differently in markup
// but identically in meaning. We key off the QUESTION TEXT, not the DOM structure.

(function () {
  'use strict';

  const IGNORE_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image']);

  /** Best-effort label text for a control. Tries cheapest reliable sources first. */
  function labelFor(el) {
    // 1. Explicit <label for="...">
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) return clean(l.textContent);
    }
    // 2. Wrapping <label>
    const wrap = el.closest('label');
    if (wrap) return clean(wrap.textContent);
    // 3. ARIA
    if (el.getAttribute('aria-label')) return clean(el.getAttribute('aria-label'));
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const parts = lb.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean);
      if (parts.length) return clean(parts.map((p) => p.textContent).join(' '));
    }
    // 4. Walk up to a field container and take its leading text
    let node = el;
    for (let i = 0; i < 5 && node; i++) {
      node = node.parentElement;
      if (!node) break;
      const own = leadingText(node, el);
      if (own && own.length > 3) return own;
    }
    // `id` last, and it earns its place. Greenhouse renders the resume upload as a bare
    // `input#resume[type=file]` with no <label>, no aria-label, and no text in any ancestor — the
    // visible "Attach" control is a sibling button. Every source above returns '', the field is
    // dropped by the `f.question` filter at the end of discover(), and the whole application goes
    // out with no resume attached while reporting success. Measured on a live Volexity/Greenhouse
    // form 2026-08-13. The id is "resume", which the rules table matches directly.
    return el.name || el.placeholder || el.id || '';
  }

  // A generic label tells you how to operate the control, not what it is for.
  const GENERIC_FILE_LABEL = /^(attach|attached|upload|uploaded|choose file|browse|select file|add file|attach file)$/i;

  // "Dennis Do - Scrum Master.pdf" is a widget state readout, not a question.
  const FILENAME = /\.(pdf|docx?|rtf|txt|odt|pages)$/i;

  /**
   * What a file input is actually asking for.
   *
   * File inputs are labelled by their button rather than their purpose. Greenhouse gives BOTH the
   * resume and the cover-letter inputs `<label class="visually-hidden" for="...">Attach</label>`,
   * so labelFor() returns "Attach" for each, the rules table matches neither, and the application
   * goes out with **no resume attached** while reporting success. Measured on a live
   * Volexity/Greenhouse form 2026-08-13; this is why the first two end-to-end runs filled 7 and 9
   * fields with the resume silently missing.
   *
   * So climb to the upload wrapper, whose leading text is the real heading ("Resume/CV", "Cover
   * Letter"), and keep the id, which is unambiguous even when the wrapper text is not.
   */
  function fileQuestion(el) {
    const label = labelFor(el);
    // Always carry the id and name. A file input's visible text is whatever the widget is
    // currently saying, which after an upload is the FILENAME - measured on Breezy, where
    // labelFor() returned "Dennis Do - Scrum Master.pdf" on a revisit, matched no rule, and
    // dropped the resume from the run with no error. The id/name never change with widget state.
    if (label && !GENERIC_FILE_LABEL.test(label) && !FILENAME.test(label)) {
      return clean(`${label} ${ident(el)}`);
    }

    let node = el;
    for (let i = 0; i < 6 && node.parentElement; i++) {
      node = node.parentElement;
      const lead = leadingText(node, el);
      if (lead && !GENERIC_FILE_LABEL.test(lead.split(' ')[0])) {
        return clean(`${lead} ${ident(el)}`);
      }
    }
    return clean(`${label} ${ident(el)}`);
  }

  /**
   * Both `id` AND `name`, because either one alone can be the uninformative one.
   *
   * Breezy's resume input is `id="main-attachment" name="cResume"` - the id says nothing and the
   * name says everything. Appending only `el.id || el.name` picked the id, the question never
   * contained "resume", the rule never matched, and the field vanished from the run without an
   * error. The surrounding text does carry "Upload Resume", but only until something is attached,
   * after which it reads "Attached <filename>" - so it cannot be the thing this depends on.
   */
  const ident = (el) => clean(`${el.id || ''} ${el.name || ''}`);

  // Inline validation and hint text sits in the DOM alongside the real label and is not part of
  // the question. Breezy renders all of it up front, before anything is typed.
  const NOISE = /(is required|are required|required field|please enter|please select|must be|invalid|^\*$|^required$|^optional$)/i;

  /** Controls whose presence means the text before them belonged to THEM, not to `el`. */
  function isControl(node) {
    if (node.nodeType !== 1) return false;
    const tag = node.tagName;
    if (tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') return false;
    return !IGNORE_TYPES.has(node.type);
  }

  /**
   * The question text for `el` — the text between the PREVIOUS control and this one.
   *
   * This used to collect every text node in `container` preceding `el` and join the lot. In a
   * container holding several inputs that makes each field's question swallow all the ones above
   * it, so on a live Breezy form the questions came out as "Personal Details Full Name", then
   * "...Full Name A full name is required Email Address", then "...An email is required Phone
   * Number". Every one of them still contained "Full Name", so the full-name rule matched all
   * three and wrote "Gyeonghwan Do" into the name, email AND phone inputs — each reported ok,
   * because the value did stick, just in the wrong field. Measured on Sports Reference 2026-08-13.
   *
   * So: reset the buffer every time the walk passes another control. Whatever text preceded that
   * control describes it, not us.
   */
  function leadingText(container, el) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let out = [];
    let n;
    while ((n = walker.nextNode())) {
      if (n === el) break;
      if (n.nodeType === 1) {
        // Ancestors of `el` are on the path to it and describe nothing on their own.
        if (n.contains(el)) continue;
        if (isControl(n)) out = [];   // that text belonged to the control we just passed
        continue;
      }
      if (el.contains(n)) continue;
      const t = clean(n.textContent);
      if (t && !NOISE.test(t)) out.push(t);
    }
    // A question this long is a sign the scoping failed; keep the tail, which is nearest the input.
    const joined = clean(out.join(' '));
    return joined.length > 120 ? clean(joined.slice(-120)) : joined;
  }

  const clean = (s) => String(s || '').replace(/\s+/g, ' ').replace(/\*$/, '').trim();

  /**
   * Group radios by name so "Yes/No" pairs come through as ONE question with two options,
   * not two questions. Ashby renders Yes/No as <button>s, so we catch those too.
   */
  function discover(root = document) {
    const fields = [];
    const seenRadioGroups = new Set();

    const controls = [...root.querySelectorAll('input, textarea, select')].filter((el) => {
      if (IGNORE_TYPES.has(el.type)) return false;
      if (el.disabled || el.readOnly) return false;
      if (!el.offsetParent && el.type !== 'file') return false; // not visible
      return true;
    });

    for (const el of controls) {
      if (el.type === 'radio') {
        const key = el.name || labelFor(el);
        if (seenRadioGroups.has(key)) continue;
        seenRadioGroups.add(key);
        const group = [...root.querySelectorAll(`input[type=radio][name="${CSS.escape(el.name)}"]`)];
        fields.push({
          kind: 'radio',
          question: groupQuestion(group) || labelFor(el),
          options: group.map((r) => ({ el: r, text: labelFor(r) })),
          required: group.some((r) => r.required),
        });
        continue;
      }
      fields.push({
        kind: el.tagName === 'SELECT' ? 'select'
          : el.type === 'file' ? 'file'
          : el.type === 'checkbox' ? 'checkbox'
          : el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete') ? 'combobox'
          : 'text',
        question: el.type === 'file' ? fileQuestion(el) : labelFor(el),
        el,
        inputType: el.type,
        required: el.required || el.getAttribute('aria-required') === 'true',
      });
    }

    // Ashby-style Yes/No rendered as buttons rather than radios.
    for (const pair of buttonPairs(root)) fields.push(pair);

    return fields.filter((f) => f.question);
  }

  /** The shared question text for a radio group is the text above the whole group. */
  function groupQuestion(group) {
    if (!group.length) return '';
    let container = group[0];
    for (let i = 0; i < 6 && container.parentElement; i++) {
      container = container.parentElement;
      if (group.every((g) => container.contains(g))) break;
    }
    // The heading usually sits ABOVE the element that wraps the options rather than inside it, so
    // the smallest common ancestor often contains no text at all. Keep climbing until one yields
    // something. Without this the group question comes back empty, discover() falls back to
    // labelFor(firstRadio), and the question is recorded as the first OPTION - literally "A" for
    // an A/B/C/D group, and "May/June 2026 (recent graduate)" for a graduation-date question.
    // Both sat in the pending queue unanswerable, because what was being asked was never captured.
    for (let i = 0; i < 4 && container; i++) {
      const q = leadingText(container, group[0]);
      if (q) return q;
      container = container.parentElement;
    }
    return '';
  }

  /** Find Yes/No (and similar) button groups that behave as radios. */
  function buttonPairs(root) {
    const out = [];
    const groups = new Map();
    for (const b of root.querySelectorAll('button')) {
      const t = clean(b.textContent);
      if (!/^(yes|no)$/i.test(t)) continue;
      if (!b.offsetParent) continue;
      const parent = b.parentElement;
      if (!groups.has(parent)) groups.set(parent, []);
      groups.get(parent).push({ el: b, text: t });
    }
    for (const [parent, options] of groups) {
      if (options.length < 2) continue;
      let container = parent;
      for (let i = 0; i < 5 && container.parentElement; i++) container = container.parentElement;
      out.push({
        kind: 'buttonpair',
        question: leadingText(container, parent),
        options,
        required: true,
      });
    }
    return out;
  }

  /** Ashby / Greenhouse / Lever all label their submit differently. */
  function findSubmit(root = document) {
    const cands = [...root.querySelectorAll('button, input[type=submit]')];
    const rx = /^(submit application|submit|apply|send application)$/i;
    return cands.find((b) => rx.test(clean(b.textContent) || b.value || '') && b.offsetParent) || null;
  }

  /**
   * The button that OPENS the form, as opposed to the one that submits it.
   *
   * Greenhouse, Lever, SmartRecruiters and many others show only a job description with an
   * "Apply" button; the form is behind it. Without this, discover() finds nothing and the run
   * reports "no form fields" on hosts that work perfectly well.
   *
   * Deliberately narrow. It must not match the submit button, so anything containing "submit"
   * is out, and the match is on the whole trimmed label rather than a substring — "Apply" is a
   * common word in page chrome ("Apply filters", "Apply to 5 similar jobs").
   */
  // Matching a fixed list of exact strings was too brittle. Breezy labels its control "Apply To
  // Position", which matched none of them, so a form that was one click away reported "no form
  // fields found and no apply button to click" — measured on Sports Reference 2026-08-13.
  //
  // So: anything that STARTS with "apply" and is short, minus the page chrome that also does.
  // "Apply filters", "Apply to 5 similar jobs" and "Apply all" are the ones that bite.
  const APPLY_START = /^apply\b/i;
  const APPLY_ALT = /^(start (your )?application|i'?m interested|join our team|continue to application)$/i;
  const NOT_APPLY = /submit|filters?|coupon|promo|discount|changes|settings|similar|\ball\b|\d+\s+jobs?\b/i;

  function findApplyButton(root = document) {
    const cands = [...root.querySelectorAll('button, a, input[type=button]')];
    return cands.find((b) => {
      const t = clean(b.textContent) || b.value || b.getAttribute('aria-label') || '';
      if (!t || t.length > 40) return false;
      if (NOT_APPLY.test(t)) return false;
      return (APPLY_START.test(t) || APPLY_ALT.test(t)) && b.offsetParent;
    }) || null;
  }

  window.__aa_discover = { discover, findSubmit, findApplyButton, labelFor, clean };
})();
