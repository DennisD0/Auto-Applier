const send = (m) => chrome.runtime.sendMessage(m);

// Naming the missing element turns "Cannot set properties of null" into something actionable.
// The usual cause is a stale load: popup.html and popup.js reloaded at different times.
const $ = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id} in popup.html — reload the extension at chrome://extensions`);
  return el;
};
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// Inline SVG rather than emoji — consistent stroke, themeable via currentColor.
const ICON = {
  assist: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
  armed:  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m9 12 2 2 4-4"/></svg>',
  halt:   '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/></svg>',
};

// What the segmented control shows, which can differ from what's saved: selecting Full auto
// reveals its settings but does not enable it until Start is pressed.
let pendingMode = null;

function humanLeft(iso) {
  const ms = Date.parse(iso) - Date.now();
  if (!(ms > 0)) return 'expired';
  const h = Math.floor(ms / 3600e3);
  const m = Math.floor((ms % 3600e3) / 60e3);
  return h ? `${h}h ${m}m left` : `${m}m left`;
}

async function refresh() {
  const { state, arm } = await send({ type: 'AA_STATUS' });
  const live = state.mode === 'auto' && arm.ok;
  const shown = pendingMode ?? (live ? 'auto' : 'assist');

  // --- segmented control -------------------------------------------------
  $('modeAssist').setAttribute('aria-pressed', String(shown === 'assist'));
  const autoBtn = $('modeAuto');
  autoBtn.setAttribute('aria-pressed', String(shown === 'auto'));
  autoBtn.classList.toggle('auto-on', live);
  $('autopanel').classList.toggle('show', shown === 'auto' && !live);

  // --- status banner -----------------------------------------------------
  let cls, icon, title, sub;
  if (state.halt) {
    cls = 'is-halt'; icon = ICON.halt;
    title = 'Halted';
    sub = 'Everything is stopped, including any active full-auto window.';
  } else if (live) {
    cls = 'is-armed'; icon = ICON.armed;
    title = 'Full auto — submitting';
    sub = `${arm.remaining} submit${arm.remaining === 1 ? '' : 's'} left · ${humanLeft(arm.until)}`;
  } else {
    cls = 'is-assist'; icon = ICON.assist;
    title = 'Assist — will not submit';
    sub = state.mode === 'auto'
      ? `Full auto ended: ${arm.reason}`
      : 'Fills each application, saves the tab, moves to the next.';
  }
  $('status').className = `status ${cls}`;
  $('statusIcon').innerHTML = icon;
  $('statusTitle').textContent = title;
  $('reason').textContent = sub;

  $('halt').textContent = state.halt ? 'Clear halt' : 'Halt all automation';

  const mm = $('minMatch');
  if (document.activeElement !== mm) mm.value = state.minMatchPct ?? 70;
  showEligible(state.minMatchPct ?? 70);

  // --- log ----------------------------------------------------------------
  const log = (state.runLog || []).filter((e) => e.jobId);
  const submitted = log.filter((e) => e.submitted).length;
  const review = log.filter((e) => e.needsReview).length;
  $('counts').textContent = log.length ? `${submitted} submitted · ${review} to review` : '';

  $('log').innerHTML = log.slice(0, 25).map((e) => {
    const kind = e.submitted ? 'ok' : e.needsReview ? 'review' : 'no';
    const tag = e.submitted ? (e.confirmed ? 'Submitted' : 'Sent, unconfirmed')
      : e.needsAccount ? 'Needs account'
      : e.needsReview ? 'Needs you' : 'Filled';
    const meta = [
      e.company,
      e.matchPct != null ? `${e.matchPct}%` : null,
      e.filled ? `${e.filled} fields` : null,
      e.mismatches?.length ? `${e.mismatches.length} did not stick` : null,
      e.unverifiable ? `${e.unverifiable} unverifiable` : null,
      e.needsAccount ? 'sign-in wall' : null,
      // Only worth saying when it is a surprise. A known ATS is the expected case.
      e.atsKnown === false ? 'unknown ATS' : null,
      e.ms ? `${(e.ms / 1000).toFixed(1)}s` : null,
    ].filter(Boolean).join(' · ');
    return `<div class="log-row">
      <span class="dot ${kind}" aria-hidden="true"></span>
      <div class="grow">
        <div class="between">
          <span class="log-title truncate">${esc(e.title || 'Untitled role')}</span>
          <span class="row" style="gap:var(--s1)">
            <span class="tag ${kind}">${tag}</span>
            <button class="del" data-at="${esc(e.at)}" title="Remove and allow retry"
                    aria-label="Remove ${esc(e.title || 'this run')} and allow retry">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
                   stroke-width="2" stroke-linecap="round" aria-hidden="true">
                <path d="M18 6 6 18M6 6l12 12"/></svg>
            </button>
          </span>
        </div>
        <div class="log-meta">${esc(meta)}</div>
        ${e.reason ? `<div class="log-meta">${esc(e.reason)}</div>` : ''}
      </div>
    </div>`;
  }).join('') || '<div class="empty">No runs yet. Open your Jobright recommendations, then Run.</div>';

  for (const b of document.querySelectorAll('.del')) {
    b.onclick = async () => {
      await send({ type: 'AA_DELETE_RUN', at: b.dataset.at });
      refresh();
    };
  }
}

/** Show how many jobs the current threshold admits, read live. A number you can't judge is noise. */
async function showEligible(min) {
  const hint = $('matchHint');
  // Goes through the background so content-script injection is handled in one place.
  const res = await send({ type: 'AA_PREVIEW' }).catch(() => null);
  if (!res?.ok) {
    hint.textContent = 'Open your Jobright recommendations tab to see matches.';
    return;
  }
  const jobs = res.jobs || [];
  const ok = jobs.filter((j) => (j.matchPct ?? 0) >= min);
  const best = jobs.map((j) => j.matchPct ?? 0).sort((a, b) => b - a)[0] ?? 0;
  hint.textContent = ok.length
    ? `${ok.length} of ${jobs.length} loaded jobs qualify. Running scrolls for more.`
    : `None of ${jobs.length} loaded jobs qualify. Best is ${best}%.`;
}

// ---- this page: read the posting, then hand it to Claude Code --------------
//
// The whole path is local. Extraction and scoring are plain DOM and string work in
// content/lib/jd-{extract,parse}.js, and the rewriting goes through the clipboard to a Claude
// Code session. No API key is involved at any point, by design.

let lastScan = null;

const SOURCE_LABEL = {
  jsonld: 'structured data',
  meta: 'page metadata',
  dom: 'page markup',
};

function renderScan({ jd, scan }) {
  lastScan = { jd, scan };
  $('jdPanel').classList.add('show');
  $('jdHint').textContent = '';
  $('jdSource').textContent = SOURCE_LABEL[jd.source] || jd.source;

  $('jdTitle').textContent = jd.title || 'Untitled posting';
  $('jdCompany').textContent = [jd.company, jd.location].filter(Boolean).join(' · ') || jd.host;

  const v = $('jdVerdict');
  v.className = `verdict ${scan.verdict}`;
  v.textContent = { apply: 'Worth tailoring', review: 'Read it first', skip: 'Skip' }[scan.verdict] || scan.verdict;

  // Blockers before flags: a blocker means a rule Dennis already decided says no, and burying
  // that under advisory notes is how a skip gets applied to anyway.
  $('jdReasons').innerHTML = [
    ...scan.blockers.map((b) => `<li class="bad">${esc(b)}</li>`),
    ...scan.flags.map((f) => `<li>${esc(f)}</li>`),
  ].join('') || '<li>Nothing flagged. Seniority and excluded skills both check out.</li>';

  // Evidence, not just a verdict — a hard excluded-skill call is worth being able to audit.
  $('jdQuotes').innerHTML = (scan.excluded || [])
    .filter((h) => h.hard)
    .map((h) => `<p class="quote">${esc(h.label)}: ${esc(h.quote)}</p>`).join('');

  $('jdChips').innerHTML = (scan.matched || []).slice(0, 14)
    .map((m) => `<span class="chip">${esc(m.term)}</span>`).join('');

  $('copyBrief').disabled = false;
}

$('scan').onclick = async () => {
  const btn = $('scan');
  btn.disabled = true;
  btn.textContent = 'Reading…';
  const r = await send({ type: 'AA_JD_SCAN' }).catch((e) => ({ ok: false, error: String(e) }));
  btn.disabled = false;
  btn.textContent = 'Tailor for this page';

  if (!r?.ok) {
    $('jdPanel').classList.remove('show');
    $('jdSource').textContent = '';
    $('jdHint').textContent = r?.error || 'Could not read this page.';
    return;
  }
  renderScan(r);
};

$('copyBrief').onclick = async () => {
  if (!lastScan) return;
  const r = await send({ type: 'AA_JD_BRIEF', ...lastScan });
  if (!r?.ok) { alert(r?.error || 'Could not build the brief.'); return; }
  await navigator.clipboard.writeText(r.text);
  const btn = $('copyBrief');
  btn.textContent = 'Copied — run /tailor';
  setTimeout(() => (btn.textContent = 'Copy tailoring brief'), 2600);
};

// The <label> wrapping the file input already forwards clicks, but the inner <button> swallows
// them, so forward explicitly rather than dropping the button and losing the styling.
$('attachBtn').onclick = () => $('tailoredFile').click();

// Stored against the company it was built for. pickResume() prefers it only when that company
// matches the job being applied to, so a stale tailored PDF can never attach to the wrong role.
$('tailoredFile').onchange = async () => {
  const input = $('tailoredFile');
  const file = input.files?.[0];
  if (!file) return;
  if (file.type !== 'application/pdf') { alert('Attach a PDF.'); input.value = ''; return; }

  const b64 = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(fr.error);
    fr.onload = () => resolve(String(fr.result).split(',')[1]);
    fr.readAsDataURL(file);
  });
  if (b64.length > 4_000_000) { alert('That PDF is too large (over ~3MB).'); input.value = ''; return; }

  const { profile } = await chrome.storage.local.get('profile');
  if (!profile) { alert('Set up your profile in Options first.'); return; }
  profile.resumes = profile.resumes || {};
  profile.resumes.tailored = {
    name: file.name,
    mime: file.type,
    b64,
    forCompany: lastScan?.jd?.company || '',
    forTitle: lastScan?.jd?.title || '',
    at: new Date().toISOString(),
  };
  await chrome.storage.local.set({ profile });
  $('jdAttached').textContent = `${file.name} attached for ${profile.resumes.tailored.forCompany || 'this job'}.`;
  input.value = '';
};

/** Restore the last scan so reopening the popup does not look like the scan never happened. */
async function restoreScan() {
  if (lastScan) return;
  const { lastScan: saved, profile } = await chrome.storage.local.get(['lastScan', 'profile']);
  if (saved?.jd?.descriptionText) renderScan(saved);
  const t = profile?.resumes?.tailored;
  if (t?.b64) $('jdAttached').textContent = `${t.name} attached for ${t.forCompany || 'a job'}.`;
}

// ---- mode -----------------------------------------------------------------
$('modeAssist').onclick = async () => {
  pendingMode = null;
  await send({ type: 'AA_SET_MODE', mode: 'assist' });
  refresh();
};

$('modeAuto').onclick = () => { pendingMode = 'auto'; refresh(); };

$('startAuto').onclick = async () => {
  const hours = +$('hours').value, max = +$('max').value;
  if (!confirm(`Start full auto for ${hours}h, up to ${max} submissions?\n\nApplications are submitted without asking. This cannot be undone.`)) return;
  const r = await send({ type: 'AA_SET_MODE', mode: 'auto', hours, max });
  if (!r.ok) { alert(r.error); return; }
  pendingMode = null;
  refresh();
};

$('halt').onclick = async () => {
  const { state } = await send({ type: 'AA_STATUS' });
  await send({ type: 'AA_HALT', on: !state.halt });
  pendingMode = null;
  refresh();
};

$('minMatch').onchange = async () => {
  const v = Math.max(0, Math.min(100, +$('minMatch').value || 0));
  $('minMatch').value = v;
  await chrome.storage.local.set({ minMatchPct: v });
  showEligible(v);
};

$('run').onclick = async () => {
  const btn = $('run');
  btn.disabled = true;
  btn.textContent = 'Working…';
  const r = await send({ type: 'AA_RUN' });
  btn.disabled = false;
  btn.textContent = 'Run on Jobright list';
  if (!r.ok) alert(r.error);
  else if (!r.attempted) alert(`Nothing to do — ${r.considered} jobs found, none new above ${$('minMatch').value}% match.`);
  refresh();
};

// One posting, no scrolling. Reports the single outcome rather than a batch summary.
$('runOne').onclick = async () => {
  const btn = $('runOne');
  btn.disabled = true;
  btn.textContent = 'Working…';
  const r = await send({ type: 'AA_RUN_ONE' });
  btn.disabled = false;
  btn.textContent = 'Run one job';
  if (!r.ok) alert(r.error);
  else alert(`${r.job.title} at ${r.job.company || 'unknown'}\n\n${r.entry.reason || (r.entry.submitted ? 'Submitted' : 'Filled')}`);
  refresh();
};

// Clears everything that didn't submit, so those jobs can be retried. Submitted runs are kept
// deliberately — forgetting one would let it be applied to twice.
$('clearRuns').onclick = async () => {
  const r = await send({ type: 'AA_CLEAR_RUNS', keepSubmitted: true });
  if (r?.removed === 0) alert('Nothing to clear — every run submitted.');
  refresh();
};

$('opts').onclick = () => chrome.runtime.openOptionsPage();

function boot() {
  refresh().catch((e) => {
    console.error(e);
    document.body.innerHTML =
      `<div class="status is-halt" style="margin:16px">
         <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"
              stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
           <circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/></svg>
         <div class="grow"><div class="status-title">Popup failed to load</div>
           <div class="status-sub">${String(e.message || e)}</div></div>
       </div>`;
  });
}

boot();
// Once, not on the interval — re-rendering the scan every 2.5s would fight the Copy button's
// transient "Copied" label and reset the attach confirmation.
restoreScan().catch((e) => console.warn('[AA] could not restore last scan', e));
setInterval(boot, 2500);
