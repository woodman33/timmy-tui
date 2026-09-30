import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveManagedOutput, type WitnessDeps } from '../packages/opencode-witness/src/witness.js';

const digest = (bytes: Uint8Array | string) => 'sha256_' + createHash('sha256').update(bytes).digest('hex');
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'witness-file-boundary-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function contentSpies() {
  return {
    exists: vi.fn((path: string) => existsSync(path)),
    readFile: vi.fn((path: string) => readFileSync(path, 'utf8')),
    sizeOf: vi.fn((path: string) => statSync(path).size),
  };
}

describe('managed output filesystem boundaries', () => {
  it('refuses a guarded intermediate file symlink even when its final target is unguarded', () => {
    const target = join(dir, 'payload.bin');
    writeFileSync(target, 'synthetic protected bytes');
    symlinkSync(target, join(dir, '.env'));
    const presented = join(dir, 'innocent.output');
    symlinkSync(join(dir, '.env'), presented);
    const spies = contentSpies();
    const result = resolveManagedOutput({ output_file: presented }, '', spies);
    expect(result).toMatchObject({ refused: 'guarded_path', guarded_id: 'dotenv' });
    expect(spies.exists).not.toHaveBeenCalled();
    expect(spies.readFile).not.toHaveBeenCalled();
    expect(spies.sizeOf).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('sha256');
    expect(JSON.stringify(result)).not.toContain(digest('synthetic protected bytes'));
  });

  it('refuses a guarded intermediate directory hop before measuring or reading its final child', () => {
    const payload = join(dir, 'payload-root');
    mkdirSync(payload);
    writeFileSync(join(payload, 'result.output'), 'synthetic protected bytes');
    mkdirSync(join(dir, '.timmy'));
    symlinkSync(payload, join(dir, '.timmy', 'private'));
    symlinkSync(join(dir, '.timmy', 'private'), join(dir, 'innocent-directory'));
    const spies = contentSpies();
    const result = resolveManagedOutput({ persistedOutput: join(dir, 'innocent-directory', 'result.output') }, '', spies);
    expect(result).toMatchObject({ refused: 'guarded_path', guarded_id: 'private_overlay' });
    expect(spies.exists).not.toHaveBeenCalled();
    expect(spies.readFile).not.toHaveBeenCalled();
    expect(spies.sizeOf).not.toHaveBeenCalled();
    expect(result).not.toHaveProperty('sha256');
  });

  it('does not fall back to opening the presented path when final realpath resolution fails', () => {
    const path = join(dir, 'safe.output');
    writeFileSync(path, 'synthetic bytes');
    const spies = contentSpies();
    const deps: WitnessDeps = { ...spies, realpath: () => { throw Object.assign(new Error('synthetic EACCES'), { code: 'EACCES' }); } };
    const result = resolveManagedOutput({ managedOutputFile: path }, '', deps);
    expect(result).toHaveProperty('refused');
    expect(result).not.toHaveProperty('sha256');
    expect(spies.exists).not.toHaveBeenCalled();
    expect(spies.readFile).not.toHaveBeenCalled();
    expect(spies.sizeOf).not.toHaveBeenCalled();
  });

  it('hashes and counts the same raw binary bytes without UTF-8 replacement', () => {
    const path = join(dir, 'binary.output');
    const bytes = Buffer.from([0x00, 0xff, 0xfe, 0xc3, 0x28, 0x80, 0x61]);
    writeFileSync(path, bytes);
    expect(resolveManagedOutput({ output_file: path }, '')).toMatchObject({ sha256: digest(bytes), size: bytes.length });
  });

  it('refuses directories without invoking the content reader or size adapter', () => {
    const path = join(dir, 'directory.output');
    mkdirSync(path);
    const readFile = vi.fn(() => 'must not be read');
    const sizeOf = vi.fn(() => 123);
    const result = resolveManagedOutput({ output_file: path }, '', { readFile, sizeOf });
    expect(result).toHaveProperty('refused');
    expect(result).not.toHaveProperty('sha256');
    expect(readFile).not.toHaveBeenCalled();
    expect(sizeOf).not.toHaveBeenCalled();
  });

  it('refuses a real FIFO promptly without blocking on a content read', () => {
    const fifo = join(dir, 'pipe.output');
    execFileSync('mkfifo', [fifo]);
    // A separate process bounds an accidental blocking read in the regression.
    // It imports only the witness core, uses our temporary FIFO and never seals.
    const moduleUrl = pathToFileURL(join(process.cwd(), 'packages/opencode-witness/src/witness.ts')).href;
    const script = `const { resolveManagedOutput } = await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(resolveManagedOutput({output_file: process.argv[1]}, '')));`;
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, fifo], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 3000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(JSON.parse(output)).toHaveProperty('refused');
    expect(JSON.parse(output)).not.toHaveProperty('sha256');
  });
});
