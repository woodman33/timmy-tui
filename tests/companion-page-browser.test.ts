/**
 * R4 (H92): the browser companion's page (`timmy watch`) loads nothing from the internet. Found on the Mac (r23c, row 173):
 * the page loaded code from public CDNs (about 1,130 requests to esm.sh for React and Streamdown, the Tailwind Play CDN, GSAP
 * from cdnjs, Google Fonts, Streamdown's CSS from unpkg), and that code ran with the page's rights, so it could read the
 * page's token and use the companion's routes (/chat spends the operator's OpenRouter key).
 *
 * In a real headless Chromium against the real companion server on 127.0.0.1. Every request the page makes, in any frame,
 * is recorded; one to any other origin is aborted before it leaves, and the browser resolves no name but 127.0.0.1, so even
 * a failing run fetches nothing from elsewhere. The page is served under a strict Content-Security-Policy, and no violation
 * of it is reported while the page loads and is used (a script the test itself tries to add is refused, which shows the
 * violations are seen). The model chat renders markdown with the page's own renderer, on `marked` served from the package:
 * headings, lists, code with a copy button, a mermaid block shown as its source; a hostile answer (an image with an onerror,
 * a javascript: link, raw HTML, a script) stays text. The model is a FAKE OpenRouter on 127.0.0.1. Skipped, saying so,
 * where no Chromium or Chrome is found.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMPANION_RUNTIME_FILES, startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { HOMEBREW } from '../src/theme/tokens.js';

const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('companion-page-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

const FAKE_KEY = 'FAKE-openrouter-key-for-companion-page-tests';

/** What the FAKE OpenRouter answers: markdown of every kind the renderer draws. */
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
  '3. three',
  '4. four',
  '',
  '```ts',
  'const answer: number = 42;',
  'console.log(answer < 43 && "<b>not bold</b>");',
  '```',
  '',
  '```mermaid',
  'graph LR',
  '  A[Prompt] --> B[Answer]',
  '```',
  '',
  '> a quoted line',
  '',
  '| a | b |',
  '|:--|--:|',
  '| 1 | 2 |',
].join('\n');

/** A hostile answer: every piece of it must stay text (or a link only to http, https or mailto). */
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
  '[docs](https://docs.example/path?q=1) · <mailto:someone@example.com> · [relative](/api/canvas)',
  '',
  '![tracker](http://192.0.2.7/pixel.png)',
  '',
  '<style>body { display: none }</style>',
].join('\n');

/** Every request a page made, every socket, every console line, refused dialog and page error, from every frame. */
interface Seen { requests: string[]; outside: string[]; sockets: string[]; console: string[]; errors: string[]; dialogs: string[] }

/** The violations of the page's policy each frame reported (a listener the test adds before any page script runs). */
async function violations(page: Page): Promise<string[]> {
  const out: string[] = [];
  for (const f of page.frames()) {
    try { out.push(...await f.evaluate(() => (window as unknown as { __violations?: string[] }).__violations ?? [])); } catch { /* a frame gone */ }
  }
  return out;
}

/** sRGB relative luminance and the WCAG contrast ratio of two colours given as rgb()/rgba() or #rrggbb. */
function rgb(c: string): [number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(c);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)) as [number, number, number];
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c);
  if (!m) throw new Error(`not a colour: ${c}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
function contrast(a: string, b: string): number {
  const lum = (c: string): number => {
    const [r, g, bl] = rgb(c).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

describe.skipIf(!browserPath)('the browser companion\'s page loads nothing from the internet (R4 H92), in a real browser', () => {
  const dirs: string[] = [];
  const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
  const saved: Record<string, string | undefined> = {};
  const ENV = ['TIMMY_REPO', 'OPENROUTER_API_KEY', 'TIMMY_HOME'];
  const originalCwd = process.cwd();
  let browser: Browser;
  let fake: Server;
  let fakeUrl = '';
  let server: CompanionServer;
  let base = '';
  const upstream: string[] = [];

  beforeAll(async () => {
    for (const k of ENV) saved[k] = process.env[k];
    const root = temp('h92-root-');
    mkdirSync(join(root, '.timmy', 'runs'), { recursive: true });
    writeFileSync(join(root, '.timmy', 'runs', 'timmy-events.jsonl'), `${JSON.stringify({ v: 1, ts: new Date().toISOString(), kind: 'test.h92-seeded', payload: { note: 'SYNTHETIC' } })}\n`);
    process.env.TIMMY_REPO = root;
    process.env.OPENROUTER_API_KEY = FAKE_KEY;
    process.env.TIMMY_HOME = temp('h92-home-');
    process.chdir(temp('h92-work-'));
    // FAKE OpenRouter: the hostile answer when asked for it, else the markdown answer; streamed in pieces that cut through
    // the markdown (a fence, a list, a link), so the page renders partial markdown on the way
    fake = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += String(c); });
      req.on('end', () => {
        upstream.push(body);
        const asked = String(JSON.parse(body).messages?.at(-1)?.content ?? '');
        const text = asked.includes('hostile') ? HOSTILE : ANSWER;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const step = Math.ceil(text.length / 5);
        for (let i = 0; i < text.length; i += step) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(i, i + step) } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { total_tokens: 99 } })}\n\n`);
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
    fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/chat/completions`;
    server = await startCompanionServer(0, { upstream: fakeUrl });
    base = `http://127.0.0.1:${server.port}`;
    // the browser resolves no name but 127.0.0.1: nothing the page asks for can leave this computer
    browser = await chromium.launch({ headless: true, executablePath: browserPath, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await server?.shutdown();
    await new Promise<void>((r) => (fake ? fake.close(() => r()) : r()));
    process.chdir(originalCwd);
    for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  /** The page in a fresh context, opened with the address Timmy gives; requests elsewhere are recorded and aborted. */
  async function open(address = server.url): Promise<{ page: Page; context: BrowserContext; seen: Seen }> {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
    const seen: Seen = { requests: [], outside: [], sockets: [], console: [], errors: [], dialogs: [] };
    context.on('request', (r) => seen.requests.push(r.url()));
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin === base) return route.continue();
      seen.outside.push(url.href);
      return route.abort('blockedbyclient');
    });
    await context.addInitScript(() => {
      const w = window as unknown as { __violations: string[] };
      w.__violations = [];
      document.addEventListener('securitypolicyviolation', (e) => { w.__violations.push(`${e.effectiveDirective} ${e.blockedURI} ${e.sample}`); });
    });
    const page = await context.newPage();
    page.on('websocket', (ws) => seen.sockets.push(ws.url()));
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') seen.console.push(m.text()); });
    page.on('pageerror', (e) => seen.errors.push(e.message));
    page.on('dialog', (d) => { seen.dialogs.push(d.message()); void d.dismiss(); });
    await page.goto(address);
    return { page, context, seen };
  }

  const connected = (page: Page): Promise<unknown> => page.waitForFunction(() => document.getElementById('status-text')?.textContent === 'COMPANION SOCKET · CONNECTED', null, { timeout: 30_000 });
  const tab = async (page: Page, name: string): Promise<void> => {
    await page.click(`[data-tab="${name}"]`);
    await page.waitForFunction((n) => document.getElementById(`tab-${n}`)?.classList.contains('active') && getComputedStyle(document.getElementById(`tab-${n}`)!).opacity === '1', name, { timeout: 10_000 });
  };
  /** Asks the model chat (through its own input and Send button) and waits for the answer to finish streaming. */
  const ask = async (page: Page, words: string): Promise<void> => {
    const before = await page.locator('#model-messages .chat-msg.assistant').count();
    await page.fill('#model-input', words);
    await page.click('#model-send');
    await page.waitForFunction((n) => document.querySelectorAll('#model-messages .chat-msg.assistant').length === n + 1 && document.getElementById('model-status')?.textContent === 'IDLE', before, { timeout: 20_000 });
  };

  it('loads only from its own server: every request of every frame to 127.0.0.1, none elsewhere, its one socket its own, no policy violated', async () => {
    const { page, context, seen } = await open();
    try {
      await connected(page);
      // every tab, as a person opens them: the model chat's sample, the canvas, Slate 3D's frame
      for (const name of ['workspace', 'logs', 'proof', 'canvas', 'model', 'slate3d', 'chat']) {
        await tab(page, name);
        if (name === 'model') {
          await page.click('#model-sample');
          await page.waitForFunction(() => document.querySelector('#model-messages .md-diagram') !== null && document.getElementById('model-status')?.textContent === 'IDLE', null, { timeout: 15_000 });
        }
        if (name === 'canvas') await page.waitForFunction(() => /Revision 0|No canvas jobs yet/.test(document.getElementById('canvas-summary')?.textContent ?? ''), null, { timeout: 15_000 });
        // Slate 3D's own document, loaded (the frame's first document, about:blank, is complete before it arrives)
        if (name === 'slate3d') {
          await page.waitForFunction(() => {
            const d = (document.getElementById('slate3d-frame') as HTMLIFrameElement | null)?.contentDocument;
            return Boolean(d && d.readyState === 'complete' && d.location.pathname.startsWith('/slate3d') && d.body);
          }, null, { timeout: 15_000 });
        }
      }
      await page.waitForTimeout(500);
      expect(seen.outside).toEqual([]);
      expect(seen.requests.length).toBeGreaterThan(0);
      for (const r of seen.requests) expect(new URL(r).origin, r).toBe(base);
      // the renderer's markdown parser came from this server (the package's own marked)
      expect(seen.requests).toContain(`${base}/vendor/marked.esm.js`);
      expect(seen.sockets).toEqual([`ws://127.0.0.1:${server.port}/`]);
      expect(await violations(page)).toEqual([]);
      expect(seen.console.filter((l) => /Content Security Policy|Refused to/i.test(l))).toEqual([]);
      expect(seen.errors).toEqual([]);
      expect(seen.dialogs).toEqual([]);
    } finally { await context.close(); }
  });

  it('is served under a strict Content-Security-Policy with no inline script, style or handler; a script added on the page is refused', async () => {
    const r = await fetch(`${base}/`);
    const csp = r.headers.get('content-security-policy') ?? '';
    const directives = new Map(csp.split(';').map((d) => d.trim()).filter(Boolean).map((d) => { const [k, ...v] = d.split(/\s+/); return [k, v.join(' ')] as const; }));
    expect(directives.get('default-src')).toBe("'none'");
    expect(directives.get('script-src')).toBe("'self'");
    expect(directives.get('style-src')).toBe("'self'");
    expect(directives.get('connect-src')).toBe(`'self' ws://127.0.0.1:${server.port}`);
    expect(directives.get('object-src')).toBe("'none'");
    expect(directives.get('frame-ancestors')).toBe("'none'");
    expect(directives.get('base-uri')).toBe("'none'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|https?:|\*|data:/);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    const html = await r.text();
    const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const s of scripts) expect(s).toMatch(/\ssrc="\/[\w.-]+\.js"/);
    expect(html).not.toMatch(/<style\b|\sstyle=|\son[a-z]+=|importmap/i);
    expect(html).not.toMatch(/https?:\/\/(?!127\.0\.0\.1|localhost)/);
    // each file the page needs is this server's, with its type, the same policy and nosniff, and names no other site
    for (const f of COMPANION_RUNTIME_FILES.map((p) => p.slice(p.lastIndexOf('/') + 1)).filter((n) => n !== 'index.html')) {
      const a = await fetch(`${base}/${f}`);
      expect(a.status, f).toBe(200);
      expect(a.headers.get('content-type'), f).toMatch(f.endsWith('.css') ? /^text\/css/ : /^(text|application)\/javascript/);
      expect(a.headers.get('content-security-policy'), f).toBe(csp);
      expect(a.headers.get('x-content-type-options'), f).toBe('nosniff');
      expect(await a.text(), f).not.toMatch(/https?:\/\/(?!127\.0\.0\.1|localhost)/);
    }
    const marked = await fetch(`${base}/vendor/marked.esm.js`);
    expect(marked.status).toBe(200);
    expect(marked.headers.get('content-type')).toMatch(/^text\/javascript/);
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

  it('the model chat renders an answer streamed from the FAKE upstream: headings, lists, code with a working copy button, a mermaid block as its source', async () => {
    const { page, context, seen } = await open();
    try {
      await connected(page);
      await tab(page, 'model');
      await ask(page, 'release notes please');
      const md = page.locator('#model-messages .chat-msg.assistant').last().locator('.md');
      expect(await md.locator('h1').textContent()).toBe('Release notes');
      expect(await md.locator('h2').textContent()).toBe('Steps');
      expect(await md.locator('strong').first().textContent()).toBe('bold');
      expect(await md.locator('em').first().textContent()).toBe('emphasis');
      expect(await md.locator('ul > li').allTextContents()).toEqual(['first item', 'second item with code']);
      expect(await md.locator('ol > li').allTextContents()).toEqual(['three', 'four']);
      expect(await md.locator('ol').getAttribute('start')).toBe('3');
      expect(await md.locator('blockquote').textContent()).toContain('a quoted line');
      expect(await md.locator('table th').allTextContents()).toEqual(['a', 'b']);
      expect(await md.locator('table td').allTextContents()).toEqual(['1', '2']);
      // the link: http(s), opened apart from this page, with no referrer
      const link = md.locator('a', { hasText: 'docs link' });
      expect(await link.getAttribute('href')).toBe('https://docs.example/guide?x=1');
      expect(await link.getAttribute('rel')).toBe('noopener noreferrer');
      expect(await link.getAttribute('target')).toBe('_blank');
      // code: its text exactly as sent (markup in it is text), its language, and a copy button that copies it
      const code = md.locator('.md-code').filter({ hasNotText: 'mermaid' });
      expect(await code.locator('pre code').textContent()).toBe('const answer: number = 42;\nconsole.log(answer < 43 && "<b>not bold</b>");');
      expect(await code.locator('.md-lang').textContent()).toBe('ts');
      expect(await code.locator('b').count()).toBe(0);
      await code.locator('button').click();
      await page.waitForFunction(() => /Copied/.test(document.querySelector('#model-messages .md-code button')?.textContent ?? ''), null, { timeout: 5_000 });
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('const answer: number = 42;\nconsole.log(answer < 43 && "<b>not bold</b>");');
      // the mermaid block: its source, said to be a diagram's source that is not drawn here
      const diagram = md.locator('.md-diagram');
      expect(await diagram.locator('pre code').textContent()).toBe('graph LR\n  A[Prompt] --> B[Answer]');
      expect(await diagram.locator('.md-diagram-note').textContent()).toMatch(/mermaid.*source.*not drawn here/i);
      expect(await diagram.locator('svg').count()).toBe(0);
      // the cost words: the provider's reported tokens, never an estimate passed off as measured
      expect(await page.textContent('#model-tokens')).toBe('99 tokens (reported)');
      // one request upstream, with the operator's key, the conversation as sent
      expect(JSON.parse(upstream.at(-1)!).messages.at(-1)).toEqual({ role: 'user', content: 'release notes please' });
      expect(seen.outside).toEqual([]);
      expect(await violations(page)).toEqual([]);
    } finally { await context.close(); }
  });

  it('a hostile answer stays inert: an image with onerror, javascript: and data: links, raw HTML, a script, a frame and a style are text; only http(s) and mailto are links', async () => {
    const { page, context, seen } = await open();
    try {
      await connected(page);
      await tab(page, 'model');
      await ask(page, 'a hostile answer please');
      await page.waitForTimeout(800);
      const md = page.locator('#model-messages .chat-msg.assistant').last().locator('.md');
      expect(await md.locator('img, script, iframe, frame, object, embed, style, link, meta, base, form, svg, math, video, audio').count()).toBe(0);
      expect(await md.locator('[onclick], [onerror], [style], [id], [name]').count()).toBe(0);
      const text = (await md.textContent()) ?? '';
      expect(text).toContain('<img src=x onerror="window.__pwned = \'img\'">');
      expect(text).toContain('<script>window.__pwned = \'script\'</script>');
      expect(text).toContain('<iframe src="http://192.0.2.7/frame"></iframe>');
      expect(text).toContain('<b onclick="window.__pwned=\'b\'">');
      expect(text).toContain('click me');
      // links: only http(s) and mailto
      const hrefs = await md.locator('a').evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? ''));
      expect(hrefs).toContain('https://docs.example/path?q=1');
      expect(hrefs).toContain('mailto:someone@example.com');
      for (const h of hrefs) expect(h, h).toMatch(/^(https?:\/\/|mailto:)/);
      expect(await md.locator('a', { hasText: 'click me' }).count()).toBe(0);
      expect(await md.locator('a', { hasText: 'raw anchor' }).count()).toBe(0);
      expect(await md.locator('a', { hasText: 'relative' }).count()).toBe(0);
      // nothing ran and nothing was fetched: no flag, no dialog, no request for the image, the frame or the pixel
      expect(await page.evaluate(() => (window as unknown as { __pwned?: string }).__pwned)).toBeUndefined();
      expect(seen.dialogs).toEqual([]);
      expect(seen.outside).toEqual([]);
      expect(seen.requests.filter((r) => /\/x$|pixel|frame/.test(r))).toEqual([]);
      expect(await page.isVisible('#model-messages')).toBe(true);
      expect(await violations(page)).toEqual([]);
    } finally { await context.close(); }
  });

  it('Slate 3D\'s words, where its bundle is not built, are drawn in the theme\'s text colour on its dark ground', async () => {
    const { page, context, seen } = await open();
    try {
      await connected(page);
      await tab(page, 'slate3d');
      const frame = page.frameLocator('#slate3d-frame');
      await frame.locator('body').waitFor({ timeout: 15_000 });
      const look = await frame.locator('body').evaluate((b) => {
        const p = b.querySelector('p') ?? b;
        return { text: p.textContent ?? '', color: getComputedStyle(p).color, ground: getComputedStyle(b).backgroundColor };
      });
      if (!/Slate 3D is not part of this installation/.test(look.text)) {
        // a checkout that built Slate 3D shows its scene instead
        console.warn('companion-page-browser: Slate 3D is built here, so its absence words were not checked');
        return;
      }
      expect(rgb(look.color)).toEqual(rgb(HOMEBREW.text));
      expect([rgb(HOMEBREW.surface), rgb(HOMEBREW.ground)]).toContainEqual(rgb(look.ground));
      expect(contrast(look.color, look.ground)).toBeGreaterThan(7);
      expect(seen.outside).toEqual([]);
      expect(await violations(page)).toEqual([]);
    } finally { await context.close(); }
  });
});
