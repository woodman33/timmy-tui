import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: vi.fn((...args: Parameters<typeof spawn>) => { throw new Error('unexpected subprocess in synthetic demo test'); }) }));
import { demosRows, demoWindow, openDemo, type DemoRow } from '../src/harness/uinext.js';
import { DemosPane, ShellV2 } from '../src/tui/components/ShellV2.js';
import { initialShell, shellOnKey } from '../src/tui/shell-mode.js';
import { appendReceipt, hashOf, type Receipt } from '../src/utils/receipts.js';
import { signBody } from '../src/utils/signing.js';
let root: string;
const families = Array.from({ length: 9 }, (_, n) => ({ id: `family-${n}`, family: `family-${n}`, demo: 'canvas', open: `surface-${n}.html`, fill: `lane.${n}`, prediction: { text: 'Declared plan', seal: null }, evidence: { path: null, seal: null } }));
const registry = (value: unknown = families) => writeFileSync(join(root, 'lanes/demos/families.json'), JSON.stringify({ families: value }));
function receipt(id: string, subject: string, sources: unknown[] = [], status: Receipt['status'] = 'ok'): Receipt {
  const body = { v: 1 as const, id, subject, stream: 'runs', ts: '2026-01-01T00:00:00.000Z', kind: 'synthetic-test', policy: 'auto', prev_hash: 'genesis', sources, status };
  const signed = { ...body, ...signBody(body, root) };
  return { ...signed, hash: hashOf({ ...signed, hash: '' }) };
}
beforeEach(() => {
  vi.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), 'timmy-demos-'));
  mkdirSync(join(root, 'lanes/demos'), { recursive: true }); registry();
  vi.stubEnv('TIMMY_STORE', join(root, '.timmy/receipts'));
  vi.stubEnv('TIMMY_SIGNAL_DIR', join(root, 'absent-signal'));
  vi.stubEnv('TIMMY_REPO_ROOT', root); vi.stubEnv('TIMMY_DEMO', '1');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe('historical demo references', () => {
  it('uses only signed, untampered successful receipts and real prediction references', () => {
    const pred = receipt('prediction-1', 'prediction.fixture');
    const evidence = receipt('evidence-1', 'lane.8 test-run', [{ prediction_receipt: pred.id }]);
    const before = JSON.stringify([pred, evidence]);
    const rows = demosRows([pred, evidence]);
    expect(rows[0]).toMatchObject({ id: 'family-8', status: 'historical refs', prediction: { seal: pred.hash.slice(7, 15) }, evidence: { seal: evidence.hash.slice(7, 15) } });
    expect(JSON.stringify([pred, evidence])).toBe(before);
    for (const bad of [receipt('failed', 'lane.8', [], 'failed'), { ...evidence, signature: undefined }, { ...evidence, subject: 'lane.8 forged' }, { ...evidence, hash: 'sha256_bad' }]) {
      expect(demosRows([bad]).every(row => row.evidence.seal === null)).toBe(true);
    }
    expect(demosRows([receipt('arbitrary-reference', 'lane.8', [{ prediction_receipt: 'actual' }])])[0].prediction.seal).toBeNull();
    expect(demosRows([receipt('prefix-collision', 'lane.80')]).every(row => row.evidence.seal === null)).toBe(true);
  });
  it('refuses self-references and predictions appended after their evidence', () => {
    const self = receipt('self', 'lane.0', [{ prediction_receipt: 'self' }]);
    expect(demosRows([self])[0].prediction.seal).toBeNull();
    const later = receipt('later', 'prediction.fixture');
    const ev = receipt('ev-before-pred', 'lane.0', [{ prediction_receipt: later.id }]);
    expect(demosRows([ev, later])[0].prediction.seal).toBeNull();
    expect(demosRows([later, ev])[0].prediction.seal).toBe(later.hash.slice(7, 15));
  });
  it('sanitizes the display projection while preserving raw family metadata', async () => {
    const family = 'name\x1b]52;c;fixture\x07\n\u202e';
    const raw = { ...families[0], family };
    registry([raw]);
    const row = demosRows()[0];
    expect(row.family).not.toMatch(/[\x00-\x1f\x7f-\x9f\u202a-\u202e]/);
    expect((await openDemo({ ...row, family })).note).not.toMatch(/[\x00-\x1f\x7f-\x9f\u202a-\u202e]/);
    expect(raw.family).toBe(family);
  });
  it('does not promote registry seal strings without matching historical receipts', () => {
    registry([{ ...families[0], prediction: { seal: 'sha256_' + 'a'.repeat(64) }, evidence: { seal: 'sha256_' + 'b'.repeat(64) } }]);
    expect(demosRows([receipt('other', 'lane.0')])[0]).toMatchObject({ status: 'unknown', prediction: { seal: null }, evidence: { seal: null } });
    registry({ malformed: true }); expect(demosRows()).toEqual([]);
    registry([null, {}, families[0], families[0]]); expect(demosRows()).toHaveLength(1);
  });
  it('keeps the selection visible after sorting and opens that exact row', async () => {
    const rows = demosRows([receipt('ev', 'lane.8')]);
    writeFileSync(join(root, 'surface-8.html'), 'synthetic');
    const view = render(<DemosPane rows={rows} sel={0} armed maxRows={4} />);
    expect(view.lastFrame()).toContain('▶ family-8');
    expect((await openDemo(rows[demoWindow(rows, 0, 4).index])).note).toBe('family-8: demo no-op open');
    view.rerender(<DemosPane rows={rows} sel={8} armed maxRows={4} />);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(view.lastFrame()).toContain('▶ family-7');
    expect(view.lastFrame()).toContain('more families');
    expect(demoWindow(rows, 8, 4).shown.map(row => row.id)).toContain('family-7');
    view.unmount();
  });
  it.each([80, 120])('opens the highlighted sorted family through ShellV2 at %i columns', async width => {
    const previousRows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
    Object.defineProperty(process.stdout, 'rows', { value: 24, configurable: true });
    appendReceipt('runs', { kind: 'synthetic-test', subject: 'lane.8', policy: 'auto', status: 'ok' }, root);
    writeFileSync(join(root, 'surface-8.html'), 'synthetic');
    const view = render(<ShellV2 width={width} />);
    const until = async (text: string) => {
      for (let i = 0; i < 80 && !view.lastFrame()?.includes(text); i++) await new Promise(resolve => setTimeout(resolve, 25));
      expect(view.lastFrame()).toContain(text);
    };
    try {
      await until('YOUR JOURNEY'); view.stdin.write('4'); await until('MODELS');
      view.stdin.write('D'); await until('▶ family-8');
      view.stdin.write('\r'); await until('family-8: demo no-op open');
      for (let i = 0; i < 8; i++) { view.stdin.write(']'); await new Promise(resolve => setTimeout(resolve, 25)); }
      await until('▶ family-7');
      expect(view.lastFrame()!.split('\n').length).toBeLessThanOrEqual(24);
      expect(view.lastFrame()).toContain('PRED — EV —');
    } finally {
      view.unmount();
      if (previousRows) Object.defineProperty(process.stdout, 'rows', previousRows); else Reflect.deleteProperty(process.stdout, 'rows');
    }
  });
  it('arms library navigation without taking commander or text-entry keys', () => {
    const initial = { ...initialShell(), tab: 'LIBRARY' as const };
    const armed = shellOnKey(initial, 'D').state;
    expect(shellOnKey(armed, ']').actions).toEqual(['demo-next']);
    expect(shellOnKey(armed, 'Enter').actions).toEqual(['demo-open']);
    expect(shellOnKey(armed, 'Esc').state.demoArmed).toBe(false);
    expect(shellOnKey({ ...armed, mode: 'INSERT' }, 'D').state.input).toBe('D');
    expect(shellOnKey({ ...armed, tab: 'COMMAND' }, ']').actions).toEqual(['sw-preset-next']);
  });
  it('refuses missing and escaping surfaces, including symlinks', async () => {
    const row = demosRows()[0];
    expect((await openDemo(row)).ok).toBe(false);
    const outside = mkdtempSync(join(tmpdir(), 'timmy-demos-outside-'));
    try {
      writeFileSync(join(outside, 'external.html'), 'synthetic');
      symlinkSync(join(outside, 'external.html'), join(root, 'surface-0.html'));
      expect((await openDemo(row)).note).toContain('inside the repository');
      expect(spawn).not.toHaveBeenCalled();
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });
  it.skipIf(process.platform !== 'darwin')('settles opener errors without claiming an opened surface', async () => {
    vi.stubEnv('TIMMY_DEMO', '0');
    writeFileSync(join(root, 'surface-0.html'), 'synthetic');
    const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
    vi.mocked(spawn).mockImplementationOnce(() => child as unknown as ReturnType<typeof spawn>);
    const pending = openDemo(demosRows()[0]); child.emit('error', new Error('synthetic launch failure'));
    expect(await pending).toMatchObject({ ok: false });
    child.emit('error', new Error('late synthetic error')); child.emit('close', 0);
  });
});
