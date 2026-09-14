// ui-v3-t9r2 C0 audit (Will, 2026-09-14): the shipped bin forwarded a verb WHITELIST to
// src/cli.ts, so `timmy cockpit|privacy|engine|clip|status|swarm` never reached the installed
// command. The bin now forwards every verb it does not answer itself. This test enumerates the
// verbs src/cli.ts dispatches — from the source, not from a list kept here — and asserts each
// one reaches the CLI through the bin, so a verb added to the CLI is covered the moment it
// exists and a new bin-native collision fails here until it is named in BIN_NATIVE.
import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = join(ROOT, 'timmy.ts');
const run = promisify(execFile);

/** Every verb src/cli.ts dispatches: `command === 'x'` and `['a', 'b'].includes(command)`. */
export function cliVerbs(source: string = readFileSync(join(ROOT, 'src', 'cli.ts'), 'utf8')): string[] {
  const verbs = new Set<string>();
  for (const m of source.matchAll(/command === '([a-z][a-z0-9-]*)'/g)) verbs.add(m[1]);
  for (const m of source.matchAll(/\[((?:'[a-z][a-z0-9-]*'\s*,?\s*)+)\]\.includes\(command\)/g)) {
    for (const v of m[1].matchAll(/'([a-z][a-z0-9-]*)'/g)) verbs.add(v[1]);
  }
  return [...verbs].sort();
}

/** The verbs the bin answers itself (see the header of timmy.ts). Everything else must forward. */
const BIN_NATIVE = ['demo', 'version'];

/** The bin's routing decision for argv, without booting or spawning (TIMMY_BIN_DRY_RUN=1). */
async function route(argv: string[]): Promise<Record<string, unknown>> {
  const { stdout } = await run(process.execPath, ['--import', 'tsx', BIN, ...argv], {
    cwd: ROOT,
    env: { ...process.env, TIMMY_BIN_DRY_RUN: '1' },
    timeout: 30_000,
  });
  const last = stdout.trim().split('\n').pop() ?? '{}';
  return JSON.parse(last) as Record<string, unknown>;
}

/** Map with bounded concurrency — one tsx boot per verb. */
async function mapPool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

describe('the shipped bin forwards every verb', { timeout: 180_000 }, () => {
  it('enumerates the verbs src/cli.ts dispatches', () => {
    const verbs = cliVerbs();
    expect(verbs.length).toBeGreaterThan(40);
    // the audit's unreachable verbs that exist on this tree
    for (const v of ['privacy', 'engine', 'clip', 'status', 'swarm']) expect(verbs).toContain(v);
    // the enumerator reads both dispatch shapes
    expect(cliVerbs("if (command === 'one') {} if (['two', 'three'].includes(command)) {}")).toEqual(['one', 'three', 'two']);
  });

  it('every CLI verb reaches src/cli.ts through the bin, argv untouched (bin-native verbs excepted)', async () => {
    const verbs = cliVerbs().filter(v => !BIN_NATIVE.includes(v));
    const decisions = await mapPool(verbs, 8, async v => [v, await route([v, '--probe', 'x'])] as const);
    const wrong = decisions.filter(([v, d]) => d.forward !== 'src/cli' || JSON.stringify(d.argv) !== JSON.stringify([v, '--probe', 'x']));
    expect(wrong.map(([v, d]) => `${v}: ${JSON.stringify(d)}`)).toEqual([]);
  });

  it('the bin-native verbs are exactly the named ones', async () => {
    for (const v of BIN_NATIVE) expect((await route([v])).native).toBe(v);
    // a verb the CLI knows that the bin answers itself is a collision: it must be named above
    const collisions = cliVerbs().filter(v => BIN_NATIVE.includes(v));
    expect(collisions).toEqual(BIN_NATIVE.filter(v => cliVerbs().includes(v)));
  });

  it('help and flags forward too; bare `timmy` boots the Command Post', async () => {
    expect((await route(['help'])).forward).toBe('src/cli');
    expect((await route(['--help'])).forward).toBe('src/cli');
    expect((await route(['cockpit', 'up', '--json'])).argv).toEqual(['cockpit', 'up', '--json']);
    expect((await route([])).native).toBe('boot');
    expect((await route(['--version'])).native).toBe('version');
  });

  it('a real forward: `timmy help` prints the CLI usage', async () => {
    const { stdout } = await run(process.execPath, ['--import', 'tsx', BIN, 'help'], { cwd: ROOT, timeout: 60_000 });
    expect(stdout).toContain('Usage: timmy <command>');
  });
});
