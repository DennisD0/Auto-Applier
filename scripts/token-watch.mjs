#!/usr/bin/env node
/**
 * token-watch.mjs — sum this session's token spend and toast at the configured thresholds.
 *
 * Source of truth is the Claude Code session transcript, which records a `usage` object on
 * every assistant message. This measures THIS SESSION's spend — the only figure available
 * locally. It is not your plan's usage limit; that lives server-side and needs `/usage`.
 *
 * Usage:
 *   node scripts/token-watch.mjs --session <id>  # check, toast if a threshold is crossed
 *   node scripts/token-watch.mjs --report        # print the numbers, never toast
 *   node scripts/token-watch.mjs --budget 50000  # override budget (used to test the toast)
 *
 * Always pass --session when several Claude Code sessions may be open, or the reading can
 * come from whichever transcript was written most recently.
 *
 * Exit codes:  0 = under warn   |   10 = at/over warn   |   20 = at/over halt
 * The loop reads the exit code to decide whether to stop taking new jobs.
 */

import { readFile, readdir, stat, writeFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = join(ROOT, 'profile', 'targets.md');
const NOTIFY = join(ROOT, 'scripts', 'notify.ps1');
const STATE = join(ROOT, '.cache', 'token-watch-state.json');
const TRANSCRIPT_DIR = join(homedir(), '.claude', 'projects', 'C--Users-Gyeonghwan-Do');

const REPORT_ONLY = process.argv.includes('--report');

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

/** Pull the run-config values out of the ```yaml block in targets.md. */
async function readConfig() {
  const raw = await readFile(TARGETS, 'utf8').catch(() => '');
  const num = (key, fallback) => {
    const m = new RegExp(`^\\s*${key}\\s*:\\s*([0-9_]+)`, 'm').exec(raw);
    return m ? Number(m[1].replace(/_/g, '')) : fallback;
  };
  return {
    budget: num('token_budget', null),
    warnAt: num('warn_at_percent', 75),
    haltAt: num('halt_at_percent', 90),
  };
}

/**
 * Resolve which transcript to measure.
 *
 * Prefer an explicit session id — with several Claude Code sessions open at once,
 * "most recently modified" flips between files from one call to the next and the numbers
 * jump wildly. The loop always passes --session. The fallback warns when the choice was
 * ambiguous rather than quietly reporting another session's spend.
 */
async function activeTranscript(sessionId) {
  if (sessionId) {
    const p = join(TRANSCRIPT_DIR, `${sessionId}.jsonl`);
    try {
      await access(p);
      return p;
    } catch {
      console.error(`No transcript for session ${sessionId}; falling back to most recent.`);
    }
  }

  const files = await readdir(TRANSCRIPT_DIR).catch(() => []);
  const jsonl = files.filter((f) => f.endsWith('.jsonl'));
  if (jsonl.length === 0) return null;

  const stamped = await Promise.all(
    jsonl.map(async (f) => {
      const p = join(TRANSCRIPT_DIR, f);
      return { path: p, mtime: (await stat(p)).mtimeMs };
    }),
  );
  stamped.sort((a, b) => b.mtime - a.mtime);

  const recent = stamped.filter((s) => stamped[0].mtime - s.mtime < 120_000);
  if (recent.length > 1) {
    console.error(
      `WARN: ${recent.length} transcripts modified in the last 2 min — multiple sessions are ` +
        `live. Pass --session <id> to pin this one; numbers below may be another session's.`,
    );
  }
  return stamped[0].path;
}

/**
 * Cache reads are re-counted on every single request — a long session re-reads the same
 * prompt hundreds of times — and they bill at roughly 10% of input rate. Summing them 1:1
 * produces a number many times larger than actual consumption, which would trip the 75%
 * warning almost immediately and make it useless. So we track components separately and
 * compare the budget against a weighted "effective" total.
 */
const CACHE_READ_WEIGHT = 0.1;

async function sumUsage(path) {
  const raw = await readFile(path, 'utf8');
  // One requestId can appear on several lines; count each request once.
  const byRequest = new Map();

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || !line.includes('"usage"')) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const u = obj?.message?.usage;
    if (!u) continue;

    const rec = {
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
    };
    const key = obj.requestId ?? obj.uuid;
    if (!key) continue;
    // Keep the largest observation per request — partial streams report smaller subtotals.
    const prev = byRequest.get(key);
    const sum = (r) => r.input + r.output + r.cacheWrite + r.cacheRead;
    if (!prev || sum(rec) > sum(prev)) byRequest.set(key, rec);
  }

  const t = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  for (const r of byRequest.values()) {
    t.input += r.input;
    t.output += r.output;
    t.cacheWrite += r.cacheWrite;
    t.cacheRead += r.cacheRead;
  }

  return {
    ...t,
    raw: t.input + t.output + t.cacheWrite + t.cacheRead,
    effective: Math.round(t.input + t.output + t.cacheWrite + t.cacheRead * CACHE_READ_WEIGHT),
    requests: byRequest.size,
  };
}

function toast(title, message, level) {
  return new Promise((res) => {
    const p = spawn(
      'powershell',
      ['-ExecutionPolicy', 'Bypass', '-File', NOTIFY, '-Title', title, '-Message', message, '-Level', level],
      { shell: false },
    );
    p.on('error', () => res(false));
    p.on('close', (code) => res(code === 0));
  });
}

/** Remember which threshold already fired so each one toasts once per session. */
async function readState(sessionPath) {
  try {
    await access(STATE);
    const s = JSON.parse(await readFile(STATE, 'utf8'));
    return s.session === sessionPath ? s : { session: sessionPath, fired: [] };
  } catch {
    return { session: sessionPath, fired: [] };
  }
}

const fmt = (n) => n.toLocaleString('en-US');

async function main() {
  const cfg = await readConfig();
  const override = argValue('--budget');
  const budget = override ? Number(override) : cfg.budget;

  const path = await activeTranscript(argValue('--session'));
  if (!path) {
    console.error(`No transcript found in ${TRANSCRIPT_DIR}`);
    process.exit(1);
  }

  const u = await sumUsage(path);
  const spent = u.effective;
  const breakdown =
    `in ${fmt(u.input)} | out ${fmt(u.output)} | cache-write ${fmt(u.cacheWrite)} | ` +
    `cache-read ${fmt(u.cacheRead)} (weighted x${CACHE_READ_WEIGHT})`;

  if (!budget || Number.isNaN(budget)) {
    console.log(`effective ${fmt(spent)} tokens (raw ${fmt(u.raw)}) across ${u.requests} requests`);
    console.log(breakdown);
    console.log('no token_budget set in profile/targets.md — nothing to compare against');
    process.exit(0);
  }

  const pct = (spent / budget) * 100;
  const line = `${fmt(spent)} / ${fmt(budget)} effective tokens (${pct.toFixed(1)}%) across ${u.requests} requests`;
  console.log(line);
  console.log(breakdown);

  if (REPORT_ONLY) process.exit(0);

  const state = await readState(path);
  const hit = pct >= cfg.haltAt ? 'halt' : pct >= cfg.warnAt ? 'warn' : null;

  if (hit && !state.fired.includes(hit)) {
    const title = hit === 'halt' ? `Token budget ${cfg.haltAt}% — halting new jobs` : `Token budget ${cfg.warnAt}% reached`;
    const body =
      hit === 'halt'
        ? `${line}. Finishing in-flight applications only, then writing SESSION_HANDOFF.md.`
        : `${line}. Still running — you have roughly ${fmt(Math.max(0, budget - spent))} tokens left.`;
    await toast(title, body, hit === 'halt' ? 'critical' : 'warning');
    state.fired.push(hit);
    await writeFile(STATE, JSON.stringify(state, null, 2));
  }

  process.exit(hit === 'halt' ? 20 : hit === 'warn' ? 10 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
