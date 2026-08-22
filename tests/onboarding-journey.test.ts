// v1.0.5-fix onboarding journey: splash → setup steps → teach-by-doing
// gates (wrong keys swallowed) → populated View [1] empty state.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { App } from '../src/tui/app.js';

process.env.TIMMY_TELEMETRY_URL = 'off';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// cold profile: empty chat history + scratch .timmy so View [1] is truly cold
let scratch = '';
let home = '';
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'timmy-onboard-'));
  home = process.cwd();
  process.chdir(scratch);
});
afterAll(() => {
  process.chdir(home);
  rmSync(scratch, { recursive: true, force: true });
});

describe('onboarding journey', () => {
  it('first-run gate triggers splash; teach gates reject wrong keys; ends in View [1]', async () => {
    const view = render(React.createElement(App, { config: {} as never })); // onboarded unset
    await sleep(400);

    let f = view.lastFrame() ?? '';
    expect(f).toContain('Flight Recorder for AI Agent Runs'); // splash
    expect(f).toContain('[Enter] Begin setup');

    view.stdin.write('x');                    // splash ignores stray keys
    await sleep(200);
    f = view.lastFrame() ?? '';
    expect(f).toContain('[Enter] Begin setup');

    view.stdin.write('\r');                   // begin setup
    await sleep(250);
    f = view.lastFrame() ?? '';
    expect(f).toContain('PICK A BRAIN');

    view.stdin.write('o');                    // ollama-only branch
    await sleep(200);
    view.stdin.write('l');                    // local-only cloud sync
    await sleep(200);
    f = view.lastFrame() ?? '';
    expect(f).toContain('LOG ORGANIZATION');
    view.stdin.write('1');
    await sleep(150);
    view.stdin.write('\r');
    await sleep(150);
    view.stdin.write('d');
    await sleep(150);
    view.stdin.write('\r');                   // → teachMission
    await sleep(250);
    f = view.lastFrame() ?? '';
    expect(f).toContain('TEACH 1/3');

    view.stdin.write('x');                    // wrong key swallowed
    await sleep(200);
    f = view.lastFrame() ?? '';
    expect(f).toContain('not that one');
    expect(f).toContain('TEACH 1/3');

    view.stdin.write('2');                    // real '2' advances
    await sleep(200);
    f = view.lastFrame() ?? '';
    expect(f).toContain('TEACH 2/3');

    view.stdin.write('\x0b');                 // ctrl+k advances
    await sleep(200);
    f = view.lastFrame() ?? '';
    expect(f).toContain('TEACH 3/3');

    view.stdin.write('1');                    // finish → View [1]
    await sleep(400);
    f = view.lastFrame() ?? '';
    expect(f).toContain('cold start');       // empty-state wayfinding card
    expect(f).toContain('[2] MISSION');

    view.unmount();
  }, 30000);
});
