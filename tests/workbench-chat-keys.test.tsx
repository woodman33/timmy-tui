// R10 CHAT CHECKPOINT (H167): the Chat screen's keys, through the Workbench's own Controller (Controller.frame, the rows Ink
// prints) as `timmy workbench` makes it (opensOn: 'chat'), over a real Timmy home in a temporary folder whose chat is the local
// route with a FAKE model chosen. It opens on Chat, the conversation having the keyboard; Enter writes, Esc leaves the
// composer with the draft kept; Tab moves the rail → the conversation → Models → the bottom; the bottom's Logs opens its drawer
// over the conversation, Esc closes it and the keyboard stays on Logs, the draft kept (the target's check); Enter in the
// conversation gives the draft back; M gives Models the keyboard and Esc gives it back to the conversation.
//
// FAKE here: the openers and the servers (nothing is opened or started), the run detail's and the chat session's producers
// (none: no turn is sent), the Ollama the setup's deps would ask (a FAKE list, no request) and the catalog (none).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createProject, projectId, saveActiveProject } from '../src/project/index.js';
import { copyStarter } from '../src/project/starters.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import { Controller } from '../src/workbench/controller.js';
import { glyphsFor } from '../src/workbench/frame.js';
import { CompanionControl, StudioControl, type Opener } from '../src/workbench/servers.js';
import type { Line } from '../src/workbench/text.js';

const FAKE_OPENER: Opener = { program: null, open: () => ({ ok: false, why: 'FAKE opener: nothing is opened in this test' }) };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rowText = (l: Line): string => l.map((s) => s.text).join('');
const cols = (row: string, from: number, to: number) => [...row].slice(from, to + 1).join('').trimEnd();
const ENTER = { return: true };
const ESC = { escape: true };
const TAB = { tab: true };
const RIGHT = { rightArrow: true };

let box = '';
let jobsDir = '';
const opened: Controller[] = [];
const spaces: Workspace[] = [];
beforeAll(() => {
  box = mkdtempSync(join(tmpdir(), 'wb-chat-keys-'));
  jobsDir = join(box, 'jobs');
  mkdirSync(jobsDir, { recursive: true });
});
afterAll(() => { rmSync(box, { recursive: true, force: true }); });
afterEach(async () => {
  for (const c of opened.splice(0)) c.dispose();
  for (const ws of spaces.splice(0)) await ws.close({ by: 'as the test ended' });
  vi.unstubAllEnvs();
});

/** A Timmy home of its own (`name`), its chat the local route with the FAKE model chosen (the setup's record, as timmy init
 *  --chat local --model writes it) or, `model` false, with none chosen; its Ollama an address nothing listens on (the deps'
 *  FAKE list stands in for it); and a tray project. */
function homeWithModel(name: string, model = true): { name: string; root: string; chosen: boolean } {
  const home = join(box, name);
  mkdirSync(home, { recursive: true });
  vi.stubEnv('TIMMY_HOME', home);
  vi.stubEnv('TIMMY_SETTINGS_DIR', join(box, 'settings'));
  vi.stubEnv('OPENROUTER_API_KEY', '');
  vi.stubEnv('TIMMY_WORKBENCH_CHAT', '');
  vi.stubEnv('TIMMY_CHAT_MODEL', '');
  writeFileSync(join(home, 'providers.json'), JSON.stringify({ ollama_host: 'http://127.0.0.1:9' }));
  writeFileSync(join(home, 'setup.json'), JSON.stringify({ version: 1, by: 'timmy init', answers: { operator: 'Sample', ollama: 'http://127.0.0.1:9', project: name, chat: 'local', ...(model ? { model: 'fake-qwen3:8b' } : {}) } }));
  const made = createProject(name);
  if ('error' in made) throw new Error(made.error);
  const copied = copyStarter('tray-workflow', made.root);
  if ('error' in copied) throw new Error(copied.error);
  saveActiveProject(made);
  return made;
}

function workbench(p: { name: string; root: string; chosen: boolean }): Controller {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.TIMMY_STORE;
  const ws = new Workspace({ glyphs: glyphSet(true), env, onPath: () => null, notify: () => undefined, openWeb: () => '', link: (t) => t, seal: () => undefined, jobsDir, recoverAtStart: false, chdir: () => undefined }, p);
  spaces.push(ws);
  const c = new Controller({
    env, jobsDir, onPath: () => null, glyphs: glyphsFor(true), workspace: ws, opensOn: 'chat',
    producers: { runDetail: async () => ({ ok: false, why: 'FIXTURE: none' }), openChat: async () => ({ ok: false, why: 'FIXTURE: no chat session in this test' }) },
    setup: {
      ollama: async () => ({ where: 'FAKE Ollama', answered: true, models: [{ name: 'fake-qwen3:8b', facts: 'local weights · 8B · Q4_K_M' }], listed: 1, cloud: 0 }),
      catalog: async () => ({ from: 'none', at: null, models: [] }),
    },
    companion: new CompanionControl({ opener: FAKE_OPENER, start: async () => { throw new Error('FAKE: no server is started in this test'); } }),
    studio: new StudioControl({ env: process.env, opener: FAKE_OPENER, project: () => ws.project, projectId, jobsDir, receipts: () => join(box, 'store'), ensure: async () => ({ state: 'failed', error: 'FAKE: no Studio in this test' }) }),
    capabilities: async () => [], tickMs: 100, slowMs: 3_600_000,
  });
  opened.push(c);
  return c;
}

/** The frame at 122x37 (drawn, so the next key meets the screen as shown), its rows as text. */
const shown = (c: Controller): string[] => c.frame(122, 37).screen.map(rowText);
/** One key, then the frame (the Controller reads keys against the last frame drawn). */
function press(c: Controller, input: string, k: Record<string, boolean> = {}): string[] {
  c.key(input, k);
  return shown(c);
}

describe('the Chat screen\'s keys (R10 CHAT H167): opens on Chat; the draft, Tab, the Logs drawer and Models give the keyboard back', { timeout: 60_000 }, () => {
  it('opens on Chat with the conversation\'s zone; Enter writes and Esc keeps the draft; Logs\' drawer and Esc keep it and the keyboard on Logs; Enter gives the draft back; M and Esc', () => {
    const c = workbench(homeWithModel('keys'));
    let t = shown(c);
    expect(c.ui.page).toBe('chat');
    expect(c.ui.focus).toBe('center');
    expect(cols(t[4], 20, 89)).toBe('CHAT / keys');
    expect(cols(t[1], 20, 121)).toBe('NEXT / Ollama local / FAKE fake-qwen3:8b');
    // Enter writes; Esc leaves the composer, what was typed kept as the draft
    t = press(c, '\r', ENTER);
    expect(c.ui.input.field).toBe('composer');
    t = press(c, 'kept words');
    expect(cols(t[30], 20, 89)).toMatch(/^┃ kept words +┃$/);
    t = press(c, '', ESC);
    expect(c.ui.input.field).toBeNull();
    expect(c.ui.draft).toBe('kept words');
    expect(c.ui.focus).toBe('center');
    expect(cols(t[29], 20, 89)).toBe('draft: kept words');
    // Tab: Models, then the bottom; → to Logs (the seventh control); Enter opens its drawer over the conversation
    press(c, '', TAB);
    expect(c.ui.focus).toBe('right');
    press(c, '', TAB);
    expect(c.ui.focus).toBe('bottom');
    for (let i = 0; i < 6; i++) press(c, '', RIGHT);
    expect(c.ui.cursor.shellBottom).toBe(6);
    t = press(c, '\r', ENTER);
    expect(c.ui.shellDrawer).toBe('logs');
    expect(cols(t[4], 20, 89)).toMatch(/^LOGS \/ this computer +\[ Close \]$/);
    expect(cols(t[29], 20, 89)).toBe('draft: kept words');
    // Esc closes it: the keyboard stays on Logs, the draft kept
    t = press(c, '', ESC);
    expect(c.ui.shellDrawer).toBeUndefined();
    expect(c.ui.focus).toBe('bottom');
    expect(c.ui.cursor.shellBottom).toBe(6);
    expect(c.ui.draft).toBe('kept words');
    expect(cols(t[4], 20, 89)).toBe('CHAT / keys');
    // Tab on round to the conversation (the rail first); Enter gives the draft back in the composer
    press(c, '', TAB);
    expect(c.ui.focus).toBe('nav');
    press(c, '', TAB);
    expect(c.ui.focus).toBe('center');
    t = press(c, '\r', ENTER);
    expect(c.ui.input).toEqual({ field: 'composer', text: 'kept words' });
    // text typed in the composer never fires a shortcut: M is a letter there
    t = press(c, ' M');
    expect(c.ui.input.text).toBe('kept words M');
    expect(c.ui.focus).toBe('center');
    press(c, '', ESC);
    // M outside it: Models has the keyboard; Esc gives it back to the conversation
    press(c, 'M');
    expect(c.ui.focus).toBe('right');
    press(c, '', ESC);
    expect(c.ui.focus).toBe('center');
    expect(c.ui.draft).toBe('kept words M');
  });

  it('no model: the first run\'s question, Continue without a model; a send that cannot go keeps what was typed and says what it needs', () => {
    const c = workbench(homeWithModel('nomodel', false));
    let t = shown(c);
    expect(cols(t[4], 20, 89)).toBe('WELCOME TO TIMMY');
    // ↓ ↓ ↓ to Continue without a model; Enter
    for (let i = 0; i < 3; i++) press(c, '', { downArrow: true });
    expect(cols(shown(c)[19], 20, 89)).toBe('> [ Continue without a model ]');
    t = press(c, '\r', ENTER);
    expect(c.ui.firstRunDone).toBe(true);
    expect(cols(t[7], 20, 89)).toBe('A model is optional until you need an answer.');
    // ↓ ↓ to Write a draft; Enter opens the composer
    press(c, '', { downArrow: true });
    t = press(c, '', { downArrow: true });
    expect(cols(t[13], 20, 89)).toBe('> [ Write a draft ]');
    press(c, '\r', ENTER);
    expect(c.ui.input).toEqual({ field: 'composer', text: '' });
    t = press(c, 'hello there');
    t = press(c, '\r', ENTER);
    expect(c.ui.input).toEqual({ field: 'composer', text: 'hello there' });
    // (the session is still being looked for here, so that is what the notice says; either way the text stays)
    expect(c.ui.flash?.text).toMatch(/^Not sent( yet)?: .*What you typed stays here/);
    expect(c.ui.draft).toBeUndefined();
  });

  it('the mouse selects (never opens or acts): a rail item, a model of Models, a control of the bottom; the zone under it gets the keyboard', async () => {
    const c = workbench(homeWithModel('mouse'));
    c.ui.mouse = true;
    let t = shown(c);
    // (1-based cells, as the terminal reports them) the rail's Studio, row 11
    const click = (col: number, row: number): string[] => { c.mouse({ button: 0, x: col + 1, y: row + 1, press: true }); return shown(c); };
    expect(cols(t[11], 0, 17)).toBe('   Studio');
    t = click(5, 11);
    expect(c.ui.focus).toBe('nav');
    expect(c.ui.page).toBe('chat');
    expect(c.ui.cursor.rail).toBe(3);
    // the bottom's [Budget] (its cells in the actions row)
    const budgetAt = [...t[35]].join('').indexOf('[Budget]');
    t = click(budgetAt + 2, 35);
    expect(c.ui.focus).toBe('bottom');
    expect(c.ui.cursor.shellBottom).toBe(4);
    expect(c.ui.shellDrawer).toBeUndefined();
    // Models' model row (the FAKE list's one, once the deps' FAKE list is read)
    const modelRow = (rows: string[]): number => rows.findIndex((r) => cols(r, 92, 121) === '> FAKE fake-qwen3:8b');
    for (const end = Date.now() + 10_000; Date.now() < end && modelRow(t) < 0; await sleep(20)) t = shown(c);
    const row = modelRow(t);
    expect(row, t.join('\n')).toBeGreaterThan(0);
    click(95, row);
    expect(c.ui.focus).toBe('right');
    expect(c.ui.cursor['right:models']).toBe(0);
  });
});
