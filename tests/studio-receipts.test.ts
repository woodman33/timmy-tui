import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startStudioServer } from '../src/studio/server.js';
import { appendReceipt, readChain, receiptsPath, verifyChain } from '../src/utils/receipts.js';

// C-13: Timmy serves the receipt page itself, on 127.0.0.1 only (the same server as Timmy Canvas), with a
// text fallback. The page says "signed and verified" only when the chain verifies and the receipt's own
// signature checks out; every value is escaped; nothing on it is fetched from anywhere else.
const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
async function serve() {
  const dir = mkdtempSync(join(tmpdir(), 'timmy-page-'));
  dirs.push(dir);
  const server = await startStudioServer(0, { receipts: { read: () => readChain('runs', dir), verify: () => verifyChain('runs', dir) } });
  closers.push(() => new Promise<void>((r) => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { dir, base };
}
const seal = (dir: string, subject: string) => appendReceipt('runs', { kind: 'turn', subject, policy: 'human-gated', status: 'ok', cost_usd: 0.004, ms: 1500, model_requested: 'anthropic/claude-sonnet-4.5' }, dir);

describe('the receipt page', () => {
  it('shows a receipt by its short hash, verified, with no outside resources', async () => {
    const { dir, base } = await serve();
    const r = seal(dir, 'repl · 1 step <b>x</b>');
    const res = await fetch(`${base}/receipts/${r.hash.slice(7, 15)}`);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(res.headers.get('content-security-policy')).toMatch(/default-src 'none'/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(html).toContain(r.hash.slice(7, 15));
    expect(html).toContain('signed and verified');
    expect(html).toContain('repl · 1 step &lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toMatch(/<b>x<\/b>|https?:\/\/(?!127\.0\.0\.1)/);
  });
  it('has a text fallback with the same facts', async () => {
    const { dir, base } = await serve();
    const r = seal(dir, 'repl · 2 steps');
    const res = await fetch(`${base}/receipts/${r.hash.slice(7, 15)}?format=text`);
    const text = await res.text();
    expect(res.headers.get('content-type')).toMatch(/text\/plain/);
    expect(text).toContain(`RECEIPT ${r.hash.slice(7, 15)}`);
    expect(text).toContain('signed and verified');
    expect(text).toContain('repl · 2 steps');
    expect(text).toContain('anthropic/claude-sonnet-4.5');
  });
  it('says a broken chain plainly, and an unknown receipt is a 404', async () => {
    const { dir, base } = await serve();
    const r = seal(dir, 'repl · 1 step');
    const p = receiptsPath('runs', dir);
    writeFileSync(p, readFileSync(p, 'utf8').replace('repl', 'REPL'));
    const page = await (await fetch(`${base}/receipts/${r.hash.slice(7, 15)}?format=text`)).text();
    expect(page).toContain('chain broken');
    expect(page).not.toContain('signed and verified');
    const missing = await fetch(`${base}/receipts/00000000`);
    expect([missing.status, await missing.text()]).toEqual([404, 'No receipt 00000000 in this chain.']);
  });
  it('answers 127.0.0.1 only', async () => {
    const { dir, base } = await serve();
    const r = seal(dir, 'repl · 1 step');
    // fetch drops a Host header it is given, so this asks over plain HTTP, as a rebound DNS name would.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      request(`${base}/receipts/${r.hash.slice(7, 15)}`, { headers: { Host: 'timmy.example.com' } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject).end();
    });
    expect(status).toBe(403);
  });
});
