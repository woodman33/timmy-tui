// Capture an assembled Timmy PTY frame through tmux. Captured text can contain
// private content: keep --out private, and never treat its hash as verification.
// Example: tsx scripts/capture-frames.ts --name hands-80 --width 80 --height 24
//          --keys 6,h,Right,Enter --out .timmy/private/captures
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

type CaptureOptions = { out: string; name: string; width: number; height: number; wait: number; keys: string[]; env: string[] };
type CaptureIO = { tmux: (args: string[]) => string; sleep: (ms: number) => Promise<unknown>; now: () => number };
const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

export function parseCaptureArgs(argv: string[]): CaptureOptions {
  const values: Record<string, string> = { out: '.timmy/private/captures', width: '120', height: '40', wait: '30000', keys: '' };
  const env: string[] = [];
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]; const value = argv[i + 1];
    if (!['--out', '--name', '--width', '--height', '--wait', '--keys', '--env'].includes(flag) || value === undefined || value.startsWith('--') || value.includes('\0')) throw new Error('invalid capture argument');
    if (flag === '--env') {
      if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) throw new Error('invalid environment assignment');
      env.push(value);
    } else values[flag.slice(2)] = value;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(values.name ?? '') || !values.out) throw new Error('a safe --name stem and output directory are required');
  const width = Number(values.width), height = Number(values.height), wait = Number(values.wait);
  if (![width, height, wait].every(Number.isSafeInteger) || width < 20 || width > 1000 || height < 5 || height > 500 || wait < 1 || wait > 300000) throw new Error('capture dimensions or wait out of range');
  return { out: values.out, name: values.name, width, height, wait, env, keys: values.keys.split(',').map(k => k.trim()).filter(Boolean) };
}

export async function captureFrames(options: CaptureOptions, io: CaptureIO = {
  tmux: args => execFileSync('tmux', args, { encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }),
  sleep, now: Date.now,
}) {
  const { out, name, width, height, wait, keys, env } = options;
  const session = `timmy-capture-${randomUUID()}`;
  // tmux interprets its single command through a shell. Quote every token,
  // including caller-provided environment values; never use JSON as quoting.
  const command = ['env', 'TIMMY_TELEMETRY_URL=off', 'TIMMY_SHELL=v2', ...env, process.execPath, '--import', 'tsx', 'timmy.ts'].map(shellQuote).join(' ');
  let frame: string;
  try {
    io.tmux(['new-session', '-d', '-s', session, '-x', String(width), '-y', String(height), '-c', process.cwd(), command]);
    const started = io.now();
    for (;;) {
      await io.sleep(500);
      const candidate = io.tmux(['capture-pane', '-p', '-t', `=${session}`]);
      if (io.now() - started >= wait) throw new Error('capture shell did not assemble before timeout');
      if (/TIMMY\s+1 /.test(candidate) && !/assembling/.test(candidate)) break;
    }
    await io.sleep(1200);
    for (const key of keys) {
      io.tmux(['send-keys', '-t', `=${session}`, ...(key.startsWith('text:') ? ['-l', '--', key.slice(5)] : ['--', key])]);
      await io.sleep(600);
    }
    await io.sleep(800);
    frame = io.tmux(['capture-pane', '-p', '-t', `=${session}`]);
  } finally {
    // Never kill a preexisting session derived from a user-provided name.
    try { io.tmux(['kill-session', '-t', `=${session}`]); } catch { /* already gone or creation failed */ }
  }
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const file = join(out, name);
  writeFileSync(file, frame, { flag: 'wx', mode: 0o600 });
  const lines = frame.split('\n');
  return { file, width, height, keys, lines: lines.length, widest: Math.max(...lines.map(line => [...line].length)), sha256: createHash('sha256').update(frame).digest('hex') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await captureFrames(parseCaptureArgs(process.argv.slice(2))))); }
  catch { console.error('capture-frames: invalid arguments, unavailable session, timeout, or output collision; no successful capture reported'); process.exitCode = 1; }
}
