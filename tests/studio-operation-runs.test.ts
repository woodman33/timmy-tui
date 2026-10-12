/**
 * R4 (H109; the operator's "Bind workflow/result nodes to real operation and artifact IDs"): each operation's own run of a
 * workflow document, for a workflow card placed for it (src/studio/operation-runs.ts, through projectCards), against a real
 * temporary project (tests/helpers/canvas-project.ts) with two operations that ran the same document: X (its record, its
 * workflow job started inside it by the real JobManager, then a flow and a VoxVision record naming it: tests/helpers/
 * canvas-operation.ts) and Y, which ran it again since. FAKE: each job's program is node itself, standing in for upmd (no
 * workflow block runs); FIXTURES: the flow and VoxVision records, written in their schemas.
 */
import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobManager, type JobRecord } from '../src/jobs/index.js';
import { inOperation } from '../src/ops/context.js';
import { projectCards } from '../src/studio/project-cards.js';
import { makeCanvasProject, type CanvasProject } from './helpers/canvas-project.js';
import { addOperation, writeOperation, writeVox, type Operation } from './helpers/canvas-operation.js';

const X = 'oa1b2c3d4';
const Y = 'ob1b2c3d4';
const Z = 'oc1c2c3d4';

describe("an operation's own run of a workflow document", () => {
  let p: CanvasProject;
  let x: Operation;
  let y: JobRecord;

  beforeAll(async () => {
    p = await makeCanvasProject('studio-operation-runs-');
    x = await addOperation(p, X);
    // Y runs RUN.md › build again, later: its run is the newest now
    writeOperation(p, { id: Y, request: '/run RUN.md build' });
    const manager = new JobManager({ dir: p.jobs });
    y = inOperation({ id: Y }, () => manager.start({ kind: 'workflow', label: 'RUN.md › build', project: 'demo', root: p.root, command: process.execPath, args: ['-e', 'setTimeout(() => {}, 20)'] }));
    await manager.done(y.id);
    // Z ran no workflow: a VoxVision record names it
    writeOperation(p, { id: Z, request: '/inspect part.stl' });
    writeVox(p, 'vc1c2c3d4', Z, '2099-01-01T00:00:03.000Z');
  }, 60_000);
  afterAll(() => { if (p?.base) rmSync(p.base, { recursive: true, force: true }); });

  const read = (detail: boolean) => projectCards({ root: p.root, name: 'demo', jobs: p.jobs, receipts: p.store }, {}, { detail });

  it("names the newest run's operation on the workflow card, and gives the earlier operation its own run of the document beside it", () => {
    const now = read(true);
    const wf = now.cards.find((c) => c.id === 'workflow:RUN.md')!;
    expect(wf.operation).toBe(Y);
    expect(wf.detail && wf.detail.type === 'workflow' ? wf.detail.last?.job : null).toBe(y.id);
    const ops = new Map((now.operations ?? []).map((o) => [o.id, o]));
    // X: its own run of RUN.md (its job, not Y's), from the job records that name X only
    const ran = ops.get(X)!.ran!;
    expect(ran).toHaveLength(1);
    expect(ran[0]).toMatchObject({ card: 'workflow:RUN.md', doc: 'RUN.md', last: { job: x.job.id, target: 'build', word: 'completed' } });
    expect(ran[0].blocks.map((b) => b.name)).toEqual(['build']);
    // Y: the card's own detail is its run already, so nothing beside it; Z ran no workflow: read, and none
    expect(ops.get(Y)!.ran).toEqual([]);
    expect(ops.get(Z)!.ran).toEqual([]);
    // no absolute path in what is sent
    expect(JSON.stringify(now.operations)).not.toContain(p.root);
  });

  it('is read only with the detail (a page with a session): the plain list has no runs', () => {
    const plain = read(false);
    expect((plain.operations ?? []).every((o) => o.ran === undefined)).toBe(true);
  });
});
