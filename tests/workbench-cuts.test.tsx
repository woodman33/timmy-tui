// R8 (H157; the R7 package's open item E, R5's visual review 8: "cut lines on tab 8"): at 100x30, 120x40 and 160x45 every
// line of tab 8 (Fleet & Clef) fits, wraps at a word, or ends with an ellipsis after a whole word: no word is cut through,
// in the Unicode glyphs and in the ASCII ones (a terminal without Unicode, whose ellipsis is three dots). The cut came from
// the shared src/workbench/text.ts cut(), which every row's fit() uses: it ended at a space only when one was in the last
// third of the room, and cut through the word otherwise (tab 8's row 2 drew "[4 Connect a Cloudro...]" at 100x30, Home's
// "[2 Check con…]  [3 New proj…]" at 120x40, tab 6's "[3 After Effects composit…]" at 100x30). The other tabs are read the
// same way.
//
// How a word is known whole: the same state drawn 400 columns wide (where nothing is cut), with the workspace frame's own
// words, gives the words a screen can show; the word before each ellipsis must be one of them (or a path's folders, ending
// in /, as a wrapped path breaks). An ellipsis that is part of the words themselves (drawn wide too) is not a cut. Raw
// output (what a job printed) is cut where its row ends, by design (src/workbench/text.ts clip); none is on these screens.
//
// Drawn by the Workbench's own frame (Controller.frame, the rows Ink prints) over a real Timmy home in a temporary folder: a
// tray-workflow project made by the starter code and the REPL's own Workspace, in a git folder of its own; two FAKE fleet
// plans (one run to its end on the FAKE backend: a simulation, no compute, no harness, no model, no cost) and two decisions
// recorded by `timmy decide`'s own code (one answered from a FAKE Clef-Omni response file, no service called). The run
// detail's and the chat session's producers have none; the browser opener and the server starts are FAKE.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { decideDo } from '../src/decision/cli.js';
import { fakeBackend } from '../src/fleet/fake.js';
import { planFleet, runPlan } from '../src/fleet/service.js';
import { createProject, projectId, saveActiveProject, type Project } from '../src/project/index.js';
import { copyStarter } from '../src/project/starters.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import { Controller } from '../src/workbench/controller.js';
import { FLEET_LIST } from '../src/workbench/fleet-tab.js';
import { glyphsFor, screenText } from '../src/workbench/frame.js';
import { CompanionControl, StudioControl, type Opener } from '../src/workbench/servers.js';
import { fixture as clefFixture } from './fixtures/clef-omni/fake.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FAKE_OPENER: Opener = { program: null, open: () => ({ ok: false, why: 'FAKE opener: nothing is opened in this test' }) };
const SIZES = [[100, 30], [120, 40], [160, 45]] as const;

let box = '';
let home = '';
let jobsDir = '';
const opened: Controller[] = [];
const spaces: Workspace[] = [];

beforeAll(() => {
  box = mkdtempSync(join(tmpdir(), 'wb-cuts-'));
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

function project(name: string): Project {
  const p = createProject(name);
  if ('error' in p) throw new Error(p.error);
  const copied = copyStarter('tray-workflow', p.root);
  if ('error' in copied) throw new Error(copied.error);
  saveActiveProject(p);
  return p;
}

/** Two FAKE plans (one run to its end) and two decisions, in the project's own git folder (a plan names its revision). */
async function fleetOf(p: Project): Promise<void> {
  const git = (...a: string[]) => spawnSync('git', ['-c', 'user.email=fake@example.com', '-c', 'user.name=FAKE', '-c', 'commit.gpgsign=false', ...a], { cwd: p.root, encoding: 'utf8' });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'FAKE');
  const run = planFleet(p.root, { agents: 3, concurrency: 2, provider: 'fake', isolation: 'vm', harness: 'codex', model: 'the harness default', prompt: 'FAKE task' });
  if (!run.ok) throw new Error(run.refusals.join('; '));
  await runPlan(p.root, run.plan.id, { by: 'person', backendFor: () => fakeBackend() });
  const later = planFleet(p.root, { agents: 2, concurrency: 1, provider: 'fake', isolation: 'container', harness: 'pi', model: 'the harness default', prompt: 'FAKE task 2' });
  if (!later.ok) throw new Error(later.refusals.join('; '));
  expect((await decideDo(['route', '--option', 'codex:Codex', '--option', 'pi', '--option', 'openhands', '--deterministic', 'codex', '--project', p.root, '--fixture', clefFixture('response-route-ok.json')], { env: { ...process.env, TIMMY_CLEF: '1' } })).code).toBe(0);
  expect((await decideDo(['route', '--option', 'codex', '--option', 'pi', '--deterministic', 'pi', '--project', p.root], { env: { ...process.env, TIMMY_CLEF: '0' } })).code).toBe(0);
}

function workbench(p: Project, unicode: boolean): Controller {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.TIMMY_STORE;
  const ws = new Workspace({ glyphs: glyphSet(unicode), env, onPath: () => null, notify: () => undefined, openWeb: () => '', link: (t) => t, seal: () => undefined, jobsDir, recoverAtStart: false, chdir: () => undefined }, p);
  spaces.push(ws);
  const c = new Controller({
    env, jobsDir, onPath: () => null, glyphs: glyphsFor(unicode), workspace: ws,
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

/** A word as a reader takes it: without the brackets, quotes and punctuation around it. */
const bare = (t: string): string => t.replace(/^[([{"'`<▸>]+/, '').replace(/[)\]}"'`>,;:.·!?]+$/, '');
const wordsOf = (texts: readonly string[]): Set<string> => new Set(texts.join(' ').split(/\s+/).map(bare).filter(Boolean));

/** The words before each ellipsis on the rows (the run of letters, digits and marks just before it), with its row. */
function cutsOf(rows: readonly string[], ellipsis: string): Array<{ word: string; row: string }> {
  const out: Array<{ word: string; row: string }> = [];
  for (const row of rows) {
    for (let i = row.indexOf(ellipsis); i >= 0; i = row.indexOf(ellipsis, i + ellipsis.length)) {
      const word = /(\S*)$/.exec(row.slice(0, i))![1];
      if (word) out.push({ word, row: row.trim() });
    }
  }
  return out;
}

/**
 * The words cut through on the screens of `look` at the three sizes: each ellipsis must follow a whole word of the same state
 * drawn wide (or a path's folder), unless the words themselves hold it.
 */
function cutThrough(c: Controller, unicode: boolean, look: string, extra: readonly string[] = []): string[] {
  const ell = glyphsFor(unicode).ellipsis;
  const wide = [...screenText(c.frame(400, 120).screen), ...screenText(c.frame(260, 120).screen)];
  const screens = SIZES.map(([cols, rows]) => ({ size: `${cols}x${rows}`, rows: screenText(c.frame(cols, rows).screen) }));
  const f = c.data.frame!;
  const said = [...wide, ...extra, ...f.connections.flatMap((x) => [x.label, x.words, x.detail ?? '']), ...Object.values(f.actions).flat().flatMap((a) => [a.label, a.command, a.why ?? ''])];
  // every word shown whole anywhere (not just before an ellipsis) is a word too
  const whole = wordsOf([...said, ...screens.flatMap((s) => s.rows.map((r) => r.split(ell).map((part) => part.replace(/\S*$/, '')).join(' ')))]);
  const wideText = said.join('\n');
  const bad: string[] = [];
  for (const s of screens) {
    for (const { word, row } of cutsOf(s.rows, ell)) {
      if (wideText.includes(`${word}${ell}`)) continue;
      const w = bare(word);
      const folder = w.endsWith('/') && [...whole].some((x) => x.startsWith(w));
      if (!whole.has(w) && !folder) bad.push(`${look} at ${s.size}: "${word}${ell}" in: ${row}`);
    }
  }
  return bad;
}

describe('no word cut through (R8 H157: the R7 package\'s open item E; R5\'s visual review 8)', () => {
  it('tab 8, Fleet & Clef, with plans and decisions: at 100x30, 120x40 and 160x45, every item selected in turn, in the Unicode and the ASCII glyphs, each ellipsis follows a whole word', async () => {
    sandbox();
    const p = project('cuts-fleet');
    await fleetOf(p);
    const bad: string[] = [];
    for (const unicode of [true, false]) {
      const c = workbench(p, unicode);
      c.start();
      await until('the frame', () => c.data.frame);
      // opened afresh from Home (the layout is remembered per project: 8 again would turn the tab to God's Eye View)
      c.key('1', {});
      c.key('8', {});
      expect(c.ui.workspace).toBe('fleet');
      const d = await until('the fleet read', () => c.data.fleet);
      expect(d.plans).toHaveLength(2);
      expect(d.decisions).toHaveLength(2);
      for (let i = 0; i < d.plans.length + d.decisions.length; i++) {
        c.ui.cursor[FLEET_LIST] = i;
        bad.push(...cutThrough(c, unicode, `tab 8 (${unicode ? 'Unicode' : 'ASCII'}), item ${i + 1} selected`));
      }
      c.dispose();
    }
    expect(bad).toEqual([]);
  }, 120_000);

  it('the other tabs, as they open, at the three sizes, in both glyph sets: no word cut through either (the same shared cut)', async () => {
    sandbox();
    const p = project('cuts-tabs');
    const bad: string[] = [];
    for (const unicode of [true, false]) {
      const c = workbench(p, unicode);
      c.start();
      await until('the frame', () => c.data.frame);
      await sleep(300);
      for (const t of c.data.frame!.tabs) {
        // each tab opened afresh from Home, so a key pressed twice never turns a tab to its other workspace
        c.key('1', {});
        c.key(t.key, {});
        await sleep(100);
        bad.push(...cutThrough(c, unicode, `tab ${t.key} (${unicode ? 'Unicode' : 'ASCII'})`));
      }
      c.dispose();
    }
    expect(bad).toEqual([]);
  }, 120_000);
});
