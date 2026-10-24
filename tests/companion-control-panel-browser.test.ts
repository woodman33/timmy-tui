/**
 * R8 (H155): the companion's tab 7 draws the Control Room's panes (src/companion/client/panel-control.js over
 * src/companion/panels/control.ts and src/ops/panes.ts), in a real headless Chromium against the real companion server on
 * 127.0.0.1, reading what the page shows: a 2×2 grid at 1376×768 and one column at 390×844, the running panes first (a job, a
 * chat turn being answered), then the newest ended ones; each pane's words (its mark and word, its run name, its log's last
 * lines, how often it is read, its exit and its receipt, the stop words as the workspace frame gives them); a verified
 * receipt green and one changed on its chain not (amber, with ✕ and its words); more than four running said as "N more
 * running"; the panes read again while the tab is shown and not while it is not; a pane opening its run detail (/run/<op>)
 * and nothing on the panes starting, stopping or changing anything (no request but GET); text of 11 px or more, amber and
 * green only in B10's roles; no request outside 127.0.0.1; no console error.
 *
 * REAL here: the server, its token, the page's code, the job store's jobs (sh and sleep, in this file's Timmy home) and their
 * logs, the receipts the job store's seal wrote into this test's own store (TIMMY_STORE) and the verifier, a chat turn's hold
 * taken by this process (as a REPL turn takes it), the workspace frame.
 * FAKE here: the project (FAKE-control), the jobs' labels and what they print, an operation id given to one job
 * (o0e137a01: no request of Timmy's made it), and one receipt changed on its chain by the test. Captures are written only
 * where H155_CAPS names a folder. Skipped, saying so, where no Chromium or Chrome is found.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { takeTurnHold } from '../src/agent/chat-turn.js';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { JobManager } from '../src/jobs/index.js';
import { inOperation } from '../src/ops/context.js';
import { projectId } from '../src/project/index.js';
import { appendReceipt, receiptsPath } from '../src/utils/receipts.js';
import { landWorkspace } from './helpers/companion-page-kit.js';

const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('companion-control-panel-browser: no Chromium or Chrome found, so the real-browser checks are skipped here');

const CAPS = process.env.H155_CAPS ?? '';
const OP = 'o0e137a01';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, get: () => T | undefined | false | null | Promise<T | undefined | false | null>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(50);
  }
}

interface Seen { errors: string[]; outside: string[]; writes: string[]; panes: number[]; bad: string[] }

describe.skipIf(!browserPath)('the companion\'s tab 7: the Control Room\'s panes, read-only (R8 H155)', () => {
  const kept = { TIMMY_HOME: process.env.TIMMY_HOME, TIMMY_REPO: process.env.TIMMY_REPO };
  let box = '';
  let root = '';
  let browser: Browser;
  let companion: CompanionServer;
  const managers: JobManager[] = [];

  beforeAll(async () => {
    box = mkdtempSync(join(tmpdir(), 'r8-control-browser-'));
    root = join(box, 'home', 'projects', 'FAKE-control');
    mkdirSync(join(root, '.timmy'), { recursive: true });
    process.env.TIMMY_HOME = join(box, 'home');
    process.env.TIMMY_REPO = root;
    companion = await startCompanionServer(0, { workspace: { env: { TIMMY_HOME: process.env.TIMMY_HOME, TIMMY_SETTINGS_DIR: join(box, 'settings') }, shareMs: 0 } });
    browser = await chromium.launch({ headless: true, executablePath: browserPath, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
    if (CAPS) mkdirSync(CAPS, { recursive: true });
  }, 120_000);
  afterEach(async () => { for (const m of managers.splice(0)) await m.stopAll(); });
  afterAll(async () => {
    await browser?.close();
    await companion?.shutdown();
    for (const [k, v] of Object.entries(kept)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (box) rmSync(box, { recursive: true, force: true });
  });

  /** REAL: the job store in this file's Timmy home (the companion reads it there), sealing each ended job into this test's store. */
  const store = (): JobManager => {
    const m = new JobManager({
      dir: join(process.env.TIMMY_HOME!, 'jobs'),
      seal: (j) => appendReceipt('runs', { kind: 'run', subject: `task · ${j.label} · ${j.state}`, policy: 'human-gated', status: j.state === 'completed' ? 'ok' : 'failed', project: 'FAKE-control', project_id: projectId(root), job: { id: j.id, kind: j.kind, label: j.label, state: j.state, exit_code: j.exitCode ?? null }, spans: [], artifacts: [] }).hash.slice(7, 15),
    });
    managers.push(m);
    return m;
  };

  async function open(viewport: { width: number; height: number }): Promise<{ page: Page; seen: Seen }> {
    const page = await browser.newPage({ viewport });
    const seen: Seen = { errors: [], outside: [], writes: [], panes: [], bad: [] };
    page.on('pageerror', (e) => seen.errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') seen.errors.push(m.text()); });
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (u.protocol !== 'data:' && u.protocol !== 'blob:' && u.hostname !== '127.0.0.1') seen.outside.push(r.url());
      if (u.pathname.startsWith('/api/') && r.method() !== 'GET') seen.writes.push(`${r.method()} ${u.pathname}`);
      if (u.pathname === '/api/panel/control/panes') seen.panes.push(Date.now());
    });
    page.on('response', (r) => { if (r.status() >= 400) seen.bad.push(`${r.status()} ${new URL(r.url()).pathname}`); });
    await page.goto(companion.url);
    await landWorkspace(page);
    await page.waitForFunction(() => document.getElementById('status-text')?.textContent === 'COMPANION SOCKET · CONNECTED', null, { timeout: 30_000 });
    await page.keyboard.press('7');
    await page.waitForSelector('[data-panel-host="control"] [data-control="grid"]', { timeout: 15_000 });
    return { page, seen };
  }
  const shot = async (page: Page, name: string): Promise<void> => { if (CAPS) await page.screenshot({ path: join(CAPS, `${name}.png`) }); };
  /** Each pane as drawn: its id, kind, place on screen and words. */
  const drawn = (page: Page) => page.$$eval('[data-panel-host="control"] .control-pane', (ps) => ps.map((p) => {
    const r = p.getBoundingClientRect();
    const t = (sel: string): string => (p.querySelector(sel)?.textContent ?? '').replace(/\s+/g, ' ').trim();
    return {
      id: (p as HTMLElement).dataset.pane ?? '', kind: (p as HTMLElement).dataset.paneKind ?? '', quiet: (p as HTMLElement).dataset.paneQuiet === 'true',
      x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom),
      state: t('[data-pane-part="state"]'), name: t('[data-pane-part="name"]'), who: t('[data-pane-part="who"]'),
      log: [...p.querySelectorAll('[data-pane-part="log"] .control-line')].map((l) => (l.textContent ?? '').trim()),
      // the lines in sight (the newest kept where the pane is short), and how many of those are cut at the log's top edge
      seen: [...p.querySelectorAll('[data-pane-part="log"] .control-line')].filter((l) => !(l as HTMLElement).hidden && l.getBoundingClientRect().height > 0).map((l) => (l.textContent ?? '').trim()),
      cut: (() => { const lg = p.querySelector('[data-pane-part="log"]'); if (!lg) return 0; const top = lg.getBoundingClientRect().top; return [...lg.querySelectorAll('.control-line')].filter((l) => !(l as HTMLElement).hidden && l.getBoundingClientRect().top < top - 0.5).length; })(),
      logWhy: t('[data-pane-part="log-why"]'), every: t('[data-pane-part="every"]'), exit: t('[data-pane-part="exit"]'),
      receipt: t('[data-pane-part="receipt"]'), receiptVerified: Boolean(p.querySelector('[data-pane-part="receipt"].is-verified')),
      receiptColor: p.querySelector('[data-pane-part="receipt"]') ? getComputedStyle(p.querySelector('[data-pane-part="receipt"]')!).color : '',
      stop: t('[data-pane-part="stop"]'), open: t('[data-pane-part="open"]'), opens: (p as HTMLElement).dataset.openRun ?? '',
      text: (p.textContent ?? '').replace(/\s+/g, ' ').trim(),
    };
  }));
  /** Every text of the panel at 11 px or more; colours: no blue, purple or cyan; green and amber only where they are allowed. */
  const look = (page: Page) => page.evaluate(() => {
    const parse = (v: string): number[] | null => { const mm = /^rgba?\(([^)]+)\)$/.exec(v.trim()); if (!mm) return null; const p = mm[1].split(/[\s,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] ?? 1]; };
    const hsl = ([rr, gg, bb]: number[]) => { const [R, G, B] = [rr / 255, gg / 255, bb / 255]; const max = Math.max(R, G, B); const min = Math.min(R, G, B); const l = (max + min) / 2; const d = max - min; if (d === 0) return { h: 0, s: 0, l }; const h = max === R ? 60 * (((G - B) / d) % 6) : max === G ? 60 * ((B - R) / d + 2) : 60 * ((R - G) / d + 4); return { h: (h + 360) % 360, s: d / (1 - Math.abs(2 * l - 1)), l }; };
    const out = { small: [] as string[], hue: [] as string[], green: [] as string[], amber: [] as string[] };
    const host = document.querySelector('[data-panel-host="control"]')!;
    for (const el of [host, ...host.querySelectorAll('*')]) {
      if (el.closest('[hidden]')) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || el.getBoundingClientRect().width === 0) continue;
      const words = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent ?? '').join('').trim();
      if (words && parseFloat(cs.fontSize) < 11) out.small.push(`${el.tagName}.${el.className} ${cs.fontSize} "${words.slice(0, 40)}"`);
      // a border's or outline's colour counts only where one is drawn (its colour is the text's when none is set)
      for (const [prop, style] of [['color', ''], ['background-color', ''], ['border-top-color', 'border-top-style'], ['border-left-color', 'border-left-style'], ['outline-color', 'outline-style']] as const) {
        if (style && cs.getPropertyValue(style) === 'none') continue;
        const c = parse(cs.getPropertyValue(prop)); if (!c || c[3] === 0) continue;
        const { h, s, l } = hsl(c); if (s < 0.2 || l < 0.08 || l > 0.92) continue;
        const what = `${el.tagName}.${el.className} ${prop} "${(el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)}"`;
        if (h >= 150 && h <= 320) out.hue.push(what);
        else if (h >= 75 && h < 150) out.green.push(what);
        else if (c[0] === 255 && c[1] === 176 && c[2] === 0) out.amber.push(what);
      }
    }
    return out;
  });

  it('at 1376×768: a 2×2 grid, the running panes first (a job, a turn being answered), then the newest ended; their words, logs, exits and receipts (green only when verified); the frame\'s stop words; read again while shown and not when hidden; a pane opens its run detail and nothing else is asked', async () => {
    const jobs = store();
    // two ended runs, oldest first: one given an operation id (its pane opens that run's detail), then one whose receipt the
    // test changes on its chain (the newest job receipt there, so the one before it still verifies)
    const ok = inOperation({ id: OP }, () => jobs.start({ kind: 'task', label: 'FAKE job (test): passes', project: 'FAKE-control', root, command: 'sh', args: ['-c', 'echo "FAKE: one"; echo "FAKE: two"; echo "FAKE: fine"'] }));
    await jobs.done(ok.id);
    await sleep(15);
    const changed = jobs.start({ kind: 'workflow', label: 'FAKE.md › changed', project: 'FAKE-control', root, command: 'sh', args: ['-c', 'echo "FAKE: sealed, then changed"'] });
    await jobs.done(changed.id);
    const file = receiptsPath('runs');
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const at = lines.findIndex((l) => (JSON.parse(l) as { job?: { id?: string } }).job?.id === changed.id);
    expect(at).toBeGreaterThan(-1);
    const sealed = JSON.parse(lines[at]) as { subject: string };
    lines[at] = JSON.stringify({ ...sealed, subject: `${sealed.subject} (changed by the test)` });
    writeFileSync(file, `${lines.join('\n')}\n`);
    await sleep(15);
    // a running job that prints a line every 0.25 s, and a chat turn being answered (this process's hold, as the REPL's)
    const run = jobs.start({ kind: 'task', label: 'FAKE job (test): a line every 0.25 s', project: 'FAKE-control', root, command: 'sh', args: ['-c', 'i=0; while [ $i -lt 600 ]; do i=$((i+1)); echo "FAKE line $i"; sleep 0.25; done'] });
    await until('its first lines', () => (jobs.get(run.id)?.lines ?? 0) >= 3);
    const held = takeTurnHold(root, 'repl');
    if (!held.ok) throw new Error(held.lines.join(' '));
    const { page, seen } = await open({ width: 1376, height: 768 });
    try {
      await page.waitForFunction(() => document.querySelectorAll('[data-panel-host="control"] .control-pane').length === 4, null, { timeout: 15_000 });
      const panes = await drawn(page);
      // the order: running first (the job, then the turn), then the newest ended
      expect(panes.map((p) => [p.kind, p.id, p.quiet])).toEqual([['job', run.id, false], ['turn', held.hold.id, false], ['job', changed.id, true], ['job', ok.id, true]]);
      // a 2×2 grid: two columns, two rows, row by row; every pane in the window
      expect(new Set(panes.map((p) => p.x)).size).toBe(2);
      expect(new Set(panes.map((p) => p.y)).size).toBe(2);
      expect(panes[0].y).toBe(panes[1].y);
      expect(panes[2].y).toBe(panes[3].y);
      expect(panes[0].x).toBe(panes[2].x);
      expect(panes[1].x).toBeGreaterThan(panes[0].x + panes[0].w - 1);
      expect(panes[2].y).toBeGreaterThanOrEqual(panes[0].bottom);
      for (const p of panes) { expect(p.bottom, `${p.id} in the window`).toBeLessThanOrEqual(768); expect(p.w).toBeGreaterThan(200); expect(p.h).toBeGreaterThan(90); }
      expect(await page.$eval('[data-control="title"]', (e) => (e.textContent ?? '').trim())).toBe('Panes (4) · 2 running · 2 newest ended');

      // the running job: its mark and word, its name, who started it, its newest log lines, how often it is read, the frame's stop
      const [job, turn, bad, good] = panes;
      expect(job.state).toBe('▶ running');
      expect(job.name).toBe('FAKE job (test): a line every 0.25 s');
      expect(job.who).toMatch(new RegExp(`^${run.id} · another session · \\d`));
      expect(job.log.length).toBeGreaterThan(0);
      expect(job.log.every((l) => /^FAKE line \d+$/.test(l))).toBe(true);
      // the newest lines in sight, whole: what shows is the end of what was read, none cut at the log's top edge
      for (const p of panes) {
        expect(p.cut, `${p.id}: a line cut at its log's top`).toBe(0);
        if (p.log.length) { expect(p.seen.length, p.id).toBeGreaterThan(0); expect(p.log.slice(-p.seen.length), p.id).toEqual(p.seen); }
      }
      expect(job.every).toBe('log read every 2 s');
      expect(job.stop).toBe(`Stop current: ${run.id} FAKE job (test): a line every 0.25 s · in Timmy’s terminal: /stop`);
      expect(job.open).toBe('no run detail: this job names no operation');
      expect(job.opens).toBe('');
      expect(job.exit + job.receipt).toBe('');
      // the turn: answering, from the REPL, how it stops there (the frame's words), no run detail until sealed
      expect(turn.state).toBe('▶ answering');
      expect(turn.name).toBe('chat turn');
      expect(turn.who).toMatch(new RegExp(`^from the REPL · pid ${process.pid} · since \\d\\d:\\d\\d:\\d\\d$`));
      expect(turn.logWhy).toBe('its words are where it was sent');
      expect(turn.stop).toBe('Ctrl+C in the REPL stops it');
      expect(turn.open).toBe('no run detail: a turn being answered has none until its receipt is sealed');
      // the ended ones: their exit and receipt; verified green, changed not (✕, amber, its words)
      expect(good.state).toBe('✓ completed');
      expect(good.log).toEqual(['FAKE: one', 'FAKE: two', 'FAKE: fine']);
      expect(good.exit).toBe('exit 0');
      expect(good.receipt).toMatch(/^✓ receipt [0-9a-f]{8} verified$/);
      expect(good.receiptVerified).toBe(true);
      expect(good.receiptColor).toBe('rgb(40, 254, 20)');
      expect(good.open).toBe(`opens run ${OP}`);
      expect(good.opens).toBe(OP);
      expect(bad.name).toBe('FAKE.md › changed');
      expect(bad.receipt).toMatch(/^✕ receipt [0-9a-f]{8} does not verify: .+/);
      expect(bad.receiptVerified).toBe(false);
      expect(bad.receiptColor).toBe('rgb(255, 176, 0)');
      // more than four running: not now
      expect(await page.$('[data-control="more"]')).toBeNull();
      await shot(page, 'h155-01-tab7-grid-1376x768');

      // text 11 px or more; green only on the verified receipt; amber only on a failure's ✕ words; no other hue
      const l = await look(page);
      expect(l.small).toEqual([]);
      expect(l.hue).toEqual([]);
      expect(l.green.length).toBeGreaterThan(0);
      for (const g of l.green) expect(g).toMatch(/is-verified color "✓ receipt [0-9a-f]{8} verified"/);
      for (const a of l.amber) expect(a).toMatch(/color "✕ /);

      // read again while the tab is shown: the running pane's newest line moves on
      const newest = (p: Awaited<ReturnType<typeof drawn>>): number => Math.max(0, ...p.filter((x) => x.id === run.id).flatMap((x) => x.log.map((t) => Number(/(\d+)$/.exec(t)?.[1] ?? 0))));
      const n1 = newest(panes);
      await until('a newer line in the running pane', async () => newest(await drawn(page)) >= n1 + 4, 15_000);
      const before = seen.panes.length;
      await sleep(4500);
      expect(seen.panes.length - before, 'reads while shown').toBeGreaterThanOrEqual(2);
      // and not while another tab is shown
      await page.keyboard.press('1');
      await page.waitForFunction(() => (document.querySelector('[data-ws-page="control"]') as HTMLElement).hidden === true);
      await sleep(600);
      const hidden = seen.panes.length;
      await sleep(5000);
      expect(seen.panes.length, 'no read while tab 7 is not shown').toBe(hidden);
      await page.keyboard.press('7');
      await until('a read once it is shown again', () => seen.panes.length > hidden, 10_000);

      // the keyboard reaches a pane that opens a run; a click on it opens its run detail (the Workflows tab, /run/<op>)
      await page.waitForSelector(`[data-panel-host="control"] .control-pane[data-open-run="${OP}"]`, { timeout: 10_000 });
      expect(await page.$eval(`.control-pane[data-open-run="${OP}"]`, (e) => [e.getAttribute('tabindex'), e.getAttribute('role')])).toEqual(['0', 'link']);
      expect(await page.$$eval('[data-panel-host="control"] button, [data-panel-host="control"] input, [data-panel-host="control"] [data-stop-turn], [data-panel-host="control"] [data-act]', (els) => els.length)).toBe(0);
      await page.click(`.control-pane[data-open-run="${OP}"] [data-pane-part="log"]`);
      await page.waitForFunction((op) => location.pathname === `/run/${op}`, OP, { timeout: 10_000 });
      expect(await page.$eval('#ws-tab-workflows', (b) => b.getAttribute('aria-selected'))).toBe('true');
      await shot(page, 'h155-02-tab7-pane-opened-its-run');
      // back on tab 7, Enter on the focused pane opens it the same way
      await page.keyboard.press('7');
      await page.waitForSelector(`.control-pane[data-open-run="${OP}"]`, { timeout: 10_000 });
      await page.evaluate(() => { history.replaceState(null, '', '/'); });
      await page.focus(`.control-pane[data-open-run="${OP}"]`);
      await page.keyboard.press('Enter');
      await page.waitForFunction((op) => location.pathname === `/run/${op}`, OP, { timeout: 10_000 });

      // nothing on the panes started, stopped or changed anything: every request to the companion's API was a GET
      expect(seen.writes).toEqual([]);
      expect(seen.outside).toEqual([]);
      expect(seen.bad).toEqual([]);
      expect(seen.errors).toEqual([]);
    } finally {
      held.hold.release();
      await page.close();
    }
  }, 120_000);

  it('at 390×844: one column, in the same order, nothing sideways; more than four running: the first four, and "N more running"', async () => {
    const jobs = store();
    const started = [];
    for (let k = 0; k < 6; k += 1) {
      started.push(jobs.start({ kind: 'task', label: `FAKE job (test): runner ${k}`, project: 'FAKE-control', root, command: 'sh', args: ['-c', `echo "FAKE runner ${k}"; sleep 60`] }));
      await sleep(15);
    }
    await until('every runner printed', () => started.every((j) => (jobs.get(j.id)?.lines ?? 0) >= 1));
    const { page, seen } = await open({ width: 390, height: 844 });
    try {
      await page.waitForFunction(() => document.querySelectorAll('[data-panel-host="control"] .control-pane').length === 4, null, { timeout: 15_000 });
      await page.waitForSelector('[data-control="more"]', { timeout: 15_000 });
      const panes = await drawn(page);
      expect(panes.map((p) => p.name)).toEqual([5, 4, 3, 2].map((k) => `FAKE job (test): runner ${k}`));
      expect(panes.every((p) => !p.quiet && p.state === '▶ running')).toBe(true);
      // one column: one x, the rows one under another in order
      expect(new Set(panes.map((p) => p.x)).size).toBe(1);
      for (let k = 1; k < panes.length; k += 1) expect(panes[k].y).toBeGreaterThanOrEqual(panes[k - 1].bottom);
      expect(await page.$eval('[data-control="more"]', (e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim())).toBe('2 more running, not drawn here (four panes at most); the Workbench’s tab 7 (timmy workbench, key 7) shows every running pane');
      expect(await page.$eval('[data-control="title"]', (e) => (e.textContent ?? '').trim())).toBe('Panes (4) · 6 running');
      // nothing scrolls sideways
      const m = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, body: document.body.scrollWidth, inner: window.innerWidth }));
      expect(Math.max(m.page, m.body)).toBeLessThanOrEqual(m.inner);
      const l = await look(page);
      expect(l.small).toEqual([]);
      expect(l.hue).toEqual([]);
      expect(l.green).toEqual([]);
      await page.$eval('[data-panel-host="control"]', (e) => e.scrollIntoView());
      await shot(page, 'h155-03-tab7-stacked-390x844');
      expect(seen.writes).toEqual([]);
      expect(seen.outside).toEqual([]);
      expect(seen.bad).toEqual([]);
      expect(seen.errors).toEqual([]);
    } finally {
      await page.close();
      for (const j of started) await jobs.stop(j.id);
    }
  }, 120_000);
});
