// R6 (H141; the lead's ask, after 66a1323): c (Companion · Show) opens the browser companion on the tab the Workbench shows.
// The page has the same ten tabs by the same ids and opens the one ?tab=<id> names (src/companion/client/companion.js); from
// tab 5, c also names the VoxVision record selected there, vox=<id>, which the page's VoxVision panel opens
// (src/companion/client/panel-vox.js). The address is read back from the private page that opens it (src/utils/launch-page.ts):
// the tab and record in its query, the token only after #.
//
// Over a real Timmy home in a temporary folder: a project made by the starter code and a real VoxVision record (the REPL's
// /inspect of an STL: Timmy's own reader, in process), sealed in this test's store. FAKE: the companion's start (nothing
// listens; its port and token are FAKE) and the browser opener (it records the page it is given).
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createProject, saveActiveProject } from '../src/project/index.js';
import { copyStarter } from '../src/project/starters.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import { appendReceipt, readChain, type ReceiptInput } from '../src/utils/receipts.js';
import { Controller } from '../src/workbench/controller.js';
import { glyphsFor } from '../src/workbench/frame.js';
import { CompanionControl, StudioControl, withQuery, type Opener } from '../src/workbench/servers.js';
import { cubeStl, put, settled } from './helpers/vox-fakes.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// FAKE: the companion's token (64 hex, as a real one's)
const FAKE_TOKEN = 'fa'.repeat(32);
const NO_OPENER: Opener = { program: null, open: () => ({ ok: false, why: 'FAKE opener: nothing is opened in this test' }) };

let box = '';
let home = '';
let jobsDir = '';
const opened: Array<{ c: Controller; ws: Workspace }> = [];
const pages: string[] = [];

beforeAll(() => {
  box = mkdtempSync(join(tmpdir(), 'wb-companion-tab-'));
  home = join(box, 'timmy');
  jobsDir = join(home, 'jobs');
  mkdirSync(home, { recursive: true });
});
afterAll(() => { rmSync(box, { recursive: true, force: true }); });
afterEach(async () => {
  for (const o of opened.splice(0)) { o.c.dispose(); await o.ws.close(); }
  for (const href of pages.splice(0)) rmSync(dirname(fileURLToPath(href)), { recursive: true, force: true });
  vi.unstubAllEnvs();
});

/** The REPL's seal, made real: a receipt on this test's own chain (TIMMY_STORE, tests/isolation-setup.ts). */
const seal = (input: ReceiptInput): string => appendReceipt('runs', input).hash;

function workbench(name: string): { c: Controller; ws: Workspace; root: string; companion: CompanionControl } {
  vi.stubEnv('TIMMY_HOME', home);
  vi.stubEnv('TIMMY_SETTINGS_DIR', join(box, 'settings'));
  vi.stubEnv('OPENROUTER_API_KEY', '');
  const made = createProject(name);
  if ('error' in made) throw new Error(made.error);
  const copied = copyStarter('tray-workflow', made.root);
  if ('error' in copied) throw new Error(copied.error);
  saveActiveProject(made);
  const ws = new Workspace({
    glyphs: glyphSet(true), env: process.env, onPath: () => null, notify: () => undefined, openWeb: () => '', link: (t) => t,
    seal, receipts: () => readChain('runs'), jobsDir, recoverAtStart: false, chdir: () => undefined,
  }, made);
  // FAKE: the companion's start (nothing listens) and the opener (it keeps the page it is given)
  const opener: Opener = { program: 'FAKE opener', open: (href) => { pages.push(href); return { ok: true }; } };
  const companion = new CompanionControl({
    opener, env: { TIMMY_COMPANION_PORT: '4567' },
    start: async (port) => ({ port, url: `http://127.0.0.1:${port}/#t=${FAKE_TOKEN}`, address: `http://127.0.0.1:${port}/`, shutdown: async () => undefined }),
  });
  const c = new Controller({
    env: process.env, jobsDir, onPath: () => null, glyphs: glyphsFor(true), workspace: ws, companion,
    studio: new StudioControl({ env: process.env, opener: NO_OPENER, project: () => ws.project, projectId: () => 'FAKE', jobsDir, receipts: () => join(box, 'store'), ensure: async () => ({ state: 'failed', error: 'FAKE: no Studio in this test' }) }),
    capabilities: async () => [], tickMs: 100, slowMs: 400,
  });
  opened.push({ c, ws });
  return { c, ws, root: made.root, companion };
}

/** The address the newest private page opens (its one script's location.replace). */
function opens(): string {
  const href = pages.at(-1);
  if (!href) throw new Error('no page was opened');
  const m = /location\.replace\(("(?:[^"\\]|\\.)*")\)/.exec(readFileSync(fileURLToPath(href), 'utf8'));
  if (!m) throw new Error('the private page has no address');
  return JSON.parse(m[1]) as string;
}

/** Presses c and waits for its answer in Activity. */
async function pressC(c: Controller): Promise<string> {
  const before = pages.length;
  c.key('c', {});
  for (let i = 0; i < 100 && pages.length === before; i++) await sleep(20);
  await sleep(20);
  return c.data.activity.events[0]?.words ?? '';
}

describe('c opens the companion on the tab the Workbench shows (R6 H141; the lead\'s ask after 66a1323)', () => {
  it('from tab 5, on VoxVision with the record selected there: ?tab=voxvision&vox=<id>, the token after # only', async () => {
    const { c, ws, root, companion } = workbench('companion-vox');
    put(root, 'parts/cube.stl', cubeStl(10));
    await ws.inspect('parts/cube.stl');
    await settled(ws);
    const [vox] = readdirSync(join(root, 'results', 'vox')).filter((n) => /^v[0-9a-f]{8}\.json$/.test(n)).map((n) => n.slice(0, -5));
    c.key('5', {});
    expect(c.ui.page).toBe('voxvision');
    const sel = c.selected();
    expect(sel?.kind === 'vox-record' ? sel.row.card.id : sel?.kind).toBe(vox);
    const words = await pressC(c);
    expect(opens()).toBe(`http://127.0.0.1:4567/?tab=voxvision&vox=${vox}#t=${FAKE_TOKEN}`);
    // the words say what opened (R10 H167; H168's F3: in words); the address it opened, never its token, is the details' ([i]:
    // the companion's own words, kept whole)
    expect(words).toBe('Opened in the companion: the observation chosen in VoxVision.');
    expect(companion.state().last).toBe(`The Companion opened in your browser (http://127.0.0.1:4567/?tab=voxvision&vox=${vox}), through a private page that carries its key`);
    expect(JSON.stringify(c.data.activity.events)).not.toContain(FAKE_TOKEN);
  });

  it('from tab 9 on Tools & MCP, and from each tab on its own: the same ten ids; a record only from tab 5', async () => {
    const { c } = workbench('companion-tabs');
    for (const [key, tab] of [['9', 'tools'], ['3', 'workflows'], ['1', 'home'], ['7', 'control'], ['0', 'logs'], ['5', 'voxvision']] as const) {
      c.key(key, {});
      expect(c.ui.page).toBe(tab);
      await pressC(c);
      // (tab 5 of a project with no record: the tab alone)
      expect(opens()).toBe(`http://127.0.0.1:4567/?tab=${tab}#t=${FAKE_TOKEN}`);
    }
  });

  it('the query goes before the fragment, beside a query there; anything but names and plain values is not passed', async () => {
    expect(withQuery(`http://127.0.0.1:1/#t=${FAKE_TOKEN}`, 'tab=tools')).toBe(`http://127.0.0.1:1/?tab=tools#t=${FAKE_TOKEN}`);
    expect(withQuery('http://127.0.0.1:1/?a=b#t=x', 'tab=tools')).toBe('http://127.0.0.1:1/?a=b&tab=tools#t=x');
    expect(withQuery('http://127.0.0.1:1/', 'tab=tools')).toBe('http://127.0.0.1:1/?tab=tools');
    const { companion } = workbench('companion-query');
    for (const odd of ['tab=tools#x', 'tab=<b>', 'tab=a b', '&tab=tools', 'tab']) {
      await companion.show(odd);
      expect(opens()).toBe(`http://127.0.0.1:4567/#t=${FAKE_TOKEN}`);
    }
  });
});
