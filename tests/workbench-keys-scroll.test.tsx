// R6 (H141; the interaction review of a77d80d, defect 6): the `?` Keys list scrolls from the keyboard, by the keys it lists
// itself (↑ ↓ k j a row, PgUp PgDn a page, Home End to its start or end), and the wheel as before; its title says which rows
// show ("29–56 of 65"); and every entry it lists can be brought into view at 160x45, 120x40 and 100x30. Before, only the
// wheel moved it: ↓, j, PgDn and End left it at "1–28 of 65", and x, c s, C S, ",", i g, ?, Ctrl+C and the Marks legend were
// out of reach. A message box with no rows to select scrolls the same way.
//
// Drawn by the Workbench's own frame (Controller.frame, the rows Ink prints) over a real Timmy home in a temporary folder: a
// tray-workflow project made by the starter code and the REPL's own Workspace. FAKE or FIXTURE here, each labelled where it is
// made: the chat session's and the run detail's producers have none; the browser opener and the server starts are FAKE (nothing
// presses Show).
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
import { HELP } from '../src/workbench/views.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FAKE_OPENER: Opener = { program: null, open: () => ({ ok: false, why: 'FAKE opener: nothing is opened in this test' }) };

let box = '';
let home = '';
let jobsDir = '';
const opened: Controller[] = [];
const spaces: Workspace[] = [];

beforeAll(() => {
  box = mkdtempSync(join(tmpdir(), 'wb-keys-scroll-'));
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
  return c;
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

/** The body's left column as drawn at this size: its title row's range note (a–b of n) and its rows inside the border. */
function body(c: Controller, columns: number, rows: number): { note: { from: number; to: number; of: number } | null; rows: string[]; title: string } {
  const fr = c.frame(columns, rows);
  const rect = fr.regions.center!.rect;
  const text = screenText(fr.screen);
  const cells = (y: number): string => {
    let x = 0;
    let row = '';
    for (const ch of text[y] ?? '') { if (x > rect.x + 1 && x < rect.x + rect.w - 2) row += ch; x += visibleWidth(ch); }
    return row.replace(/\s+$/, '');
  };
  const title = cells(rect.y);
  const m = /(\d+)–(\d+) of (\d+)/.exec(title);
  const out: string[] = [];
  for (let y = rect.y + 1; y < rect.y + rect.h - 1; y++) out.push(cells(y));
  return { note: m ? { from: Number(m[1]), to: Number(m[2]), of: Number(m[3]) } : null, rows: out, title };
}

const joined = (r: string[]): string => r.join(' ').replace(/\s+/g, ' ');
const DOWN = { downArrow: true };
const UP = { upArrow: true };
const PGDN = { pageDown: true };
const PGUP = { pageUp: true };
const END = { end: true };
const HOME = { home: true };

describe('the Keys list (?) scrolls from the keyboard (R6 H141; the interaction review of a77d80d, defect 6)', () => {
  for (const [columns, rows] of [[160, 45], [120, 40], [100, 30]] as const) {
    it(`at ${columns}x${rows}: ↓ j k ↑ move it a row, PgDn PgUp a page, End and Home to its end and start, the wheel a row; its title says which rows show; every entry it lists comes into view`, async () => {
      const c = workbench(`keys-${columns}`);
      c.start();
      c.selectPage('home');
      await until('the frame', () => c.data.frame);
      c.key('?', {});
      expect(c.ui.overlay?.kind).toBe('help');
      const first = body(c, columns, rows);
      // it does not fit (else nothing would scroll): its title says the first rows of how many
      expect(first.note, `the title of the Keys list at ${columns}x${rows}: ${first.title}`).not.toBeNull();
      const { of: total, to: shown } = first.note!;
      const height = shown;
      expect(first.note).toEqual({ from: 1, to: height, of: total });
      expect(total).toBeGreaterThan(height);
      // its first rows say how it scrolls
      expect(joined(first.rows.slice(0, 4))).toContain('↑ ↓ (k j) scroll this list, PgUp PgDn a page, Home End to its start or end; the title says which rows show.');

      // a row at a time: ↓, j, then k, ↑ back
      c.key('', DOWN);
      expect(body(c, columns, rows).note).toEqual({ from: 2, to: height + 1, of: total });
      c.key('j', {});
      expect(body(c, columns, rows).note).toEqual({ from: 3, to: height + 2, of: total });
      c.key('k', {});
      expect(body(c, columns, rows).note).toEqual({ from: 2, to: height + 1, of: total });
      c.key('', UP);
      expect(body(c, columns, rows).note).toEqual({ from: 1, to: height, of: total });
      // the rows drawn are the rows the note names: one ↓ moves the second row to the first
      c.key('', DOWN);
      expect(body(c, columns, rows).rows[0]).toBe(first.rows[1]);
      c.key('', UP);

      // a page: PgDn, then PgUp back to the start
      c.key('', PGDN);
      const paged = body(c, columns, rows).note!;
      expect(paged.from).toBeGreaterThan(2);
      expect(paged.to - paged.from + 1).toBe(height);
      c.key('', PGUP);
      expect(body(c, columns, rows).note).toEqual({ from: 1, to: height, of: total });

      // End: its last rows, the last entry's last words on its last row; Home: its first rows again
      c.key('', END);
      const end = body(c, columns, rows);
      expect(end.note).toEqual({ from: total - height + 1, to: total, of: total });
      const [lastKey, lastWords] = HELP[HELP.length - 1];
      expect(joined(end.rows)).toContain(lastWords.split(' ').slice(-6).join(' '));
      expect(end.rows.some((r) => r.startsWith(lastKey))).toBe(true);
      // more keys at the end move nothing past it
      c.key('', DOWN);
      c.key('', PGDN);
      expect(body(c, columns, rows).note).toEqual({ from: total - height + 1, to: total, of: total });
      c.key('', HOME);
      expect(body(c, columns, rows).note).toEqual({ from: 1, to: height, of: total });

      // every entry it lists comes into view, whole, walking it a page at a time from its start to its end (each row kept at its
      // own place in the list, as the note names it: pages overlap by a row or two)
      const seen: string[] = [];
      const keep = (b: ReturnType<typeof body>): void => { b.rows.forEach((r, i) => { seen[b.note!.from - 1 + i] = r; }); };
      keep(first);
      for (let i = 0; i < 40; i++) {
        c.key('', PGDN);
        const b = body(c, columns, rows);
        keep(b);
        if (b.note!.to === total) break;
      }
      expect(body(c, columns, rows).note!.to).toBe(total);
      expect(seen.length).toBe(total);
      expect(seen.every((r) => r !== undefined), 'a row of the Keys list never came into view').toBe(true);
      for (const [k, w] of HELP) expect(joined(seen), `the Keys list's ${k} at ${columns}x${rows}`).toContain(`${k} ${w}`.replace(/\s+/g, ' '));

      // the wheel as before: one row per tick over the list
      c.key('', HOME);
      c.ui.mouse = true;
      const fr = c.frame(columns, rows);
      const r = fr.regions.center!.rect;
      c.mouse({ button: 65, x: r.x + 4, y: r.y + 4, press: true });
      expect(body(c, columns, rows).note).toEqual({ from: 2, to: height + 1, of: total });
      c.mouse({ button: 64, x: r.x + 4, y: r.y + 4, press: true });
      expect(body(c, columns, rows).note).toEqual({ from: 1, to: height, of: total });

      // Esc closes it; opened again it starts at its first rows
      c.key('', END);
      c.key('', { escape: true });
      expect(c.ui.overlay).toBeNull();
      c.key('?', {});
      expect(body(c, columns, rows).note).toEqual({ from: 1, to: height, of: total });
    }, 30_000);
  }

  it('a message box with no rows to select scrolls the same way (Run it in the REPL, at 100x30)', async () => {
    const c = workbench('keys-message');
    c.start();
    c.selectPage('home');
    await until('the frame', () => c.data.frame);
    // a box whose words do not fit (FIXTURE words: forty numbered rows)
    const words = Array.from({ length: 40 }, (_, i) => [{ text: `FIXTURE row ${i + 1} of 40`, role: 'text' as const }]);
    c.ui.overlay = { kind: 'message', title: 'A long message', lines: words };
    c.ui.focus = 'center';
    const first = body(c, 100, 30);
    // its title, a blank row, the forty rows, a blank row and [Esc] Close
    expect(first.note).toEqual({ from: 1, to: first.note!.to, of: 44 });
    expect(first.rows.slice(0, 3)).toEqual(['A long message', '', 'FIXTURE row 1 of 40']);
    c.key('', END);
    const end = body(c, 100, 30);
    expect(end.note).toEqual({ from: 44 - first.note!.to + 1, to: 44, of: 44 });
    expect(end.rows.slice(-3)).toEqual(['FIXTURE row 40 of 40', '', '[Esc] Close']);
    c.key('', HOME);
    expect(body(c, 100, 30).rows[2]).toBe('FIXTURE row 1 of 40');
    c.key('j', {});
    expect(body(c, 100, 30).rows[1]).toBe('FIXTURE row 1 of 40');
  }, 30_000);
});
