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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { browserPath, launchBrowser, openPage, landWorkspace } from './helpers/companion-page-kit.js';
import { appendReceipt } from '../src/utils/receipts.js';
import { startFakeOllama, textChunks, toolCallChunks, type FakeOllama } from './fixtures/fake-ollama-chat.js';

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
      // (R11 step 2: three chunks 250 ms apart, so the turn streams long enough for its indicator to be read; R11 round 5: a
      // second turn that never answers, stopped from the page — the activity component's feed on Stop)
      // (R11 round 6: the NEEDS-YOU case after the first — the FAKE model asks for write_project_file, which asks the person; answered
      // once, the tool runs and the model says Written.)
      chat: [() => ({ chunks: textChunks('fake-qwen3:8b', ['FAKE streamed ', 'answer from ', 'the test\'s stand-in.']), delayMs: 250 }), () => ({ hang: true }),
        () => ({ chunks: toolCallChunks('fake-qwen3:8b', [{ name: 'write_project_file', arguments: { path: 'notes-r6.md', content: 'from the FAKE model, allowed once on the page\n' } }]) }), () => ({ chunks: textChunks('fake-qwen3:8b', ['Written', '.', ' The', ' note', ' is', ' there.']), delayMs: 400 }),
        // (the 390 ask case: the same gate, denied on the page)
        () => ({ chunks: toolCallChunks('fake-qwen3:8b', [{ name: 'write_project_file', arguments: { path: 'notes-390.md', content: 'not written: denied\n' } }]) }), () => ({ chunks: textChunks('fake-qwen3:8b', ['Not written.']) })],
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
    // (an action on an element that is not there fails here with its line, instead of holding the case to its own timeout)
    page.setDefaultTimeout(30_000);
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
      // (R11 round 7: the rail is the shell's — SHELL CONTRACT v1 §3.1, D3's groups; Control Room listed; Help & find in its foot)
      expect(menu.map((m) => m.label?.replace(/ · \d+$/, ''))).toEqual(['Chat', 'Files', 'Workflows', 'Runs & receipts', 'Canvas', 'VoxVision', 'Motion & 3D', 'Models & accounts', 'Tools & integrations', 'Control Room']);
      expect(await page.$$eval('#rail-menu .rail-group', (els) => els.map((e) => (e.textContent ?? '').trim()))).toEqual(['Work', 'Create', 'Connect']);
      expect(await text(page, '#shell-help')).toContain('Help & find');
      expect(menu[0].current).toBe('page');
      expect(menu.filter((m) => m.current === 'page')).toHaveLength(1);
      // the project the companion says this page shows, once its socket has said it
      await page.waitForFunction(() => document.getElementById('rail-project-name')?.textContent === 'tray', null, { timeout: 60_000 });
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
      // (R11 round 7: the receipt is a LINK into Runs & receipts beside the line — the row reads as before, with → after the link)
      const lines = await page.$$eval('#cx-turns > .cx-turn.is-timmy .cx-ev-row', (els) => els.map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()));
      expect(lines).toEqual([
        `▸ fake-qwen3:8b · this computer · 2.1 s · receipt ${ids.a1} ✓ →`,
        '▸ fake-qwen3:8b · this computer · 0.9 s · receipt 7f7f7f7f →',
        `▸ fake-qwen3:8b · this computer · 1.2 s · receipt ${ids.stop} ✓ →`,
        '▸ model not recorded · no receipt',
      ]);
      expect(await page.$$eval('#cx-turns > .cx-turn.is-timmy .cx-receipt', (els) => els.map((e) => [e.getAttribute('href'), e.classList.contains('is-verified')]))).toEqual([[`#logs?receipt=${ids.a1}`, true], ['#logs?receipt=7f7f7f7f', false], [`#logs?receipt=${ids.stop}`, true]]);
      expect(await page.$('#cx-turns .cx-activity')).toBeNull();
      // (R11 round 7) a receipt link is the way to Runs & receipts: the click fires timmy:open-receipt with the id, the address
      // names it, the logs page is shown; key 2 brings Chat back (the link never leaves the page or reloads it)
      await page.evaluate(() => { (window as unknown as { __receipts: unknown[] }).__receipts = []; document.addEventListener('timmy:open-receipt', (e) => (window as unknown as { __receipts: unknown[] }).__receipts.push((e as CustomEvent).detail)); });
      await page.click(`#cx-turns > .cx-turn.is-timmy .cx-receipt[data-cx-receipt="${ids.a1}"]`);
      await page.waitForFunction(() => document.body.dataset.dest === 'logs' && !(document.getElementById('ws-logs') as HTMLElement).hidden, null, { timeout: 10_000 });
      expect(await page.evaluate(() => ({ events: (window as unknown as { __receipts: unknown[] }).__receipts, hash: location.hash }))).toEqual({ events: [{ id: ids.a1, from: 'chat' }], hash: `#logs?receipt=${ids.a1}` });
      await page.keyboard.press('2');
      await page.waitForFunction(() => document.body.dataset.dest === 'chat', null, { timeout: 10_000 });
      // Enter on the line opens the activity: the tools as grouped lines (the receipt's outcomes, the result's first line), the receipt's facts
      await page.focus('#cx-turns > .cx-turn.is-timmy .cx-evidence');
      await page.keyboard.press('Enter');
      await page.waitForSelector('#cx-turns .cx-activity', { timeout: 10_000 });
      expect(await page.getAttribute('#cx-turns > .cx-turn.is-timmy .cx-evidence', 'aria-expanded')).toBe('true');
      expect(await page.evaluate(() => document.activeElement?.className)).toBe('cx-evidence');
      // (R11 round 7: each tool a collapsed card — the dot, the tool, its state, the verb and the result's first line on one row;
      // the result's lines behind Details)
      const act = await page.$$eval('#cx-turns .cx-activity .cx-act-line, #cx-turns .cx-activity .cx-act-sub', (els) => els.map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()));
      expect(act).toEqual(['● list_project_files · completed · Listed the project’s files · README.md…']);
      expect(await page.$eval('#cx-turns .cx-activity .cx-tcard', (d) => ({ open: (d as HTMLDetailsElement).open, tool: d.getAttribute('data-tool'), pre: d.querySelector('pre')?.textContent }))).toEqual({ open: false, tool: 'list_project_files', pre: 'README.md\nSHOT.md' });
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
      // (R11 round 7: the kicker is the hierarchy's — 01 / <project> · <the current task>, the newest message of the person's)
      expect(await text(page, '#cx-kicker')).toBe('01 / tray · One more question, then.');
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
      // (R11 round 4: the provider's state word beside its name in the panel's description, its words on their own line)
      expect(await text(page, '#cm-desc-state')).toMatch(/^● answered \d\d:\d\d$/);
      expect(await text(page, '#cm-desc .cm-state')).toMatch(/^Ollama answered its list of models at 127\.0\.0\.1:\d+: it lists 3, 2 of them local chat models \(no model ran, no charge\)\.$/);
      // R11 step 1: the composer nobody can miss, and its model chip: green only because Ollama answered /api/show for the model
      expect(await page.getAttribute('#cx-input', 'placeholder')).toBe('Message Timmy…');
      expect(await text(page, '#cx-hint-keys')).toBe('Enter to send · Shift + Enter for a new line');
      expect(await page.getAttribute('#cx-dot', 'data-state')).toBe('ready');
      expect(await text(page, '#cx-chip-words')).toMatch(/^fake-qwen3:8b · this computer · ready \d\d:\d\d$/);
      // (H168's pass 4a R40: "ready" with its time, and the whole of it shown, not cut)
      expect(await page.$eval('#cx-chip-words', (e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
      expect(await page.isDisabled('#cx-send')).toBe(true);
      expect(await text(page, '#cx-send-why')).toBe('');
      expect(await page.$eval('#cx-send', (b) => ({ image: getComputedStyle(b).backgroundImage, color: getComputedStyle(b).backgroundColor }))).toEqual({ image: 'none', color: 'rgba(0, 0, 0, 0)' }); // (off: no primary material)
      await page.fill('#cx-input', 'a');
      // (no identity provider here: the page is this computer's operator, and Send is amber with a draft and a route)
      expect(await page.isDisabled('#cx-send')).toBe(false);
      expect(await page.$eval('#cx-send', (b) => getComputedStyle(b).backgroundImage)).toContain('linear-gradient'); // (B11: the primary's material, the family gradient; never green)
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
      // OpenRouter: its public rows, newest first (the catalog's added date; the control says "Newest first", R11 round 4); Cost keeps through a Sort; Clear filters shows all
      await page.click('[data-cm-provider="openrouter"]');
      await page.waitForFunction((n) => document.querySelectorAll('#cm-list .cm-row').length === n, TEXT.length, { timeout: 20_000 });
      expect(await text(page, '#cm-list .cm-row .cm-name')).toBe(NEWEST.name);
      // (H168's pass 3b R18) no OpenRouter row is the next turn's model: none is opened, and the rail says what the next turn uses
      expect(await page.$('#cm-list .cm-detail')).toBeNull();
      expect(await text(page, '#cm-none')).toBe('Model / none · the next turn uses fake-qwen3:8b (Ollama on this computer), not a row here; a row shows its facts when you open it.');
      expect(await page.$eval('#cm-sort', (s) => (s as HTMLSelectElement).selectedOptions[0].textContent)).toBe('Newest first');
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
      // (R11 round 7, H169's CATALOG METADATA v1 on the row) the capabilities the catalog lists as TRUE are chips, the provider
      // named at the right; a price with other charges says so; nothing the catalog does not list is drawn as a no
      const rowMeta = (id: string) => page.$eval(`#cm-list .cm-row[data-model="${id}"]`, (e) => ({ caps: [...e.querySelectorAll('.cm-cap')].map((c) => c.textContent?.trim()), src: e.querySelector('.cm-row-src')?.textContent?.trim(), facts: [...e.querySelectorAll('.cm-row-facts > span')].map((c) => (c.textContent ?? '').replace(/\s+/g, ' ').trim()) }));
      expect(await rowMeta('anthropic/claude-haiku-5.5')).toEqual({ caps: ['tools', 'vision', 'reasoning'], src: 'OpenRouter', facts: ['1M ctx', '$0.1 / $0.5 per M + other charges'] });
      expect(await rowMeta('recursive/flint-v1.0:free')).toEqual({ caps: ['tools', 'reasoning'], src: 'OpenRouter', facts: ['262K ctx', 'free · $0 / $0 per M'] });
      // a model not in use: its detail, and why it cannot be used from this page yet
      await page.click('#cm-list .cm-row[data-model="anthropic/claude-haiku-5.5"]');
      const detail = await text(page, '.cm-detail');
      expect(detail).toContain('Anthropic: Claude Haiku 5.5');
      expect(detail).toContain('Model idanthropic/claude-haiku-5.5');
      // (round 7) the catalog's other charges and its "varies" are the detail's own rows, in the provider's words
      expect(detail).toContain('Other chargesweb_search');
      expect(detail).toContain('Pricevaries by request (the provider’s word)');
      expect(detail).toContain('Tools · Vision · Reasoningyes · yes · yes');
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
      // R11 round 4: Send is POST /api/chat/turn (H169's SSE, the real agent turn). No identity provider is configured here,
      // so the page is this computer's operator (the lead's ruling of 21:48; H173's operator principal): the turn runs in the
      // companion's own project and env, the FAKE Ollama answers, and the answer streams as this page's turn with its
      // indicator and evidence line (with a provider configured, Send needs a session: tests/companion-shell-r4-browser)
      // R11 round 5 (H174's seam): an agent-activity component bound to the `activity` vocabulary, made by TimmyRive.component
      // as the Inspect view makes its own (no .riv on this container: the words stand, the binding events are recorded all the
      // same). Its REAL feed is this page's turn: each SSE event of POST /api/chat/turn, and Stop — never only the page's drawing
      await page.waitForFunction(() => typeof (window as unknown as { TimmyRive?: unknown }).TimmyRive !== 'undefined', null, { timeout: 10_000 });
      await page.evaluate(() => {
        const host = document.createElement('div');
        host.id = 'activity-test-host';
        host.style.cssText = 'position:fixed;left:-9999px;top:0';
        document.body.append(host);
        (window as unknown as { TimmyRive: { component(o: Record<string, unknown>): unknown } }).TimmyRive.component({ host, component: 'activity-test', asset: '/assets/rive/activity/activity.riv', artboard: 'Activity', stateMachine: 'Activity', role: 'img', label: 'Agent activity (test)', binds: ['activity'], word: 'idle' });
      });
      type Fed = Array<[string, string]>;
      const fedEvents = (): Promise<Fed> => page.evaluate(() => {
        const R = (window as unknown as { TimmyRive: { inspect(): Array<{ component: string; events: Array<{ input: string; value: unknown; source: string }> }> } }).TimmyRive;
        const x = R.inspect().find((c) => c.component === 'activity-test');
        return (x ? x.events : []).filter((e) => e.input === 'activity' && /^POST \/api\/chat\/(turn|stop)/.test(e.source)).map((e) => [String(e.value), e.source] as [string, string]);
      });
      expect(await fedEvents()).toEqual([]);
      await page.fill('#cx-input', 'Sketch the first screen.');
      await page.focus('#cx-input');
      expect(await page.isDisabled('#cx-send')).toBe(false);
      await page.keyboard.press('Enter');
      // the turn streams as this page's own (YOU, then TIMMY with its indicator), and — its receipt sealed and read back —
      // folds into the project's saved conversation as its newest turn, drawn once. The page's own copy may be gone by the
      // time this looks, so the end state is the chain's: one more TIMMY turn with the FAKE's answer and a receipt id
      await page.waitForFunction(() => document.querySelectorAll('#cx-turns .cx-turn.is-timmy').length >= 5 && document.querySelectorAll('#cx-own .cx-turn').length === 0, null, { timeout: 60_000 });
      expect(await page.inputValue('#cx-input')).toBe('');
      const last = await page.$eval('#cx-turns .cx-turn.is-timmy:last-of-type', (e) => ({ text: (e.querySelector('.cx-text')?.textContent ?? '').replace(/\s+/g, ' ').trim(), line: (e.querySelector('.cx-ev-row')?.textContent ?? '').replace(/\s+/g, ' ').trim() }));
      expect(last.text).toBe('FAKE streamed answer from the test\'s stand-in.');
      // the evidence line is the terminal's: model · where · seconds · receipt <8>, the receipt's short id by the terminal's
      // rule (src/workbench/hub.ts receiptShort: the FIRST 8 hex after sha256_); the page's own copy folded into this turn
      // because its own id (the same rule) matched — "receipt <8>" names the same receipt on the page and in the terminal
      expect(last.line).toMatch(/^▸ fake-qwen3:8b · this computer · \d+(\.\d)? s · receipt [0-9a-f]{8}/);
      // (the fold above is the pin of that rule: the page drops its own copy only when its id, by receiptShort, equals the
      // chain's ReceiptFacts.id — hash.slice(7, 15) on the server; the last 8 never matched, and the turn was drawn twice)
      const chainIds = await page.$$eval('#cx-turns .cx-turn.is-timmy .cx-ev-row', (els) => els.map((e) => /receipt ([0-9a-f]{8})/.exec(e.textContent ?? '')?.[1] ?? ''));
      expect(chainIds.at(-1)).toMatch(/^[0-9a-f]{8}$/);
      expect(ollama.chats().at(-1)?.messages?.at(-1)).toMatchObject({ role: 'user', content: 'Sketch the first screen.' });
      // the activity component was fed the turn's OWN events (the source names the request and the SSE event), in order: route
      // → working, turn → working, done (answered) → idle; a delta is fed only when it changes the word (after `awaiting`, an
      // answer resuming), so the streamed answer's deltas — the same word as the turn's — are not repeated into the component's
      // event list; nothing "derived from the page's drawing" is among them, and every value is a word of the vocabulary
      const fed = await fedEvents();
      expect(fed[0]).toEqual(['working', 'POST /api/chat/turn · SSE route']);
      expect(fed[1]).toEqual(['working', 'POST /api/chat/turn · SSE turn']);
      expect(fed.filter((e) => e[1] === 'POST /api/chat/turn · SSE delta')).toHaveLength(0);
      expect(fed.at(-1)).toEqual(['idle', 'POST /api/chat/turn · SSE done (answered)']);
      expect(fed).toHaveLength(3);
      expect(fed.every((e) => ['idle', 'working', 'awaiting', 'stopping', 'stopped', 'failed'].includes(e[0]))).toBe(true);
      expect(fed.some((e) => /derived/.test(e[1]))).toBe(false);
      // (and the component's label beside it says the word: the HTML carrier of the state, canvas or no canvas)
      expect(await text(page, '#activity-test-host [data-rive-status="activity-test"]')).toBe('idle');
      // the drawing of H169's `done` facts: `cost` is the REPL's sentence (a string), the numbers beside it (costUsd,
      // costMeasured) — the Spend line of this page's own turn shows the sentence (H169's finding: the page read t.cost.words
      // of a string and showed nothing). Checked by calling the page's own ownTurn on a `done` of that shape
      const spend = await page.evaluate(() => {
        const W = window as unknown as { costOfDone(d: unknown): unknown; ownTurn(t: unknown, i: number): DocumentFragment };
        // (openActivity is a top-level const of chat-shell.js: a global lexical binding, reached by its name, not a window property)
        // @ts-expect-error -- declared by the page's classic script
        const opened: Set<string> = openActivity;
        const cost = W.costOfDone({ status: 'answered', cost: '$0.0012 (as OpenRouter reported)', costUsd: 0.0012, costMeasured: true, steps: 1, receipt: `sha256_${'ab'.repeat(32)}` });
        opened.add('own:7');
        const frag = W.ownTurn({ id: 't1', you: 'q', answer: 'a', model: 'fake-qwen3:8b', state: 'answered', at: new Date().toISOString(), started: Date.now() - 1200, ended: Date.now(), where: 'this computer', tools: [], needs: null, receipt: `sha256_${'ab'.repeat(32)}`, steps: 1, cost }, 7);
        opened.delete('own:7');
        const dds = [...frag.querySelectorAll('.cx-facts dt')].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent]);
        return { cost, spend: dds.find((d) => d[0] === 'Spend')?.[1] ?? null, none: W.costOfDone({ status: 'answered' }), local: W.costOfDone({ cost: 'no charge: Ollama on this computer, local weights', costUsd: 0, costMeasured: true }) };
      });
      expect(spend.cost).toEqual({ words: '$0.0012 (as OpenRouter reported)', usd: 0.0012, measured: true });
      expect(spend.spend).toBe('$0.0012 (as OpenRouter reported)');
      expect(spend.none).toBeNull();
      expect(spend.local).toEqual({ words: 'no charge: Ollama on this computer, local weights', usd: 0, measured: true });
      // Stop: a second turn the FAKE never answers; the composer's Send reads Stop while it runs; pressed, the component is
      // fed `stopping` (POST /api/chat/stop by the turn's id) and then `stopped` (this page stopped reading); the turn is
      // this page's stopped turn, then the chain's (its receipt says cancelled)
      // (the FAKE's requests so far: one /api/chat for the answered turn — a second would have taken the hanging script and
      // left the turn below a 500 "no answer was scripted", which ends at once and answers Stop with 409: said here, not later)
      const chatsBefore = ollama.chats().length;
      expect(chatsBefore, `the FAKE's /api/chat requests before the slow turn (${ollama.requests.filter((r) => r.path === '/api/chat').length} chats; all requests: ${ollama.requests.map((r) => r.path).join(' ')})`).toBe(1);
      await page.fill('#cx-input', 'And then?');
      await page.focus('#cx-input');
      await page.keyboard.press('Enter');
      await page.waitForSelector('#cx-own li.cx-turn.is-timmy.is-streaming[data-turn-id]', { timeout: 30_000 });
      await page.waitForSelector('#cx-send.is-stop', { timeout: 10_000 });
      expect(await page.getAttribute('#cx-send', 'aria-label')).toBe('Stop');
      // Stop is pressed while the turn is AT the model: the FAKE holds the request (it never answers), so the turn cannot end
      // on its own before the stop lands (the freeze on 92811157 saw a 409 under load: the turn was no longer running)
      for (let i = 0; i < 60 && ollama.chats().length < chatsBefore + 1; i++) await page.waitForTimeout(250);
      expect(ollama.chats().length, 'the slow turn\'s request reached the FAKE (which holds it)').toBe(chatsBefore + 1);
      const stopAnswer = page.waitForResponse((r) => r.url().includes('/api/chat/stop'), { timeout: 15_000 });
      stopAnswer.catch(() => undefined);
      await page.click('#cx-send.is-stop', { timeout: 10_000 });
      // the companion took the stop (200, its words), by the turn's id
      const stopRes = await stopAnswer;
      const stopBody = await stopRes.json().catch(() => null) as { ok?: boolean; words?: string; error?: string } | null;
      expect({ status: stopRes.status(), body: stopBody, holds: (() => { try { return readdirSync(join(box, 'tray', '.timmy', 'chat-turns')); } catch { return 'no chat-turns folder'; } })() }).toMatchObject({ status: 200, body: { ok: true, words: expect.stringMatching(/^Stop asked of the turn being answered in the companion/) } });
      // (the turn ends ON THIS PAGE when its own li stops streaming — its `done`, or its read dropped; the project's conversation
      // may hold the sealed turn a moment before that `done` arrives, the companion sealing it first, so the chain's stopped li
      // alone is not this page's end)
      await page.waitForFunction(() => !document.querySelector('#cx-own li.cx-turn.is-streaming') && (document.querySelector('#cx-own li.cx-turn.is-timmy.is-stopped') !== null || [...document.querySelectorAll('#cx-turns li.cx-turn.is-timmy')].some((li) => li.classList.contains('is-stopped'))), null, { timeout: 30_000 });
      // the turn ENDED where it ran, not only on this page: the companion's hold is released (the frame's activity names no
      // chat turn, so the composer reads Send again, not Stop), and the project's conversation holds the stopped turn with
      // its receipt — the FAKE never answered, so nothing was written before the stop. (Found by this pin: the operator's page
      // sent { id } to a Stop route that took { turn } only, was told 400, and its turn ran on while the page said stopped.)
      const composerState = () => page.evaluate(() => ({
        send: document.getElementById('cx-send')?.className, label: document.getElementById('cx-send')?.getAttribute('aria-label'),
        // (cx and workspace are top-level consts of the page's classic scripts: global lexical bindings, reached by name)
        // @ts-expect-error -- declared by the page's classic scripts
        running: Boolean(cx.running), chatTurn: (workspace as { frame: { activity?: { chatTurn?: unknown } } | null }).frame?.activity?.chatTurn ?? null,
      }));
      // (R11 round 5, H172's observation: the composer read Stop a tick after the turn ended — the frame, read every 3 s, still
      // named this page's own turn; and the own li read stopped at the SSE `done` while the composer waited for the stream's
      // close. Now `done` IS the end: the composer, the controls and the status row are drawn in that tick, and the frame's word
      // for this page's own turn is never "another surface's": the FIRST read after this page's turn ended is Send)
      let composer = await composerState();
      expect(composer).toMatchObject({ send: expect.not.stringContaining('is-stop'), label: 'Send message', running: false });
      // (the frame itself is read again as the turn ends — the hold is gone there within its next answer)
      for (let i = 0; i < 40 && composer.chatTurn !== null; i++) { await page.waitForTimeout(500); composer = await composerState(); }
      expect(composer).toMatchObject({ send: expect.not.stringContaining('is-stop'), label: 'Send message', running: false, chatTurn: null });
      await page.waitForFunction(() => document.querySelectorAll('#cx-own .cx-turn').length === 0 && [...document.querySelectorAll('#cx-turns li.cx-turn.is-timmy')].slice(-1).every((li) => li.classList.contains('is-stopped') && /receipt [0-9a-f]{8}/.test(li.querySelector('.cx-ev-row')?.textContent ?? '')), null, { timeout: 30_000 });
      const stoppedLast = await page.$eval('#cx-turns li.cx-turn.is-timmy:last-of-type', (li) => ({ text: (li.querySelector('.cx-text')?.textContent ?? '').replace(/\s+/g, ' ').trim(), meta: (li.querySelector('.cx-meta')?.textContent ?? '').replace(/\s+/g, ' ').trim() }));
      expect(stoppedLast.text).toBe('Nothing was written before the stop.');
      expect(stoppedLast.meta).toMatch(/^■ stopped by you/);
      const afterStop = (await fedEvents()).slice(fed.length);
      expect(afterStop[0]).toEqual(['working', 'POST /api/chat/turn · SSE route']);
      const stopAt = afterStop.findIndex((e) => e[0] === 'stopping');
      expect(stopAt).toBeGreaterThan(0);
      expect(afterStop[stopAt][1]).toMatch(/^POST \/api\/chat\/stop \{ id: [A-Za-z0-9_-]+ \} \(this page's Stop\)$/);
      expect(afterStop.slice(stopAt + 1).map((e) => e[0])).toEqual(['stopped']);
      expect(await text(page, '#activity-test-host [data-rive-status="activity-test"]')).toBe('stopped');
      // (H172's GATE 38 observation, R11 round 6: on a project WITH a saved conversation, New conversation asks the companion for a
      // conversation of its own — POST /api/chat/new, H169's route (the REPL's /new) — and the chat's read then answers an EMPTY
      // newest conversation: the welcome is drawn with its three starters, the primary one the native button, the composer
      // focused, and the saved conversation is no longer the center's; a companion without the route answers 404 and the page
      // says plainly what its New conversation is then — the fallback path, kept as the other half of this pin)
      const newConv = page.waitForResponse((r) => /\/api\/chat\/new$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST', { timeout: 15_000 });
      await page.click('#rail-new-conv');
      expect(await page.$$eval('#cx-own .cx-turn', (els) => els.length)).toBe(0);
      const newStatus = (await newConv).status();
      expect([200, 404], `POST /api/chat/new answered ${newStatus}: 200 when the companion has the route, 404 without it`).toContain(newStatus);
      if (newStatus === 200) {
        await page.waitForFunction(() => document.body.dataset.chatState === 'empty', null, { timeout: 20_000 });
        expect(await page.$$eval('#cx-empty [data-cx-start]', (els) => els.map((e) => [e.getAttribute('data-cx-start'), e.querySelector('.cx-way-title')?.textContent?.trim()]))).toEqual([['plan', 'Plan a project'], ['image', 'Inspect an image'], ['workflow', 'Build a workflow']]);
        await page.waitForFunction(() => ['drawn', 'words'].includes(document.querySelector('#cx-empty .cx-way-twin')?.getAttribute('data-rive') ?? ''), null, { timeout: 15_000 });
        expect(await page.$$eval('#cx-turns > .cx-turn', (els) => els.length)).toBe(0);
        expect((await text(page, '#cx-note')).startsWith('New conversation on this page:'), 'the "no route yet" words never show when the route answered').toBe(false);
        expect(await page.evaluate(() => document.activeElement?.id)).toBe('cx-input');
        expect(await text(page, '#cx-note')).toBe('New conversation: the project’s next turn starts a conversation of its own (the saved one is kept in .sessions).');
        console.warn('[companion-chat-shell-browser] New conversation: the companion has POST /api/chat/new — the welcome drawn on the empty conversation of its own');
        // (the cases after this one read the SAVED conversation as the project's newest: the empty conversation this step started —
        // H169's route writes it as an empty newest .sessions file — is removed again, the fixture's own file; the page's next read
        // shows the saved turns again)
        const sessions = join(box, 'tray', '.sessions');
        for (const f of readdirSync(sessions)) { if (f.endsWith('.jsonl') && statSync(join(sessions, f)).size === 0) rmSync(join(sessions, f)); }
        await page.waitForFunction(() => document.querySelectorAll('#cx-turns .cx-turn.is-timmy').length > 0 && document.body.dataset.chatState !== 'empty', null, { timeout: 15_000 });
      } else {
        await page.waitForFunction(() => (document.getElementById('cx-note')?.textContent ?? '').startsWith('New conversation on this page:'), null, { timeout: 10_000 });
        expect(await text(page, '#cx-note')).toMatch(/^New conversation on this page: its own turns are put away and the composer is clear; the project’s saved conversation \(\d+ messages\) stays and the next turn continues it — a conversation of its own is the REPL’s \/new today \(this companion has no POST \/api\/chat\/new yet\)\.$/);
        expect(await page.$$eval('#cx-turns > .cx-turn', (els) => els.length)).toBeGreaterThan(0);
        expect(await page.evaluate(() => document.body.dataset.chatState)).not.toBe('empty');
        console.warn('[companion-chat-shell-browser] New conversation: this companion has no POST /api/chat/new — the page said so (the fallback path)');
      }
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
      // (the turn sent above may still be counted by the frame for a moment: the row settles within its next read)
      await page.waitForFunction(() => document.querySelector('#cx-status .is-logs')?.textContent?.trim() === 'Logs stay on this computer', null, { timeout: 20_000 });
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
      expect(controls.map((c) => c.replace(/^[^A-Za-z]+/, '').replace(/(?:\d+|—|free-only|this computer)$/, '').trim())).toEqual(['Plan / Run', 'Permissions', 'Budget', 'Logs', 'Keys', 'Cloudflare optional']); // (round 7: Keys on the row)
      expect(await page.$('#cx-controls [data-cx="stop"], #cx-controls [data-cx="stop-other"]')).toBeNull();
      await page.click('#cx-controls [data-cx-ctl="approvals"]');
      expect(await page.isVisible('#cx-drawer')).toBe(true);
      await page.keyboard.press('Escape');
      expect(await page.isVisible('#cx-drawer')).toBe(false);
      expect(await page.evaluate(() => document.activeElement?.getAttribute('data-cx-ctl'))).toBe('approvals');
      // (R11 round 7, SHELL CONTRACT v1 §4: on a desk the Models are the page's context column, always there — M puts the keyboard
      // in its search; on a phone M opens the context sheet)
      await page.keyboard.press('m');
      expect(await page.isVisible('#cx-models')).toBe(true);
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('cm-search');
      await page.keyboard.press('Escape');
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
      // (B11, the lead's 15:29 rule: green ONLY on an observed state — a verified receipt's mark, the live socket word, a route
      // the companion checked ready, a verified tool, a live provider state; nothing else on the page wears #28FE14)
      const green = await page.evaluate(() => {
        const out: string[] = [];
        const ok = (el: Element) => Boolean(el.closest('.is-verified, .is-live, [data-state="ready"], .cm-word.is-verified, .cm-word.is-live, .cx-d-state.is-live, .cx-setup-word.is-live, .activity-list, #ws-activity'));
        for (const el of document.querySelectorAll('#ws-chat *, #shell-rail *, #shell-top *')) {
          if (!el.getClientRects().length) continue;
          const cs = getComputedStyle(el);
          if ([cs.color, cs.backgroundColor, cs.borderColor].some((c) => /^rgb\(40, 254, 20\)$/.test(c)) && !ok(el)) out.push(`${el.tagName.toLowerCase()}.${el.className} ${(el.textContent || '').trim().slice(0, 30)}`);
        }
        return out;
      });
      expect(green, 'green only on an observed live / passed / sealed state').toEqual([]);
      const face = await page.evaluate(() => document.body.innerText);
      expect(face).not.toContain(token);
      // (R11 round 7: every destination is a page of the one shell with the rail present — D3; Home is not in the rail (its
      // content lives in Chat's first use) and keeps its key 1; the rail stays, marked for the page shown; key 2 brings Chat back)
      // (the rail's foot button is the other way in — the key `?` opened it above)
      await page.click('#shell-help');
      await page.waitForFunction(() => (document.getElementById('shell-help-dialog') as HTMLDialogElement | null)?.open === true, null, { timeout: 5_000 });
      await page.keyboard.type('home');
      await page.waitForFunction(() => (document.querySelector('#shell-help-dialog [data-help-run]')?.textContent ?? '').includes('Open Home'), null, { timeout: 5_000 });
      await page.click('#shell-help-dialog [data-help-run]');
      await page.waitForFunction(() => document.body.dataset.dest === 'home' && !(document.getElementById('ws-home') as HTMLElement).hidden, null, { timeout: 10_000 }).catch(async () => { throw new Error(`Help & find did not open Home: ${JSON.stringify(await page.evaluate(() => ({ page: document.body.dataset.page, dest: document.body.dataset.dest, hidden: (document.getElementById('ws-home') as HTMLElement).hidden, active: document.activeElement?.tagName })))}`); });
      expect(await page.isVisible('#shell-rail')).toBe(true);
      expect(await page.$$eval('#rail-menu .rail-item[aria-current="page"]', (els) => els.length)).toBe(0);
      expect(await page.evaluate(() => document.body.dataset.page)).toBe('home');
      await page.keyboard.press('2');
      await page.waitForFunction(() => document.body.dataset.dest === 'chat', null, { timeout: 10_000 });
      expect(await page.isVisible('#shell-rail')).toBe(true);
      // (R11 round 7: `?` is the shell's Help & find — one overlay, the destinations found by name, Enter opens the first; Escape
      // closes it with the focus back; the Chat's old `/` finder is gone — SHELL CONTRACT v1 §5)
      await page.keyboard.press('?');
      await page.waitForFunction(() => (document.getElementById('shell-help-dialog') as HTMLDialogElement | null)?.open === true, null, { timeout: 5_000 });
      await page.keyboard.type('runs');
      await page.waitForFunction(() => (document.querySelector('#shell-help-dialog [data-help-run]')?.textContent ?? '').includes('Open Runs & receipts'), null, { timeout: 5_000 });
      await page.click('#shell-help-dialog [data-help-run]');
      await page.waitForFunction(() => !(document.getElementById('shell-help-dialog') as HTMLDialogElement).open, null, { timeout: 5_000 });
      await page.waitForFunction(() => document.body.dataset.dest === 'logs', null, { timeout: 10_000 }).catch(async () => { throw new Error(`Help & find did not open Runs & receipts: ${JSON.stringify(await page.evaluate(() => ({ page: document.body.dataset.page, dest: document.body.dataset.dest, screen: document.body.dataset.screen })))}`); });
      await page.keyboard.press('2');
      await page.waitForFunction(() => document.body.dataset.dest === 'chat', null, { timeout: 10_000 });
      expect(await page.$$eval('#rail-menu .rail-item', (els) => els.length)).toBe(10); // (D3's ten; Home, Fleet & Clef and Settings by key or Help & find)
      // the Chat's own Help drawer (the keys by task) is the row's Keys control (in More under 1180 px); Escape closes it
      await page.click('#cx-controls [data-cx-ctl="keys"]');
      expect(await text(page, '#cx-drawer-title')).toBe('Help');
      expect(await page.$$eval('#cx-drawer h4', (els) => els.map((e) => (e.textContent ?? '').trim()))).toEqual(['Chat', 'Models', 'Moving around', 'Runs']);
      await page.keyboard.press('Escape');
      expect(await page.isVisible('#cx-drawer')).toBe(false);
      expect(errors).toEqual([]);
    } catch (e) {
      // (said on stderr too: a close that cannot finish would otherwise hide this behind the case's own timeout)
      console.error('[companion-chat-shell-browser] the first case failed:', e instanceof Error ? e.message.split('\n').slice(0, 12).join('\n') : String(e));
      throw e;
    } finally {
      await context.close();
    }
  }, 180_000);

  it('R11 round 6: NEEDS-YOU answered through the native ActionButton (timmy-ui.riv) when it draws, its HTML twin when it does not — the one answer goes POST /api/chat/answer through the existing gate, the tool runs, the file is written; the console band reads the turn', async () => {
    const { context, page, errors } = await openPage(browser, { origin }, { width: 1440, height: 900 });
    page.setDefaultTimeout(30_000);
    const answers: string[] = [];
    page.on('request', (r) => { if (/\/api\/chat\/answer$/.test(new URL(r.url()).pathname)) answers.push(r.postData() ?? ''); });
    try {
      await page.goto(`${origin}/#t=${token}`);
      await landWorkspace(page);
      await page.waitForSelector('#cx-turns .cx-turn.is-timmy', { timeout: 30_000 });
      await page.waitForFunction(() => document.getElementById('cx-dot')?.dataset.state === 'ready', null, { timeout: 30_000 });
      // the FAKE's queue: the first case used its two scripted answers; this case's tool call is next (said here if the order moved)
      expect(ollama.chats().length, 'the FAKE\'s /api/chat requests before this case (its tool-call script is the third)').toBe(2);
      // the console band: present above the route line with the state word idle before the turn; the band's toggle and the face
      // never hold the focus the composer has
      expect(await page.isVisible('#cx-console')).toBe(true);
      expect(await text(page, '#cx-console [data-rive-status]')).toBe('idle');
      await page.focus('#cx-input');
      await page.keyboard.press('Shift+Tab');
      expect(await page.evaluate(() => document.activeElement?.id), 'the stop before the textarea is the route line\'s button, as before the band').toBe('cx-change');
      const rivBefore = await page.evaluate(() => { performance.setResourceTimingBufferSize(4000); return performance.getEntriesByType('resource').filter((e) => /timmy-ui\.riv$/.test(new URL(e.name).pathname)).length; });
      await page.focus('#cx-input');
      await page.keyboard.type('write notes');
      await page.keyboard.press('Enter');
      // the ask: the box with its three options (the server's: once · session · deny), each a native button and its HTML twin
      await page.waitForSelector('#cx-own .cx-needs', { timeout: 30_000 });
      expect(await page.$$eval('#cx-own .cx-needs [data-cx-answer]', (els) => els.map((e) => e.getAttribute('data-cx-answer')))).toEqual(['once', 'session', 'deny']);
      expect(await text(page, '#cx-console [data-rive-status]')).toBe('awaiting approval');
      // the component settles: drawn (the native face the control, the twin hidden) or words (the twin the control, no empty host);
      // never both controls at once, and never an answer sent on its own
      await page.waitForFunction(() => [...document.querySelectorAll('#cx-own .cx-needs .cx-twin')].every((t) => t.getAttribute('data-rive') === 'drawn' || t.getAttribute('data-rive') === 'words' || t.getAttribute('data-rive') === 'none'), null, { timeout: 15_000 });
      const twins = await page.$$eval('#cx-own .cx-needs .cx-twin', (els) => els.map((t) => ({ rive: t.getAttribute('data-rive'), label: t.querySelector('[data-cx-answer]')?.textContent?.trim(), twinHidden: (t.querySelector('[data-cx-answer]') as HTMLElement | null)?.hidden ?? null, face: t.querySelector('.cx-rive-host button.tr-face') !== null, faceLabel: t.querySelector('.cx-rive-host button.tr-face')?.getAttribute('aria-label') ?? null, hosts: t.querySelectorAll('.cx-rive-host').length })));
      expect(twins.map((t) => t.label)).toEqual(['once', 'session', 'deny']);
      const drawn = twins[0].rive === 'drawn';
      for (const t of twins) {
        expect(t.rive).toBe(twins[0].rive);
        if (drawn) expect(t).toMatchObject({ twinHidden: true, face: true, faceLabel: t.label, hosts: 1 });
        else expect(t).toMatchObject({ twinHidden: false, face: false, hosts: 0 });
      }
      expect(answers).toEqual([]);
      // a redraw of the running turn (every second) keeps the same box: the native button is not mounted again
      const boxId = await page.$eval('#cx-own .cx-needs', (e) => { (e as HTMLElement).dataset.pin = 'same-box'; return e.getAttribute('data-needs'); });
      await page.waitForTimeout(1_500);
      expect(await page.$eval('#cx-own .cx-needs', (e) => (e as HTMLElement).dataset.pin)).toBe('same-box');
      // the answer "once": the native face (a real click on it) when drawn, else the twin; ONE POST /api/chat/answer { id, choice },
      // answered 200 by the existing route (the FAKE answers Written. right after, so the box's "answered" line is not waited on)
      const answered = page.waitForResponse((r) => /\/api\/chat\/answer$/.test(new URL(r.url()).pathname), { timeout: 15_000 });
      if (drawn) await page.click('#cx-own .cx-needs .cx-twin:nth-child(1) .cx-rive-host button.tr-face');
      else await page.click('#cx-own .cx-needs [data-cx-answer="once"]');
      const res = await answered;
      // (the status only: the page reads the answer's body only when it is not ok, and Playwright's response.json() on a body the
      // page never reads waits for the context's close — round 5's lesson)
      expect(res.status()).toBe(200);
      expect(answers).toHaveLength(1);
      expect(JSON.parse(answers[0])).toEqual({ id: boxId, choice: 'once' });
      // the real action behind the gate: the tool ran where the turn runs (the project's folder) — its line reads ran while the
      // FAKE's answer still streams (six chunks, 400 ms apart), the answered ask's box under it
      await page.waitForFunction(() => /· ran\b/.test((document.querySelector('#cx-own .cx-act-line[data-tool="write_project_file"]')?.textContent ?? '').replace(/\s+/g, ' ').trim()), null, { timeout: 30_000 });
      expect(readFileSync(join(box, 'tray', 'notes-r6.md'), 'utf8')).toBe('from the FAKE model, allowed once on the page\n');
      // (R11 round 7: the tool as a collapsed card — the dot, the tool, its state, the verb; Details hold its words)
      expect(await page.$$eval('#cx-own .cx-act-line[data-tool="write_project_file"]', (els) => els.map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()))).toEqual(['● write_project_file · ran · Wrote a project file']);
      expect(await page.$eval('#cx-own .cx-tcard[data-tool="write_project_file"]', (d) => ({ open: (d as HTMLDetailsElement).open, state: d.getAttribute('data-tool-state'), body: (d.querySelector('.cx-tcard-body')?.textContent ?? '').trim() }))).toEqual({ open: false, state: 'ran', body: 'write_project_file ran' });
      // (the installed capture of GATE 36, H172: the tool line was laid in the turn grid's MARK column, 30 px wide, and painted
      // over the ask's box beside it) the tool line is ONE row in the turn's text column — the glyph, the name, the state — its box
      // not overlapping the ask's box, which sits under it with its "answered: once" note; both start where the turn's text starts
      const rows = await page.evaluate(() => {
        const r = (el: Element | null) => { if (!el) return null; const b = el.getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right), top: Math.round(b.top), bottom: Math.round(b.bottom), height: Math.round(b.height) }; };
        const li = document.querySelector('#cx-own li.cx-turn.is-timmy')!;
        const row = li.querySelector('.cx-act-line[data-tool="write_project_file"]');
        // (R11 round 7: the line is the summary row of a collapsed card; the card's box is what sits in the text column)
        const line = row?.closest('.cx-tcard') ?? row;
        return { who: r(li.querySelector('.cx-who')), line: r(line), row: r(row), dot: r(row?.querySelector('.cx-act-dot') ?? null), needs: r(li.querySelector('.cx-needs')), note: r(li.querySelector('.cx-needs .cx-act-sub')), lineHeight: row ? parseFloat(getComputedStyle(row).lineHeight) : 0, answered: li.querySelector('.cx-needs .cx-act-sub')?.textContent?.trim() };
      });
      expect(rows.line && rows.row && rows.needs && rows.who && rows.dot).toBeTruthy();
      expect(rows.row!.height, 'one row').toBeLessThanOrEqual(Math.ceil(rows.lineHeight * 1.5));
      expect(rows.line!.height, 'the closed card is that one row and its border').toBeLessThanOrEqual(Math.ceil(rows.lineHeight * 1.5) + 2);
      expect(rows.line!.left, 'in the text column, where TIMMY starts').toBe(rows.who!.left);
      expect(rows.needs!.left).toBe(rows.who!.left);
      expect(rows.line!.bottom, 'the ask\'s box under the tool line, not beside or over it').toBeLessThanOrEqual(rows.needs!.top);
      expect(rows.dot!.top, 'the glyph on the line\'s row').toBeGreaterThanOrEqual(rows.line!.top);
      expect(rows.dot!.bottom).toBeLessThanOrEqual(rows.line!.bottom + 1);
      expect(rows.answered).toBe('└ answered: once');
      // the model's answer follows, the turn ends on this page and folds into the project's conversation by its receipt; the
      // console reads idle again
      await page.waitForFunction(() => document.querySelector('#cx-own li.cx-turn.is-timmy.is-answered') !== null || [...document.querySelectorAll('#cx-turns li.cx-turn.is-timmy .cx-text')].some((e) => /Written\. The note is there\./.test(e.textContent ?? '')), null, { timeout: 30_000 });
      await page.waitForFunction(() => [...document.querySelectorAll('#cx-turns li.cx-turn.is-timmy .cx-text')].some((e) => /Written\. The note is there\./.test(e.textContent ?? '')), null, { timeout: 30_000 });
      expect(await text(page, '#cx-console [data-rive-status]')).toBe('idle');
      expect(await page.evaluate(() => document.activeElement?.closest('#cx-console') !== null)).toBe(false);
      expect(answers, 'one answer, and no second one from the twin or the face').toHaveLength(1);
      // the operator's bar (one runtime instance per MOUNTED component; GATE 36's finding): after the answered ask and the turn's
      // end no ActionButton handle remains (this conversation has no welcome starter) — the three of the ask were unmounted when
      // it was answered, and an answered ask never mounted a second set — and the .riv was fetched exactly once per drawn button
      const after = await page.evaluate(() => ({
        census: (window as unknown as { TimmyRive: { inspect(): Array<{ component: string; state: string }> } }).TimmyRive.inspect().map((x) => `${x.component}:${x.state}`),
        rivFetches: performance.getEntriesByType('resource').filter((e) => /timmy-ui\.riv$/.test(new URL(e.name).pathname)).length,
      }));
      expect(after.census.filter((c) => c.startsWith('action:')), `no ActionButton outlives its ask (census: ${after.census.join(', ')})`).toEqual([]);
      expect(after.census.filter((c) => c.startsWith('console:'))).toEqual(['console:drawn']);
      expect(after.rivFetches - rivBefore, 'the .riv fetched once per drawn button of the ask (three), never for an answered ask').toBe(drawn ? 3 : 0);
      // the operator's bar of 07:06 (rapid backend events): a dense burst through THIS PAGE's feed (riveFeed, the one the turn's
      // SSE goes through) leaves the band's word at the LAST event's state, no lag, no intermediate word; a run of deltas is one
      // event (the feed collapses a repeated word), every other event is fed as it comes
      const burst = await page.evaluate(() => {
        // @ts-expect-error -- riveFeed is a function of the page's classic script chat-shell.js
        const feed = riveFeed as (e: string, d: unknown, s: string) => void;
        const R = (window as unknown as { TimmyRive: { inspect(): Array<{ component: string; events: Array<{ source: string; value: unknown }> }> } }).TimmyRive;
        for (let i = 0; i < 300; i++) feed('delta', { text: 'x' }, 'burst');
        feed('tool', { name: 'list_project_files', status: 'asked' }, 'burst');
        feed('needs-you', { id: 'burst-ask' }, 'burst');
        for (let i = 0; i < 300; i++) feed('delta', { text: 'y' }, 'burst');
        feed('done', { status: 'cancelled' }, 'burst');
        const h = R.inspect().find((x) => x.component === 'console');
        return { word: document.querySelector('#cx-console [data-rive-status]')?.textContent?.trim(), burstEvents: h ? h.events.filter((e) => e.source === 'burst').map((e) => e.value) : null };
      });
      expect(burst.word).toBe('stopped');
      expect(burst.burstEvents).toEqual(['working', 'working', 'awaiting', 'working', 'stopped']);
      // a duplicate ask of one this page answered, arriving again: nothing changes, nothing is sent (the id was answered once)
      // @ts-expect-error -- answerNeedsYou is a function of the page's classic script chat-shell.js
      await page.evaluate((id) => answerNeedsYou(id, 'once'), boxId);
      await page.waitForTimeout(300);
      expect(answers, 'the same ask answered again sends nothing').toHaveLength(1);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 180_000);

  it('R11 round 6 (H168\'s R65): at 390 × 844 with the band OPENED, an ask that opens folds the band by itself and is scrolled into view whole — its words and all three options on screen; answered, the band comes back as it was', async () => {
    const { context, page, errors } = await openPage(browser, { origin }, { width: 390, height: 844 });
    page.setDefaultTimeout(30_000);
    try {
      await page.goto(`${origin}/#t=${token}`);
      await landWorkspace(page);
      await page.waitForSelector('#cx-turns .cx-turn.is-timmy', { timeout: 30_000 });
      await page.waitForFunction(() => document.getElementById('cx-dot')?.dataset.state === 'ready', null, { timeout: 30_000 });
      expect(ollama.chats().length, 'the FAKE\'s queue: this case\'s tool-call script is the fifth').toBe(4);
      // (the companion holds no turn of the case before: the composer reads Send, not another surface's turn)
      await page.waitForFunction(() => document.getElementById('cx-send')?.getAttribute('aria-label') === 'Send message', null, { timeout: 20_000 });
      // the band starts folded on a phone; the viewer opens it (the choice kept)
      expect(await page.$eval('#cx-console', (b) => b.classList.contains('is-folded'))).toBe(true);
      await page.click('#cx-console-toggle');
      expect(await page.getAttribute('#cx-console-toggle', 'aria-expanded')).toBe('true');
      await page.focus('#cx-input');
      await page.keyboard.type('write notes on the phone');
      await page.keyboard.press('Enter');
      await page.waitForSelector('#cx-own .cx-needs .cx-needs-opts', { timeout: 30_000 });
      await page.waitForFunction(() => [...document.querySelectorAll('#cx-own .cx-needs .cx-twin')].every((t) => ['drawn', 'words', 'none'].includes(t.getAttribute('data-rive') ?? '')), null, { timeout: 15_000 });
      await page.waitForTimeout(400); // (the scroll into view: the frame after the draw)
      const view = await page.evaluate(() => {
        const sb = document.getElementById('cx-scroll')!.getBoundingClientRect();
        const band = document.getElementById('cx-console')!;
        const box = document.querySelector('#cx-own .cx-needs')!;
        const r = (e: Element) => { const b = e.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), inside: b.top >= sb.top - 1 && b.bottom <= sb.bottom + 1 && b.top >= 0 && b.bottom <= window.innerHeight + 1 }; };
        const comp = document.getElementById('cx-composer')!;
        return { adopted: document.body.classList.contains('cx-on-scaffold'), scrollY: Math.round(scrollY), composer: { pos: getComputedStyle(comp).position, top: Math.round(comp.getBoundingClientRect().top), bottom: Math.round(comp.getBoundingClientRect().bottom) }, folded: band.classList.contains('is-folded'), auto: band.dataset.autoFolded ?? null, expanded: document.getElementById('cx-console-toggle')!.getAttribute('aria-expanded'), scroll: { top: Math.round(sb.top), bottom: Math.round(sb.bottom) }, box: r(box), words: r(box.querySelector('p:not(.cx-needs-k)')!), options: [...box.querySelectorAll('.cx-twin')].map((t) => ({ label: t.querySelector('[data-cx-answer]')?.textContent?.trim(), ...r(t) })), overflow: document.documentElement.scrollWidth <= window.innerWidth + 1 };
      });
      expect(view.folded, `the band folded itself for the ask: ${JSON.stringify(view)}`).toBe(true);
      expect(view.auto).toBe('1');
      expect(view.expanded).toBe('false');
      expect(view.box.inside, `the ask's box whole in the conversation's view: ${JSON.stringify(view)}`).toBe(true);
      expect(view.words.inside).toBe(true);
      expect(view.options.map((o) => o.label)).toEqual(['once', 'session', 'deny']);
      expect(view.options.every((o) => o.inside), `every option on screen: ${JSON.stringify(view.options)}`).toBe(true);
      expect(view.overflow).toBe(true);
      // deny: the control that shows (the native face when drawn, the twin otherwise); the tool is refused where the turn runs
      const denied = page.waitForResponse((r) => /\/api\/chat\/answer$/.test(new URL(r.url()).pathname), { timeout: 15_000 });
      const drawn = await page.$eval('#cx-own .cx-needs .cx-twin:nth-child(3)', (t) => t.getAttribute('data-rive') === 'drawn');
      if (drawn) await page.click('#cx-own .cx-needs .cx-twin:nth-child(3) .cx-rive-host button.tr-face');
      else await page.click('#cx-own .cx-needs [data-cx-answer="deny"]');
      expect((await denied).status()).toBe(200);
      await page.waitForFunction(() => [...document.querySelectorAll('#cx-turns li.cx-turn.is-timmy .cx-text, #cx-own li.cx-turn.is-timmy .cx-text')].some((e) => /Not written\./.test(e.textContent ?? '')), null, { timeout: 30_000 });
      await page.waitForFunction(() => !document.getElementById('cx-console')!.dataset.autoFolded, null, { timeout: 10_000 });
      // the ask is over: the band is back as the viewer left it (opened)
      expect(await page.getAttribute('#cx-console-toggle', 'aria-expanded')).toBe('true');
      expect(await page.isVisible('#cx-console .tr-face')).toBe(true);
      expect(existsSync(join(box, 'tray', 'notes-390.md'))).toBe(false);
      expect(errors).toEqual([]);
    } finally {
      // (an ask left open by a failed assertion would hold the project's turn for the cases after: denied on the way out)
      // @ts-expect-error -- answerNeedsYou is a function of the page's classic script chat-shell.js
      await page.evaluate(() => { const id = document.querySelector('#cx-own .cx-needs .cx-needs-opts')?.closest('.cx-needs')?.getAttribute('data-needs'); if (id) answerNeedsYou(id, 'deny'); }).catch(() => undefined);
      await page.waitForTimeout(500).catch(() => undefined);
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
      // R52 (as R11 round 4 places it): the chip's words are whole (wrapped in the panel's NEXT TURN if tight, never cut with …);
      // the chip sits in that block, and Send is on the composer's foot row beside Attach and Tools
      expect(await page.$eval('#cx-chip-words', (e) => getComputedStyle(e).whiteSpace !== 'nowrap' && e.scrollHeight <= e.clientHeight + 1)).toBe(true);
      expect(await page.evaluate(() => { const b = document.getElementById('cx-next-turn')!.getBoundingClientRect(); const c = document.getElementById('cx-chip')!.getBoundingClientRect(); return { inside: c.top >= b.top - 1 && c.bottom <= b.bottom + 1, box: [b.top, b.bottom], chip: [c.top, c.bottom], chipIn: document.getElementById('cx-chip')!.parentElement?.id }; })).toMatchObject({ inside: true });
      expect(await page.evaluate(() => { const a = document.querySelector('#cx-composer [data-cx-ctl="attachments"]')!.getBoundingClientRect(); const s = document.getElementById('cx-send')!.getBoundingClientRect(); return s.top < a.bottom && s.bottom > a.top; })).toBe(true);
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
      expect(await page.$eval('#cx-send', (b) => getComputedStyle(b).backgroundImage)).toContain('linear-gradient'); // (B11: the primary's material, the family gradient; never green)
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
          expect(await page.$eval('#cx-empty .cx-welcome-mark', (e) => e.getBoundingClientRect().top >= 0)).toBe(true);
          // (R11 round 7: at a desk the composer is in view; on the phone the shell's head and band take the first screen (627 px
          // of 844 — said to H175), so the composer is REACHABLE: scrolled to, it sits whole above the sticky dock, not under it)
          if (size.width > 720) expect(await page.$eval('#cx-composer', (f) => f.getBoundingClientRect().bottom <= window.innerHeight)).toBe(true);
          else {
            await page.$eval('#cx-composer', (f) => f.scrollIntoView({ block: 'center' }));
            expect(await page.evaluate(() => { const r = document.getElementById('cx-composer')!.getBoundingClientRect(); const d = document.querySelector('#ws-chat .page-dock')!.getBoundingClientRect(); return { inView: r.top >= 0 && r.bottom <= window.innerHeight, clearOfDock: r.bottom <= d.top + 1 }; })).toEqual({ inView: true, clearOfDock: true });
            await page.evaluate(() => window.scrollTo(0, 0));
          }
          // R11 round 4 (the preview's welcome): the mark, "What would you like to make?", one line, three starters in one row at
          // the desk and stacked on the phone, all above the composer; FAKE is named on the descriptor
          expect(await text(page, '#cx-descriptor')).toContain('FAKE model on this computer');
          // (R11 round 7, on the scaffold: the page head asks the question and says the line — once; the welcome is the mark,
          // "Start with" and the starters)
          expect(await text(page, '#ws-chat .page-head .page-title')).toBe('What would you like to make?');
          expect(await text(page, '#ws-chat .page-head .page-intro')).toBe('Your models, tools and ideas share one workspace.');
          expect(await text(page, '#cx-empty .cx-welcome-start')).toBe('Start with');
          expect(await page.$$eval('#cx-empty .cx-welcome-title, #cx-empty .cx-welcome-line', (els) => els.length)).toBe(0);
          const starters = await page.$$eval('#cx-empty [data-cx-start]', (els) => els.map((e) => [e.getAttribute('data-cx-start'), e.querySelector('.cx-way-title')?.textContent?.trim()]));
          expect(starters).toEqual([['plan', 'Plan a project'], ['image', 'Inspect an image'], ['workflow', 'Build a workflow']]);
          await page.evaluate(() => document.fonts.ready);
          const geo = await page.$$eval('#cx-empty [data-cx-start]', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return { top: Math.round(r.top), bottom: r.bottom, inside: r.left >= 0 && r.right <= window.innerWidth, cut: e.scrollHeight > e.clientHeight + 1 }; }));
          // (H168's R65: the band sits between the conversation and the composer, so the starters must end above the conversation's
          // own scroll box's bottom edge, not only above the composer)
          const fold = await page.$eval('#cx-scroll', (f) => f.getBoundingClientRect().bottom);
          const parts = await page.$$eval('#cx-empty > *, #cx-scroll, #cx-descriptor, #cx-composer, .cx-hint, #cx-controls, #cx-route, #cx-console', (els) => els.map((e) => `${e.id || e.className}:${Math.round(e.getBoundingClientRect().top)}-${Math.round(e.getBoundingClientRect().bottom)}`));
          expect(JSON.stringify({ ok: geo.every((g) => g.inside && !g.cut && g.bottom <= fold + 1), size, fold, geo, parts })).toMatch(/"ok":true/);
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
      // (R11 round 7, SHELL CONTRACT v1 §4: the rail is a top strip with its sheet closed; the Models context is a sheet CLOSED by
      // default — off the screen, not open over the conversation (GATE 04 R-c); the composer in view above the sticky dock)
      expect(await page.$eval('#rail-sheet', (e) => getComputedStyle(e).display)).toBe('none');
      const sheet = await page.$eval('#ws-chat .page-context', (e) => { const r = e.getBoundingClientRect(); return { open: e.classList.contains('is-open'), position: getComputedStyle(e).position, top: Math.round(r.top), inner: window.innerHeight, holdsModels: Boolean(e.querySelector('#cx-models')) }; });
      expect(sheet).toMatchObject({ open: false, position: 'fixed', holdsModels: true });
      expect(sheet.top, `the closed sheet is off the screen: ${JSON.stringify(sheet)}`).toBeGreaterThanOrEqual(sheet.inner);
      // (the composer reachable on the phone: scrolled to, whole above the sticky dock — the first screen is the shell's head and band)
      await page.$eval('#cx-composer', (f) => f.scrollIntoView({ block: 'center' }));
      expect(await page.evaluate(() => { const r = document.getElementById('cx-composer')!.getBoundingClientRect(); const d = document.querySelector('#ws-chat .page-dock')!.getBoundingClientRect(); return { inView: r.top >= 0 && r.bottom <= window.innerHeight, clearOfDock: r.bottom <= d.top + 1, sticky: getComputedStyle(document.getElementById('cx-composer')!).position }; })).toEqual({ inView: true, clearOfDock: true, sticky: 'sticky' });
      // the row of controls fits the phone's width: the minor ones are in More
      expect(await page.$eval('#cx-controls', (b) => JSON.stringify({ fits: b.scrollWidth <= b.clientWidth + 1, sw: b.scrollWidth, cw: b.clientWidth, items: [...b.children].map((e) => `${(e as HTMLElement).innerText.replace(/\s+/g, ' ').trim()}:${Math.round(e.getBoundingClientRect().width)}`), styles: [...b.children].map((e) => getComputedStyle(e).display) }))).toMatch(/"fits":true/);
      const said = (sel: string): Promise<string[]> => page.$$eval(sel, (els) => els.filter((e) => e.getClientRects().length).map((e) => (e as HTMLElement).innerText.replace(/[^A-Za-z /]/g, '').trim()));
      // (R11 round 4, capture 09: Plan / Run · Permissions · Budget · Logs · More; Attach, Tools and Cloudflare optional in More)
      expect(await said('#cx-controls .cx-ctl, #cx-controls .cx-more')).toEqual(['Plan / Run', 'Permissions', 'Budget', 'Logs', 'More']);
      await page.click('#cx-more');
      expect(await said('#cx-drawer [data-cx-ctl]')).toEqual(['Attach', 'Tools', 'Keys', 'Cloudflare optional']);
      await page.click('#cx-drawer [data-cx-ctl="attachments"]');
      // (R11 round 7: Attach says what is allowed — a project file by its path, read by the turn's tools — and what is not yet)
      expect(await text(page, '#cx-drawer')).toContain('Allowed: a file inside the project’s folder, named by its path there.');
      expect(await text(page, '#cx-drawer')).toContain('Not yet: uploads from this computer');
      expect(await page.isVisible('#cx-attach-path')).toBe(true);
      await page.keyboard.press('Escape');
      expect(await page.isVisible('#cx-drawer')).toBe(false);
      // (R11 round 4: FAKE is named on the descriptor; the next turn's model in the panel's NEXT TURN and the line above the composer)
      expect(await text(page, '#cx-descriptor')).toContain('FAKE model on this computer');
      expect(await text(page, '#cx-next-turn-model')).toMatch(/^fake-(?:qwen3:8b|llama:1b)$/);
      // R11 step 1 on a phone: the chip, and a model chosen from the Models drawer closes it and gives the composer the keyboard
      await page.waitForFunction(() => document.getElementById('cx-dot')?.dataset.state === 'ready', null, { timeout: 20_000 });
      expect(await text(page, '#cx-chip-words')).toMatch(/^fake-(?:qwen3:8b|llama:1b) · this computer · ready \d\d:\d\d$/);
      await page.fill('#cx-input', 'phone draft');
      // (the chip lives in the Models sheet's NEXT TURN on a phone: the head's Models button opens it — SHELL CONTRACT v1 §4)
      await page.click('#ws-chat .page-head .page-context-btn');
      await page.waitForSelector('#ws-chat .page-context.is-open', { timeout: 5_000 });
      expect(await page.isVisible('#cx-models')).toBe(true);
      expect(await page.isVisible('#cx-chip')).toBe(true);
      await page.click('[data-cm-provider="ollama"][data-cm-sub="local"]');
      await page.waitForSelector('#cm-list .cm-row[data-model="fake-llama:1b"]', { timeout: 20_000 });
      await page.focus('#cm-list .cm-row[data-model="fake-llama:1b"]');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.getElementById('cx-route-words')?.textContent?.startsWith('Next turn: fake-llama:1b'), null, { timeout: 20_000 });
      // (the drawer closes and the composer takes the keyboard once the choice's read-back is drawn)
      await page.waitForFunction(() => !document.querySelector('#ws-chat .page-context.is-open') && document.activeElement?.id === 'cx-input', null, { timeout: 10_000 });
      expect(await page.$eval('#ws-chat .page-context', (e) => e.classList.contains('is-open'))).toBe(false);
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
        expect(await text(p2, '#ws-chat .page-head .page-title')).toBe('What would you like to make?');
        expect(await text(p2, '#cx-empty .cx-welcome-start')).toBe('Start with');
        expect(await text(p2, '#cx-change')).toBe('Set up a model →');
        await p2.fill('#cx-input', 'a draft with no model');
        expect(await p2.isDisabled('#cx-send')).toBe(true);
        expect(await text(p2, '#cx-send-why')).toBe('No model chosen: choose one in Models');
        expect(await text(p2, '#cx-next-turn-model')).toBe('No model selected');
        await p2.focus('#cx-input');
        await p2.keyboard.press('Enter');
        expect(none.chats()).toEqual([]);
        expect(await p2.inputValue('#cx-input')).toBe('a draft with no model');
        // the Models context at 800 × 600 (one column, ≤ 1100: the context sits under the work, in the flow — SHELL CONTRACT v1
        // §2.2; the head's Models button and the sheet are the phone's, ≤ 720): Ollama local lists nothing, said why; no row SELECTED
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
