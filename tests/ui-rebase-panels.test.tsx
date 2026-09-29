// Rebase union: ui-next lane data must survive C5's bounded-card layout.
// All service/process boundaries are replaced; these are local frame tests.
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { EventEmitter } from 'node:events';
import { render } from 'ink';
import { ShellV2 } from '../src/tui/components/ShellV2.js';
import { visibleWidth } from '../src/tui/utils/text.js';

const fixture = vi.hoisted(() => ({ many: false }));
vi.mock('child_process', async importOriginal => ({
  ...await importOriginal<typeof import('child_process')>(),
  spawnSync: vi.fn(() => ({ status: 1, stdout: '', stderr: '' })),
  spawn: vi.fn(() => { throw new Error('Frame tests must not launch processes'); }),
}));
vi.mock('../src/bus/index.js', () => ({ subscribe: () => ({ stop() {} }), publish: vi.fn() }));
vi.mock('../src/vision/integrations/registry.js', () => ({ integrationCatalog: () => [] }));
vi.mock('../src/harness/commander.js', () => ({
  CommanderClient: class { online = false; connect() {} close() {} }, edgeToken: () => '',
}));
vi.mock('../src/harness/cockpit.js', () => ({ loadBoard: () => null, ROUNDS: ['R0', 'R1', 'R2', 'R3', 'R4'] }));
vi.mock('../src/utils/dispatch.js', () => ({ listLanes: () => [{ id: 'jcode', available: false }] }));
vi.mock('../src/harness/policy.js', () => ({
  readPolicy: () => ({ default: 'fixture/model', scopes: {} }), setModel: vi.fn(), ADAPTERS: [],
}));
vi.mock('../src/models/registry.js', () => ({ listModelsSync: () => [], readNotes: () => ({}), notesPath: () => '/unused' }));
vi.mock('../src/utils/escrow-engine.js', () => ({ listEscrows: () => [], lockEscrow: vi.fn(), cancelEscrow: vi.fn() }));
vi.mock('../src/utils/receipts.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/utils/receipts.js')>(),
  readChain: () => [], verifyChain: () => ({ ok: true, count: 0, segments: [] }),
  appendReceipt: vi.fn(() => { throw new Error('Frame tests must not append receipts'); }),
}));
vi.mock('../src/harness/warroom.js', () => ({
  defaultProfile: () => ({ name: 'fixture', commander: { model: 'fixture', ws: null }, harnesses: [{ id: 'jcode', model: 'fixture/model', weight: 0 }] }),
  panes: () => [],
}));
vi.mock('../src/harness/warroom2.js', () => ({
  swarmPresets: () => [], swarmRuns: () => [], sbxRuns: () => [], dockerPorts: () => ({}), abilities: () => [],
  projects: () => [{ name: 'fixture-project', budget: 3.5, skills: ['example'], plans: [], drop: [] }],
  nodeStats: () => Array.from({ length: fixture.many ? 18 : 2 }, (_, i) => ({
    id: `node-${i}`, reachable: true, memGb: 32, tokPerS: 21,
    // Repeated tags on distinct nodes must retain distinct React identities.
    models: ['fixture/shared-local'],
  })),
  nodeForModel: () => null, modelFit: () => true,
}));
vi.mock('../src/harness/uinext.js', () => ({
  unrealRow: () => ({ present: true, root: 'env', rc: true, py: 'ok', lastRender: { hash: 'abcdef01', stage: 'fixture-stage' } }),
  houdiniRow: () => ({ present: true, installed: true, version: '22.0.429', bridge: 'cli,mcp', templates: 4, proven: 1, dropRuns: 3 }),
  modelStrictness: () => [
    { model: 'fixture/shared-local', schema: 'strict' },
    { model: 'fixture/cloud-remote', schema: 'lenient' },
  ],
  signalState: () => ({ live: true, round: 2, status: 'hold_live_day_not_started', receipt: 'abcdef012345', attention: 7, reserved: 2, rows: 2, dir: '/unused' }),
}));

class Output extends EventEmitter {
  last = '';
  constructor(public columns: number, public rows: number) { super(); }
  write = (value: string): boolean => { this.last = value; return true; };
}
class Input extends EventEmitter {
  isTTY = true;
  data: string | null = null;
  write(value: string) { this.data = value; this.emit('readable'); this.emit('data', value); }
  setEncoding() {} setRawMode() {} resume() {} pause() {} ref() {} unref() {}
  read() { const value = this.data; this.data = null; return value; }
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const clean = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, '');
function frameAt(width: number, height: number) {
  const stdout = new Output(width, height);
  const stderr = new Output(width, height);
  const stdin = new Input();
  const view = render(<ShellV2 width={width} />, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true, exitOnCtrlC: false, patchConsole: false,
  });
  return { frame: () => clean(stdout.last), stderr: () => clean(stderr.last), key: (key: string) => stdin.write(key), unmount: () => view.unmount() };
}
function expectBounded(frame: string, width: number, height: number) {
  const lines = frame.split('\n');
  expect(lines.length, frame).toBeLessThanOrEqual(height);
  expect(lines.filter(line => visibleWidth(line) > width), frame).toEqual([]);
  expect(lines[0], frame).toContain('TIMMY');
  expect(lines[1]?.trim(), frame).toMatch(/^─+$/);
  expect(lines.filter(line => /^\s*│/.test(line) && !/[│╮╯]\s*$/.test(line)), frame).toEqual([]);
}

describe('ui-next + bounded rows rebase', () => {
  for (const [width, height, many] of [[80, 24, false], [120, 40, false], [120, 24, true]] as const) {
    it(`${width}x${height}: lane cards preserve their data or disclose folding/overflow`, async () => {
      fixture.many = many;
      const savedRows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
      Object.defineProperty(process.stdout, 'rows', { value: height, configurable: true });
      const warnings = vi.spyOn(console, 'error').mockImplementation(() => {});
      const view = frameAt(width, height);
      try {
        // The Shell collects node inventory on its first two-second tick.
        await pause(2250);
        const frames: Record<string, string> = {};
        for (const [tab, key] of [['RUN', '2'], ['LIBRARY', '4'], ['COMMAND', '6']] as const) {
          view.key(key);
          await pause(200);
          frames[tab] = view.frame();
          expectBounded(frames[tab], width, height);
        }
        if (width === 120 && height === 40) {
          expect(frames.RUN).toContain('SIGNAL');
          expect(frames.RUN).toContain('Attention  7/20');
          expect(frames.RUN).toContain('ledger 2 rows');
          expect(frames.LIBRARY).toContain('OLLAMA LOCAL/CLOUD');
          expect(frames.LIBRARY).toMatch(/shared-local[^\n]*local[^\n]*FIT[^\n]*strict/);
          expect(frames.LIBRARY).toMatch(/cloud-remote[^\n]*cloud[^\n]*edge[^\n]*lenient/);
          expect(frames.LIBRARY).toContain('$3.5');
          expect(frames.COMMAND).toContain('unreal');
          expect(frames.COMMAND).toContain('abcdef01');
          expect(frames.COMMAND).toContain('houdini');
          expect(frames.COMMAND).toContain('drop  3 runs');
        }
        if (many) {
          expect(frames.LIBRARY).toContain('OLLAMA');
          expect(frames.COMMAND).toContain('ENGINE ROOM');
          expect(frames.LIBRARY).toMatch(/▾[^\n]*(?:more|folded)/);
          expect(frames.COMMAND).toMatch(/▾[^\n]*(?:more|folded)/);
        }
        expect(view.stderr()).not.toMatch(/same key|unique.*key|hooks/i);
        expect(warnings.mock.calls.flat().join(' ')).not.toMatch(/same key|unique.*key|hooks/i);
      } finally {
        view.unmount();
        warnings.mockRestore();
        if (savedRows) Object.defineProperty(process.stdout, 'rows', savedRows);
        else Reflect.deleteProperty(process.stdout, 'rows');
        fixture.many = false;
      }
    });
  }

  it('arrow escape events never become buffer text; literal direction words remain text', async () => {
    const savedRows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
    Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true });
    const view = frameAt(120, 40);
    const send = async (...keys: string[]) => {
      for (const key of keys) { view.key(key); await pause(40); }
      await pause(80);
    };
    const arrows = ['\x1b[A', '\x1b[B', '\x1b[D', '\x1b[C'];
    try {
      await pause(150);
      // INSERT's visible library filter is the actual state buffer.
      await send('4', '/', 'seed-', ...arrows, 'up');
      expect(view.frame()).toMatch(/\/ seed-up(?=\s|[│█]|$)/);
      expect(view.frame()).not.toContain('seed-updownleftright');
      await send('\x1b', '\x1b');

      // Open CHAT without submitting it: no agent/model call is made.
      await send('c', 'seed-', ...arrows, 'up');
      expect(view.frame()).toContain('SOVEREIGN CHAT');
      expect(view.frame()).toMatch(/> seed-up(?=\s|[│█]|$)/);
      expect(view.frame()).not.toContain('seed-updownleftright');
      await send('\x1b');

      for (const [tab, overlay, title] of [['4', 'n', 'NOTE —'], ['2', 'r', 'REFUSE — reason required']] as const) {
        await send(tab, overlay, 'seed-', ...arrows, 'up');
        expect(view.frame()).toContain(title);
        expect(view.frame()).toMatch(/> seed-up(?=\s|[│█]|$)/);
        expect(view.frame()).not.toContain('seed-updownleftright');
        // Abandon overlays; never save a note or submit a refusal.
        await send('\x1b');
      }
    } finally {
      view.unmount();
      if (savedRows) Object.defineProperty(process.stdout, 'rows', savedRows);
      else Reflect.deleteProperty(process.stdout, 'rows');
    }
  });
});
