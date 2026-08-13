#!/usr/bin/env node
/**
 * render-tailored.mjs — build ONE per-job resume from a tailoring spec, or fail loudly.
 *
 * Sibling of resume-variants.mjs. That script renders the two standing variants ahead of time;
 * this one renders a single resume tailored to a specific posting, driven by a JSON spec that a
 * Claude Code `/tailor` run writes.
 *
 * The spec may only SELECT, REORDER and REWORD what is already in templates/resume-pm.tex and
 * profile/master-resume.md. This script cannot verify that — enforcing the anti-fabrication rule
 * is the /tailor command's job, and trace.md is the artifact that makes it checkable. What this
 * script does enforce is the constraint the command cannot see: the output must be exactly one
 * page. The resume is at its one-page limit with no rollback, so a spill is a hard failure, never
 * a warning.
 *
 * Usage:
 *   node scripts/render-tailored.mjs <spec.json>
 *
 * Spec shape (every field optional except summary):
 * {
 *   "company": "Zocdoc",
 *   "title":   "Associate Product Manager",
 *   "summary": "Builder PM and CS grad (Summer 2026) who ...",   // plain text, no \small{} wrapper
 *   "order":   ["MavenStudio", "En Hakkore Cafe", "AutoBulletin", "Scout", "NASA L'SPACE"],
 *   "bullets": { "MavenStudio": ["...", "...", "..."] },          // replaces that role's bullets
 *   "skills":  { "Product Management": "Product Discovery, ..." } // replaces that skills line
 * }
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = join(ROOT, 'templates', 'resume-pm.tex');

// Same anchor resume-variants.mjs uses. If the template's Summary is ever restructured, both
// scripts fail in the same recognisable way rather than silently emitting an untailored resume.
const SUMMARY_RX = /\\small\{Builder PM and CS grad \(Summer 2026\)[^}]*\}/;

const die = (msg) => { console.error(`FAIL: ${msg}`); process.exit(1); };

/**
 * Escape the LaTeX specials that show up in resume prose, leaving anything already escaped alone.
 *
 * A bare `%` is the one that actually bites: LaTeX reads it as a comment and silently swallows the
 * rest of the line, so "cutting prospecting time by 90%" renders as "cutting prospecting time by
 * 90" and nobody notices until it is on a real application.
 */
const escapeLatex = (s) => String(s).replace(/(?<!\\)([%&#_$])/g, '\\$1');

const spec = (() => {
  const p = process.argv[2];
  if (!p) die('usage: node scripts/render-tailored.mjs <spec.json>');
  try { return JSON.parse(readFileSync(resolve(p), 'utf8')); }
  catch (e) { die(`could not read spec: ${e.message}`); }
})();

if (!spec.summary) die('spec has no "summary" — a tailored resume with the stock summary is not tailored');

let tex = readFileSync(BASE, 'utf8');
if (!SUMMARY_RX.test(tex)) die('could not locate the Summary block in resume-pm.tex — refusing to guess');

// ---- 1. summary -------------------------------------------------------------
tex = tex.replace(SUMMARY_RX, `\\small{${escapeLatex(spec.summary)}}`);

// ---- 2. per-role bullets ----------------------------------------------------
//
// Each role is a \resumeSubheading{Company}{...} followed by a bullet list. Rewriting the list
// between its Start and End markers keeps the surrounding formatting exactly as the template has
// it, which is what holds the layout at one page.
function roleBlock(source, company) {
  const at = source.indexOf(`{${company}}`);
  if (at === -1) return null;
  const start = source.indexOf('\\resumeItemListStart', at);
  const end = source.indexOf('\\resumeItemListEnd', start);
  if (start === -1 || end === -1) return null;
  return { start: start + '\\resumeItemListStart'.length, end };
}

for (const [company, bullets] of Object.entries(spec.bullets || {})) {
  if (!Array.isArray(bullets) || !bullets.length) die(`"bullets.${company}" must be a non-empty array`);
  const block = roleBlock(tex, company);
  if (!block) die(`role "${company}" not found in resume-pm.tex — the spec may name it differently`);
  const body = '\n' + bullets.map((b) => `        \\resumeItem{${escapeLatex(b)}}`).join('\n') + '\n      ';
  tex = tex.slice(0, block.start) + body + tex.slice(block.end);
}

// ---- 3. skills lines --------------------------------------------------------
for (const [label, value] of Object.entries(spec.skills || {})) {
  const rx = new RegExp(`(\\\\textbf\\{${label.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}:\\}\\s*)([^}]*)`);
  if (!rx.test(tex)) die(`skills line "${label}" not found in resume-pm.tex`);
  tex = tex.replace(rx, `$1${escapeLatex(value)}`);
}

// ---- 4. role order ----------------------------------------------------------
//
// Reordering moves whole \resumeSubheading blocks. Only ever a permutation of what is already
// there: a name in `order` that the template does not have is an error, not a silent no-op.
if (Array.isArray(spec.order) && spec.order.length) {
  const expStart = tex.indexOf('\\resumeSubHeadingListStart', tex.indexOf('%-----------EXPERIENCE-----------'));
  const expEnd = tex.indexOf('\\resumeSubHeadingListEnd', expStart);
  if (expStart === -1 || expEnd === -1) die('could not locate the Experience list in resume-pm.tex');

  const inner = tex.slice(expStart + '\\resumeSubHeadingListStart'.length, expEnd);
  const blocks = inner.split(/(?=\n\s*\\resumeSubheading)/).filter((b) => b.trim());
  const nameOf = (b) => (b.match(/\\resumeSubheading\s*\n?\s*\{([^}]+)\}/) || [])[1];

  const present = blocks.map(nameOf);
  for (const want of spec.order) {
    if (!present.includes(want)) die(`order names "${want}", which is not a role in resume-pm.tex`);
  }
  if (spec.order.length !== blocks.length) {
    die(`order lists ${spec.order.length} roles but the resume has ${blocks.length} — reordering must be a permutation, not a cut`);
  }

  const reordered = spec.order.map((n) => blocks[present.indexOf(n)]).join('');
  tex = tex.slice(0, expStart + '\\resumeSubHeadingListStart'.length) + reordered + '\n\n  ' + tex.slice(expEnd);
}

// ---- 5. render and gate on page count ---------------------------------------
const outDir = spec.outDir ? resolve(spec.outDir) : join(ROOT, 'applications', slug());
mkdirSync(outDir, { recursive: true });
const texPath = join(outDir, 'resume.tex');
writeFileSync(texPath, tex, 'utf8');

function slug() {
  const date = new Date().toISOString().slice(0, 10);
  const part = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return [date, part(spec.company) || 'unknown', part(spec.title)].filter(Boolean).join('-');
}

try {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'render-pdf.mjs'), texPath], { stdio: 'pipe' });
} catch (e) {
  console.error(e.stdout?.toString() || e.message);
  die('LaTeX build failed — see the output above');
}

const logPath = texPath.replace(/\.tex$/, '.log');
if (!existsSync(logPath)) die('no LaTeX log was produced, so the page count cannot be verified');
const log = readFileSync(logPath, 'latin1');
const pages = Number(log.match(/Output written on .*?\((\d+) page/)?.[1] ?? 0);

if (pages !== 1) {
  console.error(`FAIL: resume.pdf is ${pages} page${pages === 1 ? '' : 's'}.`);
  console.error('The resume is at its one-page limit. Trim the summary or a bullet and re-run.');
  process.exit(1);
}

console.log(`OK  ${join(outDir, 'resume.pdf')}  (1 page)`);
console.log(`    attach this in the extension popup under "This page"`);
