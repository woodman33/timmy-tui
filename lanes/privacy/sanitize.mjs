#!/usr/bin/env node
// timmy privacy sanitize (ORDER privacy-d5n9 step 2) — the reproducible rewrite.
//
//   node lanes/privacy/sanitize.mjs home     rewrite the absolute repo/home path to <repo>/<home> across
//                                            every tracked text file (except the load-bearing .timmy/store-pin)
//   node lanes/privacy/sanitize.mjs identity <file…>   in the named files: login name → <user>, Mac hostname → <hostname>
//   node lanes/privacy/sanitize.mjs overlay-observer   move companion/boards/observer.board.json to the private
//                                            overlay and leave a VC0000-style placeholder template in the tree
//   node lanes/privacy/sanitize.mjs all      home + identity(abilities) + overlay-observer, then print a summary
//
// Deterministic and idempotent: run it twice, the second run changes nothing.
// The worker subdomain (wmeldman33.workers.dev) and author email are left as the
// operator decided; this script never touches them.
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const REAL_REPO = ROOT.replace(/\/\.claude\/worktrees\/[^/]+$/, ''); // the main checkout path, whichever worktree we run from
const args = process.argv.slice(2);
const cmd = args[0] ?? 'all';

const trackedText = () => spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }).stdout.split('\0').filter(Boolean);
const isBinaryPath = (f) => /\.(png|jpg|jpeg|gif|mp4|webm|mov|pdf|docx|woff2?|ttf|riv|ico)$/i.test(f);
const EXCLUDE = new Set(['.timmy/store-pin', 'lanes/privacy/sanitize.mjs', 'lanes/privacy/patterns.json', 'lanes/privacy/fixtures/must-fail.txt', 'docs/PRIVACY-AUDIT.md', 'fleet/nodes.example.json', 'lanes/privacy/overlay.mjs', 'config/mcporter.json', 'lanes/abilities/harnesses.json']);

function rewriteFile(f, rules) {
  if (EXCLUDE.has(f) || isBinaryPath(f)) return 0;
  const abs = join(ROOT, f);
  let st; try { st = statSync(abs); } catch { return 0; }
  if (!st.isFile() || st.size > 16 * 1024 * 1024) return 0;
  const buf = readFileSync(abs);
  if (buf.includes(0)) return 0; // binary
  let text = buf.toString('utf8');
  let n = 0;
  for (const [re, to] of rules) { const before = text; text = text.replace(re, () => { n++; return to; }); if (text !== before) {} }
  if (n) writeFileSync(abs, text);
  return n;
}

// the home/repo paths, longest first so the repo path wins over the bare home
function homeRules() {
  const homes = new Set([REAL_REPO, ROOT]);
  const repoRes = [...homes].map((h) => [new RegExp(h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<repo>']);
  return [
    ...repoRes,
    [/\/Users\/williammeldman/g, '<home>'],
    [/\/home\/williammeldman/g, '<home>']
  ];
}
const identityRules = () => [
  [/\bwilliammeldman\b/g, '<user>'],
  [/[Ww]illiam['’]?s[- ]?[Mm]ac[Bb]ook[- ]?[Pp]ro(?:-2|\s?\(2\))?/g, '<hostname>'],
  [/\bwilliams-macbook-pro(?:-2|-exit-node)?\b/g, '<hostname>']
];

function summary() {
  const P = spawnSync('node', [join(ROOT, 'lanes', 'privacy', 'scan.mjs'), 'scan', '--tree', '.', '--fail-on', 'critical', '--json', '/tmp/san.json', '--quiet'], { cwd: ROOT, encoding: 'utf8' });
  return P.stdout.trim();
}

let touched = 0, files = 0;
if (cmd === 'home' || cmd === 'all') {
  const rules = homeRules();
  for (const f of trackedText()) { const n = rewriteFile(f, rules); if (n) { touched += n; files++; } }
  console.log(JSON.stringify({ step: 'home', repo: '<repo>', home: '<home>', rewrites: touched, files }));
}
if (cmd === 'identity' || cmd === 'all') {
  const list = cmd === 'identity' ? args.slice(1) : trackedText().filter((f) => f.startsWith('lanes/abilities/') && /\.(json|jsonl)$/.test(f));
  let it = 0, ifiles = 0;
  for (const f of list) { const n = rewriteFile(f, identityRules()); if (n) { it += n; ifiles++; } }
  console.log(JSON.stringify({ step: 'identity', files: ifiles, rewrites: it, targets: list.length }));
}
if (cmd === 'overlay-observer' || cmd === 'all') {
  const rel = 'companion/boards/observer.board.json';
  const abs = join(ROOT, rel);
  if (existsSync(abs)) {
    const raw = readFileSync(abs, 'utf8');
    // move the real board to the gitignored private overlay
    const priv = join(ROOT, '.timmy', 'private', rel);
    mkdirSync(dirname(priv), { recursive: true });
    writeFileSync(priv, raw, { mode: 0o600 });
    // placeholder template in the tree: card serials → VC0000, venues/locations → placeholders, home/login already handled
    let tpl = raw
      .replace(/\bVC[0-9]{3,}\b/g, 'VC0000')
      .replace(/\b(TV|SUN)[0-9]{3,}\b/g, '$10000')
      .replace(/Paradise Card Breaks/g, '<venue>')
      .replace(/\bParadise\b/g, '<venue>')
      .replace(/\bHenderson\b/g, '<location>')
      .replace(/\/Users\/williammeldman/g, '<home>')
      .replace(/\bwilliammeldman\b/g, '<user>');
    writeFileSync(abs, tpl);
    console.log(JSON.stringify({ step: 'overlay-observer', private: '.timmy/private/' + rel, template: rel, note: 'real board in the private overlay; the tree keeps a VC0000/<venue> placeholder template' }));
  }
}
if (cmd === 'all') console.log(summary());
