// R6 (H141; REMAINING-DEFECTS #31, the interaction review of a77d80d, defect 12): one screen does not contradict itself. Home's
// preview drew Studio's cards as first read when Home opened, so after a run it said "Approval: see a NEEDS YOU box  not run
// yet · 1 block: tidy" above "LAST RUN ✓ j7ace85 completed APPROVAL.md › tidy". The cards are read again when a job starts,
// moves or ends: the board's card names the run LAST RUN names, as it ended.
//
// Drawn by the Workbench's own frame (Controller.frame, the rows Ink prints) over a real Timmy home in a temporary folder: a
// project made by the starter code, the REPL's own Workspace and its /run (its job store, its operation log, its receipts sealed
// into this test's store). FAKE or FIXTURE here, each labelled where it is made: upmd is tests/fixtures/fake-upmd.mjs (a TEST
// DOUBLE of upmd 0.2.7; its block runs for real through sh); QUICK.md is this test's FAKE workflow (it prints a line); the run
// detail's and the chat session's producers have none; the browser opener and the server starts are FAKE.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createProject, projectId, saveActiveProject } from '../src/project/index.js';
import { copyStarter } from '../src/project/starters.js';
import { realOnPath } from '../src/repl/center.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import { visibleWidth } from '../src/term/width.js';
import { appendReceipt, readChain } from '../src/utils/receipts.js';
import { Controller } from '../src/workbench/controller.js';
import { glyphsFor, screenText } from '../src/workbench/frame.js';
import { CompanionControl, StudioControl, type Opener } from '../src/workbench/servers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FAKE_OPENER: Opener = { program: null, open: () => ({ ok: false, why: 'FAKE opener: nothing is opened in this test' }) };
const FAKE_UPMD = resolve('tests/fixtures/fake-upmd.mjs');
const QUICK = '# Quick (FAKE workflow, this test)\n\nIt prints a line.\n\n```bash [name:say]\necho "FAKE workflow: said"\n```\n';

let box = '';
let home = '';
let jobsDir = '';
const opened: Controller[] = [];
const spaces: Workspace[] = [];

beforeAll(() => {
  box = mkdtempSync(join(tmpdir(), 'wb-home-board-'));
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

async function until<T>(what: string, get: () => T | undefined | false | null, ms = 20_000, show?: () => string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}${show ? `:\n${show()}` : ''}`);
    await sleep(50);
  }
}

/** A region of the frame as drawn at 160x60, its rows joined. */
function area(c: Controller, name: 'center' | 'right'): string {
  const fr = c.frame(160, 60);
  const rect = fr.regions[name]!.rect;
  const text = screenText(fr.screen);
  const out: string[] = [];
  for (let y = rect.y + 1; y < rect.y + rect.h - 1; y++) {
    let x = 0;
    let row = '';
    for (const ch of text[y] ?? '') { if (x > rect.x && x < rect.x + rect.w - 1) row += ch; x += visibleWidth(ch); }
    out.push(row);
  }
  return out.join(' ').replace(/\s+/g, ' ');
}

describe('Home\'s board follows a run (R6 H141; REMAINING-DEFECTS #31)', () => {
  it('a workflow\'s card says "not run yet" until it runs; once a run of it has ended, the card names that run as LAST RUN does, never "not run yet" beside it', async () => {
    vi.stubEnv('TIMMY_HOME', home);
    vi.stubEnv('TIMMY_SETTINGS_DIR', join(box, 'settings'));
    vi.stubEnv('TIMMY_STORE', join(box, 'store'));
    vi.stubEnv('OPENROUTER_API_KEY', '');
    const made = createProject('board-fresh');
    if ('error' in made) throw new Error(made.error);
    const copied = copyStarter('tray-workflow', made.root);
    if ('error' in copied) throw new Error(copied.error);
    writeFileSync(join(made.root, 'QUICK.md'), QUICK);
    saveActiveProject(made);
    const env = { ...process.env, UPMD_BIN: FAKE_UPMD };
    const onPath = (cmd: string) => realOnPath(cmd, process.env);
    const ws = new Workspace({
      glyphs: glyphSet(true), env, onPath, notify: () => undefined, openWeb: () => '', link: (t) => t,
      seal: (input) => appendReceipt('runs', input).hash.slice(7, 15), receipts: () => readChain('runs'),
      jobsDir, recoverAtStart: false, chdir: () => undefined,
    }, made);
    spaces.push(ws);
    const c = new Controller({
      env, jobsDir, onPath, glyphs: glyphsFor(true), workspace: ws,
      producers: { runDetail: async () => ({ ok: false, why: 'FIXTURE: none' }), openChat: async () => ({ ok: false, why: 'FIXTURE: no chat session in this test' }) },
      companion: new CompanionControl({ opener: FAKE_OPENER, start: async () => { throw new Error('FAKE: no server is started in this test'); } }),
      studio: new StudioControl({ env: process.env, opener: FAKE_OPENER, project: () => ws.project, projectId, jobsDir, receipts: () => join(box, 'store'), ensure: async () => ({ state: 'failed', error: 'FAKE: no Studio in this test' }) }),
      // (no slow reading while the test runs: the cards follow the job's own change, not a reading every few seconds)
      capabilities: async () => [], tickMs: 100, slowMs: 3_600_000,
    });
    opened.push(c);
    c.start();
    // R10 (H167): Home's preview in words (its board, its last run) gave way to recent work and the selected item: Studio's
    // cards are tab 4's list (the same reading of the project's records), and the run is an item of Home's recent work
    c.selectPage('studio');
    await until('Studio\'s cards read', () => c.data.studio.state === 'ready' && /Quick \(FAKE workflow, this test\) +not run yet · 1 block: say/.test(area(c, 'center')), 20_000, () => area(c, 'center'));

    // a run of it, through the REPL's own /run (FAKE upmd; the block prints a line)
    await ws.run('QUICK.md say');
    // the card follows (read again at the job's change, not at a slow reading): it names its newest run, never "not run yet"
    await until('the card naming its newest run', () => /Quick \(FAKE workflow, this test\) +newest run \([^)]*\) completed · 1 block: say/.test(area(c, 'center')), 30_000, () => area(c, 'center'));
    expect(area(c, 'center')).not.toMatch(/Quick \(FAKE workflow, this test\) +not run yet/);
    // Home's recent work names the run as it ended
    c.selectPage('home');
    await until('the run in Home\'s recent work', () => /Quick \(FAKE workflow, this test\) › say +run · completed/.test(area(c, 'center')), 10_000, () => area(c, 'center'));
  }, 60_000);
});
