import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { verifySignature } from '../src/utils/receipts.js';
import { buildVolumeContextPack, readSealedContextPack, sealContextPack, sealSpatialAnnotation, spatialBytesHash, validateSpatialCamera, type SpatialCameraPose } from '../src/vision/spatial/context-pack.js';

let root: string;
const camera: SpatialCameraPose = { frameId: 'fixture', units: 'mm', provenance: 'generated', projection: 'perspective', position: [140, -150, 115], target: [0, 0, 0], up: [0, 0, 1], verticalFovDegrees: 50 };
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'timmy-context-pack-')); cpSync('studio/spatial-volume-20260912/grid10', join(root, 'grid10'), { recursive: true }); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
const options = () => ({ outputDir: join(root, 'C2'), receiptDir: root, sourceRoot: root });
const pack = () => buildVolumeContextPack(join(root, 'grid10/manifest.json'), { camera, sourceRoot: root });

describe('C2 sealed context pack and grounded annotation receipts', () => {
  it('seals identified generated volume/reconstructed mesh, constructed camera and explicit unknowns separately from its receipt', () => {
    const value = pack(), seal = sealContextPack(value, options()), bytes = readFileSync(join(root, seal.artifact.path));
    expect(value.geometry.map(g => [g.kind, g.provenance])).toEqual([['volume', 'generated'], ['mesh', 'reconstructed']]);
    expect(value.context.entities.some(e => e.id === 'cell-center')).toBe(true);
    expect(value.document.path).toBe('grid10/manifest.json'); expect(value.camera.provenance).toBe('generated');
    expect(value.unknowns.some(u => u.factId === 'volume.density')).toBe(true);
    expect(bytes.toString()).not.toContain('signature'); expect(bytes.toString()).not.toContain(root);
    expect(spatialBytesHash(bytes)).toBe(seal.artifact.sha256); expect(verifySignature(seal.receipt)).toBe(true);
    expect(seal.receipt.env_lock?.tools).toEqual({}); expect(seal.receipt.artifacts?.every(p => !isAbsolute(p))).toBe(true);
    expect(readSealedContextPack(seal, root)).toEqual(value);
  });
  it('anchors admitted annotations to object identity, exact source revision and the sealed camera', () => {
    const value = pack(), seal = sealContextPack(value, options());
    const review = { sourceSha256: value.sourceRevision, materialKnown: false, densityKnown: false, annotations: [{ entityId: 'cell-center', factIds: ['cell-center.location', 'cell-center.fill'], comment: 'The selected cell has a known location; fill alone does not establish material.', proposedAction: 'inspect' }] };
    const result = sealSpatialAnnotation(seal, { camera, review }, options());
    expect(result.result.status).toBe('grounded'); expect(result.result.annotations[0]).toMatchObject({ objectId: 'cell-center', sourceRevision: value.sourceRevision, camera, provenance: 'generated' });
    expect(result.result.scope).toMatchObject({ nativeEditsExecuted: false, physicalValidation: false, semanticCorrectnessChecked: false });
    expect(verifySignature(result.receipt)).toBe(true);
  });
  it('rejects the exact retained historical Granite response for cross-object citations', () => {
    const value = pack(), seal = sealContextPack(value, options()), historic = JSON.parse(readFileSync('tests/fixtures/spatial/granite-ungrounded-response.json', 'utf8'));
    expect(JSON.parse(historic.message.content).sourceSha256).toBe(value.sourceRevision);
    const denied = sealSpatialAnnotation(seal, { camera, review: historic.message.content }, options());
    expect(denied.result.status).toBe('rejected'); expect(denied.result.reason).toBe('annotation_ungrounded'); expect(denied.result.annotations).toEqual([]);
    expect(denied.result.inputSha256).toBe(spatialBytesHash(historic.message.content)); expect(denied.receipt.status).toBe('denied'); expect(verifySignature(denied.receipt)).toBe(true);
  });
  it('refuses changed camera/revision and unknown-property promotion as sealed rejections', () => {
    const value = pack(), seal = sealContextPack(value, options()), review = { sourceSha256: value.sourceRevision, materialKnown: false, densityKnown: false, annotations: [{ entityId: 'volume', factIds: ['volume.material'], comment: 'Material is unknown.', proposedAction: 'none' }] };
    expect(sealSpatialAnnotation(seal, { camera: { ...camera, position: [141, -150, 115] }, review }, options()).result.reason).toBe('annotation_camera_mismatch');
    expect(sealSpatialAnnotation(seal, { camera, review: { ...review, sourceSha256: '0'.repeat(64) } }, options()).result.reason).toBe('annotation_revision_mismatch');
    expect(sealSpatialAnnotation(seal, { camera, review: { ...review, materialKnown: true } }, options()).result.reason).toBe('annotation_unknown_promoted');
  });
  it('rejects altered sealed bytes and forged receipt metadata before they can anchor annotations', () => {
    const seal = sealContextPack(pack(), options()), path = join(root, seal.artifact.path);
    const forged = structuredClone(seal); forged.receipt.output_sha256 = '0'.repeat(64);
    expect(() => readSealedContextPack(forged, root)).toThrow(/receipt/);
    chmodSync(path, 0o600); writeFileSync(path, '{}');
    expect(() => readSealedContextPack(seal, root)).toThrow(/bytes changed/);
  });
  it('rejects degenerate camera poses and never labels this constructed fixture camera as native measured', () => {
    expect(() => validateSpatialCamera({ ...camera, position: [0, 0, 0] })).toThrow();
    expect(() => validateSpatialCamera({ ...camera, up: camera.position })).toThrow();
    expect(() => validateSpatialCamera({ ...camera, verticalFovDegrees: Infinity })).toThrow();
    expect(() => buildVolumeContextPack(join(root, 'grid10/manifest.json'), { camera: { ...camera, provenance: 'measured' }, sourceRoot: root })).toThrow(/constructed camera/);
  });
  it('refuses generic, measured and invalid construction sources instead of labeling them generated', () => {
    const path = join(root, 'grid10/manifest.json'), original = JSON.parse(readFileSync(path, 'utf8'));
    for (const construction of [undefined, { ...original.construction, source: 'scanner' }, { ...original.construction, physicalMeasurement: true }, { ...original.construction, physicalMeasurement: undefined }, { ...original.construction, boxSideMm: 0 }, { ...original.construction, boreRadiusMm: 40 }, { ...original.construction, boreRadiusMm: '12' }]) {
      writeFileSync(path, JSON.stringify({ ...original, construction }));
      expect(() => pack()).toThrow(expect.objectContaining({ code: 'unsupported_generated_source' }));
    }
  });
  it('refuses source-reported measured material and measured density rather than relabeling their provenance', () => {
    const path = join(root, 'grid10/manifest.json'), original = JSON.parse(readFileSync(path, 'utf8'));
    for (const measured of [{ material: { status: 'measured', id: 'copper', source: 'retained instrument observation' } }, { density: { status: 'measured', value: 8960, unit: 'kg/m3', basis: 'occupied-material', source: 'retained instrument observation' } }]) {
      writeFileSync(path, JSON.stringify({ ...original, ...measured }));
      expect(() => pack()).toThrow(expect.objectContaining({ code: 'measured_property_not_generated' }));
    }
  });
  it('rejects a symlink output ancestor before creating any directory outside the authority root', () => {
    const outside = mkdtempSync(join(tmpdir(), 'timmy-context-output-outside-'));
    try {
      symlinkSync(outside, join(root, 'link'));
      expect(() => sealContextPack(pack(), { ...options(), outputDir: join(root, 'link/new-evidence') })).toThrow(expect.objectContaining({ code: 'output_symlink' }));
      expect(existsSync(join(outside, 'new-evidence'))).toBe(false);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });
});
