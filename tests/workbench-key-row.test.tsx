// R8 (H157; the R7 package's open item E, R5's visual review 25: "the key row at 100×30 drops keys"): the Workbench's bottom
// row of key hints shows only whole hints at every width from 80 to 200 columns, always the five that matter most (the tabs,
// Enter, Tab, Stop and [?] keys, which lists every key), and leaves the others out whole in one fixed order of importance:
// a hint is never left out while a less important one is drawn, so the row loses hints from one end as it narrows and never
// shows one in place of another (at 100 columns it drew [a] log and left out [s] Studio · Show).
//
// Drawn by the Workbench's own frame (Controller.frame, the rows Ink prints) over a real Timmy home in a temporary folder: a
// tray-workflow project made by the starter code and the REPL's own Workspace. The run detail's and the chat session's
// producers have none; the browser opener and the server starts are FAKE.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createProject, projectId, saveActiveProject } from '../src/project/index.js';
import { copyStarter } from '../src/project/starters.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import { visibleWidth } from '../src/term/width.js';
import { Controller } from '../src/workbench/controller.js';
import { glyphsFor, screenText } from '../src/workbench/frame.js';
import { CompanionControl, StudioControl, type Opener } from '../src/workbench/servers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FAKE_OPENER: Opener = { program: null, open: () => ({ ok: false, why: 'FAKE opener: nothing is opened in this test' }) };

let box = '';
let home = '';
let jobsDir = '';
const opened: Controller[] = [];
const spaces: Workspace[] = [];

beforeAll(() => {
  box = mkdtempSync(join(tmpdir(), 'wb-keyrow-'));
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

function workbench(name: string): Controller {
  vi.stubEnv('TIMMY_HOME', home);
  vi.stubEnv('TIMMY_SETTINGS_DIR', join(box, 'settings'));
  vi.stubEnv('OPENROUTER_API_KEY', '');
  const p = createProject(name);
  if ('error' in p) throw new Error(p.error);
  const copied = copyStarter('tray-workflow', p.root);
  if ('error' in copied) throw new Error(copied.error);
  saveActiveProject(p);
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.TIMMY_STORE;
  const ws = new Workspace({ glyphs: glyphSet(true), env, onPath: () => null, notify: () => undefined, openWeb: () => '', link: (t) => t, seal: () => undefined, jobsDir, recoverAtStart: false, chdir: () => undefined }, p);
  spaces.push(ws);
  const c = new Controller({
    env, jobsDir, onPath: () => null, glyphs: glyphsFor(true), workspace: ws,
    producers: { runDetail: async () => ({ ok: false, why: 'FIXTURE: none' }), openChat: async () => ({ ok: false, why: 'FIXTURE: no chat session in this test' }) },
    companion: new CompanionControl({ opener: FAKE_OPENER, start: async () => { throw new Error('FAKE: no server is started in this test'); } }),
    studio: new StudioControl({ env: process.env, opener: FAKE_OPENER, project: () => ws.project, projectId, jobsDir, receipts: () => join(box, 'store'), ensure: async () => ({ state: 'failed', error: 'FAKE: no Studio in this test' }) }),
    capabilities: async () => [], tickMs: 100, slowMs: 3_600_000,
  });
  opened.push(c);
  return c;
}

async function until<T>(what: string, get: () => T | undefined | false | null, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** Every hint the row can draw, in the order it draws them. */
// (R10 H167: on Home and Chat, where this row is read, [i] is the details, kept before the Show keys)
const DRAWN = ['[1–0] tabs', '[Enter] acts', '[Tab] zones', '[x] Stop', '[c] Companion · Show', '[s] Studio · Show', '[a] log', '[/] find', '[,] settings', '[i] details', '[?] keys'];
/** The same hints, the most important first: the order they are kept in, and the reverse of the order they are left out in. */
const IMPORTANCE = ['[?] keys', '[1–0] tabs', '[Enter] acts', '[x] Stop', '[Tab] zones', '[i] details', '[c] Companion · Show', '[s] Studio · Show', '[a] log', '[/] find', '[,] settings'];
/** The hints every width keeps. */
const ALWAYS = ['[1–0] tabs', '[Enter] acts', '[Tab] zones', '[x] Stop', '[?] keys'];

/** The key row as drawn (Activity & log's last row inside its border and its cell of air) and the cells it has. */
function keyRow(c: Controller, columns: number, rows: number): { text: string; room: number } {
  const fr = c.frame(columns, rows);
  const rect = fr.regions.bottom!.rect;
  const line = screenText(fr.screen)[rect.y + rect.h - 2];
  expect(visibleWidth(line), `the row at ${columns} columns is the terminal's width`).toBe(columns);
  const chars = [...line];
  expect(chars[rect.x], 'the row is inside Activity & log\'s border').toMatch(/[│┃]/);
  return { text: chars.slice(rect.x + 2, rect.x + rect.w - 2).join('').trimEnd(), room: rect.w - 4 };
}

describe('the key row (R8 H157: the R7 package\'s open item E; R5\'s visual review 25)', () => {
  it('at every width from 80 to 200: whole hints only, the five that matter most always, the others left out whole in one fixed order of importance', async () => {
    const c = workbench('key-row');
    c.start();
    await until('the frame', () => c.data.frame);
    let before: string[] = [];
    for (let columns = 80; columns <= 200; columns++) {
      const { text, room } = keyRow(c, columns, 30);
      const shown = text.split(/ {2,}/).filter(Boolean);
      // whole hints, each one the row knows, drawn in its order, joined by two spaces and nothing else
      for (const h of shown) expect(DRAWN, `at ${columns} columns, "${h}" is a whole hint (the row: ${text})`).toContain(h);
      expect(text, `at ${columns} columns`).toBe(DRAWN.filter((h) => shown.includes(h)).join('  '));
      expect(text, `at ${columns} columns, nothing cut`).not.toMatch(/…/);
      // the five that matter most, at every width
      for (const h of ALWAYS) expect(shown, `at ${columns} columns (the row: ${text})`).toContain(h);
      // the hints kept are the most important ones, in the fixed order: a hint is never left out while a less important one is drawn
      const k = shown.length;
      expect([...shown].sort(), `at ${columns} columns, the ${k} most important hints (the row: ${text})`).toEqual(IMPORTANCE.slice(0, k).sort());
      // and as many as fit: the next most important would not
      if (k < IMPORTANCE.length) {
        const next = DRAWN.filter((h) => shown.includes(h) || h === IMPORTANCE[k]).join('  ');
        expect(visibleWidth(next), `at ${columns} columns, ${IMPORTANCE[k]} would not fit in ${room} cells`).toBeGreaterThan(room);
      }
      // a wider row never loses a hint a narrower one drew
      for (const h of before) expect(shown, `at ${columns} columns, a hint the row drew one column narrower`).toContain(h);
      before = shown;
    }
    // the sizes the reviews named: 100x30 keeps Companion and leaves out Studio, the log and the rest whole; 120x40 and
    // 160x45 as before
    // (R10 H167: on Home, [i] details is kept before the Show keys)
    expect(keyRow(c, 100, 30).text).toBe('[1–0] tabs  [Enter] acts  [Tab] zones  [x] Stop  [c] Companion · Show  [i] details  [?] keys');
    expect(keyRow(c, 120, 40).text).toBe('[1–0] tabs  [Enter] acts  [Tab] zones  [x] Stop  [c] Companion · Show  [s] Studio · Show  [i] details  [?] keys');
    expect(keyRow(c, 160, 45).text).toBe(DRAWN.join('  '));
  }, 60_000);
});
