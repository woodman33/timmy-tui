import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { appendReceipt, rootStoreDir, verifySignature, hashOf } from '../../src/utils/receipts.js';
import { readVolumePackage } from '../../src/vision/spatial/volume-cli.js';
import { groundVoxelImagePixel } from '../../src/vision/spatial/voxel-image-grounding.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = join(root, 'studio/box-loop-20260914/s2');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const save = (p: string, x: unknown) => writeFileSync(p, JSON.stringify(x, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const files = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(d, e.name)) : [join(d, e.name)]);
function seal(kind: string, subject: string, status: 'ok' | 'failed', artifact: string, op_id: string, children: string[] = []) {
  const store = rootStoreDir(root); console.log('store: ' + store);
  if (store !== join(root, '.timmy/receipts')) throw Error('Pinned receipt store mismatch');
  const r = appendReceipt('runs', { kind, subject, status, tier: 'LIGHT', policy: 'One native view; source preserved; stop on failed gate; Fleet parked.',
    artifacts: [relative(root, artifact)], output_sha256: sha(readFileSync(artifact)), child_receipts: children, sources: [{ op_id }],
    ...(status === 'failed' ? { error_class: 'native_view_gate', exit_code: 2 } : {}) }, root);
  if (!verifySignature(r) || hashOf({ ...r, hash: '' }) !== r.hash) throw Error('Seal verification failed');
  return r;
}
const [mode, op] = process.argv.slice(2);
if (mode === 'submit') {
  const s1 = JSON.parse(readFileSync(join(root, 'studio/box-loop-20260914/s1-second/granite/evidence.bind.receipt.json'), 'utf8'));
  if (s1.status !== 'ok' || !verifySignature(s1) || hashOf({ ...s1, hash: '' }) !== s1.hash) throw Error('S1 gate not admitted');
  const id = 'view-' + randomUUID();
  save(join(out, 'request.json'), { schema: 'timmy.op/1', op_id: id, operation: 'view.ground', admittedBy: s1.hash, deadlineMs: 240000, worker: 'native sync core in detached worker' });
  const r = seal('op.request', 'view.ground', 'ok', join(out, 'request.json'), id, [s1.hash]); save(join(out, 'request.receipt.json'), r);
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), 'worker', id], { cwd: root, detached: true, stdio: 'ignore' });
  child.unref(); console.log(JSON.stringify({ op_id: id, pid: child.pid, requestSeal: r.id, state: 'submitted' }));
} else if (mode === 'worker') {
  if (!/^view-[a-f0-9-]{36}$/.test(op)) throw Error('Invalid operation id');
  let result: any; const started = Date.now();
  try {
    const source = join(root, 'studio/spatial-volume-20260912/grid40');
    const checked = readVolumePackage(join(source, 'manifest.json'));
    save(join(out, 'source-verification.json'), checked);
    const revision = checked.verification.manifestSha256;
    const sourceHashes = Object.fromEntries(['manifest.json', 'surface.json', 'fixture.vdb'].map(p => [p, sha(readFileSync(join(source, p)))]));
    const native = join(out, 'native');
    const run = spawnSync('/Applications/Blender.app/Contents/MacOS/Blender', ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '2',
      '--python', join(root, 'tools/box-loop-20260914/export-native-view.py'), '--', '--source', join(source, 'surface.json'), '--source-revision', revision, '--out', native],
      { encoding: 'utf8', timeout: 180000, maxBuffer: 2000000 });
    save(join(out, 'native-process.json'), { status: run.status, signal: run.signal, error: run.error?.message, stdout: run.stdout, stderr: run.stderr });
    if (run.status !== 0) throw Error('Native view exporter failed; process evidence retained');
    const verify = spawnSync('python3', [join(root, 'tools/box-loop-20260914/verify-native-view.py'), '--source', join(source, 'surface.json'), '--view', native], { encoding: 'utf8', timeout: 60000, maxBuffer: 1000000 });
    save(join(out, 'independent-process.json'), { status: verify.status, signal: verify.signal, stdout: verify.stdout, stderr: verify.stderr });
    if (verify.status !== 0) throw Error('Independent native view verification failed');
    const independent = JSON.parse(verify.stdout); save(join(out, 'independent-verification.json'), independent);
    const input = JSON.parse(readFileSync(join(native, 'grounding-input.json'), 'utf8'));
    const grounded = groundVoxelImagePixel(input); save(join(out, 'grounded.json'), grounded);
    const hole = structuredClone(input); hole.detection.pixel = [64, 64];
    const stale = structuredClone(input); stale.expectedSourceRevision = '0'.repeat(64);
    const wrongCamera = structuredClone(input); wrongCamera.depth.cameraId = 'different-camera';
    const missing = structuredClone(input); delete missing.depth;
    const controls = { noReturn: groundVoxelImagePixel(hole), stale: groundVoxelImagePixel(stale), wrongCamera: groundVoxelImagePixel(wrongCamera), missingDepth: groundVoxelImagePixel(missing) };
    save(join(out, 'grounding-controls.json'), controls);
    if (grounded.status !== 'grounded' || grounded.anchor.objectId !== input.objectIds.objects[0]
      || controls.noReturn.reason !== 'no_depth_return_at_pixel' || controls.stale.status !== 'rejected'
      || controls.wrongCamera.status !== 'rejected' || controls.missingDepth.status !== 'unknown') throw Error('Existing grounding function or negative control gate failed');
    for (const [p, expected] of Object.entries(sourceHashes)) if (sha(readFileSync(join(source, p))) !== expected) throw Error('Source artifact changed');
    result = { schema: 'timmy.op.result/1', op_id: op, status: 'ok', sourceRevision: revision, sourcePreserved: true,
      objectId: grounded.anchor.objectId, selectedPixel: input.detection.pixel, pointWorldMm: grounded.observation?.pointWorldMm,
      nativeView: true, sourceProvenance: input.sourceProvenance, depthMethod: 'native geometry ray cast, camera-Z mm',
      density: null, physicalMeasurement: false, controlsPassed: true, independent, durationMs: Date.now() - started };
  } catch (error) { result = { schema: 'timmy.op.result/1', op_id: op, status: 'failed', error: error instanceof Error ? error.message : 'Native view failed', durationMs: Date.now() - started }; }
  save(join(out, 'result.json'), result);
  const manifest = { schema: 'timmy.native-view.manifest/1', status: result.status, artifacts: files(out).sort().map(p => ({ path: relative(root, p), sha256: sha(readFileSync(p)) })),
    implementation: ['export-native-view.py', 'verify-native-view.py', 'native-view.ts'].map(p => ({ path: 'tools/box-loop-20260914/' + p, sha256: sha(readFileSync(join(root, 'tools/box-loop-20260914', p))) })) };
  save(join(out, 'manifest.json'), manifest);
  const boundary = seal('op.result', 'view.ground', result.status, join(out, 'result.json'), op); save(join(out, 'op.result.receipt.json'), boundary);
  const qualified = seal('seal', 'view.ground', result.status, join(out, 'manifest.json'), op, [boundary.hash]); save(join(out, 'view.ground.receipt.json'), qualified);
  save(join(out, 'complete.json'), { op_id: op, status: result.status, sealId: qualified.id, hash: qualified.hash, opResultId: boundary.id, verified: true });
} else throw Error('Unknown mode');
