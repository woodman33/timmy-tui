/**
 * R4 (H109): an operation's run detail on Timmy Canvas (GET /api/project/run-detail, src/studio/run-detail-route.ts), over real
 * HTTP on 127.0.0.1 against the real canvas server, with the REPL's handoff (POST /api/project/active with the server's token)
 * and a page's one-time grant traded for its session (tests/helpers/canvas-auth.ts, as the page trades it). The run detail is
 * made by src/ops/run-detail.ts (H102), which is not in this revision yet: here a FIXTURE producer, given through the server's
 * options and labelled FIXTURE in every word it makes, stands in for it (the real producer replaces it at merge); the loader is
 * exercised with FIXTURE modules written at run time into a temporary folder. FAKE: no REPL takes card actions here (a holder
 * id is named, nothing asks for actions).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { RUN_DETAIL_VERSION, type RunDetail } from '../src/contracts/run-detail.js';
import { projectId } from '../src/project/index.js';
import { CARDS_REFUSED } from '../src/studio/project-link.js';
import { loadRunDetail, NOT_BUILT, OTHER_PROJECT, UNKNOWN_PROJECT, type RunDetailProducer } from '../src/studio/run-detail-route.js';
import { startStudioServer, type StudioServer } from '../src/studio/server.js';
import { bearer, call, nameProject, pageSession } from './helpers/canvas-auth.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
/** Whether H102's producer is in this revision (then the route asks it, and the FIXTURE-free checks below change). */
const producerHere = existsSync(join(repo, 'src', 'ops', 'run-detail.ts'));
const H = 'a'.repeat(32);
const H2 = 'b'.repeat(32);
const OP = 'oa1b2c3d4';

const made: string[] = [];
const servers: StudioServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise<void>((done) => s.close(() => done()));
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); made.push(d); return d; };

/** FIXTURE: a run detail as src/ops/run-detail.ts makes one, written here by hand; its paths as a producer writes them (absolute). */
function fixtureDetail(op: string, root: string, name: string): RunDetail {
  return {
    version: RUN_DETAIL_VERSION, operation: op, parent: null, children: [],
    project: { name, root, id: projectId(root) },
    objective: { value: 'FIXTURE: make the tray 150 mm wide', from: `.timmy/operations/${op}.json` },
    sourceRevision: null,
    verdict: { state: 'completed', words: 'FIXTURE: the tray was rebuilt and its readback matches', from: 'receipt 1a2b3c4d' },
    stage: { current: 'readback', done: 3, total: 3, from: 'results/flows/fa1b2c3d4.json' },
    exits: [{ who: 'recipe runner', code: 0, state: 'exited', from: 'jobs/j1.json' }, { who: 'upmd', code: 2, from: 'jobs/j2.json' }],
    freshness: { state: 'current', why: `FIXTURE: ${root}/recipes/tray.params.json holds the bytes it was built from`, from: 'results/flows/fa1b2c3d4.json' },
    acceptance: { state: 'not reviewed' },
    worker: { harness: { value: 'FIXTURE harness', from: 'jobs/j1.json' } },
    time: { startedAt: '2026-10-11T10:00:00.000Z', endedAt: '2026-10-11T10:02:05.000Z', elapsedMs: 125_000 },
    prediction: { words: 'FIXTURE: 150 x 80 x 30 mm', receipt: '0f0e0d0c', frozenAt: '2026-10-11T09:59:59.000Z' },
    checks: [{ name: 'bounds', predicted: '150 x 80 x 30 mm', actual: '150 x 80 x 30 mm', differs: false, from: 'receipt 1a2b3c4d' }],
    files: [{ path: `${root}/recipes/tray.params.json`, role: 'input', sha256: 'ab'.repeat(32), from: 'receipt 1a2b3c4d' }],
    receipts: [{ id: '1a2b3c4d', kind: 'flow', subject: 'tray' }],
    cost: { usd: null, measured: false, why: 'FIXTURE: no model was called, so no cost was reported' },
    summary: { path: null },
    next: { words: 'FIXTURE: look at the tray, then accept or reject it', command: `/op ${op}` },
    unknown: [{ field: 'sourceRevision', why: 'FIXTURE: no record names it (one copy was read from /var/tmp/elsewhere/record.json)' }],
  };
}

/**
 * A canvas server and projects to name to it. Its producer: the FIXTURE below (each call recorded), the one given, or (`'none'`)
 * none: the server then looks for src/ops/run-detail.ts, as it does in use.
 */
async function world(given: RunDetailProducer | 'none' | null = null) {
  const home = temp('timmy-rd-home-');
  const asked: Array<{ op: string; project: string }> = [];
  const names = new Map<string, string>();
  const fixture: RunDetailProducer = (op, o) => { asked.push({ op, project: o.project }); return fixtureDetail(op, o.project, names.get(o.project) ?? 'unnamed'); };
  const producer = given === 'none' ? null : given ?? fixture;
  const server = await startStudioServer(0, { env: { TIMMY_HOME: home }, projectTokenFile: true, followActive: false, ...(producer ? { runDetail: producer } : {}) });
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  const project = (name: string) => { const root = join(temp(`timmy-rd-${name}-`), name); mkdirSync(root, { recursive: true }); names.set(root, name); return { name, root, id: projectId(root) }; };
  const get = (op: string, auth: Record<string, string> = {}, o: { project?: string; host?: string } = {}) =>
    call(port, 'GET', `/api/project/run-detail?op=${op}${o.project ? `&project=${o.project}` : ''}`, { headers: { ...auth, ...(o.host ? { Host: o.host } : {}) } });
  return { server, port, token: server.projectToken, asked, project, get };
}

describe("an operation's run detail on Timmy Canvas", () => {
  it("answers the producer's run detail for an operation of the project the canvas shows, to the server's token and to a page whose session counts: every field kept, the project's folder as \".\", no other absolute path", async () => {
    const w = await world();
    const alpha = w.project('alpha');
    await nameProject(w.port, w.token, { root: alpha.root, name: 'alpha', holder: H });
    const s = await pageSession(w.port, w.token);
    for (const auth of [bearer(w.token), bearer(s)]) {
      const r = await w.get(OP, auth);
      expect(r.status).toBe(200);
      expect(r.headers['cache-control']).toBe('no-store');
      const d = r.json.detail as RunDetail;
      expect(r.json.ok).toBe(true);
      expect(d).toMatchObject({
        version: RUN_DETAIL_VERSION, operation: OP, project: { name: 'alpha', root: '.', id: alpha.id },
        verdict: { state: 'completed', words: 'FIXTURE: the tray was rebuilt and its readback matches', from: 'receipt 1a2b3c4d' },
        stage: { current: 'readback', done: 3, total: 3 },
        exits: [{ who: 'recipe runner', code: 0, state: 'exited' }, { who: 'upmd', code: 2 }],
        acceptance: { state: 'not reviewed' },
        cost: { usd: null, measured: false, why: 'FIXTURE: no model was called, so no cost was reported' },
        time: { elapsedMs: 125_000 },
      });
      // the project's folder as ".", any other absolute path as <path>: no folder of this machine leaves the server
      expect(d.files[0].path).toBe('./recipes/tray.params.json');
      expect(d.freshness.why).toBe('FIXTURE: ./recipes/tray.params.json holds the bytes it was built from');
      expect(d.unknown[0].why).toBe('FIXTURE: no record names it (one copy was read from <path>)');
      expect(r.body).not.toContain(alpha.root);
      expect(r.body).not.toContain(tmpdir());
    }
    // the producer was asked for this operation of this project, once per answer
    expect(w.asked).toEqual([{ op: OP, project: alpha.root }, { op: OP, project: alpha.root }]);
  });

  it('is refused without a credential, to a session given for another project, from another host, and for an id that is not an operation\'s; the producer is never asked', async () => {
    const w = await world();
    const alpha = w.project('alpha');
    const beta = w.project('beta');
    await nameProject(w.port, w.token, { root: alpha.root, name: 'alpha', holder: H });
    const s = await pageSession(w.port, w.token);
    const none = await w.get(OP);
    expect(none.status).toBe(401);
    expect(none.json).toMatchObject({ ok: false, error: CARDS_REFUSED, session: 'none' });
    expect(none.json.other).toBeUndefined();
    expect((await w.get(OP, bearer('f'.repeat(64)))).json).toMatchObject({ session: 'unknown' });
    for (const bad of ['o123', 'OA1B2C3D4', 'oa1b2c3d4x', '', '..%2Fx']) {
      const r = await w.get(bad, bearer(w.token));
      expect(r.status).toBe(400);
      expect(r.json.error).toBe("op is an operation's id: o and 8 hex digits.");
    }
    expect((await w.get(OP, bearer(w.token), { project: 'ALPHA' })).status).toBe(400);
    expect((await w.get(OP, bearer(w.token), { host: `timmy.example:${w.port}` })).status).toBe(403);
    // another REPL (another holder) names beta: the page's session (given for alpha by H) does not count for it
    await nameProject(w.port, w.token, { root: beta.root, name: 'beta', holder: H2 });
    const other = await w.get(OP, bearer(s));
    expect(other.status).toBe(401);
    expect(other.json.session).toBe('project');
    expect(String(other.json.error)).toMatch(/^Refused: this canvas page's session was given for another project than the one the canvas shows now\./);
    expect(other.json.other).toBeUndefined();
    expect(w.asked).toEqual([]);
  });

  it("reads a card's own project when it is not the one shown (a board pinned to it): while the page's session reaches it, read only; refused in its own words when it never did; unknown when this server does not know it", async () => {
    const w = await world();
    const alpha = w.project('alpha');
    const beta = w.project('beta');
    const gamma = w.project('gamma');
    await nameProject(w.port, w.token, { root: alpha.root, name: 'alpha', holder: H });
    const s = await pageSession(w.port, w.token);
    // the same REPL names beta: its page follows; a board pinned to alpha still reads alpha's operations
    await nameProject(w.port, w.token, { root: beta.root, name: 'beta', holder: H });
    const pinned = await w.get(OP, bearer(s), { project: alpha.id });
    expect(pinned.status).toBe(200);
    expect(pinned.json.detail).toMatchObject({ operation: OP, project: { name: 'alpha', root: '.', id: alpha.id } });
    const shown = await w.get(OP, bearer(s), { project: beta.id });
    expect(shown.json.detail).toMatchObject({ project: { name: 'beta', id: beta.id } });
    expect((await w.get(OP, bearer(s))).json.detail).toMatchObject({ project: { name: 'beta' } });
    expect(w.asked.map((a) => a.project)).toEqual([alpha.root, beta.root, beta.root]);
    // another REPL names gamma and opens a page: that page never counted for alpha, so it does not read alpha's run details
    await nameProject(w.port, w.token, { root: gamma.root, name: 'gamma', holder: H2 });
    const s2 = await pageSession(w.port, w.token);
    const never = await w.get(OP, bearer(s2), { project: alpha.id });
    expect(never.status).toBe(401);
    expect(never.json).toMatchObject({ ok: false, error: OTHER_PROJECT(OP), session: 'project', other: true });
    expect(OTHER_PROJECT(OP)).toBe(`Refused: operation ${OP} is of a project this canvas page was never opened for (nor followed to), so it does not read its run detail. In Timmy, in that project: /op ${OP}.`);
    // the first page still reads alpha (pinned): its refusal elsewhere changed nothing for it
    expect((await w.get(OP, bearer(s), { project: alpha.id })).status).toBe(200);
    // a project this server never named
    const unknown = await w.get(OP, bearer(w.token), { project: 'f'.repeat(16) });
    expect(unknown.status).toBe(404);
    expect(unknown.json).toMatchObject({ ok: false, error: UNKNOWN_PROJECT(OP), other: true, command: `/op ${OP}` });
    expect(w.asked).toHaveLength(4);
  });

  it("shows no answer that is not this operation's run detail of this version and project (502, saying why), and says a producer's failure in words with no path (500); each gives /op", async () => {
    const producer: RunDetailProducer = (op, o) => {
      const d = fixtureDetail(op, o.project, 'alpha');
      if (op === 'o00000001') return { ...d, operation: 'o00000002' };
      if (op === 'o00000003') return { ...d, version: 2 as never };
      if (op === 'o00000004') return { ...d, project: { ...d.project, id: 'e'.repeat(16) } };
      if (op === 'o00000005') return { ...d, exits: 'none' as never };
      if (op === 'o00000006') throw new Error(`FIXTURE: could not read ${o.project}/results/flows/x.json nor /var/tmp/elsewhere/y.json`);
      if (op === 'o00000007') return { ...d, verdict: undefined as never };
      return d;
    };
    const w = await world(producer);
    const alpha = w.project('alpha');
    await nameProject(w.port, w.token, { root: alpha.root, name: 'alpha', holder: H });
    const said = async (op: string) => { const r = await w.get(op, bearer(w.token)); expect(r.body).not.toContain(alpha.root); return { status: r.status, error: r.json.error, command: r.json.command }; };
    expect(await said('o00000001')).toEqual({ status: 502, error: 'The run detail of o00000001 is not shown: it answered for operation o00000002, not o00000001.', command: '/op o00000001' });
    expect(await said('o00000003')).toEqual({ status: 502, error: 'The run detail of o00000003 is not shown: it answered a run detail of version 2, not 1.', command: '/op o00000003' });
    expect(await said('o00000004')).toEqual({ status: 502, error: 'The run detail of o00000004 is not shown: it answered for another project than alpha.', command: '/op o00000004' });
    expect(await said('o00000005')).toEqual({ status: 502, error: 'The run detail of o00000005 is not shown: its exits is not a list.', command: '/op o00000005' });
    expect(await said('o00000006')).toEqual({ status: 500, error: 'The run detail of o00000006 could not be made: FIXTURE: could not read ./results/flows/x.json nor <path>', command: '/op o00000006' });
    expect(await said('o00000007')).toEqual({ status: 502, error: 'The run detail of o00000007 is not shown: it left out a field every run detail has.', command: '/op o00000007' });
    expect((await w.get('o00000008', bearer(w.token))).status).toBe(200);
  });

  it('loads the producer by name, in a real Node process (as Timmy runs): a module exporting runDetail is used; one exporting none, or failing to load, says so; one that is not there is "not built yet" (FIXTURE modules written here at run time)', () => {
    const dir = temp('timmy-rd-modules-');
    const write = (name: string, text: string) => { const f = join(dir, name); writeFileSync(f, text); return pathToFileURL(f).href; };
    const specs = {
      good: write('good.mjs', 'export const runDetail = (op, o) => ({ fixture: "FIXTURE", op, project: o.project });\n'),
      none: write('none.mjs', 'export const somethingElse = 1;\n'),
      broken: write('broken.mjs', 'throw new Error("FIXTURE: this module fails as it loads");\n'),
      missing: pathToFileURL(join(dir, 'missing.mjs')).href,
    };
    // the loader runs in a Node process of its own (the test runner does not import modules from a temporary folder)
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', [
      "import { loadRunDetail } from './src/studio/run-detail-route.ts';",
      `const specs = ${JSON.stringify(specs)};`,
      'const out = {};',
      'for (const [k, s] of Object.entries(specs)) { const l = await loadRunDetail(s); out[k] = l.producer ? { ran: await l.producer("oa1b2c3d4", { project: "." }) } : { why: l.why }; }',
      'const d = await loadRunDetail();',
      'out.default = d.producer ? { found: true } : { why: d.why };',
      'console.log(JSON.stringify(out));',
    ].join('\n')], { encoding: 'utf8', cwd: repo, env: { ...process.env, NODE_OPTIONS: '' }, timeout: 60_000 });
    expect(child.status, child.stderr).toBe(0);
    const out = JSON.parse(child.stdout.trim()) as Record<string, { ran?: unknown; why?: string | null; found?: boolean }>;
    expect(out.good).toEqual({ ran: { fixture: 'FIXTURE', op: OP, project: '.' } });
    expect(out.none).toEqual({ why: 'none.mjs exports no runDetail' });
    expect(out.broken.why).toMatch(/^broken\.mjs did not load: FIXTURE: this module fails as it loads$/);
    expect(out.missing).toEqual({ why: null });
    // src/ops/run-detail.ts beside it: there once H102's producer is merged, not before
    expect(out.default).toEqual(producerHere ? { found: true } : { why: null });
  });

  it.skipIf(producerHere)('in this revision (no src/ops/run-detail.ts yet), a server given no producer says the run detail is not built yet, and the command that shows the operation today (501)', async () => {
    expect(await loadRunDetail()).toEqual({ producer: null, why: null });
    const w = await world('none');
    const alpha = w.project('alpha');
    await nameProject(w.port, w.token, { root: alpha.root, name: 'alpha', holder: H });
    const r = await w.get(OP, bearer(await pageSession(w.port, w.token)));
    expect(r.status).toBe(501);
    expect(r.json).toEqual({ ok: false, built: false, error: NOT_BUILT(OP), command: `/op ${OP}` });
    expect(NOT_BUILT(OP)).toBe(`The run detail is not built in this revision yet (src/ops/run-detail.ts, round R4). In Timmy, /op ${OP} shows the operation's card.`);
    // no project named: said so, before any producer is looked for
    const w2 = await world('none');
    const unnamed = await w2.get(OP, bearer(w2.token));
    expect(unnamed.status).toBe(409);
    expect(unnamed.json.error).toBe('No project is named to this canvas: in Timmy, /canvas open.');
  });

  it.runIf(producerHere)("with H102's producer merged (src/ops/run-detail.ts), a server given no producer asks it: never \"not built\"", async () => {
    const loaded = await loadRunDetail();
    expect(loaded.producer).toBeTypeOf('function');
    const w = await world('none');
    const alpha = w.project('alpha');
    await nameProject(w.port, w.token, { root: alpha.root, name: 'alpha', holder: H });
    const r = await w.get(OP, bearer(w.token));
    expect(r.status).not.toBe(501);
    if (r.status === 200) expect(r.json.detail).toMatchObject({ operation: OP, project: { root: '.', id: alpha.id } });
  });
});
