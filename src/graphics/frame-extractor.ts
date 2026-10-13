/**
 * The Rive frame extractor: a Rive animation drawn in a headless Chromium, its canvas captured as frames for the terminal's
 * graphics pipelines (opt-in: ENABLE_RIVE_PLAYWRIGHT=true, src/tui/hooks/useGraphicsPipeline.ts).
 *
 * Round R4 (helper H97): its page loaded the Rive runtime from unpkg (rive.js 2.9.1, whose WebAssembly comes from unpkg or
 * jsdelivr) and drew a public animation from cdn.rive.app, whatever file the caller named. Now the page fetches nothing from
 * the internet:
 *   - the page, the runtime (rive.js) and its WebAssembly (rive.wasm, and rive_fallback.wasm for older processors) are the
 *     installed @rive-app/canvas's own files, answered from this computer by Playwright's page.route; the page's origin is a
 *     name that resolves nowhere (RIVE_ORIGIN, .invalid), and the browser is started resolving no name at all;
 *   - the animation is a local .riv file the caller names; none is downloaded, and when none is named, or the one named
 *     cannot be read or drawn, the canvas says so in words (and `status` says it to the caller);
 *   - the runtime's asset CDN is off (enableRiveAssetCDN false): a font or image a .riv names by a CDN address is not fetched;
 *   - every other request is aborted before it leaves, and recorded in `refused`; `requested` records every request.
 * Timmy's states reach the animation through its playing state machines: an input named like the state (idle, thinking,
 * streaming, tool_call, error, success) is set (a boolean: true for that state, false otherwise) or fired (a trigger).
 */
import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { chromium, type Browser, type LaunchOptions, type Page, type Route } from 'playwright';
import { EventEmitter } from 'eventemitter3';
import type { FrameBuffer } from './pipeline.js';
import { logger } from '../utils/logger.js';
import { tildePath } from '../utils/home-scrub.js';
import { HOMEBREW, TYPE } from '../theme/tokens.js';

/** The page's origin: a name that resolves nowhere (RFC 2606 .invalid); only page.route answers it. */
export const RIVE_ORIGIN = 'http://timmy-rive.invalid';
/** The largest .riv file the extractor reads. */
export const RIVE_FILE_MAX = 64 * 1024 * 1024;

export const RIVE_NONE_NAMED = 'No Rive animation named, and Timmy downloads none: name a local .riv file to draw one.';
export const RIVE_NO_RUNTIME = 'The Rive runtime (@rive-app/canvas) is not installed with this Timmy, so no animation is drawn.';

/** What the extractor's page shows: the animation (`playing`), or why not, in words. */
export type RiveState = 'none-named' | 'unreadable' | 'no-runtime' | 'playing' | 'load-error';
export interface RiveStatus { state: RiveState; words: string }

export interface RiveRuntimeFiles { version: string; js: string; wasm: string; fallback: string }

/** The installed @rive-app/canvas's runtime files (Timmy's own dependency); null when it is not installed. */
export function riveRuntimeFiles(): RiveRuntimeFiles | null {
  try {
    const req = createRequire(import.meta.url);
    const dir = path.dirname(req.resolve('@rive-app/canvas/package.json'));
    const version = (req('@rive-app/canvas/package.json') as { version?: unknown }).version;
    const files = { js: path.join(dir, 'rive.js'), wasm: path.join(dir, 'rive.wasm'), fallback: path.join(dir, 'rive_fallback.wasm') };
    for (const f of Object.values(files)) if (!statSync(f).isFile()) return null;
    return { version: typeof version === 'string' ? version : 'unknown', ...files };
  } catch { return null; }
}

/** A named .riv file that can be served: its absolute path, or why not in words. */
function namedFile(riveFile: string | null | undefined): { file: string } | RiveStatus {
  if (!riveFile || !riveFile.trim()) return { state: 'none-named', words: RIVE_NONE_NAMED };
  const file = path.resolve(riveFile);
  const shown = tildePath(file);
  try {
    const st = statSync(file);
    if (!st.isFile()) return { state: 'unreadable', words: `The Rive file named (${shown}) is not a file, so no animation is drawn.` };
    if (st.size > RIVE_FILE_MAX) return { state: 'unreadable', words: `The Rive file named (${shown}) is larger than ${RIVE_FILE_MAX / 1024 / 1024} MB, so it is not read.` };
  } catch (e) {
    return { state: 'unreadable', words: `The Rive file named (${shown}) cannot be read (${(e as NodeJS.ErrnoException).code ?? 'an error'}), so no animation is drawn.` };
  }
  return { file };
}

export interface RiveInitOptions {
  /** the state machine to play (else the runtime's choice: the file's first animation, else its first state machine) */
  stateMachine?: string;
  /** added to Chromium's launch (a test's executablePath, more args); the name-resolving rule is always kept */
  launch?: LaunchOptions;
  /** how long the page may take to say what it shows (default 15 s) */
  timeoutMs?: number;
}

export class RiveFrameExtractor extends EventEmitter {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private running = false;
  private frameId = 0;
  private currentState = 'idle';
  /** Every address the page asked for (Playwright's record of the browser's requests), in order. */
  readonly requested: string[] = [];
  /** Every address elsewhere the page asked for: each aborted before it left. */
  readonly refused: string[] = [];
  /** What the page shows, once init has settled. */
  status: RiveStatus | null = null;

  /** Starts the page for the local .riv file `riveFile` (none: '' or null, and the canvas says so) and settles what it shows. */
  async init(riveFile?: string | null, width = 400, height = 300, o: RiveInitOptions = {}): Promise<RiveStatus> {
    const runtime = riveRuntimeFiles();
    const named = namedFile(riveFile);
    logger.info('Starting headless browser for Rive frame extraction');
    const launch = o.launch ?? {};
    // the page needs no name resolved: every name resolves to nothing, so a request that escaped the routes could not leave
    this.browser = await chromium.launch({ headless: true, ...launch, args: [...(launch.args ?? []), '--host-resolver-rules=MAP * ~NOTFOUND'] });
    const context = await this.browser.newContext({ viewport: { width, height } });
    context.on('request', (r) => { this.requested.push(r.url()); });
    this.page = await context.newPage();

    const served = new Map<string, { path?: string; body?: string; contentType: string }>();
    served.set('/', { body: buildRiveHtml({ width, height, runtime: Boolean(runtime), named, stateMachine: o.stateMachine }), contentType: 'text/html; charset=utf-8' });
    if (runtime) {
      served.set('/rive.js', { path: runtime.js, contentType: 'text/javascript; charset=utf-8' });
      served.set('/rive.wasm', { path: runtime.wasm, contentType: 'application/wasm' });
      served.set('/rive_fallback.wasm', { path: runtime.fallback, contentType: 'application/wasm' });
    }
    if ('file' in named) served.set('/animation.riv', { path: named.file, contentType: 'application/octet-stream' });
    await this.page.route('**/*', async (route: Route) => {
      const url = new URL(route.request().url());
      if (url.origin !== RIVE_ORIGIN) { this.refused.push(url.href); await route.abort('blockedbyclient'); return; }
      const f = served.get(url.pathname);
      if (!f) { await route.fulfill({ status: 404, contentType: 'text/plain; charset=utf-8', body: 'Not served here.' }); return; }
      await route.fulfill({ status: 200, contentType: f.contentType, headers: { 'Cache-Control': 'no-store' }, ...(f.path ? { path: f.path } : { body: f.body }) });
    });

    await this.page.goto(`${RIVE_ORIGIN}/`, { waitUntil: 'load' });
    await this.page.waitForFunction(() => {
      const s = (window as unknown as { __timmyRive?: { state: string } }).__timmyRive;
      return Boolean(s && s.state !== 'starting' && s.state !== 'loading');
    }, null, { timeout: o.timeoutMs ?? 15_000 });
    this.status = await this.page.evaluate(() => (window as unknown as { __timmyRive: RiveStatus }).__timmyRive);
    if (this.status.state === 'playing') logger.info(`Rive frame extraction: ${this.status.words}`);
    else logger.warn(`Rive frame extraction: ${this.status.words}`);
    return this.status;
  }

  async setState(state: string): Promise<void> {
    this.currentState = state;
    if (this.page) {
      try {
        await this.page.evaluate((s: string) => {
          (window as any).setRiveState?.(s);
        }, state);
      } catch (e) {
        logger.error('Failed to set Rive state:', state, e);
      }
    }
  }

  async *frameGenerator(fps = 20): AsyncGenerator<FrameBuffer> {
    this.running = true;
    const interval = 1000 / fps;
    let lastCapture = 0;

    while (this.running && this.page) {
      const now = Date.now();
      if (now - lastCapture >= interval) {
        try {
          const canvas = await this.page.$('canvas');
          if (canvas) {
            const data = await canvas.screenshot({ type: 'png' });
            const vp = this.page.viewportSize();
            yield {
              data,
              width: vp?.width || 400,
              height: vp?.height || 300,
              id: this.frameId++,
              timestamp: now,
            };
          }
        } catch (e) {
          logger.error('Frame capture error:', e);
        }
        lastCapture = now;
      }
      // Sleep to avoid pegging CPU
      await new Promise(r => setTimeout(r, Math.max(1, interval - (Date.now() - lastCapture))));
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
    }
  }
}

/** The extractor's page: the installed runtime from its own origin, the named file (or the words why there is none). */
function buildRiveHtml(o: { width: number; height: number; runtime: boolean; named: { file: string } | RiveStatus; stateMachine?: string }): string {
  const config = {
    origin: RIVE_ORIGIN,
    animation: 'file' in o.named ? '/animation.riv' : null,
    stateMachine: o.stateMachine ?? null,
    status: 'file' in o.named ? null : o.named,
    noRuntime: RIVE_NO_RUNTIME,
    playing: `Playing the named Rive file${o.stateMachine ? ` (state machine ${o.stateMachine})` : ''}, with the installed runtime; nothing fetched from elsewhere.`,
    loadError: 'The named Rive file did not load:',
    colors: { ground: HOMEBREW.ground, accent: HOMEBREW.accent, text: HOMEBREW.text, secondary: HOMEBREW.textSecondary },
    font: TYPE.stack,
  };
  // the page loads only its own origin's files; the runtime compiles WebAssembly, and nothing else is allowed
  const policy = "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; connect-src 'self'; img-src 'self' data: blob:; style-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${policy}">
<link rel="icon" href="data:,">
<style>
  body { margin: 0; background: ${HOMEBREW.ground}; display: flex; align-items: center; justify-content: center; width: 100vw; height: 100vh; overflow: hidden; }
  canvas { display: block; width: 100%; height: 100%; }
</style>
</head><body>
<canvas id="rive-canvas" width="${o.width}" height="${o.height}"></canvas>
${o.runtime ? '<script src="/rive.js"></script>' : ''}
<script>
(function () {
  var C = ${JSON.stringify(config).replace(/</g, '\\u003c')};
  var canvas = document.getElementById('rive-canvas');
  var ctx = canvas.getContext('2d');
  var r = null, loaded = false, current = 'idle';
  window.__timmyRive = { state: 'starting', words: '' };
  function wrap(text, max) {
    var out = [], line = '';
    String(text).split(/\\s+/).forEach(function (w) {
      var t = line ? line + ' ' + w : w;
      if (line && ctx.measureText(t).width > max) { out.push(line); line = w; } else line = t;
    });
    if (line) out.push(line);
    return out;
  }
  function draw() {
    if (loaded) return;
    var s = window.__timmyRive, w = canvas.width, h = canvas.height;
    ctx.fillStyle = C.colors.ground; ctx.fillRect(0, 0, w, h);
    ctx.textAlign = 'center';
    ctx.fillStyle = C.colors.accent; ctx.font = '600 18px ' + C.font;
    ctx.fillText('Rive', w / 2, 40);
    ctx.fillStyle = C.colors.text; ctx.font = '14px ' + C.font;
    wrap(s.words, w - 40).forEach(function (l, i) { ctx.fillText(l, w / 2, 80 + i * 20); });
    ctx.fillStyle = C.colors.secondary; ctx.font = '13px ' + C.font;
    ctx.fillText('Timmy: ' + current, w / 2, h - 24);
  }
  function report(state, words) { window.__timmyRive = { state: state, words: words }; draw(); }
  window.setRiveState = function (state) {
    current = String(state);
    if (!loaded) { draw(); return; }
    try {
      r.playingStateMachineNames.forEach(function (name) {
        (r.stateMachineInputs(name) || []).forEach(function (i) {
          if (i.type === rive.StateMachineInputType.Boolean) i.value = (i.name === current);
          else if (i.type === rive.StateMachineInputType.Trigger && i.name === current) i.fire();
        });
      });
    } catch (e) { console.error('Rive state input error:', e); }
  };
  if (C.status) { report(C.status.state, C.status.words); return; }
  if (typeof rive === 'undefined') { report('no-runtime', C.noRuntime); return; }
  rive.RuntimeLoader.setWasmUrl(C.origin + '/rive.wasm');
  rive.RuntimeLoader.setWasmFallbackUrl(C.origin + '/rive_fallback.wasm');
  window.__timmyRive = { state: 'loading', words: '' };
  try {
    var params = {
      src: C.animation, canvas: canvas, autoplay: true, enableRiveAssetCDN: false,
      onLoad: function () { loaded = true; r.resizeDrawingSurfaceToCanvas(); window.__timmyRive = { state: 'playing', words: C.playing }; window.setRiveState(current); },
      onLoadError: function (e) { report('load-error', C.loadError + ' ' + (e && e.data ? e.data : 'no reason was given')); }
    };
    if (C.stateMachine) params.stateMachines = C.stateMachine;
    r = new rive.Rive(params);
  } catch (e) { report('load-error', C.loadError + ' ' + (e && e.message ? e.message : String(e))); }
})();
</script>
</body></html>
`;
}
