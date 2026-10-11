/**
 * Round R4 (H76): the plan's one status ladder per tool (docs/ui-cockpit/COMMAND-CENTER-PLAN.md, "Rules every feature
 * follows" 1; AGENTS.md §8) on every /tools row: proposed, installed, reachable, exercised, qualified, each rung with its
 * own evidence, never one inferred from a lower one or from a configured value; and the operator's Mac demonstrations
 * beside it, a separate fact that never raises a rung.
 *
 * REAL pieces: executables on a temporary PATH (installed); local HTTP servers on 127.0.0.1, one answering, one that never
 * answers, one answering 500, and a closed port (reachable or not); a receipts chain sealed with appendReceipt in a
 * temporary project (hash-chained, signed with an ed25519 key made there), read back through liveDeps' own readers
 * (exercised; a record with no receipt, and a chain changed after sealing: not); a real child process for `timmy tools`;
 * the ledger and the plan of this repository (the demonstrations' and the proposals' citations).
 *
 * FAKE pieces, each labelled: the programs are shell scripts that only say FAKE (found by the checks, never run here); the
 * runs behind the sealed receipts were not run (their records are written as the runs write them, their words made up);
 * the qualified answer is a FAKE model's, sealed on the real chain; the repository qualification record is FAKE, in a
 * temporary folder. No model or other network service is contacted: no model key reaches OpenRouter's check.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { capabilities, type CapabilityRow, type ProbeDeps } from '../src/capabilities/index.js';
import { DEMONSTRATIONS, LEDGER } from '../src/capabilities/demonstrations.js';
import { checkQualificationRecord, QUALIFICATION_RECORDS } from '../src/capabilities/evidence.js';
import { RUNGS } from '../src/capabilities/ladder.js';
import { liveDeps } from '../src/capabilities/live.js';
import { PROPOSED } from '../src/capabilities/plans.js';
import { capabilityDetailLines, capabilityJson, capabilityLines } from '../src/capabilities/render.js';
import { scrubRows, type RoomView } from '../src/room/index.js';
import { kit } from '../src/repl/board-kit.js';
import { toolsPanel } from '../src/repl/board-room.js';
import { glyphSet } from '../src/term/glyphs.js';
import { appendReceipt, type Receipt, type ReceiptInput } from '../src/utils/receipts.js';
import { LATER_LAYERS } from '../src/vox/layers.js';

const ROOT = resolve('.');
const dirs: string[] = [];
const servers: Server[] = [];
const temp = (prefix: string): string => { const d = realpathSync(mkdtempSync(join(tmpdir(), prefix))); dirs.push(d); return d; };
afterEach(async () => {
  for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>((r) => s.close(() => r())); }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const byId = (rows: CapabilityRow[]): Record<string, CapabilityRow> => Object.fromEntries(rows.map((r) => [r.id, r]));
const put = (root: string, rel: string, body: string): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
const sha = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');
const lineText = (l: { text: string }[]): string => l.map((s) => s.text).join('');

/** A program the checks can find: a FAKE shell script (these tests never run it). */
function program(dir: string, name: string, mode = 0o755): string {
  const f = join(dir, name);
  writeFileSync(f, '#!/bin/sh\necho "FAKE: found by the ladder tests, never run"\nexit 1\n');
  chmodSync(f, mode);
  return f;
}

/** A port nothing listens on: one the system gave a server that was then closed. */
async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** A local HTTP server on 127.0.0.1; `answer` decides each response by its path ('hang': it never answers). */
async function server(answer: (path: string) => number | 'hang'): Promise<number> {
  const s = createServer((req, res) => {
    const a = answer(req.url ?? '');
    if (a === 'hang') return;
    res.writeHead(a, { 'content-type': 'application/json' });
    res.end('{}');
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  return (s.address() as AddressInfo).port;
}

/**
 * The live checks of a temporary machine (liveDeps, as /tools uses them): its own PATH, HOME, project and receipts store,
 * Timmy Canvas asked on a closed port. No model key is passed, so OpenRouter's check never contacts anything.
 */
async function machine(o: { path: string; env?: Record<string, string>; root?: string }): Promise<{ deps: ProbeDeps; root: string; env: Record<string, string> }> {
  const env = { PATH: o.path, HOME: temp('ladder-home-'), TIMMY_STUDIO_URL: `http://127.0.0.1:${await closedPort()}`, ...o.env };
  const root = o.root ?? temp('ladder-project-');
  return { deps: liveDeps({ env, model: 'fake/chat-model (FAKE)', storeDir: root, projectRoot: root }), root, env };
}

/** A receipt sealed on the project's real chain (appendReceipt: hash-chained and signed there). */
const seal = (root: string, input: Partial<ReceiptInput> & { kind: string }): Receipt =>
  appendReceipt('runs', { subject: `${input.kind} · the ladder tests`, policy: 'human-gated', status: 'ok', project: 'ladder', ...input } as ReceiptInput, root);

/** A native run's record as the native runner writes it (job.json and its verdicts), its words made up: a FAKE run. */
function nativeRecord(root: string, run: string, outcome: 'ok' | 'failed'): void {
  put(root, `.timmy/native/${run}/job.json`, JSON.stringify({ record: 'timmy-native-run', v: 1, app: 'openscad', run, program: 'openscad', label: 'FAKE run', project: 'ladder', started_at: '2026-10-10T09:00:00.000Z', expect: [] }));
  put(root, `.timmy/native/${run}/verdicts.jsonl`, `${JSON.stringify({ judged_at: '2026-10-10T09:01:00.000Z', outcome, why: 'FAKE: written by the test', exit: { code: 0, signal: null }, files: [] })}\n`);
}

/** No machine at all: every check answers "nothing here" (the deps other /tools tests use). */
const none: ProbeDeps = {
  env: {}, onPath: () => false, canvasBuilt: () => false, studio: async () => ({ state: 'not-running' }), studioBase: 'http://127.0.0.1:4337',
  ollama: async () => ({ ok: false, models: [] }), openrouter: async () => 'no-key', modelKeySource: () => null, model: 'm', http: async () => null,
  lanes: () => [], adapters: () => [], receipts: () => ({ ok: true, count: 0 }), exercised: () => new Map(), edgeSet: () => false, exists: () => false,
};

describe('installed: found here, with where and how (temporary executables)', () => {
  it('an executable on the PATH is installed, with its file and "the PATH"; one that is not executable is not; neither is reachable', async () => {
    const bin = temp('ladder-bin-');
    const oha = program(bin, 'oha');
    program(bin, 'agent-browser', 0o644);
    const r = byId(await capabilities((await machine({ path: bin })).deps));
    expect(r.stress).toMatchObject({ rung: 'installed', ladder: { proposed: null, installed: { found: 'oha is on PATH (asks first)', where: oha, how: 'the PATH (oha)' }, reachable: null, exercised: null, qualified: null } });
    expect(r.stress.notReached).toEqual({
      proposed: 'past this rung: Timmy has code that runs it',
      reachable: 'no probe asked: this check runs no program and contacts nothing for it',
      exercised: 'no run of its own here judged ok and sealed on a chain that verifies',
      qualified: 'no qualification record',
    });
    // Present, but not a program: not found, so not installed; its step is shown.
    expect(r.browser).toMatchObject({ rung: 'needs setup', setup: 'brew install agent-browser, then agent-browser install', ladder: { installed: null } });
    expect(r.browser.notReached!.installed).toBe('not found here: agent-browser is not on PATH');
  });
});

describe('reachable: only a probe that answered (local HTTP servers on 127.0.0.1)', () => {
  it('TaskForge\'s health route answering 200 is reachable: what was asked, when, the answer; its address is never shown', async () => {
    const asked: string[] = [];
    const port = await server((p) => { asked.push(p); return p === '/api/runtime/health' ? 200 : 404; });
    const before = new Date().toISOString();
    const r = byId(await capabilities((await machine({ path: temp('ladder-bin-'), env: { TASKFORGE_API_URL: `http://127.0.0.1:${port}/api` } })).deps));
    const after = new Date().toISOString();
    expect(asked).toEqual(['/api/runtime/health']);
    expect(r.taskforge).toMatchObject({
      rung: 'reachable', detail: 'its health check answered',
      ladder: { installed: { how: 'TASKFORGE_API_URL, set in the environment (an address is not an answer)' }, reachable: { asked: 'GET TASKFORGE_API_URL/runtime/health', answer: 'HTTP 200' } },
    });
    const at = r.taskforge.ladder!.reachable!.at;
    expect(at >= before && at <= after, at).toBe(true);
    expect(JSON.stringify(r.taskforge)).not.toContain(String(port));
  });

  it('a route that never answers, one that answers 500, and an address where nothing listens: installed, not reachable, each saying why', async () => {
    const cases: Array<[string, string, RegExp]> = [
      ['hangs', `http://127.0.0.1:${await server(() => 'hang')}/api`, /^asked GET TASKFORGE_API_URL\/runtime\/health at .* UTC: no answer came \(refused, or none within its time\)$/],
      ['500', `http://127.0.0.1:${await server(() => 500)}/api`, /^asked GET TASKFORGE_API_URL\/runtime\/health at .* UTC: HTTP 500, not a healthy answer$/],
      ['closed', `http://127.0.0.1:${await closedPort()}/api`, /: no answer came \(refused, or none within its time\)$/],
    ];
    for (const [label, url, why] of cases) {
      const r = byId(await capabilities((await machine({ path: temp('ladder-bin-'), env: { TASKFORGE_API_URL: url } })).deps));
      expect(r.taskforge, label).toMatchObject({ rung: 'installed', ladder: { installed: { how: expect.stringContaining('an address is not an answer') }, reachable: null } });
      expect(r.taskforge.notReached!.reachable, label).toMatch(why);
    }
  });
});

describe('exercised: Timmy\'s own run here, judged and sealed on a chain that verifies (a REAL chain)', () => {
  it('a turn, a native run, an agent run and a VoxVision action, each sealed: exercised, with its receipt and its record; never qualified', async () => {
    const bin = temp('ladder-bin-');
    for (const p of ['oha', 'openscad', 'qwen']) program(bin, p);
    const root = temp('ladder-project-');
    const run = '0a1b2c3d-0000-4000-8000-000000000001';
    nativeRecord(root, run, 'ok');
    const turn = seal(root, { kind: 'turn', tool_outcomes: [{ name: 'stress_test_endpoint', outcome: 'completed' }], outcome_rule: 2 });
    const native = seal(root, { kind: 'native', native: { app: 'openscad', outcome: 'ok', why: 'FAKE: a run made up for this test', exit_code: 0, signal: null, files: [], run } });
    const agent = seal(root, {
      kind: 'agent', job: { id: 'j0a0001', kind: 'task', label: 'agent qwen (FAKE)', state: 'completed' },
      agent: { name: 'qwen', run: 'a0000a001', version: '0.22.2', model: 'qwen3:4b', endpoint: 'local', outcome: 'completed', why: 'FAKE', tool_calls: 1, added: 0, changed: 1, deleted: [], cost_basis: 'local endpoint' },
    });
    const vox = seal(root, {
      kind: 'vox', outputs: [{ path: '.timmy/vox/v0000001.json', sha256: 'f'.repeat(64), bytes: 10 }],
      sources: [{ vox: 'v0000001', schema: 'timmy.vox/1', action: 'inspect', status: 'ok', tools: [{ tool: 'stl', ran: 'in-process', name: 'Timmy\'s STL reader', version: '1' }] }],
    });
    // An MCP call answered through MCPorter's route, and one through the SDK route that failed (it does not count).
    const mcp = seal(root, { kind: 'mcp.call', outputs: [{ path: '.timmy/mcp/m0000001/call.json', sha256: 'e'.repeat(64), bytes: 10 }], sources: [{ mcp_call: 'm0000001', server: 'fake-server', route: 'mcporter', transport: 'stdio', tool: 'echo', outcome: 'answered', called: true, isError: false }] });
    seal(root, { kind: 'mcp.call', status: 'failed', sources: [{ mcp_call: 'm0000002', server: 'fake-server', route: 'sdk', transport: 'stdio', tool: 'echo', outcome: 'failed', called: true, isError: null }] });
    // A typed /observe whose Look measurements were sealed ok.
    const look = seal(root, { kind: 'observe', outputs: [{ path: 'results/observations/one.json', sha256: 'd'.repeat(64), bytes: 10 }], observation: { tiers: ['deterministic computation'], worker: 'timmy-look 1.0 (FAKE)', measurements: 3 } });
    program(bin, 'python3');
    const r = byId(await capabilities((await machine({ path: bin, root })).deps));
    expect(r['mcp-cli:mcporter']).toMatchObject({ rung: 'exercised', ladder: { exercised: { receipt: mcp.hash.slice(7, 15), record: '.timmy/mcp/m0000001/call.json', what: 'an MCP call answered through the mcporter route' } } });
    expect(r['mcp-cli:sdk'].ladder!.exercised).toBeNull();
    // Its version only as its own package says it.
    const said = (JSON.parse(readFileSync(join(ROOT, 'node_modules/mcporter/package.json'), 'utf8')) as { version: string }).version;
    expect(r['mcp-cli:mcporter'].ladder!.installed).toMatchObject({ version: said, versionFrom: 'its package.json' });
    expect(r['mcp-cli']).toMatchObject({ rung: 'exercised', ladder: { exercised: { receipt: mcp.hash.slice(7, 15) } } });
    expect(r.look).toMatchObject({ rung: 'exercised', ladder: { exercised: { receipt: look.hash.slice(7, 15), record: 'results/observations/one.json', what: 'an /observe run: timmy-look 1.0 (FAKE) measured the image, and its observation was sealed ok' } } });
    const short = (x: Receipt): string => x.hash.slice(7, 15);
    expect(r.stress).toMatchObject({ rung: 'exercised', exercised: turn.ts, ladder: { exercised: { at: turn.ts, receipt: short(turn), hash: turn.hash, what: 'stress_test_endpoint completed in a sealed turn (outcome rule 2: the tool\'s own answer decided)' } } });
    expect(r.stress.ladder!.exercised!.chain).toBe('on the runs chain, which verifies here (its links and body hashes), with its own signature');
    expect(r.openscad).toMatchObject({ rung: 'exercised', exercised: native.ts, ladder: { exercised: { receipt: short(native), record: `.timmy/native/${run}/job.json`, what: 'a openscad run judged ok from its own result file' } } });
    expect(r['qwen-code']).toMatchObject({ rung: 'exercised', ladder: { exercised: { receipt: short(agent), record: '.timmy/agents/a0000a001/result.json', what: 'a completed run of qwen (version 0.22.2 as it reported, model qwen3:4b, a local endpoint)' } } });
    expect(r['vox:stl']).toMatchObject({ rung: 'exercised', ladder: { exercised: { receipt: short(vox), record: '.timmy/vox/v0000001.json', what: '/inspect: stl ran (Timmy\'s STL reader 1, as it reported) and its record settled ok' } } });
    // The paid Codex row is not Qwen Code's; a development run qualifies nothing.
    expect(r.codex.ladder!.exercised).toBeNull();
    for (const id of ['stress', 'openscad', 'qwen-code', 'vox:stl']) expect(r[id].ladder!.qualified, id).toBeNull();
  });

  it('not exercised: a record judged ok with no receipt, a run judged failed, a /vox view launch; and a chain changed after sealing vouches for nothing', async () => {
    const bin = temp('ladder-bin-');
    for (const p of ['oha', 'openscad']) program(bin, p);
    const root = temp('ladder-project-');
    nativeRecord(root, '0a1b2c3d-0000-4000-8000-000000000002', 'ok');
    seal(root, { kind: 'native', status: 'failed', native: { app: 'openscad', outcome: 'failed', why: 'FAKE: judged failed', exit_code: 1, signal: null, files: [], run: '0a1b2c3d-0000-4000-8000-000000000003' } });
    seal(root, { kind: 'vox', subject: 'vox · view · v0000002 · rerun · started', sources: [{ vox: 'v0000002', schema: 'timmy.vox/1', event: 'view', viewer: 'rerun', detached: true }] });
    const turn = seal(root, { kind: 'turn', tool_outcomes: [{ name: 'stress_test_endpoint', outcome: 'completed' }], outcome_rule: 2 });
    let r = byId(await capabilities((await machine({ path: bin, root })).deps));
    expect(r.openscad).toMatchObject({ rung: 'installed', ladder: { exercised: null }, notReached: { exercised: 'no run of its own here judged ok and sealed on a chain that verifies' } });
    expect(r.openscad.exercised).toBeUndefined();
    expect(r['vox:rerun'].ladder!.exercised).toBeNull();
    expect(r.stress).toMatchObject({ rung: 'exercised', exercised: turn.ts });
    // One sealed receipt's words changed in the file: the chain no longer verifies, and no run on it counts.
    const file = join(root, '.timmy', 'receipts', 'runs.jsonl');
    writeFileSync(file, readFileSync(file, 'utf8').replace('FAKE: judged failed', 'FAKE: judged ok after all'));
    r = byId(await capabilities((await machine({ path: bin, root })).deps));
    expect(r.stress).toMatchObject({ rung: 'installed', ladder: { exercised: null } });
    expect(r.stress.exercised).toBeUndefined();
    expect(r.stress.notReached!.exercised).toMatch(/^the receipts chain does not verify here, so no run of it counts \(body hash mismatch \(receipt rc_\w+ was tampered with\)\)$/);
    expect(r.receipts.detail).toMatch(/^chain BROKEN: /);
  });

  it('a tool that is not here now reads "needs setup", whatever ran before: the earlier run stays in its ladder', async () => {
    const root = temp('ladder-project-');
    const turn = seal(root, { kind: 'turn', tool_outcomes: [{ name: 'stress_test_endpoint', outcome: 'completed' }], outcome_rule: 2 });
    const r = byId(await capabilities((await machine({ path: temp('ladder-bin-'), root })).deps));
    expect(r.stress).toMatchObject({ rung: 'needs setup', setup: 'brew install oha', exercised: turn.ts, ladder: { installed: null, exercised: { receipt: turn.hash.slice(7, 15) } } });
  });
});

describe('qualified: a formal qualification record only', () => {
  const observe = (path: string, qualified: Record<string, unknown>, status: 'ok' | 'failed' = 'ok'): Partial<ReceiptInput> & { kind: string } => ({
    kind: 'observe', status, outputs: [{ path, sha256: 'a'.repeat(64), bytes: 10 }],
    observation: { tiers: ['deterministic computation', 'model interpretation'], worker: 'timmy-look FAKE', measurements: 2, qualified: { cites: [], ...qualified } as never },
  });

  it('an admitted /observe --qualify answer (a FAKE model, sealed on the real chain) qualifies that model through OpenRouter, for that protocol only', async () => {
    const root = temp('ladder-project-');
    const key = { OPENROUTER_API_KEY: 'FAKE-not-a-key (OpenRouter is never contacted by these tests)' };
    seal(root, observe('results/observations/one.json', { status: 'refused', model: 'fake/vision-model (FAKE)', refusal: 'unknown_handle' }));
    seal(root, observe('results/observations/two.json', { status: 'admitted', model: 'fake/vision-model (FAKE)' }, 'failed'));
    let r = byId(await capabilities((await machine({ path: temp('ladder-bin-'), root, env: key })).deps));
    expect(r.openrouter).toMatchObject({ rung: 'installed', detail: 'key set; not contacted', ladder: { reachable: null, exercised: null, qualified: null } });
    expect(r.openrouter.notReached!.reachable).toBe('not asked: this check could not read the key itself (/tools in the REPL asks with the key it uses)');
    const admitted = seal(root, observe('results/observations/three.json', { status: 'admitted', model: 'fake/vision-model (FAKE)', run_id: 'run-1', cites: ['h-0001', 'h-0002'] }));
    r = byId(await capabilities((await machine({ path: temp('ladder-bin-'), root, env: key })).deps));
    expect(r.openrouter).toMatchObject({
      rung: 'qualified',
      ladder: {
        reachable: null,
        exercised: { receipt: admitted.hash.slice(7, 15), record: 'results/observations/three.json' },
        qualified: {
          what: 'fake/vision-model (FAKE): an answer admitted under the observed-handle + cite (AGENTS.md §4) protocol (/observe --qualify), citing 2 observed handles',
          scope: 'that model, for that protocol, on that image; not the chat model, any other model or any other task',
          record: 'results/observations/three.json', receipt: admitted.hash.slice(7, 15), at: admitted.ts,
        },
      },
    });
    const table = capabilityLines([r.openrouter], glyphSet(true), 120).map(lineText);
    expect(table.some((l) => l.startsWith('      qualified: fake/vision-model (FAKE): an answer admitted under the observed-handle + cite') && l.length <= 119), table.join('\n')).toBe(true);
  });

  it('a repository qualification record (FAKE) qualifies its row only while every source its seal names is unchanged; none is none', async () => {
    const repo = temp('ladder-repo-');
    put(repo, 'lanes/recipes/tray.ts', 'FAKE source\n');
    put(repo, 'docs/orders/spatial-t5k1/evidence.json', JSON.stringify({ schema: 'timmy.spatial-t5k1.acceptance/1', state: 'passed', note: 'FAKE: made up by the ladder tests' }));
    put(repo, 'docs/orders/spatial-t5k1/seal.json', JSON.stringify({ schema: 'timmy.public-seal-reference/1', id: 'rc_fake_0001', hash: `sha256_${'c'.repeat(64)}`, note: 'FAKE', sources: [{ path: 'lanes/recipes/tray.ts', sha256: sha('FAKE source\n') }] }));
    const python = program(temp('ladder-bin-'), 'python-with-cadquery');
    const { deps } = await machine({ path: temp('ladder-bin-'), env: { TIMMY_CADQUERY_PYTHON: python } });
    const row = async (root: string): Promise<CapabilityRow> => (await capabilities({ ...deps, qualificationRoot: () => root })).find((x) => x.id === 'recipe-tray')!;
    expect(await row(repo)).toMatchObject({
      rung: 'qualified',
      ladder: { exercised: null, qualified: { record: 'docs/orders/spatial-t5k1/evidence.json', receipt: 'rc_fake_0001', what: expect.stringContaining('the tray recipe\'s native acceptance'), scope: expect.stringContaining('not a later revision') } },
    });
    put(repo, 'lanes/recipes/tray.ts', 'FAKE source, changed after the seal\n');
    const stale = await row(repo);
    expect(stale).toMatchObject({ rung: 'installed', ladder: { qualified: null } });
    expect(stale.notReached!.qualified).toBe('the qualification record docs/orders/spatial-t5k1/evidence.json (seal rc_fake_0001, passed) covers earlier sources: 1 of 1 have changed since (lanes/recipes/tray.ts), so it does not qualify this revision');
    expect((await row(temp('ladder-empty-'))).notReached!.qualified).toBe('no qualification record: docs/orders/spatial-t5k1/evidence.json is not here');
  });

  it('the record kept in this repository is read as it is: it qualifies only when every source its seal names is unchanged here', () => {
    const rec = QUALIFICATION_RECORDS.find((q) => q.row === 'recipe-tray')!;
    const seal = JSON.parse(readFileSync(join(ROOT, rec.seal), 'utf8')) as { id: string; sources: Array<{ path: string; sha256: string }> };
    const changed = seal.sources.filter((s) => !existsSync(join(ROOT, s.path)) || sha(readFileSync(join(ROOT, s.path))) !== s.sha256).map((s) => s.path);
    const got = checkQualificationRecord(rec, ROOT);
    if (changed.length) expect(got).toEqual({ ok: false, why: expect.stringContaining(`(seal ${seal.id}, passed) covers earlier sources: ${changed.length} of ${seal.sources.length} have changed since`) });
    else expect(got).toMatchObject({ ok: true, evidence: { receipt: seal.id } });
  });
});

describe('the Mac\'s demonstrations: a separate fact, from the ledger', () => {
  it('every entry stands in its ledger row: the run, its revision, its words; PASS and FAIL as the row says', async () => {
    const ledger = readFileSync(join(ROOT, LEDGER), 'utf8').split('\n');
    const ids = new Set((await capabilities(none, { all: true })).map((r) => r.id));
    for (const d of DEMONSTRATIONS) {
      const row = ledger.find((l) => l.startsWith(`| ${d.row} | ${d.run}:`));
      expect(row, `${d.tool}: ledger row ${d.row} is ${d.run}`).toBeDefined();
      expect(row!, d.tool).toContain(`\`${d.revision}\``);
      expect(row!, d.tool).toMatch(/scripted/);
      for (const c of d.cites) expect(row!, `${d.tool}, row ${d.row}: ${c}`).toContain(c);
      // A FAIL rests on the row's own words for it; a PASS on none of them.
      expect(d.cites.some((c) => /\bfailed\b|\bnot demonstrated\b|\bagain\b/i.test(c)), `${d.tool} ${d.run} ${d.result}`).toBe(d.result === 'FAIL');
      expect(d.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(ids.has(d.tool), `${d.tool} is a /tools row`).toBe(true);
    }
    // The failed ones stay listed as failed.
    expect(DEMONSTRATIONS.filter((d) => d.result === 'FAIL').map((d) => `${d.tool} ${d.run}`)).toEqual(['openhands r19o', 'openhands r20', 'unreal r21', 'openhands r21']);
  });

  it('never raises a rung: OpenSCAD, PASS on the Mac, stays where its own evidence here puts it, and says both', async () => {
    const r = byId(await capabilities(none));
    expect(r.openscad.demonstrated!.map((d) => `${d.run} ${d.result} row ${d.row}`)).toEqual(['r21 PASS row 163']);
    expect(r.openscad).toMatchObject({ rung: 'needs setup', ladder: { installed: null, exercised: null, qualified: null } });
    expect(r.openhands.demonstrated!.map((d) => `${d.run} ${d.result}`)).toEqual(['r21 PASS', 'r21 FAIL', 'r20 FAIL', 'r19o FAIL']);
    const lines = capabilityLines([r.openscad, r.openhands], glyphSet(true), 80).map(lineText);
    expect(lines).toContain('      on the Mac (scripted): r21 PASS');
    expect(lines).toContain('      on the Mac (scripted): r21 PASS, FAIL · r20 FAIL · r19o FAIL');
    // A row with none says nothing of the Mac in the table.
    expect(capabilityLines([r.browser], glyphSet(true), 80).map(lineText).some((l) => l.includes('on the Mac ('))).toBe(false);
  });
});

describe('proposed: a plan in this repository names it, and no code here runs it', () => {
  it('each proposal\'s words stand in its plan\'s section; VoxVision has no layer for it, and the registry\'s adapter script is not in this repository', async () => {
    for (const [id, p] of Object.entries(PROPOSED)) {
      const text = readFileSync(join(ROOT, p.plan), 'utf8');
      const [heading, item] = p.section.split(': ');
      const at = text.indexOf(`\n## ${heading}\n`);
      expect(at, `${id}: ## ${heading}`).toBeGreaterThanOrEqual(0);
      const next = text.indexOf('\n## ', at + 1);
      const paragraph = text.slice(at, next < 0 ? undefined : next).split('\n\n').find((x) => x.includes(`**${item}.**`));
      // The plan wraps its lines; its words are compared with the line breaks as spaces.
      expect(paragraph?.replace(/\s+/g, ' '), `${id}: ${item}`).toContain(p.says);
    }
    expect(LATER_LAYERS.map((l) => `vox:${l.tool}`)).toEqual(Object.keys(PROPOSED));
    expect(existsSync(join(ROOT, 'tools/platform-vision-20260910/analytics/adapter.py'))).toBe(false);
    const r = byId(await capabilities(none));
    for (const id of Object.keys(PROPOSED)) {
      expect(r[id], id).toMatchObject({ rung: 'proposed', ladder: { proposed: { plan: 'docs/ui-cockpit/COMMAND-CENTER-PLAN.md' }, installed: null } });
      expect(r[id].setup, id).toBeUndefined();
      expect(r[id].notReached!.installed, id).toMatch(/^not looked for: VoxVision has no (Viser|FiftyOne) layer/);
    }
  });
});

describe('showing it: --json, /tools <name>, and `timmy tools` in a real child process', () => {
  it('--json: every row has the same keys: its rung, a ladder with the five rungs (null when not reached, else why), notReached and demonstrated', async () => {
    const json = capabilityJson(await capabilities(none, { all: true }), new Date('2026-10-10T12:00:00Z'));
    expect(json).toMatchObject({ checkedAt: '2026-10-10T12:00:00.000Z', ladder: ['proposed', 'installed', 'reachable', 'exercised', 'qualified'], demonstrated: { ledger: 'docs/ui-cockpit/CHECKPOINTS.md' } });
    for (const r of json.rows as Array<CapabilityRow & { ladder: Record<string, unknown> }>) {
      expect(Object.keys(r.ladder), r.id).toEqual([...RUNGS]);
      for (const rung of RUNGS) expect(r.ladder[rung] === null ? typeof r.notReached![rung] : 'evidence', `${r.id} ${rung}`).toBe(r.ladder[rung] === null ? 'string' : 'evidence');
      expect(Array.isArray(r.demonstrated), r.id).toBe(true);
      expect(['proposed', 'needs setup', 'installed', 'reachable', 'exercised', 'qualified'], r.id).toContain(r.rung);
    }
  });

  it('/tools <name>: one row in full, each rung with its evidence or why not, its demonstrations with their ledger rows, within the width', async () => {
    const rows = await capabilities(none, { all: true });
    const lines = capabilityDetailLines(rows, 'openhands', glyphSet(true), 80).map(lineText);
    for (const l of lines) expect(l.length, l).toBeLessThanOrEqual(80);
    expect(lines[0]).toBe('  OpenHands, local model  id openhands · OTHER AGENTS');
    expect(lines[1]).toBe('  rung         needs setup (Timmy has the code; do the step)');
    for (const rung of RUNGS) expect(lines.some((l) => l.startsWith(`  ${rung.padEnd(13)}`)), rung).toBe(true);
    const words = lines.map((l) => l.slice(15).trim()).join(' ');
    expect(words).toContain('FAIL r19o (ledger row 159, 2026-10-10, c8a0cf7, scripted): four runs, each ended at the agent\'s first tool call (D1): no completed run');
    expect(words).toContain('PASS r21 (ledger row 163, 2026-10-10, aae9e82, scripted, part O): the stop order');
    expect(words).toContain('a recorded, scripted run of Timmy on the operator\'s Mac, in the ledger; it never raises a rung here');
    expect(lines).toContain('  qualified    not reached: no qualification record');
    expect(lines).toContain('  proposed     past this rung: Timmy has code that runs it');
    // By name too; several matches are listed; none says so.
    expect(capabilityDetailLines(rows, 'Viser', glyphSet(true), 80).map(lineText)[0]).toMatch(/^ {2}Viser {2}id vox:viser/);
    expect(capabilityDetailLines(rows, 'readback', glyphSet(true), 80).map(lineText)).toEqual([
      '  3 rows match "readback"; /tools <id> shows one:',
      '    vox:step  STEP readback (OCP)  needs setup', '    vox:blend  .blend readback (Blender)  needs setup', '    vox:video  Video readback (ffmpeg)  needs setup',
    ]);
    expect(capabilityDetailLines(rows, 'no such tool', glyphSet(true), 80).map(lineText)[0]).toMatch(/^ {2}No \/tools row is named "no such tool"/);
  });

  it('`timmy tools <name> --json` as a real child process: exit 0 with that row and its ladder; a name no row has exits 1', async () => {
    const bin = temp('ladder-bin-');
    const oha = program(bin, 'oha');
    const env = { PATH: bin, HOME: temp('ladder-home-'), TIMMY_STORE: join(temp('ladder-store-'), 'receipts'), TIMMY_STUDIO_URL: `http://127.0.0.1:${await closedPort()}` };
    const run = (...a: string[]) => spawnSync(process.execPath, ['--import', 'tsx', join(ROOT, 'src/cli.ts'), 'tools', ...a], { cwd: ROOT, env, encoding: 'utf8', timeout: 90_000 });
    const one = run('stress', '--json');
    expect(one.status, one.stderr).toBe(0);
    const json = JSON.parse(one.stdout) as { ladder: string[]; rows: CapabilityRow[] };
    expect(json.ladder).toEqual([...RUNGS]);
    expect(json.rows.map((r) => r.id)).toEqual(['stress']);
    expect(json.rows[0]).toMatchObject({ rung: 'installed', ladder: { installed: { where: oha, how: 'the PATH (oha)' }, reachable: null, exercised: null, qualified: null }, demonstrated: [] });
    const missing = run('no-such-tool', '--json');
    expect(missing.status).toBe(1);
    expect((JSON.parse(missing.stdout) as { rows: unknown[] }).rows).toEqual([]);
  }, 120_000);
});

describe('the Control Room\'s tools panel', () => {
  it('draws each row\'s rung, its Mac demonstrations and its folded ladder, with the folders scrubbed from the evidence', async () => {
    const bin = temp('ladder-bin-');
    program(bin, 'openscad');
    const root = temp('ladder-project-');
    const native = seal(root, { kind: 'native', native: { app: 'openscad', outcome: 'ok', why: 'FAKE', exit_code: 0, signal: null, files: [], run: '0a1b2c3d-0000-4000-8000-000000000004' } });
    const rows = (await capabilities((await machine({ path: bin, root })).deps)).filter((r) => ['openscad', 'openhands', 'vox:viser'].includes(r.id));
    const scrubbed = scrubRows(rows, (t) => t.split(bin).join('<bin>'));
    expect(JSON.stringify(scrubbed)).not.toContain(bin);
    const html = toolsPanel({ tools: { checkedAt: '2026-10-10T12:00:00.000Z', rows: scrubbed } } as unknown as RoomView, kit({ live: false, base: '../../' }));
    expect(html).toContain('<li class="tl" data-tool="openscad"><div class="tl-head"><span class="tl-name">OpenSCAD (command line)</span> <span class="rung rung-exercised">exercised</span></div>');
    expect(html).toContain(`used ${native.ts.slice(0, 10)} (a run&#39;s own sealed record)`);
    expect(html).toContain('<div class="tl-mac">on the Mac (scripted): r21 PASS</div>');
    expect(html).toContain('<details class="more tl-ladder" data-keep="room:tool:openscad"><summary>the ladder and the Mac runs</summary>');
    expect(html).toContain(`<dt class="lr-on">exercised</dt><dd class="lr-on">a openscad run judged ok from its own result file · ${native.ts.slice(0, 16).replace('T', ' ')} UTC · receipt ${native.hash.slice(7, 15)}`);
    expect(html).toContain('<dt class="lr-off">qualified</dt><dd class="lr-off">not reached: no qualification record</dd>');
    expect(html).toContain('<dt class="lr-on">installed</dt><dd class="lr-on">openscad on PATH at &lt;bin&gt;/openscad');
    expect(html).toContain('<span class="demo demo-fail">FAIL</span> r19o (ledger row 159, 2026-10-10, c8a0cf7, scripted)');
    expect(html).toContain('<span class="rung rung-proposed">proposed</span>');
    expect(html).toContain('proposed in docs/ui-cockpit/COMMAND-CENTER-PLAN.md (The orders, in order: F-6 The vision observatory)');
    expect(html).toContain('&quot;On the Mac&quot; is a recorded, scripted run of Timmy on the operator&#39;s Mac, in the ledger; it never raises a rung here (docs/ui-cockpit/CHECKPOINTS.md).');
    expect(html).not.toMatch(/style=/);
  });
});
