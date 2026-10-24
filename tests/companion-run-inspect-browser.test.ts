/**
 * R6 (H144): the companion's run detail, inspected, in a real headless Chromium against the real companion server on
 * 127.0.0.1, its run made for real: a /run in the REPL's own Workspace (tests/helpers/run-inspect-fixture.ts; upmd and the
 * `change` block's flow are TEST DOUBLES, labelled FAKE there), its records read by the companion's own producer
 * (src/ops/run-detail.ts, with no producer given) and its receipts verified by Timmy's verifier on the server.
 *
 * What the page shows is read back: the source as it ran (its blocks, both hashes), a change's diff lines with their markers
 * and colours (B5: + green, − red), an image drawn (its natural size), a JSON laid out, the log scrolling with "more below",
 * each receipt's mark as the server sent it (green only where it verified, amber ✕ where it did not), the receipts column
 * reachable to its last receipt, one primary action (amber words and border), and an action's result: Restore (the
 * existing /restore, typed in the REPL as the page tells a person to) and the run detail read again after it.
 *
 * FIXTURE at the end: one receipt's words changed in this test's own sandbox chain, to show a receipt that does not verify.
 * Captures are made only when TIMMY_H144_CAPTURES names a folder.
 *
 * R10 (H167; H168's F3, as on Home): the run's face says what happened in words, and what its records say by id, hash or
 * place (its operation, its receipts, a sha256, a record under .timmy) is behind a Details control beside those words: the
 * text a person sees (innerText: a closed Details shows its summary only) names none of them, and each Details holds them.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ensureCompanionWeb } from '../scripts/companion-web-build.mjs';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { saveActiveProject } from '../src/project/index.js';
import { readChain } from '../src/utils/receipts.js';
import { opsKit, replOf, sandbox } from './helpers/ops-sandbox.js';
import { PNG, reportProject, runOf, typed } from './helpers/run-inspect-fixture.js';
import { landWorkspace } from './helpers/companion-page-kit.js';

const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('companion-run-inspect-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');
const CAPS = process.env.TIMMY_H144_CAPTURES ? path.resolve(process.env.TIMMY_H144_CAPTURES) : '';

const kit = opsKit();
const dirs: string[] = [];
afterEach(async () => { await kit.cleanup(); }, 60_000);
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const GREEN = 'rgb(40, 254, 20)';
const RED = 'rgb(255, 95, 86)';
const AMBER = 'rgb(255, 176, 0)';

describe.skipIf(!browserPath)('the run detail inspected, in a real browser (R6 H144)', () => {
  let browser: Browser;
  beforeAll(async () => {
    await ensureCompanionWeb();
    browser = await chromium.launch({ headless: true, executablePath: browserPath, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  }, 600_000);
  afterAll(async () => { await browser?.close(); });

  const text = async (page: Page, selector: string): Promise<string> => ((await page.textContent(selector)) ?? '').replace(/\s+/g, ' ').trim();
  const all = (page: Page, selector: string): Promise<string[]> => page.$$eval(selector, (els) => els.map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()));
  const colour = (page: Page, selector: string, prop: 'color' | 'borderTopColor' | 'borderLeftColor' = 'color'): Promise<string> => page.$eval(selector, (e, p) => getComputedStyle(e)[p as 'color'], prop);
  const shot = async (page: Page, name: string): Promise<void> => {
    if (!CAPS) return;
    mkdirSync(CAPS, { recursive: true });
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
    await page.screenshot({ path: path.join(CAPS, `${name}.png`) });
  };
  /** The run detail's cards, rows and scrolling boxes whose content is wider than they are (cut at their right edge). */
  const cut = (page: Page): Promise<string[]> => page.$$eval(
    '#run-detail .rv-card, #run-detail .rv-block, #run-detail .rv-chain > li, #run-detail .rv-v-head, #run-detail .rv-acts-row, #run-detail .rv-pipe, #run-detail .rv-head, #run-detail [data-rv-scroll]',
    (els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => `${e.className}${(e as HTMLElement).dataset.rvCard ? ` [${(e as HTMLElement).dataset.rvCard}]` : ''}: ${e.scrollWidth} > ${e.clientWidth}`));
  /** The run detail's buttons drawn amber (border, words or fill): B10 keeps amber for focus, the selection and the strip's one primary. */
  const amberButtons = (page: Page): Promise<string[]> => page.$$eval('#run-detail button', (els, amber) => els
    .filter((e) => { const c = getComputedStyle(e); return c.borderTopColor === amber || c.color === amber || c.backgroundColor === amber; })
    .map((e) => e.getAttribute('data-rv-sel') ?? e.getAttribute('data-rv-act') ?? e.className), AMBER);
  /** The Operation id box, opened as a person opens it (R10 H167: it is behind its Details control). */
  const byId = async (page: Page, op: string): Promise<void> => {
    if (!(await page.$eval('#run-by-id', (d) => (d as HTMLDetailsElement).open))) await page.click('#run-by-id > summary');
    await page.fill('#run-op', op);
    await page.click('#run-open');
  };
  /** Whether a scrolling box says "more below" (its holder's data-more), and the cue drawn on its edge. */
  const more = (page: Page, holder: string): Promise<{ more: boolean; cue: string }> => page.$eval(holder, (h) => ({ more: (h as HTMLElement).dataset.more === '1', cue: getComputedStyle(h, '::after').content }));

  it('source, a change\'s diff, an image, a JSON, the log with its cue, receipts verified now, one primary; Restore and its result; a receipt that does not verify', async () => {
    const s = sandbox(kit, 'rv-browser-');
    reportProject(s);
    const { ws } = replOf(kit, s);
    const { job, op } = await runOf(ws, 'REPORT.md', 'report');
    saveActiveProject({ name: path.basename(s.root), root: s.root, chosen: true });
    const settings = mkdtempSync(path.join(tmpdir(), 'rv-settings-'));
    dirs.push(settings);
    const companion: CompanionServer = await startCompanionServer(0, { chatEnv: { TIMMY_HOME: settings, TIMMY_SETTINGS_DIR: settings } });
    const origin = `http://127.0.0.1:${companion.port}`;
    const token = /#t=([0-9a-f]{64})$/.exec(companion.url)![1];
    let context: BrowserContext | undefined;
    try {
      context = await browser.newContext({ viewport: { width: 1376, height: 768 }, deviceScaleFactor: 1, timezoneId: 'UTC', locale: 'en-GB' });
      await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
      await context.route('**/*', (route) => (new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient')));
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      await page.goto(`${origin}/run/${op}#t=${token}`);
      await landWorkspace(page);
      await page.waitForSelector(`#run-detail .run-view[data-operation="${op}"][data-inspected="true"]`, { timeout: 30_000 });
      await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));

      // the run card holds its columns: it never says "more below" itself (each column scrolls on its own, with its cue)
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      expect(await page.getAttribute('#run-card', 'data-more')).toBeNull();
      // nothing is cut at a card's right edge: long commands and paths wrap inside their card
      expect(await cut(page)).toEqual([]);

      // ── the head and the pipeline: intent → predict → run → receipt, each stage as the server verified its receipts
      // (R10 H167: the run named in words, its request as Home lists it; its operation's id is the title's tip)
      expect(await text(page, '#run-detail .run-title')).toMatch(new RegExp(` · ${path.basename(s.root).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`));
      expect(await page.getAttribute('#run-detail .run-title', 'title')).toBe(`operation ${op}`);
      expect(await text(page, '#run-detail .rv-checked')).toMatch(/^checked \d\d:\d\d:\d\d by this companion's server$/);
      expect(await page.getAttribute('#run-detail .rv-checked', 'title')).toContain('verifyReceiptIn');
      // (R10 H167, H168's F3: each stage in words, its receipts' ids in the receipts' Details and the step's tip)
      expect(await all(page, '#run-detail .rv-pipe-step')).toEqual(['.intent the request · not a receipt', '.predict ✓ verified now', 'run ✓ 3 receipts · verified now', '.receipt ✓ verified now']);
      // (R11 step 3: where the run ran, in plain words: upmd ran the blocks here, no sandbox ran, so none is named)
      expect(await all(page, '#run-detail [data-rv-ran="this-computer"]')).toEqual(['Ran on this computer; no sandbox.']);
      expect(await page.getAttribute('#run-detail .rv-pipe-step[data-stage="predict"]', 'title')).toMatch(/^receipt [0-9a-f]{8}$/);
      expect(await colour(page, '#run-detail .rv-pipe-step[data-stage="receipt"]')).toBe(GREEN);
      expect(await colour(page, '#run-detail .rv-pipe-step[data-stage="intent"]', 'borderTopColor')).toBe(AMBER);

      // ── the source (left): the document and its blocks as they ran, the same now
      expect(await text(page, '#run-detail [data-rv-card="source"] h6')).toBe('source · REPORT.md › report');
      const docSha = (await import('node:crypto')).createHash('sha256').update(readFileSync(path.join(s.root, 'REPORT.md'))).digest('hex');
      expect(await text(page, '#run-detail [data-rv-doc-now]')).toBe('✓ REPORT.md still holds the bytes it ran from');
      expect(await text(page, '#run-detail [data-rv-card="source"] > .rv-more')).toContain(`REPORT.md still holds the bytes it ran from (sha256 ${docSha.slice(0, 12)})`);
      expect(await all(page, '#run-detail [data-rv-block="change"] .rv-tl')).toEqual(['6fake-params-flow 150']);
      expect(await text(page, '#run-detail [data-rv-block="report"] .rv-block-head')).toBe('report · bash · needs change · the block asked for');
      expect(await text(page, '#run-detail [data-rv-block="report"] .rv-sealed')).toBe('✓ its code is the code its block receipt sealed');
      expect(await text(page, '#run-detail [data-rv-block="report"] .rv-more')).toMatch(/^Details its block receipt [0-9a-f]{8} sealed sha256 ([0-9a-f]{12}) its code sha256 \1$/);
      expect(await text(page, '#run-detail [data-rv-card="intent"] [data-rv-sealed-face]')).toBe('not a receipt: Timmy writes an operation\'s record and nothing seals it; its prediction receipt seals what it ran from');
      expect(await text(page, '#run-detail [data-rv-card="intent"] .rv-more [data-rv-sealed]')).toMatch(/^not a receipt: Timmy writes an operation's record and nothing seals it; prediction receipt [0-9a-f]{8} seals what it ran from \(REPORT\.md sha256 [0-9a-f]{12}\)$/);

      // ── the viewer (centre) opens on the change with a diff: the parameter file, against the copy the flow kept
      expect(await page.getAttribute('#run-detail [data-rv-viewer]', 'data-rv-viewer')).toBe('c:0');
      expect(await text(page, '#run-detail [data-rv-viewer] .rv-v-path')).toBe('recipes/tray.params.json');
      const adds = await all(page, '#run-detail [data-rv-viewer] .rv-dl[data-op="add"]');
      const dels = await all(page, '#run-detail [data-rv-viewer] .rv-dl[data-op="del"]');
      expect(adds).toEqual([expect.stringMatching(/^\+\s+"width": 150,$/)]);
      expect(dels).toEqual([expect.stringMatching(/^−\s+"width": 140,$/)]);
      expect(await text(page, '#run-detail [data-rv-viewer] .rv-diff-head')).toBe('+1 −1 · against the version Timmy kept');
      expect(await page.getAttribute('#run-detail [data-rv-viewer] .rv-diff-head', 'title')).toMatch(/^\+1 −1 · against the version Timmy kept \(\.timmy\/flows\/f[0-9a-f]{8}\/params\.before\.json\)$/);
      expect(await colour(page, '#run-detail [data-rv-viewer] .rv-dl[data-op="add"] .rv-mark')).toBe(GREEN);
      expect(await colour(page, '#run-detail [data-rv-viewer] .rv-dl[data-op="del"] .rv-mark')).toBe(RED);
      expect(await text(page, '#run-detail [data-rv-viewer] [data-now]')).toBe('✓ unchanged since the run');
      expect(await text(page, '#run-detail [data-rv-viewer] .rv-check')).toBe('✓ its receipt sealed this record\'s bytes');
      // the viewer's Details: the sha256 now, the kept version's place, the receipt and the record, as the records say them
      const viewerMore = await text(page, '#run-detail [data-rv-viewer] .rv-v-facts > .rv-more');
      expect(viewerMore).toMatch(/ now unchanged since the run: sha256 [0-9a-f]{12} /);
      expect(viewerMore).toMatch(/ kept previous version kept at \.timmy\/flows\/f[0-9a-f]{8}\/params\.before\.json /);
      expect(viewerMore).toMatch(/ its check receipt [0-9a-f]{8} sealed this record's bytes its record results\/flows\/f[0-9a-f]{8}\.json$/);
      // F3: what a person sees of the run names no operation, no receipt, no sha256 and no place under .timmy; the
      // Details named above hold them
      const ids = readChain('runs', s.root).filter((r) => r.operation_id === op).map((r) => r.hash.slice(7, 15));
      const face = await page.$eval('#run-detail .run-view', (e) => (e as HTMLElement).innerText);
      expect(face).not.toContain(op);
      for (const id of ids) expect(face).not.toContain(id);
      expect(face).not.toMatch(/\.timmy\/|sha256 [0-9a-f]{7}/);
      expect(await text(page, '#run-detail .rv-head > .rv-more')).toContain(`operation ${op}`);
      const restoreCmd = await page.getAttribute('#run-detail [data-rv-viewer] .rv-copy[data-rv-effect="write"]', 'data-rv-copy');
      expect(restoreCmd).toMatch(/^\/restore recipes\/tray\.params\.json --from \.timmy\/flows\/f[0-9a-f]{8}\/params\.before\.json$/);
      expect(await text(page, '#run-detail [data-rv-viewer] .rv-copy[data-rv-effect="write"] .rv-effect')).toBe('write');
      await shot(page, 'companion-run-detail-1376x768-source-diff-receipts');

      // ── the files: what the run changed, then its log and outputs
      expect(await all(page, '#run-detail [data-rv-list="changes"] .rv-pick-path')).toEqual(expect.arrayContaining(['recipes/tray.params.json', 'out/report.md', 'out/summary.json', 'out/preview.png', 'out/blob.bin']));
      // the image: drawn, at its own 8 by 6 pixels, from the bytes the run left
      await page.click('#run-detail [data-rv-list="changes"] .rv-pick:has(.rv-pick-path:text-is("out/preview.png"))');
      await page.waitForSelector('#run-detail [data-rv-viewer] img[data-rv-image]');
      expect(await page.$eval('#run-detail [data-rv-viewer] img[data-rv-image]', (i) => [(i as HTMLImageElement).complete, (i as HTMLImageElement).naturalWidth, (i as HTMLImageElement).naturalHeight, (i as HTMLImageElement).src.slice(0, 22)])).toEqual([true, 8, 6, 'data:image/png;base64,']);
      expect(await text(page, '#run-detail [data-rv-viewer] figcaption .rv-fig-facts')).toBe(`image/png · 8 × 6 · ${PNG.length} B`);
      expect(await text(page, '#run-detail [data-rv-viewer] figcaption .rv-more')).toMatch(/^Details sha256 [0-9a-f]{64}$/);
      expect(await text(page, '#run-detail [data-rv-viewer] [data-rv-diff]')).toBe('no line diff: Timmy kept no previous version of it, and whether it was there before the run is not recorded');
      expect(await text(page, '#run-detail [data-rv-viewer] [data-rv-restore]')).toBe('Restore: not now: no previous version is kept');
      await shot(page, 'companion-run-detail-1376x768-image-output');
      // the JSON, laid out; the binary, its size and sha256
      await page.click('#run-detail [data-rv-list="changes"] .rv-pick:has(.rv-pick-path:text-is("out/summary.json"))');
      expect(await all(page, '#run-detail [data-rv-viewer] .rv-text.is-json .rv-tl')).toEqual(['1{', '2 "width": 150,', '3 "files": [', '4 "out/report.md",', '5 "out/preview.png"', '6 ],', '7 "ok": true', '8}']);
      await page.click('#run-detail [data-rv-list="changes"] .rv-pick:has(.rv-pick-path:text-is("out/blob.bin"))');
      expect(await text(page, '#run-detail [data-rv-viewer] [data-rv-binary] > p')).toBe('a binary file (not UTF-8 text) · 7 B');
      expect(await text(page, '#run-detail [data-rv-viewer] [data-rv-binary] > .rv-more')).toMatch(/^Details sha256 [0-9a-f]{64}$/);
      // the log: its last lines, scrolling in the viewer, "more below" until its end is reached
      await page.click('#run-detail [data-rv-list="outputs"] li:first-child .rv-pick');
      // (R10 H167: the log said by what it is; its place, which names its job, in the viewer's Details)
      expect(await text(page, '#run-detail [data-rv-viewer] .rv-v-path')).toBe('the log of the job (REPORT.md › report)');
      expect(await text(page, '#run-detail [data-rv-viewer] .rv-v-facts > .rv-more')).toMatch(new RegExp(`its place \\S*jobs/${job}\\.log `));
      expect(await text(page, '#run-detail [data-rv-viewer] [data-now]')).toBe('✓ the bytes its receipt recorded');
      expect(await all(page, '#run-detail [data-rv-viewer] .rv-text .rv-tl')).toEqual(expect.arrayContaining([expect.stringMatching(/^\d+report line 60$/)]));
      await page.waitForFunction(() => document.querySelector('#run-detail [data-rv-viewer] .rv-v-body')?.getAttribute('data-more') === '1');
      expect(await more(page, '#run-detail [data-rv-viewer] .rv-v-body')).toEqual({ more: true, cue: '"more below ↓"' });
      await shot(page, 'companion-run-detail-1376x768-log-more-below');
      await page.$eval('#run-detail [data-rv-viewer] .rv-v-body > .rv-scroll', (el) => { el.scrollTop = el.scrollHeight; });
      await page.waitForFunction(() => document.querySelector('#run-detail [data-rv-viewer] .rv-v-body')?.getAttribute('data-more') === null);

      // ── the receipts (right): each verified now, its mark green with what was checked; the list reachable to its end
      const chain = readChain('runs', s.root).filter((r) => r.operation_id === op);
      const rows = await page.$$eval('#run-detail [data-rv-chain] li[data-receipt]', (els) => els.map((e) => ({ id: e.getAttribute('data-receipt'), verified: e.getAttribute('data-verified'), mark: (e.querySelector('.rv-verified')?.textContent ?? '').trim(), more: (e.querySelector('.rv-more')?.textContent ?? '').replace(/\s+/g, ' ').trim() })));
      expect(rows.map((r) => r.id)).toEqual(chain.map((r) => r.hash.slice(7, 15)));
      for (const r of rows) {
        expect(r.verified).toBe('true');
        expect(r.mark).toBe('✓ sealed and verified now');
        // (R10 H167: its id, its place on the chain and what was checked, in its Details)
        expect(r.more).toMatch(new RegExp(`^Details receipt ${r.id} on the chain epoch 1, receipt \\d+ · links to (?:the start of epoch 1|receipt [0-9a-f]{8}) · signed checked its body hashes to sha256_[0-9a-f]{12}…, recomputed now; its prev_hash (?:starts epoch 1|is receipt [0-9a-f]{8}'s hash), and the \\d+ links? and body hashes from the start of epoch 1 up to it hold; its signature verifies against the signer key it carries$`));
      }
      expect(await colour(page, '#run-detail [data-rv-chain] li[data-receipt] .rv-verified')).toBe(GREEN);
      expect(await colour(page, '#run-detail [data-rv-card="receipt"]', 'borderTopColor')).toBe(GREEN);
      expect(await text(page, '#run-detail [data-rv-chain-ok]')).toBe('✓ the chain verifies from the start of epoch 1 up to its receipt');
      expect(await text(page, '#run-detail [data-rv-chain-ok] + .rv-more')).toMatch(/^Details the chain the chain verifies from the start of epoch 1 up to receipt [0-9a-f]{8}: \d+ receipts, every link and body hash, and [0-9a-f]{8}'s signature \(verifyReceiptIn, now\)$/);
      // the column says "more below" while its receipts go on below its edge, and scrolls to the last of them
      const after = '#run-detail .rd-after';
      await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute('data-more') === '1', after);
      expect(await more(page, after)).toEqual({ more: true, cue: '"more below ↓"' });
      await page.$eval(`${after} > .rv-scroll`, (el) => { el.scrollTop = el.scrollHeight; });
      await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute('data-more') === null, after);
      const reach = await page.$eval(`${after} > .rv-scroll`, (col) => { const last = [...col.querySelectorAll('[data-rv-chain] li')].at(-1)!; return last.getBoundingClientRect().bottom <= col.getBoundingClientRect().bottom + 1; });
      expect(reach).toBe(true);

      // ── the actions: one primary (amber words and border), each with what it does; a command copied for the REPL
      expect(await all(page, '#run-detail .rv-act')).toEqual([
        '1. Open recipes/tray.params.json reads', '2. Review reads', '3. Restore recipes/tray.params.json write', '4. Run again runs',
      ]);
      expect(await page.$$eval('#run-detail .rv-act', (els) => els.map((e) => e.getAttribute('data-rv-command')))).toEqual(['/open recipes/tray.params.json', `/review ${op}`, restoreCmd, '/run REPORT.md report']);
      expect(await page.$$eval('#run-detail .rv-act.is-primary', (els) => els.map((e) => e.getAttribute('data-rv-act')))).toEqual(['open']);
      // B10: the strip's primary is the page's one amber next step, so the run's own actions stay neutral (the primary's
      // border brighter than the others'); in the run detail only the selection (the file the viewer shows) is amber
      expect(await colour(page, '#run-detail .rv-act.is-primary', 'borderTopColor')).not.toBe(AMBER);
      expect(await colour(page, '#run-detail .rv-act.is-primary', 'borderTopColor')).not.toBe(await colour(page, '#run-detail .rv-act[data-rv-act="review"]', 'borderTopColor'));
      expect(await amberButtons(page)).toEqual([await page.getAttribute('#run-detail [data-rv-viewer]', 'data-rv-viewer')]);
      // the line under the actions: the primary's command and what it does, then the one pointed at
      // (R10 H167, H168's pattern 1 and F3: the action by its label and what it does, in words; its command is its tip and what
      // a press copies, and the kept version's place is in the viewer's Details)
      expect(await text(page, '#run-detail [data-rv-cmd]')).toBe('Open recipes/tray.params.json · reads: its preview here, from the file as it is now; /open shows it in Timmy\'s REPL');
      await page.hover('#run-detail .rv-act[data-rv-act="restore"]');
      expect(await text(page, '#run-detail [data-rv-cmd]')).toBe('Restore recipes/tray.params.json · write: writes the kept previous version back over recipes/tray.params.json, only while it is exactly what the run left; its current version is kept first under .timmy/restore-history/, and an edit receipt is sealed');
      expect(await page.getAttribute('#run-detail .rv-act[data-rv-act="restore"]', 'title')).toMatch(/^\/restore recipes\/tray\.params\.json --from \.timmy\/flows\/f[0-9a-f]{8}\/params\.before\.json: writes the kept previous version \(\.timmy\/flows\/f[0-9a-f]{8}\/params\.before\.json\) back over/);
      await page.click('#run-detail .rv-act[data-rv-act="review"]');
      await page.waitForFunction(() => /^Copied: /.test(document.querySelector('#run-detail [data-rv-note]')?.textContent ?? ''));
      expect(await text(page, '#run-detail [data-rv-note]')).toBe(`Copied: /review ${op}. Paste it in Timmy's REPL (timmy); nothing ran from this page.`);
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`/review ${op}`);
      // Open: its preview here (the server's reading), and what shows it in the REPL
      await page.click('#run-detail .rv-act[data-rv-act="open"]');
      expect(await page.getAttribute('#run-detail [data-rv-viewer]', 'data-rv-viewer')).toBe('c:0');

      // ── Restore: the command copied, typed in the REPL (the existing /restore); the run read again says what changed
      await page.click('#run-detail .rv-act[data-rv-act="restore"]');
      await page.waitForFunction(() => /^Copied: \/restore /.test(document.querySelector('#run-detail [data-rv-note]')?.textContent ?? ''));
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      expect(copied).toBe(restoreCmd);
      const { said, op: restoreOp } = await typed(ws, copied, () => ws.restore!(copied.replace(/^\/restore /, '')));
      expect(said).toMatch(/restored/i);
      await page.click('#run-detail [data-rv-again]');
      await page.waitForFunction(() => /✕ changed since the run/.test(document.querySelector('#run-detail [data-rv-viewer] [data-now]')?.textContent ?? ''));
      expect(await text(page, '#run-detail [data-rv-viewer] [data-rv-restore]')).toBe('Restore: not now: it changed since the run: restoring would replace a later version');
      expect(await text(page, '#run-detail [data-rv-viewer] .rv-v-facts > .rv-more')).toMatch(/ Restore it changed since the run \(sha256 [0-9a-f]{12} now; the run left [0-9a-f]{12}\): restoring would replace a later version/);
      expect(await page.getAttribute('#run-detail .rv-act[data-rv-act="restore"]', 'aria-disabled')).toBe('true');
      // the restore's own run: its change against the version /restore kept first (− 150, + 140), its edit receipt verified
      await byId(page, restoreOp);
      await page.waitForSelector(`#run-detail .run-view[data-operation="${restoreOp}"][data-inspected="true"]`, { timeout: 15_000 });
      expect(await all(page, '#run-detail [data-rv-viewer] .rv-dl[data-op="add"]')).toEqual([expect.stringMatching(/^\+\s+"width": 140,$/)]);
      expect(await all(page, '#run-detail [data-rv-viewer] .rv-dl[data-op="del"]')).toEqual([expect.stringMatching(/^−\s+"width": 150,$/)]);
      expect(await text(page, '#run-detail [data-rv-viewer] .rv-by')).toBe('changed by /restore');
      expect(await text(page, '#run-detail [data-rv-viewer] .rv-v-facts > .rv-more')).toMatch(/ by \/restore \(from \.timmy\/flows\/f[0-9a-f]{8}\/params\.before\.json\) /);
      expect(await page.$$eval('#run-detail [data-rv-chain] li[data-receipt]', (els) => els.map((e) => [e.textContent?.includes(' · edit · '), e.getAttribute('data-verified')]))).toEqual([[true, 'true']]);
      expect(await text(page, '#run-detail [data-rv-source="none"]')).toBe('Source: it ran no workflow document: no document\'s bytes were sealed before it ran');
      // its request, a long /restore command, wraps inside the .intent card
      expect(await text(page, '#run-detail [data-rv-card="intent"] h6')).toBe(`.intent · ${copied}`);
      expect(await cut(page)).toEqual([]);
      await shot(page, 'companion-run-after-restore-1376x768');

      // ── at 390 px wide (a phone): one column, nothing scrolls sideways, nothing cut at a card's edge, the diff drawn
      const narrow = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, timezoneId: 'UTC', locale: 'en-GB' });
      try {
        await narrow.route('**/*', (route) => (new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient')));
        const phone = await narrow.newPage();
        phone.on('pageerror', (e) => errors.push(e.message));
        // the restore's own run: its change, − 150 + 140, against the version /restore kept first
        await phone.goto(`${origin}/run/${restoreOp}#t=${token}`);
        await landWorkspace(phone);
        await phone.waitForSelector(`#run-detail .run-view[data-operation="${restoreOp}"][data-inspected="true"]`, { timeout: 30_000 });
        await phone.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
        expect(await phone.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= window.innerWidth)).toBe(true);
        expect(await cut(phone)).toEqual([]);
        expect(await all(phone, '#run-detail [data-rv-viewer] .rv-dl[data-op="add"]')).toEqual([expect.stringMatching(/^\+\s+"width": 140,$/)]);
        await phone.$eval('#run-detail .rd-run', (el) => el.scrollIntoView({ block: 'start' }));
        await shot(phone, 'companion-run-detail-390x844-after-restore');
      } finally { await narrow.close(); }

      // ── FIXTURE: the run's flow receipt's words changed in this sandbox's chain: no verified mark for it, and why
      const store = path.join(s.root, '.timmy', 'receipts', 'runs.jsonl');
      const lines = readFileSync(store, 'utf8').split('\n');
      writeFileSync(store, lines.map((l) => { if (!l.trim()) return l; const r = JSON.parse(l) as { kind?: string; operation_id?: string; subject?: string }; return r.kind === 'flow' && r.operation_id === op ? JSON.stringify({ ...r, subject: `${r.subject} (FIXTURE: changed after it was sealed)` }) : l; }).join('\n'));
      await byId(page, op);
      await page.waitForSelector(`#run-detail .run-view[data-operation="${op}"][data-inspected="true"]`, { timeout: 15_000 });
      const marks = await page.$$eval('#run-detail [data-rv-chain] li[data-receipt]', (els) => els.map((e) => ({ kind: (e.textContent ?? '').split(' · ')[1], verified: e.getAttribute('data-verified'), mark: (e.querySelector('.rv-verified')?.textContent ?? '').trim(), colour: getComputedStyle(e.querySelector('.rv-verified')!).color })));
      expect(marks[0]).toMatchObject({ verified: 'true', colour: GREEN });
      const flow = marks.find((m) => m.kind === 'flow')!;
      expect(flow).toMatchObject({ verified: 'false', colour: AMBER });
      expect(flow.mark).toMatch(/^✕ not verified: body hash mismatch/);
      for (const m of marks.slice(marks.indexOf(flow) + 1)) { expect(m.verified).toBe('false'); expect(m.mark).toMatch(/^✕ not verified: the chain is broken before it/); expect(m.colour).toBe(AMBER); }
      expect(await page.$$eval('#run-detail .rv-pipe-step.is-verified', (els) => els.map((e) => e.getAttribute('data-stage')))).toEqual(['predict']);
      expect(await colour(page, '#run-detail [data-rv-card="receipt"]', 'borderTopColor')).toBe(AMBER);
      expect(await cut(page)).toEqual([]);
      await page.$eval('#run-detail .rd-after > .rv-scroll', (el) => { el.scrollTop = 0; });
      await shot(page, 'companion-run-receipt-not-verified-FIXTURE-1376x768');
      expect(errors).toEqual([]);
    } finally {
      await context?.close();
      await companion.shutdown();
    }
  }, 240_000);
});
