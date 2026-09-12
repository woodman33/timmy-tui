#!/usr/bin/env node
// lanes/factory/verifiers/probe.mjs — which verifiers this machine can run, measured not assumed.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
const req = createRequire(import.meta.url);
const run = (c, a) => { const r = spawnSync(c, a, { encoding: 'utf8', timeout: 20000 }); return { ok: r.status === 0, out: ((r.stdout || '') + (r.stderr || '')).trim().split('\n')[0]?.slice(0, 80) ?? '' }; };
export async function probe() {
  const jbang = run('jbang', ['version']);
  const tesseract = run('tesseract', ['--version']);
  let playwright = { ok: false, out: 'not resolvable' };
  try { const pw = req('playwright'); const exe = pw.chromium.executablePath(); playwright = { ok: existsSync(exe), out: existsSync(exe) ? `chromium ${exe.split('/').slice(-3, -1).join('/')}` : 'chromium not installed (npx playwright install chromium)' }; } catch (e) { playwright = { ok: false, out: e.message.slice(0, 80) }; }
  return { jsoup: { ok: jbang.ok, via: 'jbang', detail: jbang.out }, ocr: { ok: tesseract.ok, via: 'tesseract', detail: tesseract.out }, playwright, instatic_snapshot: { ok: true, via: 'folder + manifest', detail: 'always available' } };
}
if (process.argv[1]?.endsWith('probe.mjs')) console.log(JSON.stringify(await probe(), null, 1));
