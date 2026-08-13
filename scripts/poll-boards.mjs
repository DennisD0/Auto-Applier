#!/usr/bin/env node
/**
 * poll-boards.mjs — fetch postings from company ATS boards and report which are new.
 *
 * Greenhouse, Lever, and Ashby each publish a public JSON endpoint per company board, so
 * this is structured data, not scraping: no HTML parsing, no bot detection, no heuristics.
 *
 * Usage:
 *   node scripts/poll-boards.mjs            # print new postings as JSON
 *   node scripts/poll-boards.mjs --check    # validate every slug, print nothing else
 *   node scripts/poll-boards.mjs --all      # ignore the ledger, print everything found
 *
 * "New" means: not already present in ledger.jsonl by stable id. Duplicate applications are
 * the worst failure mode this rig has, so the ledger check is unconditional.
 */

import { readFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const COMPANIES = join(ROOT, 'profile', 'companies.txt');
const LEDGER = join(ROOT, 'ledger.jsonl');

const CHECK_ONLY = process.argv.includes('--check');
const IGNORE_LEDGER = process.argv.includes('--all');

const TIMEOUT_MS = 15000;
const CONCURRENCY = 6;

/** Per-ATS endpoint + response shape. Each normalizer returns a common posting record. */
const PROVIDERS = {
  greenhouse: {
    url: (slug) => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`,
    parse: (body, slug) =>
      (body.jobs ?? []).map((j) => ({
        id: `greenhouse:${slug}:${j.id}`,
        title: j.title ?? '',
        company: slug,
        location: j.location?.name ?? '',
        url: j.absolute_url ?? '',
        updatedAt: j.updated_at ?? null,
        // Greenhouse returns HTML-escaped content; strip to plain text for scoring.
        description: htmlToText(j.content ?? ''),
      })),
  },
  lever: {
    url: (slug) => `https://api.lever.co/v0/postings/${slug}?mode=json`,
    parse: (body, slug) =>
      (Array.isArray(body) ? body : []).map((j) => ({
        id: `lever:${slug}:${j.id}`,
        title: j.text ?? '',
        company: slug,
        location: j.categories?.location ?? '',
        url: j.hostedUrl ?? j.applyUrl ?? '',
        updatedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null,
        description:
          j.descriptionPlain ??
          htmlToText(j.description ?? '') +
            '\n' +
            (j.lists ?? []).map((l) => `${l.text}\n${htmlToText(l.content ?? '')}`).join('\n'),
      })),
  },
  ashby: {
    url: (slug) => `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`,
    parse: (body, slug) =>
      (body.jobs ?? []).map((j) => ({
        id: `ashby:${slug}:${j.id}`,
        title: j.title ?? '',
        company: slug,
        location: j.location ?? '',
        url: j.jobUrl ?? j.applyUrl ?? '',
        updatedAt: j.publishedAt ?? null,
        description: j.descriptionPlain ?? htmlToText(j.descriptionHtml ?? ''),
      })),
  },
};

/** Crude but adequate: JDs only need to be readable for scoring, not rendered. */
function htmlToText(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function readCompanies() {
  const raw = await readFile(COMPANIES, 'utf8');
  const entries = [];
  const bad = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = /^([a-z]+):(.+)$/i.exec(t);
    if (!m) { bad.push(t); continue; }
    const [, ats, slug] = m;
    if (!PROVIDERS[ats.toLowerCase()]) { bad.push(t); continue; }
    entries.push({ ats: ats.toLowerCase(), slug: slug.trim() });
  }
  return { entries, bad };
}

async function readLedgerIds() {
  const seen = new Set();
  try {
    await access(LEDGER);
  } catch {
    return seen; // no ledger yet — first run, everything is new
  }
  // Strip a leading BOM: anything on Windows that touches this file with PowerShell's
  // Set-Content -Encoding utf8 prepends one, and it would silently break line 1's dedup.
  const raw = (await readFile(LEDGER, 'utf8')).replace(/^﻿/, '');
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const id = JSON.parse(line).id;
      if (id) seen.add(id);
    } catch {
      // A corrupt line must not silently shrink the dedup set — say so.
      console.error(`WARN: unparseable ledger line skipped: ${line.slice(0, 120)}`);
    }
  }
  return seen;
}

async function fetchBoard({ ats, slug }) {
  const provider = PROVIDERS[ats];
  const url = provider.url(slug);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: 'application/json', 'user-agent': 'job-hunt-poller/1.0' },
    });
    if (!res.ok) {
      return { ats, slug, ok: false, error: `HTTP ${res.status}`, postings: [] };
    }
    const body = await res.json();
    return { ats, slug, ok: true, postings: provider.parse(body, slug) };
  } catch (err) {
    return { ats, slug, ok: false, error: err.name === 'AbortError' ? 'timeout' : err.message, postings: [] };
  } finally {
    clearTimeout(timer);
  }
}

/** Simple fixed-size worker pool — boards are independent, but don't hammer them. */
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

async function main() {
  const { entries, bad } = await readCompanies();
  for (const b of bad) console.error(`WARN: malformed companies.txt line ignored: ${b}`);
  if (entries.length === 0) {
    console.error('No valid boards in profile/companies.txt — nothing to poll.');
    process.exit(2);
  }

  const results = await mapPool(entries, CONCURRENCY, fetchBoard);
  const failed = results.filter((r) => !r.ok);
  const succeeded = results.filter((r) => r.ok);

  if (CHECK_ONLY) {
    for (const r of succeeded) console.log(`OK    ${r.ats}:${r.slug}  (${r.postings.length} postings)`);
    for (const r of failed) console.log(`FAIL  ${r.ats}:${r.slug}  -> ${r.error}`);
    console.log(`\n${succeeded.length} ok, ${failed.length} failed, ${entries.length} total`);
    process.exit(failed.length ? 1 : 0);
  }

  // Board failures are reported loudly and never silently reduce coverage.
  for (const r of failed) console.error(`WARN: board unreachable ${r.ats}:${r.slug} -> ${r.error}`);

  const all = succeeded.flatMap((r) => r.postings).filter((p) => p.url);
  const seen = IGNORE_LEDGER ? new Set() : await readLedgerIds();
  const fresh = all.filter((p) => !seen.has(p.id));

  console.error(
    `polled ${entries.length} boards (${failed.length} failed) | ${all.length} postings | ${fresh.length} new`,
  );
  process.stdout.write(JSON.stringify(fresh, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
