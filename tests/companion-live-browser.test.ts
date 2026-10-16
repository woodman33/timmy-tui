/**
 * R6 (H140; the R5 interaction review, claim c: the companion page kept "● live · answered just now" for its own companion for
 * 2.5 min after the Workbench that served it quit, beside "COMPANION SOCKET · RECONNECTING"): the page's own card stops being
 * green as soon as the page's own reads of the frame fail, and says when the companion last answered it and that its reads
 * fail now; no other card stays green on a frame the page cannot read again.
 *
 * Real: a browser companion in a process of its own (tests/fixtures/h140-companion-child.mts) at the address the frame names,
 * its page in a headless Chromium (opened at the address the companion gives, its token kept in memory), the frame producer,
 * and SIGKILL (no stop is noted). FAKE, labelled: one observation of Ollama ("answered" 5 s before the companion starts, no
 * Ollama asked), so a second card is green before the kill. Skipped, saying so, where no Chromium or Chrome is found. With
 * TIMMY_CAPTURE_DIR set, the page is saved there before and after the kill (no address or token is in a capture).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONNECTIONS_SCHEMA, writeConnections } from '../src/ops/workspace-frame.js';

const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('companion-live-browser: no Chromium or Chrome found, so the real-browser check is skipped here');

const LOADER = createRequire(import.meta.url).resolve('tsx');
const CHILD = join(import.meta.dirname, 'fixtures', 'h140-companion-child.mts');
const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const s = createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const a = s.address(); const p = typeof a === 'object' && a ? a.port : 0; s.close(() => resolve(p)); });
});

describe.skipIf(!browserPath)('the companion page\'s own card after its companion is killed (a real browser, a real companion process)', () => {
  let box = '';
  let browser: Browser;
  const children: ChildProcess[] = [];
  beforeAll(async () => {
    box = mkdtempSync(join(tmpdir(), 'h140-live-browser-'));
    browser = await chromium.launch({ headless: true, executablePath: browserPath, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  }, 120_000);
  afterAll(async () => {
    for (const c of children) { try { c.kill('SIGKILL'); } catch { /* ended */ } }
    await browser?.close();
    if (box) rmSync(box, { recursive: true, force: true });
  });

  it('green while it answers the page; killed with SIGKILL, the card is ✕ "not answering this page" with when it last answered, within one read, and nothing on the page stays green', async () => {
    const project = join(box, 'FAKE-project');
    mkdirSync(join(project, '.timmy', 'receipts'), { recursive: true });
    const port = await freePort();
    const env = { HOME: box, PATH: process.env.PATH, TIMMY_HOME: join(box, 'home'), TIMMY_SETTINGS_DIR: join(box, 'settings'), TIMMY_REPO: project, TIMMY_COMPANION_PORT: String(port), OLLAMA_HOST: 'http://127.0.0.1:11434' };
    // FAKE: Ollama "answered" a check just before (no Ollama is asked): a second green card before the kill
    writeConnections({ schema: CONNECTIONS_SCHEMA, checks: { ollama: { answer: 'accepted', at: new Date(Date.now() - 5000).toISOString(), detail: 'FAKE: 1 local model', asked: 'http://127.0.0.1:11434' } } }, env);
    const child = spawn(process.execPath, ['--import', LOADER, CHILD], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const hello = await new Promise<{ port: number; url: string; pid: number }>((resolve, reject) => {
      let out = '';
      let err = '';
      const timer = setTimeout(() => reject(new Error(`the companion child said nothing in 30 s: ${err.slice(-400)}`)), 30_000);
      child.stderr!.setEncoding('utf8').on('data', (d: string) => { err += d; });
      child.stdout!.setEncoding('utf8').on('data', (d: string) => { out += d; const i = out.indexOf('\n'); if (i >= 0) { clearTimeout(timer); resolve(JSON.parse(out.slice(0, i))); } });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`the companion child ended (${code}): ${err.slice(-400)}`)); });
    });
    expect(hello.port).toBe(port);
    const context = await browser.newContext({ viewport: { width: 1376, height: 900 } });
    const errors: string[] = [];
    try {
      const page = await context.newPage();
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(hello.url);
      const conn = '#home-connections [data-connection="companion"]';
      await page.waitForFunction((sel) => document.querySelector(`${sel} .conn-state`)?.textContent === '● live', conn, { timeout: 30_000 });
      expect(await page.getAttribute(`${conn} .conn-state`, 'class')).toContain('is-live');
      expect(await page.textContent(`${conn} .conn-words`)).toBe('answered just now (its page asked for its frame); live: an answer within the last 60 s');
      expect(await page.textContent('#home-connections [data-connection="ollama"] .conn-state')).toBe('● live');
      if (process.env.TIMMY_CAPTURE_DIR) await page.screenshot({ path: join(process.env.TIMMY_CAPTURE_DIR, 'companion-live-before-kill.png'), fullPage: false });

      // the companion's process is killed: it notes no stop
      const t0 = Date.now();
      child.kill('SIGKILL');
      await exited;
      await page.waitForFunction((sel) => document.querySelector(`${sel} .conn-state`)?.textContent === '✕ unreachable', conn, { timeout: 10_000 });
      const took = Date.now() - t0;
      // within one read of the frame (the page reads every 3 s, and at once when its socket closes)
      expect(took).toBeLessThan(4000);
      const words = await page.textContent(`${conn} .conn-words`);
      expect(words).toMatch(/^not answering this page: its reads of the frame fail since \d\d:\d\d:\d\d \((.+)\); it last answered this page at \d\d:\d\d:\d\d$/);
      expect(await page.getAttribute(`${conn} .conn-state`, 'class')).not.toContain('is-live');
      // no other card stays green: Ollama's says it is not known now, and what the frame said when last read
      expect(await page.textContent('#home-connections [data-connection="ollama"] .conn-state')).toBe('? unknown');
      expect(await page.textContent('#home-connections [data-connection="ollama"] .conn-words')).toMatch(/^not known now: this page cannot read the frame; when it last could \(\d\d:\d\d:\d\d\), the frame said: answered just now \(FAKE: 1 local model\); live: an answer within the last 30 min$/);
      expect(await page.locator('#home-connections .conn-state.is-live').count()).toBe(0);
      expect(await page.locator('#home-preview .state-word.is-live').count()).toBe(0);
      // the strip says the companion did not answer
      expect(await page.textContent('#ws-strip-note')).toMatch(/^The companion did not answer at \d\d:\d\d:\d\d \(.+\); this is the frame read before\.$/);
      if (process.env.TIMMY_CAPTURE_DIR) await page.screenshot({ path: join(process.env.TIMMY_CAPTURE_DIR, 'companion-live-after-kill.png'), fullPage: false });
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 90_000);
});
