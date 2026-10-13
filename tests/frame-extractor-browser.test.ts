// R4 (H97): the Rive frame extractor (src/graphics/frame-extractor.ts) in a real headless Chromium: its page, the installed
// Rive runtime (rive.js, rive.wasm from node_modules/@rive-app/canvas) and the animation the caller names are answered from
// this computer by page.route, and nothing is asked of any other origin (every request of the page is recorded by
// Playwright; one elsewhere would be aborted and recorded in `refused`). Before, the page loaded rive.js from unpkg and
// drew https://cdn.rive.app/animations/vehicles.riv whatever file was named.
// The animation itself is drawn only when the repository holds a local .riv file; it holds none now, so that test is
// skipped, saying so. Skipped too, saying so, where no Chromium or Chrome is found.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { RIVE_NONE_NAMED, RIVE_ORIGIN, RiveFrameExtractor, riveRuntimeFiles } from '../src/graphics/frame-extractor.js';

const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('frame-extractor-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

const repo = fileURLToPath(new URL('..', import.meta.url));
/** A .riv file the repository holds (tracked by git), if any. */
const localRiv = (() => {
  try { return execFileSync('git', ['ls-files', '--', '*.riv'], { cwd: repo, encoding: 'utf8' }).split('\n').filter(Boolean).map((f) => join(repo, f))[0]; } catch { return undefined; }
})();
if (!localRiv) console.warn('frame-extractor-browser: the repository holds no .riv file, so drawing an animation itself is not tested here');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const paths = (urls: string[]): string[] => urls.map((u) => new URL(u).pathname);

describe('the installed Rive runtime (R4 H97)', () => {
  it('is @rive-app/canvas\'s own rive.js, rive.wasm and rive_fallback.wasm, from this computer', () => {
    const rt = riveRuntimeFiles();
    expect(rt).not.toBeNull();
    const pkg = JSON.parse(readFileSync(join(repo, 'node_modules', '@rive-app', 'canvas', 'package.json'), 'utf8')) as { version: string };
    expect(rt!.version).toBe(pkg.version);
    for (const f of [rt!.js, rt!.wasm, rt!.fallback]) expect(f).toMatch(/node_modules[\\/]@rive-app[\\/]canvas[\\/]rive(_fallback)?\.(js|wasm)$/);
    // the WebAssembly is a WebAssembly module (\0asm)
    expect(readFileSync(rt!.wasm).subarray(0, 4)).toEqual(Buffer.from([0x00, 0x61, 0x73, 0x6d]));
  });
});

describe.skipIf(!browserPath)('the Rive frame extractor in a real browser (R4 H97)', () => {
  let dir = '';
  let x: RiveFrameExtractor | null = null;
  const launch = () => ({ launch: { executablePath: browserPath } });

  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'h97-rive-')); });
  // R4 (H114; the suite at 86a10be: this hook timed out at 10 s, then the next test read `refused` of null): the extractor is
  // taken off `x` before its stop is awaited, so a stop that ends after the hook's limit cannot clear the next test's. Its
  // stop awaits Playwright's close of Chromium, which has no deadline of its own (tests/suite-causes-teardowns.test.ts says
  // what was measured): 30 s for it under a loaded machine
  afterEach(async () => { const was = x; x = null; await was?.stop(); }, 30_000);
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('with no file named, downloads nothing and says so on the canvas; its frames are real PNGs of that canvas', async () => {
    x = new RiveFrameExtractor();
    const status = await x.init('', 400, 300, launch());
    expect(status).toEqual({ state: 'none-named', words: RIVE_NONE_NAMED });
    await x.setState('thinking');
    const frames = x.frameGenerator(20);
    const first = (await frames.next()).value!;
    await frames.return(undefined);
    expect(first.data.subarray(0, 8)).toEqual(PNG_SIGNATURE);
    expect([first.width, first.height]).toEqual([400, 300]);
    expect(x.refused).toEqual([]);
    for (const u of x.requested) expect(new URL(u).origin, u).toBe(RIVE_ORIGIN);
    expect(paths(x.requested)).toEqual(['/', '/rive.js']);
  }, 60_000);

  it('a named file that cannot be read is said, with its reason; nothing is asked elsewhere', async () => {
    x = new RiveFrameExtractor();
    const status = await x.init(join(dir, 'missing.riv'), 400, 300, launch());
    expect(status.state).toBe('unreadable');
    expect(status.words).toContain('cannot be read (ENOENT)');
    expect(x.refused).toEqual([]);
    expect(paths(x.requested)).toEqual(['/', '/rive.js']);
  }, 60_000);

  it('a named file that is not a Rive file: the installed runtime and its WebAssembly load from this computer, and the canvas says the file did not load', async () => {
    const notRive = join(dir, 'not-rive.riv');
    writeFileSync(notRive, Buffer.from('not a rive file, written by the test'));
    x = new RiveFrameExtractor();
    const status = await x.init(notRive, 400, 300, launch());
    expect(status.state).toBe('load-error');
    expect(status.words).toMatch(/^The named Rive file did not load: /);
    // the runtime itself loaded (its WebAssembly compiled): the failure is the file's, not the runtime's
    expect(status.words).not.toMatch(/WASM/);
    expect(x.refused).toEqual([]);
    for (const u of x.requested) expect(new URL(u).origin, u).toBe(RIVE_ORIGIN);
    expect(paths(x.requested)).toEqual(expect.arrayContaining(['/', '/rive.js', '/rive.wasm', '/animation.riv']));
    expect(paths(x.requested)).not.toContain('/rive_fallback.wasm');
  }, 60_000);

  it.skipIf(!localRiv)('a local .riv file of the repository plays, from this computer only', async () => {
    x = new RiveFrameExtractor();
    const status = await x.init(localRiv!, 400, 300, launch());
    expect(status.state).toBe('playing');
    expect(x.refused).toEqual([]);
    for (const u of x.requested) expect(new URL(u).origin, u).toBe(RIVE_ORIGIN);
  }, 60_000);
});
