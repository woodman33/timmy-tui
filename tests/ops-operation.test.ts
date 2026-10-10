/**
 * Round R4 (H51): one request, one operation id, through a workflow run, a real `timmy act` child process in each block,
 * a flow with its agent, its native run and its readback, a VoxVision record, and every receipt. Real child processes,
 * real files, a real receipt chain (in the temporary project), real job lifecycles.
 *
 * FAKE pieces, each labelled:
 * - upmd is tests/fixtures/fake-upmd.mjs (a TEST DOUBLE of upmd 0.2.7's --ci behaviour; it runs each block with sh -c);
 * - the code agent is tests/fixtures/fake-code-agent.mjs (a TEST DOUBLE: no model, nothing sent), run through /agent's own
 *   start as Qwen Code on a local endpoint (TIMMY_AGENT_QWEN_BIN); its PYFILE and PYREPLACE words edit the parameter file;
 * - OpenSCAD is tests/fixtures/fake-openscad.mjs (a TEST DOUBLE with no geometry engine: it writes a box sized by -D width,
 *   depth and height), as tests/iterate-scad.test.ts uses it.
 * The `timmy` each block runs is the real CLI (src/cli.ts through tsx, as tests/drop-cli.test.ts runs it), with its own
 * HOME and TIMMY_HOME under the test's temporary folder; the receipt chain is the project's own (.timmy/receipts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readChain, verifyChain, type Receipt } from '../src/utils/receipts.js';
import { OPERATION_ID } from '../src/ops/context.js';
import { readOperationRecord } from '../src/ops/operations.js';
import { json, opsKit, replOf, sandbox as opsSandbox, text } from './helpers/ops-sandbox.js';

const kit = opsKit();
afterEach(() => kit.cleanup(), 60_000);

/** A project from the OpenSCAD starter, a `timmy` on PATH that is the real CLI, the FAKE programs, and this process as its REPL. */
function sandbox() {
  const s = opsSandbox(kit, 'ops-operation-');
  const { ws, notes } = replOf(kit, s);
  return { base: s.base, root: s.root, home: s.home, ws, notes };
}

const WORKFLOW = [
  '# FAKE workflow for the operation test',
  '',
  '```bash [name:change]',
  'timmy act \'/iterate scad box.scad "make it wider PYFILE:box.params.json PYREPLACE:60,=>100,"\' --wait',
  '```',
  '',
  '```bash [name:inspect, deps:change]',
  'stl=$(ls -t out/scad/*/box.stl 2>/dev/null | head -n 1)',
  'if [ -z "$stl" ]; then echo "no STL"; exit 1; fi',
  'timmy act "/inspect $stl" --wait',
  '```',
  '',
  '```bash [name:result, deps:inspect]',
  'echo "the block runs in operation $TIMMY_OPERATION"',
  'timmy act \'/op\' --wait',
  '```',
  '',
].join('\n');

describe('one request, one operation id, through a workflow, `timmy act` child processes, a flow and its records', () => {
  it('a /run whose blocks call real `timmy act`: the workflow job, the flow, its agent run, native run and jobs, the VoxVision record and every receipt name one operation', async () => {
    const { root, home, ws, notes } = sandbox();
    fs.writeFileSync(path.join(root, 'WORKFLOW.md'), WORKFLOW);
    const started = text(await ws.operate('/run WORKFLOW.md result', 'repl', () => ws.run('WORKFLOW.md result')));
    const h = ws.ops.latest!;
    const op = h.id;
    expect(op).toMatch(OPERATION_ID);
    const jobId = /Running\s+(j[0-9a-f]{6})/.exec(started)?.[1];
    expect(jobId, started).toBeDefined();
    // The operation's record was written before the workflow's process started (its first run), so a block can join it.
    const early = readOperationRecord(root, op);
    expect(early.ok && early.record.state).toBe('running');
    const done = await ws.jobs.done(jobId!);
    const log = ws.jobs.tail(jobId!, 400).join('\n');
    expect(done.state, log).toBe('completed');
    await ws.ops.done(h);

    // The workflow job: its record, its TIMMY_OPERATION (each block's own words), and the operation's record.
    expect(done.operation).toBe(op);
    expect(log).toContain(`the block runs in operation ${op}`);
    expect(log).toMatch(new RegExp(`operation ${op} \\(joined: TIMMY_OPERATION\\)`));
    const rec = readOperationRecord(root, op);
    expect(rec.ok, JSON.stringify(rec)).toBe(true);
    if (!rec.ok) return;
    expect(rec.record).toMatchObject({ schema: 'timmy.operation/1', id: op, request: '/run WORKFLOW.md result', via: 'repl', state: 'succeeded', parent: null });
    expect(rec.record.ended).not.toBeNull();
    expect(rec.record.runs).toEqual([{ kind: 'job', id: jobId, at: expect.any(String) }]);

    // The flow the `change` block's act started: its record, its agent run, its native run, and every job in the jobs
    // folder this HOME's Timmys share (the REPL's workflow job, and each act's jobs).
    const flows = fs.readdirSync(path.join(root, 'results', 'flows'));
    expect(flows).toHaveLength(1);
    const flow = json(path.join(root, 'results', 'flows', flows[0]));
    expect(flow).toMatchObject({ outcome: 'succeeded', operation: op });
    const agentRun = (flow.agent as { run: string }).run;
    expect(json(path.join(root, '.timmy', 'agents', agentRun, 'result.json')).operation).toBe(op);
    const nativeRun = (flow.openscad as { run: string }).run;
    expect(json(path.join(root, '.timmy', 'native', nativeRun, 'job.json')).operation).toBe(op);
    const allJobs = fs.readdirSync(path.join(home, 'timmy', 'jobs')).filter((n) => /^j[0-9a-f]{6}\.json$/.test(n)).map((n) => json(path.join(home, 'timmy', 'jobs', n)));
    expect(allJobs.length).toBeGreaterThanOrEqual(3);
    for (const j of allJobs) expect(j.operation, String(j.label)).toBe(op);
    // The VoxVision record the `inspect` block's act made.
    const vox = fs.readdirSync(path.join(root, 'results', 'vox')).filter((n) => n.endsWith('.json'));
    expect(vox).toHaveLength(1);
    expect(json(path.join(root, 'results', 'vox', vox[0]))).toMatchObject({ action: 'inspect', status: 'ok', operation: op });
    // No operation record of its own for a joined act: one record, the REPL's.
    expect(fs.readdirSync(path.join(root, '.timmy', 'operations')).filter((n) => n.endsWith('.json'))).toEqual([`${op}.json`]);

    // Every receipt on the project's chain, from both processes, names the operation; the chain verifies.
    const chain: Receipt[] = readChain('runs', root);
    const kinds = chain.map((r) => r.kind);
    for (const k of ['predict', 'workflow', 'agent', 'native', 'flow', 'vox']) expect(kinds, k).toContain(k);
    for (const r of chain) expect(r.operation_id, `${r.kind} ${r.subject}`).toBe(op);
    expect(verifyChain('runs', root).ok).toBe(true);

    // The `result` block's act printed the operation's card: the request, the flow and the STL it made, the VoxVision record.
    expect(log).toContain(`Operation ${op}`);
    expect(log).toContain('/run WORKFLOW.md result');
    expect(log).toContain(`flow ${String(flow.id)}`.replace('flow ', ''));
    expect(log).toMatch(/Output\s+out\/scad\/[0-9a-f]{8}\/box\.stl/);
    expect(log).toMatch(/VoxVision\s+v[0-9a-f]{8}\s+inspect out\/scad\/[0-9a-f]{8}\/box\.stl\s+ok/);
    expect(notes.join('\n')).toContain(`${jobId} completed`);
    // Nothing of the test's folders in the receipts.
    for (const r of chain) expect(JSON.stringify(r)).not.toContain(root);

    // The card the REPL shows for it: the workflow with its three blocks, the flow verified, the STL as sealed, the inspection.
    const card = text(ws.op(op));
    expect(card).toContain(`Operation ${op}`);
    expect(card).toMatch(/Workflow\s+WORKFLOW\.md › result\s+job j[0-9a-f]{6}\s+completed/);
    expect(card).toContain('1 change completed · 2 inspect completed · 3 result completed');
    expect(card).toMatch(/verified: the document as it ran/);
    expect(card).toMatch(/Flow\s+f[0-9a-f]{8}\s+scad\s+succeeded/);
    expect(card).toMatch(/verified: sha256 [0-9a-f]{12}, as receipt [0-9a-f]{8} sealed its record/);
    expect(card).toMatch(/agent \(builder\) completed/);
    expect(card).toMatch(/compare \(checker\)/);
    expect(text(ws.opsView(''))).toContain(op);
  }, 240_000);

  it('a flow stopped by another request keeps the operation that started it: its record, its jobs and its receipts', async () => {
    const { root, ws } = sandbox();
    const out = text(await ws.operate('/iterate scad box.scad "SLEEP"', 'repl', () => ws.iterate('scad box.scad "SLEEP"')));
    const first = ws.ops.latest!;
    const flow = /Flow\s+(f[0-9a-f]{8})/.exec(out)?.[1];
    expect(flow, out).toBeDefined();
    const stopped = text(await ws.operate(`/stop ${flow}`, 'repl', () => ws.stop(flow!)));
    expect(stopped).toContain(`${flow} cancelled`);
    const second = ws.ops.latest!;
    expect(second.id).not.toBe(first.id);
    await ws.ops.done(first);
    const record = json(path.join(root, 'results', 'flows', `${flow}.json`));
    expect(record.operation).toBe(first.id);
    const chain = readChain('runs', root);
    const flowReceipt = chain.find((r) => r.kind === 'flow');
    const agentReceipt = chain.find((r) => r.kind === 'agent');
    expect(flowReceipt?.operation_id).toBe(first.id);
    expect(agentReceipt?.operation_id).toBe(first.id);
    // The /stop sealed nothing of its own and started nothing: it has no record.
    expect(fs.existsSync(path.join(root, '.timmy', 'operations', `${second.id}.json`))).toBe(false);
    const rec = readOperationRecord(root, first.id);
    expect(rec.ok && rec.record.state).toBe('stopped');
  }, 120_000);
});
