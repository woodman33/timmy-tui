/**
 * R12 (the operator's 03:04 order): the Timmy app as the companion serves it (src/companion/timmy-app.ts) and as `timmy app`
 * opens it (src/app/launch.ts), over real HTTP on 127.0.0.1. No browser here (tests/timmy-app-browser.test.ts draws it).
 *
 * What is checked: /app answers the page under the app's own policy (scripts only from this server, plus WebAssembly for the Rive
 * runtime; inline styles and data:/blob: images for tldraw; no frames, no plugins, never framed); its bundle under /app/dist;
 * a missing build is said in words, never a 404 page of another server; GET /api/app/config needs the launch token, then gives the
 * tldraw key (only from TLDRAW_LICENSE_KEY), the principal's project and the Ollama starters; GET /api/chat/view?local=skip asks
 * the local Ollama nothing (the page's permission); the launcher opens /app with the token in the fragment, says where, and
 * stops cleanly; a bad argument or a missing build exits with its code and words.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appUrlOf, runApp } from '../src/app/launch.js';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { APP_NOT_BUILT, appPolicy } from '../src/companion/timmy-app.js';

const TOKEN = 'b'.repeat(64);

describe('the Timmy app\'s page and config, from the companion (R12)', () => {
  let companion: CompanionServer;
  let base = '';
  let asked: string[] = [];
  let ollama: ReturnType<typeof createServer>;
  const kept = { TIMMY_REPO: process.env.TIMMY_REPO, TLDRAW_LICENSE_KEY: process.env.TLDRAW_LICENSE_KEY };
  let box = '';
  beforeAll(async () => {
    box = mkdtempSync(join(tmpdir(), 'r12-app-'));
    // a stand-in Ollama that only records what it is asked (no model behind it)
    ollama = createServer((req, res) => { asked.push(String(req.url)); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"models":[]}'); });
    await new Promise<void>((r) => ollama.listen(0, '127.0.0.1', () => r()));
    const host = `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`;
    const root = join(box, 'project');
    mkdirSync(root, { recursive: true });
    const home = process.env.TIMMY_HOME!;
    writeFileSync(join(home, 'setup.json'), JSON.stringify({ version: 1, by: 'test', answers: { chat: 'local', ollama: host, model: 'fake-qwen3:8b' } }));
    process.env.TIMMY_REPO = root;
    const env = { TIMMY_HOME: home, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR, TLDRAW_LICENSE_KEY: 'tldraw-test-key-not-real' };
    companion = await startCompanionServer(0, { token: TOKEN, chatEnv: env, workspace: { env } });
    base = `http://127.0.0.1:${companion.port}`;
  }, 120_000);
  afterAll(async () => {
    await companion?.shutdown();
    await new Promise<void>((r) => ollama.close(() => r()));
    for (const [k, v] of Object.entries(kept)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (box) rmSync(box, { recursive: true, force: true });
  });

  it('the policy: this server\'s scripts (+ WebAssembly), tldraw\'s inline styles and data:/blob: images, its own socket, nothing framed', () => {
    const p = appPolicy('127.0.0.1:3001');
    expect(p).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(p).not.toMatch(/script-src[^;]*'unsafe-(inline|eval)'/);
    expect(p).toContain("connect-src 'self' ws://127.0.0.1:3001");
    expect(p).toContain("frame-ancestors 'none'");
    expect(p).toContain("object-src 'none'");
    expect(p).toContain("form-action 'none'");
    expect(p).toContain("img-src 'self' data: blob:");
    // a Host that is not this computer's names no socket
    expect(appPolicy('evil.example:80')).toContain("connect-src 'self';");
  });

  it('/app is the page (or, unbuilt, words), under the app\'s policy; its bundle under /app/dist', async () => {
    const page = await fetch(`${base}/app`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toBe(appPolicy(`127.0.0.1:${companion.port}`));
    const body = await page.text();
    if (/text\/html/.test(String(page.headers.get('content-type')))) {
      expect(body).toContain('<script type="module" src="/app/dist/app.js"></script>');
      const js = await fetch(`${base}/app/dist/app.js`);
      expect(js.status).toBe(200);
      expect(js.headers.get('content-type')).toMatch(/javascript/);
      expect(js.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    } else {
      expect(body.trim()).toBe(APP_NOT_BUILT);
    }
    expect((await fetch(`${base}/app/dist/nothing-here.js`)).status).toBe(404);
  });

  it('GET /api/app/config needs the token, then gives the key, the project and the starters', async () => {
    expect((await fetch(`${base}/api/app/config`)).status).toBe(401);
    const r = await fetch(`${base}/api/app/config`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(r.status).toBe(200);
    const c = await r.json() as { ok: boolean; licenseKey: string | null; project: { name: string; root: string } | null; tldrawVersion: string; ollama: { starters: Array<{ model: string; size: string }>; install: { install: string } } };
    expect(c.ok).toBe(true);
    expect(c.licenseKey).toBe('tldraw-test-key-not-real');
    expect(c.tldrawVersion).toBe('5.5.2');
    expect(c.project?.root).toBe(process.env.TIMMY_REPO);
    expect(c.ollama.starters.find((s) => s.model === 'qwen3:0.6b')?.size).toBe('523 MB');
    expect(typeof c.ollama.install.install).toBe('string');
  });

  it('GET /api/chat/view?local=skip asks the local Ollama nothing (the page has no permission yet); without it, Ollama is asked', async () => {
    asked = [];
    const skip = await fetch(`${base}/api/chat/view?local=skip`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(skip.status).toBe(200);
    const v = await skip.json() as { choice: { check?: { state: string; words: string } } };
    expect(asked).toEqual([]);
    expect(v.choice.check?.state).toBe('unknown');
    const asks = await fetch(`${base}/api/chat/view?fresh=1`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(asks.status).toBe(200);
    expect(asked).toContain('/api/tags');
  });
});

describe('timmy app (R12): the launcher', () => {
  const fakeServer = (port: number) => ({ port, address: `http://127.0.0.1:${port}/`, url: `http://127.0.0.1:${port}/#t=${TOKEN}`, shutdown: async () => { /* closed */ } });
  let built = '';
  beforeAll(() => { built = mkdtempSync(join(tmpdir(), 'r12-app-root-')); mkdirSync(join(built, 'dist'), { recursive: true }); writeFileSync(join(built, 'dist', 'app.js'), '// built'); });
  afterAll(() => { if (built) rmSync(built, { recursive: true, force: true }); });

  it('the app\'s address is the companion\'s, with /app and the same token in the fragment', () => {
    expect(appUrlOf(`http://127.0.0.1:3001/#t=${TOKEN}`)).toBe(`http://127.0.0.1:3001/app#t=${TOKEN}`);
  });

  it('starts the companion on the asked port, opens /app with its token, prints the address without it, and stops', async () => {
    const lines: string[] = [];
    const opened: string[] = [];
    let stop!: () => void;
    const until = new Promise<void>((r) => { stop = r; });
    const ran = runApp(['--port', '3999'], { root: built, keys: null, until, out: (l) => lines.push(l), env: {}, start: async (port) => fakeServer(port) as never, open: async (u) => { opened.push(u); return 'asked'; } });
    await new Promise((r) => setTimeout(r, 30));
    stop();
    expect(await ran).toBe(0);
    expect(opened).toEqual([`http://127.0.0.1:3999/app#t=${TOKEN}`]);
    expect(lines[0]).toBe('Timmy app: http://127.0.0.1:3999/app');
    expect(lines.join('\n')).not.toContain(TOKEN);
    expect(lines.at(-1)).toBe('Timmy app stopped.');
  });

  it('a taken port moves to the next one, and says so; --no-open opens nothing', async () => {
    const lines: string[] = [];
    const opened: string[] = [];
    const tried: number[] = [];
    const ran = await runApp(['--port', '3999', '--no-open'], {
      root: built, keys: null, until: Promise.resolve(), out: (l) => lines.push(l), env: {}, open: async (u) => { opened.push(u); return 'asked'; },
      start: async (port) => { tried.push(port); if (port === 3999) throw Object.assign(new Error('in use'), { code: 'EADDRINUSE' }); return fakeServer(port) as never; },
    });
    expect(ran).toBe(0);
    expect(tried.slice(0, 2)).toEqual([3999, 4000]);
    expect(opened).toEqual([]);
    expect(lines[0]).toContain('3999, the port asked for, was taken');
  });

  it('a bad argument is 2, a missing build is 69, each with its words', async () => {
    const lines: string[] = [];
    expect(await runApp(['--bogus'], { root: built, out: (l) => lines.push(l) })).toBe(2);
    expect(lines.join('\n')).toContain('unknown argument --bogus');
    expect(await runApp(['--port', 'x'], { root: built, out: (l) => lines.push(l) })).toBe(2);
    const empty = mkdtempSync(join(tmpdir(), 'r12-app-empty-'));
    try {
      expect(await runApp([], { root: empty, out: (l) => lines.push(l) })).toBe(69);
      expect(lines.at(-1)).toBe(`timmy app: ${APP_NOT_BUILT}`);
    } finally { rmSync(empty, { recursive: true, force: true }); }
  });
});
