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
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { browserPath, launchBrowser, openPage, landWorkspace } from './helpers/companion-page-kit.js';
import { appendReceipt } from '../src/utils/receipts.js';
import { startFakeOllama, textChunks, type FakeOllama } from './fixtures/fake-ollama-chat.js';

const FIXTURE = join(__dirname, 'fixtures', 'openrouter-public-catalog-2026-10-22.json');
interface FixtureModel { id: string; name: string; created?: number; pricing?: Record<string, string>; architecture?: { output_modalities?: string[] } }
const MODELS = (JSON.parse(readFileSync(FIXTURE, 'utf8')) as { data: FixtureModel[] }).data;
const TEXT = MODELS.filter((m) => !m.architecture?.output_modalities || m.architecture.output_modalities.includes('text'));
const NEWEST = [...TEXT].sort((a, b) => (b.created ?? 0) - (a.created ?? 0))[0];
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const ANSWER_1 = 'FAKE answer 1: a plan in three steps (no model behind it).';
const PARTIAL = 'FAKE partial answer, written before the stop';
const text = async (page: Page, sel: string): Promise<string> => ((await page.textContent(sel)) ?? '').replace(/\s+/g, ' ').trim();

const ANSWER_2 = 'FAKE answer 2: its receipt is hand-written here, so it does not verify.';
const ANSWER_4 = 'FAKE answer 4, which no receipt of this project seals.';

/**
 * The project: a conversation in the order the agent keeps it (the person, a tool's result, the answer) and its receipts:
 * two sealed as src/repl/seal.ts seals them (this project's own key: they verify), one written by hand (a FAKE hash: it does
 * not), one answer no receipt seals. Returns the sealed receipts' ids.
 */
function project(root: string): { a1: string; stop: string } {
  mkdirSync(join(root, '.sessions'), { recursive: true });
  const t0 = Date.parse('2026-10-22T23:30:00.000Z');
  const ask3 = 'Stop that one, please.';
  const lines = [
    { role: 'user', content: 'Help me turn this folder into a plan.', timestamp: t0 },
    { role: 'tool', name: 'list_project_files', content: 'README.md\nSHOT.md', timestamp: t0 + 500 },
    { role: 'assistant', content: ANSWER_1, timestamp: t0 + 1000 },
    { role: 'user', content: 'And the first slice?', timestamp: t0 + 2000 },
    { role: 'assistant', content: ANSWER_2, timestamp: t0 + 3000 },
    // (H168's pass 3b R19) a turn stopped in the Workbench: the conversation keeps Timmy's record of the stop
    { role: 'user', content: ask3, timestamp: t0 + 4000 },
    { role: 'assistant', content: `[Cancelled by the user before I finished answering. No tool had run. What I had written so far: ${JSON.stringify(PARTIAL)}. I stopped here and will not continue this request unless the user asks me to.]`, timestamp: t0 + 6000 },
    { role: 'user', content: 'One more question, then.', timestamp: t0 + 7000 },
    { role: 'assistant', content: ANSWER_4, timestamp: t0 + 8000 },
  ];
  writeFileSync(join(root, '.sessions', 'session-1792711800000-abc123.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const a1 = appendReceipt('runs', {
    kind: 'chat', subject: 'chat.turn · workbench · 1 step · fake-qwen3:8b', policy: 'human-gated', status: 'ok', via: 'ollama', model_resolved: 'fake-qwen3:8b', model_requested: 'fake-qwen3:8b',
    sources: [{ kind: 'ollama', host: 'http://127.0.0.1:11434', endpoint: 'local', tools: 'on', cost_basis: 'local endpoint' }],
    tool_outcomes: [{ name: 'list_project_files', outcome: 'completed' }], outcome_rule: 2, files: [],
    prompt_hash: sha('Help me turn this folder into a plan.'), response_hash: sha(ANSWER_1), cost_usd: 0, cost_measured: true, ms: 2140,
  } as never, root);
  const stop = appendReceipt('runs', {
    kind: 'chat', subject: 'chat.turn · workbench · cancelled · 0 steps · fake-qwen3:8b', policy: 'human-gated', status: 'cancelled', cancelled_at: 'before-tools', rollback: 'none', via: 'ollama',
    model_resolved: 'fake-qwen3:8b', model_requested: 'fake-qwen3:8b', sources: [{ kind: 'ollama', host: 'http://127.0.0.1:11434', endpoint: 'local', tools: 'off', cost_basis: 'local endpoint' }],
    prompt_hash: sha(ask3), response_hash: sha(PARTIAL), cost_usd: 0, cost_measured: true, ms: 1200,
  } as never, root);
  // a receipt written by hand, last on the chain (a FAKE hash): its body does not verify, and nothing after it is hurt
  writeFileSync(join(root, '.timmy', 'receipts', 'runs.jsonl'), `${JSON.stringify({
    v: 1, id: 'rc_hand', stream: 'runs', ts: '2026-10-22T23:30:03.000Z', kind: 'chat', subject: 'chat.turn · workbench · 0 steps · fake-qwen3:8b', epoch: 1, prev_hash: stop.hash,
    status: 'ok', via: 'ollama', model_resolved: 'fake-qwen3:8b', model_requested: 'fake-qwen3:8b', response_hash: sha(ANSWER_2), hash: `sha256_${'7f'.repeat(32)}`, ms: 900,
  })}\n`, { flag: 'a' });
  return { a1: a1.hash.slice(7, 15), stop: stop.hash.slice(7, 15) };
}

describe.skipIf(!browserPath)('the companion\'s shell and its Chat at 1440 × 900 (R10 H171)', () => {
  const kept = { TIMMY_REPO: process.env.TIMMY_REPO };
  let box = '';
  let browser: Browser;
  let ollama: FakeOllama;
  let companion: CompanionServer;
  let origin = '';
  let token = '';
  let ids = { a1: '', stop: '' };

  // the FAKE's list, by reference: a test changes a model's answer after the page listed it (a stale list)
  const models = [
    { name: 'fake-qwen3:8b', capabilities: ['completion', 'tools'] as string[] | null },
    { name: 'fake-llama:1b', capabilities: ['completion'] as string[] | null },
    { name: 'fake-embed:1', capabilities: ['embedding'] as string[] | null },
  ];

  beforeAll(async () => {
    browser = await launchBrowser();
    box = mkdtempSync(join(tmpdir(), 'h171-chat-shell-'));
    // R11 step 1: this file's own Timmy home and settings folder (tests/isolation-setup.ts), so what a choice made on the
    // page writes through the Workbench's paths (the setup's files, the process's settings store) is what the companion
    // reads back, as in production where both are the process's environment
    const home = process.env.TIMMY_HOME!;
    const root = join(box, 'tray');
    ids = project(root);
    ollama = await startFakeOllama({
      models,
      // (R11 step 2: three chunks 250 ms apart, so the turn streams long enough for its indicator to be read)
      chat: [() => ({ chunks: textChunks('fake-qwen3:8b', ['FAKE streamed ', 'answer from ', 'the test\'s stand-in.']), delayMs: 250 })],
    });
    mkdirSync(join(home, 'models'), { recursive: true });
    writeFileSync(join(home, 'models', 'openrouter-catalog.json'), JSON.stringify({ fetchedAt: '2026-10-22T16:00:00.000Z', models: MODELS }));
    writeFileSync(join(home, 'setup.json'), JSON.stringify({ version: 1, by: 'test', answers: { chat: 'local', ollama: ollama.host, model: 'fake-qwen3:8b' } }));
    const env = { TIMMY_HOME: home, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR };
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
      await landWorkspace(page);
      await page.waitForSelector('#cx-turns .cx-turn.is-timmy', { timeout: 30_000 });
      // the shell: Chat open, first in the menu and marked; the menu in the terminal's order
      expect(await page.getAttribute('body', 'data-dest')).toBe('chat');
      expect(await page.isVisible('#ws-chat')).toBe(true);
      expect(await page.isVisible('.ws-header')).toBe(false);
      // (R11 step 3: the terminal's groups and labels; every old route still reachable under its new name)
      const menu = await page.$$eval('#rail-menu .rail-item', (els) => els.map((e) => ({ label: e.querySelector('.rail-label')?.textContent?.trim(), current: e.getAttribute('aria-current') })));
      // (R11 round 4: the preview's rail; Control Room and Fleet & Clef keep their keys and the finder finds them)
      expect(menu.map((m) => m.label?.replace(/ · \d+$/, ''))).toEqual(['Chat', 'Files', 'Workflows', 'Runs & receipts', 'Canvas', 'VoxVision', 'Motion & 3D', 'Models & accounts', 'Tools & integrations']);
      expect(await page.$$eval('#rail-menu .rail-group', (els) => els.map((e) => (e.textContent ?? '').trim()))).toEqual(['Work', 'Create', 'Connect']);
      expect(await page.$$eval('#rail-foot .rail-foot-keys button', (els) => els.map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()))).toEqual(['? Help', '/ find']);
      expect(menu[0].current).toBe('page');
      expect(menu.filter((m) => m.current === 'page')).toHaveLength(1);
      // the project the companion says this page shows, once its socket has said it
      await page.waitForFunction(() => document.getElementById('rail-project-name')?.textContent === 'tray', null, { timeout: 15_000 });
      expect(await text(page, '#cx-proj')).toBe('tray');
      // the saved conversation: YOU / TIMMY, the model each answer's receipt names; a tool's result folds into the answer it precedes
      const turns = await page.$$eval('#cx-turns > .cx-turn', (els) => els.map((e) => e.className.replace('cx-turn ', '')));
      expect(turns).toEqual(['is-you', 'is-timmy', 'is-you', 'is-timmy', 'is-you', 'is-timmy is-stopped', 'is-you', 'is-timmy']);
      const timmy = await page.$$eval('#cx-turns > .cx-turn.is-timmy .cx-who', (els) => els.map((e) => [...e.children].map((c) => (c.textContent ?? '').trim()).slice(0, 3)));
      expect(timmy[0]).toEqual(['TIMMY', 'fake-qwen3:8b', 'FAKE model']);
      expect(timmy[1]).toEqual(['TIMMY', 'fake-qwen3:8b', 'FAKE model']);
      expect(timmy[3].slice(0, 2)).toEqual(['TIMMY', 'model not recorded']);
      // R11 step 2: the evidence line under each answer: "<model> · <where> · <seconds> · receipt <id> ✓" (✓ only when the
      // companion verified the receipt on this read); a hand-written receipt is "(not verified)"; no receipt says so
      const lines = await page.$$eval('#cx-turns > .cx-turn.is-timmy .cx-evidence', (els) => els.map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()));
      expect(lines).toEqual([
        `▸ fake-qwen3:8b · this computer · 2.1 s · receipt ${ids.a1} ✓`,
        '▸ fake-qwen3:8b · this computer · 0.9 s · receipt 7f7f7f7f',
        `▸ fake-qwen3:8b · this computer · 1.2 s · receipt ${ids.stop} ✓`,
        '▸ model not recorded · no receipt',
      ]);
      expect(await page.$('#cx-turns .cx-activity')).toBeNull();
      // Enter on the line opens the activity: the tools as grouped lines (the receipt's outcomes, the result's first line), the receipt's facts
      await page.focus('#cx-turns > .cx-turn.is-timmy .cx-evidence');
      await page.keyboard.press('Enter');
      await page.waitForSelector('#cx-turns .cx-activity', { timeout: 10_000 });
      expect(await page.getAttribute('#cx-turns > .cx-turn.is-timmy .cx-evidence', 'aria-expanded')).toBe('true');
      expect(await page.evaluate(() => document.activeElement?.className)).toBe('cx-evidence');
      const act = await page.$$eval('#cx-turns .cx-activity .cx-act-line, #cx-turns .cx-activity .cx-act-sub', (els) => els.map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()));
      expect(act).toEqual(['● list_project_files · completed', '└ README.md…']);
      const facts = await page.$$eval('#cx-turns .cx-activity .cx-facts dt, #cx-turns .cx-activity .cx-facts dd', (els) => els.map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()));
      expect(facts).toEqual([
        'Receipt', `${ids.a1} · sealed by the Workbench · ok · 1 step`, 'Verified', '✓ its links, body hashes and signature verify on this computer (checked on this read)',
        'Model', 'fake-qwen3:8b', 'Ran on', 'this computer', 'Time', '2.1 s', 'Spend', 'none', 'Files written', 'none',
      ]);
      expect(await text(page, '#cx-turns .cx-activity')).not.toMatch(/prev_hash|signature":|"hash"/);
      // the hand-written one, opened: why it is not verified, in words
      await page.click('#cx-turns > .cx-turn.is-timmy:nth-of-type(4) .cx-evidence');
      await page.waitForFunction(() => document.querySelectorAll('#cx-turns .cx-activity').length === 2, null, { timeout: 10_000 });
      const hand = await page.$$eval('#cx-turns > .cx-turn.is-timmy:nth-of-type(4) .cx-facts dt, #cx-turns > .cx-turn.is-timmy:nth-of-type(4) .cx-facts dd', (els) => els.map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()));
      expect(hand.slice(0, 4)).toEqual(['Receipt', '7f7f7f7f · sealed by the Workbench · ok · 0 steps', 'Verified', '✕ not verified: body hash mismatch (receipt rc_hand was tampered with)']);
      expect(await text(page, '#cx-turns > .cx-turn.is-timmy:nth-of-type(4) .cx-act-line')).toBe('No tool ran: the answer came from the model alone.');
      await page.click('#cx-turns > .cx-turn.is-timmy:nth-of-type(4) .cx-evidence');
      await page.click('#cx-turns > .cx-turn.is-timmy .cx-evidence');
      await page.waitForFunction(() => document.querySelectorAll('#cx-turns .cx-activity').length === 0, null, { timeout: 10_000 });
      // (H168's pass 3b R19) the stopped turn: its model and receipt (found by the person's message it answers), the answer
      // written before the stop, and Timmy's record of the stop folded, never shown as Timmy's words
      expect(timmy[2]).toEqual(['TIMMY', 'fake-qwen3:8b', 'FAKE model']);
      expect(await text(page, '#cx-turns > .cx-turn.is-stopped .cx-text')).toBe(PARTIAL);
      expect(await text(page, '#cx-turns > .cx-turn.is-stopped .cx-meta')).toBe('■ stopped by you');
      expect(await page.$eval('#cx-turns > .cx-turn.is-stopped details.cx-stop-record', (d) => (d as HTMLDetailsElement).open)).toBe(false);
      expect(await page.isVisible('#cx-turns > .cx-turn.is-stopped details.cx-stop-record pre')).toBe(false);
      // (no standalone tool result stands between the turns any more: the tool's result folded into its answer's activity)
      expect(await page.$('#cx-turns details.cx-tool:not(.cx-stop-record)')).toBeNull();
      expect(await text(page, '#cx-kicker')).toMatch(/^Chat \/ tray · since /);
      // the route of the next turn
      expect(await text(page, '#cx-route-words')).toBe('Next turn: fake-qwen3:8b · Ollama on this computer');
      // the Models rail: Ollama local first (the route's), its installed model in use and selected
      await page.waitForSelector('#cm-list .cm-row', { timeout: 20_000 });
      expect(await page.getAttribute('[data-cm-provider="ollama"][data-cm-sub="local"]', 'aria-selected')).toBe('true');
      expect(await text(page, '#cm-list .cm-row[data-model="fake-qwen3:8b"] .cm-inuse')).toBe('✓ in use');
      expect(await text(page, '.cm-detail')).toContain('✓ The next turn of this page uses this model.');
      expect(await text(page, '.cm-detail-k')).toBe('Selected');
      // (H168's pass 3b R20) the chat models of what Ollama lists, and why the other is not a row
      expect(await text(page, '.cm-list-head span:last-child')).toBe('2 chat models · 3 listed');
      expect(await text(page, '#cm-list .cm-left')).toBe('Not shown as local chat models: 1 did not pass Ollama\'s /api/show check as local weights.');
      expect(await text(page, '.cm-state')).toMatch(/· Ollama answered its list of models at 127\.0\.0\.1:\d+: it lists 3, 2 of them local chat models \(no model ran, no charge\)\.$/);
      // R11 step 1: the composer nobody can miss, and its model chip: green only because Ollama answered /api/show for the model
      expect(await page.getAttribute('#cx-input', 'placeholder')).toBe('Message Timmy…');
      expect(await text(page, '#cx-hint-keys')).toBe('Enter to send · Shift + Enter for a new line');
      expect(await page.getAttribute('#cx-dot', 'data-state')).toBe('ready');
      expect(await text(page, '#cx-chip-words')).toMatch(/^fake-qwen3:8b · this computer · ready \d\d:\d\d$/);
      // (H168's pass 4a R40: "ready" with its time, and the whole of it shown, not cut)
      expect(await page.$eval('#cx-chip-words', (e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
      expect(await page.isDisabled('#cx-send')).toBe(true);
      expect(await text(page, '#cx-send-why')).toBe('');
      expect(await page.$eval('#cx-send', (b) => getComputedStyle(b).backgroundColor)).not.toBe('rgb(255, 176, 0)');
      await page.fill('#cx-input', 'a');
      expect(await page.isDisabled('#cx-send')).toBe(false);
      expect(await page.$eval('#cx-send', (b) => getComputedStyle(b).backgroundColor)).toBe('rgb(255, 176, 0)');
      await page.focus('#cx-input');
      await page.keyboard.press('Control+j');
      await page.keyboard.type('b');
      expect(await page.inputValue('#cx-input')).toBe('a\nb');
      await page.fill('#cx-input', '');
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
      // (H168's pass 3b R18) no OpenRouter row is the next turn's model: none is opened, and the rail says what the next turn uses
      expect(await page.$('#cm-list .cm-detail')).toBeNull();
      expect(await text(page, '#cm-none')).toBe('Model / none · the next turn uses fake-qwen3:8b (Ollama on this computer), not a row here; a row shows its facts when you open it.');
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
      // (R11 step 1) a row can be chosen from here; this one needs the OpenRouter route, said when tried
      expect(await page.isDisabled('.cm-detail [data-cm-use]')).toBe(false);
      expect(detail).toContain('Kept in the settings and as Models’ record, as the Workbench keeps a choice');
      // a row the person opened that is not the next turn's model: MODEL, not SELECTED
      expect(await text(page, '.cm-detail-k')).toBe('Model');
      await page.click('.cm-detail [data-cm-use]');
      await page.waitForSelector('.cm-use-state[data-state="failed"]', { timeout: 15_000 });
      expect(await text(page, '.cm-use-state[data-state="failed"]')).toMatch(/^✕ anthropic\/claude-haiku-5\.5 runs on OpenRouter, and the chat's route is local/);
      expect(await text(page, '#cx-route-words')).toBe('Next turn: fake-qwen3:8b · Ollama on this computer');
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
      await landWorkspace(page);
      await page.waitForSelector('#cx-turns .cx-turn.is-timmy', { timeout: 30_000 });
      await page.waitForFunction(() => (document.getElementById('cx-input') as HTMLTextAreaElement | null)?.value === 'A draft kept across opening the page again', null, { timeout: 15_000 });
      // R11 round 4: sent with Enter, the turn is POST /api/chat/turn (H169's SSE). On a tree without that route the page
      // says so and streams nothing; with it, the FAKE's answer streams as this page's turn with its indicator and evidence
      await page.fill('#cx-input', 'Sketch the first screen.');
      await page.focus('#cx-input');
      await page.keyboard.press('Enter');
      await page.waitForSelector('#cx-own .cx-turn.is-answered, #cx-own .cx-turn.is-failed', { timeout: 30_000 });
      expect(await page.inputValue('#cx-input')).toBe('');
      const failedWords = await page.$eval('#cx-own .cx-turn', (e) => e.querySelector('.cx-end')?.textContent ?? '');
      if (/no POST \/api\/chat\/turn yet/.test(failedWords)) {
        console.warn('companion-chat-shell-browser: this tree has no POST /api/chat/turn (H169\'s agent turn): the page said so; the streamed turn is not checked here');
        expect(await text(page, '#cx-own .cx-turn.is-failed .cx-end')).toContain('this companion has no POST /api/chat/turn yet');
        expect(ollama.chats().length).toBe(0);
      } else {
        expect(await page.$('#cx-own .cx-spin')).toBeNull();
        expect(await text(page, '#cx-own .cx-turn.is-answered .cx-text')).toBe('FAKE streamed answer from the test\'s stand-in.');
        expect(await text(page, '#cx-own .cx-turn.is-answered .cx-evidence')).toMatch(/^▸ fake-qwen3:8b · Ollama on this computer · \d+(\.\d)? s · (receipt [0-9a-f]{8}|no receipt)/);
        expect(ollama.chats().at(-1)?.messages?.at(-1)).toMatchObject({ role: 'user', content: 'Sketch the first screen.' });
      }
      await page.click('#rail-new-conv');
      expect(await page.$$eval('#cx-own .cx-turn', (els) => els.length)).toBe(0);
      // R11 step 1 (the operator's first-use failure): a local model chosen on the page. Enter on its row: Ollama is asked
      // for that exact name (/api/show, no model run), the setup's answer is written, the draft is kept, the composer has
      // the keyboard, the route line, the chip and the status row say the next turn's model
      await page.fill('#cx-input', 'a draft kept through the choice');
      await page.click('[data-cm-provider="ollama"][data-cm-sub="local"]');
      await page.waitForSelector('#cm-list .cm-row[data-model="fake-llama:1b"]', { timeout: 20_000 });
      const shows = () => ollama.requests.filter((r) => r.path === '/api/show').map((r) => r.body?.model as string);
      const shown = shows().length;
      await page.focus('#cm-list .cm-row[data-model="fake-llama:1b"]');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.getElementById('cx-route-words')?.textContent?.startsWith('Next turn: fake-llama:1b'), null, { timeout: 20_000 });
      expect(shows().slice(shown)).toContain('fake-llama:1b');
      expect(JSON.parse(readFileSync(join(process.env.TIMMY_HOME!, 'setup.json'), 'utf8')).answers.model).toBe('fake-llama:1b');
      expect(await page.inputValue('#cx-input')).toBe('a draft kept through the choice');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('cx-input');
      expect(await text(page, '#cx-status .is-inference .cx-st-v')).toBe('fake-llama:1b on this computer');
      // (R11 step 3: the status row in sentences, as the terminal's)
      expect(await text(page, '#cx-status .is-logs')).toBe('Logs stay on this computer');
      expect(await page.$eval('#rail-menu .rail-item[data-dest="tools"] .rail-label', (e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
      expect(await text(page, '#cx-status .cx-st-sync')).toBe('cloud sync off · spend no charge');
      expect(await text(page, '#cx-note')).toBe('Next turn: fake-llama:1b on this computer.');
      await page.waitForFunction(() => document.getElementById('cx-dot')?.dataset.state === 'ready' && /^fake-llama:1b · this computer · ready \d\d:\d\d$/.test(document.getElementById('cx-chip-words')?.textContent ?? ''), null, { timeout: 20_000 });
      expect(await text(page, '#cm-list .cm-row[data-model="fake-llama:1b"] .cm-inuse')).toBe('✓ in use');
      // a row Ollama no longer establishes as a chat model (its list is stale): the row says why, nothing changed
      const qwen = models.find((m) => m.name === 'fake-qwen3:8b')!;
      qwen.capabilities = ['embedding'];
      try {
        await page.focus('#cm-list .cm-row[data-model="fake-qwen3:8b"]');
        await page.keyboard.press('Enter');
        await page.waitForSelector('.cm-use-state[data-state="failed"]', { timeout: 15_000 });
        // (H170's checkLocalModel's words, shared with the terminal, after "Not chosen:")
        expect(await text(page, '.cm-use-state[data-state="failed"]')).toMatch(/^✕ Not chosen: fake-qwen3:8b is not a chat model: Ollama at 127\.0\.0\.1:\d+ lists it without the completion capability \(an embedding model, or weights in a form it cannot run\)\. Choose a chat model\. Nothing was changed\.$/);
        expect(await text(page, '#cx-route-words')).toMatch(/^Next turn: fake-llama:1b /);
        expect(await page.evaluate(() => document.activeElement?.getAttribute('data-model'))).toBe('fake-qwen3:8b');
        // the state beside the row itself, and the row in view (the rail scrolled to it)
        expect(await text(page, '#cm-list .cm-row[data-model="fake-qwen3:8b"] .cm-row-state')).toBe('✕ not a chat model');
        expect(await page.evaluate(() => { const r = document.querySelector('#cm-list .cm-row[data-model="fake-qwen3:8b"]')!.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; })).toBe(true);
      } finally { qwen.capabilities = ['completion', 'tools']; }
      // back to the first model for the cases below
      await page.focus('#cm-list .cm-row[data-model="fake-qwen3:8b"]');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.getElementById('cx-route-words')?.textContent?.startsWith('Next turn: fake-qwen3:8b'), null, { timeout: 20_000 });
      await page.fill('#cx-input', '');
      // a bottom control opens its drawer; Esc closes it and gives focus back
      const controls = await page.$$eval('#cx-controls .cx-ctl', (els) => els.map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()));
      // (R11 round 4: the preview's bottom row [Plan / Run] [Permissions] [Budget] [Logs] … [Cloudflare optional]; Attach and Tools
      // in the composer; Stop in the composer)
      expect(controls.map((c) => c.replace(/^[^A-Za-z$]+/, '').replace(/(?:\d+|—|free-only|this computer)$/, '').trim())).toEqual(['Plan / Run', 'Permissions', 'Budget', 'Logs', 'Cloudflare optional']);
      expect(await page.$('#cx-controls [data-cx="stop"], #cx-controls [data-cx="stop-other"]')).toBeNull();
      await page.click('#cx-controls [data-cx-ctl="approvals"]');
      expect(await page.isVisible('#cx-drawer')).toBe(true);
      await page.keyboard.press('Escape');
      expect(await page.isVisible('#cx-drawer')).toBe(false);
      expect(await page.evaluate(() => document.activeElement?.getAttribute('data-cx-ctl'))).toBe('approvals');
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
      // R11 step 3: "/ find" filters the rail by name and Enter opens the first; "? Help" is the help by task
      await page.keyboard.press('/');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('rail-find');
      await page.keyboard.type('runs');
      expect(await page.$$eval('#rail-menu .rail-item .rail-label', (els) => els.map((e) => (e.textContent ?? '').trim()))).toEqual(['Runs & receipts']);
      expect(await page.$$eval('#rail-menu .rail-group', (els) => els.filter((e) => !(e as HTMLElement).hidden).map((e) => (e.textContent ?? '').trim()))).toEqual(['Work']);
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.body.dataset.dest === 'logs', null, { timeout: 10_000 });
      await page.keyboard.press('2');
      await page.waitForFunction(() => document.body.dataset.dest === 'chat', null, { timeout: 10_000 });
      expect(await page.isVisible('#rail-find-box')).toBe(false);
      expect(await page.$$eval('#rail-menu .rail-item', (els) => els.length)).toBe(11);
      await page.click('#rail-help');
      expect(await text(page, '#cx-drawer-title')).toBe('Help');
      expect(await page.$$eval('#cx-drawer h4', (els) => els.map((e) => (e.textContent ?? '').trim()))).toEqual(['Chat', 'Models', 'Moving around', 'Runs']);
      await page.keyboard.press('Escape');
      expect(await page.isVisible('#cx-drawer')).toBe(false);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }, 180_000);

  it('at 1280 × 720 the composer, its chip and Send read as at 1440 (the rail beside them); the conversation takes the height first: the composer one row until typed in, the chip whole with Send on its row, the first answer above the fold (R51, R52)', async () => {
    const { context, page, errors } = await openPage(browser, { origin }, { width: 1280, height: 720 });
    try {
      await page.goto(`${origin}/#t=${token}`);
      await landWorkspace(page);
      await page.waitForSelector('#cx-turns .cx-turn.is-timmy', { timeout: 30_000 });
      await page.waitForFunction(() => document.getElementById('cx-dot')?.dataset.state === 'ready', null, { timeout: 20_000 });
      expect(await page.isVisible('#cx-models')).toBe(true);
      expect(await text(page, '#cx-chip-words')).toMatch(/^fake-(?:qwen3:8b|llama:1b) · this computer · ready \d\d:\d\d$/);
      expect(await page.$eval('#cx-chip-words', (e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
      // R52: the chip's words are whole (wrapped inside the chip if the row is tight, never cut with …), and Send is on the chip's row
      expect(await page.$eval('#cx-chip-words', (e) => getComputedStyle(e).whiteSpace !== 'nowrap' && e.scrollHeight <= e.clientHeight + 1)).toBe(true);
      expect(await page.evaluate(() => { const c = document.getElementById('cx-chip')!.getBoundingClientRect(); const s = document.getElementById('cx-send')!.getBoundingClientRect(); return s.top < c.bottom && s.bottom > c.top; })).toBe(true);
      // R51: the composer is one row until typed in; it grows with the draft and shrinks back
      expect(await page.$eval('#cx-input', (e) => (e as HTMLTextAreaElement).rows)).toBe(1);
      expect(await page.isDisabled('#cx-send')).toBe(true);
      // the conversation takes the height first: its scroll box has at least 400 px of the 720 (the head's paragraph, the
      // field's label and the draft sentence are not drawn at this height; the composer is one row), so an exchange's answer
      // is above the fold; the last answer's text is in view over the composer
      expect(await page.$eval('#cx-scroll', (e) => e.clientHeight)).toBeGreaterThanOrEqual(400);
      expect(await page.$$eval('#cx-turns .cx-turn.is-timmy .cx-text', (els) => { const r = els[els.length - 1].getBoundingClientRect(); const f = document.getElementById('cx-composer')!.getBoundingClientRect(); return r.top >= 0 && r.bottom <= f.top; })).toBe(true);
      expect(await page.$eval('#cx-sub', (e) => e.getClientRects().length)).toBe(0);
      expect(await page.$eval('#cx-hint-draft', (e) => e.getClientRects().length)).toBe(0);
      await page.fill('#cx-input', 'x');
      expect(await page.isDisabled('#cx-send')).toBe(false);
      expect(await page.$eval('#cx-send', (b) => getComputedStyle(b).backgroundColor)).toBe('rgb(255, 176, 0)');
      expect(await page.$eval('#cx-composer', (f) => { const r = f.getBoundingClientRect(); return r.bottom <= window.innerHeight && r.width > 500; })).toBe(true);
      await page.fill('#cx-input', 'one\ntwo\nthree');
      expect(await page.$eval('#cx-input', (e) => (e as HTMLTextAreaElement).rows)).toBe(3);
      await page.fill('#cx-input', '');
      expect(await page.$eval('#cx-input', (e) => (e as HTMLTextAreaElement).rows)).toBe(1);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 120_000);

  it('an empty conversation shows the welcome (the preview\'s: the question, one line, three starters that act) at 1440 × 900 and 390 × 844; a turn being answered elsewhere shows an indicator with its words', async () => {
    // a second companion on a project that keeps no conversation yet (the route the setup chose is ready)
    const root = join(box, 'fresh');
    mkdirSync(root, { recursive: true });
    const home = process.env.TIMMY_HOME!;
    const env = { TIMMY_HOME: home, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR };
    process.env.TIMMY_REPO = root;
    const own = await startCompanionServer(0, { chatEnv: env, workspace: { env } });
    if (kept.TIMMY_REPO === undefined) delete process.env.TIMMY_REPO; else process.env.TIMMY_REPO = kept.TIMMY_REPO;
    const o2 = `http://127.0.0.1:${own.port}`;
    const t2 = /#t=([0-9a-f]{64})$/.exec(own.url)![1];
    // (the hold's writer: a sleep of this test's; its start is recorded now, as the view checks it against the process table within 3 s)
    const child = spawn('sleep', ['60'], { stdio: 'ignore' });
    const childStarted = new Date().toISOString();
    try {
      for (const size of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
        const { context, page, errors } = await openPage(browser, { origin: o2 }, size);
        try {
          await page.goto(`${o2}/#t=${t2}`);
          await landWorkspace(page);
          await page.waitForFunction(() => document.body.dataset.chatState === 'empty', null, { timeout: 30_000 });
          // the welcome opens at its top, the composer in view below it at both sizes
          expect(await page.$eval('#cx-scroll', (e) => e.scrollTop)).toBe(0);
          expect(await page.$eval('#cx-empty .cx-welcome-title', (e) => e.getBoundingClientRect().top >= 0)).toBe(true);
          expect(await page.$eval('#cx-composer', (f) => f.getBoundingClientRect().bottom <= window.innerHeight)).toBe(true);
          // R11 round 4 (the preview's welcome): the mark, "What would you like to make?", one line, three starters in one row at
          // the desk and stacked on the phone, all above the composer; FAKE is named on the descriptor
          expect(await text(page, '#cx-descriptor')).toContain('FAKE model on this computer');
          expect(await text(page, '#cx-empty .cx-welcome-title')).toBe('What would you like to make?');
          expect(await page.$$eval('#cx-empty .cx-welcome-line', (els) => els.map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()))).toEqual(['Your models, tools and ideas share one workspace.']);
          const starters = await page.$$eval('#cx-empty [data-cx-start]', (els) => els.map((e) => [e.getAttribute('data-cx-start'), e.querySelector('.cx-way-title')?.textContent?.trim()]));
          expect(starters).toEqual([['plan', 'Plan a project'], ['image', 'Inspect an image'], ['workflow', 'Build a workflow']]);
          await page.evaluate(() => document.fonts.ready);
          const geo = await page.$$eval('#cx-empty [data-cx-start]', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { top: Math.round(r.top), bottom: r.bottom, inside: r.left >= 0 && r.right <= window.innerWidth, cut: e.scrollHeight > e.clientHeight + 1 }; }));
          const fold = await page.$eval('#cx-composer', (f) => f.getBoundingClientRect().top);
          for (const g of geo) { expect(g.inside).toBe(true); expect(g.cut).toBe(false); expect(g.bottom).toBeLessThanOrEqual(fold); }
          expect(new Set(geo.map((g) => g.top)).size).toBe(size.width === 1440 ? 1 : 3);
          // Plan a project: the sample draft in the composer, which has the keyboard; the page's own draft is kept as it is
          await page.click('[data-cx-start="plan"]');
          expect(await page.inputValue('#cx-input')).toBe('Plan this project: what it does, what ran here last, and the next step.');
          expect(await page.evaluate(() => document.activeElement?.id)).toBe('cx-input');
          expect(await page.isDisabled('#cx-send')).toBe(false);
          await page.fill('#cx-input', 'my own words');
          await page.click('[data-cx-start="plan"]');
          expect(await page.inputValue('#cx-input')).toBe('my own words');
          await page.fill('#cx-input', '');
          // the other two open this page's tabs: VoxVision, Workflows; Chat in the rail comes back
          for (const [id, dest] of [['image', 'voxvision'], ['workflow', 'workflows']]) {
            await page.click(`[data-cx-start="${id}"]`);
            await page.waitForFunction((d) => document.body.dataset.dest === d, dest, { timeout: 10_000 });
            // (back to Chat by its key, as the frame's tabs take it: another tab shows the frame's own nav, the rail folded)
            await page.keyboard.press('2');
            await page.waitForFunction(() => document.body.dataset.dest === 'chat', null, { timeout: 10_000 });
            await page.waitForFunction(() => document.body.dataset.chatState === 'empty', null, { timeout: 10_000 });
          }
          expect(await page.$('#cx-running:not([hidden])')).toBeNull();
          // a turn of this project being answered by another surface (a live hold: its writer a sleep of this test's, killed by its pid)
          mkdirSync(join(root, '.timmy', 'chat-turns'), { recursive: true });
          const hold = join(root, '.timmy', 'chat-turns', `t${child.pid}-0b0b0b0b.json`);
          writeFileSync(hold, `${JSON.stringify({ schema: 'timmy.chat-turn-hold/1', surface: 'workbench', owner: { pid: child.pid, started: childStarted }, taken: new Date(Date.now() - 1500).toISOString() })}\n`);
          await page.goto(`${o2}/#t=${t2}`);
          await landWorkspace(page);
          await page.waitForSelector('#cx-running:not([hidden]) .cx-spin', { timeout: 30_000 });
          expect(await text(page, '#cx-running')).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] A turn of this project is being answered in the Workbench since \d\d:\d\d; its receipt comes when it ends\.$/);
          rmSync(hold);
          expect(errors).toEqual([]);
        } finally { await context.close(); }
      }
    } finally { child.kill(); await own.shutdown(); }
  }, 240_000);

  it('at 390 × 844 the controls fit with More, its controls open their drawers (Esc back to More), FAKE stays named; a home with no route shows the welcome with Send off and the way to the connections screen', async () => {
    const { context, page, errors } = await openPage(browser, { origin }, { width: 390, height: 844 });
    try {
      await page.goto(`${origin}/#t=${token}`);
      await landWorkspace(page);
      await page.waitForSelector('#cx-turns .cx-turn.is-timmy', { timeout: 30_000 });
      expect(await page.isVisible('#shell-rail')).toBe(false);
      expect(await page.isVisible('#cx-models')).toBe(false);
      // the row of controls fits the phone's width: the minor ones are in More
      expect(await page.$eval('#cx-controls', (b) => b.scrollWidth <= b.clientWidth + 1)).toBe(true);
      const said = (sel: string): Promise<string[]> => page.$$eval(sel, (els) => els.filter((e) => e.getClientRects().length).map((e) => (e as HTMLElement).innerText.replace(/[^A-Za-z /]/g, '').trim()));
      // (R11 round 4, capture 09: Plan / Run · Permissions · Budget · Logs · More; Attach, Tools and Cloudflare optional in More)
      expect(await said('#cx-controls .cx-ctl, #cx-controls .cx-more')).toEqual(['Plan / Run', 'Permissions', 'Budget', 'Logs', 'More']);
      await page.click('#cx-more');
      expect(await said('#cx-drawer [data-cx-ctl]')).toEqual(['Attach', 'Tools', 'Cloudflare optional']);
      await page.click('#cx-drawer [data-cx-ctl="attachments"]');
      expect(await text(page, '#cx-drawer')).toContain('Not on this page yet: its Send carries text only.');
      await page.keyboard.press('Escape');
      expect(await page.isVisible('#cx-drawer')).toBe(false);
      // (R11 round 4: FAKE is named on the descriptor; the next turn's model in the panel's NEXT TURN and the line above the composer)
      expect(await text(page, '#cx-descriptor')).toContain('FAKE model on this computer');
      expect(await text(page, '#cx-next-turn-model')).toMatch(/^fake-(?:qwen3:8b|llama:1b)$/);
      // R11 step 1 on a phone: the chip, and a model chosen from the Models drawer closes it and gives the composer the keyboard
      await page.waitForFunction(() => document.getElementById('cx-dot')?.dataset.state === 'ready', null, { timeout: 20_000 });
      expect(await text(page, '#cx-chip-words')).toMatch(/^fake-(?:qwen3:8b|llama:1b) · this computer · ready \d\d:\d\d$/);
      await page.fill('#cx-input', 'phone draft');
      await page.click('#cx-chip');
      expect(await page.isVisible('#cx-models')).toBe(true);
      await page.click('[data-cm-provider="ollama"][data-cm-sub="local"]');
      await page.waitForSelector('#cm-list .cm-row[data-model="fake-llama:1b"]', { timeout: 20_000 });
      await page.focus('#cm-list .cm-row[data-model="fake-llama:1b"]');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.getElementById('cx-route-words')?.textContent?.startsWith('Next turn: fake-llama:1b'), null, { timeout: 20_000 });
      expect(await page.isVisible('#cx-models')).toBe(false);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('cx-input');
      expect(await page.inputValue('#cx-input')).toBe('phone draft');
      expect(await text(page, '#cx-status .is-inference .cx-st-v')).toBe('fake-llama:1b on this computer');
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
        await landWorkspace(p2);
        // R11 round 4: a home with no route shows the welcome (the route is made on the connections screen, not in the center):
        // the line above the composer says no model is connected, Send is off and says why, the panel's NEXT TURN says no model
        await p2.waitForFunction(() => document.body.dataset.chatState === 'empty', null, { timeout: 30_000 });
        await p2.waitForFunction(() => (document.getElementById('cx-route-words')?.textContent ?? '').startsWith('No model connected'), null, { timeout: 30_000 });
        expect(await text(p2, '#cx-empty .cx-welcome-title')).toBe('What would you like to make?');
        expect(await text(p2, '#cx-change')).toBe('Set up a model →');
        await p2.fill('#cx-input', 'a draft with no model');
        expect(await p2.isDisabled('#cx-send')).toBe(true);
        expect(await text(p2, '#cx-send-why')).toBe('No model chosen: choose one in Models');
        expect(await text(p2, '#cx-next-turn-model')).toBe('No model selected');
        await p2.focus('#cx-input');
        await p2.keyboard.press('Enter');
        expect(none.chats()).toEqual([]);
        expect(await p2.inputValue('#cx-input')).toBe('a draft with no model');
        // the Models panel (a drawer at this width): Ollama local lists nothing, said why; no row SELECTED, nobody chose one
        await p2.click('#cx-models-toggle');
        await p2.click('[data-cm-provider="ollama"][data-cm-sub="local"]');
        await p2.waitForFunction(() => { const e = document.querySelector('#cm-list .cm-empty'); return Boolean(e && !/^Reading/.test(e.textContent ?? '')); }, null, { timeout: 20_000 });
        expect(await text(p2, '#cm-desc-state')).toMatch(/^● answered \d\d:\d\d$/);
        expect(await text(p2, '#cm-desc .cm-state')).toMatch(/^Ollama answered its list of models at 127\.0\.0\.1:\d+: 0 installed here \(no model ran, no charge\)\. Install a model yourself \(ollama pull .+\); this page downloads nothing\.$/);
        expect(await text(p2, '#cm-list .cm-empty')).toContain('None listed: the line above says why.');
        expect(await p2.$('#cm-foot')).toBeNull();
        expect(await p2.getAttribute('#cx-dot', 'data-state')).toBe('unknown');
        expect(await text(p2, '#cx-chip-words')).toBe('no model · choose one');
        // (H168's R18b) a fresh page with no setup never says "the setup's model": a row opened in Models, the whole face read
        await p2.click('[data-cm-provider="openrouter"]');
        await p2.waitForSelector('#cm-list .cm-row', { timeout: 20_000 });
        expect(await p2.$('#cx-models .cm-detail')).toBeNull();
        expect(await text(p2, '#cm-none')).toBe('Model / none · no model is chosen for the next turn; a row shows its facts when you open it.');
        await p2.click('#cm-list .cm-row');
        await p2.waitForSelector('.cm-detail', { timeout: 10_000 });
        expect(await p2.evaluate(() => document.body.innerText)).not.toMatch(/setup['’]s (model|choice)/);
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
