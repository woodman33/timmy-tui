/**
 * C-15, the frozen qualification (AGENTS.md §5), C-16, the final acceptance of a new revision, and C-17,
 * the release candidate's: the UI playbook's CLI (§19.5) and Agent TUI (§19.6) checklists against the
 * real Timmy in real PTYs (tmux), captures at 60, 80 and 120 columns in Timmy Night and Day through the
 * contrast gate, the shared receipt store and the frozen tree preserved, the related suites, Timmy Canvas
 * in a real browser, a replay in a fresh clone, the packed package installed and used as a user meets it
 * (INSTALL-01), and the evidence of the two checks that run elsewhere.
 *
 *   npx tsx scripts/ui/qualify.ts --out DIR --monitor-home DIR [--repo DIR] [--dev] [--only ID,ID] [--controls]
 *     [--skip ID,ID --skip-why TEXT] [--freeze]
 *
 * Every check is binary and its expectation is written here before the run. Without --dev the run
 * stops at the first genuine failure (AGENTS.md §5) and reports the rest as not run; --dev runs every
 * check (development only, never a qualification). --controls first runs the negative controls of the
 * check primitives: each must fail on input known to be wrong (DOCTRINE §12). Evidence (raw PTY bytes,
 * screens, captures, verdicts) goes to DIR, which stays private: it can show paths.
 *
 * --skip reports the named checks as not run, with the reason given. It exists for the isolated sandbox
 * replay (scripts/ui/replay-sandbox.sh), where REPLAY-02 and LIVE-01 cannot run. Those two read evidence
 * taken elsewhere (docs/ui-cockpit/c17/: the sandbox's own frozen run, and the live turns on the
 * operator's Mac), each bound to the commit it ran at: the frozen tree may differ from that commit only
 * under docs/ui-cockpit/, where the ledger and the evidence live. C-16's evidence stays in c16/.
 */
import { createHash } from 'node:crypto';
import { builtinModules } from 'node:module';
import { execFileSync, spawn as spawnChild, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { visibleWidth } from '../../src/term/width.js';
import { parseAnsiFrame, TIMMY_NIGHT } from '../../src/tui/qa/ansi-frame.js';

const argv = process.argv.slice(2);
const opt = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const OUT = resolve(opt('--out') ?? '');
const REPO = resolve(opt('--repo') ?? '.');
const MONITOR_HOME = opt('--monitor-home') ? resolve(opt('--monitor-home') as string) : '';
const DEV = argv.includes('--dev');
const ONLY = opt('--only')?.split(',');
const SKIP = opt('--skip')?.split(',').filter(Boolean) ?? [];
const SKIP_WHY = opt('--skip-why') ?? '';
const USAGE = 'usage: qualify.ts --out DIR --monitor-home DIR [--repo DIR] [--dev] [--only ID,ID] [--controls] [--skip ID,ID --skip-why TEXT] [--freeze]';
if (!opt('--out') || !MONITOR_HOME || (SKIP.length > 0 && !SKIP_WHY)) {
  console.error(USAGE);
  if (SKIP.length > 0 && !SKIP_WHY) console.error('--skip needs --skip-why TEXT: a skipped check is reported as not run, with its reason');
  process.exit(2);
}
const EVID = join(OUT, 'evidence');
mkdirSync(EVID, { recursive: true });
// tmux sockets live in a short temporary folder: a socket path over 107 bytes cannot be bound.
const TMUXDIR = mkdtempSync('/tmp/tq-');
process.on('exit', () => rmSync(TMUXDIR, { recursive: true, force: true }));
const NODE = process.execPath;
/** tmux, found once on this run's PATH: the PTYs are driven with it, whatever PATH a scenario gives its own programs. */
const TMUX = ((): string => {
  const r = spawnSync('bash', ['-c', 'command -v tmux'], { encoding: 'utf8' });
  const found = (r.stdout ?? '').trim();
  if (r.status !== 0 || !found.startsWith('/')) { console.error('qualify: tmux is not on the PATH'); process.exit(2); }
  return found;
})();
const LOADER = pathToFileURL(join(REPO, 'node_modules/tsx/dist/loader.mjs')).href;
const CLI = join(REPO, 'src/cli.ts');
const FIXTURE = join(REPO, 'tests/fixtures/repl-qualify-fixture.ts');
const APPROVAL = join(REPO, 'tests/fixtures/repl-approval-fixture.ts');
const GATE = join(REPO, 'scripts/ui/gate.ts');
const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const TIMMY = (args: string): string => `${q(NODE)} --import ${q(LOADER)} ${q(CLI)} ${args}`;
/** Through the installed command's bin (timmy.ts, from source), which starts the CLI as a child process. */
const TIMMY_BIN = (args: string): string => `${q(NODE)} --import ${q(LOADER)} ${q(join(REPO, 'timmy.ts'))} ${args}`;
const NODE_TS = (file: string): string => `${q(NODE)} --import ${q(LOADER)} ${q(file)}`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const ALLOWED_EXITS = new Set([0, 1, 2, ...Array.from({ length: 15 }, (_, i) => 64 + i), 130, 143]);
const EXITS: Array<{ scenario: string; code: number }> = [];

// ── evidence primitives (each has a negative control in CONTROLS) ────────────────────────────────
interface Colors { basic: number; c256: number; truecolor: number; }
/** Every SGR color parameter in a byte stream: basic (30-37, 40-47, 90-97, 100-107), 256 and truecolor. */
export function colorsIn(text: string): Colors {
  const out: Colors = { basic: 0, c256: 0, truecolor: 0 };
  for (const m of text.matchAll(/\x1b\[([0-9;:]*)m/g)) {
    const p = m[1].split(/[;:]/).map(Number);
    for (let i = 0; i < p.length; i++) {
      const n = p[i];
      if ((n === 38 || n === 48 || n === 58) && p[i + 1] === 5) { out.c256++; i += 2; continue; }
      if ((n === 38 || n === 48 || n === 58) && p[i + 1] === 2) { out.truecolor++; i += 4; continue; }
      if ((n >= 30 && n <= 37) || (n >= 40 && n <= 47) || (n >= 90 && n <= 97) || (n >= 100 && n <= 107)) out.basic++;
    }
  }
  return out;
}
const count = (hay: string, needle: string): number => hay.split(needle).length - 1;
const widest = (lines: string[]): number => Math.max(0, ...lines.map((l) => visibleWidth(l.replace(/\s+$/, ''))));
const nonAscii = (b: Buffer): number => b.filter((x) => x >= 0x80).length;
/** The bare imports in `src` (not relative, not node:) whose package is not in `declared`. */
export function undeclaredImports(src: string, declared: Set<string>): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)) {
    const spec = m[1];
    if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:') || spec.startsWith('file:') || spec.includes('${')) continue;
    const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    if (!declared.has(name) && !builtinModules.includes(name)) out.push(spec);
  }
  return out;
}
const EM_DASH = '\u2014';
const lines = (s: string): string[] => s.split('\n');

// ── a real PTY: one tmux server per scenario, the raw bytes logged from before the program starts ──
let serial = 0;
class Pty {
  readonly sock = `q${process.pid}x${++serial}`;
  readonly raw: string;
  readonly marks: string;
  constructor(readonly name: string, readonly o: { cols: number; rows: number; env: NodeJS.ProcessEnv; cwd: string; script: string; pre?: string }) {
    this.raw = join(EVID, `${name}.raw`);
    this.marks = join(o.cwd, '..', 'exit.txt');
  }
  tmux(...args: string[]): string { return execFileSync(TMUX, ['-L', this.sock, ...args], { env: this.o.env, encoding: 'utf8' }); }
  start(): this {
    const wrapped = `sleep 0.6; ${this.o.pre ?? ''} S0=$(stty -g); ${this.o.script}; C=$?; [ "$(stty -g)" = "$S0" ] && T=same || T=changed; echo "EXIT=$C TTY=$T" > ${q(this.marks)}; sleep 900`;
    this.tmux('-f', join(REPO, 'scripts/ui/tmux-capture.conf'), 'new-session', '-d', '-s', 'q', '-x', String(this.o.cols), '-y', String(this.o.rows), '-c', this.o.cwd, 'bash', '--norc', '--noprofile', '-c', wrapped);
    this.tmux('pipe-pane', '-o', '-t', 'q', `cat >> ${q(this.raw)}`);
    return this;
  }
  screen(history = false, join = false): string { return this.tmux('capture-pane', '-p', ...(join ? ['-J'] : []), ...(history ? ['-S', '-'] : []), '-t', 'q'); }
  ansi(): string { return this.tmux('capture-pane', '-e', '-p', '-N', '-t', 'q'); }
  keys(...k: string[]): void { this.tmux('send-keys', '-t', 'q', ...k); }
  text(s: string): void { this.tmux('send-keys', '-t', 'q', '-l', s); }
  paste(s: string): void { this.tmux('set-buffer', '-b', 'qp', s); this.tmux('paste-buffer', '-p', '-d', '-b', 'qp', '-t', 'q'); }
  async waitFor(re: RegExp, ms = 20_000, history = false): Promise<string> {
    const end = Date.now() + ms;
    for (;;) {
      const s = this.screen(history);
      if (re.test(s)) return s;
      if (Date.now() > end) throw new Error(`${this.name}: timed out after ${ms}ms waiting for ${re}`);
      await sleep(40);
    }
  }
  async exited(ms = 20_000): Promise<{ code: number; tty: string }> {
    const end = Date.now() + ms;
    for (;;) {
      if (existsSync(this.marks)) {
        const m = readFileSync(this.marks, 'utf8').match(/EXIT=(\d+) TTY=(\w+)/);
        if (m) { EXITS.push({ scenario: this.name, code: Number(m[1]) }); return { code: Number(m[1]), tty: m[2] }; }
      }
      if (Date.now() > end) throw new Error(`${this.name}: still running after ${ms}ms`);
      await sleep(40);
    }
  }
  running(): boolean { return !existsSync(this.marks); }
  cursor(): string { return this.tmux('display', '-p', '-t', 'q', '#{cursor_flag}').trim(); }
  /** Sends `sig` to the program itself (the pane shell's child), as `kill <pid>` or `timeout` would. */
  signal(sig: NodeJS.Signals): void {
    const shell = this.tmux('display', '-p', '-t', 'q', '#{pane_pid}').trim();
    const pid = Number(execFileSync('pgrep', ['-P', shell], { encoding: 'utf8' }).trim().split('\n')[0]);
    process.kill(pid, sig);
  }
  resize(cols: number, rows: number): void { this.tmux('resize-window', '-t', 'q', '-x', String(cols), '-y', String(rows)); }
  bytes(): string { return existsSync(this.raw) ? readFileSync(this.raw, 'latin1') : ''; }
  utf8(): string { return existsSync(this.raw) ? readFileSync(this.raw, 'utf8') : ''; }
  save(tag = ''): void {
    try {
      writeFileSync(join(EVID, `${this.name}${tag}.screen.txt`), this.screen(true));
      writeFileSync(join(EVID, `${this.name}${tag}.ansi`), this.ansi());
    } catch { /* the server may be gone */ }
  }
  kill(): void { try { this.tmux('kill-server'); } catch { /* gone */ } }
}

type Palette = 'night' | 'day';
function sandbox(name: string, o: { palette?: Palette | null; env?: Record<string, string | undefined>; monitorHome?: boolean } = {}) {
  const dir = join(EVID, 'sb', name);
  const home = join(dir, 'home');
  const work = join(dir, 'work');
  mkdirSync(work, { recursive: true });
  mkdirSync(home, { recursive: true });
  if (o.monitorHome) cpSync(MONITOR_HOME, home, { recursive: true });
  const env: Record<string, string | undefined> = {
    PATH: `${join(REPO, 'node_modules/.bin')}:${process.env.PATH}`,
    LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', HOME: home, TIMMY_HOME: join(home, 'timmy'), TIMMY_REPO_ROOT: work,
    TIMMY_STORE: join(dir, 'store'), OPENROUTER_API_KEY: '', COLORTERM: 'truecolor', TMUX_TMPDIR: TMUXDIR, TMUX: '',
    ...(o.palette === undefined ? { TIMMY_PALETTE: 'night' } : o.palette ? { TIMMY_PALETTE: o.palette } : {}),
    ...o.env,
  };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return { dir, home, work, env: env as NodeJS.ProcessEnv };
}

const memo = new Map<string, Promise<unknown>>();
const once = <T>(key: string, f: () => Promise<T>): Promise<T> => {
  if (!memo.has(key)) memo.set(key, f());
  return memo.get(key) as Promise<T>;
};

interface Run { code: number; tty: string; raw: string; utf8: string; history: string; joined: string; ansi: string; cursor: string; }
/** A program that runs to its end on its own (no keys): the screen, history and raw bytes after it. */
function runToEnd(name: string, script: string, o: { cols?: number; rows?: number; palette?: Palette | null; env?: Record<string, string | undefined>; pre?: string; ms?: number; monitorHome?: boolean } = {}): Promise<Run> {
  return once(name, async () => {
    const sb = sandbox(name, { palette: o.palette, env: o.env, monitorHome: o.monitorHome });
    const p = new Pty(name, { cols: o.cols ?? 80, rows: o.rows ?? 40, env: sb.env, cwd: sb.work, script, pre: o.pre }).start();
    try {
      const ex = await p.exited(o.ms ?? 30_000);
      await sleep(150);
      const r = { ...ex, raw: p.bytes(), utf8: p.utf8(), history: p.screen(true), joined: p.screen(true, true), ansi: p.ansi(), cursor: p.cursor() };
      p.save();
      return r;
    } finally { p.kill(); }
  });
}
const demo = (cols: number, palette: Palette, env: Record<string, string | undefined> = {}, tag = '', flags = '') =>
  runToEnd(`demo-${cols}-${palette}${tag}`, TIMMY(`repl --demo ${flags}`), { cols, palette, env });
/** The scripted REPL (tests/fixtures/repl-qualify-fixture.ts) waiting at its prompt. */
async function fixture(name: string, script: string, o: { cols?: number; rows?: number; palette?: Palette | null; env?: Record<string, string | undefined> } = {}): Promise<Pty> {
  const sb = sandbox(name, { palette: o.palette, env: { TIMMY_Q_SCRIPT: script, ...o.env } });
  const p = new Pty(name, { cols: o.cols ?? 80, rows: o.rows ?? 30, env: sb.env, cwd: sb.work, script: NODE_TS(FIXTURE) }).start();
  await p.waitFor(/Enter to send/);
  await sleep(350); // the type-ahead guard
  return p;
}
const spawn = (args: string[], env: Record<string, string | undefined>, input = '') => {
  const sb = sandbox(`spawn-${++serial}`, { env });
  const r = spawnSync(NODE, ['--import', LOADER, ...args], { cwd: sb.work, env: sb.env, input, encoding: 'utf8', timeout: 30_000 });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

// ── checks ───────────────────────────────────────────────────────────────────────────────────────
type Status = 'pass' | 'fail' | 'deferred' | 'not run';
interface Check { id: string; line: string; ref: string; run?: () => Promise<string>; deferred?: string; notRun?: string; }
class Fail extends Error {}
/** A check that could not run here, for a reason recorded as data: reported as not run, never as a pass. */
class NotRun extends Error {}
const must = (ok: boolean, why: string): void => { if (!ok) throw new Fail(why); };

// ── evidence taken elsewhere: REPLAY-02 (an isolated sandbox) and LIVE-01 (the operator's Mac) ────────
// Each record names the commit it ran at. It holds for the frozen tree only when nothing has changed
// since that commit outside docs/ui-cockpit/, where the ledger and the evidence itself live.
const EVIDENCE = join(REPO, 'docs/ui-cockpit/c17');
const LEDGER_DIR = 'docs/ui-cockpit/';
/** The changed paths that break the binding: everything outside the ledger and evidence folder. */
export function outsideEvidence(changed: string[]): string[] { return changed.filter((p) => !p.startsWith(LEDGER_DIR)); }
/** Every path of the working tree (tracked, or untracked and not ignored) that differs from `commit`. */
function changedSince(commit: string): string[] {
  must(/^[0-9a-f]{40}$/.test(commit), `not a full commit hash: "${commit}"`);
  must(spawnSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: REPO }).status === 0, `commit ${commit.slice(0, 7)} is not in this repository`);
  const git = (...a: string[]): string[] => execFileSync('git', a, { cwd: REPO, encoding: 'utf8' }).split('\n').filter(Boolean);
  return [...new Set([...git('diff', '--name-only', commit), ...git('ls-files', '-o', '--exclude-standard')])].sort();
}
/** The tree manifest's hash for `commit` as committed: a clean checkout of it, hashed the way the freeze hashes. */
function manifestHash(commit: string): string {
  const tmp = mkdtempSync(join(TMUXDIR, 'm-'));
  try {
    execFileSync('git', ['clone', '--quiet', '--shared', '--no-checkout', REPO, tmp]);
    execFileSync('git', ['-C', tmp, 'checkout', '--quiet', commit]);
    return createHash('sha256').update(treeManifest(tmp)).digest('hex');
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}
/** The reason a recorded blocker (BLOCKED.json) gives for a check that runs elsewhere, with its time. */
export function blockerOf(rec: { reason?: unknown; at?: unknown }): string {
  must(typeof rec?.reason === 'string' && rec.reason.trim().length >= 20, 'the blocker gives no reason');
  must(typeof rec?.at === 'string' && !Number.isNaN(Date.parse(rec.at)), 'the blocker gives no time');
  return `${rec.reason} (recorded ${rec.at})`;
}
/** `dir` must hold the evidence or a recorded blocker, never both and never neither; a blocker ends the check as not run. */
function evidenceOrBlocker(dir: string, evidence: string): void {
  const where = `${dir.slice(REPO.length + 1)}/`;
  const has = existsSync(join(dir, evidence));
  if (existsSync(join(dir, 'BLOCKED.json'))) {
    must(!has, `both ${evidence} and a blocker are recorded in ${where}`);
    throw new NotRun(`Blocked: ${blockerOf(JSON.parse(readFileSync(join(dir, 'BLOCKED.json'), 'utf8')))}`);
  }
  must(has, `neither ${evidence} nor a recorded blocker in ${where}`);
}
/** Checks that cannot run inside the sandbox replay (they are the evidence it feeds), and one that may not. */
const REMOTE_MUST_SKIP = ['REPLAY-02', 'LIVE-01'];
const REMOTE_MAY_SKIP = ['CANVAS-01']; // only where no Chromium could be installed and started, saying so
interface RunRecord { dev: boolean; stopped: string | null; results: Array<{ id: string; status: string; detail: string }>; }
/** What is wrong with a remote frozen run of `checks`: [] when every check that can run there passed there. */
export function remoteVerdict(run: RunRecord, checks: Array<Pick<Check, 'id' | 'deferred' | 'notRun'>>): string[] {
  const bad: string[] = [];
  if (run.dev) bad.push('a development run (--dev), not a frozen one');
  if (run.stopped) bad.push(`it stopped at ${run.stopped}`);
  const got = new Map(run.results.map((r) => [r.id, r]));
  const skipped = (id: string): boolean => got.get(id)?.status === 'not run' && /^Skipped in this run/.test(got.get(id)?.detail ?? '');
  for (const c of checks) {
    const r = got.get(c.id);
    if (!r) { bad.push(`${c.id}: absent`); continue; }
    if (c.deferred) { if (r.status !== 'deferred') bad.push(`${c.id}: ${r.status}, not deferred`); continue; }
    if (c.notRun) { if (r.status !== 'not run') bad.push(`${c.id}: ${r.status}, not "not run"`); continue; }
    if (REMOTE_MUST_SKIP.includes(c.id)) { if (!skipped(c.id)) bad.push(`${c.id}: ${r.status}, not skipped`); continue; }
    if (r.status === 'pass' || (REMOTE_MAY_SKIP.includes(c.id) && skipped(c.id))) continue;
    bad.push(`${c.id}: ${r.status}`);
  }
  for (const r of run.results) if (!checks.some((c) => c.id === r.id)) bad.push(`${r.id}: not a check of this runner`);
  return bad;
}
/** The LIVE-01 steps, in order: a turn with a tool call, its interruption, the prompt usable after it, another turn. */
const LIVE_STEPS = ['tool-turn', 'interrupt', 'prompt-after', 'second-turn'];
interface LiveStep { id: string; ok: boolean; tools?: string[]; receipt?: string; outcome?: string; screens?: string[] }
interface LiveRecord { commit: string; model: string; steps: LiveStep[]; spend: { run_usd: number; total_usd: number; cap_usd: number } }
/** What is missing from a LIVE-01 record: [] when it holds every step, ok, within its spending cap. */
export function liveVerdict(rec: LiveRecord): string[] {
  const bad: string[] = [];
  if (!/^[0-9a-f]{40}$/.test(rec?.commit ?? '')) bad.push('no full commit hash');
  if (typeof rec?.model !== 'string' || rec.model.length === 0) bad.push('no model');
  const steps: LiveStep[] = Array.isArray(rec?.steps) ? rec.steps : [];
  const step = (id: string): LiveStep | undefined => steps.find((x) => x?.id === id);
  for (const id of LIVE_STEPS) { const x = step(id); if (!x) bad.push(`no ${id} step`); else if (x.ok !== true) bad.push(`${id} not ok`); }
  if (step('tool-turn') && !((step('tool-turn')?.tools?.length ?? 0) > 0)) bad.push('the tool turn names no tool call');
  for (const id of ['tool-turn', 'second-turn']) if (step(id) && !step(id)?.receipt) bad.push(`${id} has no sealed receipt`);
  if (step('interrupt') && step('interrupt')?.outcome !== 'cancelled') bad.push('the interruption did not end the turn as cancelled');
  const sp = rec?.spend;
  if (!sp || ![sp.run_usd, sp.total_usd, sp.cap_usd].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)) bad.push('spend not recorded');
  else if (sp.total_usd > sp.cap_usd) bad.push(`spend $${sp.total_usd} over the $${sp.cap_usd} cap`);
  return bad;
}

/** Where a replay ran, as scripts/ui/replay-sandbox.sh records it in replay.json. */
interface ReplayEnv {
  platform: string; os?: string; sha?: string;
  runner_environment?: string; image_os?: string; image_version?: string; run_id?: string; run_attempt?: string; repository?: string; workflow_sha?: string; run_url?: string;
}
/** The fields a run on GitHub Actions records (the runner sets them; the replay script copies them). */
const GITHUB_FIELDS = ['runner_environment', 'image_os', 'image_version', 'run_id', 'run_attempt', 'repository', 'workflow_sha', 'run_url'] as const;
/**
 * Where a replay of the frozen commit `head` ran, as its own record proves it: `bad` is [] when that is a
 * platform AGENTS.md §10 allows for this replay, and `label` names it as it was. A Vercel Sandbox; or, under
 * §10's cockpit exception (C-17), a GitHub-hosted runner, with its image, its run and the commit it ran. A
 * record that carries GitHub's provenance is never a Vercel run.
 */
export function platformVerdict(env: ReplayEnv, head: string): { bad: string[]; label: string } {
  const bad: string[] = [];
  const fromGitHub = GITHUB_FIELDS.some((k) => env?.[k] !== undefined);
  if (typeof env?.os !== 'string' || env.os.length === 0) bad.push('no OS');
  if (env?.platform === 'vercel-sandbox') {
    if (fromGitHub) bad.push('a run with GitHub Actions provenance labeled as a Vercel Sandbox');
    if (env.sha !== head) bad.push(`it ran ${env.sha ? env.sha.slice(0, 7) : 'no named commit'}, not ${head.slice(0, 7)}`);
    return { bad, label: `Vercel Sandbox (${env.os})` };
  }
  if (env?.platform === 'github-actions') {
    if (env.runner_environment !== 'github-hosted') bad.push(`runner environment ${JSON.stringify(env.runner_environment ?? null)}, not github-hosted (an isolated machine for the job)`);
    if (!/^[a-z]+\d+$/.test(env.image_os ?? '')) bad.push('no runner image');
    if (!env.image_version) bad.push('no runner image version');
    if (!/^\d+$/.test(env.run_id ?? '')) bad.push('no run ID');
    if (!/^\d+$/.test(env.run_attempt ?? '')) bad.push('no run attempt');
    if (!/^[\w.-]+\/[\w.-]+$/.test(env.repository ?? '')) bad.push('no repository');
    if (env.sha !== head) bad.push(`it ran ${env.sha ? env.sha.slice(0, 7) : 'no named commit'}, not ${head.slice(0, 7)}`);
    return { bad, label: `GitHub Actions, a GitHub-hosted runner (${env.os}; image ${env.image_os} ${env.image_version}; run ${env.run_id}, attempt ${env.run_attempt}, in ${env.repository})` };
  }
  bad.push(`platform ${JSON.stringify(env?.platform ?? null)} is not one AGENTS.md §10 allows for this replay`);
  return { bad, label: String(env?.platform) };
}
/** CLI-29: what is wrong with what a version flag printed: [] when it is the version line and nothing else. */
export function versionProblems(out: string, version: string): string[] {
  const want = `timmy-tui v${version}\n`;
  return out === want ? [] : [`printed ${JSON.stringify(out.slice(0, 120))}, not ${JSON.stringify(want)}`];
}
/** CLI-29: the help rows that give -v a meaning other than the version. */
export function helpVProblems(help: string): string[] {
  return help.split('\n').filter((l) => /(^|[\s,])-v(?=[\s,]|$)/.test(l) && !/version/i.test(l)).map((l) => `-v is not the version here: "${l.trim()}"`);
}
/** INSTALL-01: what is wrong with a next step an installed user is given: npm start needs a checkout. */
export function nextStepProblems(out: string, want: RegExp): string[] {
  const bad: string[] = [];
  if (/npm start\b/.test(out)) bad.push('it names npm start, which an installed package does not have');
  if (!want.test(out)) bad.push(`no line matching ${want}`);
  return bad;
}
/** The cursor at column 0 once a program ends, so whatever the shell prints next starts its own line. */
export const atLineStart = (cursorX: string): boolean => cursorX.trim() === '0';

const CHECKS: Check[] = [
  // §18 Process and Copy ([cli] and [agent-tui] run only these two groups of §18)
  { id: 'PROC-01', ref: '18 Process', line: 'Every third-party import (in the files this branch added or changed) exists in the manifest', run: async () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
    const declared = new Set(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies }));
    // The branch's files: everything changed since it left main (committed or not), and untracked files.
    const mb = spawnSync('git', ['merge-base', 'HEAD', 'origin/main'], { cwd: REPO, encoding: 'utf8' });
    const base = (mb.stdout ?? '').trim();
    must(mb.status === 0 && /^[0-9a-f]{40}$/.test(base), 'no merge base with origin/main, so the branch\'s files cannot be named (a full clone with origin/main is needed)');
    const changed = execFileSync('git', ['diff', '--name-only', base], { cwd: REPO, encoding: 'utf8' }).split('\n');
    const added = execFileSync('git', ['ls-files', '-o', '--exclude-standard'], { cwd: REPO, encoding: 'utf8' }).split('\n');
    const files = [...new Set([...changed, ...added])].filter((f) => /\.(ts|tsx|mts|mjs|js)$/.test(f) && existsSync(join(REPO, f)));
    must(files.length > 0, `no source file changed since ${base.slice(0, 7)}: nothing was checked`);
    const missing: string[] = [];
    for (const f of files) for (const spec of undeclaredImports(readFileSync(join(REPO, f), 'utf8'), declared)) missing.push(`${f}: ${spec}`);
    must(missing.length === 0, `imports not in package.json: ${[...new Set(missing)].join(', ')}`);
    return `${files.length} files changed since the branch left main at ${base.slice(0, 7)}; every bare import is declared in package.json`;
  } },

  // §19.5 CLI
  { id: 'CLI-01', ref: '19.5', line: 'One synced write per frame, lines overwritten with ESC[K, no ESC[2J in update loops', run: async () => {
    const d = await demo(80, 'night');
    const h = count(d.raw, '\x1b[?2026h'); const l = count(d.raw, '\x1b[?2026l');
    must(h === l && h >= 10, `REPL synced writes ${h}/${l}`); must(count(d.raw, '\x1b[2J') === 0, 'REPL wrote ESC[2J'); must(count(d.raw, '\x1b[K') >= 1, 'REPL never wrote ESC[K');
    const m = await monitorRun();
    const mh = count(m.raw, '\x1b[?2026h'); const ml = count(m.raw, '\x1b[?2026l');
    must(mh === ml && mh >= 1, `monitor synced writes ${mh}/${ml}`); must(count(m.raw, '\x1b[2J') === 0, 'monitor wrote ESC[2J');
    return `REPL --demo: ${h} synced writes, 0 ESC[2J, ${count(d.raw, '\x1b[K')} ESC[K; monitor: ${mh} synced writes, 0 ESC[2J`;
  } },
  { id: 'CLI-02', ref: '19.5', line: 'Spinner about 80ms per frame', run: async () => {
    const d = await runToEnd('loader-80-night', TIMMY('repl --demo-loader'), { cols: 80, palette: 'night' });
    const frames = [...d.utf8.matchAll(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Working/g)].length;
    must(frames >= 100 && frames <= 150, `${frames} spinner frames over the 10s hold (expected 100-150, 67-100ms each)`);
    return `${frames} frames over the 10s hold (about ${Math.round(10_000 / frames)}ms each)`;
  } },
  { id: 'CLI-03', ref: '19.5', line: 'Parsed keys with explicit modifiers; no Cmd shortcuts', run: async () => {
    const src = readFileSync(join(REPO, 'src/repl/input.ts'), 'utf8');
    must(/key\.ctrl/.test(src) && /emitKeypressEvents|keypress/.test(src), 'input is not read through parsed keypress events with modifiers');
    const p = await fixture('keys-hint', 'text');
    try {
      const s = p.screen();
      must(!/\bCmd\b|⌘|Super\+/.test(s), 'a Cmd shortcut is shown');
      must(/Enter to send · Ctrl\+J newline · \/ commands/.test(s), 'the key hint is missing');
      return 'keypress events with key.ctrl/key.meta; the hint names Enter, Ctrl+J and /';
    } finally { p.save(); p.kill(); }
  } },
  { id: 'CLI-04', ref: '19.5', line: 'Keystrokes echo within 100ms', run: async () => {
    const p = await fixture('echo-latency', 'text');
    try {
      const times: number[] = [];
      for (const ch of 'abcdefghij') {
        const t0 = performance.now();
        p.text(ch);
        const want = new RegExp(`› \\S*${ch}`);
        for (;;) { if (want.test(p.screen())) break; if (performance.now() - t0 > 1000) throw new Fail(`"${ch}" did not echo within 1s`); }
        times.push(performance.now() - t0);
        await sleep(60);
      }
      times.sort((a, b) => a - b);
      const p95 = times[Math.ceil(times.length * 0.95) - 1];
      must(p95 <= 100, `95th percentile echo ${p95.toFixed(0)}ms`);
      return `10 keys, median ${times[5].toFixed(0)}ms, slowest ${times[9].toFixed(0)}ms (tmux round trips included)`;
    } finally { p.save(); p.kill(); }
  } },
  { id: 'CLI-05', ref: '19.5', line: 'Ctrl+C at an idle prompt exits 130 with the terminal restored', run: async () => {
    const p = await fixture('ctrlc-idle', 'text');
    try {
      p.keys('C-c');
      const ex = await p.exited(5000);
      must(ex.code === 130 && ex.tty === 'same' && p.cursor() === '1', `exit ${ex.code}, tty ${ex.tty}, cursor ${p.cursor()}`);
      return 'exit 130, stty unchanged, cursor visible';
    } finally { p.save(); p.kill(); }
  } },
  { id: 'CLI-06', ref: '19.5', line: 'Ctrl+C mid-turn cancels the turn and returns to the prompt', run: async () => {
    const p = await fixture('ctrlc-turn', 'slowtool');
    try {
      p.text('render the storyboard'); p.keys('Enter');
      await p.waitFor(/npm run render:storyboard/);
      await sleep(1200);
      p.keys('C-c');
      await p.waitFor(/Cancelled\./, 5000);
      await p.waitFor(/Enter to send/, 5000);
      must(p.running(), 'the REPL quit instead of returning to the prompt');
      return '"Cancelled." then the prompt; the REPL kept running';
    } finally { p.save(); p.kill(); }
  } },
  { id: 'CLI-07', ref: '19.5', line: 'Ctrl+C twice within 2s mid-turn exits 130 with the terminal restored', run: async () => {
    const p = await fixture('ctrlc-twice', 'slowtool');
    try {
      p.text('render the storyboard'); p.keys('Enter');
      await p.waitFor(/npm run render:storyboard/);
      await sleep(800);
      p.keys('C-c'); await sleep(300); p.keys('C-c');
      const ex = await p.exited(5000);
      must(ex.code === 130 && ex.tty === 'same' && p.cursor() === '1', `exit ${ex.code}, tty ${ex.tty}, cursor ${p.cursor()}`);
      return 'exit 130, stty unchanged, cursor visible';
    } finally { p.save(); p.kill(); }
  } },
  { id: 'CLI-08', ref: '19.5', line: 'Esc backs out: of the slash menu, and of NEEDS YOU (deny)', run: async () => {
    const p = await fixture('esc-menu', 'text');
    try {
      p.text('/r');
      await p.waitFor(/Tab completes/);
      p.keys('Escape');
      // Node's readline holds a lone ESC for 500ms to tell it from the start of a key sequence.
      await sleep(900);
      const s = p.screen();
      must(!/Tab completes/.test(s), 'Esc left the slash menu open');
    } finally { p.save(); p.kill(); }
    const d = await approval('esc-approval', 'Escape');
    must(d === 'deny', `Esc at NEEDS YOU gave ${d}`);
    return 'Esc closed the slash menu (after readline\'s 500ms hold on a lone ESC); Esc at NEEDS YOU denied';
  } },
  { id: 'CLI-09', ref: '19.5', line: 'q types into the input; it never quits from a text field; the exit hint is shown', run: async () => {
    const p = await fixture('q-key', 'text');
    try {
      must(/\/exit to quit/.test(p.screen(true)), 'no exit hint in the banner');
      p.text('q');
      await sleep(400);
      must(p.running() && /› q/.test(p.screen()), 'q did not type into the input');
      return '"q" typed into the input; the banner says "/exit to quit"';
    } finally { p.save(); p.kill(); }
  } },
  { id: 'CLI-10', ref: '19.5', line: 'Re-measured on resize (REPL input and monitor frame)', run: async () => {
    const p = await fixture('resize-repl', 'text', { cols: 80 });
    try {
      p.text('abc');
      await p.waitFor(/› abc/);
      p.resize(60, 30);
      await sleep(700);
      const s = p.screen(false, true);
      must(widest(lines(s)) <= 60 && /› abc/.test(s), `after resize to 60 the widest line is ${widest(lines(s))}`);
    } finally { p.save(); p.kill(); }
    const sb = sandbox('resize-monitor', { monitorHome: true });
    const m = new Pty('resize-monitor', { cols: 100, rows: 30, env: sb.env, cwd: sb.work, script: TIMMY('watch') }).start();
    try {
      await m.waitFor(/chain/, 25_000);
      await sleep(1500);
      m.resize(70, 30);
      await sleep(1500);
      const s = m.screen(false, true);
      must(widest(lines(s)) <= 70, `monitor after resize to 70: widest line ${widest(lines(s))}`);
      return 'REPL input redrawn at 60 with its text; monitor frame within 70 after 100';
    } finally { m.save(); m.signal('SIGTERM'); await sleep(500); m.kill(); }
  } },
  { id: 'CLI-11', ref: '19.5', line: 'Display-width truncation: previews never wrap at 60 or 80 columns', run: async () => {
    for (const cols of [60, 80]) {
      const d = await demo(cols, 'night');
      const w = widest(lines(d.joined));
      must(w <= cols, `at ${cols} columns a line is ${w} wide (it wrapped)`);
    }
    return 'the demo turn at 60 and 80: no joined line wider than the terminal';
  } },
  { id: 'CLI-12', ref: '19.5', line: 'ASCII fallback (LC_ALL=C): no byte above 0x7F', run: async () => {
    const d = await demo(80, 'night', { LANG: 'C', LC_ALL: 'C' }, '-ascii');
    const n = nonAscii(Buffer.from(d.raw, 'latin1'));
    must(n === 0, `${n} bytes above 0x7F`);
    must(/\[OK\]|\+-|\|/.test(d.history), 'no ASCII glyphs in the transcript');
    return '0 bytes above 0x7F; ASCII glyphs in the transcript';
  } },
  { id: 'CLI-13', ref: '19.5', line: 'Write-once scrollback under a small live region; the alternate screen only for the full-screen monitor, left on exit', run: async () => {
    const d = await demo(80, 'night');
    must(count(d.raw, '\x1b[?1049h') === 0, 'the REPL entered the alternate screen');
    must(/Make a 20-second storyboard/.test(d.history) && /RECEIPT/.test(d.history), 'the turn is not in the scrollback');
    const m = await monitorRun();
    const on = m.raw.lastIndexOf('\x1b[?1049h'); const off = m.raw.lastIndexOf('\x1b[?1049l');
    must(on >= 0 && off > on, 'the monitor did not leave its alternate screen');
    must(/MARKER-BEFORE/.test(m.history), 'the shell text from before the monitor is gone');
    return 'REPL: no ESC[?1049h, the turn stays in scrollback; monitor: ESC[?1049h then ESC[?1049l, the earlier shell text intact';
  } },
  { id: 'CLI-14', ref: '19.5', line: 'Enter accepts the shown default (NEEDS YOU: deny)', run: async () => {
    const d = await approval('enter-approval', 'Enter');
    must(d === 'deny', `Enter gave ${d}`);
    return 'Enter at NEEDS YOU denied, the default it shows';
  } },
  { id: 'CLI-15', ref: '19.5', line: 'One specific message per validation failure', run: async () => {
    const cases: Array<[string[], RegExp]> = [
      [[CLI, 'repl', '--bogus'], /--bogus/],
      [[CLI, 'receipts', '--last', 'x'], /--last/],
      [[CLI, 'theme', 'install', '--terminal', 'nope'], /nope/],
    ];
    const out: string[] = [];
    for (const [args, re] of cases) {
      const r = spawn(args, {});
      const errLines = r.stderr.trim().split('\n').filter(Boolean);
      must(r.code === 2 && errLines.length === 1 && re.test(errLines[0]), `${args.slice(1).join(' ')}: exit ${r.code}, ${errLines.length} lines: ${errLines.join(' | ')}`);
      out.push(`${args.slice(1).join(' ')} → 2: ${errLines[0]}`);
    }
    return out.join('; ');
  } },
  { id: 'CLI-16', ref: '19.5', line: 'A slow step shows its start line within 100ms', run: async () => {
    const p = await fixture('start-line', 'text');
    try {
      p.text('hello');
      await p.waitFor(/› hello/);
      const t0 = performance.now();
      p.keys('Enter');
      for (;;) { if (/Working/.test(p.screen())) break; if (performance.now() - t0 > 2000) throw new Fail('no start line within 2s'); }
      const ms = performance.now() - t0;
      must(ms <= 100, `start line after ${ms.toFixed(0)}ms`);
      return `"Working" after ${ms.toFixed(0)}ms (tmux round trips included)`;
    } finally { p.save(); p.kill(); }
  } },
  { id: 'CLI-17', ref: '19.5', line: 'The spinner shows elapsed time from 1s', run: async () => {
    const sb = sandbox('loader-elapsed', {});
    const p = new Pty('loader-elapsed', { cols: 80, rows: 20, env: sb.env, cwd: sb.work, script: TIMMY('repl --demo-loader') }).start();
    try {
      await p.waitFor(/Working/, 20_000);
      await sleep(3500);
      const s = p.screen();
      must(/Working [1-9]\.\ds/.test(s), 'no elapsed time on the spinner at about 3.5s');
      return `at about 3.5s: "${s.match(/Working [0-9.]+s/)?.[0]}"`;
    } finally { p.save(); await p.exited(20_000).catch(() => undefined); p.kill(); }
  } },
  { id: 'CLI-18', ref: '19.5', line: 'Percent and ETA beyond 10s', deferred: 'No step in this branch reports a known total: Spinner.progress() has no caller, so the bar never shows. A thinking wait and a tool run show elapsed time only.' },
  { id: 'CLI-19', ref: '19.5', line: 'A stop line states the outcome', run: async () => {
    const d = await demo(80, 'night');
    must(/✓ RECEIPT \S+ .*(signed and verified|verified)/.test(d.history), 'the turn did not end on its receipt line');
    return 'the demo turn ends on "✓ RECEIPT …"';
  } },
  { id: 'CLI-20', ref: '19.5', line: 'Colors always paired with a glyph or text (NO_COLOR keeps every glyph)', run: async () => {
    const d = await demo(80, 'night', { NO_COLOR: '1' }, '-nocolor');
    for (const g of ['✓', '●', '└']) must(d.history.includes(g), `glyph ${g} missing without color`);
    return 'with NO_COLOR=1 the turn keeps ✓, ● and └ and its words';
  } },
  { id: 'CLI-21', ref: '19.5', line: 'Errors give what, why, the fix, and where to get help', run: async () => {
    const p = await fixture('turn-error', 'error');
    let inflow = '';
    try {
      p.text('render it'); p.keys('Enter');
      inflow = await p.waitFor(/Try:/, 8000);
    } finally { p.save(); p.kill(); }
    for (const re of [/Error:/, /Cause:/, /Try:/, /Help:/]) must(re.test(inflow), `the turn error has no ${re.source}`);
    const r = spawn([CLI, 'repl'], {}, 'hi\n');
    for (const re of [/Error|no model key/, /Cause:/, /Try:/, /Help:/]) must(re.test(r.stderr), `the no-key error has no ${re.source}`);
    return 'in the flow and at startup: Error, Cause, Try and Help';
  } },
  { id: 'CLI-22', ref: '19.5', line: 'NO_COLOR honored', run: async () => {
    const d = await demo(80, 'night', { NO_COLOR: '1' }, '-nocolor');
    const c = colorsIn(d.raw);
    must(c.basic + c.c256 + c.truecolor === 0, `color with NO_COLOR=1: ${JSON.stringify(c)}`);
    return 'no color parameter in the raw bytes with NO_COLOR=1';
  } },
  { id: 'CLI-23', ref: '19.5', line: 'FORCE_COLOR honored (0 off, 1-3 on through a pipe)', run: async () => {
    const res: string[] = [];
    for (const v of ['0', '1', '2', '3']) {
      const r = spawn([CLI, 'repl', '--demo'], { FORCE_COLOR: v });
      const c = colorsIn(r.stdout + r.stderr);
      const any = c.basic + c.c256 + c.truecolor;
      must(v === '0' ? any === 0 : any > 0, `FORCE_COLOR=${v} through a pipe: ${JSON.stringify(c)}`);
      res.push(`${v}: ${any}`);
    }
    return `color parameters through a pipe by FORCE_COLOR value: ${res.join(', ')}`;
  } },
  { id: 'CLI-24', ref: '19.5', line: 'TERM=dumb honored', run: async () => {
    const d = await runToEnd('demo-80-dumb', TIMMY('repl --demo'), { cols: 80, palette: 'night', pre: 'export TERM=dumb;' });
    const moves = (d.raw.match(/\x1b\[\d*[ABCDHJK]|\x1b\[\?2026/g) ?? []).length;
    const c = colorsIn(d.raw);
    must(moves === 0 && c.basic + c.c256 + c.truecolor === 0, `TERM=dumb: ${moves} cursor or erase sequences, colors ${JSON.stringify(c)}`);
    return 'no cursor movement, erase, sync or color with TERM=dumb';
  } },
  { id: 'CLI-25', ref: '19.5', line: 'Non-TTY output honored', run: async () => {
    const r = spawn([CLI, 'repl', '--demo'], {});
    must(!r.stdout.includes('\x1b'), 'escape bytes on a piped stdout');
    must(/The storyboard and the voiceover are ready/.test(r.stdout), 'the answer is not on the piped stdout');
    return 'piped stdout: the answer and no escape byte';
  } },
  { id: 'CLI-26', ref: '19.5', line: 'Never prompts in CI', run: async () => {
    const d = await runToEnd('ci-no-prompt', TIMMY('repl'), { cols: 80, palette: 'night', env: { CI: 'true' }, ms: 10_000 });
    must(!/Enter to send/.test(d.history), 'the input was drawn in CI');
    must(d.code === 78, `exit ${d.code} in CI without a key`);
    return 'CI=true in a PTY: no input drawn, exit 78 with the fix';
  } },
  { id: 'CLI-27', ref: '19.5', line: '-h/--help and --version', run: async () => {
    const out: string[] = [];
    for (const args of [['repl', '--help'], ['repl', '-h'], ['receipts', '--help'], ['theme', '--help']]) {
      const r = spawn([CLI, ...args], {});
      must(r.code === 0 && r.stdout.trim().length > 0, `timmy ${args.join(' ')}: exit ${r.code}`);
      out.push(`timmy ${args.join(' ')} → 0`);
    }
    const v = spawn([CLI, '--version'], {});
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version as string;
    must(v.code === 0 && v.stdout.includes(pkg), `--version: exit ${v.code}, "${v.stdout.trim()}"`);
    return `${out.join(', ')}; --version → ${pkg}`;
  } },
  { id: 'CLI-28', ref: '19.5', line: 'A stable --json envelope and --quiet bare values (on the verbs this branch added: receipts, theme)', run: async () => {
    const seed = sandbox('json-seed', {});
    const s = spawnSync(NODE, ['--import', LOADER, CLI, 'receipts', '--json'], { cwd: seed.work, env: seed.env, encoding: 'utf8' });
    let parsed: unknown = null;
    try { parsed = JSON.parse(s.stdout); } catch { /* not JSON */ }
    must(s.status === 0 && parsed !== null && typeof parsed === 'object', `timmy receipts --json: exit ${s.status}, not a JSON envelope`);
    const qq = spawnSync(NODE, ['--import', LOADER, CLI, 'receipts', '--quiet'], { cwd: seed.work, env: seed.env, encoding: 'utf8' });
    must(qq.status === 0 && !/\x1b|✓|✖/.test(qq.stdout), `timmy receipts --quiet: exit ${qq.status}`);
    const t = spawnSync(NODE, ['--import', LOADER, CLI, 'theme', '--json'], { cwd: seed.work, env: seed.env, encoding: 'utf8' });
    let tj: unknown = null;
    try { tj = JSON.parse(t.stdout); } catch { /* not JSON */ }
    must(t.status === 0 && tj !== null, `timmy theme --json: exit ${t.status}, not JSON`);
    return 'receipts --json and --quiet, theme --json';
  } },
  { id: 'CLI-29', ref: '19.5; the 20:14 order', line: '-v never overloaded: through the bin, `-v`, `--version`, `version` and `repl -v` each print the version line and nothing else (exit 0), and no help row gives -v another meaning', run: async () => {
    const version = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version as string;
    const BIN = join(REPO, 'timmy.ts');
    for (const args of [['-v'], ['--version'], ['version'], ['repl', '-v']]) {
      const r = spawn([BIN, ...args], {});
      must(r.code === 0 && r.stderr === '', `timmy ${args.join(' ')}: exit ${r.code}, stderr ${JSON.stringify(r.stderr.slice(0, 120))}`);
      const bad = versionProblems(r.stdout, version);
      must(bad.length === 0, `timmy ${args.join(' ')}: ${bad.join('; ')}`);
    }
    for (const args of [[BIN, '--help'], [CLI, 'repl', '--help']]) {
      const r = spawn(args, {});
      const bad = helpVProblems(r.stdout + r.stderr);
      must(bad.length === 0, `${args.slice(1).join(' ')}: ${bad.join('; ')}`);
    }
    return `timmy -v, --version, version and repl -v: "timmy-tui v${version}" and nothing else, exit 0; no -v row with another meaning in timmy --help or timmy repl --help`;
  } },
  { id: 'CLI-30', ref: '19.5', line: 'No prompt without TTYs on stdin and stdout: fail fast, naming the fix', run: async () => {
    const t0 = Date.now();
    const r = spawn([CLI, 'repl'], {}, 'hi\n');
    const ms = Date.now() - t0;
    must(r.code === 78 && /timmy init/.test(r.stderr) && ms < 8000, `piped, no key: exit ${r.code} after ${ms}ms`);
    must(!/\x1b\]11;\?|\x1b\[\?2004h/.test(r.stdout + r.stderr), 'a terminal query or bracketed paste was sent to a pipe');
    return `piped with no key: exit 78 after ${ms}ms naming "timmy init"; no terminal query`;
  } },
  { id: 'CLI-31', ref: '19.5', line: 'Data on stdout; errors, spinners and diagnostics on stderr', run: async () => {
    const sb = sandbox('stdout-split', {});
    const p = new Pty('stdout-split', { cols: 80, rows: 30, env: sb.env, cwd: sb.work, script: `${TIMMY('repl --demo')} > ${q(join(sb.dir, 'out.txt'))}` }).start();
    try { await p.exited(30_000); } finally { p.save(); p.kill(); }
    const out = readFileSync(join(sb.dir, 'out.txt'), 'utf8');
    must(/The storyboard and the voiceover are ready/.test(out), 'the answer is not on stdout');
    must(!/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(out), 'spinner frames on stdout');
    const r = spawn([CLI, 'repl'], {}, 'hi\n');
    must(r.stdout.trim() === '' && /no model key/.test(r.stderr), 'the no-key error is not on stderr alone');
    return 'the answer on stdout with no spinner frame; the error on stderr only';
  } },
  { id: 'CLI-32', ref: '19.5', line: 'Exit codes 0, 1, 2, 64-78, 130, 143; never 126 or 127', run: async () => {
    const r = spawn([CLI, 'nosuchverb'], {});
    must(r.code === 2, `an unknown verb exits ${r.code}`);
    const bad = EXITS.filter((e) => !ALLOWED_EXITS.has(e.code));
    must(bad.length === 0, `exit codes outside the set: ${JSON.stringify(bad)}`);
    return `an unknown verb exits 2; ${EXITS.length} PTY exits so far, all in the set: ${[...new Set(EXITS.map((e) => e.code))].sort((a, b) => a - b).join(', ')}`;
  } },
  { id: 'CLI-33', ref: '19.5', line: 'SIGTERM: bounded shutdown, exit 143, cursor, raw mode and screen restored (REPL mid-turn and monitor)', run: async () => {
    const p = await fixture('sigterm-repl', 'slowtool');
    let ms = 0;
    try {
      p.text('render the storyboard'); p.keys('Enter');
      await p.waitFor(/npm run render:storyboard/);
      await sleep(800);
      const t0 = Date.now();
      p.signal('SIGTERM');
      const ex = await p.exited(5000);
      ms = Date.now() - t0;
      const raw = p.bytes();
      must(ex.code === 143 && ex.tty === 'same' && p.cursor() === '1' && ms < 2000, `REPL: exit ${ex.code} after ${ms}ms, tty ${ex.tty}, cursor ${p.cursor()}`);
      must(raw.lastIndexOf('\x1b[?2004l') > raw.lastIndexOf('\x1b[?2004h'), 'REPL left bracketed paste on');
    } finally { p.save(); p.kill(); }
    const m = await monitorRun('SIGTERM');
    must(m.code === 143 && m.tty === 'same' && m.cursor === '1', `monitor: exit ${m.code}, tty ${m.tty}, cursor ${m.cursor}`);
    return `REPL mid-turn: 143 after ${ms}ms, stty unchanged, cursor on, bracketed paste off; monitor: 143, screen restored`;
  } },
  { id: 'CLI-34', ref: '19.5', line: 'SIGINT on the monitor: exit 130, screen restored', run: async () => {
    const m = await monitorRun('C-c');
    must(m.code === 130 && m.tty === 'same' && m.cursor === '1', `exit ${m.code}, tty ${m.tty}, cursor ${m.cursor}`);
    return 'monitor Ctrl+C: 130, stty unchanged, cursor on, alternate screen left';
  } },
  { id: 'CLI-35', ref: '19.5', line: 'Capability fallback to 16 colors (TERM=xterm, no COLORTERM)', run: async () => {
    const d = await demo(80, 'night', { COLORTERM: undefined }, '-16', '');
    // tmux 3.6 and later set COLORTERM in a pane when the terminal has RGB ("Set and check COLORTERM as a
    // hint for RGB colour"), so the pane unsets it: the condition is TERM=xterm with no COLORTERM.
    const d2 = await runToEnd('demo-80-xterm16', TIMMY('repl --demo'), { cols: 80, palette: 'night', env: { COLORTERM: undefined }, pre: 'export TERM=xterm; unset COLORTERM;' });
    const c = colorsIn(d2.raw);
    must(c.c256 === 0 && c.truecolor === 0 && c.basic > 0, `TERM=xterm: ${JSON.stringify(c)}`);
    void d;
    return `TERM=xterm: ${c.basic} basic color parameters, no 256 or truecolor`;
  } },
  { id: 'CLI-36', ref: '19.5', line: 'Prose clamped to 80 columns on a wide terminal', run: async () => {
    const p = await fixture('clamp-120', 'long', { cols: 120 });
    try {
      p.text('describe the storyboard'); p.keys('Enter');
      await p.waitFor(/once it renders\./, 10_000);
      await sleep(300);
      const body = lines(p.screen(true)).filter((l) => /storyboard has|frame names|voiceover it sits|once it renders/.test(l));
      must(body.length >= 3 && widest(body) <= 80, `the answer took ${body.length} lines, the widest ${widest(body)}`);
      return `the answer wrapped to ${body.length} lines, the widest ${widest(body)} columns, at 120`;
    } finally { p.save(); p.kill(); }
  } },
  { id: 'CLI-37', ref: '19.5', line: 'An explicit opt-in plain mode (--plain): no redraws', run: async () => {
    const d = await runToEnd('demo-80-plain', TIMMY('repl --demo --plain'), { cols: 80, palette: 'night' });
    const redraws = (d.raw.match(/\x1b\[\d*A|\x1b\[\?2026h|\r(?!\n)/g) ?? []).length;
    must(redraws === 0, `${redraws} redraws in --plain`);
    must(/The storyboard and the voiceover are ready/.test(d.history), 'the answer is missing in --plain');
    return '--plain: no cursor-up, no sync, no carriage-return redraw; the answer printed';
  } },
  { id: 'BIN-01', ref: '19.5; fourth order, step 6; the 20:14 order', line: 'Through the installed command\'s bin: bare `timmy` opens the REPL at an empty first-run prompt where /exit exits 0, and a SIGTERM to `timmy` mid-turn reaches the REPL it started (143, the terminal restored, the next output on a clean line, nothing left running)', run: async () => {
    const sb1 = sandbox('bin-bare', {});
    const bare = new Pty('bin-bare', { cols: 80, rows: 24, env: sb1.env, cwd: sb1.work, script: TIMMY_BIN('') }).start();
    try {
      await bare.waitFor(/First run: type \/setup/, 20_000);
      await bare.waitFor(/Enter to send/);
      must(!/Tab completes/.test(bare.screen()), 'the first-run prompt is not empty');
      bare.text('/exit'); bare.keys('Enter');
      const out = await bare.exited(8000);
      must(out.code === 0 && out.tty === 'same', `/exit at the first-run prompt: exit ${out.code}, tty ${out.tty}`);
      must(!/\/setup\/exit|Unknown command/.test(bare.screen()), 'the typed /exit did not reach the REPL as /exit');
    } finally { bare.save(); bare.kill(); }
    const sb2 = sandbox('bin-sigterm', {});
    const p = new Pty('bin-sigterm', { cols: 80, rows: 20, env: sb2.env, cwd: sb2.work, script: TIMMY_BIN('repl --demo-loader') }).start();
    try {
      await p.waitFor(/Working/, 20_000);
      await sleep(800);
      const kid = (pid: string | number): number => Number(execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).trim().split('\n')[0]);
      const bin = kid(p.tmux('display', '-p', '-t', 'q', '#{pane_pid}').trim());
      const repl = kid(bin);
      process.kill(bin, 'SIGTERM');
      const ex = await p.exited(8000);
      await sleep(200);
      const left = ((): boolean => { try { process.kill(repl, 0); return true; } catch { return false; } })();
      if (left) process.kill(repl, 'SIGKILL');
      must(!left, 'the REPL kept running after timmy ended');
      must(ex.code === 143 && ex.tty === 'same', `timmy: exit ${ex.code}, tty ${ex.tty}`);
      must(p.cursor() === '1', 'the cursor was left hidden');
      const column = p.tmux('display', '-p', '-t', 'q', '#{cursor_x}').trim();
      must(atLineStart(column), `the shell's next output would start at column ${column}, after the live line`);
      return 'bare timmy: an empty first-run prompt, where /exit exits 0; SIGTERM to timmy mid-turn: 143, stty unchanged, cursor on and at column 0, no REPL left';
    } finally { p.save(); p.kill(); }
  } },

  // §19.6 Agent TUI
  { id: 'TUI-01', ref: '19.6', line: 'Per-call display: ▸ name and argument, then ✓ name and timing', deferred: 'Not built: Timmy offers the grouped display only (the plan\'s choice for the REPL); there is no --tool-display.' },
  { id: 'TUI-02', ref: '19.6', line: 'Grouped display: bold past verbs over └ branch lines', run: async () => {
    const d = await demo(80, 'night');
    must(/\x1b\[(?:[0-9;]*;)?1(?:;[0-9;]*)?m[^\x1b]*Read/.test(d.utf8), 'the past verb "Read" is not bold');
    must(/└/.test(d.history), 'no └ branch line');
    return 'bold "Read" over └ preview lines in the demo turn';
  } },
  { id: 'TUI-03', ref: '19.6', line: 'Minimal display: one gray summary line', deferred: 'Not built: no minimal display mode (grouped only).' },
  { id: 'TUI-04', ref: '19.6', line: 'A tool running 30s or more shows a live indicator', run: async () => {
    const p = await fixture('tool-30s', 'slowtool', { rows: 24 });
    try {
      p.text('render the storyboard'); p.keys('Enter');
      await p.waitFor(/npm run render:storyboard/);
      await sleep(29_500);
      const a = p.screen(); await sleep(400); const b = p.screen();
      must(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] .*\b(29|30|31)\.\ds/.test(b), 'no live indicator with elapsed time near 30s');
      must(a !== b, 'the indicator did not change in 400ms');
      await p.waitFor(/The render finished\./, 10_000);
      return `at about 30s: "${b.match(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] .*\d+\.\ds/)?.[0]?.trim()}", still moving; then the result`;
    } finally { p.save(); p.kill(); }
  } },
  { id: 'TUI-05', ref: '19.6', line: 'Block input: a three-row full-width tint, the › prompt, unchanged while typing', run: async () => {
    const p = await fixture('block-input', 'text', { cols: 80, rows: 20 });
    try {
      // Rows with any cell on a ground of its own (the tint), read by the same parser the gate uses.
      const tinted = (): number => new Set(parseAnsiFrame(p.ansi(), TIMMY_NIGHT).filter((c) => c.bg.toUpperCase() !== TIMMY_NIGHT.background.toUpperCase()).map((c) => c.row)).size;
      const before = tinted();
      p.text('hello there');
      await p.waitFor(/› hello there/);
      const after = tinted();
      must(before === 3 && after === 3, `tinted rows ${before} before typing, ${after} after`);
      must(/› /.test(p.screen()), 'no › prompt');
      return 'three tinted rows before and after typing, › prompt';
    } finally { p.save(); p.kill(); }
  } },
  { id: 'TUI-06', ref: '19.6', line: 'Without a tint the input falls back (bordered ─ rules, or a plain >)', run: async () => {
    const p = await fixture('nocolor-input', 'text', { env: { NO_COLOR: '1' } });
    try {
      const s = p.screen();
      const rows = lines(s).map((l) => l.trimEnd());
      const at = rows.findIndex((l, i) => /^─{10,}$/.test(l) && /^\s*[›>]( |$)/.test(rows[i + 1] ?? '') && /^─{10,}$/.test(rows[i + 2] ?? ''));
      must(at >= 0 || rows.some((l) => /^> ?$/.test(l)), 'neither bordered rules nor a plain > without color');
      return at >= 0 ? 'NO_COLOR: bordered, ─ rules above and below the › prompt' : 'NO_COLOR: plain > prompt';
    } finally { p.save(); p.kill(); }
  } },
  { id: 'TUI-07', ref: '19.6', line: 'Backspace leaves no artifacts; arrows, paste, CJK and emoji work', run: async () => {
    const p = await fixture('editing', 'text');
    try {
      p.text('ab'); p.keys('Left'); p.text('X'); p.keys('End'); p.text('世界👋');
      await p.waitFor(/👋/);
      p.keys('BSpace');
      await sleep(300);
      p.paste(' pasted');
      await sleep(500);
      const row = lines(p.screen()).filter((l) => /^\s*›( |$)/.test(l)).pop() ?? '';
      must(row.replace(/\s+$/, '').endsWith('› aXb世界 pasted'), `the input reads "${row.trim()}"`);
      return `the input reads "${row.trim()}": insert with Left, CJK, one backspace removed the emoji whole, bracketed paste`;
    } finally { p.save(); p.kill(); }
  } },
  { id: 'TUI-08', ref: '19.6', line: 'The submitted prompt stays in scrollback; the reply streams; the next prompt renders clean', run: async () => {
    const p = await fixture('scrollback', 'text');
    try {
      p.text('show me the plan'); p.keys('Enter');
      await p.waitFor(/one line at a time\./, 8000);
      await p.waitFor(/Enter to send/, 5000);
      const s = p.screen(true);
      const at = s.indexOf('show me the plan'); const ans = s.indexOf('one line at a time.');
      must(at >= 0 && ans > at, 'the prompt is not above the reply in the scrollback');
      const input = lines(p.screen()).filter((l) => /^\s*›( |$)/.test(l)).pop() ?? '';
      must(input.trim() === '›', `the next prompt is not empty: "${input.trim()}"`);
      return 'prompt above the reply in scrollback; the next input empty';
    } finally { p.save(); p.kill(); }
  } },
  { id: 'TUI-09', ref: '19.6', line: 'Input text and tint readable on light and dark themes (truecolor and 256)', run: async () => {
    const out: string[] = [];
    for (const palette of ['night', 'day'] as const) {
      for (const [tag, env, pre] of [['tc', {}, ''], ['256', { COLORTERM: undefined }, 'export TERM=xterm-256color; unset COLORTERM;']] as const) {
        const name = `tint-${palette}-${tag}`;
        const sb = sandbox(name, { palette, env: { TIMMY_Q_SCRIPT: 'text', ...env } });
        const p = new Pty(name, { cols: 80, rows: 12, env: sb.env, cwd: sb.work, script: NODE_TS(FIXTURE), pre }).start();
        try {
          await p.waitFor(/Enter to send/); await sleep(350);
          p.text('readable on every theme'); await p.waitFor(/readable on every theme/);
          const file = join(EVID, `${name}.ansi`); writeFileSync(file, p.ansi());
          const g = gate(file, palette);
          must(g.code === 0, `${name}: gate exit ${g.code}: ${g.out.slice(0, 300)}`);
          out.push(`${palette}/${tag}`);
        } finally { p.kill(); }
      }
    }
    return `contrast gate PASS: ${out.join(', ')}`;
  } },
  { id: 'TUI-10', ref: '19.6', line: 'Piped stdin works: plain input, no raw mode, no OSC 11 query', run: async () => {
    const sb = sandbox('piped-fixture', { env: { TIMMY_Q_SCRIPT: 'text' } });
    const r = spawnSync(NODE, ['--import', LOADER, FIXTURE], { cwd: sb.work, env: sb.env, input: 'hi\n', encoding: 'utf8', timeout: 20_000 });
    must(r.status === 0 && /one line at a time\./.test(r.stdout), `piped: exit ${r.status}`);
    must(!/\x1b\]11;\?|\x1b\]4;|\x1b\[\?2004h|\x1b\[c/.test(r.stdout + r.stderr), 'a terminal query or bracketed paste went to a pipe');
    return 'echo hi | REPL: the answer, exit 0, no OSC 11 or DA1 query, no bracketed paste';
  } },
  { id: 'TUI-11', ref: '19.6', line: 'Tool blocks stay in order with streamed text; a text, tool, text turn shows the whole second message', run: async () => {
    const p = await fixture('text-tool-text', 'ttt', { rows: 40 });
    try {
      p.text('update the script'); p.keys('Enter');
      await p.waitFor(/twenty seconds\./, 10_000);
      await p.waitFor(/Enter to send/, 5000);
      const s = p.screen(true, true);
      const a = s.indexOf("I'll read the brief"); const t = s.search(/Read|Edited/); const b = s.indexOf('Both files are written');
      must(a >= 0 && t > a && b > t, `order: text ${a}, tools ${t}, second text ${b}`);
      must(/Both files are written: script\.md now opens on a receipt sealing in real time, and the storyboard\s+keeps six frames at twenty seconds\./.test(s.replace(/\n\s*/g, ' ')), 'the second message is not whole');
      return 'text, then the tool group, then the whole second message';
    } finally { p.save(); p.kill(); }
  } },
  { id: 'TUI-12', ref: '19.6', line: 'No style bleed after a turn; one blank line between phases', run: async () => {
    const d = await demo(80, 'night');
    const tail = d.raw.slice(d.raw.lastIndexOf('RECEIPT'));
    must(/\x1b\[(0|39|22|0;39|39;22|22;39)?m/.test(tail), 'no SGR reset after the receipt line');
    const body = d.history.slice(d.history.indexOf('Make a 20-second'), d.history.indexOf('RECEIPT'));
    must(!/\n[ \t]*\n[ \t]*\n/.test(body), 'two blank lines in a row inside the turn');
    return 'SGR reset after the last line; never two blank lines in a row';
  } },
  { id: 'TUI-13', ref: '19.6', line: 'Ctrl+C mid-turn returns to the prompt; idle or second Ctrl+C exits 130 restored', run: async () => 'see CLI-05, CLI-06 and CLI-07 (same runs)' },
  { id: 'TUI-14', ref: '19.6', line: 'Turn errors print in the flow and return to the prompt', run: async () => {
    const p = await fixture('turn-error-2', 'error');
    try {
      p.text('render it'); p.keys('Enter');
      await p.waitFor(/Error:/, 8000);
      await p.waitFor(/Enter to send/, 5000);
      must(p.running(), 'the REPL quit on a turn error');
      return '"✖ Error:" with its cause and fix in the flow, then the prompt';
    } finally { p.save(); p.kill(); }
  } },
  { id: 'TUI-15', ref: '19.6', line: '429 and 5xx retry with backoff before surfacing', run: async () => {
    const r = spawnSync(join(REPO, 'node_modules/.bin/vitest'), ['run', 'tests/repl-agent-send.test.ts'], { cwd: REPO, encoding: 'utf8', timeout: 120_000 });
    writeFileSync(join(EVID, 'retry-suite.log'), (r.stdout ?? '') + (r.stderr ?? ''));
    must(r.status === 0, `tests/repl-agent-send.test.ts exit ${r.status}`);
    return 'tests/repl-agent-send.test.ts passes (unit level: retries 429, 5xx and connection errors with backoff; not a PTY run)';
  } },

  // Captures: 60, 80 and 120 columns in Timmy Night and Day, each through the contrast gate.
  ...(['night', 'day'] as const).flatMap((palette) => [60, 80, 120].map((cols): Check => ({
    id: `CAP-${palette}-${cols}`, ref: 'C-15', line: `Captures at ${cols} columns in Timmy ${palette === 'night' ? 'Night' : 'Day'}: REPL turn, first run, setup, slash menu, monitor, receipts --follow`,
    run: async () => captureSet(palette, cols),
  }))),

  { id: 'COPY-01', ref: '18 Copy', line: 'Zero U+2014 in the copy of the surfaces this branch built (REPL, setup, receipts, theme, receipt page)', run: async () => {
    const dir = join(OUT, 'captures');
    const caps = existsSync(dir) ? execFileSync('ls', [dir], { encoding: 'utf8' }).split('\n').filter((f) => /^(repl-turn|first-run|setup|menu|follow)-.*\.ansi$/.test(f)) : [];
    must(caps.length === 30, `expected 30 captures of the branch's surfaces, found ${caps.length}`);
    const hits = caps.filter((f) => readFileSync(join(dir, f), 'utf8').includes(EM_DASH));
    must(hits.length === 0, `U+2014 in ${hits.join(', ')}`);
    for (const args of [['repl', '--help'], ['receipts', '--help'], ['theme', '--help']]) {
      const r = spawn([CLI, ...args], {});
      must(!r.stdout.includes(EM_DASH), `U+2014 in timmy ${args.join(' ')}`);
    }
    const sources = ['src/repl', 'src/term'].flatMap((d) => execFileSync('ls', [join(REPO, d)], { encoding: 'utf8' }).split('\n').filter((f) => /\.ts$/.test(f)).map((f) => join(d, f))).concat(['src/studio/receipt-page.ts']);
    const inStrings = sources.filter((f) => readFileSync(join(REPO, f), 'utf8').split('\n').some((l) => l.includes(EM_DASH) && !/^\s*(\/\/|\*|\/\*)/.test(l)));
    must(inStrings.length === 0, `U+2014 outside comments in ${inStrings.join(', ')}`);
    return `none in the 30 captures, the three help texts, or the strings of ${sources.length} source files`;
  } },
  { id: 'COPY-02', ref: '18 Copy', line: 'Zero U+2014 in the monitor\'s copy', deferred: 'The monitor shows the Command Post\'s text from before this branch, with U+2014 in it (for example "timmy doctor — read-only posture"). C-11 restyled its colors and layout only; rewriting its copy is outside the plan.' },

  // Preservation, suites and replays.
  { id: 'SUITE-01', ref: 'dev', line: 'The related suites pass at the frozen tree', run: async () => {
    const files = ['tests/repl-', 'tests/term-', 'tests/ui-', 'tests/studio-', 'tests/evidence', 'tests/keyboard-contract', 'tests/bin-', 'tests/runtime-package'];
    const r = spawnSync(join(REPO, 'node_modules/.bin/vitest'), ['run', ...files], { cwd: REPO, encoding: 'utf8', timeout: 600_000 });
    const log = (r.stdout ?? '') + (r.stderr ?? '');
    writeFileSync(join(EVID, 'suite.log'), log);
    const plain = log.replace(/\x1b\[[0-9;]*m/g, '').split('\n');
    // A failure names its tests (no paths), so a run elsewhere says what failed without its log.
    const failed = [...new Set(plain.filter((l) => /^\s*FAIL\s+tests\//.test(l)).map((l) => l.trim().replace(/^FAIL\s+/, '')))].slice(0, 5);
    must(r.status === 0, `vitest exit ${r.status}: ${plain.filter((l) => /Test Files|Tests /.test(l)).map((l) => l.trim()).join(' / ')}${failed.length ? `; failed: ${failed.join(' | ')}` : ''}`);
    return plain.filter((l) => /Test Files|Tests /.test(l)).map((l) => l.trim()).join('; ');
  } },
  { id: 'SUITE-02', ref: 'dev', line: 'Types: tsc and tsgo report 0 errors; privacy gate 0 gated', run: async () => {
    const tsc = spawnSync(join(REPO, 'node_modules/.bin/tsc'), ['--noEmit', '-p', '.'], { cwd: REPO, encoding: 'utf8', timeout: 600_000 });
    writeFileSync(join(EVID, 'tsc.log'), (tsc.stdout ?? '') + (tsc.stderr ?? ''));
    must(tsc.status === 0, `tsc exit ${tsc.status}`);
    const tsgo = spawnSync(join(REPO, 'node_modules/.bin/tsgo'), ['--noEmit'], { cwd: REPO, encoding: 'utf8', timeout: 600_000 });
    writeFileSync(join(EVID, 'tsgo.log'), (tsgo.stdout ?? '') + (tsgo.stderr ?? ''));
    must(tsgo.status === 0, `tsgo exit ${tsgo.status}`);
    const pj = join(EVID, 'privacy.json');
    const pv = spawnSync(NODE, [join(REPO, 'lanes/privacy/scan.mjs'), 'scan', '--tree', '.', '--json', pj, '--quiet'], { cwd: REPO, encoding: 'utf8', timeout: 300_000 });
    const j = existsSync(pj) ? JSON.parse(readFileSync(pj, 'utf8')) : null;
    must(pv.status === 0 && j && j.gated === 0, `privacy gate exit ${pv.status}, gated ${j?.gated}`);
    return `tsc 0, tsgo 0; privacy gate: ${j.gated} gated, ${j.total} review-level matches in ${j.files} files`;
  } },
  { id: 'CANVAS-01', ref: 'fourth order, step 5', line: 'Timmy Canvas in a real browser at desktop, tablet and phone sizes: its checks run, none skipped, and pass', run: async () => {
    const r = spawnSync(join(REPO, 'node_modules/.bin/vitest'), ['run', 'tests/studio-canvas-browser.test.ts'], { cwd: REPO, encoding: 'utf8', timeout: 300_000 });
    const log = ((r.stdout ?? '') + (r.stderr ?? '')).replace(/\x1b\[[0-9;]*m/g, '');
    writeFileSync(join(EVID, 'canvas.log'), log);
    const tests = log.split('\n').find((l) => /^\s*Tests\s/.test(l))?.trim() ?? '';
    must(r.status === 0, `vitest exit ${r.status}: ${tests}`);
    must(/\d+ passed/.test(tests) && !/skipped|todo/.test(tests), `the browser checks did not all run (no Chromium or Chrome?): "${tests}"`);
    return `${tests.replace(/\s+/g, ' ')}, in a real Chromium`;
  } },
  { id: 'REPLAY-01', ref: 'AGENTS §10 (local part)', line: 'A fresh clone with the frozen changes applied runs the REPL demo and passes the gate', run: async () => replay() },
  { id: 'INSTALL-01', ref: 'the 20:14 order, parts 4, 5 and 7', line: 'The frozen tree packed as the release job packs it and validated, then installed by npm into an empty prefix and used as an installed user meets it: -v; init and the doctor name next steps that work installed; bare timmy opens an empty first-run prompt where /exit exits 0; SIGTERM mid-turn leaves 143, the terminal restored and the next output on a clean line; timmy studio serves the canvas and names TIMMY_HOME\'s canvas folder', run: async () => installedPackage() },
  { id: 'REPLAY-02', ref: 'AGENTS §10', line: 'This frozen run, repeated in an isolated sandbox (a Vercel Sandbox, or a GitHub-hosted runner under the cockpit exception in AGENTS.md §10) on a fresh clone at a commit the frozen tree differs from only in docs/ui-cockpit/: every check that can run there passed there, and its record names where it ran', run: async () => {
    const dir = join(EVIDENCE, 'replay-02');
    const where = `${dir.slice(REPO.length + 1)}/`;
    evidenceOrBlocker(dir, 'freeze.json');
    for (const f of ['results.json', 'controls.txt', 'replay.json']) must(existsSync(join(dir, f)), `no ${f} in ${where}`);
    const fz = JSON.parse(readFileSync(join(dir, 'freeze.json'), 'utf8')) as { head: string; manifest: string; node: string; tmux: string; runner: string };
    const run = JSON.parse(readFileSync(join(dir, 'results.json'), 'utf8')) as RunRecord;
    const env = JSON.parse(readFileSync(join(dir, 'replay.json'), 'utf8')) as ReplayEnv;
    const off = outsideEvidence(changedSince(fz.head));
    must(off.length === 0, `changed since ${fz.head.slice(0, 7)} outside docs/ui-cockpit/: ${off.slice(0, 8).join(', ')}`);
    must(fz.manifest === manifestHash(fz.head), `the sandbox's tree was not commit ${fz.head.slice(0, 7)} as committed`);
    const runner = createHash('sha256').update(readFileSync(join(REPO, 'scripts/ui/qualify.ts'))).digest('hex');
    must(fz.runner === runner, 'the sandbox ran another runner');
    const bad = remoteVerdict(run, CHECKS);
    must(bad.length === 0, `the sandbox run: ${bad.join('; ')}`);
    const here = join(OUT, 'controls.txt');
    must(existsSync(here), 'run with --controls: the sandbox negative controls are compared with this run\'s');
    must(readFileSync(join(dir, 'controls.txt'), 'utf8') === readFileSync(here, 'utf8'), 'the sandbox negative controls differ from this run\'s');
    const platform = platformVerdict(env, fz.head);
    must(platform.bad.length === 0, `replay.json: ${platform.bad.join('; ')}`);
    const n = (s: string) => run.results.filter((r) => r.status === s).length;
    const skipped = run.results.filter((r) => r.status === 'not run').map((r) => r.id);
    return `${platform.label}; Node ${fz.node}, ${fz.tmux}; a clean clone at ${fz.head.slice(0, 7)}: ${n('pass')} passed, 0 failed, ${n('deferred')} deferred, not run there: ${skipped.join(', ')}; the same ${readFileSync(here, 'utf8').trim().split('\n').length} controls; only docs/ui-cockpit/ changed since`;
  } },
  { id: 'LIVE-01', ref: 'B1; fourth order, step 6', line: 'On the operator\'s Mac, at a commit the frozen tree differs from only in docs/ui-cockpit/: a real model turn with a tool, its interruption, a usable prompt after it, and another turn (the record and its binding are checked here; the turns were watched there)', run: async () => {
    const f = join(EVIDENCE, 'live-01', 'live-01.json');
    evidenceOrBlocker(join(EVIDENCE, 'live-01'), 'live-01.json');
    const rec = JSON.parse(readFileSync(f, 'utf8')) as LiveRecord;
    const bad = liveVerdict(rec);
    must(bad.length === 0, `the LIVE-01 record: ${bad.join('; ')}`);
    for (const st of rec.steps) for (const sc of st.screens ?? []) must(existsSync(join(EVIDENCE, 'live-01', sc)), `the screen ${sc} is missing`);
    const off = outsideEvidence(changedSince(rec.commit));
    must(off.length === 0, `changed since ${rec.commit.slice(0, 7)} outside docs/ui-cockpit/: ${off.slice(0, 8).join(', ')}`);
    return `at ${rec.commit.slice(0, 7)} with ${rec.model}: ${rec.steps.map((x) => x.id).join(', ')}, each ok; tools: ${rec.steps.find((x) => x.id === 'tool-turn')?.tools?.join(', ')}; $${rec.spend.run_usd} this run, $${rec.spend.total_usd} of the $${rec.spend.cap_usd} cap; only docs/ui-cockpit/ changed since`;
  } },
  // Last: protected state compared after everything else ran, suites and replay included (AGENTS.md §2, step 8).
  { id: 'PRES-01', ref: 'AGENTS §6', line: 'The shared receipt store is byte for byte its preimage', run: async () => {
    const pre = join(OUT, 'freeze', 'runs.jsonl.pre');
    must(existsSync(pre), 'no preimage was taken at the freeze');
    const a = readFileSync(pre); const b = readFileSync(join(REPO, '.timmy/receipts/runs.jsonl'));
    must(a.equals(b), `runs.jsonl changed: ${a.length} bytes before, ${b.length} after`);
    return `.timmy/receipts/runs.jsonl: ${b.length} bytes, identical to the preimage`;
  } },
  { id: 'PRES-02', ref: 'AGENTS §5', line: 'The frozen tree is unchanged by the run', run: async () => {
    const before = readFileSync(join(OUT, 'freeze', 'manifest.sha256'), 'utf8');
    const after = treeManifest();
    must(before === after, 'the tree manifest differs from the freeze');
    return `${before.trim().split('\n').length} files, manifest identical to the freeze`;
  } },
];

// ── scenario helpers used above ──────────────────────────────────────────────────────────────────
function approval(name: string, key: string): Promise<string> {
  return once(`approval-${name}`, async () => {
    const sb = sandbox(name, {});
    const p = new Pty(name, { cols: 80, rows: 24, env: sb.env, cwd: sb.work, script: NODE_TS(APPROVAL) }).start();
    try {
      await p.waitFor(/NEEDS YOU/);
      await sleep(450);
      p.keys(key);
      const s = await p.waitFor(/DECISION=\w+/);
      await p.exited(5000);
      return s.match(/DECISION=(\w+)/)?.[1] ?? '';
    } finally { p.save(); p.kill(); }
  });
}

interface MonitorRun { code: number; tty: string; raw: string; history: string; cursor: string; }
function monitorRun(end: 'C-c' | 'SIGTERM' | 'q' = 'C-c'): Promise<MonitorRun> {
  return once(`monitor-${end}`, async () => {
    const name = `monitor-${end}`;
    const sb = sandbox(name, { monitorHome: true });
    const p = new Pty(name, { cols: 100, rows: 30, env: sb.env, cwd: sb.work, script: TIMMY('watch'), pre: 'printf "MARKER-BEFORE\\n";' }).start();
    try {
      await p.waitFor(/chain/, 25_000);
      await sleep(5000);
      p.save('-live');
      if (end === 'SIGTERM') p.signal('SIGTERM'); else p.keys(end);
      const ex = await p.exited(8000);
      await sleep(200);
      return { ...ex, raw: p.bytes(), history: p.screen(true), cursor: p.cursor() };
    } finally { p.save(); p.kill(); }
  });
}

function gate(file: string, palette: Palette): { code: number; out: string } {
  const r = spawnSync(NODE, ['--import', LOADER, GATE, file, '--palette', palette], { cwd: REPO, encoding: 'utf8', timeout: 60_000 });
  return { code: r.status ?? -1, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

async function captureSet(palette: Palette, cols: number): Promise<string> {
  const dir = join(OUT, 'captures');
  mkdirSync(dir, { recursive: true });
  const shots: Array<[string, () => Promise<string>]> = [
    ['repl-turn', async () => (await demo(cols, palette)).ansi],
    ['first-run', async () => {
      const name = `first-${palette}-${cols}`; const sb = sandbox(name, { palette });
      const p = new Pty(name, { cols, rows: 24, env: sb.env, cwd: sb.work, script: TIMMY('repl') }).start();
      try {
        await p.waitFor(/First run: type \/setup/); await p.waitFor(/Enter to send/); await sleep(300);
        const first = p.ansi();
        p.text('/setup'); await sleep(100); p.keys('Enter');
        await p.waitFor(/RECEIPT/, 15_000); await sleep(300);
        writeFileSync(join(dir, `setup-${palette}-${cols}.ansi`), p.ansi());
        return first;
      } finally { p.save(); p.kill(); }
    }],
    ['menu', async () => {
      const p = await fixture(`menu-${palette}-${cols}`, 'text', { cols, rows: 20, palette });
      try { p.text('/r'); await p.waitFor(/Tab completes/); await sleep(200); return p.ansi(); } finally { p.kill(); }
    }],
    ['monitor', async () => {
      const name = `mon-${palette}-${cols}`; const sb = sandbox(name, { palette, monitorHome: true });
      const p = new Pty(name, { cols, rows: 30, env: sb.env, cwd: sb.work, script: TIMMY('watch') }).start();
      try { await p.waitFor(/chain/, 25_000); await sleep(4000); return p.ansi(); } finally { p.signal('SIGTERM'); await sleep(400); p.kill(); }
    }],
    ['follow', async () => {
      const name = `follow-${palette}-${cols}`; const sb = sandbox(name, { palette, env: { TIMMY_Q_SCRIPT: 'text', TIMMY_Q_SEAL: '1' } });
      const seal = new Pty(`${name}-seal`, { cols, rows: 20, env: sb.env, cwd: sb.work, script: NODE_TS(FIXTURE) }).start();
      try {
        await seal.waitFor(/Enter to send/); await sleep(350);
        for (const t of ['first turn', 'second turn']) { seal.text(t); seal.keys('Enter'); await seal.waitFor(new RegExp(`RECEIPT[\\s\\S]*Enter to send`), 10_000); await sleep(400); }
      } finally { seal.kill(); }
      const p = new Pty(name, { cols, rows: 16, env: sb.env, cwd: sb.work, script: TIMMY('receipts --follow') }).start();
      try { await p.waitFor(/Chain verified/, 15_000); await sleep(600); return p.ansi(); } finally { p.keys('C-c'); await sleep(300); p.kill(); }
    }],
  ];
  const verdicts: string[] = [];
  for (const [what, take] of shots) {
    const ansi = await take();
    const file = join(dir, `${what}-${palette}-${cols}.ansi`);
    writeFileSync(file, ansi);
    const g = gate(file, palette);
    must(g.code === 0, `${what} at ${cols} in ${palette}: gate exit ${g.code}: ${g.out.slice(0, 400)}`);
    verdicts.push(what);
    if (what === 'first-run') {
      const setup = join(dir, `setup-${palette}-${cols}.ansi`);
      const gs = gate(setup, palette);
      must(gs.code === 0, `setup at ${cols} in ${palette}: gate exit ${gs.code}: ${gs.out.slice(0, 400)}`);
      verdicts.push('setup');
    }
  }
  return `gate PASS: ${verdicts.join(', ')}`;
}

/** The working tree as the freeze sees it: every tracked and untracked file (not ignored), hashed. */
function treeManifest(dir = REPO): string {
  const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: dir, encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0').filter(Boolean).sort();
  const out = spawnSync('sha256sum', ['--', ...files], { cwd: dir, encoding: 'utf8', maxBuffer: 1 << 28 });
  return out.stdout;
}

/** A shell step for a check that works in its own folder: logged there, and a failure is the check's. */
function stepper(dir: string, logName: string, env?: NodeJS.ProcessEnv) {
  const log = (s: string) => writeFileSync(join(dir, logName), `${s}\n`, { flag: 'a' });
  const sh = (cmd: string, cwd = dir, ms = 900_000) => {
    const r = spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8', timeout: ms, maxBuffer: 1 << 28, ...(env ? { env } : {}) });
    log(`$ ${cmd}\n${(r.stdout ?? '').slice(-4000)}${(r.stderr ?? '').slice(-4000)}exit ${r.status}`);
    const shown = cmd.split(OUT).join('<out>').split(REPO).join('<repo>').split(dirname(NODE)).join('<node>');
    must(r.status === 0, `${logName.replace(/\.log$/, '')} step failed (exit ${r.status}): ${shown}`);
    return r.stdout ?? '';
  };
  return { log, sh };
}
/** A clone of the frozen tree in `dir`/timmy-tui: HEAD, plus the uncommitted changes and untracked files of a development run. */
function cloneFrozen(dir: string, sh: (cmd: string, cwd?: string, ms?: number) => string, log: (s: string) => void): { clone: string; base: string; patched: boolean; untracked: number } {
  const clone = join(dir, 'timmy-tui');
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  sh(`git clone --quiet --no-local ${q(REPO)} ${q(clone)} && git -C ${q(clone)} checkout --quiet ${base}`);
  // A clean frozen tree is the commit itself: no patch to apply and no untracked file are not failures.
  const patch = join(dir, 'tracked.patch');
  sh(`git -C ${q(REPO)} diff --binary ${base} > ${q(patch)}`);
  const patched = statSync(patch).size > 0;
  if (patched) sh(`git -C ${q(clone)} apply ${q(patch)}`);
  const untracked = execFileSync('git', ['ls-files', '-o', '--exclude-standard', '-z'], { cwd: REPO, encoding: 'utf8' }).split('\0').filter(Boolean);
  if (untracked.length > 0) sh(`git -C ${q(REPO)} ls-files -o --exclude-standard -z | xargs -0 tar -C ${q(REPO)} -cf ${q(join(dir, 'untracked.tar'))} && tar -C ${q(clone)} -xf ${q(join(dir, 'untracked.tar'))}`);
  log(`applied: ${patched ? 'the uncommitted changes' : 'no uncommitted change'}, ${untracked.length} untracked file(s)`);
  must(treeManifest(clone) === treeManifest(), 'the clone with the changes applied is not the frozen tree');
  return { clone, base, patched, untracked: untracked.length };
}

async function replay(): Promise<string> {
  const dir = join(OUT, 'replay');
  mkdirSync(dir, { recursive: true });
  const { log, sh } = stepper(dir, 'replay.log');
  const { clone, base, patched, untracked } = cloneFrozen(dir, sh, log);
  const t0 = Date.now();
  sh('npm ci --ignore-scripts --no-audit --no-fund --prefer-offline --loglevel=error', clone, 1_200_000);
  const installS = Math.round((Date.now() - t0) / 1000);
  const tsxLoader = pathToFileURL(join(clone, 'node_modules/tsx/dist/loader.mjs')).href;
  sh(`${q(NODE)} --import ${q(tsxLoader)} src/cli.ts repl --help | head -1`, clone);
  const sb = sandbox('replay-demo', { palette: 'night' });
  const p = new Pty('replay-demo', { cols: 80, rows: 40, env: sb.env, cwd: sb.work, script: `${q(NODE)} --import ${q(tsxLoader)} ${q(join(clone, 'src/cli.ts'))} repl --demo` }).start();
  let ansi = '';
  try { const ex = await p.exited(60_000); must(ex.code === 0 && ex.tty === 'same', `clone demo: exit ${ex.code}, tty ${ex.tty}`); ansi = p.ansi(); } finally { p.save(); p.kill(); }
  const file = join(dir, 'replay-demo-80-night.ansi');
  writeFileSync(file, ansi);
  const g = gate(file, 'night');
  must(g.code === 0, `clone demo capture: gate exit ${g.code}`);
  sh(`${q(join(clone, 'node_modules/.bin/vitest'))} run tests/repl-turn.test.ts tests/repl-seal.test.ts tests/term-law-palette.test.ts tests/studio-receipts.test.ts`, clone, 600_000);
  const what = patched || untracked > 0 ? `clone of ${base.slice(0, 7)} plus the frozen changes` : `clean clone of ${base.slice(0, 7)} (the frozen tree is that commit)`;
  return `${what} = the frozen tree (manifest identical); npm ci in ${installS}s; repl --help; the demo turn in a PTY (exit 0, stty unchanged, gate PASS); 4 suites pass in the clone`;
}

/**
 * INSTALL-01 (the 20:14 order): the frozen tree packed as the release job packs it (.github/workflows/
 * release.yml: the build tools included, built, the canvas distribution check, one tarball, validated by
 * scripts/release/validate-tarball.mjs), installed by npm into an empty prefix, and used through the
 * installed `timmy` as a user meets it: this run's Node and the installed command on the PATH, nothing of
 * the repository's, and a home of its own for each step. The doctor's own findings are kept with the evidence.
 */
async function installedPackage(): Promise<string> {
  const dir = join(OUT, 'install');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const nodeDir = dirname(NODE);
  const npm = existsSync(join(nodeDir, 'npm')) ? join(nodeDir, 'npm') : 'npm';
  // Built with this Node, the build tools named explicitly, and no NODE_ENV (production would omit them) or NODE_PATH.
  const buildEnv: NodeJS.ProcessEnv = { ...process.env, PATH: `${nodeDir}:${process.env.PATH ?? ''}` };
  delete buildEnv.NODE_ENV;
  delete buildEnv.NODE_PATH;
  const { log, sh } = stepper(dir, 'install.log', buildEnv);
  const { clone, base, patched, untracked } = cloneFrozen(dir, sh, log);
  const npmVersion = sh(`${q(npm)} --version`).trim();
  sh(`${q(npm)} ci --include=dev --no-audit --no-fund --prefer-offline --loglevel=error`, clone, 1_200_000);
  sh(`${q(npm)} run build`, clone, 900_000);
  sh(`${q(NODE)} scripts/canvas/build.mjs --check`, clone);
  const packed = JSON.parse(sh(`${q(npm)} pack --ignore-scripts --pack-destination ${q(dir)} --json`, clone)) as Array<{ filename: string }>;
  const name = packed[0].filename;
  const version = JSON.parse(readFileSync(join(clone, 'package.json'), 'utf8')).version as string;
  sh(`${q(NODE)} scripts/release/validate-tarball.mjs ${q(join(dir, name))} --expect-version ${q(version)} --out ${q(join(dir, 'release-artifact.json'))} > /dev/null`, clone);
  const artifact = JSON.parse(readFileSync(join(dir, 'release-artifact.json'), 'utf8')) as { ok: boolean; sha256: string; entries: number };
  must(artifact.ok === true, 'the packed artifact failed its release check');
  const prefix = join(dir, 'prefix');
  sh(`${q(npm)} install --global --prefix ${q(prefix)} ${q(join(dir, name))} --no-audit --no-fund --loglevel=error`, dir, 1_200_000);
  const timmy = join(prefix, 'bin', 'timmy');
  must(existsSync(timmy), 'the installed package has no timmy command');
  const userPath = `${nodeDir}:${join(prefix, 'bin')}:/usr/local/bin:/usr/bin:/bin`;
  const user = (step: string) => sandbox(`install-${step}`, { env: { PATH: userPath } });
  const run = (sb: ReturnType<typeof sandbox>, args: string[]) => {
    const r = spawnSync(timmy, args, { cwd: sb.work, env: sb.env, encoding: 'utf8', timeout: 60_000 });
    return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  // -v: the version line and nothing else.
  const v = run(user('version'), ['-v']);
  const vBad = versionProblems(v.stdout, version);
  must(v.code === 0 && vBad.length === 0, `installed timmy -v: exit ${v.code}; ${vBad.join('; ')}`);
  // init, then the doctor it names: next steps that work installed. The doctor's findings are kept.
  const sbi = user('init');
  const init = run(sbi, ['init', '--yes', '--operator', 'Sample', '--project', 'demo']);
  writeFileSync(join(dir, 'init.txt'), init.stdout + init.stderr);
  must(init.code === 0, `installed timmy init --yes: exit ${init.code}`);
  const initBad = nextStepProblems(init.stdout, /Next: `timmy doctor`, then `timmy` to open the REPL\./);
  must(initBad.length === 0, `installed timmy init: ${initBad.join('; ')}`);
  const doc = run(sbi, ['doctor']);
  writeFileSync(join(dir, 'doctor.txt'), doc.stdout + doc.stderr);
  must(doc.code === 0, `installed timmy doctor: exit ${doc.code}`);
  const docBad = nextStepProblems(doc.stdout, /^Next step: `timmy` opens the REPL/m);
  must(docBad.length === 0, `installed timmy doctor: ${docBad.join('; ')}`);
  const pre = doc.stdout.split('\n').filter((l) => /^\s+[✓✗!] /.test(l));
  const tally = (glyph: string) => pre.filter((l) => l.trim().startsWith(glyph)).length;
  const verdict = /Preflight READY/.test(doc.stdout) ? 'READY' : /Preflight BLOCKED/.test(doc.stdout) ? 'BLOCKED' : 'unstated';
  // Bare timmy: the first-run prompt starts empty, and /exit typed there exits 0.
  const sbb = user('bare');
  const bare = new Pty('install-bare', { cols: 80, rows: 24, env: sbb.env, cwd: sbb.work, script: q(timmy) }).start();
  try {
    await bare.waitFor(/First run: type \/setup/, 30_000);
    await bare.waitFor(/Enter to send/);
    must(!/Tab completes/.test(bare.screen()), 'the installed first-run prompt is not empty');
    bare.text('/exit'); bare.keys('Enter');
    const out = await bare.exited(10_000);
    must(out.code === 0 && out.tty === 'same', `installed timmy, /exit at the first-run prompt: exit ${out.code}, tty ${out.tty}`);
    must(bare.cursor() === '1', 'the installed REPL left the cursor hidden');
  } finally { bare.save(); bare.kill(); }
  // SIGTERM to the installed timmy mid-turn: 143, the terminal restored, the next output on a clean line.
  const sbs = user('sigterm');
  const p = new Pty('install-sigterm', { cols: 80, rows: 20, env: sbs.env, cwd: sbs.work, script: `${q(timmy)} repl --demo-loader` }).start();
  try {
    await p.waitFor(/Working/, 30_000);
    await sleep(1200);
    const kid = (pid: string | number): number => Number(execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).trim().split('\n')[0]);
    const bin = kid(p.tmux('display', '-p', '-t', 'q', '#{pane_pid}').trim());
    const repl = kid(bin);
    process.kill(bin, 'SIGTERM');
    const ex = await p.exited(10_000);
    await sleep(200);
    const left = ((): boolean => { try { process.kill(repl, 0); return true; } catch { return false; } })();
    if (left) process.kill(repl, 'SIGKILL');
    must(!left, 'the installed REPL kept running after timmy ended');
    must(ex.code === 143 && ex.tty === 'same', `installed timmy, SIGTERM mid-turn: exit ${ex.code}, tty ${ex.tty}`);
    must(p.cursor() === '1', 'the installed REPL left the cursor hidden');
    const column = p.tmux('display', '-p', '-t', 'q', '#{cursor_x}').trim();
    must(atLineStart(column), `after the installed REPL, the shell's next output would start at column ${column}`);
  } finally { p.save(); p.kill(); }
  // timmy studio from the package: the page and its bundle served, and the canvas folder from TIMMY_HOME,
  // set outside HOME so the page shows it in full.
  const sbc = user('studio');
  const home = join(sbc.dir, 'elsewhere', 'timmy');
  const studio = spawnChild(timmy, ['studio', '--port', '0'], { cwd: sbc.work, env: { ...sbc.env, TIMMY_HOME: home }, stdio: ['ignore', 'pipe', 'ignore'] });
  const ended = new Promise<number>((resolve) => studio.on('exit', (code, signal) => resolve(code ?? (signal === 'SIGTERM' ? 143 : -1))));
  let said = '';
  studio.stdout?.on('data', (c) => { said += String(c); });
  let bundleBytes = 0;
  try {
    let url = '';
    for (const end = Date.now() + 30_000; !url; await sleep(50)) {
      url = /Timmy Canvas: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(said)?.[1] ?? '';
      if (!url && Date.now() > end) throw new Fail(`installed timmy studio did not say where it serves: ${JSON.stringify(said.slice(0, 160))}`);
    }
    const config = await (await fetch(`${url}studio-config.json`)).json() as { canvasDir?: unknown };
    const shown = typeof config.canvasDir === 'string' ? config.canvasDir.split(sbc.dir).join('<sandbox>') : JSON.stringify(config.canvasDir);
    must(config.canvasDir === join(home, 'canvas'), `the installed canvas names ${shown}, not <sandbox>/elsewhere/timmy/canvas`);
    const page = await fetch(url);
    const html = await page.text();
    must(page.status === 200 && html.includes('id="guide-dir"') && html.includes('src="dist/canvas.js"'), `the installed canvas page: HTTP ${page.status}`);
    const bundle = await fetch(`${url}dist/canvas.js`);
    bundleBytes = (await bundle.arrayBuffer()).byteLength;
    must(bundle.status === 200 && bundleBytes > 100_000, `the installed canvas bundle: HTTP ${bundle.status}, ${bundleBytes} bytes`);
  } finally { studio.kill('SIGTERM'); }
  const studioExit = await ended;
  must(studioExit === 143, `installed timmy studio, SIGTERM: exit ${studioExit}`);
  const from = patched || untracked > 0 ? `${base.slice(0, 7)} plus the frozen changes` : `a clean clone of ${base.slice(0, 7)}`;
  return `${name} from ${from}: ${artifact.entries} files, sha256 ${artifact.sha256}, release check passed; installed by npm ${npmVersion} into an empty prefix and run with Node ${process.version}: -v prints "timmy-tui v${version}"; init and the doctor name timmy, never npm start (the doctor's preflight: ${tally('✓')} ok, ${tally('✗')} missing, ${tally('!')} warnings, ${verdict}; its text kept); bare timmy opens an empty first-run prompt, where /exit exits 0; SIGTERM mid-turn: 143, stty unchanged, cursor on at column 0, no REPL left; timmy studio serves the page and its bundle (${bundleBytes} bytes) and names <TIMMY_HOME>/canvas`;
}

// ── negative controls for the primitives (DOCTRINE §12) ─────────────────────────────────────────
async function controls(): Promise<string[]> {
  const out: string[] = [];
  const expectFail = (name: string, f: () => void) => {
    try { f(); } catch (e) { if (e instanceof Fail) { out.push(`${name}: fails as it should`); return; } throw e; }
    throw new Error(`negative control ${name} passed; the primitive cannot see the defect`);
  };
  expectFail('color in NO_COLOR', () => { const c = colorsIn('\x1b[31mred\x1b[39m'); must(c.basic + c.c256 + c.truecolor === 0, 'color'); });
  expectFail('truecolor under TERM=xterm', () => { const c = colorsIn('\x1b[48;2;1;2;3mx\x1b[49m'); must(c.truecolor === 0, 'truecolor'); });
  expectFail('256 under TERM=xterm', () => { const c = colorsIn('\x1b[38;5;240mx'); must(c.c256 === 0, '256'); });
  expectFail('a wrapped line', () => { must(widest(['a'.repeat(61)]) <= 60, 'wide'); });
  expectFail('a CJK line that wraps', () => { must(widest(['世'.repeat(31)]) <= 60, 'wide'); });
  expectFail('ESC[2J in a frame', () => { must(count('\x1b[?2026h\x1b[2J\x1b[?2026l', '\x1b[2J') === 0, '2J'); });
  expectFail('a byte above 0x7F', () => { must(nonAscii(Buffer.from('✓')) === 0, 'utf8'); });
  expectFail('an exit code of 127', () => { must(ALLOWED_EXITS.has(127), '127'); });
  expectFail('an undeclared import', () => { must(undeclaredImports(['imp', 'ort x fr', 'om ', "'left", "-pad';"].join(''), new Set(['react'])).length === 0, 'undeclared'); });
  expectFail('an em dash in copy', () => { must(!'read-only \u2014 posture'.includes(EM_DASH), 'em dash'); });
  expectFail('unbalanced sync', () => { const s = '\x1b[?2026hx'; must(count(s, '\x1b[?2026h') === count(s, '\x1b[?2026l'), 'sync'); });
  // Evidence taken elsewhere (REPLAY-02, LIVE-01): each primitive on a record known to be wrong.
  expectFail('evidence older than a source change', () => { must(outsideEvidence(['docs/ui-cockpit/CHECKPOINTS.md', 'src/repl/main.ts']).length === 0, 'bound'); });
  expectFail('a remote run with a failed check', () => { must(remoteVerdict({ dev: false, stopped: 'CLI-01', results: [{ id: 'CLI-01', status: 'fail', detail: 'x' }] }, [{ id: 'CLI-01' }]).length === 0, 'remote'); });
  expectFail('a remote development run', () => { must(remoteVerdict({ dev: true, stopped: null, results: [{ id: 'CLI-01', status: 'pass', detail: 'x' }] }, [{ id: 'CLI-01' }]).length === 0, 'dev'); });
  expectFail('a remote run that skipped a check it can run', () => { must(remoteVerdict({ dev: false, stopped: null, results: [{ id: 'CLI-01', status: 'not run', detail: 'Skipped in this run (--skip): x' }] }, [{ id: 'CLI-01' }]).length === 0, 'skip'); });
  const live: LiveRecord = { commit: 'a'.repeat(40), model: 'm', steps: [{ id: 'tool-turn', ok: true, tools: ['t'], receipt: 'r' }, { id: 'interrupt', ok: true, outcome: 'cancelled' }, { id: 'prompt-after', ok: true }, { id: 'second-turn', ok: true, receipt: 'r' }], spend: { run_usd: 0.1, total_usd: 0.5, cap_usd: 2 } };
  expectFail('a LIVE-01 record without its interruption', () => { must(liveVerdict({ ...live, steps: live.steps.filter((x) => x.id !== 'interrupt') }).length === 0, 'live'); });
  expectFail('a LIVE-01 record over its cap', () => { must(liveVerdict({ ...live, spend: { run_usd: 0.1, total_usd: 2.5, cap_usd: 2 } }).length === 0, 'cap'); });
  // C-17 (the 20:14 order): where a replay ran, as its own record proves it. GitHub Actions is allowed by
  // AGENTS.md §10's cockpit exception only on a GitHub-hosted runner, for the frozen commit, named as such.
  const head = 'b'.repeat(40);
  const gh: ReplayEnv = { platform: 'github-actions', os: 'Ubuntu 24.04.3 LTS', sha: head, runner_environment: 'github-hosted', image_os: 'ubuntu24', image_version: '20251005.1', run_id: '18300000000', run_attempt: '1', repository: 'owner/repo' };
  const vercel: ReplayEnv = { platform: 'vercel-sandbox', os: 'Amazon Linux 2023', sha: head };
  expectFail('a GitHub run labeled as Vercel', () => { must(platformVerdict({ ...gh, platform: 'vercel-sandbox' }, head).bad.length === 0, 'label'); });
  expectFail('a GitHub run on a self-hosted runner', () => { must(platformVerdict({ ...gh, runner_environment: 'self-hosted' }, head).bad.length === 0, 'hosted'); });
  expectFail('a GitHub run without its run ID', () => { must(platformVerdict({ ...gh, run_id: undefined }, head).bad.length === 0, 'run'); });
  expectFail('a GitHub run of another commit', () => { must(platformVerdict({ ...gh, sha: 'c'.repeat(40) }, head).bad.length === 0, 'sha'); });
  expectFail('a Vercel run of another commit', () => { must(platformVerdict({ ...vercel, sha: 'c'.repeat(40) }, head).bad.length === 0, 'sha'); });
  expectFail('a replay on an unnamed platform', () => { must(platformVerdict({ platform: 'laptop', os: 'macOS' }, head).bad.length === 0, 'platform'); });
  // CLI-29 and INSTALL-01: -v is the version and nothing else; the next steps work from an installed package;
  // the shell's next output starts its own line.
  expectFail('a -v that prints more than the version', () => { must(versionProblems('timmy-tui v1.2.3\nverbose: on\n', '1.2.3').length === 0, 'v'); });
  expectFail('a -v that prints another version', () => { must(versionProblems('timmy-tui v1.2.2\n', '1.2.3').length === 0, 'v'); });
  expectFail('a help that gives -v another meaning', () => { must(helpVProblems('  -v, --verbose    More output\n').length === 0, 'help'); });
  expectFail('a next step that needs a checkout', () => { must(nextStepProblems('  Next: `timmy doctor`, then `npm start`.\n', /Next: `timmy doctor`, then `timmy`/).length === 0, 'next'); });
  expectFail("the shell's next output mid-line", () => { must(atLineStart('14'), 'column'); });
  expectFail('a blocker without a reason', () => { blockerOf({ at: '2026-10-07T22:30:40Z' }); });
  expectFail('a blocker without a time', () => { blockerOf({ reason: 'the sandbox could not be created from here' }); });
  // And their positive controls: a gate that refused everything would also pass the negative ones.
  const expectPass = (name: string, bad: string[]) => { if (bad.length > 0) throw new Error(`positive control ${name} failed: ${bad.join('; ')}`); out.push(`${name}: passes as it should`); };
  expectPass('a good LIVE-01 record', liveVerdict(live));
  expectPass('a recorded blocker', ((): string[] => { try { blockerOf({ reason: 'the sandbox could not be created from here', at: '2026-10-07T22:30:40Z' }); return []; } catch (e) { return [String(e)]; } })());
  expectPass('a GitHub-hosted run of the frozen commit', platformVerdict(gh, head).bad);
  expectPass('a Vercel Sandbox run', platformVerdict(vercel, head).bad);
  expectPass('the version line', versionProblems('timmy-tui v1.2.3\n', '1.2.3'));
  expectPass('a help where -v is the version', helpVProblems('  -v, --version    Print the version\n'));
  expectPass('a next step that works installed', nextStepProblems('  Next: `timmy doctor`, then `timmy` to open the REPL.\n', /Next: `timmy doctor`, then `timmy`/));
  expectPass('a good remote run', remoteVerdict({ dev: false, stopped: null, results: [{ id: 'CLI-01', status: 'pass', detail: 'x' }, { id: 'CLI-18', status: 'deferred', detail: 'x' }, { id: 'LIVE-01', status: 'not run', detail: 'Skipped in this run (--skip): x' }] }, [{ id: 'CLI-01' }, { id: 'CLI-18', deferred: 'x' }, { id: 'LIVE-01' }]));
  // The contrast gate on a capture known to fail: grey-2 text on the Night ground.
  const bad = join(EVID, 'control-low-contrast.ansi');
  writeFileSync(bad, '\x1b[38;2;64;64;64mthis text is too dim to read\x1b[39m\n');
  const g = gate(bad, 'night');
  if (g.code !== 1) throw new Error(`negative control: the contrast gate passed a low-contrast capture (exit ${g.code})`);
  out.push('contrast gate on dim text: exit 1 as it should');
  return out;
}

// ── freeze (AGENTS.md §5 and §6): preimages and the tree, taken before the run ──────────────────────
if (argv.includes('--freeze')) {
  const dir = join(OUT, 'freeze');
  mkdirSync(dir, { recursive: true });
  const store = join(REPO, '.timmy/receipts/runs.jsonl');
  cpSync(store, join(dir, 'runs.jsonl.pre'));
  writeFileSync(join(dir, 'manifest.sha256'), treeManifest());
  const sha = (f: string): string => createHash('sha256').update(readFileSync(join(REPO, f))).digest('hex');
  const tool = (cmd: string, args: string[]): string => execFileSync(cmd, args, { encoding: 'utf8' }).trim();
  const info = {
    frozenAt: new Date().toISOString(), head: tool('git', ['-C', REPO, 'rev-parse', 'HEAD']), branch: tool('git', ['-C', REPO, 'branch', '--show-current']),
    node: process.version, tmux: tool('tmux', ['-V']), files: treeManifest().trim().split('\n').length,
    manifest: createHash('sha256').update(treeManifest()).digest('hex'),
    store: { path: '.timmy/receipts/runs.jsonl', bytes: readFileSync(store).length, sha256: sha('.timmy/receipts/runs.jsonl') },
    runner: sha('scripts/ui/qualify.ts'), fixture: sha('tests/fixtures/repl-qualify-fixture.ts'), gate: sha('scripts/ui/gate.ts'), lockfile: sha('package-lock.json'),
    monitorHome: MONITOR_HOME ? execFileSync('bash', ['-c', 'find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum'], { cwd: MONITOR_HOME, encoding: 'utf8' }).trim().split(' ')[0] : null,
    checks: CHECKS.map((c) => ({ id: c.id, line: c.line, ...(c.deferred ? { deferred: c.deferred } : {}), ...(c.notRun ? { notRun: c.notRun } : {}) })),
    ...(SKIP.length > 0 ? { skip: SKIP, skipWhy: SKIP_WHY } : {}),
  };
  writeFileSync(join(dir, 'freeze.json'), JSON.stringify(info, null, 2));
  console.log(`frozen: ${info.files} files, manifest ${info.manifest.slice(0, 12)}, runner ${info.runner.slice(0, 12)}, store ${info.store.bytes} bytes`);
  process.exit(0);
}

// ── run ──────────────────────────────────────────────────────────────────────────────────────────
interface Result { id: string; ref: string; line: string; status: Status; detail: string; ms: number; }
const results: Result[] = [];
const started = new Date();
let stopped: string | null = null;
if (argv.includes('--controls')) {
  const c = await controls();
  writeFileSync(join(OUT, 'controls.txt'), `${c.join('\n')}\n`);
  const positive = c.filter((l) => l.endsWith('passes as it should')).length;
  console.log(`controls: ${c.length - positive} negative controls fail as they should, ${positive} positive controls pass`);
}
for (const c of CHECKS) {
  if (ONLY && !ONLY.includes(c.id)) continue;
  const t0 = Date.now();
  if (c.deferred) { results.push({ id: c.id, ref: c.ref, line: c.line, status: 'deferred', detail: c.deferred, ms: 0 }); continue; }
  if (c.notRun) { results.push({ id: c.id, ref: c.ref, line: c.line, status: 'not run', detail: c.notRun, ms: 0 }); continue; }
  if (SKIP.includes(c.id)) { results.push({ id: c.id, ref: c.ref, line: c.line, status: 'not run', detail: `Skipped in this run (--skip): ${SKIP_WHY}`, ms: 0 }); continue; }
  if (stopped) { results.push({ id: c.id, ref: c.ref, line: c.line, status: 'not run', detail: `Not run: the qualification stopped at ${stopped} (AGENTS.md §5).`, ms: 0 }); continue; }
  try {
    const detail = await (c.run as () => Promise<string>)();
    results.push({ id: c.id, ref: c.ref, line: c.line, status: 'pass', detail, ms: Date.now() - t0 });
    console.log(`PASS ${c.id} ${detail}`);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    if (e instanceof NotRun) {
      results.push({ id: c.id, ref: c.ref, line: c.line, status: 'not run', detail, ms: Date.now() - t0 });
      console.log(`NOT RUN ${c.id} ${detail}`);
    } else {
      results.push({ id: c.id, ref: c.ref, line: c.line, status: 'fail', detail, ms: Date.now() - t0 });
      console.log(`FAIL ${c.id} ${detail}`);
      if (!DEV) stopped = c.id;
    }
  }
  writeFileSync(join(OUT, 'results.json'), JSON.stringify({ started: started.toISOString(), dev: DEV, stopped, results }, null, 2));
}
const tally = (s: Status) => results.filter((r) => r.status === s).length;
writeFileSync(join(OUT, 'results.json'), JSON.stringify({ started: started.toISOString(), finished: new Date().toISOString(), dev: DEV, stopped, exits: EXITS, results }, null, 2));
console.log(`${DEV ? 'DEV RUN' : 'QUALIFICATION'}: ${tally('pass')} passed, ${tally('fail')} failed, ${tally('deferred')} deferred, ${tally('not run')} not run${stopped ? `; stopped at ${stopped}` : ''}`);
process.exit(tally('fail') ? 1 : 0);
