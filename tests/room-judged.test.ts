/**
 * Round R4 (helper H73): the Control Room, /jobs and /results say what Timmy judged (never a process's exit 0 where a
 * record judges the job), count a workflow run's blocks the same way everywhere, and cover the owner's Control Room list for
 * every kind of run.
 *
 * Real: a project in an os.tmpdir() folder with its own receipts chain (tests/helpers/ops-sandbox.ts: every seal is
 * appendReceipt into the project's store), the REPL's Workspace over it, its job manager running real child processes (each
 * exits as told, or is stopped by its job manager), job records on disk (a workflow run's record written into the jobs
 * folder as recovery leaves one, read back by the job manager), and the live board in a real headless Chromium.
 * FAKE, each labelled: the records no app wrote here are written by hand in the shapes Timmy writes them, with made-up
 * words, ids and hashes: an /unreal run's job.json, started.json, verdicts and readbacks (no Unreal ran); code agent runs'
 * result.json (no agent or model ran); a VoxVision record; MCP call records (no server ran); chat turn receipts (no model
 * was asked). Nothing leaves 127.0.0.1.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { chromium, type Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { JobRecord } from '../src/jobs/index.js';
import { buildOverview } from '../src/overview/index.js';
import { buildIndex, operationCard } from '../src/ops/card.js';
import { inOperationId } from '../src/ops/context.js';
import { projectId } from '../src/project/index.js';
import { gatherRoom, LEFT_RUNNING, TURN_NO_COST } from '../src/room/index.js';
import { JOB_KINDS, jobJudgement, judgeIndex } from '../src/room/judge.js';
import type { Workspace } from '../src/repl/workspace.js';
import { HOMEBREW } from '../src/theme/tokens.js';
import { appendReceipt, readChain, type Receipt, type ReceiptInput } from '../src/utils/receipts.js';
import { blockReceiptInput, CODE_FROM, receiptShort, type BlockFacts } from '../src/workflows/block-receipts.js';
import { opsKit, replOf, sandbox, sleep, text, until, type Sandbox } from './helpers/ops-sandbox.js';

const browserPath = [process.env.TIMMY_UI_CHROMIUM, chromium.executablePath(), '/opt/pw-browsers/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  .find((p): p is string => Boolean(p) && fs.existsSync(p!));
if (!browserPath) console.warn('room-judged: no Chromium or Chrome found, so the real-browser check is skipped here');

const kit = opsKit();
afterEach(() => kit.cleanup(), 60_000);

const lineOf = (out: string, id: string): string => out.split('\n').find((l) => l.includes(id)) ?? `(no line names ${id})`;
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A FAKE native run token (no app ran under it). */
const RUN_FAILED = '0c0ffee0-0000-4000-8000-00000000a173';
const RUN_STOPPED = '0c0ffee0-0000-4000-8000-00000000b173';
const RUN_FREECAD = '0c0ffee0-0000-4000-8000-00000000c173';
const RUN_DIFFERS = '0c0ffee0-0000-4000-8000-00000000d173';
const RUN_OK = '0c0ffee0-0000-4000-8000-00000000e173';
const RUN_AGREES = '0c0ffee0-0000-4000-8000-00000000f173';
/** The words u23's failed run's verdict said (ledger row 166), made up here: no Unreal ran. */
const FAILED_WHY = 'the script reported ok: false: FAKE: spawn raised; written by this failed run: Content/Timmy/F.umap';
const OP = 'o0000a173';

/** A real job: a child process that exits with `code`, through the Workspace's own job manager (inside `operation`, as a
 *  request's job is started, when one is given). */
async function ran(ws: Workspace, s: Sandbox, label: string, code = 0, operation?: string): Promise<JobRecord> {
  const j = inOperationId(operation, () => ws.jobs.start({ kind: 'task', label, project: ws.project.name, root: s.root, command: process.execPath, args: ['-e', `process.exit(${code})`] }));
  return ws.jobs.done(j.id);
}
/** A real job that waits until its job manager stops it (a stop's SIGTERM to its process group). */
async function stopped(ws: Workspace, s: Sandbox, label: string): Promise<JobRecord> {
  const j = ws.jobs.start({ kind: 'task', label, project: ws.project.name, root: s.root, command: process.execPath, args: ['-e', 'setTimeout(() => {}, 60000)'] });
  await until(() => ws.jobs.get(j.id)?.state === 'running', 10_000, 'the job to run');
  return (await ws.jobs.stop(j.id))!;
}
const writeJson = (abs: string, v: unknown): void => { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, `${JSON.stringify(v, null, 2)}\n`); };
const lines = (abs: string, list: unknown[]): void => { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, list.map((l) => JSON.stringify(l)).join('\n') + '\n'); };

/** A FAKE native run's folder, as src/native writes it: job.json, started.json, verdicts.jsonl, readbacks.jsonl. */
function nativeRun(root: string, run: string, o: { app: string; job: string; label: string; operation?: string; verdicts?: unknown[]; readbacks?: unknown[] }): void {
  const dir = path.join(root, '.timmy', 'native', run);
  writeJson(path.join(dir, 'job.json'), {
    record: 'timmy-native-run', v: 1, app: o.app, run, program: 'FAKE: never run', label: o.label, project: 'project', args: [], expect: [], pre: {},
    started_at: new Date(Date.now() - 60_000).toISOString(), timeout_ms: 60_000, ...(o.operation ? { operation: o.operation } : {}),
  });
  writeJson(path.join(dir, 'started.json'), { job: o.job, started_at: new Date(Date.now() - 60_000).toISOString() });
  if (o.verdicts) lines(path.join(dir, 'verdicts.jsonl'), o.verdicts);
  if (o.readbacks) lines(path.join(dir, 'readbacks.jsonl'), o.readbacks);
}
const verdict = (job: string, outcome: string, why: string, state = 'completed'): Record<string, unknown> => ({
  judged_at: new Date().toISOString(), job, outcome, why, exit: { state, code: state === 'completed' ? 0 : null, signal: state === 'cancelled' ? 'SIGTERM' : null }, files: [],
});

/** A FAKE code agent run's result.json, as sealAgent writes it (no agent or model ran). */
function agentResult(root: string, run: string, o: Record<string, unknown>): void {
  writeJson(path.join(root, '.timmy', 'agents', run, 'result.json'), {
    agent_run: 1, run, agent: 'qwen', agent_version: '0.0.0-fake (a FAKE code agent)', model: 'fake-model', endpoint: 'local', where: '127.0.0.1:11434',
    task: 'FAKE: a task', started_at: new Date(Date.now() - 30_000).toISOString(), ended_at: new Date().toISOString(), cost_usd: 0, cost_basis: 'local endpoint', ...o,
  });
}

const seal = (s: Sandbox, input: Omit<ReceiptInput, 'policy' | 'subject'> & { subject?: string }): Receipt => appendReceipt('runs', { policy: 'human-gated', subject: `FAKE ${input.kind}`, project: 'project', project_id: projectId(s.root), ...input } as ReceiptInput, s.root);

describe('the one table of job kinds', () => {
  it('judges a workflow run, a preview, a recipe watcher and a plain task by their own end, and every other kind by its record', () => {
    expect(Object.fromEntries(Object.entries(JOB_KINDS).map(([k, r]) => [k, r.by]))).toEqual({
      workflow: 'exit', preview: 'exit', recipe: 'exit', task: 'exit', agent: 'record', native: 'record', readback: 'record', vox: 'record', look: 'record',
    });
  });
});

describe('item 1: what Timmy judged, never a process\'s exit where a record judges the job', () => {
  it('u23 (ledger row 166): an /unreal run judged failed reads ✖ failed in /jobs, /jobs <id> and /results, where it read "✓ completed" by its exit 0', async () => {
    const s = sandbox(kit, 'judged-u23-');
    const { ws } = replOf(kit, s);
    const job = await ran(ws, s, 'Unreal · scene.py in TimmyStarter.uproject');
    // The job's own record: its process ended with 0.
    expect(job).toMatchObject({ state: 'completed', exitCode: 0 });
    nativeRun(s.root, RUN_FAILED, { app: 'unreal', job: job.id, label: job.label, verdicts: [verdict(job.id, 'failed', FAILED_WHY)] });
    const listed = lineOf(text(ws.jobsView('')), job.id);
    expect(listed).toMatch(new RegExp(`^ {2}✖ ${job.id} {2}failed {4}Unreal · scene\\.py in TimmyStarter\\.uproject · its verdict: the script reported ok: false: FAKE: spawn raised`));
    expect(listed).not.toContain('✓');
    expect(listed).not.toContain('completed');
    const shown = text(ws.jobsView(job.id));
    expect(shown).toContain(`Judged   failed  by its verdict (.timmy/native/${RUN_FAILED}/verdicts.jsonl): ${FAILED_WHY} · its process completed (exit 0)`);
    const results = text(ws.results(''));
    expect(lineOf(results.slice(results.indexOf('  Jobs')), job.id)).toMatch(new RegExp(`^ {2}✖ ${job.id} {2}failed `));
  }, 30_000);

  it('every kind by its own judge in /jobs: an agent judged unknown is "?", a stopped Unreal run the stop\'s blank, a readback not judged "?", one judged matches ✓, a task by its exit', async () => {
    const s = sandbox(kit, 'judged-kinds-');
    const { ws } = replOf(kit, s);
    // H69 (r20, r21): an OpenHands run that said it finished after 0 steps and changed nothing is judged unknown.
    const agent = await ran(ws, s, 'agent openhands a0000a173: FAKE: make the tray wider');
    agentResult(s.root, 'a0000a173', { agent: 'openhands', job: agent.id, outcome: 'unknown', why: 'it said it finished after 0 steps and changed nothing in its copy: whether it did the task is not known' });
    // u23 (c4da880): a stopped Unreal run is judged too; its verdict keeps the stop.
    const stop = await stopped(ws, s, 'Unreal · sleep.py in TimmyStarter.uproject');
    expect(stop.state).toBe('cancelled');
    nativeRun(s.root, RUN_STOPPED, { app: 'unreal', job: stop.id, label: stop.label, verdicts: [verdict(stop.id, 'failed', 'stopped; no result file, and UnrealEditor-Cmd was stopped', 'cancelled')] });
    // A readback no record judges yet, and one a FreeCAD readback line judged.
    const unjudged = await ran(ws, s, 'readback models/part.step · FreeCAD run 1a2b3c4d');
    const matched = await ran(ws, s, 'readback models/other.step · FreeCAD run 2b3c4d5e');
    nativeRun(s.root, RUN_FREECAD, { app: 'freecad', job: 'j000000', label: 'FreeCAD · part.py', readbacks: [{ readback: 1, at: new Date().toISOString(), job: matched.id, run: RUN_FREECAD, state: 'completed', verdict: 'matches' }] });
    // A VoxVision tool whose action's record says untrusted, and a Look measurement whose observe receipt says failed.
    const vox = await ran(ws, s, 'vox inspect refs/photo.png · Look (OpenCV)');
    writeJson(path.join(s.root, 'results', 'vox', 'v0000a173.json'), { schema: 'timmy.vox/1', id: 'v0000a173', status: 'untrusted', tools: [{ tool: 'look', ran: 'job', job: { id: vox.id, state: 'completed', exit_code: 0 } }], failures: [{ tool: 'look', code: 'untrusted', message: 'FAKE: the image changed while it was read' }] });
    const look = await ran(ws, s, 'look refs/photo.png');
    seal(s, { kind: 'observe', status: 'failed', job: { id: look.id, kind: 'task', label: look.label, state: 'completed' }, observation: { error: 'FAKE: the worker printed no JSON' } } as never);
    // Kinds whose own exit judges them: as before.
    const task = await ran(ws, s, 'FAKE: a plain task');
    const broke = await ran(ws, s, 'FAKE: a plain task that fails', 3);
    const out = text(ws.jobsView(''));
    expect(lineOf(out, agent.id)).toMatch(new RegExp(`^ {2}\\? ${agent.id} {2}unknown {3}agent openhands a0000a173: FAKE: make the tray wider · its result\\.json: it said it finished after 0 steps`));
    expect(lineOf(out, stop.id)).toMatch(new RegExp(`^ {4}${stop.id} {2}stopped {3}Unreal · sleep\\.py in TimmyStarter\\.uproject · its verdict: stopped; no result file`));
    expect(lineOf(out, unjudged.id)).toMatch(new RegExp(`^ {2}\\? ${unjudged.id} {2}not judged readback models/part\\.step · FreeCAD run 1a2b3c4d · its readback's verdict has no judgement of it here yet, so its exit 0 is not taken as a success · `));
    expect(lineOf(out, matched.id)).toMatch(new RegExp(`^ {2}✓ ${matched.id} {2}matches {3}readback models/other\\.step`));
    expect(lineOf(out, vox.id)).toMatch(new RegExp(`^ {2}\\? ${vox.id} {2}untrusted vox inspect refs/photo\\.png · Look \\(OpenCV\\) · its VoxVision record: FAKE: the image changed while it was read`));
    expect(lineOf(out, look.id)).toMatch(new RegExp(`^ {2}✖ ${look.id} {2}failed {4}look refs/photo\\.png · its observe receipt: FAKE: the worker printed no JSON`));
    expect(lineOf(out, task.id)).toMatch(new RegExp(`^ {2}✓ ${task.id} {2}completed FAKE: a plain task · `));
    expect(lineOf(out, broke.id)).toMatch(new RegExp(`^ {2}✖ ${broke.id} {2}failed {4}FAKE: a plain task that fails · `));
    // No line of a job a record judges shows ✓ by its exit 0.
    for (const id of [agent.id, unjudged.id, vox.id, look.id]) expect(lineOf(out, id)).not.toMatch(/✓|completed {2}/);
    // The judgements as one reading for every view (the board's Jobs section and the Control Room read the same).
    const ix = judgeIndex({ root: s.root, chain: readChain('runs', s.root), projectId: projectId(s.root) });
    expect([agent, stop, unjudged, matched, vox, look, task, broke].map((j) => jobJudgement(j, ix).mark)).toEqual(['unknown', 'stopped', 'unknown', 'ok', 'unknown', 'failed', 'ok', 'failed']);
  }, 60_000);

  it('the notice when a job a record judges ends: no ✓ by its exit 0; it hands over to its judge, which says how it ended', async () => {
    const s = sandbox(kit, 'judged-notice-');
    const { ws, notes } = replOf(kit, s);
    const job = await ran(ws, s, 'readback models/part.step · FreeCAD run 1a2b3c4d');
    await until(() => notes.some((n) => n.includes(job.id)), 5_000, 'the notice');
    const said = notes.find((n) => n.includes(job.id))!;
    expect(said).toMatch(new RegExp(`^ {2}→ ${job.id} ended {2}readback models/part\\.step · FreeCAD run 1a2b3c4d · exit 0 · [0-9.]+ s · its readback's verdict says how it ended$`));
    expect(notes.join('\n')).not.toContain(`${job.id} completed`);
    // A job its own exit judges keeps its ✓.
    const task = await ran(ws, s, 'FAKE: a plain task');
    await until(() => notes.some((n) => n.includes(task.id)), 5_000, 'the notice');
    expect(notes.find((n) => n.includes(task.id))).toMatch(new RegExp(`^ {2}✓ ${task.id} completed`));
  }, 30_000);

  it('/op: a native run reads as its operation counts it, with its verdict\'s words (it read "native run"), and an agent judged unknown is not drawn as a failure', async () => {
    const s = sandbox(kit, 'judged-op-');
    const { ws } = replOf(kit, s);
    const job = await ran(ws, s, 'Unreal · scene.py in TimmyStarter.uproject');
    nativeRun(s.root, RUN_FAILED, { app: 'unreal', job: job.id, label: job.label, operation: OP, verdicts: [verdict(job.id, 'failed', FAILED_WHY)] });
    const agentJob = await ran(ws, s, 'agent openhands a0000b173: FAKE');
    agentResult(s.root, 'a0000b173', { agent: 'openhands', job: agentJob.id, operation: OP, outcome: 'unknown', why: 'FAKE: 0 steps' });
    const card = text(ws.op(OP));
    expect(card).toContain(`native ${RUN_FAILED.slice(0, 8)}  builder  failed (judged by its result file): ${FAILED_WHY}`);
    expect(card).toContain('agent a0000b173  builder  unknown');
    const c = operationCard(buildIndex({ root: s.root, projectId: projectId(s.root), chain: readChain('runs', s.root), jobs: ws.jobs.list(), scrub: (t) => t }), OP);
    expect(c.runs.map((r) => [r.kind, r.tone])).toEqual([['agent', 'attention'], ['native', 'failed']]);
  }, 30_000);
});

/** A FAKE block receipt's facts, as src/repl/workflow-blocks.ts seals them. */
const block = (run: string, name: string, index: number, outcome: BlockFacts['outcome'], o: Partial<BlockFacts> = {}): BlockFacts => ({
  run, doc: 'WORK.md', name, index, code_sha256: null, code_from: CODE_FROM, doc_sha256: null, doc_at_end: 'unchanged', state: outcome === 'interrupted' ? 'interrupted' : outcome,
  outcome, exit_code: outcome === 'completed' ? 0 : null, started_at: null, ended_at: null, ms: null, seen: 'timmy', prediction: null, files: [], files_checked: 'FAKE: nothing checked', ...o,
});

/** A workflow run's job file as recovery leaves it (r20): three blocks planned, the REPL killed during the second. */
function leftRun(s: Sandbox, id: string, o: { expected: boolean; operation?: string }): void {
  const at = Date.now() - 120_000;
  writeJson(path.join(s.home, 'timmy', 'jobs', `${id}.json`), {
    id, kind: 'workflow', label: 'WORK.md › third', project: 'project', root: s.root, command: '/usr/bin/false', args: ['FAKE: never run'],
    state: 'failed', startedAt: new Date(at).toISOString(), endedAt: new Date(at + 20_000).toISOString(), exitCode: null, signal: null,
    error: 'its REPL ended while it ran; recovery recorded its end', lines: 0,
    steps: [{ name: 'first', state: 'completed', code: 0 }, { name: 'second', state: 'interrupted' }],
    interrupted: { step: 'second', rest: 'not seen' },
    ...(o.expected ? { expected: { steps: ['first', 'second', 'third'] } } : {}), ...(o.operation ? { operation: o.operation } : {}),
  });
}

describe('item 2: one count of a workflow run\'s blocks', () => {
  it('r20 (ledger row 162): after recovery a run of three blocks reads "2 of 3 steps" in /jobs, /room and /op (the room said "2 of 2"), each block with its receipt', async () => {
    const s = sandbox(kit, 'judged-count-');
    const { ws } = replOf(kit, s);
    leftRun(s, 'j0a7301', { expected: true, operation: 'o0000a720' });
    const first = seal(s, { ...blockReceiptInput(block('j0a7301', 'first', 1, 'completed'), { label: 'WORK.md › third', project: 'project', projectId: projectId(s.root) }) });
    const second = seal(s, { ...blockReceiptInput(block('j0a7301', 'second', 2, 'interrupted', { interrupted_by: 'repl ended' }), { label: 'WORK.md › third', project: 'project', projectId: projectId(s.root) }) });
    const [r1, r2] = [receiptShort(first), receiptShort(second)];
    expect(lineOf(text(ws.jobsView('')), 'j0a7301')).toContain(' · 2 of 3 steps · ');
    const room = text(await ws.room('j0a7301'));
    expect(room).toContain('2 of 3 steps; second interrupted; third not seen');
    expect(room).toMatch(new RegExp(`Handoff {4}1\\. first {2}a shell block, run by upmd · completed · receipt ${r1} · exit 0`));
    expect(room).toMatch(new RegExp(`2\\. second {2}a shell block, run by upmd · interrupted · receipt ${r2} · interrupted here`));
    expect(room).toMatch(/3\. third {2}a shell block, run by upmd · not seen$/m);
    expect(room).not.toContain('2 of 2 steps');
    const card = text(ws.op('o0000a720'));
    expect(card).toContain('failed · 2 of 3 steps');
    expect(card).toContain('1 first completed · 2 second interrupted · 3 third not seen');
    expect(card).toContain(`block first: receipt ${r1} · block second: receipt ${r2}`);
    // The board's Control Room and /room read the same run the same way.
    const run = gatherRoom({ root: s.root, project: 'project', projectId: projectId(s.root), jobs: ws.jobs.list(), chain: readChain('runs', s.root), mine: () => false, activeFlows: [], scrub: (t) => t }).all.find((r) => r.id === 'j0a7301')!;
    expect(run.progress).toBe('2 of 3 steps; second interrupted; third not seen');
    expect(run.handoff!.map((b) => [b.name, b.state, b.receipt ?? null])).toEqual([['first', 'completed', r1], ['second', 'interrupted', r2], ['third', 'not seen', null]]);
  }, 30_000);

  it('a record from before H67 (no planned order) says what it saw and that the planned count is not recorded, in /jobs, /room and /op', async () => {
    const s = sandbox(kit, 'judged-count-old-');
    const { ws } = replOf(kit, s);
    leftRun(s, 'j0a7302', { expected: false, operation: 'o0000a721' });
    expect(lineOf(text(ws.jobsView('')), 'j0a7302')).toContain(' · 2 steps seen (the planned count is not recorded) · ');
    expect(text(await ws.room('j0a7302'))).toContain('2 steps seen (the planned count is not recorded); second interrupted');
    expect(text(ws.op('o0000a721'))).toContain('failed · 2 steps seen (the planned count is not recorded)');
  }, 30_000);
});

describe('item 3: the owner\'s list for every kind of run', () => {
  it('a chat turn whose receipt records no cost asked a model: unknown in the room and the overview, counted, never 0; its tool calls are its handoffs', async () => {
    const s = sandbox(kit, 'judged-chat-');
    const { ws } = replOf(kit, s);
    // FAKE turn receipts (no model was asked): one sealed before turns recorded a cost (no cost field), one measured.
    const legacy = seal(s, { kind: 'turn', status: 'ok', model_requested: 'fake/chat', ms: 1200, tool_outcomes: [{ name: 'describe_image', outcome: 'completed', receipt: 'abcd1234' }, { name: 'read_project_file', outcome: 'failed' }] });
    seal(s, { kind: 'turn', status: 'ok', model_requested: 'fake/chat', ms: 900, cost_usd: 0.002, cost_measured: true });
    const room = gatherRoom({ root: s.root, project: 'project', projectId: projectId(s.root), jobs: [], chain: readChain('runs', s.root), mine: () => false, activeFlows: [], scrub: (t) => t });
    const turn = room.all.find((r) => r.id === receiptShort(legacy))!;
    expect(turn.cost).toEqual({ kind: 'unknown', words: TURN_NO_COST });
    expect(room.view.costs).toMatchObject({ known: 1, unknown: 1 });
    expect(turn.handoff!.map((h) => `${h.name} ${h.state}${h.receipt ? ` ${h.receipt}` : ''}`)).toEqual(['describe_image completed abcd1234', 'read_project_file failed']);
    expect(text(await ws.room(receiptShort(legacy)))).toMatch(/Handoff {4}1\. describe_image {2}a tool Timmy ran for the chat agent · completed · receipt abcd1234/);
    // God's Eye View reads the same: the turn's cost unknown (null), counted apart, never summed as 0.
    const o = buildOverview(s.root, { store: path.join(s.root, '.timmy', 'receipts'), jobsDir: null });
    expect(o.history.costs.unknown.runs).toBe(1);
    expect(o.history.costs.reported).toEqual({ usd: 0.002, runs: 1 });
    expect(o.agents.items.find((i) => i.id === receiptShort(legacy))!.cost).toEqual({ kind: 'unknown', usd: null, words: TURN_NO_COST });
  }, 30_000);

  it('routes: OpenHands\' model route through LiteLLM as its worker reported it (H69), and Codex\'s local route on this machine\'s Ollama', () => {
    const s = sandbox(kit, 'judged-routes-');
    agentResult(s.root, 'a0000c173', { agent: 'openhands', job: 'j0c0173', outcome: 'completed', why: 'FAKE', openhands: { image: 'timmy-openhands:fake', reported: { sdk: null, route: 'ollama_chat', tool_calls: 'native' } } });
    agentResult(s.root, 'a0000d173', { agent: 'codex', job: 'j0d0173', outcome: 'completed', why: 'FAKE', where: '127.0.0.1:11434' });
    const all = gatherRoom({ root: s.root, project: 'project', projectId: projectId(s.root), jobs: [], chain: [], mine: () => false, activeFlows: [], scrub: (t) => t }).all;
    expect(all.find((r) => r.id === 'a0000c173')!.route).toMatch(/^local endpoint, no charge; in a container \(timmy-openhands:fake\).*; its model through LiteLLM's ollama_chat route \(tool calls native\)$/);
    expect(all.find((r) => r.id === 'a0000d173')!.route).toBe('local endpoint, no charge: Codex\'s local route (--oss) on this machine\'s Ollama at 127.0.0.1:11434');
  });

  it('an Unreal run is decided by its readback, a stopped one reads stopped, and its handoff lists the first pass and each readback', () => {
    const s = sandbox(kit, 'judged-unreal-');
    nativeRun(s.root, RUN_DIFFERS, {
      app: 'unreal', job: 'j0e0173', label: 'Unreal · scene.py in TimmyStarter.uproject', verdicts: [verdict('j0e0173', 'ok', 'FAKE: the result file says ok')],
      readbacks: [{ readback: 1, app: 'unreal', at: new Date().toISOString(), job: 'j0f0173', run: RUN_DIFFERS, token: 'FAKE', state: 'completed', levels: [], tolerance: {}, verdict: 'differs', reason: 'FAKE: TimmyCube_0_0 is 2 cm higher', scope: 'FAKE' }],
    });
    nativeRun(s.root, RUN_STOPPED, { app: 'unreal', job: 'j0e0174', label: 'Unreal · sleep.py', verdicts: [verdict('j0e0174', 'failed', 'stopped; FAKE', 'cancelled')] });
    const all = gatherRoom({ root: s.root, project: 'project', projectId: projectId(s.root), jobs: [], chain: [], mine: () => false, activeFlows: [], scrub: (t) => t }).all;
    const differs = all.find((r) => r.id === RUN_DIFFERS)!;
    expect(differs).toMatchObject({ tone: 'failed', state: 'ok (judged by its result file); readback differs: FAKE: TimmyCube_0_0 is 2 cm higher' });
    expect(differs.handoff!.map((h) => `${h.name}: ${h.state}${h.job ? ` ${h.job}` : ''}${h.here ? ` (${h.here})` : ''}`)).toEqual(['first pass: ok j0e0173', 'readback: differs j0f0173 (its verdict decides the run)']);
    const stop = all.find((r) => r.id === RUN_STOPPED)!;
    expect(stop).toMatchObject({ tone: 'stopped', state: 'stopped: stopped; FAKE' });
    expect(stop.handoff!.map((h) => `${h.name}: ${h.state}`)).toEqual(['first pass: stopped', 'readback: not run']);
  });

  it('an Unreal first pass judged ok is never ✓ alone: in /jobs it reads "?" until read back, then as its readback decides it (✓ agrees, ✖ differs), and /op says it once', async () => {
    const s = sandbox(kit, 'judged-unreal-jobs-');
    const { ws } = replOf(kit, s);
    const readback = (run: string, job: string, verdictWord: string, reason: string): Record<string, unknown> => ({ readback: 1, app: 'unreal', at: new Date().toISOString(), job, run, token: 'FAKE', state: 'completed', levels: [], tolerance: {}, verdict: verdictWord, reason, scope: 'FAKE' });
    const waiting = await ran(ws, s, 'Unreal · scene.py in TimmyStarter.uproject');
    nativeRun(s.root, RUN_OK, { app: 'unreal', job: waiting.id, label: waiting.label, verdicts: [verdict(waiting.id, 'ok', 'FAKE: the result file says ok')] });
    const agreed = await ran(ws, s, 'Unreal · lights.py in TimmyStarter.uproject');
    nativeRun(s.root, RUN_AGREES, { app: 'unreal', job: agreed.id, label: agreed.label, verdicts: [verdict(agreed.id, 'ok', 'FAKE: the result file says ok')], readbacks: [readback(RUN_AGREES, 'j0f0175', 'agrees', 'FAKE: every actor where the first pass put it')] });
    const differed = await ran(ws, s, 'Unreal · cubes.py in TimmyStarter.uproject', 0, OP);
    nativeRun(s.root, RUN_DIFFERS, { app: 'unreal', job: differed.id, label: differed.label, operation: OP, verdicts: [verdict(differed.id, 'ok', 'FAKE: the result file says ok')], readbacks: [readback(RUN_DIFFERS, 'j0f0176', 'differs', 'FAKE: TimmyCube_0_0 is 2 cm higher')] });
    const out = text(ws.jobsView(''));
    expect(lineOf(out, waiting.id)).toMatch(new RegExp(`^ {2}\\? ${waiting.id} {2}unknown {3}Unreal · scene\\.py in TimmyStarter\\.uproject · its verdict, then its readback: ok \\(judged by its result file\\), but not read back yet`));
    expect(lineOf(out, agreed.id)).toMatch(new RegExp(`^ {2}✓ ${agreed.id} {2}ok {8}Unreal · lights\\.py in TimmyStarter\\.uproject · its verdict, then its readback: ok \\(judged by its result file\\); readback agrees`));
    expect(lineOf(out, differed.id)).toMatch(new RegExp(`^ {2}✖ ${differed.id} {2}differs {3}Unreal · cubes\\.py in TimmyStarter\\.uproject · its verdict, then its readback: ok \\(judged by its result file\\); readback differs: FAKE: TimmyCube_0… · `));
    expect(text(ws.jobsView(waiting.id))).toContain(`Judged   unknown  by its verdict, then its readback (.timmy/native/${RUN_OK}/verdicts.jsonl): ok (judged by its result file), but not read back yet: the first pass alone is not trusted · its process completed (exit 0)`);
    // /jobs <id>: the judge's words in full (the one-line list cuts them at 100 characters).
    expect(text(ws.jobsView(differed.id))).toContain(`Judged   differs  by its verdict, then its readback (.timmy/native/${RUN_DIFFERS}/readbacks.jsonl): ok (judged by its result file); readback differs: FAKE: TimmyCube_0_0 is 2 cm higher · its process completed (exit 0)`);
    // /op: the run's own row says how its operation counts it, once (its first pass's words are not added to the readback's).
    const card = text(ws.op(OP));
    expect(card).toContain(`native ${RUN_DIFFERS.slice(0, 8)}  builder  ok (judged by its result file); readback differs: FAKE: TimmyCube_0_0 is 2 cm higher`);
    expect(card).not.toContain('FAKE: the result file says ok');
  }, 30_000);

  it('a run left running by a Timmy that ended: /recover is what reaches it, said as its Stop would be', async () => {
    const s = sandbox(kit, 'judged-left-');
    // A real process for the job (its own process group, as the job manager starts them), and a REPL that has ended (a
    // real process that has exited: its pid is the job record's owner).
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore' });
    const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    try {
      await sleep(100);
      const job: JobRecord = {
        id: 'j0a7303', kind: 'task', label: 'FAKE: a task left running', project: 'project', root: s.root, command: process.execPath, args: [], state: 'running',
        pid: child.pid!, owner: { pid: Number(gone.stdout), startedAt: new Date(Date.now() - 60_000).toISOString() }, startedAt: new Date().toISOString(), steps: [], logPath: path.join(s.base, 'none.log'), lines: 0,
      };
      const run = gatherRoom({ root: s.root, project: 'project', projectId: projectId(s.root), jobs: [job], chain: [], mine: () => false, activeFlows: [], scrub: (t) => t }).all.find((r) => r.id === 'j0a7303')!;
      expect(run).toMatchObject({ running: true, hint: { words: LEFT_RUNNING, command: '/recover' } });
      expect(run.stop).toBeUndefined();
    } finally { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* gone */ } }
  });

  it('costs: an MCP call that was sent is unknown (never 0), one never sent has none, and a Roboflow detection (a network call) is unknown', async () => {
    const s = sandbox(kit, 'judged-costs-');
    const { ws } = replOf(kit, s);
    const call = (id: string, called: boolean): void => writeJson(path.join(s.root, '.timmy', 'mcp', id, 'call.json'), {
      schema: 'timmy.mcp-call/1', id, server: 'fake-server', route: 'sdk', transport: 'http', url: 'https://mcp.example.invalid/mcp', tool: 'echo', arguments: {},
      // a call Timmy refused, or whose route could not start, is recorded failed with called: false (mcp-records.ts)
      started_at: new Date().toISOString(), ended_at: new Date().toISOString(), ms: 10, outcome: called ? 'answered' : 'failed', called, isError: false,
      output_file: null, output_bytes: 0, output_sha256: null, truncated: false, annotations: null,
    });
    call('m0000a173', true);
    call('m0000b173', false);
    const roboflow = await ran(ws, s, 'vox detect refs/photo.png · Roboflow model fake/1 (a network call)');
    const all = gatherRoom({ root: s.root, project: 'project', projectId: projectId(s.root), jobs: ws.jobs.list(), chain: [], mine: () => false, activeFlows: [], scrub: (t) => t }).all;
    expect(all.find((r) => r.id === 'm0000a173')!.cost).toEqual({ kind: 'unknown', words: 'unknown: a request went out to the MCP server, and MCP reports no cost' });
    expect(all.find((r) => r.id === 'm0000b173')!.cost.kind).toBe('none');
    const detect = all.find((r) => r.id === roboflow.id)!;
    expect(detect).toMatchObject({ owner: 'VoxVision (a tool of one of its actions)', endpoint: 'remote', cost: { kind: 'unknown', words: 'unknown: a request went out to a hosted service, and no cost came back' } });
    // Its job a record judges and none did: never ✓ by its exit.
    expect(detect.tone).toBe('attention');
    expect(detect.state).toBe('not judged: its VoxVision record has no judgement of it here yet, so its exit 0 is not taken as a success');
  }, 30_000);
});

describe.skipIf(!browserPath)('in a real headless Chromium (a fresh context), the live board', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true, executablePath: browserPath }); });
  afterAll(async () => { await browser?.close(); });

  it('the Jobs section shows what Timmy judged (its word, its colour, its judge\'s words), and the Control Room lists a workflow run\'s blocks counted once', async () => {
    const s = sandbox(kit, 'judged-browser-');
    const { ws } = replOf(kit, s);
    const job = await ran(ws, s, 'Unreal · scene.py in TimmyStarter.uproject');
    nativeRun(s.root, RUN_FAILED, { app: 'unreal', job: job.id, label: job.label, verdicts: [verdict(job.id, 'failed', FAILED_WHY)] });
    const agent = await ran(ws, s, 'agent openhands a0000e173: FAKE');
    agentResult(s.root, 'a0000e173', { agent: 'openhands', job: agent.id, outcome: 'unknown', why: 'FAKE: 0 steps' });
    leftRun(s, 'j0a7304', { expected: true });
    await ws.boardLive('live');
    const context = await browser.newContext();
    const page = await context.newPage();
    const problems: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(m.text()); });
    page.on('pageerror', (e) => problems.push(String(e)));
    await page.goto(ws.liveBoard!.url);
    const card = page.locator(`[data-job-card="${job.id}"]`);
    await card.waitFor({ timeout: 10_000 });
    expect(await card.locator('.state').textContent()).toBe('failed');
    expect(await card.locator('.state').getAttribute('class')).toBe('state state-failed');
    expect(await card.locator('.judged').textContent()).toBe(`judged by its verdict: ${FAILED_WHY}`);
    const rgb = (hex: string): string => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
    expect(await card.locator('.state').evaluate((e) => getComputedStyle(e).color)).toBe(rgb(HOMEBREW.failure));
    const unknown = page.locator(`[data-job-card="${agent.id}"] .state`);
    expect(await unknown.textContent()).toBe('unknown');
    expect(await unknown.evaluate((e) => getComputedStyle(e).color)).toBe(rgb(HOMEBREW.attention));
    // A poll later the state is still the judgement, never the exit's word (the page updates states in place).
    await sleep(2500);
    expect(await card.locator('.state').textContent()).toBe('failed');
    // The Control Room: the workflow run's three blocks, its count, each block's word.
    const blocks = page.locator('ol.handoff[aria-label="the blocks of workflow run j0a7304"] li');
    expect(await blocks.count()).toBe(3);
    expect(await blocks.locator('.ho-state').allTextContents()).toEqual(['completed', 'interrupted', 'not seen']);
    expect(await page.locator('article.room-run[data-room-id="j0a7304"] .room-progress').textContent()).toBe('2 of 3 steps; second interrupted; third not seen');
    expect(problems).toEqual([]);
    await context.close();
  }, 60_000);
});
