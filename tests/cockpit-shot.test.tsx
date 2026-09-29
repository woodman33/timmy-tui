import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as privacy from '../lanes/privacy/scan.mjs';
import { runCockpitShot, CockpitShotSealError, type CockpitShotDependencies } from '../src/demo/cockpit-shot.js';

const fixture = resolve('lanes/demos/hands-8.rounds.md');
const roots: string[] = [];
const root = () => { const value = mkdtempSync(join(tmpdir(), 'timmy-cockpit-test-')); roots.push(value); return value; };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const capture: NonNullable<CockpitShotDependencies['capture']> = async ({ label }) => [
  { name: 'hands-120', width: 120, hold: 2.4, text: `${label}\nHANDS\neight declared hands` },
  { name: 'hands-80', width: 80, hold: 2, text: `${label}\nHANDS\neight declared hands` },
];
const options = (cwd: string) => ({ cwd, rounds: fixture, marker: 'test', film: false, seal: false });

describe('cockpit capture publication boundary', () => {
  it('labels synthetic input, hashes exact captures, and never reads or changes the caller store while rendering', async () => {
    const cwd = root(); const callerStore = join(cwd, 'caller-store'); mkdirSync(callerStore);
    writeFileSync(join(callerStore, 'runs.jsonl'), 'sentinel-private-store');
    vi.stubEnv('TIMMY_STORE', callerStore); vi.stubEnv('TIMMY_REPO_ROOT', cwd);
    const date = Date, random = Math.random; let workspace = '';
    const result = await runCockpitShot(options(cwd), { capture: async context => {
      workspace = context.root;
      expect(context.store).not.toBe(callerStore);
      expect(readdirSync(context.store)).toEqual([]);
      expect(context.board.hands).toHaveLength(8);
      expect(context.label).toContain('SYNTHETIC FIXTURE');
      return capture(context);
    } });
    expect(result).toMatchObject({ ok: true, sealed: null, renderer: 'injected-test', board: { kind: 'synthetic-fixture', hands: 8 } });
    expect(Date).toBe(date); expect(Math.random).toBe(random);
    expect(process.env.TIMMY_STORE).toBe(callerStore);
    expect(readFileSync(join(callerStore, 'runs.jsonl'), 'utf8')).toBe('sentinel-private-store');
    expect(existsSync(workspace)).toBe(false);
    const manifest = JSON.parse(readFileSync(join(result.directory, result.manifest), 'utf8'));
    expect(manifest.limits).toMatchObject({ fullShellCapture: false, nativeQualification: false, modelEvidenceAdmission: false });
    for (const shot of manifest.shots) expect(createHash('sha256').update(readFileSync(join(result.directory, shot.file))).digest('hex')).toBe(shot.sha256);
  });
  it('publishes source hashes instead of unscanned private source paths', async () => {
    const cwd = root(), boardDir = join(cwd, '.timmy/private/cockpit'); mkdirSync(boardDir, { recursive: true });
    vi.stubEnv('TIMMY_REPO_ROOT', cwd);
    const board = { source: join('/', 'Users', 'synthetic-only', 'private', 'ROUNDS.md'), importedAt: 'synthetic', hands: [{ name: 'hand', tool: 'external', worktree: 'fixture', order: 'fixture', round: 'R0', state: 'idle', lastSeal: '—' }], prompts: {} };
    writeFileSync(join(boardDir, 'board.json'), JSON.stringify(board));
    const result = await runCockpitShot({ ...options(cwd), rounds: undefined }, { capture });
    const manifest = readFileSync(join(result.directory, result.manifest), 'utf8');
    expect(manifest).not.toContain(board.source); expect(JSON.stringify(result)).not.toContain(board.source);
    expect(result.board.kind).toBe('private'); expect(result.board.source_sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it('refuses a private frame before publishing and cleans its temporary board', async () => {
    const cwd = root(); let workspace = '';
    await expect(runCockpitShot(options(cwd), { capture: async context => {
      workspace = context.root;
      return (await capture(context)).map(frame => ({ ...frame, text: frame.text + '\n' + join('/', 'Users', 'synthetic-only', 'private.txt') }));
    } })).rejects.toThrow('Privacy refused frame');
    expect(existsSync(join(cwd, '.timmy/captures'))).toBe(false); expect(existsSync(workspace)).toBe(false);
  });
  it('gates public metadata before creating output, even when frames are clean', async () => {
    const cwd = root(); const patterns = privacy.loadPatterns();
    vi.spyOn(privacy, 'loadPatterns').mockReturnValue({ ...patterns, patterns: [...patterns.patterns, { id: 'test.metadata', severity: 'high', re: 'do-not-publish', rx: /do-not-publish/g }] });
    await expect(runCockpitShot({ ...options(cwd), marker: 'do-not-publish' }, { capture })).rejects.toThrow('Privacy refused metadata');
    expect(existsSync(join(cwd, '.timmy/captures'))).toBe(false);
  });
  it('refuses terminal commands and unbounded injected frames without rewriting their bytes', async () => {
    for (const bad of ['\u001b]52;c;fixture\u0007', '\u009b2J', '\n'.repeat(40), 'x'.repeat(121)]) {
      const cwd = root();
      await expect(runCockpitShot(options(cwd), { capture: async context => (await capture(context)).map(frame => ({ ...frame, text: frame.text + '\n' + bad })) })).rejects.toThrow('unsafe capture frame');
      expect(existsSync(join(cwd, '.timmy/captures'))).toBe(false);
    }
  });
  it('refuses terminal commands in board declarations before rendering', async () => {
    const cwd = root(), input = join(cwd, 'unsafe.md');
    writeFileSync(input, readFileSync(fixture, 'utf8').replace('cc1', 'cc1\u001b]52;c;fixture\u0007'));
    const captureSpy = vi.fn(capture);
    await expect(runCockpitShot({ ...options(cwd), rounds: input }, { capture: captureSpy })).rejects.toThrow('unsafe terminal text');
    expect(captureSpy).not.toHaveBeenCalled();
  });
  it('does not publish or seal a failed native render and removes staging data', async () => {
    const cwd = root(), seal = vi.fn(); let workspace = '';
    const render = vi.fn<NonNullable<CockpitShotDependencies['render']>>((_command, _argv, staging) => { writeFileSync(join(staging, 'cockpit.gif'), 'partial'); return { status: 1 }; });
    await expect(runCockpitShot({ ...options(cwd), film: true, seal: true }, { capture: async context => { workspace = context.root; return capture(context); }, render, seal })).rejects.toThrow('agg did not produce');
    expect(render).toHaveBeenCalledTimes(1); expect(seal).not.toHaveBeenCalled();
    expect(readdirSync(join(cwd, '.timmy/captures'))).toEqual([]); expect(existsSync(workspace)).toBe(false);
  });
  it('passes fixed renderer argv and seals the final manifest hash', async () => {
    const cwd = root();
    const render = vi.fn((command: 'agg' | 'ffmpeg', _argv: string[], staging: string) => { writeFileSync(join(staging, command === 'agg' ? 'cockpit.gif' : 'cockpit.mp4'), 'SYNTHETIC RENDER BYTES'); return { status: 0 }; });
    const seal = vi.fn<NonNullable<CockpitShotDependencies['seal']>>(() => ({ ok: true, hash: 'synthetic-test-receipt' }));
    const result = await runCockpitShot({ ...options(cwd), film: true, seal: true }, { capture, render, seal });
    expect(render.mock.calls.map(call => call[0])).toEqual(['agg', 'ffmpeg']);
    expect(render.mock.calls[0][1]).toEqual(['cockpit.cast', 'cockpit.gif']);
    expect(render.mock.calls[1][1][0]).toBe('-n');
    expect(seal.mock.calls[0][1]).toMatchObject({ manifest_sha256: createHash('sha256').update(readFileSync(join(result.directory, 'manifest.json'))).digest('hex'), renderer: 'injected-test' });
  });
  it('reports a failed seal as unsealed rather than success', async () => {
    const cwd = root();
    const refusal = { ok: false, note: 'synthetic refusal retained verbatim' };
    const error = await runCockpitShot({ ...options(cwd), seal: true }, { capture, seal: () => refusal }).catch(error => error);
    expect(error).toBeInstanceOf(CockpitShotSealError);
    expect(error.message).toContain('capture is unsealed');
    expect(error.refusal).toBe(refusal);
  });
  it('renders the read-only Ink board without full-shell or live services', async () => {
    const cwd = root();
    const result = await runCockpitShot(options(cwd));
    expect(result.renderer).toBe('cockpit-read-only-ink-view');
    const manifest = JSON.parse(readFileSync(join(result.directory, result.manifest), 'utf8'));
    expect(manifest.shots).toHaveLength(5);
    expect(readFileSync(join(result.directory, 'prompt-120.txt'), 'utf8')).toContain('prompt cc1 R4');
    expect(readFileSync(join(result.directory, 'hands-80.txt'), 'utf8')).toContain('SYNTHETIC FIXTURE');
  });
  it('refuses symlink and oversized chart inputs before capture', async () => {
    const cwd = root(), linked = join(cwd, 'linked.md'), oversized = join(cwd, 'oversized.md');
    symlinkSync(fixture, linked); writeFileSync(oversized, Buffer.alloc(1024 * 1024 + 1));
    const captureSpy = vi.fn(capture);
    for (const rounds of [linked, oversized]) await expect(runCockpitShot({ ...options(cwd), rounds }, { capture: captureSpy })).rejects.toThrow();
    expect(captureSpy).not.toHaveBeenCalled(); expect(existsSync(join(cwd, '.timmy/captures'))).toBe(false);
  });
  it.skipIf(process.platform === 'win32')('refuses FIFO input without waiting for a writer', async () => {
    const cwd = root(), fifo = join(cwd, 'input.pipe'); execFileSync('mkfifo', [fifo]);
    const captureSpy = vi.fn(capture);
    await expect(runCockpitShot({ ...options(cwd), rounds: fifo }, { capture: captureSpy })).rejects.toThrow('bounded regular');
    expect(captureSpy).not.toHaveBeenCalled(); expect(existsSync(join(cwd, '.timmy/captures'))).toBe(false);
  });
  it('refuses traversal markers and leaves existing captures unchanged', async () => {
    const cwd = root();
    await expect(runCockpitShot({ ...options(cwd), marker: '../outside' }, { capture })).rejects.toThrow('Marker');
    const result = await runCockpitShot(options(cwd), { capture });
    const original = readFileSync(join(result.directory, result.manifest));
    await expect(runCockpitShot(options(cwd), { capture })).rejects.toThrow('already exists');
    expect(readFileSync(join(result.directory, result.manifest))).toEqual(original);
  });
});
