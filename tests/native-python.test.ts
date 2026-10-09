/**
 * The Cinema 4D starter and its result helper, run by Python 3 against a STAND-IN `c4d` module
 * (tests/fixtures/c4d-stub): python3 takes c4dpy's place in an ordinary c4dpyJob, so the job's
 * environment, the starter (templates/c4d-starter/scene.py), the helper (workers/c4d/timmy_c4d.py) and the
 * judgement (src/native) are checked together. Cinema 4D does not run here: a pass says the pieces agree
 * with each other and with the names the stand-in defines from the documented API, not that Cinema 4D
 * accepts the calls. Skipped where python3 is not on PATH.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobManager } from '../src/jobs/index.js';
import { c4dpyJob, judgeNativeJob, readNativeResult } from '../src/native/index.js';

const REPO = path.resolve(__dirname, '..');
const STUB = path.join(__dirname, 'fixtures', 'c4d-stub');
const which = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
const python = which.status === 0 ? which.stdout.trim() : '';

let tmp = '';
let root = '';
let m: JobManager;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), 'timmy-c4d-py-')));
  root = path.join(tmp, 'project');
  mkdirSync(root, { recursive: true });
  // the template as a project would use it: scene.py alone, the helper found through TIMMY_C4D_LIB
  copyFileSync(path.join(REPO, 'templates', 'c4d-starter', 'scene.py'), path.join(root, 'scene.py'));
  m = new JobManager({ dir: path.join(tmp, 'jobs') });
});
afterEach(async () => {
  await m.stopAll();
  rmSync(tmp, { recursive: true, force: true });
});

async function run(env: NodeJS.ProcessEnv) {
  const spec = c4dpyJob({ script: 'scene.py', root, project: 'demo', bin: python, timeoutMs: 30_000, env: { PYTHONPATH: STUB, PYTHONDONTWRITEBYTECODE: '1', ...env } });
  const job = await m.done(m.start(spec).id);
  const read = readNativeResult(spec.native.result!);
  return { spec, job, verdict: judgeNativeJob(job, spec), result: read.state === 'read' ? read.data as Record<string, unknown> : undefined, log: m.tail(job.id, 40).join('\n') };
}

describe.skipIf(!python)('the Cinema 4D starter against a stand-in c4d (python3 in c4dpy\'s place)', () => {
  it('saves out/scene.c4d, renders out/still.png and writes a result the judgement calls ok', async () => {
    const { spec, job, verdict, result, log } = await run({});
    expect(job.state, log).toBe('completed');
    expect(spec.env?.TIMMY_C4D_LIB).toBe(path.join(REPO, 'workers', 'c4d'));
    expect(result).toMatchObject({ ok: true, run: spec.native.run, c4d_version: 2026000, renderer: 'standard', resolution: [640, 360] });
    expect(Object.keys(result?.files as object).sort()).toEqual(['out/scene.c4d', 'out/still.png']);
    expect(result?.notes).toBeUndefined();
    expect(verdict.outcome).toBe('ok');
    expect(verdict.files.every((f) => f.present && f.matches)).toBe(true);
    expect(JSON.parse(readFileSync(path.join(root, 'out', 'scene.c4d'), 'utf8')).objects).toEqual(['Cube', 'Camera', 'Stage']);
  });

  it('a render that fails is ok: false with the error, the saved document still recorded', async () => {
    const { job, verdict, result } = await run({ C4D_STUB_RENDER_FAIL: '1' });
    expect(job.state).toBe('completed');
    expect(result).toMatchObject({ ok: false });
    expect(String(result?.error)).toMatch(/RenderDocument returned 1/);
    expect(Object.keys(result?.files as object)).toEqual(['out/scene.c4d']);
    expect(String(result?.traceback)).not.toContain(root);
    expect(verdict.outcome).toBe('failed');
    expect(verdict.why).toMatch(/RenderDocument returned 1/);
  });

  it('with no active view headless, it notes that only the Stage object names the camera', async () => {
    const { verdict, result } = await run({ C4D_STUB_NO_VIEW: '1' });
    expect(verdict.outcome).toBe('ok');
    expect(String((result?.notes as string[])[0])).toMatch(/Stage object/);
  });

  it('without the helper it still leaves a result that says what is missing', async () => {
    const empty = path.join(tmp, 'no-helper');
    mkdirSync(empty);
    const { job, verdict, result } = await run({ TIMMY_C4D_LIB: empty });
    expect(job.exitCode).not.toBe(0);
    expect(String(result?.error)).toMatch(/timmy_c4d\.py was not found/);
    expect(verdict.outcome).toBe('failed');
  });
});
