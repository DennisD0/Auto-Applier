#!/usr/bin/env node
/**
 * render-pdf.mjs — compile a tailored .tex to PDF, or fail loudly.
 *
 * A silently-broken render is the dangerous case: a zero-byte or stale PDF gets uploaded to a
 * real application and nobody notices. So this verifies the output actually exists, is
 * non-trivially sized, and starts with a PDF magic number — and exits non-zero otherwise.
 *
 * Usage:
 *   node scripts/render-pdf.mjs <path/to/file.tex>
 *   node scripts/render-pdf.mjs --probe        # report which LaTeX engine is available
 */

import { spawn } from 'node:child_process';
import { readFile, stat, unlink } from 'node:fs/promises';
import { dirname, resolve, basename } from 'node:path';

const MIN_PDF_BYTES = 5000; // a real one-page resume is ~40-80 KB; anything tiny is a failed build

/**
 * Engines in preference order.
 *
 * latexmk sits last deliberately: MiKTeX ships it as a Perl script and MiKTeX does not
 * bundle Perl, so it fails at run time on a stock Windows install even though `where
 * latexmk` finds it. pdflatex is a native binary and needs no interpreter. This resume
 * template has no cross-references or TOC, so a single pdflatex pass is sufficient.
 */
const ENGINES = [
  { cmd: 'tectonic', args: (tex) => ['--keep-logs', '--print', tex] },
  { cmd: 'pdflatex', args: (tex) => ['-interaction=nonstopmode', tex] },
  { cmd: 'xelatex', args: (tex) => ['-interaction=nonstopmode', tex] },
  { cmd: 'latexmk', args: (tex) => ['-pdf', '-interaction=nonstopmode', tex] },
];

/**
 * MiKTeX's installer does not refresh PATH for already-running processes, and a scheduled
 * or long-lived session inherits the stale environment. Search the known install roots so
 * the rig works without requiring a reboot or a terminal restart.
 */
const EXTRA_BIN_DIRS = [
  `${process.env.LOCALAPPDATA ?? ''}\\Programs\\MiKTeX\\miktex\\bin\\x64`,
  `${process.env.LOCALAPPDATA ?? ''}\\Programs\\MiKTeX\\miktex\\bin`,
  'C:\\Program Files\\MiKTeX\\miktex\\bin\\x64',
  'C:\\Program Files\\MiKTeX\\miktex\\bin',
].filter(Boolean);

function run(cmd, args, cwd) {
  return new Promise((res) => {
    // No shell: the MiKTeX path contains a space ("Gyeonghwan Do"), and cmd.exe would split
    // it into two tokens. spawn passes argv directly, so spaces are safe.
    const p = spawn(cmd, args, { cwd, shell: false });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', (err) => res({ code: -1, out: String(err) }));
    p.on('close', (code) => res({ code, out }));
  });
}

/** Resolve an engine to an absolute path: PATH first, then the known install roots. */
async function locate(cmd) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const { code } = await run(probe, [cmd], process.cwd());
  if (code === 0) return cmd;

  if (process.platform === 'win32') {
    for (const dir of EXTRA_BIN_DIRS) {
      const full = resolve(dir, `${cmd}.exe`);
      try {
        await stat(full);
        return full;
      } catch {
        // not here; keep looking
      }
    }
  }
  return null;
}

async function pickEngine() {
  for (const e of ENGINES) {
    const path = await locate(e.cmd);
    if (path) return { ...e, path };
  }
  return null;
}

async function main() {
  if (process.argv.includes('--probe')) {
    const found = [];
    for (const e of ENGINES) {
      const p = await locate(e.cmd);
      if (p) found.push(`${e.cmd} (${p})`);
    }
    if (found.length === 0) {
      console.error('No LaTeX engine found. Install MiKTeX:  winget install MiKTeX.MiKTeX');
      process.exit(1);
    }
    console.log(`available:\n  ${found.join('\n  ')}\nwill use: ${found[0]}`);
    process.exit(0);
  }

  const texArg = process.argv[2];
  if (!texArg) {
    console.error('usage: node scripts/render-pdf.mjs <file.tex>');
    process.exit(2);
  }

  const texPath = resolve(texArg);
  const cwd = dirname(texPath);
  const pdfPath = texPath.replace(/\.tex$/i, '.pdf');

  // Remove any prior PDF so a failed build can't leave a stale file that looks like success.
  await unlink(pdfPath).catch(() => {});

  const engine = await pickEngine();
  if (!engine) {
    console.error('FAIL: no LaTeX engine on PATH. Run with --probe for install guidance.');
    process.exit(1);
  }

  const { code, out } = await run(engine.path, engine.args(basename(texPath)), cwd);

  let st;
  try {
    st = await stat(pdfPath);
  } catch {
    console.error(`FAIL: ${engine.cmd} produced no PDF (exit ${code}).`);
    console.error(out.slice(-3000));
    process.exit(1);
  }

  if (st.size < MIN_PDF_BYTES) {
    console.error(`FAIL: PDF is only ${st.size} bytes — build almost certainly broken.`);
    console.error(out.slice(-3000));
    process.exit(1);
  }

  const head = await readFile(pdfPath, { encoding: 'latin1', flag: 'r' }).then((s) => s.slice(0, 5));
  if (!head.startsWith('%PDF-')) {
    console.error('FAIL: output is not a PDF (missing %PDF- header).');
    process.exit(1);
  }

  console.log(`OK: ${pdfPath} (${st.size} bytes, via ${engine.cmd})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
