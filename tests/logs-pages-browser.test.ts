/**
 * R4 (H95): every page the log companion (`timmy logs`) serves runs under the strictest Content-Security-Policy it works
 * under (src/utils/logserver.ts logsPagePolicy), in a real headless Chromium against the real server on 127.0.0.1:
 *   /, /mission, /browser   their inline scripts only by the answer's nonce (a new one each answer), so no other inline
 *                           script and no inline handler runs: their buttons (the dispatch rail's arm/launch/hold/cancel/
 *                           collect, the mission studio's compile, send to controller, load state, play, stop, play
 *                           fragment, the receipt browser's verify) are wired by the pages' own scripts, and still work;
 *                           inline styles (theme colours in their markup); requests to this server only
 *   /chat                   scripts from this server only (its token script, /chat/page.js, and the Streamdown island
 *                           from the companion's own build, /web/), its style block by the answer's nonce
 * Every request of every page is recorded; one elsewhere is aborted. No violation is reported and no page error happens
 * while the pages load and their buttons are used; an inline script the test adds is refused and reported (so a violation
 * would have been seen). Skipped, saying so, where no Chromium or Chrome is found.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureCompanionWeb } from '../scripts/companion-web-build.mjs';
import { startManagedLogServer, type LogServerHandle } from '../src/utils/logserver.js';
import { appendReceipt } from '../src/utils/receipts.js';

const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('logs-pages-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

interface Seen { method: string; path: string; body: string }

const directives = (csp: string): Map<string, string> => new Map(csp.split(';').map((d) => d.trim()).filter(Boolean).map((d) => { const [k, ...v] = d.split(/\s+/); return [k, v.join(' ')] as const; }));

describe.skipIf(!browserPath)('the log companion\'s pages under their policies, their buttons wired by their own scripts (R4 H95), in a real browser', () => {
  const dirs: string[] = [];
  const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
  const saved: Record<string, string | undefined> = {};
  const ENV = ['TIMMY_REPO', 'TIMMY_HOME', 'TIMMY_LOGS_OPEN'];
  const originalCwd = process.cwd();
  let browser: Browser;
  let logs: LogServerHandle;
  let base = '';
  let token = '';

  beforeAll(async () => {
    await ensureCompanionWeb();
    for (const k of ENV) saved[k] = process.env[k];
    const work = temp('h95-logs-');
    process.env.TIMMY_REPO = work;
    process.env.TIMMY_HOME = temp('h95-logs-home-');
    process.env.TIMMY_LOGS_OPEN = '0';
    process.chdir(work);
    // a plan for the dispatch rail, a session for the chat mirror (both SYNTHETIC; the receipt browser's receipt is sealed in
    // its test, into that test's own store: tests/isolation-setup.ts)
    mkdirSync(join(work, '.timmy', 'dispatch'), { recursive: true });
    writeFileSync(join(work, '.timmy', 'dispatch', 'plan_synthetic.json'), JSON.stringify({ id: 'plan_synthetic', lifecycle: 'draft', plan_hash: 'sha256_synthetic', plan: { harnesses: ['tmux'], objective: 'SYNTHETIC plan' } }));
    mkdirSync(join(work, '.sessions'), { recursive: true });
    writeFileSync(join(work, '.sessions', 'h95.jsonl'), `${JSON.stringify({ role: 'assistant', content: '## SYNTHETIC mirror heading\n\n```ts\nconst x = 1;\n```' })}\n`);
    logs = await startManagedLogServer({ port: 0 });
    base = `http://127.0.0.1:${logs.port}`;
    token = /#t=([0-9a-f]{64})$/.exec(logs.url)?.[1] ?? '';
    browser = await chromium.launch({ headless: true, executablePath: browserPath, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  }, 600_000);

  afterAll(async () => {
    await browser?.close();
    await logs?.stop();
    process.chdir(originalCwd);
    for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  async function open(path: string): Promise<{ page: Page; context: BrowserContext; seen: Seen[]; outside: string[]; errors: string[]; dialogs: string[] }> {
    const context = await browser.newContext({ viewport: { width: 1300, height: 900 } });
    const seen: Seen[] = [];
    const outside: string[] = [];
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== base) { outside.push(url.href); return route.abort('blockedbyclient'); }
      seen.push({ method: route.request().method(), path: url.pathname + url.search, body: route.request().postData() ?? '' });
      return route.continue();
    });
    await context.addInitScript(() => {
      const w = window as unknown as { __violations: string[] };
      w.__violations = [];
      document.addEventListener('securitypolicyviolation', (e) => { w.__violations.push(`${e.effectiveDirective} ${e.blockedURI}`); });
    });
    const page = await context.newPage();
    const errors: string[] = [];
    const dialogs: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => { dialogs.push(d.message()); void d.dismiss(); });
    await page.goto(`${base}${path}#t=${token}`);
    return { page, context, seen, outside, errors, dialogs };
  }
  const violations = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as { __violations: string[] }).__violations);

  it('serves each page with its policy and a new nonce each answer; no page carries an inline handler; the chat mirror\'s scripts are its server\'s files', async () => {
    for (const path of ['/', '/mission', '/browser']) {
      const [a, b] = [await fetch(`${base}${path}`), await fetch(`${base}${path}`)];
      const d = directives(a.headers.get('content-security-policy') ?? '');
      const nonce = /^'nonce-([A-Za-z0-9+/=]+)'$/.exec(d.get('script-src') ?? '')?.[1];
      expect(nonce, path).toBeTruthy();
      expect(b.headers.get('content-security-policy'), path).not.toBe(a.headers.get('content-security-policy'));
      expect(d.get('default-src'), path).toBe("'none'");
      expect(d.get('connect-src'), path).toBe("'self'");
      expect(d.get('style-src'), path).toBe("'unsafe-inline'");
      expect(d.get('frame-ancestors'), path).toBe("'none'");
      expect(d.get('media-src'), path).toBe(path === '/mission' ? 'http: https:' : undefined);
      expect(a.headers.get('x-content-type-options'), path).toBe('nosniff');
      const html = await a.text();
      expect(html, path).not.toMatch(/\son[a-z]+\s*=/);
      const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
      expect(scripts.length, path).toBeGreaterThan(0);
      for (const s of scripts) expect(s, path).toBe(` nonce="${nonce}"`);
      expect(html, path).not.toContain('__TIMMY_NONCE__');
    }
    const chat = await fetch(`${base}/chat`);
    const d = directives(chat.headers.get('content-security-policy') ?? '');
    expect(d.get('script-src')).toBe("'self'");
    expect(d.get('style-src')).toMatch(/^'nonce-[A-Za-z0-9+/=]+'$/);
    const html = await chat.text();
    expect([...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1])).toEqual([' src="/chat/page.js"', ' type="module" src="/web/island/logs-chat.js"']);
    expect(html).not.toMatch(/esm\.sh|unpkg|https?:\/\/(?!127\.0\.0\.1)/);
    const js = await fetch(`${base}/chat/page.js`);
    expect(js.headers.get('content-type')).toMatch(/^text\/javascript/);
    expect(await js.text()).toContain('timmyLinks();');
  });

  it('the live logs page and its dispatch rail: live under its policy; a plan\'s hold button, wired by the page\'s script, asks the controller', async () => {
    const { page, context, seen, outside, errors } = await open('/');
    try {
      await page.waitForFunction(() => document.getElementById('conn')?.textContent === 'live', null, { timeout: 20_000 });
      await page.waitForSelector('button[data-act="hold"][data-plan="plan_synthetic"]', { timeout: 15_000 });
      await page.click('button[data-act="hold"][data-plan="plan_synthetic"]');
      await page.waitForFunction(() => true);
      await expect.poll(() => seen.find((s) => s.method === 'POST' && s.path === '/dispatch/action')?.body ?? '', { timeout: 10_000 }).toContain('"action":"hold"');
      expect(JSON.parse(seen.find((s) => s.path === '/dispatch/action')!.body)).toMatchObject({ id: 'plan_synthetic', action: 'hold' });
      expect(outside).toEqual([]);
      expect(await violations(page)).toEqual([]);
      expect(errors).toEqual([]);
      // an inline script the test adds is refused and reported
      await page.evaluate(() => { const s = document.createElement('script'); s.textContent = 'window.__inline = 1'; document.body.append(s); });
      await page.waitForFunction(() => ((window as unknown as { __violations: string[] }).__violations).length > 0, null, { timeout: 5_000 });
      expect((await violations(page)).join(' ')).toMatch(/script-src/);
      expect(await page.evaluate(() => (window as unknown as { __inline?: number }).__inline)).toBeUndefined();
    } finally { await context.close(); }
  });

  it('the mission studio: compile, send to controller, load state, play and stop work through the page\'s own wiring, under its policy', async () => {
    const { page, context, seen, outside, errors } = await open('/mission');
    try {
      await page.waitForFunction(() => /escrow/.test(document.getElementById('escrows')?.textContent ?? ''), null, { timeout: 20_000 });
      await page.click('button[data-run="compile"]');
      await page.waitForSelector('button[data-store="0"]', { timeout: 15_000 });
      expect(seen.some((s) => s.method === 'POST' && s.path === '/mission/compile')).toBe(true);
      await page.click('button[data-store="0"]');
      await page.waitForFunction(() => /stored|×/.test(document.getElementById('gw-0')?.textContent ?? ''), null, { timeout: 15_000 });
      expect(seen.some((s) => s.method === 'POST' && s.path === '/mission/store')).toBe(true);
      await page.click('button[data-run="loadState"]');
      await page.waitForFunction(() => /no theatre state|loaded/.test(document.getElementById('stateNote')?.textContent ?? ''), null, { timeout: 15_000 });
      expect(seen.some((s) => s.path.startsWith('/mission/theatre?folder='))).toBe(true);
      await page.click('button[data-run="play"]');
      await page.waitForFunction(() => /^t=\d/.test(document.getElementById('clock')?.textContent ?? '') && document.getElementById('clock')?.textContent !== 't=0.000', null, { timeout: 5_000 });
      await page.click('button[data-run="stop"]');
      expect(outside).toEqual([]);
      expect(await violations(page)).toEqual([]);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });

  it('the receipt browser: a receipt\'s verify button, wired by the page\'s script, checks it, under its policy', async () => {
    appendReceipt('runs', { kind: 'run', subject: 'SYNTHETIC logs receipt', policy: 'auto', status: 'ok' });
    const { page, context, seen, outside, errors } = await open('/browser');
    try {
      await page.waitForSelector('button[data-vf]', { timeout: 20_000 });
      const id = await page.getAttribute('button[data-vf]', 'data-vf');
      await page.click('button[data-vf]');
      await page.waitForFunction((i) => /body\+sig|sig|body/.test(document.getElementById(`vf-${i}`)?.textContent ?? ''), id, { timeout: 10_000 });
      expect(seen.some((s) => s.path.startsWith('/verify-receipt?') && s.path.includes(`id=${id}`))).toBe(true);
      expect(outside).toEqual([]);
      expect(await violations(page)).toEqual([]);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });

  it('the chat mirror draws the session\'s turns with Streamdown from the companion\'s own build, asking nothing of anywhere else', async () => {
    const { page, context, seen, outside, errors } = await open('/chat');
    try {
      await page.waitForFunction(() => document.querySelector('#left [data-streamdown="heading-2"]')?.textContent === 'SYNTHETIC mirror heading', null, { timeout: 20_000 });
      expect(await page.locator('#left [data-streamdown="code-block"]').count()).toBe(1);
      expect(seen.map((s) => s.path)).toEqual(expect.arrayContaining(['/chat', '/chat/page.js', '/web/island/logs-chat.js', '/chat/events']));
      expect(seen.some((s) => s.path.startsWith('/web/island/chunks/'))).toBe(true);
      expect(outside).toEqual([]);
      expect(await violations(page)).toEqual([]);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  });
});
