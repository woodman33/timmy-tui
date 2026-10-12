// v1.0.5-fix onboarding journey: splash → setup steps → teach-by-doing
// gates (wrong keys swallowed) → populated View [1] empty state.
// R4 (H98): the setup steps are Timmy's one guided setup (src/setup), the questions `timmy init` asks, only those without
// an answer: here a home an older `timmy init` set up (identity, providers, project; no setup.json), so the chat model, the
// local model preselected (logs stay on this computer: nothing to ask). The answers go to the Timmy home (this file's own
// temporary one, tests/isolation-setup.ts); the legacy v1 shell then teaches its keys.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { App } from '../src/tui/app.js';
import { applyInit } from '../src/utils/init.js';

process.env.TIMMY_TELEMETRY_URL = 'off';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// cold profile: empty chat history + scratch cwd so View [1] is truly cold.
// Safe under parallelism now that store resolution honors per-test TIMMY_STORE
// (isolation-setup) and no longer depends on process.cwd (tui-redesign corr 1).
let scratch = '';
let home = '';
const kept = { xdg: process.env.XDG_CONFIG_HOME, repo: process.env.TIMMY_REPO_ROOT };
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'timmy-onboard-'));
  home = process.cwd();
  process.chdir(scratch);
  // the setup reads the monitor's settings file for a key saved there: an empty folder of this test's, never the account's
  process.env.XDG_CONFIG_HOME = join(scratch, 'config');
  process.env.TIMMY_REPO_ROOT = scratch;
  applyInit({ operator: 'Sample', project: 'demo' }, scratch);
  rmSync(join(process.env.TIMMY_HOME!, 'setup.json'));
});
afterAll(() => {
  process.chdir(home);
  rmSync(scratch, { recursive: true, force: true });
  if (kept.xdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = kept.xdg;
  if (kept.repo === undefined) delete process.env.TIMMY_REPO_ROOT; else process.env.TIMMY_REPO_ROOT = kept.repo;
});

describe('onboarding journey', { timeout: 60000 }, () => {
  // CUTOVER: legacy nine-view shell lives behind TIMMY_SHELL=v1 for one
  // release; pinned inside the lifecycle so it cannot leak across test files
  beforeAll(() => { process.env.TIMMY_SHELL = 'v1'; });
  afterAll(() => { delete process.env.TIMMY_SHELL; });
  it('first-run gate triggers splash; asks only the unanswered questions; teach gates reject wrong keys; ends in View [1]', async () => {
    const view = render(React.createElement(App, { config: {} as never })); // onboarded unset
    await sleep(400);

    let f = view.lastFrame() ?? '';
    expect(f).toContain('Flight Recorder for AI Agent Runs'); // splash
    expect(f).toContain('[Enter] Begin setup');
    expect(f).toContain('One setup question has no answer yet: Chat model.');
    expect(f).toContain('[Enter] Begin setup · [Esc] Quit · Ctrl+C quits');

    view.stdin.write('q');                    // q never quits the monitor: the splash stays
    await sleep(200);
    expect(view.lastFrame() ?? '').toContain('[Enter] Begin setup');

    view.stdin.write('x');                    // splash ignores stray keys
    await sleep(200);
    f = view.lastFrame() ?? '';
    expect(f).toContain('[Enter] Begin setup');

    view.stdin.write('\r');                   // begin setup
    await sleep(250);
    f = view.lastFrame() ?? '';
    expect(f).toContain('Chat model');
    expect(f).toContain('▸ [l] local model only');   // the local model preselected
    expect(f).toContain('◇ [o] OpenRouter: a paid cloud service');

    view.stdin.write('o');                    // a choice's key selects it…
    await sleep(150);
    expect(view.lastFrame() ?? '').toContain('▸ [o] OpenRouter: a paid cloud service');
    view.stdin.write('l');                    // …and another key selects another; Enter goes on
    await sleep(150);
    view.stdin.write('\r');
    await sleep(250);
    f = view.lastFrame() ?? '';
    expect(f).not.toContain('Logs and run events');
    expect(f).toContain('Save these answers?');
    view.stdin.write('\r');                   // save → teachMission
    await sleep(300);
    f = view.lastFrame() ?? '';
    expect(f).toContain('TEACH 1/3');
    const rec = JSON.parse(readFileSync(join(process.env.TIMMY_HOME!, 'setup.json'), 'utf8'));
    expect({ by: rec.by, chat: rec.answers.chat, logs: rec.answers.logs }).toEqual({ by: 'the monitor', chat: 'local', logs: undefined });

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
    expect(f).toContain('no conversation yet');       // empty-state wayfinding card
    expect(f).toContain('▸ 2 spawn a lane');

    view.unmount();
  }, 120000); // App mount blocks on the startup health probe in cold networks
});
