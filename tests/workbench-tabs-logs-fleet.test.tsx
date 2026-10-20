// R5 (H134): tab 0 (Logs & Receipts) and tab 8 (Fleet & Clef) wired into the terminal Workbench. Their keys open their bodies
// (src/workbench/logs-tab.ts, src/workbench/fleet-tab.ts) in the composed frame, the same key again their second workspace
// (Files; God's Eye View), each tab is read only while it is shown, and a row's detail is in the Inspector. Over a real Timmy
// home in a temporary folder and a project made by the starter code, with one receipt sealed by the real appendReceipt in
// this test's own store (its words FAKE, as they say). Nothing is asked over the network; no server is started.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createProject, projectId, saveActiveProject } from '../src/project/index.js';
import { copyStarter } from '../src/project/starters.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import { visibleWidth } from '../src/term/width.js';
import { appendReceipt, type ReceiptInput } from '../src/utils/receipts.js';
import { Controller } from '../src/workbench/controller.js';
import { glyphsFor, screenText } from '../src/workbench/frame.js';
import type { Frame } from '../src/workbench/screen.js';
import { CompanionControl, StudioControl, type Opener } from '../src/workbench/servers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FAKE_OPENER: Opener = { program: null, open: () => ({ ok: false, why: 'FAKE opener: nothing is opened in this test' }) };

let box = '';
let home = '';
let jobsDir = '';
const opened: Controller[] = [];

beforeAll(() => {
  box = mkdtempSync(join(tmpdir(), 'wb-tabs-0-8-'));
  home = join(box, 'timmy');
  jobsDir = join(home, 'jobs');
  mkdirSync(home, { recursive: true });
});
afterAll(() => { rmSync(box, { recursive: true, force: true }); });
afterEach(() => {
  for (const c of opened.splice(0)) c.dispose();
  vi.unstubAllEnvs();
});

function sandbox(): void {
  vi.stubEnv('TIMMY_HOME', home);
  vi.stubEnv('TIMMY_SETTINGS_DIR', join(box, 'settings'));
  vi.stubEnv('OPENROUTER_API_KEY', '');
}

function trayProject(name: string): { name: string; root: string; chosen: boolean } {
  const made = createProject(name);
  if ('error' in made) throw new Error(made.error);
  const copied = copyStarter('tray-workflow', made.root);
  if ('error' in copied) throw new Error(copied.error);
  saveActiveProject(made);
  return made;
}

function workbench(project: { name: string; root: string; chosen: boolean }): Controller {
  const ws = new Workspace({
    glyphs: glyphSet(true), env: process.env, onPath: () => null, notify: () => undefined, openWeb: () => '', link: (t) => t,
    seal: () => undefined, jobsDir, recoverAtStart: false, chdir: () => undefined,
  }, project);
  const c = new Controller({
    env: process.env, jobsDir, onPath: () => null, glyphs: glyphsFor(true), workspace: ws,
    companion: new CompanionControl({ opener: FAKE_OPENER, start: async () => { throw new Error('FAKE: no server is started in this test'); } }),
    studio: new StudioControl({ env: process.env, opener: FAKE_OPENER, project: () => ws.project, projectId, jobsDir, receipts: () => join(box, 'store'), ensure: async () => ({ state: 'failed', error: 'FAKE: no Studio in this test' }) }),
    // FAKE: no tools rows (no machine is probed)
    capabilities: async () => [], tickMs: 100, slowMs: 400,
  });
  opened.push(c);
  return c;
}

/** A region's rows as text, inside its border. */
function regionRows(f: Frame, region: 'center' | 'right'): string[] {
  const rect = f.regions[region]?.rect;
  if (!rect) return [];
  const rows = screenText(f.screen);
  const out: string[] = [];
  for (let y = rect.y + 1; y < rect.y + rect.h - 1; y++) {
    let x = 0;
    let row = '';
    for (const ch of rows[y] ?? '') { if (x > rect.x && x < rect.x + rect.w - 1) row += ch; x += visibleWidth(ch); }
    out.push(row);
  }
  return out;
}

const text = (f: Frame, region: 'center' | 'right'): string => regionRows(f, region).join('\n');

describe('tabs 0 and 8 in the terminal Workbench (R5 H134)', () => {
  it('0 opens Logs & Receipts and 8 Fleet & Clef, each read only while shown; the same key again: Files, God\'s Eye View', async () => {
    sandbox();
    const p = trayProject('tabs-0-8');
    // one receipt in this test's own store (TIMMY_STORE, tests/isolation-setup.ts), naming this project (FAKE words)
    appendReceipt('runs', { policy: 'auto', status: 'ok', project: p.name, project_id: projectId(p.root), kind: 'run', subject: 'FAKE run: doctor.pass, 12 checks' } as ReceiptInput);
    const c = workbench(p);
    c.frame(160, 45);
    // Home reads neither tab
    expect(c.ui.page).toBe('home');
    expect(c.data.logs).toBeUndefined();
    expect(c.data.fleet).toBeUndefined();

    c.key('0', {});
    expect([c.ui.page, c.ui.workspace]).toEqual(['logs', 'logs']);
    expect(c.data.logs?.chain.state).toBe('verified');
    expect(c.data.fleet).toBeUndefined();
    let f = c.frame(160, 45);
    const logs = text(f, 'center');
    expect(logs).toMatch(/✓ chain verified: 1 receipt/);
    expect(logs).toMatch(/EVENT LOG[^\n]*│ OPERATION[^\n]*│ RAW OUTPUT/);
    expect(logs).toMatch(/#1 run/);
    // the tab draws its own columns (src/workbench/layout.ts OWN_COLUMNS): the whole width, Context no column beside it
    expect(f.regions.right).toBeFalsy();
    // [i] opens Context as a drawer: the Inspector has the selected row's detail (the receipt, its raw line whole); [i] closes it
    c.key('i', {});
    f = c.frame(160, 45);
    expect(text(f, 'right')).toMatch(/RECEIPT/);
    expect(text(f, 'right').replace(/\s+/g, ' ')).toMatch(/FAKE run: doctor\.pass, 12 checks/);
    c.key('i', {});
    expect(c.frame(160, 45).regions.right).toBeFalsy();
    // the same key again: the tab's second workspace (the project's files), then back
    c.key('0', {});
    expect([c.ui.page, c.ui.workspace]).toEqual(['logs', 'files']);
    c.key('0', {});
    expect(c.ui.workspace).toBe('logs');

    c.key('8', {});
    expect([c.ui.page, c.ui.workspace]).toEqual(['fleet', 'fleet']);
    expect(c.data.fleet?.clef.useClef).toBe(false);
    f = c.frame(160, 45);
    const fleet = text(f, 'center');
    expect(fleet).toMatch(/FLEET · plans, newest first/);
    expect(fleet).toMatch(/No fleet plan in this project\./);
    expect(fleet).toMatch(/DECISION MODEL · none set up/);
    expect(fleet).toMatch(/uncalibrated thresholds/);
    expect(fleet).toMatch(/CLOUDFLARE · optional/);
    // God's Eye View stays reachable: 8 again (and /overview, the tab that gathers it)
    c.key('8', {});
    expect([c.ui.page, c.ui.workspace]).toEqual(['fleet', 'overview']);
    c.key('8', {});
    expect(c.ui.workspace).toBe('fleet');

    // read with the slow reading only while shown: away from tab 0, its reading is not made again
    const before = c.data.logs?.at;
    await sleep(20);
    c.readAll();
    expect(c.data.logs?.at).toBe(before);
    expect(c.data.fleet?.at).not.toBe(undefined);
  }, 60_000);

  it('at 160x45, 120x40 and 100x30 each body fills the frame exactly: as many rows as the terminal, none wider', () => {
    sandbox();
    const p = trayProject('tabs-0-8-sizes');
    appendReceipt('runs', { policy: 'auto', status: 'ok', project: p.name, project_id: projectId(p.root), kind: 'run', subject: 'FAKE run' } as ReceiptInput);
    const c = workbench(p);
    for (const key of ['0', '8']) {
      c.frame(160, 45);
      c.key(key, {});
      for (const [w, h] of [[160, 45], [120, 40], [100, 30]] as const) {
        const f = c.frame(w, h);
        const rows = screenText(f.screen);
        expect(rows, `${key} at ${w}x${h}`).toHaveLength(h);
        for (const r of rows) expect(visibleWidth(r), `${key} at ${w}x${h}`).toBeLessThanOrEqual(w);
        // the columns side by side from 120, stacked at 100 (the terminal's width decides, not the body's)
        const body = text(f, 'center');
        if (key === '0') expect(/EVENT LOG[^\n]*│ OPERATION/.test(body), `${key} at ${w}x${h}`).toBe(w >= 120);
        else expect(/FLEET · plans[^\n]*│ CLOUDFLARE/.test(body), `${key} at ${w}x${h}`).toBe(w >= 120);
      }
    }
  });
});
