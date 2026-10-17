// R7 (H150; H148's N3, REMAINING-DEFECTS row 5; the operator, 2026-10-16: "Fix Enter unexpectedly stopping another surface's
// turn and the contradictory running/idle state afterward"). While another surface answers a turn, the chat tab's Stop the
// turn is done where that turn was sent (the frame's WorkspaceAction.doneIn, src/contracts/workspace.ts): the Workbench shows
// it and where it is done, and never runs it on any key. 2 → Enter opens the composer (the README's "2 → Enter → type"):
// typing goes there, and sending waits, one turn at a time per project, said plainly. x, the Workbench's own way to stop
// another surface's turn, asks first and names the surface. The refusal, the run line and RUNNING NOW read one answer
// (src/workbench/hub.ts chatTurnNow): no screen says a turn is being answered while it also says nothing runs.
//
// Drawn by the Workbench's own frame (Controller.frame) over a real Timmy home in a temporary folder: a tray-workflow project
// made by the starter code and the REPL's own Workspace; turn receipts sealed for real (signed and chained) by sealTurn. FAKE
// or FIXTURE here, each labelled where it is made:
// - a turn being answered "in the REPL" is a hold this test takes with the REPL's own takeTurnHold (no REPL runs: the real
//   REPL's is tests/workbench-done-in-pty.test.ts); a FAKE REPL answers a stop asked of it as the REPL's own turn does
//   (watchTurnStop): a cancelled turn's receipt (FIXTURE facts) naming its turn_id and who asked, then its hold let go;
// - the chat session is a FIXTURE in the contract's shape: it answers at once without any model and says so, keeps its
//   exchange in the project's .sessions, and holds no turn hold of its own;
// - the run detail's producer has none; the browser opener and the server starts are FAKE (nothing presses Show).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { projectStore } from '../src/agent/chat-session.js';
import { takeTurnHold, watchTurnStop, type TurnHold } from '../src/agent/chat-turn.js';
import { ConversationManager } from '../src/agent/conversation.js';
import type { ChatSession, ChatTurnHooks, OpenChatSession } from '../src/contracts/chat-session.js';
import { createProject, projectId, saveActiveProject } from '../src/project/index.js';
import { copyStarter } from '../src/project/starters.js';
import { sealTurn } from '../src/repl/seal.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import { visibleWidth } from '../src/term/width.js';
import { Controller } from '../src/workbench/controller.js';
import { glyphsFor, screenText } from '../src/workbench/frame.js';
import { routeOf } from '../src/workbench/hub.js';
import type { Producers } from '../src/workbench/producers.js';
import { CompanionControl, StudioControl, type Opener } from '../src/workbench/servers.js';
import { pageActions, selectedAction } from '../src/workbench/views.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FAKE_OPENER: Opener = { program: null, open: () => ({ ok: false, why: 'FAKE opener: nothing is opened in this test' }) };
const ENTER = { return: true };
const ESC = { escape: true };

let box = '';
let home = '';
let jobsDir = '';
const opened: Controller[] = [];
const spaces: Workspace[] = [];
const holds: TurnHold[] = [];

beforeAll(() => {
  box = mkdtempSync(join(tmpdir(), 'wb-done-in-'));
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

/** FIXTURE: a chat session in the contract's shape, answering at once with no model (it says so); it holds no turn hold. */
function fixtureChat(root: string): { sent: string[]; producers: Producers } {
  const sent: string[] = [];
  const conv = new ConversationManager(join(root, '.sessions'));
  const openChat: OpenChatSession = async () => {
    const session: ChatSession = {
      route: () => ({ kind: 'local', words: 'chat: FIXTURE route', ready: true }),
      sendOnce: async (_key: string, text: string, hooks: ChatTurnHooks) => session.send(text, hooks),
      send: async (text: string, hooks: ChatTurnHooks) => {
        sent.push(text);
        if (!conv.current) conv.startNew();
        conv.appendMessage({ role: 'user', content: text });
        const answer = `FIXTURE answer (no model) to: ${text}`;
        conv.appendMessage({ role: 'assistant', content: answer });
        hooks.onText(answer);
        return { status: 'answered', text: answer, sent: false, receipt: 'fixture1', costWords: 'no charge (FIXTURE: no model)' };
      },
    };
    return session;
  };
  return { sent, producers: { runDetail: async () => ({ ok: false, why: 'FIXTURE: no run detail in this test' }), openChat: async () => ({ ok: true, value: openChat }) } };
}

/** A Workbench on the project; `slowMs` an hour (no slow reading reads the frame again on its own while a test runs). */
function workbench(p: { name: string; root: string; chosen: boolean }, producers: Producers, o: { watch?: boolean } = {}): Controller {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.TIMMY_STORE;
  const ws = new Workspace({ glyphs: glyphSet(true), env, onPath: () => null, notify: () => undefined, openWeb: () => '', link: (t) => t, seal: () => undefined, jobsDir, recoverAtStart: false, chdir: () => undefined }, p);
  spaces.push(ws);
  const c = new Controller({
    env, jobsDir, onPath: () => null, glyphs: glyphsFor(true), workspace: ws, producers,
    companion: new CompanionControl({ opener: FAKE_OPENER, start: async () => { throw new Error('FAKE: no server is started in this test'); } }),
    studio: new StudioControl({ env: process.env, opener: FAKE_OPENER, project: () => ws.project, projectId, jobsDir, receipts: () => join(box, 'store'), ensure: async () => ({ state: 'failed', error: 'FAKE: no Studio in this test' }) }),
    capabilities: async () => [], tickMs: 100, slowMs: 3_600_000,
    ...(o.watch === false ? { holdsEveryMs: 3_600_000, holdWatch: false } : {}),
  });
  opened.push(c);
  return c;
}

async function until<T>(what: string, get: () => T | undefined | false | null, ms = 10_000, show?: () => string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}${show ? `:\n${show()}` : ''}`);
    await sleep(20);
  }
}

/** One region's words as drawn at 160x45, its rows joined (the top region through its bottom edge: the run state and Stop). */
function region(c: Controller, name: 'top' | 'center' | 'right' | 'bottom'): string {
  const fr = c.frame(160, 45);
  const rect = fr.regions[name]?.rect;
  if (!rect) return '';
  const text = screenText(fr.screen);
  const out: string[] = [];
  const last = name === 'top' ? rect.y + rect.h - 1 : rect.y + rect.h - 2;
  for (let y = rect.y + 1; y <= last; y++) {
    let x = 0;
    let row = '';
    for (const ch of text[y] ?? '') { if (x > rect.x && x < rect.x + rect.w - 1) row += ch; x += visibleWidth(ch); }
    out.push(y === rect.y + rect.h - 1 ? row.replace(/[─━]/g, ' ') : row);
  }
  return out.join(' ').replace(/\s+/g, ' ');
}
const screen = (c: Controller): string => screenText(c.frame(160, 45).screen).join('\n');

/** A turn being answered "in the REPL": its hold, as the REPL takes it. With `answers`, a FAKE REPL ends it when a stop is asked
 *  of it (its receipt sealed cancelled, naming the turn and who asked; then the hold let go). `end()` ends it as answered. */
function replTurn(p: { name: string; root: string }, asked: Array<string | null>, answers = true): { hold: TurnHold; end: () => void } {
  const held = takeTurnHold(p.root, 'repl');
  if (!held.ok) throw new Error(held.lines.join(' '));
  const hold = held.hold;
  holds.push(hold);
  const facts = { prompt: 'FIXTURE: a REPL question', steps: 0, spend: 0, costMeasured: false, surface: 'repl' as const, model: 'fixture/chat-model', project: p.name, projectId: projectId(p.root), turnId: hold.id };
  const watch = answers ? watchTurnStop(p.root, hold.id, (by) => {
    asked.push(by);
    sealTurn({ ...facts, answer: '', ms: 500, status: 'cancelled', stoppedBy: by ?? 'unknown' }, projectStore(p.root));
    watch?.close();
    hold.release();
  }, 20) : null;
  // FIXTURE: the REPL's turn answered (its receipt sealed ok), then its hold let go, as the REPL's own turn ends
  const end = () => { watch?.close(); sealTurn({ ...facts, answer: 'FIXTURE: the REPL\'s answer', ms: 900, status: 'ok' }, projectStore(p.root)); hold.release(); };
  return { hold, end };
}

describe('Enter never stops another surface\'s turn; one answer for being answered and RUNNING NOW (R7 H150; H148\'s N3)', () => {
  it('2 → Enter while the REPL answers opens the composer: the REPL\'s turn goes on, nothing is asked of it; Stop the turn says it is done in the REPL', async () => {
    const p = trayProject('done-in-enter');
    const chat = fixtureChat(p.root);
    const c = workbench(p, chat.producers);
    c.start();
    await until('the frame', () => c.data.frame, 10_000, () => screen(c));
    c.selectPage('chat');
    await until('the chat session', () => c.can().chat, 10_000, () => screen(c));
    c.selectPage('home');
    const asked: Array<string | null> = [];
    const turn = replTurn(p, asked);
    await until('the frame naming the REPL\'s turn', () => c.data.frame?.activity.chatTurn?.id === turn.hold.id, 10_000, () => screen(c));
    // the frame's own step: Stop the turn, done where the turn was sent
    const framed = c.data.frame!.actions.chat.find((a) => a.label === 'Stop the turn')!;
    expect(framed).toMatchObject({ primary: true, doneIn: 'repl', command: 'Ctrl+C in the REPL that sent it' });

    // 2, then Enter (the keyboard on the actions bar, where the Workbench starts): the composer, not a stop
    expect(c.ui.focus).toBe('top');
    c.key('2', {});
    expect(c.ui.page).toBe('chat');
    const { acts, at } = selectedAction(c);
    expect(acts[at]).toMatchObject({ label: 'Send a message', enabled: true });
    expect(region(c, 'top')).toMatch(/▸\[1 Send a message\]/);
    expect(region(c, 'top')).toMatch(/\[▶ 3 Stop the turn\]/);
    // what Enter does on the selected action, said under the bar: the composer opens; sending waits for the REPL's turn
    expect(region(c, 'top')).toContain('1 Send a message · type in Chat, then Enter · Enter opens the composer: type now, sent once the turn in the REPL ends (one turn at a time per project)');
    c.key('\r', ENTER);
    expect(c.ui.input.field).toBe('composer');
    c.key('a question for later', {});
    expect(c.ui.input.text).toBe('a question for later');
    await sleep(300);
    expect(asked, 'nothing was asked of the REPL\'s turn').toEqual([]);
    expect(region(c, 'top')).toContain('run: 1 running (the chat turn in the REPL)');
    expect(region(c, 'right')).toContain('Running now (1)'.toUpperCase());

    // Enter in the composer while the REPL's turn runs: not sent, said plainly; what was typed stays in the composer
    c.key('\r', ENTER);
    await sleep(100);
    expect(chat.sent).toEqual([]);
    expect(c.ui.input).toEqual({ field: 'composer', text: 'a question for later' });
    expect(c.ui.flash?.text).toBe('Not sent yet: one turn at a time per project, and a turn is being answered in the REPL. What you typed stays here; Enter sends it once that turn has ended (RUNNING NOW 0).');

    // the cursor on Stop the turn, then Enter: nothing is stopped, and it says where it is done
    c.key('', ESC);
    expect(c.ui.input.field).toBe(null);
    c.ui.focus = 'top';
    c.key('', { rightArrow: true });
    c.key('', { rightArrow: true });
    expect(selectedAction(c).acts[selectedAction(c).at]).toMatchObject({ label: 'Stop the turn', doneIn: 'repl' });
    expect(region(c, 'top')).toContain('3 Stop the turn · Ctrl+C in the REPL that sent it · done in the REPL, not here: Enter does not stop it; x asks you first');
    c.key('\r', ENTER);
    await sleep(300);
    expect(asked).toEqual([]);
    expect(c.ui.flash?.text).toBe('3 Stop the turn is done in the REPL (Ctrl+C in the REPL that sent it): Enter here does not stop it. x asks you first, then asks it to stop there.');

    // the REPL's turn runs to its end and seals answered; then the send is accepted as soon as RUNNING NOW is 0
    turn.end();
    await until('RUNNING NOW 0', () => region(c, 'right').includes('RUNNING NOW (0)'), 5000, () => screen(c));
    expect(region(c, 'top')).toContain('run: idle');
    expect(c.data.turns?.find((t) => t.turn === turn.hold.id)).toMatchObject({ surface: 'repl', state: 'answered' });
    expect(asked).toEqual([]);
    c.selectPage('chat');
    c.ui.focus = 'center';
    c.key('\r', ENTER);
    expect(c.ui.input.field).toBe('composer');
    c.key('a question for later', {});
    c.key('\r', ENTER);
    await until('the message sent', () => chat.sent.length === 1, 5000, () => screen(c));
    expect(chat.sent).toEqual(['a question for later']);
  }, 30_000);

  it('x on another surface\'s turn asks first and names the surface: n keeps it; y asks it to stop there', async () => {
    const p = trayProject('done-in-x');
    const chat = fixtureChat(p.root);
    const c = workbench(p, chat.producers);
    c.start();
    await until('the frame', () => c.data.frame, 10_000, () => screen(c));
    const asked: Array<string | null> = [];
    const turn = replTurn(p, asked);
    await until('the run line naming the REPL\'s turn', () => region(c, 'top').includes('run: 1 running (the chat turn in the REPL)'), 5000, () => region(c, 'top'));
    expect(region(c, 'top')).toContain('[x] Stop current: the chat turn in the REPL (Ctrl+C in the REPL stops it there; x here asks you first)');
    await c.stop();
    expect(c.ui.overlay).toMatchObject({ kind: 'confirm-stop' });
    expect(screen(c)).toContain('Stop the chat turn being answered in the REPL?');
    expect(screen(c)).toContain('[y] Stop it there');
    expect(screen(c)).toContain('[n] Keep it (Esc, Enter)');
    await sleep(300);
    expect(asked, 'nothing is asked before y').toEqual([]);
    c.key('n', {});
    expect(c.ui.overlay).toBe(null);
    // the keyboard back where x was pressed (the actions bar, where the Workbench starts)
    expect(c.ui.focus).toBe('top');
    expect(c.ui.flash?.text).toBe('Kept: the chat turn in the REPL goes on (nothing was asked of it).');
    await sleep(300);
    expect(asked).toEqual([]);
    await c.stop();
    c.key('\r', ENTER);
    expect(c.ui.overlay).toBe(null);
    expect(asked).toEqual([]);
    await c.stop();
    c.key('y', {});
    expect(c.ui.flash?.text).toBe('Stop asked of the turn being answered in the REPL (x, then y): it stops there as Ctrl+C in the REPL would, and its end shows here once its receipt is sealed.');
    await until('the stop answered by the REPL', () => asked.length === 1, 5000);
    expect(asked).toEqual(['workbench']);
    await until('the run line idle', () => region(c, 'top').includes('run: idle'), 5000, () => region(c, 'top'));
    expect(c.data.turns?.find((t) => t.turn === turn.hold.id)).toMatchObject({ surface: 'repl', state: 'stopped', stoppedBy: 'workbench' });
  }, 30_000);

  it('the frame read before the REPL\'s turn ended and the holds read after: Send, the run line and RUNNING NOW say the same (no "being answered" beside "Nothing runs")', async () => {
    const p = trayProject('done-in-one');
    const chat = fixtureChat(p.root);
    const c = workbench(p, chat.producers, { watch: false });
    c.start();
    c.selectPage('chat');
    await until('the frame', () => c.data.frame, 10_000, () => screen(c));
    await until('the chat session', () => c.can().chat, 10_000, () => screen(c));
    const asked: Array<string | null> = [];
    const turn = replTurn(p, asked, false);
    c.refresh();
    await until('the frame naming the REPL\'s turn', () => c.data.frame?.activity.chatTurn?.id === turn.hold.id, 10_000, () => screen(c));
    const stale = c.data.frame!;
    // the REPL's turn ends (answered, its hold let go); this Workbench reads the holds (as its watch does), and the frame it
    // holds is the one read while the turn ran (the next reading comes at most once a second)
    turn.end();
    // x reads the holds before it answers (this Workbench's watch is off here): the turn the screen named has ended, so it
    // is asked by its identity and refused (no box: there is nothing to stop), and x says so
    await c.stop();
    expect(c.ui.overlay).toBe(null);
    expect(c.ui.flash?.text).toBe('Nothing stopped (x): that chat turn is not being answered now (it ended, or it was never this project\'s).');
    c.data.frame = stale;
    expect(c.data.frame.activity.chatTurn?.id).toBe(turn.hold.id);
    // one answer: nothing runs, so Send is offered, its refusal never says a turn is being answered
    expect(region(c, 'right')).toContain('RUNNING NOW (0)');
    expect(region(c, 'top')).toContain('run: idle');
    const send = pageActions(c).acts.find((a) => routeOf(a).kind === 'composer')!;
    expect(send).toMatchObject({ enabled: true });
    expect(send.why ?? '').not.toMatch(/being answered/);
    const stop = pageActions(c).acts.find((a) => routeOf(a).kind === 'abort')!;
    expect(stop).toMatchObject({ enabled: false, primary: false });
    expect(screen(c)).not.toMatch(/a turn is being answered in the REPL/);
    // Enter on Send: the composer (a message typed there is sent: nothing runs)
    c.ui.focus = 'top';
    await c.runAction(send);
    expect(c.ui.input.field).toBe('composer');
    c.key('right after the REPL', {});
    c.key('\r', ENTER);
    await until('the message sent', () => chat.sent.length === 1, 5000, () => screen(c));
    expect(asked).toEqual([]);
  }, 30_000);
});
