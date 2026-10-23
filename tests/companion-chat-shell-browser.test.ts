/**
 * R10 CHAT CHECKPOINT (H171; the operator's order of 2026-10-22, 16:01 PT, and the handoff's captures 01 to 06): the browser
 * companion's shell and its Chat composition at 1440 × 900, in a real headless Chromium against the real companion server on
 * 127.0.0.1, read as a person sees it.
 *
 * Real: the server, its token, the page's code, the Chat's routes (src/companion/chat-view.ts), its existing Send (POST
 * /chat, this page's own chat), a project conversation in .sessions with one answer's turn sealed in the shape src/repl/seal.ts
 * writes (the page reads its model and verifies nothing). FAKE, labelled: the local Ollama (tests/fixtures/fake-ollama-chat.ts:
 * its model fake-qwen3:8b, no model behind it, its answer says FAKE); OpenRouter's rows are its public catalog of 2026-10-22
 * trimmed to 12 models (tests/fixtures/openrouter-public-catalog-2026-10-22.json, H169's), kept as a fetched catalog.
 *
 * What is checked: Chat opens when the address names no destination, first in the left menu and marked; the saved
 * conversation's turns with the model each answer's receipt names (and "model not recorded" where none does), a tool result
 * folded until opened; the route of the next turn; the Models rail's provider, rows, Sort and filters (a sort keeps a
 * filter, Clear filters shows all), the selected model's detail; a message sent with Enter streams the FAKE's answer as this
 * page's own turn, said not to be saved to the project; a draft survives the page opened again; a bottom control opens its drawer and Esc
 * returns focus to it; every text of the composition is 13 px or more; the menu opens Home and key 2 brings Chat back; no
 * token on the page's face.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { browserPath, launchBrowser, openPage } from './helpers/companion-page-kit.js';
import { startFakeOllama, textChunks, type FakeOllama } from './fixtures/fake-ollama-chat.js';

const FIXTURE = join(__dirname, 'fixtures', 'openrouter-public-catalog-2026-10-22.json');
interface FixtureModel { id: string; name: string; created?: number; pricing?: Record<string, string>; architecture?: { output_modalities?: string[] } }
const MODELS = (JSON.parse(readFileSync(FIXTURE, 'utf8')) as { data: FixtureModel[] }).data;
const TEXT = MODELS.filter((m) => !m.architecture?.output_modalities || m.architecture.output_modalities.includes('text'));
const NEWEST = [...TEXT].sort((a, b) => (b.created ?? 0) - (a.created ?? 0))[0];
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const ANSWER_1 = 'FAKE answer 1: a plan in three steps (no model behind it).';
const text = async (page: Page, sel: string): Promise<string> => ((await page.textContent(sel)) ?? '').replace(/\s+/g, ' ').trim();

function project(root: string): void {
  mkdirSync(join(root, '.sessions'), { recursive: true });
  const t0 = Date.parse('2026-10-22T23:30:00.000Z');
  const lines = [
    { role: 'user', content: 'Help me turn this folder into a plan.', timestamp: t0 },
    { role: 'assistant', content: ANSWER_1, timestamp: t0 + 1000 },
    { role: 'tool', name: 'list_project_files', content: 'README.md\nSHOT.md', timestamp: t0 + 1500 },
    { role: 'user', content: 'And the first slice?', timestamp: t0 + 2000 },
    { role: 'assistant', content: 'FAKE answer 2, which no receipt of this project seals.', timestamp: t0 + 3000 },
  ];
  writeFileSync(join(root, '.sessions', 'session-1792711800000-abc123.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  mkdirSync(join(root, '.timmy', 'receipts'), { recursive: true });
  writeFileSync(join(root, '.timmy', 'receipts', 'runs.jsonl'), `${JSON.stringify({
    v: 1, id: 'rc_test', stream: 'runs', ts: '2026-10-22T23:30:01.000Z', kind: 'chat', subject: 'chat.turn · workbench · 0 steps · fake-qwen3:8b',
    status: 'ok', via: 'ollama', model_resolved: 'fake-qwen3:8b', model_requested: 'fake-qwen3:8b', response_hash: sha(ANSWER_1), hash: `sha256_${'7f'.repeat(32)}`,
  })}\n`);
}

describe.skipIf(!browserPath)('the companion\'s shell and its Chat at 1440 × 900 (R10 H171)', () => {
  const kept = { TIMMY_REPO: process.env.TIMMY_REPO };
  let box = '';
  let browser: Browser;
  let ollama: FakeOllama;
  let companion: CompanionServer;
  let origin = '';
  let token = '';

  beforeAll(async () => {
    browser = await launchBrowser();
    box = mkdtempSync(join(tmpdir(), 'h171-chat-shell-'));
    const home = join(box, 'home');
    const root = join(box, 'tray');
    project(root);
    ollama = await startFakeOllama({
      models: [{ name: 'fake-qwen3:8b', capabilities: ['completion', 'tools'] }],
      chat: [() => ({ chunks: textChunks('fake-qwen3:8b', ['FAKE streamed ', 'answer from the test\'s stand-in.']), delayMs: 40 })],
    });
    mkdirSync(join(home, 'models'), { recursive: true });
    writeFileSync(join(home, 'models', 'openrouter-catalog.json'), JSON.stringify({ fetchedAt: '2026-10-22T16:00:00.000Z', models: MODELS }));
    writeFileSync(join(home, 'setup.json'), JSON.stringify({ version: 1, by: 'test', answers: { chat: 'local', ollama: ollama.host, model: 'fake-qwen3:8b' } }));
    const env = { TIMMY_HOME: home, TIMMY_SETTINGS_DIR: join(box, 'settings') };
    process.env.TIMMY_REPO = root;
    companion = await startCompanionServer(0, { chatEnv: env, workspace: { env } });
    if (kept.TIMMY_REPO === undefined) delete process.env.TIMMY_REPO; else process.env.TIMMY_REPO = kept.TIMMY_REPO;
    origin = `http://127.0.0.1:${companion.port}`;
    token = /#t=([0-9a-f]{64})$/.exec(companion.url)![1];
  }, 600_000);
  afterAll(async () => {
    await companion?.shutdown();
    await ollama?.close();
    await browser?.close();
    for (const [k, v] of Object.entries(kept)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (box) rmSync(box, { recursive: true, force: true });
  });

  it('Chat first and open by default; the saved conversation with each answer\'s model; the route; the Models rail; a sent message streamed as this page\'s own turn; drawers, keys and the other destinations', async () => {
    const { context, page, errors } = await openPage(browser, { origin }, { width: 1440, height: 900 });
    try {
      await page.goto(`${origin}/#t=${token}`);
      await page.waitForSelector('#cx-turns .cx-turn.is-timmy', { timeout: 30_000 });
      // the shell: Chat open, first in the menu and marked; the menu in the terminal's order
      expect(await page.getAttribute('body', 'data-dest')).toBe('chat');
      expect(await page.isVisible('#ws-chat')).toBe(true);
      expect(await page.isVisible('.ws-header')).toBe(false);
      const menu = await page.$$eval('#rail-menu .rail-item', (els) => els.map((e) => ({ label: e.querySelector('.rail-label')?.textContent?.trim(), current: e.getAttribute('aria-current') })));
      expect(menu.slice(0, 9).map((m) => m.label?.replace(/ · \d+$/, ''))).toEqual(['Chat', 'Studio', 'Workflows', 'VoxVision', 'Motion', 'Control Room', 'Files', 'Logs & records', 'Connections']);
      expect(menu[0].current).toBe('page');
      expect(menu.filter((m) => m.current === 'page')).toHaveLength(1);
      // the project the companion says this page shows, once its socket has said it
      await page.waitForFunction(() => document.getElementById('rail-project-name')?.textContent === 'tray', null, { timeout: 15_000 });
      expect(await text(page, '#cx-proj')).toBe('tray');
      // the saved conversation: YOU / TIMMY, the model each answer's receipt names, a tool result folded
      const turns = await page.$$eval('#cx-turns > .cx-turn', (els) => els.map((e) => e.className.replace('cx-turn ', '')));
      expect(turns).toEqual(['is-you', 'is-timmy', 'is-tool', 'is-you', 'is-timmy']);
      const timmy = await page.$$eval('#cx-turns > .cx-turn.is-timmy .cx-who', (els) => els.map((e) => [...e.children].map((c) => (c.textContent ?? '').trim()).slice(0, 3)));
      expect(timmy[0]).toEqual(['TIMMY', 'fake-qwen3:8b', 'FAKE model']);
      expect(timmy[1].slice(0, 2)).toEqual(['TIMMY', 'model not recorded']);
      expect(await text(page, '#cx-turns > .cx-turn.is-timmy .cx-meta')).toContain('sent from the Workbench · sealed in receipt 7f7f7f7f (not checked here)');
      expect(await page.$eval('#cx-turns details.cx-tool', (d) => (d as HTMLDetailsElement).open)).toBe(false);
      await page.click('#cx-turns details.cx-tool > summary');
      expect(await page.isVisible('#cx-turns details.cx-tool pre')).toBe(true);
      expect(await text(page, '#cx-kicker')).toMatch(/^Chat \/ tray · since /);
      // the route of the next turn
      expect(await text(page, '#cx-route-words')).toBe('Next turn fake-qwen3:8b / Ollama on this computer · this page’s own chat · no tools');
      // the Models rail: Ollama local first (the route's), its installed model in use and selected
      await page.waitForSelector('#cm-list .cm-row', { timeout: 20_000 });
      expect(await page.getAttribute('[data-cm-provider="ollama"][data-cm-sub="local"]', 'aria-selected')).toBe('true');
      expect(await text(page, '#cm-list .cm-row[data-model="fake-qwen3:8b"] .cm-inuse')).toBe('✓ in use');
      expect(await text(page, '.cm-detail')).toContain('✓ The next turn of this page uses this model.');
      expect(await text(page, '.cm-detail-k')).toBe('Selected');
      // the selected model's detail sits right below its row (a one-row list leaves no gap before it)
      const gap = await page.$eval('#cm-list li.is-selected', (li) => {
        const row = li.querySelector('.cm-row')!.getBoundingClientRect();
        const detail = li.querySelector('.cm-detail')!.getBoundingClientRect();
        return detail.top - row.bottom;
      });
      expect(Math.abs(gap)).toBeLessThan(2);
      // OpenRouter: its public rows, Recently added first; Cost keeps through a Sort; Clear filters shows all
      await page.click('[data-cm-provider="openrouter"]');
      await page.waitForFunction((n) => document.querySelectorAll('#cm-list .cm-row').length === n, TEXT.length, { timeout: 20_000 });
      expect(await text(page, '#cm-list .cm-row .cm-name')).toBe(NEWEST.name);
      expect(await page.$eval('#cm-sort', (s) => (s as HTMLSelectElement).selectedOptions[0].textContent)).toBe('Recently added');
      await page.selectOption('#cm-cost', 'free');
      await page.waitForFunction((n) => document.querySelectorAll('#cm-list .cm-row').length < n, TEXT.length, { timeout: 20_000 });
      const freeRows = await page.$$eval('#cm-list .cm-row', (els) => els.map((e) => e.getAttribute('data-model')));
      expect(freeRows).toContain('recursive/flint-v1.0:free');
      await page.selectOption('#cm-sort', 'name');
      await page.waitForFunction(() => (document.getElementById('cm-sort') as HTMLSelectElement | null)?.value === 'name', null, { timeout: 20_000 });
      await page.waitForTimeout(500);
      expect(await page.$eval('#cm-cost', (s) => (s as HTMLSelectElement).value)).toBe('free');
      expect((await page.$$eval('#cm-list .cm-row', (els) => els.map((e) => e.getAttribute('data-model')))).sort()).toEqual([...freeRows].sort());
      await page.click('[data-cx="clear-filters"]');
      await page.waitForFunction((n) => document.querySelectorAll('#cm-list .cm-row').length === n, TEXT.length, { timeout: 20_000 });
      // a model not in use: its detail, and why it cannot be used from this page yet
      await page.click('#cm-list .cm-row[data-model="anthropic/claude-haiku-5.5"]');
      const detail = await text(page, '.cm-detail');
      expect(detail).toContain('Anthropic: Claude Haiku 5.5');
      expect(detail).toContain('Model idanthropic/claude-haiku-5.5');
      expect(await page.isDisabled('.cm-detail .cx-btn')).toBe(true);
      expect(detail).toContain('Not available on this page yet: its Send asks fake-qwen3:8b');
      // ArrowDown moves along the list, the detail with it
      await page.focus('#cm-list .cm-row[aria-current="true"]');
      const before = await page.evaluate(() => document.activeElement?.getAttribute('data-model'));
      await page.keyboard.press('ArrowDown');
      expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-current'))).toBe('true');
      expect(await page.evaluate(() => document.activeElement?.getAttribute('data-model'))).not.toBe(before);
      expect(await page.evaluate(() => document.activeElement?.parentElement?.querySelector('.cm-detail') !== null)).toBe(true);

      // a draft survives the page opened again in this browser tab (from Timmy, with its token: a reload has none, by design)
      await page.fill('#cx-input', 'A draft kept across opening the page again');
      await page.goto(`${origin}/#t=${token}`);
      await page.waitForSelector('#cx-turns .cx-turn.is-timmy', { timeout: 30_000 });
      await page.waitForFunction(() => (document.getElementById('cx-input') as HTMLTextAreaElement | null)?.value === 'A draft kept across opening the page again', null, { timeout: 15_000 });
      // sent with Enter: the FAKE's answer streamed as this page's own turn, said not to be saved to the project
      await page.fill('#cx-input', 'Sketch the first screen.');
      await page.focus('#cx-input');
      await page.keyboard.press('Enter');
      await page.waitForSelector('#cx-own .cx-turn.is-answered', { timeout: 30_000 });
      expect(await text(page, '#cx-own .cx-divider')).toBe('This page’s own chat · not saved to the project’s conversation · no tools · no receipt');
      expect(await text(page, '#cx-own .cx-turn.is-answered .cx-text')).toBe('FAKE streamed answer from the test\'s stand-in.');
      expect(await page.$eval('#cx-own .cx-turn.is-answered .cx-who', (e) => [...e.children].map((c) => (c.textContent ?? '').trim()).slice(0, 3))).toEqual(['TIMMY', 'fake-qwen3:8b', 'FAKE model']);
      expect(await page.inputValue('#cx-input')).toBe('');
      expect(ollama.chats().at(-1)?.messages?.at(-1)).toMatchObject({ role: 'user', content: 'Sketch the first screen.' });
      // a bottom control opens its drawer; Esc closes it and gives focus back
      const controls = await page.$$eval('#cx-controls .cx-ctl', (els) => els.map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()));
      expect(controls.map((c) => c.replace(/^[^A-Za-z]+/, '').replace(/(?:\d+|—|free-only|this computer)$/, '').trim())).toEqual(['Attach', 'Tools', 'Plan / Run', 'Permissions', 'Budget', 'Stop', 'Logs', 'Cloudflare']);
      await page.click('[data-cx-ctl="tools"]');
      expect(await text(page, '#cx-drawer')).toContain('This page’s Send offers no tools');
      await page.keyboard.press('Escape');
      expect(await page.isVisible('#cx-drawer')).toBe(false);
      expect(await page.evaluate(() => document.activeElement?.getAttribute('data-cx-ctl'))).toBe('tools');
      // M hides and shows Models (not while typing)
      await page.keyboard.press('m');
      expect(await page.isVisible('#cx-models')).toBe(false);
      await page.keyboard.press('m');
      expect(await page.isVisible('#cx-models')).toBe(true);
      // every text of the composition and the menu is 13 px or more
      const small = await page.evaluate(() => {
        const out: string[] = [];
        for (const root of document.querySelectorAll('.cx, #shell-rail')) {
          const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          for (let n = walk.nextNode(); n; n = walk.nextNode()) {
            const t = (n.textContent ?? '').trim();
            const el = n.parentElement;
            if (!t || !el || !el.getClientRects().length) continue;
            const px = parseFloat(getComputedStyle(el).fontSize);
            if (px < 13) out.push(`${px}px ${t.slice(0, 40)}`);
          }
        }
        return out;
      });
      expect(small).toEqual([]);
      const face = await page.evaluate(() => document.body.innerText);
      expect(face).not.toContain(token);
      // the menu opens another destination with its own page (R10's, at its full width: its header and tab row), where Menu
      // opens the menu over it and Esc closes it again, focus back on Menu; key 2 brings Chat back
      await page.click('#rail-menu .rail-item[data-dest="home"]');
      await page.waitForFunction(() => document.body.dataset.dest === 'home' && !(document.getElementById('ws-home') as HTMLElement).hidden, null, { timeout: 10_000 });
      expect(await page.isVisible('.ws-header')).toBe(true);
      expect(await page.isVisible('#shell-rail')).toBe(false);
      expect(await page.getAttribute('#rail-menu .rail-item[data-dest="home"]', 'aria-current')).toBe('page');
      await page.click('#ws-menu');
      expect(await page.isVisible('#shell-rail')).toBe(true);
      expect(await page.evaluate(() => document.activeElement?.getAttribute('data-dest'))).toBe('home');
      await page.keyboard.press('Escape');
      expect(await page.isVisible('#shell-rail')).toBe(false);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('ws-menu');
      await page.keyboard.press('2');
      await page.waitForFunction(() => document.body.dataset.dest === 'chat', null, { timeout: 10_000 });
      expect(await page.isVisible('#shell-rail')).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 180_000);

  it('at 390 × 844 the controls fit with More, its controls open their drawers (Esc back to More), FAKE stays named; a home with no route opens its first run at the top, and a setup too', async () => {
    const { context, page, errors } = await openPage(browser, { origin }, { width: 390, height: 844 });
    try {
      await page.goto(`${origin}/#t=${token}`);
      await page.waitForSelector('#cx-turns .cx-turn.is-timmy', { timeout: 30_000 });
      expect(await page.isVisible('#shell-rail')).toBe(false);
      expect(await page.isVisible('#cx-models')).toBe(false);
      // the row of controls fits the phone's width: the minor ones are in More
      expect(await page.$eval('#cx-controls', (b) => b.scrollWidth <= b.clientWidth + 1)).toBe(true);
      const said = (sel: string): Promise<string[]> => page.$$eval(sel, (els) => els.filter((e) => e.getClientRects().length).map((e) => (e as HTMLElement).innerText.replace(/[^A-Za-z /]/g, '').trim()));
      expect(await said('#cx-controls .cx-ctl, #cx-controls .cx-more')).toEqual(['Tools', 'Budget', 'Stop', 'Logs', 'More']);
      await page.click('#cx-more');
      expect(await said('#cx-drawer [data-cx-ctl]')).toEqual(['Attach', 'Plan / Run', 'Permissions', 'Cloudflare']);
      await page.click('#cx-drawer [data-cx-ctl="attachments"]');
      expect(await text(page, '#cx-drawer')).toContain('Not on this page yet: its Send carries text only.');
      await page.keyboard.press('Escape');
      expect(await page.isVisible('#cx-drawer')).toBe(false);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('cx-more');
      // the status keeps each word with its value, and FAKE is named on it
      expect(await text(page, '#cx-status')).toContain('FAKE model');
      expect(await page.$eval('#cx-status .is-inference', (e) => (e as HTMLElement).innerText.replace(/\s+/g, ' ').trim())).toMatch(/^INFERENCE: Ollama on this computer/i);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }

    // a home with no chat route and an empty project; its Ollama a FAKE with no model (this computer's own is never asked)
    const fresh = mkdtempSync(join(tmpdir(), 'h171-chat-fresh-'));
    const none = await startFakeOllama({ models: [] });
    let other: CompanionServer | undefined;
    const keptRepo = process.env.TIMMY_REPO;
    try {
      const root = join(fresh, 'untitled');
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'README.md'), '# untitled\n');
      const env = { TIMMY_HOME: join(fresh, 'home'), TIMMY_SETTINGS_DIR: join(fresh, 'settings'), OLLAMA_HOST: none.host };
      process.env.TIMMY_REPO = root;
      other = await startCompanionServer(0, { chatEnv: env, workspace: { env } });
      if (keptRepo === undefined) delete process.env.TIMMY_REPO; else process.env.TIMMY_REPO = keptRepo;
      const at = `http://127.0.0.1:${other.port}`;
      const key = /#t=([0-9a-f]{64})$/.exec(other.url)![1];
      const { context: c2, page: p2, errors: e2 } = await openPage(browser, { origin: at }, { width: 800, height: 600 });
      try {
        await p2.goto(`${at}/#t=${key}`);
        await p2.waitForFunction(() => document.body.dataset.chatState === 'first-run', null, { timeout: 30_000 });
        await p2.waitForTimeout(400);
        // the first run opens at its top: its question in view, though the panel is taller than the window
        expect(await p2.$eval('#cx-scroll', (s) => [s.scrollTop, s.scrollHeight > s.clientHeight])).toEqual([0, true]);
        const title = await p2.$eval('#cx-empty .cx-title', (t) => [t.textContent, t.getBoundingClientRect().top >= (document.getElementById('cx-scroll') as HTMLElement).getBoundingClientRect().top]);
        expect(title).toEqual(['How would you like to run chat?', true]);
        // no model installed: OpenRouter is the suggested way, said why
        expect(await p2.getAttribute('.cx-way.is-suggested', 'data-cx-way')).toBe('openrouter');
        // a setup opens at its top too; the Models rail shows Ollama's answer once (its line), the list says so
        await p2.$eval('#cx-scroll', (s) => { s.scrollTop = s.scrollHeight; });
        await p2.click('[data-cx-way="ollama-local"]');
        await p2.waitForFunction(() => document.body.dataset.chatState === 'setup', null, { timeout: 10_000 });
        expect(await p2.$eval('#cx-scroll', (s) => s.scrollTop)).toBe(0);
        await p2.waitForSelector('#cm-list .cm-empty', { timeout: 20_000 });
        expect(await text(p2, '.cm-state')).toMatch(/^● answered \d\d:\d\d · Ollama answered its list of models at 127\.0\.0\.1:\d+: 0 installed here \(no model ran, no charge\)\. Install a model yourself \(ollama pull .+\); this page downloads nothing\.$/);
        expect(await text(p2, '#cm-list .cm-empty')).toBe('None listed: the line above says why.');
        expect(await p2.$('#cm-foot')).toBeNull();
        // Back to the choices: focus on the first way, the panel at its top again
        await p2.click('[data-cx="setup-back"]');
        await p2.waitForFunction(() => document.body.dataset.chatState === 'first-run', null, { timeout: 10_000 });
        expect(await p2.evaluate(() => document.activeElement?.getAttribute('data-cx-way'))).toBe('openrouter');
        expect(await p2.$eval('#cx-scroll', (s) => s.scrollTop)).toBe(0);
        expect(none.chats()).toEqual([]);
        expect(e2).toEqual([]);
      } finally {
        await c2.close();
      }
    } finally {
      if (process.env.TIMMY_REPO !== keptRepo) { if (keptRepo === undefined) delete process.env.TIMMY_REPO; else process.env.TIMMY_REPO = keptRepo; }
      await other?.shutdown();
      await none.close();
      rmSync(fresh, { recursive: true, force: true });
    }
  }, 180_000);
});
