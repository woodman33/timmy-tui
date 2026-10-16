// R5 (H131): words given the room they need, after the R5 QA round (defects 3, 5, 15, 24 and 25): the keys sheet (?) and Quick
// settings (,) wrapped, never cut, at 160x45 on Home; the settings file's path broken at a separator; the Run confirm's fields
// whole; a notice wider than the row taking two rows; Home counting Timmy's own logs apart; tab 6 saying what a terminal cannot
// draw. Drawn by the Workbench's own frame (Controller.frame, the rows Ink prints) over a real Timmy home in a temporary
// folder: a tray-workflow project made by the starter code and the REPL's own Workspace.
//
// FAKE or FIXTURE here, each labelled where it is made: Timmy's own logs are empty files this test writes where Timmy writes
// them (logs/*.log); the chat session's and the run detail's producers have none; the browser opener and the server starts
// are FAKE (nothing presses Show).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createProject, projectId, saveActiveProject } from '../src/project/index.js';
import { copyStarter } from '../src/project/starters.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import { visibleWidth } from '../src/term/width.js';
import { tildePath } from '../src/utils/home-scrub.js';
import { Controller } from '../src/workbench/controller.js';
import { glyphsFor, screenText } from '../src/workbench/frame.js';
import { CompanionControl, StudioControl, type Opener } from '../src/workbench/servers.js';
import { PRESETS, SETTING_LABELS } from '../src/workbench/settings.js';
import { HELP } from '../src/workbench/views.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FAKE_OPENER: Opener = { program: null, open: () => ({ ok: false, why: 'FAKE opener: nothing is opened in this test' }) };

let box = '';
let home = '';
let jobsDir = '';
const opened: Controller[] = [];
const spaces: Workspace[] = [];

beforeAll(() => {
  box = mkdtempSync(join(tmpdir(), 'wb-wrap-'));
  home = join(box, 'timmy');
  jobsDir = join(home, 'jobs');
  mkdirSync(home, { recursive: true });
});
afterAll(() => { rmSync(box, { recursive: true, force: true }); });
afterEach(async () => {
  for (const c of opened.splice(0)) c.dispose();
  for (const ws of spaces.splice(0)) await ws.close({ by: 'as the test ended' });
  vi.unstubAllEnvs();
});

function sandbox(): void {
  vi.stubEnv('TIMMY_HOME', home);
  vi.stubEnv('TIMMY_SETTINGS_DIR', join(box, 'settings'));
  vi.stubEnv('OPENROUTER_API_KEY', '');
}

function workbench(name: string): { c: Controller; root: string } {
  const made = createProject(name);
  if ('error' in made) throw new Error(made.error);
  const copied = copyStarter('tray-workflow', made.root);
  if ('error' in copied) throw new Error(copied.error);
  saveActiveProject(made);
  const ws = new Workspace({ glyphs: glyphSet(true), env: process.env, onPath: () => null, notify: () => undefined, openWeb: () => '', link: (t) => t, seal: () => undefined, jobsDir, recoverAtStart: false, chdir: () => undefined }, made);
  spaces.push(ws);
  const c = new Controller({
    env: process.env, jobsDir, onPath: () => null, glyphs: glyphsFor(true), workspace: ws,
    producers: { runDetail: async () => ({ ok: false, why: 'FIXTURE: none' }), openChat: async () => ({ ok: false, why: 'FIXTURE: no chat session in this test' }) },
    companion: new CompanionControl({ opener: FAKE_OPENER, start: async () => { throw new Error('FAKE: no server is started in this test'); } }),
    studio: new StudioControl({ env: process.env, opener: FAKE_OPENER, project: () => ws.project, projectId, jobsDir, receipts: () => join(box, 'store'), ensure: async () => ({ state: 'failed', error: 'FAKE: no Studio in this test' }) }),
    capabilities: async () => [], tickMs: 100, slowMs: 400,
  });
  opened.push(c);
  return { c, root: made.root };
}

async function until<T>(what: string, get: () => T | undefined | false | null, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

/** A region's rows as drawn, inside its border and its cell of air on each side. */
function rows(c: Controller, name: 'center' | 'right' | 'bottom', columns: number, height: number): string[] {
  const fr = c.frame(columns, height);
  const rect = fr.regions[name]!.rect;
  const text = screenText(fr.screen);
  const out: string[] = [];
  for (let y = rect.y + 1; y < rect.y + rect.h - 1; y++) {
    let x = 0;
    let row = '';
    for (const ch of text[y] ?? '') { if (x > rect.x + 1 && x < rect.x + rect.w - 2) row += ch; x += visibleWidth(ch); }
    out.push(row.replace(/\s+$/, ''));
  }
  return out;
}

const joined = (r: string[]): string => r.join(' ').replace(/\s+/g, ' ');

describe('words given room (R5 H131, the QA round)', () => {
  it('the keys sheet and Quick settings at 160 columns on Home (defect 5): each entry whole, wrapped under itself, no row cut; the settings file\'s path broken only at a separator (defect 25)', async () => {
    sandbox();
    const { c } = workbench('wrap-keys');
    c.start();
    c.selectPage('home');
    await until('the frame', () => c.data.frame);
    c.key('?', {});
    expect(c.ui.overlay?.kind).toBe('help');
    // (a terminal tall enough to show the whole sheet; its width, and so its rows, are those of 160x45)
    const help = rows(c, 'center', 160, 120);
    expect(help.filter((r) => r.endsWith('…')), 'a row of the keys sheet cut').toEqual([]);
    for (const [k, w] of HELP) expect(joined(help), `the keys sheet's ${k}`).toContain(`${k} ${w}`.replace(/\s+/g, ' '));
    expect(rows(c, 'center', 160, 45).every((r) => visibleWidth(r) <= c.frame(160, 45).regions.center!.rect.w - 4)).toBe(true);
    c.key('', { escape: true });
    c.key(',', {});
    expect(c.ui.overlay?.kind).toBe('settings');
    const settings = rows(c, 'center', 160, 120);
    expect(settings.filter((r) => r.endsWith('…')), 'a row of Quick settings cut').toEqual([]);
    for (const x of SETTING_LABELS) expect(joined(settings), `the setting ${x.label}`).toContain(`${x.label} ${x.about}`.replace(/\s+/g, ' '));
    for (const p of PRESETS) expect(joined(settings), `the preset ${p.label}`).toContain(`${p.label} ${p.about}`.replace(/\s+/g, ' '));
    // the path, from ~ where it can be: whole on one row, or broken just after a /
    const path = `${tildePath(c.ui.settings.path)}.`;
    const at = settings.findIndex((r) => r.includes('Kept in '));
    expect(at).toBeGreaterThanOrEqual(0);
    const tail = joined(settings.slice(at));
    if (!settings[at].includes(path)) {
      const shown = settings[at].slice(settings[at].indexOf('Kept in ') + 'Kept in '.length);
      expect(path.startsWith(shown) && shown.endsWith('/'), `the path's first row: ${shown}`).toBe(true);
      expect(tail.replace(`${shown} `, shown)).toContain(`Kept in ${path}`);
    } else expect(tail).toContain(`Kept in ${path}`);
  }, 30_000);

  it('the Run confirm says each field whole (defect 15); a notice wider than the row takes the row above the hints too, read to its end', async () => {
    sandbox();
    const { c } = workbench('wrap-confirm');
    c.start();
    c.selectPage('workflows');
    await until('the frame', () => c.data.frame);
    c.ui.overlay = { kind: 'confirm-run', doc: 'APPROVAL.md', block: 'tidy', order: ['tidy'], risky: [{ name: 'tidy', command: 'rm scratch/x' }] };
    const confirm = joined(rows(c, 'center', 100, 30));
    expect(confirm).toContain('How the REPL\'s own /run: its prediction sealed first, upmd runs each block after the blocks it needs');
    expect(confirm).toContain('Needs you tidy: a destructive command; its NEEDS YOU box asks first');
    c.ui.overlay = null;
    const words = 'upmd runs a block only after the blocks it needs, one after the other with no stop between them (upmd 0.2.7 has no option that runs one block alone), so Timmy asks once for every block that needs you before the run starts.';
    c.say(words, 'attention');
    const bottom = rows(c, 'bottom', 120, 40);
    // its last two rows: the notice, from its first word to its last
    expect(joined(bottom.slice(-2))).toBe(words);
    // Activity's first row stays
    expect(bottom[0]).toMatch(/Activity/);
  }, 30_000);

  it('Home counts Timmy\'s own logs apart and says so (defect 24); tab 6 says, first, what a terminal cannot draw and which keys draw it (defect 3)', async () => {
    sandbox();
    const { c, root } = workbench('wrap-files');
    c.start();
    c.selectPage('home');
    await until('the frame', () => c.data.frame);
    const before = c.data.files.total;
    // FAKE: Timmy's own logs, empty, where it writes them (src/utils/logger.ts makes these in the folder it runs in)
    mkdirSync(join(root, 'logs'), { recursive: true });
    for (const n of ['timmy-tui.log', 'companion.log', 'browser-launcher.log', 'workspace-launcher.log', 'agent-events.log']) writeFileSync(join(root, 'logs', n), '');
    // and one of the project's own, which is counted
    writeFileSync(join(root, 'logs', 'build.log'), 'the project\'s own log\n');
    c.refresh();
    expect(c.data.files.total).toBe(before + 6);
    const preview = joined(rows(c, 'right', 160, 70));
    expect(preview).toContain(`FILES (${before + 1})`);
    expect(preview).toContain('not counted: 5 logs Timmy writes itself (logs/*.log)');
    expect(preview).toContain('1 other file');

    // tab 6: 3D Create, then Motion (the key again)
    c.key('6', {});
    expect(c.ui.workspace).toBe('create3d');
    const line = 'A terminal cannot draw images, 3D or live previews: [c] Companion · Show, [s] Studio · Show.';
    expect(rows(c, 'center', 160, 45)[0]).toBe(line);
    c.key('6', {});
    expect(c.ui.workspace).toBe('motion');
    expect(rows(c, 'center', 160, 45)[0]).toBe(line);
  }, 30_000);
});
