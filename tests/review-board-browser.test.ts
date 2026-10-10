/**
 * Round R4 (H65): the review section and its Restore on the live board, in a real headless Chromium (skipped when none is
 * found, as the other *-browser tests are). Real records by the existing writers, each sealed on the project's own REAL
 * receipts chain: an /iterate scad flow with its kept copy, and a workflow with a hostile name and hostile lines saved through
 * the live board's own POST /edit with its token (its previous version kept by the board's writer).
 *
 * FAKE pieces: the code agent (tests/fixtures/fake-code-agent.mjs) and OpenSCAD (tests/fixtures/fake-openscad.mjs) are TEST
 * DOUBLES (tests/helpers/ops-sandbox.ts); no model or app runs, and nothing leaves 127.0.0.1.
 */
import fs from 'node:fs';
import path from 'node:path';
import { request } from 'node:http';
import { createHash } from 'node:crypto';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readChain, verifyChain } from '../src/utils/receipts.js';
import { parseWorkflow } from '../src/workflows/upmd.js';
import { opsKit, replOf, sandbox, text } from './helpers/ops-sandbox.js';

const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && fs.existsSync(p!));
if (!browserPath) console.warn('review-board-browser: no Chromium or Chrome found, so the real-browser check is skipped here');

const kit = opsKit();
afterEach(() => kit.cleanup(), 60_000);

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const RLO = String.fromCharCode(0x202e);

/** One HTTP request to the live board on 127.0.0.1 (Node, not the page): status and text. */
function raw(port: number, o: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: o.method ?? 'GET', path: o.path, headers: o.headers ?? {} }, (res) => {
      let body = '';
      res.setEncoding('utf8').on('data', (c: string) => { body += c; }).on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end(o.body);
  });
}
const restoreButton = (file: string): string => `button[data-act="restore"][data-file="${file.replace(/["\\]/g, (c) => `\\${c}`)}"]`;
/** The page's #out once it shows a new answer (the live page sets it from the action's response as text). */
async function answerOf(page: Page, before: string): Promise<string> {
  await page.waitForFunction((b) => { const o = document.getElementById('out'); return !!o && !o.hidden && o.textContent !== b && !/…$/.test(o.textContent ?? ''); }, before, { timeout: 15_000 });
  return (await page.textContent('#out')) ?? '';
}

describe.skipIf(!browserPath)('Results and review on the live board (headless Chromium, a fresh context)', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true, executablePath: browserPath }); });
  afterAll(async () => { await browser?.close(); });

  it('shows each change escaped; Restore is refused without the token, refused when the file changed since, and done when it is as its run left it: the history copy kept, the receipt sealed', async () => {
    const s = sandbox(kit, 'review-browser-');
    const { ws, notes } = replOf(kit, s);
    // A real /iterate scad flow (FAKE agent, FAKE OpenSCAD): width 60 → 100, the file's bytes as read kept by the flow.
    const instruction = 'make it 100 wide PYFILE:box.params.json PYREPLACE:60,=>100,';
    const original = fs.readFileSync(path.join(s.root, 'box.params.json'));
    const out = text(await ws.operate(`/iterate scad box.scad "${instruction}"`, 'repl', () => ws.iterate(`scad box.scad "${instruction}"`)));
    const flow = /\b(f[0-9a-f]{8})\b/.exec(out)?.[1];
    expect(flow, out).toBeDefined();
    await ws.ops.done(ws.ops.latest!);
    const left = fs.readFileSync(path.join(s.root, 'box.params.json'));
    const kept = `.timmy/flows/${flow}/params.before.json`;
    // A workflow with a hostile name and hostile lines, saved through the live board's own POST /edit with its token.
    const F = '```';
    const doc = 'wf <b>"x" & y.md';
    const first = ['# A workflow', '', `${F}bash [name:build]`, `echo "<script>alert(1)</script>" ${ESC}]8;;http://x${BEL}link${ESC}]8;;${BEL} ${RLO}txt.exe`, F, ''].join('\n');
    fs.writeFileSync(path.join(s.root, doc), first);
    expect(text(await ws.boardLive('live'))).toContain('Live board');
    const lb = ws.liveBoard!;
    const token = lb.url.split('#t=')[1];
    const json = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const block = parseWorkflow(first).find((b) => b.name === 'build')!;
    const saved = await raw(lb.port, { method: 'POST', path: '/edit', headers: json, body: JSON.stringify({ action: 'save-workflow', doc, sha256: sha(first), blocks: [{ from: block.index, name: 'build', lang: 'bash', needs: [], command: 'echo safe <img src=x onerror=alert(2)>' }] }) });
    expect(saved.status, saved.body).toBe(200);
    const docSaved = fs.readFileSync(path.join(s.root, doc));

    const context = await browser.newContext();
    const page = await context.newPage();
    const problems: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(m.text()); });
    page.on('pageerror', (e) => problems.push(String(e)));
    page.on('dialog', (d) => { problems.push(`a dialog: ${d.message()}`); void d.dismiss(); });
    await page.goto(lb.url);
    await page.waitForSelector(restoreButton('box.params.json'));
    await page.waitForSelector(restoreButton(doc));
    // The section, next to the Control Room, every string as text: the name, the lines (control and direction characters as codes).
    expect(await page.evaluate(() => { const r = document.getElementById('review'); const c = document.getElementById('room'); return !!r && !!c && !!(c.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING); })).toBe(true);
    const item = `li[data-review-file="${doc.replace(/["\\]/g, (c) => `\\${c}`)}"]`;
    expect(await page.textContent(`${item} .rv-path`)).toBe(doc);
    const lines = await page.$$eval(`${item} .rv-line`, (els) => els.map((e) => e.textContent));
    expect(lines).toEqual(['echo "<script>alert(1)</script>" \\x1b]8;;http://x\\x07link\\x1b]8;;\\x07 \\u202etxt.exe', 'echo safe <img src=x onerror=alert(2)>']);
    expect(await page.$$eval('.review script, .review img, .review b b, .rv-path b', (els) => els.length)).toBe(0);
    expect(await page.evaluate((chars) => chars.map((c) => (document.querySelector('.review')!.textContent ?? '').includes(c)), [ESC, BEL, RLO])).toEqual([false, false, false]);
    expect(await page.textContent(`li[data-review-file="box.params.json"] .rv-kept`)).toContain(`previous version kept at ${kept}`);
    const chainBefore = readChain('runs', s.root).length;

    // Refused without the token: a page of the board's own origin, opened without it, sends the action; nothing is written.
    const other = await browser.newContext();
    const bare = await other.newPage();
    await bare.goto(lb.address);
    const noToken = await bare.evaluate(async (body) => {
      const r = await fetch('/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'omit' });
      return [r.status, await r.text()];
    }, { action: 'restore', file: 'box.params.json', from: kept });
    expect(noToken).toEqual([401, 'Refused: no valid token. Open the address /board live printed.']);
    await other.close();
    expect(fs.readFileSync(path.join(s.root, 'box.params.json'))).toEqual(left);

    // Refused when the file changed since its run: the button drawn before the change is pressed; the typed /restore says why.
    // (The page is held from redrawing for this one press, as it is while a card is being edited: data-editing.)
    await page.evaluate(() => document.querySelector('.review')!.setAttribute('data-editing', ''));
    const later = left.toString().replace('"width": 100', '"width": 120');
    fs.writeFileSync(path.join(s.root, 'box.params.json'), later);
    let before = (await page.textContent('#out')) ?? '';
    await page.click(restoreButton('box.params.json'));
    let answer = await answerOf(page, before);
    expect(answer.split('\n')[0]).toBe(`board /restore box.params.json --from ${kept}`);
    expect(answer).toMatch(/Refused    box\.params\.json changed since the run \(sha256 [0-9a-f]{12} now; the run left [0-9a-f]{12}\): restoring would replace a later version\. Nothing was written\./);
    expect(fs.readFileSync(path.join(s.root, 'box.params.json'), 'utf8')).toBe(later);
    expect(readChain('runs', s.root).length).toBe(chainBefore);
    expect(fs.existsSync(path.join(s.root, '.timmy', 'restore-history'))).toBe(false);
    await page.evaluate(() => document.querySelector('.review')!.removeAttribute('data-editing'));

    // Done when the file is as its run left it: the kept bytes back, the version it replaced kept, an edit receipt sealed.
    fs.rmSync(path.join(s.root, 'box.params.json'));
    fs.writeFileSync(path.join(s.root, 'box.params.json'), left);
    await page.waitForFunction(() => /unchanged/.test(document.querySelector('li[data-review-file="box.params.json"] .rv-now')?.textContent ?? ''), undefined, { timeout: 15_000 });
    before = (await page.textContent('#out')) ?? '';
    await page.click(restoreButton('box.params.json'));
    answer = await answerOf(page, before);
    expect(answer).toContain(`  Restored   box.params.json  from ${kept}`);
    expect(fs.readFileSync(path.join(s.root, 'box.params.json'))).toEqual(original);
    const history = /kept at (\.timmy\/restore-history\/box\.params\.json\/\S+\.json\.bak)/.exec(answer)?.[1];
    expect(history, answer).toBeDefined();
    expect(fs.readFileSync(path.join(s.root, history!))).toEqual(left);
    let chain = readChain('runs', s.root);
    expect(chain.length).toBe(chainBefore + 1);
    expect(chain.at(-1)).toMatchObject({ kind: 'edit', policy: 'human-gated', status: 'ok', files: [{ path: 'box.params.json', sha256: sha(original), previous_sha256: sha(left), created: false }] });
    expect(answer).toContain(`receipt ${chain.at(-1)!.hash.slice(7, 15)} (edit, human-gated)`);
    expect(notes).toContain(`  board  /restore box.params.json --from ${kept}`);

    // The hostile workflow's Restore: its first version back, exactly, its name passed through as data.
    await page.waitForSelector(restoreButton(doc));
    before = (await page.textContent('#out')) ?? '';
    await page.click(restoreButton(doc));
    answer = await answerOf(page, before);
    expect(answer).toContain('  Restored   wf <b>"x" & y.md');
    expect(fs.readFileSync(path.join(s.root, doc), 'utf8')).toBe(first);
    expect(fs.readdirSync(path.join(s.root, '.timmy', 'restore-history', doc)).map((n) => fs.readFileSync(path.join(s.root, '.timmy', 'restore-history', doc, n)))).toEqual([docSaved]);
    chain = readChain('runs', s.root);
    expect(chain.length).toBe(chainBefore + 2);
    expect(chain.at(-1)).toMatchObject({ kind: 'edit', files: [{ path: doc, sha256: sha(first), previous_sha256: sha(docSaved) }] });
    expect(verifyChain('runs', s.root).ok).toBe(true);
    // The section, drawn again from the next state, shows the two restores as the newest operations.
    await page.waitForFunction(() => document.querySelectorAll('[data-review-op]').length >= 4, undefined, { timeout: 15_000 });
    expect(await page.$$eval('[data-review-op] .rv-request code', (els) => els.slice(0, 2).map((e) => e.textContent))).toEqual([
      `/restore 'wf <b>"x" & y.md' --from '${chain.at(-1)!.sources!.map((x) => (x as { path?: string; role: string })).find((x) => x.role === 'restored from')!.path}'`,
      `/restore box.params.json --from ${kept}`,
    ]);
    // Nothing kept in the browser; no script, console or policy error; no dialog.
    expect(await page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie])).toEqual([0, 0, '']);
    expect(problems).toEqual([]);
    await context.close();
  }, 120_000);
});
