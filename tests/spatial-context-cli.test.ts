import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runContextOrderCli, readSpatialPackDescriptor } from '../src/vision/spatial/context-order-cli.js';
import { readSealedContextPack, spatialBytesHash, type SpatialCameraPose } from '../src/vision/spatial/context-pack.js';
import { runModelCli } from '../src/vision/spatial/model-cli.js';
import { runSpatialCli } from '../src/vision/spatial/cli.js';
import { readChain, verifySignature } from '../src/utils/receipts.js';

const mocked = vi.hoisted(() => ({ review: vi.fn() }));
vi.mock('../src/vision/spatial/local-model-review.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/vision/spatial/local-model-review.js')>(), reviewSpatialContext: mocked.review,
}));

let root: string;
const camera: SpatialCameraPose = { frameId: 'fixture', units: 'mm', provenance: 'generated', projection: 'perspective', position: [140, -150, 115], target: [0, 0, 0], up: [0, 0, 1], verticalFovDegrees: 50 };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'timmy-context-cli-'));
  cpSync('studio/spatial-volume-20260912/grid10', join(root, 'grid10'), { recursive: true });
  writeFileSync(join(root, 'camera.json'), JSON.stringify(camera)); mocked.review.mockReset();
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
async function command(args: string[]) {
  const lines: string[] = [], code = await runContextOrderCli(args, line => lines.push(line), root);
  return { code, text: lines.join('\n'), value: lines.length === 1 && lines[0].startsWith('{') ? JSON.parse(lines[0]) : null };
}
async function makePack() {
  const result = await command(['pack', 'grid10/manifest.json', '--camera', 'camera.json', '--out', 'evidence', '--json']);
  expect(result.code).toBe(0); return result.value;
}
async function review(descriptor: string, extra: string[] = []) {
  const lines: string[] = [], code = await runModelCli(['review-pack', descriptor, '--model', 'local-fixture:latest', '--question', 'Inspect the center voxel.', '--out', 'annotations', ...extra], line => lines.push(line), root);
  return { code, value: JSON.parse(lines[0]) };
}

describe('explicit sealed spatial CLI flows', () => {
  it('creates a full descriptor sidecar without modifying the signed pack and can read it back', async () => {
    const result = await makePack(), seal = readSpatialPackDescriptor(result.descriptorPath, root);
    const bytes = readFileSync(join(root, seal.artifact.path));
    expect(spatialBytesHash(bytes)).toBe(seal.artifact.sha256); expect(verifySignature(seal.receipt)).toBe(true);
    expect(JSON.parse(bytes.toString())).not.toHaveProperty('receipt');
    expect(readSealedContextPack(seal, root).camera).toEqual(camera);
    expect(Object.keys(JSON.parse(readFileSync(join(root, result.descriptorPath), 'utf8'))).sort()).toEqual(['artifact', 'receipt']);
    expect(mocked.review).not.toHaveBeenCalled();
  });

  it('routes proposals with working-directory relative document paths and leaves the source unchanged', async () => {
    const pack = await makePack(), path = join(root, 'grid10/manifest.json'), before = readFileSync(path);
    writeFileSync(join(root, 'request.json'), JSON.stringify({ documentPath: 'grid10/manifest.json', objectId: 'volume', changes: [{ path: '/construction/boreRadiusMm', before: 12, after: 14 }] }));
    const result = await command(['propose', pack.descriptorPath, '--request', 'request.json', '--out', 'proposals']);
    expect(result.code).toBe(0); expect(result.value.result).toMatchObject({ status: 'proposed', dryRun: { documentWritten: false, requiresGeometryRebuild: true } });
    expect(readFileSync(path)).toEqual(before); expect(verifySignature(result.value.receipt)).toBe(true);
    expect(JSON.parse(readFileSync(join(root, result.value.descriptorPath), 'utf8')).receipt.hash).toBe(result.value.receipt.hash);
  });

  it('retains a signed denial when a proposal source revision changed', async () => {
    const pack = await makePack(), path = join(root, 'grid10/manifest.json');
    writeFileSync(path, readFileSync(path, 'utf8') + '\n'); const changed = readFileSync(path);
    writeFileSync(join(root, 'request.json'), JSON.stringify({ documentPath: 'grid10/manifest.json', objectId: 'volume', changes: [{ path: '/construction/boreRadiusMm', before: 12, after: 14 }] }));
    const result = await command(['propose', pack.descriptorPath, '--request', 'request.json', '--out', 'proposals']);
    expect(result.code).toBe(1); expect(result.value.result.reason).toBe('stale_source_revision');
    expect(result.value.receipt.status).toBe('denied'); expect(verifySignature(result.value.receipt)).toBe(true); expect(readFileSync(path)).toEqual(changed);
  });

  it('reviews verified context and seals an annotation using the exact pack camera', async () => {
    const packed = await makePack(), seal = readSpatialPackDescriptor(packed.descriptorPath, root), pack = readSealedContextPack(seal, root), before = readFileSync(join(root, seal.artifact.path));
    mocked.review.mockResolvedValue({ ok: true, review: { sourceSha256: pack.sourceRevision, summary: 'Material remains unknown.', materialKnown: false, densityKnown: false, annotations: [{ entityId: 'cell-center', factIds: ['cell-center.location'], comment: 'Inspect the identified center voxel.', proposedAction: 'inspect' }] }, receiptHash: 'mock-local-review-receipt' });
    const result = await review(packed.descriptorPath);
    expect(mocked.review).toHaveBeenCalledWith(pack.context, { model: 'local-fixture:latest', question: 'Inspect the center voxel.', dir: root });
    expect(result.code).toBe(0); expect(result.value.annotation.result.annotations[0]).toMatchObject({ camera: pack.camera, sourceRevision: pack.sourceRevision, objectId: 'cell-center' });
    expect(verifySignature(result.value.annotation.receipt)).toBe(true); expect(readFileSync(join(root, seal.artifact.path))).toEqual(before);
    expect(JSON.parse(readFileSync(join(root, result.value.descriptorPath), 'utf8')).receipt.kind).toBe('annotation.receipt');
  });

  it('rejects a forged pack or escaping output before any model review', async () => {
    const packed = await makePack(), forged = JSON.parse(readFileSync(join(root, packed.descriptorPath), 'utf8'));
    forged.receipt.output_sha256 = '0'.repeat(64); writeFileSync(join(root, 'forged.json'), JSON.stringify(forged));
    expect((await review('forged.json')).code).toBe(1); expect(mocked.review).not.toHaveBeenCalled();
    const lines: string[] = [];
    const code = await runModelCli(['review-pack', packed.descriptorPath, '--model', 'local-fixture:latest', '--question', 'Inspect.', '--out', '../outside'], line => lines.push(line), root);
    expect(code).toBe(1); expect(mocked.review).not.toHaveBeenCalled();
  });

  it.each(['before-dispatch', 'failed-response'])('keeps %s review failure signed and produces no successful annotation', async failure => {
    const packed = await makePack();
    if (failure === 'before-dispatch') mocked.review.mockRejectedValue(new Error('Requested local model unavailable.'));
    else mocked.review.mockResolvedValue({ ok: false, review: null, error: 'Model response is incomplete.', receiptHash: 'retained-failed-inference' });
    const result = await review(packed.descriptorPath);
    expect(result.code).toBe(1); expect(result.value.ok).toBe(false); expect(result.value.receipt.status).toBe('failed'); expect(verifySignature(result.value.receipt)).toBe(true);
    expect(result.value.scope.annotationProduced).toBe(false); expect(readChain('runs', root).some(row => row.kind === 'annotation.receipt')).toBe(false);
    expect(readdirSync(join(root, 'annotations')).some(name => name.endsWith('.descriptor.json'))).toBe(true);
  });

  it('keeps unknown-property promotion as a denied annotation rather than a successful review', async () => {
    const packed = await makePack(), pack = readSealedContextPack(readSpatialPackDescriptor(packed.descriptorPath, root), root);
    mocked.review.mockResolvedValue({ ok: true, review: { sourceSha256: pack.sourceRevision, summary: 'Claimed material.', materialKnown: true, densityKnown: false, annotations: [{ entityId: 'volume', factIds: ['volume.material'], comment: 'A material claim.', proposedAction: 'none' }] } });
    const result = await review(packed.descriptorPath);
    expect(result.code).toBe(1); expect(result.value.annotation.result.reason).toBe('annotation_unknown_promoted'); expect(result.value.annotation.receipt.status).toBe('denied');
  });

  it('exposes CLI dispatch and rejects duplicate/missing options without inference', async () => {
    const lines: string[] = []; expect(await runSpatialCli(['pack'], s => lines.push(s))).toBe(2);
    expect(lines[0]).toContain('spatial pack');
    expect((await command(['pack', 'grid10/manifest.json', '--camera', 'camera.json'])).code).toBe(2);
    expect((await command(['pack', 'grid10/manifest.json', '--camera', 'camera.json', '--camera', 'camera.json', '--out', 'evidence'])).code).toBe(2);
    expect(mocked.review).not.toHaveBeenCalled();
  });

  it('rejects an output symlink before creating directories outside its authority root', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'timmy-context-cli-outside-'));
    try {
      symlinkSync(outside, join(root, 'linked'));
      const result = await command(['pack', 'grid10/manifest.json', '--camera', 'camera.json', '--out', 'linked/new-output']);
      expect(result.code).toBe(1); expect(result.value.error).toMatch(/symlink/); expect(readdirSync(outside)).toEqual([]);
      expect(mocked.review).not.toHaveBeenCalled();
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });
});
