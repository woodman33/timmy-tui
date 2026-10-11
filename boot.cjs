#!/usr/bin/env node
// BOOT (opentui-u4e9): first frame ≤1s. Plain node paints the header with the
// chain head via raw ANSI (no tsx, no ink), then hands the terminal to the
// tsx app, which repaints the same header and assembles HOME.
const { existsSync, readFileSync } = require('fs');
const head8 = () => {
  try {
    const p = '.timmy/receipts/runs.jsonl';
    if (!existsSync(p)) return '—';
    const s = readFileSync(p, 'utf8');
    const i = s.lastIndexOf('\n', s.length - 2);
    const j = JSON.parse(s.slice(i + 1));
    return String(j.hash || '').slice(7, 15) || '—';
  } catch { return '—'; }
};
process.stdout.write('\x1Bc');
process.stdout.write(`\x1b[1mTIMMY\x1b[0m   chain · ${head8()}\r\n\x1b[2massembling…\x1b[0m\r\n`);
const { spawnSync } = require('child_process');
const fast = existsSync('dist/fast-entry.js') && process.argv.length === 2;
const args = fast ? ['dist/fast-entry.js'] : existsSync('dist/cli.js') ? ['dist/cli.js', ...process.argv.slice(2)] : ['tsx', 'cli.tsx', ...process.argv.slice(2)];
const cmd = fast || existsSync('dist/cli.js') ? process.execPath : 'npx';
const r = spawnSync(cmd, args, { stdio: 'inherit' });
// R4 (H82; the review of 6fb765a..4338fdb, finding 3): a CLI killed by a signal has no status, and `r.status ?? 0` made
// that exit 0. It exits 128 plus the signal's number, as the installed bin (timmy.ts) does; a CLI that did not start, 69.
if (r.error) { process.stderr.write(`timmy: could not start the CLI (${r.error.message}).\n`); process.exit(69); }
if (r.status === null && r.signal) process.exit(128 + (require('os').constants.signals[r.signal] || 0));
process.exit(r.status ?? 1);
