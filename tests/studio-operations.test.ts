/**
 * Round R4 (H100): Timmy Canvas's project cards name the operation their records name (gap 4 of the operator's first
 * hands-on review: "Studio never shows the id"), read from those records at each reading, and the answer lists the
 * operations the cards name, each as its own record says it, its cards in the order they ran.
 *
 * A real temporary project (tests/helpers/canvas-project.ts): an operation record written by Timmy's own writer
 * (src/ops/operations.ts writeOperationRecord), a job started inside that operation by the real JobManager (so its record
 * carries the operation through the real context, src/ops/context.ts), a flow record and a VoxVision record naming it
 * (FIXTURES written in their schemas: no /iterate or /inspect ran), and receipts with and without an operation_id. FAKE: the
 * job's program is node itself, standing in for upmd (no workflow block runs). Real HTTP on 127.0.0.1 for the route;
 * everything else through projectCards directly.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JobRecord } from '../src/jobs/index.js';
import { projectCards, type ProjectCard, type ProjectCards } from '../src/studio/project-cards.js';
import { startStudioServer, type StudioServer } from '../src/studio/server.js';
import { flowRecord, makeCanvasProject, type CanvasProject } from './helpers/canvas-project.js';
import { addOperation, writeOperation } from './helpers/canvas-operation.js';

const OP = 'oa1b2c3d4';
const LEFT = 'ob2c3d4e5';
const UNRECORDED = 'oc3d4e5f6';
const SAVED = 'od4e5f6a7';

describe("Timmy Canvas's cards name their operations, read from the records", () => {
  let p: CanvasProject;
  let job: JobRecord;
  let read: ProjectCards;
  let flowId = '';
  let voxId = '';
  const leftFlow = 'fb2c3d4e5';

  const record = (o: Parameters<typeof writeOperation>[1]): void => writeOperation(p, o);
  const byId = (cards: readonly ProjectCard[]): Record<string, ProjectCard> => Object.fromEntries(cards.map((c) => [c.id, c]));
  const source = () => ({ root: p.root, name: 'demo', jobs: p.jobs, receipts: p.store });

  beforeAll(async () => {
    p = await makeCanvasProject('studio-operations-');
    // The operation: its own record (its request names the project's folder: scrubbed when read), a workflow job started
    // inside it by the real JobManager, then a flow and a VoxVision record naming it (tests/helpers/canvas-operation.ts).
    ({ job, flowId, voxId } = await addOperation(p, OP));
    // An operation whose Timmy ended while its record says it runs (a pid that runs no process): read as interrupted.
    record({ id: LEFT, request: '/iterate tray "deeper"', state: 'running', ended: null, why: undefined, owner: { pid: 2 ** 22 + 12345, started: '2026-10-11T09:00:00.000Z' }, started: '2026-10-11T09:00:00.000Z' });
    p.write(`results/flows/${leftFlow}.json`, flowRecord(leftFlow, 'failed', 'deeper').replace('"project": "demo"', `"project": "demo",\n  "operation": "${LEFT}"`));
    // A VoxVision record naming an operation this project holds no record of.
    p.write('results/vox/vb2c3d4e5.json', `${JSON.stringify({ schema: 'timmy.vox/1', id: 'vb2c3d4e5', operation: UNRECORDED, action: 'measure', command: '/measure part.stl', made_at: '2026-10-11T08:00:00.000Z', status: 'ok', inputs: [], tools: [], metrics: [], claims: [], failures: [], notes: [], highlights: [] }, null, 2)}\n`);
    // A save of the OpenSCAD parameter file under an operation: the newest receipt naming the file names it.
    p.seal({ kind: 'edit', subject: 'edit · box.params.json', operation_id: SAVED, files: [{ path: 'box.params.json', sha256: 'e'.repeat(64) }] });
    record({ id: SAVED, request: 'set-scad-params box.scad', via: 'board', started: '2026-10-11T07:00:00.000Z', ended: '2026-10-11T07:00:01.000Z' });
    read = projectCards(source(), {}, { detail: true });
  }, 60_000);
  afterAll(() => { if (p) rmSync(p.base, { recursive: true, force: true }); });

  it('each card names the operation its own record names, and where it was read; a card whose record names none says why', () => {
    const cards = byId(read.cards);
    expect(cards['workflow:RUN.md']).toMatchObject({ operation: OP, operationFrom: `its newest run's job record (${job.id})`, at: job.startedAt });
    expect(cards[`flow:${flowId}`]).toMatchObject({ operation: OP, operationFrom: 'its flow record', at: '2099-01-01T00:00:01.000Z' });
    expect(cards[`vox:${voxId}`]).toMatchObject({ operation: OP, operationFrom: 'its VoxVision record', at: '2099-01-01T00:00:02.000Z' });
    // The job itself, as the Control Room reads it (its record names the operation)
    expect(cards[`run:job:${job.id}`]).toMatchObject({ operation: OP, operationFrom: 'its record or receipt', at: job.startedAt });
    // The parameter file saved under an operation: the receipt that names it names the operation too
    const edit = read.cards.find((c) => c.id === 'params:box.params.json')!;
    expect(edit).toMatchObject({ operation: SAVED, operationFrom: `receipt ${edit.receipt}, the newest naming box.params.json` });
    // None named: each says why, in its own words
    expect(cards['workflow:BUILD.md']).toMatchObject({ operation: null, operationFrom: 'not run yet', at: null });
    expect(cards[`flow:${p.flow}`]).toMatchObject({ operation: null, operationFrom: 'its flow record names none' });
    expect(cards[`vox:${p.voxId}`]).toMatchObject({ operation: null, operationFrom: 'its VoxVision record names none' });
    expect(cards['params:recipes/tray.params.json']).toMatchObject({ operation: null, operationFrom: expect.stringMatching(/^receipt [0-9a-f]{8}, the newest naming recipes\/tray\.params\.json, names none$/) });
    expect(cards['unreadable:results/flows/f0badbad0.json']).toMatchObject({ operation: null, operationFrom: 'its record cannot be read', at: null });
    const turn = read.cards.find((c) => c.id.startsWith('run:chat:'))!;
    expect(turn).toMatchObject({ operation: null, operationFrom: 'neither its record nor its receipt names one' });
  });

  it('lists the operations the cards name, each as its own record says it, its cards in the order they ran', () => {
    const ops = read.operations!;
    const op = ops.find((o) => o.id === OP)!;
    // the request as its record writes it, the project's folder written as "."
    expect(op).toMatchObject({ request: '/run RUN.md build # in .', via: 'repl', state: 'succeeded', why: 'job ran: completed', record: `.timmy/operations/${OP}.json`, note: null });
    // the workflow run and its job (the same start), then the flow, then the VoxVision record: as they ran
    expect(op.cards).toEqual(['workflow:RUN.md', `run:job:${job.id}`, `flow:${flowId}`, `vox:${voxId}`]);
    expect(ops.find((o) => o.id === LEFT)).toMatchObject({ state: 'interrupted', note: 'its record says it runs, and the Timmy that wrote it has ended: it was left as it was', cards: [`flow:${leftFlow}`] });
    expect(ops.find((o) => o.id === UNRECORDED)).toMatchObject({ request: null, state: 'not recorded here', record: null, note: `no record .timmy/operations/${UNRECORDED}.json in this project`, cards: ['vox:vb2c3d4e5'] });
    expect(ops.find((o) => o.id === SAVED)).toMatchObject({ request: 'set-scad-params box.scad', via: 'board', cards: ['params:box.params.json'] });
    // newest first (none runs): OP (10:00), SAVED (07:00)... with LEFT (09:00) between them; the unrecorded one by its card (08:00)
    expect(ops.map((o) => o.id)).toEqual([OP, LEFT, UNRECORDED, SAVED]);
  });

  it("each drawn card's detail carries the operation as read now (with its request and state), so the card shows it", () => {
    const cards = byId(read.cards);
    expect(cards[`flow:${flowId}`].detail).toMatchObject({ type: 'result', operation: { id: OP, from: 'its flow record', request: '/run RUN.md build # in .', state: 'succeeded' } });
    expect(cards['workflow:RUN.md'].detail).toMatchObject({ type: 'workflow', operation: { id: OP, state: 'succeeded' } });
    expect(cards['workflow:BUILD.md'].detail).toMatchObject({ operation: { id: null, from: 'not run yet', request: null, state: null } });
    // without the detail, the cards still name their operations (the panel groups by them)
    const plain = byId(projectCards(source()).cards);
    expect(plain[`vox:${voxId}`]).toMatchObject({ operation: OP, operationFrom: 'its VoxVision record' });
    expect(plain[`vox:${voxId}`].detail).toBeUndefined();
  });

  it('reads the records again each time: a record changed to name another operation is said so at the next reading', () => {
    const file = join(p.root, `results/vox/${voxId}.json`);
    const before = byId(projectCards(source()).cards)[`vox:${voxId}`];
    expect(before.operation).toBe(OP);
    p.write(`results/vox/${voxId}.json`, JSON.stringify({ schema: 'timmy.vox/1', id: voxId, action: 'inspect', command: '/inspect part.stl', made_at: '2099-01-01T00:00:02.000Z', status: 'ok', inputs: [], tools: [], metrics: [], claims: [], failures: [], notes: [], highlights: [] }));
    try {
      const after = projectCards(source());
      expect(byId(after.cards)[`vox:${voxId}`]).toMatchObject({ operation: null, operationFrom: 'its VoxVision record names none' });
      expect(after.operations!.find((o) => o.id === OP)!.cards).not.toContain(`vox:${voxId}`);
    } finally {
      rmSync(file);
    }
  });

  it('GET /api/project answers with the operations, and names no absolute path', async () => {
    const home = mkdtempSync(join(tmpdir(), 'studio-operations-home-'));
    let server: StudioServer | undefined;
    try {
      server = await startStudioServer(0, { env: { TIMMY_HOME: home } });
      const port = (server.address() as AddressInfo).port;
      const call = (method: string, path: string, body?: string): Promise<{ status: number; text: string }> => new Promise((done, fail) => {
        const req = request({ host: '127.0.0.1', port, method, path, headers: { Authorization: `Bearer ${server!.projectToken}`, ...(body ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)) } : {}) } }, (res) => {
          let text = '';
          res.on('data', (c) => { text += String(c); });
          res.on('end', () => done({ status: res.statusCode ?? 0, text }));
        });
        req.on('error', fail);
        if (body) req.write(body);
        req.end();
      });
      expect((await call('POST', '/api/project/active', JSON.stringify(source()))).status).toBe(200);
      const r = await call('GET', '/api/project?detail=1');
      expect(r.status).toBe(200);
      const answer = JSON.parse(r.text) as { operations: Array<{ id: string; cards: string[] }>; cards: ProjectCard[] };
      expect(answer.operations.map((o) => o.id)).toEqual([OP, LEFT, UNRECORDED, SAVED]);
      expect(answer.cards.find((c) => c.id === `flow:${flowId}`)).toMatchObject({ operation: OP });
      for (const f of [p.root, p.real, p.base, p.jobs, p.store, home, homedir()]) expect(r.text).not.toContain(f);
    } finally {
      await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
      rmSync(home, { recursive: true, force: true });
    }
  });
});
