// R10 CHAT CHECKPOINT (H167): the Chat screen's keys, through the Workbench's own Controller (Controller.frame, the rows Ink
// prints) as `timmy workbench` makes it (opensOn: 'chat'), over a real Timmy home in a temporary folder whose chat is the local
// route with a FAKE model chosen. It opens on Chat, the conversation having the keyboard; Enter writes, Esc leaves the
// composer with the draft kept; Tab moves the rail → the conversation → Models → the bottom; the bottom's Logs opens its drawer
// over the conversation, Esc closes it and the keyboard stays on Logs, the draft kept (the target's check); Enter in the
// conversation gives the draft back; M gives Models the keyboard and Esc gives it back to the conversation.
//
// FAKE here: the openers and the servers (nothing is opened or started), the run detail's and the chat session's producers
// (none: no turn is sent), the Ollama the setup's deps would ask (a FAKE list, no request) and the catalog (none).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConversationManager } from '../src/agent/conversation.js';
import { createProject, projectId, saveActiveProject } from '../src/project/index.js';
import { copyStarter } from '../src/project/starters.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import { Controller, type ControllerDeps } from '../src/workbench/controller.js';
import type { SignIn, SignInResult } from '../src/setup/openrouter-signin.js';
import type { ChatRouteState, ChatSession, ChatTurnResult } from '../src/contracts/chat-session.js';
import type { Producers } from '../src/workbench/producers.js';
import { glyphsFor } from '../src/workbench/frame.js';
import { CompanionControl, StudioControl, type Opener } from '../src/workbench/servers.js';
import type { SetupDeps } from '../src/workbench/setup-paths.js';
import type { Line } from '../src/workbench/text.js';
import { readSettings } from '../src/workbench/settings.js';
import { loadConfig, saveConfig } from '../src/utils/config.js';

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

function workbench(p: { name: string; root: string; chosen: boolean }, setup: Partial<SetupDeps> = {}, extra: Partial<ControllerDeps> = {}): Controller {
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
      ...setup,
    },
    companion: new CompanionControl({ opener: FAKE_OPENER, start: async () => { throw new Error('FAKE: no server is started in this test'); } }),
    studio: new StudioControl({ env: process.env, opener: FAKE_OPENER, project: () => ws.project, projectId, jobsDir, receipts: () => join(box, 'store'), ensure: async () => ({ state: 'failed', error: 'FAKE: no Studio in this test' }) }),
    capabilities: async () => [], tickMs: 100, slowMs: 3_600_000,
    ...extra,
  });
  opened.push(c);
  return c;
}

/** FAKE: a chat session in the contract's shape that asks no model: its route the test's, each message answered by `answer`
 *  (by default at once, a FAKE answer); how many messages it was given. */
function fakeSession(o: { route?: ChatRouteState; answer?: (text: string, signal?: AbortSignal) => Promise<ChatTurnResult> } = {}): { producers: Producers; sends: () => number } {
  let sends = 0;
  const session: ChatSession = {
    route: () => o.route ?? { kind: 'local', words: 'chat: local fake-qwen3:8b · Ollama', ready: true },
    send: async (text, hooks) => {
      sends++;
      return o.answer ? o.answer(text, hooks.signal) : { status: 'answered', text: 'FAKE answer (no model behind it).', sent: true, costWords: 'no charge (FAKE)' };
    },
    sendOnce: async (_key, text, hooks) => session.send(text, hooks),
  };
  return { producers: { runDetail: async () => ({ ok: false, why: 'FIXTURE: none' }), openChat: async () => ({ ok: true, value: async () => session }) }, sends: () => sends };
}

/** FIXTURE: three models of a catalog "shipped" on a FIXTURE day (one free, one priced, one with no price) */
const FIXTURE_CATALOG = [
  { id: 'fixture-maker/older-model', name: 'FIXTURE: Older model', created: 1_700_000_000, context_length: 32_000, pricing: { prompt: '0.0000005', completion: '0.0000015' } },
  { id: 'fixture-maker/newest-model:free', name: 'FIXTURE: Newest (free)', created: 1_790_000_000, context_length: 262_144, pricing: { prompt: '0', completion: '0' } },
  { id: 'other-maker/middle-model', name: 'FIXTURE: Middle model', created: 1_750_000_000, context_length: 1_000_000 },
];

/** FAKE (R11 H167, step 1a): a local model's readiness check as H170's checkLocalModel answers it, by name, after a short
 *  wait (so a frame drawn meanwhile shows "checking"); which names were asked. No request leaves the test. */
function fakeCheck(answers: Record<string, 'ready' | 'not-a-chat-model' | 'not-installed' | 'unreachable'>, waitMs = 30): { checkLocal: SetupDeps['checkLocal']; asked: string[] } {
  const asked: string[] = [];
  const checkLocal: SetupDeps['checkLocal'] = async (model) => {
    asked.push(model);
    await sleep(waitMs);
    const state = answers[model] ?? 'not-installed';
    const words = state === 'ready' ? `ready: ${model} is installed on this computer's Ollama (8B Q4_K_M, 40k context); checked just now, no model run.`
      : state === 'not-a-chat-model' ? `${model} is not a chat model: Ollama at 127.0.0.1:9 lists it without the completion capability (an embedding model, or weights in a form it cannot run). Choose a chat model.`
        : state === 'not-installed' ? `Ollama at 127.0.0.1:9 does not have ${model}: ollama pull ${model} downloads it (its size shows first), then choose it again.`
          : 'Ollama is not running at 127.0.0.1:9 (the connection was refused): start it (ollama serve), then choose the model again.';
    const why = state === 'ready' ? 'completion' : state === 'not-a-chat-model' ? 'no-completion' : state === 'not-installed' ? 'not-held' : 'not-running';
    return { state, why, words, at: new Date().toISOString(), name: model, origin: 'http://127.0.0.1:9', latencyMs: waitMs };
  };
  return { checkLocal, asked };
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
    // (H168's pass 3a, R4: the notice's words fit the status row: "What you typed stays; M chooses a model.")
    expect(c.ui.flash?.text).toMatch(/^Not sent( yet)?: .*What you typed stays/);
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

  it('a relaunch with a kept conversation and no model chosen: the first frame is that conversation (not the first run\'s question)', () => {
    const p = homeWithModel('kept', false);
    // FIXTURE: a conversation kept in the project from an earlier launch (as a turn answered then writes it)
    const conv = new ConversationManager(join(p.root, '.sessions'));
    conv.startNew();
    conv.appendMessage({ role: 'user', content: 'FIXTURE: the question asked before the relaunch.' });
    conv.appendMessage({ role: 'assistant', content: 'FIXTURE: its answer, kept.' });
    const c = workbench(p);
    const t = shown(c);
    const center = t.map((r) => cols(r, 20, 89));
    expect(center[4]).toBe('CHAT / kept');
    expect(center.some((r) => r === 'FIXTURE: the question asked before the relaunch.')).toBe(true);
    expect(center.some((r) => r === 'FIXTURE: its answer, kept.')).toBe(true);
    expect(t.join('\n')).not.toMatch(/WELCOME TO TIMMY|How would you like to run chat/);
  });

  it('R11 step 1a, the first run\'s Ollama on this computer: Enter on a row asks Ollama (FAKE check); a row that is not a chat model says why beside it and nothing is saved, the selector staying; a chat model: checking, then ready: saved, the selector closed, the composer with the draft, the status row naming the next turn', async () => {
    const set: string[] = [];
    const fake = fakeCheck({ 'clef-flash:latest': 'not-a-chat-model', 'fake-qwen3:8b': 'ready' });
    const c = workbench(homeWithModel('notchat', false), {
      // FAKE: a local list as the setup's deps give it, each with the probe's check (one is a decision model: not a chat model)
      ollama: async () => ({ where: 'FAKE Ollama', answered: true, models: [{ name: 'clef-flash:latest', facts: 'local weights · mxfp8 · 12.4 GB', chat: false }, { name: 'fake-qwen3:8b', facts: 'local weights · 8B · Q4_K_M', chat: true }], listed: 2, cloud: 0 }),
      checkLocal: fake.checkLocal,
      setLocal: async (m: string) => { set.push(m); return { written: [] }; },
      blank: async () => false,
    });
    let t = shown(c);
    expect(cols(t[4], 20, 89)).toBe('WELCOME TO TIMMY');
    press(c, '', { downArrow: true });
    expect(cols(shown(c)[13], 20, 89)).toBe('> [ Ollama / this computer ]');
    t = press(c, '\r', ENTER);
    expect(c.ui.focus).toBe('right');
    const rail = (rows: string[]) => rows.map((r) => cols(r, 92, 121));
    for (const end = Date.now() + 10_000; Date.now() < end && !rail(t).includes('  not a chat model'); await sleep(20)) t = shown(c);
    expect(rail(t).slice(14, 18)).toEqual(['> clef-flash:latest', '  not a chat model', '  FAKE fake-qwen3:8b', '  8B · Q4_K_M']);
    // no route chosen: the cursor's model is MODEL, nothing is SELECTED
    expect(rail(t)).toContain('MODEL / clef-flash:latest');
    expect(t.join('\n')).not.toMatch(/SELECTED|next turn uses it/);
    // Enter on the decision model: Ollama is asked once more (the FAKE answers not a chat model); nothing saved; the row says
    // why, and H170's whole words stand under MODEL; the selector keeps the keyboard; the status row says it in a sentence
    c.key('\r', ENTER);
    t = shown(c);
    expect(c.ui.modelCheck).toMatchObject({ model: 'clef-flash:latest', state: 'checking' });
    expect(rail(t)[15]).toBe('  checking with Ollama…');
    for (const end = Date.now() + 10_000; Date.now() < end && c.ui.modelCheck?.state === 'checking'; await sleep(20)) t = shown(c);
    t = shown(c);
    expect(fake.asked).toEqual(['clef-flash:latest']);
    expect(set).toEqual([]);
    expect(c.ui.focus).toBe('right');
    expect(c.ui.modelsOpen).toBe(true);
    expect(rail(t)[15]).toBe('  ✕ not a chat model');
    expect(rail(t).join(' ').replace(/\s+/g, ' ')).toMatch(/clef-flash:latest is not a chat model: Ollama at 127\.0\.0\.1:9 lists it without the completion capability/);
    expect(c.ui.flash?.text).toBe('Not chosen: not a chat model: no completion capability.');
    expect(c.ui.flash?.role).toBe('failure');
    expect(c.ui.overlay).toBeNull();
    // a draft, typed before the choice (Chat with no model: Write a draft opens the composer; Tab leaves it as the draft, the
    // keyboard on Models)
    press(c, '', ESC);
    expect(c.ui.focus).toBe('center');
    press(c, '', { downArrow: true });
    press(c, '', { downArrow: true });
    press(c, '\r', ENTER);
    expect(c.ui.input.field).toBe('composer');
    press(c, 'FIXTURE: a draft kept across the choice');
    press(c, '', TAB);
    expect(c.ui.draft).toBe('FIXTURE: a draft kept across the choice');
    expect(c.ui.focus).toBe('right');
    // ↓ to the chat model; Enter: checking (the row says so), then ready: saved through the setup's writer; the selector closes
    // (the keyboard leaves it), the composer has the keyboard with the draft intact, the status row names the next turn
    press(c, '', { downArrow: true });
    c.key('\r', ENTER);
    t = shown(c);
    expect(rail(t)[17]).toBe('  checking with Ollama…');
    expect(c.ui.flash?.text).not.toMatch(/^Next turn/);
    for (const end = Date.now() + 10_000; Date.now() < end && !set.length; await sleep(20)) shown(c);
    t = shown(c);
    expect(fake.asked).toEqual(['clef-flash:latest', 'fake-qwen3:8b']);
    expect(set).toEqual(['fake-qwen3:8b']);
    expect(c.ui.modelCheck).toMatchObject({ model: 'fake-qwen3:8b', state: 'ready' });
    expect(c.ui.modelsOpen).toBe(false);
    expect(c.ui.focus).toBe('center');
    expect(c.ui.input).toEqual({ field: 'composer', text: 'FIXTURE: a draft kept across the choice' });
    expect(c.ui.draft).toBeUndefined();
    expect(c.ui.firstRunDone).toBe(true);
    expect(c.ui.overlay).toBeNull();
    expect(c.ui.flash?.text).toBe('Next turn: fake-qwen3:8b on this computer.');
    expect(rail(t)[17]).toBe('  8B · Q4_K_M');
    expect(t.join('\n')).not.toMatch(/The local chat's model|WHAT CHANGED/);
  });

  it('R11 step 1a: an Ollama that does not answer the check: nothing saved, the row says it did not answer at its address; a second Enter during a check is refused; the check is cancelled when the Workbench ends', async () => {
    const set: string[] = [];
    const fake = fakeCheck({ 'fake-qwen3:8b': 'unreachable' }, 150);
    const c = workbench(homeWithModel('noanswer', false), { checkLocal: fake.checkLocal, setLocal: async (m: string) => { set.push(m); return { written: [] }; }, blank: async () => false });
    shown(c);
    press(c, '', { downArrow: true });
    let t = press(c, '\r', ENTER);
    const rail = (rows: string[]) => rows.map((r) => cols(r, 92, 121));
    for (const end = Date.now() + 10_000; Date.now() < end && !rail(t).includes('> FAKE fake-qwen3:8b'); await sleep(20)) t = shown(c);
    c.key('\r', ENTER);
    t = press(c, '\r', ENTER);
    expect(c.ui.flash?.text).toBe('Still checking fake-qwen3:8b with Ollama…');
    for (const end = Date.now() + 10_000; Date.now() < end && c.ui.modelCheck?.state === 'checking'; await sleep(20)) t = shown(c);
    t = shown(c);
    expect(fake.asked).toEqual(['fake-qwen3:8b']);
    expect(set).toEqual([]);
    expect(c.ui.modelCheck).toMatchObject({ model: 'fake-qwen3:8b', state: 'unreachable' });
    expect(rail(t)[15]).toBe('  ✕ no answer from Ollama');
    expect(rail(t).join(' ').replace(/\s+/g, ' ')).toMatch(/Ollama is not running at 127\.0\.0\.1:9 \(the connection was refused\)/);
    expect(c.ui.flash?.text).toBe('Not chosen: Ollama did not answer at 127.0.0.1:9.');
    expect(c.ui.focus).toBe('right');
    expect(c.ui.modelsOpen).toBe(true);
    // a check under way when the Workbench ends is cancelled: nothing saved after it
    const slow = fakeCheck({ 'fake-qwen3:8b': 'ready' }, 200);
    const d = workbench(homeWithModel('ending', false), { checkLocal: slow.checkLocal, setLocal: async (m: string) => { set.push(m); return { written: [] }; }, blank: async () => false });
    shown(d);
    press(d, '', { downArrow: true });
    t = press(d, '\r', ENTER);
    for (const end = Date.now() + 10_000; Date.now() < end && !rail(t).includes('> FAKE fake-qwen3:8b'); await sleep(20)) t = shown(d);
    d.key('\r', ENTER);
    expect(d.ui.modelCheck?.state).toBe('checking');
    d.dispose();
    await sleep(300);
    expect(set).toEqual([]);
  });

  it('R11 step 1a: a home with no identity yet: the choice sets it up through the setup\'s writer (as timmy init would, by timmy workbench), said on the status row; nothing is sent to a shell', async () => {
    const fake = fakeCheck({ 'fake-qwen3:8b': 'ready' });
    const home = join(box, 'blankhome');
    const c = workbench(homeWithModel('blankhome', false), {
      checkLocal: fake.checkLocal,
      // FAKE: the writer's answer for a home that had no identity (the real one makes it, R11 setup-paths.ts setLocal)
      setLocal: async () => ({ written: [join(home, 'identity.json'), join(home, 'identity.seed'), join(home, 'setup.json')], identity: true }),
      blank: async () => true,
    });
    shown(c);
    press(c, '', { downArrow: true });
    let t = press(c, '\r', ENTER);
    const rail = (rows: string[]) => rows.map((r) => cols(r, 92, 121));
    for (const end = Date.now() + 10_000; Date.now() < end && !rail(t).includes('> FAKE fake-qwen3:8b'); await sleep(20)) t = shown(c);
    c.key('\r', ENTER);
    for (const end = Date.now() + 10_000; Date.now() < end && c.ui.modelCheck?.state !== 'ready'; await sleep(20)) shown(c);
    t = shown(c);
    expect(c.ui.modelCheck).toMatchObject({ model: 'fake-qwen3:8b', state: 'ready', setUp: true });
    expect(c.ui.flash?.text).toMatch(/^Next turn: fake-qwen3:8b on this computer\. Set up now: identity and setup written in \S*blankhome\.$/);
    expect(c.ui.input.field).toBe('composer');
    expect(t.join('\n')).not.toMatch(/timmy init, in a shell|not set up on this computer/);
  });

  it('R11 step 1a: a box opened while the Models drawer is open (80x24) closes the drawer: the box is drawn, and after Esc the conversation and the composer, never the drawer over them', () => {
    const c = workbench(homeWithModel('drawerbox'));
    const at80 = (): string[] => c.frame(80, 24).screen.map(rowText);
    at80();
    c.key('M', {});
    let t = at80();
    expect(c.ui.modelsOpen).toBe(true);
    expect(t.map((r) => cols(r, 16, 79))[4]).toMatch(/^MODELS +\[ Close \]$/);
    c.key('?', {});
    t = at80();
    expect(c.ui.overlay?.kind).toBe('help');
    expect(c.ui.modelsOpen).toBe(false);
    expect(t.join('\n')).not.toMatch(/\[ Close \]|OpenRouter +> Local/);
    c.key('', ESC);
    t = at80();
    expect(c.ui.overlay).toBeNull();
    expect(c.ui.focus).toBe('center');
    const mid = t.map((r) => cols(r, 16, 79));
    expect(mid[4]).toMatch(/^CHAT \/ drawerbox/);
    expect(mid.join('\n')).not.toMatch(/MODELS|\[ Close \]/);
    expect(mid.some((r) => /Enter writes a message|Message TIMMY/.test(r))).toBe(true);
  });

  it('OpenRouter in the first run: Connect OpenRouter; the sign-in\'s address shown and opened only on Enter, Esc cancels it with nothing saved (FAKE sign-in and opener); a pasted key goes into a hidden field, is saved (saved, not checked) and is never shown', async () => {
    const p = homeWithModel('connect', false);
    const opened: string[] = [];
    let cancels = 0;
    // FAKE: a sign-in that listens on nothing, its address a FIXTURE of the shape H170's flow gives
    const FIXTURE_URL = 'https://openrouter.ai/auth?callback_url=http%3A%2F%2F127.0.0.1%3A9%2Fopenrouter%2Fcallback%2FFIXTURE&code_challenge=FIXTURE&code_challenge_method=S256';
    const signIn = async (): Promise<SignIn> => {
      let settle: (r: SignInResult) => void = () => undefined;
      const done = new Promise<SignInResult>((r) => { settle = r; });
      return {
        url: FIXTURE_URL, callback: 'http://127.0.0.1:9/openrouter/callback/FIXTURE', port: 9, done,
        cancel: () => { cancels++; settle({ ok: false, reason: 'cancelled', at: new Date().toISOString(), words: 'The sign-in was cancelled: nothing was saved.' }); },
        submit: () => ({ ok: false, words: 'FIXTURE: not taken.' }),
      };
    };
    const c = workbench(p, {}, { signIn, opener: { program: 'FAKE', open: (href) => { opened.push(href); return { ok: true }; } } });
    // every frame drawn here, to read that no step shows what was typed into the hidden field
    const frames: string[] = [];
    const see = (t: string[]): string[] => { frames.push(t.join('\n')); return t; };
    const mid = (rows: string[]) => rows.map((r) => cols(r, 20, 89));
    let t = see(shown(c));
    expect(cols(t[4], 20, 89)).toBe('WELCOME TO TIMMY');
    // Enter on OpenRouter / cloud (the cursor's): the box; nothing is sent yet
    t = see(press(c, '\r', ENTER));
    expect(mid(t)).toContain('Connect OpenRouter');
    expect(mid(t)).toContain('> [ Sign in with OpenRouter ]');
    // Enter on Sign in: its address, whole; nothing opened
    press(c, '\r', ENTER);
    for (const end = Date.now() + 5_000; Date.now() < end && !mid(shown(c)).some((r) => r.startsWith('  https://openrouter.ai/auth?')); await sleep(20)) { /* the FAKE sign-in starts */ }
    t = see(shown(c));
    const at = mid(t).findIndex((r) => r.startsWith('  https://openrouter.ai/auth?'));
    const rows: string[] = [];
    for (let k = at; k >= 0 && /^ {2}\S+$/.test(mid(t)[k] ?? ''); k++) rows.push(mid(t)[k].slice(2));
    expect(rows.join('')).toBe(FIXTURE_URL);
    expect(opened).toEqual([]);
    expect(mid(t)).toContain('> [ Open it in the browser ]');
    // Enter on Open: the opener has it, only now
    t = see(press(c, '\r', ENTER));
    expect(opened).toEqual([FIXTURE_URL]);
    expect(t.join('\n')).toContain('Opened in the browser: sign in on OpenRouter');
    // Esc: cancelled, nothing saved; the first run's question again
    t = see(press(c, '', ESC));
    expect(cancels).toBe(1);
    expect(c.ui.overlay).toBeNull();
    expect(c.ui.flash?.text).toBe('The sign-in was cancelled: nothing was saved.');
    expect(cols(t[4], 20, 89)).toBe('WELCOME TO TIMMY');
    const providers = () => JSON.parse(readFileSync(join(process.env.TIMMY_HOME ?? '', 'providers.json'), 'utf8')) as Record<string, unknown>;
    expect(providers().openrouter_api_key).toBeUndefined();
    // Enter, ↓, Enter: Paste a key, its hidden field
    press(c, '\r', ENTER);
    press(c, '', { downArrow: true });
    t = see(press(c, '\r', ENTER));
    expect(c.ui.input.field).toBe('secret');
    expect(mid(t)).toContain('Paste a key');
    expect(mid(t)).toContain('› nothing typed yet (hidden)');
    // too short: not saved, said why (never what was typed); the field open again, empty
    t = see(press(c, 'FIXTURE-short'));
    expect(mid(t)).toContain('› 13 characters typed (hidden)');
    t = see(press(c, '\r', ENTER));
    expect(mid(t).join(' ')).toMatch(/Not saved: that is not a OpenRouter key: a key is 20 to 512 characters, and this is 13\./);
    expect(c.ui.input).toEqual({ field: 'secret', text: '' });
    // FIXTURE: a string of a key's shape (not a key): saved, not checked; its fingerprint only
    const KEY = 'FIXTURE-not-a-real-key-0123456789';
    t = see(press(c, KEY));
    expect(mid(t)).toContain(`› ${KEY.length} characters typed (hidden)`);
    t = see(press(c, '\r', ENTER));
    expect(mid(t)).toContain('OpenRouter: the key is saved');
    expect(mid(t).join(' ')).toMatch(/Saved, not checked: the OpenRouter key \(key [0-9a-f]{12}\) is in providers\.json in the Timmy home \(0600\)\./);
    expect(mid(t).join(' ')).toMatch(/The route as read now: chat: local · no model chosen · \/model\. The setup's answer keeps the chat local/);
    expect(providers()).toMatchObject({ openrouter_api_key: KEY, ollama_host: 'http://127.0.0.1:9' });
    // Models on OpenRouter says it in H170's words, once its states are read again
    for (const end = Date.now() + 5_000; Date.now() < end && cols(shown(c)[5], 92, 121) !== 'saved, not checked'; await sleep(20)) { /* the states read again */ }
    expect(cols(see(shown(c))[5], 92, 121)).toBe('saved, not checked');
    // what was typed was never on the screen, at any step
    for (const f of frames) { expect(f).not.toContain(KEY); expect(f).not.toContain('FIXTURE-short'); }
    expect(c.ui.input).toEqual({ field: null, text: '' });
  });
});

describe('H168\'s pass 3b through the Controller (R10 CHAT H167): R16, R17', { timeout: 60_000 }, () => {
  const rail = (rows: string[]) => rows.map((r) => cols(r, 92, 121));
  const mid = (rows: string[]) => rows.map((r) => cols(r, 20, 89));

  it('R16: the cursor drawn, Enter and the arrows act on one row: the next turn\'s model drawn first, Enter takes that one; ↑ moves from it, Enter takes the row drawn', async () => {
    const chosen: string[] = [];
    const c = workbench(homeWithModel('r16'), {
      // FAKE: what the local Ollama lists (no request): a model the check does not establish first, the route's model last
      ollama: async () => ({ where: 'FAKE Ollama', answered: true, listed: 3, cloud: 0, models: [
        { name: 'fake-embed-text:latest', facts: 'local weights · 137M · F16', chat: false },
        { name: 'fake-llama3.2:3b', facts: 'local weights · 3B · Q4_K_M', chat: true },
        { name: 'fake-qwen3:8b', facts: 'local weights · 8B · Q4_K_M', chat: true },
      ] }),
      // FAKE: the setup's writer, recording what it is asked to write (nothing is written); R11 step 1a: the check each
      // choice asks (FAKE: no request)
      checkLocal: fakeCheck({ 'fake-llama3.2:3b': 'ready', 'fake-qwen3:8b': 'ready', 'fake-embed-text:latest': 'not-a-chat-model' }, 10).checkLocal,
      setLocal: async (m: string) => { chosen.push(m); return { written: [] }; },
      blank: async () => false,
    });
    shown(c);
    press(c, 'M');
    const drawn = (): string[] => rail(shown(c)).filter((x) => x.startsWith('> FAKE'));
    for (const end = Date.now() + 5_000; Date.now() < end && drawn()[0] !== '> FAKE fake-qwen3:8b'; await sleep(20)) { /* the list read */ }
    expect(drawn()).toEqual(['> FAKE fake-qwen3:8b']);
    press(c, '\r', ENTER);
    for (const end = Date.now() + 5_000; Date.now() < end && chosen.length < 1; await sleep(20)) shown(c);
    expect(chosen).toEqual(['fake-qwen3:8b']);
    // (R11 step 1a: the composer has the keyboard after the choice) Esc leaves it; Models again: ↑ from the row drawn
    press(c, '', ESC);
    press(c, 'M');
    press(c, '', { upArrow: true });
    expect(drawn()).toEqual(['> FAKE fake-llama3.2:3b']);
    press(c, '\r', ENTER);
    for (const end = Date.now() + 5_000; Date.now() < end && chosen.length < 2; await sleep(20)) shown(c);
    expect(chosen).toEqual(['fake-qwen3:8b', 'fake-llama3.2:3b']);
    press(c, '', ESC);
    press(c, 'M');
    press(c, '', { upArrow: true });
    press(c, '', { upArrow: true });
    expect(drawn()).toEqual(['> FAKE fake-embed-text:late…']);
    press(c, '\r', ENTER);
    for (const end = Date.now() + 5_000; Date.now() < end && c.ui.modelCheck?.state === 'checking'; await sleep(20)) shown(c);
    expect(chosen).toHaveLength(2);
    expect(c.ui.flash?.text ?? '').toBe('Not chosen: not a chat model: no completion capability.');
  });

  it('R17 (R11: no shipped default, H169\'s Phase 0 item 1): a key pasted in a home with no chat answer chooses no model: the route refuses every send until one is chosen, Models starts on OpenRouter\'s free ones, nothing is sent; Check the key asks only the key endpoint (FAKE); a priced model chosen in Models is the next turn\'s, said with its price', async () => {
    const p = homeWithModel('r17', false);
    // a fresh home's setup: no chat answer (the key pasted below is the first route)
    writeFileSync(join(process.env.TIMMY_HOME ?? '', 'setup.json'), JSON.stringify({ version: 1, by: 'timmy init', answers: { operator: 'Sample', ollama: 'http://127.0.0.1:9', project: 'r17' } }));
    // FIXTURE: a priced model (its price made up here: $5 / $25 per 1M); R11: nothing ships as a default any more
    const DEFAULT = 'fixture-maker/priced-model';
    const saved: string[] = [];
    let checks = 0;
    const catalog = [...FIXTURE_CATALOG, { id: DEFAULT, name: 'FIXTURE: Default', created: 1_760_000_000, context_length: 200_000, pricing: { prompt: '0.000005', completion: '0.000025' } }];
    // (the writer as the real one writes: the settings' model, in this test's own settings folder; R11: the route reads it,
    // and with none written it refuses every send)
    saveConfig({ model: '' });
    expect(loadConfig().model).toBe('');
    const c = workbench(p, { catalog: async () => ({ from: 'shipped', at: '2026-09-07', models: catalog }), saveModel: async (id: string) => { saved.push(id); saveConfig({ model: id }); return { path: 'the settings (this test\'s folder)' }; } }, {
      // FAKE: H170's check of OpenRouter's key endpoint, answered here (nothing is asked)
      checkKey: async () => { checks++; return { id: 'openrouter', state: 'checked', at: new Date().toISOString(), words: 'FAKE: the key endpoint took the key; no model was called.' }; },
    });
    let t = shown(c);
    expect(cols(t[4], 20, 89)).toBe('WELCOME TO TIMMY');
    // OpenRouter / cloud, Paste a key, a FIXTURE string of a key's shape (not a key), Enter
    press(c, '\r', ENTER);
    press(c, '', { downArrow: true });
    press(c, '\r', ENTER);
    expect(c.ui.input.field).toBe('secret');
    press(c, 'FIXTURE-not-a-real-key-0123456789');
    t = press(c, '\r', ENTER);
    // (R11: the route itself refuses: no model chosen, not ready, its refusal lines; nothing was ever the default)
    expect(c.data.route).toMatchObject({ kind: 'openrouter', ready: false, noneChosen: true, words: 'chat: OpenRouter · no model chosen' });
    expect(c.data.route.unchosen).toBeUndefined();
    expect(c.data.route.refusal?.[0]).toMatch(/^Error: No model chosen\./);
    expect(mid(t)).toContain('OpenRouter: the key is saved');
    expect(mid(t).join(' ')).toMatch(/No model is chosen for the next turn yet, and nothing is sent from here until one is/);
    expect(mid(t).join(' ')).toMatch(/No surface sends a turn until one is chosen\./);
    expect(mid(t).join(' ')).not.toMatch(/claude-opus|settings' default/);
    expect(mid(t)).toContain('> [ Check the key ]');
    expect(cols(t[1], 20, 121)).toBe('NEXT / OpenRouter / no model chosen: Models (M)');
    expect(c.ui.modelsProvider).toBe('openrouter');
    // (H168's pass 3c, R17b: the free start is the route's, no model chosen, every launch: a key sets no Cost)
    expect(c.ui.modelsCost).toBeUndefined();
    // Check the key: the FAKE check, its answer with its time; no model called
    press(c, '\r', ENTER);
    for (const end = Date.now() + 5_000; Date.now() < end && !mid(shown(c)).join(' ').includes('Checked'); await sleep(20)) { /* the FAKE check */ }
    expect(checks).toBe(1);
    expect(mid(shown(c)).join(' ')).toMatch(/Checked \(\d\d:\d\d\): FAKE: the key endpoint took the key; no model was called\./);
    // Choose an OpenRouter model: Models on OpenRouter, Free (start), the free one listed; no SELECTED
    press(c, '', { downArrow: true });
    t = press(c, '\r', ENTER);
    expect(c.ui.focus).toBe('right');
    expect(rail(t)[16]).toBe('Cost       Free (start)');
    expect(rail(t)[20]).toBe('> FIXTURE: Newest (free)');
    expect(t.join('\n')).not.toMatch(/SELECTED/);
    // a message now: not sent (the settings' default is nobody's choice); what was typed stays
    press(c, '', ESC);
    press(c, '', { downArrow: true });
    press(c, '', { downArrow: true });
    press(c, '\r', ENTER);
    expect(c.ui.input.field).toBe('composer');
    press(c, 'FIXTURE: a message');
    press(c, '\r', ENTER);
    expect(c.ui.flash?.text).toBe('Not sent: no OpenRouter model chosen yet. What you typed stays; M chooses one.');
    expect(c.ui.input).toEqual({ field: 'composer', text: 'FIXTURE: a message' });
    // Models: Cost to Paid (no longer the starting filter), the default chosen: the next turn's, said with its price
    press(c, '', ESC);
    press(c, 'M');
    press(c, '', { upArrow: true });
    press(c, '', { upArrow: true });
    t = press(c, '', { rightArrow: true });
    expect(rail(t)[16]).toBe('Cost       < Paid >');
    press(c, '', { downArrow: true });
    t = press(c, '', { downArrow: true });
    expect(rail(t)[20]).toBe('> FIXTURE: Default');
    press(c, '\r', ENTER);
    // (the choice is saved, recorded and said once the FAKE writer's answer is back: the notice says when)
    for (const end = Date.now() + 5_000; Date.now() < end && !/^Next turn: /.test(c.ui.flash?.text ?? ''); await sleep(20)) shown(c);
    expect(saved).toEqual([DEFAULT]);
    expect(readSettings(process.env).settings.openRouterModel).toBe(DEFAULT);
    expect(c.data.route.unchosen).toBeUndefined();
    expect(c.data.route.noneChosen).toBeUndefined();
    expect(c.data.route.ready).toBe(true);
    expect(c.ui.flash?.text).toBe(`Next turn: ${DEFAULT} on OpenRouter (paid: $5.00/$25 per 1M).`);
    t = shown(c);
    expect(cols(t[1], 20, 121)).toBe(`NEXT / OpenRouter / ${DEFAULT}`);
    const r = rail(t);
    expect(r.slice(28, 34)).toEqual(['SELECTED / FIXTURE: Default', 'No description in the', 'catalog.', 'The next turn uses it, paid:', '$5.00 in / $25 out per 1M', 'Catalog snapshot: Sep 7']);
    // (the settings' model back to none for the cases after this one)
    saveConfig({ model: '' });
  });
});

describe('H168\'s pass 3a through the Controller (R10 CHAT H167): R1, R3, R4, R7, R8, R9', { timeout: 60_000 }, () => {
  const rail = (rows: string[]) => rows.map((r) => cols(r, 92, 121));
  const mid = (rows: string[]) => rows.map((r) => cols(r, 20, 89));

  it('R4: a fresh home\'s message with no model is not sent, as the route says, even with its session open: the no-model view and its choices stay; no garbled cause', async () => {
    const p = homeWithModel('r4fresh', false);
    // a fresh home's setup: no chat answer at all (no key, no local model: the route is none)
    writeFileSync(join(process.env.TIMMY_HOME ?? '', 'setup.json'), JSON.stringify({ version: 1, by: 'timmy init', answers: { operator: 'Sample', ollama: 'http://127.0.0.1:9', project: 'r4fresh' } }));
    const fake = fakeSession({ route: { kind: 'none', words: 'chat: no model key · /setup', ready: false } });
    const c = workbench(p, {}, { producers: fake.producers });
    // (the producers load at start, as `timmy workbench` starts it: the FAKE session opens then)
    c.start();
    for (const end = Date.now() + 5_000; Date.now() < end && !c.can().chat; await sleep(20)) shown(c);
    expect(c.can().chat, 'the session opened: it would take a message').toBe(true);
    let t = shown(c);
    expect(cols(t[4], 20, 89)).toBe('WELCOME TO TIMMY');
    for (let i = 0; i < 3; i++) press(c, '', { downArrow: true });
    press(c, '\r', ENTER);
    press(c, '', { downArrow: true });
    press(c, '', { downArrow: true });
    t = press(c, '\r', ENTER);
    expect(c.ui.input.field).toBe('composer');
    press(c, 'FIXTURE: a message with no model');
    t = press(c, '\r', ENTER);
    expect(fake.sends()).toBe(0);
    expect(c.ui.flash?.text).toBe('Not sent: no model for the next turn. What you typed stays; M chooses a model.');
    // the notice whole on the status row at 122x37 (the size at its right end)
    expect(cols(t[36], 19, 121)).toMatch(/^ Not sent: no model for the next turn\. What you typed stays; M chooses a model\. +122 x 37$/);
    expect(c.ui.input).toEqual({ field: 'composer', text: 'FIXTURE: a message with no model' });
    expect(mid(t)[7]).toBe('A model is optional until you need an answer.');
    expect(mid(t)).toContain('  [ Review setup choices ]');
    expect(t.join('\n')).not.toMatch(/Cause|a setting \(\[i\]\)|YOUR LAST MESSAGE/);
  });

  it('R1: Models asks the local Ollama again after a turn\'s end and when shown, while its last answer failed or is older than 30 s, and on r (never twice at once); a failure is dated', async () => {
    let calls = 0;
    let up = false;
    let skew = 0;
    const fake = fakeSession();
    const c = workbench(homeWithModel('r1'), {
      // FAKE: the local Ollama as the setup's deps ask it: refused until `up`
      ollama: async () => { calls++; return up ? { where: 'FAKE Ollama', answered: true, models: [{ name: 'fake-qwen3:8b', facts: 'local weights · 8B · Q4_K_M', chat: true }], listed: 1, cloud: 0 } : { where: 'FAKE Ollama', answered: false, models: [], listed: 0, cloud: 0, why: 'FAKE: the connection was refused' }; },
    }, { producers: fake.producers, now: () => Date.now() + skew });
    c.start();
    const listed = async (): Promise<void> => { for (const end = Date.now() + 5_000; Date.now() < end && c.data.models?.ollama?.state !== 'listed'; await sleep(20)) shown(c); };
    // the read at launch (the route is local): refused, and dated; once (the producers' load asks nothing more)
    for (const end = Date.now() + 5_000; Date.now() < end && !rail(shown(c)).some((r) => /^NO ANSWER \/ asked \d\d:\d\d$/.test(r)); await sleep(20)) { /* the first read */ }
    expect(rail(shown(c)).some((r) => /^NO ANSWER \/ asked \d\d:\d\d$/.test(r))).toBe(true);
    expect(calls).toBe(1);
    // a turn (the FAKE session answers): its end asks again, the last answer having failed
    for (const end = Date.now() + 5_000; Date.now() < end && !c.can().chat; await sleep(20)) shown(c);
    press(c, '\r', ENTER);
    press(c, 'FIXTURE: a question');
    press(c, '\r', ENTER);
    for (const end = Date.now() + 5_000; Date.now() < end && calls < 2; await sleep(20)) shown(c);
    expect(fake.sends()).toBe(1);
    expect(calls).toBe(2);
    // Ollama answers now; M shows Models, its last answer failed: asked again, listed
    up = true;
    press(c, '', ESC);
    press(c, 'M');
    for (const end = Date.now() + 5_000; Date.now() < end && !rail(shown(c)).some((r) => /^INSTALLED \/ read/.test(r)); await sleep(20)) { /* read again */ }
    expect(calls).toBe(3);
    await listed();
    // shown again within 30 s: not asked; 31 s later: asked
    press(c, '', ESC);
    press(c, 'M');
    await sleep(50);
    expect(calls).toBe(3);
    skew = 31_000;
    press(c, '', ESC);
    press(c, 'M');
    for (const end = Date.now() + 5_000; Date.now() < end && calls < 4; await sleep(20)) shown(c);
    expect(calls).toBe(4);
    await listed();
    // r: asked again
    press(c, '', ESC);
    press(c, 'r');
    for (const end = Date.now() + 5_000; Date.now() < end && calls < 5; await sleep(20)) shown(c);
    expect(calls).toBe(5);
  });

  it('R3: Models\' controls from the keyboard: ↑ above the first model reaches them, ← → and Enter change them over H169\'s query, / and Enter on Search type into it, Enter keeps the matches, Esc clears them', async () => {
    const c = workbench(homeWithModel('r3'), { catalog: async () => ({ from: 'shipped', at: '2026-09-07', models: FIXTURE_CATALOG }) });
    shown(c);
    press(c, 'M');
    press(c, '', { leftArrow: true });
    for (const end = Date.now() + 5_000; Date.now() < end && !rail(shown(c)).some((r) => /FIXTURE: Newest/.test(r)); await sleep(20)) { /* the catalog read */ }
    let r = rail(shown(c));
    expect(r[6]).toBe('> OpenRouter');
    expect(r[16]).toBe('Cost       All (default)');
    // ↑ from the first model: Context; ↑ again: Cost
    press(c, '', { upArrow: true });
    expect(c.ui.modelsControl).toBe(5);
    r = rail(press(c, '', { upArrow: true }));
    expect(r[16]).toBe('Cost       < All (default) >');
    // →: Free only, and the list is what the query keeps
    r = rail(press(c, '', { rightArrow: true }));
    expect(r[16]).toBe('Cost       < Free only >');
    expect(r.slice(20, 23)).toEqual(['> FIXTURE: Newest (free)', '  262k context / Free', '']);
    // Enter: its next value
    r = rail(press(c, '\r', ENTER));
    expect(r[16]).toBe('Cost       < Paid >');
    expect(r.slice(20, 23)).toEqual(['> FIXTURE: Older model', '  32k context / $0.50/$1.50', '']);
    // up to Search; Enter types into it, each key filters
    for (let i = 0; i < 4; i++) press(c, '', { upArrow: true });
    expect(c.ui.modelsControl).toBe(0);
    press(c, '', { rightArrow: true });
    expect(c.ui.input.field).toBeNull();
    press(c, '\r', ENTER);
    expect(c.ui.input.field).toBe('msearch');
    press(c, '', { leftArrow: true });
    press(c, 'All');
    r = rail(shown(c));
    expect(r[11]).toBe('Search All');
    expect(r[20]).toBe('No model matches.');
    for (let i = 0; i < 3; i++) press(c, '', { backspace: true });
    r = rail(press(c, 'older'));
    expect(r[11]).toBe('Search older');
    expect(r[20]).toBe('> FIXTURE: Older model');
    // Enter keeps the matches, the keyboard on the first; / types into Search again; Esc clears it
    press(c, '\r', ENTER);
    expect(c.ui.modelsControl).toBeUndefined();
    expect(c.ui.modelsSearch).toBe('older');
    expect(c.ui.cursor['right:models']).toBe(0);
    press(c, '/');
    expect(c.ui.input).toEqual({ field: 'msearch', text: 'older' });
    press(c, '', ESC);
    expect(c.ui.modelsSearch).toBeUndefined();
    expect(c.ui.flash?.text).toBe('Search cleared: Models lists every model the filters keep.');
    // a control left from OpenRouter never takes ← → on another provider's list: → changes the provider there, Cost stays
    c.ui.modelsControl = 4;
    c.ui.modelsProvider = 'ollama-local';
    press(c, '', { rightArrow: true });
    expect(c.ui.modelsProvider).toBe('ollama-cloud');
    expect(c.ui.modelsControl).toBeUndefined();
    expect(c.ui.modelsCost).toBe('paid');
  });

  it('R7: [M] Models, [ Details ] and [ Close ] are targets: a click acts as their key', () => {
    const c = workbench(homeWithModel('r7'));
    c.ui.mouse = true;
    const at80 = (): string[] => c.frame(80, 24).screen.map(rowText);
    let t = at80();
    const m = t[4].indexOf('[M] Models');
    expect(m).toBeGreaterThan(0);
    c.mouse({ button: 0, x: m + 5, y: 5, press: true });
    expect(c.ui.focus).toBe('right');
    expect(c.ui.modelsOpen).toBe(true);
    t = at80();
    const close = t[4].indexOf('[ Close ]');
    expect(close).toBeGreaterThan(0);
    c.mouse({ button: 0, x: close + 3, y: 5, press: true });
    expect(c.ui.modelsOpen).toBe(false);
    // 122x37: [ Details ], and [M] beside MODELS
    t = shown(c);
    const d = t[4].indexOf('[ Details ]');
    c.mouse({ button: 0, x: d + 3, y: 5, press: true });
    expect(c.ui.modelsDetails).toBe(true);
    expect(c.ui.focus).toBe('right');
    c.key('', ESC);
    t = shown(c);
    c.mouse({ button: 0, x: t[4].indexOf('[M]') + 2, y: 5, press: true });
    expect(c.ui.focus).toBe('right');
  });

  it('R8: a click while this Workbench\'s turn is answered says Tab leaves the composer, the text kept (Esc would stop the turn)', async () => {
    let release: () => void = () => undefined;
    const fake = fakeSession({ answer: () => new Promise<ChatTurnResult>((done) => { release = () => done({ status: 'answered', text: 'FAKE answer (no model behind it).', sent: true, costWords: 'no charge (FAKE)' }); }) });
    const c = workbench(homeWithModel('r8'), {}, { producers: fake.producers });
    c.start();
    c.ui.mouse = true;
    for (const end = Date.now() + 5_000; Date.now() < end && !c.can().chat; await sleep(20)) shown(c);
    press(c, '\r', ENTER);
    press(c, 'FIXTURE: a question');
    press(c, '\r', ENTER);
    for (const end = Date.now() + 5_000; Date.now() < end && c.data.turn?.state !== 'sending'; await sleep(20)) shown(c);
    expect(c.data.turn?.state).toBe('sending');
    expect(c.ui.input.field).toBe('composer');
    const t = shown(c);
    c.mouse({ button: 0, x: t[4].indexOf('MODELS') + 2, y: 5, press: true });
    expect(c.ui.flash?.text).toBe('A field has the keyboard: Tab leaves it, the text kept as a draft (Esc would stop the turn being answered).');
    release();
    for (const end = Date.now() + 5_000; Date.now() < end && c.data.turn?.state === 'sending'; await sleep(20)) shown(c);
  });

  it('R10: ? on the Chat screen: its own keys, the title row saying which rows show; ↓ scrolls them, Esc closes', () => {
    const c = workbench(homeWithModel('r10'));
    shown(c);
    let t = press(c, '?');
    expect(c.ui.overlay?.kind).toBe('help');
    const note = /^CHAT \/ r10 +Keys (\d+)–(\d+) of (\d+)$/;
    const m = note.exec(cols(t[4], 20, 89));
    expect(m, cols(t[4], 20, 89)).not.toBeNull();
    const [from, to, of] = [Number(m![1]), Number(m![2]), Number(m![3])];
    expect(from).toBe(1);
    expect(of).toBeGreaterThan(to);
    expect(mid(t).join('\n')).toMatch(/Tab +the next pane: the left menu, the conversation,/);
    t = press(c, '', { downArrow: true });
    expect(cols(t[4], 20, 89)).toMatch(new RegExp(`Keys 2–${to + 1} of ${of}$`));
    press(c, '', ESC);
    expect(c.ui.overlay).toBeNull();
  });

  it('the lead\'s guard with R24: when the open session would ask another model than the screen shows as the next turn\'s, nothing is sent and what was typed stays', async () => {
    let words = 'chat: fake/shown-model · OpenRouter';
    let sends = 0;
    // FAKE: a session in the contract's shape whose route changes after it opened (as a model chosen elsewhere would)
    const session: ChatSession = {
      route: () => ({ kind: 'openrouter', words, ready: true }),
      send: async () => { sends++; return { status: 'answered', text: 'FAKE answer (no model behind it).', sent: true, costWords: 'no charge (FAKE)' }; },
      sendOnce: async (_k, text, hooks) => session.send(text, hooks),
    };
    const c = workbench(homeWithModel('guard'), {}, { producers: { runDetail: async () => ({ ok: false, why: 'FIXTURE: none' }), openChat: async () => ({ ok: true, value: async () => session }) } });
    c.start();
    for (const end = Date.now() + 5_000; Date.now() < end && !c.can().chat; await sleep(20)) shown(c);
    expect(c.can().chat).toBe(true);
    // (the screen shows the session's route as read when it opened: its model is the next turn's on screen)
    expect(cols(shown(c)[1], 20, 121)).toMatch(/ \/ FAKE fake\/shown-model$/);
    words = 'chat: fake/other-model · OpenRouter';
    press(c, '\r', ENTER);
    press(c, 'FIXTURE: a message');
    press(c, '\r', ENTER);
    for (const end = Date.now() + 2_000; Date.now() < end && !/^Not sent: the chat would ask/.test(c.ui.flash?.text ?? ''); await sleep(20)) shown(c);
    expect(c.ui.flash?.text).toBe('Not sent: the chat would ask fake/other-model, not fake/shown-model as shown. What you typed stays.');
    expect(sends).toBe(0);
    expect(c.ui.input).toEqual({ field: 'composer', text: 'FIXTURE: a message' });
  });

  it('R9: the composer holds 4,000 characters and says so when it is full', () => {
    const c = workbench(homeWithModel('r9'));
    press(c, '\r', ENTER);
    expect(c.ui.input.field).toBe('composer');
    c.paste('a'.repeat(4005));
    expect(c.ui.input.text).toHaveLength(4000);
    expect(c.ui.flash?.text).toBe('The message holds 4,000 characters; the rest was not typed in.');
  });
});
