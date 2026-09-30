import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import * as childProcess from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { emitTimeline } from '../src/forge/timeline.js';
import { appendReceipt, readChain } from '../src/utils/receipts.js';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});
const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
const uvPython = join(homedir(), '.local', 'share', 'uv', 'tools', 'opentimelineio', 'bin', 'python');
const nativePython = actualFs.existsSync(uvPython) ? uvPython : 'python3';
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forge-otio-runtime-'));
  vi.stubEnv('TIMMY_FORGE', '1');
  vi.stubEnv('TIMMY_OTIO_PYTHON', undefined);
  vi.mocked(childProcess.spawnSync).mockClear();
  const artifact = join(dir, 'synthetic-reference.txt');
  writeFileSync(artifact, 'Synthetic reference; this test checks timeline parsing, not media playback.');
  appendReceipt('runs', { kind: 'gen.result', subject: 'synthetic OTIO runtime control', policy: 'auto',
    status: 'ok', artifacts: [artifact], sources: [{ slot_id: 'synthetic-clip' }] } as never, dir);
});
afterEach(() => {
  vi.mocked(existsSync).mockReset().mockImplementation(actualFs.existsSync);
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});
function assertUnpublished(out: string, receipts: number) {
  expect(existsSync(out)).toBe(false);
  expect(readdirSync(dir).filter(name => name.startsWith('.timeline-'))).toEqual([]);
  expect(readChain('runs', dir)).toHaveLength(receipts);
}

describe('pinned OTIO interpreter selection', () => {
  it('uses python3 when the optional uv installation is absent and still performs native acceptance', () => {
    const bin = join(dir, 'bin'); mkdirSync(bin);
    const wrapper = join(bin, 'python3');
    // Keep the native interpreter's environment intact while exposing the CI command name.
    writeFileSync(wrapper, `#!/bin/sh\nexec ${quote(nativePython === 'python3' ? childProcess.execFileSync('python3', ['-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' }).trim() : nativePython)} "$@"\n`);
    chmodSync(wrapper, 0o700);
    vi.stubEnv('PATH', bin + delimiter + process.env.PATH);
    vi.mocked(existsSync).mockImplementation(path => String(path) === uvPython ? false : actualFs.existsSync(path));
    const out = join(dir, 'accepted.otio');
    const result = emitTimeline({ dir, out });
    expect(result.clips).toBe(1);
    expect(JSON.parse(readFileSync(out, 'utf8')).tracks.children[0].children).toHaveLength(1);
    expect(vi.mocked(childProcess.spawnSync).mock.calls.some(([command, args]) => command === 'python3' && Array.isArray(args) && args[0] === '-c')).toBe(true);
  });

  it('refuses a missing explicitly configured interpreter and publishes no timeline or receipt', () => {
    vi.stubEnv('TIMMY_OTIO_PYTHON', join(dir, 'missing-python'));
    const out = join(dir, 'missing.otio'), before = readChain('runs', dir).length;
    expect(() => emitTimeline({ dir, out })).toThrow(/OTIO acceptance failed:.*ENOENT/);
    assertUnpublished(out, before);
  });

  it('rejects a different OTIO version even when the configured Python launches successfully', () => {
    const moduleDir = join(dir, 'python-modules'); mkdirSync(moduleDir);
    writeFileSync(join(moduleDir, 'opentimelineio.py'), '__version__ = "0.0.0"\n');
    vi.stubEnv('TIMMY_OTIO_PYTHON', nativePython);
    vi.stubEnv('PYTHONPATH', moduleDir);
    const out = join(dir, 'wrong-version.otio'), before = readChain('runs', dir).length;
    expect(() => emitTimeline({ dir, out })).toThrow(/OTIO version mismatch/);
    assertUnpublished(out, before);
  });
});
