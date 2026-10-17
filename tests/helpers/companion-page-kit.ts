/**
 * R7 (H152): one project for the companion page's R7 browser tests (tests/companion-text-size-browser.test.ts,
 * tests/companion-vox-room-browser.test.ts, tests/companion-r7-page-browser.test.ts): a real companion server on 127.0.0.1
 * with its token, a real headless Chromium, and a project that gives every tab something to draw.
 *
 * Real: the server, its token, the page's code, a /run in the REPL's own Workspace (upmd is the TEST DOUBLE of
 * tests/helpers/ops-sandbox.ts, labelled FAKE there), its records read by the companion's own producer. FAKE, labelled: the
 * VoxVision records (written and sealed by tests/helpers/vox-panel-kit.ts sealRecord, each saying FAKE; no tool ran) and
 * their images, and the run's image (a PNG the test's own block writes).
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { ensureCompanionWeb } from '../../scripts/companion-web-build.mjs';
import { startCompanionServer, type CompanionServer } from '../../src/companion/server.js';
import { folderProject, saveActiveProject } from '../../src/project/index.js';
import { replOf, sandbox, type OpsKit, type Sandbox } from './ops-sandbox.js';
import { reportProject, runOf } from './run-inspect-fixture.js';
import { png, sealRecord, writeFile } from './vox-panel-kit.js';

const F = '```';

export const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium']
  .find((p): p is string => Boolean(p) && existsSync(p!));

/** The two window sizes the operator's R7 order names: the review's laptop and a small window. */
export const SIZES = [{ width: 1376, height: 768 }, { width: 800, height: 600 }] as const;

export async function launchBrowser(): Promise<Browser> {
  await ensureCompanionWeb();
  return chromium.launch({ headless: true, executablePath: browserPath, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
}

/**
 * A FAKE VoxVision record of one image, `w` × `h`, with a colour region measured over it and its centroid (written and
 * sealed; no tool ran). `paint` draws the image: the default is a dark field with the region light, and a light band of
 * "text" where the image has its own words (the review's demo image has red words beside its region).
 */
export function fakeImageRecord(root: string, id: string, rel: string, w: number, h: number, at: string, box: [number, number, number, number],
  paint?: (x: number, y: number) => [number, number, number]): void {
  const img = writeFile(root, rel, png(w, h, paint ?? ((x, y) => (x >= box[0] && x < box[2] && y >= box[1] && y < box[3] ? [240, 240, 240] : [24, 24, 24]))));
  sealRecord(root, {
    schema: 'timmy.vox/1', id, action: 'detect', command: `/detect ${rel} color 240,240,240`, made_at: at, project: folderProject(root).name, status: 'ok',
    inputs: [{ ...img, kind: 'image', kind_by: 'bytes', frame: { space: 'pixels', unit: 'px', unit_by: 'reported', size: [w, h], words: `the image's pixel frame: ${w} × ${h} px (FAKE)` } }],
    tools: [{ tool: 'look', name: 'timmy-look', version: 'fake', ran: 'job', job: { id: 'j0fa4e3', state: 'completed', exit_code: 0 } }],
    metrics: [{
      name: 'color_region', title: 'Colour region',
      value: { rgb: [240, 240, 240], tolerance: 48, pixels: (box[2] - box[0]) * (box[3] - box[1]), share: ((box[2] - box[0]) * (box[3] - box[1])) / (w * h), centroid: [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2], box },
      unit: 'pixels', method: 'FAKE: written by the test, not measured', tier: 'deterministic computation', label: 'FAKE fixture', measured_by: 'timmy-look fake',
      status_word: 'measured', status_note: 'FAKE: written by the test',
    }],
    highlights: [], failures: [], notes: ['FAKE: a test fixture (tests/helpers/companion-page-kit.ts): no image was read and no tool ran.'],
  });
}

/** A run's FAKE block: writes `rel` (a `w` × `h` PNG) when `image`, else only a text file. */
export function shotDoc(name: string, o: { image?: { rel: string; w: number; h: number } } = {}): string {
  const lines = [`# FAKE run ${name} (tests/helpers/companion-page-kit.ts)`, '', `${F}bash [name:${name}]`, 'mkdir -p out'];
  if (o.image) {
    const big = png(o.image.w, o.image.h, (x, y) => (x > o.image!.w / 3 && x < (2 * o.image!.w) / 3 && y > o.image!.h / 3 && y < (2 * o.image!.h) / 3 ? [240, 240, 240] : [30, 30, 30]));
    lines.push(`printf '%s' '${big.toString('base64')}' | base64 -d > ${o.image.rel}`);
  } else {
    lines.push(`printf 'FAKE: a run that writes no image (%s)\\n' '${name}' > out/${name}.txt`);
  }
  lines.push(F, '');
  return lines.join('\n');
}

export interface PageProject {
  s: Sandbox;
  /** the run that wrote out/shot.png (640 × 360) */
  op: string;
  companion: CompanionServer;
  origin: string;
  token: string;
}

/**
 * The project: REPORT.md (the run inspection's FAKE report workflow), a run that writes a 640 × 360 image, and two FAKE
 * VoxVision records (an older 1280 × 720 one and the newest, 640 × 360); then the companion, following it.
 */
export async function pageProject(kit: OpsKit, o: { prefix?: string; records?: boolean } = {}): Promise<PageProject> {
  const s = sandbox(kit, o.prefix ?? 'companion-page-');
  reportProject(s);
  writeFile(s.root, 'SHOT.md', shotDoc('shot', { image: { rel: 'out/shot.png', w: 640, h: 360 } }));
  const { ws } = replOf(kit, s);
  const { op } = await runOf(ws, 'SHOT.md', 'shot');
  if (o.records !== false) {
    fakeImageRecord(s.root, 'vfa4e0b16', 'refs/large.png', 1280, 720, '2026-10-16T12:00:00.000Z', [200, 300, 900, 420]);
    fakeImageRecord(s.root, 'vfa4e0b17', 'refs/newest.png', 640, 360, '2026-10-16T12:05:00.000Z', [100, 60, 300, 160]);
  }
  saveActiveProject({ name: path.basename(s.root), root: s.root, chosen: true });
  const settings = mkdtempSync(path.join(tmpdir(), 'companion-page-settings-'));
  kit.dirs.push(settings);
  const companion = await startCompanionServer(0, { chatEnv: { TIMMY_HOME: settings, TIMMY_SETTINGS_DIR: settings } });
  const origin = `http://127.0.0.1:${companion.port}`;
  const token = /#t=([0-9a-f]{64})$/.exec(companion.url)![1];
  return { s, op, companion, origin, token };
}

/** A page of the companion at `size`, every request to another origin refused; its errors collected. */
export async function openPage(browser: Browser, p: Pick<PageProject, 'origin'>, size: { width: number; height: number }): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await browser.newContext({ viewport: { ...size }, deviceScaleFactor: 1 });
  await context.route('**/*', (route) => (new URL(route.request().url()).origin === p.origin ? route.continue() : route.abort('blockedbyclient')));
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return { context, page, errors };
}

/** The ten tabs, by their keys and ids (src/contracts/workspace.ts TABS). */
export const TAB_KEYS: ReadonlyArray<[string, string]> = [['1', 'home'], ['2', 'chat'], ['3', 'workflows'], ['4', 'studio'], ['5', 'voxvision'], ['6', 'create'], ['7', 'control'], ['8', 'fleet'], ['9', 'tools'], ['0', 'logs']];

/** Opens tab `id` with its key and waits until its page has drawn what it reads (no "Reading…" left on it), at most 20 s. */
export async function showTab(page: Page, key: string, id: string): Promise<void> {
  await page.keyboard.press(key);
  await page.waitForFunction((tab) => document.querySelector(`#ws-tabs [data-ws-tab="${tab}"]`)?.getAttribute('aria-selected') === 'true'
    && !(document.querySelector(`[data-ws-page="${tab}"]`) as HTMLElement | null)?.hidden, id, { timeout: 10_000 });
  await page.waitForFunction((tab) => {
    const shown = document.querySelector(`[data-ws-page="${tab}"]`);
    if (!shown || !document.querySelector('#ws-actions .act')) return false;
    const reading = [...shown.querySelectorAll('*')].some((el) => el.children.length === 0 && /^Reading\b/.test((el.textContent ?? '').trim()) && (el as HTMLElement).getClientRects().length > 0);
    return !reading;
  }, id, { timeout: 20_000 }).catch(() => undefined);
}

export interface SmallText { text: string; px: number; tag: string; cls: string; where: string }

/**
 * Every rendered text of the page (its text nodes, the content of its ::before and ::after, a field's placeholder) whose
 * size on screen is under `least` px: an element's computed font size, times the scale an SVG draws it at (its screen CTM).
 * Same-origin frames are read too. Text in a hidden tab is not rendered, so it is not read.
 */
export async function smallText(page: Page, least = 11): Promise<SmallText[]> {
  return page.evaluate((min) => {
    const out: Array<{ text: string; px: number; tag: string; cls: string; where: string }> = [];
    const clsOf = (el: Element): string => (typeof (el as HTMLElement).className === 'string' ? (el as HTMLElement).className : ((el as SVGElement).className as unknown as SVGAnimatedString)?.baseVal ?? '');
    const whereOf = (el: Element): string => {
      const page = el.closest('[data-ws-page]')?.getAttribute('data-ws-page');
      return page ?? (el.closest('dialog') ? 'dialog' : el.closest('#ws-activity') ? 'activity' : el.closest('header, nav, #ws-strip') ? 'chrome' : 'page');
    };
    const sizeOf = (el: Element, pseudo?: string): number => {
      let px = parseFloat(getComputedStyle(el, pseudo).fontSize);
      const svgEl = el as SVGGraphicsElement;
      if (el instanceof (el.ownerDocument.defaultView as Window & typeof globalThis).SVGElement && typeof svgEl.getScreenCTM === 'function') {
        const m = svgEl.getScreenCTM();
        if (m) px *= Math.hypot(m.a, m.b);
      }
      return Math.round(px * 100) / 100;
    };
    const read = (doc: Document, frame: string): void => {
      const walk = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const t = (n.textContent ?? '').replace(/\s+/g, ' ').trim();
        const el = n.parentElement;
        if (!t || !el) continue;
        const range = doc.createRange();
        range.selectNodeContents(n);
        if (![...range.getClientRects()].some((r) => r.width > 0 && r.height > 0)) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.opacity === '0') continue;
        const px = sizeOf(el);
        if (px < min - 0.01) out.push({ text: t.slice(0, 60), px, tag: el.tagName.toLowerCase(), cls: clsOf(el), where: `${frame}${whereOf(el)}` });
      }
      for (const el of doc.body.querySelectorAll('*')) {
        if (!(el as HTMLElement).getClientRects().length) continue;
        for (const pseudo of ['::before', '::after']) {
          const c = getComputedStyle(el, pseudo).content;
          if (!c || c === 'none' || c === 'normal' || c === '""' || c === "''") continue;
          if (getComputedStyle(el, pseudo).display === 'none') continue;
          const px = sizeOf(el, pseudo);
          if (px < min - 0.01) out.push({ text: `${pseudo} ${c.slice(0, 40)}`, px, tag: el.tagName.toLowerCase(), cls: clsOf(el), where: `${frame}${whereOf(el)}` });
        }
        if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.placeholder && !el.value) {
          const px = sizeOf(el);
          if (px < min - 0.01) out.push({ text: `placeholder ${el.placeholder.slice(0, 40)}`, px, tag: el.tagName.toLowerCase(), cls: clsOf(el), where: `${frame}${whereOf(el)}` });
        }
      }
      for (const f of doc.querySelectorAll('iframe')) {
        try { if (f.contentDocument?.body && (f as HTMLElement).getClientRects().length) read(f.contentDocument, `${frame}frame:`); } catch { /* another origin's: not this page's text */ }
      }
    };
    read(document, '');
    return out;
  }, least);
}

/** Cleans up what pageProject started that the kit does not: the companion. */
export async function closeProject(p: PageProject | undefined): Promise<void> {
  if (p) await p.companion.shutdown();
}
