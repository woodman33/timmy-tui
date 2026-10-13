import { existsSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser } from 'playwright';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Receipt } from '../src/utils/receipts.js';
import { mountReceiptPages, receiptHtml, receiptInspect, receiptText } from '../src/studio/receipt-page.js';

// Round R1, assignment 3: the receipt page says where to inspect in the REPL's own words (Receipt, Canvas),
// from the receipt itself (nothing invented), in the text version too, and reads at phone width.
const rec = (extra: Partial<Receipt> = {}): Receipt => ({
  v: 1, id: 'r', stream: 'runs', ts: '2026-10-08T21:00:00.000Z', kind: 'turn', subject: 'repl · 1 step', policy: 'human-gated', status: 'ok',
  hash: `sha256:${'ab12cd34'.repeat(8)}`, prev_hash: `sha256:${'00ff00ff'.repeat(8)}`, ...extra,
}) as Receipt;
const canvas = (job: string, revision: number) => ({ kind: 'timmy-canvas', job, revision, source_revision: 'f'.repeat(64) });
const SHORT = 'ab12cd34';

describe('where to inspect, in the REPL\'s words', () => {
  it('always names the Receipt: this page\'s address, and timmy receipts', () => {
    const rows = receiptInspect(rec());
    expect(rows).toEqual([{ label: 'Receipt', text: `/receipts/${SHORT}`, href: `/receipts/${SHORT}`, hint: 'or timmy receipts' }]);
  });
  it('names each Canvas job the receipt sealed, with its revision, and links the canvas', () => {
    const rows = receiptInspect(rec({ sources: [canvas('job-a', 3), canvas('job-b', 9)] }));
    expect(rows.map((r) => [r.label, r.text])).toEqual([['Receipt', `/receipts/${SHORT}`], ['Canvas', 'job job-a, rev 3'], ['Canvas', 'job job-b, rev 9']]);
    expect(rows.filter((r) => r.label === 'Canvas').every((r) => r.href === '/' && r.hint === 'open the canvas')).toBe(true);
  });
  it('invents no Canvas row: other sources and malformed ones are left out', () => {
    const rows = receiptInspect(rec({ sources: [{ kind: 'web', url: 'x' }, { kind: 'timmy-canvas', job: 5, revision: 1 }, { kind: 'timmy-canvas', job: 'ok', revision: -1 }, null, 'x', canvas('fine', 0)] }));
    expect(rows.map((r) => r.text)).toEqual([`/receipts/${SHORT}`, 'job fine, rev 0']);
  });
  it('shows the same rows in the page and in the text version, escaped', () => {
    const r = rec({ sources: [canvas('a<b>', 2)] });
    const html = receiptHtml(r, true);
    expect(html).toContain('<h2>Inspect</h2>');
    expect(html).toContain(`<dt>Receipt</dt>`);
    expect(html).toContain('<dt>Canvas</dt>');
    expect(html).toContain('job a&lt;b&gt;, rev 2');
    expect(html).not.toContain('a<b>');
    expect(html).toContain('<a href="/">open the canvas</a>');
    const text = receiptText(r, true);
    expect(text).toContain(`Receipt   /receipts/${SHORT} · or timmy receipts`);
    expect(text).toContain('Canvas    job a<b>, rev 2 · open the canvas: /');
    // Plain text is not HTML: nothing in it is escaped.
    expect(text).not.toContain('&lt;');
  });
  it('keeps the verdict and the facts as they were, and the verdict first', () => {
    const html = receiptHtml(rec(), true);
    expect(html.indexOf('signed and verified')).toBeLessThan(html.indexOf('<h2>Inspect</h2>'));
    expect(html).toContain('<dt>sealed</dt><dd>2026-10-08T21:00:00.000Z</dd>');
    expect(receiptHtml(rec(), false)).toContain('chain broken');
    expect(receiptText(rec(), true).split('\n')[0]).toBe(`✓ RECEIPT ${SHORT} signed and verified`);
  });
});

const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('studio-receipt-words: no Chromium or Chrome found, so the phone-width check is skipped here');

describe.skipIf(!browserPath)('the receipt page at phone width, in a real browser', () => {
  let server: Server | undefined;
  let browser: Browser | undefined;
  let base = '';
  beforeAll(async () => {
    const app = express();
    const r = rec({ sources: [canvas('storyboard-turn-0142-long-job-name', 12)], model_requested: 'anthropic/claude-sonnet-4.5', cost_usd: 0.004, ms: 1500, prompt_hash: 'sha256:' + 'c'.repeat(64) });
    mountReceiptPages(app, { read: () => [r], verify: () => ({ ok: true, reason: undefined }) as never });
    server = await new Promise<Server>((done) => { const s = app.listen(0, '127.0.0.1', () => done(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch({ headless: true, executablePath: browserPath });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  });

  for (const width of [320, 390, 768]) {
    it(`fits ${width}px wide: no sideways scroll, text at 14px, Inspect rows readable and unclipped`, async () => {
      const context = await browser!.newContext({ viewport: { width, height: 800 } });
      const page = await context.newPage();
      await page.goto(`${base}/receipts/${SHORT}`);
      const m = await page.evaluate(() => {
        const doc = document.documentElement;
        const rows = [...document.querySelectorAll('h2 ~ dl dd, h2 ~ dl dt')].map((el) => ({ text: el.textContent, right: el.getBoundingClientRect().right, fits: el.scrollWidth <= el.clientWidth + 1 }));
        return { scroll: doc.scrollWidth, client: doc.clientWidth, font: getComputedStyle(document.body).fontSize, rows, h2: document.querySelector('h2')?.textContent };
      });
      expect(m.scroll, 'sideways scroll').toBeLessThanOrEqual(m.client);
      expect(m.font).toBe('14px');
      expect(m.h2).toBe('Inspect');
      expect(m.rows.map((r) => r.text)).toEqual(expect.arrayContaining(['Receipt', 'Canvas']));
      for (const row of m.rows) { expect(row.fits, row.text ?? '').toBe(true); expect(row.right, row.text ?? '').toBeLessThanOrEqual(width); }
      // Where there is little room, a label sits above its value rather than squeezing it.
      if (width <= 390) {
        const stacked = await page.evaluate(() => { const dt = document.querySelector('h2 ~ dl dt')!.getBoundingClientRect(); const dd = document.querySelector('h2 ~ dl dd')!.getBoundingClientRect(); return dd.top >= dt.bottom - 1; });
        expect(stacked).toBe(true);
      }
      await context.close();
    }, 30_000);
  }

  it('links stay on this server: the canvas link is "/" and the receipt link is this page', async () => {
    const context = await browser!.newContext({ viewport: { width: 390, height: 800 } });
    const page = await context.newPage();
    await page.goto(`${base}/receipts/${SHORT}`);
    const hrefs = await page.$$eval('h2 ~ dl a', (as) => as.map((a) => a.getAttribute('href')));
    expect(hrefs).toEqual([`/receipts/${SHORT}`, '/']);
    await context.close();
  });
});
