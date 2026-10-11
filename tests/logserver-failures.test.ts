// R4 (H87): `timmy logs` never dies on a request. r23: GET /chat crashed it in the installed package (an uncaught ENOENT on its
// page file); any route whose read failed did the same (the request handler had no catch). Now a read that fails answers 500
// with words (no path of this computer, no stack), nothing is logged with the token, and the server keeps answering.
//
// The real log server (src/utils/logserver.ts) runs in a child process of its own (tsx), on 127.0.0.1, over real HTTP. Its page
// folder is the test's (LogServerOptions.pageDir): missing the page, or holding a folder where the page file should be (a real
// EISDIR: "unreadable" even for root, which a file's mode cannot make it); and a folder's theatre state that is a folder too.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LOGS_FAILED, LOGS_PAGE_FAILED } from '../src/utils/logserver.js';

const TOKEN = 'ab'.repeat(32);
const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill('SIGKILL');
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function logServer(pages: (dir: string) => void): Promise<{ base: string; child: ChildProcess; dir: string; out: () => string }> {
  const dir = mkdtempSync(join(tmpdir(), 'timmy-logsfail-'));
  dirs.push(dir);
  const pageDir = join(dir, 'pages');
  mkdirSync(pageDir);
  pages(pageDir);
  mkdirSync(join(dir, 'work', 'shot', 'theatre-state.json'), { recursive: true }); // a folder where a file is read
  const code = `import { startManagedLogServer } from ${JSON.stringify(resolve('src/utils/logserver.ts'))};
    const s = await startManagedLogServer({ port: 0, token: ${JSON.stringify(TOKEN)}, pageDir: ${JSON.stringify(pageDir)} });
    console.log('PORT=' + s.port);`;
  writeFileSync(join(dir, 'serve.mts'), code);
  const child = spawn(resolve('node_modules/.bin/tsx'), [join(dir, 'serve.mts')], {
    cwd: join(dir, 'work'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TIMMY_HOME: join(dir, 'home'), TIMMY_LOGS_OPEN: '0', HOME: join(dir, 'home') },
  });
  children.push(child);
  let out = '';
  child.stdout!.on('data', (d) => { out += String(d); });
  child.stderr!.on('data', (d) => { out += String(d); });
  for (const end = Date.now() + 30_000; !/PORT=\d+/.test(out) && child.exitCode === null && Date.now() < end;) await new Promise((r) => setTimeout(r, 100));
  const port = Number(/PORT=(\d+)/.exec(out)?.[1]);
  expect(port, out).toBeGreaterThan(0);
  return { base: `http://127.0.0.1:${port}`, child, dir, out: () => out };
}

const get = async (url: string, token = false): Promise<{ status: number; type: string; body: string }> => {
  const r = await fetch(url, { headers: token ? { Authorization: `Bearer ${TOKEN}` } : {}, signal: AbortSignal.timeout(10_000) });
  return { status: r.status, type: r.headers.get('content-type') ?? '', body: await r.text() };
};

/** An answer with words only: none of this computer's folders, no stack, no error code. */
const wordsOnly = (body: string, dir: string): boolean => !body.includes(dir) && !/\n\s+at |ENOENT|EISDIR|EACCES|\/home\/|\/Users\/|\/tmp\//.test(body);

describe('`timmy logs` never dies on a request (R4 H87)', () => {
  for (const [what, pages] of [
    ['missing', (_d: string) => undefined],
    ['unreadable (a folder where the file should be)', (d: string) => mkdirSync(join(d, 'chatpage.html'))],
  ] as const) {
    it(`its chat page ${what}: GET /chat is a 500 with words, and the server keeps answering`, async () => {
      const s = await logServer(pages);
      const chat = await get(`${s.base}/chat`);
      expect({ status: chat.status, type: chat.type, words: chat.body.trim() }).toEqual({ status: 500, type: 'text/plain; charset=utf-8', words: LOGS_PAGE_FAILED });
      expect(wordsOnly(chat.body, s.dir)).toBe(true);
      // still answering: its health, its main page, a route that needs the token
      expect((await get(`${s.base}/health`)).status).toBe(200);
      expect((await get(`${s.base}/`)).status).toBe(200);
      expect((await get(`${s.base}/receipts?stream=runs`, true)).status).toBe(200);
      expect(s.child.exitCode).toBe(null);
      // nothing it printed holds the token
      expect(s.out().includes(TOKEN)).toBe(false);
    }, 60_000);
  }

  it('a route whose read fails (a theatre state that is a folder) is a 500 with words, and the server keeps answering', async () => {
    const s = await logServer(() => undefined);
    const theatre = await get(`${s.base}/mission/theatre?folder=shot`, true);
    expect({ status: theatre.status, body: JSON.parse(theatre.body) }).toEqual({ status: 500, body: { ok: false, error: LOGS_FAILED } });
    expect(wordsOnly(theatre.body, s.dir)).toBe(true);
    const health = await get(`${s.base}/health`);
    expect({ status: health.status, ok: JSON.parse(health.body).ok, alive: s.child.exitCode }).toEqual({ status: 200, ok: true, alive: null });
    expect(s.out().includes(TOKEN)).toBe(false);
  }, 60_000);
});
