#!/usr/bin/env node
// Render the three resume variants the Chrome extension picks between.
//
// All three derive from templates/resume-pm.tex (current as of 2026-08-09). Only the Summary
// differs. templates/resume-proj.tex is deliberately NOT used as a base: it predates the
// 2026-08-09 update and contains no Linear/MCP framing at all, which is the strongest and most
// defensible positioning available.
//
// Anti-fabrication: every clause below traces to an existing approved bullet in resume-pm.tex.
// Nothing is added. Run `node scripts/resume-variants.mjs` after any resume edit.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = join(ROOT, 'templates', 'resume-pm.tex');
const OUT = join(ROOT, 'templates', 'variants');

const SUMMARY_RX = /\\small\{Builder PM and CS grad \(Summer 2026\)[^}]*\}/;

// Two variants only, per Dennis 2026-08-10: product manager and project manager.
const VARIANTS = {
  // Default. The current approved Summary, unchanged.
  product: null,

  // Project and program roles. Leads with NASA L'SPACE, where his title was literally Project
  // Manager, then delivery and stakeholder management.
  //   8-member cross-university / 5 subsystems / Agile sprints / 6+ syncs / on-time / 100% approval  -> NASA bullets 1-2
  //   Linear via MCP                                                                                 -> MavenStudio b2
  //   CI/CD, 3 environments, Google Cloud VM, 99% uptime                                             -> AutoBulletin b2
  project: String.raw`\small{Project and program manager and CS grad (Summer 2026) who led an 8-member cross-university team across 5 subsystems for NASA L'SPACE, running Agile sprint cycles and 6+ weekly stakeholder syncs to on-time delivery with 100\% submission approval. Ships software by directing AI coding agents (Claude Code, Codex) with all work tracked as structured Linear issues connected via MCP, and directed CI/CD across 3 environments to a Google Cloud VM sustaining 99\% uptime. Strong in milestone tracking, cross-functional alignment, and turning ambiguous objectives into scoped, delivered work.}`,
};

const base = readFileSync(BASE, 'utf8');
if (!SUMMARY_RX.test(base)) {
  console.error('FAIL: could not locate the Summary block in resume-pm.tex — refusing to guess.');
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });
let failed = 0;

for (const [name, summary] of Object.entries(VARIANTS)) {
  const tex = summary ? base.replace(SUMMARY_RX, summary) : base;
  const texPath = join(OUT, `resume-${name}.tex`);
  writeFileSync(texPath, tex, 'utf8');

  try {
    execFileSync(process.execPath, [join(ROOT, 'scripts', 'render-pdf.mjs'), texPath], { stdio: 'pipe' });
  } catch (e) {
    console.error(`FAIL  ${name}: render failed\n${e.stdout?.toString() || e.message}`);
    failed++;
    continue;
  }

  const log = readFileSync(texPath.replace(/\.tex$/, '.log'), 'latin1');
  const pages = Number(log.match(/Output written on .*?\((\d+) page/)?.[1] ?? 0);
  const ok = pages === 1;
  if (!ok) failed++;
  console.log(`${ok ? 'OK  ' : 'FAIL'}  resume-${name}.pdf  (${pages} page${pages === 1 ? '' : 's'})`);
  if (!ok) console.error('      the resume is at its one-page limit — this variant must be trimmed');
}

process.exit(failed ? 1 : 0);
