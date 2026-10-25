/**
 * R4 (H104, second part): the browser companion follows the active project, chats on the route the setup chose, and shows
 * one operation's run detail by its id; in a real headless Chromium against the real companion server on 127.0.0.1.
 *
 * The active project is written by Timmy's own code (src/project/index.ts saveActiveProject, as the REPL's /project writes
 * it) into this file's Timmy home; each project is a temporary folder with its own event bus, where FAKE REPL turns
 * (receipt.sealed events as src/utils/receipts.ts publishes them; no REPL runs) are appended. The local chat route is
 * answered by a FAKE Ollama (tests/fixtures/fake-ollama-chat.ts: a real HTTP server on 127.0.0.1, no model behind it), the
 * OpenRouter route by a FAKE OpenRouter on 127.0.0.1 (each test checks what reached it, often nothing); the setup's answers
 * are files of a temporary Timmy home given to the companion as its chat's environment (CompanionOptions.chatEnv). The run
 * detail is a FIXTURE RunDetail from a FIXTURE producer (H102's src/ops/run-detail.ts is not in this revision); with no
 * producer given, the companion's own words for its absence (or, once H102's lands, its answer). Every page load records
 * each response of status 400 or more and each console error, and none is allowed (r25's D11). The browser tests are
 * skipped, saying so, where no Chromium or Chrome is found.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { basename, join, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureCompanionWeb } from '../scripts/companion-web-build.mjs';
import type { RunDetail } from '../src/contracts/run-detail.js';
import { CHAT_HAPPENS } from '../src/companion/chat-route.js';
import { PROJECT_POLL_MS, ProjectFollower } from '../src/companion/project.js';
import { RUN_NO_PRODUCER, runDetailAnswer, type RunDetailProducer } from '../src/companion/run-detail.js';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { projectId, saveActiveProject, type ActiveProject } from '../src/project/index.js';
import { tildePath } from '../src/utils/home-scrub.js';
import { openWorkspaceTab, landWorkspace } from './helpers/companion-page-kit.js';
import { startFakeOllama, textChunks } from './fixtures/fake-ollama-chat.js';

const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('companion-project-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

const dirs: string[] = [];
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
const ENV = ['TIMMY_REPO', 'TIMMY_HOME', 'OPENROUTER_API_KEY'];
const saved: Record<string, string | undefined> = {};
const originalCwd = process.cwd();
/** This file's Timmy home: the active-project record is written here by Timmy's own code. */
let home = '';

beforeAll(() => {
  for (const k of ENV) saved[k] = process.env[k];
  delete process.env.TIMMY_REPO;
  delete process.env.OPENROUTER_API_KEY;
  home = temp('h104b-home-');
  process.env.TIMMY_HOME = home;
  // the folder a companion was started in, when no project is recorded: one of the test's own
  process.chdir(temp('h104b-work-'));
});
afterAll(() => {
  process.chdir(originalCwd);
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A project folder of the test's own, its event bus there (empty). */
function project(name: string): ActiveProject & { bus: string } {
  const root = join(temp('h104b-projects-'), name);
  mkdirSync(join(root, '.timmy', 'receipts'), { recursive: true });
  const bus = join(root, '.timmy', 'receipts', 'runs.jsonl');
  writeFileSync(bus, '');
  return { name, root, chosen: true, bus };
}

/** Makes `p` the active project, as the REPL's /project does (the record in this file's Timmy home). */
const choose = (p: ActiveProject): void => saveActiveProject({ name: p.name, root: p.root, chosen: true });

/**
 * FAKE: the bus event Timmy publishes when the REPL seals a turn's receipt (src/utils/receipts.ts appendReceipt publishes
 * receipt.sealed; src/repl/seal.ts gives a turn kind `turn` and its subject). No REPL runs here and nothing is sealed.
 */
function fakeTurn(bus: string, subject: string): string {
  const hash = `sha256_${randomBytes(32).toString('hex')}`;
  appendFileSync(bus, `${JSON.stringify({ v: 1, ts: new Date().toISOString(), kind: 'receipt.sealed', payload: { stream: 'runs', id: 'FAKE-turn-receipt', hash, kind: 'turn', subject, epoch: 1 } })}\n`);
  return hash.slice(7, 15);
}

/** FAKE OpenRouter on 127.0.0.1: records each request (its Authorization header and body) and streams a short answer. */
async function fakeOpenRouter(): Promise<{ url: string; seen: Array<{ auth?: string; body: string }>; close: () => Promise<void> }> {
  const seen: Array<{ auth?: string; body: string }> = [];
  const s: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += String(c); });
    req.on('end', () => {
      seen.push({ auth: req.headers.authorization, body });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'FAKE OpenRouter answer' } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}/chat/completions`, seen, close: () => new Promise((r) => { s.closeAllConnections?.(); s.close(() => r()); }) };
}

/** A Timmy home for the chat's environment: the setup's answers (setup.json) and providers.json, as `timmy init` writes them. */
function setupHome(answers: Record<string, string> | null, providers: Record<string, string> | null): { TIMMY_HOME: string; TIMMY_SETTINGS_DIR: string } {
  const h = temp('h104b-setup-');
  if (answers) writeFileSync(join(h, 'setup.json'), `${JSON.stringify({ version: 1, by: 'FIXTURE', at: new Date().toISOString(), answers })}\n`);
  if (providers) writeFileSync(join(h, 'providers.json'), `${JSON.stringify(providers)}\n`);
  return { TIMMY_HOME: h, TIMMY_SETTINGS_DIR: temp('h104b-settings-') };
}

const tokenOf = (c: CompanionServer): string => /#t=([0-9a-f]{64})$/.exec(c.url)![1];
const auth = (c: CompanionServer): Record<string, string> => ({ Authorization: `Bearer ${tokenOf(c)}` });

/**
 * R11 round 4 (H169, contract C3): the legacy POST /chat is REMOVED, never kept as a fallback: 404 in the companion's words,
 * nothing streamed, nothing sent to any model. The page's chat is POST /api/chat/turn under a signed-in user
 * (tests/companion-chat-run.test.ts). This asks the old address and returns its status and words.
 */
async function chatGone(c: CompanionServer, message: string): Promise<{ status: number; text: string }> {
  const r = await fetch(`http://127.0.0.1:${c.port}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth(c) }, body: JSON.stringify({ messages: [{ role: 'user', content: message }] }), signal: AbortSignal.timeout(10_000) });
  return { status: r.status, text: await r.text() };
}
const GONE = 'The browser companion has nothing at this address.';

/** FIXTURE: a run detail as H102's producer (src/ops/run-detail.ts, not in this revision) will make one. */
function fixtureDetail(operation: string, root: string, over: Partial<RunDetail> = {}): RunDetail {
  return {
    version: 1, operation, parent: 'o0a0b0c0d', children: ['o5e6f7a8b'],
    project: { name: basename(root), root, id: projectId(root) },
    objective: { value: 'FIXTURE: tidy the tray inbox', from: `.timmy/operations/${operation}.json` },
    sourceRevision: { value: 'FIXTURE-rev-0001', from: `.timmy/operations/${operation}.json` },
    verdict: { state: 'no change', words: 'FIXTURE: the run changed nothing; its result was already current', from: 'receipt FIXTURE-rc-1' },
    stage: { current: 'inspect', done: 2, total: 3, from: '.timmy/jobs/FIXTURE-job.json' },
    exits: [{ who: 'upmd', code: 4, state: 'stale build', from: '.timmy/jobs/FIXTURE-job.log' }, { who: 'runner', code: 0, from: '.timmy/jobs/FIXTURE-job.json' }],
    freshness: { state: 'stale', why: 'FIXTURE: its input changed after the result was made', from: `.timmy/operations/${operation}.json` },
    acceptance: { state: 'not reviewed' },
    worker: { model: { value: 'FIXTURE-model', from: 'receipt FIXTURE-rc-1' } },
    time: { startedAt: '2026-10-11T10:00:00.000Z', endedAt: '2026-10-11T10:01:12.000Z', elapsedMs: 72_000 },
    prediction: { words: 'FIXTURE: Predicted change, then inspect, then result, each exits 0', receipt: 'FIXTURE-rc-0', frozenAt: '2026-10-11T09:59:58.000Z' },
    checks: [
      { name: 'inspect', predicted: 'exits 0', actual: 'exited 4', differs: true, from: '.timmy/jobs/FIXTURE-job.log' },
      { name: 'result', predicted: null, actual: 'not run', differs: null, from: '.timmy/jobs/FIXTURE-job.json' },
    ],
    files: [
      { path: 'inbox/FIXTURE-note.txt', role: 'input', sha256: 'ab'.repeat(32), from: `.timmy/operations/${operation}.json` },
      { path: '.timmy/jobs/FIXTURE-job.log', role: 'log', from: '.timmy/jobs/FIXTURE-job.json' },
    ],
    receipts: [{ id: 'FIXTURE-rc-0', kind: 'predict', subject: 'workflow · predict' }, { id: 'FIXTURE-rc-1', kind: 'workflow' }],
    cost: { usd: null, measured: false, why: 'FIXTURE: no model was asked in this run' },
    summary: { path: null },
    next: { words: 'FIXTURE: run it again once its input settles', command: '/run APPROVAL.md tidy' },
    unknown: [{ field: 'acceptance', why: 'FIXTURE: no person has reviewed this result' }],
    ...over,
  };
}

describe('the companion\'s project follower (src/companion/project.ts), without a browser (R4 H104, second part)', () => {
  it('reads the record again no more than once a second besides its watch: with no state folder when it starts, a record written later is found by that poll', async () => {
    expect(PROJECT_POLL_MS).toBe(1000);
    const h = temp('h104b-poll-home-');
    const was = process.env.TIMMY_HOME;
    process.env.TIMMY_HOME = h;
    const seen: Array<{ name: string; at: number }> = [];
    // asked for a faster poll: it keeps once a second
    const started = Date.now();
    const f = new ProjectFollower({ cwd: temp('h104b-poll-work-'), pollMs: 10, onChange: (p) => seen.push({ name: p.name, at: Date.now() }) });
    try {
      expect(f.current().chosen).toBe(false);
      const delta = project('delta');
      const written = Date.now();
      choose(delta);
      const deadline = Date.now() + 5_000;
      while (!seen.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      expect(seen.map((s) => s.name)).toEqual(['delta']);
      // no state folder to watch at the start: only the poll could find it: not before its first second (the asked-for
      // 10 ms poll was not used; a timer never fires early), and within about two seconds of the record's writing
      expect(seen[0].at - started).toBeGreaterThanOrEqual(PROJECT_POLL_MS - 20);
      expect(seen[0].at - written).toBeLessThan(PROJECT_POLL_MS * 2 + 500);
      expect(f.current()).toEqual({ name: 'delta', root: delta.root, chosen: true });
      expect(f.find(projectId(delta.root))?.root).toBe(delta.root);
      expect(f.find('0'.repeat(16))).toBeNull();
      expect(f.find('not-an-id')).toBeNull();
    } finally { f.stop(); process.env.TIMMY_HOME = was; }
  });
});

describe('a run detail as the companion sends it (src/companion/run-detail.ts), without a browser (R4 H104, second part)', () => {
  const root = '/FIXTURE/project';
  it('draws only a run detail of version 1 for the operation asked; a refusal, nothing, another version or something else is said in words; a failure is a 500 in words with the home folder as ~', async () => {
    const ok = await runDetailAnswer('o1a2b3c4d', root, () => fixtureDetail('o1a2b3c4d', root));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, detail: { version: 1, operation: 'o1a2b3c4d' } });
    const asked: unknown[] = [];
    await runDetailAnswer('o1a2b3c4d', root, (op, o) => { asked.push([op, o]); return fixtureDetail(op, root); });
    expect(asked).toEqual([['o1a2b3c4d', { project: root }]]);
    expect(await runDetailAnswer('not-an-id', root, () => { throw new Error('never asked'); })).toMatchObject({ status: 400, body: { ok: false, error: expect.stringMatching(/^Not an operation id/) } });
    expect(await runDetailAnswer('o1a2b3c4d', root, () => null)).toEqual({ status: 200, body: { ok: false, reason: 'unknown', error: 'No operation o1a2b3c4d in this project\'s records.' } });
    expect(await runDetailAnswer('o1a2b3c4d', root, () => ({ error: 'FIXTURE: o1a2b3c4d is another project\'s operation (FIXTURE-other)' }))).toEqual({ status: 200, body: { ok: false, reason: 'refused', error: 'FIXTURE: o1a2b3c4d is another project\'s operation (FIXTURE-other)' } });
    const v2 = await runDetailAnswer('o1a2b3c4d', root, () => ({ ...fixtureDetail('o1a2b3c4d', root), version: 2 } as unknown as RunDetail));
    expect(v2.body).toMatchObject({ ok: false, reason: 'version', error: 'The run detail of o1a2b3c4d is version 2; this companion draws version 1, so it shows none (the producer and the companion change together).' });
    expect((await runDetailAnswer('o1a2b3c4d', root, () => ({ version: 1, operation: 'o1a2b3c4d' } as unknown as RunDetail))).body).toMatchObject({ ok: false, reason: 'not-a-run-detail' });
    expect((await runDetailAnswer('o1a2b3c4d', root, () => fixtureDetail('o5e6f7a8b', root))).body).toMatchObject({ ok: false, reason: 'not-a-run-detail', error: 'The producer gave the run detail of o5e6f7a8b when o1a2b3c4d was asked for, so none is shown.' });
    // a failure: words, the first line only, the home folder as ~ (the path is made here, at run time)
    const failed = await runDetailAnswer('o1a2b3c4d', root, () => { throw new Error(`FIXTURE: cannot read ${join(homedir(), 'FIXTURE-records', 'x.json')}\n    at a stack line`); });
    expect(failed.status).toBe(500);
    const words = (failed.body as { error: string }).error;
    expect(words).toBe('The run detail of o1a2b3c4d could not be made: FIXTURE: cannot read ~/FIXTURE-records/x.json');
    // a path under the home folder in a detail is written from ~ too
    const scrubbed = await runDetailAnswer('o1a2b3c4d', root, () => fixtureDetail('o1a2b3c4d', join(homedir(), 'FIXTURE-project')));
    expect((scrubbed.body as { detail: RunDetail }).detail.project.root).toBe('~/FIXTURE-project');
  });
});

describe.skipIf(!browserPath)('the browser companion follows the active project, chats on the chosen route, and shows a run detail by its id, in a real browser (R4 H104, second part)', () => {
  let browser: Browser;
  const servers: CompanionServer[] = [];
  /** A companion of the test's own (TIMMY_REPO unset: it follows the active project), shut down after the file. */
  const companion = async (o: Parameters<typeof startCompanionServer>[1] = {}): Promise<CompanionServer> => {
    const s = await startCompanionServer(0, { chatEnv: setupHome(null, null), ...o });
    servers.push(s);
    return s;
  };

  beforeAll(async () => {
    // the page's built chat: built here first when it is missing or stale (CI has no build)
    await ensureCompanionWeb();
    browser = await chromium.launch({ headless: true, executablePath: browserPath, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  }, 600_000);
  afterAll(async () => {
    await browser?.close();
    for (const s of servers) await s.shutdown();
  });

  interface Seen { requests: string[]; outside: string[]; bad: string[]; consoleErrors: string[]; errors: string[] }
  /** The page in a fresh context (or `context`), at `path` with the token in its fragment; requests elsewhere are aborted. */
  async function open(target: CompanionServer, o: { path?: string; context?: BrowserContext; viewport?: { width: number; height: number } } = {}): Promise<{ page: Page; context: BrowserContext; seen: Seen }> {
    const origin = `http://127.0.0.1:${target.port}`;
    const context = o.context ?? await browser.newContext({ viewport: o.viewport ?? { width: 1440, height: 900 } });
    const seen: Seen = { requests: [], outside: [], bad: [], consoleErrors: [], errors: [] };
    if (!o.context) {
      await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.origin === origin) return route.continue();
        seen.outside.push(url.href);
        return route.abort('blockedbyclient');
      });
    }
    const page = await context.newPage();
    page.on('request', (r) => seen.requests.push(r.url()));
    page.on('response', (r) => { if (r.status() >= 400) seen.bad.push(`${r.status()} ${r.url()}`); });
    page.on('console', (m) => { if (m.type() === 'error') seen.consoleErrors.push(`${m.text()} ${m.location().url ?? ''}`.trim()); });
    page.on('pageerror', (e) => seen.errors.push(e.message));
    // R10 CHAT (H171): the page opens on Chat unless its address names a tab; these cases read the header and Home, as before
    await page.goto(`${origin}${o.path ?? '/?tab=home'}#t=${tokenOf(target)}`);
    await landWorkspace(page);
    return { page, context, seen };
  }
  const clean = (seen: Seen): void => {
    expect(seen.bad).toEqual([]);
    expect(seen.consoleErrors).toEqual([]);
    expect(seen.errors).toEqual([]);
    expect(seen.outside).toEqual([]);
  };
  const connected = (page: Page): Promise<unknown> => page.waitForFunction(() => document.getElementById('status-text')?.textContent === 'COMPANION SOCKET · CONNECTED', null, { timeout: 30_000 });
  // R11 round 7 (H172, SHELL CONTRACT v1): the project's name is shown in the topbar crumb ("<project> / <page>") and in the rail's
  // switcher (#rail-project-name); the records' Details (closed by default) keep the legacy project bar (#project-name, its mode, Pin)
  const shows = (page: Page, name: string, timeout = 10_000): Promise<unknown> => page.waitForFunction((n) => document.getElementById('project-name')?.textContent === n
    && document.getElementById('rail-project-name')?.textContent === n && document.getElementById('shell-crumb-ws')?.textContent === n, name, { timeout });
  /** The records' Details opened (the legacy project bar, the socket's status and the folder live under it on the round-7 shell). */
  const openRecords = async (page: Page): Promise<void> => { await page.evaluate(() => { const d = document.getElementById('shell-details') as HTMLDetailsElement | null; if (d && !d.open) d.open = true; }); };
  /** Pin / Unpin as a person does it on the shell: the rail's project switcher and its "Keep this page on <project>" / "Follow the active project". */
  const pinViaRail = async (page: Page, on: boolean): Promise<void> => {
    const menu = page.locator('#rail-project-menu');
    if (!(await menu.isVisible())) await page.click('#rail-project');
    await menu.waitFor({ state: 'visible', timeout: 5_000 });
    await menu.locator(`[data-cx="${on ? 'pin' : 'unpin'}"]`).first().click();
    if (await menu.isVisible()) await page.keyboard.press('Escape');
  };
  /** The rail switcher's own words about the project's mode (its menu opened, read, closed). */
  const railMode = async (page: Page): Promise<string> => {
    const menu = page.locator('#rail-project-menu');
    if (!(await menu.isVisible())) await page.click('#rail-project');
    await menu.waitFor({ state: 'visible', timeout: 5_000 });
    const words = ((await menu.locator('.rail-mode').first().textContent()) ?? '').replace(/\s+/g, ' ').trim();
    await page.keyboard.press('Escape');
    return words;
  };
  const text = async (page: Page, selector: string): Promise<string> => ((await page.textContent(selector)) ?? '').replace(/\s+/g, ' ').trim();
  const turns = (page: Page): Promise<string[]> => page.$$eval('#console-logs [data-mirror="repl-turn"]', (rows) => rows.map((r) => (r.textContent ?? '').replace(/\s+/g, ' ')));
  const turnShown = (page: Page, receipt: string): Promise<unknown> => page.waitForFunction((r) => [...document.querySelectorAll('#console-logs [data-mirror="repl-turn"]')].some((row) => (row.textContent ?? '').includes(r)), receipt, { timeout: 15_000 });
  const tab = async (page: Page, name: string): Promise<void> => {
    // R5 (H132): each panel sits in one of the ten workspace tabs (data-ws): that tab is opened first, then the panel's own
    // switch where it shares its place (the Chat tab's two views)
    const ws = await page.getAttribute(`#tab-${name}`, 'data-ws');
    // R10 CHAT (H171): by the control drawn for it (the tab row, or on Chat the shell's left menu); Chat is shown already when
    // the page opens on it
    if (ws && (await page.getAttribute('body', 'data-dest')) !== ws) await openWorkspaceTab(page, ws);
    // R11 round 7 (H172): the workspace tab row is hidden (D3: the rail is the navigation) — a panel's own switch is clicked only
    // where it is drawn and visible, never the row's [data-tab] button
    const own = page.locator(`.view-switch [data-tab="${name}"]`);
    const other = page.locator(`[data-tab="${name}"]:not(.ws-tab)`).filter({ visible: true });
    // (R11 round 7, H171 d5a6f005: the Chat's older views are the Chat page's records, a details closed by default — opened as a
    // person opens it before its switch is used)
    if (await own.count()) await page.evaluate((sel) => { const sw = document.querySelector(sel); for (let d = sw?.closest('details'); d; d = d.parentElement?.closest('details') ?? null) d.open = true; }, `.view-switch [data-tab="${name}"]`);
    if (await own.count()) await own.first().click();
    else if (await other.count()) await other.first().click();
    await page.waitForFunction((n) => { const p = document.getElementById(`tab-${n}`); return Boolean(p?.classList.contains('active') && getComputedStyle(p).opacity === '1' && p.getAnimations().length === 0); }, name, { timeout: 10_000 });
  };
  const record = (): string => tildePath(join(home, 'state', 'active-project.json'));

  it('the header shows the active project the record names, following it, with its folder and where the record is; a change of the record is followed within about a second, the Chat Mirror\'s REPL turns with it', async () => {
    const alpha = project('alpha');
    const beta = project('beta');
    choose(alpha);
    const own = await companion();
    const { page, context, seen } = await open(own);
    try {
      await connected(page);
      await shows(page, 'alpha');
      await openRecords(page);
      expect(await text(page, '#project-mode')).toBe('following the active project');
      expect(await page.isHidden('#project-pin-mark')).toBe(true);
      expect(await text(page, '#project-pin')).toBe('Pin: keep this page on alpha');
      expect(await page.isEnabled('#project-pin')).toBe(true);
      // the rail's switcher says the same, in its words
      expect(await railMode(page)).toBe('Following the active project: this page moves when Timmy’s active project changes.');
      expect(await page.getAttribute('#project', 'data-project')).toBe(projectId(alpha.root));
      // (R10 H167: said in words on the line; the folder whole under its Details)
      expect(await text(page, '#project-folder .folder-whole')).toBe(`Project folder: ${tildePath(alpha.root)}: this page reads its event bus and receipts (.timmy), for the Chat Mirror's REPL turns and the Logs tab. Following the active project, which Timmy records in ${record()}.`);
      // the mirror's words name where a REPL turn must happen to be seen here
      const empty = await text(page, '#console-logs');
      expect(empty).toContain(`A REPL turn is seen here when the REPL works in the project this page shows, alpha (${tildePath(alpha.root)}) (in the REPL, /project chooses one): Timmy keeps an event bus in each project's folder, and this page reads that project's.`);
      // a REPL turn in alpha (FAKE: its bus event) reaches the mirror
      const inAlpha = fakeTurn(alpha.bus, 'repl · 1 step');
      await turnShown(page, inAlpha);

      // the REPL chooses beta (Timmy's own code writes the record): this page follows it
      const t0 = Date.now();
      choose(beta);
      await shows(page, 'beta', 5_000);
      const followedIn = Date.now() - t0;
      expect(followedIn).toBeLessThan(2_500);
      expect(await text(page, '#project-mode')).toBe('following the active project');
      expect(await text(page, '#project-folder .folder-whole')).toContain(`Project folder: ${tildePath(beta.root)}:`);
      expect(await text(page, '#project-pin')).toBe('Pin: keep this page on beta');
      // alpha's turn is not shown with beta; a turn in alpha now is not shown, one in beta is
      expect(await turns(page)).toEqual([]);
      const lateAlpha = fakeTurn(alpha.bus, 'repl · 2 steps');
      const inBeta = fakeTurn(beta.bus, 'repl · 3 steps');
      await turnShown(page, inBeta);
      const rows = await turns(page);
      expect(rows).toHaveLength(1);
      expect(rows[0]).not.toContain(lateAlpha);
      expect(rows[0]).not.toContain(inAlpha);
      // the Logs tab says what happened
      await tab(page, 'logs');
      expect(await text(page, '#logs-list')).toContain(`Project: beta (${tildePath(beta.root)}), following (followed)`);
      clean(seen);
      console.log(`companion-project: the record's change was followed in ${followedIn} ms`);
    } finally { await context.close(); }
  });

  it('a pinned page keeps its project, visibly, its bus with it, and when the companion\'s address is opened again in that tab; a following page moves when the record changes; Unpin follows again; a new page follows', async () => {
    const beta = project('beta');
    const gamma = project('gamma');
    choose(beta);
    const own = await companion();
    const pinned = await open(own);
    const following = await open(own);
    try {
      await Promise.all([connected(pinned.page), connected(following.page)]);
      await Promise.all([shows(pinned.page, 'beta'), shows(following.page, 'beta')]);
      await Promise.all([openRecords(pinned.page), openRecords(following.page)]);
      // Pin: this page keeps beta — through the rail's project switcher ("Keep this page on beta"); the records' bar follows
      await pinViaRail(pinned.page, true);
      await pinned.page.waitForFunction(() => !document.getElementById('project-pin-mark')?.hidden, null, { timeout: 5_000 });
      expect(await text(pinned.page, '#project-pin-mark')).toBe('PINNED');
      expect(await text(pinned.page, '#project-mode')).toBe('pinned on this page');
      expect(await text(pinned.page, '#project-pin')).toBe('Unpin: follow the active project');
      expect(await pinned.page.getAttribute('#project', 'data-mode')).toBe('pinned');

      // the active project changes: the following page moves, the pinned one stays and says what is active now
      choose(gamma);
      await shows(following.page, 'gamma', 5_000);
      await pinned.page.waitForFunction(() => /the active project is gamma/.test(document.getElementById('project-mode')?.textContent ?? ''), null, { timeout: 5_000 });
      expect(await text(pinned.page, '#project-name')).toBe('beta');
      expect(await text(pinned.page, '#project-mode')).toBe('pinned · the active project is gamma');
      expect(await text(pinned.page, '#project-pin')).toBe('Unpin: follow the active project (gamma)');
      expect(await railMode(pinned.page)).toBe('Pinned on this page; the active project is gamma.');
      // (R10 H167: said in words on the line; the folder whole under its Details)
      expect(await text(pinned.page, '#project-folder .folder-whole')).toBe(`Project folder: ${tildePath(beta.root)}: this page reads its event bus and receipts (.timmy), for the Chat Mirror's REPL turns and the Logs tab. Pinned on this page; the active project is now gamma (${tildePath(gamma.root)}).`);
      expect(await pinned.page.isHidden('#project-pin-mark')).toBe(false);
      expect(await following.page.isHidden('#project-pin-mark')).toBe(true);
      // each page's mirror shows its own project's REPL turns
      const inBeta = fakeTurn(beta.bus, 'repl · 1 step');
      const inGamma = fakeTurn(gamma.bus, 'repl · 2 steps');
      await Promise.all([turnShown(pinned.page, inBeta), turnShown(following.page, inGamma)]);
      expect((await turns(pinned.page)).join(' ')).not.toContain(inGamma);
      expect((await turns(following.page)).join(' ')).not.toContain(inBeta);

      // the companion's address opened again in this tab (a reload alone has no token: the page keeps it in memory only)
      // keeps the pin, this tab's own; a new page follows
      await pinned.page.goto(`http://127.0.0.1:${own.port}/?tab=home#t=${tokenOf(own)}`);
      await landWorkspace(pinned.page);
      await connected(pinned.page);
      await shows(pinned.page, 'beta');
      await openRecords(pinned.page);
      await pinned.page.waitForFunction(() => document.getElementById('project')?.dataset.mode === 'pinned', null, { timeout: 5_000 });
      expect(await text(pinned.page, '#project-mode')).toBe('pinned · the active project is gamma');
      const fresh = await open(own);
      try {
        await connected(fresh.page);
        await shows(fresh.page, 'gamma');
        expect(await text(fresh.page, '#project-mode')).toBe('following the active project');
        clean(fresh.seen);
      } finally { await fresh.context.close(); }

      // Unpin: the page follows the active project again (the rail's "Follow the active project")
      await pinViaRail(pinned.page, false);
      await shows(pinned.page, 'gamma', 5_000);
      expect(await text(pinned.page, '#project-mode')).toBe('following the active project');
      expect(await pinned.page.isHidden('#project-pin-mark')).toBe(true);
      expect(await pinned.page.evaluate(() => sessionStorage.getItem('timmy.companion.pin'))).toBeNull();
      clean(pinned.seen);
      clean(following.seen);
    } finally { await pinned.context.close(); await following.context.close(); }
  });

  it('TIMMY_REPO, set when the companion starts, fixes its folder: the header says so, Pin is off and says why, and a change of the record moves nothing', async () => {
    const fixed = project('fixed-folder');
    const other = project('other');
    choose(other);
    process.env.TIMMY_REPO = fixed.root;
    let own: CompanionServer;
    try { own = await companion(); } finally { delete process.env.TIMMY_REPO; }
    const { page, context, seen } = await open(own);
    try {
      await connected(page);
      await shows(page, 'fixed-folder');
      expect(await text(page, '#project-mode')).toBe('fixed by TIMMY_REPO');
      expect(await page.isDisabled('#project-pin')).toBe(true);
      expect(await text(page, '#project-pin')).toBe('Pin: off (TIMMY_REPO fixed this companion’s folder)');
      // (R10 H167: said in words on the line; the folder whole under its Details)
      expect(await text(page, '#project-folder .folder-whole')).toBe(`Project folder: ${tildePath(fixed.root)}: this page reads its event bus and receipts (.timmy), for the Chat Mirror's REPL turns and the Logs tab. TIMMY_REPO fixed this folder: this companion follows no project.`);
      choose(project('elsewhere'));
      await page.waitForTimeout(PROJECT_POLL_MS + 500);
      expect(await text(page, '#project-name')).toBe('fixed-folder');
      clean(seen);
    } finally { await context.close(); }
  });

  it('on the local route the older Streamdown view names the route ("local <model> · Ollama · the project\'s conversation") and sends nothing: its Send says the chat is in Chat (POST /api/chat/turn); nothing reaches Ollama\'s chat or OpenRouter', async () => {
    const ollama = await startFakeOllama({
      models: [{ name: 'fake-chat:8b', capabilities: ['completion', 'tools'] }],
      chat: [() => ({ chunks: textChunks('fake-chat:8b', ['FAKE local ', 'answer: **streamed** ', 'from the FAKE Ollama.']), delayMs: 150 })],
    });
    const openrouter = await fakeOpenRouter();
    try {
      const own = await companion({ chatEnv: setupHome({ chat: 'local', model: 'fake-chat:8b', ollama: ollama.url }, { ollama_host: ollama.url }), upstream: openrouter.url });
      const { page, context, seen } = await open(own);
      try {
        await connected(page);
        await tab(page, 'streamdown');
        // (R11 round 4, H169's contract C3: the route's label names the project's conversation; its scope words say whose it is)
        await page.waitForFunction(() => document.getElementById('sd-route-chip')?.textContent === 'local fake-chat:8b · Ollama · the project\'s conversation', null, { timeout: 15_000 });
        expect(await page.getAttribute('#sd-route-chip', 'data-route')).toBe('local');
        expect(await text(page, '#sd-route')).toBe('The project\'s conversation, the one the Workbench and the REPL continue: the agent\'s tools, gated at NEEDS YOU; every turn sealed with a receipt.');
        expect(await page.getAttribute('#sd-input', 'placeholder')).toBe('This older view sends nothing: message fake-chat:8b in Chat above');
        expect(await page.locator('#sd-route-off').count()).toBe(0);
        await page.fill('#sd-input', 'FAKE: a question for the local model');
        expect(await page.isEnabled('#sd-send')).toBe(true);
        await page.click('#sd-send');
        // the older view sends nothing: the page's chat call refuses in words, drawn as the view's error; nothing streams
        await page.waitForSelector('.sd-error', { timeout: 15_000 });
        expect(await text(page, '.sd-error')).toContain('This older view sends nothing: the chat is the agent turn in Chat above (POST /api/chat/turn).');
        await page.waitForFunction(() => document.getElementById('sd-status')?.textContent === 'IDLE', null, { timeout: 15_000 });
        // the FAKE Ollama saw the Models rail's reads only (GET /api/tags, /api/show, /api/ps: no model runs), never a chat
        expect(ollama.chats()).toHaveLength(0);
        for (const p of ollama.requests.map((r) => r.path)) expect(['/api/tags', '/api/show', '/api/ps']).toContain(p);
        // the legacy address is gone: 404 in words
        expect(await chatGone(own, 'FAKE: a question for the local model')).toMatchObject({ status: 404, text: expect.stringContaining(GONE) });
        expect(ollama.chats()).toHaveLength(0);
        expect(openrouter.seen).toEqual([]);
        clean(seen);
      } finally { await context.close(); }
    } finally { await ollama.close(); await openrouter.close(); }
  });

  it('with no route (no local model chosen, no OpenRouter key), Send stays off and says why and where chat happens; nothing is sent anywhere; the ✨ sample still streams', async () => {
    const openrouter = await fakeOpenRouter();
    try {
      const own = await companion({ chatEnv: setupHome(null, null), upstream: openrouter.url });
      const { page, context, seen } = await open(own);
      try {
        await connected(page);
        await tab(page, 'streamdown');
        await page.waitForSelector('#sd-route-off', { timeout: 15_000 });
        expect(await text(page, '#sd-route-chip')).toBe('no chat route here · Send is off');
        expect(await text(page, '#sd-route')).toBe('no chat route here · Send is off');
        const words = await text(page, '#sd-route-off');
        expect(words).toBe(`Send is off: the setup has not chosen a route for chat, and no OpenRouter key is set (not in this companion's environment or .env, a timmy-tui.config.json, the Timmy home's providers.json or the monitor's settings), so this page asks no model. \`timmy init\` keeps a key, or chooses the local model. ${CHAT_HAPPENS}`);
        expect(await page.isDisabled('#sd-send')).toBe(true);
        expect(await page.isDisabled('#sd-input')).toBe(true);
        expect(await text(page, '#sd-send')).toBe('Send: off');
        expect(await page.getAttribute('#sd-send', 'title')).toBe(words);
        // asked directly, the legacy /chat is gone (404 in words) and sends nothing anywhere
        expect(await chatGone(own, 'FAKE: a message with no route')).toMatchObject({ status: 404, text: expect.stringContaining(GONE) });
        expect(openrouter.seen).toEqual([]);
        // the page's own sample asks no model: it streams without a route
        await page.click('#sd-try');
        await page.waitForSelector('[data-card="approval"]', { timeout: 30_000 });
        await page.waitForFunction(() => document.getElementById('sd-status')?.textContent === 'IDLE', null, { timeout: 30_000 });
        expect(openrouter.seen).toEqual([]);
        clean(seen);
      } finally { await context.close(); }
    } finally { await openrouter.close(); }
  });

  it('the route as the setup gives it, at each request: a cloud-backed model only by a name that says so; a remote one whose name does not; no model chosen; OpenRouter with the key where the REPL finds it, never echoed; the legacy POST /chat a 404 throughout (R11 round 4: the turn is POST /api/chat/turn, tests/companion-chat-run.test.ts)', async () => {
    const ollama = await startFakeOllama({
      models: [
        { name: 'fake-big:70b-cloud', capabilities: ['completion'], remote_host: 'FAKE-remote' },
        { name: 'sneaky:8b', capabilities: ['completion'], remote_host: 'FAKE-remote' },
      ],
      chat: [() => ({ chunks: textChunks('fake-big:70b-cloud', ['FAKE cloud answer']) })],
    });
    const openrouter = await fakeOpenRouter();
    // one environment object, its Timmy home changed between the cases: the route is read again at each request
    const env: Record<string, string | undefined> = { ...setupHome(null, null) };
    const own = await companion({ chatEnv: env, upstream: openrouter.url });
    const route = async (): Promise<Record<string, unknown>> => {
      const r = await fetch(`http://127.0.0.1:${own.port}/api/chat/route`, { headers: auth(own) });
      expect(r.status).toBe(200);
      return await r.json() as Record<string, unknown>;
    };
    const use = (answers: Record<string, string> | null, providers: Record<string, string> | null): void => { env.TIMMY_HOME = setupHome(answers, providers).TIMMY_HOME; };
    try {
      // a cloud-backed model, chosen by its name (which says cloud): the label names the route (R11 Phase 2, H169: "ollama cloud · <name>"); the turn says
      // the terms and that the chat leaves this computer
      use({ chat: 'local', model: 'fake-big:70b-cloud' }, { ollama_host: ollama.url });
      expect(await route()).toMatchObject({ kind: 'local', ready: true, cloud: true, label: 'ollama cloud · fake-big:70b-cloud · the project\'s conversation' });
      // (R11 round 4: the legacy POST /chat is gone; the cloud terms notice and the remote refusal are the turn's, in
      // tests/companion-chat-run.test.ts and the chat session's own tests)
      expect(await chatGone(own, 'FAKE: for the cloud model')).toMatchObject({ status: 404, text: expect.stringContaining(GONE) });
      expect(ollama.chats()).toHaveLength(0);
      // a model Ollama sends elsewhere though its name does not say cloud: the route says cloud: false (the turn refuses it)
      use({ chat: 'local', model: 'sneaky:8b' }, { ollama_host: ollama.url });
      expect(await route()).toMatchObject({ kind: 'local', ready: true, cloud: false, label: 'local sneaky:8b · Ollama · the project\'s conversation' });
      const before = ollama.chats().length;
      expect((await chatGone(own, 'FAKE: for the sneaky model')).status).toBe(404);
      expect(ollama.chats()).toHaveLength(before);
      // the local model with none chosen: Send is off, saying where to choose one
      use({ chat: 'local' }, { ollama_host: ollama.url });
      const off = await route();
      expect(off).toMatchObject({ kind: 'none', ready: false, chat: 'local', label: 'chat: local · no model chosen · Send is off' });
      expect(off.words).toBe(`Send is off: the setup chose the local model for chat, and no model is chosen. In the REPL, /model lists what Ollama at ${new URL(ollama.url).host} has and /setup chat keeps one. Nothing is sent from this page until then. ${CHAT_HAPPENS}`);
      // OpenRouter, its key in the Timmy home's providers.json (where `timmy init` keeps it; the REPL finds it there too)
      const key = `FAKE-or-${randomBytes(12).toString('hex')}`;
      use({ chat: 'openrouter' }, { openrouter_api_key: key });
      const or = await route();
      // R11 (H169's Phase 0 item 2; H171's step 1): the page has no fixed model: a key and the setup's OpenRouter answer choose
      // nothing, so the route is none / no-model-chosen, Send is off, and POST /chat sends nothing to OpenRouter
      expect(or).toMatchObject({ kind: 'none', ready: false, chat: 'openrouter', reason: 'no-model-chosen', label: 'No model chosen: choose one in Models · Send is off' });
      expect(or.words).toMatch(/^Send is off: No model chosen: choose one in Models /);
      expect(JSON.stringify(or)).not.toContain(key);
      expect((await chatGone(own, 'FAKE: for OpenRouter, no model chosen')).status).toBe(404);
      expect(openrouter.seen).toHaveLength(0);
      // a FAKE model saved as a choice in this test's own settings file (as Models in the Workbench, /model or timmy init
      // --chat openrouter --model keep it): the route names it, and Send asks it
      writeFileSync(join(env.TIMMY_SETTINGS_DIR!, 'config.json'), JSON.stringify({ model: 'fake/page-test:free', modelChosen: 'fake/page-test:free' }));
      expect(await route()).toMatchObject({ kind: 'openrouter', ready: true, model: 'fake/page-test:free', keyFrom: 'providers.json', label: 'fake/page-test:free · OpenRouter · the project\'s conversation · each message spends credits' });
      // the legacy address sends nothing to OpenRouter, key or no key
      expect(await chatGone(own, 'FAKE: for OpenRouter')).toMatchObject({ status: 404, text: expect.stringContaining(GONE) });
      expect(openrouter.seen).toHaveLength(0);
      // OpenRouter chosen, no key anywhere: off, saying so
      use({ chat: 'openrouter' }, null);
      expect(await route()).toMatchObject({ kind: 'none', ready: false, chat: 'openrouter', words: expect.stringMatching(/^Send is off: the setup chose OpenRouter for chat, and no OpenRouter key is set/) });
      expect(openrouter.seen).toHaveLength(0);
    } finally { await ollama.close(); await openrouter.close(); }
  });

  it('a run detail opened by its operation id at /run/<id>: the FIXTURE RunDetail drawn with every value and where it came from, verdict, stage, exits, freshness and acceptance apart, no percentage; its child opens in place; an unknown id and a non-id are answered in words; the address names the run, never the token', async () => {
    const alpha = project('alpha-runs');
    choose(alpha);
    const asked: Array<{ op: string; project?: string }> = [];
    // FIXTURE producer: two runs of this project; anything else refused in its words
    const producer: RunDetailProducer = (op, o) => {
      asked.push({ op, project: o.project });
      if (op === 'o1a2b3c4d') return fixtureDetail(op, o.project!);
      if (op === 'o5e6f7a8b') {
        return fixtureDetail(op, o.project!, { parent: 'o1a2b3c4d', children: [], verdict: { state: 'completed', words: 'FIXTURE: the run made its result', from: 'receipt FIXTURE-rc-9' }, cost: { usd: 0.0123, measured: true, from: 'receipt FIXTURE-rc-9' }, freshness: { state: 'current', why: 'FIXTURE: made from its recorded inputs' }, acceptance: { state: 'accepted', by: 'FIXTURE-operator', at: '2026-10-11T11:00:00.000Z', from: 'receipt FIXTURE-rc-10' } });
      }
      return { error: `FIXTURE: no operation ${op} in this project's records` };
    };
    const own = await companion({ runDetail: producer });
    const { page, context, seen } = await open(own, { path: '/run/o1a2b3c4d' });
    try {
      await connected(page);
      await page.waitForSelector('#run-detail .run-view[data-operation="o1a2b3c4d"]', { timeout: 15_000 });
      expect(await page.evaluate(() => document.getElementById('tab-run')?.classList.contains('active'))).toBe(true);
      // the address names the run; the token was taken out of it when the page opened
      expect(await page.evaluate(() => location.href)).toBe(`http://127.0.0.1:${own.port}/run/o1a2b3c4d`);
      expect(asked).toEqual([{ op: 'o1a2b3c4d', project: alpha.root }]);
      const field = (f: string): Promise<string> => text(page, `#run-detail .run-row[data-field="${f}"] dd`);
      // (R10 H167: the run named in words, its request as Home lists it; its operation's id is the title's tip)
      expect(await text(page, '#run-detail .run-title')).toMatch(/ · alpha-runs$/);
      expect(await page.getAttribute('#run-detail .run-title', 'title')).toBe('operation o1a2b3c4d');
      // (R10 H167, H168's F3 as on Home: each value on the face; where it came from, the project's folder and id and a next
      // step's command in its column's Details)
      expect(await field('verdict')).toBe('no change · FIXTURE: the run changed nothing; its result was already current');
      expect(await field('stage')).toBe('inspect · 2 of 3 steps done');
      expect(await field('exits')).toBe('upmd: exit 4 (stale build) runner: exit 0');
      expect(await field('freshness')).toBe('stale · FIXTURE: its input changed after the result was made');
      expect(await field('acceptance')).toBe('not reviewed');
      expect(await field('objective')).toBe('FIXTURE: tidy the tray inbox');
      expect(await field('project')).toBe('alpha-runs');
      expect(await field('worker')).toBe('model FIXTURE-model');
      expect(await field('time')).toMatch(/^started .+ · ended .+ · elapsed 1 min 12 s$/);
      expect(await field('cost')).toBe('unknown: FIXTURE: no model was asked in this run');
      expect(await field('next')).toBe('FIXTURE: run it again once its input settles');
      expect(await field('summary')).toBe('none saved');
      const more = (col: string): Promise<string> => text(page, `#run-detail .${col} .run-facts + .rv-more`);
      expect(await more('rd-before')).toBe('Details Objective from .timmy/operations/o1a2b3c4d.json');
      expect(await more('rd-run')).toBe(`Details Workflow stage from .timmy/jobs/FIXTURE-job.json Process exits upmd from .timmy/jobs/FIXTURE-job.log; runner from .timmy/jobs/FIXTURE-job.json Artifact freshness from .timmy/operations/o1a2b3c4d.json Project ${tildePath(alpha.root)} · id ${projectId(alpha.root)} Source revision from .timmy/operations/o1a2b3c4d.json Worker model from receipt FIXTURE-rc-1`);
      expect(await more('rd-after')).toBe('Details Timmy’s verdict from receipt FIXTURE-rc-1 Parent · children parent o0a0b0c0d; children o5e6f7a8b Next its command: /run APPROVAL.md tidy');
      expect(await field('related')).toBe('its parent run · child run 1');
      const view = await text(page, '#run-detail .run-view');
      expect(view).toMatch(/Prediction \(frozen before the result; not an observed receipt\) FIXTURE: Predicted change, then inspect, then result, each exits 0(?: · frozen .+?)? Details its receipt FIXTURE-rc-0/);
      expect(view).toContain('inspect exits 0 exited 4 differs');
      expect(view).toContain('result none not run not compared');
      expect(view).toContain('Details inspect its actual from .timmy/jobs/FIXTURE-job.log result its actual from .timmy/jobs/FIXTURE-job.json');
      expect(view).toContain('inbox/FIXTURE-note.txt input Timmy’s record log');
      expect(view).toContain('Details inbox/FIXTURE-note.txt sha256 abababababab · from .timmy/operations/o1a2b3c4d.json Timmy’s record (log) .timmy/jobs/FIXTURE-job.log · no sha256 recorded · from .timmy/jobs/FIXTURE-job.json');
      expect(view).toContain('Receipts predict · workflow · predict');
      expect(view).toContain('Details predict receipt FIXTURE-rc-0');
      expect(view).toContain('Not known (no record says) acceptance: FIXTURE: no person has reviewed this result');
      // what a person sees (a closed Details shows its summary only) names no operation and no place under .timmy
      const face = await page.$eval('#run-detail .run-view', (e) => (e as HTMLElement).innerText);
      expect(face).not.toContain('o1a2b3c4d');
      expect(face).not.toContain('.timmy/');
      expect(face).not.toContain('FIXTURE-rc-');
      // never a percentage
      expect(view).not.toContain('%');

      // its child operation opens in place, with its reported cost and a person's acceptance
      await page.click('#run-detail [data-op="o5e6f7a8b"]');
      await page.waitForSelector('#run-detail .run-view[data-operation="o5e6f7a8b"]', { timeout: 10_000 });
      expect(await page.evaluate(() => location.pathname)).toBe('/run/o5e6f7a8b');
      expect(await field('verdict')).toBe('completed · FIXTURE: the run made its result');
      expect(await field('cost')).toBe('$0.0123 (reported)');
      expect(await field('acceptance')).toMatch(/^accepted by FIXTURE-operator, \S.*$/);
      expect(await field('related')).toBe('its parent run · no children');
      expect(await page.getAttribute('#run-detail .run-row[data-field="related"] [data-op="o1a2b3c4d"]', 'title')).toBe('operation o1a2b3c4d');
      expect(await text(page, '#run-detail .rd-after .run-facts + .rv-more')).toMatch(/^Details Timmy’s verdict from receipt FIXTURE-rc-9 A person’s acceptance from receipt FIXTURE-rc-10 Parent · children parent o1a2b3c4d Next its command: \/run APPROVAL\.md tidy$/);
      expect(await text(page, '#run-detail .rd-run .run-facts + .rv-more')).toContain('Cost from receipt FIXTURE-rc-9');

      // an id this project has no record of: the producer's words (the Operation id box is behind its Details control)
      await page.click('#run-by-id > summary');
      await page.fill('#run-op', 'o99999999');
      await page.click('#run-open');
      await page.waitForSelector('#run-detail .run-error[data-run="refused"]', { timeout: 10_000 });
      expect(await text(page, '#run-detail')).toBe('FIXTURE: no operation o99999999 in this project\'s records');
      // something that is not an operation id: said so, and nothing asked
      const before = asked.length;
      await page.fill('#run-op', 'not-an-id');
      await page.click('#run-open');
      await page.waitForSelector('#run-detail .run-error[data-run="not-an-id"]', { timeout: 10_000 });
      expect(await text(page, '#run-detail')).toBe('Not an operation id: an operation id is o and 8 hex digits (o1a2b3c4d), as Timmy prints it. Nothing was read.');
      expect(asked).toHaveLength(before);
      // no request's address (its path and query: what reaches a server) carries the token
      for (const r of seen.requests) expect(new URL(r).pathname + new URL(r).search).not.toContain(tokenOf(own));
      clean(seen);
    } finally { await context.close(); }
  });

  it('with no producer given, the companion asks its own (src/ops/run-detail.ts, H102\'s): where this revision has none, the page says so in words; no request fails', async () => {
    const own = await companion();
    const { page, context, seen } = await open(own, { path: '/run/o1a2b3c4d' });
    try {
      await connected(page);
      await page.waitForSelector('#run-detail .run-error, #run-detail .run-view', { timeout: 15_000 });
      const producerHere = existsSync(resolve(originalCwd, 'src/ops/run-detail.ts'));
      if (!producerHere) expect(await text(page, '#run-detail')).toBe(RUN_NO_PRODUCER);
      // once H102's producer is in this revision, it answers (a run detail, or its refusal in words), never these words
      else expect(await text(page, '#run-detail')).not.toBe(RUN_NO_PRODUCER);
      clean(seen);
    } finally { await context.close(); }
  });

  it('/run/<operation id> is the page (no token needed, as at /); anything else under /run/ is a 404 in words; /api/run needs the token, and a project it does not know is said in words', async () => {
    const own = await companion({ runDetail: (op, o) => fixtureDetail(op, o.project!) });
    const base = `http://127.0.0.1:${own.port}`;
    const page = await fetch(`${base}/run/o1a2b3c4d`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('id="tab-run"');
    for (const p of ['/run/o1a2b3c4', '/run/O1A2B3C4D', '/run/o1a2b3c4d/x', '/run/']) {
      const r = await fetch(`${base}${p}`);
      expect(r.status, p).toBe(404);
      const words = await r.text();
      expect(words, p).not.toMatch(/at \S+\.(?:js|ts):\d+|\/home\/|\/Users\//);
    }
    expect((await fetch(`${base}/api/run/o1a2b3c4d`)).status).toBe(401);
    const unknown = await fetch(`${base}/api/run/o1a2b3c4d?project=${'0'.repeat(16)}`, { headers: auth(own) });
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toMatchObject({ ok: false, reason: 'project', error: expect.stringMatching(/^This page's project is not one this companion knows/) });
    expect((await fetch(`${base}/api/run/not-an-id`, { headers: auth(own) })).status).toBe(400);
    const ok = await fetch(`${base}/api/run/o1a2b3c4d`, { headers: auth(own) });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, detail: { operation: 'o1a2b3c4d', version: 1 } });
  });
});
