// React-safe value setting.
//
// Ashby and Greenhouse are React apps. Assigning `el.value = x` updates the DOM node but NOT
// React's internal state, so the field LOOKS filled and submits EMPTY. This is the single most
// common reason a homemade autofill extension silently fails.
//
// The fix is to call the native property setter from the prototype (which React's synthetic
// event system observes) and then dispatch the events React listens for.

(function () {
  'use strict';

  function nativeSet(el, value) {
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  function fire(el, ...types) {
    for (const t of types) el.dispatchEvent(new Event(t, { bubbles: true }));
  }

  /**
   * Set a text/email/tel/url/textarea/date value so React registers it.
   *
   * `blur: false` is required when typing INTO a combobox. Greenhouse uses react-select, whose
   * menu opens on input and closes on blur, so the trailing blur here was destroying the very
   * list setCombobox then waited for — every combobox on the form reported "no options appeared"
   * while the typing itself had worked. Measured on a live Volexity/Greenhouse form 2026-08-13.
   */
  function setText(el, value, { blur = true } = {}) {
    el.focus();
    nativeSet(el, '');
    fire(el, 'input');
    nativeSet(el, String(value));
    fire(el, 'input', 'change');
    if (blur) {
      el.blur();
      fire(el, 'blur');
    }

    // Forms reformat as you type. Greenhouse stores "917-887-1991" as "9178871991", which a
    // strict compare called a failed write — and a field marked failed at fill time never gets
    // a second look in the verification pass, so it stayed wrong. Same characters in the same
    // order counts as written.
    const want = String(value);
    const got = readBack(el);
    const loose = (s) => String(s).trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    return got === want || (loose(want) !== '' && loose(got) === loose(want));
  }

  /** Check a radio or checkbox. */
  function setChecked(el, checked = true) {
    if (el.checked === checked) return true;
    el.focus();
    el.click(); // click is what React radio groups actually listen to
    if (el.checked !== checked) {
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, 'checked');
      if (desc && desc.set) desc.set.call(el, checked);
      fire(el, 'click', 'input', 'change');
    }
    return el.checked === checked;
  }

  /** Select an <option> by visible text or value, case-insensitive, trimmed. */
  function setSelect(el, wanted) {
    const norm = (s) => String(s).trim().toLowerCase();
    const target = norm(wanted);
    let hit = [...el.options].find((o) => norm(o.textContent) === target || norm(o.value) === target);
    if (!hit) hit = [...el.options].find((o) => norm(o.textContent).includes(target));
    if (!hit) return false;
    nativeSet(el, hit.value);
    fire(el, 'input', 'change');
    return norm(el.selectedOptions[0]?.textContent) === norm(hit.textContent);
  }

  /**
   * Typeahead comboboxes (Ashby's location field). Type, wait for the listbox, pick the best
   * option. Returns the text actually committed, which may differ from what was asked for —
   * gazetteers are city-level, so "Fresh Meadows" legitimately resolves to "New York City".
   */
  async function setCombobox(el, wanted, { timeout = 4000 } = {}) {
    const norm = (s) => String(s).trim().toLowerCase();
    const target = norm(wanted);

    // Options are frequently rendered into a portal at the end of <body>, not inside the
    // control's own subtree, so scan the whole document rather than a container we guessed at.
    const readOptions = () => {
      const o = [...document.querySelectorAll('[role="option"]')].filter((x) => x.offsetParent);
      return o.length ? o : null;
    };

    // Typing is the primary way in, not a fallback.
    //
    // Greenhouse's comboboxes are react-select: the element carrying id/role is a 4px-wide hidden
    // input, and the widget only opens from a TRUSTED mouse event on the .select__control wrapper.
    // A content script cannot forge one — verified 2026-08-13 that a real click opens the Country
    // menu (aria-expanded true, 244 options) while synthetic click and mousedown on both the input
    // and the wrapper leave it closed. Typing does open it, because react-select reacts to the
    // input event. So type first and keep focus; the click below is only for the widgets that
    // genuinely open on click and populate nothing until they do.
    el.focus();
    el.click();
    let opts = await waitFor(readOptions, 600);

    if (!opts || opts.length > 1) {
      setText(el, wanted, { blur: false });
      opts = await waitFor(() => {
        const o = readOptions();
        if (!o) return null;
        // Wait for the list to actually filter down to the typed text where it can.
        return o.some((x) => norm(x.textContent).includes(target)) || o.length <= 12 ? o : null;
      }, timeout) || opts;
    }

    // Greenhouse keeps its whole country list in the DOM and hides it until the listbox opens,
    // so "no visible options" does not mean the write failed. Ask the control what it holds
    // before calling this a failure — a typeahead that accepted the text is done.
    const settled = () => {
      const got = readBack(el);
      const loose = (s) => norm(s).replace(/[^a-z0-9]/g, '');
      return loose(got) !== '' && loose(got) === loose(wanted)
        ? { ok: true, committed: got, exact: norm(got) === target, reason: 'accepted as typed' }
        : null;
    };

    if (!opts?.length) {
      // Do NOT trust settled() here. On react-select the typed text sits in the input and is
      // discarded on blur, so "accepted as typed" was a false pass that reported a filled field
      // and submitted an empty one. Go to the page's own JS world and commit properly instead.
      const viaReact = await reactPick(el, wanted);
      if (viaReact.ok) return { ok: true, committed: viaReact.committed, exact: norm(viaReact.committed) === target, via: 'react' };
      return settled() || { ok: false, committed: null, reason: viaReact.reason || 'no options appeared' };
    }

    const pick = opts.find((o) => norm(o.textContent) === target)
      || opts.find((o) => norm(o.textContent).startsWith(target))
      || opts.find((o) => norm(o.textContent).includes(target))
      || opts.find((o) => target.includes(norm(o.textContent)) && norm(o.textContent).length > 2);

    // Never settle for whatever happened to be first. This used to fall back to opts[0], which
    // in auto mode would submit an arbitrary answer to a question nobody answered — worse than
    // leaving it blank and routing the application to review.
    if (!pick) {
      return settled() || {
        ok: false, committed: null,
        reason: `no option matches "${wanted}" (offered: ${opts.slice(0, 6).map((o) => o.textContent.trim()).join(' / ')})`,
      };
    }

    const committed = pick.textContent.trim();
    pick.click();
    await sleep(200);
    return { ok: true, committed, exact: norm(committed) === target };
  }

  /**
   * Attach a file to <input type=file>. You cannot assign to `input.files` directly, but you
   * CAN build a DataTransfer and hand over its FileList — which is how a real drop works, so
   * React and Ashby's uploader both accept it. Bytes come from chrome.storage as base64.
   */
  function setFile(el, { name, mime, b64 }) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], name, { type: mime || 'application/pdf' });
    const dt = new DataTransfer();
    dt.items.add(file);
    el.files = dt.files;
    fire(el, 'input', 'change');
    return el.files.length === 1 && el.files[0].name === name;
  }

  function readBack(el) {
    if (el.type === 'file') return el.files?.[0]?.name ?? '';
    if (el.type === 'checkbox' || el.type === 'radio') return el.checked ? 'true' : 'false';
    if (el.tagName === 'SELECT') return el.selectedOptions[0]?.textContent.trim() ?? '';

    // react-select CLEARS its input once a selection commits and renders the chosen value into a
    // sibling div instead. Reading el.value there returns "" for a write that landed perfectly,
    // so the verification pass marked Country, Location, Gender, Veteran Status and Disability
    // Status as "value did not stick" on a form where all five were correct. That matters beyond
    // cosmetics: log.verified gates the auto-mode submit, so this alone made auto mode unable to
    // submit anything on Greenhouse. Measured 2026-08-13.
    const rendered = selectedValueOf(el);
    if (rendered) return rendered;

    return el.value;
  }

  /**
   * Ask the background to commit this combobox from the page's MAIN world.
   *
   * React's fiber is an expando on the DOM node and expandos do not cross into a content script's
   * isolated world, so the selection has to happen over there. Attributes DO cross, which is how
   * the target is identified. The marker is always removed, including on failure, so a stale
   * data-aa-combo can never make a later field pick the wrong control.
   */
  async function reactPick(el, wanted) {
    el.setAttribute('data-aa-combo', '1');
    try {
      const res = await chrome.runtime.sendMessage({ type: 'AA_REACT_PICK', wanted });
      const r = res?.result || {};
      if (r.ok) await sleep(300);   // let React re-render before the caller reads back
      return r;
    } catch (e) {
      return { ok: false, reason: `MAIN-world pick failed: ${String(e?.message || e)}` };
    } finally {
      el.removeAttribute('data-aa-combo');
    }
  }

  /** The committed display value of a react-select style widget, or '' if this isn't one. */
  function selectedValueOf(el) {
    const shell = el.closest('[class*="select__control"], [class*="select-shell"], [class*="select__value-container"]');
    if (!shell) return '';
    const node = shell.querySelector('[class*="singleValue"], [class*="single-value"], [class*="multiValue"], [class*="multi-value"]');
    return node ? String(node.textContent || '').replace(/\s+/g, ' ').trim() : '';
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, timeout = 3000, step = 100) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(step);
    }
    return null;
  }

  window.__aa_set = { setText, setChecked, setSelect, setCombobox, setFile, readBack, sleep, waitFor };
})();
