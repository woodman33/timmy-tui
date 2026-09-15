import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
import { chafaExecutable, checkedTerminalPreview, renderTerminalImage } from '../src/utils/terminal-image.js';

const png = resolve('examples/visual-tools/preview.png');
const actualChafa = chafaExecutable();
const roots: string[] = [];
const root = () => { const path = mkdtempSync(join(tmpdir(), 'timmy-chafa-')); roots.push(path); return path; };
const fake = (source: string) => {
  const path = join(root(), 'renderer'); writeFileSync(path, `#!${process.execPath}\n${source}`); chmodSync(path, 0o700);
  vi.stubEnv('TIMMY_CHAFA_BIN', path);
};
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });

async function fakeChild(pid?: number) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubEnv('TIMMY_CHAFA_BIN', process.execPath);
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid,
    kill: vi.fn(() => true) });
  const stdoutDestroy = vi.spyOn(child.stdout, 'destroy'), stderrDestroy = vi.spyOn(child.stderr, 'destroy');
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  vi.mocked(spawn).mockImplementationOnce(() => { ready(); return child as unknown as ReturnType<typeof spawn>; });
  const result = renderTerminalImage(png);
  await started;
  child.stdout.write('kept stdout'); child.stderr.write('kept stderr');
  return { child, result, kill, stdoutDestroy, stderrDestroy };
}

async function assertTerminal(fixture: Awaited<ReturnType<typeof fakeChild>>, failure: string | null) {
  const result = await fixture.result;
  expect(result.status).toBe(failure ? 'failed' : 'completed');
  const before = readFileSync(result.artifactPath!, 'utf8');
  expect(JSON.parse(before).failure).toBe(failure);
  expect(readFileSync(join(result.artifactPath!, '../raw.ansi'), 'utf8')).toBe('kept stdout');
  expect(readFileSync(join(result.artifactPath!, '../stderr.txt'), 'utf8')).toBe('kept stderr');
  expect(vi.getTimerCount()).toBe(0);
  const kills = fixture.kill.mock.calls.length, cleanup = fixture.stdoutDestroy.mock.calls.length;
  fixture.child.emit('error', new Error('late error'));
  fixture.child.emit('close', 0);
  fixture.child.stdout.emit('data', Buffer.alloc(300000));
  await vi.advanceTimersByTimeAsync(10000);
  expect(fixture.kill).toHaveBeenCalledTimes(kills);
  expect(fixture.stdoutDestroy).toHaveBeenCalledTimes(cleanup);
  expect(readFileSync(result.artifactPath!, 'utf8')).toBe(before);
  expect(readdirSync(join(result.artifactPath!, '..'))).toEqual(['preview.json', 'raw.ansi', 'source.png', 'stderr.txt']);
  return result;
}

describe('bounded asynchronous Chafa preview', () => {
  it('settles a spawn error without close promptly, keeps output and clears the caller running state', async () => {
    const fixture = await fakeChild();
    let running = true;
    const caller = fixture.result.finally(() => { running = false; });
    fixture.child.emit('error', new Error('spawn refused'));
    await assertTerminal(fixture, 'spawn_error'); await caller;
    expect(running).toBe(false);
    expect(fixture.kill).not.toHaveBeenCalled(); expect(fixture.child.kill).not.toHaveBeenCalled();
    expect(fixture.stdoutDestroy).toHaveBeenCalledTimes(1); expect(fixture.stderrDestroy).toHaveBeenCalledTimes(1);
  });
  it('keeps the original spawn failure when close follows and termination emits reentrant events', async () => {
    const fixture = await fakeChild(424242);
    fixture.kill.mockImplementation(() => {
      fixture.child.emit('error', new Error('during kill')); fixture.child.emit('close', 0); return true;
    });
    fixture.child.emit('error', new Error('first error')); fixture.child.emit('close', 0);
    await assertTerminal(fixture, 'spawn_error');
    expect(fixture.kill).toHaveBeenCalledExactlyOnceWith(-424242, 'SIGKILL');
    expect(fixture.child.kill).not.toHaveBeenCalled();
    expect(fixture.stdoutDestroy).toHaveBeenCalledTimes(1); expect(fixture.stderrDestroy).toHaveBeenCalledTimes(1);
  });
  it('settles timeout without waiting for close and does not repeat termination', async () => {
    const fixture = await fakeChild(424242);
    await vi.advanceTimersByTimeAsync(5000);
    await assertTerminal(fixture, 'timeout');
    expect(fixture.kill).toHaveBeenCalledTimes(1); expect(fixture.stdoutDestroy).toHaveBeenCalledTimes(1);
  });
  it('settles the output limit without close and preserves the bounded earlier output', async () => {
    const fixture = await fakeChild(424242);
    fixture.child.stdout.write(Buffer.alloc(300000));
    await assertTerminal(fixture, 'output_limit');
    expect(fixture.kill).toHaveBeenCalledTimes(1); expect(fixture.stdoutDestroy).toHaveBeenCalledTimes(1);
  });
  it('settles even when process-group and child termination both throw', async () => {
    const fixture = await fakeChild(424242);
    fixture.kill.mockImplementation(() => { throw new Error('already gone'); });
    fixture.child.kill.mockImplementation(() => { throw new Error('already gone'); });
    await vi.advanceTimersByTimeAsync(5000);
    await assertTerminal(fixture, 'timeout');
    expect(fixture.kill).toHaveBeenCalledTimes(1); expect(fixture.child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  });
  it('keeps a normal close final when error or output arrives afterward', async () => {
    const fixture = await fakeChild(424242);
    fixture.child.emit('close', 0);
    await assertTerminal(fixture, null);
    expect(fixture.kill).not.toHaveBeenCalled(); expect(fixture.stdoutDestroy).not.toHaveBeenCalled();
  });
  it('admits SGR colors and refuses terminal commands and oversized previews', () => {
    expect(checkedTerminalPreview('\x1b[38;2;255;0;0m██\x1b[0m\n')).toContain('██');
    for (const raw of ['\x1b[2Jtext', '\x1b]52;c;c2VjcmV0\x07', 'x\r', '', 'x'.repeat(65), Array(12).fill('x').join('\n')]) expect(() => checkedTerminalPreview(raw)).toThrow();
  });
  it('refuses unavailable runtimes and malformed, oversized, linked or special inputs', async () => {
    vi.stubEnv('TIMMY_CHAFA_BIN', 'relative/chafa');
    expect((await renderTerminalImage(png)).status).toBe('refused');
    fake('throw Error("must not execute")');
    const d = root(), bad = join(d, 'bad.png'), huge = join(d, 'huge.png'), link = join(d, 'link.png');
    writeFileSync(bad, Buffer.alloc(40));
    const bytes = Buffer.from(readFileSync(png)); bytes.writeUInt32BE(100000,16); writeFileSync(huge, bytes); symlinkSync(png,link);
    for (const file of [bad, huge, link, d, join(d,'absent')]) expect((await renderTerminalImage(file)).status).toBe('refused');
  });
  it('preserves failed decoder output without a completed preview', async () => {
    fake('process.stdout.write("failed raw");process.stderr.write("decode failed");process.exit(2)');
    const r = await renderTerminalImage(png);
    expect(r.status).toBe('failed'); expect(r.ansiPreview).toBeUndefined();
    expect(JSON.parse(readFileSync(r.artifactPath!, 'utf8'))).toMatchObject({exit_code:2,failure:'renderer_exit'});
    expect(readFileSync(join(r.artifactPath!,'../raw.ansi'),'utf8')).toBe('failed raw');
  });
  it('retains but refuses cursor controls returned by a renderer', async () => {
    fake('process.stdout.write("\\x1b[2Jscreen")');
    const r = await renderTerminalImage(png); expect(r.status).toBe('failed'); expect(r.ansiPreview).toBeUndefined();
    expect(JSON.parse(readFileSync(r.artifactPath!,'utf8')).failure).toBe('unsafe_or_oversized_preview');
  });
  it('terminates excessive native output', async () => {
    fake('process.stdout.write(Buffer.alloc(300000,120));setInterval(()=>{},1000)');
    const r = await renderTerminalImage(png); expect(r.status).toBe('failed');
    expect(JSON.parse(readFileSync(r.artifactPath!,'utf8')).failure).toBe('output_limit');
  });
  it.skipIf(!actualChafa)('runs the real headless CLI on a retained local PNG without changing the input', () => {
    const d = root(), before = readFileSync(png);
    const r = spawnSync(process.execPath, ['--import','tsx','src/cli.ts','vision','preview','--image',png,'--json'], {
      env:{...process.env,NODE_ENV:'test',TIMMY_STORE:join(d,'receipts'),TIMMY_CHAFA_BIN:actualChafa!}, encoding:'utf8',timeout:15000,maxBuffer:1024*1024
    });
    expect(r.status,r.stdout+r.stderr).toBe(0);
    const result = JSON.parse(r.stdout); expect(result.status).toBe('completed'); expect(result.ansiPreview.length).toBeGreaterThan(10);
    const report = JSON.parse(readFileSync(result.artifactPath,'utf8'));
    expect(report.source.sha256).toBe(createHash('sha256').update(before).digest('hex'));
    expect(report.limits).toMatchObject({model_calls:0,geometry_verified:false,receipt_sealed:false});
    expect(readFileSync(png)).toEqual(before); expect(existsSync(join(d,'receipts','runs.jsonl'))).toBe(false);
  });
});
