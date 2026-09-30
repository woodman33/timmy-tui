// Actual ShellV2 + Ink input under a real PTY. Integration probes are stubbed;
// full CLI startup, providers, and native jobs require their separate controls.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
let root = '';
let compiled = '';
const repository = process.cwd();
let socket = '';
let binary = '';
let env: NodeJS.ProcessEnv;
let ownedChildren: { pid: number; signature: string }[] = [];
const cleanupRecords: unknown[] = [];
const progressRecords: unknown[] = [];

function processSignature(pid: number): string {
  const r = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'pid=,lstart=,command='], { encoding: 'utf8', env, timeout: 1000 });
  if (r.error || ![0, 1].includes(r.status ?? -1)) throw new Error('cannot inspect owned PTY process');
  return (r.stdout ?? '').trim();
}
const session = `keyboard-${process.pid}`;
const captures: { label: string; text: string }[] = [];
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function tmux(args: string[], allowFailure = false): string {
  const r = spawnSync(binary, ['-S', socket, '-f', '/dev/null', ...args], {
    encoding: 'utf8', env, timeout: 5000, killSignal: 'SIGKILL',
  });
  if (!allowFailure && (r.error || r.status !== 0)) throw new Error(`tmux ${args[0]}: ${r.error?.message ?? r.stderr}`);
  return r.stdout ?? '';
}
function capture(): string { return tmux(['capture-pane', '-p', '-t', `=${session}:0.0`]); }
async function observe(label: string, check: (text: string) => boolean): Promise<string> {
  const until = performance.now() + 8000;
  let text = '';
  do {
    text = capture();
    if (check(text)) { captures.push({ label, text }); return text; }
    if (existsSync(join(root, 'violations.jsonl'))) break;
    await pause(80);
  } while (performance.now() < until);
  captures.push({ label: `FAILED: ${label}`, text });
  throw new Error(`PTY did not reach ${label}:\n${text}`);
}
const key = (value: string) => tmux(['send-keys', '-t', `=${session}:0.0`, value]);
const type = (value: string) => tmux(['send-keys', '-l', '-t', `=${session}:0.0`, '--', value]);
const mode = (name: string, tab: string) => (text: string) => new RegExp(`\\b${name}\\s+${tab}\\b`).test(text);

describe.skipIf(process.env.TIMMY_PTY_TESTS !== '1')('isolated ShellV2 keyboard PTY contract', () => {
  beforeAll(async () => {
    // Compile the source graph once before measuring interactive readiness.
    // No tsx/esbuild loader or its child processes run inside the PTY.
    const builds = join(repository, '.timmy', 'private');
    mkdirSync(builds, { recursive: true, mode: 0o700 });
    compiled = mkdtempSync(join(builds, 'keyboard-compiled-'));
    const declarations = readdirSync(join(repository, 'src/types')).filter(p => p.endsWith('.d.ts')).map(p => join(repository, 'src/types', p));
    const began = performance.now();
    const build = spawnSync(process.execPath, [join(dirname(require.resolve('typescript/package.json')), 'bin/tsc'),
      '--ignoreConfig', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
      '--jsx', 'react-jsx', '--types', 'node,react', '--esModuleInterop', '--skipLibCheck', '--noEmitOnError',
      '--rootDir', repository, '--outDir', compiled,
      resolve('tests/helpers/keyboard-pty.ts'), ...declarations], {
      cwd: repository, encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL',
    });
    if (process.env.TIMMY_PTY_ARTIFACTS) {
      const out = resolve(process.env.TIMMY_PTY_ARTIFACTS);
      mkdirSync(out, { recursive: true, mode: 0o700 });
      writeFileSync(join(out, 'keyboard-build.json'), JSON.stringify({ status: build.status, error: build.error?.message, ms: performance.now() - began, stdout: build.stdout, stderr: build.stderr }, null, 2), { mode: 0o600 });
    }
    expect(build.error, 'fixture compilation must finish before PTY startup').toBeUndefined();
    expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
    writeFileSync(join(compiled, 'package.json'), JSON.stringify({ type: 'module' }));
    const { copyRuntimeAssets } = await import(pathToFileURL(join(repository, 'scripts/copy-runtime-assets.mjs')).href);
    copyRuntimeAssets(repository, compiled);
  }, 65000);
  afterAll(() => { if (compiled) rmSync(compiled, { recursive: true, force: true }); });

  beforeEach(async () => {
    ownedChildren = [];
    binary = (process.env.PATH ?? '').split(':').map(p => join(p, 'tmux')).find(p => {
      try { accessSync(p, constants.X_OK); return true; } catch { return false; }
    }) ?? '';
    expect(binary, 'opted-in PTY tests require tmux').not.toBe('');
    root = realpathSync(mkdtempSync('/tmp/timmy-kb-'));
    socket = join(root, 'tmux.sock');
    for (const dir of ['home', 'config', 'cache', 'tmp', 'receipts', 'private', 'projects', 'bin', '.timmy']) mkdirSync(join(root, dir), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, '.timmy/model-policy.json'), JSON.stringify({ default: 'fixture/keyboard', scopes: {} }));
    writeFileSync(join(root, 'private/config.json'), '{}');
    // Fresh allowlist: no credentials, endpoint overrides, NODE_OPTIONS, TMUX,
    // caller .env, shell startup files, or inherited Timmy stores/configuration.
    env = {
      HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'),
      TMPDIR: join(root, 'tmp'), PATH: join(root, 'bin'), SHELL: '/bin/sh',
      TERM: 'xterm-256color', LANG: 'C.UTF-8', NODE_ENV: 'test',
      TIMMY_STORE: join(root, 'receipts'), TIMMY_PRIVATE_DIR: join(root, 'private'),
      TIMMY_REPO_ROOT: root, TIMMY_PROJECTS_ROOT: join(root, 'projects'), TIMMY_POLICY_DIR: root,
      TIMMY_DEMO: '1', TIMMY_LOGS_OPEN: '0', TIMMY_PTY_FIXTURE: '1',
    };
    tmux(['new-session', '-d', '-s', session, '-x', '120', '-y', '40', '-c', root, '/bin/sleep', '90']);
    tmux(['set-window-option', '-t', `=${session}:0`, 'remain-on-exit', 'on']);
    tmux(['respawn-pane', '-k', '-t', `=${session}:0.0`, '-c', root, process.execPath, join(compiled, 'tests/helpers/keyboard-pty.js'), '--fixture-run', root]);
    const panePid = Number(tmux(['display-message', '-p', '-t', `=${session}:0.0`, '#{pane_pid}']).trim());
    expect(panePid).toBeGreaterThan(0);
    ownedChildren.push({ pid: panePid, signature: processSignature(panePid) });
    await observe('NORMAL HOME readiness', text => mode('NORMAL', 'HOME')(text) && text.includes('YOUR JOURNEY'));
    const child = JSON.parse(readFileSync(join(root, 'child.json'), 'utf8')) as { pid: number; run: string };
    expect(child.run).toBe(root);
    expect(child.pid).toBeGreaterThan(0);
    if (child.pid !== panePid) ownedChildren.push({ pid: child.pid, signature: processSignature(child.pid) });
    expect(ownedChildren.every(child => child.signature.includes(root))).toBe(true);
  }, 15000);

  afterEach(async context => {
    const failures: string[] = [];
    try {
      // Startup can fail before readiness; retain the helper identity then too.
      if (root && existsSync(join(root, 'child.json'))) {
        const child = JSON.parse(readFileSync(join(root, 'child.json'), 'utf8')) as { pid: number; run: string };
        if (child.run === root && Number.isInteger(child.pid) && child.pid > 0 && !ownedChildren.some(p => p.pid === child.pid)) {
          const signature = processSignature(child.pid);
          if (signature.includes(root)) ownedChildren.push({ pid: child.pid, signature });
        }
      }
      if (socket && binary) tmux(['kill-server'], true); // only this private socket
      const until = performance.now() + 3000;
      let alive = ownedChildren;
      do {
        alive = ownedChildren.filter(child => child.signature && processSignature(child.pid) === child.signature);
        if (!alive.length) break;
        await pause(80);
      } while (performance.now() < until);
      if (alive.length) failures.push('owned PTY child remained alive after private server shutdown');
      if (root && existsSync(join(root, 'violations.jsonl'))) failures.push('forbidden network, agent, or subprocess attempt');
      if (root && existsSync(join(root, 'receipts/runs.jsonl'))) failures.push('keyboard navigation wrote receipts');
      if (root && existsSync(join(root, 'progress.jsonl'))) progressRecords.push({ root, progress: readFileSync(join(root, 'progress.jsonl'), 'utf8') });
      cleanupRecords.push({ children: ownedChildren, exited: alive.length === 0, failures });
      if (process.env.TIMMY_PTY_ARTIFACTS) {
        const out = resolve(process.env.TIMMY_PTY_ARTIFACTS);
        mkdirSync(out, { recursive: true, mode: 0o700 });
        writeFileSync(join(out, 'keyboard-captures.json'), JSON.stringify(captures, null, 2), { mode: 0o600 });
        writeFileSync(join(out, 'keyboard-progress.json'), JSON.stringify(progressRecords, null, 2), { mode: 0o600 });
        writeFileSync(join(out, 'keyboard-cleanup.json'), JSON.stringify(cleanupRecords, null, 2), { mode: 0o600 });
        if (root && existsSync(join(root, 'violations.jsonl'))) writeFileSync(join(out, 'keyboard-violations.jsonl'), readFileSync(join(root, 'violations.jsonl')), { mode: 0o600 });
      }
      if (!alive.length && root) rmSync(root, { recursive: true, force: true });
    } catch (error) { failures.push(String(error)); }
    // Retain the original assertion failure; cleanup cannot replace its cause.
    if (failures.length && !context.task.result?.errors?.length) throw new Error(failures.join('; '));
    if (failures.length) console.error(`PTY cleanup: ${failures.join('; ')}`);
  });

  it('keeps navigation characters as text in INSERT and CHAT, and Esc exits both', async () => {
    key('3'); await observe('CHAIN', mode('NORMAL', 'CHAIN'));
    type('i'); await observe('INSERT CHAIN', mode('INSERT', 'CHAIN'));
    const literal = 'g1q? 123456';
    type(literal);
    const inserted = await observe('literal filter', text => mode('INSERT', 'CHAIN')(text) && text.includes(`/ ${literal}`));
    expect(inserted).not.toContain('KEYS ·');
    key('Escape'); await observe('NORMAL CHAIN', mode('NORMAL', 'CHAIN'));
    key('Escape');
    await observe('cleared filter', text => mode('NORMAL', 'CHAIN')(text) && !text.includes(literal));
    key('1'); await observe('HOME', mode('NORMAL', 'HOME'));
    type('c'); await observe('CHAT drawer', text => text.includes('SOVEREIGN CHAT'));
    type(literal);
    await observe('CHAT literal', text => text.includes(`> ${literal}`) && /CHAT\s+sovereign/.test(text));
    key('BSpace');
    await observe('CHAT backspace', text => text.includes(`> ${literal.slice(0, -1)}`) && !text.includes(`> ${literal}`));
    key('Escape'); await observe('CHAT exit', text => mode('NORMAL', 'HOME')(text) && !text.includes('SOVEREIGN CHAT'));
  }, 60000);

  it('navigates six tabs, scopes COMMAND digits, and opens/closes which-key', async () => {
    for (const [index, tab] of ['HOME', 'RUN', 'CHAIN', 'LIBRARY', 'CHAT', 'COMMAND'].entries()) {
      key(String(index + 1)); await observe(`tab ${tab}`, mode('NORMAL', tab));
    }
    key('3'); await observe('COMMAND digit is pane focus', mode('NORMAL', 'COMMAND'));
    key('Tab'); await observe('Tab exits COMMAND', mode('NORMAL', 'HOME'));
    type('?'); await observe('which-key', text => text.includes('KEYS · NORMAL · HOME'));
    key('Escape'); await observe('which-key closed', text => mode('NORMAL', 'HOME')(text) && !text.includes('KEYS ·'));
  }, 60000);
});
