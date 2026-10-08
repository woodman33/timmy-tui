import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Fourth order, step 4: the terminal and zellij themes ship in the npm package. `timmy theme install`
// copies them from assets/themes at the package's root, and `timmy center` hands zellij its theme
// folder from there; while `files` left them out, an installed Timmy had neither. The list is npm's
// own (`npm pack --dry-run`, the build skipped), compared with the themes the repo tracks.
const root = fileURLToPath(new URL('..', import.meta.url));
const run = (cmd: string, args: string[]): string => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', timeout: 60_000 });

describe('the npm package', () => {
  it('carries every terminal theme the repo has in assets/themes', () => {
    const tracked = run('git', ['ls-files', '-z', '--', 'assets/themes']).split('\0').filter(Boolean).sort();
    expect(tracked.length).toBeGreaterThanOrEqual(11);
    const [pack] = JSON.parse(run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'])) as Array<{ files: Array<{ path: string }> }>;
    expect(pack.files.map((f) => f.path).filter((p) => p.startsWith('assets/themes/')).sort()).toEqual(tracked);
  });
});
