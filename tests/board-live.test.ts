// Round R3: the live board (/board live) — the board with Stop, Run and Observe, served on 127.0.0.1 by
// the REPL's Workspace. Every request here goes to 127.0.0.1 on the board's own ephemeral port. Workflow
// runs use tests/fixtures/fake-upmd.mjs, a labelled TEST DOUBLE of upmd 0.2.7's --ci protocol (it is not
// upmd). /observe runs the real Workspace method; this test gives it no python3, so its answer is the
// method's own "Look needs a Python with OpenCV" refusal: what is checked is that the board dispatched
// exactly `/observe <file>` through it, not Look itself.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request, type IncomingHttpHeaders } from 'node:http';
import { connect } from 'node:net';
import { homedir, networkInterfaces, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { folderProject } from '../src/project/index.js';
import { ACTION_LIMIT, checkAction, livePage, observeArg, plainText, type LiveState } from '../src/repl/board-live.js';
import { COMMANDS } from '../src/repl/commands.js';
import { Workspace, type WorkspaceDeps } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import type { Receipt, ReceiptInput } from '../src/utils/receipts.js';

const FAKE_UPMD = resolve('tests/fixtures/fake-upmd.mjs');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const XSS = '<img src=x onerror=alert(1)>.png';
const WORKFLOW = [
  '# Build', '',
  '```bash [name:setup]', 'mkdir -p dist', '```', '',
  '```bash [name:wait]', 'sleep 30', '```', '',
].join('\n');

const dirs: string[] = [];
const spaces: Workspace[] = [];
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
const put = (root: string, rel: string, body: string | Buffer): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
const text = (lines: { text: string }[][]): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
const tick = (ms = 80): Promise<void> => new Promise((r) => setTimeout(r, ms));

afterEach(async () => {
  for (const w of spaces.splice(0)) await w.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function project(): string {
  const root = temp('board-live-');
  put(root, 'BUILD.md', WORKFLOW);
  put(root, 'refs/photo.png', PNG);
  put(root, `refs/${XSS}`, PNG);
  put(root, 'refs/notes.txt', 'just text\n');
  return root;
}

/** The OSC 8 link a terminal would get: the page's text must come back without it. */
const osc8 = (t: string, url: string): string => `\x1b]8;;${url}\x1b\\${t}\x1b]8;;\x1b\\`;

function make(root: string, extra: Partial<WorkspaceDeps> = {}) {
  const notes: string[] = [];
  const sealed: ReceiptInput[] = [];
  const opened: string[] = [];
  const ws = new Workspace({
    glyphs: glyphSet(true),
    env: { UPMD_BIN: FAKE_UPMD },
    onPath: () => null,
    notify: (l) => notes.push(l.map((s) => s.text).join('')),
    openWeb: (url) => { opened.push(url); return `Open ${url} in your browser.`; },
    link: osc8,
    seal: (input) => { sealed.push(input); return `id${sealed.length}`; },
    jobsDir: join(temp('jobs-'), 'jobs'),
    chdir: () => {},
    receipts: () => sealed.map((r, i) => ({ ...r, hash: `sha256:${String(i).padStart(8, '0')}rest` })) as unknown as Receipt[],
    ...extra,
  }, folderProject(root));
  spaces.push(ws);
  return { ws, notes, sealed, opened };
}

interface Reply { status: number; headers: IncomingHttpHeaders; body: string }
/** One HTTP request to 127.0.0.1:<port>, with exactly the headers given (Host defaults to the board's own). */
function raw(port: number, o: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer } = {}): Promise<Reply> {
  return new Promise((resolveReply, reject) => {
    const headers = { Host: `127.0.0.1:${port}`, ...(o.headers ?? {}) };
    const req = request({ host: '127.0.0.1', port, method: o.method ?? 'GET', path: o.path ?? '/', headers, setHost: false, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolveReply({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

async function live(ws: Workspace): Promise<{ port: number; token: string; url: string }> {
  const lines = text(await ws.boardLive('live'));
  expect(lines).toContain('Live board');
  const lb = ws.liveBoard!;
  const token = lb.url.split('#t=')[1];
  return { port: lb.port, token, url: lb.url };
}
const auth = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });
const json = (token: string): Record<string, string> => ({ ...auth(token), 'Content-Type': 'application/json' });
async function state(port: number, token: string): Promise<LiveState> {
  const r = await raw(port, { path: '/state', headers: auth(token) });
  expect(r.status).toBe(200);
  return JSON.parse(r.body) as LiveState;
}
const post = (port: number, token: string, body: unknown, headers: Record<string, string> = json(token)): Promise<Reply> =>
  raw(port, { method: 'POST', path: '/action', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

describe('/board live: started, reported, stopped', () => {
  it('serves on 127.0.0.1 at an ephemeral port with a 64-hex token in the fragment; again it reports; /board off closes the port', async () => {
    const root = project();
    const { ws, opened } = make(root);
    const { port, token, url } = await live(ws);
    expect(port).toBeGreaterThan(0);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(url).toBe(`http://127.0.0.1:${port}/#t=${token}`);
    expect(opened).toEqual([url]);
    expect(ws.liveBoard!.host).toBe('127.0.0.1');
    const again = text(await ws.boardLive('live'));
    expect(again).toContain(`http://127.0.0.1:${port}/`);
    expect(again).toContain('running');
    expect(opened).toHaveLength(1);
    expect((await raw(port)).status).toBe(200);
    expect(text(await ws.boardLive('off'))).toContain('stopped');
    expect(ws.liveBoard).toBeUndefined();
    await expect(raw(port)).rejects.toThrow(/ECONNREFUSED/);
    expect(text(await ws.boardLive('off'))).toContain('No live board is running');
  });

  it('never binds 0.0.0.0: a non-loopback address of this machine does not reach it', async () => {
    const { ws } = make(project());
    const { port } = await live(ws);
    expect(ws.liveBoard!.host).toBe('127.0.0.1');
    const outside = Object.values(networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
    if (outside) {
      // A server bound to 0.0.0.0 would answer here; this one must refuse.
      const reached = await new Promise<boolean>((done) => {
        const s = connect({ host: outside, port });
        s.once('connect', () => { s.destroy(); done(true); });
        s.once('error', () => done(false));
        s.setTimeout(2000, () => { s.destroy(); done(false); });
      });
      expect(reached).toBe(false);
    }
  });

  it('stops with the REPL: Workspace.close() closes the port', async () => {
    const { ws } = make(project());
    const { port } = await live(ws);
    await ws.close();
    await expect(raw(port)).rejects.toThrow(/ECONNREFUSED/);
  });

  it('/board alone still writes the read-only snapshot, with no live buttons; the command routes live and off', async () => {
    const root = project();
    const { ws } = make(root);
    expect(text(ws.board(''))).toContain('a read-only snapshot');
    const html = readFileSync(join(root, '.timmy/board/index.html'), 'utf8');
    expect(html).not.toContain('data-act=');
    expect(html).toContain('href="../../refs/photo.png"');
    expect(ws.liveBoard).toBeUndefined();
    const printed: string[] = [];
    const board = COMMANDS.find((c) => c.name === 'board')!;
    const ctx = { print: (s: { text: string }[]) => printed.push(s.map((x) => x.text).join('')), workspace: ws } as unknown as Parameters<typeof board.run>[1];
    await board.run('live', ctx);
    expect(ws.liveBoard).toBeDefined();
    expect(printed.join('\n')).toContain('Live board');
    await board.run('off', ctx);
    expect(ws.liveBoard).toBeUndefined();
  });
});

describe('who may ask', () => {
  it('refuses state and actions without the token, or with a wrong one (401)', async () => {
    const { ws } = make(project());
    const { port, token } = await live(ws);
    const wrong = token.replace(/^./, (c) => (c === 'a' ? 'b' : 'a'));
    for (const headers of [{}, auth(wrong), auth(token.toUpperCase()), { Authorization: token }, { Authorization: `Bearer ${token}x` }, { Authorization: `Basic ${token}` }]) {
      const s = await raw(port, { path: '/state', headers });
      expect(s.status).toBe(401);
      expect(s.headers['www-authenticate']).toBe('Bearer');
      const a = await post(port, '', { action: 'stop', job: 'j1' }, { ...headers, 'Content-Type': 'application/json' });
      expect(a.status).toBe(401);
    }
    expect((await raw(port, { path: '/state', headers: auth(token) })).status).toBe(200);
  });

  it('refuses a Host other than 127.0.0.1:<port> (DNS rebinding), even with the token', async () => {
    const { ws } = make(project());
    const { port, token } = await live(ws);
    for (const Host of ['evil.example', `evil.example:${port}`, `localhost:${port}`, `127.0.0.1:${port + 1}`, '127.0.0.1']) {
      expect((await raw(port, { path: '/state', headers: { Host, ...auth(token) } })).status).toBe(403);
      expect((await raw(port, { path: '/', headers: { Host } })).status).toBe(403);
    }
  });

  it('refuses a foreign Origin, even with the token; its own Origin is accepted; no CORS header is sent', async () => {
    const { ws } = make(project());
    const { port, token } = await live(ws);
    for (const Origin of ['http://evil.example', `http://localhost:${port}`, `https://127.0.0.1:${port}`, 'null']) {
      const r = await post(port, token, { action: 'stop', job: 'nope' }, { ...json(token), Origin });
      expect(r.status).toBe(403);
      expect((await raw(port, { path: '/state', headers: { ...auth(token), Origin } })).status).toBe(403);
    }
    const own = await raw(port, { path: '/state', headers: { ...auth(token), Origin: `http://127.0.0.1:${port}` } });
    expect(own.status).toBe(200);
    expect(Object.keys(own.headers).some((h) => h.startsWith('access-control-'))).toBe(false);
  });

  it('serves its page without the token but with no project data, under a strict nonce CSP and the safety headers', async () => {
    const root = project();
    const { ws } = make(root);
    const { port } = await live(ws);
    const page = await raw(port);
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.headers['cache-control']).toBe('no-store');
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    const csp = String(page.headers['content-security-policy']);
    const nonce = csp.match(/script-src 'nonce-([A-Za-z0-9+/=]+)'/)?.[1];
    expect(nonce).toBeTruthy();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain(`style-src 'nonce-${nonce}'`);
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|https?:|\*/);
    // Every script and style element carries this response's nonce; no inline handlers or style attributes.
    expect([...page.body.matchAll(/<script\b([^>]*)>/g)].every((m) => m[1].includes(`nonce="${nonce}"`))).toBe(true);
    expect([...page.body.matchAll(/<style\b([^>]*)>/g)].every((m) => m[1].includes(`nonce="${nonce}"`))).toBe(true);
    expect(page.body).not.toMatch(/\son[a-z]+=|\sstyle="/);
    // No project data in the shell: not the project's name, files, workflow or folder.
    for (const s of [ws.project.name, 'photo.png', 'BUILD.md', 'onerror', root, homedir()]) expect(page.body).not.toContain(s);
    // The token is read from the fragment and sent only as a header; nothing is stored.
    expect(page.body).toContain("'Bearer ' + token");
    expect(page.body).not.toMatch(/localStorage|sessionStorage|document\.cookie|indexedDB/);
    // A fresh nonce for each response.
    const second = String((await raw(port)).headers['content-security-policy']);
    expect(second).not.toBe(csp);
    // JSON and text answers carry the same headers.
    const st = await raw(port, { path: '/state', headers: auth(ws.liveBoard!.url.split('#t=')[1]) });
    expect(st.headers['cache-control']).toBe('no-store');
    expect(st.headers['x-content-type-options']).toBe('nosniff');
    expect(String(st.headers['content-security-policy'])).toContain("default-src 'none'");
  });
});

describe('the state', () => {
  it("returns the project's files, workflows and jobs, with no absolute path; a file name with HTML is escaped in the sections", async () => {
    const root = project();
    const { ws } = make(root);
    const { port, token } = await live(ws);
    const s = await state(port, token);
    expect(s.project).toBe(ws.project.name);
    expect(s.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ rel: 'refs/photo.png', kind: 'image' }),
      expect.objectContaining({ rel: `refs/${XSS}`, kind: 'image' }),
    ]));
    expect(s.workflows).toEqual([{ rel: 'BUILD.md', blocks: ['setup', 'wait'] }]);
    const whole = JSON.stringify(s);
    for (const p of [root, homedir(), tmpdir()]) expect(whole).not.toContain(p);
    // The sections: escaped, buttons as data, no links or thumbnails (this page serves no files).
    expect(s.html).not.toContain('<img src=x');
    expect(s.html).toContain('&lt;img src=x onerror=alert(1)&gt;.png');
    expect(s.html).toContain('data-act="observe" data-file="refs/&lt;img src=x onerror=alert(1)&gt;.png"');
    expect(s.html).toContain('data-act="run" data-doc="BUILD.md" data-block="wait"');
    expect(s.html).not.toMatch(/<a [^>]*href=|<img /);
    expect(s.html).not.toMatch(/\sstyle="/);
    // The shell never names it.
    expect((await raw(port)).body).not.toContain('onerror');
  });
});

describe('actions, as the typed commands', () => {
  it('runs a workflow block as /run (fake upmd), then stops the running job as /stop, echoed from the board; an unknown job is a clear 404', async () => {
    const root = project();
    const { ws, notes, sealed } = make(root);
    const { port, token } = await live(ws);
    const ran = await post(port, token, { action: 'run', doc: 'BUILD.md', block: 'wait' });
    expect(ran.status).toBe(200);
    expect(ran.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(ran.body.split('\n')[0]).toBe('board /run BUILD.md wait');
    expect(ran.body).not.toMatch(/\x1b/);
    expect(ran.body).not.toContain(root);
    expect(notes).toContain('  board  /run BUILD.md wait');
    // The same path as a typed /run: the prediction is sealed before the run.
    expect(sealed.some((r) => r.kind === 'predict' && r.subject?.includes('BUILD.md › wait'))).toBe(true);
    const job = ws.jobs.list().find((j) => j.label === 'BUILD.md › wait')!;
    expect(job).toBeDefined();
    await tick(200);
    const before = await state(port, token);
    expect(before.jobs.find((j) => j.id === job.id)).toMatchObject({ stoppable: true });
    expect(before.html).toContain(`data-act="stop" data-job="${job.id}"`);

    const unknown = await post(port, token, { action: 'stop', job: 'jnope' });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toBe('No job jnope on this board: /jobs lists them.');

    const stopped = await post(port, token, { action: 'stop', job: job.id });
    expect(stopped.status).toBe(200);
    expect(stopped.body.split('\n')[0]).toBe(`board /stop ${job.id}`);
    expect(stopped.body).toContain(`${job.id} cancelled`);
    expect(notes).toContain(`  board  /stop ${job.id}`);
    expect(ws.jobs.get(job.id)?.state).toBe('cancelled');
    const after = await state(port, token);
    expect(after.jobs.find((j) => j.id === job.id)).toMatchObject({ state: 'cancelled', stoppable: false });
    // A job that is not running is not stopped again.
    const again = await post(port, token, { action: 'stop', job: job.id });
    expect(again.status).toBe(409);
    expect(again.body).toContain('cancelled');
  }, 20_000);

  it('checks run and observe against the state: unknown documents, blocks and files, and non-images, are refused', async () => {
    const { ws, notes } = make(project());
    const { port, token } = await live(ws);
    const cases: Array<[unknown, number, string]> = [
      [{ action: 'run', doc: 'NOPE.md', block: 'wait' }, 404, 'No workflow NOPE.md'],
      [{ action: 'run', doc: 'BUILD.md', block: 'deploy' }, 404, 'No block named deploy in BUILD.md: setup, wait'],
      [{ action: 'run', doc: '../BUILD.md', block: 'wait' }, 404, 'No workflow'],
      [{ action: 'observe', file: 'refs/missing.png' }, 404, 'not an image file on this board'],
      [{ action: 'observe', file: 'refs/notes.txt' }, 404, 'not an image file on this board'],
      [{ action: 'observe', file: '/etc/passwd' }, 404, 'not an image file on this board'],
    ];
    for (const [body, status, says] of cases) {
      const r = await post(port, token, body);
      expect(r.status, JSON.stringify(body)).toBe(status);
      expect(r.body).toContain(says);
    }
    expect(notes.filter((n) => n.includes('board  /'))).toEqual([]);
    expect(ws.jobs.list()).toEqual([]);
  });

  it('dispatches observe as /observe <file> through the Workspace method (no python3 here: its own refusal comes back)', async () => {
    const { ws, notes } = make(project());
    const { port, token } = await live(ws);
    const r = await post(port, token, { action: 'observe', file: 'refs/photo.png' });
    expect(r.status).toBe(200);
    const lines = r.body.split('\n');
    expect(lines[0]).toBe('board /observe refs/photo.png');
    expect(lines.slice(1).join('\n')).toBe(text(await ws.observe('refs/photo.png')));
    expect(r.body).toContain('Look needs a Python with OpenCV');
    expect(notes[0]).toBe('  board  /observe refs/photo.png');
    // A name with HTML is sent as data and dispatched as one argument, as /observe reads it.
    const x = await post(port, token, { action: 'observe', file: `refs/${XSS}` });
    expect(x.status).toBe(200);
    expect(x.body.split('\n')[0]).toBe(`board /observe "refs/${XSS}"`);
  });

  it('refuses malformed JSON, an oversized body, a wrong content type, another method, extra keys and free command text', async () => {
    const { ws, notes } = make(project());
    const { port, token } = await live(ws);
    expect((await post(port, token, '{"action":')).status).toBe(400);
    expect((await post(port, token, 'null')).status).toBe(400);
    expect((await post(port, token, '[]')).status).toBe(400);
    const big = JSON.stringify({ action: 'observe', file: 'a'.repeat(ACTION_LIMIT) });
    expect((await post(port, token, big)).status).toBe(413);
    expect((await post(port, token, { action: 'stop', job: 'j1' }, { ...auth(token), 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await post(port, token, { action: 'stop', job: 'j1' }, { ...auth(token), 'Content-Type': 'application/x-www-form-urlencoded' })).status).toBe(415);
    expect((await post(port, token, { action: 'stop', job: 'j1' }, auth(token))).status).toBe(415);
    expect((await raw(port, { path: '/action', headers: auth(token) })).status).toBe(405);
    expect((await raw(port, { method: 'POST', path: '/state', headers: json(token), body: '{}' })).status).toBe(405);
    expect((await raw(port, { method: 'POST', path: '/', headers: json(token), body: '{}' })).status).toBe(405);
    for (const body of [
      { action: 'run', doc: 'BUILD.md', block: 'wait', cmd: 'rm -rf .' },
      { action: 'shell', cmd: '/run BUILD.md wait' },
      { command: '/stop all' },
      { action: 'stop', job: 'all', extra: 1 },
      { action: 'stop', job: 7 },
      { action: 'observe', file: '' },
    ]) {
      const r = await post(port, token, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    // `/stop all` is not on the board: "all" is no job here.
    expect((await post(port, token, { action: 'stop', job: 'all' })).status).toBe(404);
    expect((await raw(port, { path: '/nope', headers: auth(token) })).status).toBe(404);
    expect(notes.filter((n) => n.includes('board  /'))).toEqual([]);
  });
});

describe('the pieces', () => {
  it('writes an /observe argument that /observe reads back exactly, or refuses', () => {
    expect(observeArg('refs/a.png')).toBe('refs/a.png');
    expect(observeArg('refs/my photo.png')).toBe('"refs/my photo.png"');
    expect(observeArg('refs/say "hi" there.png')).toBe('\'refs/say "hi" there.png\'');
    expect(observeArg('"quoted.png')).toBe('\'"quoted.png\'');
    expect(observeArg('refs/both "a" and \'b\'.png')).toBeNull();
  });

  it('turns lines into plain text: no terminal escapes, no control characters', () => {
    expect(plainText(`  ${osc8('BUILD.md', 'file:///x/BUILD.md')} \x1b[1mdone\x1b[0m\x07`)).toBe('  BUILD.md done');
  });

  it('checks each action against the state it is given', () => {
    const s: LiveState = {
      project: 'p', madeAt: 'now', toc: '', html: '', shape: '',
      jobs: [{ id: 'j1', state: 'running', label: 'x', stoppable: true }, { id: 'j2', state: 'running', label: 'y', stoppable: false }],
      workflows: [{ rel: 'my doc.md', blocks: ['a'] }],
      files: [{ rel: 'a.png', kind: 'image', bytes: 1 }],
    };
    expect(checkAction({ action: 'stop', job: 'j1' }, s)).toEqual({ ok: true, command: { name: 'stop', args: 'j1', line: '/stop j1' } });
    expect(checkAction({ action: 'stop', job: 'j2' }, s)).toMatchObject({ ok: false, status: 409 });
    // /run reads one word for each: a document with a space is refused, not sent mangled.
    expect(checkAction({ action: 'run', doc: 'my doc.md', block: 'a' }, s)).toMatchObject({ ok: false, status: 422 });
    expect(checkAction({ action: 'observe', file: 'a.png' }, s)).toEqual({ ok: true, command: { name: 'observe', args: 'a.png', line: '/observe a.png' } });
  });
});

// The page's script, run in a vm with a small fake DOM (a FAKE: no browser runs here). Its fetch goes to
// the real live board on 127.0.0.1, so the round trip — token header, state, a button's POST — is real.
describe("the page's script (fake DOM, real server)", () => {
  type El = { id?: string; textContent: string; innerHTML: string; className: string; hidden: boolean; disabled?: boolean; querySelectorAll: () => unknown[] };
  const el = (id: string): El => ({ id, textContent: '', innerHTML: '', className: '', hidden: id === 'out', querySelectorAll: () => [] });
  const script = (): string => livePage('n0nce').match(/<script nonce="n0nce">([\s\S]*?)<\/script>/)![1];

  function page(port: number, hash: string) {
    const els: Record<string, El> = Object.fromEntries(['main', 'toc', 'status', 'out', 'project', 'live'].map((id) => [id, el(id)]));
    const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string; credentials?: string }> = [];
    const handlers: Record<string, (e: unknown) => void> = {};
    const replaced: unknown[][] = [];
    let interval: (() => void) | undefined;
    const fetchFake = async (url: string, opts: { method?: string; headers?: Record<string, string>; body?: string; credentials?: string } = {}) => {
      calls.push({ url, method: opts.method ?? 'GET', headers: opts.headers ?? {}, ...(opts.body ? { body: opts.body } : {}), credentials: opts.credentials });
      const r = await raw(port, { method: opts.method ?? 'GET', path: url, headers: opts.headers ?? {}, ...(opts.body ? { body: opts.body } : {}) });
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => JSON.parse(r.body), text: async () => r.body };
    };
    const document = {
      title: '',
      getElementById: (id: string) => els[id],
      addEventListener: (type: string, fn: (e: unknown) => void) => { handlers[type] = fn; },
    };
    runInNewContext(script(), {
      location: { hash, pathname: '/' }, history: { replaceState: (...a: unknown[]) => { replaced.push(a); } },
      document, fetch: fetchFake, setInterval: (fn: () => void) => { interval = fn; return 1; }, setTimeout, navigator: {}, window: {},
    });
    return { els, calls, handlers, replaced, document, poll: () => interval?.() };
  }

  it('reads the token from the fragment, drops it from the address bar, polls state with it as a header, and draws the sections', async () => {
    const { ws } = make(project());
    const { port, token } = await live(ws);
    const p = page(port, `#t=${token}`);
    await tick(150);
    expect(p.replaced).toEqual([[null, '', '/']]);
    expect(p.calls[0]).toMatchObject({ url: '/state', method: 'GET', headers: { Authorization: `Bearer ${token}` }, credentials: 'omit' });
    const s = await state(port, token);
    expect(p.els.main.innerHTML).toBe(s.html);
    expect(p.els.toc.innerHTML).toBe(s.toc);
    expect(p.els.project.textContent).toBe(ws.project.name);
    expect(p.els.status.textContent).toContain('live');
    // R4 (H67): the header's word says live once the state has come
    expect([p.els.live.textContent, p.els.live.className]).toEqual(['live', 'live']);
    expect(p.document.title).toBe(`Live board · ${ws.project.name}`);
  });

  it('sends a button as its structured action, disabled while in flight, and shows the returned text', async () => {
    const { ws, notes } = make(project());
    const { port, token } = await live(ws);
    const p = page(port, `#t=${token}`);
    await tick(150);
    const attrs: Record<string, string> = { 'data-act': 'observe', 'data-file': 'refs/photo.png' };
    const button = { disabled: false, textContent: 'Observe', hidden: false, getAttribute: (k: string) => attrs[k] ?? null, closest: (sel: string) => (sel === 'button[data-act]' ? button : null) };
    p.handlers.click({ target: button });
    expect(button.disabled).toBe(true);
    await tick(250);
    const post = p.calls.find((c) => c.method === 'POST')!;
    expect(post).toMatchObject({ url: '/action', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, credentials: 'omit' });
    expect(JSON.parse(post.body!)).toEqual({ action: 'observe', file: 'refs/photo.png' });
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Observe');
    expect(p.els.out.hidden).toBe(false);
    expect(p.els.out.textContent.split('\n')[0]).toBe('board /observe refs/photo.png');
    expect(notes[0]).toBe('  board  /observe refs/photo.png');
  });

  it('without a token in the fragment asks nothing and says why', async () => {
    const { ws } = make(project());
    const { port } = await live(ws);
    const p = page(port, '');
    await tick(50);
    expect(p.calls).toEqual([]);
    expect(p.els.status.textContent).toContain('No token');
    // R4 (H67, r20): never "live" without a token
    expect([p.els.live.textContent, p.els.live.className]).toEqual(['waiting for the token', 'live not-live']);
  });
});
