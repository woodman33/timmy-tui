// v1.0.5-fix INPUT SOVEREIGNTY — red before the fix: typing "g1q? 1234
// hello — v1.0.5" in View [1] double-dispatched into root navigation ('q'
// quit, '1'/'2' switched views). After the fix the chat holds the keyboard
// lock; Esc blurs to NAV where 1-4/Tab/^K/q/? work.
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from '../src/tui/app.js';

process.env.TIMMY_TELEMETRY_URL = 'off';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('input sovereignty (View [1] chat)', () => {
  it('typing nav-key-laden text never hijacks; Esc then 2 switches view', async () => {
    const view = render(React.createElement(App, { config: { onboarded: true } as never }));
    await sleep(400);

    view.stdin.write('g1q? 1234 hello — v1.0.5');
    await sleep(400);
    const f1 = view.lastFrame() ?? '';
    expect(f1).toContain('hello — v1.0.5');   // buffer intact, chars not eaten
    expect(f1).toContain('[1 COM]');          // still on COMMAND (active tab, compact form at 80 cols)
    expect(f1).not.toContain('SLATE DAG');    // no hijack to MISSION

    view.stdin.write('\x1b');                  // Esc → NAV mode
    await sleep(250);
    view.stdin.write('2');                     // root nav now live
    await sleep(400);
    const f2 = view.lastFrame() ?? '';
    expect(f2).toContain('SLATE DAG');        // switched to MISSION

    view.unmount();
  }, 20000);
});
