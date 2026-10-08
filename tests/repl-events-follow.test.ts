import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// `timmy events --follow` must keep following. It used to print its first dump, fall through to the
// unknown-command check, print the help and exit 2 (found by the cockpit's Events tab, plan C-12).
describe('timmy events --follow', () => {
  it('is still following after 3 seconds, and never prints the help', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'events', '--follow', '--human'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    let exited: number | null = null;
    child.on('exit', (code) => (exited = code ?? -1));
    await new Promise((r) => setTimeout(r, 3000));
    const stillRunning = exited === null;
    child.kill('SIGTERM');
    expect(stillRunning).toBe(true);
    expect(out).not.toContain('The inline REPL');
  });
});
