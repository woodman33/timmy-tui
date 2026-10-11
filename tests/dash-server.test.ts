// R4 (H97): TIMMY Studios' dashboard server (`/panes`, `/publish`, the legacy Slate panel's panes) is Timmy's own, on this
// computer only, and serves only what its pages need. It was `python3 -m http.server 4273 --directory <the working folder>`
// (src/utils/dash.ts), which listens on every network address and served the whole folder: run on a temporary folder here,
// it answered GET /.env with the file and GET /.timmy/generations.json through this computer's network address, 200 each.
//
// The real server (src/utils/dash-server.ts) on 127.0.0.1, over real HTTP and real sockets, with real files in a temporary
// folder (a SYNTHETIC .env and .timmy/ beside the pages: nothing of the account's). FAKE only: the process that stands for an
// older Timmy's Python server (a Node process whose command line names http.server; no Python server is started).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { connect } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureDashServer, renderDashboardHtml, stopDashServer, writeDashboard } from '../src/utils/dash.js';
import {
  DASH_FOREIGN, DASH_NOT_SERVED, DASH_PORT, DASH_PRIVATE, dashGenerations, dashHealth, dashRootId, startDashServer, type DashServer,
} from '../src/utils/dash-server.js';
import { handleSlashCommand } from '../src/utils/slash-commands.js';
import { initProject, addRefToProject, renderProjectSite } from '../src/utils/projects.js';

/** A 1x1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const SECRET = `SYNTHETIC_SECRET_${Date.now().toString(36)}`;

const dirs: string[] = [];
const servers: DashServer[] = [];
const others: Server[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  await stopDashServer();
  for (const s of servers.splice(0)) await s.close();
  for (const s of others.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill('SIGKILL');
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A working folder as Timmy leaves one: a .env, .timmy/ (ledger, events, receipts), studio/ with the dashboard, a Slate project and frames. */
function folder(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'h97-dash-')));
  dirs.push(root);
  writeFileSync(join(root, '.env'), `OPENROUTER_API_KEY=${SECRET}\n`);
  writeFileSync(join(root, 'package.json'), '{"name":"a-project"}\n');
  mkdirSync(join(root, '.timmy', 'runs'), { recursive: true });
  mkdirSync(join(root, '.timmy', 'receipts'), { recursive: true });
  writeFileSync(join(root, '.timmy', 'receipts', 'runs.jsonl'), `{"note":"${SECRET}"}\n`);
  const frames = join(root, 'studio', 'frames', 'clip');
  mkdirSync(frames, { recursive: true });
  for (const n of [1, 2]) writeFileSync(join(frames, `frame_000${n}.png`), PNG);
  writeFileSync(join(root, '.timmy', 'generations.json'), JSON.stringify({
    schema: 1,
    generations: [
      { id: 'gen_a', prompt: 'a lighthouse at dusk', prompt_hash: 'sha256_x', provider: 'seedance-2-0', model: 'bytedance/seedance-2.0', kind: 'video', transport: 'openrouter', status: 'done', cost_usd: 0.22, framesDir: frames, frameCount: 2, artifact: join(root, 'studio', 'clip.mp4'), stamp: 's', created_at: '2026-10-11T10:00:00.000Z', spans: [{ name: 'x', kind: 'root' }] },
      { id: 'gen_b', prompt: 'a placeholder cost', prompt_hash: 'sha256_y', provider: 'higgsfield', kind: 'image', transport: 'higgsfield', status: 'done', cost_usd: 0, cost_measured: false, framesDir: join(root, '.timmy', 'frames'), stamp: 's', created_at: '2026-10-11T10:01:00.000Z' },
    ],
  }));
  writeFileSync(join(root, '.timmy', 'runs', 'events.jsonl'), Array.from({ length: 40 }, (_, i) => JSON.stringify({ ts: `2026-10-11T10:${String(i).padStart(2, '0')}:00.000Z`, genId: 'gen_a', event: `e${i}` })).join('\n') + '\n');
  writeDashboard(root);
  initProject('p', {}, root);
  const ref = join(root, 'ref.png');
  writeFileSync(ref, PNG);
  addRefToProject('p', ref, 'hero', root);
  renderProjectSite('p', root);
  return root;
}

async function serve(root: string): Promise<DashServer> {
  const s = await startDashServer({ root, port: 0 });
  servers.push(s);
  return s;
}

/** A raw request (any Host, any Origin, any method), its status, headers and body. */
function raw(port: number, path: string, o: { host?: string; origin?: string; method?: string } = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: o.method ?? 'GET', headers: { Host: o.host ?? `127.0.0.1:${port}`, ...(o.origin ? { Origin: o.origin } : {}) } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('the dashboard server: this computer only (R4 H97)', () => {
  it('listens on 127.0.0.1 only: this computer\'s network addresses are refused at connection', async () => {
    const s = await serve(folder());
    expect((s.server.address() as AddressInfo).address).toBe('127.0.0.1');
    const own = Object.values(networkInterfaces()).flat().filter((a) => a && !a.internal && a.family === 'IPv4').map((a) => a!.address);
    if (!own.length) console.warn('dash-server: this computer has no network address besides loopback, so only the bound address was checked');
    for (const address of own) {
      const outcome = await new Promise<string>((resolve) => {
        const sock = connect({ host: address, port: s.port });
        sock.setTimeout(3000, () => { sock.destroy(); resolve('timeout'); });
        sock.once('connect', () => { sock.destroy(); resolve('connected'); });
        sock.once('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'error'));
      });
      expect(outcome, `a connection to ${address}:${s.port}`).toBe('ECONNREFUSED');
    }
  });

  it('refuses a request addressed to another name (DNS rebinding) or sent by a page elsewhere, with words; answers this computer\'s own', async () => {
    const s = await serve(folder());
    for (const host of ['dash.example', `dash.example:${s.port}`]) {
      const r = await raw(s.port, '/studio/dashboard.html', { host });
      expect({ status: r.status, error: JSON.parse(r.body).error }).toEqual({ status: 403, error: DASH_FOREIGN });
    }
    const r = await raw(s.port, '/data/generations.json', { origin: 'http://dash.example' });
    expect({ status: r.status, error: JSON.parse(r.body).error }).toEqual({ status: 403, error: DASH_FOREIGN });
    for (const host of [`127.0.0.1:${s.port}`, `localhost:${s.port}`, `[::1]:${s.port}`]) expect((await raw(s.port, '/health', { host })).status).toBe(200);
    expect((await raw(s.port, '/data/generations.json', { origin: `http://localhost:${s.port}` })).status).toBe(200);
  });
});

describe('the dashboard server: only what its pages need (R4 H97)', () => {
  it('refuses .env, .timmy/… and every dotfile or dot folder, however the address is written; never their bytes', async () => {
    const root = folder();
    mkdirSync(join(root, 'studio', 'p', '.timmy'), { recursive: true });
    writeFileSync(join(root, 'studio', 'p', '.timmy', 'secret.json'), `{"k":"${SECRET}"}`);
    writeFileSync(join(root, 'studio', '.hidden'), SECRET);
    const s = await serve(root);
    for (const p of ['/.env', '/.timmy/generations.json', '/.timmy/receipts/runs.jsonl', '/.timmy/', '/.git/config', '/%2Eenv', '/%2etimmy/generations.json',
      '/studio/.hidden', '/studio/p/.timmy/secret.json', '/studio/p/%2Etimmy/secret.json', '/data/../.env', '/studio/%2e%2e/.env']) {
      const r = await raw(s.port, p);
      expect({ p, status: r.status, words: r.body.trim() }).toEqual({ p, status: 403, words: DASH_PRIVATE });
      expect(r.body, p).not.toContain(SECRET);
    }
  });

  it('serves nothing else of the folder (its files, its source, a folder\'s listing), and nothing a link inside studio/ leads to outside it', async () => {
    const root = folder();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'h97-dash-outside-')));
    dirs.push(outside);
    writeFileSync(join(outside, 'elsewhere.txt'), SECRET);
    symlinkSync(join(root, '.env'), join(root, 'studio', 'env-link.txt'));
    symlinkSync(join(outside, 'elsewhere.txt'), join(root, 'studio', 'outside-link.txt'));
    symlinkSync(join(root, '.timmy'), join(root, 'studio', 'timmy-link'));
    const s = await serve(root);
    for (const p of ['/package.json', '/ref.png', '/studio', '/studio/', '/studio/p/', '/studio/frames/clip/', '/studio/env-link.txt', '/studio/outside-link.txt', '/studio/timmy-link/generations.json', '/nothing']) {
      const r = await raw(s.port, p);
      expect([403, 404], p).toContain(r.status);
      expect(r.body, p).not.toContain(SECRET);
      expect(r.body, p).not.toContain('a-project');
      expect(r.body, p).not.toContain(root);
    }
    expect((await raw(s.port, '/package.json')).body.trim()).toBe(DASH_NOT_SERVED);
  });

  it('a FIFO in studio/ answers 404 at once (it is never opened as a file to read)', async () => {
    const root = folder();
    const made = spawnSync('mkfifo', [join(root, 'studio', 'pipe.txt')]);
    if (made.status !== 0) { console.warn('dash-server: no mkfifo here, so the FIFO case was not checked'); return; }
    const s = await serve(root);
    const t0 = Date.now();
    expect((await raw(s.port, '/studio/pipe.txt')).status).toBe(404);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('GET and HEAD only; every answer says nosniff and no-store; its pages carry a policy that loads nothing from elsewhere', async () => {
    const s = await serve(folder());
    expect((await raw(s.port, '/studio/dashboard.html', { method: 'POST' })).status).toBe(405);
    expect((await raw(s.port, '/studio/dashboard.html', { method: 'DELETE' })).status).toBe(405);
    const head = await raw(s.port, '/studio/dashboard.html', { method: 'HEAD' });
    expect({ status: head.status, body: head.body }).toEqual({ status: 200, body: '' });
    const page = await raw(s.port, '/studio/dashboard.html');
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(page.headers['cache-control']).toBe('no-store');
    const csp = String(page.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toMatch(/https?:|\*/);
  });

  it('its pages\' own files load: the dashboard, its two records (as the page draws them), the frames, a Slate site and its reference', async () => {
    const root = folder();
    const s = await serve(root);
    const page = await raw(s.port, '/studio/dashboard.html');
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.body).toContain("fetch('/data/generations.json')");
    expect(page.body).not.toContain('/.timmy/');
    expect(page.body).not.toContain(root);
    const gens = JSON.parse((await raw(s.port, '/data/generations.json')).body) as { generations: Array<Record<string, unknown>> };
    expect(gens.generations).toEqual([
      { id: 'gen_a', created_at: '2026-10-11T10:00:00.000Z', provider: 'seedance-2-0', model: 'bytedance/seedance-2.0', status: 'done', prompt: 'a lighthouse at dusk', cost: 0.22, frameCount: 2, frames: '/studio/frames/clip', artifact: 'studio/clip.mp4' },
      // a declared-unknown cost is not known (never $0); frames kept under .timmy/ get no address
      { id: 'gen_b', created_at: '2026-10-11T10:01:00.000Z', provider: 'higgsfield', status: 'done', prompt: 'a placeholder cost', cost: null, frames: null },
    ]);
    const events = (await raw(s.port, '/data/events.jsonl')).body.split('\n');
    expect(events).toHaveLength(25);
    expect(JSON.parse(events.at(-1)!).event).toBe('e39');
    const frame = await raw(s.port, '/studio/frames/clip/frame_0001.png');
    expect({ status: frame.status, type: frame.headers['content-type'] }).toEqual({ status: 200, type: 'image/png' });
    const site = await raw(s.port, '/studio/p/site/index.html');
    expect(site.status).toBe(200);
    const refPath = /<img src="\.\.\/(refs\/[^"]+)"/.exec(site.body)?.[1];
    expect(refPath).toBeTruthy();
    expect((await raw(s.port, `/studio/p/${refPath}`)).status).toBe(200);
    expect((await raw(s.port, '/studio/p/slate.json')).status).toBe(200);
    // the root page says what this is; /health names the folder by a hash only
    expect((await raw(s.port, '/')).body).toContain('/studio/dashboard.html');
    expect(JSON.parse((await raw(s.port, '/health')).body)).toEqual({ ok: true, server: 'timmy-dash', root: dashRootId(root) });
  });

  it('the dashboard draws from the server\'s records only: no folder path in the page, no address under .timmy/', () => {
    const html = renderDashboardHtml('/some/working/folder');
    expect(html).toContain("fetch('/data/generations.json')");
    expect(html).toContain("fetch('/data/events.jsonl')");
    expect(html).not.toContain('/some/working/folder');
    expect(html).not.toMatch(/fetch\('\/\.timmy/);
    expect(html).toContain("'unknown'");
    const empty = mkdtempSync(join(tmpdir(), 'h97-dash-empty-'));
    dirs.push(empty);
    expect(dashGenerations(empty)).toEqual([]);
  });
});

describe('ensureDashServer: the server in this Timmy, and what it says (R4 H97)', () => {
  /** A free port on 127.0.0.1 (taken, then given back). */
  const freePort = async (): Promise<number> => {
    const s = createServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    const port = (s.address() as AddressInfo).port;
    await new Promise<void>((r) => s.close(() => r()));
    return port;
  };

  it('starts once for a folder: starting, then up on 127.0.0.1; asked again, it is up already', async () => {
    const root = folder();
    const port = await freePort();
    const first = ensureDashServer(root, { port });
    expect(first.state).toBe('starting');
    expect(first.words).toBe(`starting on 127.0.0.1:${port}, this computer only`);
    expect(await first.ready).toEqual({ up: true, words: `up on 127.0.0.1:${port}, this computer only: it serves this folder's studio/ and the dashboard's records, nothing else of it` });
    const again = ensureDashServer(root, { port });
    expect(again.state).toBe('up');
    expect((await raw(port, '/.env')).status).toBe(403);
    expect((await raw(port, '/studio/dashboard.html')).status).toBe(200);
  });

  it('the port taken by another program, or by the dashboard server of another folder: not started, and why; of this same folder: served by it', async () => {
    const root = folder();
    const port = await freePort();
    const squatter = createServer((_req, res) => { res.end('not timmy'); });
    others.push(squatter);
    await new Promise<void>((r) => squatter.listen(port, '127.0.0.1', () => r()));
    expect(await ensureDashServer(root, { port }).ready).toEqual({ up: false, words: `not started: 127.0.0.1:${port} is taken by another program (not Timmy's dashboard server), so this folder's pages are not served` });
    await new Promise<void>((r) => squatter.close(() => r()));
    others.splice(0);
    const otherFolder = await startDashServer({ root: folder(), port });
    servers.push(otherFolder);
    expect((await ensureDashServer(root, { port }).ready).words).toMatch(/^not started: 127\.0\.0\.1:\d+ is taken by Timmy's dashboard server of another folder/);
    await otherFolder.close();
    servers.splice(0);
    const same = await startDashServer({ root, port });
    servers.push(same);
    expect(await ensureDashServer(root, { port }).ready).toEqual({ up: true, words: `served by another Timmy on this computer, on 127.0.0.1:${port}, for this same folder (its pages work while that Timmy runs)` });
  });

  it('names an older Timmy\'s Python server that still runs for this folder (FAKE: a process whose command names http.server), with how to stop it; stops nothing', async () => {
    const root = folder();
    const port = await freePort();
    const fake = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'http.server', String(port)], { stdio: 'ignore' });
    children.push(fake);
    writeFileSync(join(root, '.timmy', 'dash.pid'), String(fake.pid));
    const r = await ensureDashServer(root, { port }).ready;
    expect(r.up).toBe(true);
    expect(r.older).toBe(`an older Timmy's dashboard server still runs: Python's http.server (pid ${fake.pid}, named in .timmy/dash.pid), which serves this whole folder, .env and .timmy/ included, to every network address of this computer; stop it with: kill ${fake.pid}`);
    expect(r.words).toContain(r.older!);
    expect(fake.exitCode).toBe(null);
    // a pid file whose process is something else: nothing is said
    writeFileSync(join(root, '.timmy', 'dash.pid'), String(process.pid));
    await stopDashServer();
    expect((await ensureDashServer(root, { port }).ready).older).toBeUndefined();
  });
});

describe('/publish and /panes (the TUI\'s commands) say where the server is, and what it could not do (R4 H97)', () => {
  it('/publish names the server\'s state; the site is then served on 127.0.0.1:4273, this computer only', async () => {
    const root = folder();
    const cwd = process.cwd();
    const busy = (await dashHealth(DASH_PORT)).state !== 'none';
    const said: string[] = [];
    const agent = { emit: (_e: string, m: { content: string }) => { said.push(m.content); }, addBrowserPane: () => undefined };
    process.chdir(root);
    try {
      const out = String(handleSlashCommand('/publish p', agent, {}));
      expect(out).toContain(`published → http://127.0.0.1:${DASH_PORT}/studio/p/site/index.html`);
      expect(out).toContain(`• server: starting on 127.0.0.1:${DASH_PORT}, this computer only`);
      const r = await ensureDashServer(root).ready;
      if (busy) {
        // something else holds 4273 on this computer: what it could not do is said once it has tried
        console.warn('dash-server: port 4273 is in use here, so /publish\'s served page was not checked; its message was');
        expect(r.up).toBe(false);
        await new Promise((z) => setTimeout(z, 50));
        expect(said).toEqual([`⚙️ **[SYSTEM]** dashboard server: ${r.words}`]);
        return;
      }
      expect(r.up).toBe(true);
      expect((await raw(DASH_PORT, '/studio/p/site/index.html')).status).toBe(200);
      expect((await raw(DASH_PORT, '/.env')).status).toBe(403);
      expect(said).toEqual([]);
    } finally { process.chdir(cwd); }
  });

  it('/panes names the dashboard and the server\'s state (no carbonyl here: the addresses are given to open)', async () => {
    const root = folder();
    const cwd = process.cwd();
    const closed = await (async () => { const s = createServer(); await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r())); const p = (s.address() as AddressInfo).port; await new Promise<void>((r) => s.close(() => r())); return p; })();
    const was = process.env.TIMMY_SLATE_URL;
    process.env.TIMMY_SLATE_URL = `http://127.0.0.1:${closed}/`;
    process.chdir(root);
    try {
      const out = String(handleSlashCommand('/panes', { emit: () => undefined }, {}));
      expect(out).toContain(`• dashboard: http://127.0.0.1:${DASH_PORT}/studio/dashboard.html (server starting on 127.0.0.1:${DASH_PORT}, this computer only)`);
      await ensureDashServer(root).ready;
    } finally {
      process.chdir(cwd);
      if (was === undefined) delete process.env.TIMMY_SLATE_URL; else process.env.TIMMY_SLATE_URL = was;
    }
  });
});
