import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { readVolumePackage } from './volume-cli.js';
import { validateVolumeManifest, VolumeValidationError, type VolumeVec3 } from './volume.js';

export type SpatialContextKind = 'volume' | 'spline' | 'hana' | 'point-cloud' | 'mesh' | 'gaussian-splats';
export type SpatialContextValue = null | boolean | number | string | SpatialContextValue[] | { [key: string]: SpatialContextValue };
export interface SpatialContextEntity { id: string; kind: 'volume' | 'voxel' | 'object' | 'frame' | 'mesh' | 'point-cloud' | 'gaussian-splats' | 'group' | 'shape'; label?: string; parentId?: string; ijk?: VolumeVec3; sourceObjectId?: string }
export interface SpatialContextFact { id: string; entityId: string; key: string; value: SpatialContextValue; epistemic: 'computed' | 'declared' | 'unknown'; source: { sha256: string; artifact: string; method: string } }
export interface SpatialModelContext {
  schema: 'timmy.spatial-model-context/1';
  source: { kind: SpatialContextKind; id: string; sha256: string };
  frame: { id: string; units: 'mm' | 'cm' | 'm' | 'scene-unit' | 'px'; origin?: VolumeVec3; basis?: [VolumeVec3, VolumeVec3, VolumeVec3]; dimensions?: VolumeVec3; cellSize?: VolumeVec3 };
  entities: SpatialContextEntity[]; facts: SpatialContextFact[]; limitations: string[];
}
const MAX_CONTEXT_BYTES = 64 * 1024;
function fail(code: string, message: string): never { throw new VolumeValidationError(code, message); }
function obj(v: unknown): Record<string, unknown> { if (!v || typeof v !== 'object' || Array.isArray(v)) fail('invalid_model_context', 'Context fields must be objects.'); return v as Record<string, unknown>; }
function keys(v: Record<string, unknown>, allowed: string[]) { if (Object.keys(v).some(k => !allowed.includes(k))) fail('invalid_model_context_field', 'Context contains unsupported fields.'); }
function text(v: unknown, max = 256): string { if (typeof v !== 'string' || !v.trim() || v.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(v)) fail('invalid_model_context_text', 'Context text is empty, too long, or contains control characters.'); return v; }
function id(v: unknown): string { const s = text(v, 128); if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/u.test(s)) fail('invalid_model_context_id', 'Context identifiers must use stable printable identifier characters.'); return s; }
function sha(v: unknown): string { if (typeof v !== 'string' || !/^[a-f0-9]{64}$/u.test(v)) fail('invalid_model_context_hash', 'Context sources require SHA-256 hexadecimal identity.'); return v; }
function vec(v: unknown): VolumeVec3 { if (!Array.isArray(v) || v.length !== 3 || Array.from(v).some(n => typeof n !== 'number' || !Number.isFinite(n))) fail('invalid_model_context_vector', 'Context vectors require three finite values.'); return [...v] as VolumeVec3; }
function array(v: unknown, max: number): unknown[] { if (!Array.isArray(v) || v.length > max) fail('unbounded_model_context', 'Context array exceeds its finite size limit.'); return Array.from(v); }
/** Admission for compact source packets, including separately captured native-app snapshots. */
export function validateSpatialModelContext(raw: unknown): SpatialModelContext {
  const p = obj(raw); keys(p, ['schema', 'source', 'frame', 'entities', 'facts', 'limitations']);
  if (p.schema !== 'timmy.spatial-model-context/1') fail('invalid_model_context_schema', 'Unsupported spatial model context schema.');
  const s = obj(p.source); keys(s, ['kind', 'id', 'sha256']);
  if (!['volume', 'spline', 'hana', 'point-cloud', 'mesh', 'gaussian-splats'].includes(String(s.kind))) fail('invalid_model_context_source', 'Unsupported spatial source kind.');
  const source: SpatialModelContext['source'] = { kind: s.kind as SpatialContextKind, id: id(s.id), sha256: sha(s.sha256) };
  const f = obj(p.frame); keys(f, ['id', 'units', 'origin', 'basis', 'dimensions', 'cellSize']);
  if (!['mm', 'cm', 'm', 'scene-unit', 'px'].includes(String(f.units))) fail('invalid_model_context_units', 'Spatial context units must be explicit.');
  const frame: SpatialModelContext['frame'] = { id: id(f.id), units: f.units as SpatialModelContext['frame']['units'] };
  for (const key of ['origin', 'dimensions', 'cellSize'] as const) if (f[key] !== undefined) frame[key] = vec(f[key]);
  if (f.basis !== undefined) { const columns = array(f.basis, 3); if (columns.length !== 3) fail('invalid_model_context_frame', 'A frame basis needs three columns.'); frame.basis = columns.map(vec) as [VolumeVec3, VolumeVec3, VolumeVec3]; }
  if (frame.dimensions?.some(n => !Number.isSafeInteger(n) || n < 1) || frame.cellSize?.some(n => n <= 0)) fail('invalid_model_context_frame', 'Grid dimensions and cell sizes must be positive.');
  if (source.kind === 'volume') validateVolumeManifest({ schema: 'timmy.spatial-volume/1', id: source.id, grid: { frameId: frame.id, units: frame.units, origin: frame.origin, basis: frame.basis, dimensions: frame.dimensions, cellSize: frame.cellSize }, fill: { status: 'declared', method: 'model-context-grid' }, material: { status: 'unknown' }, density: { status: 'unknown' }, artifacts: { cells: { path: 'cells.json', sha256: source.sha256, bytes: 1 } } });
  const entityIds = new Set<string>();
  const entities = array(p.entities, 16).map(value => {
    const e = obj(value); keys(e, ['id', 'kind', 'label', 'parentId', 'ijk', 'sourceObjectId']);
    const entityId = id(e.id); if (entityIds.has(entityId)) fail('duplicate_model_entity', 'Context entity identities must be unique.'); entityIds.add(entityId);
    if (!['volume', 'voxel', 'object', 'frame', 'mesh', 'point-cloud', 'gaussian-splats', 'group', 'shape'].includes(String(e.kind))) fail('invalid_model_entity_kind', 'Unsupported context entity kind.');
    const entity: SpatialContextEntity = { id: entityId, kind: e.kind as SpatialContextEntity['kind'] };
    if (e.label !== undefined) entity.label = text(e.label, 160);
    if (e.parentId !== undefined) entity.parentId = id(e.parentId);
    if (e.sourceObjectId !== undefined) entity.sourceObjectId = text(e.sourceObjectId, 160);
    if (e.ijk !== undefined) { entity.ijk = vec(e.ijk); if (entity.ijk.some((n, axis) => !Number.isSafeInteger(n) || n < 0 || (frame.dimensions && n >= frame.dimensions[axis]))) fail('invalid_model_cell', 'Voxel indices must be within the declared grid.'); }
    return entity;
  });
  if (!entities.length) fail('missing_model_entities', 'A context needs at least one source entity.');
  const entityById = new Map(entities.map(e => [e.id, e]));
  for (const entity of entities) {
    const seen = new Set([entity.id]); let parent = entity.parentId;
    while (parent) { if (!entityIds.has(parent) || seen.has(parent)) fail('invalid_model_hierarchy', 'Entity parents must exist and form an acyclic hierarchy.'); seen.add(parent); parent = entityById.get(parent)!.parentId; }
  }
  let valueNodes = 0;
  function value(v: unknown, depth = 0): SpatialContextValue {
    if (++valueNodes > 1024 || depth > 4) fail('unbounded_model_values', 'Context values exceed their finite nesting limit.');
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'number') { if (!Number.isFinite(v)) fail('invalid_model_number', 'Context numbers must be finite.'); return v; }
    if (typeof v === 'string') return text(v);
    if (Array.isArray(v)) return array(v, 24).map(item => value(item, depth + 1));
    const record = obj(v), entries = Object.keys(record); if (entries.length > 24) fail('unbounded_model_values', 'Context objects have too many fields.');
    const result: { [key: string]: SpatialContextValue } = {};
    for (const key of entries) { if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('invalid_model_value_key', 'Unsupported context value key.'); result[id(key)] = value(record[key], depth + 1); }
    return result;
  }
  const factIds = new Set<string>();
  const facts = array(p.facts, 64).map(item => {
    const t = obj(item); keys(t, ['id', 'entityId', 'key', 'value', 'epistemic', 'source']);
    const factId = id(t.id), entityId = id(t.entityId);
    if (factIds.has(factId) || !entityIds.has(entityId)) fail('invalid_model_fact_identity', 'Fact identities must be unique and refer to existing entities.'); factIds.add(factId);
    if (!['computed', 'declared', 'unknown'].includes(String(t.epistemic)) || (t.epistemic === 'unknown' && t.value !== null)) fail('invalid_model_epistemic_state', 'Unknown facts must use null; all facts must name their epistemic state.');
    const r = obj(t.source); keys(r, ['sha256', 'artifact', 'method']);
    if (sha(r.sha256) !== source.sha256) fail('model_source_mismatch', 'Every fact must bind to this packet source hash.');
    return { id: factId, entityId, key: id(t.key), value: value(t.value), epistemic: t.epistemic as SpatialContextFact['epistemic'], source: { sha256: source.sha256, artifact: text(r.artifact, 96), method: text(r.method, 128) } };
  });
  const limitations = array(p.limitations, 16).map(v => text(v, 384));
  if (!limitations.length) fail('missing_model_limitations', 'A spatial model context must state its limits.');
  const result: SpatialModelContext = { schema: p.schema, source, frame, entities, facts, limitations };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_CONTEXT_BYTES) fail('unbounded_model_context', 'Spatial model context exceeds 64 KiB.');
  return result;
}
function boundedManifest(path: string): Buffer {
  const fd = openSync(realpathSync(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd); if (!stat.isFile() || stat.size < 1 || stat.size > 1024 * 1024) fail('invalid_model_source_size', 'Volume source must be a bounded regular manifest.');
    const bytes = Buffer.alloc(stat.size + 1); let length = 0;
    while (length < bytes.length) { const n = readSync(fd, bytes, length, bytes.length - length, null); if (!n) break; length += n; }
    if (length !== stat.size) fail('model_source_changed', 'Volume source changed while being read.');
    return bytes.subarray(0, length);
  } finally { closeSync(fd); }
}
/** Compact local packet. No model/network call and no write to a receipt stream. */
export function buildVolumeModelContext(manifestPath: string): SpatialModelContext {
  const bytes = boundedManifest(manifestPath), sourceHash = createHash('sha256').update(bytes).digest('hex');
  let raw: Record<string, unknown>;
  try { raw = obj(JSON.parse(bytes.toString('utf8'))); } catch { return fail('invalid_model_source_json', 'Volume source manifest is not valid JSON.'); }
  const manifest = validateVolumeManifest(raw), centerIndex = manifest.grid.dimensions.map(n => Math.floor(n / 2)) as VolumeVec3;
  const report = readVolumePackage(manifestPath, centerIndex);
  if (report.verification.manifestSha256 !== sourceHash) fail('model_source_changed', 'Volume source changed between context selection and artifact verification.');
  const sourceId = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/u.test(manifest.id) ? manifest.id : `volume-${sourceHash.slice(0,16)}`;
  const frameId = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/u.test(report.grid.frameId) ? report.grid.frameId : `frame-${sourceHash.slice(0,16)}`;
  const facts: SpatialContextFact[] = [];
  function fact(factId: string, entityId: string, key: string, value: SpatialContextValue, epistemic: SpatialContextFact['epistemic'], artifact: string, method: string) { facts.push({ id: factId, entityId, key, value, epistemic, source: { sha256: sourceHash, artifact, method } }); }
  fact('volume.location-count', 'volume', 'knownLocations', report.coverage.knownLocations, 'computed', 'manifest', 'bounded-grid-count');
  fact('volume.total-cells', 'volume', 'totalCells', report.coverage.total, 'computed', 'manifest', 'dimension-product');
  fact('volume.fill-coverage', 'volume', 'fillCoverage', { ...report.coverage.fill }, 'computed', 'manifest+cells', 'explicit-null-and-fraction-counts');
  fact('volume.material-coverage', 'volume', 'materialCoverage', { ...report.coverage.material }, 'computed', 'manifest+cells', 'default-and-override-status-counts');
  fact('volume.density-coverage', 'volume', 'densityCoverage', { ...report.coverage.density }, 'computed', 'manifest+cells', 'default-and-override-status-counts');
  fact('volume.filled-volume', 'volume', 'completeFilledVolume', report.volume.completeEstimate === null ? null : { amount: report.volume.completeEstimate, unit: report.volume.unit, exact: false }, report.volume.completeEstimate === null ? 'unknown' : 'computed', 'manifest+cells', 'fraction-sum-times-cell-volume');
  fact('volume.accounted-filled-volume', 'volume', 'accountedFilledVolume', { amount: report.volume.accountedFilledVolume, unit: report.volume.unit }, 'computed', 'manifest+cells', 'sum-known-fractions-only');
  fact('volume.unknown-capacity', 'volume', 'unknownCapacity', { amount: report.volume.unknownCapacity, unit: report.volume.unit }, 'computed', 'manifest+cells', 'unknown-cell-count-times-cell-volume');
  if (report.coverage.material.unknown === report.coverage.total) fact('volume.material', 'volume', 'material', null, 'unknown', 'manifest+cells', 'no-material-identification');
  if (report.coverage.density.unknown === report.coverage.total) fact('volume.density', 'volume', 'intrinsicDensityKgM3', null, 'unknown', 'manifest+cells', 'no-density-identification');
  fact('volume.physical-validation', 'volume', 'physicalValidation', null, 'unknown', 'manifest+cells', 'not-performed-by-inspector');
  fact('volume.reference-count', 'volume', 'referenceCount', report.references.count, 'computed', 'manifest', 'count-only-no-reference-fetch');
  const cell = report.cell!;
  fact('cell-center.location', 'cell-center', 'center', cell.location.center, 'computed', 'manifest', 'origin-plus-column-basis-times-cell-center');
  fact('cell-center.fill', 'cell-center', 'fillFraction', cell.fill.status === 'unknown' ? null : cell.fill.fraction!, cell.fill.status === 'unknown' ? 'unknown' : 'declared', 'manifest+cells', 'source-reported-cell-fill');
  fact('cell-center.material', 'cell-center', 'material', cell.material.status === 'unknown' ? null : { id: cell.material.id, status: cell.material.status }, cell.material.status === 'unknown' ? 'unknown' : 'declared', 'manifest+cells', 'source-reported-cell-material');
  fact('cell-center.density', 'cell-center', 'intrinsicDensityKgM3', cell.density.status === 'unknown' ? null : { value: cell.density.value, unit: cell.density.unit, basis: cell.density.basis, status: cell.density.status }, cell.density.status === 'unknown' ? 'unknown' : 'declared', 'manifest+cells', 'source-reported-cell-density');
  fact('cell-center.boundary', 'cell-center', 'boundaryField', cell.boundary.status === 'unknown' ? null : { value: cell.boundary.value!, units: cell.boundary.units, representation: cell.boundary.representation, exactDistance: cell.boundary.exactDistance }, cell.boundary.status === 'unknown' ? 'unknown' : 'declared', 'manifest+cells', 'source-reported-boundary-sample');
  const construction = raw.construction;
  if (construction && typeof construction === 'object' && !Array.isArray(construction)) for (const key of ['boxSideMm', 'boreRadiusMm'] as const) {
    const n = (construction as Record<string, unknown>)[key];
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) fact(`volume.construction.${key}`, 'volume', key, n, 'declared', 'manifest', 'numeric-construction-metadata-only');
  }
  return validateSpatialModelContext({ schema: 'timmy.spatial-model-context/1', source: { kind: 'volume', id: sourceId, sha256: sourceHash }, frame: { id: frameId, units: report.grid.units, origin: report.grid.origin, basis: report.grid.basis, dimensions: report.grid.dimensions, cellSize: report.grid.cellSize }, entities: [{ id: 'volume', kind: 'volume', label: 'Bounded volume' }, { id: 'cell-center', kind: 'voxel', parentId: 'volume', ijk: centerIndex, label: 'Cell at the center index of the bounded grid' }], facts, limitations: [
    'Artifact hashes verify local bytes, not producer authentication or physical truth.',
    'This packet inspector does not parse OpenVDB; native round-trip evidence requires separate review.',
    'Fill fractions describe occupied volume, not opacity, confidence, or an exact boundary inside each cell.',
    'Known grid locations do not imply known fill, material, or intrinsic density; outside this domain is unknown.',
    'Construction dimensions are source declarations, not independently verified geometric measurements.',
    'Reported material or density measurements remain source declarations here until their provenance is reviewed.',
    'Only one selected voxel is included; aggregate counts do not establish every local geometric relationship.',
    'Reference content and unbounded source descriptions are omitted; reference counts do not establish evidence.',
    'Fact and entity IDs must be interpreted together with the exact source hash; a new source revision requires a new review.',
  ] });
}
