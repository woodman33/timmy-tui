import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureFrames, parseCaptureArgs } from '../scripts/capture-frames.js';

const fixtures: string[] = [];
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), 'capture-control-')); fixtures.push(dir); return dir; };
afterEach(() => { for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('PTY capture command boundary', () => {
  it('rejects traversal, shell names and invalid numeric/environment arguments before execution', () => {
    for (const extra of [['--name', '../out'], ['--name', 'bad;echo'], ['--width', 'NaN'], ['--height', '-1'], ['--wait', 'Infinity'], ['--env', 'BAD-KEY=x'], ['--env'], ['--unknown', 'x']]) {
      expect(() => parseCaptureArgs(['--name', 'frame', ...extra])).toThrow();
    }
  });
  it('passes literal text and environment values without shell expansion and uses an owned session', async () => {
    const dir = fixture();
    const calls: string[][] = [];
    const literal = '$(touch sentinel);`echo bad`';
    const result = await captureFrames(parseCaptureArgs(['--out', dir, '--name', 'frame', '--keys', `text:${literal}`, '--env', "VALUE=a'b$(echo secret)"]), {
      tmux: args => { calls.push(args); return args[0] === 'capture-pane' ? 'TIMMY 1 HOME\nready\n' : ''; },
      sleep: async () => {}, now: () => 0,
    });
    expect(calls[0][0]).toBe('new-session');
    expect(calls[0].at(-1)).toContain("'VALUE=a'\\''b$(echo secret)'");
    expect(calls.find(c => c[0] === 'send-keys')?.slice(-3)).toEqual(['-l', '--', literal]);
    expect(calls.at(-1)?.[0]).toBe('kill-session');
    expect(calls[0][calls[0].indexOf('-s') + 1]).toMatch(/^timmy-capture-[a-f0-9-]+$/);
    expect(readFileSync(join(dir, 'frame'), 'utf8')).toContain('TIMMY 1');
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it('timeout refuses output and still cleans up the owned session', async () => {
    const calls: string[][] = []; let t = 0; const out = fixture();
    await expect(captureFrames(parseCaptureArgs(['--out', out, '--name', 'frame', '--wait', '1']), {
      tmux: args => { calls.push(args); return 'assembling'; }, sleep: async () => { t += 500; }, now: () => t,
    })).rejects.toThrow('did not assemble');
    expect(calls.at(-1)?.[0]).toBe('kill-session');
    expect(existsSync(join(out, 'frame'))).toBe(false);
  });
  it('rejects readiness first observed after the deadline', async () => {
    let t = 0; const out = fixture();
    await expect(captureFrames(parseCaptureArgs(['--out', out, '--name', 'frame', '--wait', '1']), {
      tmux: () => 'TIMMY 1 HOME', sleep: async () => { t += 500; }, now: () => t,
    })).rejects.toThrow('did not assemble');
    expect(existsSync(join(out, 'frame'))).toBe(false);
  });
  it('does not overwrite an existing output or follow its symlink', async () => {
    const dir = fixture();
    const target = join(dir, 'existing'); writeFileSync(target, 'preserve'); symlinkSync(target, join(dir, 'frame'));
    await expect(captureFrames(parseCaptureArgs(['--out', dir, '--name', 'frame']), {
      tmux: () => 'TIMMY 1 HOME', sleep: async () => {}, now: () => 0,
    })).rejects.toThrow();
    expect(readFileSync(target, 'utf8')).toBe('preserve');
  });
  it.each([999, 1000, 1001])('requires readiness observed before the 1000ms deadline: %ims', async observedAt => {
    let t = 0; const out = fixture(); const calls: string[][] = [];
    const result = captureFrames(parseCaptureArgs(['--out', out, '--name', 'frame', '--wait', '1000']), {
      tmux: args => { calls.push(args); return 'TIMMY 1 HOME'; },
      sleep: async () => { t = observedAt; }, now: () => t,
    });
    if (observedAt < 1000) {
      await expect(result).resolves.toMatchObject({ file: join(out, 'frame') });
      expect(readFileSync(join(out, 'frame'), 'utf8')).toBe('TIMMY 1 HOME');
    } else {
      await expect(result).rejects.toThrow('did not assemble');
      expect(existsSync(join(out, 'frame'))).toBe(false);
    }
    expect(calls.at(-1)?.[0]).toBe('kill-session');
  });
  it('rejects a ready capture that returns after the deadline despite starting before it', async () => {
    let t = 0; const out = fixture(); const calls: string[][] = [];
    await expect(captureFrames(parseCaptureArgs(['--out', out, '--name', 'frame', '--wait', '1000']), {
      tmux: args => { calls.push(args); if (args[0] === 'capture-pane') t = 1001; return 'TIMMY 1 HOME'; },
      sleep: async () => { t = 500; }, now: () => t,
    })).rejects.toThrow('did not assemble');
    expect(calls.at(-1)?.[0]).toBe('kill-session');
    expect(existsSync(join(out, 'frame'))).toBe(false);
  });
});
