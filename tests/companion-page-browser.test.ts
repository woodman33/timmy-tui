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
 * collected in every frame (a script the test itself adds is refused and reported, which shows they are seen). Skipped,
 * saying so, where no Chromium or Chrome is found.
 *
 * R11 round 4 (H169, contract C3): the page's chat is the REAL agent turn — the Chat's composer sends POST /api/chat/turn
 * (src/companion/chat-run.ts, through openChatSession({ surface: 'companion' }); the launch token in a header) and the answer
 * streams as this page's turn, sealed into the project's conversation. The legacy raw POST /chat and the FAKE OpenRouter
 * upstream it posted to are gone, so the model here is a FAKE Ollama on 127.0.0.1 (tests/fixtures/fake-ollama-chat.ts) the
 * setup names as the chat's local model. The Chat draws a model's answer as text (fenced code as blocks: chat-shell.js
 * textBlock), so Streamdown's drawing of a MODEL's answer (headings, tables, diagrams, its caret) is no longer on the page:
 * the STREAMDOWN island still draws the ✨ sample (no model asked), and the cases below keep Streamdown exercised there.
 *
 * R4 (H104): the CHAT MIRROR says where chat happens when none of this session has come (r24: an empty panel that said
 * nothing), and shows a REPL turn as the bus carries it (a FAKE receipt.sealed event appended to the bus file the companion
 * tails: its receipt, never words) beside this monitor's chat; the ✨ sample's diagram labels are measured on the drawn SVG
 * at 1440 and 390 wide, in the chat and in fullscreen (r24: about 6 px; now at least 12), with zoom, pan and fullscreen used.
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureCompanionWeb } from '../scripts/companion-web-build.mjs';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { sealTurn } from '../src/repl/seal.js';
import { tildePath } from '../src/utils/home-scrub.js';
import { openWorkspaceTab, landWorkspace } from './helpers/companion-page-kit.js';
import { startFakeOllama, textChunks, type ChatScript, type FakeOllama } from './fixtures/fake-ollama-chat.js';

const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('companion-page-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

/** FAKE: the local model the setup names (not a real Ollama model; the FAKE Ollama lists and answers it). No regex-special character: it is used in patterns as it is. */
const MODEL = 'fake-page-test:8b';

/** What the FAKE model answers: markdown of every kind (the Chat draws it as text, its fenced blocks as blocks). */
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
  // R11 (H171, step 1): the page's chat sends only to a model somebody chose: the setup's (the FAKE Ollama's); R11 round 4
  // (H169): no OpenRouter key or model in this test's environment (they served the removed POST /chat's FAKE upstream)
  const ENV = ['TIMMY_REPO', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL', 'TIMMY_HOME'];
  const originalCwd = process.cwd();
  let browser: Browser;
  /** FAKE Ollama: the model behind the real turn; what reached it is in its requests (no model runs) */
  let ollama: FakeOllama;
  let server: CompanionServer;
  let base = '';
  /** the user messages the FAKE model was asked (the last message of each /api/chat request) */
  const asked = (): string[] => ollama.chats().map((c) => String(c.messages?.at(-1)?.content ?? ''));

  beforeAll(async () => {
    // the page's built chat: built here first when it is missing or stale (CI has no build)
    await ensureCompanionWeb();
    for (const k of ENV) saved[k] = process.env[k];
    const root = temp('h95-root-');
    mkdirSync(join(root, '.timmy', 'runs'), { recursive: true });
    writeFileSync(join(root, '.timmy', 'runs', 'timmy-events.jsonl'), `${JSON.stringify({ v: 1, ts: new Date().toISOString(), kind: 'test.h95-seeded', payload: { note: 'SYNTHETIC' } })}\n`);
    // the project's own receipts store, pinned in its folder: the real turn seals each answer there (src/repl/seal.ts)
    writeFileSync(join(root, '.timmy', 'store-pin'), join(root, '.timmy', 'receipts'));
    process.env.TIMMY_REPO = root;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_MODEL;
    const home = temp('h95-home-');
    process.env.TIMMY_HOME = home;
    process.chdir(temp('h95-work-'));
    // FAKE Ollama (labelled; no model behind it): the hostile answer, a slow answer (for the running indicator) or the
    // markdown answer, by the message it is asked; streamed in pieces that cut through the markdown (a fence, a list, a
    // link), so the page draws partial text on the way. One script per request: enough for every case of this file.
    const script: ChatScript = (request) => {
      const words = String(request.messages?.at(-1)?.content ?? '');
      const text = words.includes('hostile') ? HOSTILE : ANSWER;
      const step = words.includes('slow') ? 12 : Math.ceil(text.length / 5);
      const pieces: string[] = [];
      for (let i = 0; i < text.length; i += step) pieces.push(text.slice(i, i + step));
      return { chunks: textChunks(MODEL, pieces), ...(words.includes('slow') ? { delayMs: 120 } : {}) };
    };
    ollama = await startFakeOllama({ models: [{ name: MODEL, capabilities: ['completion', 'tools'] }], chat: Array.from({ length: 24 }, () => script) });
    // the setup as `timmy init --chat local --model <m>` records it, at the FAKE's address: the one route every surface reads
    writeFileSync(join(home, 'providers.json'), JSON.stringify({ ollama_host: ollama.url }));
    writeFileSync(join(home, 'setup.json'), JSON.stringify({ version: 1, by: 'timmy init', answers: { operator: 'Sample', ollama: ollama.url, project: basename(root), chat: 'local', model: MODEL } }));
    server = await startCompanionServer(0);
    base = `http://127.0.0.1:${server.port}`;
    // the browser resolves no name but 127.0.0.1: nothing the page asks for can leave this computer
    browser = await chromium.launch({ headless: true, executablePath: browserPath, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
    // R10 lead: say which browser ran this file, so a CI log shows it (the hostile-answer case first failed only on the
    // runner image whose Google Chrome was newer than every other run's; a passing run proves a fix only on that browser)
    console.log(`companion-page-browser: ${browser.browserType().name()} ${browser.version()} at ${browserPath}`);
  }, 600_000);

  afterAll(async () => {
    await browser?.close();
    await server?.shutdown();
    await ollama?.close();
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
    await landWorkspace(page);
    return { page, context, seen };
  }

  const connected = (page: Page): Promise<unknown> => page.waitForFunction(() => document.getElementById('status-text')?.textContent === 'COMPANION SOCKET · CONNECTED', null, { timeout: 30_000 });
  const tab = async (page: Page, name: string): Promise<void> => {
    // R5 (H132): each panel sits in one of the ten workspace tabs (data-ws): that tab is opened first, then the panel's own
    // switch where it shares its place (the Chat tab's two views)
    const ws = await page.getAttribute(`#tab-${name}`, 'data-ws');
    // R10 CHAT (H171): by the control drawn for it (the tab row, or on Chat the shell's left menu); Chat is shown already when
    // the page opens on it
    if (ws && (await page.getAttribute('body', 'data-dest')) !== ws) await openWorkspaceTab(page, ws);
    // R11 round 7 (the lead, SHELL CONTRACT v1 §2.1): the old tab row stays in the DOM hidden (companion.js's one switcher), so
    // only a VISIBLE control is clicked — the rail item opened the page above; a panel's own switch is the visible [data-tab]
    if (await page.locator(`.view-switch [data-tab="${name}"]:visible`).count()) await page.click(`.view-switch [data-tab="${name}"]:visible`);
    else if (await page.locator(`[data-tab="${name}"]:visible`).count()) await page.click(`[data-tab="${name}"]:visible`);
    await page.waitForFunction((n) => { const p = document.getElementById(`tab-${n}`); return Boolean(p?.classList.contains('active') && getComputedStyle(p).opacity === '1' && p.getAnimations().length === 0); }, name, { timeout: 10_000 });
  };
  const idle = (page: Page): Promise<unknown> => page.waitForFunction(() => document.getElementById('sd-status')?.textContent === 'IDLE', null, { timeout: 30_000 });
  /**
   * R11 round 4 (H169): asks the Chat (its composer: #cx-input, Enter) — the REAL turn through POST /api/chat/turn — and waits
   * until the answer has ended: streamed as this page's own turn, then sealed and folded into the project's conversation
   * (#cx-turns), or left as the page's own with its end state. Returns the TIMMY turn that holds the answer.
   */
  const askChat = async (page: Page, words: string): Promise<ReturnType<Page['locator']>> => {
    await page.waitForSelector('#cx-input', { timeout: 30_000 });
    await page.fill('#cx-input', words);
    await page.focus('#cx-input');
    await page.waitForFunction(() => !(document.getElementById('cx-send') as HTMLButtonElement | null)?.disabled, null, { timeout: 30_000 });
    const before = await page.locator('#cx-turns .cx-turn.is-timmy').count();
    await page.keyboard.press('Enter');
    // the turn is drawn as the page's own at once; a fast answer may already be sealed and folded into the conversation
    await page.waitForFunction((n) => document.querySelector('#cx-own .cx-turn.is-timmy') !== null || document.querySelectorAll('#cx-turns .cx-turn.is-timmy').length > n, before, { timeout: 15_000 });
    await page.waitForFunction((n) => !document.querySelector('#cx-own .cx-turn.is-streaming') && !document.querySelector('#cx-own .cx-running')
      && (document.querySelector('#cx-own .cx-turn.is-timmy') !== null || document.querySelectorAll('#cx-turns .cx-turn.is-timmy').length > n), before, { timeout: 60_000 });
    // folded into the conversation (its receipt read back), or still the page's own copy: the newest TIMMY turn either way
    return page.locator('#cx-own .cx-turn.is-timmy, #cx-turns .cx-turn.is-timmy').last();
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
    const chatsBefore = ollama.chats().length;
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
      // the chat's code, its styles and Timmy's shared look came from this server (R5 H132: the theme's sheet; its face's
      // files are this server's too, or the font installed here: the face test below)
      for (const p of ['/web/island/companion-chat.js', '/web/styles/tailwind.css', '/web/styles/streamdown.css', '/timmy-theme.css']) {
        expect(seen.requests, p).toContain(`${base}${p}`);
      }
      expect(seen.requests.some((r) => r.startsWith(`${base}/web/island/chunks/`))).toBe(true);
      // R4 (H97): nothing of the page H92 made and H95 replaced (its chat and markdown scripts, marked): no page of the
      // companion asks for any of them, so they are no longer shipped or served. R5 (H132): nor b69ab12's Inter and Fira Code.
      // R11 round 7 (H175; DESIGN.md §10 B11, the lead's D2): Outfit is the page's UI face again, served from this server's own
      // built web assets (/web/fonts/outfit-latin-wght-normal.woff2) — the face test below holds it to that one file.
      // R11 round 6: what the page may ask for under /vendor/ is what this server serves from its own installed packages —
      // the Rive runtime (rive-assets.ts: /vendor/rive/rive.js + rive.wasm, for the Chat's AgentConsole band) and, on a
      // Clerk-configured companion, Clerk's module (/vendor/clerk/, identity) — nothing else there (the old marked copy above all).
      expect(seen.requests.filter((r) => /^\/(?:chat\.js|markdown\.js|vendor\/(?!rive\/|clerk\/)|web\/fonts\/(?:inter|fira-code)-)/.test(new URL(r).pathname))).toEqual([]);
      for (const p of seen.requests.map((r) => new URL(r).pathname).filter((p) => p.startsWith('/vendor/'))) expect(p, 'under /vendor/ only the Rive runtime or Clerk').toMatch(/^\/vendor\/(?:rive\/rive\.(?:js|wasm)|clerk\/)/);
      // (R11 round 4: the ✨ sample asks no model: the FAKE Ollama saw no chat request for this page)
      expect(ollama.chats().length).toBe(chatsBefore);
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
    // R11 round 6 (the lead): the Rive runtime's WebAssembly needs the keyword 'wasm-unsafe-eval' (a keyword, never a host) — the
    // policy carries it exactly when the companion serves a .riv with the runtime (rive-assets.ts / page.ts setPagePolicyWasm),
    // and nothing else: still scripts from itself only, no unsafe-inline, no unsafe-eval
    const listing = await (await fetch(`${base}/api/rive/assets`, { headers: { Authorization: `Bearer ${new URL(server.url).hash.replace(/^#t=/, '')}` } })).json().catch(() => null) as { runtime?: boolean; components?: Array<{ riv?: unknown }> } | null;
    const wasm = Boolean(listing && listing.runtime && Array.isArray(listing.components) && listing.components.some((c) => c.riv));
    expect(directives.get('script-src')).toBe(wasm ? "'self' 'wasm-unsafe-eval'" : "'self'");
    expect(directives.get('style-src')).toBe("'self' 'unsafe-inline'");
    expect(directives.get('img-src')).toBe("'self' data:");
    expect(directives.get('font-src')).toBe("'self'");
    expect(directives.get('connect-src')).toBe(`'self' ws://127.0.0.1:${server.port}`);
    expect(directives.get('object-src')).toBe("'none'");
    expect(directives.get('frame-ancestors')).toBe("'none'");
    expect(directives.get('base-uri')).toBe("'none'");
    // (R11 round 6: 'wasm-unsafe-eval' is the one keyword the policy may carry — exactly when a .riv is served, asserted above;
    // 'unsafe-eval' itself, a scheme, a wildcard or blob: never)
    expect(csp.replace(/'wasm-unsafe-eval'/g, '')).not.toMatch(/unsafe-eval|https?:|\*|blob:/);
    if (!wasm) expect(csp).not.toMatch(/wasm-unsafe-eval/);
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
    expect(named).toEqual(expect.arrayContaining(['/timmy-theme.css', '/companion.css', '/web/styles/tailwind.css', '/web/styles/streamdown.css', '/companion.js', '/web/island/companion-chat.js']));
    // R4 (H97): what H92's page had and H95's replaced is not served any more (no page asks for it: the test above)
    for (const p of ['/chat.js', '/markdown.js', '/vendor/marked.esm.js']) {
      const gone = await fetch(`${base}${p}`);
      expect(gone.status, p).toBe(404);
      expect(await gone.text(), p).not.toMatch(/marked|@font-face|--timmy-|function\s*\(/);
    }
    // R5 (H132, DESIGN.md §10 B10): Timmy's shared look is served again: the --timmy-* variables with Monaspace Argon's faces,
    // and the faces' files by their exact names only, beside the page's web files (anything else is a 404 in words, no path)
    const theme = await fetch(`${base}/timmy-theme.css`);
    expect(theme.status).toBe(200);
    expect(await theme.text()).toMatch(/--timmy-ground: #000000;[\s\S]*--timmy-accent: #FFB000;[\s\S]*--timmy-live: #28FE14;/);
    const face = await fetch(`${base}/web/fonts/monaspace-argon-latin-400-normal.woff2`);
    expect(face.status).toBe(200);
    expect(face.headers.get('content-type')).toMatch(/^font\/woff2/);
    for (const p of ['/fonts/monaspace-argon-latin-400-normal.woff2', '/web/fonts/monaspace-argon-latin-400-normal.woff', '/web/fonts/..%2F..%2Fpackage.json']) {
      const no = await fetch(`${base}${p}`);
      expect(no.status, p).toBe(404);
      expect(await no.text(), p).not.toMatch(/\/(?:home|root|Users|tmp)\/|node_modules/);
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

  it('the Chat draws the FAKE model\'s answer streamed through the real turn (POST /api/chat/turn): its markdown as text, each fenced block as a block (the code, the Mermaid source), the FAKE model named, the evidence line with its receipt; nothing of it as markup', async () => {
    // R11 round 4 (H169): this case asked the removed POST /chat and read the island's Streamdown DOM (headings, a table with
    // its copy, a link, Shiki-coloured code, a drawn Mermaid diagram with its downloads). The page's chat is the real turn
    // now, drawn by the Chat shell as text (chat-shell.js textBlock: fenced code as <pre>, never markup); Streamdown's
    // drawing of markdown stays exercised on the ✨ sample (the cases below). What is asserted here is what the page does.
    const { page, context, seen } = await open();
    try {
      await connected(page);
      const turn = await askChat(page, 'release notes please');
      const text = turn.locator('.cx-text');
      const words = (await text.textContent()) ?? '';
      // the markdown, as text: its heading marks, its list and task marks, its table, its link's own text
      expect(words).toContain('# Release notes');
      expect(words).toContain('## Steps');
      expect(words).toContain('- [x] a done task');
      expect(words).toContain('| a | b |');
      expect(words).toContain('[docs link](https://docs.example/guide?x=1)');
      // the two fenced blocks are blocks: the code and the Mermaid source, their fences gone
      expect(await text.locator('pre').allTextContents()).toEqual(['const answer: number = 42;', 'graph LR\n  A[Prompt] --> B[Answer]']);
      // nothing of it became markup: no heading, list, table, link, box or image elements in the answer
      expect(await text.locator('h1, h2, ul, ol, li, table, a, input, img, svg, script').count()).toBe(0);
      // the FAKE model is named as such beside TIMMY (the page's own chip, from its name)
      expect(await turn.locator('.cx-who .cx-chip').textContent()).toBe('FAKE model');
      expect(await turn.locator('.cx-who .cx-model').textContent()).toBe(MODEL);
      // the evidence line: the model, where it ran, the seconds and the receipt's short id (sealed by the real turn)
      await expect.poll(async () => ((await turn.locator('.cx-evidence').textContent()) ?? '').replace(/\s+/g, ' ').trim(), { timeout: 15_000 }).toMatch(new RegExp(`^▸ ${MODEL} · [^·]+ · \\d+(?:\\.\\d)? s · receipt [0-9a-f]{8}`));
      // one request to the FAKE, with the message as sent, and the turn's request to this server carried the token
      expect(asked().at(-1)).toBe('release notes please');
      expect(seen.requests.some((r) => new URL(r).pathname === '/api/chat/turn')).toBe(true);
      // (the removed path was never asked for)
      expect(seen.requests.some((r) => new URL(r).pathname === '/chat')).toBe(false);
      expect(seen.outside).toEqual([]);
      expect(await violations(page)).toEqual([]);
      expect(seen.errors).toEqual([]);
    } finally { await context.close(); }
  });

  it('shows the turn\'s running indicator (the model, where it runs, the seconds, no tool yet) while the FAKE model\'s answer streams through the real turn, and none once it has ended', async () => {
    // R11 round 4 (H169): Streamdown's caret and its "estimated while streaming" counter belonged to the removed POST /chat
    // stream in the island. The page's turn runs through POST /api/chat/turn and the Chat shell says what runs, in words.
    const { page, context } = await open();
    try {
      await connected(page);
      await page.waitForSelector('#cx-input', { timeout: 30_000 });
      await page.fill('#cx-input', 'a slow answer please');
      await page.focus('#cx-input');
      await page.waitForFunction(() => !(document.getElementById('cx-send') as HTMLButtonElement | null)?.disabled, null, { timeout: 30_000 });
      await page.keyboard.press('Enter');
      await page.waitForSelector('#cx-own .cx-turn.is-streaming .cx-running', { timeout: 15_000 });
      const running = ((await page.textContent('#cx-own .cx-turn.is-streaming .cx-running')) ?? '').replace(/\s+/g, ' ').trim();
      expect(running).toMatch(new RegExp(`^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Answering · ${MODEL} · Ollama on this computer · \\d+ s · no tool yet$`));
      // the answer grows while it streams (the FAKE sends it in 12-character pieces, 120 ms apart)
      const before = ((await page.textContent('#cx-own .cx-turn.is-streaming .cx-text')) ?? '').length;
      await page.waitForFunction((n) => ((document.querySelector('#cx-own .cx-turn.is-streaming .cx-text')?.textContent ?? '').length) > n, before, { timeout: 15_000 });
      // ended: no indicator anywhere, the turn answered (folded into the conversation, or the page's own with its end)
      await page.waitForFunction(() => !document.querySelector('#cx-own .cx-turn.is-streaming') && !document.querySelector('.cx-running'), null, { timeout: 60_000 });
      await page.waitForFunction(() => document.querySelectorAll('#cx-turns .cx-turn.is-timmy, #cx-own .cx-turn.is-answered').length > 0, null, { timeout: 15_000 });
      expect(await page.locator('.cx-running').count()).toBe(0);
      expect(asked().at(-1)).toBe('a slow answer please');
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
      // the sample is the page's own: no model was asked for it (R11 round 4: nothing of it reached the FAKE Ollama)
      expect(asked().filter((w) => w.includes('Try it'))).toEqual([]);
    } finally { await context.close(); }
  });

  // R4 (H98): the sample says it is one wherever it is seen; a model's answer (the FAKE model's, through the real turn) does not
  it('the ✨ sample carries a visible SAMPLE label on its message, its answer and each card; a model\'s answer carries none', async () => {
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
      // a model's answer says no SAMPLE anywhere. R11 round 4 (H169): the model answers through the real turn into the Chat
      // (POST /api/chat/turn; the island draws no model answer any more, so its [data-sample="no"] answer and its cards are
      // gone): the FAKE model's turn carries the page's "FAKE model" chip and no SAMPLE label, nor does the message
      const turn = await askChat(page, 'release notes please');
      expect(await label('#cx-scroll')).toEqual([]);
      expect(await turn.locator('.cx-who .cx-chip').allTextContents()).toEqual(['FAKE model']);
      expect(((await page.textContent('#cx-turns')) ?? '') + ((await page.textContent('#cx-own')) ?? '')).not.toContain('SAMPLE');
      expect(seen.errors).toEqual([]);
    } finally { await context.close(); }
  });

  it('a hostile answer is inert in the Chat: an image with onerror, javascript: and data: links, raw script, frame and style, a card\'s handler and a Mermaid block with directives arrive as text, make no element, run nothing and fetch nothing', async () => {
    // R11 round 4 (H169): this case read the island's Streamdown DOM for the removed POST /chat stream (its sanitizer, Mermaid's
    // strict mode). The page's chat is the real turn into the Chat shell, which sets an answer as text (textBlock: text nodes
    // and <pre> for fenced code), so hostile markup is words on the screen: the same intent, held by the renderer the page has.
    const { page, context, seen } = await open();
    try {
      await connected(page);
      const turn = await askChat(page, 'a hostile answer please');
      await page.waitForTimeout(800);
      const text = turn.locator('.cx-text');
      // every hostile piece is there as text, none as an element
      const words = (await text.textContent()) ?? '';
      for (const piece of ['<img src=x onerror=', '<script>window.__pwned', '<iframe src="http://192.0.2.7/frame">', '[click me](javascript:', '<a href="javascript:', '<b onclick=', '![tracker](http://192.0.2.7/pixel.png)', '<style>body { display: none }</style>', '<receipt id="run_x"']) expect(words, piece).toContain(piece);
      expect(await text.locator('script, iframe, frame, object, embed, style, link, meta, base, form, img, a, b, receipt, svg').count()).toBe(0);
      expect(await turn.locator('[onclick], [onerror], [onload], [onmouseover]').count()).toBe(0);
      // the Mermaid block (with its init and click directives) is a block of source text, drawn by nothing
      expect(await text.locator('pre').last().textContent()).toContain('click B "javascript:window.__pwned=3" "x"');
      await text.locator('pre').last().click({ force: true });
      // nothing ran, nothing was fetched from anywhere else (no image, no frame: they are text), the page still stands
      expect(await page.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned)).toBeUndefined();
      expect(seen.dialogs).toEqual([]);
      expect(seen.outside).toEqual([]);
      expect(seen.requests.filter((r) => new URL(r).origin !== base)).toEqual([]);
      expect(await violations(page)).toEqual([]);
      expect(await page.evaluate(() => getComputedStyle(document.body).display)).not.toBe('none');
      expect(await page.isVisible('#cx-turns')).toBe(true);
      expect(asked().at(-1)).toBe('a hostile answer please');
      expect(seen.errors).toEqual([]);
    } finally { await context.close(); }
  });

  it('its two faces are the theme\'s (R5 H132 B10; R11 round 7 H175, DESIGN.md §10 B11 and the lead\'s D2): Outfit for headings, labels and text, Monaspace Argon for code, paths and keys — each loaded from this computer (installed, or the companion\'s own file), nothing from elsewhere', async () => {
    const { page, context, seen } = await open();
    try {
      await connected(page);
      await page.evaluate(() => document.fonts.ready);
      const fonts = await page.evaluate(() => [...document.fonts].map((f) => `${f.family.replace(/["']/g, '')} ${f.weight} ${f.status}`));
      // the mono face: the page's keys (kbd), commands and records are drawn in it, so its regular weight is loaded
      expect(fonts).toContain('Monaspace Argon 400 loaded');
      // the UI face: Outfit's one variable file (weights 100 to 900), loaded for the words on screen
      expect(fonts.some((f) => /^Outfit (?:100 900|\d+) loaded$/.test(f)), fonts.join(', ')).toBe(true);
      for (const s of ['h1', 'body', '#status', '#project-name', '.page-title', '.rail-item', '#shell-crumb-page']) {
        expect(await page.evaluate((sel) => getComputedStyle(document.querySelector(sel)!).fontFamily, s), s).toMatch(/^"?Outfit"?/);
      }
      for (const s of ['kbd', 'code, .cmd, pre']) {
        expect(await page.evaluate((sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).fontFamily : '"Monaspace Argon" (none on the page)'; }, s), s).toMatch(/^"?Monaspace Argon"?/);
      }
      // a face's file the browser asked for was this server's (none, where the font is installed): the four Monaspace Argon
      // files or Outfit's one; b69ab12's Inter and Fira Code are not asked for (the policy case above)
      for (const r of seen.requests.filter((u) => /\.woff2?$/.test(new URL(u).pathname))) expect(r).toMatch(new RegExp(`^${base}/web/fonts/(?:monaspace-argon-latin-\\d00-(?:normal|italic)|outfit-latin-wght-normal)\\.woff2$`));
      expect(seen.outside).toEqual([]);
    } finally { await context.close(); }
  });

  it('the chat\'s two views fade with GSAP\'s timing (out 0.15 s power2.in, then in 0.25 s power2.out), a workspace tab fades in (0.15 s power2.out), and both switch at once where reduced motion is asked', async () => {
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
      // R10 CHAT (H171): the page opens on Chat; from Home (key 1), opening Chat fades its page in, as before
      await moving.page.keyboard.press('1');
      await moving.page.waitForFunction(() => document.body.dataset.dest === 'home' && document.getAnimations().every((a) => a.playState !== 'running'), null, { timeout: 10_000 });
      await record(moving.page);
      // R5 (H132): a workspace tab (here 2, Chat & Intent) fades its page in; the chat's two views keep GSAP's fade
      await tab(moving.page, 'chat');
      await tab(moving.page, 'streamdown');
      expect(await moving.page.evaluate(() => (window as unknown as { __anims: unknown[] }).__anims)).toEqual([
        { id: 'ws-chat', from: 0, to: 1, duration: 150, easing: 'cubic-bezier(0.33, 1, 0.68, 1)' },
        { id: 'tab-chat', from: 1, to: 0, duration: 150, easing: 'cubic-bezier(0.32, 0, 0.67, 0)' },
        { id: 'tab-streamdown', from: 0, to: 1, duration: 250, easing: 'cubic-bezier(0.33, 1, 0.68, 1)' },
      ]);
    } finally { await moving.context.close(); }
    const still = await open({ reducedMotion: 'reduce' });
    try {
      await connected(still.page);
      // R10 CHAT (H171): from Home (key 1), where the tab row is drawn
      await still.page.keyboard.press('1');
      await still.page.waitForFunction(() => document.body.dataset.dest === 'home', null, { timeout: 10_000 });
      await record(still.page);
      // R11 round 7 (the lead): the tab row is hidden under the one rail (SHELL CONTRACT v1 §2.1); Runs & receipts by its rail item
      await openWorkspaceTab(still.page, 'logs');
      await still.page.waitForFunction(() => document.getElementById('tab-logs')?.classList.contains('active') && !document.getElementById('ws-logs')?.hidden, null, { timeout: 5_000 });
      await tab(still.page, 'streamdown');
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
      // R5 (H132): the theme's text (#F2EFE9) on the canvas (#000000), in Monaspace Argon
      expect(look.color).toBe('rgb(242, 239, 233)');
      expect(look.ground).toBe('rgb(0, 0, 0)');
      expect(look.font).toMatch(/^"?Monaspace Argon"?/);
      expect(contrast(look.color, look.ground)).toBeGreaterThan(7);
      expect(seen.outside).toEqual([]);
      expect(await violations(page)).toEqual([]);
    } finally { await context.close(); }
  });

  it('its sheet colors with Timmy\'s shared variables only (R5 H132, DESIGN.md §10 B10): no color of its own, none of b69ab12\'s palette, glows, blur or gradient title', () => {
    const css = readFileSync(new URL('../src/companion/client/companion.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    // no literal color anywhere (the shadcn tokens Streamdown's parts name are the palette's own values, as HSL triplets)
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i);
    for (const gone of ['--bg-base', '--secondary-hsl', '--primary-hsl', '--success-hsl', 'radial-gradient', 'linear-gradient', 'backdrop-filter', 'blur(', 'Outfit', 'Fira Code']) expect(css, gone).not.toContain(gone);
    // every color a declaration gives is one of the theme's variables (or transparent, currentColor, inherit, none)
    const decl = /(?:^|[;{\s])((?:background|border|outline|box-shadow|text-decoration|caret|scrollbar|column-rule)(?:-[a-z-]+)?|color|fill|stroke)\s*:\s*([^;}]+)/g;
    for (const [, prop, value] of css.matchAll(decl)) {
      if (/^(?:border(?:-[a-z]+)*-(?:width|style|radius|collapse|spacing)|border-(?:top|right|bottom|left)-(?:width|style)|scrollbar-width|text-decoration-(?:line|thickness|style)|background-(?:clip|image|position|repeat|size)|outline-(?:offset|width|style))$/.test(prop)) continue;
      // R6 lead: `inset` (a box-shadow's side) and `line-through` (a decoration's line) are keywords, not colors (H142's tab 9)
      const rest = value.replace(/var\(--timmy-[a-z-]+\)/g, '').replace(/!important|\b(?:solid|dashed|dotted|none|transparent|currentColor|inherit|underline|line-through|inset|thin|auto)\b|-?\d*\.?\d+(?:px|em|rem|%)?/g, '').trim();
      expect(rest, `${prop}: ${value}`).toBe('');
    }
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
    const { own, root } = await ownCompanion([fakeTurn(new Date(Date.now() - 3_600_000), 'repl · 1 step')]);
    const { page, context, seen } = await open({ on: own, viewport });
    try {
      await connected(page);
      // R5 (H132): the mirror is the Chat tab's (2)
      await tab(page, 'chat');
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
      // R4 (H104, second part): where a REPL turn must happen to be seen: the project this page shows (here the folder
      // TIMMY_REPO fixed, as the test's own companion was started)
      expect(words).toContain(`A REPL turn is seen here when the REPL works in ${basename(root)} (${tildePath(root)}), the folder TIMMY_REPO fixed for this companion: Timmy keeps an event bus in each project's folder, and this page reads that one's.`);
      expect(words).toContain('The older STREAMDOWN CHAT view sends nothing now: the chat is the agent turn in Chat (POST /api/chat/turn); its ✨ sample is labelled SAMPLE there and is never shown here.');
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
      await tab(page, 'chat');
      await page.waitForSelector('#console-logs [data-mirror="empty"]');
      const first = fakeTurn(new Date(), 'repl · 2 steps');
      appendFileSync(bus, `${JSON.stringify(first)}\n`);
      await page.waitForSelector('#console-logs [data-mirror="repl-turn"]', { timeout: 15_000 });
      const row = (await page.textContent('#console-logs [data-mirror="repl-turn"]'))!.replace(/\s+/g, ' ').trim();
      expect(row).toMatch(/^⌨ REPL turn · ended \d/);
      // (R10 H167, H168's F3 on the page: the REPL by its name, the receipt's id behind the row's Details)
      expect(row).toContain('A chat turn in the REPL ended (2 steps); Timmy sealed its receipt. Its words are in the REPL: Timmy seals a REPL turn\'s prompt and answer as hashes only, so they are not on the event bus and are not shown here.');
      expect(row).toMatch(new RegExp(`Details receipt ${first.payload.hash.slice(7, 15)}$`));
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
      // R5 lead: a cancelled turn is said stopped, the word the Workbench and the shared frame use (1598141)
      // R7 (H152): with who asked (no other surface did, so the REPL that sent it)
      expect(order).toEqual(['⌨ REPL turn · ended', '▶ You', '⌨ REPL turn · stopped (asked from the REPL)', '◀ TIMMY Agent']);
      expect((await page.locator('#console-logs [data-mirror="repl-turn"]').nth(1).textContent())!.replace(/\s+/g, ' ')).toContain('A chat turn in the REPL stopped (asked from the REPL; 1 step);');
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
      await tab(page, 'chat');
      await page.waitForSelector('#console-logs [data-mirror="empty"]');
      // SYNTHETIC turn facts (no model was asked); the sealing, its signature, its chain and its bus event are the real ones
      const sealed = sealTurn({ prompt: 'SYNTHETIC prompt, never shown', answer: 'SYNTHETIC answer, never shown', steps: 3, spend: 0, costMeasured: false, ms: 1_200, status: 'ok', model: 'SYNTHETIC/model' }, root);
      expect(sealed.verified).toBe(true);
      expect(readFileSync(join(root, '.timmy', 'receipts', 'runs.jsonl'), 'utf8')).toContain(sealed.hash);
      await page.waitForSelector('#console-logs [data-mirror="repl-turn"]', { timeout: 15_000 });
      const row = (await page.textContent('#console-logs [data-mirror="repl-turn"]'))!.replace(/\s+/g, ' ');
      expect(row).toContain('A chat turn in the REPL ended (3 steps); Timmy sealed its receipt.');
      expect(row).toContain(`Details receipt ${sealed.id}`);
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
        // R10 (H167; the lead's reading of a failure with four browser files at once on 2 CPUs: 5 of the 6 labels read, the last
        // not drawn yet): the diagram is drawn again as the answer's last part arrives, so an earlier drawing can be the one on
        // screen just after the stream ends. The sample's whole diagram is the one with its last label: measured once it is drawn
        const LABELS = ['User Prompt', 'POST /chat SSE', 'Streamdown Parser', 'receipt Card', 'approval Gate', 'Mermaid Diagram'];
        await expect.poll(async () => (await shownLabels(page, 'chat'))?.labels.map((l) => l.text) ?? null, { timeout: 20_000, interval: 100 }).toEqual(LABELS);
        // the drawing given its size (data-fit, by the chat's script); what is measured below decides, whether or not it is
        await page.waitForFunction(() => Boolean(document.querySelector('#streamdown-root [aria-label="Mermaid chart"] > svg[data-fit]')), null, { timeout: 5_000 }).catch(() => undefined);
        const shown = (await shownLabels(page, 'chat'))!;
        expect(shown.labels.map((l) => l.text)).toEqual(LABELS);
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
        // zoom in, zoom out, Reset: Streamdown's own buttons scale the drawing. A click's new state reaches the drawing's frame
        // (role="application") as an inline transform that then eases in 150 ms, so each reading is taken again until it is the
        // one asked for or 10 s pass, and then the last reading is what fails. A fixed 400 ms wait read the scale before a
        // zoom had landed on a loaded computer ("expected 1 to be close to 0.9", R5 H130).
        const again = { timeout: 10_000, interval: 50 };
        const scale = async (): Promise<number> => (await shownLabels(page, 'chat'))!.scale;
        const left = async (): Promise<number> => (await shownLabels(page, 'chat'))!.left;
        await block.locator('button[title="Zoom in"]').click();
        await expect.poll(async () => (await scale()) / shown.scale, again).toBeCloseTo(1.1, 2);
        await block.locator('button[title="Zoom out"]').click();
        await block.locator('button[title="Zoom out"]').click();
        await expect.poll(async () => (await scale()) / shown.scale, again).toBeCloseTo(0.9, 2);
        await block.locator('button[title="Reset zoom and pan"]').click();
        await expect.poll(scale, again).toBeCloseTo(shown.scale, 3);
        // pan: a drag moves the drawing by as much; Reset brings it back
        const a = (await area.boundingBox())!;
        await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
        await page.mouse.down();
        await page.mouse.move(a.x + a.width / 2 - 120, a.y + a.height / 2, { steps: 12 });
        await page.mouse.up();
        await expect.poll(async () => (await left()) - shown.left, again).toBeCloseTo(-120, 0);
        await block.locator('button[title="Reset zoom and pan"]').click();
        await expect.poll(left, again).toBeCloseTo(shown.left, 0);
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
        // Timmy Homebrew's well and amber accent (src/theme/tokens.ts, B10: an icon is never green), and no script or other site
        expect(svg, p).toContain('fill="#070707"');
        expect(svg, p).toContain('stroke="#FFB000"');
        expect(svg.toUpperCase(), p).not.toContain('#28FE14');
        expect(svg.replace('http://www.w3.org/2000/svg', ''), p).not.toMatch(/<script|https?:|href=/i);
      }
      expect(seen.errors).toEqual([]);
      expect(seen.outside).toEqual([]);
      expect(await violations(page)).toEqual([]);
    } finally { await context.close(); }
  });
});
