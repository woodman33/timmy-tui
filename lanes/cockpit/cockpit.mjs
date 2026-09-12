#!/usr/bin/env node
// timmy cockpit — one tmux session "timmy", one pane per non-external hand (ORDER factory-f1d0 C2 PANES).
//
//   timmy cockpit hands [--discover] [--write]   the registry (.timmy/private/cockpit/hands.json); --discover proposes
//                                                entries from `git worktree list` + the ledger's HANDS lines; --write saves
//                                                the proposal when no registry exists yet
//   timmy cockpit up [--dry] [--restart] [--session timmy]
//                                                start the session: per local hand, a pane cd'd to its worktree, its
//                                                output piped (tmux pipe-pane) to .timmy/private/cockpit/<hand>/<date>.log
//                                                BEFORE its CLI is launched (claude / codex / qwen-code)
//   timmy cockpit attach                          tmux attach -t timmy
//   timmy cockpit status                          panes, hands, log files
//   timmy cockpit down                            kill the session (logs stay)
//
// Nothing here writes to the tree: the registry, the session record and every log live under .timmy/private/.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..', '..');
export const PRIVATE = join(ROOT, '.timmy', 'private', 'cockpit');
export const REGISTRY = join(PRIVATE, 'hands.json');
const TEMPLATE = join(HERE, 'hands.example.json');
export const CLI_ALIASES = { claude: ['claude'], codex: ['codex'], 'qwen-code': ['qwen-code', 'qwen'], qwen: ['qwen', 'qwen-code'] };
const today = () => new Date().toISOString().slice(0, 10);
const sh = (cmd, argv, opts = {}) => spawnSync(cmd, argv, { encoding: 'utf8', ...opts });
const onPath = (bin) => sh('sh', ['-c', `command -v ${bin}`]).status === 0;
const isPlaceholder = (v) => typeof v === 'string' && /<[a-z-]+>/.test(v);

/** The registry: private overlay first, else the committed template (flagged, so `up` refuses to launch placeholders). */
export function loadRegistry(file = REGISTRY) {
  if (existsSync(file)) return { ...JSON.parse(readFileSync(file, 'utf8')), source: 'private', file };
  return { ...JSON.parse(readFileSync(TEMPLATE, 'utf8')), source: 'template', file: TEMPLATE };
}

/** Which binary a hand's `cli` resolves to on this machine (qwen-code → qwen when only qwen is installed). */
export function resolveCli(cli, has = onPath) {
  for (const c of CLI_ALIASES[cli] ?? [cli]) if (has(c)) return c;
  return null;
}

/** Local hands with resolved binaries and absolute worktrees; problems are named, never guessed around. */
export function resolveHands(registry, { has = onPath, exists = existsSync } = {}) {
  const local = (registry.hands ?? []).filter((h) => (h.kind ?? 'local') !== 'external');
  return local.map((h) => {
    const worktree = isAbsolute(h.worktree ?? '') ? h.worktree : resolve(ROOT, h.worktree ?? '');
    const problems = [];
    if (!h.name) problems.push('no name');
    if (isPlaceholder(h.worktree)) problems.push(`worktree is a placeholder (${h.worktree}) — edit ${REGISTRY}`);
    else if (!exists(worktree)) problems.push(`worktree missing: ${worktree}`);
    const bin = resolveCli(h.cli, has);
    if (!bin) problems.push(`cli not on PATH: ${h.cli}`);
    return { name: h.name, cli: h.cli, bin, args: h.args ?? [], worktree, problems };
  });
}

export const logPath = (hand, date = today(), base = PRIVATE) => join(base, hand, `${date}.log`);

/** The tmux plan as argv arrays — testable without tmux. Pane ids are resolved at run time (see run()). */
export function plan(hands, { session = 'timmy', window = 'hands', date = today(), base = PRIVATE } = {}) {
  const steps = [];
  hands.forEach((h, i) => {
    const log = logPath(h.name, date, base);
    steps.push({ hand: h.name, op: 'mkdir', path: dirname(log) });
    if (i === 0) steps.push({ hand: h.name, op: 'tmux', argv: ['new-session', '-d', '-s', session, '-n', window, '-c', h.worktree, '-P', '-F', '#{pane_id}'] });
    else steps.push({ hand: h.name, op: 'tmux', argv: ['split-window', '-t', `${session}:${window}`, '-c', h.worktree, '-P', '-F', '#{pane_id}'] });
    steps.push({ hand: h.name, op: 'tmux', argv: ['select-pane', '-t', '{PANE}', '-T', h.name] });
    // the log is attached BEFORE the CLI starts, so the first byte the hand prints is captured
    steps.push({ hand: h.name, op: 'tmux', argv: ['pipe-pane', '-o', '-t', '{PANE}', `exec cat >> '${log}'`], log });
    steps.push({ hand: h.name, op: 'tmux', argv: ['send-keys', '-t', '{PANE}', `export TIMMY_HAND='${h.name}'; clear; ${[h.bin, ...h.args].join(' ')}`, 'C-m'] });
  });
  if (hands.length > 1) steps.push({ op: 'tmux', argv: ['select-layout', '-t', `${session}:${window}`, 'tiled'] });
  return steps;
}

export function hasSession(session) { return sh('tmux', ['has-session', '-t', session]).status === 0; }

/** Execute the plan; returns the session record that `status`/`down` read. */
export function run(steps, { session = 'timmy', dry = false } = {}) {
  const panes = {}; let pane = null;
  for (const s of steps) {
    if (s.op === 'mkdir') { if (!dry) mkdirSync(s.path, { recursive: true, mode: 0o700 }); continue; }
    const argv = s.argv.map((a) => (a === '{PANE}' ? pane : a));
    if (dry) { console.log('tmux ' + argv.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')); if (/new-session|split-window/.test(argv[0])) pane = `%${Object.keys(panes).length}`; if (s.hand && !panes[s.hand]) panes[s.hand] = { pane, log: s.log ?? null }; if (s.log) panes[s.hand].log = s.log; continue; }
    const r = sh('tmux', argv);
    if (r.status !== 0) throw new Error(`tmux ${argv[0]} failed for ${s.hand ?? 'layout'}: ${(r.stderr || '').trim()}`);
    if (/new-session|split-window/.test(argv[0])) { pane = r.stdout.trim(); panes[s.hand] = { pane, log: null }; }
    if (s.log) panes[s.hand].log = s.log;
  }
  return { schema: 'timmy.cockpit-session/1', session, started_at: new Date().toISOString(), panes };
}

/** Propose a registry from the worktrees and the ledger's "HANDS: <hand> … in worktree <path>" lines. */
export function discover() {
  const wts = sh('git', ['worktree', 'list', '--porcelain'], { cwd: ROOT }).stdout.split('\n\n').map((b) => { const m = {}; for (const l of b.split('\n')) { const [k, ...v] = l.split(' '); if (k) m[k] = v.join(' '); } return m; }).filter((m) => m.worktree);
  const ledger = existsSync(join(ROOT, 'orders.log')) ? readFileSync(join(ROOT, 'orders.log'), 'utf8') : '';
  const byWorktree = {};
  for (const m of ledger.matchAll(/HANDS:\s*([a-z][a-z-]*)[^|]*?in worktree\s+([^\s,;|]+)/g)) byWorktree[resolve(ROOT, m[2])] = m[1].replace(/-code$/, '');
  const hands = wts.filter((m) => /refs\/heads\/order\//.test(m.branch ?? '')).map((m) => {
    const name = byWorktree[m.worktree] ?? 'unassigned';
    const cli = name === 'claude' ? 'claude' : name === 'codex' ? 'codex' : name === 'qwen' ? 'qwen-code' : '<cli>';
    return { name: name === 'unassigned' ? `unassigned:${(m.branch ?? '').replace('refs/heads/order/', '')}` : name, kind: name === 'unassigned' ? 'unassigned' : 'local', cli, args: [], worktree: m.worktree, branch: (m.branch ?? '').replace('refs/heads/', '') };
  });
  return { schema: 'timmy.cockpit-hands/1', session: 'timmy', hands: [...hands, { name: 'cursor-bugbot', kind: 'external' }, { name: 'sourcery', kind: 'external' }], note: 'proposed by `timmy cockpit hands --discover`: assign each unassigned worktree to a hand, then keep one line per hand' };
}

if (process.argv[1]?.endsWith('cockpit.mjs')) {
  const args = process.argv.slice(2); const cmd = args[0] ?? 'status';
  const flag = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
  const has = (k) => args.includes(k);
  const session = flag('--session', 'timmy');
  try {
    if (cmd === 'hands') {
      if (has('--discover')) { const p = discover(); if (has('--write')) { if (existsSync(REGISTRY)) throw new Error(`${REGISTRY} exists; edit it instead`); mkdirSync(PRIVATE, { recursive: true, mode: 0o700 }); writeFileSync(REGISTRY, JSON.stringify(p, null, 1) + '\n', { mode: 0o600 }); console.log(JSON.stringify({ ok: true, wrote: REGISTRY, hands: p.hands.length })); } else console.log(JSON.stringify(p, null, 1)); }
      else { const reg = loadRegistry(); console.log(JSON.stringify({ source: reg.source, file: reg.file, hands: resolveHands(reg).map((h) => ({ name: h.name, cli: h.cli, bin: h.bin, worktree: h.worktree, problems: h.problems })), external: (reg.hands ?? []).filter((h) => h.kind === 'external').map((h) => h.name) }, null, 1)); }
    } else if (cmd === 'up') {
      if (!onPath('tmux')) throw new Error('tmux is not installed');
      const reg = loadRegistry();
      if (reg.source === 'template' && !has('--dry')) throw new Error(`no registry at ${REGISTRY} — run: timmy cockpit hands --discover --write, then edit it`);
      const hands = resolveHands(reg);
      const bad = hands.filter((h) => h.problems.length);
      if (bad.length && !has('--dry')) throw new Error('refusing to start: ' + bad.map((h) => `${h.name}: ${h.problems.join('; ')}`).join(' | '));
      if (!hands.length) throw new Error('no local hands in the registry');
      if (hasSession(session)) { if (has('--restart')) sh('tmux', ['kill-session', '-t', session]); else throw new Error(`session "${session}" is already up — timmy cockpit attach, or --restart`); }
      const steps = plan(hands, { session });
      const rec = run(steps, { session, dry: has('--dry') });
      if (!has('--dry')) { mkdirSync(PRIVATE, { recursive: true, mode: 0o700 }); writeFileSync(join(PRIVATE, 'session.json'), JSON.stringify(rec, null, 1) + '\n', { mode: 0o600 }); }
      console.log(JSON.stringify({ ok: true, dry: has('--dry'), session, panes: Object.fromEntries(Object.entries(rec.panes).map(([h, p]) => [h, { pane: p.pane, log: p.log }])), attach: `timmy cockpit attach${session !== 'timmy' ? ` --session ${session}` : ''}` }, null, 1));
    } else if (cmd === 'attach') {
      if (!hasSession(session)) throw new Error(`no session "${session}" — timmy cockpit up`);
      const r = spawnSync('tmux', ['attach', '-t', session], { stdio: 'inherit' }); process.exit(r.status ?? 0);
    } else if (cmd === 'down') {
      const r = sh('tmux', ['kill-session', '-t', session]); console.log(JSON.stringify({ ok: r.status === 0, session, note: r.status === 0 ? 'session killed; logs kept under .timmy/private/cockpit/' : (r.stderr || '').trim() }));
    } else if (cmd === 'status') {
      const up = hasSession(session);
      const panes = up ? sh('tmux', ['list-panes', '-t', session, '-F', '#{pane_id} #{pane_title} #{pane_current_path} #{pane_pid}']).stdout.trim().split('\n').filter(Boolean) : [];
      const logs = existsSync(PRIVATE) ? readdirSync(PRIVATE, { withFileTypes: true }).filter((d) => d.isDirectory()).flatMap((d) => readdirSync(join(PRIVATE, d.name)).filter((f) => f.endsWith('.log')).map((f) => ({ hand: d.name, file: join(PRIVATE, d.name, f), bytes: statSync(join(PRIVATE, d.name, f)).size }))) : [];
      console.log(JSON.stringify({ session, up, panes, logs }, null, 1));
    } else { console.error('usage: timmy cockpit hands|up|attach|status|down [--discover --write] [--dry] [--restart] [--session name]'); process.exit(2); }
  } catch (e) { console.error(`[cockpit] ${e.message}`); process.exit(1); }
}
