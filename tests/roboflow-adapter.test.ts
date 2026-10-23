import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const doubles = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), spawnSync: doubles.spawnSync }));
import { roboflowRun } from '../src/utils/roboflow-adapter.js';
import { readChain } from '../src/utils/receipts.js';
import * as assets from '../src/vision/config.js';

let dir: string;
let python: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'timmy-rf-unit-'));
  python = join(dir, 'python-unit-double');
  writeFileSync(python, 'unit test placeholder; never executed');
  vi.stubEnv('ROBOFLOW_API_KEY', 'unit-test-key-not-a-real-credential');
  vi.stubEnv('TIMMY_VISION_PYTHON', python);
  vi.stubEnv('TIMMY_STORE', join(dir, '.timmy', 'receipts'));
  doubles.spawnSync.mockReset();
  doubles.spawnSync.mockReturnValue({ stdout: JSON.stringify({ ok: true, state: 'observed', result: { predictions: [] } }), stderr: '', status: 0 });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('legacy Roboflow adapter unit controls (process doubles, no inference)', () => {
  it('reports not_configured without a key and records the refusal', () => {
    vi.stubEnv('ROBOFLOW_API_KEY', '');
    const result = roboflowRun({ action: 'sample', project: 'unit-observer', video: 'x.mp4' }, dir);
    expect(result).toMatchObject({ ok: false, state: 'not_configured' });
    expect(doubles.spawnSync).not.toHaveBeenCalled();
    expect(readChain('runs', dir).at(-1)).toMatchObject({ status: 'failed', error_class: 'not_configured' });
  });
  it('resolves the package bridge from a project that has no scripts directory', () => {
    roboflowRun({ action: 'detect', project: 'unit-project', path: 'fixture.png' }, dir);
    const [executable, args, options] = doubles.spawnSync.mock.calls[0];
    expect(executable).toBe(python);
    expect(args).toEqual([fileURLToPath(new URL('../scripts/roboflow-bridge.py', import.meta.url))]);
    expect(options.cwd).toBe(dir);
  });
  it('refuses a missing package bridge before launching Python', () => {
    vi.spyOn(assets, 'visionAsset').mockReturnValue(join(dir, 'missing-bridge.py'));
    expect(roboflowRun({ action: 'detect', project: 'unit-project', path: 'fixture.png' }, dir)).toMatchObject({ ok: false, state: 'not_available' });
    expect(doubles.spawnSync).not.toHaveBeenCalled();
  });
  it('refuses a relative Python override instead of falling back', () => {
    vi.stubEnv('TIMMY_VISION_PYTHON', 'python3');
    expect(roboflowRun({ action: 'detect', project: 'unit-project', path: 'fixture.png' }, dir)).toMatchObject({ ok: false, state: 'not_configured' });
    expect(doubles.spawnSync).not.toHaveBeenCalled();
  });
  it('uses the project vision venv when no Python override is set', () => {
    delete process.env.TIMMY_VISION_PYTHON;
    const venv = join(dir, '.timmy', 'venv-vision', 'bin');
    mkdirSync(venv, { recursive: true });
    writeFileSync(join(venv, 'python'), 'unit double; never executed');
    roboflowRun({ action: 'detect', project: 'unit-project', path: 'fixture.png' }, dir);
    expect(doubles.spawnSync.mock.calls[0][0]).toBe(join(venv, 'python'));
  });
  it('never relays raw stderr when the process protocol is invalid', () => {
    doubles.spawnSync.mockReturnValue({ stdout: 'not JSON', stderr: 'Bearer unit-test-key-not-a-real-credential', status: 1 });
    const result = roboflowRun({ action: 'detect', project: 'unit-project', path: 'fixture.png' }, dir);
    expect(result).toMatchObject({ ok: false, state: 'execution_error' });
    expect(JSON.stringify(result)).not.toContain('unit-test-key-not-a-real-credential');
    expect(JSON.stringify(result)).not.toContain('Bearer');
  });
  it('redacts credential-shaped response fields without truncating predictions', () => {
    const predictions = Array.from({ length: 37 }, (_, index) => ({ class: `unit-${index}`, confidence: 0.5 }));
    doubles.spawnSync.mockReturnValue({ stdout: JSON.stringify({ ok: true, predictions, result: { predictions }, token: 'unit-test-key-not-a-real-credential', note: 'unit-test-key-not-a-real-credential' }), stderr: '', status: 0 });
    const result = roboflowRun({ action: 'detect', project: 'unit-project', path: 'fixture.png' }, dir);
    expect(result.predictions).toHaveLength(37);
    expect(result.token).toBe('[redacted]');
    expect(result.note).toBe('[redacted]');
  });
  it('does not trust a success payload from a failed process', () => {
    doubles.spawnSync.mockReturnValue({ stdout: '{"ok":true}', stderr: '', status: 1 });
    expect(roboflowRun({ action: 'detect', project: 'unit-project', path: 'fixture.png' }, dir)).toMatchObject({ ok: false, state: 'execution_error' });
  });
});
