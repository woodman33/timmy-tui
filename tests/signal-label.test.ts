// FILM-PLAN-v2 (1): the RUN Signal panel's state label must DERIVE from the
// checkpoint state — a hold / not-started / round-0 game must never render
// 'live'. Negative control: the not-started fixture asserts the absence of a
// live label (this test failed against the hardcoded 'live' purpose).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShellV2 } from '../src/tui/components/ShellV2.js';
import { signalState } from '../src/harness/uinext.js';

let root = '';
let signalDir = '';
const saved: Record<string, string | undefined> = {};
const writeSignal = (status: string, checkpoint: number, attention: number) => {
  const w = (rel: string, body: string) => {
    const p = join(signalDir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, body);
  };
  w('out/latest-checkpoint.json', JSON.stringify({ checkpoint, complete: false, status, receipt: 'sha256_abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789' }));
  w('out/opening-state.json', JSON.stringify({ state: { attention } }));
};
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'signal-label-root-'));
  signalDir = mkdtempSync(join(tmpdir(), 'signal-label-game-'));
  mkdirSync(join(root, 'lanes'), { recursive: true });
  for (const k of ['TIMMY_REPO_ROOT', 'TIMMY_SIGNAL_DIR', 'TIMMY_STORE']) saved[k] = process.env[k];
  process.env.TIMMY_REPO_ROOT = root;
  process.env.TIMMY_SIGNAL_DIR = signalDir;
  process.env.TIMMY_STORE = mkdtempSync(join(tmpdir(), 'signal-label-store-'));
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

describe('SIGNAL state label derives from state', { timeout: 60000 }, () => {
  it('NEGATIVE CONTROL: hold_live_day_not_started / round 0 / reserved 0 never says live', async () => {
    writeSignal('hold_live_day_not_started', 0, 0);
    const st = signalState();
    expect(st?.live).toBe(false); // a not-started day is not a live game
    const view = render(React.createElement(ShellV2, { width: 120 }));
    view.stdin.write('2');
    const run = await until(view, x => x.includes('SIGNAL'));
    expect(run).not.toContain('game · live');
    expect(run).toContain('game · hold');
    expect(run).toContain('round  0');
    view.unmount();
  });
  it('a started day with reservations reads live', async () => {
    writeSignal('live_day_round_3', 3, 9);
    mkdirSync(join(signalDir, 'out/ledger'), { recursive: true });
    writeFileSync(join(signalDir, 'out/ledger/reservations.jsonl'), JSON.stringify({ type: 'reservation', usd: 1.5 }) + '\n');
    const st = signalState();
    expect(st?.live).toBe(true);
    const view = render(React.createElement(ShellV2, { width: 120 }));
    view.stdin.write('2');
    const run = await until(view, x => x.includes('SIGNAL'));
    expect(run).toContain('game · live');
    expect(run).toContain('round  3');
    view.unmount();
  });
});
