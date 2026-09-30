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
import { accessSync, constants, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// Installed assets stay beside this module; mutable state belongs to the caller.
export const ROOT = resolve(process.env.TIMMY_REPO_ROOT || process.cwd());
export const PRIVATE = join(resolve(process.env.TIMMY_PRIVATE_DIR || join(ROOT, '.timmy', 'private')), 'cockpit');
export const REGISTRY = join(PRIVATE, 'hands.json');
const TEMPLATE = join(HERE, 'hands.example.json');
export const CLI_ALIASES = { claude: ['claude'], codex: ['codex'], 'qwen-code': ['qwen-code', 'qwen'], qwen: ['qwen', 'qwen-code'] };
const today = () => new Date().toISOString().slice(0, 10);
const sh = (cmd, argv, opts = {}) => spawnSync(cmd, argv, { encoding: 'utf8', ...opts });
const text = (value) => typeof value === 'string' && value.length <= 32768 && !/[\x00-\x1f\x7f-\x9f]/.test(value);
const identity = (value) => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value) && !['constructor', 'prototype', '__proto__'].includes(value);
const assertIdentity = (value, label) => { if (!identity(value)) throw new Error(`Invalid ${label}; use letters, digits, underscores or hyphens, starting with a letter.`); return value; };
const argvValid = (args) => Array.isArray(args) && args.length <= 256 && args.every(text);
const onPath = (bin) => {
  if (!text(bin) || !bin) return false;
  const paths = isAbsolute(bin) ? [bin] : bin.includes('/') ? [] : (process.env.PATH ?? '').split(delimiter).filter(isAbsolute).map(dir => join(dir, bin));
  return paths.some(path => { try { if (!statSync(path).isFile()) return false; accessSync(path, constants.X_OK); return true; } catch { return false; } });
};
const quote = (value) => { if (!text(value)) throw new Error('Command arguments cannot contain terminal controls.'); return "'" + value.replaceAll("'", "'\"'\"'") + "'"; };
// tmux expands formats in -c and additionally strftime in pipe-pane, before sh.
const tmuxLiteral = (value) => value.replaceAll('#', '##');
const pipeLiteral = (value) => tmuxLiteral(value).replaceAll('%', '%%');
const target = (session) => '=' + assertIdentity(session, 'session');
const isPlaceholder = (v) => typeof v === 'string' && /<[a-z-]+>/.test(v);

/** The registry: private overlay first, else the committed template (flagged, so `up` refuses to launch placeholders). */
export function loadRegistry(file = REGISTRY) {
  if (existsSync(file)) return { ...JSON.parse(readFileSync(file, 'utf8')), source: 'private', file };
  return { ...JSON.parse(readFileSync(TEMPLATE, 'utf8')), source: 'template', file: TEMPLATE };
}

/** Which binary a hand's `cli` resolves to on this machine (qwen-code → qwen when only qwen is installed). */
export function resolveCli(cli, has = onPath) {
  for (const c of (Object.hasOwn(CLI_ALIASES, cli) ? CLI_ALIASES[cli] : [cli])) if (has(c)) return c;
  return null;
}

/** Local hands with resolved binaries and absolute worktrees; problems are named, never guessed around. */
export function resolveHands(registry, { has = onPath, exists = existsSync } = {}) {
  if (!registry || !Array.isArray(registry.hands) || registry.hands.length > 128) throw new Error('Registry hands must be a bounded array.');
  const seen = new Set();
  return registry.hands.filter(h => h?.kind !== 'external').map((h) => {
    if (!h || typeof h !== 'object') throw new Error('Invalid hand entry.');
    const problems = [];
    if (!identity(h.name)) problems.push('invalid name');
    if (seen.has(h.name)) problems.push('duplicate name');
    seen.add(h.name);
    if (!text(h.worktree) || !h.worktree) problems.push('invalid worktree');
    const worktree = text(h.worktree) && h.worktree ? resolve(ROOT, h.worktree) : ROOT;
    if (isPlaceholder(h.worktree)) problems.push('worktree is a placeholder — edit the private registry');
    else if (!exists(worktree)) problems.push(`worktree missing: ${worktree}`);
    const bin = text(h.cli) && h.cli ? resolveCli(h.cli, has) : null;
    if (!bin) problems.push(`cli not on PATH: ${text(h.cli) ? h.cli : '(invalid)'}`);
    const args = h.args ?? [];
    if (!argvValid(args)) problems.push('args must be an array of strings without terminal controls');
    return { name: h.name, cli: h.cli, bin, args, worktree, problems };
  });
}

export function logPath(hand, date = today(), base = PRIVATE) {
  assertIdentity(hand, 'hand');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !text(base) || !isAbsolute(base)) throw new Error('Invalid log destination.');
  return join(base, hand, `${date}.log`);
}

/** Only static shell syntax is constructed; every registry value is one quoted argument. */
export function plan(hands, { session = 'timmy', window = 'hands', date = today(), base = PRIVATE } = {}) {
  const windowTarget = `${target(session)}:=${assertIdentity(window, 'window')}`;
  if (!Array.isArray(hands) || !hands.length || hands.length > 128) throw new Error('A bounded nonempty hand list is required.');
  const steps = [], seen = new Set();
  hands.forEach((h, i) => {
    assertIdentity(h.name, 'hand');
    if (seen.has(h.name)) throw new Error('Duplicate hand name.');
    seen.add(h.name);
    if (!text(h.bin) || !h.bin || !argvValid(h.args) || !text(h.worktree) || !isAbsolute(h.worktree)) throw new Error('Invalid hand command or worktree.');
    const log = logPath(h.name, date, base);
    steps.push({ hand: h.name, op: 'mkdir', path: dirname(log) });
    if (i === 0) steps.push({ hand: h.name, op: 'tmux', argv: ['new-session', '-d', '-s', session, '-n', window, '-c', tmuxLiteral(h.worktree), '-P', '-F', '#{session_id} #{pane_id}'] });
    else steps.push({ hand: h.name, op: 'tmux', argv: ['split-window', '-t', windowTarget, '-c', tmuxLiteral(h.worktree), '-P', '-F', '#{pane_id}'] });
    steps.push({ hand: h.name, op: 'tmux', argv: ['select-pane', '-t', '{PANE}', '-T', h.name] });
    // Formats and strftime expand even inside shell quotes, so escape them too.
    steps.push({ hand: h.name, op: 'tmux', argv: ['pipe-pane', '-o', '-t', '{PANE}', pipeLiteral(`umask 077; exec ${quote('/bin/cat')} >> ${quote(log)}`)], log });
    const command = `TIMMY_HAND=${quote(h.name)} ` + [h.bin, ...h.args].map(quote).join(' ');
    steps.push({ hand: h.name, op: 'tmux', argv: ['send-keys', '-l', '-t', '{PANE}', '--', command] });
    steps.push({ hand: h.name, op: 'tmux', argv: ['send-keys', '-t', '{PANE}', 'Enter'] });
  });
  if (hands.length > 1) steps.push({ op: 'tmux', argv: ['select-layout', '-t', windowTarget, 'tiled'] });
  return steps;
}

export function hasSession(session, execute = sh) { return execute('tmux', ['has-session', '-t', target(session)]).status === 0; }

/** Execute only a plan produced above. Failures clean up the newly owned session ID. */
export function run(steps, { session = 'timmy', dry = false, execute = sh, print = console.log } = {}) {
  target(session);
  const panes = Object.create(null); let pane = null, ownedSession = null;
  try {
    for (const s of steps) {
      if (s.op === 'mkdir') { if (!dry) mkdirSync(s.path, { recursive: true, mode: 0o700 }); continue; }
      const argv = s.argv.map(a => a === '{PANE}' ? pane : ownedSession && a.startsWith(`=${session}:`) ? ownedSession + a.slice(session.length + 1) : a);
      if (dry) {
        if (argv[0] === 'new-session' || argv[0] === 'split-window') { pane = `%${Object.keys(panes).length}`; panes[s.hand] = { pane, log: null }; }
        print('tmux ' + argv.map(a => quote(String(a))).join(' '));
      } else {
        const r = execute('tmux', argv);
        if (r.status !== 0) throw new Error(`tmux ${argv[0]} failed for ${s.hand ?? 'layout'}.`);
        if (argv[0] === 'new-session') {
          const ids = r.stdout.trim().match(/^(\$\d+) (%\d+)$/);
          if (!ids) throw new Error('tmux returned invalid session or pane identity.');
          [, ownedSession, pane] = ids; panes[s.hand] = { pane, log: null };
        } else if (argv[0] === 'split-window') {
          pane = r.stdout.trim(); if (!/^%\d+$/.test(pane)) throw new Error('tmux returned invalid pane identity.');
          panes[s.hand] = { pane, log: null };
        }
      }
      if (s.log) panes[s.hand].log = s.log;
    }
  } catch (error) {
    if (ownedSession && !dry) { try { execute('tmux', ['kill-session', '-t', ownedSession]); } catch { /* original failure remains */ } }
    throw error;
  }
  return { schema: 'timmy.cockpit-session/1', session, started_at: new Date().toISOString(), panes };
}

/** Validation precedes any restart; a dry run never contacts tmux or changes files. */
export function up(registry, { session = 'timmy', dry = false, restart = false, base = PRIVATE, has = onPath, exists = existsSync, execute = sh, print = console.log } = {}) {
  target(session);
  const hands = resolveHands(registry, { has, exists });
  const bad = hands.filter(h => h.problems.length);
  if (bad.length) throw new Error('Refusing invalid or unresolved cockpit hands.');
  const steps = plan(hands, { session, base });
  if (dry) return run(steps, { session, dry: true, execute, print });
  if (registry.source === 'template') throw new Error('Create and edit a private cockpit registry before launch.');
  if (!has('tmux')) throw new Error('tmux is not installed');
  if (hasSession(session, execute)) {
    if (!restart) throw new Error('Session is already up; attach or explicitly restart.');
    if (execute('tmux', ['kill-session', '-t', target(session)]).status !== 0) throw new Error('Existing session could not be stopped.');
  }
  return run(steps, { session, execute, print });
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
    target(session);
    if (cmd === 'hands') {
      if (has('--discover')) { const p = discover(); if (has('--write')) { if (existsSync(REGISTRY)) throw new Error(`${REGISTRY} exists; edit it instead`); mkdirSync(PRIVATE, { recursive: true, mode: 0o700 }); writeFileSync(REGISTRY, JSON.stringify(p, null, 1) + '\n', { mode: 0o600 }); console.log(JSON.stringify({ ok: true, wrote: REGISTRY, hands: p.hands.length })); } else console.log(JSON.stringify(p, null, 1)); }
      else { const reg = loadRegistry(); console.log(JSON.stringify({ source: reg.source, file: reg.file, hands: resolveHands(reg).map((h) => ({ name: h.name, cli: h.cli, bin: h.bin, worktree: h.worktree, problems: h.problems })), external: (reg.hands ?? []).filter((h) => h.kind === 'external').map((h) => h.name) }, null, 1)); }
    } else if (cmd === 'up') {
      const rec = up(loadRegistry(), { session, dry: has('--dry'), restart: has('--restart') });
      if (!has('--dry')) { mkdirSync(PRIVATE, { recursive: true, mode: 0o700 }); writeFileSync(join(PRIVATE, 'session.json'), JSON.stringify(rec, null, 1) + '\n', { mode: 0o600 }); }
      console.log(JSON.stringify({ ok: true, dry: has('--dry'), session, panes: rec.panes, attach: `timmy cockpit attach${session !== 'timmy' ? ` --session ${session}` : ''}` }, null, 1));
    } else if (cmd === 'attach') {
      if (!hasSession(session)) throw new Error(`no session "${session}" — timmy cockpit up`);
      const r = spawnSync('tmux', ['attach', '-t', target(session)], { stdio: 'inherit' }); process.exit(r.status ?? 0);
    } else if (cmd === 'down') {
      const r = sh('tmux', ['kill-session', '-t', target(session)]); console.log(JSON.stringify({ ok: r.status === 0, session, note: r.status === 0 ? 'session killed; logs kept under .timmy/private/cockpit/' : (r.stderr || '').trim() }));
    } else if (cmd === 'status') {
      const up = hasSession(session);
      const panes = up ? sh('tmux', ['list-panes', '-t', target(session), '-F', '#{pane_id} #{pane_title} #{pane_current_path} #{pane_pid}']).stdout.trim().split('\n').filter(Boolean) : [];
      const logs = existsSync(PRIVATE) ? readdirSync(PRIVATE, { withFileTypes: true }).filter((d) => d.isDirectory()).flatMap((d) => readdirSync(join(PRIVATE, d.name)).filter((f) => f.endsWith('.log')).map((f) => ({ hand: d.name, file: join(PRIVATE, d.name, f), bytes: statSync(join(PRIVATE, d.name, f)).size }))) : [];
      console.log(JSON.stringify({ session, up, panes, logs }, null, 1));
    } else { console.error('usage: timmy cockpit hands|up|attach|status|down [--discover --write] [--dry] [--restart] [--session name]'); process.exit(2); }
  } catch (e) { console.error(`[cockpit] ${e.message}`); process.exit(1); }
}
