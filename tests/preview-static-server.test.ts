// The preview's static server (src/preview/static-server.ts). Independent source review at c7475458
// (2026-10-08), finding 5: a file that cannot be read (unreadable, or removed while a build rewrites the
// folder) must not take the whole server down.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { STATIC_SERVER_JS } from '../src/preview/static-server.js';

const INJECT = resolve('tests/fixtures/fail-read-stream.cjs');
const running: ChildProcess[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const p of running.splice(0)) p.kill('SIGKILL');
  for (const d of dirs.splice(0)) { try { chmodSync(join(d, 'locked.html'), 0o644); } catch { /* none */ } rmSync(d, { recursive: true, force: true }); }
});

function site(): string {
  const d = mkdtempSync(join(tmpdir(), 'static-'));
  dirs.push(d);
  writeFileSync(join(d, 'index.html'), '<h1>Home</h1>\n');
  writeFileSync(join(d, 'broken.html'), '<h1>never served</h1>\n');
  return d;
}

/** Starts the server on a free port; resolves with its address once it says so. */
function serve(dir: string, preload: string[] = []): Promise<{ url: string; child: ChildProcess; exited: () => boolean }> {
  const child = spawn(process.execPath, [...preload, '-e', STATIC_SERVER_JS, dir, '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  running.push(child);
  let exited = false;
  child.once('exit', () => { exited = true; });
  return new Promise((ok, fail) => {
    let out = '';
    child.stdout!.on('data', (b: Buffer) => {
      out += b.toString();
      const m = /serving at (http:\/\/127\.0\.0\.1:\d+\/)/.exec(out);
      if (m) ok({ url: m[1], child, exited: () => exited });
    });
    child.once('exit', (code) => fail(new Error(`server exited (${code}) before serving: ${out}`)));
  });
}

describe('review: an unreadable file does not take the preview down', () => {
  it('answers 500 for a file whose read fails, and keeps serving the rest', async () => {
    const dir = site();
    const s = await serve(dir, ['--require', INJECT]);
    const bad = await fetch(`${s.url}broken.html`, { signal: AbortSignal.timeout(3000) });
    expect(bad.status).toBe(500);
    await new Promise((r) => setTimeout(r, 100));
    expect(s.exited()).toBe(false);
    const good = await fetch(s.url, { signal: AbortSignal.timeout(3000) });
    expect(good.status).toBe(200);
    expect(await good.text()).toContain('Home');
  });

  // Root reads anything regardless of mode, so the real unreadable file runs where tests are not root (CI).
  it.skipIf(process.getuid?.() === 0)('answers 500 for a real unreadable file and keeps serving', async () => {
    const dir = site();
    writeFileSync(join(dir, 'locked.html'), 'secret');
    chmodSync(join(dir, 'locked.html'), 0o000);
    const s = await serve(dir);
    const bad = await fetch(`${s.url}locked.html`, { signal: AbortSignal.timeout(3000) });
    expect(bad.status).toBe(500);
    expect(await bad.text()).not.toContain('secret');
    const good = await fetch(s.url, { signal: AbortSignal.timeout(3000) });
    expect(good.status).toBe(200);
    expect(s.exited()).toBe(false);
  });
});

// Independent verification of b1ede23: opening a FIFO blocks one of Node's four file threads for good,
// so four requests for one stopped the server answering; a folder named index.html sent a 200 then broke.
describe('review follow-up: only regular files are served', () => {
  it.skipIf(process.platform === 'win32')('answers 404 for a FIFO and for a folder named like a page, and keeps serving', async () => {
    const dir = site();
    execFileSync('mkfifo', [join(dir, 'pipe.txt')]);
    mkdirSync(join(dir, 'sub', 'index.html'), { recursive: true });
    const s = await serve(dir);
    const pipes = await Promise.all([1, 2, 3, 4, 5].map(() => fetch(`${s.url}pipe.txt`, { signal: AbortSignal.timeout(1500) }).then((r) => r.status, () => 'no answer')));
    expect(pipes).toEqual([404, 404, 404, 404, 404]);
    const sub = await fetch(`${s.url}sub/`, { signal: AbortSignal.timeout(1500) }).then((r) => r.status, () => 'no answer');
    expect(sub).toBe(404);
    const good = await fetch(s.url, { signal: AbortSignal.timeout(3000) });
    expect(good.status).toBe(200);
  });
});
