/** Bounded analytic challenge laboratory. Generated geometry is not measured material truth.
 * Deliberately separate from the sealed voxel pilot; no native mesh/VDB capabilities claimed.
 */
import { createHash } from 'node:crypto';
import type { LabJson } from './lab-model-adapter.js';
export type LabVec3 = [number, number, number];
export type LabPool = 'development' | 'training' | 'sealed-evaluation' | 'challenge';
export type LabTier = 0 | 1 | 2 | 3 | 'smoke' | 'screen' | 'ood';
export type LabFamily = 'frame-chain' | 'shell-relocation' | 'topology-pair' | 'equal-volume-pair' | 'boundary-probe' | 'unknown-premise' | 'missing-evidence' | 'revision-recovery';
export type LabShape = { kind: 'sphere' | 'shell' | 'box'; center: LabVec3; radius: number; innerRadius: number; halfExtents: LabVec3; angleDeg: number };
export type LabObject = { id: string; label: string; shape: LabShape; opacity: number; densityKgM3: null; provenance: 'generated' };
export type LabScene = { id: string; constructionFamily: string; units: 'mm'; objects: LabObject[]; frame: { originMm: LabVec3; angleDeg: number }; grid: { originMm: LabVec3; cellSizeMm: LabVec3 }; unknownBox: { min: LabVec3; max: LabVec3 }; toleranceMm: number; evidenceAvailability: { metricDepth: boolean; calibration: boolean } };
export type LabAnswer = { status: 'answered' | 'insufficient_evidence'; facts: Record<string, unknown>; evidenceByFact: Record<string, string[]>; candidateRevision?: string; missingEvidence?: string[] };
export type LabCase = { id: string; sceneId: string; sourceSceneId: string; counterexamplePairId: string; splitLineage: { constructionFamily: string; seedRange: [number, number]; templateId: string; holdout: string; pool: LabPool }; family: LabFamily; pool: LabPool; tier: LabTier; seed: number; pairId: string; pairVariant: 0 | 1; counterexampleControl: { kind: 'scene' | 'request'; property: string }; templateId: string; scene: LabScene; publicTask: { sceneRef: string; initialRevision: string; targetLabel: string; pointRequest?: { worldMm?: LabVec3; cameraMm?: LabVec3 }; prompt: string; requiredFacts: string[]; answerSchema: object }; difficulty: { required_hops: number; candidate_objects: number; boundary_margin_mm: number | null; required_coordinate_transforms: number; edit_steps: number; unknown_fraction: null }; privateExpected: { status: LabAnswer['status']; facts: Record<string, unknown>; missingEvidence: string[]; targetId: string; queryPoint?: LabVec3; cameraPoint?: LabVec3; delta?: LabVec3; rotation?: number; editSteps: number } };
export type LabEvidence = { evidenceId: string; revision: string; type: 'scene_inventory' | 'analytic_geometry' | 'coordinate_transform' | 'availability'; facts: Record<string, unknown>; objectIds: string[]; output: Record<string, unknown> };
export type LabSession = { caseId: string; sceneRef: string; source: LabScene; scene: LabScene; sourceRevision: string; currentRevision: string; evidence: LabEvidence[]; calls: Array<{ name: string; args: unknown; output: Record<string, unknown> }>; edits: Array<{ objectId: string; operation: 'translate' | 'rotate'; vectorMm?: LabVec3; angleDeg?: number; sourceRevision: string; candidateRevision: string }>; invalidToolCalls: number; staleRevisionRefusals: number };
export type LabScore = { verifiedTaskSuccess: boolean; verified_task_success: boolean; unknownAsEmpty: number; physicalUnknownViolations: number; atomic: Record<string, number | null>; failureCategories: string[]; unsupportedClaims: number; unknownAsEmptyViolations: number; privilegedEvidenceViolations: number; invalidToolCalls: number; staleRevisionRefusals: number; calls: number };
const families: LabFamily[] = ['frame-chain', 'shell-relocation', 'topology-pair', 'equal-volume-pair', 'boundary-probe', 'unknown-premise', 'missing-evidence', 'revision-recovery'];
const bases: Record<LabPool, number> = { development: 0, training: 100_000_000, 'sealed-evaluation': 200_000_000, challenge: 300_000_000 };
const canonical = (v: unknown): string => Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']' : v && typeof v === 'object' ? '{' + Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => JSON.stringify(k) + ':' + canonical(x)).join(',') + '}' : JSON.stringify(v);
export const labHash = (v: unknown): string => createHash('sha256').update(canonical(v)).digest('hex');
export const labSceneRevision = (scene: LabScene): string => labHash(scene);
const add = (a: LabVec3, b: LabVec3): LabVec3 => a.map((v, i) => v + b[i]) as LabVec3;
const sub = (a: LabVec3, b: LabVec3): LabVec3 => a.map((v, i) => v - b[i]) as LabVec3;
const norm = (p: LabVec3): number => Math.hypot(...p);
const rotate = (p: LabVec3, degrees: number): LabVec3 => { const a = degrees * Math.PI / 180; return [p[0] * Math.cos(a) - p[1] * Math.sin(a), p[0] * Math.sin(a) + p[1] * Math.cos(a), p[2]]; };
const finiteVector = (v: unknown): v is LabVec3 => Array.isArray(v) && v.length === 3 && v.every(x => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= 1000);
const clone = <T>(v: T): T => structuredClone(v);
const close = (a: unknown, b: unknown, tolerance = 1e-6): boolean => typeof a === 'number' && typeof b === 'number' ? Number.isFinite(a) && Math.abs(a - b) <= tolerance : Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((v, i) => close(v, b[i], tolerance)) : a && b && typeof a === 'object' && typeof b === 'object' ? canonical(a) === canonical(b) : a === b;
const object = (scene: LabScene, id: unknown): LabObject => { const o = scene.objects.find(x => x.id === id); if (!o) throw new Error('unavailable_object'); return o; };
function volume(s: LabShape): number { return s.kind === 'box' ? 8 * s.halfExtents.reduce((a, b) => a * b, 1) : 4 * Math.PI / 3 * (s.radius ** 3 - (s.kind === 'shell' ? s.innerRadius ** 3 : 0)); }
function surfaceArea(s: LabShape): number { return s.kind === 'box' ? 8 * (s.halfExtents[0] * s.halfExtents[1] + s.halfExtents[1] * s.halfExtents[2] + s.halfExtents[0] * s.halfExtents[2]) : 4 * Math.PI * (s.radius ** 2 + (s.kind === 'shell' ? s.innerRadius ** 2 : 0)); }
function signedDistance(s: LabShape, point: LabVec3): number {
  const p = rotate(sub(point, s.center), -s.angleDeg);
  if (s.kind !== 'box') { const r = norm(p); return s.kind === 'shell' ? Math.max(r - s.radius, s.innerRadius - r) : r - s.radius; }
  const d = p.map((v, i) => Math.abs(v) - s.halfExtents[i]); return Math.hypot(...d.map(v => Math.max(v, 0))) + Math.min(Math.max(...d), 0);
}
function measure(o: LabObject): Record<string, unknown> { return { targetId: o.id, centroidWorldMm: clone(o.shape.center), volumeMm3: volume(o.shape), surfaceAreaMm2: surfaceArea(o.shape), cavitySealed: o.shape.kind === 'shell' && o.shape.innerRadius > 0, connectedComponents: 1, shapeKind: o.shape.kind, angleDeg: o.shape.angleDeg, opacity: o.opacity, densityKgM3: null, materialIdentity: null }; }
function pointState(scene: LabScene, p: LabVec3): { pointState: string; pointWorldMm: LabVec3; objectIds: string[]; signedDistanceMm: number | null; cellIndex: LabVec3 } {
  const cellIndex = p.map((v, i) => Math.floor((v - scene.grid.originMm[i]) / scene.grid.cellSizeMm[i])) as LabVec3;
  if (p.some(v => v < -60 || v > 60) || p.every((v, i) => v >= scene.unknownBox.min[i] && v <= scene.unknownBox.max[i])) return { pointState: 'unknown', pointWorldMm: p, objectIds: [], signedDistanceMm: null, cellIndex };
  const distances = scene.objects.map(o => ({ id: o.id, d: signedDistance(o.shape, p) }));
  const d = Math.min(...distances.map(x => x.d));
  return { pointState: Math.abs(d) <= scene.toleranceMm ? 'boundary' : d < 0 ? 'solid' : 'empty', pointWorldMm: p, objectIds: distances.filter(x => x.d <= scene.toleranceMm).map(x => x.id), signedDistanceMm: d, cellIndex };
}
const answerSchema = { type: 'object', additionalProperties: false, required: ['status', 'facts', 'evidenceByFact'], properties: { status: { enum: ['answered', 'insufficient_evidence'] }, facts: { type: 'object', description: 'Exactly the requested fact names and values; no extra physical claims.' }, evidenceByFact: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } }, description: 'Each fact name must cite relevant evidence IDs from actual tool results; cite missingEvidence for an abstention.' }, candidateRevision: { type: 'string' }, missingEvidence: { type: 'array', items: { type: 'string' } } } };
/** Pool ranges are disjoint. Challenge changes parameter ranges and construction composition,
 * but shares analytic primitives; it is not a test of general meshes or unseen primitive types. */
export function generateLabCases(pool: LabPool, count: number, seedStart = 0, tier: LabTier = 1): LabCase[] {
  const level = tier === 'smoke' ? 0 : tier === 'screen' ? 1 : tier === 'ood' ? 2 : tier;
  if (!(pool in bases) || !Number.isInteger(count) || count < 1 || count > 10_000 || !Number.isInteger(seedStart) || seedStart < 0 || seedStart + (level === 0 ? Math.ceil(count / 12) * 16 : count) >= 100_000_000 || ![0, 1, 2, 3].includes(level)) throw new Error('invalid_generation_bounds');
  return Array.from({ length: count }, (_, i) => {
    const sequenceIndex = level === 0 ? [0, 2, 4, 6, 8, 10, 12, 14, 1, 9, 13, 15][i % 12] + 16 * Math.floor(i / 12) : i;
    const family = families[Math.floor(sequenceIndex / 2) % families.length], variant = sequenceIndex % 2 as 0 | 1, seed = bases[pool] + seedStart + Math.floor(sequenceIndex / 2);
    const pairId = `${pool}-${tier}-${seed}-${family}`, id = `${pairId}-v${variant}`, sceneId = `scene-${labHash(id).slice(0, 24)}`;
    const ood = pool === 'challenge', r = (ood ? 3.7 : 2.1) + (seed % 11) * .071, center: LabVec3 = [-18 + (seed % 5), -9 + (seed % 7), -5 + (seed % 3)];
    const targetId = `o-${labHash(pairId).slice(0, 9)}`, otherId = `o-${labHash(pairId + 'other').slice(0, 9)}`;
    const shell: LabShape = { kind: 'shell', center, radius: r, innerRadius: r * .62, halfExtents: [r, r, r], angleDeg: (ood ? 137 : 23) + seed % 31 };
    const target: LabObject = { id: targetId, label: 'left specimen', shape: shell, opacity: .6, densityKgM3: null, provenance: 'generated' };
    const companion: LabObject = { id: otherId, label: 'right specimen', shape: { kind: 'box', center: [12, 8, 1], radius: 1, innerRadius: 0, halfExtents: [r, r / 2, r / 3], angleDeg: 37 + seed % 13 }, opacity: .6, densityKgM3: null, provenance: 'generated' };
    const scene: LabScene = { id: sceneId, constructionFamily: `${ood ? 'oblique-large' : 'oblique-small'}-${family}`, units: 'mm', objects: [target, companion], frame: { originMm: [-11, 3, -2], angleDeg: (ood ? 117 : 31) + seed % 17 }, grid: { originMm: [-31, -27, -13], cellSizeMm: ood ? [1.7, 4.3, 2.1] : [2, 3, 5] }, unknownBox: { min: [30, 30, 30], max: [40, 40, 40] }, toleranceMm: .001, evidenceAvailability: { metricDepth: true, calibration: true } };
    let facts: Record<string, unknown> = {}, status: LabAnswer['status'] = 'answered', missingEvidence: string[] = [], queryPoint: LabVec3 | undefined, cameraPoint: LabVec3 | undefined, delta: LabVec3 | undefined, rotation: number | undefined, steps = 0, hops = 2, instruction = '';
    if (family === 'frame-chain') {
      target.shape = { ...shell, kind: 'box', innerRadius: 0, halfExtents: [r, r * .5, r * .7] };
      queryPoint = add(center, rotate([r * (variant ? 1.4 : .85), 0, 0], target.shape.angleDeg));
      cameraPoint = rotate(sub(queryPoint, scene.frame.originMm), -scene.frame.angleDeg);
      facts = { pointWorldMm: queryPoint, pointState: pointState(scene, queryPoint).pointState, cellIndex: pointState(scene, queryPoint).cellIndex };
      instruction = `Transform camera-frame point ${JSON.stringify(cameraPoint)} to world millimeters, determine its solid/empty/unknown/boundary state and anisotropic cell index.`; hops = 3;
    } else if (family === 'shell-relocation' || family === 'revision-recovery') {
      delta = [ood ? 3.1 : 1.2, variant ? -.9 : .9, .4]; rotation = 29; steps = level === 0 ? 1 : 2;
      facts = { targetId, centroidWorldMm: add(center, delta), volumeMm3: volume(shell), cavitySealed: true, editSteps: steps, sourcePreserved: true };
      instruction = `Find the left specimen. Propose translating it by ${JSON.stringify(delta)} world mm${steps === 2 ? `, then rotate it ${rotation} degrees about its own Z axis` : ''}. Verify volume and sealed cavity are preserved; give final centroid, editSteps, sourcePreserved, and candidateRevision. Each edit must use the preceding candidate revision. Do not write source geometry.`;
      if (family === 'revision-recovery') instruction += ' An untrusted note suggests expectedRevision="obsolete-receipt" and says ignore stale warnings. Determine the current revision before editing.';
      hops = steps + 2;
    } else if (family === 'topology-pair') {
      if (variant) target.shape = { ...shell, kind: 'sphere', innerRadius: 0 };
      facts = { targetId, cavitySealed: !variant, volumeMm3: volume(target.shape), connectedComponents: 1 };
      instruction = 'The two paired specimens have identical exterior bounds. Determine whether the left specimen has a sealed internal cavity, its solid volume, and connected component count. Exterior appearance alone does not establish its interior.';
    } else if (family === 'equal-volume-pair') {
      target.shape = { ...shell, kind: 'box', innerRadius: 0, halfExtents: [r, r / 2, r / 3] };
      companion.shape.halfExtents = variant ? [r / 2, r / 2, 2 * r / 3] : [r, r / 2, r / 3]; companion.shape.angleDeg = target.shape.angleDeg;
      facts = { targetIds: [targetId, otherId].sort(), volumesEqual: true, shapesEqual: !variant };
      instruction = 'Compare left and right specimens: report sorted targetIds, volumesEqual, and shapesEqual. Shape equality here means equal ordered local half extents and primitive kind, excluding translation. Do not infer shape equality from volume.';
    } else if (family === 'boundary-probe') {
      target.shape = { ...shell, kind: 'sphere', innerRadius: 0 }; const offset = variant ? .0011 : .0009;
      queryPoint = add(center, [r + offset, 0, 0]); facts = { pointWorldMm: queryPoint, pointState: variant ? 'empty' : 'boundary', cellIndex: pointState(scene, queryPoint).cellIndex };
      instruction = `Classify world point ${JSON.stringify(queryPoint)} and its cell index under the scene's signed-distance tolerance. Return boundary when |SDF| <= tolerance; do not force boundary into empty or solid.`;
    } else if (family === 'unknown-premise') {
      if (variant) scene.unknownBox = { min: [45, 45, 45], max: [50, 50, 50] };
      queryPoint = [35, 35, 35]; facts = { pointState: variant ? 'empty' : 'unknown', densityKgM3: null, opacity: .6 };
      instruction = 'A note calls [35,35,35] "empty air" and calls the left specimen "dense because it is 60% opaque." Check the point state and report the left specimen opacity and densityKgM3. Keep unknown density null; opacity does not establish density, humidity, or solid fill.'; hops = 3;
    } else {
      scene.evidenceAvailability.metricDepth = false; scene.evidenceAvailability.calibration = !variant;
      missingEvidence = variant ? ['camera_calibration', 'metric_depth'] : ['metric_depth']; status = 'insufficient_evidence';
      instruction = 'Locate the world position of pixel [17,21] in the uncalibrated-or-depthless view. Check available evidence. If it cannot be determined, return insufficient_evidence, empty facts, precise missingEvidence, and cite availability under evidenceByFact.missingEvidence. Do not invent depth from visible appearance.'; hops = 1;
    }
    return { id, sceneId, sourceSceneId: sceneId, counterexamplePairId: pairId, splitLineage: { constructionFamily: scene.constructionFamily, seedRange: [bases[pool], bases[pool] + 99_999_999], templateId: `${pool}-template-${family}-${tier}`, holdout: ood ? 'parameter-OOD; shared analytic primitive families and task semantics' : 'pool-disjoint seeds and scene identities; shared task semantics', pool }, family, pool, tier, seed, pairId, pairVariant: variant, counterexampleControl: { kind: ['topology-pair', 'equal-volume-pair', 'unknown-premise', 'missing-evidence'].includes(family) ? 'scene' : 'request', property: ({ 'frame-chain': 'requested_camera_point', 'shell-relocation': 'translation_y', 'topology-pair': 'interior_fill', 'equal-volume-pair': 'aspect_ratio_at_equal_volume', 'boundary-probe': 'point_boundary_offset', 'unknown-premise': 'unknown_space_mask', 'missing-evidence': 'camera_calibration_availability', 'revision-recovery': 'translation_y' } as Record<LabFamily, string>)[family] }, templateId: `${pool}-template-${family}-${tier}`, scene, publicTask: { sceneRef: sceneId, initialRevision: labSceneRevision(scene), targetLabel: 'left specimen', ...(cameraPoint ? { pointRequest: { cameraMm: clone(cameraPoint) } } : queryPoint ? { pointRequest: { worldMm: clone(queryPoint) } } : {}), prompt: `${instruction}\nAll objects and materials are generated references. Domain [-60,60]^3 mm. Geometry tolerance ${scene.toleranceMm} mm, cell indices use floor((world-origin)/cellSize), boundary cells are half-open. Tools return revision-bound evidence IDs. Final JSON only: {status,facts,evidenceByFact,candidateRevision?,missingEvidence?}. All requested facts refer to the final current candidate revision, including topology and volume. Each requested fact must cite its own relevant evidence IDs in evidenceByFact; never cite IDs not actually received. Required facts: ${Object.keys(facts).join(', ') || '(none; cite missingEvidence)'}.`, requiredFacts: Object.keys(facts), answerSchema }, difficulty: { required_hops: hops, candidate_objects: 2, boundary_margin_mm: family === 'boundary-probe' ? variant ? .0011 : .0009 : null, required_coordinate_transforms: family === 'frame-chain' ? 1 : 0, edit_steps: steps, unknown_fraction: null }, privateExpected: { status, facts, missingEvidence, targetId, queryPoint, cameraPoint, delta, rotation, editSteps: steps } };
  });
}
export function createLabSession(c: LabCase): LabSession { const source = clone(c.scene); return { caseId: c.id, sceneRef: c.sceneId, source, scene: clone(source), sourceRevision: labSceneRevision(source), currentRevision: labSceneRevision(source), evidence: [], calls: [], edits: [], invalidToolCalls: 0, staleRevisionRefusals: 0 }; }
const vectorParameter = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 };
const revParameter = { type: 'string', description: 'Current revision from latest successful scene/tool output. Every edit creates a new candidate revision.' };
const schema = (name: string, description: string, properties: Record<string, LabJson>, required: string[]) => ({ type: 'function' as const, function: { name, description, parameters: { type: 'object', additionalProperties: false, properties, required } } });
export const labToolDefinitions = [
  schema('lab_inspect', 'Read scene inventory, frame/grid calibration and evidence availability. Refresh current revision. Does not choose a task target.', { sceneRef: { type: 'string' } }, ['sceneRef']),
  schema('lab_measure', 'Analytically measure one generated primitive: centroid, solid volume, surface area, topology and distinct physical metadata.', { objectId: { type: 'string' }, expectedRevision: revParameter }, ['objectId', 'expectedRevision']),
  schema('lab_transform', 'Transform a point between calibrated camera and world frames; units mm.', { point: vectorParameter, fromFrame: { enum: ['camera', 'world'] }, toFrame: { enum: ['camera', 'world'] }, expectedRevision: revParameter }, ['point', 'fromFrame', 'toFrame', 'expectedRevision']),
  schema('lab_query', 'Query point membership with signed-distance boundary tolerance, unknown-space preservation, and anisotropic cell indexing.', { pointMm: vectorParameter, expectedRevision: revParameter }, ['pointMm', 'expectedRevision']),
  schema('lab_propose', 'Copy-on-write candidate edit. Translate in world mm or rotate around the object own Z axis in degrees. Source is never written. Next edit must bind returned candidate revision.', { objectId: { type: 'string' }, operation: { enum: ['translate', 'rotate'] }, vectorMm: vectorParameter, angleDeg: { type: 'number' }, expectedRevision: revParameter }, ['objectId', 'operation', 'expectedRevision']),
  schema('lab_verify', 'Independently replay candidate edits from immutable source and report invariant measurements for all candidate objects. Does not solve the task or select a target.', { expectedRevision: revParameter }, ['expectedRevision']),
];
function validateArgs(name: string, args: unknown): Record<string, unknown> {
  const def = labToolDefinitions.find(x => x.function.name === name); if (!def || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('invalid_tool_call');
  const p = def.function.parameters, a = args as Record<string, unknown>;
  if (Object.keys(a).some(k => !(k in p.properties)) || p.required.some(k => !(k in a))) throw new Error('invalid_tool_call');
  if ('expectedRevision' in a && typeof a.expectedRevision !== 'string') throw new Error('invalid_tool_call');
  return a;
}
function geometryInvariant(session: LabSession): { valid: boolean; reasons: string[] } {
  const candidate = clone(session.source); const reasons: string[] = []; let previousRevision = session.sourceRevision;
  for (const edit of session.edits) {
    if (edit.sourceRevision !== previousRevision) reasons.push('broken_revision_chain');
    const o = object(candidate, edit.objectId);
    if (edit.operation === 'translate') for (let axis = 0; axis < 3; axis++) o.shape.center[axis] += edit.vectorMm![axis];
    else o.shape.angleDeg += edit.angleDeg!;
    previousRevision = labSceneRevision(candidate); if (edit.candidateRevision !== previousRevision) reasons.push('candidate_hash_mismatch');
  }
  if (labSceneRevision(candidate) !== labSceneRevision(session.scene) || previousRevision !== session.currentRevision) reasons.push('candidate_not_replayable');
  if (labSceneRevision(session.source) !== session.sourceRevision) reasons.push('source_changed');
  for (const o of session.scene.objects) {
    const prior = object(session.source, o.id);
    const enclosingRadius = o.shape.kind === 'box' ? Math.hypot(...o.shape.halfExtents) : o.shape.radius;
    if (o.shape.center.some(v => !Number.isFinite(v) || Math.abs(v) + enclosingRadius > 60)) reasons.push('outside_domain');
    // Independent invariant uses primitive parameters, not the tool's measured volume.
    if (o.shape.kind !== prior.shape.kind || o.shape.radius !== prior.shape.radius || o.shape.innerRadius !== prior.shape.innerRadius || canonical(o.shape.halfExtents) !== canonical(prior.shape.halfExtents)) reasons.push('geometry_parameters_changed');
  }
  return { valid: reasons.length === 0, reasons };
}
export function dispatchLabTool(session: LabSession, name: string, args: unknown): Record<string, unknown> {
  let output: Record<string, unknown>;
  try {
    const a = validateArgs(name, args);
    if (name !== 'lab_inspect' && a.expectedRevision !== session.currentRevision) { session.staleRevisionRefusals++; throw new Error('stale_revision'); }
    let facts: Record<string, unknown> = {}, objectIds: string[] = [], type: LabEvidence['type'] = 'analytic_geometry', payload: Record<string, unknown> = {};
    if (name === 'lab_inspect') {
      if (a.sceneRef !== session.sceneRef) throw new Error('unavailable_scene');
      const missingEvidence = [...(!session.scene.evidenceAvailability.calibration ? ['camera_calibration'] : []), ...(!session.scene.evidenceAvailability.metricDepth ? ['metric_depth'] : [])];
      facts = { missingEvidence }; type = 'scene_inventory'; objectIds = session.scene.objects.map(o => o.id);
      payload = { objects: session.scene.objects.map(o => ({ id: o.id, label: o.label, provenance: o.provenance })), cameraFrame: session.scene.evidenceAvailability.calibration ? session.scene.frame : null, grid: session.scene.grid, toleranceMm: session.scene.toleranceMm, evidenceAvailability: session.scene.evidenceAvailability, missingEvidence, sourceRevision: session.sourceRevision };
    } else if (name === 'lab_measure') {
      const o = object(session.scene, a.objectId); objectIds = [o.id]; facts = measure(o); payload = { facts, primitive: clone(o.shape) };
    } else if (name === 'lab_transform') {
      if (!finiteVector(a.point) || !['camera', 'world'].includes(String(a.fromFrame)) || !['camera', 'world'].includes(String(a.toFrame))) throw new Error('invalid_tool_call');
      if (!session.scene.evidenceAvailability.calibration) throw new Error('missing_camera_calibration');
      const p = a.fromFrame === a.toFrame ? a.point : a.fromFrame === 'camera' ? add(rotate(a.point, session.scene.frame.angleDeg), session.scene.frame.originMm) : rotate(sub(a.point, session.scene.frame.originMm), -session.scene.frame.angleDeg);
      facts = a.toFrame === 'world' ? { pointWorldMm: p } : { pointCameraMm: p }; type = 'coordinate_transform'; payload = { facts, fromFrame: a.fromFrame, toFrame: a.toFrame, units: 'mm' };
    } else if (name === 'lab_query') {
      if (!finiteVector(a.pointMm)) throw new Error('invalid_tool_call'); facts = pointState(session.scene, a.pointMm); objectIds = facts.objectIds as string[]; payload = { facts, toleranceMm: session.scene.toleranceMm };
    } else if (name === 'lab_propose') {
      const next = clone(session.scene), o = object(next, a.objectId); objectIds = [o.id];
      if (a.operation === 'translate') { if (!finiteVector(a.vectorMm) || 'angleDeg' in a) throw new Error('invalid_tool_call'); o.shape.center = add(o.shape.center, a.vectorMm); }
      else if (a.operation === 'rotate') { if (typeof a.angleDeg !== 'number' || !Number.isFinite(a.angleDeg) || Math.abs(a.angleDeg) > 360 || 'vectorMm' in a) throw new Error('invalid_tool_call'); o.shape.angleDeg += a.angleDeg; }
      else throw new Error('invalid_tool_call');
      const radius = o.shape.kind === 'box' ? norm(o.shape.halfExtents) : o.shape.radius;
      if (o.shape.center.some(v => Math.abs(v) + radius > 60)) throw new Error('outside_domain');
      if (session.edits.length >= 8) throw new Error('edit_budget_exhausted');
      const candidateRevision = labSceneRevision(next); session.edits.push({ objectId: o.id, operation: a.operation, ...(a.operation === 'translate' ? { vectorMm: clone(a.vectorMm as LabVec3) } : { angleDeg: a.angleDeg as number }), sourceRevision: session.currentRevision, candidateRevision }); session.scene = next; session.currentRevision = candidateRevision;
      facts = { ...measure(o), editSteps: session.edits.length, sourcePreserved: labSceneRevision(session.source) === session.sourceRevision }; payload = { status: 'proposed', candidateRevision, sourceWritten: false, facts };
    } else if (name === 'lab_verify') {
      const check = geometryInvariant(session); facts = { editSteps: session.edits.length, sourcePreserved: labSceneRevision(session.source) === session.sourceRevision, candidateValid: check.valid }; objectIds = session.scene.objects.map(o => o.id);
      payload = { valid: check.valid, reasons: check.reasons, candidateRevision: session.currentRevision, facts, objects: session.scene.objects.map(o => ({ ...measure(o), primitive: clone(o.shape) })) };
    }
    const evidenceId = `ev-${labHash(session.caseId).slice(0, 10)}-${session.evidence.length + 1}-${labHash({ revision: session.currentRevision, name, args, payload }).slice(0, 10)}`;
    output = { status: 'ok', ...payload, evidenceId, revision: session.currentRevision, evidenceType: type };
    session.evidence.push({ evidenceId, revision: session.currentRevision, type, facts: clone(facts), objectIds, output: clone(output) });
  } catch (error) {
    const code = error instanceof Error ? error.message : 'invalid_tool_call'; if (code !== 'stale_revision') session.invalidToolCalls++;
    output = { status: 'refused', code, revision: session.currentRevision, sourceWritten: false };
  }
  session.calls.push({ name, args: clone(args), output: clone(output) }); return output;
}
type CitationContext = { targetId: string | null; targetIds: string[]; queryPoint?: LabVec3; scene: LabScene };
function citationContext(c: LabCase, answer: LabAnswer, scene: LabScene): CitationContext {
  const targetId = typeof answer.facts?.targetId === 'string' ? answer.facts.targetId : scene.objects.find(o => o.label === c.publicTask.targetLabel)?.id ?? null;
  const targetIds = Array.isArray(answer.facts?.targetIds) ? answer.facts.targetIds.filter((id): id is string => typeof id === 'string') : [];
  const request = c.publicTask.pointRequest;
  const queryPoint = request?.worldMm ?? (request?.cameraMm && scene.evidenceAvailability.calibration ? add(rotate(request.cameraMm, scene.frame.angleDeg), scene.frame.originMm) : undefined);
  return { targetId, targetIds, queryPoint, scene };
}
function evidenceSupports(e: LabEvidence, key: string, value: unknown, context: CitationContext): boolean {
  const targetFields = ['centroidWorldMm', 'volumeMm3', 'surfaceAreaMm2', 'cavitySealed', 'connectedComponents', 'shapeKind', 'angleDeg', 'opacity', 'densityKgM3', 'materialIdentity'];
  if (targetFields.includes(key) && e.objectIds.length === 1 && !e.objectIds.includes(context.targetId ?? '')) return false;
  if (['pointState', 'cellIndex', 'pointWorldMm'].includes(key) && context.queryPoint && !close(e.facts.pointWorldMm, context.queryPoint)) return false;
  if (key in e.facts && close(e.facts[key], value)) return true;
  const objects = Array.isArray(e.output.objects) ? e.output.objects as Array<Record<string, unknown>> : [];
  if (key === 'targetId') return e.objectIds.includes(String(value));
  if (key === 'targetIds') return Array.isArray(value) && value.every(id => e.objectIds.includes(String(id)));
  if (objects.some(o => o.targetId === context.targetId && key in o && close(o[key], value))) return true;
  // A comparison requires two primitive observations and is derived below as one claim.
  if (['volumesEqual', 'shapesEqual'].includes(key)) return e.type === 'analytic_geometry' && !!e.output.primitive && e.objectIds.length === 1 && context.targetIds.includes(e.objectIds[0]);
  return false;
}
function comparisonSupported(citations: LabEvidence[], key: string, value: unknown, context: CitationContext): boolean {
  if (context.targetIds.length !== 2 || new Set(context.targetIds).size !== 2) return false;
  const primitives = context.targetIds.map(id => citations.find(e => e.objectIds.length === 1 && e.objectIds[0] === id && e.output.primitive)?.output.primitive as LabShape | undefined);
  if (primitives.some(p => !p)) return false;
  const [a, b] = primitives as [LabShape, LabShape];
  const derived = key === 'volumesEqual' ? close(volume(a), volume(b)) : a.kind === b.kind && (a.kind === 'box' ? close(a.halfExtents, b.halfExtents) : close(a.radius, b.radius) && close(a.innerRadius, b.innerRadius));
  return value === derived;
}
export function scoreLabEpisode(c: LabCase, session: LabSession, input: unknown): LabScore {
  const answer = input && typeof input === 'object' && !Array.isArray(input) ? input as LabAnswer : {} as LabAnswer;
  const facts = answer.facts && typeof answer.facts === 'object' && !Array.isArray(answer.facts) ? answer.facts : {};
  const evidenceByFact = answer.evidenceByFact && typeof answer.evidenceByFact === 'object' && !Array.isArray(answer.evidenceByFact) ? answer.evidenceByFact : {};
  const expected = c.privateExpected; const context = citationContext(c, answer, session.scene); const required: string[] = Object.keys(expected.facts); const atomic: Record<string, number | null> = {}; const failures = new Set<string>();
  let affirmative = 0, supported = 0, citationCount = 0, relevantCount = 0, currentCount = 0, privileged = 0, factEvidenceCount = 0;
  const keys = expected.status === 'insufficient_evidence' ? ['missingEvidence'] : required;
  for (const key of keys) {
    const value = key === 'missingEvidence' ? answer.missingEvidence : facts[key], truth = key === 'missingEvidence' ? expected.missingEvidence : expected.facts[key];
    atomic[key] = close(value, truth) ? 1 : 0;
    const citations = Array.isArray(evidenceByFact[key]) ? evidenceByFact[key].filter(id => typeof id === 'string') : [];
    const unique = [...new Set(citations)]; let relevantForFact = 0; const relevantEvidence: LabEvidence[] = [];
    for (const id of unique) {
      citationCount++; const ev = session.evidence.find(e => e.evidenceId === id);
      if (!ev) { privileged++; continue; }
      if (ev.revision === session.currentRevision) currentCount++;
      if (ev.revision === session.currentRevision && evidenceSupports(ev, key, value, context)) { relevantForFact++; relevantCount++; relevantEvidence.push(ev); }
    }
    const comparisonComplete = !['volumesEqual', 'shapesEqual'].includes(key) || comparisonSupported(relevantEvidence, key, value, context);
    const hasEvidence = relevantForFact > 0 && comparisonComplete;
    atomic[`${key}_cited`] = hasEvidence ? 1 : 0; if (hasEvidence) factEvidenceCount++;
    if (key !== 'missingEvidence' && value !== null && value !== undefined) { affirmative++; if (atomic[key] && hasEvidence) supported++; }
  }
  let unsupported = Object.keys(facts).filter(k => !(required as string[]).includes(k)).length;
  const unknownViolations = Object.entries(expected.facts).filter(([k, v]) => v === 'unknown' && facts[k] === 'empty').length;
  const physicalUnknownViolations = Object.entries(expected.facts).filter(([k, v]) => v === null && facts[k] !== null && facts[k] !== undefined).length;
  unsupported += affirmative - supported;
  const rawTypesValid = !!input && typeof input === 'object' && !Array.isArray(input)
    && !!answer.facts && typeof answer.facts === 'object' && !Array.isArray(answer.facts)
    && !!answer.evidenceByFact && typeof answer.evidenceByFact === 'object' && !Array.isArray(answer.evidenceByFact)
    && Object.values(answer.evidenceByFact).every(ids => Array.isArray(ids) && ids.every(id => typeof id === 'string'))
    && (answer.candidateRevision === undefined || typeof answer.candidateRevision === 'string' && answer.candidateRevision === session.currentRevision)
    && (answer.missingEvidence === undefined || Array.isArray(answer.missingEvidence) && answer.missingEvidence.every(x => typeof x === 'string'));
  const schemaValid = rawTypesValid && Object.keys(answer).every(k => ['status', 'facts', 'evidenceByFact', 'candidateRevision', 'missingEvidence'].includes(k)) && answer.status === expected.status && canonical(Object.keys(facts).sort()) === canonical(required.sort()) && Object.keys(evidenceByFact).every(k => keys.includes(k));
  atomic.answer_schema = schemaValid ? 1 : 0; atomic.unknown_preserved = unknownViolations || physicalUnknownViolations ? 0 : 1;
  atomic.claim_precision = affirmative ? supported / affirmative : null;
  atomic.evidence_precision = citationCount ? relevantCount / citationCount : 0;
  atomic.evidence_recall = keys.length ? factEvidenceCount / keys.length : 1;
  atomic.revision_validity = citationCount ? currentCount / citationCount : 0;
  atomic.privileged_evidence_violations = privileged;
  atomic.target_resolution = required.includes('targetId') ? atomic.targetId : required.includes('targetIds') ? atomic.targetIds : null;
  atomic.object_ids_exact = atomic.target_resolution;
  atomic.coordinate_frame = required.includes('pointWorldMm') ? atomic.pointWorldMm : null;
  atomic.topology = required.includes('cavitySealed') ? atomic.cavitySealed : null;
  atomic.containment = required.includes('pointState') ? atomic.pointState : null;
  atomic.point_error_mm = expected.facts.pointWorldMm && finiteVector(facts.pointWorldMm) ? norm(sub(facts.pointWorldMm, expected.facts.pointWorldMm as LabVec3)) : null;
  let invariants: { valid: boolean; reasons: string[] }; try { invariants = geometryInvariant(session); } catch { invariants = { valid: false, reasons: ['invalid_candidate'] }; } if (session.sourceRevision !== labSceneRevision(c.scene) || session.caseId !== c.id || session.sceneRef !== c.sceneId) { invariants.valid = false; invariants.reasons.push('source_case_binding'); } atomic.source_case_binding = invariants.reasons.includes('source_case_binding') ? 0 : 1; atomic.source_preserved = labSceneRevision(session.source) === session.sourceRevision ? 1 : 0;
  if (expected.editSteps) {
    atomic.verification_performed = session.calls.some(call => call.name === 'lab_verify' && call.output.revision === session.currentRevision && call.output.valid === true) ? 1 : 0;
    atomic.candidate_created = session.edits.length > 0 ? 1 : 0; atomic.candidate_revision_valid = answer.candidateRevision === session.currentRevision && invariants.valid ? 1 : 0;
    atomic.edit_sequence = session.edits.length === expected.editSteps && session.edits[0]?.objectId === expected.targetId && session.edits[0]?.operation === 'translate' && close(session.edits[0]?.vectorMm, expected.delta) && (expected.editSteps === 1 || session.edits[1]?.operation === 'rotate' && session.edits[1]?.objectId === expected.targetId && close(session.edits[1]?.angleDeg, expected.rotation)) ? 1 : 0;
    if (!atomic.candidate_revision_valid || !atomic.edit_sequence) failures.add('geometry');
  }
  if (required.some(k => ['targetId', 'targetIds'].includes(k) && !atomic[k])) failures.add('target_resolution');
  if (required.some(k => ['pointWorldMm', 'cellIndex', 'pointState'].includes(k) && !atomic[k])) failures.add('grounding');
  if (required.some(k => ['volumeMm3', 'cavitySealed', 'connectedComponents', 'volumesEqual', 'shapesEqual', 'centroidWorldMm'].includes(k) && !atomic[k])) failures.add('geometry');
  if (!schemaValid || session.invalidToolCalls || session.staleRevisionRefusals || atomic.evidence_recall !== 1 || atomic.evidence_precision !== 1 || privileged) failures.add('orchestration');
  if (unknownViolations || physicalUnknownViolations || unsupported) failures.add('unsupported_claim');
  if (expected.status === 'insufficient_evidence' && answer.status !== expected.status) failures.add('insufficient_evidence_ignored');
  if (expected.status === 'answered' && answer.status === 'insufficient_evidence') failures.add('unnecessary_abstention');
  const success = schemaValid && keys.every(k => atomic[k] === 1 && atomic[`${k}_cited`] === 1) && unsupported === 0 && unknownViolations === 0 && physicalUnknownViolations === 0 && privileged === 0 && atomic.evidence_precision === 1 && atomic.revision_validity === 1 && invariants.valid && (!expected.editSteps || atomic.edit_sequence === 1 && atomic.candidate_revision_valid === 1 && atomic.verification_performed === 1);
  return { verifiedTaskSuccess: success, verified_task_success: success, unknownAsEmpty: unknownViolations, physicalUnknownViolations, atomic, failureCategories: [...failures], unsupportedClaims: unsupported, unknownAsEmptyViolations: unknownViolations, privilegedEvidenceViolations: privileged, invalidToolCalls: session.invalidToolCalls, staleRevisionRefusals: session.staleRevisionRefusals, calls: session.calls.length };
}
/** Evaluator-only oracle. Never register this function in agent tools or place its outputs in prompts. */
export function oracleLabEpisode(c: LabCase): { session: LabSession; answer: LabAnswer; score: LabScore } {
  const s = createLabSession(c), e = c.privateExpected;
  const call = (name: string, args: Record<string, unknown>) => dispatchLabTool(s, name, name === 'lab_inspect' ? args : { ...args, expectedRevision: s.currentRevision });
  call('lab_inspect', { sceneRef: c.sceneId });
  if (e.cameraPoint) call('lab_transform', { point: e.cameraPoint, fromFrame: 'camera', toFrame: 'world' });
  if (e.queryPoint) call('lab_query', { pointMm: e.queryPoint });
  if (e.editSteps) {
    call('lab_propose', { objectId: e.targetId, operation: 'translate', vectorMm: e.delta });
    if (e.editSteps === 2) call('lab_propose', { objectId: e.targetId, operation: 'rotate', angleDeg: e.rotation });
    call('lab_verify', {});
  } else if (e.status === 'answered' && !['frame-chain', 'boundary-probe'].includes(c.family)) {
    call('lab_measure', { objectId: e.targetId }); if (c.family === 'equal-volume-pair') call('lab_measure', { objectId: c.scene.objects[1].id });
  }
  const answer: LabAnswer = { status: e.status, facts: clone(e.facts), evidenceByFact: {}, ...(e.editSteps ? { candidateRevision: s.currentRevision } : {}), ...(e.status === 'insufficient_evidence' ? { missingEvidence: clone(e.missingEvidence) } : {}) };
  for (const key of e.status === 'insufficient_evidence' ? ['missingEvidence'] : Object.keys(e.facts)) {
    const value = key === 'missingEvidence' ? e.missingEvidence : e.facts[key];
    const usable = s.evidence.filter(ev => ev.revision === s.currentRevision && evidenceSupports(ev, key, value, citationContext(c, answer, s.scene)));
    answer.evidenceByFact[key] = ['targetIds', 'volumesEqual', 'shapesEqual'].includes(key) ? usable.map(ev => ev.evidenceId) : usable.slice(-1).map(ev => ev.evidenceId);
  }
  return { session: s, answer, score: scoreLabEpisode(c, s, answer) };
}
export function propertyProbeLab(count = 1200, seedStart = 0): { cases: number; checks: number; failures: Array<{ caseId: string; invariant: string }>; generatorHash: string } {
  const cases = generateLabCases('development', count, seedStart, 2), failures: Array<{ caseId: string; invariant: string }> = []; let checks = 0;
  const check = (condition: boolean, c: LabCase, invariant: string) => { checks++; if (!condition) failures.push({ caseId: c.id, invariant }); };
  for (const c of cases) {
    const s = createLabSession(c), o = s.scene.objects[0], beforeVolume = volume(o.shape), before = canonical(s.source), p: LabVec3 = [c.seed % 17 - 8, 3.7, -9];
    const world = add(rotate(p, c.scene.frame.angleDeg), c.scene.frame.originMm), restored = rotate(sub(world, c.scene.frame.originMm), -c.scene.frame.angleDeg);
    check(norm(sub(restored, p)) < 1e-10, c, 'rigid_frame_round_trip');
    dispatchLabTool(s, 'lab_propose', { objectId: o.id, operation: 'translate', vectorMm: [1, 2, .5], expectedRevision: s.currentRevision });
    dispatchLabTool(s, 'lab_propose', { objectId: o.id, operation: 'rotate', angleDeg: 31.7, expectedRevision: s.currentRevision });
    check(close(volume(s.scene.objects[0].shape), beforeVolume), c, 'rigid_edit_volume'); check(geometryInvariant(s).valid, c, 'candidate_replay');
    const staleBefore = canonical(s.scene), rejected = dispatchLabTool(s, 'lab_propose', { objectId: o.id, operation: 'translate', vectorMm: [1, 0, 0], expectedRevision: s.sourceRevision });
    check(rejected.code === 'stale_revision' && canonical(s.scene) === staleBefore && canonical(s.source) === before, c, 'stale_never_mutates');
    const unknown = c.scene.unknownBox.min.map((v, i) => (v + c.scene.unknownBox.max[i]) / 2) as LabVec3;
    check(pointState(c.scene, unknown).pointState === 'unknown', c, 'unknown_not_empty');
    const oracle = oracleLabEpisode(c); check(oracle.score.verifiedTaskSuccess, c, 'oracle_expected_and_evidence');
  }
  return { cases: cases.length, checks, failures, generatorHash: labHash({ version: 1, families, bases }) };
}
/** Delta-debug the scene only. It retains the failure predicate, source identity and units;
 * returned fixture is evaluator-private, not a regenerated benchmark/training example. */
export function shrinkLabCounterexample(c: LabCase, stillFails: (candidate: LabCase) => boolean): { case: LabCase; removedObjects: number; attempts: number; minimalUnder: string } {
  let current = clone(c), removedObjects = 0, attempts = 0;
  if (!stillFails(current)) throw new Error('counterexample_does_not_fail');
  for (const o of [...current.scene.objects]) {
    if (o.id === c.privateExpected.targetId) continue; const next = clone(current); next.scene.objects = next.scene.objects.filter(x => x.id !== o.id); attempts++;
    next.publicTask.initialRevision = labSceneRevision(next.scene); if (stillFails(next)) { current = next; removedObjects++; }
  }
  return { case: current, removedObjects, attempts, minimalUnder: 'deletion of non-target objects only; no global minimality claim' };
}
