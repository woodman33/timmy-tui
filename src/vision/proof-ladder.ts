import { existsSync, readFileSync } from 'node:fs';
import { imageHash, listVisionEvents, verifyVisionEvent, visionHash, type VisionEvent, type VisionStoreOptions } from './store.js';
import { publicVisionEvent } from './presentation.js';

export const HOUDINI_PROOF_FRAMES = [1, 61, 121, 181, 240] as const;
export interface ProofLadderCheck { id: string; label: string; output: string; className?: string }
export interface ProofLadderManifest {
  schema: 'timmy-houdini-proof-inputs/1'; project: string; sceneSHA256: string; fps: number;
  workflow: { specificationSHA256?: string; workflowId?: string; workspace?: string };
  checks: ProofLadderCheck[];
  frames: { frame: number; imagePath: string; imageSHA256: string; imageSrc?: string }[];
}
export interface VisibilityObservation {
  id: string; label: string; state: 'detected' | 'not_detected' | 'not_reported';
  count: number | null; minConfidence: number | null; maxConfidence: number | null;
  boundingBoxes: { x: number; y: number; width: number; height: number }[];
  note: string;
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function output(result: unknown, key: string): unknown {
  // Image inspections return one Workflow output object, commonly wrapped in a one-item batch.
  const body = object(Array.isArray(result) && result.length === 1 ? result[0] : result);
  return body && Object.hasOwn(body, key) ? body[key] : undefined;
}
function predictions(value: unknown): unknown[] | undefined {
  const rows = Array.isArray(value) ? value : object(value)?.predictions;
  return Array.isArray(rows) && rows.every(value => { const row = object(value); return row && ['x','y','width','height'].every(key => typeof row[key] === 'number' && Number.isFinite(row[key])); }) ? rows : undefined;
}
export function visibilityObservations(event: VisionEvent, checks: ProofLadderCheck[]): VisibilityObservation[] {
  return checks.map(check => {
    const reported = predictions(output(event.result, check.output));
    const rows = check.className && reported ? reported.filter(value => object(value)?.class === check.className) : reported;
    const scores: number[] = [];
    const boxes: VisibilityObservation['boundingBoxes'] = [];
    if (rows) for (const value of rows.slice(0, 10000)) {
      const row = object(value); if (!row) continue;
      const confidence = row.confidence;
      if (typeof confidence === 'number' && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1) scores.push(confidence);
      if (['x','y','width','height'].every(key => typeof row[key] === 'number' && Number.isFinite(row[key]))) {
        boxes.push({ x: row.x as number, y: row.y as number, width: row.width as number, height: row.height as number });
      }
    }
    return { id: check.id, label: check.label, state: rows ? rows.length ? 'detected' : 'not_detected' : 'not_reported',
      count: rows ? rows.length : null, minConfidence: scores.length ? Math.min(...scores) : null,
      maxConfidence: scores.length ? Math.max(...scores) : null, boundingBoxes: boxes,
      note: !rows ? 'The selected Workflow did not report this output.' : rows.length
        ? 'Model-reported segmentation; review the mask against the native frame.'
        : 'No segmentation was reported. This does not prove the object is absent or invisible.' };
  });
}
export function validateProofManifest(manifest: ProofLadderManifest) {
  if (manifest.schema !== 'timmy-houdini-proof-inputs/1' || !/^[a-f0-9]{64}$/.test(manifest.sceneSHA256)) throw new Error('Invalid proof manifest or scene hash.');
  if (!manifest.project || !Number.isFinite(manifest.fps) || manifest.fps <= 0) throw new Error('A project and positive frame rate are required.');
  if (manifest.frames.length !== HOUDINI_PROOF_FRAMES.length || !HOUDINI_PROOF_FRAMES.every((frame, i) => manifest.frames[i].frame === frame)) throw new Error('Expected native frames 1, 61, 121, 181 and 240 in order.');
  if (!manifest.workflow.specificationSHA256 && !manifest.workflow.workflowId) throw new Error('Pin a Workflow definition hash or saved Workflow ID.');
  if (manifest.workflow.specificationSHA256 && !/^[a-f0-9]{64}$/.test(manifest.workflow.specificationSHA256)) throw new Error('Invalid Workflow definition hash.');
  if (!manifest.checks.length || new Set(manifest.checks.map(check => check.id)).size !== manifest.checks.length || manifest.checks.some(check => !/^[a-z][a-z0-9_]*$/.test(check.output))) throw new Error('Checks require unique IDs and explicit output names.');
  for (const frame of manifest.frames) if (!/^[a-f0-9]{64}$/.test(frame.imageSHA256)) throw new Error(`Frame ${frame.frame} needs its exact image hash.`);
}
function matches(event: VisionEvent, manifest: ProofLadderManifest, frame: ProofLadderManifest['frames'][number]) {
  const metadata = object(event.metadata.houdini);
  return metadata?.project === manifest.project && metadata.sceneSHA256 === manifest.sceneSHA256 && metadata.frame === frame.frame
    && event.image.sha256 === frame.imageSHA256
    && (manifest.workflow.specificationSHA256 ? event.provenance.specificationHash === manifest.workflow.specificationSHA256
      : event.provenance.workflowId === manifest.workflow.workflowId && (!manifest.workflow.workspace || event.provenance.workspace === manifest.workflow.workspace));
}

/** Read-only projection of signed, matching Timmy Vision observations. Never launches inference. */
export function buildProofLadder(manifest: ProofLadderManifest, options: VisionStoreOptions = {}) {
  validateProofManifest(manifest);
  const events = listVisionEvents({ limit: 500 }, options).events;
  const frames = manifest.frames.map(frame => {
    const base = { frame: frame.frame, timeSeconds: (frame.frame - 1) / manifest.fps, imageSHA256: frame.imageSHA256,
      imageSrc: frame.imageSrc?.startsWith('/') && !frame.imageSrc.startsWith('//') ? frame.imageSrc : undefined };
    if (!existsSync(frame.imagePath)) return { ...base, state: 'missing_frame', note: 'Native frame input is unavailable.', observations: [] as VisibilityObservation[] };
    if (imageHash(readFileSync(frame.imagePath)) !== frame.imageSHA256) return { ...base, state: 'integrity_error', note: 'Native frame bytes differ from the pinned input.', observations: [] as VisibilityObservation[] };
    const event = events.find(candidate => matches(candidate, manifest, frame));
    if (!event) return { ...base, state: 'pending_inspection', note: 'No matching Timmy Vision inspection has been run for this scene, frame and Workflow.', observations: [] as VisibilityObservation[] };
    if (!verifyVisionEvent(event, options) || !existsSync(event.image.path) || imageHash(readFileSync(event.image.path)) !== event.image.sha256) {
      return { ...base, state: 'integrity_error', note: 'Stored image or signed observation failed verification.', observations: [] as VisibilityObservation[] };
    }
    const presented = publicVisionEvent(event);
    return { ...base, state: event.state, eventId: event.id, receiptHash: event.receiptHash, resultHash: event.resultHash,
      observedAt: event.timestamp, needsReview: event.needsReview, feedback: event.feedback ? { verdict: event.feedback.verdict, receiptHash: event.feedback.receiptHash } : undefined,
      provenance: { runtime: event.provenance.runtime, workflowId: event.provenance.workflowId, specificationSHA256: event.provenance.specificationHash, sdkVersion: event.provenance.sdkVersion },
      outputImages: presented.outputs.map(image => ({ sha256: image.sha256, src: `http://127.0.0.1:4336${image.url}`, mimeType: image.mimeType })),
      observations: event.state === 'observed' ? visibilityObservations(event, manifest.checks) : [],
      note: event.state === 'observed' ? 'Receipt and input verified. Model observations still require visual review.' : 'The inspection failed; no visibility observations are claimed.' };
  });
  return { schema: 'timmy-houdini-proof-ladder/1', project: manifest.project, sceneSHA256: manifest.sceneSHA256, fps: manifest.fps,
    inputManifestSHA256: visionHash(manifest), checks: manifest.checks, workflow: manifest.workflow,
    state: frames.every(frame => frame.state === 'observed') ? 'observations_available' : 'pending',
    frames, note: 'Native render proof and model observations are separate evidence. Non-detection is not proof of absence; this report does not certify photorealism.' };
}
