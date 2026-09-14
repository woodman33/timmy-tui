import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { appendReceipt, hashOf, verifySignature, type Receipt } from '../../utils/receipts.js';
import { captureEnvLock } from '../../utils/envlock.js';
import { buildVolumeModelContext, validateSpatialModelContext, type SpatialModelContext, type SpatialContextFact } from './model-context.js';
import { readVolumePackage } from './volume-cli.js';
import { type VolumeVec3 } from './volume.js';

export type SpatialProvenance = 'measured' | 'reconstructed' | 'generated';
export interface SpatialCameraPose { frameId: string; units: 'mm' | 'cm' | 'm' | 'scene-unit' | 'px'; provenance: SpatialProvenance; projection: 'perspective'; position: VolumeVec3; target: VolumeVec3; up: VolumeVec3; verticalFovDegrees: number }
export interface ContextPack {
  schema: 'timmy.context.pack/1'; context: SpatialModelContext; sourceRevision: string;
  document: { path: string; sha256: string; authority: 'retained-local-file' };
  geometry: { id: string; kind: 'volume' | 'mesh'; provenance: SpatialProvenance; artifactSha256: string; units: string }[];
  camera: SpatialCameraPose;
  measurements: { factId: string; objectId: string; provenance: SpatialProvenance; epistemic: 'computed' | 'declared'; value: SpatialContextFact['value'] }[];
  unknowns: { factId: string; objectId: string; key: string }[];
  scope: { nativeDocumentFreshness: false; physicalValidation: false; cameraIsNativeCapture: false; meaning: string };
}
export interface SpatialSealOptions { outputDir: string; receiptDir?: string; sourceRoot?: string }
export interface SpatialArtifactSeal { artifact: { path: string; sha256: string; bytes: number }; receipt: Receipt }
export class SpatialSealError extends Error { constructor(public code: string, message: string) { super(message); this.name = 'SpatialSealError'; } }
export const spatialBytesHash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
function fail(code: string, message: string): never { throw new SpatialSealError(code, message); }
function object(v: unknown): Record<string, unknown> { if (!v || typeof v !== 'object' || Array.isArray(v)) fail('invalid_object', 'Expected a bounded object.'); return v as Record<string, unknown>; }
function text(v: unknown, max = 256): string { if (typeof v !== 'string' || !v.trim() || v.length > max || /[\u0000-\u001f\u007f]/u.test(v)) fail('invalid_text', 'Invalid bounded text.'); return v; }
function vec(v: unknown): VolumeVec3 { if (!Array.isArray(v) || v.length !== 3 || Array.from(v).some(n => typeof n !== 'number' || !Number.isFinite(n))) fail('invalid_camera', 'Camera vectors require three finite numbers.'); return [...v] as VolumeVec3; }
function digest(v: unknown): string { if (typeof v !== 'string' || !/^[a-f0-9]{64}$/u.test(v)) fail('invalid_hash', 'Expected a SHA-256 source identity.'); return v; }
function relPath(v: unknown): string { const path = text(v, 1024); if (isAbsolute(path) || path.split(/[\\/]/u).some(s => s === '..' || !s || s === '.') || path.includes(':')) fail('unsafe_path', 'Expected a relative path within the declared local authority root.'); return path; }
export function readSpatialBytes(path: string, limit = 2 * 1024 * 1024): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { const before = fstatSync(fd); if (!before.isFile() || before.size < 1 || before.size > limit) fail('invalid_source_size', 'Source is not a bounded regular file.'); const data = Buffer.alloc(before.size + 1); let length = 0; while (length < data.length) { const n = readSync(fd, data, length, data.length - length, null); if (!n) break; length += n; } const after = fstatSync(fd); if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail('source_changed', 'Source changed during the authoritative byte read.'); return data.subarray(0, length); } finally { closeSync(fd); }
}
export function resolveSpatialAuthority(root: string, path: string): string {
  const canonicalRoot = realpathSync(root), canonical = realpathSync(resolve(canonicalRoot, relPath(path))), part = relative(canonicalRoot, canonical);
  if (part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) fail('authority_escape', 'Source resolves outside the declared local authority root.');
  return canonical;
}
export function validateSpatialCamera(input: unknown): SpatialCameraPose {
  const p = object(input), position = vec(p.position), target = vec(p.target), up = vec(p.up);
  if (Object.keys(p).some(k => !['frameId', 'units', 'provenance', 'projection', 'position', 'target', 'up', 'verticalFovDegrees'].includes(k))) fail('invalid_camera', 'Unsupported camera property.');
  if (!['mm', 'cm', 'm', 'scene-unit', 'px'].includes(String(p.units)) || !['measured', 'reconstructed', 'generated'].includes(String(p.provenance)) || p.projection !== 'perspective') fail('invalid_camera', 'Camera units, provenance and projection must be explicit.');
  const view = target.map((n, i) => n - position[i]), length = Math.hypot(...view), upLength = Math.hypot(...up);
  const cross = [view[1] * up[2] - view[2] * up[1], view[2] * up[0] - view[0] * up[2], view[0] * up[1] - view[1] * up[0]];
  if (!Number.isFinite(length) || !length || !Number.isFinite(upLength) || !upLength || !Number.isFinite(Math.hypot(...cross)) || Math.hypot(...cross) / length / upLength < 1e-9 || typeof p.verticalFovDegrees !== 'number' || !Number.isFinite(p.verticalFovDegrees) || p.verticalFovDegrees <= 0 || p.verticalFovDegrees >= 180) fail('invalid_camera', 'Camera direction, up vector or field of view is degenerate.');
  return { frameId: text(p.frameId), units: p.units as SpatialCameraPose['units'], provenance: p.provenance as SpatialProvenance, projection: 'perspective', position, target, up, verticalFovDegrees: p.verticalFovDegrees };
}
export function validateContextPack(raw: unknown): ContextPack {
  const p = object(raw); if (p.schema !== 'timmy.context.pack/1') fail('invalid_pack', 'Unsupported context pack schema.');
  const context = validateSpatialModelContext(p.context), sourceRevision = digest(p.sourceRevision), document = object(p.document), camera = validateSpatialCamera(p.camera);
  if (sourceRevision !== context.source.sha256 || digest(document.sha256) !== sourceRevision || document.authority !== 'retained-local-file' || camera.frameId !== context.frame.id || camera.units !== context.frame.units || camera.provenance !== 'generated') fail('pack_source_mismatch', 'Pack source, constructed camera and local document binding disagree.');
  if (!Array.isArray(p.geometry) || p.geometry.length < 1 || p.geometry.length > 4) fail('invalid_geometry', 'Pack geometry must be a bounded identified list.');
  const geometry = p.geometry.map(item => { const g = object(item); if (!['volume', 'mesh'].includes(String(g.kind)) || !['measured', 'reconstructed', 'generated'].includes(String(g.provenance)) || !context.entities.some(e => e.id === g.id) || g.units !== context.frame.units) fail('invalid_geometry', 'Geometry identity, provenance or units disagree with context.'); return { id: text(g.id), kind: g.kind as 'volume' | 'mesh', provenance: g.provenance as SpatialProvenance, artifactSha256: digest(g.artifactSha256), units: String(g.units) }; });
  const expectedMeasurements = context.facts.filter(f => f.epistemic !== 'unknown').map(f => ({ factId: f.id, objectId: f.entityId, provenance: 'generated' as const, epistemic: f.epistemic as 'computed' | 'declared', value: f.value }));
  const expectedUnknowns = context.facts.filter(f => f.epistemic === 'unknown').map(f => ({ factId: f.id, objectId: f.entityId, key: f.key }));
  if (JSON.stringify(p.measurements) !== JSON.stringify(expectedMeasurements) || JSON.stringify(p.unknowns) !== JSON.stringify(expectedUnknowns)) fail('pack_fact_mismatch', 'Pack measurements and unknowns must reproduce the identified context facts.');
  const scope = object(p.scope); if (scope.nativeDocumentFreshness !== false || scope.physicalValidation !== false || scope.cameraIsNativeCapture !== false) fail('invalid_pack_scope', 'This pack does not establish native freshness, physical validation or a captured camera.');
  return { schema: p.schema, context, sourceRevision, document: { path: relPath(document.path), sha256: sourceRevision, authority: 'retained-local-file' }, geometry, camera, measurements: expectedMeasurements, unknowns: expectedUnknowns, scope: { nativeDocumentFreshness: false, physicalValidation: false, cameraIsNativeCapture: false, meaning: text(scope.meaning, 512) } };
}
export function buildVolumeContextPack(manifestPath: string, options: { camera: SpatialCameraPose; sourceRoot?: string }): ContextPack {
  const root = realpathSync(options.sourceRoot ?? process.cwd()), canonical = realpathSync(resolve(manifestPath)), path = relPath(relative(root, canonical));
  resolveSpatialAuthority(root, path);
  const declarationBytes = readSpatialBytes(canonical, 1024 * 1024);
  let declaration: Record<string, unknown>;
  try { declaration = object(JSON.parse(declarationBytes.toString('utf8'))); } catch { fail('invalid_generated_source', 'Generated volume factory requires a valid local manifest declaration.'); }
  const construction = declaration.construction && typeof declaration.construction === 'object' && !Array.isArray(declaration.construction) ? declaration.construction as Record<string, unknown> : {};
  const side = construction.boxSideMm, radius = construction.boreRadiusMm;
  if (construction.source !== 'analytic' || construction.physicalMeasurement !== false || typeof side !== 'number' || !Number.isFinite(side) || side <= 0 || typeof radius !== 'number' || !Number.isFinite(radius) || radius <= 0 || radius * 2 >= side) fail('unsupported_generated_source', 'This generated-only factory requires declared analytic box-and-bore construction with finite positive parameters and no physical measurement.');
  const context = buildVolumeModelContext(canonical), report = readVolumePackage(canonical), camera = validateSpatialCamera(options.camera);
  if (context.source.sha256 !== report.verification.manifestSha256 || spatialBytesHash(declarationBytes) !== context.source.sha256) fail('source_changed', 'Source changed while building the pack.');
  if (report.coverage.material.measured > 0 || report.coverage.density.measured > 0) fail('measured_property_not_generated', 'Measured material or density evidence requires a provenance-preserving factory and cannot be relabeled generated.');
  const geometry: ContextPack['geometry'] = [{ id: 'volume', kind: 'volume', provenance: 'generated', artifactSha256: report.verification.artifacts.native?.sha256 ?? report.verification.artifacts.cells.sha256, units: context.frame.units }];
  if (report.verification.artifacts.mesh) geometry.push({ id: 'volume', kind: 'mesh', provenance: 'reconstructed', artifactSha256: report.verification.artifacts.mesh.sha256, units: context.frame.units });
  return validateContextPack({ schema: 'timmy.context.pack/1', context, sourceRevision: context.source.sha256, document: { path, sha256: context.source.sha256, authority: 'retained-local-file' }, geometry, camera, measurements: context.facts.filter(f => f.epistemic !== 'unknown').map(f => ({ factId: f.id, objectId: f.entityId, provenance: 'generated', epistemic: f.epistemic, value: f.value })), unknowns: context.facts.filter(f => f.epistemic === 'unknown').map(f => ({ factId: f.id, objectId: f.entityId, key: f.key })), scope: { nativeDocumentFreshness: false, physicalValidation: false, cameraIsNativeCapture: false, meaning: 'Generated local volume fixture with reconstructed surface and a constructed camera; no physical measurement or live editor attestation.' } });
}
/** Retains immutable payload bytes; the receipt describes their provenance separately. */
export function sealSpatialArtifact(kind: string, payload: unknown, sourceRevision: string, options: SpatialSealOptions, status: 'ok' | 'denied' = 'ok'): SpatialArtifactSeal {
  if (!/^[a-z][a-z.]{1,63}$/u.test(kind)) fail('invalid_artifact_kind', 'Artifact kind must be a bounded identifier.');
  digest(sourceRevision);
  const lexicalRoot = resolve(options.sourceRoot ?? process.cwd()), root = realpathSync(lexicalRoot), relativeOutput = relative(lexicalRoot, resolve(options.outputDir)), output = resolve(root, relativeOutput);
  if (relativeOutput === '..' || relativeOutput.startsWith(`..${sep}`) || isAbsolute(relativeOutput)) fail('output_escape', 'Evidence output must remain within the declared local authority root.');
  let ancestor = output;
  while (!existsSync(ancestor)) { const parent = dirname(ancestor); if (parent === ancestor) fail('output_unavailable', 'Evidence output has no resolvable ancestor.'); ancestor = parent; }
  const canonicalAncestor = realpathSync(ancestor), ancestorRelative = relative(root, canonicalAncestor);
  if (canonicalAncestor !== ancestor || ancestorRelative === '..' || ancestorRelative.startsWith(`..${sep}`) || isAbsolute(ancestorRelative)) fail('output_symlink', 'Evidence output must not traverse symlink directories.');
  mkdirSync(output, { recursive: true }); if (realpathSync(output) !== output) fail('output_symlink', 'Evidence output must not traverse symlink directories.');
  const bytes = Buffer.from(JSON.stringify(payload, null, 2) + '\n'); if (bytes.length > 512 * 1024) fail('unbounded_seal', 'Evidence payload exceeds its bounded size.');
  const sha256 = spatialBytesHash(bytes), filename = `${kind}-${sha256.slice(0, 16)}-${randomUUID()}.json`, absolute = resolve(output, filename), path = relative(root, absolute);
  writeFileSync(absolute, bytes, { flag: 'wx', mode: 0o444 });
  const receipt = appendReceipt('runs', { kind, subject: kind, policy: 'Retain immutable spatial evidence; no authority or physical correctness promotion', status, output_sha256: sha256, manifest_sha256: digest(sourceRevision), artifacts: [path], sources: [{ source_sha256: sourceRevision, artifact_sha256: sha256, authority: 'retained-local-file' }], env_lock: captureEnvLock([], options.receiptDir ?? process.cwd()) }, options.receiptDir);
  return { artifact: { path, sha256, bytes: bytes.length }, receipt };
}
export function sealContextPack(pack: ContextPack, options: SpatialSealOptions): SpatialArtifactSeal { const admitted = validateContextPack(pack); return sealSpatialArtifact('context.pack', admitted, admitted.sourceRevision, options); }
export function readSealedContextPack(seal: SpatialArtifactSeal, sourceRoot = process.cwd()): ContextPack {
  if (seal.receipt.kind !== 'context.pack' || seal.receipt.status !== 'ok' || !verifySignature(seal.receipt) || hashOf({ ...seal.receipt, hash: '' }) !== seal.receipt.hash || seal.receipt.output_sha256 !== seal.artifact.sha256 || !seal.receipt.artifacts?.includes(seal.artifact.path)) fail('invalid_pack_seal', 'Context pack receipt does not bind the retained bytes.');
  const bytes = readSpatialBytes(resolveSpatialAuthority(sourceRoot, seal.artifact.path));
  if (bytes.length !== seal.artifact.bytes || spatialBytesHash(bytes) !== seal.artifact.sha256) fail('pack_bytes_changed', 'Sealed context pack bytes changed.');
  const pack = validateContextPack(JSON.parse(bytes.toString('utf8'))); if (seal.receipt.manifest_sha256 !== pack.sourceRevision) fail('invalid_pack_seal', 'Receipt source revision differs from the sealed pack.'); return pack;
}
export function sealSpatialAnnotation(packSeal: SpatialArtifactSeal, input: { camera: SpatialCameraPose; review: unknown }, options: SpatialSealOptions) {
  const pack = readSealedContextPack(packSeal, options.sourceRoot), inputBytes = typeof input.review === 'string' ? input.review : JSON.stringify(input.review);
  if (typeof inputBytes !== 'string' || Buffer.byteLength(inputBytes) > 64 * 1024) fail('invalid_annotation_size', 'Annotation response exceeds its bounded size.');
  let annotations: { objectId: string; sourceRevision: string; camera: SpatialCameraPose; factIds: string[]; comment: string; proposedAction: string; provenance: 'generated' }[] = [], reason: string | null = null;
  try {
    const camera = validateSpatialCamera(input.camera); if (JSON.stringify(camera) !== JSON.stringify(pack.camera)) fail('annotation_camera_mismatch', 'Annotation camera differs from the sealed pack.');
    const raw = object(typeof input.review === 'string' ? JSON.parse(input.review) : input.review);
    if (raw.sourceSha256 !== pack.sourceRevision) fail('annotation_revision_mismatch', 'Annotation names another source revision.');
    if (!Array.isArray(raw.annotations) || raw.annotations.length < 1 || raw.annotations.length > 4) fail('invalid_annotation', 'Expected one to four grounded annotations.');
    for (const property of ['material', 'density'] as const) if (pack.context.facts.some(f => f.id === `volume.${property}` && f.epistemic === 'unknown') && raw[`${property}Known`] !== false) fail('annotation_unknown_promoted', 'Annotation promotes an explicitly unknown material or density.');
    const facts = new Map(pack.context.facts.map(f => [f.id, f]));
    annotations = raw.annotations.map(item => { const a = object(item), objectId = text(a.entityId, 128); if (!pack.context.entities.some(e => e.id === objectId) || !Array.isArray(a.factIds) || a.factIds.length < 1 || a.factIds.length > 8 || a.factIds.some(id => typeof id !== 'string' || facts.get(id)?.entityId !== objectId)) fail('annotation_ungrounded', 'Annotation cites an unknown fact or a fact belonging to another object.'); if (!['inspect', 'refine', 'annotate', 'none'].includes(String(a.proposedAction))) fail('annotation_action', 'Unsupported annotation proposal.'); return { objectId, sourceRevision: pack.sourceRevision, camera, factIds: a.factIds as string[], comment: text(a.comment, 1200), proposedAction: String(a.proposedAction), provenance: 'generated' as const }; });
  } catch (error) { reason = error instanceof SpatialSealError ? error.code : 'invalid_annotation_json'; annotations = []; }
  const result = { schema: 'timmy.annotation.receipt/1', status: reason ? 'rejected' : 'grounded', packSha256: packSeal.artifact.sha256, sourceRevision: pack.sourceRevision, inputSha256: spatialBytesHash(inputBytes), annotations, reason, scope: { modelInterpretationOnly: true, semanticCorrectnessChecked: false, nativeEditsExecuted: false, physicalValidation: false } };
  const seal = sealSpatialArtifact('annotation.receipt', result, pack.sourceRevision, options, reason ? 'denied' : 'ok'); return { result, ...seal };
}
