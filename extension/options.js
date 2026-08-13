// Seed profile â€” transcribed from profile/answers.md and profile/targets.md as of 2026-08-10.
// Values Dennis has not confirmed are left empty rather than guessed; an empty required field
// routes that application to the review queue instead of being invented.
const SEED = {
  legalFirstName: 'Gyeonghwan',
  lastName: 'Do',
  preferredName: 'Dennis',
  email: 'dennisnasa@gmail.com',
  phone: '917-887-1991',
  pronouns: '',

  streetAddress: '194-20 56Ave 1st FL',
  city: 'Fresh Meadows',
  cityForForms: 'New York City',
  state: 'NY',
  zip: '11365',
  country: 'United States',

  authorizedToWorkUS: true,
  requiresSponsorship: false,
  age18OrOver: true,
  visaStatus: 'Prefer not to state',
  subjectToRestrictiveAgreements: false,

  startDate: '2026-08-24',
  noticePeriod: 'None',
  desiredSalaryNumber: '80000',
  desiredSalaryText: '$80,000 to $100,000, flexible for the right role',
  openToRelocation: '',
  canTravelToNY: true,
  travelWillingness: '',
  workModelPreference: 'Open to onsite, hybrid, or fully remote',

  linkedin: 'https://linkedin.com/in/dennis-do-coding',
  portfolio: 'https://personal-portfolio-bice-pi.vercel.app/',
  github: '',

  school: 'CUNY Queens College',
  degree: 'Bachelor of Arts',
  highestEducation: 'Bachelor degree',
  fieldOfStudy: 'Computer Science',
  graduationDate: 'Summer 2026',
  gpa: '',

  howDidYouHear: 'Company Website',
  smsConsent: false,

  // Filled by the Resumes file pickers above, not by hand. Shape: {name, mime, b64}.
  // `tailored` is written by the popup's "Tailor for this page" flow instead, and carries the
  // company it was built for so it can never attach to a different posting.
  resumes: { product: null, project: null, tailored: null },
  coverLetterFile: null,

  // Grown by the Pending questions loop. Question text -> answer. Checked before a field is
  // ever treated as unmapped, so the manual tail shrinks with every batch.
  learnedAnswers: {},

  eeo: {
    gender: 'Male',
    race: 'Asian',
    hispanic: 'No',
    veteran: 'I am not a protected veteran',
    disability: 'No',
    lgbtq: 'No',
    orientation: 'Heterosexual',
  },

  // Reference material for the AI call on unmapped questions. Selection only, never addition.
  experienceSummary: [
    'MavenStudio - Founder & Product Manager, Jan 2026 to present. Automated lead pipeline, 200+ B2B prospects/week, 90% less manual prospecting. Directed Claude Code and Codex as SWEs via 55+ Linear issues over MCP, shipped 4 client sites at 2-week turnaround, paying customers within a 3-week sales cycle.',
    'AutoBulletin - Product Manager, May to Jul 2026. Found a 4-hour weekly bottleneck across 3 staff; shipped a multi-user tool for 8+ concurrent users with auto-translation in 5 languages and one-click PDF export. CI/CD via GitHub Actions to a Google Cloud VM, 99% uptime. 38-issue Linear backlog, revision cycles 3 rounds to 1.',
    'En Hakkore Cafe - Product Manager, Feb to May 2026. Attends the church as a member, noticed the problem himself and built the solution unprompted. Real-time mobile-ordering MVP in 3 weeks, solo as PM and builder. 2-person staff handling 30+ concurrent orders. Barista dashboard, order errors down an estimated 40%.',
    'Scout - Product Designer, Oct 2025 to Jan 2026. Discovery and requirements for an early-stage startup, 20+ hi-fi screens in a 2-week sprint, 5+ cross-functional teammates.',
    'NASA L\'SPACE - Project Manager, May to Sep 2025. Led an 8-member cross-university team across 5 subsystems, 6+ weekly stakeholder syncs, 100% submission approval. Feasibility analysis modeling a projected 91% cost reduction (a projection, never a delivered result).',
  ],

  constraints: [
    'Never claim SQL, A/B testing, Amplitude, Mixpanel, Google Analytics, Jira, C++, Java, Unity, or Python. These are permanently excluded as interview landmines.',
    'Dennis does not hand-write code. Every technical claim is scoped as directing AI coding agents.',
    'The NASA 91% cost reduction is a modeled projection, never a result.',
    'Target APM and entry-level product roles only. Never full, mid, or senior PM.',
    'Writing style: no em-dashes, no colons in the body, open with the point, narrative not labeled structure, short, varied sentence length.',
  ],
};

// Naming the missing element turns "Cannot set properties of null" into something actionable.
// The usual cause is a stale load: the HTML and JS were reloaded at different times.
const $ = (id) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id} in options.html - reload the extension at chrome://extensions`);
  return el;
};

const PROFILE_FIELDS = [
  'legalFirstName', 'lastName', 'preferredName', 'pronouns', 'email', 'phone',
  'streetAddress', 'city', 'cityForForms', 'state', 'zip', 'country',
  'startDate', 'noticePeriod', 'workModelPreference', 'desiredSalaryNumber',
  'desiredSalaryText', 'openToRelocation', 'travelWillingness', 'howDidYouHear',
  'visaStatus', 'github', 'linkedin', 'portfolio', 'school', 'degree',
  'highestEducation', 'fieldOfStudy', 'graduationDate', 'gpa',
];
const PROFILE_BOOLEANS = [
  'authorizedToWorkUS', 'requiresSponsorship', 'age18OrOver',
  'subjectToRestrictiveAgreements', 'canTravelToNY', 'smsConsent',
];
const EEO_FIELDS = ['gender', 'race', 'hispanic', 'veteran', 'disability', 'lgbtq', 'orientation'];
const IMPORT_FIELD_LABELS = {
  legalFirstName: 'Legal first name',
  lastName: 'Last name',
  preferredName: 'Preferred name',
  pronouns: 'Pronouns',
  email: 'Email',
  phone: 'Phone',
  streetAddress: 'Street address',
  city: 'Home city',
  cityForForms: 'City for forms',
  state: 'State',
  zip: 'ZIP',
  country: 'Country',
  authorizedToWorkUS: 'Authorized to work in the US',
  requiresSponsorship: 'Requires sponsorship',
  age18OrOver: '18 or over',
  visaStatus: 'Visa status',
  subjectToRestrictiveAgreements: 'Subject to restrictive agreements',
  startDate: 'Start date',
  noticePeriod: 'Notice period',
  desiredSalaryNumber: 'Desired salary number',
  desiredSalaryText: 'Desired salary text',
  openToRelocation: 'Open to relocation',
  canTravelToNY: 'Can travel to New York',
  travelWillingness: 'Travel willingness',
  workModelPreference: 'Work model preference',
  linkedin: 'LinkedIn',
  portfolio: 'Portfolio',
  github: 'GitHub',
  school: 'School',
  degree: 'Degree',
  highestEducation: 'Highest education',
  fieldOfStudy: 'Field of study',
  graduationDate: 'Graduation date',
  gpa: 'GPA',
  howDidYouHear: 'How did you hear',
  smsConsent: 'SMS consent',
  'eeo.gender': 'EEO gender',
  'eeo.race': 'EEO race',
  'eeo.hispanic': 'EEO Hispanic or Latino',
  'eeo.veteran': 'EEO veteran status',
  'eeo.disability': 'EEO disability status',
  'eeo.lgbtq': 'EEO LGBTQ',
  'eeo.orientation': 'EEO orientation',
};
const IMPORT_FIELD_ORDER = [
  ...PROFILE_FIELDS,
  ...PROFILE_BOOLEANS,
  ...EEO_FIELDS.map((k) => `eeo.${k}`),
];
let lastJobrightImport = null;

function cloneSeed() {
  return JSON.parse(JSON.stringify(SEED));
}

function mergedProfile(profile) {
  const seed = cloneSeed();
  const next = profile ? JSON.parse(JSON.stringify(profile)) : {};
  next.eeo = { ...seed.eeo, ...(next.eeo || {}) };
  next.experienceSummary = Array.isArray(next.experienceSummary) ? next.experienceSummary : seed.experienceSummary.slice();
  next.constraints = Array.isArray(next.constraints) ? next.constraints : seed.constraints.slice();
  for (const key of PROFILE_FIELDS) if (next[key] == null) next[key] = seed[key] ?? '';
  for (const key of PROFILE_BOOLEANS) if (typeof next[key] !== 'boolean') next[key] = Boolean(seed[key]);
  return { ...seed, ...next, eeo: next.eeo, experienceSummary: next.experienceSummary, constraints: next.constraints };
}

// The PDFs base64 to hundreds of KB each, which would make the textarea unusable and easy to
// corrupt. Keep them out of the editor and merge them back in on save.
// learnedAnswers is excluded too - it is managed by the Pending questions loop, and keeping it
// out of the editor means a stale textarea can never clobber answers saved since it was loaded.
function forEditor(profile) {
  const { resumes, coverLetterFile, learnedAnswers, ...rest } = mergedProfile(profile);
  return JSON.stringify(rest, null, 2);
}

function linesToList(text) {
  return String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function listToLines(list) {
  return (Array.isArray(list) ? list : []).join('\n');
}

function setFieldValue(id, value) {
  const el = $('pf-' + id);
  if (el.type === 'checkbox') el.checked = Boolean(value);
  else el.value = value ?? '';
}

function getFieldValue(id) {
  const el = $('pf-' + id);
  return el.type === 'checkbox' ? el.checked : el.value.trim();
}

function populateForm(profile) {
  const next = mergedProfile(profile);
  for (const key of PROFILE_FIELDS) setFieldValue(key, next[key]);
  for (const key of PROFILE_BOOLEANS) setFieldValue(key, next[key]);
  for (const key of EEO_FIELDS) setFieldValue(`eeo-${key}`, next.eeo[key]);
  $('pf-experienceSummary').value = listToLines(next.experienceSummary);
  $('pf-constraints').value = listToLines(next.constraints);
}

function formToProfile() {
  const base = cloneSeed();
  for (const key of PROFILE_FIELDS) base[key] = getFieldValue(key);
  for (const key of PROFILE_BOOLEANS) base[key] = getFieldValue(key);
  base.eeo = {};
  for (const key of EEO_FIELDS) base.eeo[key] = getFieldValue(`eeo-${key}`);
  base.experienceSummary = linesToList($('pf-experienceSummary').value);
  base.constraints = linesToList($('pf-constraints').value);
  return base;
}

function syncEditorFromForm() {
  $('profile').value = forEditor(formToProfile());
}

function profileValue(profile, key) {
  if (key.startsWith('eeo.')) return profile.eeo?.[key.slice(4)] ?? '';
  return profile[key];
}

function setProfileValue(profile, key, value) {
  if (key.startsWith('eeo.')) {
    profile.eeo = profile.eeo || {};
    profile.eeo[key.slice(4)] = value;
    return;
  }
  profile[key] = value;
}

function sameValue(a, b) {
  if (typeof a === 'boolean' || typeof b === 'boolean') return Boolean(a) === Boolean(b);
  return String(a ?? '').trim() === String(b ?? '').trim();
}

function presentValue(value) {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value ?? '').trim() || '(empty)';
}

function renderJobrightImport(profile, payload) {
  const host = $('jrProfileReview');
  const status = $('jrProfileStatus');
  const apply = $('jrProfileApply');

  if (!payload?.fields || !Object.keys(payload.fields).length) {
    host.innerHTML = '';
    apply.disabled = true;
    status.textContent = payload?.ok
      ? 'Jobright profile opened, but no mappable fields were found.'
      : (payload?.error || '');
    lastJobrightImport = null;
    return;
  }

  const rows = IMPORT_FIELD_ORDER
    .filter((key) => payload.fields[key])
    .map((key) => {
      const incoming = payload.fields[key];
      const current = profileValue(profile, key);
      return {
        key,
        label: IMPORT_FIELD_LABELS[key] || key,
        current,
        incoming: incoming.value,
        source: incoming.source,
        fromLabel: incoming.label,
        changed: !sameValue(current, incoming.value),
      };
    });

  const changed = rows.filter((row) => row.changed);
  lastJobrightImport = { ...payload, rows };
  apply.disabled = !changed.length;
  status.textContent = `Read ${payload.matched} mapped field${payload.matched === 1 ? '' : 's'} from Jobright. ${changed.length} ${changed.length === 1 ? 'change' : 'changes'} selected by default.`;

  host.innerHTML = rows.length
    ? `<div class="card">
        <table class="import-table">
          <thead>
            <tr>
              <th class="import-check"><input type="checkbox" id="jrSelectAll" ${changed.length ? 'checked' : ''} aria-label="Select all changed fields"></th>
              <th>Field</th>
              <th>Current</th>
              <th>Imported</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map((row, i) => `<tr>
              <td class="import-check"><input type="checkbox" class="jr-import-pick" data-index="${i}" ${row.changed ? 'checked' : ''} ${row.changed ? '' : 'disabled'}></td>
              <td>
                <div class="import-field">${esc(row.label)}</div>
                <div class="import-prov">${row.changed ? 'Will update' : 'No change'}</div>
              </td>
              <td class="import-from">${esc(presentValue(row.current))}</td>
              <td class="import-to">
                <div>${esc(presentValue(row.incoming))}</div>
                <div class="import-prov">${esc(row.source)} | ${esc(row.fromLabel)}</div>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`
    : '';

  const selectAll = document.getElementById('jrSelectAll');
  if (selectAll) {
    selectAll.addEventListener('change', () => {
      document.querySelectorAll('.jr-import-pick:not([disabled])').forEach((box) => { box.checked = selectAll.checked; });
    });
  }
}

async function load() {
  const s = await chrome.storage.local.get(['apiKey', 'profile', 'maxPerDay', 'minMatchPct', 'reviewQueue', 'pendingQuestions', 'bridgeOff']);
  const profile = mergedProfile(s.profile || SEED);
  renderPending(s.pendingQuestions || [], s.profile?.learnedAnswers || {});
  $('bridgeOff').checked = Boolean(s.bridgeOff);
  $('apiKey').value = s.apiKey || '';
  $('maxPerDay').value = s.maxPerDay ?? 10;
  $('minMatchPct').value = s.minMatchPct ?? 70;
  populateForm(profile);
  $('profile').value = forEditor(profile);
  renderQueue(s.reviewQueue || []);
  renderResumeStatus(profile.resumes || {});
  renderJobrightImport(profile, lastJobrightImport);
}

function renderResumeStatus(resumes) {
  for (const v of ['product', 'project']) {
    const el = $('st-' + v);
    if (!el) continue;
    const doc = resumes[v];
    el.textContent = doc?.b64 ? `${Math.round(doc.b64.length * 0.75 / 1024)} KB attached` : 'Not attached';
    el.className = 'slot-state ' + (doc?.b64 ? 'has' : 'none');
    el.title = doc?.name || '';
  }
}

// Attaching a resume writes straight into the saved profile so it survives a Save of the
// structured editor, and so a half-finished profile edit can't silently drop an attached PDF.
document.querySelectorAll('#resumes input[type=file]').forEach((input) => {
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (file.type !== 'application/pdf') { alert('Attach a PDF.'); input.value = ''; return; }
    const b64 = await toBase64(file);
    if (b64.length > 4_000_000) { alert('That PDF is too large (over ~3MB).'); input.value = ''; return; }

    const { profile } = await chrome.storage.local.get('profile');
    const next = mergedProfile(profile || SEED);
    next.resumes = next.resumes || {};
    next.resumes[input.dataset.variant] = { name: file.name, mime: file.type, b64 };
    await chrome.storage.local.set({ profile: next });

    populateForm(next);
    $('profile').value = forEditor(next);
    renderResumeStatus(next.resumes);
    $('saved').textContent = `Attached ${file.name}`;
    setTimeout(() => ($('saved').textContent = ''), 2200);
  });
});

// ---- pending questions: the zero-cost resolver loop -----------------------

function renderPending(pending, learned) {
  const open = pending.filter((q) => learned[q.question] == null);
  const nLearned = Object.keys(learned).length;
  $('qcount').textContent = open.length
    ? `${open.length} unanswered · ${nLearned} learned`
    : nLearned ? `all clear · ${nLearned} learned` : '';
  $('copyQ').disabled = !open.length;

  $('pending').innerHTML = open.length
    ? open.map((q) => `<div class="q">
        <div class="q-text">${esc(q.question)}</div>
        ${q.options?.length ? `<div class="q-opts">Options: ${q.options.map(esc).join(' · ')}</div>` : ''}
        <div class="q-meta">${esc(q.kind)} · seen ${q.seen}x${q.firstSeenOn ? ' · first at ' + esc(q.firstSeenOn) : ''}</div>
      </div>`).join('')
    : '<div class="empty">Nothing pending. Every question so far has an answer.</div>';
  window.__pendingOpen = open;
}

$('copyQ').onclick = async () => {
  const open = window.__pendingOpen || [];
  if (!open.length) { alert('Nothing pending.'); return; }
  const { profile } = await chrome.storage.local.get('profile');
  const payload = {
    instruction:
      'Answer each question for this candidate using ONLY the profile below. Return a JSON object '
      + 'mapping each question string to its answer string. Use null if the profile does not support '
      + 'an answer - do not invent employment, skills, dates, or credentials. For questions with '
      + 'options, return one of the options verbatim. Keep free text short, first person, no em-dashes.',
    profile,
    questions: open.map((q) => ({ question: q.question, kind: q.kind, options: q.options })),
  };
  await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
  $('qcount').textContent = 'Copied. Paste into a Claude Code session.';
};

$('clearQ').onclick = async () => {
  if (!confirm('Clear all pending questions?')) return;
  await chrome.storage.local.set({ pendingQuestions: [] });
  load();
};

$('saveAnswers').onclick = async () => {
  let incoming;
  try { incoming = JSON.parse($('answers').value); }
  catch (e) { alert('Answers are not valid JSON:\n' + e.message); return; }
  if (typeof incoming !== 'object' || Array.isArray(incoming)) { alert('Expected a JSON object of question -> answer.'); return; }

  const { profile } = await chrome.storage.local.get('profile');
  const next = mergedProfile(profile || SEED);
  next.learnedAnswers = next.learnedAnswers || {};
  let n = 0;
  for (const [q, a] of Object.entries(incoming)) {
    if (a == null || a === '') continue;
    next.learnedAnswers[q] = String(a);
    n++;
  }
  await chrome.storage.local.set({ profile: next });
  $('answers').value = '';
  $('asaved').textContent = `Learned ${n} answer${n === 1 ? '' : 's'}`;
  setTimeout(() => ($('asaved').textContent = ''), 2500);
  load();
};

$('jrProfileRead').onclick = async () => {
  $('jrProfileStatus').textContent = 'Reading open Jobright profile...';
  $('jrProfileApply').disabled = true;
  $('jrProfileReview').innerHTML = '';
  const res = await chrome.runtime.sendMessage({ type: 'AA_JR_PROFILE_READ' });
  const current = mergedProfile(formToProfile());
  renderJobrightImport(current, res);
};

$('jrProfileApply').onclick = () => {
  if (!lastJobrightImport?.rows?.length) return;
  const picks = [...document.querySelectorAll('.jr-import-pick:checked')]
    .map((el) => Number(el.dataset.index))
    .filter((n) => Number.isInteger(n) && lastJobrightImport.rows[n]);
  if (!picks.length) {
    $('jrProfileStatus').textContent = 'No imported fields selected.';
    return;
  }

  const profile = mergedProfile(formToProfile());
  for (const index of picks) {
    const row = lastJobrightImport.rows[index];
    setProfileValue(profile, row.key, row.incoming);
  }

  populateForm(profile);
  syncEditorFromForm();
  $('jrProfileStatus').textContent = `Applied ${picks.length} field${picks.length === 1 ? '' : 's'} to the form. Review and click Save changes to persist them.`;
  renderJobrightImport(profile, lastJobrightImport);
};

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(fr.error);
    fr.onload = () => resolve(String(fr.result).split(',')[1]);
    fr.readAsDataURL(file);
  });
}

function renderQueue(q) {
  $('queue').innerHTML = q.length
    ? q.map((e) => `<tr>
        <td><div style="font-weight:600">${esc(e.title || 'Untitled role')}</div>
            <div class="subtle">${esc(e.company || '')}</div>
            ${e.needsAccount ? '<div class="subtle" style="margin-top:4px;font-weight:600">Needs account</div>' : ''}</td>
        <td class="subtle">${esc(e.reason || '')}</td>
        <td>${e.applyUrl ? `<a href="${esc(e.applyUrl)}" target="_blank" rel="noopener">Open</a>` : ''}</td>
      </tr>`).join('')
    : '<tr><td colspan="3"><div class="empty">Nothing waiting for review.</div></td></tr>';
}


const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

$('profileForm').addEventListener('input', syncEditorFromForm);
$('profileForm').addEventListener('change', syncEditorFromForm);

$('refreshProfileJson').onclick = () => {
  syncEditorFromForm();
  $('saved').textContent = 'JSON refreshed';
  setTimeout(() => ($('saved').textContent = ''), 1800);
};

$('applyProfileJson').onclick = () => {
  let edited;
  try { edited = JSON.parse($('profile').value); }
  catch (e) { alert('Profile JSON is not valid:\n' + e.message); return; }
  populateForm(edited);
  $('profile').value = forEditor(mergedProfile(edited));
  $('saved').textContent = 'JSON applied to form';
  setTimeout(() => ($('saved').textContent = ''), 1800);
};

$('save').onclick = async () => {
  const { profile: stored } = await chrome.storage.local.get('profile');
  const profile = {
    ...formToProfile(),
    resumes: stored?.resumes || {},
    coverLetterFile: stored?.coverLetterFile || null,
    learnedAnswers: stored?.learnedAnswers || {},
  };

  await chrome.storage.local.set({
    apiKey: $('apiKey').value.trim(),
    profile,
    maxPerDay: +$('maxPerDay').value,
    minMatchPct: +$('minMatchPct').value,
    bridgeOff: $('bridgeOff').checked,
  });
  $('profile').value = forEditor(profile);
  $('saved').textContent = 'Saved';
  setTimeout(() => ($('saved').textContent = ''), 1800);
};

$('reset').onclick = () => {
  populateForm(SEED);
  $('profile').value = forEditor(SEED);
};

load().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('afterbegin',
    `<div class="status is-halt" style="margin:16px">
       <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
         <circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/></svg>
       <div class="grow"><div class="status-title">Settings failed to load</div>
         <div class="status-sub">${String(e.message || e)}</div></div>
     </div>`);
});
