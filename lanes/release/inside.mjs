#!/usr/bin/env node
// timmy release check — the part that runs INSIDE the fresh clone (container or temp dir).
// Prints one line `RELEASE_CHECK_JSON {...}`; lanes/release/check.mjs drives it (ORDER blank-slate-v1k9).
import { existsSync, readFileSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { loadPatterns, scanTree, scanText } from '../privacy/scan.mjs';

const ROOT = process.cwd();
const HOME = process.env.TIMMY_HOME; const PRIV = process.env.TIMMY_PRIVATE_DIR;
const P = loadPatterns();
const isPersonal = (f) => /^(pii|identity)\./.test(f.pattern);
const gated = (fs) => fs.filter((f) => ['critical', 'high', 'medium'].includes(f.severity));

const tree = scanTree(ROOT, P, 'tree');
const treePersonal = tree.findings.filter(isPersonal);
const present = (p) => existsSync(join(ROOT, p));
const artifacts = { receipts: present('.timmy/receipts'), store_pin: present('.timmy/store-pin'), private_overlay: present('.timmy/private'), ledger: present('orders.log') };

// first screen: both entry points, no TTY, blank home → the wizard must show and write nothing
const env = { ...process.env, HOME: process.env.HOME, TIMMY_HOME: HOME, TIMMY_PRIVATE_DIR: PRIV, CI: '', TIMMY_SKIP_INIT: '', FORCE_COLOR: '0' };
const launch = (file) => { const r = spawnSync('npx', ['tsx', file], { cwd: ROOT, env, input: '', encoding: 'utf8', timeout: 180000 }); return { out: (r.stdout ?? '') + (r.stderr ?? ''), status: r.status }; };
const screens = { 'src/cli.ts': launch('src/cli.ts'), 'timmy.ts': launch('timmy.ts') };
const wizard = Object.fromEntries(Object.entries(screens).map(([k, v]) => [k, v.out.includes('first run') && v.out.includes('blank slate')]));
const firstScreenPersonal = Object.values(screens).flatMap((s) => scanText(s.out, 'first-screen', P, 'screen').filter(isPersonal));
const wroteHome = existsSync(HOME) || existsSync(PRIV);
const receiptsAfter = present('.timmy/receipts');

// §12 negative control: plant personal strings, the scan MUST find them, then remove them
// assembled at runtime so this file never carries a literal the gate would (rightly) block
const planted = [['', 'Users', 'plantedlogin', 'private-notes.md'].join('/'), ['planted.person', 'plantedmail.net'].join('@'), ['planted', 'identity', 'term'].join('-')];
if (process.env.TIMMY_PLANT) planted.push(process.env.TIMMY_PLANT);
const plantFile = join(ROOT, '.release-check-planted.txt');
writeFileSync(plantFile, planted.join('\n') + '\n');
const withPlant = scanTree(ROOT, P, 'tree').findings.filter(isPersonal).filter((f) => f.file === '.release-check-planted.txt');
unlinkSync(plantFile);
const afterPlant = scanTree(ROOT, P, 'tree').findings.filter(isPersonal).length;
const negative = { planted: planted.length, findings: withPlant.length, patterns: [...new Set(withPlant.map((f) => f.pattern))], restored: afterPlant === treePersonal.length, ok: withPlant.length >= planted.length && afterPlant === treePersonal.length };

const ok = treePersonal.length === 0 && firstScreenPersonal.length === 0 && Object.values(wizard).every(Boolean) && !wroteHome && !receiptsAfter && !artifacts.receipts && !artifacts.store_pin && !artifacts.private_overlay && !artifacts.ledger && negative.ok;
const summary = {
  ok, node: process.version, files: tree.files, scanned: tree.scanned,
  tree_personal: treePersonal.length, tree_personal_by: Object.fromEntries([...new Set(treePersonal.map((f) => f.pattern))].map((p) => [p, treePersonal.filter((f) => f.pattern === p).length])),
  tree_gated_any: gated(tree.findings).length,
  artifacts, wizard_shown: wizard, first_screen_personal: firstScreenPersonal.length, launch_wrote_home: wroteHome, receipts_after_launch: receiptsAfter,
  negative_control: negative, patterns_sha256: P.sha256,
  sample: treePersonal.slice(0, 12).map((f) => `${f.pattern} ${f.file}:${f.line}`)
};
console.log('RELEASE_CHECK_JSON ' + JSON.stringify(summary));
process.exit(ok ? 0 : 1);
