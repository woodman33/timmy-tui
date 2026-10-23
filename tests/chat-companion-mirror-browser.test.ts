/**
 * R4 (H113, part 3): the companion's CHAT MIRROR shows every surface's turns of the project, in a real headless Chromium against
 * the real companion server on 127.0.0.1: the REPL's, the terminal Workbench's, a monitor's and a companion page's, each sealed
 * by the one turn implementation into the project (src/agent/chat-turn.ts, src/repl/seal.ts), each row labelled with its
 * surface, its receipt and its steps, once (a reconnect's tail does not repeat one), and none of their words (sealed as
 * hashes only). The page's own ✨ Try it sample stays labelled SAMPLE in its STREAMDOWN CHAT tab and is in neither the mirror
 * nor the project's conversation; nothing it does asks a model.
 *
 * Real pieces: the companion server and its page, the turns (the agent, src/repl/turn.ts, signed receipts, the bus events
 * their seals publish in the project's folder, the conversation files). FAKE pieces, labelled: the model is a FAKE Ollama on
 * 127.0.0.1 (tests/fixtures/fake-ollama-chat.ts, no model behind it); this process's fetch is a recording fetch (FAKE network:
 * anything else is refused before it leaves); the browser resolves no name but 127.0.0.1. Skipped, saying so, where no
 * Chromium or Chrome is found.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureCompanionWeb } from '../scripts/companion-web-build.mjs';
import { openChatSession, projectStore } from '../src/agent/chat-session.js';
import { projectTurn, takeTurnHold } from '../src/agent/chat-turn.js';
import { createAgent } from '../src/agent/core.js';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { projectId } from '../src/project/index.js';
import { sealTurn } from '../src/repl/seal.js';
import { readChain } from '../src/utils/receipts.js';
import { startFakeOllama, textChunks, type FakeOllama } from './fixtures/fake-ollama-chat.js';
import { onlyPorts, recordFetch } from './fixtures/recording-fetch.js';

const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('chat-companion-mirror-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

const VARS = ['TIMMY_HOME', 'TIMMY_REPO', 'OPENROUTER_API_KEY', 'TIMMY_CHAT_MODEL', 'OLLAMA_HOST'] as const;

describe.skipIf(!browserPath)('the companion\'s Chat Mirror: every surface\'s turns of the project (R4 H113), in a real browser', () => {
  const kept = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
  let box = '';
  let root = '';
  let browser: Browser;
  let ollama: FakeOllama;
  let companion: CompanionServer;
  let restoreNet: () => void = () => undefined;

  beforeAll(async () => {
    // the page's built chat: built here first when it is missing or stale
    await ensureCompanionWeb();
    box = mkdtempSync(join(tmpdir(), 'chat-mirror-'));
    root = join(box, 'project');
    mkdirSync(join(root, '.timmy', 'receipts'), { recursive: true });
    // the project's own store, pinned in its folder (src/utils/receipts.ts rootStoreDir): every seal here lands in it
    writeFileSync(join(root, '.timmy', 'store-pin'), join(root, '.timmy', 'receipts'));
    writeFileSync(join(root, 'README.md'), '# demo\n');
    process.env.TIMMY_HOME = join(box, 'home', 'timmy');
    for (const v of ['OPENROUTER_API_KEY', 'TIMMY_CHAT_MODEL', 'OLLAMA_HOST'] as const) delete process.env[v];
    ollama = await startFakeOllama({
      models: [{ name: 'qwen3:8b' }],
      chat: ['SYNTHETIC answer one', 'SYNTHETIC answer two', 'SYNTHETIC answer three', 'SYNTHETIC answer four'].map((t) => () => ({ chunks: textChunks('qwen3:8b', [t]) })),
    });
    mkdirSync(process.env.TIMMY_HOME, { recursive: true });
    writeFileSync(join(process.env.TIMMY_HOME, 'providers.json'), JSON.stringify({ ollama_host: ollama.url }));
    writeFileSync(join(process.env.TIMMY_HOME, 'setup.json'), JSON.stringify({ version: 1, by: 'timmy init', answers: { operator: 'Sample', ollama: ollama.url, project: 'demo', chat: 'local', model: 'qwen3:8b' } }));
    restoreNet = recordFetch(onlyPorts(new URL(ollama.url).port)).restore;
    // the companion reads this project's folder (TIMMY_REPO fixes it as it starts); its chat's route from this test's home
    process.env.TIMMY_REPO = root;
    companion = await startCompanionServer(0, { chatEnv: { TIMMY_HOME: process.env.TIMMY_HOME, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR } });
    delete process.env.TIMMY_REPO;
    browser = await chromium.launch({ headless: true, executablePath: browserPath, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  }, 600_000);

  afterAll(async () => {
    await browser?.close();
    await companion?.shutdown();
    restoreNet();
    await ollama?.close();
    for (const v of VARS) { if (kept[v] === undefined) delete process.env[v]; else process.env[v] = kept[v]; }
    if (box) rmSync(box, { recursive: true, force: true });
  });

  it('each surface\'s turn appears once, labelled with its surface, its receipt and its steps, never its words; the ✨ sample stays SAMPLE and out of the conversation', async () => {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const outside: string[] = [];
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin === `http://127.0.0.1:${companion.port}`) return route.continue();
      outside.push(url.href);
      return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(companion.url);
      await page.waitForFunction(() => document.getElementById('status-text')?.textContent === 'COMPANION SOCKET · CONNECTED', null, { timeout: 30_000 });
      // R5 (H132): the mirror is the Chat tab's (2). R10 CHAT (H171): Chat is the menu's first destination, and the mirror
      // one of its older views, below the conversation
      await page.click('#rail-menu .rail-item[data-dest="chat"]');
      await page.waitForSelector('#console-logs [data-mirror="empty"]', { timeout: 15_000 });
      const words = (await page.textContent('#console-logs [data-mirror="empty"]'))!.replace(/\s+/g, ' ');
      expect(words).toContain('In the Workbench (timmy workbench), each turn of its Chat appears here the same way, when it ends, labelled Workbench; a monitor\'s turn is labelled Monitor.');

      // the four surfaces' turns of this project, each by its own path (one turn implementation)
      const project = { name: 'demo', root };
      const repl = createAgent({ apiKey: '', model: '', instructions: 'REPL (test)', maxSteps: 3, maxCost: 1 }, { multiplexer: 'none' });
      repl.useSessions(join(root, '.sessions'));
      repl.useLocalChat({ host: ollama.url, model: 'qwen3:8b' });
      const r1 = await projectTurn({
        agent: repl, project, surface: 'repl', text: 'SYNTHETIC question one', sink: { handle: () => undefined, endTurn: () => undefined },
        seal: (f) => sealTurn({ ...f, model: 'qwen3:8b', project: 'demo', projectId: projectId(root) }, projectStore(root)),
      });
      expect(r1.status).toBe('ok');
      const hooks = { onText: () => undefined, askPerson: async () => 'deny' as const };
      const wb = await (await openChatSession({ project, surface: 'workbench' })).send('SYNTHETIC question two', hooks);
      // the monitor hands over its own agent (its conversation elsewhere, until the turn makes it the project's)
      const monitorAgent = createAgent({ apiKey: '', model: '', instructions: '', maxSteps: 3, maxCost: 1 }, { multiplexer: 'none' });
      monitorAgent.useSessions(join(box, 'monitor-sessions'));
      const mon = await (await openChatSession({ project, surface: 'monitor' }, { agent: monitorAgent })).send('SYNTHETIC question three', hooks);
      const comp = await (await openChatSession({ project, surface: 'companion' })).sendOnce('k-SYNTHETIC-0001', 'SYNTHETIC question four', hooks);
      for (const r of [wb, mon, comp]) expect(r).toMatchObject({ status: 'answered', sent: true, receipt: expect.stringMatching(/^sha256_/) });
      const sealed = readChain('runs', root).filter((r) => r.kind === 'turn' || r.kind === 'chat');
      expect(sealed.map((r) => r.subject)).toEqual(['repl · 0 steps', 'chat.turn · workbench · 0 steps · qwen3:8b', 'chat.turn · monitor · 0 steps · qwen3:8b', 'chat.turn · companion · 0 steps · qwen3:8b']);

      // the mirror: four rows, in the order sealed, each labelled with its surface, its receipt and its steps
      await page.waitForFunction(() => document.querySelectorAll('#console-logs [data-mirror="repl-turn"], #console-logs [data-mirror="surface-turn"]').length === 4, null, { timeout: 20_000 });
      const rows = await page.$$eval('#console-logs .log-msg', (els) => els.map((e) => ({
        mirror: e.getAttribute('data-mirror'), surface: e.getAttribute('data-surface'),
        head: (e.querySelector('.log-header span')?.textContent ?? '').trim(), text: (e.textContent ?? '').replace(/\s+/g, ' ').trim(),
      })));
      expect(rows.map((r) => [r.mirror, r.surface, r.head])).toEqual([
        ['repl-turn', null, '⌨ REPL turn · ended'],
        ['surface-turn', 'workbench', '▣ Workbench turn · ended'],
        ['surface-turn', 'monitor', '◉ Monitor turn · ended'],
        ['surface-turn', 'companion', '◇ Companion turn · ended'],
      ]);
      const ids = sealed.map((r) => r.hash.slice(7, 15));
      // (R10 H167, H168's F3 on the page: each surface by its name, its receipt's id behind the row's Details)
      expect(rows[0].text).toContain('A chat turn in the REPL ended (0 steps); Timmy sealed its receipt.');
      expect(rows[1].text).toContain('A chat turn in the Workbench ended (0 steps); Timmy sealed its receipt, in this project\'s one conversation. Its words are in the Workbench\'s Chat: Timmy seals a turn\'s prompt and answer as hashes only');
      expect(rows[2].text).toContain('A chat turn in the monitor ended (0 steps); Timmy sealed its receipt');
      expect(rows[3].text).toContain('A chat turn in a companion page ended (0 steps); Timmy sealed its receipt');
      expect(await page.$$eval('#console-logs .log-msg .mirror-more', (els) => els.map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()))).toEqual(ids.map((id) => `Details receipt ${id}`));
      const mirror = (await page.textContent('#console-logs'))!;
      expect(mirror).not.toMatch(/SYNTHETIC (question|answer)/);
      // a reconnect's tail, or the same seal read again, adds no row
      const bus = join(root, '.timmy', 'receipts', 'runs.jsonl');
      const events = readFileSync(bus, 'utf8').split('\n').filter((l) => l.includes('"receipt.sealed"'));
      appendFileSync(bus, `${events.at(-1)}\n`);
      await page.waitForTimeout(1_500);
      expect(await page.locator('#console-logs [data-mirror="repl-turn"], #console-logs [data-mirror="surface-turn"]').count()).toBe(4);

      // the page's own ✨ sample: labelled SAMPLE where it is drawn, and in neither the mirror nor the conversation
      const asked = ollama.chats().length;
      await page.click('[data-tab="streamdown"]');
      await page.waitForSelector('#sd-try');
      await page.click('#sd-try');
      await page.waitForSelector('[data-card="approval"]', { timeout: 30_000 });
      await page.waitForFunction(() => document.getElementById('sd-status')?.textContent === 'IDLE', null, { timeout: 30_000 });
      expect(await page.locator('#sd-messages [data-sample-label]').count()).toBeGreaterThanOrEqual(3);
      expect((await page.textContent('#sd-messages .sd-answer.sample'))!).toContain('SAMPLE · THE PAGE’S OWN TEXT · NO MODEL WAS ASKED');
      await page.click('[data-tab="chat"]');
      await page.waitForTimeout(500);
      const after = (await page.textContent('#console-logs'))!;
      expect(after).not.toMatch(/TMX P3|streaming markdown surface|run_tmx_demo_001/);
      expect(await page.locator('#console-logs [data-mirror="repl-turn"], #console-logs [data-mirror="surface-turn"]').count()).toBe(4);
      const kept = readdirSync(join(root, '.sessions')).filter((n) => n.endsWith('.jsonl'));
      expect(kept).toHaveLength(1);
      const conversation = readFileSync(join(root, '.sessions', kept[0]), 'utf8');
      expect(conversation).not.toMatch(/TMX P3|Try it|run_tmx_demo_001/);
      expect(conversation.split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { content: string }).content)).toEqual([
        'SYNTHETIC question one', 'SYNTHETIC answer one', 'SYNTHETIC question two', 'SYNTHETIC answer two',
        'SYNTHETIC question three', 'SYNTHETIC answer three', 'SYNTHETIC question four', 'SYNTHETIC answer four',
      ]);
      // the sample asked no model
      expect(ollama.chats()).toHaveLength(asked);
      expect(outside).toEqual([]);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 240_000);
  it('R5 lead (the final QA of a77d80d, defect 1): a turn\'s end reaches the whole page with its mirror row: the strip, the activity line and the log change when the bus brings its receipt, not at the next 3 s read of the frame', async () => {
    // a turn of the project held now, as the Workbench holds the one it answers (this process holds it; no model is asked)
    const t = takeTurnHold(root, 'workbench');
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    // a companion whose frame reads this project's own store, as an installed Timmy's does (this suite's isolation sets
    // TIMMY_STORE, which a frame would read instead: src/workbench/state.ts chainOf)
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.TIMMY_STORE;
    process.env.TIMMY_REPO = root;
    const own = await startCompanionServer(0, { workspace: { env } });
    delete process.env.TIMMY_REPO;
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await context.route('**/*', (route) => (new URL(route.request().url()).origin === `http://127.0.0.1:${own.port}` ? route.continue() : route.abort('blockedbyclient')));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // when each read of the frame was asked (the page reads it every 3 s while seen, and now on a turn's end too)
    const reads: number[] = [];
    page.on('request', (r) => { if (new URL(r.url()).pathname === '/api/workspace') reads.push(Date.now()); });
    try {
      await page.goto(own.url);
      await page.waitForFunction(() => document.getElementById('status-text')?.textContent === 'COMPANION SOCKET · CONNECTED', null, { timeout: 30_000 });
      // R10 CHAT (H171): on Chat the strip is drawn behind the composition, whose own controls offer the same Stop
      await page.click('#rail-menu .rail-item[data-dest="chat"]');
      await page.waitForSelector(`#ws-actions [data-stop-turn="${t.hold.id}"]`, { state: 'attached', timeout: 15_000 });
      await page.waitForSelector(`#cx-controls [data-stop-turn="${t.hold.id}"]`, { timeout: 15_000 });
      await page.waitForFunction(() => /^1 running/.test(document.getElementById('ws-activity-counts')?.textContent ?? ''), null, { timeout: 15_000 });
      // just after one of the page's 3 s reads has been answered, the turn ends: its receipt sealed with its identity
      const polled = reads.length;
      await page.waitForResponse((r) => new URL(r.url()).pathname === '/api/workspace', { timeout: 10_000 });
      const lastPoll = reads[reads.length - 1];
      expect(reads.length).toBeGreaterThan(polled);
      const sealed = sealTurn({ prompt: 'SYNTHETIC stopped', answer: '', steps: 0, spend: 0, ms: 5, status: 'cancelled', surface: 'workbench', turnId: t.hold.id, stoppedBy: 'companion', model: 'qwen3:8b', project: 'demo', projectId: projectId(root) }, projectStore(root));
      // the whole page says it ended: no Stop on the strip, nothing running, its row in the mirror, before the next 3 s read
      await page.waitForFunction((rc) => !document.querySelector('#ws-actions [data-stop-turn]') && !document.querySelector('#cx-controls [data-stop-turn]')
        && /^0 running/.test(document.getElementById('ws-activity-counts')?.textContent ?? '')
        && [...document.querySelectorAll('#console-logs [data-mirror="surface-turn"]')].some((e) => (e.textContent ?? '').includes(rc) && /·\s*stopped/.test(e.textContent ?? '')), sealed.id, { timeout: 10_000 }).catch(async (e) => {
        const frame = await page.evaluate(`(async () => { const r = await companion.fetch('/api/workspace'); const f = await r.json(); return { chatTurn: f.activity && f.activity.chatTurn, running: f.activity && f.activity.running, turns: ((f.chat && f.chat.turns) || []).slice(0, 3) }; })()`).catch((x) => String(x));
        const seen = await page.evaluate(() => ({ stop: [...document.querySelectorAll('#ws-actions [data-stop-turn]')].map((b) => b.getAttribute('data-stop-turn')), counts: document.getElementById('ws-activity-counts')?.textContent, rows: [...document.querySelectorAll('#console-logs .log-msg')].map((r) => `${r.getAttribute('data-mirror')}: ${(r.textContent ?? '').replace(/\s+/g, ' ').slice(0, 120)}`) }));
        throw new Error(`${String(e)}\nthe turn ${t.hold.id}, sealed as ${sealed.id}; the page showed ${JSON.stringify(seen)}; the frame it is given says ${JSON.stringify(frame)}`);
      });
      const settled = Date.now();
      // the next 3 s read cannot have begun before lastPoll + 3000, so a page settled well before then was read again by the bus
      expect(settled - lastPoll, `the page settled ${settled - lastPoll} ms after its last 3 s read began`).toBeLessThan(2_500);
      expect(errors).toEqual([]);
    } finally {
      t.hold.release();
      await context.close();
      await own.shutdown();
    }
  }, 60_000);
});
