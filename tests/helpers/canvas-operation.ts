/**
 * Round R4 (H100): one operation in a canvas test project (tests/helpers/canvas-project.ts), made of real records: its own
 * record written by Timmy's writer (src/ops/operations.ts writeOperationRecord), a workflow job started inside it by the real
 * JobManager (so the job's record names the operation through the real context, src/ops/context.ts), then a flow record and a
 * VoxVision record naming it, each sealed by a receipt with its operation_id. The job's program is node itself, standing in
 * for upmd (labelled: no workflow block runs). Times: the job now, the flow and the VoxVision record later (2099), so they
 * read in that order.
 */
import { JobManager, type JobRecord } from '../../src/jobs/index.js';
import { inOperation } from '../../src/ops/context.js';
import { OPERATION_SCHEMA, writeOperationRecord, type OperationRecord } from '../../src/ops/operations.js';
import { THIS_PROCESS } from '../../src/ops/process-proof.js';
import { flowRecord, sha, type CanvasProject } from './canvas-project.js';

const F = '```';

/** Writes an operation's record with Timmy's own writer (a finished one of this process, unless `o` says otherwise). */
export function writeOperation(p: CanvasProject, o: Partial<OperationRecord> & { id: string }): void {
  const w = writeOperationRecord(p.root, {
    schema: OPERATION_SCHEMA, request: '/run RUN.md build', via: 'repl', project: 'demo', started: '2026-10-11T10:00:00.000Z', ended: '2026-10-11T10:05:00.000Z',
    state: 'succeeded', why: 'job ran: completed', parent: null, runs: [], owner: { pid: THIS_PROCESS.pid, started: THIS_PROCESS.started }, ...o,
  });
  if (!w.ok) throw new Error(w.error);
}

/** A VoxVision record naming operation `op` (or none), made at `madeAt`, sealed by its vox receipt; its file back. */
export function writeVox(p: CanvasProject, id: string, op: string | null, madeAt: string): string {
  const stl = Buffer.from('solid empty\nendsolid empty\n');
  const text = `${JSON.stringify({
    schema: 'timmy.vox/1', id, ...(op ? { operation: op } : {}), action: 'inspect', command: '/inspect part.stl', made_at: madeAt, status: 'ok',
    inputs: [{ path: 'part.stl', sha256: sha(stl), bytes: stl.length, kind: 'mesh' }], tools: [], metrics: [], claims: [], failures: [], notes: [], highlights: [],
  }, null, 2)}\n`;
  const file = `results/vox/${id}.json`;
  p.write(file, text);
  p.seal({ kind: 'vox', subject: 'vox · inspect · part.stl · ok', ...(op ? { operation_id: op } : {}), outputs: [{ path: file, sha256: sha(text), bytes: Buffer.byteLength(text) }] });
  return file;
}

export interface Operation { op: string; job: JobRecord; flowId: string; voxId: string }

/** The operation: its record, its workflow job (RUN.md › build), its flow and its VoxVision record, in that order. */
export async function addOperation(p: CanvasProject, op = 'oa1b2c3d4'): Promise<Operation> {
  p.write('RUN.md', ['# Run it', '', `${F}bash [name:build]`, 'echo built', F, ''].join('\n'));
  writeOperation(p, { id: op, request: `/run RUN.md build # in ${p.root}` });
  const manager = new JobManager({ dir: p.jobs });
  let job = inOperation({ id: op }, () => manager.start({ kind: 'workflow', label: 'RUN.md › build', project: 'demo', root: p.root, command: process.execPath, args: ['-e', 'setTimeout(() => {}, 20)'] }));
  await manager.done(job.id);
  job = manager.get(job.id)!;
  const flowId = 'fa1b2c3d4';
  const flowText = flowRecord(flowId, 'succeeded', 'make it wider').replace('"project": "demo"', `"project": "demo",\n  "operation": "${op}"`).replace('2026-10-10T05:00:00.000Z', '2099-01-01T00:00:01.000Z');
  p.write(`results/flows/${flowId}.json`, flowText);
  p.seal({ kind: 'flow', subject: `flow · iterate · tray · ${flowId} · succeeded`, operation_id: op, outputs: [{ path: `results/flows/${flowId}.json`, sha256: sha(flowText), bytes: Buffer.byteLength(flowText) }] });
  const voxId = 'va1b2c3d4';
  writeVox(p, voxId, op, '2099-01-01T00:00:02.000Z');
  return { op, job, flowId, voxId };
}
