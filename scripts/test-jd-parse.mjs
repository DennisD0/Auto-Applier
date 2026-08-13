// Exercise jd-parse.js in Node by giving it the one global it touches.
import { readFileSync } from 'node:fs';

const src = readFileSync('C:/Users/Gyeonghwan Do/job-hunt/extension/content/lib/jd-parse.js', 'utf8');
globalThis.window = {};
new Function(src)();
const { parse } = globalThis.window.__aa_jdParse;

let fails = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`  ok    ${name}`);
  else { console.log(`  FAIL  ${name}\n        ${detail}`); fails++; }
};

const body = (extra) => `
About the role

We are looking for someone to own product discovery and user research, define MVP scope,
manage a prioritized backlog, and work cross-functional with stakeholders through agile sprint
planning. You will write user stories and acceptance criteria, run customer interviews, and
drive roadmap prioritization to delivery. Experience with Figma and Linear is useful.

You will partner closely with engineering and design to turn ambiguous objectives into scoped,
shippable work, then track it through release. Expect to run discovery sessions, synthesize what
you hear into problem statements, and defend your prioritization to stakeholders who will not
always agree with you. We care much more about how you think than about which tools you have
used before.

Requirements

- Strong written and verbal communication
- Comfortable with ambiguity
- Evidence of shipping something end to end, in any context
${extra}

Benefits

Competitive salary, health coverage, and a hybrid schedule out of our New York office.
`;

console.log('\n1. Soft SQL ask must NOT skip');
{
  const r = parse({ title: 'Associate Product Manager', source: 'jsonld',
    descriptionText: body('- Familiarity with SQL is a plus') });
  check('verdict is not skip', r.verdict !== 'skip', `verdict=${r.verdict} blockers=${JSON.stringify(r.blockers)}`);
  check('SQL recorded as soft', r.excluded.find((h) => h.id === 'sql')?.hard === false,
    JSON.stringify(r.excluded));
}

// Dennis 2026-08-13: apply even when requirements are not met, without claiming what he lacks.
// So an excluded skill is reported but never gates the verdict. The honesty half is unchanged and
// is asserted separately — the skill still has to be classified correctly so it can be reported.
console.log('\n2. Hard Python ask is reported loudly but no longer skips');
{
  const r = parse({ title: 'Associate Product Manager', source: 'jsonld',
    descriptionText: body('- 3+ years of Python required') });
  check('verdict is not skip', r.verdict !== 'skip', `verdict=${r.verdict}`);
  check('Python recorded as hard', r.excluded.find((h) => h.id === 'python')?.hard === true,
    JSON.stringify(r.excluded));
  check('reported as never going on the resume',
    r.flags.some((f) => /Python/.test(f) && /never goes on the resume/.test(f)),
    JSON.stringify(r.flags));
}

console.log('\n3. "Nice to have" heading makes an otherwise-hard ask soft');
{
  const r = parse({ title: 'Associate Product Manager', source: 'jsonld',
    descriptionText: body('') + '\nNice to have\n\n- Strong SQL skills\n' });
  check('verdict is not skip', r.verdict !== 'skip', `verdict=${r.verdict} blockers=${JSON.stringify(r.blockers)}`);
}

console.log('\n4. Datadog APM collision — the 2026-08-10 bug');
{
  const r = parse({ title: 'Senior Staff Engineer, APM', source: 'jsonld',
    descriptionText: body('- Experience with APM tooling') });
  check('reads as senior', r.seniority.level === 'senior', JSON.stringify(r.seniority));
  check('verdict is skip', r.verdict === 'skip', `verdict=${r.verdict}`);
}
{
  const r = parse({ title: 'Application Performance Monitoring Product Manager', source: 'jsonld',
    descriptionText: body('- 6+ years of product experience') });
  check('bare APM never grants entry signal', r.seniority.level !== 'entry', JSON.stringify(r.seniority));
}

console.log('\n5. Genuine entry-level PM passes');
{
  const r = parse({ title: 'Associate Product Manager', source: 'jsonld', descriptionText: body('') });
  check('reads as entry', r.seniority.level === 'entry', JSON.stringify(r.seniority));
  check('no blockers', r.blockers.length === 0, JSON.stringify(r.blockers));
  check('matched vocabulary is substantial', r.strength >= 10, `strength=${r.strength}`);
  check('verdict is apply', r.verdict === 'apply', `verdict=${r.verdict} flags=${JSON.stringify(r.flags)}`);
}

console.log('\n6. Mid-level PM with a years floor is skipped');
{
  const r = parse({ title: 'Product Manager', source: 'jsonld',
    descriptionText: body('- 5+ years of product management experience') });
  check('reads as mid', r.seniority.level === 'mid', JSON.stringify(r.seniority));
  check('verdict is skip', r.verdict === 'skip', `verdict=${r.verdict}`);
}

console.log('\n7. Non-product role is skipped');
{
  const r = parse({ title: 'Forward Deployed Engineer', source: 'jsonld', descriptionText: body('') });
  check('verdict is skip', r.verdict === 'skip', `verdict=${r.verdict} ${JSON.stringify(r.seniority)}`);
}

console.log('\n8. Java must not fire on JavaScript');
{
  const r = parse({ title: 'Associate Product Manager', source: 'jsonld',
    descriptionText: body('- Our stack is JavaScript and React') });
  check('no Java hit', !r.excluded.find((h) => h.id === 'java'), JSON.stringify(r.excluded));
}

console.log('\n9. DOM-sourced read is flagged, not silently trusted');
{
  const r = parse({ title: 'Associate Product Manager', source: 'dom', descriptionText: body('') });
  check('flagged as rough', r.flags.some((f) => /page markup/.test(f)), JSON.stringify(r.flags));
  check('verdict downgraded to review', r.verdict === 'review', `verdict=${r.verdict}`);
}

console.log('\n10. Empty page is a blocker, not an apply');
{
  const r = parse({ title: '', source: 'none', descriptionText: '' });
  check('verdict is skip', r.verdict === 'skip', `verdict=${r.verdict}`);
}

// Regression from a real posting, 2026-08-13. Volexity's Associate Product Manager reads as a
// perfect target by title and seniority, and its actual duty is "They will write Python scripts".
// The first version of this parser returned "review" with Python marked soft, because the bare
// mention carried no hard keyword. Three defects fixed together: SECTION_RX did not know "What
// the Role Involves" or "Preferred Experience"; the scan stopped at the first match per skill and
// never reached "Experience with Python" under Qualifications; and a mention with neither hard nor
// soft wording defaulted to soft. The carve-out exempts explicitly soft language, not silence.
console.log('\n11. Volexity APM — bare mention inside a required section is HARD');
{
  const jd = `
Volexity is looking for an Associate Product Manager to join its product team.

What the Role Involves

- Build and improve deployment automations using tools such as Terraform and Ansible
- Turn repeatable customer issues into actionable product requirements for the engineering team
- Communicate clearly with technical and non-technical customers

Qualifications

- Degree in CS or related field
- Experience with Python
- Strong communication skills

Preferred Experience

Candidates do not need all of these, but they would be helpful:

- Familiarity with tools like Splunk, Elastic, or similar investigation technologies
`;
  const r = parse({ title: 'Associate Product Manager', source: 'dom', descriptionText: jd });
  check('sections include the responsibilities heading',
    r.sections.includes('what the role involves'), r.sections.join(' | '));
  check('sections include preferred experience',
    r.sections.includes('preferred experience'), r.sections.join(' | '));
  check('Python is HARD, not soft', r.excluded.find((h) => h.id === 'python')?.strength === 'hard',
    JSON.stringify(r.excluded));
  check('quote cites the Qualifications line, not the intro',
    /Experience with Python/.test(r.excluded.find((h) => h.id === 'python')?.quote || ''),
    r.excluded.find((h) => h.id === 'python')?.quote);
  // Classification still has to be right even though it no longer gates: the whole point is that
  // the popup and the brief can say "this job wants Python and you are not claiming it".
  check('reported, and does not block the application',
    r.verdict !== 'skip' && r.flags.some((f) => /Python/.test(f)), `verdict=${r.verdict} flags=${JSON.stringify(r.flags)}`);
}

console.log('\n12. A bare mention outside any required section is unclear, never apply');
{
  const r = parse({ title: 'Associate Product Manager', source: 'jsonld',
    descriptionText: body('') + '\n\nAbout us\n\nOur analytics stack uses Python.\n' });
  const hit = r.excluded.find((h) => h.id === 'python');
  check('recorded as unclear', hit?.strength === 'unclear', JSON.stringify(hit));
  check('does not block', r.verdict !== 'skip', `verdict=${r.verdict}`);
  check('cannot reach apply', r.verdict === 'review', `verdict=${r.verdict}`);
}

console.log(fails ? `\n${fails} FAILED\n` : '\nall passed\n');
process.exit(fails ? 1 : 0);
