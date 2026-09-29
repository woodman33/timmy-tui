// ORDER factory-f1d0 C2 PANES: the plan puts every local hand in its own pane, cd'd to its worktree, with the
// log piped before the CLI starts; placeholders and missing binaries refuse; a throwaway tmux session proves the pipe.
import { describe, it, expect, vi } from 'vitest';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Native tmux is explicitly opt-in; the default suite never probes or starts it.
const liveTmux = process.env.TIMMY_TEST_LIVE_TMUX === '1';

describe('factory-f1d0 · cockpit', () => {
  it('resolves local hands only, maps qwen-code to the installed binary, and names problems', async () => {
    const { resolveHands } = await import('../lanes/cockpit/cockpit.mjs');
    const reg = { hands: [
      { name: 'claude', kind: 'local', cli: 'claude', worktree: '/tmp/wt-a' },
      { name: 'qwen', kind: 'local', cli: 'qwen-code', worktree: '/tmp/wt-b' },
      { name: 'codex', kind: 'local', cli: 'codex', worktree: '<repo>/../x' },
      { name: 'bot', kind: 'external' },
    ] };
    const has = (b: string) => ['claude', 'qwen'].includes(b);
    const hands = resolveHands(reg, { has, exists: (p: string) => p.startsWith('/tmp/wt-') });
    expect(hands.map((h: { name: string }) => h.name)).toEqual(['claude', 'qwen', 'codex']);
    expect(hands[1].bin).toBe('qwen');
    expect(hands[0].problems).toEqual([]);
    expect(hands[2].problems.join(' ')).toMatch(/placeholder/);
    expect(hands[2].problems.join(' ')).toMatch(/cli not on PATH: codex/);
  });

  it('the plan: one pane per hand in its worktree, pipe-pane attached before send-keys, dated private log path', async () => {
    const { plan, logPath } = await import('../lanes/cockpit/cockpit.mjs');
    const hands = [{ name: 'claude', bin: 'claude', args: [], worktree: '/tmp/wt-a', problems: [] }, { name: 'codex', bin: 'codex', args: ['--full-auto'], worktree: '/tmp/wt-b', problems: [] }];
    const steps = plan(hands, { session: 'timmy', date: '2026-09-12', base: '/private/cockpit' });
    const tmux = steps.filter((s: { op: string }) => s.op === 'tmux').map((s: { argv: string[] }) => s.argv);
    expect(tmux[0].slice(0, 6)).toEqual(['new-session', '-d', '-s', 'timmy', '-n', 'hands']);
    expect(tmux[0]).toContain('/tmp/wt-a');
    const codexSteps = steps.filter((s: { hand?: string; op: string }) => s.hand === 'codex' && s.op === 'tmux').map((s: { argv: string[] }) => s.argv[0]);
    expect(codexSteps).toEqual(['split-window', 'select-pane', 'pipe-pane', 'send-keys', 'send-keys']); // log before launch
    expect(logPath('codex', '2026-09-12', '/private/cockpit')).toBe('/private/cockpit/codex/2026-09-12.log');
    const pipe = steps.find((s: { hand?: string; op: string; argv?: string[] }) => s.hand === 'codex' && s.argv?.[0] === 'pipe-pane') as { argv: string[] };
    expect(pipe.argv[pipe.argv.length - 1]).toContain('/private/cockpit/codex/2026-09-12.log');
    const keys = steps.find((s: { hand?: string; argv?: string[] }) => s.hand === 'codex' && s.argv?.[0] === 'send-keys') as { argv: string[] };
    expect(keys.argv.slice(0, 5)).toEqual(['send-keys', '-l', '-t', '{PANE}', '--']);
    expect(keys.argv[5]).toContain("TIMMY_HAND='codex'");
    expect(keys.argv[5]).toContain("'codex' '--full-auto'");
    expect(tmux[tmux.length - 1]).toEqual(['select-layout', '-t', '=timmy:=hands', 'tiled']);
  });

  it.skipIf(!liveTmux)('a throwaway session with a fake CLI: two panes, both logs receive the first bytes', async () => {
    const { plan, run } = await import('../lanes/cockpit/cockpit.mjs');
    const base = mkdtempSync(join(tmpdir(), 'cockpit-'));
    const session = `timmy-test-${process.pid}`;
    const hands = [
      { name: 'a', bin: 'sh', args: ['-c', "echo hand-a-online; sleep 5"], worktree: base, problems: [] },
      { name: 'b', bin: 'sh', args: ['-c', "echo hand-b-online; sleep 5"], worktree: base, problems: [] },
    ];
    try {
      const rec = run(plan(hands, { session, date: '2026-09-12', base }), { session });
      expect(Object.keys(rec.panes)).toEqual(['a', 'b']);
      const deadline = Date.now() + 8000; let a = '', b = '';
      while (Date.now() < deadline && !(a.includes('hand-a-online') && b.includes('hand-b-online'))) {
        await new Promise((r) => setTimeout(r, 200));
        a = existsSync(rec.panes.a.log) ? readFileSync(rec.panes.a.log, 'utf8') : ''; b = existsSync(rec.panes.b.log) ? readFileSync(rec.panes.b.log, 'utf8') : '';
      }
      expect(a).toContain('hand-a-online');
      expect(b).toContain('hand-b-online');
      const panes = spawnSync('tmux', ['list-panes', '-t', '=' + session, '-F', '#{pane_title}'], { encoding: 'utf8' }).stdout.trim().split('\n');
      expect(panes.sort()).toEqual(['a', 'b']);
    } finally { spawnSync('tmux', ['kill-session', '-t', '=' + session]); rmSync(base, { recursive: true, force: true }); }
  });
});


describe('cockpit registry execution boundary (offline)', () => {
  const hand = (worktree: string, extra = {}) => ({ name: 'worker', bin: 'example-cli', args: [], worktree, ...extra });
  it('keeps shell syntax in custom binary names and argv literal, including quotes and empty arguments', async () => {
    const { plan } = await import('../lanes/cockpit/cockpit.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-argv-'));
    try {
      const marker = join(dir, 'unwanted'), output = join(dir, 'argv.json');
      const binary = join(dir, "cli 'quoted' $(touch unwanted); #name");
      writeFileSync(binary, `#!${process.execPath}\n` + `require('node:fs').writeFileSync(process.argv[2], JSON.stringify({hand:process.env.TIMMY_HAND,args:process.argv.slice(3)}));\n`);
      chmodSync(binary, 0o700);
      const args = ['', 'a b', "single'quote", '"double"', `$(touch ${marker})`, `; touch ${marker};`, '`touch unwanted`', '#{pane_id}', '%Y', 'C-m'];
      const steps = plan([hand(dir, { bin: binary, args: [output, ...args] })], { base: dir });
      const keys = steps.find((s: { argv?: string[] }) => s.argv?.[0] === 'send-keys')!;
      const result = spawnSync('/bin/sh', ['-c', keys.argv![5]], { cwd: dir, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({ hand: 'worker', args });
      expect(existsSync(marker)).toBe(false);
      expect(steps.filter((s: { argv?: string[] }) => s.argv?.[0] === 'send-keys').at(-1)?.argv).toEqual(['send-keys', '-t', '{PANE}', 'Enter']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('escapes shell quotes, tmux formats and time substitutions in log/worktree paths', async () => {
    const { plan } = await import('../lanes/cockpit/cockpit.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-log-'));
    try {
      const base = join(dir, "quote' $(touch unwanted) #(touch unwanted) #{pane_id} %Y");
      const steps = plan([hand(base)], { base, date: '2026-09-29' });
      const create = steps.find((s: { argv?: string[] }) => s.argv?.[0] === 'new-session')!;
      expect(create.argv![create.argv!.indexOf('-c') + 1]).toContain('##(touch unwanted) ##{pane_id}');
      const pipe = steps.find((s: { argv?: string[] }) => s.argv?.[0] === 'pipe-pane')!;
      const encoded = pipe.argv!.at(-1)!;
      expect(encoded).toContain('##(touch unwanted) ##{pane_id} %%Y');
      // tmux first runs strftime then format expansion. The only admitted
      // substitutions in our emitted command are escaped percent/hash pairs.
      const expanded = encoded.replaceAll('%%', '%').replaceAll('##', '#');
      mkdirSync(join(base, 'worker'), { recursive: true });
      const result = spawnSync('/bin/sh', ['-c', expanded], { cwd: dir, encoding: 'utf8', input: 'first bytes', env: { PATH: '/usr/bin:/bin' } });
      expect(result.status, result.stderr).toBe(0); expect(readFileSync(pipe.log!, 'utf8')).toBe('first bytes');
      expect(existsSync(join(dir, 'unwanted'))).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('looks up custom executable filenames without invoking a shell and ignores prototype alias keys', async () => {
    const { resolveCli } = await import('../lanes/cockpit/cockpit.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-path-'));
    try {
      const marker = join(dir, 'unwanted'), bin = join(dir, 'cli') + '; touch ' + marker;
      mkdirSync(join(bin, '..'), { recursive: true }); writeFileSync(bin, 'unused'); chmodSync(bin, 0o700);
      expect(resolveCli(bin)).toBe(bin); expect(resolveCli('constructor', () => false)).toBeNull(); expect(resolveCli('__proto__', () => false)).toBeNull();
      expect(existsSync(marker)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('refuses traversal, duplicate/prototype identities, malformed argv and control injection', async () => {
    const { plan, resolveHands, logPath } = await import('../lanes/cockpit/cockpit.mjs');
    for (const name of ['../outside', '__proto__', 'constructor', 'worker;touch x', 'worker\nnext', 'a:b']) expect(() => plan([hand('/tmp', { name })])).toThrow();
    for (const session of ['a:b', '=other', 'a*', 'a.b', '-L', 'a\nkill-session']) expect(() => plan([hand('/tmp')], { session })).toThrow();
    for (const args of ['--flag', [1], ['bad\x1b[2J'], ['bad\nnext']]) expect(() => plan([hand('/tmp', { args })])).toThrow();
    expect(() => plan([hand('/tmp'), hand('/tmp')])).toThrow('Duplicate'); expect(() => logPath('worker', '../outside', '/tmp')).toThrow();
    expect(resolveHands({ hands: [{ name: 'worker', cli: 'sh', worktree: '/tmp', args: '--flag' }] }, { has: () => true }).at(0)?.problems).toContain('args must be an array of strings without terminal controls');
  });
  it('dry restart makes no tmux calls or filesystem changes, even when a session would exist', async () => {
    const { up } = await import('../lanes/cockpit/cockpit.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-dry-'));
    try {
      const execute = vi.fn(() => ({ status: 0, stdout: '$7 %8', stderr: '' }));
      const result = up({ hands: [{ name: 'worker', cli: 'example-cli', worktree: dir, args: [] }] }, { session: 'timmy', dry: true, restart: true, has: () => true, execute, print: () => {}, base: join(dir, 'logs') });
      expect(execute).not.toHaveBeenCalled(); expect(existsSync(join(dir, 'logs'))).toBe(false); expect(Object.keys(result.panes)).toEqual(['worker']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('targets exact sessions and cleans up only the newly owned session on a launch failure', async () => {
    const { up } = await import('../lanes/cockpit/cockpit.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-owned-'));
    try {
      const execute = vi.fn((_bin: string, argv: string[]) => ({ status: argv[0] === 'pipe-pane' ? 1 : 0, stdout: argv[0] === 'new-session' ? '$7 %8\n' : '', stderr: '' }));
      expect(() => up({ hands: [{ name: 'worker', cli: 'example-cli', worktree: dir }] }, { session: 'timmy', restart: true, has: () => true, execute, base: dir })).toThrow('pipe-pane failed');
      expect(execute.mock.calls[0][1]).toEqual(['has-session', '-t', '=timmy']);
      expect(execute.mock.calls[1][1]).toEqual(['kill-session', '-t', '=timmy']);
      expect(execute.mock.calls.at(-1)?.[1]).toEqual(['kill-session', '-t', '$7']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('validates the complete registry before a restart can stop an existing session', async () => {
    const { up } = await import('../lanes/cockpit/cockpit.mjs');
    const execute = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }));
    expect(() => up({ hands: [{ name: '../bad', cli: 'example-cli', worktree: '/tmp' }] }, { restart: true, has: () => true, execute })).toThrow();
    expect(execute).not.toHaveBeenCalled();
  });
  it('does not kill an existing session when creation failed and pins later windows to the owned ID', async () => {
    const { plan, run } = await import('../lanes/cockpit/cockpit.mjs');
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-failure-'));
    try {
      const failed = vi.fn(() => ({ status: 1, stdout: '', stderr: 'session exists' }));
      expect(() => run(plan([hand(dir)], { base: dir }), { execute: failed })).toThrow();
      expect(failed.mock.calls).toHaveLength(1);
      const execute = vi.fn((_bin: string, argv: string[]) => ({ status: 0, stdout: argv[0] === 'new-session' ? '$7 %8\n' : argv[0] === 'split-window' ? '%9\n' : '', stderr: '' }));
      run(plan([hand(dir), hand(dir, { name: 'other' })], { base: dir }), { execute });
      expect(execute.mock.calls.find(c => c[1][0] === 'split-window')?.[1]).toContain('$7:=hands');
      expect(execute.mock.calls.at(-1)?.[1]).toEqual(['select-layout', '-t', '$7:=hands', 'tiled']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});


describe('installed cockpit workspace ownership (offline)', () => {
  it('keeps package templates in the installation and resolves reads/discovery/writes in caller or explicit roots', () => {
    const temp = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-installed-')));
    const installed = join(temp, 'installation', 'dist', 'lanes', 'cockpit');
    const workspace = join(temp, 'workspace'), overrideRoot = join(temp, 'override-root'), privateRoot = join(temp, 'private-override'), bin = join(temp, 'fake-bin');
    try {
      for (const path of [installed, join(workspace, 'checkout'), join(overrideRoot, 'checkout'), bin]) mkdirSync(path, { recursive: true });
      for (const file of ['cockpit.mjs', 'hands.example.json']) copyFileSync(join('lanes', 'cockpit', file), join(installed, file));
      const fakeCli = join(bin, 'fixture-cli'); writeFileSync(fakeCli, 'must never execute'); chmodSync(fakeCli, 0o700);
      const fakeGit = join(bin, 'git');
      writeFileSync(fakeGit, `#!${process.execPath}\n` + `if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['worktree','list','--porcelain']))process.exit(2);process.stdout.write('worktree '+process.cwd()+'/checkout\\nbranch refs/heads/order/example\\n\\n');\n`);
      chmodSync(fakeGit, 0o700);
      const invoke = (args: string[], overrides: Record<string, string> = {}) => {
        const result = spawnSync(process.execPath, [join(installed, 'cockpit.mjs'), ...args], { cwd: workspace, encoding: 'utf8', timeout: 5000, env: { PATH: bin, HOME: temp, ...overrides } });
        expect(result.status, result.stderr).toBe(0); return JSON.parse(result.stdout);
      };
      const template = invoke(['hands']);
      expect(template.source).toBe('template'); expect(template.file).toBe(join(installed, 'hands.example.json'));
      const discovered = invoke(['hands', '--discover', '--write']);
      const callerRegistry = join(workspace, '.timmy', 'private', 'cockpit', 'hands.json');
      expect(discovered.wrote).toBe(callerRegistry);
      expect(JSON.parse(readFileSync(callerRegistry, 'utf8')).hands[0].worktree).toBe(join(workspace, 'checkout'));
      const registry = { hands: [{ name: 'worker', cli: 'fixture-cli', args: [], worktree: 'checkout' }] };
      writeFileSync(callerRegistry, JSON.stringify(registry));
      const caller = invoke(['hands']);
      expect(caller.source).toBe('private'); expect(caller.file).toBe(callerRegistry);
      expect(caller.hands[0]).toMatchObject({ worktree: join(workspace, 'checkout'), bin: 'fixture-cli', problems: [] });
      const callerBefore = readFileSync(callerRegistry);
      const overrides = { TIMMY_REPO_ROOT: overrideRoot, TIMMY_PRIVATE_DIR: privateRoot };
      const overridden = invoke(['hands', '--discover', '--write'], overrides);
      const overrideRegistry = join(privateRoot, 'cockpit', 'hands.json');
      expect(overridden.wrote).toBe(overrideRegistry);
      expect(JSON.parse(readFileSync(overrideRegistry, 'utf8')).hands[0].worktree).toBe(join(overrideRoot, 'checkout'));
      writeFileSync(overrideRegistry, JSON.stringify(registry));
      const explicit = invoke(['hands'], overrides);
      expect(explicit.file).toBe(overrideRegistry); expect(explicit.hands[0]).toMatchObject({ worktree: join(overrideRoot, 'checkout'), problems: [] });
      expect(readFileSync(callerRegistry)).toEqual(callerBefore);
      expect(existsSync(join(temp, 'installation', '.timmy'))).toBe(false);
      expect(existsSync(join(temp, 'installation', 'dist', '.timmy'))).toBe(false);
      expect(existsSync(join(overrideRoot, '.timmy'))).toBe(false);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
});
