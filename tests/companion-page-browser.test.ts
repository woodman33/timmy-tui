/**
 * The browser companion's page (`timmy watch`) in a real headless Chromium against the real companion server on 127.0.0.1.
 *
 * R4 (H92): it loads nothing from the internet. Found on the Mac (r23c, row 173): the page loaded code from public CDNs
 * (about 1,130 requests to esm.sh for React and Streamdown, the Tailwind Play CDN, GSAP from cdnjs, Google Fonts,
 * Streamdown's CSS from unpkg), and that code ran with the page's rights (its token; /chat spends the operator's key).
 * R4 (H95): with its own design and its features back, as at b69ab12, still from this computer only: the page's style sheet
 * and its three fonts (Outfit, Inter, Fira Code: the companion's files), GSAP's tab fades through the browser's own
 * animations, and the STREAMDOWN CHAT tab is Streamdown again (React, Streamdown 2.5.0, Shiki highlighting, drawn Mermaid
 * diagrams, its copy and download buttons, tables, task lists, links, the streaming caret), bundled by
 * scripts/companion-web-build.mjs and served at /web/ (this test builds it first when it is missing or stale). Its receipt
 * and approval cards show what they were given and decide nothing.
 *
 * Every request the page makes, in any frame, is recorded; one to any other origin is aborted before it leaves, and the
 * browser resolves no name but 127.0.0.1, so even a failing run fetches nothing from elsewhere. The policy's violations are
 * collected in every frame (a script the test itself adds is refused and reported, which shows they are seen). The model is
 * a FAKE OpenRouter on 127.0.0.1. Skipped, saying so, where no Chromium or Chrome is found.
 *
 * R4 (H104): the CHAT MIRROR says where chat happens when none of this session has come (r24: an empty panel that said
 * nothing), and shows a REPL turn as the bus carries it (a FAKE receipt.sealed event appended to the bus file the companion
 * tails: its receipt, never words) beside this monitor's chat; the ✨ sample's diagram labels are measured on the drawn SVG
 * at 1440 and 390 wide, in the chat and in fullscreen (r24: about 6 px; now at least 12), with zoom, pan and fullscreen used.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureCompanionWeb } from '../scripts/companion-web-build.mjs';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { sealTurn } from '../src/repl/seal.js';

const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('companion-page-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

const FAKE_KEY = 'FAKE-openrouter-key-for-companion-page-tests';

/** What the FAKE OpenRouter answers: markdown of every kind Streamdown draws. */
const ANSWER = [
  '# Release notes',
  '',
  'A paragraph with **bold**, *emphasis*, `inline code` and a [docs link](https://docs.example/guide?x=1).',
  '',
  '## Steps',
  '',
  '- first item',
  '- second item with `code`',
  '',
  '- [x] a done task',
  '- [ ] an open task',
  '',
  '| a | b |',
  '|:--|--:|',
  '| 1 | 2 |',
  '',
  '```ts',
  'const answer: number = 42;',
  '```',
  '',
  '```mermaid',
  'graph LR',
  '  A[Prompt] --> B[Answer]',
  '```',
].join('\n');

/** A hostile answer: nothing in it may run, load from elsewhere or link anywhere but http, https or mailto. */
const HOSTILE = [
  'Here is **inert** content.',
  '',
  '<img src=x onerror="window.__pwned = \'img\'">',
  '',
  '<script>window.__pwned = \'script\'</script>',
  '',
  '<iframe src="http://192.0.2.7/frame"></iframe>',
  '',
  '[click me](javascript:window.__pwned=\'link\') and [data](data:text/html,<b>x</b>) and <a href="javascript:window.__pwned=\'raw\'">raw anchor</a> and <b onclick="window.__pwned=\'b\'">raw bold</b>',
  '',
  '[docs](https://docs.example/path?q=1) · <mailto:someone@example.com>',
  '',
  '![tracker](http://192.0.2.7/pixel.png)',
  '',
  '<style>body { display: none }</style>',
  '',
  '<receipt id="run_x" sha="sha256_00" onclick="window.__pwned=\'receipt\'">a receipt</receipt>',
  '',
  '```mermaid',
  '%%{init: {"securityLevel": "loose", "startOnLoad": true}}%%',
  'graph LR',
  '  A["<img src=x onerror=window.__pwned=1>"] --> B["<b onclick=window.__pwned=2>bold</b>"]',
  '  click A callback "a tooltip"',
  '  click B "javascript:window.__pwned=3" "x"',
  '```',
].join('\n');

/**
 * Every request a page made, every socket, every console line, refused dialog and page error. R4 (H104, r25's D11): every
 * answer of status 400 or more (`bad`, "<status> <url>") and every console error on its own (`consoleErrors`).
 */
interface Seen { requests: string[]; failed: string[]; outside: string[]; sockets: string[]; console: string[]; errors: string[]; dialogs: string[]; downloads: string[]; bad: string[]; consoleErrors: string[] }

/** The violations of the page's policy each frame reported (a listener the test adds before any page script runs). */
async function violations(page: Page): Promise<string[]> {
  const out: string[] = [];
  for (const f of page.frames()) {
    try { out.push(...await f.evaluate(() => (window as unknown as { __violations?: string[] }).__violations ?? [])); } catch { /* a frame gone */ }
  }
  return out;
}

/** sRGB relative luminance and the WCAG contrast ratio of two rgb()/rgba() colours. */
function contrast(a: string, b: string): number {
  const lum = (c: string): number => {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c);
    if (!m) throw new Error(`not a colour: ${c}`);
    const [r, g, bl] = [m[1], m[2], m[3]].map((v) => { const s = Number(v) / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

describe.skipIf(!browserPath)('the browser companion\'s page: its own look and features, nothing from the internet (R4 H92, H95), in a real browser', () => {
  const dirs: string[] = [];
  const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
  const saved: Record<string, string | undefined> = {};
  const ENV = ['TIMMY_REPO', 'OPENROUTER_API_KEY', 'TIMMY_HOME'];
  const originalCwd = process.cwd();
  let browser: Browser;
  let fake: Server;
  let server: CompanionServer;
  let base = '';
  const upstream: string[] = [];

  beforeAll(async () => {
    // the page's built chat: built here first when it is missing or stale (CI has no build)
    await ensureCompanionWeb();
    for (const k of ENV) saved[k] = process.env[k];
    const root = temp('h95-root-');
    mkdirSync(join(root, '.timmy', 'runs'), { recursive: true });
    writeFileSync(join(root, '.timmy', 'runs', 'timmy-events.jsonl'), `${JSON.stringify({ v: 1, ts: new Date().toISOString(), kind: 'test.h95-seeded', payload: { note: 'SYNTHETIC' } })}\n`);
    process.env.TIMMY_REPO = root;
    process.env.OPENROUTER_API_KEY = FAKE_KEY;
    process.env.TIMMY_HOME = temp('h95-home-');
    process.chdir(temp('h95-work-'));
    // FAKE OpenRouter: the hostile answer, a slow answer (for the caret) or the markdown answer; streamed in pieces that
    // cut through the markdown (a fence, a list, a link), so the page draws partial markdown on the way
    fake = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += String(c); });
      req.on('end', () => {
        upstream.push(body);
        const asked = String(JSON.parse(body).messages?.at(-1)?.content ?? '');
        const text = asked.includes('hostile') ? HOSTILE : ANSWER;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const pieces: string[] = [];
        const step = asked.includes('slow') ? 12 : Math.ceil(text.length / 5);
        for (let i = 0; i < text.length; i += step) pieces.push(`data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(i, i + step) } }] })}\n\n`);
        pieces.push(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { total_tokens: 99 } })}\n\n`);
        if (!asked.includes('slow')) { for (const p of pieces) res.write(p); res.end('data: [DONE]\n\n'); return; }
        let i = 0;
        const t = setInterval(() => {
          if (i < pieces.length) { res.write(pieces[i++]); return; }
          clearInterval(t);
          res.end('data: [DONE]\n\n');
        }, 60);
      });
    });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
    server = await startCompanionServer(0, { upstream: `http://127.0.0.1:${(fake.address() as AddressInfo).port}/chat/completions` });
    base = `http://127.0.0.1:${server.port}`;
    // the browser resolves no name but 127.0.0.1: nothing the page asks for can leave this computer
    browser = await chromium.launch({ headless: true, executablePath: browserPath, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  }, 600_000);

  afterAll(async () => {
    await browser?.close();
    await server?.shutdown();
    await new Promise<void>((r) => (fake ? fake.close(() => r()) : r()));
    process.chdir(originalCwd);
    for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  /**
   * The page in a fresh context, opened with the address Timmy gives; requests elsewhere are recorded and aborted. R4 (H104):
   * `viewport` (1400 x 900 unless given) and `on`, a companion of a test's own (the one this file starts unless given).
   */
  async function open(opts: { reducedMotion?: 'reduce'; viewport?: { width: number; height: number }; on?: CompanionServer } = {}): Promise<{ page: Page; context: BrowserContext; seen: Seen }> {
    const target = opts.on ?? server;
    const origin = `http://127.0.0.1:${target.port}`;
    const context = await browser.newContext({ viewport: opts.viewport ?? { width: 1400, height: 900 }, acceptDownloads: true, ...(opts.reducedMotion ? { reducedMotion: opts.reducedMotion } : {}) });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    const seen: Seen = { requests: [], failed: [], outside: [], sockets: [], console: [], errors: [], dialogs: [], downloads: [], bad: [], consoleErrors: [] };
    context.on('request', (r) => seen.requests.push(r.url()));
    context.on('response', (r) => { if (r.status() >= 400) seen.bad.push(`${r.status()} ${r.url()}`); });
    context.on('requestfailed', (r) => seen.failed.push(`${r.url()} ${r.failure()?.errorText ?? ''}`));
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin === origin) return route.continue();
      seen.outside.push(url.href);
      return route.abort('blockedbyclient');
    });
    await context.addInitScript(() => {
      const w = window as unknown as { __violations: string[] };
      w.__violations = [];
      document.addEventListener('securitypolicyviolation', (e) => { w.__violations.push(`${e.effectiveDirective} ${e.blockedURI}`); });
    });
    const page = await context.newPage();
    page.on('websocket', (ws) => seen.sockets.push(ws.url()));
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') seen.console.push(m.text());
      if (m.type() === 'error') seen.consoleErrors.push(`${m.text()} ${m.location().url ?? ''}`.trim());
    });
    page.on('pageerror', (e) => seen.errors.push(e.message));
    page.on('dialog', (d) => { seen.dialogs.push(d.message()); void d.dismiss(); });
    page.on('download', (d) => seen.downloads.push(d.suggestedFilename()));
    await page.goto(target.url);
    return { page, context, seen };
  }

  const connected = (page: Page): Promise<unknown> => page.waitForFunction(() => document.getElementById('status-text')?.textContent === 'COMPANION SOCKET · CONNECTED', null, { timeout: 30_000 });
  const tab = async (page: Page, name: string): Promise<void> => {
    await page.click(`[data-tab="${name}"]`);
    await page.waitForFunction((n) => { const p = document.getElementById(`tab-${n}`); return Boolean(p?.classList.contains('active') && getComputedStyle(p).opacity === '1' && p.getAnimations().length === 0); }, name, { timeout: 10_000 });
  };
  const idle = (page: Page): Promise<unknown> => page.waitForFunction(() => document.getElementById('sd-status')?.textContent === 'IDLE', null, { timeout: 30_000 });
  /** Asks the chat (its own input and Send button) and waits for the answer to finish streaming. */
  const ask = async (page: Page, words: string): Promise<void> => {
    await page.waitForSelector('#sd-input');
    await page.fill('#sd-input', words);
    await page.click('#sd-send');
    await page.waitForFunction(() => document.getElementById('sd-status')?.textContent === 'STREAMING…', null, { timeout: 10_000 }).catch(() => undefined);
    await idle(page);
  };
  /** The last answer's Mermaid block, scrolled into view (Streamdown draws a diagram when it is seen), drawn. */
  const drawn = async (page: Page): Promise<void> => {
    await page.locator('#sd-messages [data-streamdown="mermaid-block"]').last().scrollIntoViewIfNeeded();
    await page.waitForFunction(() => {
      const blocks = document.querySelectorAll('#sd-messages [data-streamdown="mermaid-block"]');
      const last = blocks[blocks.length - 1];
      return Boolean(last && (last.querySelector('[aria-label="Mermaid chart"] svg') || /Mermaid Error/.test(last.textContent ?? '')));
    }, null, { timeout: 30_000 });
  };

  it('loads only from its own server, through every tab and the chat\'s sample: every request of every frame to 127.0.0.1, its one socket its own, no policy violated, no error', async () => {
    const { page, context, seen } = await open();
    try {
      await connected(page);
      for (const name of ['workspace', 'logs', 'proof', 'canvas', 'streamdown', 'slate3d', 'chat']) {
        await tab(page, name);
        if (name === 'streamdown') {
          // the page's own sample: no model is asked
          await page.click('#sd-try');
          await page.waitForSelector('[data-card="approval"]', { timeout: 30_000 });
          await idle(page);
          await drawn(page);
          await page.locator('[data-card="receipt"] button').click();
          await page.waitForFunction(() => /Copied: timmy verify/.test(document.querySelector('[data-card="receipt"] button')?.textContent ?? ''), null, { timeout: 5_000 });
        }
        if (name === 'canvas') await page.waitForFunction(() => /Revision 0|No canvas jobs yet/.test(document.getElementById('canvas-summary')?.textContent ?? ''), null, { timeout: 15_000 });
        if (name === 'slate3d') {
          await page.waitForFunction(() => {
            const d = (document.getElementById('slate3d-frame') as HTMLIFrameElement | null)?.contentDocument;
            return Boolean(d && d.readyState === 'complete' && d.location.pathname.startsWith('/slate3d') && d.body);
          }, null, { timeout: 15_000 });
        }
      }
      await page.waitForTimeout(500);
      expect(seen.outside).toEqual([]);
      for (const r of seen.requests) expect(new URL(r).origin, r).toBe(base);
      // the chat's code, its styles and the page's fonts came from this server
      for (const p of ['/web/island/companion-chat.js', '/web/styles/tailwind.css', '/web/styles/streamdown.css', '/web/fonts/outfit-latin-wght-normal.woff2', '/web/fonts/inter-latin-wght-normal.woff2', '/web/fonts/fira-code-latin-wght-normal.woff2']) {
        expect(seen.requests, p).toContain(`${base}${p}`);
      }
      expect(seen.requests.some((r) => r.startsWith(`${base}/web/island/chunks/`))).toBe(true);
      // R4 (H97): nothing of the page H92 made and H95 replaced (its chat and markdown scripts, Timmy's theme, Monaspace's
      // files, marked): no page of the companion asks for any of them, so they are no longer shipped or served
      expect(seen.requests.filter((r) => /^\/(?:chat\.js|markdown\.js|timmy-theme\.css|fonts\/|vendor\/)/.test(new URL(r).pathname))).toEqual([]);
      expect(upstream).toEqual([]);
      expect(seen.sockets).toEqual([`ws://127.0.0.1:${server.port}/`]);
      expect(await violations(page)).toEqual([]);
      expect(seen.console.filter((l) => /Content Security Policy|Refused to/i.test(l))).toEqual([]);
      expect(seen.errors).toEqual([]);
      expect(seen.dialogs).toEqual([]);
    } finally { await context.close(); }
  });

  it('is served under its policy: scripts from itself only (no unsafe-inline, no unsafe-eval), inline styles for Mermaid alone, images from itself and data:; no inline script, handler or style in its markup; a script added on the page is refused', async () => {
    const r = await fetch(`${base}/`);
    const csp = r.headers.get('content-security-policy') ?? '';
    const directives = new Map(csp.split(';').map((d) => d.trim()).filter(Boolean).map((d) => { const [k, ...v] = d.split(/\s+/); return [k, v.join(' ')] as const; }));
    expect(directives.get('default-src')).toBe("'none'");
    expect(directives.get('script-src')).toBe("'self'");
    expect(directives.get('style-src')).toBe("'self' 'unsafe-inline'");
    expect(directives.get('img-src')).toBe("'self' data:");
    expect(directives.get('font-src')).toBe("'self'");
    expect(directives.get('connect-src')).toBe(`'self' ws://127.0.0.1:${server.port}`);
    expect(directives.get('object-src')).toBe("'none'");
    expect(directives.get('frame-ancestors')).toBe("'none'");
    expect(directives.get('base-uri')).toBe("'none'");
    expect(csp).not.toMatch(/unsafe-eval|wasm-unsafe-eval|https?:|\*|blob:/);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    const html = await r.text();
    const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const s of scripts) expect(s).toMatch(/\ssrc="\/[\w./-]+\.js"/);
    expect(html).not.toMatch(/<style\b|\sstyle=|\son[a-z]+=|importmap/i);
    expect(html).not.toMatch(/https?:\/\/(?!127\.0\.0\.1|localhost)/);
    // each file the page names is this server's, with its type, the same policy and nosniff; the page's own files name no
    // other site (the built chat's files carry its packages' licence comments, which name their sites as text: what the page
    // fetches is the browser checks' business, above and below)
    const named = [...html.matchAll(/\s(?:src|href)="(\/[^"#]+)"/g)].map((m) => m[1]).filter((p) => !p.startsWith('/slate3d'));
    expect(named).toEqual(expect.arrayContaining(['/companion.css', '/web/styles/tailwind.css', '/web/styles/streamdown.css', '/companion.js', '/web/island/companion-chat.js']));
    // R4 (H97): what H92's page had and H95's replaced is not served any more (no page asks for it: the test above)
    for (const p of ['/chat.js', '/markdown.js', '/timmy-theme.css', '/fonts/monaspace-argon-latin-400-normal.woff2', '/vendor/marked.esm.js']) {
      const gone = await fetch(`${base}${p}`);
      expect(gone.status, p).toBe(404);
      expect(await gone.text(), p).not.toMatch(/marked|@font-face|--timmy-|function\s*\(/);
    }
    // R4 (H104, r25's D11): the page names its icon, this server's own SVG
    expect(named).toContain('/favicon.svg');
    for (const p of named) {
      const a = await fetch(`${base}${p}`);
      expect(a.status, p).toBe(200);
      expect(a.headers.get('content-type'), p).toMatch(p.endsWith('.css') ? /^text\/css/ : p.endsWith('.svg') ? /^image\/svg\+xml/ : /^(text|application)\/javascript/);
      expect(a.headers.get('content-security-policy'), p).toBe(csp);
      expect(a.headers.get('x-content-type-options'), p).toBe('nosniff');
      // (an SVG names its own namespace, an identifier that is never fetched)
      if (!p.startsWith('/web/')) expect((await a.text()).replace('http://www.w3.org/2000/svg', ''), p).not.toMatch(/https?:\/\/(?!127\.0\.0\.1|localhost)/);
    }
    // in the browser: an inline script the test adds is refused and reported (so a violation would have been seen above)
    const { page, context } = await open();
    try {
      await connected(page);
      await page.evaluate(() => {
        const s = document.createElement('script');
        s.textContent = 'window.__inline = 1';
        document.body.append(s);
      });
      expect(await page.evaluate(() => (window as unknown as { __inline?: number }).__inline)).toBeUndefined();
      await page.waitForFunction(() => ((window as unknown as { __violations?: string[] }).__violations ?? []).length > 0, null, { timeout: 5_000 });
      expect((await violations(page)).join('\n')).toMatch(/script-src/);
    } finally { await context.close(); }
  });

  it('the chat draws an answer streamed from the FAKE upstream as Streamdown did: headings, lists, a task list, a table with its copy, a link, highlighted code with copy and download, a drawn Mermaid diagram with its PNG and SVG downloads', async () => {
    const { page, context, seen } = await open();
    try {
      await connected(page);
      await tab(page, 'streamdown');
      await ask(page, 'release notes please');
      const md = page.locator('#sd-messages .sd-answer').last();
      expect(await md.locator('[data-streamdown="heading-1"]').textContent()).toBe('Release notes');
      // b69ab12's cascade: the Tailwind classes before the page's own sheet, so the page's heading margins hold on an
      // answer's first block too (Streamdown's [&>*:first-child]:mt-0 loses the tie), as in the reconstruction
      expect(await md.locator('[data-streamdown="heading-1"]').evaluate((e) => [e === e.parentElement?.firstElementChild, getComputedStyle(e).marginTop])).toEqual([true, '16px']);
      expect(await md.locator('[data-streamdown="heading-2"]').textContent()).toBe('Steps');
      expect(await md.locator('[data-streamdown="strong"]').first().textContent()).toBe('bold');
      expect(await md.locator('[data-streamdown="inline-code"]').first().textContent()).toBe('inline code');
      // the task list: its boxes, as the answer marked them
      expect(await md.locator('input[type="checkbox"]').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).checked))).toEqual([true, false]);
      // the table, and Streamdown's own copy of it as markdown
      expect(await md.locator('[data-streamdown="table"] th').allTextContents()).toEqual(['a', 'b']);
      expect(await md.locator('[data-streamdown="table"] td').allTextContents()).toEqual(['1', '2']);
      await md.locator('button[title="Copy table"]').click();
      await page.locator('button', { hasText: /^Markdown$/ }).first().click();
      await page.waitForFunction(() => navigator.clipboard.readText().then((t) => t.includes('| a | b |')), null, { timeout: 5_000 });
      // the link: http(s), opened apart from this page, with no referrer
      const link = md.locator('a[data-streamdown="link"]', { hasText: 'docs link' });
      expect(await link.getAttribute('href')).toBe('https://docs.example/guide?x=1');
      expect(await link.getAttribute('target')).toBe('_blank');
      expect(await link.getAttribute('rel')).toMatch(/noreferrer/);
      // the code: highlighted by Shiki (its tokens coloured), copied and downloaded by Streamdown's own buttons
      const code = md.locator('[data-streamdown="code-block"]').filter({ hasText: 'const answer' });
      expect(await code.locator('pre').textContent()).toContain('const answer: number = 42;');
      // (Shiki loads the language's grammar first, then Streamdown draws the coloured tokens)
      await page.waitForFunction(() => {
        const block = [...document.querySelectorAll('#sd-messages [data-streamdown="code-block"]')].find((b) => b.textContent?.includes('const answer'));
        return Boolean(block && block.querySelectorAll('span[style*="--sdm-c"]').length > 3);
      }, null, { timeout: 15_000 });
      expect(new Set(await code.locator('span[style*="--sdm-c"]').evaluateAll((els) => els.map((e) => getComputedStyle(e).color))).size).toBeGreaterThan(1);
      await code.locator('[data-streamdown="code-block-copy-button"]').click();
      await page.waitForFunction(() => navigator.clipboard.readText().then((t) => t.includes('const answer: number = 42;')), null, { timeout: 5_000 });
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 10_000 }), code.locator('[data-streamdown="code-block-download-button"]').click()]);
      expect(dl.suggestedFilename()).toMatch(/\.ts$/);
      // the Mermaid diagram, drawn (Mermaid in its strict mode), and its PNG and SVG downloads
      await drawn(page);
      const svg = md.locator('[aria-label="Mermaid chart"] > svg');
      expect(await svg.count()).toBe(1);
      expect(await svg.textContent()).toMatch(/Prompt[\s\S]*Answer/);
      for (const kind of ['PNG', 'SVG']) {
        await md.locator('button[title="Download diagram"]').click();
        const [d] = await Promise.all([page.waitForEvent('download', { timeout: 10_000 }), page.locator('button', { hasText: new RegExp(`^${kind}$`) }).first().click()]);
        expect(d.suggestedFilename()).toBe(`diagram.${kind.toLowerCase()}`);
      }
      // the cost words: the provider's reported tokens, never an estimate passed off as measured
      expect(await page.textContent('#sd-tokens')).toBe('◉ 99 tokens (reported by the provider)');
      // one request upstream, with the conversation as sent
      expect(JSON.parse(upstream.at(-1)!).messages.at(-1)).toEqual({ role: 'user', content: 'release notes please' });
      expect(seen.outside).toEqual([]);
      expect(await violations(page)).toEqual([]);
      expect(seen.errors).toEqual([]);
    } finally { await context.close(); }
  });

  it('shows Streamdown\'s caret while an answer streams, and none once it has ended; the counter says an estimate is one', async () => {
    const { page, context } = await open();
    try {
      await connected(page);
      await tab(page, 'streamdown');
      await page.fill('#sd-input', 'a slow answer please');
      await page.click('#sd-send');
      const caret = (): Promise<string> => page.evaluate(() => {
        const root = [...document.querySelectorAll('#sd-messages .sd-island')].pop();
        const last = root?.lastElementChild;
        return last ? getComputedStyle(last, '::after').content : '';
      });
      await page.waitForFunction(() => document.querySelectorAll('#sd-messages .sd-island').length > 0 && document.getElementById('sd-status')?.textContent === 'STREAMING…', null, { timeout: 10_000 });
      await page.waitForFunction(() => {
        const root = [...document.querySelectorAll('#sd-messages .sd-island')].pop();
        return Boolean(root?.lastElementChild && getComputedStyle(root.lastElementChild, '::after').content.includes('▋'));
      }, null, { timeout: 10_000 });
      expect(await page.textContent('#sd-tokens')).toMatch(/^◉ ~\d+ tokens \(estimated while streaming\)$/);
      await idle(page);
      expect(await caret()).not.toContain('▋');
    } finally { await context.close(); }
  });

  it('the receipt and approval cards show what they were given, verify and decide nothing, and copy the commands that do', async () => {
    const { page, context } = await open();
    try {
      await connected(page);
      await tab(page, 'streamdown');
      await page.click('#sd-try');
      await page.waitForSelector('[data-card="approval"]', { timeout: 30_000 });
      await idle(page);
      const receipt = page.locator('[data-card="receipt"]');
      expect(await receipt.textContent()).toContain('RECEIPT · AS RECEIVED');
      expect(await receipt.textContent()).toContain('NOT VERIFIED HERE');
      // the id as the sample gave it (Streamdown's sanitizer prefixes ids; the card shows the given one)
      expect(await receipt.locator('.sd-receipt-id').textContent()).toBe('run_tmx_demo_001');
      expect(await receipt.locator('.sd-receipt-sha').textContent()).toBe('sha256_7f3c9a1e4b2d8c5f0a6e1d9b7c3f2a8e4d6b1c9f3a7e5d2b8c4f0a6e1d9b3c7f');
      expect(await receipt.textContent()).toContain('made up for this sample');
      const approval = page.locator('[data-card="approval"]');
      expect(await approval.locator('pre').textContent()).toBe('$ npm run build && npm test');
      expect(await approval.textContent()).toMatch(/Nothing is run or decided from this page.*NEEDS YOU/);
      // the buttons copy; nothing turns verified, granted or denied
      await receipt.locator('button').click();
      await page.waitForFunction(() => navigator.clipboard.readText().then((t) => t === 'timmy verify'), null, { timeout: 5_000 });
      await approval.locator('button').click();
      await page.waitForFunction(() => navigator.clipboard.readText().then((t) => t === 'npm run build && npm test'), null, { timeout: 5_000 });
      expect(await approval.locator('button').count()).toBe(1);
      const words = `${await receipt.textContent()} ${await approval.textContent()}`;
      expect(words).not.toMatch(/VERIFIED ✓|GRANTED|DENIED|AWAITING OPERATOR|\bSealed by\b/);
      expect(await receipt.textContent()).toContain('NOT VERIFIED HERE');
      // the sample is the page's own: no request went upstream for it
      expect(upstream.filter((b) => b.includes('Try it'))).toEqual([]);
    } finally { await context.close(); }
  });

  // R4 (H98): the sample says it is one wherever it is seen; a model's answer (the FAKE upstream's) and its cards do not
  it('the ✨ sample carries a visible SAMPLE label on its message, its answer and each card; a model\'s answer and its cards carry none', async () => {
    const { page, context, seen } = await open();
    try {
      await connected(page);
      await tab(page, 'streamdown');
      await page.click('#sd-try');
      await page.waitForSelector('[data-card="approval"]', { timeout: 30_000 });
      await idle(page);
      const label = async (scope: string): Promise<Array<{ text: string; shown: boolean }>> => page.$$eval(`${scope} [data-sample-label]`, (els) => els.map((e) => {
        const r = e.getBoundingClientRect();
        const css = getComputedStyle(e);
        return { text: (e.textContent ?? '').trim(), shown: r.width > 0 && r.height > 0 && css.visibility === 'visible' && css.display !== 'none' && Number(css.opacity) > 0 };
      }));
      expect(await label('.sd-user.sample')).toEqual([{ text: 'SAMPLE', shown: true }]);
      expect(await label('.sd-answer.sample > .sd-chips')).toEqual([{ text: 'SAMPLE · THE PAGE’S OWN TEXT · NO MODEL WAS ASKED', shown: true }]);
      expect(await label('.sd-answer.sample [data-card="receipt"] .sd-card-head')).toEqual([{ text: 'SAMPLE', shown: true }]);
      expect(await label('.sd-answer.sample [data-card="approval"] .sd-card-head')).toEqual([{ text: 'SAMPLE', shown: true }]);
      // a model's answer (FAKE upstream: it holds a <receipt> card) says no SAMPLE anywhere
      await ask(page, 'a hostile answer please');
      const answer = '.sd-answer[data-sample="no"]';
      await page.waitForSelector(`${answer} [data-card="receipt"]`, { timeout: 30_000 });
      expect(await label(answer)).toEqual([]);
      expect(await page.$$eval('.sd-user:not(.sample) [data-sample-label]', (els) => els.length)).toBe(0);
      expect(seen.errors).toEqual([]);
    } finally { await context.close(); }
  });

  it('a hostile answer is inert through Streamdown: an image with onerror, javascript: and data: links, raw script, frame and style, a card\'s handler, a Mermaid block with an init directive, click directives and HTML in its labels', async () => {
    const { page, context, seen } = await open();
    try {
      await connected(page);
      await tab(page, 'streamdown');
      await ask(page, 'a hostile answer please');
      await drawn(page);
      await page.waitForTimeout(800);
      const md = page.locator('#sd-messages .sd-answer').last();
      // outside Mermaid's own drawing (its SVG carries the <style> Mermaid writes for it), no such element; inside it, no script
      expect(await md.evaluate((el) => [...el.querySelectorAll('script, iframe, frame, object, embed, style, link, meta, base, form')].filter((e) => !e.closest('svg')).map((e) => e.tagName))).toEqual([]);
      expect(await md.locator('svg script, svg iframe, svg object, svg embed').count()).toBe(0);
      expect(await md.locator('[onclick], [onerror], [onload], [onmouseover]').count()).toBe(0);
      // links only to http, https and mailto; the javascript: and data: ones are not links
      const hrefs = await md.locator('a[href]').evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? ''));
      expect(hrefs).toContain('https://docs.example/path?q=1');
      for (const h of hrefs) expect(h, h).toMatch(/^(https?:\/\/|mailto:)/);
      expect(await md.locator('a', { hasText: 'click me' }).count()).toBe(0);
      expect(await md.locator('a', { hasText: 'raw anchor' }).count()).toBe(0);
      // the diagram, drawn in Mermaid's strict mode whatever its init directive asked: a clickable node is wrapped in an <a>
      // with no address at all (the javascript: one was dropped), its labels' HTML lost its handlers; clicking runs nothing
      const svg = md.locator('[aria-label="Mermaid chart"] > svg');
      expect(await svg.count()).toBe(1);
      expect(await svg.evaluate((el) => [...el.querySelectorAll('a')].map((a) => [a.getAttribute('href'), a.getAttributeNS('http://www.w3.org/1999/xlink', 'href')]))).toEqual([[null, null]]);
      expect(await svg.locator('[onclick], [onerror], [onload]').count()).toBe(0);
      for (const n of await svg.locator('g.node').all()) await n.click({ force: true }).catch(() => undefined);
      await page.locator('[data-card="receipt"]').last().click({ force: true });
      // nothing ran, nothing was fetched from elsewhere; the only refusals are the policy's, of the image elsewhere
      expect(await page.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned)).toBeUndefined();
      expect(seen.dialogs).toEqual([]);
      expect(seen.outside).toEqual([]);
      // the image elsewhere was refused by the page's policy before any request left (the browser reports the attempt, and
      // its failure: csp; the test's route, which would have aborted it, never saw it); a label's <img src="x">, its handler
      // removed, asks this server for /x: a 404 in words, inert
      const elsewhere = seen.requests.filter((r) => new URL(r).origin !== base);
      expect(elsewhere.length).toBeGreaterThan(0);
      for (const r of elsewhere) expect(r).toBe('http://192.0.2.7/pixel.png');
      for (const r of elsewhere) expect(seen.failed, r).toContain(`${r} csp`);
      for (const v of await violations(page)) expect(v).toBe('img-src http://192.0.2.7/pixel.png');
      expect(await page.isVisible('#sd-messages')).toBe(true);
      expect(seen.errors).toEqual([]);
    } finally { await context.close(); }
  });

  it('its three fonts are its own files, each loaded: Outfit for headings, Inter for text, Fira Code for code', async () => {
    const { page, context, seen } = await open();
    try {
      await connected(page);
      await page.evaluate(() => document.fonts.ready);
      const fonts = await page.evaluate(() => [...document.fonts].map((f) => `${f.family.replace(/["']/g, '')} ${f.status}`).sort());
      expect(fonts).toEqual(expect.arrayContaining(['Fira Code loaded', 'Inter loaded', 'Outfit loaded']));
      expect(await page.evaluate(() => getComputedStyle(document.querySelector('h1')!).fontFamily)).toMatch(/^"?Outfit"?/);
      expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toMatch(/^"?Inter"?/);
      expect(await page.evaluate(() => getComputedStyle(document.getElementById('status')!).fontFamily)).toMatch(/^"?Fira Code"?/);
      for (const f of ['outfit', 'inter', 'fira-code']) expect(seen.requests).toContain(`${base}/web/fonts/${f}-latin-wght-normal.woff2`);
      expect(seen.outside).toEqual([]);
    } finally { await context.close(); }
  });

  it('the tabs fade with GSAP\'s timing (out 0.15 s power2.in, then in 0.25 s power2.out), and switch at once where reduced motion is asked', async () => {
    const record = (page: Page): Promise<void> => page.evaluate(() => {
      const w = window as unknown as { __anims: Array<{ id: string; from: unknown; to: unknown; duration: unknown; easing: unknown }> };
      w.__anims = [];
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (this: Element, frames: Keyframe[] | PropertyIndexedKeyframes | null, options?: number | KeyframeAnimationOptions) {
        const k = frames as Keyframe[];
        const o = options as KeyframeAnimationOptions;
        w.__anims.push({ id: this.id, from: k?.[0]?.opacity, to: k?.[1]?.opacity, duration: o?.duration, easing: o?.easing });
        return animate.call(this, frames, options);
      };
    });
    const moving = await open();
    try {
      await connected(moving.page);
      await record(moving.page);
      await tab(moving.page, 'workspace');
      expect(await moving.page.evaluate(() => (window as unknown as { __anims: unknown[] }).__anims)).toEqual([
        { id: 'tab-chat', from: 1, to: 0, duration: 150, easing: 'cubic-bezier(0.32, 0, 0.67, 0)' },
        { id: 'tab-workspace', from: 0, to: 1, duration: 250, easing: 'cubic-bezier(0.33, 1, 0.68, 1)' },
      ]);
    } finally { await moving.context.close(); }
    const still = await open({ reducedMotion: 'reduce' });
    try {
      await connected(still.page);
      await record(still.page);
      await still.page.click('[data-tab="logs"]');
      await still.page.waitForFunction(() => document.getElementById('tab-logs')?.classList.contains('active'), null, { timeout: 5_000 });
      expect(await still.page.evaluate(() => (window as unknown as { __anims: unknown[] }).__anims)).toEqual([]);
      expect(await still.page.evaluate(() => getComputedStyle(document.querySelector('.log-line')!).animationName)).toBe('none');
    } finally { await still.context.close(); }
  });

  it('Slate 3D\'s words, where its bundle is not built, are in the page\'s own text colour on its frame\'s ground', async () => {
    const { page, context, seen } = await open();
    try {
      await connected(page);
      await tab(page, 'slate3d');
      const frame = page.frameLocator('#slate3d-frame');
      await frame.locator('body').waitFor({ timeout: 15_000 });
      const look = await frame.locator('body').evaluate((b) => {
        const p = b.querySelector('p') ?? b;
        return { text: p.textContent ?? '', color: getComputedStyle(p).color, ground: getComputedStyle(b).backgroundColor, font: getComputedStyle(p).fontFamily };
      });
      if (!/Slate 3D is not part of this installation/.test(look.text)) {
        console.warn('companion-page-browser: Slate 3D is built here, so its absence words were not checked');
        return;
      }
      // the page's --text-main (#e6edf3) on the frame's ground (#0A1628), in Inter
      expect(look.color).toBe('rgb(230, 237, 243)');
      expect(look.ground).toBe('rgb(10, 22, 40)');
      expect(look.font).toMatch(/^"?Inter"?/);
      expect(contrast(look.color, look.ground)).toBeGreaterThan(7);
      expect(seen.outside).toEqual([]);
      expect(await violations(page)).toEqual([]);
    } finally { await context.close(); }
  });

  it('its sheet holds b69ab12\'s design: the same palette, glass panels, glows, gradient title and tab look', () => {
    const css = readFileSync(new URL('../src/companion/client/companion.css', import.meta.url), 'utf8');
    for (const rule of [
      '--bg-base: #07090e;', '--bg-card: rgba(13, 17, 23, 0.75);', '--border-color: #21262d;', '--text-main: #e6edf3;', '--text-muted: #8b949e;',
      "--font-outfit: 'Outfit', sans-serif;", "--font-inter: 'Inter', sans-serif;", "--font-fira: 'Fira Code', monospace;",
      'background: radial-gradient(circle, var(--secondary-glow) 0%, transparent 70%);', 'filter: blur(80px);',
      'background: linear-gradient(135deg, var(--text-main), var(--secondary-hsl));', 'backdrop-filter: blur(12px);',
      'box-shadow: 0 0 20px hsla(var(--secondary-h), 80%, 60%, 0.35);', 'transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);',
    ]) expect(css, rule).toContain(rule);
  });

  // ---------- R4 (H104): the chat mirror (r24: empty, nothing said why) and readable diagrams (r24: labels about 6 px) ----------

  /** A companion of a test's own, its bus in a folder of its own (it reads TIMMY_REPO as it starts); `seed`: lines on its bus already. */
  async function ownCompanion(seed: object[] = []): Promise<{ own: CompanionServer; bus: string; root: string }> {
    const root = temp('h104-root-');
    mkdirSync(join(root, '.timmy', 'receipts'), { recursive: true });
    const bus = join(root, '.timmy', 'receipts', 'runs.jsonl');
    writeFileSync(bus, seed.map((e) => `${JSON.stringify(e)}\n`).join(''));
    const was = process.env.TIMMY_REPO;
    process.env.TIMMY_REPO = root;
    try { return { own: await startCompanionServer(0, {}), bus, root }; } finally { process.env.TIMMY_REPO = was; }
  }

  /**
   * FAKE: the bus event Timmy publishes when the REPL seals a turn's receipt (src/utils/receipts.ts appendReceipt publishes
   * receipt.sealed; src/repl/seal.ts gives a turn kind `turn` and its subject). No REPL runs here and nothing is sealed.
   */
  const fakeTurn = (at: Date, subject: string, kind = 'turn') => ({
    v: 1, ts: at.toISOString(), kind: 'receipt.sealed',
    payload: { stream: 'runs', id: 'FAKE-turn-receipt', hash: `sha256_${randomBytes(32).toString('hex')}`, kind, subject, epoch: 1 },
  });

  for (const viewport of [{ width: 1400, height: 900 }, { width: 390, height: 844 }]) it(`the chat mirror with no chat in this session says so and since when, where chat happens, and why a REPL turn has no words, readable at ${viewport.width} wide; no sample is in it; a turn sealed before this companion started is not shown (R4 H104)`, async () => {
    // FAKE: a REPL turn sealed an hour before this companion started: on its bus, not of this session
    const { own } = await ownCompanion([fakeTurn(new Date(Date.now() - 3_600_000), 'repl · 1 step')]);
    const { page, context, seen } = await open({ on: own, viewport });
    try {
      await connected(page);
      // the tail reached the page (its log says so), then the mirror is read
      await page.waitForFunction(() => /Event bus: 1 recent event, latest receipt\.sealed/.test(document.getElementById('logs-list')?.textContent ?? ''), null, { timeout: 15_000 });
      await page.waitForFunction(() => /since this companion started at/.test(document.querySelector('#console-logs [data-mirror="empty"]')?.textContent ?? ''), null, { timeout: 10_000 });
      // seen, not only present: the words have room in the panel (at 390 wide the panel was its header alone)
      expect(await page.isVisible('#console-logs [data-mirror="empty"]')).toBe(true);
      const room = await page.evaluate(() => {
        const logs = document.getElementById('console-logs')!.getBoundingClientRect();
        const head = document.querySelector('#console-logs .mirror-empty-head')!.getBoundingClientRect();
        return { logs: logs.height, headInside: head.top >= logs.top && head.bottom <= logs.bottom && head.height > 0 };
      });
      expect(room.logs).toBeGreaterThan(200);
      expect(room.headInside).toBe(true);
      const words = (await page.textContent('#console-logs'))!.replace(/\s+/g, ' ').trim();
      expect(words).toMatch(/^No chat in this session yet: none has reached this page since this companion started at \d/);
      expect(words).toContain('Chat happens in Timmy\'s terminal, not on this page:');
      expect(words).toContain('In this monitor (timmy watch), type in its chat line: each message and its answer appear here as they are sent.');
      expect(words).toContain('In the REPL (timmy), each turn appears here when it ends, as the receipt Timmy sealed for it. Its words stay in the REPL (a REPL turn\'s prompt and answer are sealed as hashes only).');
      expect(words).toContain('A REPL turn is seen here when the REPL works in the folder this monitor was started in (or the one TIMMY_REPO names)');
      expect(words).toContain('STREAMDOWN CHAT is this page\'s own chat with a model; its ✨ sample is labelled SAMPLE there and is never shown here.');
      expect(words).not.toMatch(/Waiting for session chat streams/);
      expect(await page.textContent('#mirror-status')).toBe('Local chat mirror: WAITING');
      // the hour-old turn is not this session's; and nothing of the sample is in the mirror
      expect(await page.locator('#console-logs [data-mirror="repl-turn"]').count()).toBe(0);
      expect(await page.locator('#console-logs [data-sample-label], #console-logs [data-card]').count()).toBe(0);
      expect(words).not.toMatch(/run_tmx_demo_001|TMX P3|streaming markdown surface/);
      expect(seen.outside).toEqual([]);
      for (const r of seen.requests) expect(new URL(r).origin, r).toBe(`http://127.0.0.1:${own.port}`);
      expect(await violations(page)).toEqual([]);
      expect(seen.errors).toEqual([]);
    } finally { await context.close(); await own.shutdown(); }
  });

  it('a REPL turn the bus carries (a FAKE receipt.sealed event appended to the bus file the companion tails) appears in the mirror: its receipt and steps, no words; with this monitor\'s chat in time order; once; a monitor chat receipt is not a REPL turn (R4 H104)', async () => {
    const { own, bus } = await ownCompanion();
    const { page, context, seen } = await open({ on: own });
    try {
      await connected(page);
      await page.waitForSelector('#console-logs [data-mirror="empty"]');
      const first = fakeTurn(new Date(), 'repl · 2 steps');
      appendFileSync(bus, `${JSON.stringify(first)}\n`);
      await page.waitForSelector('#console-logs [data-mirror="repl-turn"]', { timeout: 15_000 });
      const row = (await page.textContent('#console-logs [data-mirror="repl-turn"]'))!.replace(/\s+/g, ' ').trim();
      expect(row).toMatch(/^⌨ REPL turn · ended \d/);
      expect(row).toContain(`A chat turn in the REPL (timmy) ended (2 steps); Timmy sealed it as receipt ${first.payload.hash.slice(7, 15)}. Its words are in the REPL: Timmy seals a REPL turn's prompt and answer as hashes only, so they are not on the event bus and are not shown here.`);
      expect(await page.locator('#console-logs [data-mirror="empty"]').count()).toBe(0);
      await page.waitForFunction(() => document.getElementById('mirror-status')?.textContent === 'Local chat mirror: LIVE', null, { timeout: 5_000 });
      // this monitor's chat as its terminal sends it (sync), around a second, cancelled REPL turn: one list, in time order
      const t0 = Date.now();
      own.sendUpdate('sync', [{ role: 'user', content: 'FAKE: a message typed in the monitor', timestamp: t0 + 1000 }, { role: 'assistant', content: 'FAKE: its answer', timestamp: t0 + 3000 }]);
      appendFileSync(bus, `${JSON.stringify(fakeTurn(new Date(t0 + 2000), 'repl · cancelled · 1 step'))}\n`);
      // a monitor chat turn's receipt (kind chat): its words came with sync; it is not a REPL turn
      appendFileSync(bus, `${JSON.stringify(fakeTurn(new Date(t0 + 2500), 'chat.turn · FAKE-model', 'chat'))}\n`);
      await page.waitForFunction(() => document.querySelectorAll('#console-logs [data-mirror="repl-turn"]').length === 2 && /FAKE: its answer/.test(document.getElementById('console-logs')?.textContent ?? ''), null, { timeout: 15_000 });
      // all three events reached the page (its log names each) before the mirror is read
      await page.waitForFunction(() => ((document.getElementById('logs-list')?.textContent ?? '').match(/Event bus: receipt\.sealed/g) ?? []).length >= 3, null, { timeout: 15_000 });
      const order = await page.$$eval('#console-logs .log-msg', (els) => els.map((e) => (e.querySelector('.log-header span')?.textContent ?? '').trim()));
      expect(order).toEqual(['⌨ REPL turn · ended', '▶ You', '⌨ REPL turn · cancelled', '◀ TIMMY Agent']);
      expect((await page.locator('#console-logs [data-mirror="repl-turn"]').nth(1).textContent())!.replace(/\s+/g, ' ')).toContain('A chat turn in the REPL (timmy) cancelled (1 step);');
      // the same sealed turn again (as a reconnect's tail brings it) is still one row
      appendFileSync(bus, `${JSON.stringify(first)}\n`);
      await page.waitForTimeout(1_500);
      expect(await page.locator('#console-logs [data-mirror="repl-turn"]').count()).toBe(2);
      expect(seen.outside).toEqual([]);
      for (const r of seen.requests) expect(new URL(r).origin, r).toBe(`http://127.0.0.1:${own.port}`);
      expect(await violations(page)).toEqual([]);
      expect(seen.errors).toEqual([]);
    } finally { await context.close(); await own.shutdown(); }
  });

  it('a turn sealed by the REPL\'s own code (src/repl/seal.ts sealTurn: a real signed receipt, in a store of the test\'s own pinned in its folder) appears in the mirror with the receipt the REPL prints and its steps, and none of its words (R4 H104)', async () => {
    const { own, root } = await ownCompanion();
    // the test's own store: a pin in its folder, so the receipt is sealed there and nowhere else (src/utils/receipts.ts rootStoreDir)
    writeFileSync(join(root, '.timmy', 'store-pin'), join(root, '.timmy', 'receipts'));
    const { page, context, seen } = await open({ on: own });
    try {
      await connected(page);
      await page.waitForSelector('#console-logs [data-mirror="empty"]');
      // SYNTHETIC turn facts (no model was asked); the sealing, its signature, its chain and its bus event are the real ones
      const sealed = sealTurn({ prompt: 'SYNTHETIC prompt, never shown', answer: 'SYNTHETIC answer, never shown', steps: 3, spend: 0, costMeasured: false, ms: 1_200, status: 'ok', model: 'SYNTHETIC/model' }, root);
      expect(sealed.verified).toBe(true);
      expect(readFileSync(join(root, '.timmy', 'receipts', 'runs.jsonl'), 'utf8')).toContain(sealed.hash);
      await page.waitForSelector('#console-logs [data-mirror="repl-turn"]', { timeout: 15_000 });
      const row = (await page.textContent('#console-logs [data-mirror="repl-turn"]'))!.replace(/\s+/g, ' ');
      expect(row).toContain(`A chat turn in the REPL (timmy) ended (3 steps); Timmy sealed it as receipt ${sealed.id}.`);
      expect(await page.textContent('#console-logs')).not.toMatch(/SYNTHETIC (prompt|answer)/);
      await page.waitForFunction(() => document.getElementById('mirror-status')?.textContent === 'Local chat mirror: LIVE', null, { timeout: 5_000 });
      expect(seen.outside).toEqual([]);
      expect(await violations(page)).toEqual([]);
      expect(seen.errors).toEqual([]);
    } finally { await context.close(); await own.shutdown(); }
  });

  /** The drawn sample diagram's text as shown on screen: each label's size (its font size at the drawing's scale on screen). */
  const shownLabels = (page: Page, where: 'chat' | 'fullscreen') => page.evaluate((w) => {
    const svg = [...document.querySelectorAll('[aria-label="Mermaid chart"] > svg')].find((s) => (w === 'chat') === Boolean(s.closest('#streamdown-root'))) as SVGSVGElement | undefined;
    if (!svg) return null;
    const box = svg.viewBox.baseVal;
    const rect = svg.getBoundingClientRect();
    const scale = rect.width / box.width;
    const labels: Array<{ text: string; px: number; boxPx: number; left: number; right: number }> = [];
    const walker = document.createTreeWalker(svg, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement!;
      if (!n.nodeValue?.trim() || el.closest('style, title, desc')) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      const r = range.getBoundingClientRect();
      // its font size, scaled as the drawing is shown; and, apart from that, the height of its text's own box on screen
      labels.push({ text: n.nodeValue.trim(), px: parseFloat(getComputedStyle(el).fontSize) * scale, boxPx: r.height, left: r.left, right: r.right });
    }
    return { scale, left: rect.left, labels };
  }, where);

  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    it(`the ✨ sample's diagram labels are at least 12 px at ${viewport.width} wide, in the chat and in fullscreen, its start shown first; zoom, pan, Reset and fullscreen work; the column fits the window; nothing from elsewhere, no policy violated (R4 H104)`, async () => {
      const { page, context, seen } = await open({ viewport });
      try {
        await connected(page);
        await tab(page, 'streamdown');
        await page.click('#sd-try');
        await page.waitForSelector('[data-card="approval"]', { timeout: 30_000 });
        await idle(page);
        await drawn(page);
        const block = page.locator('#sd-messages [data-streamdown="mermaid-block"]').last();
        // the drawing given its size (data-fit, by the chat's script); what is measured below decides, whether or not it is
        await page.waitForFunction(() => Boolean(document.querySelector('#streamdown-root [aria-label="Mermaid chart"] > svg[data-fit]')), null, { timeout: 5_000 }).catch(() => undefined);
        const shown = (await shownLabels(page, 'chat'))!;
        expect(shown.labels.map((l) => l.text)).toEqual(['User Prompt', 'POST /chat SSE', 'Streamdown Parser', 'receipt Card', 'approval Gate', 'Mermaid Diagram']);
        for (const l of shown.labels) {
          expect(l.px, `${l.text} at ${viewport.width}`).toBeGreaterThanOrEqual(12);
          expect(l.boxPx, `${l.text}'s text box at ${viewport.width}`).toBeGreaterThanOrEqual(12);
        }
        // its start is shown first: the first label is inside the diagram's block
        const area = block.locator('[role="application"]');
        const blockBox = (await block.boundingBox())!;
        expect(shown.labels[0].left).toBeGreaterThanOrEqual(blockBox.x);
        // the page's column fits the window (at 390 it was laid out 712 px wide)
        expect(await page.evaluate(() => document.querySelector('.right-col')!.getBoundingClientRect().right)).toBeLessThanOrEqual(viewport.width + 1);
        // zoom in, zoom out, Reset: Streamdown's own buttons scale the drawing
        const settle = (): Promise<void> => page.waitForTimeout(400); // its transform eases in 150 ms
        await block.locator('button[title="Zoom in"]').click();
        await settle();
        expect((await shownLabels(page, 'chat'))!.scale / shown.scale).toBeCloseTo(1.1, 2);
        await block.locator('button[title="Zoom out"]').click();
        await block.locator('button[title="Zoom out"]').click();
        await settle();
        expect((await shownLabels(page, 'chat'))!.scale / shown.scale).toBeCloseTo(0.9, 2);
        await block.locator('button[title="Reset zoom and pan"]').click();
        await settle();
        expect((await shownLabels(page, 'chat'))!.scale).toBeCloseTo(shown.scale, 3);
        // pan: a drag moves the drawing by as much; Reset brings it back
        const a = (await area.boundingBox())!;
        await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
        await page.mouse.down();
        await page.mouse.move(a.x + a.width / 2 - 120, a.y + a.height / 2, { steps: 12 });
        await page.mouse.up();
        await settle();
        expect((await shownLabels(page, 'chat'))!.left - shown.left).toBeCloseTo(-120, 0);
        await block.locator('button[title="Reset zoom and pan"]').click();
        await settle();
        expect((await shownLabels(page, 'chat'))!.left).toBeCloseTo(shown.left, 0);
        // fullscreen: the drawing in Streamdown's own view (in the page's body), its labels at least 12 px too; Escape closes it
        await block.locator('[data-streamdown="mermaid-block-actions"] button[title="View fullscreen"]').click();
        await page.waitForFunction(() => [...document.querySelectorAll('[aria-label="Mermaid chart"] > svg')].some((s) => !s.closest('#streamdown-root')), null, { timeout: 15_000 });
        await page.waitForFunction(() => [...document.querySelectorAll('[aria-label="Mermaid chart"] > svg[data-fit]')].some((s) => !s.closest('#streamdown-root')), null, { timeout: 5_000 }).catch(() => undefined);
        const full = (await shownLabels(page, 'fullscreen'))!;
        expect(full.labels.map((l) => l.text)).toContain('User Prompt');
        for (const l of full.labels) expect(l.px, `fullscreen ${l.text} at ${viewport.width}`).toBeGreaterThanOrEqual(12);
        expect(full.labels[0].left).toBeGreaterThanOrEqual(0);
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => document.querySelectorAll('[aria-label="Mermaid chart"] > svg').length === 1, null, { timeout: 5_000 });
        // nothing from elsewhere; the policy refused nothing; no error
        expect(seen.outside).toEqual([]);
        for (const r of seen.requests) expect(new URL(r).origin, r).toBe(base);
        expect(await violations(page)).toEqual([]);
        expect(seen.errors).toEqual([]);
      } finally { await context.close(); }
    });
  }

  // R4 (H104, r25's D11): the page logged one 404 on the Mac (the browser's own /favicon.ico: the page declared no icon); and an
  // installed companion's SLATE 3D tab (the package never ships Slate 3D's bundle) answered 404, logged as a failed load
  it('the page, its icon and every tab answer with no 4xx or 5xx and put no error in the console; the icon is the companion\'s own SVG in Timmy Homebrew\'s colours (r25 D11)', async () => {
    const { page, context, seen } = await open();
    try {
      await connected(page);
      for (const name of ['workspace', 'logs', 'proof', 'canvas', 'streamdown', 'slate3d', 'chat']) {
        await tab(page, name);
        if (name === 'streamdown') {
          await page.click('#sd-try');
          await page.waitForSelector('[data-card="approval"]', { timeout: 30_000 });
          await idle(page);
          await drawn(page);
        }
        if (name === 'canvas') await page.waitForFunction(() => /Revision 0|No canvas jobs yet/.test(document.getElementById('canvas-summary')?.textContent ?? ''), null, { timeout: 15_000 });
        if (name === 'slate3d') {
          await page.waitForFunction(() => {
            const d = (document.getElementById('slate3d-frame') as HTMLIFrameElement | null)?.contentDocument;
            return Boolean(d && d.readyState === 'complete' && d.location.pathname.startsWith('/slate3d') && d.body);
          }, null, { timeout: 15_000 });
        }
      }
      await page.waitForTimeout(1_000);
      // nothing answered 400 or more, and the console holds no error (it held "Failed to load resource … 404")
      expect(seen.bad).toEqual([]);
      expect(seen.consoleErrors).toEqual([]);
      // the icon the page declares: asked for by this browser (it asks for a page's icon), and this server's own
      expect(await page.evaluate(() => [...document.querySelectorAll('link[rel="icon"]')].map((l) => [l.getAttribute('href'), l.getAttribute('type')]))).toEqual([['/favicon.svg', 'image/svg+xml']]);
      expect(seen.requests).toContain(`${base}/favicon.svg`);
      for (const p of ['/favicon.svg', '/favicon.ico']) {
        const icon = await fetch(`${base}${p}`);
        expect(icon.status, p).toBe(200);
        expect(icon.headers.get('content-type'), p).toMatch(/^image\/svg\+xml/);
        const svg = await icon.text();
        expect(svg, p).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
        // Timmy Homebrew's charcoal surface and green (src/theme/tokens.ts), and no script or other site
        expect(svg, p).toContain('fill="#121212"');
        expect(svg, p).toContain('stroke="#28FE14"');
        expect(svg.replace('http://www.w3.org/2000/svg', ''), p).not.toMatch(/<script|https?:|href=/i);
      }
      expect(seen.errors).toEqual([]);
      expect(seen.outside).toEqual([]);
      expect(await violations(page)).toEqual([]);
    } finally { await context.close(); }
  });
});
