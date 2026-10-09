#!/usr/bin/env node
// `npm run timmy -- <command>`: Timmy from this checkout, through tsx (a development package).
// R2 fresh-Mac walkthrough: on a Mac whose shell sets NODE_ENV=production, `npm ci` leaves development
// packages out, and the old script failed with "sh: tsx: command not found". This says why and how to fix
// it, then runs Timmy with the same arguments, in the same folder, and returns its exit code.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tsx = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
if (!existsSync(tsx)) {
  const omitted = process.env.NODE_ENV === 'production' || /\bdev\b/.test(process.env.npm_config_omit ?? '');
  console.error('Timmy runs from this checkout through tsx, a development package, and it is not installed.');
  console.error(omitted
    ? `npm left development packages out (${process.env.NODE_ENV === 'production' ? 'NODE_ENV=production' : 'omit=dev in its settings'}).`
    : 'Its packages are not installed yet.');
  console.error('Fix: npm ci --include=dev');
  process.exit(127);
}
// The child handles Ctrl+C itself; this wrapper only waits for it.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => {});
const r = spawnSync(tsx, [join(root, 'src', 'cli.ts'), ...process.argv.slice(2)], { stdio: 'inherit' });
if (r.error) { console.error(`Timmy did not start: ${r.error.message}`); process.exit(1); }
process.exit(r.status ?? 1);
