/**
 * Round R4 (H102): a FAKE tray flow for the tray template's tests: a TEST DOUBLE of what `timmy act '/iterate tray "…"'`
 * leaves in a project. No agent runs and nothing is built: it writes FAKE bytes where the rebuild delivers its STEP
 * (out/recipes/<8>/console-tray.step), a flow record in the record's shape through Timmy's own writer (writeFlowRecord), and
 * a flow receipt on the project's real runs chain (appendReceipt) naming the record's bytes, under the operation it is
 * given, as the flow's own seal names the operation its `timmy act` joined.
 *
 * Used two ways:
 * - imported (fakeTrayFlow), to lay down records in a test's project;
 * - run as a command through tsx, as the FAKE `timmy act '/iterate tray …'` of a workflow block: it reads TIMMY_OPERATION
 *   (the block's run), writes in the current folder (the project) and seals on the store `timmy act` would use there
 *   (TIMMY_STORE). FAKE_TRAY_OUTCOME picks the outcome (succeeded, default; no change; failed), FAKE_TRAY_JOB the export
 *   folder's 8 hex digits, FAKE_TRAY_LOG a file each call is noted in. R4 (H102, part 2): FAKE_TRAY_LAST_BUILD=stale makes a
 *   no change's last build stale, and the command then exits 4 (NO_CHANGE_EXIT), as `timmy act` exits for that request.
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FLOW_SCHEMA, newFlowId, writeFlowRecord, type FlowRecord, type LastBuildCheck } from '../../src/flows/iterate.js';
import { projectId } from '../../src/project/index.js';
import { DOCTRINE_15, RECIPE_ID } from '../../src/recipes/index.js';
import { appendReceipt } from '../../src/utils/receipts.js';

const sha = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');

export interface FakeTrayFlow { id: string; rel: string; step: string; stepSha256: string; receipt?: string }

/**
 * Lays down a FAKE tray flow in `root`: its STEP (unless `outcome` is failed), its record and (unless `seal` is false) its
 * flow receipt, sealed with `dir` as the store's folder (appendReceipt's own default: the current folder's store).
 * - `outcome` succeeded: the record names the STEP as its rebuild's export and as what its readback read (verdict matches);
 * - `no change`: the record names no rebuild; its last_build check names the STEP (in `job`'s folder, which must already
 *   hold it) with the check's words, as the tray's own check writes them (src/flows/iterate.ts trayLastBuild); with `stale`,
 *   the check found the request changed since that build (the last build stale);
 * - `failed`: the flow ended in its build step and names no STEP.
 */
export function fakeTrayFlow(root: string, o: {
  operation?: string; job?: string; outcome?: 'succeeded' | 'no change' | 'failed'; stepText?: string; seal?: boolean; dir?: string;
  lastBuild?: Partial<LastBuildCheck>; project?: string; id?: string; stale?: boolean;
} = {}): FakeTrayFlow {
  const id = o.id ?? newFlowId();
  const job = o.job ?? randomBytes(4).toString('hex');
  const outcome = o.outcome ?? 'succeeded';
  const step = `out/recipes/${job}/console-tray.step`;
  if (outcome === 'succeeded') {
    fs.mkdirSync(path.join(root, path.dirname(step)), { recursive: true });
    fs.writeFileSync(path.join(root, step), o.stepText ?? `FAKE STEP of ${job} (a test double: no geometry)\n`);
  }
  const stepSha256 = fs.existsSync(path.join(root, step)) ? sha(fs.readFileSync(path.join(root, step))) : '';
  const now = new Date().toISOString();
  const params = { width: 140, wall: 3, supportOffset: 10, bore: 3 };
  const record: FlowRecord = {
    flow: 1, schema: FLOW_SCHEMA, id, kind: 'iterate', recipe: RECIPE_ID,
    instruction: 'FAKE: make the tray 150 mm wide', project: o.project ?? path.basename(root),
    ...(o.operation ? { operation: o.operation } : {}),
    started_at: now, ended_at: now, outcome,
    parameters: { path: 'recipes/tray.params.json', created: false, before: { sha256: sha('FAKE before'), values: params } },
    receipts: {}, child_receipts: [], doctrine: DOCTRINE_15,
  };
  if (outcome === 'succeeded') {
    record.why = 'FAKE: the readback of the delivered STEP matches the sealed prediction';
    record.rebuild = { state: 'succeeded', outputs: [{ path: step, sha256: stepSha256, bytes: fs.statSync(path.join(root, step)).size }] };
    record.readback = { state: 'completed', step: { path: step, sha256: stepSha256 }, verdict: 'matches', tolerance: { bounds_mm: 1e-6, volume_relative: 1e-8 }, scope: 'FAKE' };
  } else if (outcome === 'no change') {
    record.why = `no change: FAKE: the agent changed nothing, so nothing was rebuilt${o.stale ? '; the last build is stale' : ''}`;
    record.last_build = {
      state: o.stale ? 'stale' : 'current', checked_at: now,
      build: { kind: 'recipe', id: `${job}-0000-4000-8000-000000000000`, outputs: `out/recipes/${job}/` },
      checks: [
        { what: 'the request (the parameter values it was built from)', recorded: sha('FAKE request'), now: sha(o.stale ? 'FAKE request, changed since' : 'FAKE request'), same: !o.stale },
        { what: 'source build.py', recorded: sha('FAKE source'), now: sha('FAKE source'), same: true },
        { what: `its export out/recipes/${job}/console-tray.stl`, recorded: sha('FAKE stl'), now: sha('FAKE stl'), same: true },
        ...(stepSha256 ? [{ what: `its export ${step}`, recorded: stepSha256, now: stepSha256, same: true }] : []),
      ],
      words: o.stale
        ? `FAKE: the last build (recipe job ${job}) is stale: the request has changed since it was built; /recipe tray runs it again`
        : `FAKE: the last build (recipe job ${job}) still matches its recorded inputs`,
      ...o.lastBuild,
    };
  } else {
    record.ended_in = 'build';
    record.why = 'FAKE: the recipe job failed; nothing was read back';
    record.rebuild = { state: 'failed' };
  }
  const w = writeFlowRecord(root, record);
  if (!w.ok) throw new Error(`FAKE flow record not written: ${w.error}`);
  let receipt: string | undefined;
  if (o.seal !== false) {
    const status = outcome === 'succeeded' ? { status: 'ok' as const } : outcome === 'failed' ? { status: 'failed' as const } : {};
    const r = appendReceipt('runs', {
      kind: 'flow', subject: `flow · iterate · tray · ${id} · ${outcome} (FAKE)`, policy: 'human-gated', ...status,
      project: record.project, project_id: projectId(root), ...(o.operation ? { operation_id: o.operation } : {}),
      outputs: [{ path: w.path, sha256: w.sha256, bytes: w.bytes }],
    }, o.dir);
    receipt = r.hash.slice(7, 15);
  }
  return { id, rel: w.path, step, stepSha256, ...(receipt ? { receipt } : {}) };
}

/**
 * A FAKE VoxVision record of a project file (a TEST DOUBLE of what `/inspect <file>` leaves: no tool ran and nothing was
 * measured): results/vox/<id>.json in the record's shape, naming the file's bytes as its input, and (unless `seal` is
 * false) a vox receipt on the project's real runs chain naming the record's bytes, under the operation it is given.
 */
export function fakeVoxRecord(root: string, file: string, o: { operation?: string; seal?: boolean; dir?: string; action?: 'inspect' | 'measure'; id?: string } = {}): { id: string; rel: string; receipt?: string } {
  const id = o.id ?? `v${randomBytes(4).toString('hex')}`;
  const bytes = fs.readFileSync(path.join(root, file));
  const rel = `results/vox/${id}.json`;
  const action = o.action ?? 'inspect';
  const record = {
    schema: 'timmy.vox/1', id, action, command: `/${action} ${file}`, made_at: new Date().toISOString(), project: path.basename(root),
    ...(o.operation ? { operation: o.operation } : {}), status: 'ok',
    inputs: [{ path: file, sha256: sha(bytes), bytes: bytes.length, kind: 'step', kind_by: 'name' }],
    tools: [], metrics: [], highlights: [], failures: [], notes: ['FAKE: a test double of a VoxVision record; no tool ran and nothing was measured'],
  };
  const body = `${JSON.stringify(record, null, 2)}\n`;
  fs.mkdirSync(path.join(root, 'results', 'vox'), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
  let receipt: string | undefined;
  if (o.seal !== false) {
    const r = appendReceipt('runs', {
      kind: 'vox', subject: `vox · ${action} · ${file} · ok (FAKE)`, policy: 'human-gated', status: 'ok',
      project: record.project, project_id: projectId(root), ...(o.operation ? { operation_id: o.operation } : {}),
      outputs: [{ path: rel, sha256: sha(body), bytes: Buffer.byteLength(body) }],
    }, o.dir);
    receipt = r.hash.slice(7, 15);
  }
  return { id, rel, ...(receipt ? { receipt } : {}) };
}

// ── as a command: the FAKE `timmy act '/iterate tray …'` ─────────────────────

const main = process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
if (main) {
  const op = process.env.TIMMY_OPERATION?.trim();
  const outcome = (process.env.FAKE_TRAY_OUTCOME ?? 'succeeded') as 'succeeded' | 'no change' | 'failed';
  const root = fs.realpathSync(process.cwd());
  const stale = outcome === 'no change' && process.env.FAKE_TRAY_LAST_BUILD === 'stale';
  const f = fakeTrayFlow(root, { ...(op ? { operation: op } : {}), outcome, ...(process.env.FAKE_TRAY_JOB ? { job: process.env.FAKE_TRAY_JOB } : {}), ...(stale ? { stale } : {}) });
  if (process.env.FAKE_TRAY_LOG) fs.appendFileSync(process.env.FAKE_TRAY_LOG, `${op ?? ''}|${process.argv.slice(2).join(' ')}|${f.id}\n`);
  process.stdout.write(`  FAKE /iterate tray (a test double: no agent ran, nothing was built): flow ${f.id} ${outcome}${stale ? ' (the last build stale)' : ''} · record ${f.rel}${f.receipt ? ` · receipt ${f.receipt}` : ''}\n`);
  // as `timmy act` exits: 1 failed; for no change, 0 with the last build current, 4 (NO_CHANGE_EXIT) with it stale
  process.exit(outcome === 'failed' ? 1 : stale ? 4 : 0);
}
