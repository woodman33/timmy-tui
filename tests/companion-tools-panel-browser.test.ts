/**
 * R6 (H142): the Tools & MCP panel (tab 9; src/companion/client/panel-tools.js over src/companion/panels/tools.ts), in a real
 * headless Chromium against the real companion server on 127.0.0.1: the test reads what the page shows (the servers with their
 * transport, the tools a real tools/list gave, each schema's fields, the request JSON, the generated CLI, the result, the
 * route, the receipt id) and checks it against the records and the chain the calls left in the project.
 *
 * Real: the server and its token, both MCP-to-CLI routes, the wire tap, the record writer, the project's receipt chain, the
 * page's code. FAKE, labelled: the MCP server (src/mcp/fake-fixture-server.ts, Timmy's FAKE fixture: every answer made up), the
 * project (a folder of this test's), MCPorter's home (an empty folder of this test's). Skipped, saying so, where no Chromium
 * or Chrome is found. With TIMMY_R6_CAPS=<folder>, the screens it reads are also saved there as PNG (the review's captures).
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { fixtureServer } from '../src/mcp/inspector.js';
import { readChain, verifyReceiptIn } from '../src/utils/receipts.js';

const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('companion-tools-panel-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

const CAPS = process.env.TIMMY_R6_CAPS;
const LONG = 180_000;
const AMBER = 'rgb(255, 176, 0)';
const GREENS = ['rgb(40, 254, 20)', 'rgb(0, 215, 0)'];

describe.skipIf(!browserPath)('the Tools & MCP panel in a real browser: servers, tools, schema, request, calls through both routes, receipts (R6 H142)', () => {
  const kept = { TIMMY_HOME: process.env.TIMMY_HOME, TIMMY_REPO: process.env.TIMMY_REPO };
  let box = '';
  let root = '';
  let browser: Browser;
  let companion: CompanionServer;
  let page: Page;
  const errors: string[] = [];

  beforeAll(async () => {
    box = mkdtempSync(join(tmpdir(), 'r6-tools-browser-'));
    root = join(box, 'FAKE-project');
    mkdirSync(join(root, '.timmy', 'receipts'), { recursive: true });
    const env = { TIMMY_HOME: join(box, 'home'), TIMMY_SETTINGS_DIR: join(box, 'settings'), TIMMY_MCP_HOME: join(box, 'mcp-home') };
    mkdirSync(env.TIMMY_MCP_HOME, { recursive: true });
    process.env.TIMMY_HOME = env.TIMMY_HOME;
    process.env.TIMMY_REPO = root;
    if (CAPS) mkdirSync(CAPS, { recursive: true });
    companion = await startCompanionServer(0, { workspace: { env, shareMs: 0 } });
    browser = await chromium.launch({ headless: true, executablePath: browserPath, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
    page = await browser.newPage({ viewport: { width: 1376, height: 768 } });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(companion.url);
    await page.waitForFunction(() => document.getElementById('status-text')?.textContent === 'COMPANION SOCKET · CONNECTED', null, { timeout: 30_000 });
  }, LONG);
  // the calls of one test are read back in the next: the project's own store, not the per-test one (tests/isolation-setup.ts)
  beforeEach(() => { delete process.env.TIMMY_STORE; });
  afterAll(async () => {
    await browser?.close();
    await companion?.shutdown();
    for (const [k, v] of Object.entries(kept)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (box) rmSync(box, { recursive: true, force: true });
  });

  const cap = async (name: string): Promise<void> => { if (CAPS) await page.screenshot({ path: join(CAPS, `${name}.png`) }); };
  // what a person reads: the rendered text (innerText keeps the line breaks between blocks), its runs of space as one
  const text = (sel: string): Promise<string> => page.$eval(sel, (el) => ((el as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim());
  const texts = (sel: string): Promise<string[]> => page.$$eval(sel, (els) => els.map((el) => ((el as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim()));
  const records = (): string[] => (existsSync(join(root, '.timmy', 'mcp')) ? readdirSync(join(root, '.timmy', 'mcp')).filter((n) => /^m[0-9a-f]{8}$/.test(n)) : []);
  /** Waits until the call button says this and can be pressed (the request passed its schema check). */
  const callable = (label: RegExp): Promise<unknown> => page.waitForFunction((src) => {
    const b = document.querySelector('[data-tools-action="call"]') as HTMLButtonElement | null;
    return !!b && !b.disabled && new RegExp(src).test(b.textContent ?? '');
  }, label.source, { timeout: 30_000 });
  /** Green appears only where it is earned: an answer observed now (.is-live) or a check passed / receipt verified (.is-verified). */
  const greenWhere = (): Promise<string[]> => page.$$eval('[data-tools-panel] *, .tools-steps *', (els, greens) => els
    .filter((el) => { const s = getComputedStyle(el); return (greens as string[]).some((g) => s.color === g || s.backgroundColor === g || s.borderTopColor === g); })
    .filter((el) => !el.closest('.is-live, .is-verified'))
    .map((el) => `${el.tagName.toLowerCase()}.${el.className}`), GREENS);
  const amberFills = (): Promise<string[]> => page.$$eval('#ws-tools *', (els, amber) => els.filter((el) => getComputedStyle(el).backgroundColor === amber).map((el) => (el.textContent ?? '').trim()), AMBER);

  it('opens on tab 9 with the ingest modes as Timmy has them, both routes\' rungs, and the FAKE fixture as a stdio server not contacted yet', async () => {
    await page.keyboard.press('9');
    await page.waitForSelector('[data-tools-panel] [data-server="fixture"]', { timeout: 30_000 });
    expect(await texts('[data-mode] .tools-mode-label')).toEqual(['1. Stdio MCP', '2. SSE / HTTP remote', '3. apisnip OpenAPI', '4. clyanything web']);
    expect(await texts('[data-mode] .tools-mode-state')).toEqual(['works · SDK + mcporter', 'works · mcporter', 'not in Timmy', 'not in Timmy']);
    expect(await page.$eval('[data-mode="apisnip"] input', (el) => (el as HTMLInputElement).disabled)).toBe(true);
    expect(await text('[data-mode-off="apisnip"]')).toMatch(/apisnip OpenAPI: apisnip is (not installed here|on PATH), .*no Timmy route runs it/);
    expect(await text('[data-mode-off="clyanything"]')).toMatch(/no Timmy route runs it/);
    expect(await texts('[data-route] [data-rung]')).toEqual([expect.stringMatching(/^installed · 1\.\d+\.\d+$/), 'installed · 0.12.4']);
    expect(await text('[data-route="sdk"]')).toMatch(/no call through it in this project yet/);
    const fx = await text('[data-server="fixture"]');
    expect(fx).toMatch(/^FAKE · timmy-fake-fixture stdio Timmy's own test server: its tools and answers are made up · not contacted from this page$/);
    // the one primary next step: list its tools (amber), and no other amber fill on the tab
    expect(await page.$eval('[data-tools-action="list"]', (el) => el.classList.contains('is-primary'))).toBe(true);
    expect(await text('[data-tools-action="list"]')).toBe("List the FAKE fixture's tools via the SDK route");
    expect(await amberFills()).toEqual(["List the FAKE fixture's tools via the SDK route"]);
    expect(await text('.tools-step.is-next')).toMatch(/^▶ 2\. tools\/list through the SDK route$/);
    await cap('h142-01-tab9-open');
    expect(errors).toEqual([]);
  }, LONG);

  it('a real tools/list through the SDK route: five FAKE tools with their hints and fields, a schema drawn as a table, the schema gate passed', async () => {
    await page.click('[data-tools-action="list"]');
    await page.waitForSelector('[data-tool="fake_echo"]', { timeout: 60_000 });
    expect(await page.$$eval('[data-tool]', (els) => els.map((el) => el.getAttribute('data-tool')))).toEqual(['fake_echo', 'fake_measure', 'fake_swatch', 'fake_fail', 'fake_write_note']);
    expect(await text('[data-tool="fake_echo"]')).toMatch(/^fake_echo\(text, times\?\) ✓ strict rule hints: read-only, not destructive, idempotent, closed world \(its claim\) · FAKE: says your words back/);
    expect(await text('[data-tool="fake_write_note"]')).toMatch(/hints: not read-only, destructive, not idempotent, closed world/);
    expect(await text('.tools-tools .tools-sub')).toMatch(/^TOOLS · 5 · tools\/list via sdk · \d+(\.\d+)? (ms|s) · \d\d:\d\d:\d\d$/);
    // the server, as observed now: it answered
    expect(await text('[data-server="fixture"]')).toMatch(/● answered tools\/list via sdk \d\d:\d\d:\d\d · 5 tools ·/);
    // fake_echo is picked: its input schema, drawn
    expect(await texts('.tools-schematable tbody tr')).toEqual([
      'text string required minLength 1 · maxLength 200 The words to say back',
      'times integer optional minimum 1 · maximum 3 · default 1 How many times (1 to 3)',
    ]);
    // the form made from it: one field per property, its type and rules said
    expect(await page.$$eval('.tools-field', (els) => els.map((el) => el.getAttribute('data-field')))).toEqual(['text', 'times']);
    expect(await text('.tools-field[data-field="text"] label')).toBe('text string · required · minLength 1 · maxLength 200');
    expect(await page.$eval('[data-field-input="times"]', (el) => (el as HTMLInputElement).value)).toBe('1');
    // the gate, every check passed (green with its ✓), and the request not yet sendable (text is required)
    const gate = await texts('.tools-gate li');
    expect(gate.slice(0, 5)).toEqual(['✓ 5 tool schemas read from the server\'s own list', '✓ 0 arrays without items', '✓ 0 properties named like a schema keyword', '✓ 0 uses of oneOf, allOf, not, patternProperties or $ref', '✓ tool names: no collisions']);
    await page.waitForFunction(() => /not match its input schema yet/.test(document.querySelector('.tools-gate')?.textContent ?? ''), null, { timeout: 15_000 });
    expect(await text('[data-field-error="(the arguments)"]')).toBe("✕ must have required property 'text'");
    expect(await page.$eval('[data-tools-action="call"]', (el) => (el as HTMLButtonElement).disabled)).toBe(true);
    expect(await greenWhere()).toEqual([]);
    await cap('h142-02-servers-and-schema');
    expect(errors).toEqual([]);
  }, LONG);

  it('the request form filled: checked against the schema on the companion, its JSON-RPC request and the generated CLI for both routes', async () => {
    await page.fill('[data-field-input="text"]', 'FAKE hello from the page');
    await callable(/^Call fake_echo via the SDK route$/);
    const request = JSON.parse(await page.$eval('[data-tools-request]', (el) => el.textContent ?? ''));
    expect(request).toEqual({ jsonrpc: '2.0', id: '(the route numbers it)', method: 'tools/call', params: { name: 'fake_echo', arguments: { times: 1, text: 'FAKE hello from the page' } } });
    const fx = fixtureServer();
    if (!fx.ok) throw new Error(fx.why);
    const cmd = fx.command.join(' ');
    const json = '{"times":1,"text":"FAKE hello from the page"}';
    expect(await page.$eval('[data-cli="repl-sdk"] .cmd', (el) => el.getAttribute('data-copy'))).toBe(`/mcp call --route sdk fake_echo ${json} -- ${cmd}`);
    expect(await text('[data-cli="repl-sdk"] .cmd')).toBe(`/mcp call --route sdk fake_echo ${json} -- ${cmd}`);
    expect(await text('[data-cli="repl-mcporter"] .cmd')).toBe(`/mcp call --route mcporter fake_echo ${json} -- ${cmd}`);
    expect(await text('[data-cli="mcporter"] .cmd')).toMatch(/^mcporter call --stdio node --stdio-arg .* --tool fake_echo --args '\{"times":1,"text":"FAKE hello from the page"\}'$/);
    expect(await text('[data-cli="sdk"] .cmd')).toMatch(/mcp-sdk-cli\.(ts|js) call fake_echo --args '\{"times":1,"text":"FAKE hello from the page"\}' --json -- node /);
    expect(await text('[data-tools-rule]')).toBe('Runs from this page: the server lists fake_echo as read-only and closed-world (its own claim, not checked), so the call runs from this page, as a /mcp call you typed would.');
    expect(await amberFills()).toEqual(['Call fake_echo via the SDK route']);
    expect(await text('.tools-step.is-next')).toMatch(/^▶ 4\. Call through the SDK route$/);
    await cap('h142-03-request-form-and-json-rpc');
    expect(errors).toEqual([]);
  }, LONG);

  it('a call through the SDK route: the result, the route, the time, the exact request and answer, the flame graph, the receipt verified', async () => {
    const before = records();
    await page.click('[data-tools-action="call"]');
    await page.waitForSelector('[data-tools-result="call"]', { timeout: 90_000 });
    const id = await page.$eval('[data-tools-result="call"]', (el) => el.getAttribute('data-call') ?? '');
    expect(id).toMatch(/^m[0-9a-f]{8}$/);
    expect(records()).toEqual([...before, id]);
    expect(await text('[data-tools-result="call"] .row-between')).toMatch(/^● answered · fake_echo on node fake-fixture-server\.(ts|js) \d\d:\d\d:\d\d · \d/);
    expect(await text('[data-tools-route]')).toBe('route: the SDK route · made from this page');
    expect(await texts('[data-item="text"]')).toEqual(['FAKE echo: FAKE hello from the page']);
    // the receipt, verified now on the project's chain, and by this test too
    const rid = await page.$eval('[data-tools-receipt]', (el) => el.getAttribute('data-tools-receipt') ?? '');
    expect(rid).toMatch(/^[0-9a-f]{8}$/);
    expect(await page.$eval('[data-tools-receipt]', (el) => el.getAttribute('data-verified'))).toBe('yes');
    expect(await text('[data-tools-receipt] p')).toMatch(new RegExp(`^✓ sealed and verified · receipt ${rid} · #\\d+ on the project's runs chain · \\d\\d:\\d\\d:\\d\\d$`));
    const chain = readChain('runs', root);
    const sealed = chain.find((r) => r.hash.slice(7, 15) === rid)!;
    expect(sealed).toMatchObject({ kind: 'mcp.call', status: 'ok' });
    expect(sealed.outputs?.[0]?.path).toBe(`.timmy/mcp/${id}/call.json`);
    expect(verifyReceiptIn(chain, sealed.hash).ok).toBe(true);
    // the request exactly as sent (the wire tap's), its id the route's
    const sent = JSON.parse(await page.$eval('[data-sent-request]', (el) => el.textContent ?? ''));
    expect(sent).toMatchObject({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'fake_echo', arguments: { text: 'FAKE hello from the page', times: 1 } } });
    expect(typeof sent.id).toBe('number');
    // the flame graph: one bar per request, measured
    expect(await page.$$eval('.tools-flame rect', (els) => els.map((el) => (el.getAttribute('data-span') ?? '').replace(/ · .*$/, '')))).toEqual(['call via sdk', 'server 1: the call', 'initialize', 'tools/list', 'tools/call']);
    expect(await texts('[data-span-method]')).toEqual([
      expect.stringMatching(/^initialize \(id 0\) · \d/), expect.stringMatching(/^tools\/list \(id 1\) · \d/), expect.stringMatching(/^tools\/call \(id 2\) · \d/),
    ]);
    // the step bar: the record and receipt step green with its word; green nowhere it is not earned
    expect(await text('.tools-step.is-verified')).toBe(`✓ 5. Record & receipt sealed and verified · ${rid}`);
    expect(await greenWhere()).toEqual([]);
    // the newest calls, from the records
    await page.waitForSelector(`[data-call-row="${id}"]`, { timeout: 15_000 });
    expect(await text(`[data-call-row="${id}"]`)).toMatch(new RegExp(`^\\d\\d:\\d\\d:\\d\\d fake_echo node fake-fixture-server\\.(ts|js) sdk ● answered \\d.* ✓ receipt ${rid} verified this page shown$`));
    expect(await text('[data-route="sdk"]')).toMatch(new RegExp(`● answered \\d\\d:\\d\\d:\\d\\d · fake_echo · ✓ receipt ${rid} verified`));
    await cap('h142-04-call-sdk-result-and-receipt');
    expect(errors).toEqual([]);
  }, LONG);

  it('a call through the mcporter route: JSON drawn, MCPorter\'s two server starts on the wire, its receipt verified', async () => {
    await page.click('[data-tool="fake_measure"]');
    await page.fill('[data-field-input="width_mm"]', '120');
    await page.fill('[data-field-input="height_mm"]', '80');
    await page.selectOption('[data-field-input="unit"]', 'cm');
    await page.click('[data-route-pick="call:mcporter"]');
    await callable(/^Call fake_measure via the mcporter route$/);
    await page.click('[data-tools-action="call"]');
    await page.waitForFunction(() => /fake_measure/.test(document.querySelector('[data-tools-result="call"]')?.textContent ?? ''), null, { timeout: 90_000 });
    expect(await text('[data-tools-route]')).toBe('route: the mcporter route · made from this page');
    const json = JSON.parse(await page.$eval('[data-item="json"] pre', (el) => el.textContent ?? ''));
    expect(json).toMatchObject({ fake: true, unit: 'cm', width: 12, height: 8, area: 96, perimeter: 40 });
    expect(await page.$$eval('.tools-flame rect', (els) => els.map((el) => (el.getAttribute('data-span') ?? '').replace(/ · .*$/, '')))).toEqual(['call via mcporter', 'server 1: name check', 'initialize', 'tools/list', 'server 2: the call', 'initialize', 'tools/call']);
    const rid = await page.$eval('[data-tools-receipt]', (el) => el.getAttribute('data-tools-receipt') ?? '');
    expect(await page.$eval('[data-tools-receipt]', (el) => el.getAttribute('data-verified'))).toBe('yes');
    const chain = readChain('runs', root);
    expect(verifyReceiptIn(chain, chain.find((r) => r.hash.slice(7, 15) === rid)!.hash).ok).toBe(true);
    expect(await text('[data-route="mcporter"]')).toMatch(new RegExp(`● answered \\d\\d:\\d\\d:\\d\\d · fake_measure · ✓ receipt ${rid} verified`));
    await cap('h142-05-call-mcporter-result-and-receipt');
    expect(errors).toEqual([]);
  }, LONG);

  it('an image answer is drawn as the server sent it', async () => {
    await page.click('[data-tool="fake_swatch"]');
    await page.selectOption('[data-field-input="shade"]', 'grey');
    await page.click('[data-route-pick="call:sdk"]');
    await callable(/^Call fake_swatch via the SDK route$/);
    await page.click('[data-tools-action="call"]');
    await page.waitForSelector('img.tools-img', { timeout: 90_000 });
    const img = await page.$eval('img.tools-img', (el) => ({ src: (el as HTMLImageElement).src.slice(0, 22), w: (el as HTMLImageElement).naturalWidth, h: (el as HTMLImageElement).naturalHeight, alt: (el as HTMLImageElement).alt }));
    expect(img).toEqual({ src: 'data:image/png;base64,', w: 64, h: 40, alt: expect.stringMatching(/^An image from the server: image\/png, \d+ B$/) });
    expect(await text('.tools-figure figcaption')).toMatch(/^image\/png · \d+ B · the server's own image, drawn as it sent it$/);
    expect(errors).toEqual([]);
  }, LONG);

  it('a call that needs approval does not run from the page: NEEDS YOU with the line for Timmy\'s terminal; nothing called, no record', async () => {
    const before = records();
    // listed through mcporter, the tool's hints are not known on the page; the call reads them through the SDK route and refuses
    await page.click('[data-route-pick="list:mcporter"]');
    await page.click('[data-tools-action="list"]');
    await page.waitForFunction(() => /tools\/list via mcporter/.test(document.querySelector('.tools-tools .tools-sub')?.textContent ?? ''), null, { timeout: 60_000 });
    expect(await text('[data-tool="fake_write_note"]')).toMatch(/hints: not known on this route/);
    await page.click('[data-tool="fake_write_note"]');
    await page.fill('[data-field-input="note"]', 'FAKE note');
    await callable(/^Call fake_write_note via the SDK route$/);
    expect(await page.$eval('[data-tools-rule]', (el) => el.getAttribute('data-tools-rule'))).toBe('later');
    await page.click('[data-tools-action="call"]');
    await page.waitForSelector('[data-tools-result="needs-you"]', { timeout: 90_000 });
    const fx = fixtureServer();
    if (!fx.ok) throw new Error(fx.why);
    const line = `/mcp call --route sdk fake_write_note {"note":"FAKE note"} -- ${fx.command.join(' ')}`;
    expect(await text('[data-tools-result="needs-you"]')).toBe(`NEEDS YOU · fake_write_note via the SDK route was not called the server does not list fake_write_note as read-only (readOnlyHint: false, destructiveHint: true): a call that may change something waits for you. Nothing was started for the call, and no record was written. In Timmy's terminal, where a typed /mcp call is your own command: ${line}`);
    expect(await page.$eval('[data-tools-result="needs-you"] .cmd', (el) => el.getAttribute('data-copy'))).toBe(line);
    expect(records()).toEqual(before);
    // now the page holds the hints, so it says so before sending, and its one primary copies the line instead of calling
    await page.click('[data-route-pick="list:sdk"]');
    await page.click('[data-tools-action="list"]');
    await page.waitForFunction(() => /tools\/list via sdk/.test(document.querySelector('.tools-tools .tools-sub')?.textContent ?? ''), null, { timeout: 60_000 });
    await page.click('[data-tool="fake_write_note"]');
    await page.fill('[data-field-input="note"]', 'FAKE note');
    await page.waitForFunction(() => document.querySelector('[data-tools-rule]')?.getAttribute('data-tools-rule') === 'needs-you', null, { timeout: 15_000 });
    expect(await text('[data-tools-rule]')).toBe(`NEEDS YOU: the server does not list fake_write_note as read-only (readOnlyHint: false, destructiveHint: true): a call that may change something waits for you. In Timmy's terminal: ${line}`);
    expect(await page.$eval('[data-tools-action]:not([data-tools-action="list"])', (el) => el.getAttribute('data-tools-action'))).toBe('copy-terminal');
    expect(records()).toEqual(before);
    await cap('h142-06-needs-you');
    expect(errors).toEqual([]);
  }, LONG);

  it('the newest calls come from the records, and each is viewable again with its receipt verified now', async () => {
    const rows = await page.$$eval('[data-call-row]', (els) => els.map((el) => el.getAttribute('data-call-row') ?? ''));
    expect(rows.length).toBe(3);
    expect(rows.sort()).toEqual(records().sort());
    // the first call (fake_echo, through the SDK route), shown again
    const echoRow = await page.$$eval('[data-call-row]', (els) => els.find((el) => /fake_echo/.test(el.textContent ?? ''))?.getAttribute('data-call-row') ?? '');
    expect(echoRow).toMatch(/^m[0-9a-f]{8}$/);
    await page.click(`[data-open-call="${echoRow}"]`);
    await page.waitForFunction((id) => document.querySelector('[data-tools-result="call"]')?.getAttribute('data-call') === id, echoRow, { timeout: 15_000 });
    expect(await texts('[data-item="text"]')).toEqual(['FAKE echo: FAKE hello from the page']);
    expect(await page.$eval('[data-tools-receipt]', (el) => el.getAttribute('data-verified'))).toBe('yes');
    expect(await text(`[data-call-row="${echoRow}"] [data-open-call]`)).toBe('shown');
    expect(errors).toEqual([]);
  }, LONG);
});
