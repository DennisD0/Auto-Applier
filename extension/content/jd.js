// Thin listener for the "Tailor for this page" scan. Injected on demand into whatever tab is
// active, on any URL — this is the one content script that is deliberately not in
// manifest.content_scripts, because a job posting can live anywhere and automatic injection
// everywhere is a much bigger footprint than this feature needs.
//
// Read-only. It does not click, fill, submit, or navigate.

(function () {
  'use strict';

  // Guard against double injection: background.js calls executeScript unconditionally when a tab
  // has no listener, and a second copy would register a second onMessage handler and reply twice.
  if (window.__aa_jd_loaded) return;
  window.__aa_jd_loaded = true;

  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (msg.type !== 'AA_JD_READ') return;
    try {
      const jd = window.__aa_jdExtract.extract();
      const scan = window.__aa_jdParse.parse(jd);
      respond({ ok: true, jd, scan });
    } catch (e) {
      respond({ ok: false, error: String(e?.stack || e) });
    }
    return true;
  });

  console.log('[AA-JD] reader ready on', location.hostname);
})();
