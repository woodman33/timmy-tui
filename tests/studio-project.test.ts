/**
 * Round R4 (H55): the REPL names its active project to Timmy Canvas (POST /api/project/active, with the server's token),
 * and the canvas server answers a read-only project API (GET /api/project) built from the board's readers. Real HTTP on
 * 127.0.0.1, a real temporary project with real record files (tests/helpers/canvas-project.ts), a real jobs folder and a
 * receipts store under os.tmpdir().
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { flowRecord, HOSTILE_INSTRUCTION, HOSTILE_TITLE, makeCanvasProject, type CanvasProject } from './helpers/canvas-project.js';
import { projectTokenFile, readProjectToken, writeProjectToken } from '../src/studio/project-link.js';
import { startStudioServer, type StudioServer } from '../src/studio/server.js';

type Res = { status: number; body: string; json: Record<string, unknown> };

describe('the project handoff and the project API', () => {
  let p: CanvasProject;
  let home = '';
  let server: StudioServer;
  let port = 0;
  /** every body the server sent in this file, checked at the end for paths */
  const bodies: string[] = [];

  const call = (method: string, path: string, o: { headers?: Record<string, string>; body?: string } = {}): Promise<Res> => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers: { ...(o.body !== undefined ? { 'Content-Length': String(Buffer.byteLength(o.body)) } : {}), ...o.headers } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += String(c); });
      res.on('end', () => {
        bodies.push(body);
        let json: Record<string, unknown> = {};
        try { json = JSON.parse(body) as Record<string, unknown>; } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, body, json });
      });
    });
    req.on('error', reject);
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
  const handoff = (body: unknown, headers: Record<string, string> = {}): Promise<Res> => call('POST', '/api/project/active', {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${server.projectToken}`, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const named = () => ({ root: p.root, name: 'demo', jobs: p.jobs, receipts: p.store });

  beforeAll(async () => {
    p = await makeCanvasProject('studio-project-');
    home = mkdtempSync(join(tmpdir(), 'studio-project-home-'));
    server = await startStudioServer(0, { env: { TIMMY_HOME: home }, projectTokenFile: true });
    port = (server.address() as AddressInfo).port;
  }, 60_000);
  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(p.base, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('before any handoff the API says no project is named, and how to name one', async () => {
    const r = await call('GET', '/api/project');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, project: null, cards: [], message: 'Timmy has not named a project to this canvas yet. In Timmy: /canvas open.' });
    expect((await call('GET', '/api/project/active')).json).toMatchObject({ ok: true, app: 'timmy-canvas', project: null, board: false, pageConnected: false });
  });

  it("accepts the REPL's handoff with the server's token, and answers with the project's name and id only", async () => {
    const r = await handoff(named());
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, project: { name: 'demo', id: p.pid }, board: false });
    const active = await call('GET', '/api/project/active');
    expect(active.json).toMatchObject({ project: { name: 'demo', id: p.pid }, board: false, pageConnected: false });
    expect(typeof active.json.since).toBe('string');
  });

  it('refuses a handoff without the token, with another token, from a page, from another host, not as JSON, too large or malformed, and keeps the project named before', async () => {
    const other = 'f'.repeat(64);
    const refusals: Array<[string, Promise<Res>, number]> = [
      ['no token', call('POST', '/api/project/active', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...named(), name: 'evil' }) }), 401],
      ['another token', handoff({ ...named(), name: 'evil' }, { Authorization: `Bearer ${other}` }), 401],
      ['a malformed token', handoff({ ...named(), name: 'evil' }, { Authorization: `Bearer ${server.projectToken.slice(1)}` }), 401],
      // Another site's page: the Host/Origin rule every route has.
      ['another origin', handoff({ ...named(), name: 'evil' }, { Origin: 'http://evil.example' }), 403],
      // A page on this machine (another port, or the canvas page itself): the handoff comes from the REPL, never a page.
      ['a local page', handoff({ ...named(), name: 'evil' }, { Origin: 'http://127.0.0.1:5173' }), 403],
      ['the canvas page', handoff({ ...named(), name: 'evil' }, { Origin: `http://127.0.0.1:${port}` }), 403],
      ['a rebound name', handoff({ ...named(), name: 'evil' }, { Host: `evil.example:${port}` }), 403],
      ['text/plain', handoff(JSON.stringify({ ...named(), name: 'evil' }), { 'Content-Type': 'text/plain' }), 415],
      ['too large', handoff({ ...named(), name: 'evil', jobs: `/${'x'.repeat(5000)}` }), 413],
      ['not JSON', handoff('{"root": '), 400],
      ['an unknown key', handoff({ ...named(), name: 'evil', token: 'x' }), 400],
      ['a relative root', handoff({ ...named(), name: 'evil', root: 'demo' }), 400],
      ['a control character in the name', handoff({ ...named(), name: 'ev\u0007il' }), 400],
      ['a board address with its token', handoff({ ...named(), name: 'evil', board: `http://127.0.0.1:4000/#t=${other}` }), 400],
      ['a board elsewhere', handoff({ ...named(), name: 'evil', board: 'http://evil.example:4000/' }), 400],
    ];
    for (const [what, pending, status] of refusals) {
      const r = await pending;
      expect(r.status, what).toBe(status);
      expect(r.body, what).not.toContain(p.root);
    }
    // A folder that is not one: refused without naming it back.
    const gone = await handoff({ ...named(), name: 'evil', root: join(p.base, 'no-such-folder') });
    expect(gone.status).toBe(404);
    expect(gone.json.error).toBe('The folder named as the project is not a folder on this machine.');
    expect(gone.body).not.toContain('no-such-folder');
    expect((await call('GET', '/api/project/active')).json.project).toEqual({ name: 'demo', id: p.pid });
  });

  it("GET /api/project: the project's cards from the board's own readers, each with its state, record, receipt and command", async () => {
    const r = await call('GET', '/api/project');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, project: { name: 'demo', id: p.pid }, board: null });
    const cards = r.json.cards as Array<Record<string, unknown>>;
    const byId = Object.fromEntries(cards.map((c) => [c.id, c]));
    const receipts = readFileSync(join(p.store, 'runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; hash: string });
    const short = (kind: string): string => receipts.find((x) => x.kind === kind)!.hash.slice(7, 15);
    // A workflow document: its title as written (the page escapes it), its blocks, and the typed /run of its last block.
    expect(byId['workflow:BUILD.md']).toEqual({ id: 'workflow:BUILD.md', kind: 'workflow', title: HOSTILE_TITLE, state: 'not run yet · 2 blocks: build, render', record: 'BUILD.md', receipt: null, command: '/run BUILD.md render', section: 'workflows' });
    // The tray recipe's parameter file, checked by its own rules, with the edit receipt that names it.
    expect(byId['params:recipes/tray.params.json']).toMatchObject({ kind: 'params', record: 'recipes/tray.params.json', receipt: short('edit'), command: '/recipe tray', section: 'parameters' });
    expect(byId['params:recipes/tray.params.json'].state).toMatch(/^saved: width \d+, wall [\d.]+, supportOffset [\d.]+, bore [\d.]+ \(mm\)$/);
    // An OpenSCAD model's parameter file: no receipt names it, so none is claimed.
    expect(byId['params:box.params.json']).toEqual({ id: 'params:box.params.json', kind: 'params', title: 'OpenSCAD parameters of box.scad (box.params.json)', state: 'saved: width 90, depth 40, height 30', record: 'box.params.json', receipt: null, command: '/scad box.scad', section: 'workflows' });
    // A flow record with its verdict, verified against the flow receipt that sealed exactly its bytes.
    expect(byId[`flow:${p.flow}`]).toEqual({
      id: `flow:${p.flow}`, kind: 'flow', title: `/iterate tray · ${p.flow}: ${HOSTILE_INSTRUCTION}`,
      state: `succeeded, readback matches · verified: receipt ${short('flow')} sealed these bytes`, record: p.flowFile, receipt: short('flow'), command: `/room ${p.flow}`, section: 'flows',
    });
    // A record that cannot be read as one is named, with why.
    expect(byId['unreadable:results/flows/f0badbad0.json']).toMatchObject({ kind: 'unreadable', record: 'results/flows/f0badbad0.json', receipt: null, command: '/open results/flows/f0badbad0.json', section: 'flows' });
    expect(byId['unreadable:results/flows/f0badbad0.json'].state).toMatch(/^unreadable: not JSON \(/);
    // A VoxVision record with its highlight, verified against its vox receipt.
    expect(byId[`vox:${p.voxId}`]).toEqual({
      id: `vox:${p.voxId}`, kind: 'vox', title: 'measure part.stl', state: `ok · verified: receipt ${short('vox')} sealed it · 1 highlight shown`,
      record: p.voxFile, receipt: short('vox'), command: '/measure part.stl', section: 'voxvision', highlights: [`results/vox/${p.voxId}/bbox.svg`],
    });
    // The Control Room's runs: the chat turn its receipt names, and the job the real JobManager ran.
    expect(cards.find((c) => c.id === `run:chat:${short('turn')}`)).toMatchObject({ kind: 'run', state: 'answered · 0 tool calls', receipt: short('turn'), command: `/room ${short('turn')}`, section: 'room' });
    const job = cards.find((c) => typeof c.id === 'string' && c.id.startsWith('run:job:'))!;
    expect(job).toMatchObject({ kind: 'run', state: 'completed · echo hello', record: null, section: 'room' });
    expect(job.command).toBe(`/room ${String(job.id).slice('run:job:'.length)}`);
    // Flows are cards of their own, never again as Control Room runs.
    expect(cards.filter((c) => typeof c.id === 'string' && c.id.startsWith('run:flow:'))).toEqual([]);
  });

  it('reads the records as they are now: a record changed after its receipt is not verified, a deleted one is gone, a board address is linked', async () => {
    const file = join(p.root, p.flowFile);
    const before = readFileSync(file, 'utf8');
    try {
      writeFileSync(file, flowRecord(p.flow, 'failed'));
      let cards = (await call('GET', '/api/project')).json.cards as Array<Record<string, unknown>>;
      const changed = cards.find((c) => c.id === `flow:${p.flow}`)!;
      expect(changed.state).toBe('failed, readback differs (as the file says) · not verified: the file changed after it was sealed: its sha256 is not the one its flow receipt sealed');
      expect(changed.receipt).toBeNull();
      unlinkSync(file);
      cards = (await call('GET', '/api/project')).json.cards as Array<Record<string, unknown>>;
      expect(cards.find((c) => c.id === `flow:${p.flow}`)).toBeUndefined();
    } finally {
      writeFileSync(file, before);
    }
    // /board live's address (never its token) is named with the project, and the API links to it.
    expect((await handoff({ ...named(), board: 'http://127.0.0.1:40123/' })).json).toEqual({ ok: true, project: { name: 'demo', id: p.pid }, board: true });
    expect((await call('GET', '/api/project')).json.board).toEqual({ address: 'http://127.0.0.1:40123/' });
    expect((await handoff(named())).json.board).toBe(false);
  });

  it("keeps its token for other REPLs of this Timmy home only when asked (mode 0600, removed on close and when its process ends); a file whose process is gone is not used", async () => {
    const file = projectTokenFile(join(home, 'canvas'), port);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readProjectToken(join(home, 'canvas'), port)).toBe(server.projectToken);
    // A server not asked to keep it (a test's, or a library caller's) writes nothing.
    const quiet = mkdtempSync(join(tmpdir(), 'studio-project-quiet-'));
    const other = await startStudioServer(0, { env: { TIMMY_HOME: quiet } });
    const otherPort = (other.address() as AddressInfo).port;
    expect(readProjectToken(join(quiet, 'canvas'), otherPort)).toBeNull();
    await new Promise<void>((done) => other.close(() => done()));
    rmSync(quiet, { recursive: true, force: true });
    // A process that ends without closing its server (a REPL's exit) takes its token file with it.
    const ending = mkdtempSync(join(tmpdir(), 'studio-project-ending-'));
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', [
      "import { startStudioServer } from './src/studio/server.ts';",
      "import { existsSync } from 'node:fs';",
      `const s = await startStudioServer(0, { env: { TIMMY_HOME: ${JSON.stringify(ending)} }, projectTokenFile: true });`,
      `console.log(existsSync(${JSON.stringify(join(ending, 'canvas'))} + '/project-token-' + s.address().port) ? 'kept' : 'none');`,
      'process.exit(0);',
    ].join('\n')], { encoding: 'utf8', cwd: process.cwd(), env: { ...process.env, NODE_OPTIONS: '' }, timeout: 60_000 });
    expect(child.stdout.trim(), child.stderr).toBe('kept');
    expect(readdirSync(join(ending, 'canvas')).filter((f) => f.startsWith('project-token-'))).toEqual([]);
    rmSync(ending, { recursive: true, force: true });
    // A token left by a process that is gone: never used.
    const stale = mkdtempSync(join(tmpdir(), 'studio-project-stale-'));
    expect(writeProjectToken(stale, 4999, 'a'.repeat(64), 2 ** 22 + 12345)).toBe(true);
    expect(readProjectToken(stale, 4999)).toBeNull();
    expect(writeProjectToken(stale, 4998, 'b'.repeat(64))).toBe(true);
    expect(readProjectToken(stale, 4998)).toBe('b'.repeat(64));
    rmSync(stale, { recursive: true, force: true });
  });

  it('names no absolute path in any answer: the project\'s folder, its real path, the home folder and the temporary folder never appear', () => {
    expect(bodies.length).toBeGreaterThan(20);
    const forbidden = [...new Set([p.root, p.real, p.base, p.jobs, p.store, home, homedir(), tmpdir()])].filter((x) => x.length > 1);
    for (const body of bodies) {
      for (const f of forbidden) expect(body, f).not.toContain(f);
      // Any filesystem path of two parts or more that starts at /.
      const strings = [...body.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
      expect(strings.filter((s) => /(?:^|[\s(=])\/[^\s/]+\/[^\s]*/.test(s) && !/^https?:\/\//.test(s))).toEqual([]);
    }
  });
});
