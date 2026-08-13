#!/usr/bin/env node
/**
 * arm-auto.mjs — time-boxed arming for fully-auto mode (the rig clicks Submit).
 *
 * Auto mode is OFF unless explicitly armed, and arming always carries an expiry. The failure
 * this design exists to prevent is auto mode left on by accident: you arm it for a weekend
 * away, forget, and three weeks later it is still submitting on your behalf. An armed window
 * that expires on its own cannot do that.
 *
 * Usage:
 *   node scripts/arm-auto.mjs status
 *   node scripts/arm-auto.mjs arm --hours 48 [--max 20]
 *   node scripts/arm-auto.mjs arm --until "2026-08-11T21:00"
 *   node scripts/arm-auto.mjs disarm
 *   node scripts/arm-auto.mjs record-submit        # called after each successful submit
 *
 * Exit codes for `status`:  0 = armed and valid   |   1 = not armed / expired / exhausted
 * The loop treats any non-zero status as "assist mode" — fill, never submit.
 */

import { readFile, writeFile, mkdir, access, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE = join(ROOT, '.cache', 'auto-arm.json');
const HALT = join(ROOT, 'HALT');
const TARGETS = join(ROOT, 'profile', 'targets.md');

/** Hard ceiling on a single arming window. A typo like --hours 720 should not be possible. */
const MAX_HOURS = 72;

const cmd = process.argv[2];

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function readState() {
  try {
    return JSON.parse(await readFile(STATE, 'utf8'));
  } catch {
    return null;
  }
}

async function writeState(s) {
  await mkdir(dirname(STATE), { recursive: true });
  await writeFile(STATE, JSON.stringify(s, null, 2), 'utf8');
}

/** Read the auto-mode caps from targets.md so config lives in one place. */
async function readConfig() {
  const raw = await readFile(TARGETS, 'utf8').catch(() => '');
  const num = (key, fallback) => {
    const m = new RegExp(`^\\s*${key}\\s*:\\s*([0-9_]+)`, 'm').exec(raw);
    return m ? Number(m[1].replace(/_/g, '')) : fallback;
  };
  return {
    defaultMax: num('auto_submit_max_per_window', 20),
    minScore: num('auto_submit_min_score', 75),
  };
}

/**
 * The single authority on "may I submit right now?". Everything else defers to this so the
 * answer cannot drift between callers.
 */
async function evaluate() {
  if (await exists(HALT)) {
    return { ok: false, reason: 'HALT file present — all automation stopped' };
  }

  const s = await readState();
  if (!s || !s.armedUntil) return { ok: false, reason: 'not armed' };

  const now = Date.now();
  const until = Date.parse(s.armedUntil);

  if (Number.isNaN(until)) return { ok: false, reason: 'corrupt arm state — treat as disarmed' };
  if (now >= until) {
    return { ok: false, reason: `arming window expired at ${s.armedUntil}`, state: s };
  }
  if (s.maxSubmits != null && s.submitted >= s.maxSubmits) {
    return { ok: false, reason: `submit cap reached (${s.submitted}/${s.maxSubmits})`, state: s };
  }

  return {
    ok: true,
    reason: 'armed',
    state: s,
    minutesLeft: Math.round((until - now) / 60000),
    remaining: s.maxSubmits == null ? null : s.maxSubmits - s.submitted,
  };
}

async function main() {
  const cfg = await readConfig();

  if (cmd === 'arm') {
    const hoursArg = argValue('--hours');
    const untilArg = argValue('--until');

    if (!hoursArg && !untilArg) {
      console.error('Refusing to arm without an expiry. Pass --hours <n> or --until <iso>.');
      process.exit(2);
    }

    let until;
    if (untilArg) {
      const t = Date.parse(untilArg);
      if (Number.isNaN(t)) {
        console.error(`Could not parse --until "${untilArg}". Use e.g. 2026-08-11T21:00`);
        process.exit(2);
      }
      until = new Date(t);
    } else {
      const h = Number(hoursArg);
      if (!Number.isFinite(h) || h <= 0) {
        console.error(`--hours must be a positive number, got "${hoursArg}"`);
        process.exit(2);
      }
      until = new Date(Date.now() + h * 3600_000);
    }

    const hoursOut = (until.getTime() - Date.now()) / 3600_000;
    if (hoursOut > MAX_HOURS) {
      console.error(
        `Refusing to arm for ${hoursOut.toFixed(1)}h — the ceiling is ${MAX_HOURS}h. ` +
          `Re-arm when you need longer; that is deliberate.`,
      );
      process.exit(2);
    }
    if (hoursOut <= 0) {
      console.error('That expiry is already in the past.');
      process.exit(2);
    }

    const maxArg = argValue('--max');
    const maxSubmits = maxArg ? Number(maxArg) : cfg.defaultMax;
    if (!Number.isFinite(maxSubmits) || maxSubmits <= 0) {
      console.error(`--max must be a positive number, got "${maxArg}"`);
      process.exit(2);
    }

    if (await exists(HALT)) {
      console.error('HALT file present — remove it before arming.');
      process.exit(2);
    }

    await writeState({
      armedAt: new Date().toISOString(),
      armedUntil: until.toISOString(),
      maxSubmits,
      submitted: 0,
      minScore: cfg.minScore,
    });

    console.log(
      `ARMED until ${until.toLocaleString()} (${hoursOut.toFixed(1)}h), ` +
        `max ${maxSubmits} submissions, min score ${cfg.minScore}.`,
    );
    console.log(`Disarm any time:  node scripts/arm-auto.mjs disarm`);
    console.log(`Emergency stop :  create a file named HALT in ${ROOT}`);
    return;
  }

  if (cmd === 'disarm') {
    await unlink(STATE).catch(() => {});
    console.log('DISARMED — back to assist mode (fill, never submit).');
    return;
  }

  if (cmd === 'record-submit') {
    const s = await readState();
    if (!s) {
      console.error('Not armed — refusing to record a submission.');
      process.exit(1);
    }
    s.submitted = (s.submitted ?? 0) + 1;
    s.lastSubmitAt = new Date().toISOString();
    await writeState(s);
    console.log(`recorded submit ${s.submitted}${s.maxSubmits ? `/${s.maxSubmits}` : ''}`);
    return;
  }

  if (cmd === 'status' || !cmd) {
    const r = await evaluate();
    if (r.ok) {
      console.log(
        `ARMED — ${r.minutesLeft} min left` +
          (r.remaining == null ? '' : `, ${r.remaining} submissions remaining`) +
          `, min score ${r.state.minScore}`,
      );
      process.exit(0);
    }
    console.log(`ASSIST MODE — ${r.reason}`);
    process.exit(1);
  }

  console.error(`unknown command "${cmd}". Use: status | arm | disarm | record-submit`);
  process.exit(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
