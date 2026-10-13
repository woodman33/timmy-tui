/**
 * Round R1, gap 5: the browser pages read Timmy's shared look from the server that shows them, and
 * Monaspace Argon is served from this machine, by exact name, when it is not installed.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fontDir, startStudioServer } from '../src/studio/server.js';
import { FONT_FILES, HOMEBREW } from '../src/theme/tokens.js';

let server: Server | undefined;
const dirs: string[] = [];
afterEach(async () => {
  if (server) await new Promise<void>((done) => server!.close(() => done()));
  server = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const start = async (): Promise<string> => {
  const dir = mkdtempSync(join(tmpdir(), 'timmy-theme-'));
  dirs.push(dir);
  server = await startStudioServer(0, { env: {}, canvasDir: dir });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

describe('the shared look on Timmy Canvas\'s server', () => {
  it('serves the theme as CSS', async () => {
    const res = await fetch(`${await start()}/timmy-theme.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/css/);
    const css = await res.text();
    expect(css).toContain(`--timmy-accent: ${HOMEBREW.accent};`);
    expect(css).toContain('font-family: "Monaspace Argon"');
  });
  it.skipIf(!fontDir())('serves each Monaspace Argon face it names, unmodified, and nothing else', async () => {
    const base = await start();
    for (const f of FONT_FILES) {
      const res = await fetch(`${base}/fonts/${f.file}`);
      expect(res.status, f.file).toBe(200);
      expect(res.headers.get('content-type')).toBe('font/woff2');
      const body = new Uint8Array(await res.arrayBuffer());
      expect(Buffer.from(body.slice(0, 4)).toString('latin1')).toBe('wOF2');
      expect(Buffer.compare(Buffer.from(body), readFileSync(join(fontDir()!, f.file)))).toBe(0);
    }
    for (const name of ['monaspace-argon-latin-200-normal.woff2', '..%2Fpackage.json', 'x.woff2']) {
      expect((await fetch(`${base}/fonts/${name}`)).status, name).toBe(404);
    }
  });
  it('the receipt page allows fonts from this server only, and uses the shared look', async () => {
    const { mountReceiptPages } = await import('../src/studio/receipt-page.js');
    const express = (await import('express')).default;
    const app = express();
    const rec = { hash: `sha256:${'a'.repeat(64)}`, prev_hash: 'genesis', ts: '2026-10-08T21:00:00Z', kind: 'turn', subject: 'repl · 1 step', status: 'ok', sig: 'x', pubkey: 'y' } as never;
    mountReceiptPages(app, { read: () => [rec], verify: () => ({ ok: true, count: 1 }) as never });
    const s = await new Promise<Server>((done) => { const x = app.listen(0, '127.0.0.1', () => done(x)); });
    try {
      const res = await fetch(`http://127.0.0.1:${(s.address() as AddressInfo).port}/receipts/aaaaaaaa`);
      expect(res.headers.get('content-security-policy')).toContain("font-src 'self'");
      const html = await res.text();
      expect(html).toContain('var(--timmy-font-mono)');
      expect(html).toContain(`--timmy-ground: ${HOMEBREW.ground};`);
    } finally {
      await new Promise<void>((done) => s.close(() => done()));
    }
  });
  it('the canvas page takes the shared look for Timmy\'s own panel and leaves tldraw\'s alone', () => {
    const html = readFileSync('companion/studio-canvas/index.html', 'utf8');
    expect(html).toContain('<link rel="stylesheet" href="/timmy-theme.css" />');
    expect(html).not.toMatch(/--tl-/);
    // Every color in the page's own style is a shared variable (with its fallback), never a color of its own.
    const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
    for (const hex of style.match(/#[0-9a-f]{6}\b/gi) ?? []) expect(style).toMatch(new RegExp(`var\\(--timmy-[a-z-]+, ${hex}\\)`));
  });
});
