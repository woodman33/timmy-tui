// v1.0.5-keyboard-arch — focus stack contract: Enter at NAV claims
// input:command; printable chars (incl. nav keys) never hijack; Esc pops to
// NAV (visible in the footer MODE indicator); 1-4 then switch views; Enter
// re-claims INPUT. Red under the old boolean mechanism.
// Load-tolerant (tui-redesign corr 1): drives wait on frame predicates, not
// fixed sleeps, so CPU contention can't flip the contract.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from '../src/tui/app.js';

process.env.TIMMY_TELEMETRY_URL = 'off';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(view: ReturnType<typeof render>, pred: (f: string) => boolean, ms = 15000): Promise<string> {
  const t0 = Date.now();
  for (;;) {
    const f = view.lastFrame() ?? '';
    if (pred(f)) return f;
    if (Date.now() - t0 > ms) return f;
    await sleep(50);
  }
}

describe('input sovereignty via focus stack (View [1] chat)', { timeout: 60000 }, () => {
  beforeAll(() => { process.env.TIMMY_SHELL = 'v1'; });
  afterAll(() => { delete process.env.TIMMY_SHELL; });
  it('Enter claims INPUT; nav-laden typing never hijacks; Esc pops to NAV', async () => {
    const view = render(React.createElement(App, { config: { onboarded: true } as never }));
    let f = await until(view, x => x.includes('MODE:NAV'));
    expect(f).toContain('MODE:NAV');

    view.stdin.write('\r');                    // Enter at NAV → input:command
    f = await until(view, x => x.includes('MODE:INPUT:COMMAND'));
    expect(f).toContain('MODE:INPUT:COMMAND');

    view.stdin.write('g1q? 1234 hello — v1.0.5');
    f = await until(view, x => x.includes('hello — v1.0.5'));
    expect(f).toContain('hello — v1.0.5');    // buffer intact
    expect(f).not.toContain('SLATE DAG');     // no hijack

    view.stdin.write('\x1b');                  // Esc → pop to NAV
    f = await until(view, x => x.includes('MODE:NAV'));
    expect(f).toContain('MODE:NAV');

    view.stdin.write('2');
    f = await until(view, x => x.includes('SLATE DAG'));
    expect(f).toContain('SLATE DAG');         // nav key works at NAV

    view.stdin.write('1');
    await until(view, x => x.includes('MODE:NAV'));
    view.stdin.write('\r');
    f = await until(view, x => x.includes('MODE:INPUT:COMMAND'));
    expect(f).toContain('MODE:INPUT:COMMAND'); // Enter re-claims INPUT

    view.unmount();
  }, 60000);
});
