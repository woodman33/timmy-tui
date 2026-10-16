// R5 (H131): the Chat tab and a chat turn, after the R5 QA round (defects 1, 8, 9, 21 and 22): a turn being answered runs (row
// 2's run state and Stop current, Activity and the event log count and name it; Send waits; Stop the turn is the next step);
// Esc means one thing at a time and says which; x stops this Workbench's own turn and only names another surface's; the event
// log lists the project's sealed turns with their receipts; the pipeline row shows the newest operation, a turn included; the
// conversation follows its newest rows; the newest exchange is said once; a chat that is not set up gives one remedy.
//
// Drawn by the Workbench's own frame (Controller.frame, the rows Ink prints) over a real Timmy home in a temporary folder: a
// tray-workflow project made by the starter code, the REPL's own Workspace and operation log, and turn receipts sealed for real
// (signed and chained) by sealTurn into the project's pinned store.
//
// FAKE or FIXTURE here, each labelled where it is made:
// - the chat session is a FIXTURE in the contract's shape: it answers without any model and says so; it keeps its exchange in
//   the project's .sessions as the real session does (ConversationManager), and holds no turn hold;
// - a turn being answered in the REPL is a hold this test takes with the REPL's own takeTurnHold (no REPL runs);
// - the sealed turns' facts are FIXTURE: no model answered them; their message and answer are sealed as hashes only;
// - the run detail's producer has none; the browser opener and the server starts are FAKE (nothing presses Show).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { projectStore } from '../src/agent/chat-session.js';
import { takeTurnHold } from '../src/agent/chat-turn.js';
import { ConversationManager } from '../src/agent/conversation.js';
import type { ChatSession, ChatTurnHooks, OpenChatSession } from '../src/contracts/chat-session.js';
import { inOperationId } from '../src/ops/context.js';
import { createProject, projectId, saveActiveProject } from '../src/project/index.js';
import { copyStarter } from '../src/project/starters.js';
import type { ApprovalRequest, Decision } from '../src/repl/approvals.js';
import { sealTurn, type TurnFacts } from '../src/repl/seal.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import { visibleWidth } from '../src/term/width.js';
import { appendReceipt, readChain } from '../src/utils/receipts.js';
import { Controller } from '../src/workbench/controller.js';
import { glyphsFor, screenText } from '../src/workbench/frame.js';
import { routeOf } from '../src/workbench/hub.js';
import type { Producers } from '../src/workbench/producers.js';
import { CompanionControl, StudioControl, type Opener } from '../src/workbench/servers.js';
import { pageActions } from '../src/workbench/views.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FAKE_OPENER: Opener = { program: null, open: () => ({ ok: false, why: 'FAKE opener: nothing is opened in this test' }) };

let box = '';
let home = '';
let jobsDir = '';
const opened: Controller[] = [];
const spaces: Workspace[] = [];

beforeAll(() => {
  box = mkdtempSync(join(tmpdir(), 'wb-chat-turn-'));
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

function trayProject(name: string): { name: string; root: string; chosen: boolean } {
  const made = createProject(name);
  if ('error' in made) throw new Error(made.error);
  const copied = copyStarter('tray-workflow', made.root);
  if ('error' in copied) throw new Error(copied.error);
  saveActiveProject(made);
  return made;
}

/** The project's store, pinned in its folder: the chain the Workbench reads when TIMMY_STORE is not set. */
function pinStore(root: string): void {
  mkdirSync(join(root, '.timmy'), { recursive: true });
  writeFileSync(join(root, '.timmy', 'store-pin'), join(root, '.timmy', 'receipts'));
}

/** FIXTURE: a chat session in the contract's shape. Each message is held until `release` (or Esc, through its signal); it keeps
 *  its exchange in the project's .sessions, as the real session does; no model answers. With `seal`, an answered turn's receipt
 *  is sealed as every surface's is (sealTurn, into the project's store, within the operation the Workbench runs it in), with
 *  FIXTURE facts. */
function fixtureChat(root: string, answerOf: (text: string) => string = (t) => `FIXTURE answer to: ${t}`, o: { seal?: { name: string } } = {}) {
  const state: { release: (() => void) | null; sent: string[] } = { release: null, sent: [] };
  const conv = new ConversationManager(join(root, '.sessions'));
  const openChat: OpenChatSession = async () => {
    const session: ChatSession = {
      route: () => ({ kind: 'local', words: 'chat: FIXTURE route', ready: true }),
      sendOnce: async (_key: string, text: string, hooks: ChatTurnHooks) => session.send(text, hooks),
      send: async (text: string, hooks: ChatTurnHooks) => {
        state.sent.push(text);
        if (!conv.current) conv.startNew();
        conv.appendMessage({ role: 'user', content: text });
        hooks.onText('FIXTURE: the first words');
        await new Promise<void>((resolve) => { state.release = resolve; hooks.signal?.addEventListener('abort', () => resolve()); });
        state.release = null;
        if (hooks.signal?.aborted) return { status: 'cancelled', text: 'FIXTURE: the first words', lines: ['Cancelled: nothing was sent to any model.'], sent: false, costWords: 'no charge (FIXTURE: no model)' };
        const answer = answerOf(text);
        conv.appendMessage({ role: 'assistant', content: answer });
        hooks.onText(answer);
        const receipt = o.seal
          ? sealTurn({ prompt: text, answer, steps: 0, spend: 0, costMeasured: false, ms: 300, status: 'ok', surface: 'workbench', model: 'fixture/chat-model', project: o.seal.name, projectId: projectId(root) }, projectStore(root)).hash
          : 'fixture1';
        return { status: 'answered', text: answer, sent: false, receipt, costWords: 'no charge (FIXTURE: no model)' };
      },
    };
    return session;
  };
  return { state, producers: { runDetail: async () => ({ ok: false, why: 'FIXTURE: no run detail in this test' }), openChat: async () => ({ ok: true, value: openChat }) } as Producers };
}

function workbench(project: { name: string; root: string; chosen: boolean }, producers: Producers): { c: Controller; ws: Workspace } {
  let c: Controller | undefined;
  // as `timmy workbench` runs with no TIMMY_STORE: the project's own store is the chain it reads
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.TIMMY_STORE;
  const ws = new Workspace({
    glyphs: glyphSet(true), env, onPath: () => null,
    notify: (l) => c?.say(l.map((s) => s.text).join('').trim()), openWeb: () => '', link: (t) => t,
    seal: (input) => appendReceipt('runs', input).hash.slice(7, 15), receipts: () => readChain('runs'),
    jobsDir, recoverAtStart: false, chdir: () => undefined,
    askPerson: (req: ApprovalRequest): Promise<Decision> => (c ? c.askPerson(req) : Promise.resolve('deny')),
  }, project);
  spaces.push(ws);
  c = new Controller({
    env, jobsDir, onPath: () => null, glyphs: glyphsFor(true), workspace: ws, producers,
    companion: new CompanionControl({ opener: FAKE_OPENER, start: async () => { throw new Error('FAKE: no server is started in this test'); } }),
    studio: new StudioControl({ env: process.env, opener: FAKE_OPENER, project: () => ws.project, projectId, jobsDir, receipts: () => join(box, 'store'), ensure: async () => ({ state: 'failed', error: 'FAKE: no Studio in this test' }) }),
    capabilities: async () => [], tickMs: 100, slowMs: 400,
  });
  opened.push(c);
  return { c, ws };
}

async function until<T>(what: string, get: () => T | undefined | false | null, ms = 10_000, show?: () => string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}${show ? `:\n${show()}` : ''}`);
    await sleep(50);
  }
}

/** One region's words as drawn at 160x45, its rows joined; the top region through its bottom edge (the run state and Stop). */
function region(c: Controller, name: 'top' | 'center' | 'right' | 'bottom', columns = 160, rows = 45): string {
  const fr = c.frame(columns, rows);
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

const screen = (c: Controller, columns = 160, rows = 45): string => screenText(c.frame(columns, rows).screen).join('\n');
const ENTER = { return: true };
const ESC = { escape: true };

/** The composer open on the Chat tab, the session ready (Tab to the conversation, then Enter, as a person does). */
async function composer(c: Controller): Promise<void> {
  c.selectPage('chat');
  await until('the chat session', () => c.can().chat, 10_000, () => screen(c));
  c.ui.focus = 'center';
  c.key('\r', ENTER);
  expect(c.ui.input.field).toBe('composer');
}

describe('the Chat tab and a chat turn (R5 H131, the QA round)', () => {
  it('a turn being answered here runs (defect 1): row 2, Activity and the event log count and name it; Send waits and Stop the turn is the next step; Esc stops it and keeps the composer, Esc again leaves it, each saying which', async () => {
    sandbox();
    const p = trayProject('turn-runs');
    const chat = fixtureChat(p.root);
    const { c } = workbench(p, chat.producers);
    c.start();
    await composer(c);
    c.key('hello there', {});
    c.key('\r', ENTER);
    await until('the turn being answered', () => c.data.turn?.state === 'sending' && c.data.turn.answer, 10_000, () => screen(c));

    // row 2's bottom edge: the run state counts it and names it; Stop current names it, with x
    expect(region(c, 'top')).toContain('run: 1 running (the chat turn)');
    expect(region(c, 'top')).toContain('[x] Stop current: the chat turn being answered here');
    // Activity counts it; the event log beside the conversation lists it under Running now
    expect(region(c, 'bottom')).toMatch(/Activity \S* ?1 running \(the chat turn\)/);
    expect(region(c, 'right')).toContain('RUNNING NOW (1)');
    expect(region(c, 'right')).toMatch(/▶ running chat turn being answered in this Workbench/);
    expect(region(c, 'right')).not.toContain('Nothing runs.');
    // the Chat tab's actions as of now: Send waits; Stop the turn is the one primary next step, available
    const acts = pageActions(c).acts;
    const send = acts.find((a) => routeOf(a).kind === 'composer')!;
    const stop = acts.find((a) => routeOf(a).kind === 'abort')!;
    expect(send).toMatchObject({ enabled: false, primary: false });
    expect(send.why).toContain('one turn at a time: a turn is being answered in this Workbench');
    expect(stop).toMatchObject({ enabled: true, primary: true });
    expect(acts.filter((a) => a.primary)).toHaveLength(1);
    // the conversation says it once, being answered, and what Esc does now (one meaning)
    const center = region(c, 'center');
    expect(center).toContain('BEING ANSWERED NOW');
    expect(center).toContain('You: hello there');
    expect(center).toContain('Esc stops the turn being answered · Enter sends once it is answered');
    expect(center).not.toContain('Esc leaves the composer');
    // the pipeline row: the newest operation is this turn
    expect(screen(c)).toMatch(/newest operation chat turn in the Workbench · operation o[0-9a-f]{8} · being answered now/);

    // Esc: the turn stops; the composer stays open, and the notice says so
    c.key('', ESC);
    expect(c.ui.input.field).toBe('composer');
    expect(c.ui.flash?.text).toBe('Esc: stopping the chat turn being answered. The composer stays open (Esc again leaves it).');
    await until('the turn stopped', () => c.data.turn?.state === 'cancelled', 10_000, () => screen(c));
    expect(region(c, 'top')).toContain('run: idle');
    expect(region(c, 'top')).toContain('Stop current: idle');
    expect(region(c, 'right')).toContain('RUNNING NOW (0)');
    expect(region(c, 'center')).toContain('Enter sends · Esc leaves the composer');
    // Esc again: it leaves the composer, and says so
    c.key('', ESC);
    expect(c.ui.input.field).toBe(null);
    expect(c.ui.flash?.text).toBe('Esc: left the composer. Enter opens it again.');
    expect(chat.state.sent).toEqual(['hello there']);
  }, 30_000);

  it('x stops this Workbench\'s own turn; a turn being answered in the REPL is counted and named with where it stops, and neither x nor Enter on Stop the turn touches it', async () => {
    sandbox();
    const p = trayProject('turn-stop');
    const chat = fixtureChat(p.root);
    const { c } = workbench(p, chat.producers);
    c.start();
    await composer(c);
    c.key('stop me', {});
    c.key('\r', ENTER);
    await until('the turn being answered', () => c.data.turn?.state === 'sending' && c.data.turn.answer, 10_000, () => screen(c));
    // x (Stop current), from outside the composer: this Workbench's own turn
    await c.stop();
    expect(c.ui.flash?.text).toBe('Stopping the chat turn being answered here (x)…');
    await until('the turn stopped', () => c.data.turn?.state === 'cancelled', 10_000, () => screen(c));
    c.key('', ESC);

    // a turn being answered in the REPL (its hold, taken by this test with the REPL's own takeTurnHold): the frame names it
    const held = takeTurnHold(p.root, 'repl');
    if (!held.ok) throw new Error(held.lines.join(' '));
    try {
      c.refresh();
      await until('the frame naming the REPL\'s turn', () => c.data.frame?.activity.chatTurn?.surface === 'repl', 10_000, () => screen(c));
      expect(region(c, 'top')).toContain('run: 1 running (the chat turn in the REPL)');
      expect(region(c, 'top')).toContain('Stop current: the chat turn in the REPL (it stops there)');
      expect(region(c, 'top')).not.toContain('[x] Stop current');
      expect(region(c, 'right')).toMatch(/▶ running chat turn being answered in the REPL · \S+ s · it stops there/);
      await c.stop();
      expect(c.ui.flash?.text).toBe('Stop current: the chat turn is being answered in the REPL; it stops there (Esc in its composer, Ctrl+C in the REPL), not from here.');
      // Stop the turn is the frame's next step; Enter on it says where it stops, and stops nothing here
      const stop = pageActions(c).acts.find((a) => routeOf(a).kind === 'abort')!;
      expect(stop).toMatchObject({ enabled: true, primary: true });
      await c.runAction(stop);
      expect(c.ui.flash?.text).toBe('The chat turn is being answered in the REPL; it stops there (Esc in its composer, Ctrl+C in the REPL), not from here.');
    } finally {
      held.hold.release();
    }
    c.refresh();
    await until('the frame with no turn', () => c.data.frame && !c.data.frame.activity.chatTurn, 10_000, () => screen(c));
    expect(region(c, 'top')).toContain('run: idle');
  }, 30_000);

  it('the conversation\'s own events (defect 8): the event log lists sealed turns with their receipts; the pipeline row shows the turn just answered; a long answer is followed to its end, its receipt and the composer; the exchange is said once (21)', async () => {
    sandbox();
    const p = trayProject('turn-events');
    pinStore(p.root);
    // a turn of the REPL sealed earlier in this project (FIXTURE facts), in an operation with its record
    const ws0 = new Workspace({ glyphs: glyphSet(true), env: process.env, onPath: () => null, notify: () => undefined, openWeb: () => '', link: (t) => t, seal: () => undefined, jobsDir, recoverAtStart: false, chdir: () => undefined }, p);
    spaces.push(ws0);
    const h = ws0.ops.begin({ request: 'FIXTURE: an earlier question', via: 'repl', root: p.root, project: p.name, record: true });
    const facts: TurnFacts & { model: string } = { prompt: 'FIXTURE prompt', answer: 'FIXTURE answer', steps: 0, spend: 0, costMeasured: false, ms: 900, status: 'ok', surface: 'repl', model: 'fixture/chat-model', project: p.name, projectId: projectId(p.root) };
    const sealed = inOperationId(h.id, () => sealTurn(facts, projectStore(p.root)));
    expect(sealed.verified).toBe(true);

    // the answer is long: the conversation is taller than its column
    const long = Array.from({ length: 40 }, (_, i) => `FIXTURE line ${i + 1} of a long answer.`).join('\n');
    const chat = fixtureChat(p.root, () => long, { seal: { name: p.name } });
    const { c } = workbench(p, chat.producers);
    c.start();
    c.selectPage('chat');
    // the event log: the sealed turn, with its receipt (hashes only: no word of its message)
    await until('the sealed turn in the event log', () => region(c, 'right').includes(`[chat] turn answered in the REPL · fixture/chat-model · receipt ${sealed.id}`), 10_000, () => screen(c));
    expect(region(c, 'right')).not.toContain('FIXTURE prompt');
    // the pipeline row: the newest operation is that turn, its receipt verified here
    expect(screen(c)).toMatch(new RegExp(`newest operation chat turn in the REPL · operation ${h.id}`));
    expect(screen(c)).toContain(`sealed ${sealed.id} · verified here`);

    await composer(c);
    c.key('a long one, please', {});
    c.key('\r', ENTER);
    await until('the answer', () => c.data.turn?.state === 'sending' && chat.state.release, 10_000, () => screen(c));
    chat.state.release!();
    await until('the answered turn', () => c.data.turn?.state === 'answered', 10_000, () => screen(c));
    // the view follows: the answer's last line, its receipt and the composer are on screen
    const center = region(c, 'center');
    expect(center).toContain('FIXTURE line 40 of a long answer.');
    const mine = c.data.turns?.[0];
    expect(mine).toMatchObject({ surface: 'workbench', state: 'answered', operation: c.data.turn?.operation });
    expect(center).toContain(`answered · nothing was sent to any model · no charge (FIXTURE: no model) · receipt ${mine!.receipt}`);
    expect(center).toContain('Enter sends · Esc leaves the composer');
    expect(screen(c)).toMatch(/(\d+)–(\d+) of \2 [╮┓]/);
    // said once: kept in the conversation, it is not said again under "Your last message here" (a terminal tall enough to show
    // the whole conversation)
    const whole = region(c, 'center', 160, 120);
    expect(whole).toContain('FIXTURE line 1 of a long answer.');
    expect(whole).not.toContain('YOUR LAST MESSAGE HERE');
    expect(whole.match(/a long one, please/g)).toHaveLength(1);
    expect(whole.match(/FIXTURE line 40 of a long answer\./g)).toHaveLength(1);
    // the pipeline row shows the turn just answered (this Workbench's), not the earlier one; the event log lists it first
    expect(screen(c)).toContain(`newest operation chat turn in the Workbench · operation ${c.data.turn!.operation}`);
    expect(screen(c)).toContain(`sealed ${mine!.receipt} · verified here`);
    expect(region(c, 'right')).toMatch(new RegExp(`EVENT LOG, NEWEST AT THE TOP \\S+ \\[chat\\] turn answered in the Workbench · fixture/chat-model · receipt ${mine!.receipt}`));
  }, 30_000);

  it('a chat that is not set up gives one remedy (defect 22): the route\'s cause, and the frame\'s fix (its Chat action, timmy init)', async () => {
    sandbox();
    const p = trayProject('turn-setup');
    const { c } = workbench(p, { runDetail: async () => ({ ok: false, why: 'FIXTURE: none' }), openChat: async () => ({ ok: false, why: 'FIXTURE: no chat session in this test' }) });
    c.start();
    c.selectPage('chat');
    await until('the frame', () => c.data.frame, 10_000, () => screen(c));
    const center = region(c, 'center');
    expect(c.data.route.ready).toBe(false);
    // R5 (H131; the finish line, item 3): the Ready line names the frame's one fix, the primary Chat action (timmy init
    // --chat openrouter, which Enter shows with what it asks); `timmy setup` makes a governed workspace's folders, asks nothing
    expect(center).toContain('Ready not ready: set up chat: an OpenRouter key (asked hidden) or a local model (workflow action 2, row 2)');
    expect(center).not.toContain('timmy setup');
    expect(center).not.toMatch(/Try: |\/setup|\/model|timmy init --chat/);
    expect(region(c, 'top')).not.toMatch(/\/setup|\/model/);
    // the frame's own action says the same step
    const send = pageActions(c).acts.find((a) => routeOf(a).kind === 'composer')!;
    // R5 lead (c2de0f9): the frame's step is timmy init (the setup's questions); `timmy setup` scaffolds a folder
    expect(send.why).toContain('timmy init --chat openrouter');
  }, 30_000);
});
