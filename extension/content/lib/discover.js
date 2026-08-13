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
  const GENERIC_FILE_LABEL = /^(attach|upload|choose file|browse|select file|add file|attach file)$/i;

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
    if (label && !GENERIC_FILE_LABEL.test(label)) return label;

    let node = el;
    for (let i = 0; i < 6 && node.parentElement; i++) {
      node = node.parentElement;
      const lead = leadingText(node, el);
      if (lead && !GENERIC_FILE_LABEL.test(lead.split(' ')[0])) {
        return clean(`${lead} ${el.id || el.name || ''}`);
      }
    }
    return clean(`${label} ${el.id || el.name || ''}`);
  }

  /** Text inside `container` that appears before `el` — i.e. the question above the input. */
  function leadingText(container, el) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const out = [];
    let n;
    while ((n = walker.nextNode())) {
      if (el.contains(n) || n.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING) continue;
      const t = clean(n.textContent);
      if (t) out.push(t);
      if (out.join(' ').length > 220) break;
    }
    return clean(out.join(' '));
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
    return leadingText(container, group[0]);
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
