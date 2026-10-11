/**
 * Round R4 (H76): the Control Room's tools panel with the ladder, in a real headless Chromium (skipped when none is found),
 * in a fresh browser context, against the Workspace's live board on 127.0.0.1: each row's rung in words, its
 * demonstrations on the operator's Mac beside it, and its ladder folded under it, kept open across a redraw.
 *
 * REAL pieces: the /tools rows come from capabilities() with liveDeps over a temporary machine (a temporary PATH holding
 * programs the checks find, and a receipts chain sealed with appendReceipt in the temporary project), handed to the
 * Workspace through its roomTools seam; the live board and its page.
 * FAKE pieces, each labelled: the programs are shell scripts that only say FAKE (found, never run); the OpenSCAD run behind
 * its sealed receipt was not run (its words are made up); the receipts the Workspace itself would seal are kept in memory.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { capabilities, type CapabilityRow } from '../src/capabilities/index.js';
import { liveDeps } from '../src/capabilities/live.js';
import { folderProject } from '../src/project/index.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import { HOMEBREW } from '../src/theme/tokens.js';
import { appendReceipt, type Receipt, type ReceiptInput } from '../src/utils/receipts.js';

const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('room-tools-ladder-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

const dirs: string[] = [];
const spaces: Workspace[] = [];
const temp = (prefix: string): string => { const d = realpathSync(mkdtempSync(join(tmpdir(), prefix))); dirs.push(d); return d; };
afterEach(async () => {
  for (const w of spaces.splice(0)) await w.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A FAKE program the checks find (never run). */
function program(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), '#!/bin/sh\necho "FAKE: found by the ladder tests, never run"\nexit 1\n');
  chmodSync(join(dir, name), 0o755);
}
async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** A project whose machine has OpenSCAD and oha found, one OpenSCAD run sealed ok, and the /tools rows of that machine. */
async function make() {
  const root = temp('ladder-browser-');
  const bin = join(root, 'bin');
  program(bin, 'openscad');
  program(bin, 'oha');
  writeFileSync(join(root, 'README.md'), '# FAKE project for the ladder browser test\n');
  const native: Receipt = appendReceipt('runs', {
    kind: 'native', subject: 'native · openscad · FAKE', policy: 'human-gated', status: 'ok', project: 'ladder',
    native: { app: 'openscad', outcome: 'ok', why: 'FAKE: a run made up for this test', exit_code: 0, signal: null, files: [], run: '0a1b2c3d-0000-4000-8000-0000000000b1' },
  } as ReceiptInput, root);
  const env = { PATH: bin, HOME: temp('ladder-browser-home-'), TIMMY_STUDIO_URL: `http://127.0.0.1:${await closedPort()}` };
  let checks = 0;
  // Each /room check asks the machine again; the second one also lists oha's row, so the panel's shape changes.
  const roomTools = async (): Promise<CapabilityRow[]> => {
    checks += 1;
    const rows = await capabilities(liveDeps({ env, model: 'fake/chat-model (FAKE)', storeDir: root, projectRoot: root }));
    return rows.filter((r) => ['openscad', 'openhands', 'vox:viser', ...(checks > 1 ? ['stress'] : [])].includes(r.id));
  };
  const sealed: ReceiptInput[] = [];
  const ws = new Workspace({
    glyphs: glyphSet(true), env: {}, onPath: () => null, notify: () => {}, openWeb: (url) => `Open ${url} in your browser.`, link: (t) => t,
    seal: (input) => { sealed.push(input); return `id${sealed.length}`; },
    jobsDir: join(temp('ladder-browser-jobs-'), 'jobs'), chdir: () => {},
    receipts: () => sealed.map((r, i) => ({ ...r, ts: new Date(Date.now() + i).toISOString(), hash: `sha256_${String(i).padStart(64, '0')}` })) as unknown as Receipt[],
    recoverAtStart: false, roomTools,
  }, folderProject(root));
  spaces.push(ws);
  return { ws, root, native };
}

describe.skipIf(!browserPath)('the tools panel\'s ladder in a real browser (headless Chromium, a fresh context)', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true, executablePath: browserPath }); });
  afterAll(async () => { await browser?.close(); });

  it('shows each rung in words with the Mac\'s runs beside it; the folded ladder opens to every rung\'s evidence and stays open across a redraw', async () => {
    const { ws, root, native } = await make();
    await ws.room('');
    await ws.boardLive('live');
    const context = await browser.newContext();
    const page = await context.newPage();
    const problems: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(m.text()); });
    page.on('pageerror', (e) => problems.push(String(e)));
    await page.goto(ws.liveBoard!.url);
    const scad = page.locator('li.tl[data-tool="openscad"]');
    await scad.waitFor({ timeout: 8000 });
    // The rung that stands, in words; the Mac's run beside it, apart from the rung.
    expect(await scad.locator('.rung').textContent()).toBe('exercised');
    expect(await scad.locator('.tl-mac').textContent()).toBe('on the Mac (scripted): r21 PASS');
    expect(await page.locator('li.tl[data-tool="vox:viser"] .rung').textContent()).toBe('proposed');
    expect(await page.locator('li.tl[data-tool="openhands"] .tl-mac').textContent()).toBe('on the Mac (scripted): r21 PASS, FAIL · r20 FAIL · r19o FAIL');
    // The ladder is folded: closed until opened.
    const ladder = scad.locator('details.tl-ladder');
    expect(await ladder.evaluate((d) => (d as HTMLDetailsElement).open)).toBe(false);
    expect(await scad.locator('dl.tl-rungs').isVisible()).toBe(false);
    await ladder.locator('summary').click();
    expect(await scad.locator('dl.tl-rungs').isVisible()).toBe(true);
    expect(await scad.locator('dl.tl-rungs dt').allTextContents()).toEqual(['proposed', 'installed', 'reachable', 'exercised', 'qualified']);
    expect(await scad.locator('dl.tl-rungs dt.lr-on').allTextContents()).toEqual(['installed', 'exercised']);
    const dd = await scad.locator('dl.tl-rungs dd').allTextContents();
    expect(dd[1]).toMatch(/^openscad on PATH at \.\/bin\/openscad; .* · where: \.\/bin\/openscad · how: the PATH \(openscad\) · version: not asked$/);
    expect(dd[3]).toContain(`receipt ${native.hash.slice(7, 15)} · record .timmy/native/0a1b2c3d-0000-4000-8000-0000000000b1/job.json`);
    expect(dd[4]).toBe('not reached: no qualification record');
    expect(await scad.locator('ul.tl-demos li').allTextContents()).toEqual(['PASS r21 (ledger row 163, 2026-10-10, aae9e82, scripted, part R): OpenSCAD 2026.09.23 in /iterate scad: 190 × 40 × 30 mm, matching OpenSCAD\'s own summary']);
    // FAIL is drawn in the failure colour, PASS in the text colour: the words carry it, the colour only repeats it.
    const oh = page.locator('li.tl[data-tool="openhands"]');
    await oh.locator('details.tl-ladder summary').click();
    const colours = await oh.locator('ul.tl-demos .demo').evaluateAll((els) => els.map((e) => [e.textContent, getComputedStyle(e).color]));
    const rgb = (hex: string): string => `rgb(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)})`;
    expect(colours).toEqual([['PASS', rgb(HOMEBREW.text)], ['FAIL', rgb(HOMEBREW.failure)], ['FAIL', rgb(HOMEBREW.failure)], ['FAIL', rgb(HOMEBREW.failure)]]);

    // A second check changes the panel (oha's row joins it, in the folded "everything else" group): the page redraws, and
    // the ladders the operator opened stay open.
    await ws.room('');
    await page.locator('li.tl[data-tool="stress"]').waitFor({ state: 'attached', timeout: 10_000 });
    expect(await page.locator('details[data-keep="room:tools:other"]').evaluate((d) => (d as HTMLDetailsElement).open)).toBe(false);
    expect(await page.locator('li.tl[data-tool="openscad"] details.tl-ladder').evaluate((d) => (d as HTMLDetailsElement).open)).toBe(true);
    expect(await page.locator('li.tl[data-tool="stress"] details.tl-ladder').evaluate((d) => (d as HTMLDetailsElement).open)).toBe(false);
    // Nothing from the project's folder on the page, nothing kept in the browser, no error.
    expect(await page.evaluate(() => document.body.innerText)).not.toContain(root);
    expect(await page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie])).toEqual([0, 0, '']);
    expect(problems).toEqual([]);
    await context.close();
  }, 60_000);
});
