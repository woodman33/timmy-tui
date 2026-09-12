// ui-cockpit-k7m3 C1 — the HANDS board. Privacy contract first: the board
// lives ONLY in .timmy/private/cockpit/ (mode 700, gitignored); a board.json
// planted in the tracked tree fails the release check; a pane log carrying a
// personal string is refused by the privacy scan BEFORE any seal cites it.
// Negative controls: fresh install never renders HANDS; planted board leaks.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { mkdtempSync, mkdirSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { ShellV2 } from '../src/tui/components/ShellV2.js';
import * as ck from '../src/harness/cockpit.js';

let root = '';
const saved: Record<string, string | undefined> = {};
const ROUNDS_MD = `# ROUNDS — ui-next-2 cohort

| hand | tool | worktree | order | round | state | last_seal |
| --- | --- | --- | --- | --- | --- | --- |
| claude | claude | wt-claude | ui-next-2 | R2 | HOLD | sha256_00aa11bb22cc33dd |
| codex | codex-cli | wt-codex | ui-next-2 | R1 | running | sha256_22cc33dd44ee55ff |
| observer | external | — | obs | R0 | idle | — |

## prompt claude R2
Rebase order/ui-next-2 onto the new main and remove the wizard write logic.

## prompt codex R1
Run the privacy gate over the staged set and report every finding.
`;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cockpit-root-'));
  for (const k of ['TIMMY_REPO_ROOT', 'TIMMY_STORE']) saved[k] = process.env[k];
  process.env.TIMMY_REPO_ROOT = root;
  process.env.TIMMY_STORE = mkdtempSync(join(tmpdir(), 'cockpit-store-'));
  mkdirSync(join(root, 'lanes'), { recursive: true });
  writeFileSync(join(root, 'ROUNDS.md'), ROUNDS_MD);
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(view: ReturnType<typeof render>, pred: (f: string) => boolean, ms = 15000): Promise<string> {
  const t0 = Date.now();
  let f = '';
  for (;;) {
    f = view.lastFrame() ?? '';
    if (pred(f) || Date.now() - t0 > ms) return f;
    await sleep(50);
  }
}

describe('C1 BOARD — hands, rounds, privacy', { timeout: 60000 }, () => {
  it('imports ROUNDS.md into the private cockpit dir at mode 700', () => {
    const r = ck.importRounds(join(root, 'ROUNDS.md'));
    expect(r.ok).toBe(true);
    expect(r.hands).toBe(3);
    expect(r.prompts).toBe(2);
    expect(statSync(ck.cockpitDir()).mode & 0o777).toBe(0o700);
    const b = ck.loadBoard();
    expect(b?.hands[0]).toMatchObject({ name: 'claude', tool: 'claude', round: 'R2', state: 'HOLD' });
    expect(b?.prompts['claude']?.['R2']).toContain('remove the wizard write logic');
    expect(b?.prompts['codex']?.['R1']).toContain('privacy gate');
  });

  it('HANDS renders beside SWARM with rows × R0–R4; [Enter] shows the full prompt', async () => {
    const view = render(React.createElement(ShellV2, { width: 120 }));
    view.stdin.write('6');
    await until(view, f => f.includes('[h] hands'));
    view.stdin.write('h');
    const grid = await until(view, f => f.includes('HANDS') && f.includes('claude'));
    expect(grid).toContain('R0');
    expect(grid).toContain('codex');
    expect(grid).toContain('wt-claude · ui-next-2');
    view.stdin.write('\x1b[C'); // right → R1
    view.stdin.write('\x1b[C'); // right → R2 (claude's prompt cell)
    view.stdin.write('\r');
    const prompted = await until(view, f => f.includes('prompt claude R2'));
    // the viewer wraps at column width, so assert wrap-safe fragments
    expect(prompted).toContain('Rebase order/ui-next-2 onto the new main');
    expect(prompted).toContain('remove the wizard write');
    view.unmount();
  });

  it('NEGATIVE: a fresh install (no board.json) never shows HANDS', async () => {
    const fresh = mkdtempSync(join(tmpdir(), 'cockpit-fresh-'));
    process.env.TIMMY_REPO_ROOT = fresh;
    try {
      const view = render(React.createElement(ShellV2, { width: 120 }));
      view.stdin.write('6');
      await until(view, f => f.includes('[h] hands'));
      view.stdin.write('h');
      await sleep(400);
      const f = view.lastFrame() ?? '';
      expect(f).not.toContain('HANDS');
      expect(f).toContain('no cockpit board');
      view.unmount();
    } finally {
      process.env.TIMMY_REPO_ROOT = root;
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('NEGATIVE §12: a board.json planted in the tracked tree fails the release check', () => {
    mkdirSync(join(root, 'docs'), { recursive: true });
    writeFileSync(join(root, 'docs', 'board.json'), '{}');
    try {
      const leaks = ck.leakCheck(root);
      expect(leaks).toContain(join('docs', 'board.json'));
      // the only legal home is private + gitignored, never a leak
      expect(leaks.some(l => l.includes('.timmy'))).toBe(false);
    } finally {
      rmSync(join(root, 'docs', 'board.json'), { force: true });
    }
    expect(ck.leakCheck(root)).toEqual([]);
  });

  it('NEGATIVE §12: a pane log carrying a personal string refuses the seal before anything cites it', () => {
    const personal = `pane tail: copied the deck to ${join(homedir(), 'Desktop')} before the call`;
    const refused = ck.sealCockpit('hand.report claude R2', { hand: 'claude', round: 'R2' }, { logText: personal });
    expect(refused.ok).toBe(false);
    expect(refused.note).toContain('seal refused');
    const clean = ck.sealCockpit('hand.report claude R2', { hand: 'claude', round: 'R2' }, { logText: 'pane tail: HOLD sha256_00aa11bb22cc33dd' });
    expect(clean.ok).toBe(true);
    expect(clean.hash).toMatch(/^sha256_/);
  });
});
