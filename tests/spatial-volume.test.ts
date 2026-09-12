import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatVolumeReport, inspectVolume, lookupVolumeCell, validateVolumeCells, validateVolumeManifest, type VolumeManifest, type VolumeCells } from '../src/vision/spatial/volume.js';
import { readVolumePackage, runVolumeCli } from '../src/vision/spatial/volume-cli.js';

let directory: string;
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
function manifest(): VolumeManifest {
  return { schema: 'timmy.spatial-volume/1', id: 'test-volume', grid: { frameId: 'part', units: 'mm', origin: [100, 200, 300], basis: [[0, 1, 0], [-1, 0, 0], [0, 0, 1]], dimensions: [2, 1, 2], cellSize: [2, 4, 6] }, fill: { status: 'sampled', method: 'regular-subcell-centers', samplesPerAxis: 2 }, material: { status: 'unknown' }, density: { status: 'unknown' }, artifacts: { cells: { path: 'cells.json', bytes: 1, sha256: '0'.repeat(64) } } };
}
function cells(): VolumeCells { return { schema: 'timmy.spatial-volume.cells/1', order: 'x-fastest', fractions: [0, .5, null, 1] }; }
function writePackage(m = manifest(), c = cells()) {
  const json = JSON.stringify(c); writeFileSync(join(directory, 'cells.json'), json);
  m.artifacts.cells = { path: 'cells.json', bytes: Buffer.byteLength(json), sha256: hash(json) };
  const path = join(directory, 'manifest.json'); writeFileSync(path, JSON.stringify(m)); return path;
}
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'timmy-volume-')); });
afterEach(() => { vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }); });

describe('bounded spatial volume meaning', () => {
  it('uses column-basis coordinates and x-fastest indexing for a nonsymmetric rotated grid', () => {
    const m = validateVolumeManifest(manifest()), c = validateVolumeCells(cells(), m), cell = lookupVolumeCell(m, c, [1, 0, 1]);
    expect(cell.flatIndex).toBe(3); expect(cell.location.center).toEqual([98, 203, 309]); expect(cell.fill).toMatchObject({ status: 'sampled', fraction: 1 });
    expect(lookupVolumeCell(m, c, [0, 0, 1])).toMatchObject({ location: { status: 'known' }, fill: { status: 'unknown' } });
    expect(() => lookupVolumeCell(m, c, [2, 0, 1])).toThrow(/outside/);
  });
  it('accounts for unknown, empty and partial cells independently and refuses a complete-volume claim', () => {
    const m = validateVolumeManifest(manifest()), c = validateVolumeCells(cells(), m), report = inspectVolume(m, c);
    expect(report.coverage).toMatchObject({ total: 4, knownLocations: 4, fill: { unknown: 1, sampled: 3, empty: 1, partial: 1, full: 1 } });
    expect(report.volume).toMatchObject({ accountedFilledVolume: 72, unknownCapacity: 48, completeEstimate: null, exact: false });
    expect(report.scope.outsideDomain).toBe('unknown');
  });
  it('keeps material and intrinsic density independent, including a declared zero density', () => {
    const m = manifest(), c = cells();
    c.overrides = [{ ijk: [1, 0, 0], material: { status: 'declared', id: 'polymer', source: 'operator assignment' } }, { ijk: [1, 0, 1], density: { status: 'declared', value: 0, unit: 'kg/m3', basis: 'occupied-material', source: 'idealized vacuum' } }];
    const valid = validateVolumeCells(c, validateVolumeManifest(m)), report = inspectVolume(m, valid);
    expect(report.coverage.material).toEqual({ unknown: 3, declared: 1, measured: 0 }); expect(report.coverage.density).toEqual({ unknown: 3, declared: 1, measured: 0 });
    expect(lookupVolumeCell(m, valid, [1, 0, 0]).density.status).toBe('unknown');
    expect(lookupVolumeCell(m, valid, [1, 0, 1]).material.status).toBe('unknown');
    expect(lookupVolumeCell(m, valid, [1, 0, 1]).density).toMatchObject({ value: 0, basis: 'occupied-material' });
  });
  it('never promotes appearance references to fill, material, density or authenticated evidence', () => {
    const m = manifest(); m.references = [{ id: 'copper-looking', kind: 'appearance', uri: 'https://example.invalid/copper.jpg' }];
    const checked = validateVolumeManifest(m), report = inspectVolume(checked, validateVolumeCells(cells(), checked));
    expect(report.references).toEqual({ count: 1, role: 'suggestions-only' });
    expect(report.coverage.material.unknown).toBe(4); expect(report.coverage.density.unknown).toBe(4);
    expect(report.scope).toMatchObject({ authenticatedProducer: false, physicalValidation: false, nativeVolumeRead: false, artifactVerification: 'not-checked' });
  });
  it.each([NaN, Infinity, -Infinity, -.1, 1.1, '0', undefined])('rejects malformed fill %s', value => {
    const c = cells(); c.fractions[1] = value as number;
    expect(() => validateVolumeCells(c, manifest())).toThrow();
  });
  it('rejects missing and duplicate coverage instead of silently filling or picking a winner', () => {
    for (const fractions of [[0], new Array(4), [0, 0, 0, 0, 0]]) expect(() => validateVolumeCells({ ...cells(), fractions }, manifest())).toThrow();
    const c = cells(); c.overrides = [{ ijk: [0, 0, 0], material: { status: 'unknown' } }, { ijk: [0, 0, 0], density: { status: 'unknown' } }];
    expect(() => validateVolumeCells(c, manifest())).toThrow(/only one/);
  });
  it('rejects ambiguous property states and invalid physical density', () => {
    for (const value of [{ status: 'unknown', value: 0 }, { status: 'measured', value: -1, unit: 'kg/m3', basis: 'occupied-material', source: 'sensor' }, { status: 'declared', value: 1, unit: 'kg/m3', source: 'catalog' }, { status: 'declared', value: NaN, unit: 'kg/m3', basis: 'occupied-material', source: 'catalog' }]) expect(() => validateVolumeManifest({ ...manifest(), density: value })).toThrow();
    expect(() => validateVolumeManifest({ ...manifest(), material: { status: 'unknown', id: 'copper' } })).toThrow();
    expect(() => validateVolumeManifest({ ...manifest(), material: { status: 'measured', id: 'copper' } })).toThrow();
  });
  it('rejects unsupported units, left-handed/sheared frames, overflow, degenerate and huge domains', () => {
    const m = manifest();
    for (const patch of [{ units: 'px' }, { cellSize: [0, 1, 1] }, { cellSize: [1e308, 1e308, 1] }, { cellSize: [1e-300, 1e-300, 1e-300] }, { dimensions: [0, 2, 2] }, { dimensions: [1.5, 2, 2] }, { dimensions: [1001, 1000, 1] }, { origin: [Infinity, 0, 0] }, { basis: [[1, 0, 0], [0, 1, 0], [0, 0, -1]] }, { basis: [[1, 0, 0], [1, 1, 0], [0, 0, 1]] }]) expect(() => validateVolumeManifest({ ...m, grid: { ...m.grid, ...patch } })).toThrow();
  });
  it('rejects collapsed world locations after large translation, including rotated bases', () => {
    const m = manifest();
    const axisAligned = { ...m.grid, origin: [1e20, 0, 0], dimensions: [10, 1, 1], cellSize: [1, 1, 1], basis: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] };
    expect(1e20 + .5).toBe(1e20 + 9.5);
    expect(() => validateVolumeManifest({ ...m, grid: axisAligned })).toThrow(expect.objectContaining({ code: 'unresolvable_grid_precision' }));
    const q = Math.SQRT1_2;
    const rotated = { ...axisAligned, origin: [1e20, 1e20, 0], basis: [[q, q, 0], [-q, q, 0], [0, 0, 1]] };
    expect(() => validateVolumeManifest({ ...m, grid: rotated })).toThrow(expect.objectContaining({ code: 'unresolvable_grid_precision' }));
    expect(() => validateVolumeManifest({ ...m, grid: { ...rotated, origin: [0, 0, 0] } })).not.toThrow();
  });
  it('preserves resolvable large, tiny and anisotropic grids without conflating unrelated axes', () => {
    const m = manifest();
    for (const size of [1e-90, 1e90]) {
      const checked = validateVolumeManifest({ ...m, grid: { ...m.grid, origin: [0, 0, 0], dimensions: [2, 1, 1], cellSize: [size, size, size], basis: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] } });
      const values = validateVolumeCells({ ...cells(), fractions: [1, 1] }, checked);
      expect(lookupVolumeCell(checked, values, [0, 0, 0]).location.center[0]).not.toBe(lookupVolumeCell(checked, values, [1, 0, 0]).location.center[0]);
      const report = inspectVolume(checked, values); expect(report.volume.completeEstimate).toBeGreaterThan(0); expect(Number.isFinite(report.volume.completeEstimate)).toBe(true);
    }
    const checked = validateVolumeManifest({ ...m, grid: { ...m.grid, origin: [0, 0, 0], dimensions: [2, 1, 1], cellSize: [1, 1e20, 1], basis: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] } });
    const values = validateVolumeCells({ ...cells(), fractions: [1, 1] }, checked);
    expect(lookupVolumeCell(checked, values, [0, 0, 0]).location.center).toEqual([.5, 5e19, .5]);
    expect(lookupVolumeCell(checked, values, [1, 0, 0]).location.center).toEqual([1.5, 5e19, .5]);
  });
  it('rejects physical-volume underflow, total-volume overflow, and nonzero fill becoming zero', () => {
    const m = manifest();
    expect(Math.pow(1e-106, 3)).toBeGreaterThan(0);
    expect(() => validateVolumeManifest({ ...m, grid: { ...m.grid, origin: [0, 0, 0], cellSize: [1e-106, 1e-106, 1e-106] } })).toThrow(expect.objectContaining({ code: 'invalid_cell_size' }));
    expect(() => validateVolumeManifest({ ...m, grid: { ...m.grid, origin: [0, 0, 0], dimensions: [1000000, 1, 1], cellSize: [1e103, 1e100, 1e100] } })).toThrow(expect.objectContaining({ code: 'invalid_cell_size' }));
    const checked = validateVolumeManifest({ ...m, grid: { ...m.grid, origin: [0, 0, 0], cellSize: [1e-90, 1e-90, 1e-90] } });
    expect(() => validateVolumeCells({ ...cells(), fractions: [1e-90, 0, null, 1] }, checked)).toThrow(expect.objectContaining({ code: 'unresolvable_fill_volume' }));
  });
  it('preserves a CSG boundary field without describing it as exact distance', () => {
    const m = manifest(); m.boundary = { representation: 'csg-implicit', exactDistance: false, description: 'Boolean field with correct sign.' };
    const c = { ...cells(), boundaryField: [0, 1, null, -1] }, checked = validateVolumeCells(c, validateVolumeManifest(m));
    expect(lookupVolumeCell(m, checked, [0, 0, 0]).boundary).toMatchObject({ value: 0, exactDistance: false });
    expect(() => validateVolumeManifest({ ...m, boundary: { ...m.boundary, exactDistance: true } })).toThrow();
    expect(() => validateVolumeCells({ ...c, boundaryField: [1] }, m)).toThrow();
    expect(() => validateVolumeCells(c, manifest())).toThrow();
  });
  it('rejects terminal controls and traversal at manifest admission', () => {
    expect(() => validateVolumeManifest({ ...manifest(), id: '\u001b[2J' })).toThrow();
    for (const path of ['../secret', '/etc/passwd', 'nested/../../secret', 'C:\\secret', 'https://example.com/data', './cells.json']) expect(() => validateVolumeManifest({ ...manifest(), artifacts: { cells: { path, sha256: 'a'.repeat(64), bytes: 1 } } })).toThrow();
  });
});

describe('read-only volume CLI', () => {
  it('emits a shared terminal and JSON projection, verifies bytes and performs no network or writes', async () => {
    const path = writePackage(), before = readdirSync(directory), fetcher = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network'));
    const text: string[] = [], json: string[] = [];
    expect(await runVolumeCli(['inspect', path, '--cell', '1,0,1'], s => text.push(s))).toBe(0);
    expect(await runVolumeCli(['inspect', path, '--cell', '1,0,1', '--json'], s => json.push(s))).toBe(0);
    const report = JSON.parse(json[0]); expect(text[0]).toBe(formatVolumeReport(report));
    expect(report.cell.location.center).toEqual([98, 203, 309]); expect(report.verification.manifestSha256).toBe(hash(readFileSync(path)));
    expect(report.scope).toMatchObject({ nativeVolumeRead: false, physicalValidation: false, artifactVerification: 'sha256-bytes-checked' });
    expect(fetcher).not.toHaveBeenCalled(); expect(readdirSync(directory)).toEqual(before);
  });
  it('checks native artifact bytes without claiming native parsing or source authentication', () => {
    const native = Buffer.from('not actually an OpenVDB file'), m = manifest(); writeFileSync(join(directory, 'fixture.vdb'), native);
    m.artifacts.native = { path: 'fixture.vdb', bytes: native.length, sha256: hash(native) };
    const report = readVolumePackage(writePackage(m));
    expect(report.verification.nativeArtifactParsed).toBe(false); expect(report.verification.producerAuthenticated).toBe(false);
    expect(report.verification.artifacts.native.sha256).toBe(hash(native));
  });
  it('rejects corrupted evidence and omits its contents from the failure response', async () => {
    const path = writePackage(); writeFileSync(join(directory, 'cells.json'), 'private corrupt content');
    const output: string[] = []; expect(await runVolumeCli(['inspect', path], s => output.push(s))).toBe(1);
    expect(output[0]).toContain('artifact_mismatch'); expect(output[0]).not.toContain('private corrupt content');
  });
  it('rejects symlink escapes even when the external bytes match the declared hash', async () => {
    const outside = join(directory, '..', `outside-${directory.split('/').at(-1)}.json`), data = JSON.stringify(cells());
    try { writeFileSync(outside, data); symlinkSync(outside, join(directory, 'linked.json')); const m = manifest(); m.artifacts.cells = { path: 'linked.json', bytes: Buffer.byteLength(data), sha256: hash(data) }; const path = join(directory, 'manifest.json'); writeFileSync(path, JSON.stringify(m)); const result: string[] = []; expect(await runVolumeCli(['inspect', path], s => result.push(s))).toBe(1); expect(result[0]).toContain('artifact_escape'); }
    finally { rmSync(outside, { force: true }); }
  });
  it('rejects malformed, duplicate and out-of-domain command options', async () => {
    const path = writePackage();
    for (const options of [['--execute'], ['--json', '--json'], ['--cell'], ['--cell', '-1,0,0'], ['--cell', '0,0,1.2'], ['--cell', '0,0,0', '--cell', '0,0,0']]) expect(await runVolumeCli(['inspect', path, ...options], () => {})).toBe(2);
    expect(await runVolumeCli(['inspect', path, '--cell', '100,0,0'], () => {})).toBe(1);
  });
});
