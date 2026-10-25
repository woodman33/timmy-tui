/**
 * R4 (H95): how the browser companion and the log companion serve the companion's built web code at /web/
 * (src/companion/web-assets.ts), over real HTTP on 127.0.0.1: only its island, chunk, style and font files, each with its
 * type and nosniff; anything else under /web/ (its record, its notices, a licence, a climb out of the folder, an encoded
 * one) a 404 in words with no path of this computer. Where the build is missing (a test's empty folder), each island's
 * entry answers a module of the server's own that says so where the chat would be, and every other file a 404 in words: in
 * a real Chromium, the STREAMDOWN CHAT tab shows those words under the page's policy, and nothing is loaded from elsewhere.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WEB_DIR, ensureCompanionWeb } from '../scripts/companion-web-build.mjs';
import { startCompanionServer } from '../src/companion/server.js';
import { WEB_ABSENT_SOURCE, WEB_NOT_FOUND } from '../src/companion/web-assets.js';
import { startManagedLogServer } from '../src/utils/logserver.js';

const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));

/** A GET with its path sent exactly as written (fetch would resolve '..' before sending). */
function raw(port: number, path: string): Promise<{ status: number; type: string; nosniff: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += String(c); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), nosniff: String(res.headers['x-content-type-options'] ?? ''), body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('the companion\'s built web code at /web/, from both local servers (R4 H95)', () => {
  const temps: string[] = [];
  const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); temps.push(d); return d; };
  beforeAll(async () => { await ensureCompanionWeb(); }, 600_000);
  afterAll(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

  it('serves its island, chunk, style and font files with their types; anything else under /web/ is a 404 in words, no path shown', async () => {
    const companion = await startCompanionServer(0, {});
    try {
      const want: Array<[string, RegExp]> = [
        ['/web/island/companion-chat.js', /^text\/javascript/], ['/web/island/logs-chat.js', /^text\/javascript/],
        ['/web/styles/tailwind.css', /^text\/css/], ['/web/styles/streamdown.css', /^text\/css/],
        ['/web/fonts/outfit-latin-wght-normal.woff2', /^font\/woff2/], ['/web/fonts/inter-latin-wght-normal.woff2', /^font\/woff2/], ['/web/fonts/fira-code-latin-wght-normal.woff2', /^font\/woff2/],
      ];
      for (const [path, type] of want) {
        const a = await raw(companion.port, path);
        expect(a.status, path).toBe(200);
        expect(a.type, path).toMatch(type);
        expect(a.nosniff, path).toBe('nosniff');
      }
      const chunk = /from"\.\/chunks\/([\w-]+\.js)"/.exec((await raw(companion.port, '/web/island/companion-chat.js')).body)?.[1];
      expect(chunk).toBeTruthy();
      expect((await raw(companion.port, `/web/island/chunks/${chunk}`)).status).toBe(200);
      for (const path of ['/web/versions.json', '/web/THIRD-PARTY-NOTICES.md', '/web/fonts/outfit-LICENSE.txt', '/web/island/../../package.json', '/web/island/%2e%2e/%2e%2e/package.json', '/web/island/chunks/../../versions.json', '/web/styles/../island/companion-chat.js', '/web/island/missing.js', '/web/', '/web/island/companion-chat.js.map']) {
        const a = await raw(companion.port, path);
        expect(a.status, path).toBe(404);
        expect(a.body.trim(), path).toBe(WEB_NOT_FOUND);
        expect(a.body, path).not.toContain(process.cwd());
      }
    } finally { await companion.shutdown(); }
  });

  it('the log companion serves the same files, and its chat mirror\'s token script', async () => {
    const logs = await startManagedLogServer({ port: 0 });
    try {
      for (const path of ['/web/island/logs-chat.js', '/chat/page.js']) {
        const a = await raw(logs.port, path);
        expect(a.status, path).toBe(200);
        expect(a.type, path).toMatch(/^text\/javascript/);
        expect(a.nosniff, path).toBe('nosniff');
      }
      const record = await raw(logs.port, '/web/versions.json');
      expect(record.status).toBe(404);
      expect(record.body.trim()).toBe(WEB_NOT_FOUND);
      // the log companion resolves the dots before it routes (new URL), so a climb out of /web/, plain or encoded, asks for
      // /package.json, which it answers as it answers every address it does not know: with its main page, never the file
      for (const path of ['/web/island/../../package.json', '/web/island/%2e%2e/%2e%2e/package.json']) {
        const climb = await raw(logs.port, path);
        expect(climb.body, path).not.toContain('"devDependencies"');
        expect(climb.body, path).toContain('DISPATCH · COMMAND POST');
      }
    } finally { await logs.stop(); }
  });

  it('where the build is missing, each island\'s entry is a module of the server\'s own that says so, and every other file a 404 in words', async () => {
    const empty = temp('h95-noweb-');
    const companion = await startCompanionServer(0, { webDir: empty });
    const logs = await startManagedLogServer({ port: 0, webDir: empty });
    try {
      const entry = await raw(companion.port, '/web/island/companion-chat.js');
      expect(entry.status).toBe(200);
      expect(entry.type).toMatch(/^text\/javascript/);
      expect(entry.body).toContain(JSON.stringify(WEB_ABSENT_SOURCE));
      expect(entry.body).toContain('getElementById("streamdown-root")');
      expect(entry.body).not.toContain(empty);
      const mirror = await raw(logs.port, '/web/island/logs-chat.js');
      expect(mirror.body).toContain('getElementById("left")');
      for (const path of ['/web/styles/tailwind.css', '/web/fonts/inter-latin-wght-normal.woff2', '/web/island/chunks/chunk-X.js']) {
        const a = await raw(companion.port, path);
        expect(a.status, path).toBe(404);
        expect(a.body.trim(), path).toBe(WEB_NOT_FOUND);
      }
    } finally { await companion.shutdown(); await logs.stop(); }
  });

  it.skipIf(!browserPath)('in a real browser, a missing build leaves the page working and the chat tab saying so, under the page\'s policy, asking nothing elsewhere', async () => {
    const empty = temp('h95-noweb-page-');
    const companion = await startCompanionServer(0, { webDir: empty, upstream: 'http://127.0.0.1:9/' });
    const base = `http://127.0.0.1:${companion.port}`;
    const browser = await chromium.launch({ headless: true, executablePath: browserPath, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
    try {
      const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
      const outside: string[] = [];
      await context.route('**/*', (route) => { const u = new URL(route.request().url()); if (u.origin === base) return route.continue(); outside.push(u.href); return route.abort(); });
      await context.addInitScript(() => { (window as unknown as { __v: string[] }).__v = []; document.addEventListener('securitypolicyviolation', (e) => (window as unknown as { __v: string[] }).__v.push(e.effectiveDirective)); });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(companion.url);
      await page.waitForFunction(() => document.getElementById('status-text')?.textContent === 'COMPANION SOCKET · CONNECTED', null, { timeout: 30_000 });
      // R5 (H132): the model chat is the Chat tab's (2) second view
      // R10 CHAT (H171): the shell's left menu opens Chat, whose older views keep this page's Streamdown chat
      await page.click('#rail-menu .rail-item[data-dest="chat"]');
      // R11 round 7 (the lead): the Chat's older views, the Streamdown island among them, sit behind the page's CLOSED records
      // ("Try a Markdown sample" is the island's switch) — open the records before the switch, as the policy test's tab() does
      await page.evaluate(() => document.querySelector('#ws-chat .page-records details.records')?.setAttribute('open', ''));
      await page.click('[data-tab="streamdown"]');
      await page.waitForFunction(() => document.getElementById('streamdown-root')?.dataset.island === 'absent', null, { timeout: 10_000 });
      expect(await page.textContent('#streamdown-root .sd-absent')).toBe(WEB_ABSENT_SOURCE);
      expect(outside).toEqual([]);
      expect(await page.evaluate(() => (window as unknown as { __v: string[] }).__v)).toEqual([]);
      expect(errors).toEqual([]);
      await context.close();
    } finally { await browser.close(); await companion.shutdown(); }
  });

  it('the build\'s folder, its lock and a build in progress are ignored by git (never committed), as git itself says', () => {
    expect(WEB_DIR).toBe(join('dist', 'companion-web'));
    const paths = [join(WEB_DIR, 'island', 'companion-chat.js'), `${WEB_DIR}.lock/x`, `${WEB_DIR}.tmp-1-2/x`];
    // git check-ignore exits 0 and names every path it ignores (1 if none is)
    const out = execFileSync('git', ['check-ignore', ...paths], { cwd: process.cwd(), encoding: 'utf8' });
    expect(out.trim().split('\n')).toEqual(paths);
    const ignore = readFileSync(join(process.cwd(), '.gitignore'), 'utf8');
    expect(ignore).toMatch(/^dist\/companion-web\/$/m);
  });
});
