/**
 * Round R4 (H48): the Control Room (src/room, src/repl/board-room.ts, /room). Every record here is FAKE: agent runs,
 * native runs, MCP calls, flow records (tests/fixtures/fake-flow-records.ts), job records and receipts written by hand in
 * the shapes Timmy writes them. No agent, model, app or server ran for any of them; every id, hash, model, cost and
 * number is made up, and every task, instruction and label says FAKE.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CapabilityRow } from '../src/capabilities/index.js';
import type { JobRecord } from '../src/jobs/index.js';
import { projectId } from '../src/project/index.js';
import { checkAction, type LiveState } from '../src/repl/board-live.js';
import { kit } from '../src/repl/board-kit.js';
import { roomSection, ROOM_CSS } from '../src/repl/board-room.js';
import type { BoardObservation } from '../src/repl/board.js';
import {
  costsLine, elapsedWords, findRun, flowHandoff, flowOutputs, gatherRoom, needsSetup, receiptCosts, ROOM_KINDS, routeWords, scrubRows, setupCounts, shortReceipt, sumCosts, toolGroups,
  type RoomContext, type RoomRun,
} from '../src/room/index.js';
import { roomItemLines, roomLines } from '../src/room/text.js';
import { glyphSet } from '../src/term/glyphs.js';
import type { Receipt } from '../src/utils/receipts.js';
import { fakeAe, fakeBlender, fakeFreecad, fakeScad, fakeTray, fakeTrayFailed, fakeTrayRunningState } from './fixtures/fake-flow-records.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const temp = (prefix: string): string => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
const put = (root: string, rel: string, body: string): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
const json = (root: string, rel: string, v: unknown): string => { const body = `${JSON.stringify(v, null, 2)}\n`; put(root, rel, body); return createHash('sha256').update(body).digest('hex'); };
const lines = (l: { text: string }[][]): string => l.map((s) => s.map((x) => x.text).join('')).join('\n');
const EVIL = '<img src=x onerror=alert(1)>';
const NOW = Date.parse('2026-10-10T10:00:00.000Z');
const glyphs = glyphSet(true);

/** A FAKE receipt in the runs chain's shape; its hash is made up (sha256_ and 64 hex characters, as appendReceipt writes). */
let serial = 0;
function receipt(pid: string, o: Partial<Receipt> & { kind: string }): Receipt {
  serial += 1;
  const hash = `sha256_${createHash('sha256').update(`FAKE receipt ${serial} ${o.kind}`).digest('hex')}`;
  return { v: 1, id: `rc_${serial}`, stream: 'runs', ts: '2026-10-10T09:30:00.000Z', subject: `FAKE ${o.kind}`, policy: 'human-gated', project: 'fake-room', project_id: pid, prev_hash: 'genesis', hash, ...o } as Receipt;
}

/** A FAKE job record (no process ran). */
function job(root: string, id: string, o: Partial<JobRecord> = {}): JobRecord {
  return {
    id, kind: 'task', label: `FAKE ${id}`, project: 'fake-room', root, command: '/usr/bin/true', args: [], state: 'completed',
    startedAt: '2026-10-10T09:00:00.000Z', endedAt: '2026-10-10T09:00:05.000Z', steps: [], logPath: join(root, '..', 'jobs-outside', `${id}.log`), lines: 0, ...o,
  };
}

/** A FAKE agent run record, as sealAgent writes result.json (or /agent's start writes run.json). */
const agentRun = (run: string, o: Record<string, unknown>) => ({
  agent_run: 1, run, agent: 'qwen', agent_version: '0.0.0-fake (a FAKE code agent)', model: 'fake-model', endpoint: 'local', where: '127.0.0.1:11434',
  task: 'FAKE: a task', job: 'j000000', started_at: '2026-10-10T09:00:00.000Z', ...o,
});

/**
 * A FAKE project with a run of every kind the Control Room reads, and the FAKE receipts that seal some of them.
 * Returns the context gatherRoom takes.
 */
function fakeProject(o: { activeFlows?: string[]; mine?: string[] } = {}) {
  const root = temp('room-');
  const pid = projectId(root);
  const chain: Receipt[] = [];
  // Code agents: a local run (free), a Claude run (a reported cost), a remote run with no reported cost, a running one.
  json(root, '.timmy/agents/a0000a001/result.json', agentRun('a0000a001', {
    job: 'j0a0001', ended_at: '2026-10-10T09:01:00.000Z', outcome: 'completed', why: 'it exited 0 and reported success',
    files: { added: [{ path: 'notes/new.txt', size: 4, sha256: 'a'.repeat(64) }], changed: [{ path: 'recipes/tray.params.json', size: 9, sha256: 'b'.repeat(64) }], deleted: [], truncated: false },
    final_message: { file: 'final-message.md', chars: 20, truncated: false }, transcript: 'transcript.log', cost_usd: 0, cost_basis: 'local endpoint',
  }));
  json(root, '.timmy/agents/a0000a002/result.json', agentRun('a0000a002', {
    agent: 'claude', agent_version: '0.0.0-fake', model: 'fake-claude', endpoint: 'remote', where: 'your Claude account', job: 'j0a0002',
    started_at: '2026-10-10T09:10:00.000Z', ended_at: '2026-10-10T09:12:00.000Z', outcome: 'completed', cost_usd: 0.0123, cost_basis: 'reported by the agent',
  }));
  json(root, '.timmy/agents/a0000a003/result.json', agentRun('a0000a003', {
    endpoint: 'remote', where: 'example.invalid:443', job: 'j0a0003', started_at: '2026-10-10T09:20:00.000Z', ended_at: '2026-10-10T09:20:30.000Z',
    outcome: 'failed', why: 'it exited 1', cost_usd: null, cost_basis: 'unknown: the agent reported no cost',
  }));
  json(root, '.timmy/agents/a0000a004/run.json', { ...agentRun('a0000a004', { job: 'j0a0004', started_at: '2026-10-10T09:55:00.000Z', task: 'FAKE: SLEEP' }), state: 'submitted' });
  // Its progress: a line with an escape sequence, the project folder and markup in it.
  put(root, '.timmy/agents/a0000a004/progress.log', `started  model fake-model\nsays  \x1b[31mred\x1b[0m FAKE ${EVIL} in ${root}/src/a.txt\n`);
  const agentA1 = receipt(pid, { kind: 'agent', cost_usd: 0, agent: { name: 'qwen', run: 'a0000a001', endpoint: 'local', outcome: 'completed', why: 'FAKE', tool_calls: 1, added: 1, changed: 1, deleted: [], cost_basis: 'local endpoint' } });
  const agentA2 = receipt(pid, { kind: 'agent', cost_usd: 0.0123, agent: { name: 'claude', run: 'a0000a002', endpoint: 'remote', outcome: 'completed', why: 'FAKE', tool_calls: 3, added: 0, changed: 0, deleted: [], cost_basis: 'reported by the agent' } });
  const agentA3 = receipt(pid, { kind: 'agent', cost_measured: false, agent: { name: 'qwen', run: 'a0000a003', endpoint: 'remote', outcome: 'failed', why: 'FAKE', tool_calls: 0, added: 0, changed: 0, deleted: [], cost_basis: 'unknown: the agent reported no cost' } });
  chain.push(agentA1, agentA2, agentA3);
  // A flow record (sealed by a FAKE flow receipt that restates its agent step's cost) and a flow that runs (its state file).
  const tray = fakeTray({ agent: { ...fakeTray().agent as object, run: 'a0000a001', job: 'j0a0001' } });
  const traySha = json(root, 'results/flows/f0000a001.json', tray);
  chain.push(receipt(pid, { kind: 'flow', cost_usd: 0, child_receipts: [shortReceipt(agentA1), 'rcpt-build-0a01'], outputs: [{ path: 'results/flows/f0000a001.json', sha256: traySha, bytes: 1 }] }));
  json(root, '.timmy/flows/f0000f001/state.json', fakeTrayRunningState());
  // A native run: Blender, judged ok by its result file (FAKE: nothing ran).
  const nativeRun = '4d5e6f70-0000-4000-8000-00000000aaaa';
  json(root, `.timmy/native/${nativeRun}/job.json`, {
    record: 'timmy-native-run', v: 1, app: 'blender', run: nativeRun, program: 'blender', label: 'FAKE Blender · scene.py', project: 'fake-room', args: [], expect: ['out/scene.blend'], pre: {},
    started_at: '2026-10-10T09:40:00.000Z', timeout_ms: 1000,
  });
  json(root, `.timmy/native/${nativeRun}/started.json`, { job: 'j0b0001', started_at: '2026-10-10T09:40:00.000Z' });
  put(root, `.timmy/native/${nativeRun}/verdicts.jsonl`, `${JSON.stringify({ judged_at: '2026-10-10T09:41:00.000Z', job: 'j0b0001', outcome: 'ok', why: 'FAKE: its result file says ok', exit: { state: 'completed', code: 0, signal: null }, files: [{ path: 'out/scene.blend', present: true, written: true }] })}\n`);
  chain.push(receipt(pid, { kind: 'native', job: { id: 'j0b0001', kind: 'task', label: 'FAKE', state: 'completed' }, native: { app: 'blender', outcome: 'ok', why: 'FAKE', exit_code: 0, signal: null, files: [], run: nativeRun, blender_version: 'Blender 0.0 (FAKE)' } }));
  // An MCP call, its server name hostile (it is the server's own text).
  const callSha = json(root, '.timmy/mcp/m00000001/call.json', {
    schema: 'timmy.mcp-call/1', id: 'm00000001', server: `fake-${EVIL}`, route: 'sdk', transport: 'stdio', tool: 'echo', arguments: {}, started_at: '2026-10-10T09:45:00.000Z', ended_at: '2026-10-10T09:45:01.000Z', ms: 812,
    outcome: 'answered', called: true, isError: false, output_file: null, output_bytes: 0, output_sha256: null, truncated: false, annotations: null,
  });
  chain.push(receipt(pid, { kind: 'mcp.call', outputs: [{ path: '.timmy/mcp/m00000001/call.json', sha256: callSha, bytes: 1 }] }));
  // Look: one observation whose model's cost was reported, one whose model reported none.
  chain.push(receipt(pid, { kind: 'observe', ts: '2026-10-10T09:50:00.000Z', cost_usd: 0.0021, model_requested: 'fake/vision', job: { id: 'j0c0001', kind: 'task', label: 'look refs/photo.png', state: 'completed', ms: 1500 },
    files: [{ path: 'refs/photo.png' }], outputs: [{ path: 'results/observations/photo.json', sha256: 'c'.repeat(64), bytes: 1 }],
    observation: { tiers: ['deterministic computation', 'model interpretation'], worker: 'look 0.0.0-fake', interpretation: { status: 'answered', model: 'fake/vision', cost_usd: 0.0021 } } }));
  chain.push(receipt(pid, { kind: 'observe', ts: '2026-10-10T09:51:00.000Z', cost_measured: false, job: { id: 'j0c0002', kind: 'task', label: 'look refs/photo.png', state: 'completed' },
    files: [{ path: 'refs/photo.png' }], outputs: [{ path: 'results/observations/photo-2.json', sha256: 'd'.repeat(64), bytes: 1 }],
    observation: { tiers: ['deterministic computation'], qualified: { status: 'refused', model: 'fake/vision', cost_usd: null } } }));
  // Chat turns: one with a measured cost (read twice, as a chain read could), one cancelled with a lower bound.
  const turn = receipt(pid, { kind: 'turn', ts: '2026-10-10T09:05:00.000Z', status: 'ok', model_requested: `fake/chat-${EVIL}`, cost_usd: 0.0042, cost_measured: true, ms: 4000,
    tool_outcomes: [{ name: 'read_project_file', outcome: 'completed' }], files: [{ path: 'notes.md', sha256: 'e'.repeat(64), created: true }] });
  chain.push(turn, turn);
  chain.push(receipt(pid, { kind: 'turn', ts: '2026-10-10T09:06:00.000Z', status: 'cancelled', cancelled_at: 'during-tool', model_requested: 'fake/chat', cost_usd: 0.001, cost_measured: false, ms: 900 }));
  // Another project's receipt: never counted here.
  chain.push(receipt('another-project', { kind: 'turn', status: 'ok', cost_usd: 9, cost_measured: true }));
  const jobs: JobRecord[] = [
    job(root, 'j0a0004', { label: 'agent qwen a0000a004: FAKE: SLEEP', state: 'running', startedAt: '2026-10-10T09:55:00.000Z', endedAt: undefined }),
    job(root, 'j0a0001', { label: 'agent qwen a0000a001: FAKE' }),
    job(root, 'j0b0001', { label: 'FAKE Blender · scene.py' }),
    job(root, 'j0c0003', { label: 'look refs/photo.png', state: 'running', startedAt: '2026-10-10T09:58:00.000Z', endedAt: undefined }),
    job(root, 'j0d0001', { kind: 'workflow', label: `BUILD.md › ${EVIL}`, command: '/somewhere/outside/bin/upmd', state: 'completed', receipt: 'rcptwf01',
      steps: [{ name: 'setup', state: 'completed', code: 0 }, { name: 'build', state: 'failed', code: 2 }] }),
    job(root, 'j0d0002', { kind: 'server', label: 'preview the project', command: '/somewhere/node', state: 'ready', url: 'http://127.0.0.1:4100/', startedAt: '2026-10-10T09:57:00.000Z', endedAt: undefined }),
    job(root, 'j0d0003', { label: 'FAKE stale task', state: 'running', stale: true, startedAt: '2026-10-10T08:00:00.000Z', endedAt: undefined }),
    job(root, 'j0f0002', { label: 'recipe enclosure.tray/1 5c6d7e8f · FAKE · flow f0000f001', state: 'running', startedAt: '2026-10-10T09:50:00.000Z', endedAt: undefined }),
  ];
  const observations: BoardObservation[] = [{ file: 'results/observations/unsealed.json', madeAt: '2026-10-10T09:52:00.000Z', source: { path: 'refs/other.png' }, measurements: [], interpretation: { status: 'answered', model: 'fake/vision' }, job: 'j0c0009' }];
  const mine = new Set(o.mine ?? ['j0a0004', 'j0c0003', 'j0d0002', 'j0d0003']);
  const ctx: RoomContext = {
    root, project: 'fake-room', projectId: pid, jobs, chain, observations,
    mine: (id) => mine.has(id), activeFlows: o.activeFlows ?? [],
    scrub: (t) => t.split(root).join('.'), now: () => NOW,
  };
  return { root, pid, chain, ctx, jobs, agentA1 };
}

describe('the Control Room: grouping and ordering', () => {
  it('groups every run by who owns it, in a fixed order, running first (newest first) and then the recent ones, newest first', () => {
    const { ctx } = fakeProject();
    const { view, all } = gatherRoom(ctx);
    expect(view.groups.map((g) => g.kind)).toEqual([...ROOM_KINDS]);
    // What runs now, any owner, newest first: the Look job, the preview server, the agent, the flow (its state file).
    expect(view.running.map((r) => `${r.kind}:${r.id}`)).toEqual(['look:j0c0003', 'job:j0d0002', 'agent:a0000a004', 'flow:f0000f001']);
    const agents = view.groups.find((g) => g.kind === 'agent')!;
    expect(agents.running.map((r) => r.id)).toEqual(['a0000a004']);
    expect(agents.recent.map((r) => r.id)).toEqual(['a0000a003', 'a0000a002', 'a0000a001']);
    expect(view.groups.find((g) => g.kind === 'chat')!.recent.map((r) => r.state)).toEqual(['cancelled (during tool)', 'answered']);
    expect(view.groups.find((g) => g.kind === 'flow')!.recent.map((r) => r.id)).toEqual(['f0000a001']);
    expect(view.groups.find((g) => g.kind === 'native')!.recent.map((r) => r.owner)).toEqual(['Blender (Python, headless)']);
    expect(view.groups.find((g) => g.kind === 'mcp')!.recent).toHaveLength(1);
    expect(view.groups.find((g) => g.kind === 'look')!.recent.map((r) => r.id)).toEqual(['j0c0009', 'j0c0002', 'j0c0001']);
    // Other jobs: only what no other owner stands for (the agent's, Blender's, Look's and the flow's jobs are theirs).
    const others = view.groups.find((g) => g.kind === 'job')!;
    expect([...others.running, ...others.recent].map((r) => r.id).sort()).toEqual(['j0d0001', 'j0d0002', 'j0d0003']);
    expect(all.length).toBeGreaterThan(12);
  });

  it('says each run\'s owner, harness and version, model, endpoint class, state, step, elapsed time and last progress line', () => {
    const { ctx, root } = fakeProject();
    const { all } = gatherRoom(ctx);
    const running = all.find((r) => r.id === 'a0000a004')!;
    expect(running).toMatchObject({ owner: 'Qwen Code', harness: 'qwen 0.0.0-fake (a FAKE code agent)', model: 'fake-model', endpoint: 'local', route: 'local endpoint, no charge', state: 'running', running: true, job: 'j0a0004', stop: { kind: 'job', id: 'j0a0004' } });
    expect(running.elapsed).toBe('5 min');
    // The progress line: its escape sequence gone, the project folder written as ".", one line.
    expect(running.progress).toBe(`says red FAKE ${EVIL} in ./src/a.txt`);
    expect(running.progress).not.toContain(root);
    const local = all.find((r) => r.id === 'a0000a001')!;
    expect(local).toMatchObject({ state: 'completed', tone: 'ok', partOf: 'the agent step of flow f0000a001', record: '.timmy/agents/a0000a001/result.json', elapsed: '60 s' });
    expect(local.outputs.map((o) => `${o.role} ${o.path}`)).toEqual(['added notes/new.txt', 'changed recipes/tray.params.json', 'its final message .timmy/agents/a0000a001/final-message.md', 'transcript .timmy/agents/a0000a001/transcript.log', 'record .timmy/agents/a0000a001/result.json']);
    expect(local.handoff!.map((s) => `${s.name}: ${s.state}${s.job ? ` ${s.job}` : ''}`)).toEqual(['job: completed j0a0001', 'result: completed: it exited 0 and reported success']);
    const turn = all.find((r) => r.kind === 'chat' && r.state === 'answered')!;
    expect(turn).toMatchObject({ owner: 'Timmy chat agent', model: `fake/chat-${EVIL}`, step: '1 tool call', elapsed: '4.0 s', progress: 'read_project_file completed' });
    expect(turn.route).toContain('not recorded');
    expect(turn.outputs).toEqual([{ role: 'created', path: 'notes.md' }]);
    const blender = all.find((r) => r.kind === 'native')!;
    expect(blender).toMatchObject({ harness: 'blender Blender 0.0 (FAKE)', state: 'ok (judged by its result file)', job: 'j0b0001', endpoint: 'local' });
    expect(blender.outputs.map((o) => o.path)).toEqual(['out/scene.blend', '.timmy/native/4d5e6f70-0000-4000-8000-00000000aaaa/job.json']);
    const mcp = all.find((r) => r.kind === 'mcp')!;
    expect(mcp).toMatchObject({ owner: `MCP server fake-${EVIL}`, state: 'answered', step: 'tool echo', elapsed: '0.8 s', endpoint: 'local', record: '.timmy/mcp/m00000001/call.json' });
    expect(mcp.receipt).toMatch(/^[0-9a-f]{8}$/);
    const workflow = all.find((r) => r.id === 'j0d0001')!;
    expect(workflow).toMatchObject({ owner: 'upmd (a workflow run)', harness: 'upmd', progress: '2 of 2 steps; build failed, exit 2', receipt: 'rcptwf01' });
    const stale = all.find((r) => r.id === 'j0d0003')!;
    expect(stale).toMatchObject({ running: false, state: 'running; its process is gone (from an earlier session)' });
    expect(stale.stop).toBeUndefined();
  });

  it('offers a Stop only for a job this REPL started or a flow it runs; another session\'s flow gets the way to record it', () => {
    const notOurs = gatherRoom(fakeProject().ctx).all.find((r) => r.id === 'f0000f001')!;
    expect(notOurs).toMatchObject({ running: true, state: 'running, as its state file says (this REPL does not run it)' });
    expect(notOurs.stop).toBeUndefined();
    expect(notOurs.hint).toContain('/recover');
    const ours = gatherRoom(fakeProject({ activeFlows: ['f0000f001'] }).ctx).all.find((r) => r.id === 'f0000f001')!;
    expect(ours).toMatchObject({ state: 'running', stop: { kind: 'flow', id: 'f0000f001' }, step: 'its build step' });
    const theirs = gatherRoom(fakeProject({ mine: [] }).ctx).all.filter((r) => r.running);
    expect(theirs.every((r) => r.stop === undefined)).toBe(true);
  });

  it('finds one run by its id, its job, its receipt or a unique prefix of 8 or more', () => {
    const { all } = gatherRoom(fakeProject().ctx);
    expect(findRun(all, 'a0000a004')?.kind).toBe('agent');
    expect(findRun(all, 'j0a0004')?.id).toBe('a0000a004');
    expect(findRun(all, 'f0000a001')?.kind).toBe('flow');
    expect(findRun(all, '4d5e6f70')?.kind).toBe('native');
    expect(findRun(all, 'rcptwf01')?.id).toBe('j0d0001');
    expect(findRun(all, 'a0000')).toBeUndefined();
    expect(findRun(all, 'nope0000')).toBeUndefined();
  });
});

describe('the Control Room: routing words', () => {
  it('says the route rule from the recorded endpoint class and where it ran, and nothing it does not know', () => {
    expect(routeWords({ endpoint: 'local', where: '127.0.0.1:11434' })).toBe('local endpoint, no charge');
    expect(routeWords({ endpoint: 'remote', where: 'your Claude account' })).toBe('paid: your Claude account');
    expect(routeWords({ endpoint: 'remote', where: 'the account of its configured provider' })).toBe('paid: the account of its configured provider');
    expect(routeWords({ endpoint: 'remote', where: 'example.invalid:443' })).toBe('paid: remote endpoint example.invalid:443');
    expect(routeWords({ endpoint: 'remote' })).toBe('paid: a remote endpoint');
    expect(routeWords({})).toBe('route not recorded');
    const { all } = gatherRoom(fakeProject().ctx);
    expect(all.find((r) => r.id === 'a0000a002')!.route).toBe('paid: your Claude account');
    expect(all.find((r) => r.id === 'f0000a001')!.route).toBe('its agent step: local endpoint, no charge');
    expect(all.find((r) => r.id === 'j0c0001')!.route).toBe('paid: a request sent to fake/vision');
    expect(all.find((r) => r.id === 'j0c0003')!.route).toBe('this machine: Look measures; no model asked yet');
  });

  it('keeps the elapsed time coarse while a run runs (so a live page is not redrawn every poll) and exact once it ended', () => {
    expect(elapsedWords(5_000, true)).toBe('under a minute');
    expect(elapsedWords(125_000, true)).toBe('2 min');
    expect(elapsedWords(3_725_000, true)).toBe('1 h 2 min');
    expect(elapsedWords(5_000, false)).toBe('5.0 s');
    expect(elapsedWords(65_000, false)).toBe('65 s');
    expect(elapsedWords(600_000, false)).toBe('10 min');
    expect(elapsedWords(-1, false)).toBeUndefined();
  });
});

describe('the Control Room: costs, as recorded', () => {
  it('sums the known costs once each, counts the unknown and the free ones apart, and never shows a remaining budget', () => {
    const { ctx } = fakeProject();
    const { view, all } = gatherRoom(ctx);
    // Known: the turn (0.0042, its receipt read twice: once), the Claude run (0.0123), the observation (0.0021).
    expect(view.costs.known).toBe(3);
    expect(view.costs.knownUsd).toBeCloseTo(0.0186, 10);
    // Unknown: the cancelled turn (at least 0.001), the remote run with no reported cost, the refused qualified answer,
    // and the observation file no receipt seals (a model was asked).
    expect(view.costs.unknown).toBe(4);
    expect(view.costs.atLeastUsd).toBeCloseTo(0.001, 10);
    // Free: the local run (its flow receipt restates it: the same charge) and the running local run.
    expect(view.costs.free).toBe(2);
    const line = costsLine(view.costs);
    expect(line).toBe('$0.0186 known (3 runs) · 4 runs of unknown cost (at least $0.0010 reported on them) · 2 runs free (local endpoint); runs that record no cost are not counted');
    expect(line).not.toMatch(/remaining|budget|left/i);
    // Per run: the receipt's words when a receipt seals the charge, the record's otherwise; unknown is never 0.
    expect(all.find((r) => r.id === 'a0000a003')!.cost).toEqual({ kind: 'unknown', words: 'unknown: the agent reported no cost' });
    expect(all.find((r) => r.id === 'a0000a002')!.cost).toEqual({ kind: 'known', usd: 0.0123, words: '$0.0123, reported by the agent' });
    expect(all.find((r) => r.id === 'a0000a001')!.cost.kind).toBe('free');
    expect(all.find((r) => r.id === 'a0000a004')!.cost.words).toBe('free: its recorded route is a local endpoint; its cost is recorded when it ends');
    expect(all.find((r) => r.id === 'f0000a001')!.cost.kind).toBe('free');
    expect(all.find((r) => r.kind === 'chat' && r.state.startsWith('cancelled'))!.cost).toMatchObject({ kind: 'unknown', atLeast: 0.001 });
    expect(all.find((r) => r.id === 'j0c0001')!.cost).toEqual({ kind: 'known', usd: 0.0021, words: '$0.0021, as the response reported it, sealed on its receipt' });
    expect(all.find((r) => r.id === 'j0c0009')!.cost.kind).toBe('unknown');
    for (const r of all.filter((x) => x.kind === 'native' || x.kind === 'mcp' || x.kind === 'job')) expect(r.cost.kind).toBe('none');
    for (const r of all.filter((x) => x.cost.kind === 'unknown')) expect(r.cost.usd).toBeUndefined();
  });

  it('counts one charge once whatever records name it: the same receipt twice, a flow receipt restating its agent step, a record and its receipt', () => {
    const pid = 'p1';
    const agent = receipt(pid, { kind: 'agent', cost_usd: 0.5, agent: { name: 'claude', run: 'a00000001', endpoint: 'remote', outcome: 'completed', why: 'FAKE', tool_calls: 1, added: 0, changed: 0, deleted: [], cost_basis: 'reported by the agent' } });
    const flow = receipt(pid, { kind: 'flow', cost_usd: 0.5, child_receipts: [shortReceipt(agent)] });
    const turn = receipt(pid, { kind: 'turn', cost_usd: 0.25, cost_measured: true });
    const sealed = receiptCosts([agent, flow, turn, turn, agent], pid);
    expect([...sealed.keys()].sort()).toEqual(['agent:a00000001', `turn:${String(turn.hash)}`].sort());
    // The agent's own record of the same run (its result.json) adds nothing: it shares the key.
    const sum = sumCosts([...sealed.values(), { key: 'agent:a00000001', cost: { kind: 'known', usd: 0.5, words: 'FAKE record' } }]);
    expect(sum).toEqual({ knownUsd: 0.75, known: 2, unknown: 0, free: 0, atLeastUsd: 0 });
    // A flow receipt whose agent receipt is not in the chain is its own charge, under its own key.
    const alone = receiptCosts([flow], pid);
    expect([...alone.keys()]).toEqual([`flow:${String(flow.hash)}`]);
  });

  it('keeps an unknown cost unknown with its reason, a lower bound as "at least", and a run with no cost out of every count', () => {
    const pid = 'p2';
    const sealed = receiptCosts([
      receipt(pid, { kind: 'turn', cost_usd: 0.003, cost_measured: false }),
      receipt(pid, { kind: 'agent', cost_measured: false, agent: { name: 'codex', run: 'a00000002', endpoint: 'remote', outcome: 'failed', why: 'FAKE', tool_calls: 0, added: 0, changed: 0, deleted: [], cost_basis: 'unknown: the agent reported no cost' } }),
      receipt(pid, { kind: 'observe', job: { id: 'j00000a', kind: 'task', label: 'look', state: 'completed' } }),
      receipt(pid, { kind: 'turn' }),
    ], pid);
    const costs = [...sealed.values()].map((e) => e.cost);
    expect(costs[0]).toEqual({ kind: 'unknown', atLeast: 0.003, words: 'unknown: its receipt marks the cost incomplete (a cancel, or a response that reported no charge) (at least $0.0030 was reported)' });
    expect(costs[1]).toEqual({ kind: 'unknown', words: 'unknown: the agent reported no cost' });
    expect(costs[2]).toEqual({ kind: 'none', words: 'no model request went out' });
    expect(costs[3]).toEqual({ kind: 'none', words: 'its receipt records no cost' });
    const sum = sumCosts(sealed.values());
    expect(sum).toEqual({ knownUsd: 0, known: 0, unknown: 2, free: 0, atLeastUsd: 0.003 });
    expect(costsLine(sum)).toBe('no known cost recorded · 2 runs of unknown cost (at least $0.0030 reported on them) · 0 runs free (local endpoint); runs that record no cost are not counted');
    expect(costsLine(sum)).not.toContain('$0.0000');
  });
});

describe('the Control Room: handoffs', () => {
  it('draws a tray flow\'s chain agent → checks → build → readback with each step\'s owner, job, state and receipt, from the record alone', () => {
    const steps = flowHandoff(fakeTray());
    expect(steps.map((s) => s.name)).toEqual(['agent', 'checks', 'build', 'readback']);
    expect(steps.map((s) => s.owner)).toEqual(['Qwen Code', "Timmy's own checks (no model)", 'the CadQuery recipe (enclosure.tray/1)', 'fake-step-readback 0.0.0-fake (a FAKE readback, not a measurement)']);
    expect(steps.map((s) => s.job)).toEqual(['j0a0001', undefined, 'j0a0002', 'j0a0003']);
    expect(steps.map((s) => s.receipt)).toEqual(['rcpt-agent-0000', undefined, 'rcpt-build-0a01', 'rcpt-read-0a01']);
    expect(steps.map((s) => s.state)).toEqual(['completed', 'completed', 'completed', 'completed']);
    expect(steps[3].here).toBe('ended here: succeeded');
    expect(steps[2].detail).toContain('recipe job 1a2b3c4d-0000-4000-8000-00000000000a');
  });

  it('says where a flow stopped and which steps did not run; a running flow says its step; each kind names its own app', () => {
    const failed = flowHandoff(fakeTrayFailed());
    expect(failed.map((s) => `${s.name} ${s.state}`)).toEqual(['agent completed', 'checks completed', 'build failed', 'readback not run']);
    expect(failed[3].job).toBeUndefined();
    const running = flowHandoff(fakeTrayRunningState());
    expect(running.map((s) => `${s.name} ${s.state}`)).toEqual(['agent completed', 'checks completed', 'build running', 'readback waiting']);
    expect(running[2].here).toBe('running now');
    expect(flowHandoff(fakeBlender()).map((s) => s.owner)).toEqual(['Qwen Code', "Timmy's own checks (no model)", 'Blender (Blender 0.0 (FAKE))', 'fake-blend-readback 0.0.0-fake']);
    expect(flowHandoff(fakeScad()).map((s) => `${s.name}:${s.owner}`)).toEqual(['agent:Qwen Code', "checks:Timmy's own checks (no model)", 'openscad:OpenSCAD (OpenSCAD 0.0 (FAKE))', "compare:Timmy's STL reader"]);
    expect(flowHandoff(fakeAe()).map((s) => s.name)).toEqual(['agent', 'checks', 'author', 'render', 'readback']);
    expect(flowHandoff(fakeAe()).map((s) => s.receipt)).toEqual(['rcpt-agent-0000', undefined, 'rcpt-ae-0e01', 'rcpt-aer-0e01', 'rcpt-read-0e01']);
    const stopped = flowHandoff(fakeFreecad());
    expect(stopped.map((s) => s.state)).toEqual(['completed', 'stopped', 'not run', 'not run']);
    expect(flowHandoff({ kind: 'not a flow' })).toEqual([]);
  });

  it('lists a flow\'s outputs from its own record, inside the project, each once: editable files first, its record and logs last', () => {
    expect(flowOutputs(fakeBlender(), 'results/flows/f0000b001.json').map((o) => `${o.role} ${o.path}`)).toEqual([
      'editable .blend out/scene.blend', 'render out/render.png', 'the source the agent changed scene.py',
      'agent transcript .timmy/agents/a0000b001/transcript.txt', 'agent result .timmy/agents/a0000b001/result.json',
      'readback log .timmy/flows/f0000b001/readback.log', 'blender log .timmy/flows/f0000b001/blender.log', 'record results/flows/f0000b001.json',
    ]);
    const outside = flowOutputs({ ...fakeTray(), parameters: { path: '/etc/passwd' }, readback: { log: '../../x.log' } }, 'results/flows/f0000a001.json');
    expect(outside.map((o) => o.path)).not.toContain('/etc/passwd');
    expect(outside.map((o) => o.path).some((p) => p.includes('..'))).toBe(false);
  });
});

describe('the Control Room on the board: escaping, buttons, no paths', () => {
  it('escapes every string from a record, offers live Stop buttons only for this REPL\'s runs, and names no absolute path', () => {
    const { ctx, root } = fakeProject({ activeFlows: ['f0000f001'] });
    const { view } = gatherRoom(ctx);
    const live = roomSection(view, kit({ live: true, base: '../../' })).html;
    const snap = roomSection(view, kit({ live: false, base: '../../' })).html;
    for (const html of [live, snap]) {
      expect(html).not.toContain('<img');
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expect(html).not.toContain(root);
      expect(html).not.toContain('jobs-outside');
      expect(html).not.toContain('/somewhere/');
      expect(html).not.toMatch(/style=/);
    }
    // Live: a Stop for each of this REPL's running runs, as data (room-stop) and never with the job cards' own selector.
    expect(live).toContain('data-act="room-stop" data-job="j0a0004"');
    expect(live).toContain('data-act="room-stop" data-flow="f0000f001"');
    expect(live).toContain('data-act="room-stop" data-job="j0d0002"');
    expect(live).not.toContain('data-act="stop"');
    expect(live).not.toContain('data-job="j0d0003"');
    // The snapshot has no buttons: the commands are copied instead.
    expect(snap).not.toContain('data-act=');
    expect(snap).toContain('data-cmd="/stop j0a0004"');
    expect(snap).toContain('data-cmd="/room a0000a004"');
    expect(snap).toContain('href="../../.timmy/agents/a0000a001/result.json"');
    expect(live).not.toContain('href=');
    // The costs line, never a remaining budget.
    // The costs bar: the same words as the costs line (only the unknown part is drawn in the attention colour).
    expect(snap.replace(/<[^>]+>/g, '')).toContain('$0.0186 known (3 runs) · 4 runs of unknown cost (at least $0.0010 reported on them) · 2 runs free (local endpoint); runs that record no cost are not counted');
    expect(snap).toContain('<span class="cost-unknown">4 runs of unknown cost');
    expect(snap).not.toMatch(/\$[0-9.]+\s*(remaining|left)|remaining budget:|budget remaining/i);
    // The handoff chain is an ordered list with each step's owner, state, job and receipt.
    expect(snap).toContain('<ol class="handoff" aria-label="the handoffs of flow f0000a001">');
    expect(snap).toContain('<div class="ho-top"><span class="ho-name">build</span> <span class="ho-state">completed</span></div><div class="ho-owner">the CadQuery recipe (enclosure.tray/1)</div><div class="ho-meta">job j0a0002 · receipt rcpt-build-0a01 · recipe job 1a2b3c4d-0000-4000-8000-00000000000a · succeeded</div>');
    expect(ROOM_CSS).not.toMatch(/data-act=/);
  });

  it('draws the tools panel from a check: groups, rungs in words, "used" dates, setup steps; Houdini has no /tools row and says so', () => {
    const { ctx } = fakeProject();
    const FAKE_ROWS: CapabilityRow[] = [
      { id: 'repl', kind: 'surface', name: 'REPL (timmy)', rung: 'installed', detail: 'FAKE: model key from the environment' },
      { id: 'openrouter', kind: 'model', name: 'OpenRouter', rung: 'installed', detail: 'key set; not contacted' },
      { id: 'blender', kind: 'adapter', name: 'Blender (Python, headless)', rung: 'needs setup', detail: 'not found: FAKE', setup: 'brew install --cask blender (FAKE)', exercised: '2026-10-09T10:00:00.000Z' },
      { id: 'openscad', kind: 'adapter', name: 'OpenSCAD (command line)', rung: 'installed', detail: `openscad on PATH at ${ctx.root}/bin/openscad (FAKE)` },
      { id: 'codex-local', kind: 'harness', name: 'Codex, local model', rung: 'installed', detail: 'FAKE: implemented; not run' },
      { id: 'mcp-cli', kind: 'tool', name: 'MCP servers (/mcp)', rung: 'needs setup', detail: 'no command-line route installed', setup: 'npm install -g mcporter (FAKE)' },
      { id: 'look', kind: 'tool', name: 'Image observations (/observe)', rung: 'installed', detail: 'FAKE: OpenCV measurements' },
    ];
    const rows = scrubRows(FAKE_ROWS, ctx.scrub);
    expect(rows[3].detail).toBe('openscad on PATH at ./bin/openscad (FAKE)');
    const groups = toolGroups(rows);
    expect(groups.map((g) => g.title)).toEqual(['Creative apps', 'Agents', 'MCP', 'Vision', 'Models', 'Everything else /tools checks']);
    expect(groups[0].rows.map((r) => r.name)).toEqual(['Blender (Python, headless)', 'OpenSCAD (command line)', 'Houdini']);
    expect(groups[0].rows[2]).toMatchObject({ rung: 'not built', detail: '/tools has no row for Houdini, so nothing was checked here' });
    expect(needsSetup(rows).map((r) => r.id)).toEqual(['blender', 'mcp-cli']);
    expect(setupCounts([...rows, { id: 'trigger', kind: 'tool', name: 'Trigger.dev jobs', rung: 'needs setup', detail: 'no key', setup: 'set TRIGGER_SECRET_KEY' }])).toEqual({ named: 6, otherNeedSetup: 1 });
    const { view } = gatherRoom({ ...ctx, tools: { checkedAt: '2026-10-10T09:59:00.000Z', rows } });
    const html = roomSection(view, kit({ live: false, base: '../../' })).html;
    expect(html).toContain('<span class="tl-name">Blender (Python, headless)</span> <span class="rung rung-needssetup">needs setup</span>');
    expect(html).toContain('used 2026-10-09 (a run&#39;s own sealed record)');
    expect(html).toContain('do: <code>brew install --cask blender (FAKE)</code>');
    expect(html).toContain('checked 2026-10-10 09:59 UTC by /room');
    expect(html).toContain('The Control Room does not contact OpenRouter');
    // The rows outside the named groups are an advanced view, folded away.
    expect(html).toContain('<details class="more" data-keep="room:tools:other"><summary>everything else /tools checks (1)</summary>');
    const unchecked = roomSection(gatherRoom(ctx).view, kit({ live: false, base: '../../' })).html;
    expect(unchecked).toContain('Not checked yet in this session');
  });
});

describe('/room in text', () => {
  it('prints running first, then the recent runs by owner, then the costs line, then the tools that need setup', () => {
    const { ctx, root } = fakeProject({ activeFlows: ['f0000f001'] });
    const rows: CapabilityRow[] = [{ id: 'blender', kind: 'adapter', name: 'Blender (Python, headless)', rung: 'needs setup', detail: 'not found: FAKE', setup: 'brew install --cask blender (FAKE)' }];
    const { view } = gatherRoom({ ...ctx, tools: { checkedAt: '2026-10-10T09:59:00.000Z', rows } });
    const out = lines(roomLines(view, { glyphs }));
    const at = (s: string): number => { const i = out.indexOf(s); expect(i, s).toBeGreaterThanOrEqual(0); return i; };
    expect(at('RUNNING NOW')).toBeLessThan(at('RECENT, BY OWNER'));
    expect(at('RECENT, BY OWNER')).toBeLessThan(at('COSTS'));
    expect(at('COSTS')).toBeLessThan(at('NEEDS SETUP'));
    expect(out).toContain('/stop j0a0004 stops it');
    expect(out).toContain('/stop f0000f001 stops it');
    expect(out).toContain('$0.0186 known (3 runs)');
    expect(out).toContain('do: brew install --cask blender (FAKE)');
    expect(out).not.toContain(root);
    expect(out).not.toMatch(/\x1b/);
  });

  it('/room <id> shows one run\'s route, handoff chain, outputs and record; an unknown id says how to list them', () => {
    const { ctx } = fakeProject();
    const room = gatherRoom(ctx);
    const flow = lines(roomItemLines(room, 'f0000a001', { glyphs, link: (rel) => `[${rel}]` }));
    expect(flow).toContain('Timmy flow (/iterate tray)');
    expect(flow).toMatch(/Handoff\s+1\. agent {2}Qwen Code · completed · job j0a0001 · receipt rcpt-agent-0000/);
    expect(flow).toContain('4. readback  fake-step-readback');
    expect(flow).toContain('[out/recipes/1a2b3c4d/console-tray.step]  STEP');
    expect(flow).toContain("its agent step's cost: free: a local endpoint, sealed as no charge");
    const agent = lines(roomItemLines(room, 'j0a0004', { glyphs }));
    expect(agent).toContain('Qwen Code  a0000a004  running');
    expect(agent).toContain('Stop       /stop j0a0004');
    expect(lines(roomItemLines(room, 'nope', { glyphs }))).toContain('No run nope');
  });
});

describe('the live board: a flow\'s Stop, checked against the state', () => {
  const state = (flows: LiveState['flows']): LiveState => ({ project: 'p', madeAt: '', toc: '', html: '', shape: '', jobs: [], workflows: [], files: [], flows });
  it('runs /stop <flow> only for a running flow on the board that this REPL runs; anything else is refused with why', () => {
    const s = state([{ id: 'f0123abcd', state: 'running', stoppable: true }, { id: 'f00000001', state: 'running, as its state file says', stoppable: false }]);
    expect(checkAction({ action: 'stop', flow: 'f0123abcd' }, s)).toEqual({ ok: true, command: { name: 'stop', args: 'f0123abcd', line: '/stop f0123abcd' } });
    expect(checkAction({ action: 'stop', flow: 'f00000001' }, s)).toMatchObject({ ok: false, status: 409 });
    expect(checkAction({ action: 'stop', flow: 'f99999999' }, s)).toMatchObject({ ok: false, status: 404 });
    expect(checkAction({ action: 'stop', flow: 'f0123abcd', job: 'j1' }, s)).toMatchObject({ ok: false, status: 400 });
    expect(checkAction({ action: 'stop', flow: 7 }, s)).toMatchObject({ ok: false, status: 400 });
    expect(checkAction({ action: 'stop', flow: 'f0123abcd' }, state(undefined))).toMatchObject({ ok: false, status: 404 });
    // A state's own id that /stop cannot read as a flow is refused, not sent.
    expect(checkAction({ action: 'stop', flow: 'f0123 abcd' }, state([{ id: 'f0123 abcd', state: 'running', stoppable: true }]))).toMatchObject({ ok: false, status: 422 });
    // A job's stop is unchanged.
    expect(checkAction({ action: 'stop', job: 'j1' }, { ...s, jobs: [{ id: 'j1', state: 'running', label: 'x', stoppable: true }] })).toMatchObject({ ok: true, command: { line: '/stop j1' } });
  });
});

describe('the Control Room never throws for a record it cannot read', () => {
  it('reads a project with nothing in it, and one whose records are torn, without failing', () => {
    const empty = temp('room-empty-');
    const ctx: RoomContext = { root: empty, project: 'empty', projectId: projectId(empty), jobs: [], chain: [], mine: () => false, activeFlows: [], scrub: (t) => t };
    const { view } = gatherRoom(ctx);
    expect(view.running).toEqual([]);
    expect(view.groups.every((g) => g.recent.length === 0)).toBe(true);
    expect(costsLine(view.costs)).toBe('no known cost recorded · 0 runs of unknown cost · 0 runs free (local endpoint); runs that record no cost are not counted');
    put(empty, '.timmy/agents/a0000ffff/result.json', '{ torn');
    put(empty, 'results/flows/f0000ffff.json', '{ torn');
    put(empty, '.timmy/mcp/m0000ffff/call.json', '{ torn');
    expect(() => gatherRoom(ctx)).not.toThrow();
    const run: RoomRun | undefined = findRun(gatherRoom(ctx).all, 'a0000ffff');
    expect(run).toBeUndefined();
  });
});
