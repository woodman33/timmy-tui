// R4 (H87): `timmy logs` never dies on a request. r23: GET /chat crashed it in the installed package (an uncaught ENOENT on its
// page file); any route whose read failed did the same (the request handler had no catch). Now a read that fails answers 500
// with words (no path of this computer, no stack), nothing is logged with the token, and the server keeps answering.
//
// The real log server (src/utils/logserver.ts) runs in a child process of its own (Node with tsx's loader), on 127.0.0.1, over
// real HTTP. Its page folder is the test's (LogServerOptions.pageDir): missing the page, or holding a folder where the page
// file should be (a real EISDIR: "unreadable" even for root, which a file's mode cannot make it); and a folder's theatre state
// that is a folder too.
//
// R4 (H97): every server this file starts is ended, and the test checks it. Before, each run left its three servers running
// after vitest exited (found by H95: 30 were running): the test started tsx's command, which runs the script in a child
// process of its own, and SIGKILL ended only tsx, never that child (a server keeps its process alive). Now the server is the
// one process this test starts (Node with tsx's loader), in a process group of its own; ending it kills the whole group, and
// each test then checks that nothing of that group, and no process naming the test's own folder, is left.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { LOGS_FAILED, LOGS_PAGE_FAILED } from '../src/utils/logserver.js';

const TOKEN = 'ab'.repeat(32);
/** tsx's loader, by its file: the server's own folder is the test's (no node_modules there to find tsx by name). */
const LOADER = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;

interface Served { base: string; child: ChildProcess; dir: string; out: () => string; pid: number; ended: boolean }
/** Every server this file started, and every folder it made (each server's folder is named in its command line). */
const servers: Served[] = [];
const dirs: string[] = [];

/** What is still running: each process (not a zombie, which has already ended) of group `pgid`, or whose command line names `dir`. */
function left(pgid: number, dir: string): string[] {
  const r = spawnSync('ps', ['-A', '-o', 'pid=,pgid=,stat=,args='], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ps could not list the processes: ${r.stderr}`);
  return r.stdout.split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m || m[3].startsWith('Z') || Number(m[1]) === process.pid) return [];
    return Number(m[2]) === pgid || m[4].includes(dir) ? [`${m[1]} ${m[4]}`] : [];
  });
}

/** Ends a server: SIGKILL to its whole process group, then waits (up to 10 s) until nothing of it is left; what is left. */
async function end(s: Served): Promise<string[]> {
  if (!s.ended) {
    s.ended = true;
    const exited = s.child.exitCode !== null || s.child.signalCode !== null ? Promise.resolve() : new Promise<void>((r) => { s.child.once('exit', () => r()); });
    try { process.kill(-s.pid, 'SIGKILL'); } catch { /* its group has ended */ }
    await exited;
  }
  let still = left(s.pid, s.dir);
  for (const until = Date.now() + 10_000; still.length && Date.now() < until; still = left(s.pid, s.dir)) await new Promise((r) => setTimeout(r, 100));
  return still;
}

afterEach(async () => {
  // a test that failed before its own end: its server ended here all the same
  for (const s of servers) await end(s);
});
afterAll(async () => {
  // the proof for the whole file: nothing it started is running, by group and by folder
  const still = (await Promise.all(servers.map(end))).flat();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  expect(still).toEqual([]);
});

async function logServer(pages: (dir: string) => void): Promise<Served> {
  const dir = mkdtempSync(join(tmpdir(), 'timmy-logsfail-'));
  dirs.push(dir);
  const pageDir = join(dir, 'pages');
  mkdirSync(pageDir);
  pages(pageDir);
  mkdirSync(join(dir, 'work', 'shot', 'theatre-state.json'), { recursive: true }); // a folder where a file is read
  const code = `import { startManagedLogServer } from ${JSON.stringify(resolve('src/utils/logserver.ts'))};
    const s = await startManagedLogServer({ port: 0, token: ${JSON.stringify(TOKEN)}, pageDir: ${JSON.stringify(pageDir)} });
    console.log('PORT=' + s.port + ' PID=' + process.pid);`;
  writeFileSync(join(dir, 'serve.mts'), code);
  // one process (Node itself, with tsx's loader), leading a process group of its own: ending the group ends all of it
  const child = spawn(process.execPath, ['--import', LOADER, join(dir, 'serve.mts')], {
    cwd: join(dir, 'work'), stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    env: { ...process.env, TIMMY_HOME: join(dir, 'home'), TIMMY_LOGS_OPEN: '0', HOME: join(dir, 'home') },
  });
  let out = '';
  child.stdout!.on('data', (d) => { out += String(d); });
  child.stderr!.on('data', (d) => { out += String(d); });
  const s: Served = { base: '', child, dir, out: () => out, pid: child.pid!, ended: false };
  servers.push(s);
  for (const until = Date.now() + 30_000; !/PORT=\d+ PID=\d+/.test(out) && child.exitCode === null && Date.now() < until;) await new Promise((r) => setTimeout(r, 100));
  const said = /PORT=(\d+) PID=(\d+)/.exec(out);
  expect(Number(said?.[1]), out).toBeGreaterThan(0);
  // the server is the process this test started (no launcher in between whose end would leave it running)
  expect(Number(said?.[2]), out).toBe(child.pid);
  s.base = `http://127.0.0.1:${said![1]}`;
  return s;
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
      // R4 (H97): ended, and nothing of it left running
      expect(await end(s)).toEqual([]);
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
    // R4 (H97): ended, and nothing of it left running
    expect(await end(s)).toEqual([]);
  }, 60_000);
});
