/**
 * LABELLED FAKE spatial tools for tests (the spatial tools order, 2026-10-28): a folder laid out like the prepared package
 * (brush/brush, kiri/versions/5.1.0, gsplat/gsplat_worker.py) whose programs are small Node scripts, and a FAKE Blender that
 * stands in for KIRI. Nothing here is Brush, Blender, KIRI or gsplat; they let the host's job, cancel, collection, receipts and
 * fencing be checked without the native tools. The input file's name chooses the FAKE's behaviour:
 *   *slow*  waits (and starts a child process in its own group, writing both pids) until it is stopped
 *   *fail*  the worker writes status failed and exits 11 (Blender's --python-exit-code)
 *   *noexport* (Brush) exits 0 without its final export
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const FIXTURE_PLY = [
  'ply', 'format ascii 1.0', 'comment SYNTHETIC FIXTURE - not measured geometry', 'element vertex 2',
  ...['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'].map((p) => `property float ${p}`),
  'end_header', '-0.4 0 0 1 0.3 -0.3 2 -2.5 -2.5 -2.5 1 0 0 0', '0.4 0 0 1 0.3 -0.3 2 -2.5 -2.5 -2.5 1 0 0 0', '',
].join('\n');

const node = process.execPath;

const FAKE_BLENDER = `#!${node}
// LABELLED FAKE Blender (tests/fixtures/fake-spatial-tools.ts): it reads the KIRI request after "--", prints the KIRI worker's
// stage events and writes its result.json and artifacts, as Timmy's worker would. It is not Blender and not KIRI.
const fs = require('fs'); const path = require('path'); const cp = require('child_process');
const req = JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--') + 1], 'utf8'));
const out = req.output_dir; const input = req.input_ply;
const stages = []; const write = (status, extra = {}) => fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ schema: 'timmy.kiri.result.v1', fixture: req.fixture, status, stages, blender: 'FAKE 5.2.3', ...extra }, null, 2));
const stage = (s, d = {}) => { stages.push({ stage: s, ...d }); write('running'); console.log(JSON.stringify({ event: s, ...d })); };
if (input.includes('slow')) {
  const child = cp.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(out, 'pids.json'), JSON.stringify({ blender: process.pid, child: child.pid }));
  stage('registered'); setInterval(() => {}, 1000); return;
}
stage('registered', { addon: 'FAKE', version: '5.1.0' });
stage('imported', { vertices: 2 });
if (input.includes('fail')) { write('failed', { error: "ValueError('FAKE failure after import')" }); console.error('Traceback: FAKE failure'); process.exit(11); }
const lines = fs.readFileSync(input, 'utf8').split('\\n'); const end = lines.indexOf('end_header');
const keepRows = lines.slice(end + 1).filter(Boolean).filter((l) => !req.crop_aabb || Number(l.split(' ')[0]) <= req.crop_aabb[1][0]);
// shaped like KIRI 5.1's raw Blender export (seen on the Mac, 2026-10-28): uchar red/green/blue/alpha after z and float
// Col_r..Col_a at the end, beside the unchanged Gaussian values; its own comment line instead of the fixture's
const header = lines.slice(0, end).filter((l) => !l.startsWith('comment')).map((l) => l.startsWith('element vertex') ? 'element vertex ' + keepRows.length : l)
  .flatMap((l) => l === 'property float z' ? [l, 'property uchar red', 'property uchar green', 'property uchar blue', 'property uchar alpha'] : [l])
  .concat(['property float Col_r', 'property float Col_g', 'property float Col_b', 'property float Col_a', 'end_header']);
header.splice(2, 0, 'comment Created in FAKE Blender');
const outRows = keepRows.map((l) => { const v = l.trim().split(' '); return [...v.slice(0, 3), '228', '201', '172', '224', ...v.slice(3), '0.78', '0.58', '0.41', '0.88'].join(' '); });
stage('cropped', { kept: keepRows.length });
for (const s of ['crop_values_verified', 'native_saved', 'native_reopened', 'native_values_verified', 'exported', 'export_reimported', 'export_values_verified']) stage(s, s.endsWith('_verified') ? { rows: keepRows.length, rtol: 1e-5, atol: 1e-6, max_abs_difference: { coordinates: 0 } } : {});
fs.writeFileSync(path.join(out, 'edited.ply'), header.join('\\n') + '\\n' + outRows.join('\\n') + '\\n');
fs.writeFileSync(path.join(out, 'edited.blend'), Buffer.concat([Buffer.from('BLENDER-v502'), Buffer.alloc(64)]));
write('success', { artifacts: ['edited.blend', 'edited.ply'] });
`;

const FAKE_BRUSH = `#!${node}
// LABELLED FAKE Brush (tests/fixtures/fake-spatial-tools.ts): it writes export_<steps>.ply into --export-path. Not Brush.
const fs = require('fs'); const path = require('path');
const a = process.argv.slice(2); const get = (k) => a[a.indexOf(k) + 1];
const steps = get('--total-steps'); const out = get('--export-path');
console.log('FAKE brush training ' + steps + ' steps');
if (a[0].includes('slow')) { setInterval(() => {}, 1000); return; }
if (!a[0].includes('noexport')) fs.writeFileSync(path.join(out, 'export_' + steps + '.ply'), ${JSON.stringify(FIXTURE_PLY)});
`;

/** Writes the FAKE package folder and the FAKE Blender; returns the env that points Timmy at them. */
export function fakeSpatialTools(dir: string): { root: string; blender: string; env: Record<string, string> } {
  const root = join(dir, 'spatial-tools');
  mkdirSync(join(root, 'brush'), { recursive: true });
  mkdirSync(join(root, 'kiri', 'versions', '5.1.0'), { recursive: true });
  mkdirSync(join(root, 'gsplat'), { recursive: true });
  writeFileSync(join(root, 'brush', 'brush'), FAKE_BRUSH); chmodSync(join(root, 'brush', 'brush'), 0o755);
  writeFileSync(join(root, 'kiri', 'versions', '5.1.0', '__init__.py'), '# FAKE KIRI addon (tests)\n');
  writeFileSync(join(root, 'gsplat', 'gsplat_worker.py'), '# FAKE gsplat worker (tests)\n');
  writeFileSync(join(root, 'timmy-spatial'), '#!/bin/sh\necho FAKE\n'); chmodSync(join(root, 'timmy-spatial'), 0o755);
  const blender = join(dir, 'fake-blender');
  writeFileSync(blender, FAKE_BLENDER); chmodSync(blender, 0o755);
  return { root, blender, env: { TIMMY_SPATIAL_TOOLS: root, TIMMY_KIRI_BLENDER: blender } };
}
