// The installed command's bin (timmy.ts) starts the CLI as a child process. A signal sent to `timmy`
// itself must reach that child. Before this, the bin waited in spawnSync: a SIGTERM ended the bin at
// once and left the REPL it had started running, orphaned, still holding the terminal.
import { describe, it, expect } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const childrenOf = (pid: number): number[] => {
  try { return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number); } catch { return []; }
};

/** `timmy <args>` from source, with a home and store of its own and no model key. */
function startBin(args: string[]) {
  const box = mkdtempSync(join(tmpdir(), 'timmy-bin-'));
  const bin = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'timmy.ts'), ...args], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: box, TIMMY_HOME: join(box, 'timmy'), TIMMY_STORE: join(box, 'store'), OPENROUTER_API_KEY: '' },
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => bin.on('exit', (code, signal) => resolve({ code, signal })));
  return { bin, exit };
}

async function firstChild(pid: number, ms = 20_000): Promise<number> {
  for (const end = Date.now() + ms; ; await sleep(50)) {
    const kids = childrenOf(pid);
    if (kids.length > 0) return kids[0];
    if (Date.now() > end) throw new Error('the bin started no child');
  }
}

describe('the bin passes signals on to the command it started', { timeout: 60_000 }, () => {
  for (const [sig, status] of [['SIGTERM', 143], ['SIGHUP', 129]] as const) {
    it(`${sig} to \`timmy\` ends the REPL it started, which exits ${status}, and nothing is left running`, async () => {
      const { bin, exit } = startBin(['repl', '--demo-loader']);
      const child = await firstChild(bin.pid!);
      await sleep(1500); // the REPL is in its 10-second loader
      bin.kill(sig);
      const r = await exit;
      for (let i = 0; i < 40 && alive(child); i++) await sleep(50);
      const left = alive(child);
      if (left) process.kill(child, 'SIGKILL');
      expect(left).toBe(false);
      // reported as a shell reports a command ended by a signal: 128 plus its number
      expect(r).toEqual({ code: status, signal: null });
    });
  }
});
