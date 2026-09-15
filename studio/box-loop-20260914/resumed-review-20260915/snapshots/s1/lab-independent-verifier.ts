import { createHash } from 'node:crypto';
import type { LabCase, LabSession, LabScene, LabShape, LabVec3 } from './lab-challenges.js';

/** Independent numerical/replay audit for the bounded analytic lab, not arbitrary meshes.
 * No engine measurements, oracle answers, or engine geometry helpers are imported. */
export interface IndependentLabVerification {
  valid: boolean; checks: Record<string, boolean>; failures: string[]; volumesMm3: Record<string, number>;
}
const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => JSON.stringify(k) + ':' + canonical(x)).join(',') + '}';
  if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('Nonfinite geometry.');
  const s = JSON.stringify(v); if (s === undefined) throw new Error('Non-JSON geometry.'); return s;
};
const revision = (scene: LabScene) => createHash('sha256').update(canonical(scene)).digest('hex');
const vec = (v: unknown): v is LabVec3 => Array.isArray(v) && v.length === 3 && v.every(x => typeof x === 'number' && Number.isFinite(x));
const near = (a: unknown, b: number) => typeof a === 'number' && Number.isFinite(a) && Math.abs(a - b) <= Math.max(1e-8, Math.abs(b) * 1e-9);
const nearVec = (a: unknown, b: LabVec3) => vec(a) && a.every((x, i) => near(x, b[i]));
const matrixZ = (angle: number): number[][] => { const radians = angle / 180 * Math.PI; return [[Math.cos(radians), -Math.sin(radians), 0], [Math.sin(radians), Math.cos(radians), 0], [0, 0, 1]]; };
const multiply = (matrix: number[][], vector: LabVec3): LabVec3 => matrix.map(row => row.reduce((n, coefficient, i) => n + coefficient * vector[i], 0)) as LabVec3;

function shapeValid(shape: LabShape): boolean {
  return ['sphere', 'shell', 'box'].includes(shape.kind) && vec(shape.center) && vec(shape.halfExtents) && shape.halfExtents.every(x => x > 0)
    && Number.isFinite(shape.angleDeg) && Number.isFinite(shape.radius) && shape.radius > 0 && Number.isFinite(shape.innerRadius)
    && shape.innerRadius >= 0 && (shape.kind !== 'shell' || shape.innerRadius < shape.radius);
}
/** Simpson integrates each polynomial region independently; shell breakpoints avoid a discontinuous second derivative. */
function simpson(fn: (z: number) => number, low: number, high: number): number {
  if (low === high) return 0;
  const intervals = 16, width = (high - low) / intervals;
  let total = fn(low) + fn(high);
  for (let i = 1; i < intervals; i++) total += (i % 2 ? 4 : 2) * fn(low + i * width);
  return total * width / 3;
}
function independentVolume(shape: LabShape): number {
  if (!shapeValid(shape)) throw new Error('Invalid primitive parameters.');
  if (shape.kind === 'box') {
    const matrix = matrixZ(shape.angleDeg), [hx, hy, hz] = shape.halfExtents;
    const [a, b, c] = [multiply(matrix, [2 * hx, 0, 0]), multiply(matrix, [0, 2 * hy, 0]), multiply(matrix, [0, 0, 2 * hz])];
    return Math.abs(a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]));
  }
  const outer = shape.radius, inner = shape.kind === 'shell' ? shape.innerRadius : 0;
  const outerSection = (z: number) => Math.PI * Math.max(0, outer * outer - z * z);
  const annulusSection = (z: number) => outerSection(z) - Math.PI * Math.max(0, inner * inner - z * z);
  return 2 * (simpson(annulusSection, 0, inner) + simpson(outerSection, inner, outer));
}
function insideDomain(shape: LabShape): boolean {
  if (!shapeValid(shape)) return false;
  if (shape.kind !== 'box') return shape.center.every(coordinate => coordinate - shape.radius >= -60 && coordinate + shape.radius <= 60);
  const rotation = matrixZ(shape.angleDeg);
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
    const offset = multiply(rotation, [x * shape.halfExtents[0], y * shape.halfExtents[1], z * shape.halfExtents[2]]);
    if (offset.some((value, axis) => shape.center[axis] + value < -60 - 1e-10 || shape.center[axis] + value > 60 + 1e-10)) return false;
  }
  return true;
}
function sceneValid(scene: LabScene): boolean {
  return scene.units === 'mm' && Number.isFinite(scene.toleranceMm) && scene.toleranceMm >= 0 && vec(scene.frame.originMm)
    && Number.isFinite(scene.frame.angleDeg) && vec(scene.grid.originMm) && vec(scene.grid.cellSizeMm) && scene.grid.cellSizeMm.every(x => x > 0)
    && vec(scene.unknownBox.min) && vec(scene.unknownBox.max) && scene.unknownBox.min.every((x, i) => x <= scene.unknownBox.max[i])
    && Array.isArray(scene.objects) && scene.objects.length > 0 && new Set(scene.objects.map(o => o.id)).size === scene.objects.length
    && scene.objects.every(o => typeof o.id === 'string' && o.id.length > 0 && shapeValid(o.shape));
}

export function independentlyVerifyLabSession(item: LabCase, session: LabSession): IndependentLabVerification {
  const checks: Record<string, boolean> = { sourceBinding: true, sourceUnchanged: true, primitiveValidity: true, domainBounds: true,
    editRevisionChain: true, editCallBinding: true, candidateReplay: true, finalRevision: true,
    evidenceRevisions: true, evidenceCallBinding: true, measuredVolumes: true, measurementCoordinates: true };
  const volumesMm3: Record<string, number> = {};
  const check = (key: string, passed: boolean) => { checks[key] = checks[key] && passed; };
  try {
    const initialRevision = revision(item.scene);
    check('sourceBinding', item.id === session.caseId && item.sceneId === session.sceneRef && item.scene.id === session.sceneRef
      && item.publicTask.sceneRef === session.sceneRef && item.publicTask.initialRevision === initialRevision && session.sourceRevision === initialRevision);
    check('sourceUnchanged', canonical(item.scene) === canonical(session.source) && revision(session.source) === session.sourceRevision);
    let candidate = structuredClone(item.scene), previousRevision = initialRevision;
    const history = new Map<string, LabScene>([[initialRevision, structuredClone(candidate)]]);
    const examineScene = (scene: LabScene) => {
      check('primitiveValidity', sceneValid(scene)); check('domainBounds', scene.objects.every(o => insideDomain(o.shape)));
    };
    examineScene(candidate);
    const successfulProposals = session.calls.filter(call => call.name === 'lab_propose' && typeof call.output.evidenceId === 'string');
    check('editCallBinding', successfulProposals.length === session.edits.length);
    check('editRevisionChain', session.edits.length <= 8);
    for (const [index, edit] of session.edits.entries()) {
      check('editRevisionChain', edit.sourceRevision === previousRevision);
      const object = candidate.objects.find(o => o.id === edit.objectId);
      if (!object) { check('candidateReplay', false); continue; }
      const call = successfulProposals[index], args = call?.args as Record<string, unknown> | undefined;
      check('editCallBinding', !!args && args.objectId === edit.objectId && args.operation === edit.operation && args.expectedRevision === edit.sourceRevision
        && call.output.candidateRevision === edit.candidateRevision && call.output.revision === edit.candidateRevision);
      if (edit.operation === 'translate') {
        if (!vec(edit.vectorMm) || edit.vectorMm.some(x => Math.abs(x) > 1000) || edit.angleDeg !== undefined) { check('candidateReplay', false); continue; }
        check('editCallBinding', !!args && nearVec(args.vectorMm, edit.vectorMm));
        const origin = object.shape.center;
        object.shape.center = [origin[0] + edit.vectorMm[0], origin[1] + edit.vectorMm[1], origin[2] + edit.vectorMm[2]];
      } else if (edit.operation === 'rotate') {
        if (typeof edit.angleDeg !== 'number' || !Number.isFinite(edit.angleDeg) || Math.abs(edit.angleDeg) > 360 || edit.vectorMm !== undefined) { check('candidateReplay', false); continue; }
        check('editCallBinding', !!args && near(args.angleDeg, edit.angleDeg)); object.shape.angleDeg += edit.angleDeg;
      } else { check('candidateReplay', false); continue; }
      const actualRevision = revision(candidate);
      check('editRevisionChain', edit.candidateRevision === actualRevision); previousRevision = actualRevision;
      history.set(actualRevision, structuredClone(candidate)); examineScene(candidate);
    }
    examineScene(session.scene);
    check('candidateReplay', canonical(candidate) === canonical(session.scene));
    check('finalRevision', previousRevision === session.currentRevision && revision(session.scene) === session.currentRevision);
    for (const object of session.scene.objects) if (shapeValid(object.shape)) volumesMm3[object.id] = independentVolume(object.shape);

    const seen = new Set<string>();
    for (const evidence of session.evidence) {
      const scene = history.get(evidence.revision);
      check('evidenceRevisions', !!scene && evidence.output.revision === evidence.revision);
      const matchingCalls = session.calls.filter(call => call.output.evidenceId === evidence.evidenceId);
      check('evidenceCallBinding', !seen.has(evidence.evidenceId) && evidence.output.evidenceId === evidence.evidenceId && matchingCalls.length === 1
        && canonical(matchingCalls[0].output) === canonical(evidence.output));
      seen.add(evidence.evidenceId);
      if (!scene) continue;
      check('evidenceRevisions', evidence.objectIds.every(id => scene.objects.some(o => o.id === id)));
      const verifyMeasurement = (measurement: Record<string, unknown>, fallbackId?: string) => {
        const id = typeof measurement.targetId === 'string' ? measurement.targetId : fallbackId;
        const object = scene.objects.find(o => o.id === id);
        if ('volumeMm3' in measurement) check('measuredVolumes', !!object && near(measurement.volumeMm3, independentVolume(object.shape)));
        if ('centroidWorldMm' in measurement) check('measurementCoordinates', !!object && nearVec(measurement.centroidWorldMm, object.shape.center));
        if ('angleDeg' in measurement) check('measurementCoordinates', !!object && near(measurement.angleDeg, object.shape.angleDeg));
        if ('primitive' in measurement) check('measurementCoordinates', !!object && canonical(measurement.primitive) === canonical(object.shape));
      };
      const singleton = evidence.objectIds.length === 1 ? evidence.objectIds[0] : undefined;
      verifyMeasurement(evidence.facts, singleton);
      if (evidence.output.facts && typeof evidence.output.facts === 'object') verifyMeasurement(evidence.output.facts as Record<string, unknown>, singleton);
      if (evidence.output.primitive) verifyMeasurement({ primitive: evidence.output.primitive }, singleton);
      if (Array.isArray(evidence.output.objects)) for (const row of evidence.output.objects) if (row && typeof row === 'object') verifyMeasurement(row as Record<string, unknown>);
    }
    check('evidenceCallBinding', session.calls.filter(call => typeof call.output.evidenceId === 'string').every(call => seen.has(String(call.output.evidenceId))));
  } catch { checks.verifierInputValid = false; }
  const failures = Object.entries(checks).filter(([, valid]) => !valid).map(([name]) => name);
  return { valid: failures.length === 0, checks, failures, volumesMm3 };
}
