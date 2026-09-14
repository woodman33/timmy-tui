import { readFileSync, cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildVolumeContextPack, sealContextPack, sealSpatialAnnotation, type SpatialCameraPose, type SpatialArtifactSeal } from '../src/vision/spatial/context-pack.js';
import { proposeSpatialEdit } from '../src/vision/spatial/edit-proposal.js';
import { digest, retain, seal } from './ctx-c3w8-seal.mjs';

const [checkpoint, directory] = process.argv.slice(2);
if (!['C2', 'C4'].includes(checkpoint) || !directory) throw new Error('Usage: tsx scripts/ctx-c3w8-checkpoints.mts C2|C4 <NEW-output-dir>');
const out = resolve(directory); mkdirSync(out, { recursive: false });
const started = Date.now(), fixture = resolve('studio/spatial-volume-20260912/grid10/manifest.json');
const camera: SpatialCameraPose = { frameId: 'fixture', units: 'mm', provenance: 'generated', projection: 'perspective', position: [140, -150, 115], target: [0, 0, 0], up: [0, 0, 1], verticalFovDegrees: 50 };
const prediction = seal(`ctx.${checkpoint.toLowerCase()}.prediction`, retain(join(out, 'prediction.json'), {
  checkpoint, order: 'ctx-c3w8', createdAt: new Date().toISOString(), sourceSha256: digest(readFileSync(fixture)), budgetSeconds: 900,
  expected: checkpoint === 'C2' ? { pack: 'sealed', constructedCamera: true, validAnnotation: 'grounded', graniteFixture: 'rejected:annotation_ungrounded' } : { fresh: 'proposed', stale: 'refused:stale_source_revision', proposalDocumentWrites: 0, harnessRevisionAdvances: 1 },
}));
function saveDescriptor(value: SpatialArtifactSeal) {
  retain(value.artifact.path + '.seal.json', value.receipt);
  return retain(value.artifact.path + '.descriptor.json', value);
}
let result: Record<string, unknown>;
if (checkpoint === 'C2') {
  const pack = buildVolumeContextPack(fixture, { camera }), packSeal = sealContextPack(pack, { outputDir: out });
  const descriptor = saveDescriptor(packSeal);
  const valid = sealSpatialAnnotation(packSeal, { camera, review: { sourceSha256: pack.sourceRevision, summary: 'Selected voxel; physical quantities remain unknown.', materialKnown: false, densityKnown: false,
    annotations: [{ entityId: 'cell-center', factIds: ['cell-center.location', 'cell-center.fill'], comment: 'The selected voxel center is [5,5,5] mm and its sampled fill fraction is 0.046875.', proposedAction: 'inspect' }],
  } }, { outputDir: out }); saveDescriptor(valid);
  const historicalPath = 'tests/fixtures/spatial/granite-ungrounded-response.json', historical = JSON.parse(readFileSync(historicalPath, 'utf8'));
  const negative = sealSpatialAnnotation(packSeal, { camera, review: historical.message.content }, { outputDir: out }); saveDescriptor(negative);
  if (valid.result.status !== 'grounded' || negative.result.reason !== 'annotation_ungrounded') throw new Error('C2 checkpoint result differs from prediction.');
  result = { checkpoint, pack: packSeal.artifact, descriptor, packReceipt: packSeal.receipt.hash, validAnnotationReceipt: valid.receipt.hash, negativeControlReceipt: negative.receipt.hash,
    graniteFixture: { path: historicalPath, sha256: digest(readFileSync(historicalPath)), origin: 'Retained prior Granite response; fresh admission test, no new model inference.' },
    geometry: pack.geometry, measurementCount: pack.measurements.length, unknownCount: pack.unknowns.length, camera, checks: { packSealed: true, objectRevisionCameraAnchored: true, ungroundedCitationRejected: true } };
} else {
  const authority = join(out, 'authority'); cpSync(resolve('studio/spatial-volume-20260912/grid10'), authority, { recursive: true });
  const documentPath = join(authority, 'manifest.json'), original = readFileSync(documentPath);
  const packSeal = sealContextPack(buildVolumeContextPack(documentPath, { camera }), { outputDir: out }); saveDescriptor(packSeal);
  const request = { documentPath, objectId: 'volume', changes: [{ path: '/construction/boxSideMm', before: 80, after: 82 }] };
  const fresh = proposeSpatialEdit(packSeal, request, { outputDir: out }); saveDescriptor(fresh);
  if (!original.equals(readFileSync(documentPath)) || fresh.result.status !== 'proposed') throw new Error('Fresh proposal failed or wrote its document.');
  // The harness advances only its disposable copied authority, representing an external edit.
  const advanced = JSON.parse(original.toString()); advanced.construction.boxSideMm = 84;
  writeFileSync(documentPath, JSON.stringify(advanced) + '\n'); const revised = readFileSync(documentPath);
  const stale = proposeSpatialEdit(packSeal, request, { outputDir: out }); saveDescriptor(stale);
  if (!revised.equals(readFileSync(documentPath)) || stale.result.reason !== 'stale_source_revision') throw new Error('Stale proposal was not refused without a document write.');
  result = { checkpoint, sourceRevision: digest(original), harnessAdvancedRevision: digest(revised), freshReceipt: fresh.receipt.hash, staleReceipt: stale.receipt.hash,
    fresh: fresh.result, stale: stale.result, checks: { freshProposed: true, dryRunDiffRetained: fresh.result.dryRun.diff.length === 1, staleRefused: true, proposalDocumentWrites: 0 },
    harness: 'One explicit revision advance of this checkpoint’s disposable copied authority; original geometry fixture and native editor documents unchanged.' };
}
const elapsedMs = Date.now() - started;
const artifact = retain(join(out, 'checkpoint.json'), { ...result, elapsedMs, budgetSeconds: 900, withinBudget: elapsedMs <= 900000, omma: 'No MCP contract confirmed. Exports-only path remains with CC2.' });
const receipt = seal(`ctx.${checkpoint.toLowerCase()}.checkpoint`, artifact, prediction);
console.log(JSON.stringify({ ...result, checkpointArtifact: artifact.path, receiptHash: receipt.hash }));
