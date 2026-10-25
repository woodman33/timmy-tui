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

/**
 * R8 (H156; R7's open item C): `word` read from the rows just after `lead` (one space or one row break between them), each row
 * read without its leading air, with row breaks allowed inside the word: its pieces, one per row it takes, and whether the first
 * is on the row of `lead`; or why the rows do not hold it whole and in order. It assumes no row the word starts on: a word that
 * does not fit beside `lead` goes whole to the next row (src/workbench/text.ts wrapSegs), and how long a path is depends on where
 * it is.
 */
function across(rows: string[], lead: string, word: string): { pieces: string[]; beside: boolean } | { why: string } {
  const at = rows.findIndex((r) => r.includes(lead));
  if (at < 0) return { why: `no row holds "${lead}"` };
  const text = rows.slice(at).map((r, i) => (i ? r.trimStart() : r)).join('\n');
  let i = text.indexOf(lead) + lead.length;
  if (text[i] !== ' ' && text[i] !== '\n') return { why: `"${lead}" is followed by ${JSON.stringify(text[i] ?? 'nothing')}` };
  const beside = text[i] === ' ';
  i += 1;
  const pieces = [''];
  for (const ch of word) {
    if (text[i] === '\n' && pieces[pieces.length - 1]) { pieces.push(''); i += 1; }
    if (text[i] !== ch) return { why: `after ${JSON.stringify(pieces.join('|'))} the rows read ${JSON.stringify(text.slice(i, i + 12))}, not ${JSON.stringify(ch)}` };
    pieces[pieces.length - 1] += ch;
    i += 1;
  }
  return { pieces, beside };
}

describe('words given room (R5 H131, the QA round)', () => {
  it('the keys sheet and Quick settings at 160 columns on Home (defect 5): each entry whole, wrapped under itself, no row cut; the settings file\'s path broken only at a separator (defect 25)', async () => {
    sandbox();
    // R8 (H156; R7's open item C): HOME is this test's folder, so the settings file's path is shown from ~ (tildePath reads
    // HOME) and its length is this test's, never the temporary folder's. Before, the shown path began with TMPDIR: with a
    // 32-character one it no longer fitted beside "Kept in" and went whole to the next row, as it should, while the test looked
    // for "Kept in " with its space on one row (a row's trailing space is not drawn) and failed; with a 15-character one it fitted.
    vi.stubEnv('HOME', box);
    const { c } = workbench('wrap-keys');
    c.start();
    c.selectPage('home');
    await until('the frame', () => c.data.frame);
    c.key('?', {});
    expect(c.ui.overlay?.kind).toBe('help');
    // (a terminal tall enough to show the whole sheet; its width, and so its rows, are those of 160x45. R6 lead: 140 rows, as
    // the Marks legend names the companion's and Studio's own live bound)
    const help = rows(c, 'center', 160, 140);
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
    // the path, from ~ where it can be: a short one whole beside "Kept in"
    const path = `${tildePath(c.ui.settings.path)}.`;
    expect(path).toBe('~/settings/workbench.json.');
    expect(across(settings, 'Kept in', path)).toEqual({ pieces: [path], beside: true });
    // and one longer than the row (no separator in its folders' names but /): broken, only just after a /, never cut
    const deep = join(box, 'settings', 'quick_settings_folder_for_the_wrap_test', 'one_more_folder_so_the_path_passes_a_row');
    vi.stubEnv('TIMMY_SETTINGS_DIR', deep);
    const { c: d } = workbench('wrap-keys-deep');
    d.start();
    d.selectPage('home');
    await until('the frame', () => d.data.frame);
    d.key(',', {});
    expect(d.ui.overlay?.kind).toBe('settings');
    const long = `${tildePath(d.ui.settings.path)}.`;
    expect(long).toBe('~/settings/quick_settings_folder_for_the_wrap_test/one_more_folder_so_the_path_passes_a_row/workbench.json.');
    const deepRows = rows(d, 'center', 160, 120);
    expect(deepRows.filter((r) => r.endsWith('…')), 'a row of Quick settings cut (the long path)').toEqual([]);
    const read = across(deepRows, 'Kept in', long);
    expect('pieces' in read, `the long path across the rows: ${JSON.stringify(read)}`).toBe(true);
    const { pieces } = read as { pieces: string[] };
    expect(visibleWidth(long), 'the long path is wider than the row').toBeGreaterThan(Math.max(...deepRows.map((r) => visibleWidth(r))));
    expect(pieces.length, `the long path's rows: ${JSON.stringify(pieces)}`).toBeGreaterThanOrEqual(2);
    expect(pieces.slice(0, -1).every((p) => p.endsWith('/')), `each of the long path's rows but its last ends just after a /: ${JSON.stringify(pieces)}`).toBe(true);
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
    // (R10 H167: Home's column beside recent work says the project's files, Timmy's own logs counted apart)
    const preview = joined(rows(c, 'right', 160, 70));
    expect(preview).toContain(`${before + 1} file`);
    expect(preview).toContain('not counted: 5 logs Timmy writes itself (logs/*.log)');

    // defect 7: at 100x30 Home's list is clipped, and says which rows it shows (1–N of M)
    const small = screenText(c.frame(100, 30).screen);
    // (R11 round 7, H177: the body's crumb is "project / Models & accounts"; the page head above it carries the title)
    const titles = small.find((r) => /\/ Models & accounts/.test(r))!;
    expect((titles.match(/\d+–\d+ of \d+/g) ?? []).length, `Home's column titles at 100x30: ${titles}`).toBeGreaterThanOrEqual(1);

    // tab 6: 3D Create, then Motion (the key again); R5 (H131; the QA of e7f853e, defect 2): what no Timmy surface draws, and
    // what c and s show for it in truth, first
    c.key('6', {});
    expect(c.ui.workspace).toBe('create3d');
    // (R7 H150: after the Unfinished block the frame's tabs[].unfinished draws first: tests/workbench-unfinished.test.tsx;
    // R7 lead, at H150's merge: tab 6's works and missing words are the longer ones of 9cd444a, so the block takes more
    // rows: the first 24 are read, the block first and then this sentence, before anything else the tab lists)
    const said = (): string => rows(c, 'center', 160, 45).slice(0, 24).join(' ').replace(/\s+/g, ' ');
    // R7 (H153): the companion's tab 6 draws the project's meshes now (src/workbench/create-tab.ts CREATE_SENTENCE)
    const line = 'The companion\'s tab 6 draws this project\'s meshes in a view you can turn: Timmy\'s own drawing of each file\'s triangles, not a render by Blender or any native tool. No Timmy surface draws a motion timeline yet; each app below draws its own, once set up. [c] Companion · Show: tab 6, the meshes in a view you can turn; [s] Studio · Show: the canvas (2D shapes and cards).';
    expect(said()).toContain(line);
    expect(said().indexOf('◌ Unfinished')).toBeGreaterThanOrEqual(0);
    expect(said().indexOf('◌ Unfinished')).toBeLessThan(said().indexOf(line));
    c.key('6', {});
    expect(c.ui.workspace).toBe('motion');
    expect(said()).toContain(line);
  }, 30_000);
});
