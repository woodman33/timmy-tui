/**
 * R4 (H92, H95): the probe the packed-install check runs on the installed package's pages (scripts/companion-page-probe.mjs;
 * scripts/packed-install-check.mjs, step 6), run here on this checkout's companion and log companion: every workflow a
 * person uses passes, each counted on its own (load, every tab, the live mirror receiving the check's own events, the chat's
 * sample with highlighted code, a drawn Mermaid diagram and its cards, a send to a FAKE upstream, Slate 3D, Proof and
 * Workspace, the canvas, and the log companion's four pages including its chat mirror). Its negative control: a FAKE
 * stand-in server whose page asks other sites for a style sheet and a script (as the page at b69ab12 asked CDNs) and sends
 * no policy: the probe fails it, having recorded each of those requests and aborted it before it left (documentation
 * addresses, cdn.example and 192.0.2.1, and a browser that resolves no name but 127.0.0.1: nothing is fetched). Skipped,
 * saying so, where no Chromium or Chrome is found.
 */
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import { beforeAll, describe, expect, it } from 'vitest';
import { ensureCompanionWeb } from '../scripts/companion-web-build.mjs';
import { logsPolicyOk, probeCompanionPage, strictPolicy } from '../scripts/companion-page-probe.mjs';
import { startCompanionServer } from '../src/companion/server.js';
import { pagePolicy } from '../src/companion/page.js';
import { logsPagePolicy, startManagedLogServer } from '../src/utils/logserver.js';

const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('companion-page-probe: no Chromium or Chrome found, so the probe was not run here');

describe('the policies the probe asks for (src/companion/page.ts pagePolicy, src/utils/logserver.ts logsPagePolicy)', () => {
  it('the companion\'s is the page\'s; one with unsafe-inline scripts, another site, eval or no socket of its own is not', () => {
    expect(strictPolicy(pagePolicy('127.0.0.1:4100'), 4100)).toBe(true);
    expect(strictPolicy(pagePolicy('127.0.0.1:4100'), 4101)).toBe(false);
    expect(strictPolicy(pagePolicy('127.0.0.1:4100').replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"), 4100)).toBe(false);
    expect(strictPolicy(pagePolicy('127.0.0.1:4100').replace("script-src 'self'", "script-src 'self' https://cdn.example"), 4100)).toBe(false);
    expect(strictPolicy(pagePolicy('127.0.0.1:4100').replace("script-src 'self'", "script-src 'self' 'unsafe-eval'"), 4100)).toBe(false);
    expect(strictPolicy(pagePolicy('127.0.0.1:4100').replace("img-src 'self' data:", 'img-src *'), 4100)).toBe(false);
    expect(strictPolicy(null, 4100)).toBe(false);
    // a Host the local rule would never let through is not written into the policy
    expect(pagePolicy('127.0.0.1:4100; script-src *')).toContain("connect-src 'self';");
  });
  it('the log companion\'s run only their own scripts: by the answer\'s nonce, or (the chat mirror) from itself', () => {
    for (const p of ['/', '/mission', '/browser', '/chat'] as const) expect(logsPolicyOk(logsPagePolicy('AAAAAAAAAAAAAAAAAAAAAA==', p), p), p).toBe(true);
    expect(logsPolicyOk(logsPagePolicy('AAAAAAAAAAAAAAAAAAAAAA==', '/').replace("script-src 'nonce-", "script-src 'unsafe-inline' 'nonce-"), '/')).toBe(false);
    expect(logsPolicyOk(logsPagePolicy('AAAAAAAAAAAAAAAAAAAAAA==', '/chat').replace("script-src 'self'", "script-src 'self' https://esm.sh"), '/chat')).toBe(false);
  });
});

describe.skipIf(!browserPath)('the packed-install check\'s browser probe (R4 H92, H95)', () => {
  beforeAll(async () => { await ensureCompanionWeb(); }, 600_000);

  it('passes on this checkout\'s pages, workflow by workflow: each with requests to its own server only, no violation, no error', async () => {
    const r = await probeCompanionPage({ startCompanionServer, startManagedLogServer, chromium, executablePath: browserPath });
    expect(r.error).toBeNull();
    expect(r.workflows.map((w) => w.name)).toEqual(['load', 'every tab', 'live mirror', 'chat sample', 'chat send (FAKE upstream)', 'slate 3d', 'proof, workspace', 'canvas', 'logs /', 'logs /mission', 'logs /browser', 'logs /chat']);
    for (const w of r.workflows) {
      expect(w.why, w.name).toBeNull();
      expect(w.outside, w.name).toEqual([]);
      expect(w.violations, w.name).toEqual([]);
      expect(w.errors, w.name).toEqual([]);
      expect(w.ok, w.name).toBe(true);
    }
    expect(r.workflows.find((w) => w.name === 'load')!.requests).toBeGreaterThan(5);
    expect(r.connected).toBe(true);
    expect(r.outside).toEqual([]);
    expect(r.own).toBe(r.requests);
    expect(r.sample).toMatchObject({ heading: expect.any(String), diagram: true, receipt: 'NOT VERIFIED HERE', copy: expect.stringMatching(/timmy verify/) });
    expect(r.sample!.highlighted).toBeGreaterThan(3);
    expect(r.workflows.find((w) => w.name === 'logs /chat')!.detail).toMatchObject({ policy: 'strict', drawn: 'SYNTHETIC answer' });
    if (r.slate) expect(r.slate.contrast).toBeGreaterThanOrEqual(4.5);
    expect(r.ok).toBe(true);
  }, 240_000);

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
    const r = await probeCompanionPage({ startCompanionServer: fakeStart, chromium, executablePath: browserPath, timeoutMs: 4_000 });
    expect(r.error).toMatch(/not the companion's page/);
    expect(r.connected).toBe(true);
    expect(r.csp).toBeNull();
    expect(r.outside).toEqual(expect.arrayContaining(['https://cdn.example', 'http://192.0.2.1']));
    expect(r.workflows.find((w) => w.name === 'load')!.outside).toEqual(expect.arrayContaining(['https://cdn.example', 'http://192.0.2.1']));
    expect(r.workflows.find((w) => w.name === 'load')!.ok).toBe(false);
    expect(r.ok).toBe(false);
  }, 240_000);
});
