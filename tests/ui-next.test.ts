// ui-next — ENGINE ROOM Unreal/Houdini rows, LIBRARY Ollama local/cloud rows
// with FIT + schema strictness, CHAIN typed views for the new receipt kinds
// (tripo's never-measured flag included), and the RUN SIGNAL panel — all on
// placeholder fixtures (privacy-d5n9).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShellV2 } from '../src/tui/components/ShellV2.js';
import { unrealRow, houdiniRow, modelStrictness, signalState } from '../src/harness/uinext.js';
import { typedLines } from '../src/tui/chain-views.js';
import type { Receipt } from '../src/utils/receipts.js';

const rec = (subject: string, m: Record<string, unknown>): Receipt =>
  ({ v: 1, id: `rc_${subject}`, stream: 'runs', ts: '2026-01-01T00:00:00.000Z', kind: 'seal', subject, policy: 'auto', sources: [m], hash: 'sha256_0000000000000000', prev_hash: 'genesis' }) as unknown as Receipt;

let root = '';
let signalDir = '';
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'uinext-root-'));
  signalDir = mkdtempSync(join(tmpdir(), 'uinext-signal-'));
  const w = (rel: string, body: string) => {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, body);
  };
  w('lanes/engines/engines.json', JSON.stringify({ v: 1, engines: [{ id: 'houdini', installed: true, version: '22.0.429 (Current)', bridge: ['cli', 'mcp'] }] }));
  w('lanes/engines/inventory.json', JSON.stringify({ v: 1, engines: [{ id: 'houdini', templates: 4, proven: 1 }] }));
  w('lanes/schema/model-strictness.json', JSON.stringify({ v: 1, rows: [
    { model: 'placeholder/strict-one', tool_schema: 'strict' },
    { model: 'placeholder/lenient-two', tool_schema: 'lenient' },
  ] }));
  w('fleet/nodes.json', JSON.stringify({ v: 1, nodes: [{ id: 'node-a', status: 'joined', kind: 'fixture', ssh: 'ssh node-a', role: ['ollama'] }] }));
  w('lanes/unreal/README.md', '# fixture unreal lane\n');
  // signal fixture: live checkpoint + opening state + ledger reservations
  const sw = (rel: string, body: string) => {
    const p = join(signalDir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, body);
  };
  sw('out/latest-checkpoint.json', JSON.stringify({ checkpoint: 2, complete: false, status: 'hold_live_day_not_started', receipt: 'sha256_abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789' }));
  sw('out/opening-state.json', JSON.stringify({ state: { attention: 7 } }));
  sw('out/ledger/reservations.jsonl', JSON.stringify({ type: 'reservation', usd: 1.5 }) + '\n' + JSON.stringify({ type: 'reservation', usd: 0.5 }) + '\n');
  for (const k of ['TIMMY_REPO_ROOT', 'TIMMY_SIGNAL_DIR']) saved[k] = process.env[k];
  process.env.TIMMY_REPO_ROOT = root;
  process.env.TIMMY_SIGNAL_DIR = signalDir;
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

describe('uinext readers', () => {
  it('houdini + strictness + unreal rows read the fixture lanes', () => {
    const h = houdiniRow([]);
    expect(h.present).toBe(true);
    expect(h.installed).toBe(true);
    expect(h.bridge).toBe('cli,mcp');
    expect(h.templates).toBe(4);
    expect(h.proven).toBe(1);
    const strict = modelStrictness();
    expect(strict.find(r => r.model === 'placeholder/strict-one')?.schema).toBe('strict');
    expect(strict.find(r => r.model === 'placeholder/lenient-two')?.schema).toBe('lenient');
    const u = unrealRow([]);
    expect(u.present).toBe(true);
    expect(u.py).toBe('pending'); // no unreal.render receipt yet
    expect(u.lastRender).toBeNull();
  });
  it('signal state reads round, attention and ledger reservations', () => {
    const st = signalState();
    expect(st).not.toBeNull();
    expect(st?.live).toBe(true);
    expect(st?.round).toBe(2);
    expect(st?.attention).toBe(7);
    expect(st?.rows).toBe(2);
    expect(st?.reserved).toBe(2);
  });
});

describe('typed views for the new kinds', () => {
  it('tripo.generate shows the NEVER MEASURED flag until a proof seals', () => {
    const never = typedLines(rec('tripo.generate', { model: 'tripo/v3', ms: '900', ok: 'true' }));
    expect(never.some(l => l.includes('NEVER MEASURED'))).toBe(true);
    const measured = typedLines(rec('tripo.generate', { model: 'tripo/v3', ms: '900', ok: 'true', measured: true, asset_sha256: 'sha256_abcdef012345' }));
    expect(measured.some(l => l.includes('NEVER MEASURED'))).toBe(false);
    expect(measured.some(l => l.includes('measured · abcdef012345'))).toBe(true);
  });
  it('unreal.render / rig.parity / capture.face / signal.* render bounded lines', () => {
    const ur = typedLines(rec('unreal.render', { stage: 'world-01/observatory.usdc', cameras: '/Observatory/Cam', ms: '4200', ok: 'true', proof_sha256: 'sha256_abcdef012345' }));
    expect(ur.join('\n')).toContain('observatory.usdc');
    expect(ur.join('\n')).toContain('proof abcdef012345');
    const rp = typedLines(rec('rig.parity', { rig: 'rig-face-01', parity: '98.2', deltas: '3', method: 'marker-replay' }));
    expect(rp.join('\n')).toContain('parity 98.2');
    const cf = typedLines(rec('capture.face', { subject: 'placeholder-who', frames: '120', quality: '0.91', capture_sha256: 'sha256_0123456789ab' }));
    expect(cf.join('\n')).toContain('frames 120');
    const sg = typedLines(rec('signal.round', { round: '3', attention: '9', cumulative_reserved_usd: '2.00', type: 'reservation' }));
    expect(sg.join('\n')).toContain('round 3');
    expect(sg.join('\n')).toContain('attention 9/20');
    for (const lines of [ur, rp, cf, sg]) for (const l of lines) {
      expect(l.length).toBeLessThanOrEqual(42);
      expect(l).not.toContain('…');
    }
  });
});

describe('ui-next panes render', { timeout: 60000 }, () => {
  it('RUN shows the SIGNAL panel while the game is live; LIBRARY shows Ollama rows; ENGINE ROOM shows houdini', async () => {
    const view = render(React.createElement(ShellV2, { width: 120 }));
    await until(view, x => x.includes('YOUR JOURNEY') || x.includes('TIMMY'));
    view.stdin.write('2');
    const run = await until(view, x => x.includes('SIGNAL'));
    expect(run).toContain('round  2');
    expect(run).toContain('Attention  7/20');
    expect(run).toContain('ledger 2 rows');
    view.stdin.write('4');
    const lib = await until(view, x => x.includes('OLLAMA LOCAL/CLOUD'));
    expect(lib).toContain('strict-one');
    expect(lib).toContain('cloud');
    expect(lib.match(/strict-one[^\n]*strict/)).not.toBeNull();
    expect(lib.match(/lenient-two[^\n]*lenient/)).not.toBeNull();
    view.stdin.write('6');
    await until(view, x => x.includes('ENGINE ROOM'));
    await sleep(2600); // ENGINE ROOM's houdini/unreal rows land on the first poll tick
    const cmd = view.lastFrame() ?? '';
    expect(cmd).toContain('houdini');
    expect(cmd).toContain('drop  0 runs');
    view.unmount();
  });
});
