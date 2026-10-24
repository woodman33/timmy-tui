// R6 (H141): the cause of CI's workbench-pty slice B failure (at 3b6a5b6, 388c0c8, 9ca1a65 and f68367c, as at bfb7fe5,
// 94e0c01, 0cbadd0 and aa247e5): "Remember layout" wrote a layout change 1.5 s after it was made, under the project shown
// when its timer fired. Slice A expands Activity on tray1 (a), collapses it (a) and, within 1.5 s, picks demo in the picker:
// when the save made between its two a's (another change's timer) had written tray1 as expanded, the save of the collapse
// fired after the switch and was written for demo. tray1 came back expanded in slice B's Workbench, so slice B's one a
// collapsed Activity ("after r: still collapsed; after a: Activity is open"). The key log of a local run (TIMMY_WORKBENCH_KEYLOG)
// showed the timing: tray1's last save 86 ms before the switch, the collapse 1.40 s before it.
//
// Here the same steps with the timing made certain: a change, a save while Activity is expanded, the collapse, and a project
// switch within 1.5 s of it. Over a real Timmy home and settings folder in a temporary folder; the REPL's own Workspace for
// /project. FAKE or FIXTURE, each labelled: the browser opener, the server starts and the producers.
import React from 'react';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { createProject, projectId, saveActiveProject } from '../src/project/index.js';
import type { ApprovalRequest, Decision } from '../src/repl/approvals.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import { WorkbenchApp } from '../src/workbench/app.js';
import { Controller } from '../src/workbench/controller.js';
import { glyphsFor } from '../src/workbench/frame.js';
import type { Producers } from '../src/workbench/producers.js';
import { settingsPath } from '../src/workbench/settings.js';
import { CompanionControl, StudioControl, type Opener } from '../src/workbench/servers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FAKE_OPENER: Opener = { program: null, open: () => ({ ok: false, why: 'FAKE opener: nothing is opened in this test' }) };
// FIXTURE producers: no run detail and no chat session are needed here
const NO_PRODUCERS: Producers = { runDetail: async () => ({ ok: false, why: 'FIXTURE: none in this test' }), openChat: async () => ({ ok: false, why: 'FIXTURE: none in this test' }) };

let box = '';
const opened: Controller[] = [];
const spaces: Workspace[] = [];

beforeAll(() => { box = mkdtempSync(join(tmpdir(), 'wb-layout-')); });
afterAll(() => { rmSync(box, { recursive: true, force: true }); });
afterEach(async () => {
  cleanup();
  for (const c of opened.splice(0)) c.dispose();
  for (const ws of spaces.splice(0)) await ws.close({ by: 'as the test ended' });
  vi.unstubAllEnvs();
});

function sandbox(name: string): void {
  const dir = join(box, name);
  mkdirSync(dir, { recursive: true });
  vi.stubEnv('TIMMY_HOME', join(dir, 'timmy'));
  vi.stubEnv('TIMMY_SETTINGS_DIR', join(dir, 'settings'));
  vi.stubEnv('TIMMY_STORE', join(dir, 'store'));
  vi.stubEnv('OPENROUTER_API_KEY', '');
}

function project(name: string): { name: string; root: string; chosen: boolean } {
  const made = createProject(name);
  if ('error' in made) throw new Error(made.error);
  return made;
}

/** A Workbench's controller on `p` (as `timmy workbench` makes it: the REPL's own Workspace), its key log kept in `keys`. */
function workbench(p: { name: string; root: string; chosen: boolean }, keys: Array<Record<string, unknown>>): Controller {
  let c: Controller | undefined;
  const env = { ...process.env };
  const onPath = () => null;
  const jobsDir = join(process.env.TIMMY_HOME!, 'jobs');
  const ws = new Workspace({
    glyphs: glyphSet(true), env, onPath, notify: (l) => c?.say(l.map((s) => s.text).join('').trim()), openWeb: () => '', link: (t) => t,
    seal: () => null, jobsDir, recoverAtStart: false, chdir: () => undefined,
    askPerson: (req: ApprovalRequest): Promise<Decision> => (c ? c.askPerson(req) : Promise.resolve('deny')),
  }, p);
  spaces.push(ws);
  c = new Controller({
    env, jobsDir, onPath, glyphs: glyphsFor(true), workspace: ws, producers: NO_PRODUCERS,
    companion: new CompanionControl({ opener: FAKE_OPENER, start: async () => { throw new Error('FAKE: no server is started in this test'); } }),
    studio: new StudioControl({ env, opener: FAKE_OPENER, project: () => ws.project, projectId, jobsDir, receipts: () => join(box, 'store'), ensure: async () => ({ state: 'failed', error: 'FAKE: no Studio in this test' }) }),
    capabilities: async () => [],
    keyLog: (entry) => { keys.push({ ms: Date.now(), ...entry }); },
  });
  opened.push(c);
  return c;
}

/** The layouts the settings file holds now, by project name. */
function layouts(...ps: Array<{ name: string; root: string }>): Record<string, { workspace: string; tab: string; activity: boolean } | undefined> {
  const saved = JSON.parse(readFileSync(settingsPath(process.env), 'utf8')) as { layouts: Record<string, { workspace: string; tab: string; activity: boolean }> };
  return Object.fromEntries(ps.map((p) => [p.name, saved.layouts[projectId(p.root)]]));
}

const said = (keys: ReadonlyArray<Record<string, unknown>>): string => keys.map((k) => JSON.stringify(k)).join('\n');

describe('Remember layout across a project switch (R6 H141; the cause of CI\'s slice B failure)', () => {
  it('Activity expanded, written, collapsed, and another project picked within 1.5 s: the project left comes back collapsed, and the other is given nothing of it', async () => {
    sandbox('switch');
    const left = project('left');
    const next = project('next');
    saveActiveProject(left);
    const keys: Array<Record<string, unknown>> = [];
    const c = workbench(left, keys);
    expect(c.ui.activityOpen).toBe(false);
    // a change (tab 3, as slice A's 3), then a expands Activity before that change's save fires (1.5 s after it), so that save
    // writes left as expanded
    c.key('3', {});
    await sleep(1300);
    c.key('a', {});
    expect(c.ui.activityOpen).toBe(true);
    await sleep(500);
    expect(layouts(left).left, said(keys)).toMatchObject({ workspace: 'workflows', activity: true });
    // the collapse, and at once another project (the picker's Enter: the REPL's own /project, the shared record)
    c.key('a', {});
    expect(c.ui.activityOpen).toBe(false);
    c.switchProject(next.root, 'switched to next');
    expect(c.data.project.name).toBe('next');
    // past the 1.5 s the collapse's save waited for
    await sleep(1800);
    c.dispose();
    // left as it was left (collapsed); next was given no layout of left's
    expect(layouts(left, next), said(keys)).toEqual({ left: { workspace: 'workflows', tab: 'inspector', activity: false }, next: undefined });

    // the next Workbench on left (slice B's) opens with Activity collapsed, and draws it so; one a expands it
    saveActiveProject(left);
    const again = workbench(left, []);
    expect(again.ui.activityOpen).toBe(false);
    const app = <WorkbenchApp controller={again} colour={false} size={{ columns: 160, rows: 45 }} />;
    const r = render(app);
    r.rerender(app);
    await sleep(100);
    expect(r.lastFrame()).toMatch(/▸ Activity/);
    r.stdin.write('a');
    await sleep(100);
    expect(r.lastFrame()).toMatch(/▾ Activity[\s\S]*All operations/);
  }, 30_000);

  it('a change on the project switched to is that project\'s own: written under its name, not the one left', async () => {
    sandbox('own');
    const left = project('left');
    const next = project('next');
    saveActiveProject(left);
    const c = workbench(left, []);
    c.key('a', {});
    c.switchProject(next.root, 'switched to next');
    // (the project left is written at the switch: expanded, as it was left)
    expect(layouts(left).left).toMatchObject({ activity: true });
    // next has no layout of its own yet: the screen keeps what it shows; a change there is next's
    c.key('a', {});
    expect(c.ui.activityOpen).toBe(false);
    await sleep(1800);
    expect(layouts(left, next)).toMatchObject({ left: { activity: true }, next: { activity: false } });
    c.dispose();
  }, 30_000);
});
