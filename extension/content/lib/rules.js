// Question text -> answer. This table is the reason the extension is fast: almost every field
// on almost every ATS is one of these, and matching them costs microseconds instead of an
// API round trip. Anything that misses every rule falls through to the batched AI call.
//
// Order matters — first match wins, so put narrow patterns above broad ones.

(function () {
  'use strict';

  // `p` is the profile object from chrome.storage (seeded from profile/answers.md).
  const RULES = [
    // ---- identity -------------------------------------------------------
    { id: 'legal-name', rx: /\blegal name\b|full legal name/i, val: (p) => `${p.legalFirstName} ${p.lastName}` },
    { id: 'first-name', rx: /\bfirst name\b|given name/i, val: (p) => p.legalFirstName },
    { id: 'last-name', rx: /\blast name\b|family name|surname/i, val: (p) => p.lastName },
    { id: 'preferred-name', rx: /preferred name|name you go by|nickname/i, val: (p) => p.preferredName },
    { id: 'full-name', rx: /^(your )?name$|full name/i, val: (p) => `${p.legalFirstName} ${p.lastName}` },
    { id: 'email', rx: /e-?mail/i, val: (p) => p.email },
    { id: 'phone', rx: /phone|mobile number|cell/i, val: (p) => p.phone },
    { id: 'pronouns', rx: /pronoun/i, val: (p) => p.pronouns, skipIfEmpty: true },

    // ---- location -------------------------------------------------------
    { id: 'street', rx: /street address|address line 1|^address$/i, val: (p) => p.streetAddress },
    { id: 'zip', rx: /zip|postal code/i, val: (p) => p.zip },
    // "Location (City)" showed up unmapped on a real form — a very common label that matched
    // neither ^location$ nor ^city\b. A gazetteer combobox wants the metro, not the neighbourhood.
    { id: 'city-state', rx: /city and state|location.*residen|current location|^location$|^location\s*\(\s*city|^city\s*\(\s*location/i, val: (p) => p.cityForForms },
    { id: 'city', rx: /^city\b/i, val: (p) => p.city },
    { id: 'state', rx: /^state\b|state\/province/i, val: (p) => p.state },
    { id: 'country', rx: /^country\b/i, val: (p) => p.country },

    // ---- work authorization (highest stakes — keep these narrow) ---------
    {
      id: 'work-auth',
      rx: /legally (authoriz|entitl)ed to work|authorized to work in the (us|u\.s\.|united states)|work authorization status/i,
      val: (p) => (p.authorizedToWorkUS ? 'Yes' : 'No'),
    },
    {
      id: 'sponsorship',
      rx: /require sponsorship|need sponsorship|sponsorship for (an )?employment visa|visa sponsorship/i,
      val: (p) => (p.requiresSponsorship ? 'Yes' : 'No'),
    },
    { id: 'age18', rx: /18 (years )?(of age )?or older|at least 18/i, val: (p) => (p.age18OrOver ? 'Yes' : 'No') },
    { id: 'visa-status', rx: /visa status|immigration status/i, val: (p) => p.visaStatus },

    // ---- logistics ------------------------------------------------------
    { id: 'start-date', rx: /start date|when can you (start|begin)|availability to start/i, val: (p) => p.startDate, type: 'date' },
    { id: 'notice', rx: /notice period/i, val: (p) => p.noticePeriod },
    { id: 'salary-align', rx: /(salary|pay|compensation).*(align|meet|match).*(expectation)/i, val: (p) => 'Yes' },
    { id: 'salary-text', rx: /desired (salary|compensation|pay)|salary (expectation|requirement)|expected (salary|compensation)/i, val: (p) => p.desiredSalaryText },
    { id: 'salary-num', rx: /salary.*(number|amount)|base salary/i, val: (p) => p.desiredSalaryNumber },
    { id: 'relocate', rx: /(willing|open) to relocat|relocation/i, val: (p) => p.openToRelocation, skipIfEmpty: true },
    { id: 'travel-hq', rx: /travel to (our )?(headquarters|hq|office)|in-person onboarding/i, val: (p) => (p.canTravelToNY ? 'Yes' : 'No') },
    { id: 'travel-pct', rx: /willing to travel|travel requirement|% travel/i, val: (p) => p.travelWillingness, skipIfEmpty: true },
    { id: 'remote-pref', rx: /remote.*(preference|hybrid|onsite)|work (model|arrangement) preference/i, val: (p) => p.workModelPreference },

    // ---- links ----------------------------------------------------------
    { id: 'linkedin', rx: /linkedin/i, val: (p) => p.linkedin },
    { id: 'github', rx: /github/i, val: (p) => p.github, skipIfEmpty: true },
    { id: 'portfolio', rx: /portfolio|personal (web)?site|your website/i, val: (p) => p.portfolio },
    { id: 'website-or-linkedin', rx: /website or linkedin|link.*demonstrat.*(skill|experience)/i, val: (p) => p.linkedin },

    // ---- education ------------------------------------------------------
    { id: 'school', rx: /school|university|college|institution/i, val: (p) => p.school },
    { id: 'degree-level', rx: /highest level of education|degree level|education completed/i, val: (p) => p.highestEducation },
    { id: 'degree', rx: /\bdegree\b/i, val: (p) => p.degree },
    { id: 'major', rx: /major|field of study|discipline/i, val: (p) => p.fieldOfStudy },
    { id: 'grad-date', rx: /graduation date|expected graduation|end date/i, val: (p) => p.graduationDate },
    { id: 'gpa', rx: /\bgpa\b/i, val: (p) => p.gpa, skipIfEmpty: true },

    // ---- source / referral ----------------------------------------------
    { id: 'how-hear', rx: /how did you (hear|find out)|how were you referred|source/i, val: (p) => p.howDidYouHear },
    { id: 'referred', rx: /referred by|employee referral|do you know (anyone|someone)/i, val: (p) => 'No' },
    { id: 'worked-here', rx: /previously (been )?employed (with|at|by)|worked (for|at) (us|this company)|former employee/i, val: (p) => 'No' },
    { id: 'currently-here', rx: /currently (work|employed) (with|at|for)/i, val: (p) => 'No' },
    { id: 'agency-engaged', rx: /through a staffing agency|as an independent contractor or consultant|contingent worker/i, val: (p) => 'No' },
    { id: 'family-here', rx: /family|relative.*employed/i, val: (p) => 'No' },

    // ---- legal ----------------------------------------------------------
    { id: 'restrictive', rx: /non-?compet|non-?solicit|confidentiality agreement.*restrict|restrict your ability to work/i, val: (p) => (p.subjectToRestrictiveAgreements ? 'Yes' : 'No') },

    // ---- consent (default to the privacy-preserving answer) -------------
    { id: 'sms-consent', rx: /text message|sms|receive.*message.*updates/i, val: (p) => (p.smsConsent ? 'Yes' : 'No') },
    { id: 'marketing', rx: /marketing|newsletter|future opportunities|talent (community|network)/i, val: (p) => 'No', soft: true },

    // ---- EEO ------------------------------------------------------------
    { id: 'gender', rx: /\bgender\b/i, val: (p) => p.eeo.gender },
    { id: 'race', rx: /race|ethnicit/i, val: (p) => p.eeo.race },
    { id: 'hispanic', rx: /hispanic or latino/i, val: (p) => p.eeo.hispanic },
    { id: 'veteran', rx: /veteran/i, val: (p) => p.eeo.veteran },
    { id: 'disability', rx: /disability|CC-305/i, val: (p) => p.eeo.disability },
    { id: 'lgbtq', rx: /lgbtq/i, val: (p) => p.eeo.lgbtq },
    { id: 'orientation', rx: /sexual orientation/i, val: (p) => p.eeo.orientation },

    // ---- files ----------------------------------------------------------
    { id: 'resume', rx: /resume|cv\b/i, val: () => '@RESUME', type: 'file' },
    { id: 'cover-letter', rx: /cover letter/i, val: () => '@COVER_LETTER', type: 'file', soft: true },
  ];

  /**
   * Fields we must NEVER fill, mirroring the "Never fill" list in profile/answers.md.
   * Hitting one of these aborts the whole application rather than guessing.
   */
  const ABORT = [
    { rx: /social security|\bssn\b/i, why: 'SSN requested' },
    { rx: /date of birth|\bdob\b|birth date/i, why: 'date of birth requested' },
    { rx: /driver'?s licen[cs]e/i, why: "driver's license requested" },
    { rx: /bank|routing number|account number|payment details/i, why: 'bank details requested' },
    { rx: /password/i, why: 'password field on application' },
    { rx: /background check|credit check.*consent/i, why: 'background/credit check consent' },
    { rx: /signature|sign here|type your name to sign/i, why: 'signature requested' },
    { rx: /passport|visa document|upload.*\bid\b/i, why: 'identity document upload requested' },
  ];

  function checkAbort(question) {
    for (const a of ABORT) if (a.rx.test(question)) return a.why;
    return null;
  }

  function match(question, profile) {
    for (const r of RULES) {
      if (!r.rx.test(question)) continue;
      let v;
      try { v = r.val(profile); } catch { continue; }
      if (v === undefined || v === null || v === '') {
        if (r.skipIfEmpty) return { id: r.id, skip: true };
        continue;
      }
      return { id: r.id, value: String(v), type: r.type, soft: r.soft };
    }
    return null;
  }

  window.__aa_rules = { match, checkAbort, RULES, ABORT };
})();
