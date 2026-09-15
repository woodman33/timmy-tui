import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chafaExecutable, checkedTerminalPreview, renderTerminalImage } from '../src/utils/terminal-image.js';

const png = resolve('examples/visual-tools/preview.png');
const actualChafa = chafaExecutable();
const roots: string[] = [];
const root = () => { const path = mkdtempSync(join(tmpdir(), 'timmy-chafa-')); roots.push(path); return path; };
const fake = (source: string) => {
  const path = join(root(), 'renderer'); writeFileSync(path, `#!${process.execPath}\n${source}`); chmodSync(path, 0o700);
  vi.stubEnv('TIMMY_CHAFA_BIN', path);
};
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });

describe('bounded asynchronous Chafa preview', () => {
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
