/**
 * R4 (H92): the probe the packed-install check runs on the installed package's companion page (scripts/companion-page-probe
 * .mjs; scripts/packed-install-check.mjs step 6), run here on this checkout's companion: it passes. Its negative control: a
 * FAKE stand-in server whose page asks other sites for a style sheet and a script (as the page at b69ab12 asked CDNs) and
 * sends no policy: the probe fails it, having recorded each of those requests and aborted it before it left (documentation
 * addresses, cdn.example and 192.0.2.1, and a browser that resolves no name but 127.0.0.1: nothing is fetched). Skipped,
 * saying so, where no Chromium or Chrome is found.
 */
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { describe, expect, it } from 'vitest';
import { probeCompanionPage, strictPolicy } from '../scripts/companion-page-probe.mjs';
import { startCompanionServer } from '../src/companion/server.js';
import { pagePolicy } from '../src/companion/page.js';

const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('companion-page-probe: no Chromium or Chrome found, so the probe was not run here');

describe('the policy the probe asks for (src/companion/page.ts pagePolicy)', () => {
  it('is the page\'s; one with unsafe-inline, another site or no socket of its own is not', () => {
    expect(strictPolicy(pagePolicy('127.0.0.1:4100'), 4100)).toBe(true);
    expect(strictPolicy(pagePolicy('127.0.0.1:4100'), 4101)).toBe(false);
    expect(strictPolicy(pagePolicy('127.0.0.1:4100').replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"), 4100)).toBe(false);
    expect(strictPolicy(pagePolicy('127.0.0.1:4100').replace("script-src 'self'", "script-src 'self' https://cdn.example"), 4100)).toBe(false);
    expect(strictPolicy(null, 4100)).toBe(false);
    // a Host the local rule would never let through is not written into the policy
    expect(pagePolicy('127.0.0.1:4100; script-src *')).toContain("connect-src 'self';");
  });
});

describe.skipIf(!browserPath)('the packed-install check\'s browser probe (R4 H92)', () => {
  it('passes on this checkout\'s companion page: connected, nothing asked of anywhere else, no violation, the sample drawn', async () => {
    const r = await probeCompanionPage({ startCompanionServer, chromium, executablePath: browserPath });
    expect(r.error).toBeNull();
    expect(r.connected).toBe(true);
    expect(r.outside).toEqual([]);
    expect(r.requests).toBeGreaterThan(0);
    expect(r.own).toBe(r.requests);
    expect(r.violations).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(r.sample).toMatchObject({ heading: expect.any(String), code: expect.any(String), copy: 'Copy', diagram: expect.stringMatching(/not drawn here/) });
    expect(r.sample!.items).toBeGreaterThan(0);
    if (r.slate) expect(r.slate.contrast).toBeGreaterThanOrEqual(4.5);
    expect(r.ok).toBe(true);
  }, 120_000);

  it('fails a FAKE page that asks other sites (no policy), recording each request it aborted', async () => {
    const PAGE = [
      '<!doctype html><meta charset="utf-8"><title>FAKE companion page</title>',
      '<link rel="stylesheet" href="https://cdn.example/fonts.css">',
      '<script src="http://192.0.2.1/lib.js"></script>',
      '<p id="status-text">COMPANION SOCKET · CONNECTED</p>',
    ].join('\n');
    const fakeStart = async (): Promise<{ port: number; url: string; shutdown: () => Promise<void> }> => {
      const s = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(PAGE); });
      await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
      const port = (s.address() as AddressInfo).port;
      return { port, url: `http://127.0.0.1:${port}/#t=${'ab'.repeat(32)}`, shutdown: () => new Promise<void>((r) => { s.close(() => r()); s.closeAllConnections(); }) };
    };
    const r = await probeCompanionPage({ startCompanionServer: fakeStart, chromium, executablePath: browserPath });
    expect(r.error).toBeNull();
    expect(r.connected).toBe(true);
    expect(r.csp).toBeNull();
    expect(r.outside).toEqual(expect.arrayContaining(['https://cdn.example', 'http://192.0.2.1']));
    expect(r.ok).toBe(false);
  }, 120_000);
});
