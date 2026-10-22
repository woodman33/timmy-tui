// R10 (H163; H168's pass 2a at 5f0e1d4, the terminal leftovers): what the Workbench's face says, and what its details ([i])
// keep. The operator's rule: diagnostics (addresses, ports, error codes, raw commands and ids) only behind [i] or Details;
// the essential state and the next step on the face, in words.
//
// F3: a failed chat turn's text in the conversation, in words; the address, the cause's code and the commands in [i].
// N2: the expanded log (a) follows every operation when the selected one has no events; an operation is said by what it was,
//     its id in [i].
// F4: tab 3's RUN box a plain action; /run, the block's command and upmd in [i] (tests/workbench-workflows-tab.test.ts).
// N1: one wording for a local route's price ("no charge · local"); the long forms in [i].
// N5: a stopped turn's mark and one separator; a recording's kind once; after a failed send the next step is its fix.
// F6 (the lead's addition, with H164's one turn row): Home's connections count answered turns from the frame's own.
//
// Pure functions over hand-made Data (FIXTURE records: no project on disk, nothing sent), and one case in the Workbench itself
// (its Controller over a real Timmy home in a temporary folder, the REPL's own Workspace) with a FIXTURE chat session: it
// answers nothing and gives the lines the local route gives when its Ollama does not answer (src/agent/local-chat.ts words
// them, src/agent/chat-session.ts errorLines prints them; copied here from H168's capture 122x37-send-down).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatSession, ChatTurnHooks, ChatTurnResult, OpenChatSession } from '../src/contracts/chat-session.js';
import { ConversationManager } from '../src/agent/conversation.js';
import { createProject, projectId, saveActiveProject } from '../src/project/index.js';
import { copyStarter } from '../src/project/starters.js';
import type { ApprovalRequest, Decision } from '../src/repl/approvals.js';
import { sealTurn } from '../src/repl/seal.js';
import { projectStore } from '../src/agent/chat-session.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import { visibleWidth } from '../src/term/width.js';
import { appendReceipt, readChain } from '../src/utils/receipts.js';
import { Controller } from '../src/workbench/controller.js';
import { glyphsFor, screenText } from '../src/workbench/frame.js';
import * as journey from '../src/workbench/home-journey.js';
import type { Data, Ui } from '../src/workbench/model.js';
import type { Producers } from '../src/workbench/producers.js';
import { CompanionControl, StudioControl, type Opener } from '../src/workbench/servers.js';
import { plain, type Line } from '../src/workbench/text.js';
import { bottomView, centerView, pageActions, rightView } from '../src/workbench/views.js';
import { routeOf } from '../src/workbench/hub.js';
import { actionsOf } from '../src/ops/workspace-frame.js';
import { openTarget, type JourneyRoute, type WorkItem as JourneyWorkItem } from '../src/journey/index.js';

const g = glyphsFor(true);
const NOW = Date.parse('2026-10-22T12:40:24Z');

function data(o: Partial<Data> = {}): Data {
  return {
    project: { name: 'tray', root: '/p/tray', id: 'p1', shown: '~/timmy/projects/tray' },
    projects: [], files: { total: 0, truncated: false, groups: [] }, workflows: { docs: [], upmd: true },
    jobs: [], decisions: { items: [], more: 0, total: 0, otherSetup: 0, tools: {}, operations: {}, notes: [] },
    route: { kind: 'local', words: 'chat: local fake-qwen3:8b · Ollama', ready: true },
    activity: { running: 0, waiting: 0, events: [] }, chat: { session: null, total: 0, messages: [] }, vox: [], native: {}, starters: [], boards: [],
    studio: { state: 'idle' }, overview: { state: 'idle' }, caps: { state: 'idle' }, details: {}, readAt: NOW, away: [],
    ...o,
  } as unknown as Data;
}

function ui(o: Partial<Ui> = {}): Ui {
  return {
    page: 'chat', workspace: 'chat', focus: 'center', tab: 'inspector', cursor: {}, scroll: {}, sel: {}, anchor: {}, wheel: {}, input: { field: null, text: '' },
    activityOpen: false, activityAll: false, activityFollow: true, flash: null, settings: { settings: { reducedMotion: true } },
    companion: { serving: false, address: null, last: null }, studio: { serving: false, address: null, last: null }, ...o,
  } as unknown as Ui;
}

const ctx = (d: Data, u: Ui = ui(), width = 66) => ({ ui: u, data: d, g, width, height: 40, now: NOW, can: { chat: true, run: true, detail: true } });
/** the rows' words as one line (a wrapped sentence read whole) */
const flat = (lines: readonly Line[]): string => lines.map(plain).join(' ').replace(/\s+/g, ' ');

/** FIXTURE: the lines the local route's session gives when its Ollama does not answer (H168's capture 122x37-send-down). */
const DOWN = [
  'Ollama at 127.0.0.1:4473 did not answer, so nothing was sent.',
  'Cause: the connection failed (ECONNREFUSED)',
  'Try: start Ollama (the Ollama app, or ollama serve), or /setup chat; no other model is tried.',
];
/** what the face must never say of it: the address, the port, the cause's code, the commands, the lines' labels */
const RAW = ['127.0.0.1', '4473', 'ECONNREFUSED', 'ollama serve', '/setup chat', 'Cause:', 'Try:'];

/** FIXTURE: this Workbench's last turn, failed with those lines (nothing was sent; its receipt sealed) */
const failedTurn = (o: Partial<NonNullable<Data['turn']>> = {}): NonNullable<Data['turn']> => ({
  text: 'Is Ollama there?', answer: '', state: 'failed', lines: [...DOWN], sent: false, costWords: 'no request, no cost',
  receipt: 'sha256:1a2b3c4d5e6f7a8b', model: undefined, operation: 'o1a2b3c4d', tools: [], at: NOW - 200, ended: NOW - 100, ...o,
} as NonNullable<Data['turn']>);

describe('F3: a failed chat turn in the conversation, in words (R10 H163; H168 pass 2a)', () => {
  it('says what happened, that nothing was sent and it cost nothing, and the next step, in words; never the address, the port, the code or a command', () => {
    const d = data({ turn: failedTurn(), chat: { session: 's1', total: 1, messages: [{ role: 'user', text: 'Is Ollama there?' }] } as Data['chat'] });
    const face = flat(centerView(ctx(d)).lines);
    expect(face).toContain('Ollama on this computer did not answer: nothing was sent, no cost. Start the Ollama app, then send again.');
    for (const raw of RAW) expect(face, `the face says ${raw}:\n${face}`).not.toContain(raw);
    // its state, once: failed, its receipt sealed ("nothing was sent" and "no cost" are said in the words above, not again)
    expect(face).toMatch(/failed · receipt sealed/);
    expect(face).not.toMatch(/nothing was sent to any model|no request, no cost/);
  });

  it('the same words where the conversation keeps the turn as its newest exchange', () => {
    // (a failure after the request went out, its answer kept: what came of it is said under it)
    const lines = ['Ollama at 127.0.0.1:4473 stopped answering.', 'Cause: the connection was reset (ECONNRESET)', 'Try: start Ollama and send again; no other model is tried.'];
    const turn = failedTurn({ lines, sent: true, answer: 'FIXTURE: half an answer', costWords: 'no charge (local endpoint)', model: 'fake-qwen3:8b' });
    const d = data({ turn, chat: { session: 's1', total: 2, messages: [{ role: 'user', text: 'Is Ollama there?' }, { role: 'assistant', text: 'FIXTURE: half an answer' }] } as Data['chat'] });
    const face = flat(centerView(ctx(d)).lines);
    expect(face).toContain('Ollama on this computer stopped answering. Start the Ollama app, then send again.');
    for (const raw of [...RAW, 'ECONNRESET']) expect(face, `the face says ${raw}:\n${face}`).not.toContain(raw);
    expect(face).toMatch(/failed · sent to a model · .* · fake-qwen3:8b · receipt sealed/);
  });

  it('[i] on Chat keeps them whole: the session\'s lines (the address, the cause\'s code, the commands), what it cost, its receipt and its operation', () => {
    const d = data({ turn: failedTurn(), chat: { session: 's1', total: 1, messages: [{ role: 'user', text: 'Is Ollama there?' }] } as Data['chat'] });
    const details = flat(rightView(ctx(d, ui({ rightOpen: true } as Partial<Ui>), 60)).lines);
    for (const l of DOWN) expect(details, `[i] lacks "${l}":\n${details}`).toContain(l);
    expect(details).toContain('no request, no cost');
    expect(details).toContain('1a2b3c4d');
    expect(details).toContain('o1a2b3c4d');
  });

  it('the notice says the same words (Activity\'s newest line), and an answer\'s notice is as before', () => {
    expect(typeof journey.turnEndNotice).toBe('function');
    const say = journey.turnEndNotice;
    expect(say({ status: 'failed', lines: DOWN, sent: false, costWords: 'no request, no cost', text: '' } as ChatTurnResult, g))
      .toBe('Failed: Ollama on this computer did not answer: nothing was sent, no cost. Start the Ollama app, then send again.');
    // a failure whose next step names a model: in words too (the REPL's /model is the details')
    const noModel = ['Ollama at 127.0.0.1:11434 has no model named qwen9:1b, so nothing was sent.', 'Cause: its answer: model \'qwen9:1b\' not found (Timmy downloads nothing)', 'Try: /model lists what it has; ollama pull qwen9:1b installs it; no other model is tried.'];
    const said = say({ status: 'failed', lines: noModel, sent: false, costWords: 'no request, no cost', text: '' } as ChatTurnResult, g);
    expect(said).toBe('Failed: Ollama on this computer has no model named qwen9:1b: nothing was sent, no cost. Choose a model it has, or have Ollama pull it first.');
    for (const raw of ['11434', '/model', 'ollama pull']) expect(said).not.toContain(raw);
  });
});

describe('N2: the expanded log (a) follows every operation when the selected one has no events; an operation said by what it was (R10 H163; H168 pass 2a)', () => {
  const at = (s: number) => new Date(NOW - s * 1000).toISOString();
  /** FIXTURE: Home's newest item, a stopped chat turn another session sealed (its operation has no events in this Workbench) */
  const stopped = { kind: 'turn', id: '5c0ffee1', title: 'Stop test 2: write a long answer.', when: at(900), state: 'stopped', receipt: { id: '5c0ffee1', verified: true }, fake: false, operation: 'obd0c3730', open: openTarget({ kind: 'turn', id: '5c0ffee1' }) } as unknown as JourneyWorkItem;
  const check = { at: at(30), key: 'n:1', words: 'Checked the connections: 1 of 3 asked answered (free requests only).' };
  const other = { at: at(60), key: 'n:2', words: 'Opened in the companion: the run chosen in Workflows.', operation: 'o99990000' };
  const home = (events: unknown[], o: Partial<Ui> = {}) => {
    const d = data({ recent: { project: { name: 'tray', id: 'p1' }, notes: [], items: [stopped] }, activity: { running: 0, waiting: 0, last: null, events } as unknown as Data['activity'] });
    return { d, u: ui({ page: 'home', workspace: 'connections', activityOpen: true, ...o } as Partial<Ui>) };
  };

  it('the selected item\'s operation has no events here: every operation\'s, said so, never "Operation <id>" over "No events yet"', () => {
    const { d, u } = home([check, other]);
    const v = bottomView(ctx(d, u, 118));
    const t = flat(v.lines);
    expect(t).toMatch(/All operations · none for the chat turn "Stop test 2: write a long answer\." here · following the newest/);
    expect(t).toContain('Checked the connections: 1 of 3 asked answered');
    expect(t).toContain('Opened in the companion: the run chosen in Workflows.');
    expect(t).not.toContain('No events yet');
    expect(t).not.toContain('obd0c3730');
    expect(t).not.toMatch(/\bOperation o[0-9a-f]{8}/);
  });

  it('with events of its own: only those, the operation named by what it was; [A] all operations; its id is the details\' ([i])', () => {
    // (Activity's events newest first, as the Workbench keeps them; the strip's "last:" says the newest of all)
    const own = { at: at(20), key: 'n:3', words: 'Stopped: nothing was sent to any model.', operation: 'obd0c3730' };
    const { d, u } = home([own, check, other]);
    const lines = bottomView(ctx(d, u, 118)).lines.map(plain);
    const head = lines.findIndex((l) => l.startsWith('Only '));
    const t = flat(bottomView(ctx(d, u, 118)).lines);
    expect(t).toMatch(/Only the chat turn "Stop test 2: write a long answer\." \[A\] all operations · following the newest/);
    const rows = lines.slice(head + 1).join(' ');
    expect(rows).toContain('Stopped: nothing was sent to any model.');
    expect(rows).not.toContain('Checked the connections');
    expect(t).not.toContain('obd0c3730');
    // A: every operation's, and the way back names it the same way
    const all = flat(bottomView(ctx(d, { ...u, activityAll: true } as Ui, 118)).lines);
    expect(all).toMatch(/All operations \[A\] only the chat turn "Stop test 2: write a long answer\."/);
    expect(all).toContain('Checked the connections');
    // [i]: the selected item's details name its operation by its id
    const details = flat(rightView(ctx(d, { ...u, rightOpen: true } as Ui, 60)).lines);
    expect(details).toContain('obd0c3730');
  });

  it('nothing in Activity at all: "No events yet" (and every operation\'s, since there is none)', () => {
    const { d, u } = home([]);
    const t = flat(bottomView(ctx(d, u, 118)).lines);
    expect(t).toContain('No events yet.');
    expect(t).not.toContain('obd0c3730');
  });
});

describe('N1: one wording for a local route\'s price, the header, Chat\'s route row, the composer, a turn\'s line and its notice (R10 H163; H168 pass 2a)', () => {
  /** FIXTURE: H164's routeNow for a FAKE model on this computer's Ollama (H168's state: fake-qwen3:8b on port 4473) */
  const local = {
    provider: 'ollama', model: 'fake-qwen3:8b', where: 'this computer', fake: true, fakeWhy: 'its name says FAKE', ready: true, words: 'chat: local fake-qwen3:8b · Ollama',
    price: { state: 'unknown', words: 'no price declared: a turn on this computer\'s Ollama is sealed as no charge only when Ollama reports the model\'s local weights' },
    surface: 'workbench', tools: 'gated', details: { keyFrom: null, freeOnly: false, host: 'http://127.0.0.1:4473' },
  } as unknown as JourneyRoute;
  const LONG = /no price declared|no charge \(local|\bno price\b/;

  it('the header at every width, Chat\'s route row and the composer\'s foot: "no charge · local"', () => {
    for (const width of [160, 122, 100]) {
      const rows = journey.headerRows(data({ journeyRoute: local }), 'chat', width, g).lines.map(plain).join('\n');
      expect(rows, `the header at ${width}:\n${rows}`).toContain('no charge · local');
      expect(rows).not.toMatch(LONG);
    }
    const chat = flat(centerView(ctx(data({ journeyRoute: local }), ui(), 96)).lines);
    expect(chat).toContain('next turn: FAKE fake-qwen3:8b · this computer (Ollama) · no charge · local');
    expect(chat).toContain('to FAKE fake-qwen3:8b · this computer · no charge · local');
    expect(chat).not.toMatch(LONG);
    const open = flat(centerView(ctx(data({ journeyRoute: local }), ui({ input: { field: 'composer', text: '' } } as Partial<Ui>), 96)).lines);
    expect(open).toContain('Enter sends to FAKE fake-qwen3:8b · this computer · no charge · local');
    // the route as the one route reads it (no routeNow yet): the same words
    expect(journey.routeLine(data()).price).toBe('no charge · local');
  });

  it('a turn\'s line and its notice say it so too; [i] keeps the long forms ("no price declared (local)", "no charge (local endpoint)")', () => {
    const turn = failedTurn({ text: 'Which files?', answer: 'FIXTURE: an answer', state: 'answered', lines: [], sent: true, costWords: 'no charge (local endpoint)', model: 'fake-qwen3:8b' });
    const d = data({ journeyRoute: local, turn, chat: { session: 's1', total: 2, messages: [{ role: 'user', text: 'Which files?' }, { role: 'assistant', text: 'FIXTURE: an answer' }] } as Data['chat'] });
    const face = flat(centerView(ctx(d, ui(), 96)).lines);
    expect(face).toContain('answered · sent to a model · no charge · local · fake-qwen3:8b · receipt sealed');
    expect(face).not.toMatch(LONG);
    expect(journey.turnEndNotice({ status: 'answered', text: 'x', sent: true, receipt: 'sha256:1a2b3c4d', costWords: 'no charge (local endpoint)' }, g)).toBe('Answered: its receipt is sealed · no charge · local');
    const details = flat(rightView(ctx(d, ui({ rightOpen: true } as Partial<Ui>), 70)).lines);
    expect(details).toContain('no price declared (local)');
    expect(details).toContain('no charge (local endpoint)');
  });

  it('a paid or an unknown price keeps its own words', () => {
    const paid = { ...local, provider: 'openrouter', model: 'qwen/qwen3-coder', where: 'cloud', fake: false, words: 'chat: qwen/qwen3-coder · OpenRouter', price: { state: 'declared', free: false, words: '$0.20 per million tokens in, $0.80 out (as OpenRouter lists it)' } } as unknown as JourneyRoute;
    expect(journey.routeLine(data({ journeyRoute: paid })).price).toBe('$0.20 per million tokens in, $0.80 out (as OpenRouter lists it)');
    expect(journey.routeLine(data({ route: { kind: 'openrouter', words: 'chat: qwen/qwen3-coder · OpenRouter', ready: true } })).price).toBe('price as OpenRouter lists it (not read here)');
    expect(journey.routeLine(data({ route: { kind: 'local', words: 'chat: gpt-oss:120b-cloud · Ollama, cloud-backed', ready: true } })).price).toBe('cost unknown');
    for (const w of ['$0.0012 (as OpenRouter reported)', 'cost unknown', 'cost unknown (at least $0.0010)', 'no request, no cost']) {
      expect(journey.turnEndNotice({ status: 'answered', text: 'x', sent: true, costWords: w }, g)).toBe(`Answered · ${w}`);
    }
  });
});

describe('N5: small words: a stopped turn\'s mark, a recording\'s kind, and the next step after a failed send (R10 H163; H168 pass 2a)', () => {
  const at = (s: number) => new Date(NOW - s * 1000).toISOString();
  const stopped = { kind: 'turn', id: '5c0ffee1', title: 'Stop test 2: write a long answer.', when: at(900), state: 'stopped', receipt: { id: '5c0ffee1', verified: true }, fake: false, operation: 'obd0c3730', open: openTarget({ kind: 'turn', id: '5c0ffee1' }) } as unknown as JourneyWorkItem;
  const rrd = { kind: 'recording', id: 'out/demo-tray.rrd', title: 'out/demo-tray.rrd', when: at(1200), state: 'saved', receipt: null, fake: false, operation: null, open: openTarget({ kind: 'recording', id: 'out/demo-tray.rrd' }) } as unknown as JourneyWorkItem;
  const recent = (items: JourneyWorkItem[]) => ({ recent: { project: { name: 'tray', id: 'p1' }, notes: [], items } } as unknown as Partial<Data>);
  const homeUi = ui({ page: 'home', workspace: 'connections' } as Partial<Ui>);

  it('a stopped turn: "CHAT · ■ stopped" in Selected (one separator) and ■ on its row, never a bare "·"', () => {
    const d = data(recent([stopped]));
    const side = journey.homeSideView(ctx(d, homeUi, 50)).lines.map(plain);
    expect(side[0]).toBe('CHAT · ■ stopped');
    const row = journey.homeWorkView(ctx(d, homeUi, 70)).lines.map(plain).find((l) => l.includes('Stop test 2'))!;
    expect(row).toMatch(/^▸ ■ Stop test 2: write a long answer\./);
    // without Unicode: # (the stop's mark in ASCII), never the separator's -
    const ascii = glyphsFor(false);
    expect(journey.homeSideView({ ...ctx(d, homeUi, 50), g: ascii }).lines.map(plain)[0]).toBe('CHAT - # stopped');
  });

  it('a recording says its kind once: "recording", never "recording · recording"', () => {
    const d = data(recent([rrd]));
    const rows = journey.homeWorkView(ctx(d, homeUi, 70)).lines.map(plain).join('\n');
    expect(rows).toMatch(/demo-tray\.rrd +recording +\d+ min ago/);
    expect(rows).not.toContain('recording · recording');
    const side = flat(journey.homeSideView(ctx(d, homeUi, 50)).lines);
    expect(side).not.toMatch(/recording · recording|ago · recording/);
  });

  /** FIXTURE: the frame's Home and Chat actions for a local route that is ready, as src/ops/workspace-frame.ts actionsOf makes them */
  const frameWith = (connections: unknown[] = []) => {
    const wb = { activity: { waiting_on_you: 0, running: 0, stop_current: { job: null, words: 'idle' } }, route: { kind: 'local', ready: true, words: 'chat: local fake-qwen3:8b · Ollama', refusal: [] }, workflows: { docs: [] }, jobs: [] };
    const actions = actionsOf(wb as unknown as Parameters<typeof actionsOf>[0], [], { connections: connections as never });
    return { project: { id: 'p1', name: 'tray' }, activity: { chatTurn: null }, connections, log: [], tabs: [], actions } as unknown as Data['frame'];
  };
  const primary = (d: Data, page: 'chat' | 'home') => pageActions({ ui: ui(page === 'home' ? { page: 'home', workspace: 'connections' } as Partial<Ui> : {}), data: d }).acts.filter((a) => a.primary);

  it('after a send its Ollama did not answer: the next step is to check the connections (free), on Chat and on Home, not Send again', () => {
    const d = data({ frame: frameWith(), turn: failedTurn(), chat: { session: 's1', total: 1, messages: [{ role: 'user', text: 'Is Ollama there?' }] } as Data['chat'] });
    const chat = primary(d, 'chat');
    expect(chat.map((a) => [a.label, a.command])).toEqual([['Check connections (free requests)', 'timmy workspace check']]);
    expect(routeOf(chat[0]).kind).toBe('check');
    const home = primary(d, 'home');
    expect(home.map((a) => [a.label, a.command])).toEqual([['Check connections (free requests)', 'timmy workspace check']]);
    // before the send failed: Send (Chat) and Continue the chat (Home) are the next step, as before
    const before = data({ frame: frameWith(), chat: { session: 's1', total: 1, messages: [{ role: 'user', text: 'hello' }] } as Data['chat'] });
    expect(primary(before, 'chat').map((a) => a.label)).toEqual(['Send a message']);
    expect(primary(before, 'home').map((a) => a.label)).toEqual(['Continue the chat']);
  });

  it('a check of the route\'s connection after the failure ends it: Ollama answered, so Send is the next step again', () => {
    const talked = { chat: { session: 's1', total: 1, messages: [{ role: 'user', text: 'Is Ollama there?' }] } as Data['chat'] };
    // checked before the send failed: the failure is newer, so its fix is the next step
    const before = { id: 'ollama', label: 'Ollama (local models)', state: 'live', words: 'answered: 3 models', observedAt: new Date(NOW - 60_000).toISOString(), setup: null };
    expect(primary(data({ frame: frameWith([before]), turn: failedTurn(), ...talked }), 'chat').map((a) => a.label)).toEqual(['Check connections (free requests)']);
    // checked after it: the check is newer, and Ollama answered
    const ollama = { ...before, words: 'answered just now: 3 models', observedAt: new Date(NOW - 50).toISOString() };
    const d = data({ frame: frameWith([ollama]), turn: failedTurn(), ...talked });
    expect(primary(d, 'chat').map((a) => a.label)).toEqual(['Send a message']);
    expect(primary(d, 'home').map((a) => a.label)).toEqual(['Continue the chat']);
  });

  it('a failure whose step is a model is chosen; one whose step is to send again leaves Send the next step', () => {
    const noModel = failedTurn({ lines: ['Ollama at 127.0.0.1:11434 has no model named qwen9:1b, so nothing was sent.', 'Cause: its answer: model \'qwen9:1b\' not found (Timmy downloads nothing)', 'Try: /model lists what it has; ollama pull qwen9:1b installs it; no other model is tried.'] });
    const m = primary(data({ frame: frameWith(), turn: noModel }), 'chat');
    expect(m.map((a) => [a.label, a.command])).toEqual([['Choose the model', '/model']]);
    const again = failedTurn({ lines: ['Ollama at 127.0.0.1:11434 answered HTTP 500 for qwen3:8b.', 'Cause: its words: none', 'Try: send again; if it repeats, see Ollama\'s own log; no other model is tried.'], sent: true });
    expect(primary(data({ frame: frameWith(), turn: again }), 'chat').map((a) => a.label)).toEqual(['Send a message']);
  });

  it('another route chosen since, or a turn sealed since, ends it too: the next step is to send again', () => {
    const talked = { chat: { session: 's1', total: 1, messages: [{ role: 'user', text: 'Is Ollama there?' }] } as Data['chat'] };
    const moved = data({ frame: frameWith(), turn: failedTurn({ route: 'chat: local fake-qwen3:8b · Ollama' }), route: { kind: 'local', words: 'chat: local qwen3:8b · Ollama', ready: true } as Data['route'], ...talked });
    expect(primary(moved, 'chat').map((a) => a.label)).toEqual(['Send a message']);
    const same = data({ frame: frameWith(), turn: failedTurn({ route: 'chat: local fake-qwen3:8b · Ollama' }), ...talked });
    expect(primary(same, 'chat').map((a) => a.label)).toEqual(['Check connections (free requests)']);
    // a turn another surface sealed after it (the REPL's, answered)
    const later = { receipt: 'feedf00d', surface: 'repl', state: 'answered', model: 'fake-qwen3:8b', at: new Date(NOW).toISOString(), operation: 'o55556666' } as unknown as NonNullable<Data['turns']>[number];
    const own = { receipt: '1a2b3c4d', surface: 'workbench', state: 'failed', model: null, at: new Date(NOW - 100).toISOString(), operation: 'o1a2b3c4d' } as unknown as NonNullable<Data['turns']>[number];
    expect(primary(data({ frame: frameWith(), turn: failedTurn(), turns: [own], ...talked }), 'chat').map((a) => a.label)).toEqual(['Check connections (free requests)']);
    expect(primary(data({ frame: frameWith(), turn: failedTurn(), turns: [later, own], ...talked }), 'chat').map((a) => a.label)).toEqual(['Send a message']);
  });
});

describe('F6 with one turn row (the lead\'s addition, R10 H163; H164\'s 7df15a9b): Home\'s connections count answers from the frame\'s own sealed turns', () => {
  const at = (m: number) => new Date(NOW - m * 60_000).toISOString();
  const ollama = { id: 'ollama', label: 'Ollama (local models)', state: 'configured', words: 'set up, not checked yet (a setting is not a connection)', observedAt: null, setup: 'timmy workspace check' };
  const openrouter = { id: 'openrouter', label: 'OpenRouter', state: 'configured', words: 'a key is set; not checked yet', observedAt: null, setup: 'timmy workspace check' };
  const sealed = (o: Record<string, unknown>) => ({ receipt: 'a1b2c3d4', surface: 'workbench', state: 'answered', model: 'qwen3:8b', at: at(5), operation: 'o11112222', route: 'local', words: 'turn answered in the Workbench · qwen3:8b · receipt a1b2c3d4', ...o });
  const frame = (turns: unknown[]) => ({ project: { id: 'p1' }, activity: { chatTurn: null }, log: [], tabs: [], connections: [ollama, openrouter], chat: { turns } }) as unknown as Data['frame'];
  /** recent work as H164's 7df15a9b lists the conversation: ONE row, its newest turn */
  const oneRow = (o: Record<string, unknown>) => ({ recent: { project: { name: 'tray', id: 'p1' }, notes: [], items: [{ kind: 'turn', id: 't-new', title: 'question 3 · 3 turns in this conversation', when: at(1), receipt: null, fake: false, operation: 'o33334444', open: openTarget({ kind: 'turn', id: 't-new' }), ...o }] } } as unknown as Partial<Data>);

  it('while a turn is being answered (the one row is the running turn), an answer through Ollama 5 minutes ago still makes Ollama live', () => {
    const d = data({ frame: frame([sealed({})]), ...oneRow({ state: 'running', title: 'A chat turn being answered in the REPL' }) });
    const [o, r] = journey.homeConnections({ data: d, now: NOW });
    expect(o).toMatchObject({ id: 'ollama', state: 'live', observedAt: at(5) });
    expect(o.words).toMatch(/^answered a chat turn \d\d:\d\d:\d\d \(its receipt is sealed\)/);
    expect(r.state).toBe('configured');
  });

  it('an older answer through the other provider within 30 minutes: both are live, each from its own turn', () => {
    const turns = [sealed({ receipt: 'b2c3d4e5', route: 'openrouter', model: 'qwen/qwen3-coder', at: at(2) }), sealed({ at: at(10) })];
    const d = data({ frame: frame(turns), ...oneRow({ state: 'answered', route: { provider: 'openrouter', requested: 'qwen/qwen3-coder', answeredBy: 'qwen/qwen3-coder', where: 'cloud', fallback: false, fake: false, surface: 'workbench' } }) });
    const [o, r] = journey.homeConnections({ data: d, now: NOW });
    expect(o).toMatchObject({ id: 'ollama', state: 'live', observedAt: at(10) });
    expect(r).toMatchObject({ id: 'openrouter', state: 'live', observedAt: at(2) });
    // an answer older than the live bound, or a turn that failed or was stopped, is not counted
    const old = data({ frame: frame([sealed({ at: at(45) }), sealed({ state: 'failed', at: at(3) }), sealed({ state: 'stopped', at: at(4) })]) });
    expect(journey.homeConnections({ data: old, now: NOW }).map((x) => x.state)).toEqual(['configured', 'configured']);
  });
});

// ── in the Workbench itself ────────────────────────────────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FAKE_OPENER: Opener = { program: null, open: () => ({ ok: false, why: 'FAKE opener: nothing is opened in this test' }) };
let box = '';
let home = '';
let jobsDir = '';
const opened: Controller[] = [];
const spaces: Workspace[] = [];

beforeAll(() => {
  box = mkdtempSync(join(tmpdir(), 'wb-pass2a-'));
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
  // R10 CHAT (H167): this file checks the classic Chat tab (row 2's actions, the pipeline, the event log); the Chat screen's
  // shell that replaces it is tests/workbench-chat-shell.test.ts's
  vi.stubEnv('TIMMY_WORKBENCH_CHAT', 'classic');
  vi.stubEnv('TIMMY_SETTINGS_DIR', join(box, 'settings'));
  vi.stubEnv('OPENROUTER_API_KEY', '');
}

function trayProject(name: string): { name: string; root: string; chosen: boolean } {
  const made = createProject(name);
  if ('error' in made) throw new Error(made.error);
  const copied = copyStarter('tray-workflow', made.root);
  if ('error' in copied) throw new Error(copied.error);
  saveActiveProject(made);
  mkdirSync(join(made.root, '.timmy'), { recursive: true });
  writeFileSync(join(made.root, '.timmy', 'store-pin'), join(made.root, '.timmy', 'receipts'));
  return made;
}

/** FIXTURE: a chat session in the contract's shape on a local route. Each message is answered by `result` at once, as the
 *  session gives a turn's end; its receipt sealed (sealTurn, FIXTURE facts) into the project's store; no model is asked. */
function fixtureChat(root: string, name: string, result: (text: string) => Omit<ChatTurnResult, 'receipt'>): Producers {
  // (each message's result is the test's: its words, whether it was sent and its cost; FIXTURE: no model is asked)
  const conv = new ConversationManager(join(root, '.sessions'));
  const openChat: OpenChatSession = async () => {
    const session: ChatSession = {
      route: () => ({ kind: 'local', words: 'chat: local fake-qwen3:8b · Ollama', ready: true }),
      sendOnce: async (_key: string, text: string, hooks: ChatTurnHooks) => session.send(text, hooks),
      send: async (text: string) => {
        if (!conv.current) conv.startNew();
        conv.appendMessage({ role: 'user', content: text });
        const r = result(text);
        if (r.status === 'answered') conv.appendMessage({ role: 'assistant', content: r.text });
        const receipt = sealTurn({ prompt: text, answer: r.text, steps: 0, spend: 0, costMeasured: false, ms: 100, status: r.status === 'answered' ? 'ok' : 'failed', surface: 'workbench', model: 'fake-qwen3:8b', project: name, projectId: projectId(root) }, projectStore(root)).hash;
        return { ...r, receipt };
      },
    };
    return session;
  };
  return { runDetail: async () => ({ ok: false, why: 'FIXTURE: no run detail in this test' }), openChat: async () => ({ ok: true, value: openChat }) } as Producers;
}

function workbench(project: { name: string; root: string; chosen: boolean }, producers: Producers): Controller {
  let c: Controller | undefined;
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
  return c;
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

/** One region's words as drawn at 122x37 (H168's size), its rows joined. */
function region(c: Controller, name: 'top' | 'center' | 'right' | 'bottom', columns = 122, rows = 37): string {
  const fr = c.frame(columns, rows);
  const rect = fr.regions[name]?.rect;
  if (!rect) return '';
  const text = screenText(fr.screen);
  const out: string[] = [];
  for (let y = rect.y + 1; y <= rect.y + rect.h - 2; y++) {
    let x = 0;
    let row = '';
    for (const ch of text[y] ?? '') { if (x > rect.x && x < rect.x + rect.w - 1) row += ch; x += visibleWidth(ch); }
    out.push(row);
  }
  return out.join(' ').replace(/\s+/g, ' ');
}
const screen = (c: Controller, columns = 122, rows = 37): string => screenText(c.frame(columns, rows).screen).join('\n');
const ENTER = { return: true };

/** The composer open on the Chat tab, the session ready; `text` typed and sent; the turn's end awaited. */
async function sendFromChat(c: Controller, text: string): Promise<void> {
  c.selectPage('chat');
  await until('the chat session', () => c.can().chat, 10_000, () => screen(c));
  c.ui.focus = 'center';
  c.key('\r', ENTER);
  expect(c.ui.input.field).toBe('composer');
  c.key(text, {});
  c.key('\r', ENTER);
  await until('the turn\'s end', () => c.data.turn && c.data.turn.state !== 'sending' && c.data.turn.ended !== undefined, 10_000, () => screen(c));
}

describe('F3 in the Workbench: a send to a local route whose Ollama does not answer (R10 H163; H168 pass 2a)', () => {
  it('the conversation and the notice say it in words; [i] keeps the session\'s lines whole; the turn keeps them as the session gave them', async () => {
    sandbox();
    // the chat set up as H168's was: the local route, a FAKE model on this computer's Ollama (FIXTURE: the setup's records only;
    // nothing listens at the address, and the FIXTURE session answers instead of it)
    writeFileSync(join(home, 'providers.json'), JSON.stringify({ ollama_host: 'http://127.0.0.1:4471' }));
    writeFileSync(join(home, 'setup.json'), JSON.stringify({ version: 1, by: 'timmy init', answers: { operator: 'Sample', ollama: 'http://127.0.0.1:4471', project: 'pass2a-down', chat: 'local', model: 'fake-qwen3:8b' } }));
    const p = trayProject('pass2a-down');
    const c = workbench(p, fixtureChat(p.root, p.name, (text) => (text === 'Is Ollama there?'
      ? { status: 'failed', text: '', lines: [...DOWN], sent: false, costWords: 'no request, no cost' }
      : { status: 'answered', text: 'FIXTURE: an answer, no model behind it', sent: true, costWords: 'no charge (local endpoint)', model: 'fake-qwen3:8b' })));
    c.start();
    await sendFromChat(c, 'Is Ollama there?');
    // the turn as the session gave it: its lines whole (its record and receipt are the session's, unchanged)
    expect(c.data.turn).toMatchObject({ state: 'failed', sent: false, lines: DOWN });
    const center = region(c, 'center');
    expect(center).toContain('Ollama on this computer did not answer: nothing was sent, no cost. Start the Ollama app, then send again.');
    for (const raw of RAW) expect(center, `the conversation says ${raw}:\n${screen(c)}`).not.toContain(raw);
    // the notice, Activity's newest line: the same words
    await until('the notice', () => /^Failed:/.test(c.ui.flash?.text ?? ''), 5000, () => screen(c));
    expect(c.ui.flash?.text).toBe('Failed: Ollama on this computer did not answer: nothing was sent, no cost. Start the Ollama app, then send again.');
    // [i]: the lines whole (Esc leaves the composer first: i would be typed into it)
    c.key('', { escape: true });
    expect(c.ui.input.field).toBe(null);
    c.key('i', {});
    await until('the Inspector', () => /YOUR LAST MESSAGE HERE · DETAILS/.test(region(c, 'right')), 5000, () => screen(c));
    const right = region(c, 'right');
    for (const raw of ['127.0.0.1:4473', 'ECONNREFUSED', 'ollama serve', '/setup chat']) expect(right, `[i] lacks ${raw}:\n${screen(c)}`).toContain(raw);
    c.key('i', {});

    // N5: the next step is the failure's fix, the check (free requests), not Send again; Enter on it would run the check here
    const next = pageActions(c).acts.filter((a) => a.primary);
    expect(next.map((a) => [a.label, routeOf(a).kind])).toEqual([['Check connections (free requests)', 'check']]);
    expect(region(c, 'top')).toMatch(/\[▶ 2 Check connections \(free requests\)\]/);
    expect(region(c, 'top')).not.toMatch(/\[▶ 1 Send a message\]/);

    // N1: a turn that is answered on the local route: its line and its notice say "no charge · local"; Send is the next step again
    await sendFromChat(c, 'Which files did the report run write?');
    expect(c.data.turn).toMatchObject({ state: 'answered', costWords: 'no charge (local endpoint)' });
    await until('the notice', () => /^Answered/.test(c.ui.flash?.text ?? ''), 5000, () => screen(c));
    expect(c.ui.flash?.text).toBe('Answered: its receipt is sealed · no charge · local');
    expect(region(c, 'center')).toContain('answered · sent to a model · no charge · local · fake-qwen3:8b · receipt sealed');
    expect(screen(c)).not.toMatch(/no charge \(local endpoint\)|no price declared/);
    expect(pageActions(c).acts.filter((a) => a.primary).map((a) => a.label)).toEqual(['Send a message']);
  }, 30_000);
});
