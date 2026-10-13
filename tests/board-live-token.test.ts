// Round R4, review M4: the live board's token is never on a process's command line, in a shell's history or in a
// child's environment. /board live runs here through the REPL's own opener (openWebView, src/repl/web.ts) with
// real child processes: tmux, zellij, sh and carbonyl are FAKES (tests/fixtures/fake-web.mjs, labelled there), put
// first on the PATH the opener gives its children. Each fake records its arguments and environment; the fake
// carbonyl also records `ps` (every command line on this machine) while it runs, then opens its address the way
// a browser does and asks the board for its state with the token from the fragment.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { folderProject } from '../src/project/index.js';
import { openWebView, planWeb, resolveWebTarget, type WebPlan } from '../src/repl/web.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';

// The real headless Chromium tests/board-live-browser.test.ts uses (skipped when none is found).
const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && existsSync(p!));
if (!browserPath) console.warn('board-live-token: no Chromium or Chrome found, so the real-browser check is skipped here');

const FAKE_WEB = resolve('tests/fixtures/fake-web.mjs');
const dirs: string[] = [];
const spaces: Workspace[] = [];
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const text = (lines: { text: string }[][]): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

afterEach(async () => {
  for (const w of spaces.splice(0)) await w.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Every run of `n` characters of the token: none may appear anywhere a process shows. */
const parts = (token: string, n: number): string[] => Array.from({ length: token.length - n + 1 }, (_, i) => token.slice(i, i + n));
const holds = (s: string, token: string, n: number): boolean => parts(token, n).some((p) => s.includes(p));

async function until<T>(check: () => T | undefined, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = check();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

/** The FAKE programs, by name, in a folder of their own: each runs tests/fixtures/fake-web.mjs as that role. */
function fakeBin(): string {
  const bin = join(temp('timmy-fake-bin-'), 'bin');
  mkdirSync(bin);
  const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
  for (const role of ['tmux', 'zellij', 'sh', 'carbonyl']) {
    writeFileSync(join(bin, role), `#!/bin/sh\n# FAKE ${role} (tests/fixtures/fake-web.mjs)\nexec ${q(process.execPath)} ${q(FAKE_WEB)} ${role} "$@"\n`);
    chmodSync(join(bin, role), 0o755);
  }
  return bin;
}

interface Rec { role: string; pid: number; argv?: string[]; env?: Record<string, string>; done?: boolean; ps?: string; fileMode?: number; dirMode?: number; targetSha256?: string; page?: number; state?: number; project?: string | null; chromium?: { url: string; project: string; status: string } }
const records = (log: string): Rec[] => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Rec) : []);

function project(): string {
  const root = temp('board-token-');
  writeFileSync(join(root, 'BUILD.md'), '# Build\n\n```bash [name:setup]\nmkdir -p dist\n```\n');
  return root;
}

/** A Workspace whose openWeb is the REPL's (src/repl/main.ts), with the fakes first on its children's PATH. */
function make(route: 'tmux' | 'zellij', extra: Record<string, string> = {}) {
  const bin = fakeBin();
  const log = join(temp('timmy-fake-log-'), 'web.jsonl');
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, FAKE_WEB_LOG: log, ...extra };
  delete env.TMUX; delete env.ZELLIJ;
  if (route === 'tmux') env.TMUX = '/tmp/fake-tmux-socket,1,0'; else env.ZELLIJ = '0';
  const opened: string[] = [];
  const ws = new Workspace({
    glyphs: glyphSet(true),
    env: {},
    onPath: () => null,
    notify: () => {},
    openWeb: (url: string, opts?: { secret?: boolean }) => {
      const line = openWebView({ url: resolveWebTarget(url), has: (b) => b === 'carbonyl', locate: (b) => (b === 'carbonyl' ? join(bin, 'carbonyl') : null), env, allowRemote: false, secret: opts?.secret }, { show: (u) => u });
      opened.push(line);
      return line;
    },
    link: (t) => t,
    seal: () => 'id1',
    jobsDir: join(temp('jobs-'), 'jobs'),
    chdir: () => {},
  }, folderProject(project()));
  spaces.push(ws);
  return { ws, log, opened };
}

describe('/board live keeps its token off every command line and environment (review M4)', () => {
  for (const route of ['tmux', 'zellij'] as const) {
    it(`through the ${route} route: the panes run on a private launch page; the board still lets the page in`, async () => {
      const { ws, log, opened } = make(route);
      const shown = text(await ws.boardLive('live'));
      const { url, port } = ws.liveBoard!;
      const token = url.split('#t=')[1];
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      const done = await until(() => records(log).find((r) => r.role === 'carbonyl' && r.done), 20_000, 'the fake carbonyl');
      const all = records(log);

      // tmux or zellij, the pane's sh and carbonyl each ran once.
      expect(all.filter((r) => !r.done).map((r) => r.role).sort()).toEqual(['carbonyl', 'sh', route].sort());
      // No part of the token in any argument or environment of any of them, nor in any command line on this machine.
      const leaks = all.flatMap((r) => [
        ...(r.argv ?? []).filter((a) => holds(a, token, 8)).map(() => `${r.role} argv`),
        ...Object.entries(r.env ?? {}).filter(([, v]) => holds(String(v), token, 8)).map(([k]) => `${r.role} env ${k}`),
      ]);
      expect(leaks).toEqual([]);
      expect(holds(done.ps ?? '', token, 16)).toBe(false);
      expect(done.ps).toContain(FAKE_WEB);
      // carbonyl was given a private page (folder 0700, page 0600) that sends it to the board's address.
      const carbonyl = all.find((r) => r.role === 'carbonyl' && !r.done)!;
      const page = carbonyl.argv!.at(-1)!;
      expect(page).toMatch(/^file:\/\//);
      expect(basename(fileURLToPath(page))).toBe('open.html');
      expect({ file: done.fileMode, dir: done.dirMode }).toEqual({ file: 0o600, dir: 0o700 });
      expect(done.targetSha256).toBe(sha256(url));
      // The board let the page in, with the token the page carried.
      expect({ page: done.page, state: done.state, project: done.project }).toEqual({ page: 200, state: 200, project: ws.project.name });
      // Once the board has answered the page's first request with the token, the page and its folder are gone.
      await until(() => (existsSync(dirname(fileURLToPath(page))) ? undefined : true), 5000, 'the launch page to be removed');
      // What the REPL printed names the pane, not the token.
      expect(opened).toEqual([route === 'tmux' ? 'Opened in a tmux popup. Ctrl+C there closes it.' : 'Opened in a floating zellij pane. Ctrl+C there closes it.']);
      expect(holds(shown, token, 8)).toBe(false);
      expect(port).toBeGreaterThan(0);
    }, 40_000);
  }

  it.skipIf(!browserPath)('in a real headless Chromium (the fake carbonyl drives it): the launch page opens the board, which lets it in and drops the token from the address', async () => {
    const { ws, log } = make('tmux', { FAKE_CARBONYL_CHROMIUM: browserPath! });
    await ws.boardLive('live');
    const { url, port } = ws.liveBoard!;
    const token = url.split('#t=')[1];
    const done = await until(() => records(log).find((r) => r.role === 'carbonyl' && r.done), 60_000, 'the fake carbonyl driving Chromium');
    expect(done.chromium).toEqual({ url: `http://127.0.0.1:${port}/`, project: ws.project.name, status: expect.stringMatching(/^live · /) });
    const all = records(log);
    const leaks = all.flatMap((r) => [...(r.argv ?? []), ...Object.values(r.env ?? {})].filter((a) => holds(String(a), token, 8)).map(() => r.role));
    expect(leaks).toEqual([]);
    expect(holds(done.ps ?? '', token, 16)).toBe(false);
    const page = all.find((r) => r.role === 'carbonyl' && !r.done)!.argv!.at(-1)!;
    expect(page).toMatch(/^file:\/\/.*\/open\.html$/);
    await until(() => (existsSync(dirname(fileURLToPath(page))) ? undefined : true), 5000, 'the launch page to be removed');
  }, 90_000);
});

/** One GET to the board, with exactly the headers given (Host is the board's own). */
function get(port: number, path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { Host: `127.0.0.1:${port}`, ...headers }, setHost: false, agent: false }, (res) => { res.resume(); res.on('end', () => done(res.statusCode ?? 0)); });
    req.on('error', fail);
    req.end();
  });
}

describe('the launch page /board live writes', () => {
  /** A Workspace whose openWeb only plans (no process), as inside zellij with carbonyl: the plan is kept. */
  function planned() {
    const plans: WebPlan[] = [];
    const ws = new Workspace({
      glyphs: glyphSet(true), env: {}, onPath: () => null, notify: () => {}, link: (t) => t, seal: () => 'id1', jobsDir: join(temp('jobs-'), 'jobs'), chdir: () => {},
      openWeb: (url: string, opts?: { secret?: boolean }) => { const p = planWeb({ url, has: (b) => b === 'carbonyl', env: { ZELLIJ: '0' }, allowRemote: false, secret: opts?.secret }); plans.push(p); return p.note; },
    }, folderProject(project()));
    spaces.push(ws);
    return { ws, plans };
  }

  it('stays until a request carries the token (the page and a wrong token do not remove it), then is gone', async () => {
    const { ws, plans } = planned();
    await ws.boardLive('live');
    const { url, port } = ws.liveBoard!;
    const page = plans[0].page!;
    expect(page.target).toBe(url);
    expect(readFileSync(page.path, 'utf8')).toContain(JSON.stringify(url));
    expect(await get(port, '/')).toBe(200);
    expect(await get(port, '/state', { Authorization: `Bearer ${'0'.repeat(64)}` })).toBe(401);
    expect(existsSync(page.path)).toBe(true);
    expect(await get(port, '/state', { Authorization: `Bearer ${url.split('#t=')[1]}` })).toBe(200);
    expect(existsSync(page.dir)).toBe(false);
    expect(page.removed).toBe(true);
  });

  it('is removed by /board off when no browser came', async () => {
    const { ws, plans } = planned();
    await ws.boardLive('live');
    expect(existsSync(plans[0].page!.path)).toBe(true);
    await ws.boardLive('off');
    expect(existsSync(plans[0].page!.dir)).toBe(false);
  });
});
