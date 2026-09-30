import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { signalState } from '../src/harness/uinext.js';
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'timmy-signal-label-'));
  mkdirSync(join(root, 'out/ledger'), { recursive: true });
  writeFileSync(join(root, 'out/ledger/reservations.jsonl'), JSON.stringify({ usd: 5 }) + '\n');
  vi.stubEnv('TIMMY_SIGNAL_DIR', root);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
it.each(['hold_live_day_not_started', 'hold_budget', 'paused', 'blocked', 'not_started'])('never promotes %s to live based on old progress or reservations', status => {
  writeFileSync(join(root, 'out/latest-checkpoint.json'), JSON.stringify({ status, checkpoint: 3 }));
  expect(signalState()).toMatchObject({ label: 'hold', live: false, round: 3, reserved: 5 });
});
it.each([['complete', 'complete'], ['live_day_round_3', 'live'], ['idle', 'idle'], ['unrecognized', 'unknown']])('projects explicit %s status as %s', (status, label) => {
  writeFileSync(join(root, 'out/latest-checkpoint.json'), JSON.stringify({ status, checkpoint: 3 }));
  expect(signalState()).toMatchObject({ label, live: label === 'live' });
});
it('keeps a missing checkpoint absent', () => expect(signalState()).toBeNull());
