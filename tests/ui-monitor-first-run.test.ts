import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { visibleWidth } from '../src/term/width.js';
import { printBlankSlateBanner } from '../src/utils/init.js';

// C-14: on a blank home the first thing shown is the first-run banner, and it fits 60 columns (it ran to
// 95). The monitor cannot run before `timmy init`, so it ends with 78 (needs setup), not 0 (success).
describe('first run', () => {
  it('the banner fits 60 columns', () => {
    const lines: string[] = [];
    printBlankSlateBanner((s) => lines.push(...s.split('\n')));
    expect(lines.join('\n')).toContain('timmy init');
    expect(lines.filter((l) => visibleWidth(l) > 60)).toEqual([]);
  });
  // R4 lead: GitHub's runner checks out to ~/work/timmy-tui/timmy-tui, which made the store pin's line 66 columns wide
  it('the banner fits 60 columns with a workspace deep in the home folder (as GitHub\'s runner has it)', () => {
    const kept = { HOME: process.env.HOME, TIMMY_REPO_ROOT: process.env.TIMMY_REPO_ROOT, TIMMY_HOME: process.env.TIMMY_HOME };
    const home = mkdtempSync('/tmp/tf-');
    try {
      process.env.HOME = home;
      process.env.TIMMY_HOME = join(home, 'timmy');
      process.env.TIMMY_REPO_ROOT = join(home, 'work', 'timmy-tui', 'timmy-tui');
      const lines: string[] = [];
      printBlankSlateBanner((s) => lines.push(...s.split('\n')));
      expect(lines.filter((l) => visibleWidth(l) > 60)).toEqual([]);
      // the path whole on its line, the words after it on the next
      expect(lines).toContain('    ~/work/timmy-tui/timmy-tui/.timmy/store-pin');
      expect(lines).toContain('      (the receipts store)');
    } finally {
      for (const [k, v] of Object.entries(kept)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      rmSync(home, { recursive: true, force: true });
    }
  });
  it('on a blank home the monitor shows the banner and exits 78 (needs setup)', () => {
    const home = mkdtempSync('/tmp/tf-');
    try {
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, TIMMY_HOME: join(home, 'timmy'), TIMMY_REPO_ROOT: home, TIMMY_STORE: join(home, 'store') };
      delete env.CI;
      delete env.TIMMY_SKIP_INIT;
      const loader = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
      const r = spawnSync(process.execPath, ['--import', loader, resolve('cli.tsx'), '--no-companion'], { cwd: home, env, encoding: 'utf8', timeout: 60_000 });
      expect({ status: r.status, init: r.stdout.includes('timmy init') }).toEqual({ status: 78, init: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 90_000);
});
