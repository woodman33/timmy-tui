/**
 * R11 round 6 (H174): tldraw's ACTUAL license state, read the SDK's own way (editor.licenseManager.state, the atom
 * <TldrawEditor/> assigns to the editor in tldraw 5.5.2) and said in words by companion/studio-canvas/src/license-state.js —
 * never inferred from a key being present, the key never read by the module, nothing hiding the SDK's notice or watermark.
 * (1) the words for every state the SDK names, and the watch over a FAKE editor whose state atom the test moves; (2) in a real
 * Chromium on the real Studio server and bundle, with TLDRAW_LICENSE_KEY set to a FAKE string the SDK rejects: the SDK's own
 * verdict 'unlicensed' (its development rule on 127.0.0.1: every feature on, no watermark), the readout's words, the FAKE key
 * string nowhere in the page, and no stylesheet of ours naming the SDK's watermark class.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLicenseReadout, LICENSE_WORDS, licenseReadout, WATERMARK_STATES } from '../companion/studio-canvas/src/license-state.js';
import { startStudioServer, type StudioServer } from '../src/studio/server.js';
import { grant, nameProject } from './helpers/canvas-auth.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium']
  .find((p): p is string => Boolean(p) && existsSync(p!));
/** A key string the SDK cannot parse (no signature part): FAKE, named so; never a real key. */
const FAKE_KEY = 'FAKE-tldraw-key-the-SDK-rejects.not-a-signature';

describe('tldraw\'s license state in words (R11 round 6, H174)', () => {
  it('says every state the SDK names in its own meaning; a watch over the SDK\'s atom tells each change once', () => {
    const states = ['pending', 'licensed', 'licensed-with-watermark', 'unlicensed', 'unlicensed-production', 'expired'];
    for (const state of states) {
      const r = licenseReadout({ licenseManager: { state: { get: () => state }, isDevelopment: false } });
      expect(r.state).toBe(state);
      expect(r.words).toBe(LICENSE_WORDS[state as keyof typeof LICENSE_WORDS]);
      expect(r.watermark).toBe(WATERMARK_STATES.includes(state));
      expect(r.checked).toBe(state !== 'pending');
    }
    expect(licenseReadout({})).toMatchObject({ state: 'unknown', checked: false, words: expect.stringMatching(/^not checked/) });
    expect(licenseReadout(null)).toMatchObject({ state: 'unknown' });
    // a FAKE editor: its atom moved by the test; the FAKE react runs the effect now and on every "change" the test signals
    let state = 'pending';
    let effect: (() => void) | null = null;
    const react = (_name: string, fn: () => void) => { effect = fn; fn(); return () => { effect = null; }; };
    const readout = createLicenseReadout({ react });
    const told: string[] = [];
    const stop = readout.watch({ licenseManager: { state: { get: () => state }, isDevelopment: true } }, (r) => told.push(`${r.state}|${r.watermark}|${r.development}`));
    expect(told).toEqual(['pending|false|true']);
    state = 'licensed'; effect!();
    effect!(); // the same state again tells nothing
    state = 'licensed-with-watermark'; effect!();
    expect(told).toEqual(['pending|false|true', 'licensed|false|true', 'licensed-with-watermark|true|true']);
    stop();
    expect(effect).toBeNull();
    // an editor without a manager: told once, nothing watched
    const once: string[] = [];
    readout.watch({}, (r) => once.push(r.state));
    expect(once).toEqual(['unknown']);
  });

  describe.skipIf(!browserPath)('the real SDK on the real Studio with a FAKE key it rejects', () => {
    let root = '';
    let home = '';
    let server: StudioServer | undefined;
    const port = (): number => (server!.address() as AddressInfo).port;
    beforeAll(async () => {
      root = mkdtempSync(join(tmpdir(), 'h174-license-root-'));
      home = mkdtempSync(join(tmpdir(), 'h174-license-home-'));
      copyFileSync(join(repo, 'companion', 'studio-canvas', 'index.html'), join(root, 'index.html'));
      const { buildCanvas } = (await import('../scripts/canvas/build.mjs')) as { buildCanvas: (r: string, o: string, x: { licenses: string }) => Promise<unknown> };
      await buildCanvas(repo, join(root, 'dist'), { licenses: root });
      server = await startStudioServer(0, { env: { TIMMY_HOME: home, HOME: home, TIMMY_SETTINGS_DIR: process.env.TIMMY_SETTINGS_DIR, TLDRAW_LICENSE_KEY: FAKE_KEY }, root });
      mkdirSync(join(home, 'project'));
      await nameProject(port(), server.projectToken, { root: join(home, 'project'), name: 'license-words' });
    }, 180_000);
    afterAll(async () => {
      await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    });

    it('the SDK says unlicensed for the FAKE key (its development rule on 127.0.0.1), the readout says so in words, the key is nowhere in the page, no sheet of ours names the watermark', async () => {
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/proxy/i.test(k))) as Record<string, string>;
      const browser = await chromium.launch({ headless: true, executablePath: browserPath, env, args: ['--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
      try {
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const page = await context.newPage();
        const consoleLines: string[] = [];
        page.on('console', (m) => consoleLines.push(m.text()));
        await page.goto(`http://127.0.0.1:${port()}/#code=${await grant(port(), server!.projectToken)}`);
        await page.waitForFunction(() => /Timmy connected/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 30_000 });
        // the SDK's own verdict, settled (the key given to <Tldraw/> through the Studio's config; the manager validates it)
        await page.waitForFunction(() => { const ed = (window as unknown as { timmyCanvas: { editor: { licenseManager?: { state: { get: () => string } } } } }).timmyCanvas.editor; return Boolean(ed.licenseManager) && ed.licenseManager!.state.get() !== 'pending'; }, null, { timeout: 20_000 });
        const sdk = await page.evaluate(() => { const ed = (window as unknown as { timmyCanvas: { editor: { licenseManager?: { state: { get: () => string }; isDevelopment: boolean } } } }).timmyCanvas.editor; return { state: ed.licenseManager!.state.get(), development: ed.licenseManager!.isDevelopment }; });
        expect(sdk).toEqual({ state: 'unlicensed', development: true });
        // the readout's words for that verdict (the module run here over the SDK's state read from the page)
        const r = licenseReadout({ licenseManager: { state: { get: () => sdk.state }, isDevelopment: sdk.development } });
        expect(r.words).toMatch(/^unlicensed: no valid license found or the key is invalid/);
        expect(r.watermark).toBe(false);
        // the Studio's own line (today's once-only read in canvas.js) carries the SDK's state too
        expect(await page.textContent('#side-about-canvas')).toMatch(/unlicensed/);
        // the key: never in the page's text, DOM or console
        const html = await page.content();
        expect(html).not.toContain(FAKE_KEY);
        expect(consoleLines.join('\n')).not.toContain(FAKE_KEY);
        // nothing of ours names the SDK's watermark class (its notice is never hidden with CSS)
        for (const f of ['companion/studio-canvas/index.html', 'companion/studio-canvas/src/canvas.js', 'companion/studio-canvas/src/theme.js', 'companion/studio-canvas/src/rive-shape.js', 'src/companion/client/rive-components.css']) {
          expect(readFileSync(join(repo, f), 'utf8'), f).not.toMatch(/tl-watermark/);
        }
        await context.close();
      } finally { await browser.close(); }
    }, 120_000);
  });
});
