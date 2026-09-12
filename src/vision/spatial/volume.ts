/** Pure bounded-volume semantics. No filesystem, network, native runtime or receipt access. */
export type VolumeVec3 = [number, number, number];
export type VolumeProperty = { status: 'unknown' } | { status: 'declared' | 'measured'; id: string; source: string };
export type VolumeDensity = { status: 'unknown' } | { status: 'declared' | 'measured'; value: number; unit: 'kg/m3'; basis: 'occupied-material'; source: string };
export interface VolumeArtifact { path: string; sha256: string; bytes: number }
export interface VolumeManifest {
  schema: 'timmy.spatial-volume/1'; id: string;
  grid: { frameId: string; units: 'mm' | 'cm' | 'm'; origin: VolumeVec3; basis: [VolumeVec3, VolumeVec3, VolumeVec3]; dimensions: VolumeVec3; cellSize: VolumeVec3 };
  fill: { status: 'sampled' | 'declared'; method: string; samplesPerAxis?: number };
  material: VolumeProperty; density: VolumeDensity;
  boundary?: { representation: 'csg-implicit' | 'signed-distance'; exactDistance: boolean; description: string };
  references?: { id: string; kind: 'shape' | 'appearance' | 'material'; uri: string }[];
  artifacts: { cells: VolumeArtifact; native?: VolumeArtifact; mesh?: VolumeArtifact; obj?: VolumeArtifact; roundtrip?: VolumeArtifact };
}
export interface VolumeCells {
  schema: 'timmy.spatial-volume.cells/1'; order: 'x-fastest'; fractions: (number | null)[];
  boundaryField?: (number | null)[];
  overrides?: { ijk: VolumeVec3; material?: VolumeProperty; density?: VolumeDensity }[];
}
export const MAX_VOLUME_CELLS = 1_000_000;
export class VolumeValidationError extends Error { constructor(public code: string, message: string) { super(message); this.name = 'VolumeValidationError'; } }
function fail(code: string, message: string): never { throw new VolumeValidationError(code, message); }
function object(v: unknown, label: string): Record<string, unknown> { if (!v || typeof v !== 'object' || Array.isArray(v)) fail('invalid_object', `${label} must be an object.`); return v as Record<string, unknown>; }
function str(v: unknown, label: string, max = 512): string { if (typeof v !== 'string' || !v.trim() || v.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(v)) fail('invalid_string', `${label} must be nonempty text without control characters.`); return v; }
function finite(v: unknown, label: string): number { if (typeof v !== 'number' || !Number.isFinite(v)) fail('invalid_number', `${label} must be finite.`); return v; }
function vec(v: unknown, label: string): VolumeVec3 { if (!Array.isArray(v) || v.length !== 3) fail('invalid_vector', `${label} must have three values.`); return [0, 1, 2].map(i => finite(v[i], label)) as VolumeVec3; }
function ownKeys(v: Record<string, unknown>, allowed: string[], label: string) { if (Object.keys(v).some(k => !allowed.includes(k))) fail('conflicting_property', `${label} contains unsupported or conflicting fields.`); }
function material(v: unknown): VolumeProperty {
  const p = object(v, 'material');
  if (p.status === 'unknown') { ownKeys(p, ['status'], 'unknown material'); return { status: 'unknown' }; }
  if (p.status !== 'declared' && p.status !== 'measured') fail('invalid_material', 'Material status must be unknown, declared or measured.');
  ownKeys(p, ['status', 'id', 'source'], 'material');
  return { status: p.status, id: str(p.id, 'material id'), source: str(p.source, 'material source') };
}
function density(v: unknown): VolumeDensity {
  const p = object(v, 'density');
  if (p.status === 'unknown') { ownKeys(p, ['status'], 'unknown density'); return { status: 'unknown' }; }
  if (p.status !== 'declared' && p.status !== 'measured') fail('invalid_density', 'Density status must be unknown, declared or measured.');
  ownKeys(p, ['status', 'value', 'unit', 'basis', 'source'], 'density');
  const value = finite(p.value, 'density value');
  if (value < 0 || p.unit !== 'kg/m3' || p.basis !== 'occupied-material') fail('invalid_density', 'Density must be nonnegative, use kg/m3, and describe occupied material.');
  return { status: p.status, value, unit: 'kg/m3', basis: 'occupied-material', source: str(p.source, 'density source') };
}
function artifact(v: unknown): VolumeArtifact {
  const a = object(v, 'artifact'), path = str(a.path, 'artifact path');
  if (path.startsWith('/') || /[\\:]/u.test(path) || path.split('/').some(p => !p || p === '.' || p === '..')) fail('unsafe_artifact_path', 'Artifact paths must remain relative to the manifest directory.');
  if (typeof a.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(a.sha256)) fail('invalid_digest', 'Artifact SHA-256 must be lowercase hexadecimal.');
  const bytes = finite(a.bytes, 'artifact bytes');
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > 256 * 1024 * 1024) fail('invalid_artifact_size', 'Artifact byte length is outside the bounded range.');
  return { path, sha256: a.sha256, bytes };
}
export function validateVolumeManifest(input: unknown): VolumeManifest {
  const m = object(input, 'manifest');
  if (m.schema !== 'timmy.spatial-volume/1') fail('invalid_schema', 'Unsupported volume manifest schema.');
  const g = object(m.grid, 'grid'), origin = vec(g.origin, 'origin'), dimensions = vec(g.dimensions, 'dimensions'), cellSize = vec(g.cellSize, 'cellSize');
  if (!['mm', 'cm', 'm'].includes(String(g.units))) fail('invalid_units', 'Grid units must be mm, cm or m.');
  if (dimensions.some(n => !Number.isSafeInteger(n) || n < 1) || dimensions.reduce((a, b) => a * b, 1) > MAX_VOLUME_CELLS) fail('invalid_dimensions', 'The grid must contain between one and one million cells.');
  const cellVolume = cellSize.reduce((a, b) => a * b, 1), regionVolume = cellVolume * dimensions.reduce((a, b) => a * b, 1);
  const cubicMetersPerUnit = g.units === 'mm' ? 1e-9 : g.units === 'cm' ? 1e-6 : 1;
  if (cellSize.some(n => n <= 0) || cellVolume <= 0 || !Number.isFinite(regionVolume) || cellVolume * cubicMetersPerUnit <= 0 || !Number.isFinite(regionVolume * cubicMetersPerUnit)) fail('invalid_cell_size', 'Cell and region volumes must remain positive and finite in declared units and cubic metres.');
  if (!Array.isArray(g.basis) || g.basis.length !== 3) fail('invalid_basis', 'The basis must contain three column vectors.');
  const basis = g.basis.map((v, i) => vec(v, `basis ${i}`)) as [VolumeVec3, VolumeVec3, VolumeVec3];
  const dot = (a: number[], b: number[]) => a.reduce((s, n, i) => s + n * b[i], 0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (Math.abs(dot(basis[i], basis[j]) - (i === j ? 1 : 0)) > 1e-9) fail('invalid_basis', 'The basis must be orthonormal.');
  const [a, b, c] = basis, det = a[0] * (b[1] * c[2] - b[2] * c[1]) - b[0] * (a[1] * c[2] - a[2] * c[1]) + c[0] * (a[1] * b[2] - a[2] * b[1]);
  if (Math.abs(det - 1) > 1e-9) fail('invalid_basis', 'Version 1 requires an explicit right-handed basis.');
  for (let mask = 0; mask < 8; mask++) for (let axis = 0; axis < 3; axis++) if (!Number.isFinite(origin[axis] + basis.reduce((s, column, j) => s + column[axis] * dimensions[j] * cellSize[j] * ((mask >> j) & 1), 0))) fail('coordinate_overflow', 'Grid coordinates overflow.');
  // Bound rounding across the entire region, including cancellation after rotation.
  // Project the world-coordinate error back onto each grid axis so an unrelated
  // long axis does not reject a thin axis that still has representable coordinates.
  const coordinateError = origin.map((n, axis) => {
    const magnitude = Math.abs(n) + basis.reduce((sum, column, j) => sum + Math.abs(column[axis]) * dimensions[j] * cellSize[j], 0);
    return Math.max(8 * Number.MIN_VALUE, 8 * Number.EPSILON * magnitude);
  });
  for (let axis = 0; axis < 3; axis++) {
    const projectedError = basis[axis].reduce((sum, component, worldAxis) => sum + Math.abs(component) * coordinateError[worldAxis], 0);
    if (!Number.isFinite(projectedError) || cellSize[axis] <= 4 * projectedError) fail('unresolvable_grid_precision', 'The world frame cannot reliably distinguish this grid at its declared cell size; use a closer local origin or larger cells.');
  }
  const f = object(m.fill, 'fill');
  if (f.status !== 'sampled' && f.status !== 'declared') fail('invalid_fill', 'Fill basis must be sampled or declared; null cells remain unknown.');
  const fill: VolumeManifest['fill'] = { status: f.status, method: str(f.method, 'fill method') };
  if (f.samplesPerAxis !== undefined) {
    const samples = finite(f.samplesPerAxis, 'samplesPerAxis');
    if (f.status !== 'sampled' || !Number.isSafeInteger(samples) || samples < 1 || samples > 64) fail('invalid_sampling', 'samplesPerAxis requires sampled fill and an integer from 1 to 64.');
    fill.samplesPerAxis = samples;
  }
  if (fill.method === 'regular-subcell-centers' && fill.samplesPerAxis === undefined) fail('invalid_sampling', 'Regular subcell sampling requires samplesPerAxis.');
  const artifacts = object(m.artifacts, 'artifacts');
  ownKeys(artifacts, ['cells', 'native', 'mesh', 'obj', 'roundtrip'], 'artifacts');
  const result: VolumeManifest = { schema: m.schema, id: str(m.id, 'id'), grid: { frameId: str(g.frameId, 'frameId'), units: g.units as VolumeManifest['grid']['units'], origin, dimensions, cellSize, basis }, fill, material: material(m.material), density: density(m.density), artifacts: { cells: artifact(artifacts.cells) } };
  for (const key of ['native', 'mesh', 'obj', 'roundtrip'] as const) if (artifacts[key] !== undefined) result.artifacts[key] = artifact(artifacts[key]);
  if (m.boundary !== undefined) {
    const p = object(m.boundary, 'boundary');
    if (!['csg-implicit', 'signed-distance'].includes(String(p.representation)) || typeof p.exactDistance !== 'boolean' || (p.representation === 'csg-implicit' && p.exactDistance)) fail('invalid_boundary', 'CSG implicit fields must not claim exact signed distance.');
    result.boundary = { representation: p.representation as 'csg-implicit' | 'signed-distance', exactDistance: p.exactDistance, description: str(p.description, 'boundary description') };
  }
  if (m.references !== undefined) {
    if (!Array.isArray(m.references) || m.references.length > 1000) fail('invalid_references', 'References must be a bounded list.');
    const seen = new Set<string>();
    result.references = m.references.map(v => { const p = object(v, 'reference'), id = str(p.id, 'reference id'); if (seen.has(id) || !['shape', 'appearance', 'material'].includes(String(p.kind))) fail('invalid_reference', 'Reference identities must be unique and kinds supported.'); seen.add(id); return { id, kind: p.kind as 'shape' | 'appearance' | 'material', uri: str(p.uri, 'reference URI', 2048) }; });
  }
  return result;
}
function flatIndex(m: VolumeManifest, ijk: VolumeVec3): number { const d = m.grid.dimensions; if (ijk.some((v, i) => !Number.isSafeInteger(v) || v < 0 || v >= d[i])) fail('cell_outside_domain', 'Cell address is outside the bounded grid.'); return ijk[0] + d[0] * (ijk[1] + d[1] * ijk[2]); }
export function validateVolumeCells(input: unknown, manifest: VolumeManifest): VolumeCells {
  const c = object(input, 'cells'), count = manifest.grid.dimensions.reduce((a, b) => a * b, 1);
  if (c.schema !== 'timmy.spatial-volume.cells/1' || c.order !== 'x-fastest') fail('invalid_cells_schema', 'Cells require version 1 and x-fastest order.');
  if (!Array.isArray(c.fractions) || c.fractions.length !== count) fail('incomplete_coverage', 'Every bounded location needs one fraction or an explicit null.');
  const cellVolume = manifest.grid.cellSize.reduce((a, b) => a * b, 1), cellVolumeM3 = cellVolume * (manifest.grid.units === 'mm' ? 1e-9 : manifest.grid.units === 'cm' ? 1e-6 : 1);
  const fractions = Array.from(c.fractions, v => { if (v === null) return null; const n = finite(v, 'fill fraction'); if (n < 0 || n > 1) fail('invalid_fraction', 'Fill fraction must be between zero and one.'); if (n > 0 && (n * cellVolume <= 0 || n * cellVolumeM3 <= 0)) fail('unresolvable_fill_volume', 'A nonzero fill volume underflows in declared units or cubic metres.'); return n; });
  const result: VolumeCells = { schema: c.schema, order: c.order, fractions };
  if (c.boundaryField !== undefined) {
    if (!manifest.boundary || !Array.isArray(c.boundaryField) || c.boundaryField.length !== count) fail('invalid_boundary_coverage', 'A boundary field requires its declaration and complete cell coverage.');
    result.boundaryField = Array.from(c.boundaryField, v => v === null ? null : finite(v, 'boundary field'));
  }
  if (c.overrides !== undefined) {
    if (!Array.isArray(c.overrides) || c.overrides.length > count) fail('invalid_overrides', 'Cell property overrides must be a bounded list.');
    const seen = new Set<number>();
    result.overrides = c.overrides.map(v => { const o = object(v, 'override'); ownKeys(o, ['ijk', 'material', 'density'], 'override'); const ijk = vec(o.ijk, 'override address'), index = flatIndex(manifest, ijk); if (seen.has(index)) fail('conflicting_override', 'A cell may have only one property override.'); seen.add(index); if (o.material === undefined && o.density === undefined) fail('empty_override', 'A cell override must name a property.'); return { ijk, ...(o.material !== undefined ? { material: material(o.material) } : {}), ...(o.density !== undefined ? { density: density(o.density) } : {}) }; });
  }
  return result;
}
export function lookupVolumeCell(manifest: VolumeManifest, cells: VolumeCells, address: VolumeVec3) {
  const ijk = vec(address, 'cell address'), index = flatIndex(manifest, ijk), fraction = cells.fractions[index];
  if (fraction === undefined) fail('incomplete_coverage', 'Cell coverage is missing.');
  const { origin, basis, cellSize } = manifest.grid;
  const center = origin.map((n, axis) => n + basis.reduce((s, column, j) => s + column[axis] * (ijk[j] + .5) * cellSize[j], 0)) as VolumeVec3;
  const override = cells.overrides?.find(o => o.ijk.every((v, i) => v === ijk[i]));
  return { ijk, flatIndex: index, location: { status: 'known' as const, center, frameId: manifest.grid.frameId, units: manifest.grid.units }, fill: fraction === null ? { status: 'unknown' as const } : { status: manifest.fill.status, fraction, method: manifest.fill.method }, material: override?.material ?? manifest.material, density: override?.density ?? manifest.density, boundary: cells.boundaryField?.[index] == null ? { status: 'unknown' as const } : { status: 'sampled' as const, value: cells.boundaryField[index], units: manifest.grid.units, representation: manifest.boundary!.representation, exactDistance: manifest.boundary!.exactDistance } };
}
export function inspectVolume(manifest: VolumeManifest, cells: VolumeCells, address?: VolumeVec3) {
  const total = manifest.grid.dimensions.reduce((a, b) => a * b, 1);
  const fill = { unknown: 0, sampled: 0, declared: 0, empty: 0, partial: 0, full: 0 };
  let fractionalSum = 0;
  for (const value of cells.fractions) { if (value === null) fill.unknown++; else { fill[manifest.fill.status]++; fractionalSum += value; if (value === 0) fill.empty++; else if (value === 1) fill.full++; else fill.partial++; } }
  if (fill.unknown + fill.sampled + fill.declared !== total) fail('incomplete_coverage', 'Cell coverage does not match the declared region.');
  const materialCoverage = { unknown: 0, declared: 0, measured: 0 }, densityCoverage = { unknown: 0, declared: 0, measured: 0 };
  materialCoverage[manifest.material.status] = total; densityCoverage[manifest.density.status] = total;
  for (const override of cells.overrides ?? []) { if (override.material) { materialCoverage[manifest.material.status]--; materialCoverage[override.material.status]++; } if (override.density) { densityCoverage[manifest.density.status]--; densityCoverage[override.density.status]++; } }
  const cellVolume = manifest.grid.cellSize.reduce((a, b) => a * b, 1);
  return { schema: 'timmy.spatial-volume-report/1' as const, id: manifest.id, grid: manifest.grid, coverage: { total, knownLocations: total, fill, material: materialCoverage, density: densityCoverage }, volume: { unit: `${manifest.grid.units}3`, accountedFilledVolume: fractionalSum * cellVolume, unknownCapacity: fill.unknown * cellVolume, completeEstimate: fill.unknown === 0 ? fractionalSum * cellVolume : null, method: manifest.fill.method, exact: false }, references: { count: manifest.references?.length ?? 0, role: 'suggestions-only' as const }, scope: { artifactVerification: 'not-checked' as string, nativeVolumeRead: false, authenticatedProducer: false, physicalValidation: false, outsideDomain: 'unknown' as const, propertyStatuses: 'source-reported; declarations and measurements require separate provenance review' }, ...(address ? { cell: lookupVolumeCell(manifest, cells, address) } : {}) };
}
export type VolumeReport = ReturnType<typeof inspectVolume>;
export function formatVolumeReport(report: VolumeReport): string {
  const { fill, material: m, density: d } = report.coverage;
  const lines = [`TIMMY / SPATIAL VOLUME / ${report.id}`, `Frame ${report.grid.frameId} · ${report.grid.units} · ${report.grid.dimensions.join(' × ')} cells`, `Location: ${report.coverage.knownLocations}/${report.coverage.total} addressed; outside domain: unknown`, `Fill: ${fill.sampled} sampled · ${fill.declared} declared · ${fill.unknown} unknown`, `       ${fill.empty} empty · ${fill.partial} partial · ${fill.full} full`, `Material: ${m.unknown} unknown · ${m.declared} declared · ${m.measured} source-reported measured`, `Density:  ${d.unknown} unknown · ${d.declared} declared · ${d.measured} source-reported measured`, `Filled volume estimate: ${report.volume.completeEstimate ?? 'incomplete'} ${report.volume.unit}`, `References: ${report.references.count} suggestions; no evidence promotion`, `Artifacts: ${report.scope.artifactVerification}; native volume read: no; physical validation: no`];
  if (report.cell) { const c = report.cell; lines.push('', `Cell [${c.ijk.join(', ')}] · center [${c.location.center.join(', ')}] ${c.location.units}`, `Fill: ${c.fill.status}${'fraction' in c.fill ? ` (${c.fill.fraction})` : ''}`, `Material: ${c.material.status}${'id' in c.material ? ` (${c.material.id})` : ''}`, `Density: ${c.density.status}${'value' in c.density ? ` (${c.density.value} kg/m3)` : ''}`, `Boundary: ${c.boundary.status}${'value' in c.boundary ? ` (${c.boundary.value} ${c.boundary.units}; ${c.boundary.representation}; exact distance: ${c.boundary.exactDistance})` : ''}`); }
  return lines.join('\n');
}
