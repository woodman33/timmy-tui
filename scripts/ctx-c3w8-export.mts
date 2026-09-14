import { readFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifySignature } from '../src/utils/receipts.js';
import { digest, retain, seal } from './ctx-c3w8-seal.mjs';

const [pythonArg, ablationDirArg, outputArg] = process.argv.slice(2);
if (!pythonArg || !ablationDirArg || !outputArg) throw new Error('Usage: tsx scripts/ctx-c3w8-export.mts <visual-python> <C3-dir> <NEW-C5-dir>');
const python = resolve(pythonArg), ablationDir = resolve(ablationDirArg), out = resolve(outputArg);
const ablationPath = join(ablationDir, 'ablation.json'), ablationBytes = readFileSync(ablationPath), ablation = JSON.parse(ablationBytes.toString());
const ablationReceipt = JSON.parse(readFileSync(ablationPath + '.seal.json', 'utf8'));
if (!verifySignature(ablationReceipt) || ablationReceipt.output_sha256 !== digest(ablationBytes) || ablation.rows.length !== 24) throw new Error('C5 requires all 24 sealed ablation rows.');
mkdirSync(out, { recursive: false }); const started = Date.now();
const prediction = seal('ctx.c5.prediction', retain(join(out, 'prediction.json'), {
  order: 'ctx-c3w8', checkpoint: 'C5', createdAt: new Date().toISOString(), ablationSha256: digest(ablationBytes), ablationReceipt: ablationReceipt.hash,
  contextSha256: ablation.contextSha256, sourceSha256: ablation.sourceSha256, expected: { rrdRows: 24, viserRows: 24, gridLocations: 1000, meshVertices: 440, meshTriangles: 880, nativeWrites: 0 },
  runtime: { pythonExecutableSha256: digest(readFileSync(python)), exporterSha256: digest(readFileSync('tools/spatial-volume/export_context_evidence.py')) }, budgetSeconds: 900,
}), ablationReceipt);
const output = join(out, 'exports');
const run = spawnSync(python, ['tools/spatial-volume/export_context_evidence.py', '--manifest', 'studio/spatial-volume-20260912/grid10/manifest.json', '--context', join(ablationDir, 'context.json'), '--ablation', ablationPath, '--out', output], { encoding: 'utf8', timeout: 300000, maxBuffer: 4 * 1024 * 1024 });
if (run.status !== 0) {
  seal('ctx.c5.checkpoint', retain(join(out, 'checkpoint.json'), { checkpoint: 'C5', ok: false, exitCode: run.status, signal: run.signal, elapsedMs: Date.now() - started, finding: 'Native evidence export failed; no successful output claim.' }), prediction, 'failed');
  throw new Error('C5 exporter failed: ' + run.stderr.slice(-1200));
}
const manifestPath = join(output, 'export-manifest.json'), manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
for (const [file, entry] of Object.entries(manifest.files) as [string, { bytes: number; sha256: string }][]) {
  if (file.includes('/') || file.includes('\\') || file === '.' || file === '..') throw new Error('Unsafe export descriptor path.');
  const bytes = readFileSync(join(output, file)); if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256) throw new Error('Export changed before sealing.');
}
const exportsSeal = seal('context.scene.export', { path: join(outputArg, 'exports/export-manifest.json'), sha256: digest(readFileSync(manifestPath)) }, prediction);
const checkpoint = retain(join(out, 'checkpoint.json'), { checkpoint: 'C5', ok: true, elapsedMs: Date.now() - started, budgetSeconds: 900, withinBudget: Date.now() - started <= 900000,
  exportManifest: { path: join(outputArg, 'exports/export-manifest.json'), sha256: digest(readFileSync(manifestPath)), receipt: exportsSeal.hash },
  nativeFiles: ['context.rrd', 'context.viser'].map(name => ({ path: join(outputArg, 'exports', name), ...manifest.files[name] })),
  checks: { rrdVerified: manifest.rerun.exitCode === 0, viserGeometryReadback: manifest.viser.verification, rows: manifest.viser.annotationRows, ...manifest.geometry },
  scope: manifest.scope, omma: 'No MCP contract confirmed; exports-only integration remains with CC2.' });
const receipt = seal('ctx.c5.checkpoint', checkpoint, prediction);
console.log(JSON.stringify({ checkpoint: 'C5', artifact: checkpoint.path, receipt: receipt.hash, nativeFiles: manifest.files, checks: manifest.geometry }));
