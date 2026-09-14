import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildVolumeContextPack, sealContextPack, spatialBytesHash, type SpatialCameraPose } from '../src/vision/spatial/context-pack.js';
import { proposeSpatialEdit } from '../src/vision/spatial/edit-proposal.js';
import { verifySignature } from '../src/utils/receipts.js';

let root: string;
const camera: SpatialCameraPose = { frameId: 'fixture', units: 'mm', provenance: 'generated', projection: 'perspective', position: [140, -150, 115], target: [0, 0, 0], up: [0, 0, 1], verticalFovDegrees: 50 };
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'timmy-edit-proposal-')); cpSync('studio/spatial-volume-20260912/grid10', join(root, 'grid10'), { recursive: true }); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
const options = () => ({ outputDir: join(root, 'C4'), receiptDir: root, sourceRoot: root });
function setup() { const documentPath = join(root, 'grid10/manifest.json'), pack = buildVolumeContextPack(documentPath, { camera, sourceRoot: root }), seal = sealContextPack(pack, options()); return { documentPath, pack, seal }; }
const change = { path: '/construction/boxSideMm', before: 80, after: 82 };

describe('C4 sealed edit proposals with authoritative local freshness', () => {
  it('reads the bound document directly and seals a dry-run diff without writing that document', () => {
    const { documentPath, pack, seal } = setup(), before = readFileSync(documentPath);
    const proposed = proposeSpatialEdit(seal, { documentPath, objectId: 'volume', changes: [change] }, options());
    expect(proposed.result.status).toBe('proposed'); expect(proposed.result.freshness).toMatchObject({ basis: 'direct-authoritative-local-byte-read', readPerformed: true, observedRevision: pack.sourceRevision, leaseHeld: false });
    expect(proposed.result.dryRun).toMatchObject({ diff: [change], requiresGeometryRebuild: true, documentWritten: false });
    expect(proposed.result.dryRun.proposedDocumentSha256).toMatch(/^[a-f0-9]{64}$/); expect(readFileSync(documentPath)).toEqual(before);
    expect(proposed.receipt.kind).toBe('edit.proposal'); expect(verifySignature(proposed.receipt)).toBe(true);
    expect(spatialBytesHash(readFileSync(join(root, proposed.artifact.path)))).toBe(proposed.artifact.sha256);
  });
  it('seals stale revision refusal despite a caller supplying the expected revision string', () => {
    const { documentPath, pack, seal } = setup(), changed = JSON.parse(readFileSync(documentPath, 'utf8')); changed.construction.boxSideMm = 90; writeFileSync(documentPath, JSON.stringify(changed));
    const before = readFileSync(documentPath), request = { documentPath, objectId: 'volume', changes: [change], revision: pack.sourceRevision };
    const refused = proposeSpatialEdit(seal, request, options());
    expect(refused.result.status).toBe('refused'); expect(refused.result.reason).toBe('stale_source_revision'); expect(refused.result.freshness.observedRevision).toBe(spatialBytesHash(before));
    expect(refused.result.dryRun.diff).toEqual([]); expect(refused.result.dryRun.proposedDocumentSha256).toBeNull(); expect(readFileSync(documentPath)).toEqual(before);
    expect(refused.receipt.status).toBe('denied'); expect(verifySignature(refused.receipt)).toBe(true);
  });
  it('does not accept old copied bytes as an authoritative document identity', () => {
    const { documentPath, seal } = setup(), copy = join(root, 'old-copy.json'); copyFileSync(documentPath, copy);
    const refused = proposeSpatialEdit(seal, { documentPath: copy, objectId: 'volume', changes: [change] }, options());
    expect(refused.result.reason).toBe('wrong_document_authority'); expect(refused.result.freshness.readPerformed).toBe(false); expect(refused.result.freshness.basis).toBe('not-read');
  });
  it('refuses unsupported, conflicting, nonfinite and invalid construction changes without document writes', () => {
    const { documentPath, seal } = setup(), before = readFileSync(documentPath);
    for (const changes of [[{ ...change, path: '/__proto__/polluted' }], [{ ...change, path: '/grid/cellSize/0' }], [{ ...change, before: 70 }], [{ ...change, after: Infinity }], [{ ...change, after: 10 }], [change, change], [{ ...change, after: 80 }]]) {
      const result = proposeSpatialEdit(seal, { documentPath, objectId: 'volume', changes }, options()); expect(result.result.status).toBe('refused'); expect(result.result.dryRun.diff).toEqual([]);
    }
    expect(readFileSync(documentPath)).toEqual(before);
  });
});
