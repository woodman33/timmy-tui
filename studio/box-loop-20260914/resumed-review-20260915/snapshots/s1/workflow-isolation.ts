/** Zero-model diagnostic controls for the analytic spatial tools.
 * A simulated serialization boundary is not a network, MCP, or native-software test.
 * Fixtures and independent measurements stay in the evaluator, never in model context.
 */
import { createHash } from 'node:crypto';
import { createLabSession, dispatchLabTool, generateLabCases, labSceneRevision, type LabCase, type LabSession, type LabVec3 } from './lab-challenges.js';
import { independentlyVerifyLabSession } from './lab-independent-verifier.js';

type JsonObject = Record<string, unknown>;
export type WorkflowIsolationCause = 'none' | 'tool_logic' | 'transport_contract' | 'revision_contract' | 'source_integrity' | 'geometry_contract' | 'admission_contract' | 'availability_unobserved';
export interface WorkflowIsolationCheck {
  id: string; componentId: string; toolIds: string[]; family: string;
  expected: 'success' | 'refusal' | 'fault_detected' | 'unknown';
  passed: boolean | null; cause: WorkflowIsolationCause;
  observation: unknown; sha256: string;
}
export interface SoftwareAdapterAdmission {
  software: string; version: string | null; adapterHash: string | null;
  frame: string | null; units: string | null; revision: string | null; contentHash: string | null;
  status: 'unprobed' | 'mock_tested' | 'native_tested';
}
export interface SoftwareAdapterEvidence {
  execution: 'mock' | 'native'; software: string; version: string; adapterHash: string;
  frame: string; units: string; revision: string; contentHash: string; receiptHash?: string;
}
export interface SoftwareAdmissionDecision { admitted: boolean; nativeEvidenceAccepted: boolean; reasons: string[] }
export interface WorkflowIsolationReport {
  schema: 'timmy.workflow-isolation.v1'; passed: boolean;
  scope: { modelCalls: 0; networkCalls: 0; nativeCalls: 0; transport: 'in-memory JSON serialization only'; geometry: string; inference: string };
  checks: WorkflowIsolationCheck[];
  components: Array<{ id: string; status: 'observed' | 'unknown'; passed: number; failed: number; unknown: number }>;
  admissions: SoftwareAdapterAdmission[]; observationsHash: string;
}
const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);
const vector = (value: unknown): value is LabVec3 => Array.isArray(value) && value.length === 3 && value.every(v => typeof v === 'number' && Number.isFinite(v));
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const near = (a: unknown, b: number) => typeof a === 'number' && Math.abs(a - b) <= Math.max(1e-8, Math.abs(b) * 1e-9);
const nearVector = (a: unknown, b: LabVec3) => vector(a) && a.every((v, i) => near(v, b[i]));
const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** Contract admission is distinct from testing software quality. Native evidence requires
 * an independent receipt verifier supplied by the runtime; a string or mock cannot grant it.
 * This module never launches software or fabricates a native receipt verifier.
 */
export function validateSoftwareAdmission(
  admission: SoftwareAdapterAdmission,
  evidence?: SoftwareAdapterEvidence,
  verifyNativeReceipt?: (receiptHash: string, evidence: SoftwareAdapterEvidence) => boolean,
): SoftwareAdmissionDecision {
  const reasons: string[] = [];
  if (!admission.software || !['unprobed', 'mock_tested', 'native_tested'].includes(admission.status)) reasons.push('invalid_admission');
  if (admission.status === 'unprobed') {
    if (evidence) reasons.push('unprobed_with_execution_evidence');
    return { admitted: reasons.length === 0, nativeEvidenceAccepted: false, reasons };
  }
  const fields = ['software', 'version', 'adapterHash', 'frame', 'units', 'revision', 'contentHash'] as const;
  if (fields.some(key => typeof admission[key] !== 'string' || !admission[key])) reasons.push('incomplete_identity_or_spatial_contract');
  if (!hex(admission.adapterHash) || !hex(admission.contentHash)) reasons.push('invalid_content_or_adapter_hash');
  if (!evidence || fields.some(key => admission[key] !== evidence[key])) reasons.push('execution_evidence_mismatch');
  const expectedExecution = admission.status === 'native_tested' ? 'native' : 'mock';
  if (evidence?.execution !== expectedExecution) reasons.push('execution_kind_mismatch');
  if (admission.status === 'native_tested') {
    let verified = false;
    if (reasons.length === 0 && evidence?.execution === 'native' && hex(evidence.receiptHash) && verifyNativeReceipt) {
      try { verified = verifyNativeReceipt(evidence.receiptHash, evidence) === true; } catch { verified = false; }
    }
    if (!verified) reasons.push('native_receipt_not_independently_verified');
  }
  return { admitted: reasons.length === 0, nativeEvidenceAccepted: admission.status === 'native_tested' && reasons.length === 0, reasons };
}
export const admitSoftwareAdapter = validateSoftwareAdmission;

export interface WorkflowWireRequest { id: string; tool: string; args: JsonObject }
export interface WorkflowWireResponse {
  id: string; transport: 'simulated-json'; frame: 'world'; units: 'mm';
  result?: JsonObject; error?: { code: string };
}
/** JSON-RPC-like, deliberately not advertised as compliant MCP or actual RPC. */
export function dispatchSimulatedWorkflowTransport(session: LabSession, request: WorkflowWireRequest): WorkflowWireResponse {
  const decoded: unknown = JSON.parse(JSON.stringify(request));
  if (!object(decoded) || typeof decoded.id !== 'string' || typeof decoded.tool !== 'string' || !object(decoded.args)) {
    return { id: typeof request?.id === 'string' ? request.id : 'invalid', transport: 'simulated-json', frame: 'world', units: 'mm', error: { code: 'invalid_request' } };
  }
  const result = dispatchLabTool(session, decoded.tool, decoded.args);
  return JSON.parse(JSON.stringify({ id: decoded.id, transport: 'simulated-json', frame: 'world', units: 'mm', result })) as WorkflowWireResponse;
}

/** Validate binding and basic shape before any result may become context. Numerical
 * geometry validation remains a separate independent measurement/replay check. */
export function validateWorkflowWireResponse(request: WorkflowWireRequest, response: unknown, expectedRevision: string): { valid: boolean; failures: string[] } {
  const failures: string[] = [];
  if (!object(request) || typeof request.id !== 'string' || typeof request.tool !== 'string' || !object(request.args)) return { valid: false, failures: ['request_shape'] };
  if (!object(response)) return { valid: false, failures: ['response_shape'] };
  if (response.id !== request.id || response.transport !== 'simulated-json') failures.push('request_binding');
  if (response.frame !== 'world' || response.units !== 'mm') failures.push('spatial_contract');
  if (response.error !== undefined) failures.push(object(response.error) && response.error.code === 'simulated_timeout' ? 'simulated_timeout' : 'transport_error');
  const result = response.result;
  if (!object(result)) return { valid: false, failures: [...failures, 'result_shape'] };
  if (result.status === 'refused') {
    if (typeof result.code !== 'string' || result.sourceWritten !== false || result.revision !== expectedRevision) failures.push('refusal_contract');
    return { valid: failures.length === 0, failures };
  }
  if (!['ok', 'proposed'].includes(String(result.status))) failures.push('result_status');
  if (typeof result.evidenceId !== 'string' || !result.evidenceId) failures.push('missing_evidence');
  if (result.revision !== expectedRevision) failures.push('revision_binding');
  const facts = result.facts;
  if (request.tool === 'lab_measure' || request.tool === 'lab_propose') {
    if (!object(facts) || facts.targetId !== request.args.objectId) failures.push('object_binding');
    if (!object(facts) || !vector(facts.centroidWorldMm) || typeof facts.volumeMm3 !== 'number' || !Number.isFinite(facts.volumeMm3) || facts.volumeMm3 < 0) failures.push('measurement_shape');
  }
  if (request.tool === 'lab_measure') {
    const primitive = result.primitive;
    if (!object(primitive) || !['sphere', 'shell', 'box'].includes(String(primitive.kind)) || !vector(primitive.center) || !vector(primitive.halfExtents)
      || primitive.halfExtents.some(x => x <= 0) || typeof primitive.radius !== 'number' || !Number.isFinite(primitive.radius) || primitive.radius <= 0
      || typeof primitive.innerRadius !== 'number' || !Number.isFinite(primitive.innerRadius) || primitive.innerRadius < 0
      || typeof primitive.angleDeg !== 'number' || !Number.isFinite(primitive.angleDeg)
      || primitive.kind === 'shell' && primitive.innerRadius >= primitive.radius) failures.push('primitive_shape');
  }
  if (request.tool === 'lab_transform') {
    const key = request.args.toFrame === 'world' ? 'pointWorldMm' : 'pointCameraMm';
    if (!object(facts) || !vector(facts[key]) || result.units !== 'mm' || result.fromFrame !== request.args.fromFrame || result.toFrame !== request.args.toFrame) failures.push('transform_contract');
  }
  if (request.tool === 'lab_query' && (!object(facts) || !['solid', 'empty', 'boundary', 'unknown'].includes(String(facts.pointState)) || !vector(request.args.pointMm) || !nearVector(facts.pointWorldMm, request.args.pointMm)
    || facts.pointState === 'unknown' && facts.signedDistanceMm !== null)) failures.push('query_contract');
  if (request.tool === 'lab_propose' && (result.status !== 'proposed' || result.candidateRevision !== expectedRevision || result.sourceWritten !== false)) failures.push('proposal_contract');
  if (request.tool === 'lab_verify' && (typeof result.valid !== 'boolean' || result.candidateRevision !== expectedRevision || !Array.isArray(result.objects))) failures.push('verification_contract');
  if (request.tool === 'lab_inspect' && (!Array.isArray(result.objects) || !object(result.grid) || typeof result.sourceRevision !== 'string')) failures.push('inventory_contract');
  return { valid: failures.length === 0, failures };
}

export function runWorkflowIsolation(): WorkflowIsolationReport {
  const checks: WorkflowIsolationCheck[] = [];
  const add = (id: string, componentId: string, toolIds: string[], family: string, expected: WorkflowIsolationCheck['expected'], passed: boolean | null, cause: WorkflowIsolationCause, observation: unknown) => {
    checks.push({ id, componentId, toolIds, family, expected, passed, cause, observation, sha256: hash(observation) });
  };
  // Sixteen development fixtures suffice to cover the eight paired analytic families.
  // No privateExpected fields are read and no evaluator scenes are sent to a model.
  const fixtures = generateLabCases('development', 16, 3817, 'screen');
  const find = (family: LabCase['family'], variant = 0) => structuredClone(fixtures.find(c => c.family === family && c.pairVariant === variant)!);
  const sphere = () => find('topology-pair', 1), shell = () => find('topology-pair'), box = () => find('frame-chain');
  const observe = (item: LabCase, tool: string, args: (session: LabSession) => JsonObject) => {
    const session = createLabSession(item), input = args(session), before = hash(input), output = dispatchLabTool(session, tool, input);
    return { session, input, inputUnchanged: before === hash(input), output, independent: independentlyVerifyLabSession(item, session) };
  };
  const toolCheck = (id: string, tool: string, family: string, observed: ReturnType<typeof observe>, predicate: boolean, expected: 'success' | 'refusal' = 'success') => {
    const passed = predicate && observed.inputUnchanged && observed.independent.valid;
    add(id, `tool:${tool}`, [tool], family, expected, passed, passed ? 'none' : observed.independent.valid ? 'tool_logic' : 'geometry_contract', {
      request: { name: tool, args: observed.input }, actualToolResult: observed.output, inputUnchanged: observed.inputUnchanged, independent: observed.independent,
    });
  };
  {
    const c = box(), row = observe(c, 'lab_inspect', s => ({ sceneRef: s.sceneRef }));
    toolCheck('direct.inventory', 'lab_inspect', 'inventory', row, Array.isArray(row.output.objects) && row.output.objects.length === 2);
  }
  for (const [kind, fixture] of [['sphere', sphere], ['shell', shell], ['box', box]] as const) {
    const c = fixture(), target = c.scene.objects[0], row = observe(c, 'lab_measure', s => ({ objectId: target.id, expectedRevision: s.currentRevision }));
    const facts = row.output.facts as JsonObject;
    toolCheck(`direct.volume.${kind}`, 'lab_measure', 'measurement', row, near(facts.volumeMm3, row.independent.volumesMm3[target.id]) && nearVector(facts.centroidWorldMm, target.shape.center));
  }
  const pointControls: Array<{ id: string; fixture: () => LabCase; point: (c: LabCase) => LabVec3; expected: string }> = [
    { id: 'solid', fixture: sphere, point: c => c.scene.objects[0].shape.center, expected: 'solid' },
    { id: 'empty', fixture: sphere, point: () => [0, 0, 0], expected: 'empty' },
    { id: 'cavity', fixture: shell, point: c => c.scene.objects[0].shape.center, expected: 'empty' },
    { id: 'unknown', fixture: sphere, point: () => [35, 35, 35], expected: 'unknown' },
    { id: 'outside', fixture: sphere, point: () => [61, 0, 0], expected: 'unknown' },
    { id: 'boundary', fixture: sphere, point: c => { const shape = c.scene.objects[0].shape; return [shape.center[0] + shape.radius, shape.center[1], shape.center[2]]; }, expected: 'boundary' },
    { id: 'negative-cell-index', fixture: sphere, point: c => [c.scene.grid.originMm[0] - .5, c.scene.grid.originMm[1], c.scene.grid.originMm[2]], expected: 'empty' },
  ];
  for (const control of pointControls) {
    const c = control.fixture(), p = control.point(c), row = observe(c, 'lab_query', s => ({ pointMm: p, expectedRevision: s.currentRevision })), facts = row.output.facts as JsonObject;
    const cell = p.map((value, axis) => Math.floor((value - c.scene.grid.originMm[axis]) / c.scene.grid.cellSizeMm[axis]));
    toolCheck(`direct.query.${control.id}`, 'lab_query', 'containment', row, facts.pointState === control.expected && equal(facts.cellIndex, cell) && (control.expected !== 'unknown' || facts.signedDistanceMm === null));
  }
  for (const direction of ['identity', 'camera-world', 'world-camera'] as const) {
    const c = box(), p: LabVec3 = direction === 'world-camera' ? c.scene.frame.originMm : [0, 0, 0];
    const fromFrame = direction === 'world-camera' ? 'world' : 'camera', toFrame = direction === 'identity' || direction === 'world-camera' ? 'camera' : 'world';
    const row = observe(c, 'lab_transform', s => ({ point: p, fromFrame, toFrame, expectedRevision: s.currentRevision }));
    const target: LabVec3 = direction === 'camera-world' ? c.scene.frame.originMm : [0, 0, 0];
    toolCheck(`direct.transform.${direction}`, 'lab_transform', 'coordinates', row, nearVector((row.output.facts as JsonObject)[toFrame === 'world' ? 'pointWorldMm' : 'pointCameraMm'], target));
  }
  {
    // An exact quarter turn checks orientation and translation separately from a
    // round trip, where two equally incorrect inverse transforms could cancel.
    const c = box(); c.scene.frame.angleDeg = 90; c.publicTask.initialRevision = labSceneRevision(c.scene);
    const row = observe(c, 'lab_transform', s => ({ point: [2, -3, 4], fromFrame: 'camera', toFrame: 'world', expectedRevision: s.currentRevision }));
    const target = c.scene.frame.originMm.map((v, i) => v + [3, 2, 4][i]) as LabVec3;
    toolCheck('direct.transform.orientation', 'lab_transform', 'coordinates', row, nearVector((row.output.facts as JsonObject).pointWorldMm, target));
  }
  for (const operation of ['translate', 'rotate'] as const) {
    const c = box(), shape = c.scene.objects[0].shape, row = observe(c, 'lab_propose', s => ({ objectId: c.scene.objects[0].id, operation, ...(operation === 'translate' ? { vectorMm: [1, -2, .5] } : { angleDeg: 23 }), expectedRevision: s.currentRevision }));
    const facts = row.output.facts as JsonObject, target = shape.center.map((v, i) => v + [1, -2, .5][i]) as LabVec3;
    toolCheck(`direct.propose.${operation}`, 'lab_propose', 'candidate-edit', row, row.output.status === 'proposed' && row.output.sourceWritten === false && (operation === 'translate' ? nearVector(facts.centroidWorldMm, target) : near(facts.angleDeg, shape.angleDeg + 23)) && equal(c.scene, row.session.source));
  }
  {
    const c = box(), row = observe(c, 'lab_verify', s => ({ expectedRevision: s.currentRevision }));
    toolCheck('direct.verify.unchanged', 'lab_verify', 'verification', row, row.output.valid === true);
    const physical = observe(c, 'lab_measure', s => ({ objectId: c.scene.objects[0].id, expectedRevision: s.currentRevision })), facts = physical.output.facts as JsonObject;
    toolCheck('direct.physical-separation', 'lab_measure', 'unknown-properties', physical, facts.opacity === .6 && facts.densityKgM3 === null && facts.materialIdentity === null && !('humidity' in facts) && !('occupancyProbability' in facts));
  }
  const negativeControls: Array<{ id: string; tool: string; fixture: () => LabCase; args: (s: LabSession) => JsonObject; code: string }> = [
    { id: 'stale-measure', tool: 'lab_measure', fixture: box, args: s => ({ objectId: s.scene.objects[0].id, expectedRevision: 'obsolete' }), code: 'stale_revision' },
    { id: 'stale-edit', tool: 'lab_propose', fixture: box, args: s => ({ objectId: s.scene.objects[0].id, operation: 'translate', vectorMm: [1, 0, 0], expectedRevision: 'obsolete' }), code: 'stale_revision' },
    { id: 'wrong-object', tool: 'lab_measure', fixture: box, args: s => ({ objectId: 'missing-object', expectedRevision: s.currentRevision }), code: 'unavailable_object' },
    { id: 'missing-calibration', tool: 'lab_transform', fixture: () => find('missing-evidence', 1), args: s => ({ point: [0, 0, 0], fromFrame: 'camera', toFrame: 'world', expectedRevision: s.currentRevision }), code: 'missing_camera_calibration' },
    { id: 'malformed-vector', tool: 'lab_query', fixture: box, args: s => ({ pointMm: [0, 0], expectedRevision: s.currentRevision }), code: 'invalid_tool_call' },
    { id: 'wrong-scene', tool: 'lab_inspect', fixture: box, args: () => ({ sceneRef: 'missing-scene' }), code: 'unavailable_scene' },
  ];
  for (const control of negativeControls) {
    const c = control.fixture(), row = observe(c, control.tool, control.args);
    toolCheck(`negative.${control.id}`, control.tool, 'refusal-contract', row, row.output.status === 'refused' && row.output.code === control.code && equal(row.session.scene, c.scene) && row.session.edits.length === 0, 'refusal');
  }
  const calls: Array<{ tool: string; args: (s: LabSession) => JsonObject }> = [
    { tool: 'lab_inspect', args: s => ({ sceneRef: s.sceneRef }) },
    { tool: 'lab_measure', args: s => ({ objectId: s.scene.objects[0].id, expectedRevision: s.currentRevision }) },
    { tool: 'lab_transform', args: s => ({ point: [1, 2, 3], fromFrame: 'camera', toFrame: 'world', expectedRevision: s.currentRevision }) },
    { tool: 'lab_query', args: s => ({ pointMm: [35, 35, 35], expectedRevision: s.currentRevision }) },
    { tool: 'lab_propose', args: s => ({ objectId: s.scene.objects[0].id, operation: 'translate', vectorMm: [1, 0, 0], expectedRevision: s.currentRevision }) },
    { tool: 'lab_verify', args: s => ({ expectedRevision: s.currentRevision }) },
  ];
  for (const call of calls) {
    const c = box(), direct = createLabSession(c), transported = createLabSession(c), args = call.args(direct), request = { id: `parity-${call.tool}`, tool: call.tool, args }, before = hash(request);
    const actual = dispatchLabTool(direct, call.tool, args), wire = dispatchSimulatedWorkflowTransport(transported, request), contract = validateWorkflowWireResponse(request, wire, transported.currentRevision);
    add(`transport.parity.${call.tool}`, 'transport:simulated-json', [call.tool], 'serialization-parity', 'success', contract.valid && equal(actual, wire.result) && equal(direct, transported) && hash(request) === before, 'none', { request, directToolResult: actual, wire, contract, requestUnchanged: hash(request) === before });
  }
  // Three integration paths reuse the already-checked tools, adding only composition.
  for (const path of ['transform-query', 'edit-remeasure-verify', 'stale-recover'] as const) {
    const c = box(), session = createLabSession(c), transcripts: Array<{ request: WorkflowWireRequest; response: WorkflowWireResponse }> = [];
    let contractsValid = true;
    const invoke = (tool: string, args: JsonObject): JsonObject => {
      const request = { id: `composed-${transcripts.length}`, tool, args }, response = dispatchSimulatedWorkflowTransport(session, request);
      contractsValid = validateWorkflowWireResponse(request, response, session.currentRevision).valid && contractsValid;
      transcripts.push({ request, response }); return response.result!;
    };
    let semanticValid = false;
    if (path === 'transform-query') {
      const world: LabVec3 = c.scene.objects[0].shape.center;
      const back = invoke('lab_transform', { point: world, fromFrame: 'world', toFrame: 'camera', expectedRevision: session.currentRevision });
      const forward = invoke('lab_transform', { point: (back.facts as JsonObject).pointCameraMm, fromFrame: 'camera', toFrame: 'world', expectedRevision: session.currentRevision });
      const queried = invoke('lab_query', { pointMm: (forward.facts as JsonObject).pointWorldMm, expectedRevision: session.currentRevision });
      semanticValid = nearVector((forward.facts as JsonObject).pointWorldMm, world) && (queried.facts as JsonObject).pointState === 'solid';
    } else {
      const initial = session.currentRevision, targetId = c.scene.objects[0].id;
      if (path === 'stale-recover') invoke('lab_propose', { objectId: targetId, operation: 'translate', vectorMm: [1, 0, 0], expectedRevision: 'obsolete' });
      invoke('lab_inspect', { sceneRef: session.sceneRef });
      invoke('lab_propose', { objectId: targetId, operation: 'translate', vectorMm: [1, 0, 0], expectedRevision: session.currentRevision });
      if (path === 'edit-remeasure-verify') invoke('lab_propose', { objectId: targetId, operation: 'rotate', angleDeg: 17, expectedRevision: session.currentRevision });
      const measured = invoke('lab_measure', { objectId: targetId, expectedRevision: session.currentRevision });
      const verified = invoke('lab_verify', { expectedRevision: session.currentRevision });
      semanticValid = session.currentRevision !== initial && verified.valid === true && nearVector((measured.facts as JsonObject).centroidWorldMm, [c.scene.objects[0].shape.center[0] + 1, c.scene.objects[0].shape.center[1], c.scene.objects[0].shape.center[2]])
        && session.edits.length === (path === 'stale-recover' ? 1 : 2) && session.staleRevisionRefusals === (path === 'stale-recover' ? 1 : 0);
    }
    const independent = independentlyVerifyLabSession(c, session);
    add(`composed.${path}`, 'composition:analytic-tools', [...new Set(transcripts.map(t => t.request.tool))], path, 'success', contractsValid && semanticValid && independent.valid && equal(session.source, c.scene), 'none', { transcripts, contractsValid, semanticValid, independent, sourcePreserved: equal(session.source, c.scene) });
  }
  const faults: Array<{ id: string; expectedFailure: string; mutate: (r: WorkflowWireResponse) => void }> = [
    { id: 'wrong-revision', expectedFailure: 'revision_binding', mutate: r => { r.result!.revision = 'wrong-revision'; } },
    { id: 'wrong-object', expectedFailure: 'object_binding', mutate: r => { (r.result!.facts as JsonObject).targetId = 'wrong-object'; } },
    { id: 'corrupt-units', expectedFailure: 'spatial_contract', mutate: r => { (r as unknown as JsonObject).units = 'm'; } },
    { id: 'dropped-evidence', expectedFailure: 'missing_evidence', mutate: r => { delete r.result!.evidenceId; } },
    { id: 'timeout', expectedFailure: 'simulated_timeout', mutate: r => { delete r.result; r.error = { code: 'simulated_timeout' }; } },
    { id: 'malformed-shape', expectedFailure: 'primitive_shape', mutate: r => { (r.result!.primitive as JsonObject).halfExtents = [1, -2, 3]; } },
  ];
  for (const fault of faults) {
    const c = box(), session = createLabSession(c), request = { id: `fault-${fault.id}`, tool: 'lab_measure', args: { objectId: c.scene.objects[0].id, expectedRevision: session.currentRevision } };
    const actual = dispatchSimulatedWorkflowTransport(session, request), mutated = structuredClone(actual); fault.mutate(mutated);
    const contract = validateWorkflowWireResponse(request, mutated, session.currentRevision), independent = independentlyVerifyLabSession(c, session);
    add(`fault.${fault.id}`, 'guard:transport-boundary', ['lab_measure'], 'controlled-fault', 'fault_detected', !contract.valid && contract.failures.includes(fault.expectedFailure) && independent.valid, 'transport_contract', { request, actualToolResponse: actual, injectedResponse: mutated, injectedFault: fault.id, contract, originalToolSessionStillValid: independent.valid });
  }
  {
    const c = shell(), session = createLabSession(c); session.source.objects[0].shape.radius += .01;
    const independent = independentlyVerifyLabSession(c, session);
    add('fault.source-mutation', 'guard:source-integrity', [], 'controlled-fault', 'fault_detected', !independent.valid && !independent.checks.sourceUnchanged, 'source_integrity', { injectedFault: 'evaluator mutates isolated source clone', independent, originalFixtureHash: labSceneRevision(c.scene), mutatedSourceHash: labSceneRevision(session.source) });
  }
  const admissions: SoftwareAdapterAdmission[] = ['Houdini/OpenVDB', 'Rerun', 'Viser', 'Roboflow', 'Spline', 'Hana', 'OMMA', 'Ollama'].map(software => ({ software, version: null, adapterHash: null, frame: null, units: null, revision: null, contentHash: null, status: 'unprobed' }));
  for (const admission of admissions) add(`native.${admission.software}`, `software:${admission.software}`, [], 'native-admission', 'unknown', null, 'availability_unobserved', { admission, decision: validateSoftwareAdmission(admission), reason: 'No native invocation occurs in this diagnostic run; existing installations or past receipts do not imply current admission.' });
  const components = [...new Set(checks.map(check => check.componentId))].map(id => {
    const rows = checks.filter(check => check.componentId === id);
    return { id, status: rows.some(row => row.passed !== null) ? 'observed' as const : 'unknown' as const, passed: rows.filter(row => row.passed === true).length, failed: rows.filter(row => row.passed === false).length, unknown: rows.filter(row => row.passed === null).length };
  });
  return { schema: 'timmy.workflow-isolation.v1', passed: checks.every(check => check.passed !== false), scope: { modelCalls: 0, networkCalls: 0, nativeCalls: 0, transport: 'in-memory JSON serialization only', geometry: 'Generated spheres, spherical shells and Z-rotated boxes; point controls use known interior/exterior/unknown locations.', inference: 'Tool and connection contracts only; no model reasoning score, native-software quality claim, or general spatial performance inference.' }, checks, components, admissions, observationsHash: hash(checks) };
}
