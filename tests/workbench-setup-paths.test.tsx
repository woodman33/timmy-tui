/**
 * R5 (H131; the operator's finish line, item 3): the chat's fixes, done from the Workbench (src/workbench/setup-paths.ts).
 * The workspace frame names one fix when chat cannot answer (src/ops/workspace-frame.ts chatFix), and Enter on it does the
 * thing where the Workbench can do it honestly: /model free lists the free models of this computer's catalog and saves the
 * one chosen; /model on the local route lists what Ollama has and sets the setup's answer; timmy workspace check runs the
 * check here; the setup (every `timmy init …`, a stray `timmy setup`, /setup chat) shows its command and what it asks now,
 * the key typed hidden in a terminal, never into a tab.
 *
 * Every catalog, Ollama answer and check here is FAKE: FAKE deps, or the real check (checkConnections) with FAKE probes. No
 * request leaves this process, no model is called, nothing is charged. Timmy's home, the workspace root and its private folder
 * are this test's temporary folders; the settings store is this test file's own (tests/isolation-setup.ts), and saving a model
 * is checked to write there only.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { chatFix, checkConnections, type CheckDeps } from '../src/ops/workspace-frame.js';
import { createProject, projectId, saveActiveProject } from '../src/project/index.js';
import type { ApprovalRequest, Decision } from '../src/repl/approvals.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import { visibleWidth } from '../src/term/width.js';
import { getConfig } from '../src/utils/config.js';
import { applyInit } from '../src/utils/init.js';
import { appendReceipt, readChain } from '../src/utils/receipts.js';
import type { WorkspaceAction } from '../src/contracts/workspace.js';
import { Controller } from '../src/workbench/controller.js';
import { glyphsFor, screenText } from '../src/workbench/frame.js';
import { routeOf } from '../src/workbench/hub.js';
import type { Producers } from '../src/workbench/producers.js';
import { CompanionControl, StudioControl, type Opener } from '../src/workbench/servers.js';
import { catalogWords, checkRows, initFlags, realSetupDeps, type FreeCatalog, type OllamaList, type SetupDeps } from '../src/workbench/setup-paths.js';
import { pageActions } from '../src/workbench/views.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FAKE_OPENER: Opener = { program: null, open: () => ({ ok: false, why: 'FAKE opener: nothing is opened in this test' }) };
const NO_CHAT = { runDetail: async () => ({ ok: false, why: 'FAKE: no run detail in this test' }), openChat: async () => ({ ok: false, why: 'FAKE: no chat session in this test' }) } as Producers;
/** this test file's own settings folder (tests/isolation-setup.ts), where the settings store keeps its file */
const SETTINGS = resolve(process.env.TIMMY_SETTINGS_DIR ?? '');
const ENTER = { return: true };
const ESC = { escape: true };
const DOWN = { downArrow: true };

/** FAKE: three free models of a catalog "fetched" on a FAKE day */
const FAKE_CATALOG: FreeCatalog = {
  from: 'fetched', at: '2026-10-01',
  models: [
    { id: 'fake-lab/alpha:free', ctx: 131072, tools: true },
    { id: 'fake-lab/beta:free', ctx: 32768, tools: false },
    { id: 'fake-lab/gamma:free', tools: null },
  ],
};
/** FAKE: what an Ollama on this computer lists (one cloud-backed model besides, not offered) */
const FAKE_OLLAMA: OllamaList = {
  where: 'Ollama at 127.0.0.1:11434', answered: true, listed: 3, cloud: 1,
  models: [{ name: 'fake-llama:8b', facts: 'local weights · 8B · Q4_K_M · 4.9 GB' }, { name: 'fake-qwen:4b', facts: 'local weights · 4B' }],
};
/** FAKE probes for the real check: nothing is asked over the network */
const probes = (ollamaOk: boolean): CheckDeps => ({
  openRouter: async () => 'not-asked',
  ollama: async () => (ollamaOk
    ? { ok: true, models: ['fake-llama:8b'], latencyMs: 3, base: 'http://127.0.0.1:11434', answer: { state: 'listed', listed: 2, cloud: 1, checked: 1, failed: 0, late: 0, deadlineMs: 1500 } }
    : { ok: false, models: [], answer: { state: 'no answer', why: 'FAKE: nothing listens on 127.0.0.1:11434' } }) as Awaited<ReturnType<NonNullable<CheckDeps['ollama']>>>,
  studio: async () => ({ state: 'not-running' }),
  companion: async () => 'refused',
});

let box = '';
let n = 0;
let made = 0;
const opened: Controller[] = [];
const spaces: Workspace[] = [];

beforeAll(() => { box = mkdtempSync(join(tmpdir(), 'wb-setup-paths-')); });
afterAll(() => { rmSync(box, { recursive: true, force: true }); });
afterEach(async () => {
  for (const c of opened.splice(0)) c.dispose();
  for (const ws of spaces.splice(0)) await ws.close({ by: 'as the test ended' });
  vi.unstubAllEnvs();
});

/** This test's own Timmy home and workspace root: nothing set up, no key, free-only off. */
function sandbox(): { home: string; repo: string } {
  const at = join(box, `t${++n}`);
  const home = join(at, 'timmy');
  const repo = join(at, 'workspace');
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  vi.stubEnv('TIMMY_HOME', home);
  // R10 CHAT (H167): this file checks the classic Chat tab (row 2's actions, the pipeline, the event log); the Chat screen's
  // shell that replaces it is tests/workbench-chat-shell.test.ts's
  vi.stubEnv('TIMMY_WORKBENCH_CHAT', 'classic');
  vi.stubEnv('TIMMY_REPO_ROOT', repo);
  vi.stubEnv('TIMMY_PRIVATE_DIR', join(repo, '.timmy', 'private'));
  vi.stubEnv('OPENROUTER_API_KEY', '');
  vi.stubEnv('OPENROUTER_MODEL', '');
  vi.stubEnv('TIMMY_CHAT_MODEL', '');
  vi.stubEnv('TIMMY_CHAT_FREE_ONLY', '');
  return { home, repo };
}

/** The setup run as `timmy init --yes` would (an identity made, the answers written), in this test's home and workspace. */
function setUp(repo: string, more: Partial<Parameters<typeof applyInit>[0]> = {}): void {
  applyInit({ operator: 'FAKE operator', project: 'fake-first', ...more }, repo);
}

/** A Workbench on a project of this test's, with the chat's fixes given `setup` (FAKE) over the real ones. */
function workbench(setup: Partial<SetupDeps>): Controller {
  const project = createProject(`setup-paths-${++made}`);
  if ('error' in project) throw new Error(project.error);
  saveActiveProject(project);
  const env: NodeJS.ProcessEnv = { ...process.env };
  const jobsDir = join(process.env.TIMMY_HOME ?? box, 'jobs');
  let c: Controller | undefined;
  const ws = new Workspace({
    glyphs: glyphSet(true), env, onPath: () => null,
    notify: (l) => c?.say(l.map((s) => s.text).join('').trim()), openWeb: () => '', link: (t) => t,
    seal: (input) => appendReceipt('runs', input).hash.slice(7, 15), receipts: () => readChain('runs'),
    jobsDir, recoverAtStart: false, chdir: () => undefined,
    askPerson: (req: ApprovalRequest): Promise<Decision> => (c ? c.askPerson(req) : Promise.resolve('deny')),
  }, project);
  spaces.push(ws);
  c = new Controller({
    env, jobsDir, onPath: () => null, glyphs: glyphsFor(true), workspace: ws, producers: NO_CHAT,
    companion: new CompanionControl({ opener: FAKE_OPENER, start: async () => { throw new Error('FAKE: no server is started in this test'); } }),
    studio: new StudioControl({ env: process.env, opener: FAKE_OPENER, project: () => ws.project, projectId, jobsDir, receipts: () => join(box, 'store'), ensure: async () => ({ state: 'failed', error: 'FAKE: no Studio in this test' }) }),
    capabilities: async () => [], tickMs: 100, slowMs: 400, setup,
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
    await sleep(25);
  }
}

/** One region's words as drawn, its rows joined and its runs of spaces as one. */
function region(c: Controller, name: 'top' | 'center' | 'right', columns = 160, rows = 60): string {
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
const screen = (c: Controller): string => screenText(c.frame(160, 60).screen).join('\n');

/** The words of the box open now, when it is a message (its lines as given, joined). */
function message(c: Controller): string {
  const o = c.ui.overlay;
  return o?.kind === 'message' ? `${o.title}\n${o.lines.map((l) => l.map((s) => s.text).join('')).join('\n')}` : '';
}

/** The Chat tab's actions once the frame is read: the fix the frame makes primary, by its route. */
async function chatActions(c: Controller): Promise<WorkspaceAction[]> {
  c.selectPage('chat');
  await until('the frame', () => c.data.frame && pageActions(c).acts.length, 10_000, () => screen(c));
  return pageActions(c).acts;
}

const action = (command: string, label = `FAKE action: ${command}`): WorkspaceAction => ({ n: 9, label, command, enabled: true, primary: false, effect: 'local change' } as WorkspaceAction);

describe('the chat\'s fixes, done from the Workbench (R5 H131, the finish line item 3)', () => {
  it('every fix the frame names has a path here (none is only a command to copy), and every timmy init … is the setup\'s box', () => {
    const fixes = [
      chatFix({ kind: 'none', ready: false }),
      chatFix({ kind: 'local', ready: false, refusal: ['Error: the chat is set to the local model, and no model is chosen.'] }),
      chatFix({ kind: 'local', ready: false, refusal: ['Error: the chat is set to the local model, and its Ollama address is not one Timmy uses.'] }),
      chatFix({ kind: 'local', ready: true }, [{ id: 'ollama', state: 'unreachable', words: 'FAKE: no answer when checked just now' }]),
      chatFix({ kind: 'openrouter', ready: false }),
      chatFix({ kind: 'openrouter', ready: true }, [{ id: 'openrouter', state: 'refused', words: 'FAKE: refused when checked just now' }]),
    ];
    expect(fixes.map((f) => f?.problem)).toEqual(['no-route', 'no-local-model', 'ollama-address', 'ollama-unreachable', 'free-only', 'key-refused']);
    expect(fixes.map((f) => routeOf({ command: f!.command }).kind)).toEqual(['setup', 'model', 'setup', 'check', 'free-models', 'setup']);
    // every `timmy init …` (the cards' steps too), a stray `timmy setup` and /setup: the setup's own box; /setup chat its own
    for (const cmd of ['timmy init', 'timmy init --chat openrouter', 'timmy init --chat local --model <name>', 'timmy init --ollama <host>', 'timmy setup', '/setup']) {
      expect(routeOf({ command: cmd })).toMatchObject({ kind: 'setup', which: 'init' });
    }
    expect(routeOf({ command: '/setup chat' })).toMatchObject({ kind: 'setup', which: 'chat' });
    expect(routeOf({ command: 'timmy init --chat local --model <name>' }).words).toContain('chooses the local model here');
    expect(routeOf({ command: 'timmy initialize' }).kind).toBe('show');
    // the flags the setup reads (a <placeholder> is the person's to give)
    expect(initFlags('timmy init --chat local --model <name>')).toEqual(['--chat', 'local', '--model']);
    expect(initFlags('timmy setup')).toEqual([]);
  });

  it('/model free: a box of the FAKE catalog\'s free models with their context and tool calling; Enter saves the one chosen in this test file\'s settings only, and says what changed and what did not', async () => {
    sandbox();
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-FAKE-not-a-key');
    vi.stubEnv('TIMMY_CHAT_FREE_ONLY', '1');
    const before = getConfig().get('model');
    try {
      const c = workbench({ freeModels: async () => FAKE_CATALOG });
      c.start();
      const fix = (await chatActions(c)).find((a) => a.primary);
      expect(fix).toMatchObject({ n: 2, label: 'Choose a free model (free-only stays on)', command: '/model free' });
      // the Ready line names the same one fix
      expect(region(c, 'center')).toContain('Ready not ready: choose a free model (free-only stays on) (the next step above, Enter)');
      await c.runAction(fix);
      await until('the list', () => c.ui.overlay?.kind === 'free-models' && c.ui.overlay.state === 'listed');
      const listed = region(c, 'center');
      expect(listed).toContain('Choose a free model free-only stays on');
      expect(listed).toContain('From the OpenRouter catalog this computer fetched on 2026-10-01');
      expect(listed).toContain('Free by the catalog\'s prices, not by a check of your account.');
      expect(listed).toContain('FREE MODELS (3)');
      expect(listed).toMatch(/fake-lab\/alpha:free\s+131k context · tools/);
      expect(listed).toMatch(/fake-lab\/beta:free\s+33k context · no tools/);
      expect(listed).toMatch(/fake-lab\/gamma:free\s+context not listed · tool calling not listed/);
      c.key('', DOWN);
      c.key('\r', ENTER);
      await until('the words of what changed', () => message(c));
      // saved in this test file's settings, nowhere else (tests/isolation-setup.ts fails the file on any use of the account's)
      expect(getConfig().get('model')).toBe('fake-lab/beta:free');
      expect(resolve(getConfig().path).startsWith(SETTINGS + sep)).toBe(true);
      expect((JSON.parse(readFileSync(getConfig().path, 'utf8')) as { model?: string }).model).toBe('fake-lab/beta:free');
      const said = message(c);
      expect(said).toContain('Saved fake-lab/beta:free as the chat\'s OpenRouter model, in Timmy\'s settings');
      expect(said).toContain('WHAT CHANGED');
      expect(said).toContain('A chat started after this takes it');
      expect(said).toContain('WHAT DID NOT');
      expect(said).toContain('Free-only is as it was: it is never turned off from here.');
      expect(said).toContain('A REPL already running keeps its model until /model fake-lab/beta:free there.');
      expect(said).toContain('This Workbench\'s chat keeps the model its session was made with until the Workbench starts again');
      expect(said).toContain('Nothing was sent to any model.');
      // the route read again: free by its :free name (the FAKE id is in no catalog), so free-only lets it go
      expect(c.data.route.words).toContain('fake-lab/beta:free');
      expect(c.data.route.ready).toBe(true);
      expect(said).toContain(`The route the settings give now: ${c.data.route.words} (ready).`);
    } finally {
      getConfig().set('model', before);
    }
  }, 30_000);

  it('/model free with no catalog says so and how to fetch one, and lists nothing to choose', async () => {
    sandbox();
    const saved: string[] = [];
    const c = workbench({ freeModels: async () => ({ from: 'none', at: null, models: [] }), saveModel: async (id) => { saved.push(id); return { path: 'FAKE' }; } });
    await c.runAction(action('/model free', 'Choose a free model (free-only stays on)'));
    await until('the box', () => c.ui.overlay?.kind === 'free-models' && c.ui.overlay.state === 'listed');
    const text = region(c, 'center');
    expect(text).toContain('This computer has no OpenRouter catalog, so no model is listed here. timmy models --refresh fetches it (a free request, in a shell)');
    expect(text).not.toContain('Free models (');
    c.key('\r', ENTER);
    await sleep(50);
    expect(c.ui.overlay?.kind).toBe('free-models');
    expect(saved).toEqual([]);
    // the shipped snapshot is named as what it is
    expect(catalogWords({ from: 'shipped', at: '2026-09-07' })).toContain('From the catalog that came with Timmy (of 2026-09-07): this computer has fetched none.');
  }, 30_000);

  it('/model on the local route with no model chosen: what the FAKE Ollama lists (a cloud-backed one not offered); Enter sets it through the setup\'s writer, in this test\'s home and workspace only', async () => {
    const { home, repo } = sandbox();
    setUp(repo, { chat: 'local' });
    const c = workbench({ ollama: async () => FAKE_OLLAMA });
    c.start();
    const fix = (await chatActions(c)).find((a) => a.primary);
    expect(fix).toMatchObject({ n: 2, label: 'Choose the local model (from what Ollama lists)', command: '/model' });
    expect(region(c, 'center')).toContain('Ready not ready: choose the local model (from what Ollama lists) (the next step above, Enter)');
    await c.runAction(fix);
    await until('the list', () => c.ui.overlay?.kind === 'local-models' && c.ui.overlay.state === 'listed');
    const listed = region(c, 'center');
    // (R10 H167; H168's F3: in words; the address is the details', [i])
    expect(listed).toContain('What Ollama on this computer lists now (asked just now, no charge): the local models the chat can take.');
    expect(listed).toContain('1 cloud-backed model it lists is not offered here: Ollama sends that chat off this computer.');
    expect(listed).toContain('LOCAL MODELS (2)');
    expect(listed).toMatch(/fake-llama:8b\s+local weights · 8B · Q4_K_M · 4\.9 GB/);
    c.key('\r', ENTER);
    await until('the words of what changed', () => message(c));
    const said = message(c);
    expect(said).toContain('The chat is set to the local model fake-llama:8b, as the setup\'s answer (written as timmy init --chat local --model writes it).');
    expect(said).toContain('WHAT DID NOT');
    expect(said).toContain('A REPL whose /model chose a model for its session keeps that one there.');
    expect(said).toContain('Nothing was downloaded and nothing was sent to any model');
    // the setup's answer, written by its own writer: in this test's home; every file written is in its home or workspace
    const setupJson = JSON.parse(readFileSync(join(home, 'setup.json'), 'utf8')) as { by: string; answers: { chat?: string; model?: string } };
    expect(setupJson).toMatchObject({ by: 'timmy workbench', answers: { chat: 'local', model: 'fake-llama:8b' } });
    const written = /Written: (.+)\.\n/.exec(said)?.[1].split(', ') ?? [];
    expect(written.length).toBeGreaterThan(0);
    for (const w of written) expect([home, repo].some((root) => resolve(w).startsWith(root + sep))).toBe(true);
    // the route read again: ready on the model chosen, and the frame's fix is gone (Send is the next step again)
    expect(c.data.route).toMatchObject({ kind: 'local', ready: true });
    expect(c.data.route.words).toContain('fake-llama:8b');
    await until('the frame read again', () => pageActions(c).acts.find((a) => a.primary)?.n === 1, 10_000, () => screen(c));
  }, 30_000);

  it('a local model is never chosen before the setup ran: nothing is written, and the setup\'s box offers none', async () => {
    const { home } = sandbox();
    // the chat answered local, and no identity: as a home is between a hand-written setup.json and `timmy init`
    writeFileSync(join(home, 'setup.json'), JSON.stringify({ version: 1, by: 'FAKE', at: new Date().toISOString(), answers: { chat: 'local' } }));
    const set: string[] = [];
    const c = workbench({ ollama: async () => FAKE_OLLAMA, setLocal: async (m) => { set.push(m); return { written: [] }; } });
    c.start();
    const fix = (await chatActions(c)).find((a) => a.primary);
    expect(fix?.command).toBe('/model');
    await c.runAction(fix);
    await until('the list', () => c.ui.overlay?.kind === 'local-models' && c.ui.overlay.state === 'listed');
    c.key('\r', ENTER);
    await until('the refusal', () => message(c));
    expect(message(c)).toContain('Timmy is not set up on this computer yet (it has no identity): timmy init, in a shell, sets it up first; then choose the local model here. Nothing was written.');
    expect(set).toEqual([]);
    // the setup's box for the Ollama card's step says the setup runs first, and offers no local model here
    await c.runAction(action('timmy init --chat local --model <name>'));
    await until('the setup box', () => c.ui.overlay?.kind === 'setup');
    const text = region(c, 'center');
    expect(text).toContain('Timmy is not set up on this computer yet, so it asks each question in turn');
    expect(text).not.toContain('Choose the local model here');
    // the real writer refuses as well (it would make an identity: the setup's to do)
    await expect(realSetupDeps(process.env).setLocal('fake-llama:8b')).rejects.toThrow(/not set up on this computer yet/);
  }, 30_000);

  it('Ollama does not answer: the box says so in its words and offers the check; Enter runs it here (FAKE probes) and the frame is read again', async () => {
    const { repo } = sandbox();
    setUp(repo, { chat: 'local' });
    const c = workbench({
      ollama: async () => ({ where: 'Ollama at 127.0.0.1:11434', answered: false, models: [], listed: 0, cloud: 0, why: 'Ollama at 127.0.0.1:11434 did not answer (FAKE: connection refused)' }),
      check: () => checkConnections({ env: process.env, ...probes(true) }),
    });
    c.start();
    await c.runAction((await chatActions(c)).find((a) => a.primary));
    await until('the box', () => c.ui.overlay?.kind === 'local-models' && c.ui.overlay.state === 'failed');
    const text = region(c, 'center');
    // (R10 H167; H168's F3: in words; the address and the commands are the details', [i])
    expect(text).toContain('Ollama on this computer did not answer (FAKE: connection refused). Start the Ollama app, then check again. Nothing was changed.');
    expect(text).toContain('Check the connections again (free requests only)');
    c.key('\r', ENTER);
    await until('the check\'s words', () => /answered/.test(message(c)) && message(c));
    const said = message(c);
    expect(said).toContain('Checked just now, with free requests only: no model was called and nothing was spent.');
    expect(said).toMatch(/Ollama \(its list of models\) {2}answered: /);
    expect(said).toContain('OpenRouter (its key endpoint, no model called)  not asked: no OpenRouter key is set up');
    expect(said).toContain('Timmy Studio  not running');
    expect(said).toContain('Browser companion  not running');
    expect(said).toContain('Cloudflare edge  not asked: none is set up');
    // (R10 H167; H168's F3: where it is recorded is the details', [i])
    expect(said).toContain('Recorded. Home\'s connection rows say these now');
    await until('the Ollama card live', () => c.data.frame?.connections.find((x) => x.id === 'ollama')?.state === 'live', 10_000, () => screen(c));
  }, 30_000);

  it('timmy workspace check, the fix for an Ollama that did not answer: run here (FAKE probes); a service is called answered only when the check saw it answer', async () => {
    const { repo } = sandbox();
    setUp(repo, { chat: 'local', model: 'fake-llama:8b' });
    await checkConnections({ env: process.env, ...probes(false) });
    let ok = false;
    const c = workbench({ check: () => checkConnections({ env: process.env, ...probes(ok) }) });
    c.start();
    const fix = (await chatActions(c)).find((a) => a.primary);
    expect(fix).toMatchObject({ n: 2, label: 'Start Ollama, then check again (no charge)', command: 'timmy workspace check' });
    expect(routeOf(fix!).kind).toBe('check');
    await c.runAction(fix);
    await until('the check\'s words', () => /Checked just now/.test(message(c)) && message(c));
    expect(message(c)).toContain('Ollama (its list of models)  did not answer: FAKE: nothing listens on 127.0.0.1:11434');
    expect(message(c)).not.toMatch(/Ollama \(its list of models\) {2}answered/);
    expect(c.data.frame?.connections.find((x) => x.id === 'ollama')?.state).not.toBe('live');
    // Ollama started (FAKE): the next check sees it answer, and the frame's fix is gone
    ok = true;
    c.key('', ESC);
    await c.runAction(pageActions(c).acts.find((a) => a.primary));
    await until('the check\'s words', () => /answered: /.test(message(c)) && message(c));
    await until('the frame read again', () => pageActions(c).acts.find((a) => a.primary)?.n === 1, 10_000, () => screen(c));
    // an answer of an earlier run is never reported as this run's
    const old = { schema: 'timmy.connections/1' as const, checks: { ollama: { answer: 'accepted' as const, at: new Date(Date.now() - 60_000).toISOString(), detail: 'FAKE' } } };
    expect(checkRows(old, Date.now() - 1).find((r) => r.name.startsWith('Ollama'))).toEqual({ name: 'Ollama (its list of models)', words: 'not asked this time', answered: false });
  }, 30_000);

  it('the setup\'s box: timmy init --chat openrouter in a blank home names every question it asks, the key hidden; a stray timmy setup and /setup chat say theirs; nothing is asked or written here', async () => {
    const { home } = sandbox();
    const c = workbench({});
    c.start();
    const fix = (await chatActions(c)).find((a) => a.primary);
    expect(fix).toMatchObject({ n: 2, label: 'Set up chat: an OpenRouter key (asked hidden) or a local model', command: 'timmy init --chat openrouter' });
    expect(region(c, 'center')).toContain('Ready not ready: set up chat: an OpenRouter key (asked hidden) or a local model (the next step above, Enter)');
    await c.runAction(fix);
    await until('the setup box', () => c.ui.overlay?.kind === 'setup');
    const text = region(c, 'center');
    expect(text).toContain('Set up chat, in a shell timmy init --chat openrouter');
    expect(text).toContain('Timmy is not set up on this computer yet, so it asks each question in turn: Operator name (your receipts show it);');
    expect(text).toContain('OpenRouter key (hidden as you type; blank: no key)');
    expect(text).toContain('A key is typed only in a terminal, hidden as you type (timmy init in a shell, or /setup key in the REPL): never into a tab, a page or this Workbench. Nothing was run from here.');
    expect(text).not.toContain('Use a local model instead');
    expect(c.ui.input.field).toBeFalsy();
    c.key('\r', ENTER);
    await sleep(50);
    expect(c.ui.overlay?.kind).toBe('setup');
    expect(() => readFileSync(join(home, 'setup.json'))).toThrow();
    c.key('', ESC);
    // a stray `timmy setup`: the setup that asks is timmy init
    await c.runAction(action('timmy setup'));
    await until('the setup box', () => c.ui.overlay?.kind === 'setup');
    expect(region(c, 'center')).toContain('(timmy setup makes a governed workspace\'s folders and asks nothing; the setup that asks is timmy init.)');
    expect(region(c, 'center')).toMatch(/Set up chat, in a shell timmy init \(timmy setup/);
    c.key('', ESC);
    await c.runAction(action('/setup chat', 'Set the Ollama address the chat uses'));
    await until('the address box', () => c.ui.overlay?.kind === 'setup' && c.ui.overlay.which === 'chat');
    expect(region(c, 'center')).toContain('Set the chat\'s Ollama address');
    expect(region(c, 'center')).toContain('timmy init --ollama <host>');
  }, 30_000);

  it('a key the setup keeps, refused: timmy init --chat openrouter asks nothing now, and the box names what replaces the key; a key from the environment is said to win', async () => {
    const { repo } = sandbox();
    setUp(repo, { openrouter: 'sk-or-FAKE-not-a-key' });
    // the real plan: every question has an answer, so the command asks nothing (the key stored is not asked again)
    expect(await realSetupDeps(process.env).setupPlan('timmy init --chat openrouter')).toEqual({ asks: [], keyFrom: 'providers.json' });
    const c = workbench({});
    await c.runAction(action('timmy init --chat openrouter', 'Give a working OpenRouter key (asked hidden)'));
    await until('the setup box', () => c.ui.overlay?.kind === 'setup');
    expect(region(c, 'center')).toContain('It asks no question now: every one has an answer, and a key is set (in Timmy\'s providers.json, where the setup keeps it). It does not replace that key: timmy init --openrouter - does (it reads the key hidden at a terminal), or /setup key in the REPL (it asks for it hidden).');
    // FAKE plan: the key in use from the environment, which a key the setup keeps does not replace
    const env = workbench({ setupPlan: async () => ({ asks: ['OpenRouter key (hidden as you type; blank: no key)'], keyFrom: 'environment' }) });
    await env.runAction(action('timmy init --chat openrouter'));
    await until('the setup box', () => env.ui.overlay?.kind === 'setup');
    const text = region(env, 'center');
    expect(text).toContain('It asks what has no answer yet: OpenRouter key (hidden as you type; blank: no key).');
    expect(text).toContain('The key in use comes from the environment (OPENROUTER_API_KEY, or a .env in the working folder), which wins over the one the setup keeps: to use another key, change it there.');
  }, 30_000);

  it('the Ollama card\'s step (timmy init --chat local --model <name>) opens the setup\'s box, which offers the local model here once the setup has run', async () => {
    const { repo } = sandbox();
    setUp(repo, { openrouter: 'sk-or-FAKE-not-a-key' });
    const set: string[] = [];
    const c = workbench({ ollama: async () => FAKE_OLLAMA, setLocal: async (m) => { set.push(m); return { written: [] }; } });
    c.start();
    c.selectPage('home');
    await until('the cards', () => c.data.frame?.connections.find((x) => x.id === 'ollama'), 10_000, () => screen(c));
    expect(c.data.frame!.connections.find((x) => x.id === 'ollama')!.setup).toBe('timmy init --chat local --model <name>');
    c.ui.focus = 'center';
    // R10 (H167): Home's list holds the project's recent work first, then the connections, a row each
    for (let i = 0; i < 40 && c.selected()?.key !== 'conn:ollama'; i++) c.key('', DOWN);
    expect(c.selected()?.key).toBe('conn:ollama');
    await c.enter();
    await until('the setup box', () => c.ui.overlay?.kind === 'setup');
    const text = region(c, 'center');
    expect(text).toContain('Set the chat to a local model timmy init --chat local --model <name>');
    expect(text).toContain('It asks no question now (every one has an answer): it writes the chat as the local model you name, once that Ollama lists it');
    expect(text).toContain('Choose the local model here: what Ollama lists now (no key, no charge)');
    c.key('\r', ENTER);
    await until('the list', () => c.ui.overlay?.kind === 'local-models' && c.ui.overlay.state === 'listed');
    c.key('', DOWN);
    c.key('\r', ENTER);
    await until('the words of what changed', () => message(c));
    expect(set).toEqual(['fake-qwen:4b']);
    // FAKE writer: nothing was written, and the words say the route as read (still OpenRouter)
    expect(message(c)).toContain('The route as read now:');
  }, 30_000);
});
