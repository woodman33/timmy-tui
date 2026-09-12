// ui-cockpit-k7m3 C5 POLISH — bounded rows everywhere.
//
// (1) the row-budget solver is pure: lists shrink largest-first and pay an
//     overflow line, the lowest-priority card folds away with a note, the
//     top card never folds.
// (2) the frame contract: at 80x24 and 120x40, with deliberately LONG fixture
//     data (subjects, hand names, worktrees, prompts, orders), every tab and
//     sub-tab renders ≤ rows lines, no line wider than the width, the header
//     on exactly one line, and every card row closed by its border. The
//     harness renders through ink with a stdout that reports the real width
//     (ink-testing-library fixes columns at 100, which clips 120 frames).
import { describe, it, expect } from 'vitest';
import React from 'react';
import { EventEmitter } from 'node:events';
import { render as inkRender } from 'ink';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShellV2 } from '../src/tui/components/ShellV2.js';
import { appendReceipt } from '../src/utils/receipts.js';
import { armEscrow } from '../src/utils/escrow-engine.js';
import * as ck from '../src/harness/cockpit.js';
import { fitStack, capRows, moreLine, wrapText } from '../src/tui/utils/rows.js';
import { visibleWidth } from '../src/tui/utils/text.js';

process.env.TIMMY_TELEMETRY_URL = 'off';

describe('fitStack — the row-budget solver', () => {
  it('leaves a stack alone when it fits', () => {
    const p = fitStack([{ id: 'a', fixed: 5, items: 3, min: 1, priority: 2 }, { id: 'b', fixed: 4, items: 2, min: 1, priority: 1 }], 40);
    expect(p.caps).toEqual({ a: 3, b: 2 });
    expect(p.folded).toEqual([]);
    expect(p.rows).toBe(5 + 3 + 1 + 4 + 2);
  });
  it('shrinks the largest list first and pays one overflow line per shrunk list', () => {
    const p = fitStack([{ id: 'a', fixed: 5, items: 20, min: 2, priority: 2 }, { id: 'b', fixed: 4, items: 3, min: 1, priority: 1 }], 20);
    expect(p.caps.b).toBe(3);                 // untouched
    expect(p.caps.a).toBeLessThan(20);
    expect(p.rows).toBeLessThanOrEqual(20);
    expect(p.rows).toBe(5 + p.caps.a + 1 + 1 + 4 + 3); // a's overflow line + gap
    expect(p.folded).toEqual([]);
  });
  it('folds the lowest-priority card when the minima do not fit, and never the top one', () => {
    const p = fitStack([
      { id: 'runs', fixed: 5, items: 6, min: 2, priority: 3 },
      { id: 'drops', fixed: 4, items: 1, min: 1, priority: 1 },
      { id: 'live', fixed: 5, items: 8, min: 1, priority: 2 },
      { id: 'escrow', fixed: 4, items: 3, min: 3, priority: 4 },
    ], 20, 0);
    // minima alone need 27 rows: DROPS (p1) folds, then LIVE (p2); the freed
    // rows let RUNS grow back to its full six — ESCROW (p4) never folds
    expect(p.folded).toEqual(['drops', 'live']);
    expect(p.caps.drops).toBe(0);
    expect(p.caps.live).toBe(0);
    expect(p.caps.runs).toBe(6);
    expect(p.caps.escrow).toBe(3);
    expect(p.rows).toBeLessThanOrEqual(20);
    const lone = fitStack([{ id: 'only', fixed: 5, items: 9, min: 4, priority: 1 }], 6);
    expect(lone.folded).toEqual([]);
    expect(lone.caps.only).toBe(4);           // reports over budget rather than folding the top card
    expect(lone.rows).toBeGreaterThan(6);
  });
  it('capRows / moreLine / wrapText', () => {
    expect(capRows([1, 2, 3, 4], 2)).toEqual({ shown: [1, 2], more: 2 });
    expect(moreLine(0, 'rows')).toBeUndefined();
    expect(moreLine(7, 'models', '↓ scrolls')).toBe('▾ 7 more models · ↓ scrolls');
    expect(wrapText('one two three', 7)).toEqual(['one two', 'three']);
    expect(wrapText('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
    expect(wrapText('a\n\nb', 10)).toEqual(['a', '', 'b']);
  });
});

// ── frame harness: ink with a stdout that reports the requested grid ────────
class Stdout extends EventEmitter {
  frames: string[] = [];
  last = '';
  constructor(public columns: number, public rows: number) { super(); }
  write = (f: string): boolean => { this.frames.push(f); this.last = f; return true; };
}
class Stdin extends EventEmitter {
  isTTY = true;
  // ink reads through readable + read(), exactly as ink-testing-library feeds it
  data: string | null = null;
  write = (d: string): void => { this.data = d; this.emit('readable'); this.emit('data', d); };
  setEncoding(): void { /* fake */ }
  setRawMode(): void { /* fake */ }
  resume(): void { /* fake */ }
  pause(): void { /* fake */ }
  ref(): void { /* fake */ }
  unref(): void { /* fake */ }
  read(): string | null { const d = this.data; this.data = null; return d; }
}
function renderAt(width: number, rows: number) {
  Object.defineProperty(process.stdout, 'rows', { value: rows, configurable: true });
  const stdout = new Stdout(width, rows);
  const stderr = new Stdout(width, rows);
  const stdin = new Stdin();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inst = inkRender(React.createElement(ShellV2, { width }), { stdout: stdout as any, stderr: stderr as any, stdin: stdin as any, debug: true, exitOnCtrlC: false, patchConsole: false });
  return { frame: () => stdout.last, key: (k: string) => stdin.write(k), unmount: () => inst.unmount() };
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

const LONG = 'a-very-long-subject-token-that-keeps-going-and-going-to-see-whether-any-row-wraps-inside-its-card-'.repeat(2);
const ROUNDS_MD = `# ROUNDS — audit cohort

| hand | tool | worktree | order | round | state | last_seal |
| --- | --- | --- | --- | --- | --- | --- |
| claude-with-a-very-long-hand-name | claude | .claude/worktrees/order-with-a-very-long-worktree-name-k7m3 | ui-cockpit-k7m3-and-a-long-order-title | R2 | HOLD | sha256_00aa11bb22cc33dd |
| codex | codex-cli | wt-codex | ui-next-2 | R1 | running | sha256_22cc33dd44ee55ff |
| observer | external | — | obs | R0 | needs-approval | — |
| qwen-hand | qwen | wt-qwen | swarm-b3k7 | R3 | STOP | sha256_33dd44ee55ff6600 |
| fifth | external | wt-5 | obs | R4 | idle | — |

## prompt claude-with-a-very-long-hand-name R2
${LONG} ${LONG}
${Array.from({ length: 30 }, (_, i) => `prompt line ${i + 2}`).join('\n')}

## prompt codex R1
Run the privacy gate over the staged set and report every finding.
`;

interface Audit { label: string; lines: number; wide: number; open: number; headerOneLine: boolean }
function audit(frame: string, width: number, label: string, overlay = false): Audit {
  const lines = strip(frame).split('\n');
  const wide = lines.filter(l => visibleWidth(l) > width).length;
  // a card row is closed by its own border, or by the top/bottom corner of a
  // neighbouring rail card sharing the line
  const open = overlay ? 0 : lines.filter(l => /^\s*│/.test(l) && !/[│╮╯]\s*$/.test(l)).length;
  return { label, lines: lines.length, wide, open, headerOneLine: /^─+$/.test((lines[1] ?? '').trim()) };
}

function seedLong(root: string): void {
  mkdirSync(join(root, 'lanes'), { recursive: true });
  writeFileSync(join(root, 'ROUNDS.md'), ROUNDS_MD);
  ck.importRounds(join(root, 'ROUNDS.md'));
  const ol = join(root, 'orders.log');
  writeFileSync(ol, Array.from({ length: 30 }, (_, i) =>
    `ORD-20260912-${String(i).padStart(3, '0')} | 2026-09-12T00:00:00Z | ${i % 2 ? 'claude' : 'codex'} | ORDER-ID audit-${i} (${LONG}) | ${i % 3 ? `evidence sha256_00aa11bb22cc33dd ${LONG}` : "awaiting owner's word"} | actor=claude-code hands=claude-fable-5-1`).join('\n') + '\n');
  process.env.TIMMY_ORDERS_LOG = ol;
  for (let i = 0; i < 30; i++) {
    appendReceipt('runs', { kind: i % 4 === 0 ? 'seal' : i % 4 === 1 ? 'chat' : 'run', subject: `${['doctor.pass', 'chat.turn', 'lane.start · defold', 'unreal.render'][i % 4]} · ${LONG}`, policy: i % 5 ? 'auto' : 'human-gated', status: i % 7 === 3 ? 'denied' : 'ok', cost_usd: 0.01, sources: [{ role: 'user', text: LONG }, { role: 'answer', text: LONG }] } as never);
  }
  armEscrow({ plan_hash: 'sha256_deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', ceiling_usd: 2, qa_threshold: 0.5 } as never);
}

describe('frame contract — every tab fits the grid with long data', { timeout: 300000 }, () => {
  for (const [width, rows] of [[80, 24], [120, 40]] as const) {
    it(`${width}x${rows}: ≤ rows lines, no wide line, one-line header, closed card rows`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'bounded-root-'));
      const saved = process.env.TIMMY_REPO_ROOT;
      process.env.TIMMY_REPO_ROOT = root;
      try {
        seedLong(root);
        const v = renderAt(width, rows);
        const t0 = Date.now();
        while (!(/1 HOME/.test(v.frame()) && !/assembling/.test(v.frame())) && Date.now() - t0 < 20000) await sleep(50);
        await sleep(1200);
        const shots: Audit[] = [];
        const shot = async (label: string, keys: string[] = [], overlay = false, settle = 500) => {
          for (const k of keys) { v.key(k); await sleep(150); }
          await sleep(settle);
          shots.push(audit(v.frame(), width, label, overlay));
          // AUDIT_OUT=<dir> keeps every frame as evidence (unset in CI)
          if (process.env.AUDIT_OUT) writeFileSync(join(process.env.AUDIT_OUT, `${label}-${width}x${rows}.txt`), strip(v.frame()));
        };
        await shot('home');
        await shot('home-status', ['S'], true); v.key('\x1b'); await sleep(200);
        await shot('home-keys', ['?'], true); v.key('\x1b'); await sleep(200);
        await shot('run', ['2']);
        await shot('chain', ['3']);
        await shot('chain-open', ['\r'], true); v.key('\x1b'); await sleep(200);
        await shot('library', ['4']);
        await shot('library-demos', ['D']); v.key('\x1b'); await sleep(200);
        await shot('chat', ['5']); v.key('\x1b'); await sleep(200);
        await shot('command', ['6']);
        await shot('command-swarm', ['w']);
        await shot('command-hands', ['h']);
        await shot('command-hands-prompt', ['\x1b[C', '\x1b[C', '\r'], false, 900);
        await shot('command-hands-prompt-row4', ['\x1b', '\x1b[B', '\x1b[B', '\x1b[B', '\r'], false, 900);
        v.unmount();
        const bad = shots.filter(s => s.lines > rows || s.wide > 0 || s.open > 0 || !s.headerOneLine);
        expect(bad, JSON.stringify(shots, null, 1)).toEqual([]);
      } finally {
        if (saved === undefined) delete process.env.TIMMY_REPO_ROOT; else process.env.TIMMY_REPO_ROOT = saved;
        delete process.env.TIMMY_ORDERS_LOG;
      }
    });
  }
});
