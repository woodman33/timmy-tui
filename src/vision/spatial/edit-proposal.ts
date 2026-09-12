import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { readSealedContextPack, readSpatialBytes, resolveSpatialAuthority, sealSpatialArtifact, spatialBytesHash, SpatialSealError, type SpatialArtifactSeal, type SpatialSealOptions } from './context-pack.js';

export interface SpatialEditChange { path: string; before: null | boolean | number | string; after: null | boolean | number | string }
export interface SpatialEditRequest { documentPath: string; objectId: string; changes: SpatialEditChange[] }
function scalar(value: unknown): boolean { return value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (typeof value === 'string' && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value)); }
function pointer(path: unknown): string[] {
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > 512) throw new SpatialSealError('invalid_edit_path', 'Edit path must be a bounded JSON pointer.');
  const segments = path.slice(1).split('/'); if (!segments.length || segments.length > 8 || segments.some(s => !s || /~(?![01])/u.test(s))) throw new SpatialSealError('invalid_edit_path', 'Invalid JSON pointer.');
  const decoded = segments.map(s => s.replace(/~1/gu, '/').replace(/~0/gu, '~'));
  if (decoded.some(s => ['__proto__', 'prototype', 'constructor'].includes(s))) throw new SpatialSealError('invalid_edit_path', 'Prototype paths are not editable.'); return decoded;
}
/** A local authoritative byte read and sealed dry-run diff. No document-write path exists. */
export function proposeSpatialEdit(packSeal: SpatialArtifactSeal, request: SpatialEditRequest, options: SpatialSealOptions) {
  const pack = readSealedContextPack(packSeal, options.sourceRoot), root = options.sourceRoot ?? process.cwd();
  let status: 'proposed' | 'refused' = 'proposed', reason: string | null = null, observedRevision: string | null = null, observedAtUtc: string | null = null, proposedRevision: string | null = null;
  let diff: SpatialEditChange[] = [];
  try {
    if (!request || request.objectId !== 'volume' || !pack.context.entities.some(e => e.id === request.objectId)) throw new SpatialSealError('unknown_edit_object', 'This bounded document adapter edits only the identified volume object.');
    if (!Array.isArray(request.changes) || request.changes.length < 1 || request.changes.length > 16) throw new SpatialSealError('invalid_edit_count', 'Expected one to sixteen scalar changes.');
    const authoritativePath = resolveSpatialAuthority(root, pack.document.path), suppliedPath = realpathSync(resolve(request.documentPath));
    if (authoritativePath !== suppliedPath) throw new SpatialSealError('wrong_document_authority', 'Caller path is not the document bound by the sealed pack.');
    const beforeBytes = readSpatialBytes(authoritativePath); observedAtUtc = new Date().toISOString(); observedRevision = spatialBytesHash(beforeBytes);
    if (observedRevision !== pack.sourceRevision) throw new SpatialSealError('stale_source_revision', 'Authoritative document bytes have changed since the context pack was sealed.');
    const document = JSON.parse(beforeBytes.toString('utf8')), proposed = structuredClone(document), seen = new Set<string>();
    for (const change of request.changes) {
      const segments = pointer(change.path);
      if (seen.has(change.path) || !scalar(change.before) || !scalar(change.after)) throw new SpatialSealError('invalid_edit_change', 'Edits require unique paths and finite scalar values.'); seen.add(change.path);
      // Construction parameters are a declared input surface; geometry must later be rebuilt.
      if (segments.length !== 2 || segments[0] !== 'construction' || !['boxSideMm', 'boreRadiusMm'].includes(segments[1]) || typeof change.after !== 'number' || change.after <= 0) throw new SpatialSealError('unsupported_edit_field', 'This adapter proposes positive box-side or bore-radius construction parameters only.');
      let target = proposed;
      for (const segment of segments.slice(0, -1)) { if (!target || typeof target !== 'object' || !Object.hasOwn(target, segment)) throw new SpatialSealError('missing_edit_target', 'Proposed target does not exist.'); target = target[segment]; }
      const key = segments.at(-1)!;
      if (!target || typeof target !== 'object' || !Object.hasOwn(target, key) || target[key] !== change.before) throw new SpatialSealError('edit_precondition_mismatch', 'Expected value differs from the authoritative document.');
      if (change.before === change.after) throw new SpatialSealError('empty_edit', 'A proposal must change the declared value.');
      target[key] = change.after; diff.push({ path: change.path, before: change.before, after: change.after });
    }
    if (proposed.construction.boreRadiusMm * 2 >= proposed.construction.boxSideMm) throw new SpatialSealError('invalid_construction_parameters', 'The declared bore diameter must remain smaller than the box side.');
    proposedRevision = spatialBytesHash(JSON.stringify(proposed, null, 2) + '\n');
    const finalRevision = spatialBytesHash(readSpatialBytes(authoritativePath));
    if (finalRevision !== observedRevision) { observedRevision = finalRevision; observedAtUtc = new Date().toISOString(); throw new SpatialSealError('source_changed_during_dry_run', 'Document changed while the proposal was being inspected.'); }
  } catch (error) { status = 'refused'; reason = error instanceof SpatialSealError ? error.code : 'authoritative_document_unavailable'; diff = []; proposedRevision = null; }
  const result = { schema: 'timmy.edit.proposal/1', status, reason, packSha256: packSeal.artifact.sha256, objectId: typeof request?.objectId === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/u.test(request.objectId) ? request.objectId : null, sourceRevision: pack.sourceRevision, document: pack.document, freshness: { basis: observedRevision ? 'direct-authoritative-local-byte-read' : 'not-read', readPerformed: observedRevision !== null, observedRevision, observedAtUtc, leaseHeld: false }, dryRun: { diff, proposedDocumentSha256: proposedRevision, requiresGeometryRebuild: status === 'proposed', documentWritten: false }, scope: { proposalOnly: true, nativeDocumentFreshness: false, appliesAutomatically: false, laterApplyMustRecheckRevision: true } };
  const seal = sealSpatialArtifact('edit.proposal', result, pack.sourceRevision, options, status === 'refused' ? 'denied' : 'ok'); return { result, ...seal };
}
