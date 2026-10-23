// R7 (H150; DESIGN.md §10 B10 "Amber is exact"; the R5 visual review's item 10, "amber key hints and commands"): the
// Workbench draws amber only for the region that has the keyboard, the active tab, the selection, the one primary next step,
// a field's prompt, .intent and .predict, a recommendation, things waiting for you, and a failure (with ✕ and its word). Keys,
// key hints and commands are in the text's colour. Read from the Workbench's own frame (Controller.frame, the rows Ink prints)
// on every tab (1 to 9 and 0) and in its boxes, each segment's colour as styleOf draws it (24-bit: amber is #FFB000), by role
// and by words.
//
// Over a real Timmy home in a temporary folder: a tray-workflow project made by the starter code and the REPL's own
// Workspace. FAKE or FIXTURE here, each labelled where it is made: a turn being answered "in the REPL" is a hold this test
// takes with the REPL's own takeTurnHold (no REPL runs); a NEEDS YOU box asks for a FIXTURE request (nothing runs: it is
// denied); the run detail's and the chat session's producers have none; the browser opener and the server starts are FAKE.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { takeTurnHold, type TurnHold } from '../src/agent/chat-turn.js';
import { TABS } from '../src/contracts/workspace.js';
import { createProject, projectId, saveActiveProject } from '../src/project/index.js';
import { copyStarter } from '../src/project/starters.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import { HOMEBREW } from '../src/theme/tokens.js';
import { Controller } from '../src/workbench/controller.js';
import { glyphsFor } from '../src/workbench/frame.js';
import { routeOf } from '../src/workbench/hub.js';
import { CompanionControl, StudioControl, type Opener } from '../src/workbench/servers.js';
import type { Line, Seg } from '../src/workbench/text.js';
import { styleOf } from '../src/workbench/theme.js';
import { pageActions } from '../src/workbench/views.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FAKE_OPENER: Opener = { program: null, open: () => ({ ok: false, why: 'FAKE opener: nothing is opened in this test' }) };

let box = '';
let home = '';
let jobsDir = '';
const opened: Controller[] = [];
const spaces: Workspace[] = [];
const holds: TurnHold[] = [];

beforeAll(() => {
  box = mkdtempSync(join(tmpdir(), 'wb-amber-'));
  home = join(box, 'timmy');
  jobsDir = join(home, 'jobs');
  mkdirSync(home, { recursive: true });
});
afterAll(() => { rmSync(box, { recursive: true, force: true }); });
afterEach(async () => {
  for (const h of holds.splice(0)) h.release();
  for (const c of opened.splice(0)) c.dispose();
  for (const ws of spaces.splice(0)) await ws.close({ by: 'as the test ended' });
  vi.unstubAllEnvs();
});

function trayProject(name: string): { name: string; root: string; chosen: boolean } {
  vi.stubEnv('TIMMY_HOME', home);
  // R10 CHAT (H167): this file checks the classic Chat tab (row 2's actions, the pipeline, the event log); the Chat screen's
  // shell that replaces it is tests/workbench-chat-shell.test.ts's
  vi.stubEnv('TIMMY_WORKBENCH_CHAT', 'classic');
  vi.stubEnv('TIMMY_SETTINGS_DIR', join(box, 'settings'));
  vi.stubEnv('OPENROUTER_API_KEY', '');
  const made = createProject(name);
  if ('error' in made) throw new Error(made.error);
  const copied = copyStarter('tray-workflow', made.root);
  if ('error' in copied) throw new Error(copied.error);
  saveActiveProject(made);
  mkdirSync(join(made.root, '.timmy'), { recursive: true });
  writeFileSync(join(made.root, '.timmy', 'store-pin'), join(made.root, '.timmy', 'receipts'));
  return made;
}

function workbench(p: { name: string; root: string; chosen: boolean }): Controller {
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

const amber = (s: Seg): boolean => { const st = styleOf(s, true, 'truecolor'); return st.color === HOMEBREW.accent || st.backgroundColor === HOMEBREW.accent; };
const rowText = (l: Line): string => l.map((s) => s.text).join('');
const BOX = /^[\s─━│┃╭╮╰╯┏┓┗┛┣┫┳┻╋┠┨┯┷┿+\-|=#]*$/;
/** A key hint: a key in brackets ([x], [Enter], [1–0], [Ctrl+C]); the primary's fill brackets are '[' and ']' alone. */
const KEY_HINT = /^\[(?:[^\]\s]{1,9}|Enter|Esc|Tab|Ctrl\+C|1–0)\]$/;
/** A command: a REPL command or a shell's timmy line, as a segment's whole text. */
const COMMAND = /^\s*(?:\/[a-z][\w-]*(?:\s|$)|timmy \w)/;

/** Every amber segment of a screen, with its row and role; and what is amber that B10 does not let be. */
function readAmber(screen: Line[]): { amber: Array<{ row: number; role: string; text: string; inverse: boolean }>; wrong: string[] } {
  const out: Array<{ row: number; role: string; text: string; inverse: boolean }> = [];
  const wrong: string[] = [];
  screen.forEach((l, row) => {
    for (const s of l) {
      if (!amber(s) || !s.text.trim()) continue;
      const role = s.role ?? 'text';
      out.push({ row, role, text: s.text, inverse: !!s.inverse });
      const at = `row ${row + 1} (${role}) "${s.text}" in "${rowText(l).trim()}"`;
      if (KEY_HINT.test(s.text.trim())) wrong.push(`a key hint is amber: ${at}`);
      if (COMMAND.test(s.text)) wrong.push(`a command is amber: ${at}`);
      // by role, what each amber role may say
      if (role === 'accent') {
        // (an .intent or .predict card's edges are amber too: B10 names those cards)
        const ok = /^(?:▸ ?|› |\/ |Name › |\[|\]|▾ ?)$/.test(s.text) || /^▶ \d /.test(s.text) || /\.intent|\.predict/.test(s.text) || /recommend/i.test(s.text)
          || (s.inverse && /^\d /.test(s.text)) || (BOX.test(s.text) && /[╭╮╰╯│┏┓┗┛┃─━]/.test(s.text));
        if (!ok) wrong.push(`accent is for the selection, the primary, a prompt, .intent/.predict or a recommendation: ${at}`);
      } else if (role === 'focus') {
        // the focused region's border and its title (◆), the active tab, a selected card's or row's title
        if (COMMAND.test(s.text)) wrong.push(`focus on a command: ${at}`);
      } else if (role === 'failure') {
        if (!/✕|failed|refused|not|could not|unreachable|error|denied|✖/i.test(rowText(l))) wrong.push(`a failure without ✕ or its word: ${at}`);
      } else if (role !== 'attention') wrong.push(`amber from a role B10 does not name: ${at}`);
    }
  });
  return { amber: out, wrong };
}

/** The primary next step's fill on the actions bar (row 2): the inverse amber segments that hold a label. */
const primaries = (screen: Line[]): string[] => screen.slice(0, 10).flatMap((l) => l.filter((s) => s.inverse && amber(s) && /^(?:▶ )?\d /.test(s.text)).map((s) => s.text));

describe('amber is exact (R7 H150; DESIGN.md §10 B10)', () => {
  it('every tab, 1 to 9 and 0, at 160x45: keys, key hints and commands are never amber; amber only where B10 says; at most one primary next step', async () => {
    const p = trayProject('amber-tabs');
    const c = workbench(p);
    c.start();
    await until('the frame', () => c.data.frame);
    const seen: Record<string, number> = {};
    for (const t of TABS) {
      c.key(t.key, {});
      await sleep(150);
      const screen = c.frame(160, 45).screen;
      const r = readAmber(screen);
      expect(r.wrong, `tab ${t.key} ${t.label}`).toEqual([]);
      expect(primaries(screen).length, `tab ${t.key}: the one primary next step`).toBeLessThanOrEqual(1);
      // the active tab is amber, and the region with the keyboard (the actions bar, where the Workbench starts)
      expect(r.amber.some((x) => x.row <= 2 && x.role === 'focus' && x.text.trim().startsWith(`${t.key} ${t.label.split(' ')[0]}`)), `tab ${t.key}: the active tab amber`).toBe(true);
      // no other tab is
      for (const o of TABS.filter((x) => x.key !== t.key)) expect(r.amber.some((x) => x.row <= 2 && x.role === 'focus' && x.text.trim().startsWith(`${o.key} `)), `tab ${t.key}: tab ${o.key} not amber`).toBe(false);
      seen[t.key] = r.amber.length;
      // key hints are drawn, in the text's colour
      const hints = screen.flatMap((l) => l.filter((s) => KEY_HINT.test(s.text.trim())));
      expect(hints.length, `tab ${t.key}: key hints drawn`).toBeGreaterThan(0);
      for (const h of hints) expect(styleOf(h, true, 'truecolor').color, `tab ${t.key}: ${h.text}`).toBe(HOMEBREW.text);
    }
    // the bar's selected action: its marker amber, what Enter does in the text's colour (R10 H167: the command itself is the
    // details', not drawn on the bar)
    c.key('3', {});
    const bar = c.frame(160, 45).screen.slice(0, 8);
    const cursor = bar.flatMap((l) => l).find((s) => s.text === '▸');
    expect(cursor && amber(cursor)).toBe(true);
    expect(bar.flatMap((l) => l).find((s) => /^\/run /.test(s.text)), 'no command drawn on the bar').toBeUndefined();
    const does = bar.flatMap((l) => l).find((s) => /^Enter opens its Run confirm/.test(s.text));
    expect(does, 'what Enter does is drawn').toBeTruthy();
    expect(amber(does!)).toBe(false);
    expect(Object.keys(seen)).toHaveLength(10);
  }, 60_000);

  it('the boxes: Keys, Switch project, Quick settings, a Run confirm, NEEDS YOU, a command to copy, x\'s box for another surface\'s turn, Quit', async () => {
    const p = trayProject('amber-boxes');
    const c = workbench(p);
    c.start();
    await until('the frame', () => c.data.frame);
    const check = (what: string): ReturnType<typeof readAmber> => {
      const screen = c.frame(160, 45).screen;
      const r = readAmber(screen);
      expect(r.wrong, what).toEqual([]);
      return r;
    };
    // a command shown to copy (tab 0's first action, /receipts: the Workbench has no path of its own for it)
    c.key('0', {});
    expect(c.ui.page).toBe('logs');
    const show = pageActions(c).acts.find((a) => routeOf(a).kind === 'show');
    expect(show, 'tab 0 has a command to copy').toBeTruthy();
    await c.runAction(show);
    expect(c.ui.overlay?.kind).toBe('message');
    let r = check('a command to copy');
    const shown = c.frame(160, 45).screen.flatMap((l) => l).find((s) => s.text === show!.command);
    expect(shown, 'the command is drawn').toBeTruthy();
    expect(amber(shown!)).toBe(false);
    c.key('', { escape: true });
    expect(c.ui.overlay).toBe(null);
    c.key('?', {});
    expect(c.ui.overlay?.kind).toBe('help');
    check('the Keys box');
    // the keys it lists are in the text's colour
    const listed = c.frame(160, 45).screen.flatMap((l) => l).filter((s) => /^(?:Ctrl\+C|Enter|Esc|Tab)\b/.test(s.text));
    expect(listed.length).toBeGreaterThan(0);
    for (const s of listed) expect(amber(s), s.text).toBe(false);
    c.key('', { escape: true });
    c.key('p', {});
    expect(c.ui.overlay?.kind).toBe('picker');
    r = check('the project picker');
    expect(r.amber.some((x) => x.role === 'accent' && x.text === '› '), 'its prompt amber (the field has the keyboard)').toBe(true);
    c.key('', { escape: true });
    c.key(',', {});
    expect(c.ui.overlay?.kind).toBe('settings');
    check('Quick settings');
    c.key('', { escape: true });
    // a Run confirm (drawn for a block of the starter's; upmd is not on this test's PATH, so Enter would not open it: the box is
    // set as Enter sets it, and nothing runs from here)
    c.ui.overlay = { kind: 'confirm-run', doc: 'APPROVAL.md', block: 'tidy', order: ['tidy'], risky: [{ name: 'tidy', command: 'rm -rf FIXTURE' }] };
    r = check('the Run confirm');
    expect(r.amber.some((x) => x.role === 'attention'), 'its "Needs you" amber').toBe(true);
    c.ui.overlay = null;
    // Quit, with nothing of its own running
    c.ui.overlay = { kind: 'quit', own: [], others: [] };
    check('the Quit box');
    c.ui.overlay = null;
    // x on a turn the REPL answers (FAKE hold): its box names the REPL
    const held = takeTurnHold(p.root, 'repl');
    if (!held.ok) throw new Error(held.lines.join(' '));
    holds.push(held.hold);
    await c.stop();
    expect(c.ui.overlay?.kind).toBe('confirm-stop');
    check('x\'s box');
    c.key('n', {});
    expect(c.ui.overlay).toBe(null);
    // NEEDS YOU (FIXTURE request; nothing runs: it is denied as the Workbench ends)
    void c.askPerson({ tool: 'FIXTURE_tool', reason: 'FIXTURE: a request to look at the box', summary: 'FIXTURE: nothing runs', session: false });
    expect(c.ui.overlay?.kind).toBe('needs-you');
    r = check('NEEDS YOU');
    expect(r.amber.some((x) => x.role === 'attention' && /NEEDS YOU/.test(x.text))).toBe(true);
    const keys = c.frame(160, 45).screen.flatMap((l) => l).filter((s) => /^\[(?:y|n)\]$/.test(s.text));
    expect(keys.length).toBe(2);
    for (const k of keys) expect(amber(k), k.text).toBe(false);
  }, 60_000);
});
