// R9 lead (item B, R7's "unexplained pty-keyboard failure"): ShellV2's first frame must not wait on a folder listing.
//
// R9's qualification of 1fa4020 saw tests/keyboard-contract.pty.test.ts fail 2 of 2: a blank screen for 8 s, the
// fixture's render() never returning (its milestones stop at before-render). ShellV2's first render read the LIBRARY ›
// BOARDS PROJECTS line itself: readdirSync of the folder above the current one, then existsSync(<entry>/.timmy) for every
// entry, synchronously and with no bound. The fixture runs in /tmp/timmy-kb-…, and that machine's /tmp held 33,553
// entries. This test records every synchronous listing and existence check ShellV2 makes from the moment it is rendered
// until its first screen is drawn: none may be of the folder above the current one or of an entry in it. On 1fa4020's
// ShellV2 it fails (the folder above is listed and each entry checked); the line itself must still name the siblings once
// they are read (asynchronously, src/tui/sibling-projects.ts).
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const seen = vi.hoisted(() => ({ on: false, listed: [] as string[], checked: [] as string[] }));
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const listed = ((p: unknown, ...rest: unknown[]) => {
    if (seen.on) seen.listed.push(String(p));
    return (real.readdirSync as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof real.readdirSync;
  const checked = ((p: unknown) => {
    if (seen.on) seen.checked.push(String(p));
    return real.existsSync(p as string);
  }) as typeof real.existsSync;
  return { ...real, readdirSync: listed, existsSync: checked };
});

import { ShellV2 } from '../src/tui/components/ShellV2.js';

process.env.TIMMY_TELEMETRY_URL = 'off';
// the LIBRARY tab's panes need the 120x40 reference grid to show BOARDS (as tests/library-pane.test.tsx)
Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(view: ReturnType<typeof render>, pred: (f: string) => boolean, ms = 20000): Promise<string> {
  const t0 = Date.now();
  for (;;) {
    const f = view.lastFrame() ?? '';
    if (pred(f) || Date.now() - t0 > ms) return f;
    await sleep(50);
  }
}

let parent = '';
afterEach(() => {
  seen.on = false;
  vi.restoreAllMocks();
  if (parent) rmSync(parent, { recursive: true, force: true });
  parent = '';
});

describe('ShellV2: the first screen waits on no folder listing (R9 lead, item B)', { timeout: 60000 }, () => {
  it('lists no folder above the current one and checks none of its entries until the first screen is drawn; LIBRARY › BOARDS names the siblings once read', async () => {
    parent = mkdtempSync(join(tmpdir(), 'timmy-first-frame-'));
    for (const d of ['alpha', 'beta', 'gamma', 'here']) mkdirSync(join(parent, d));
    mkdirSync(join(parent, 'alpha', '.timmy'));
    mkdirSync(join(parent, 'gamma', '.timmy'));
    const here = join(parent, 'here');
    vi.spyOn(process, 'cwd').mockReturnValue(here);

    seen.listed.length = 0;
    seen.checked.length = 0;
    seen.on = true;
    const view = render(React.createElement(ShellV2, { width: 120 }));
    const first = await until(view, (x) => x.includes('YOUR JOURNEY'));
    seen.on = false;
    expect(first, 'the first screen').toContain('YOUR JOURNEY');

    const above = seen.listed.filter((p) => p === parent);
    const siblings = seen.checked.filter((p) => p.startsWith(`${parent}/`) && !p.startsWith(`${here}/`) && p !== here);
    expect(above, 'listed synchronously before the first screen: the folder above the current one').toEqual([]);
    expect(siblings, 'checked synchronously before the first screen: entries of the folder above').toEqual([]);

    view.stdin.write('4');
    const library = await until(view, (x) => x.includes('PROJECTS  alpha · gamma'));
    expect(library).toContain('◇ BOARDS');
    expect(library).toContain('PROJECTS  alpha · gamma');
    view.unmount();
  });
});
