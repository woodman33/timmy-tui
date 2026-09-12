// ORDER factory-f1d0 C2 PANES: the plan puts every local hand in its own pane, cd'd to its worktree, with the
// log piped before the CLI starts; placeholders and missing binaries refuse; a throwaway tmux session proves the pipe.
import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hasTmux = spawnSync('sh', ['-c', 'command -v tmux']).status === 0;

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
    expect(codexSteps).toEqual(['split-window', 'select-pane', 'pipe-pane', 'send-keys']); // log before launch
    expect(logPath('codex', '2026-09-12', '/private/cockpit')).toBe('/private/cockpit/codex/2026-09-12.log');
    const pipe = steps.find((s: { hand?: string; op: string; argv?: string[] }) => s.hand === 'codex' && s.argv?.[0] === 'pipe-pane') as { argv: string[] };
    expect(pipe.argv[pipe.argv.length - 1]).toContain('/private/cockpit/codex/2026-09-12.log');
    const keys = steps.find((s: { hand?: string; argv?: string[] }) => s.hand === 'codex' && s.argv?.[0] === 'send-keys') as { argv: string[] };
    expect(keys.argv[3]).toContain("TIMMY_HAND='codex'");
    expect(keys.argv[3]).toContain('codex --full-auto');
    expect(tmux[tmux.length - 1]).toEqual(['select-layout', '-t', 'timmy:hands', 'tiled']);
  });

  it('discover resolves ledger paths from the main worktree and keeps one row per hand', async () => {
    const { discover } = await import('../lanes/cockpit/cockpit.mjs');
    const proposal = discover({
      root: '/repo/main/.claude/worktrees/order-current',
      worktreesText: [
        'worktree /repo/main\nHEAD a\nbranch refs/heads/main',
        'worktree /repo/main/.claude/worktrees/order-old\nHEAD b\nbranch refs/heads/order/old',
        'worktree /repo/main/.claude/worktrees/order-new\nHEAD c\nbranch refs/heads/order/new',
        'worktree /repo/main/.claude/worktrees/order-codex\nHEAD d\nbranch refs/heads/order/codex',
        'worktree /repo/main/.claude/worktrees/order-lost\nHEAD e\nbranch refs/heads/order/lost',
      ].join('\n\n'),
      ledgerText: [
        'ORD | HANDS: claude-code in worktree .claude/worktrees/order-old, branch order/old',
        'ORD | HANDS: claude-code in worktree .claude/worktrees/order-new, branch order/new',
        'ORD | HANDS: codex in worktree .claude/worktrees/order-codex, branch order/codex',
      ].join('\n'),
    });
    const local = proposal.hands.filter((h: { kind?: string }) => h.kind !== 'external');
    expect(local.map((h: { name: string }) => h.name)).toEqual(['claude', 'codex', 'unassigned:lost']);
    expect(local.find((h: { name: string }) => h.name === 'claude')?.worktree).toBe('/repo/main/.claude/worktrees/order-new');
  });

  it('dry previews do not require or kill an existing session, and duplicate hand names are detectable', async () => {
    const { sessionStartDecision, duplicateHandNames } = await import('../lanes/cockpit/cockpit.mjs');
    expect(sessionStartDecision({ up: true, restart: true, dry: true })).toBe('preview');
    expect(sessionStartDecision({ up: true, restart: false, dry: true })).toBe('preview');
    expect(sessionStartDecision({ up: true, restart: true, dry: false })).toBe('restart');
    expect(sessionStartDecision({ up: true, restart: false, dry: false })).toBe('already-up');
    expect(duplicateHandNames([{ name: 'claude' }, { name: 'claude' }, { name: 'codex' }])).toEqual(['claude']);
  });

  it.skipIf(!hasTmux)('a throwaway session with a fake CLI: two panes, both logs receive the first bytes', async () => {
    const { plan, run } = await import('../lanes/cockpit/cockpit.mjs');
    const base = mkdtempSync(join(tmpdir(), 'cockpit-'));
    const session = `timmy-test-${process.pid}`;
    const hands = [
      { name: 'a', bin: 'sh', args: ['-c', "'echo hand-a-online; sleep 5'"], worktree: base, problems: [] },
      { name: 'b', bin: 'sh', args: ['-c', "'echo hand-b-online; sleep 5'"], worktree: base, problems: [] },
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
      const panes = spawnSync('tmux', ['list-panes', '-t', session, '-F', '#{pane_title}'], { encoding: 'utf8' }).stdout.trim().split('\n');
      expect(panes.sort()).toEqual(['a', 'b']);
    } finally { spawnSync('tmux', ['kill-session', '-t', session]); rmSync(base, { recursive: true, force: true }); }
  });
});
