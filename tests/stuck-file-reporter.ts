// Names the test files that keep running (R4 H31), next to vitest's default reporter.
//
// A worker blocked in a synchronous call (spawnSync, execSync, execFileSync) that never returns cannot run vitest's
// test timeout, so the run waits forever: CI run 38000946368 sat 6 hours in its vitest step and its log simply stopped.
// This reporter lives in the main process, which stays responsive. Once a file has run longer than
// TIMMY_TEST_STUCK_MS (default 5 min), it prints the file, the last test it reported starting, and the processes
// under vitest (long tokens masked), then repeats each minute. It reports only: CI's step timeout ends the run.
import { execFileSync } from 'node:child_process';
import { relative } from 'node:path';
import type { Reporter, TestCase, TestModule, Vitest } from 'vitest/node';

const AFTER_MS = Number(process.env.TIMMY_TEST_STUCK_MS) || 5 * 60_000;
const EVERY_MS = Math.min(60_000, AFTER_MS);

interface Row { pid: number; ppid: number; elapsed: string; command: string }

export default class StuckFileReporter implements Reporter {
  private vitest?: Vitest;
  private readonly running = new Map<string, { since: number; test?: string }>();
  private timer?: NodeJS.Timeout;

  onInit(vitest: Vitest): void {
    this.vitest = vitest;
  }

  onTestRunStart(): void {
    this.running.clear();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.check(), EVERY_MS);
    this.timer.unref();
  }

  onTestModuleQueued(testModule: TestModule): void {
    this.running.set(testModule.moduleId, { since: Date.now() });
  }

  onTestCaseReady(testCase: TestCase): void {
    const entry = this.running.get(testCase.module.moduleId);
    if (entry) entry.test = testCase.fullName;
  }

  onTestModuleEnd(testModule: TestModule): void {
    this.running.delete(testModule.moduleId);
  }

  onTestRunEnd(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.running.clear();
  }

  private check(): void {
    const now = Date.now();
    const stuck = [...this.running].filter(([, entry]) => now - entry.since >= AFTER_MS);
    if (!stuck.length) return;
    const root = this.vitest?.config.root ?? process.cwd();
    const lines = [
      `STILL RUNNING after ${Math.round(AFTER_MS / 1000)} s. A file that stops reporting is often blocked in a synchronous call, which vitest's test timeout cannot stop:`,
      ...stuck.map(([id, entry]) => `  ${relative(root, id)}: ${Math.round((now - entry.since) / 1000)} s; last test reported starting: ${entry.test ?? '(none)'}`),
      ...this.processes(),
    ];
    if (this.vitest) this.vitest.logger.log(lines.join('\n'));
    else console.log(lines.join('\n'));
  }

  /** The processes under this vitest process (workers and what they started), with pid and elapsed time. */
  private processes(): string[] {
    try {
      const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,etime=,args='], { encoding: 'utf8', timeout: 5000 });
      const rows: Row[] = [];
      for (const line of out.split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
        if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), elapsed: m[3], command: m[4] });
      }
      const lines: string[] = [];
      const walk = (pid: number, depth: number): void => {
        for (const row of rows.filter((r) => r.ppid === pid && !r.command.startsWith('ps -A -o '))) {
          const command = row.command.replace(/[A-Za-z0-9_-]{32,}/g, '<masked>').slice(0, 160);
          lines.push(`${'  '.repeat(depth)}${row.pid} ${row.elapsed} ${command}`);
          if (depth < 6) walk(row.pid, depth + 1);
        }
      };
      walk(process.pid, 2);
      return lines.length ? ['  processes under vitest (pid, elapsed, command):', ...lines] : [];
    } catch {
      return [];
    }
  }
}
