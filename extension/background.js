// Service worker: owns mode, the arm window, caps, the kill switch, the run log, and the one
// AI call per application. Ports the semantics of scripts/arm-auto.mjs — status is the sole
// authority on whether anything may be submitted.

// Two modes, nothing else:
//   assist — find, fill, leave the tab open, move on. Never submits.
//   auto   — find, fill, verify, submit. Time-boxed, self-expiring.
const DEFAULTS = {
  mode: 'assist',
  armedUntil: null,          // ISO string; auto is inert without it
  maxSubmits: 0,
  submitted: 0,
  halt: false,               // kill switch, overrides everything
  maxPerDay: 10,
  maxOpenTabs: 8,            // assist leaves tabs open; don't bury the browser
  minMatchPct: 70,
  apiKey: '',
  profile: null,
  runLog: [],
  reviewQueue: [],
  pendingQuestions: [],      // unmapped questions awaiting answers from a Claude Code session
  lastScan: null,            // most recent "Tailor for this page" read, so the popup survives reopening
  tailoredDraft: '',         // partial base64 while a tailored PDF is being pushed in chunks
};

const MAX_ARM_HOURS = 72;

async function state() {
  const s = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...s };
}
const save = (patch) => chrome.storage.local.set(patch);

/** The single authority on whether a submit is permitted. Mirrors arm-auto.mjs status. */
async function armStatus() {
  const s = await state();
  if (s.halt) return { ok: false, reason: 'HALT is set — all automation stopped' };
  if (s.mode !== 'auto') return { ok: false, reason: 'assist mode' };
  if (!s.armedUntil) return { ok: false, reason: 'auto mode not armed' };
  const until = Date.parse(s.armedUntil);
  if (Number.isNaN(until)) return { ok: false, reason: 'corrupt arm state — treated as disarmed' };
  if (Date.now() > until) return { ok: false, reason: `arm window expired at ${s.armedUntil}` };
  if (s.submitted >= s.maxSubmits) return { ok: false, reason: `submit cap reached (${s.submitted}/${s.maxSubmits})` };
  const today = todayCount(s.runLog);
  if (today >= s.maxPerDay) return { ok: false, reason: `daily cap reached (${today}/${s.maxPerDay})` };
  return { ok: true, remaining: s.maxSubmits - s.submitted, until: s.armedUntil };
}

/**
 * Send a message to a tab, injecting the content script first if nothing is listening.
 *
 * Content scripts are only injected at page load, so any tab that was already open when the
 * extension was installed or reloaded has no listener and throws "Receiving end does not
 * exist". Rather than making the user remember to refresh, inject on demand and retry.
 */
async function tell(tabId, msg, files) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (e) {
    if (!/Receiving end does not exist|Could not establish connection/i.test(String(e))) throw e;
    await chrome.scripting.executeScript({ target: { tabId }, files });
    await new Promise((r) => setTimeout(r, 250));
    return chrome.tabs.sendMessage(tabId, msg);
  }
}

// host_permissions is <all_urls>, so injection works anywhere and there is no domain gate.
// This list never REJECTS a destination. It does two things: it labels a destination in the run
// log (`atsKnown`), and it ranks the candidate links on a Jobright detail page so a real ATS
// beats the company's marketing site. Confirmed 2026-08-10 that Jobright's own extension takes
// the same approach: <all_urls>, no list. Ours stays narrower in practice because
// content_scripts.matches (the *automatic* injection) is still just these domains; everywhere
// else is injected on demand, only while actually applying to a job.
const KNOWN_ATS = new RegExp(
  '^https://([^/]+\\.)?(' + [
    'ashbyhq\\.com', 'greenhouse\\.io', 'lever\\.co', 'myworkdayjobs\\.com', 'workday\\.com',
    'oraclecloud\\.com', 'icims\\.com', 'smartrecruiters\\.com', 'taleo\\.net',
    'successfactors\\.com', 'bamboohr\\.com', 'jobvite\\.com', 'workable\\.com', 'breezy\\.hr',
    'recruitee\\.com', 'teamtailor\\.com', 'pinpointhq\\.com', 'applytojob\\.com',
    'avature\\.net', 'eightfold\\.ai', 'phenompeople\\.com', 'dayforcehcm\\.com',
    'paylocity\\.com', 'personio\\.de', 'join\\.com',
  ].join('|') + ')(/|$)', 'i');

/**
 * Choose the outbound application URL from what the Jobright page offered.
 *
 * `url` is the "Original Job Post" anchor and is taken as-is when present. Otherwise prefer a
 * known ATS host, then fall back to the first outbound link — an unknown host is worth trying,
 * because apply.js reports honestly when a page has no form rather than guessing at it.
 */
function pickApplyUrl({ url, candidates = [] } = {}) {
  if (url) return url;
  return candidates.find((c) => KNOWN_ATS.test(c)) || candidates[0] || null;
}

const JR_FILES = ['content/jobright.js'];
const JD_FILES = [
  'content/lib/jd-extract.js',
  'content/lib/jd-parse.js',
  'content/jd.js',
];
const ATS_FILES = [
  'content/lib/setters.js',
  'content/lib/discover.js',
  'content/lib/rules.js',
  'content/apply.js',
];

const todayCount = (log) => {
  const d = new Date().toISOString().slice(0, 10);
  return log.filter((r) => r.submitted && r.at?.startsWith(d)).length;
};

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  handle(msg, sender).then(respond).catch((e) => respond({ ok: false, error: String(e?.stack || e) }));
  return true;
});

async function handle(msg, sender) {
  switch (msg.type) {
    case 'AA_STATUS': return { ok: true, state: await state(), arm: await armStatus() };

    // One entry point for both modes. Auto always carries an expiry and a cap; there is no way
    // to reach auto without them, which is the whole point.
    case 'AA_SET_MODE': {
      if (msg.mode === 'assist') {
        await save({ mode: 'assist', armedUntil: null, maxSubmits: 0, submitted: 0 });
        return { ok: true, arm: await armStatus() };
      }
      if (msg.mode !== 'auto') return { ok: false, error: `unknown mode ${msg.mode}` };

      const hours = Math.min(Number(msg.hours) || 0, MAX_ARM_HOURS);
      if (!(hours > 0)) return { ok: false, error: 'full auto requires a time frame' };
      const max = Number(msg.max) || 0;
      if (!(max > 0)) return { ok: false, error: 'full auto requires a submit cap' };

      const s = await state();
      if (s.halt) return { ok: false, error: 'Halt is set — clear it first' };
      if (!s.profile?.resumes?.product?.b64) {
        return { ok: false, error: 'Attach a resume in Options before enabling full auto' };
      }
      await save({
        mode: 'auto',
        armedUntil: new Date(Date.now() + hours * 3600e3).toISOString(),
        maxSubmits: max,
        submitted: 0,
      });
      return { ok: true, arm: await armStatus() };
    }

    case 'AA_HALT': await save({ halt: Boolean(msg.on) }); return { ok: true };

    // Removing a run also un-blocks that job: the dedup set is built from runLog, so a failed
    // or half-finished attempt would otherwise stop it ever being retried.
    case 'AA_DELETE_RUN': {
      const s = await state();
      await save({
        runLog: s.runLog.filter((r) => r.at !== msg.at),
        reviewQueue: s.reviewQueue.filter((r) => r.at !== msg.at),
      });
      return { ok: true };
    }

    case 'AA_CLEAR_RUNS': {
      const s = await state();
      const keep = msg.keepSubmitted
        ? s.runLog.filter((r) => r.submitted)   // never silently forget what actually went out
        : [];
      await save({ runLog: keep, reviewQueue: [] });
      return { ok: true, removed: s.runLog.length - keep.length };
    }

    // Cheap read of the currently-rendered list, for the threshold preview. No scrolling.
    case 'AA_PREVIEW': {
      const [jrTab] = await chrome.tabs.query({ url: 'https://jobright.ai/jobs/recommend*' });
      if (!jrTab) return { ok: false, error: 'no Jobright tab open' };
      const r = await tell(jrTab.id, { type: 'AA_JR_HARVEST' }, JR_FILES).catch(() => null);
      return r?.ok ? { ok: true, jobs: r.jobs } : { ok: false, error: 'could not read the list' };
    }

    case 'AA_JR_PROFILE_READ': {
      const tabs = await chrome.tabs.query({ url: 'https://jobright.ai/jobs/profile*' });
      const jrTab = tabs[tabs.length - 1];
      if (!jrTab) return { ok: false, error: 'open your Jobright profile page first' };
      const r = await tell(jrTab.id, { type: 'AA_JR_PROFILE_READ' }, JR_FILES).catch((e) => ({
        ok: false,
        error: String(e?.message || e),
      }));
      return r?.ok ? r : { ok: false, error: r?.error || 'could not read the Jobright profile' };
    }

    // Read the job posting in the active tab. Works on any URL and never touches the page.
    case 'AA_JD_SCAN': return scanActiveTab();

    // Build the clipboard brief for a Claude Code /tailor run. Assembled here rather than in the
    // popup because the profile lives in storage and the service worker already owns it.
    case 'AA_JD_BRIEF': return tailorBrief(msg);

    // Store a tailored resume without going through the popup's file picker.
    //
    // The popup lives on a chrome-extension:// page, which is unreachable to automation, so
    // without this there is no way to verify the tailoring path end to end. Chunked because a
    // one-page PDF base64s to ~140KB and that is an awkward single message to push through the
    // debug bridge. Chunks accumulate under `tailoredDraft` and only become the live resume on
    // the final call, so an interrupted transfer cannot leave a truncated PDF attached.
    case 'AA_SET_TAILORED': {
      const s = await state();
      const draft = msg.seq === 0 ? '' : (s.tailoredDraft || '');
      const next = draft + String(msg.chunk || '');
      if (!msg.last) {
        await save({ tailoredDraft: next });
        return { ok: true, received: next.length, done: false };
      }
      const profile = s.profile;
      if (!profile) return { ok: false, error: 'no profile stored — configure Options first' };
      profile.resumes = profile.resumes || {};
      profile.resumes.tailored = {
        name: msg.name || 'resume.pdf',
        mime: 'application/pdf',
        b64: next,
        forCompany: msg.forCompany || '',
        forTitle: msg.forTitle || '',
        at: new Date().toISOString(),
      };
      await save({ profile, tailoredDraft: '' });
      return { ok: true, received: next.length, done: true, forCompany: profile.resumes.tailored.forCompany };
    }

    // Load a tailored resume straight from a local render.
    //
    // `scripts/render-tailored.mjs` writes the PDF to disk, and the popup's file picker is the
    // normal way to attach it. This is the scripted equivalent: serve the file on localhost and
    // point the extension at it, which keeps a 140KB base64 out of the message channel entirely.
    //
    // Localhost only, deliberately. Fetching an arbitrary URL and storing the result as the
    // resume that goes out on real applications is not something a page should be able to ask
    // for, and the debug-bridge fences alone are not the right place to rely on for that.
    case 'AA_FETCH_TAILORED': {
      let u;
      try { u = new URL(msg.url); } catch { return { ok: false, error: 'not a URL' }; }
      if (!/^(127\.0\.0\.1|localhost|\[::1\])$/i.test(u.hostname)) {
        return { ok: false, error: 'only localhost URLs are accepted here — use the popup file picker otherwise' };
      }
      const s = await state();
      if (!s.profile) return { ok: false, error: 'no profile stored — configure Options first' };

      const resp = await fetch(u.href).catch((e) => ({ ok: false, statusText: String(e) }));
      if (!resp.ok) return { ok: false, error: `fetch failed: ${resp.statusText || resp.status}` };
      const buf = new Uint8Array(await resp.arrayBuffer());
      if (buf.length < 5000) return { ok: false, error: `only ${buf.length} bytes — that is not a rendered resume` };
      if (String.fromCharCode(...buf.slice(0, 5)) !== '%PDF-') return { ok: false, error: 'not a PDF' };

      let bin = '';
      for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
      s.profile.resumes = s.profile.resumes || {};
      s.profile.resumes.tailored = {
        name: msg.name || 'resume.pdf',
        mime: 'application/pdf',
        b64: btoa(bin),
        forCompany: msg.forCompany || '',
        forTitle: msg.forTitle || '',
        at: new Date().toISOString(),
      };
      await save({ profile: s.profile });
      return { ok: true, bytes: buf.length, forCompany: msg.forCompany || '' };
    }

    // Commit a react-select combobox from the page's own JS world.
    //
    // Greenhouse's comboboxes only open on a TRUSTED mouse event, which a content script cannot
    // forge — verified 2026-08-13 that on a cold page neither synthetic click, mousedown, arrow
    // keys, typing, nor clicking the hidden option commits anything. What does work is calling
    // react-select's own `selectOption` on the component instance, reached through the React
    // fiber hanging off the input.
    //
    // That has to run in MAIN, not in the content script: React attaches the fiber as an expando
    // property on the DOM node, and expandos set by the page are invisible to an isolated world.
    // Attributes DO cross, so apply.js marks the target with data-aa-combo and this finds it.
    case 'AA_REACT_PICK': {
      const tabId = sender?.tab?.id;
      if (!tabId) return { ok: false, error: 'no sender tab' };
      const [res] = await chrome.scripting.executeScript({
        target: { tabId, frameIds: sender.frameId != null ? [sender.frameId] : undefined },
        world: 'MAIN',
        args: [String(msg.wanted ?? '')],
        func: (wanted) => {
          const el = document.querySelector('[data-aa-combo="1"]');
          if (!el) return { ok: false, reason: 'target element not marked' };

          const fk = Object.keys(el).find((k) => k.startsWith('__reactFiber'));
          if (!fk) return { ok: false, reason: 'no React fiber — not a react-select widget' };

          let n = el[fk], depth = 0, inst = null;
          while (n && depth < 40) {
            const sn = n.stateNode;
            if (sn && typeof sn === 'object' && !(sn instanceof Node)
                && typeof sn.selectOption === 'function'
                && sn.props && Array.isArray(sn.props.options)) { inst = sn; break; }
            n = n.return; depth++;
          }
          if (!inst) return { ok: false, reason: 'no react-select instance above this input' };

          const norm = (s) => String(s ?? '').trim().toLowerCase();
          const label = (o) => String(o.label ?? o.name ?? o.value ?? '');
          const target = norm(wanted);
          const opts = inst.props.options;

          const pick = opts.find((o) => norm(label(o)) === target)
            || opts.find((o) => norm(label(o)).startsWith(target))
            || opts.find((o) => norm(label(o)).includes(target))
            || opts.find((o) => target.includes(norm(label(o))) && norm(label(o)).length > 2);

          // Never settle for options[0]. In auto mode that submits an arbitrary answer to a
          // question nobody answered, which is worse than leaving it blank and routing to review.
          if (!pick) {
            return { ok: false, reason: `no option matches "${wanted}"`,
              offered: opts.slice(0, 8).map(label) };
          }

          inst.selectOption(pick);
          return { ok: true, committed: label(pick) };
        },
      });
      return { ok: true, result: res?.result || { ok: false, reason: 'no result from MAIN world' } };
    }

    case 'AA_RESOLVE_UNKNOWN': return resolveUnknown(msg, sender);

    case 'AA_RUN': return runQueue(msg);

    case 'AA_RUN_ONE': return runOne(msg);

    case 'AA_PROBE': return probe(msg);

    // Reload the unpacked extension so an edit on disk takes effect without a trip to
    // chrome://extensions. Respond first — reload tears down this service worker.
    case 'AA_RELOAD':
      setTimeout(() => chrome.runtime.reload(), 150);
      return { ok: true, reloading: true };

    default: return { ok: false, error: `unknown message ${msg.type}` };
  }
}

// ---- reading a job posting -------------------------------------------------
//
// Deliberately independent of the Jobright queue and of apply.js. This path works on any tab, on
// any site, whether or not the autofill pipeline is functioning — which is the point, since
// tailoring is worth something on its own.

/** Chrome refuses script injection on its own pages, and the failure is otherwise opaque. */
const BLOCKED_SCHEME = /^(chrome|chrome-extension|edge|about|devtools|view-source|file):|^https:\/\/chrome\.google\.com\/webstore|^https:\/\/chromewebstore\.google\.com/i;

async function scanActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) return { ok: false, error: 'no active tab' };
  if (BLOCKED_SCHEME.test(tab.url || '')) {
    return { ok: false, error: 'Chrome blocks extensions on this page. Open the job posting in a normal tab.' };
  }

  // Inject unconditionally rather than going through tell().
  //
  // tell() only injects after "Receiving end does not exist", which assumes a tab has at most one
  // listener. That does not hold here: jobright.ai and every ATS domain in
  // content_scripts.matches already run a content script, so THAT listener answers AA_JD_READ
  // with undefined, no error is thrown, and jd.js is never injected. The scan then reports
  // "returned nothing" on precisely the domains this feature is most needed on. Found by running
  // it against a live Jobright tab, not by reading the code.
  //
  // Re-injection is safe: jd.js no-ops on the __aa_jd_loaded guard.
  let res;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: JD_FILES });
    res = await chrome.tabs.sendMessage(tab.id, { type: 'AA_JD_READ' });
  } catch (e) {
    return { ok: false, error: `could not read this page: ${String(e?.message || e)}` };
  }
  if (!res?.ok) return { ok: false, error: res?.error || 'the page reader returned nothing' };

  // Nothing structured and nothing dense enough to be a description. Say so plainly rather than
  // handing back an empty scan that looks like a finding.
  if (!res.jd.descriptionText) {
    return { ok: false, error: 'no job description found on this page. Open the posting itself, not a search results list.' };
  }

  await save({ lastScan: { ...res, at: new Date().toISOString() } });
  return { ok: true, jd: res.jd, scan: res.scan };
}

/**
 * The clipboard payload for a `/tailor` run in Claude Code.
 *
 * Markdown rather than JSON, because unlike the pending-questions payload this is read by a human
 * as well as a model, and the JD body is prose. The anti-fabrication instruction is restated here
 * rather than left implicit — the brief has to be safe to paste into a session that has never
 * seen master-resume.md.
 */
async function tailorBrief({ jd, scan }) {
  const s = await state();
  const src = { jsonld: 'structured JSON-LD', meta: 'page metadata', dom: 'page markup (rough)' }[jd?.source] || jd?.source;

  const lines = [
    '# Tailoring brief',
    '',
    'Run `/tailor` on this. Rules that are not negotiable:',
    '',
    '- `profile/master-resume.md` is the anti-fabrication boundary. Select, reorder and reword only.',
    '  Never add an employer, title, date, degree, metric, tool, or skill.',
    '- The ten excluded skills never appear on the resume, whatever this posting asks for.',
    '- The output must be exactly one page. `scripts/render-tailored.mjs` enforces it.',
    '',
    '## Job',
    '',
    `- **Title:** ${jd?.title || 'unknown'}`,
    `- **Company:** ${jd?.company || 'unknown'}`,
    jd?.location ? `- **Location:** ${jd.location}` : null,
    jd?.employmentType ? `- **Type:** ${jd.employmentType}` : null,
    `- **URL:** ${jd?.url || ''}`,
    `- **Read from:** ${src}`,
    '',
    '## Scan',
    '',
    `- **Verdict:** ${scan?.verdict}`,
    `- **Seniority:** ${scan?.seniority?.level} (${scan?.seniority?.why})`,
    scan?.blockers?.length ? `- **Blockers:**\n${scan.blockers.map((b) => `  - ${b}`).join('\n')}` : '- **Blockers:** none',
    scan?.flags?.length ? `- **Flags:**\n${scan.flags.map((f) => `  - ${f}`).join('\n')}` : null,
    '',
    scan?.excluded?.length
      ? '### Excluded-skill mentions\n\n' + scan.excluded.map((h) =>
        `- **${h.label}** — ${h.hard ? 'HARD ask, this posting is a skip' : 'soft ask, does not skip'}`
        + ` (in "${h.section}")\n  > ${h.quote}`).join('\n')
      : '### Excluded-skill mentions\n\nNone.',
    '',
    '### Vocabulary the posting asks for, that Dennis can honestly claim',
    '',
    scan?.matched?.length
      ? scan.matched.map((m) => `- ${m.term} (${m.group})`).join('\n')
      : '- nothing matched, which is itself a signal that this is a poor fit',
    '',
    '### Present in the master resume, absent from this posting',
    '',
    'Deprioritise these when selecting bullets:',
    '',
    (scan?.missing || []).slice(0, 20).map((m) => `- ${m.term}`).join('\n') || '- none',
    '',
    '## Full posting text',
    '',
    '```',
    (jd?.descriptionText || '').slice(0, 20000),
    '```',
  ];

  // Anything still empty in the profile becomes a blank on the real form later, so surface it
  // here while there is a human reading. Same reasoning as the pending-questions loop.
  const gaps = Object.entries(s.profile || {})
    .filter(([k, v]) => typeof v === 'string' && !v && !['pronouns', 'gpa'].includes(k))
    .map(([k]) => k);
  if (gaps.length) {
    lines.push('', '## Profile fields still empty', '',
      'These block or degrade the application form later:', '',
      ...gaps.map((g) => `- ${g}`));
  }

  return { ok: true, text: lines.filter((l) => l !== null).join('\n') };
}

/**
 * One call per application for every field the rules table missed. Batched deliberately —
 * per-field calls are what made the old CLI workflow slow.
 */
async function resolveUnknown({ questions, jobContext }, sender) {
  const s = await state();
  if (!questions?.length) return { ok: true, answers: {} };

  // No API key is the normal configuration, not an error. Anthropic API billing is separate
  // from a Claude Pro subscription, so the default path is: queue the questions, have them
  // answered in a Claude Code session, paste the answers back. Answered questions become
  // permanent in profile.learnedAnswers and are never asked again.
  if (!s.apiKey) {
    await queuePending(questions, jobContext);
    return { ok: true, answers: {}, deferred: true };
  }

  const sys = [
    'You fill job application fields on behalf of a candidate.',
    'Answer ONLY from the supplied profile. Never invent employment, skills, dates, or credentials.',
    'If the profile does not support an answer, return null for that question — do not guess.',
    'For multiple-choice questions you MUST return one of the provided options verbatim.',
    'Keep free text short, plain, and in first person. No em-dashes. No colons in the body.',
  ].join(' ');

  const body = {
    // Field mapping is a small structured task; Haiku is roughly an order of magnitude cheaper
    // than Opus for it and the answers are constrained by the profile either way.
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1500,
    system: sys,
    messages: [{
      role: 'user',
      content: JSON.stringify({
        profile: s.profile,
        job: jobContext,
        questions,
        instructions: 'Return ONLY a JSON object mapping each question string to its answer string, or null. No prose.',
      }),
    }],
  };

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': s.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) return { ok: false, error: `anthropic ${r.status}: ${(await r.text()).slice(0, 300)}` };

  const data = await r.json();
  const text = data.content?.map((c) => c.text).join('') ?? '';
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return { ok: false, error: 'model returned no JSON' };

  let answers;
  try { answers = JSON.parse(json); } catch (e) { return { ok: false, error: `bad JSON: ${e}` }; }
  for (const k of Object.keys(answers)) if (answers[k] == null) delete answers[k];
  return { ok: true, answers };
}

/** Record unmapped questions once each, with the options and where they were seen. */
async function queuePending(questions, jobContext) {
  const s = await state();
  const byText = new Map(s.pendingQuestions.map((q) => [q.question, q]));
  for (const q of questions) {
    const existing = byText.get(q.question);
    if (existing) { existing.seen = (existing.seen || 1) + 1; continue; }
    byText.set(q.question, {
      question: q.question,
      kind: q.kind,
      options: q.options || [],
      firstSeenAt: new Date().toISOString(),
      firstSeenOn: jobContext?.company || jobContext?.url || null,
      seen: 1,
    });
  }
  await save({ pendingQuestions: [...byText.values()] });
}

/**
 * Drive the queue: scroll the whole Jobright list, then work down it.
 *
 * Auto runs until its window expires or its cap fills. Assist runs until it hits maxOpenTabs,
 * since every assist job leaves a tab behind for Dennis.
 */
async function runQueue({ limit = 50 } = {}) {
  const s0 = await state();
  if (s0.halt) return { ok: false, error: 'Halt is set' };
  if (!s0.profile) return { ok: false, error: 'No profile configured — open Options first' };
  if (!s0.profile?.resumes?.product?.b64) {
    return { ok: false, error: 'No resume attached — add one in Options first' };
  }

  const [jrTab] = await chrome.tabs.query({ url: 'https://jobright.ai/jobs/recommend*' });
  if (!jrTab) return { ok: false, error: 'Open your Jobright recommendations tab first' };

  // Scroll the list so a run covers everything, not just what happened to be rendered.
  let harvest;
  try {
    harvest = await tell(jrTab.id, { type: 'AA_JR_HARVEST_ALL', maxScrolls: 25 }, JR_FILES);
  } catch (e) {
    return { ok: false, error: `Could not read the Jobright list: ${e.message || e}` };
  }
  if (!harvest?.ok) return { ok: false, error: 'Could not read the Jobright list' };

  // A broken match-% selector would otherwise look identical to an empty list: every card gets
  // matchPct null, the >= minMatchPct filter drops all of them, and the run reports zero jobs
  // as if that were the honest answer. Cards but no scores means the selector regressed.
  if (harvest.jobs.length && harvest.jobs.every((j) => j.matchPct == null)) {
    return {
      ok: false,
      error: `Read ${harvest.jobs.length} job cards but no match percentages — the match-% selector `
        + 'in content/jobright.js harvest() has probably broken against a Jobright redesign. '
        + 'Not filtering, because every job would be dropped for the wrong reason.',
    };
  }

  const done = new Set(s0.runLog.map((r) => r.jobId));
  const queue = harvest.jobs
    .filter((j) => !done.has(j.id))
    .filter((j) => (j.matchPct ?? 0) >= s0.minMatchPct)
    .sort((a, b) => (b.matchPct ?? 0) - (a.matchPct ?? 0))
    .slice(0, limit);

  const results = [];
  let openedTabs = 0;

  for (const job of queue) {
    const s = await state();
    if (s.halt) { results.push({ stopped: 'halt' }); break; }

    const arm = await armStatus();
    if (s.mode === 'auto' && !arm.ok) { results.push({ stopped: arm.reason }); break; }
    if (s.mode === 'assist' && openedTabs >= s.maxOpenTabs) {
      results.push({ stopped: `open tab limit reached (${s.maxOpenTabs})` });
      break;
    }

    const entry = await applyToJob(job, { ...s, armOk: arm.ok });
    results.push(entry);
    if (!entry.submitted) openedTabs++;
  }

  return { ok: true, considered: harvest.jobs.length, attempted: results.length, results };
}

/**
 * Dump what a form actually looks like on a tab we already opened.
 *
 * Diagnostic only — it reads, never writes. This exists because working out why a field did not
 * fill means seeing the real markup, and the alternative was guessing at selectors and burning a
 * posting per guess. Fixed snippet rather than arbitrary code from the caller.
 */
async function probe({ match = '' }) {
  const tabs = await chrome.tabs.query({});
  const tab = tabs.filter((t) => (t.url || '').includes(match)).pop();
  if (!tab) return { ok: false, error: `no open tab whose URL contains "${match}"` };

  const [r] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const cl = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const vis = (el) => Boolean(el.offsetParent);
      const ctrls = [...document.querySelectorAll('input,select,textarea,[role=combobox],[role=listbox]')]
        .filter((el) => el.type !== 'hidden' && vis(el))
        .map((el) => ({
          tag: el.tagName,
          type: el.type || null,
          role: el.getAttribute('role'),
          autocomplete: el.getAttribute('aria-autocomplete'),
          expanded: el.getAttribute('aria-expanded'),
          controls: el.getAttribute('aria-controls'),
          id: (el.id || '').slice(0, 44),
          name: (el.name || '').slice(0, 44),
          value: cl(el.value).slice(0, 30),
          selectOptions: el.tagName === 'SELECT' ? [...el.options].slice(0, 8).map((o) => cl(o.textContent).slice(0, 24)) : null,
        }));
      return {
        url: location.href.split('?')[0],
        ctrls,
        roleOption: document.querySelectorAll('[role=option]').length,
        roleListbox: document.querySelectorAll('[role=listbox]').length,
        buttons: [...document.querySelectorAll('button')].filter(vis).map((b) => cl(b.textContent).slice(0, 26)).slice(0, 30),
      };
    },
  });
  return { ok: true, data: r?.result };
}

/**
 * Apply to exactly one job, without scrolling the list.
 *
 * This is the right shape for trying a new ATS or debugging a failure: runQueue scrolls 25 times
 * and works through up to 50 jobs, which mixes many failure causes into one run and leaves a
 * pile of tabs behind. Here one posting goes in and one log entry comes out.
 *
 * Every rejection says why. "Nothing happened" is the failure mode that wasted the most time on
 * this project, so an empty result is never silent.
 */
async function runOne({ jobId } = {}) {
  const s = await state();
  if (s.halt) return { ok: false, error: 'Halt is set' };
  if (!s.profile) return { ok: false, error: 'No profile configured — open Options first' };
  if (!s.profile?.resumes?.product?.b64) {
    return { ok: false, error: 'No resume attached — add one in Options first' };
  }

  const [jrTab] = await chrome.tabs.query({ url: 'https://jobright.ai/jobs/recommend*' });
  if (!jrTab) return { ok: false, error: 'Open your Jobright recommendations tab first' };

  // The cheap already-rendered read. Never AA_JR_HARVEST_ALL — no scrolling, by design.
  let harvest;
  try {
    harvest = await tell(jrTab.id, { type: 'AA_JR_HARVEST' }, JR_FILES);
  } catch (e) {
    return { ok: false, error: `Could not read the Jobright list: ${e.message || e}` };
  }
  if (!harvest?.ok) return { ok: false, error: 'Could not read the Jobright list' };

  const jobs = harvest.jobs || [];
  if (!jobs.length) return { ok: false, error: 'No job cards are rendered on the Jobright tab' };

  const done = new Set(s.runLog.map((r) => r.jobId));
  let job;

  if (jobId) {
    job = jobs.find((j) => j.id === jobId);
    if (!job) {
      return { ok: false, error: `Job ${jobId} is not among the ${jobs.length} rendered cards — scroll it into view first` };
    }
    if (done.has(jobId)) {
      return { ok: false, error: `Job ${jobId} already has a run-log entry. Delete that entry to retry it.` };
    }
  } else {
    const fresh = jobs.filter((j) => !done.has(j.id));
    if (!fresh.length) {
      return { ok: false, error: `All ${jobs.length} rendered jobs already have run-log entries` };
    }
    const eligible = fresh.filter((j) => (j.matchPct ?? 0) >= s.minMatchPct);
    if (!eligible.length) {
      const best = Math.max(...fresh.map((j) => j.matchPct ?? 0));
      return { ok: false, error: `None of the ${fresh.length} new jobs reach ${s.minMatchPct}% match — the best is ${best}%` };
    }
    job = eligible.sort((a, b) => (b.matchPct ?? 0) - (a.matchPct ?? 0))[0];
  }

  const arm = await armStatus();
  if (s.mode === 'auto' && !arm.ok) {
    return { ok: false, error: `Full auto is selected but not usable: ${arm.reason}` };
  }

  const entry = await applyToJob(job, { ...s, armOk: arm.ok });
  return {
    ok: true,
    mode: s.mode,
    armed: arm.ok,
    job: { id: job.id, title: job.title, company: job.company, matchPct: job.matchPct },
    entry,
  };
}

async function applyToJob(job, s) {
  const tab = await chrome.tabs.create({ url: job.detailUrl, active: false });
  await waitComplete(tab.id);
  const found = await tell(tab.id, { type: 'AA_JR_APPLY_URL' }, JR_FILES).catch(() => ({}));
  const url = pickApplyUrl(found);
  if (!url) {
    await chrome.tabs.remove(tab.id);
    return record(job, { ok: false, reason: 'no outbound application URL found' });
  }

  // Try any http(s) destination. apply.js reports honestly when a page has no form, or is
  // behind a sign-in wall, so an unknown ATS degrades to a clear message rather than a refusal.
  if (!/^https?:\/\//i.test(url)) {
    await chrome.tabs.remove(tab.id);
    return record(job, { ok: false, needsReview: true, reason: `cannot open ${url}` }, url);
  }

  await chrome.tabs.update(tab.id, { url });
  await waitComplete(tab.id);

  const ask = (u) => tell(tab.id, {
    type: 'AA_APPLY',
    profile: s.profile,
    mode: s.mode,
    armed: s.armOk,
    jobContext: { title: job.title, company: job.company, url: u },
  }, ATS_FILES).catch((e) => ({ ok: false, error: String(e.message || e) }));

  let res = await ask(url);

  // The apply control was a link to the real form. apply.js cannot click it without navigating
  // out from under itself, so the hop happens here. Exactly one hop — a careers site that keeps
  // redirecting is a site we are not going to finish anyway.
  if (res?.retryAt) {
    await chrome.tabs.update(tab.id, { url: res.retryAt });
    await waitComplete(tab.id);
    const hopped = await ask(res.retryAt);
    res = { ...hopped, hoppedFrom: url, hoppedTo: res.retryAt };
  }

  if (res?.submitted) {
    await save({ submitted: (await state()).submitted + 1 });
    await chrome.tabs.remove(tab.id);
  }
  // Assist mode and review cases keep the tab open so the user can act on it.
  return record(job, res, url);
}

async function record(job, res, applyUrl) {
  const s = await state();
  const reason = res?.reason || res?.error || null;
  const needsAccount = Boolean(
    res?.needsAccount
    || /sign-in wall|needs an account|account creation/i.test(String(reason || ''))
  );
  const entry = {
    at: new Date().toISOString(),
    jobId: job.id, title: job.title, company: job.company, matchPct: job.matchPct,
    applyUrl: applyUrl ?? null,
    // Whether the destination was a platform we recognize. Purely a log label — an unknown host
    // is still attempted — but it is what makes a first run's failures readable at a glance.
    atsKnown: applyUrl ? KNOWN_ATS.test(applyUrl) : null,
    submitted: Boolean(res?.submitted),
    confirmed: Boolean(res?.confirmed),
    // A boolean is not evidence. Keep the page text that justified it, as the CLI path kept
    // confirmation.txt, so anything submitted unattended can be checked afterwards.
    confirmation: res?.confirmation ? String(res.confirmation).slice(0, 600) : null,
    needsReview: Boolean(res?.needsReview || res?.aborted),
    needsAccount,
    reason,
    filled: res?.log?.filled ?? 0,
    mismatches: res?.log?.mismatches ?? [],
    unverifiable: res?.log?.unverifiable ?? 0,
    clickedApply: res?.log?.clickedApply ?? null,
    hoppedTo: res?.hoppedTo ?? null,
    ms: res?.log?.ms ?? null,
    // Keep what went into which field. ATS sessions expire in 30-60 minutes, so an assist tab
    // left open overnight is a dead tab — this is what makes it re-fillable rather than lost.
    fields: (res?.log?.fields ?? []).map((f) => ({ q: f.q, value: f.want, ok: f.ok })),
  };
  const runLog = [entry, ...s.runLog].slice(0, 500);
  const reviewQueue = entry.needsReview ? [entry, ...s.reviewQueue].slice(0, 200) : s.reviewQueue;
  await save({ runLog, reviewQueue });
  return entry;
}

function waitComplete(tabId, timeout = 25000) {
  return new Promise((resolve) => {
    const t = setTimeout(finish, timeout);
    function listener(id, info) { if (id === tabId && info.status === 'complete') finish(); }
    function finish() {
      clearTimeout(t);
      chrome.tabs.onUpdated.removeListener(listener);
      setTimeout(resolve, 900); // let SPA hydration settle
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}
