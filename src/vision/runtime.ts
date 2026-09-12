import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { spawn } from 'node:child_process';
import { visionAsset } from './config.js';
import {
  canonicalJson, imageHash, listLearningCandidates, listVisionEvents, readVisionEvent,
  recordVisionFeedback, saveVisionEvent, saveVisionSync, storeVisionImage, storeVisionManifest, visionHash,
  visionStorageDir, verifyVisionEvent, type VisionProvenance, type VisionStoreOptions,
} from './store.js';

export { listVisionEvents, recordVisionFeedback, listLearningCandidates } from './store.js';
export interface VisionInspectionRequest {
  imageBase64?: string; imagePath?: string; filename?: string; modelId?: string;
  workspace?: string; workflowId?: string; specification?: Record<string, unknown>;
  parameters?: Record<string, unknown>; imageInput?: string; templateId?: string;
  sourceId?: string; metadata?: Record<string, unknown>; confidenceThreshold?: number;
}
export interface VisionBridgeResult { ok: boolean; state: string; note?: string; [key: string]: unknown }
export interface VisionRunnerContext { python: string; bridge: string; env: NodeJS.ProcessEnv; timeoutMs: number }
export type VisionRunner = (request: Record<string, unknown>, context: VisionRunnerContext) => Promise<VisionBridgeResult>;
export interface VisionRuntimeOptions extends VisionStoreOptions { runner?: VisionRunner; timeoutMs?: number }
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_RESULT_BYTES = 8 * 1024 * 1024;

function settings(options: VisionRuntimeOptions) {
  const env = options.env ?? process.env;
  const dir = options.dir ?? process.cwd();
  const visionPython = join(dir, '.timmy', 'venv-vision', 'bin', 'python');
  const localPython = existsSync(visionPython) ? visionPython : join(dir, '.timmy', 'venv-roboflow', 'bin', 'python');
  return {
    env, runtime: env.TIMMY_VISION_RUNTIME ?? 'http',
    serverUrl: env.TIMMY_VISION_SERVER_URL ?? 'http://localhost:9001',
    python: env.TIMMY_VISION_PYTHON ?? (existsSync(localPython) ? localPython : 'python3'),
    bridge: visionAsset('scripts/vision-bridge.py', dir),
    modelId: env.TIMMY_VISION_MODEL_ID ?? '', workspace: env.ROBOFLOW_WORKSPACE ?? '',
    workflowId: env.TIMMY_VISION_WORKFLOW_ID ?? '', useCaseId: env.TIMMY_VISION_USE_CASE_ID ?? '',
  };
}

/** Credentials never enter requests, browser responses, persisted results, or exception text. */
export function redactVisionValue(value: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  const secrets = Object.entries(env).filter(([key, v]) => v && /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(key))
    .map(([, v]) => v!).filter(v => v.length >= 4);
  function visit(v: unknown): unknown {
    if (typeof v === 'string') {
      let text = v;
      for (const secret of secrets) text = text.split(secret).join('[redacted]');
      return text.replace(/(api[_-]?key|(?:access|refresh|id)[_-]?token|client[_-]?secret|authorization|password)(["'\s:=]+)[^\s&,"'}]+/gi, '$1$2[redacted]')
        .replace(/Bearer\s+[\w.-]+/gi, 'Bearer [redacted]')
        .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1[redacted]@');
    }
    if (Array.isArray(v)) return v.map(visit);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([key, item]) =>
      [key, /^(?:[a-z0-9]+[._:-])*(?:api[_-]?key|token|(?:access|refresh|id)[_-]?token|authorization|password|(?:client[_-]?)?secret)$/i.test(key) ? '[redacted]' : visit(item)]));
    return v;
  }
  return visit(value);
}

export const runVisionBridge: VisionRunner = (request, context) => new Promise(resolve => {
  let settled = false;
  let stdout = '';
  let size = 0;
  const finish = (value: VisionBridgeResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(redactVisionValue(value, context.env) as VisionBridgeResult);
  };
  const child = spawn(context.python, [context.bridge], { env: context.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    finish({ ok: false, state: 'timeout', note: 'Vision processing exceeded its time limit. Check the server before retrying.' });
  }, context.timeoutMs);
  child.on('error', () => finish({ ok: false, state: 'not_configured', note: 'The configured Python executable could not be started.' }));
  child.stdout.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_RESULT_BYTES) {
      child.kill('SIGKILL');
      finish({ ok: false, state: 'output_limit', note: 'Vision response exceeded the 8 MB limit.' });
    } else stdout += chunk.toString('utf8');
  });
  // Drain stderr but never relay it: SDK logs may contain URLs or credentials.
  child.stderr.resume();
  child.stdin.on('error', () => { /* process error/close produces the structured result */ });
  child.on('close', code => {
    if (settled) return;
    try {
      const value = JSON.parse(stdout) as VisionBridgeResult;
      if (!value || typeof value.ok !== 'boolean' || typeof value.state !== 'string') throw new Error('shape');
      finish(code === 0 || !value.ok ? value : { ok: false, state: 'execution_error', note: 'Vision bridge exited unsuccessfully.' });
    } catch { finish({ ok: false, state: 'execution_error', note: 'Vision bridge did not return a valid response.' }); }
  });
  child.stdin.end(JSON.stringify(request));
});

async function bridge(request: Record<string, unknown>, options: VisionRuntimeOptions, probe = false) {
  const cfg = settings(options);
  const timeoutMs = probe ? 5000 : Math.min(300000, Math.max(1000, options.timeoutMs ?? 120000));
  try {
    const value = await (options.runner ?? runVisionBridge)(request, { python: cfg.python, bridge: cfg.bridge, env: cfg.env, timeoutMs });
    return redactVisionValue(value, cfg.env) as VisionBridgeResult;
  } catch {
    return { ok: false, state: 'execution_error', note: 'Vision runtime failed. Check its local configuration.' } as VisionBridgeResult;
  }
}
function validateServer(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return undefined;
    return url.toString().replace(/\/$/, '');
  } catch { return undefined; }
}

export async function getVisionStatus(options: VisionRuntimeOptions = {}) {
  const cfg = settings(options);
  const probe = await bridge({ action: 'probe' }, options, true);
  const dependencies = (probe.dependencies ?? {}) as Record<string, { installed?: boolean; version?: string }>;
  const reasons: string[] = [];
  if (!['http', 'library'].includes(cfg.runtime)) reasons.push('TIMMY_VISION_RUNTIME must be http or library.');
  if (!probe.ok) reasons.push(probe.note ?? 'Python runtime unavailable.');
  const needed = cfg.runtime === 'library' ? 'inference' : 'inference_sdk';
  if (probe.ok && !dependencies[needed]?.installed) reasons.push(`${needed === 'inference_sdk' ? 'inference-sdk' : 'inference'} Python package is missing.`);
  if (cfg.runtime === 'http' && !validateServer(cfg.serverUrl)) reasons.push('TIMMY_VISION_SERVER_URL must be an HTTP(S) address without credentials or query parameters.');
  if (!cfg.modelId && !(cfg.workspace && cfg.workflowId)) reasons.push('Choose a model or a workspace and Workflow before running.');
  if (!cfg.env.ROBOFLOW_API_KEY && (!cfg.modelId || cfg.modelId.includes('/') || cfg.workflowId || cfg.runtime === 'http')) reasons.push('ROBOFLOW_API_KEY is missing.');
  return {
    ok: reasons.length === 0, state: reasons.length ? 'not_configured' : 'configured_unchecked',
    runtime: cfg.runtime, serverUrl: validateServer(cfg.serverUrl) ?? null,
    modelId: cfg.modelId || null, workspace: cfg.workspace || null, workflowId: cfg.workflowId || null,
    useCaseId: cfg.useCaseId || null, keyConfigured: Boolean(cfg.env.ROBOFLOW_API_KEY),
    storageDir: visionStorageDir(options), dependencies, reasons, serverChecked: false,
    note: 'Configuration check only; no model was loaded and no network request was made.',
    capabilities: { imageInference: true, workflows: cfg.runtime === 'http', localEvents: true, feedback: true,
      cloudEvents: Boolean(cfg.useCaseId && cfg.workspace && cfg.env.ROBOFLOW_API_KEY && dependencies.roboflow?.installed),
      streaming: false, automaticTraining: false },
  };
}

function loadImage(req: VisionInspectionRequest): { bytes: Buffer; mimeType: string; filename: string } {
  if (Boolean(req.imageBase64) === Boolean(req.imagePath)) throw new Error('Provide exactly one image upload or local image path.');
  let bytes: Buffer;
  if (req.imageBase64) {
    const encoded = req.imageBase64.replace(/^data:image\/(?:png|jpeg|webp);base64,/i, '');
    if (encoded.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) throw new Error('Image must be valid base64 and at most 12 MB.');
    bytes = Buffer.from(encoded, 'base64');
  } else {
    const path = req.imagePath!;
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) throw new Error('Image must be a file at most 12 MB.');
    bytes = readFileSync(path);
  }
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('Image must be nonempty and at most 12 MB.');
  const mimeType = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
      : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : '';
  if (!mimeType) throw new Error('Upload a PNG, JPEG, or WebP image.');
  return { bytes, mimeType, filename: basename(req.filename ?? req.imagePath ?? 'inspection-image').slice(0, 200) };
}
function confidences(value: unknown): number[] {
  const values: number[] = [];
  function visit(item: unknown, depth: number) {
    if (depth > 30 || values.length >= 10000) return;
    if (Array.isArray(item)) { item.forEach(v => visit(v, depth + 1)); return; }
    if (!item || typeof item !== 'object') return;
    for (const [key, val] of Object.entries(item)) {
      if (key === 'confidence' && typeof val === 'number' && Number.isFinite(val) && val >= 0 && val <= 1) values.push(val);
      else if (typeof val === 'object') visit(val, depth + 1);
    }
  }
  visit(value, 0);
  return values;
}

export async function runVisionInspection(req: VisionInspectionRequest, options: VisionRuntimeOptions = {}) {
  const cfg = settings(options);
  const runtime = cfg.runtime;
  if (runtime !== 'http' && runtime !== 'library') return { ok: false, state: 'not_configured', note: 'Choose http or library as TIMMY_VISION_RUNTIME.' };
  const workflowId = req.workflowId ?? (req.modelId !== undefined || req.specification ? '' : cfg.workflowId);
  const workspace = req.workspace ?? cfg.workspace;
  const modelId = req.modelId ?? cfg.modelId;
  const workflow = Boolean(req.specification || workflowId);
  if (!workflow && !modelId) return { ok: false, state: 'not_configured', note: 'Choose a model ID or a Workflow.' };
  if (workflow && runtime === 'library') return { ok: false, state: 'not_configured', note: 'Use the HTTP Inference Server runtime for Workflows. The direct library runtime runs a model.' };
  if (workflowId && !req.specification && !workspace) return { ok: false, state: 'not_configured', note: 'A named Workflow requires ROBOFLOW_WORKSPACE.' };
  if (req.specification && req.workflowId) return { ok: false, state: 'invalid_request', note: 'Choose an inline Workflow definition or a named Workflow.' };
  if (runtime === 'http' && !validateServer(cfg.serverUrl)) return { ok: false, state: 'not_configured', note: 'Inference server address is invalid.' };
  if (!cfg.env.ROBOFLOW_API_KEY && (runtime === 'http' || modelId.includes('/') || workflow)) return { ok: false, state: 'not_configured', note: 'Set ROBOFLOW_API_KEY on the Timmy server.' };
  const threshold = req.confidenceThreshold ?? 0.6;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) return { ok: false, state: 'invalid_request', note: 'Review confidence must be between 0 and 1.' };
  if (Buffer.byteLength(canonicalJson(req.parameters ?? {})) > 65536 || Buffer.byteLength(canonicalJson(req.specification ?? {})) > 1024 * 1024) return { ok: false, state: 'invalid_request', note: 'Workflow parameters or definition are too large.' };
  let input: ReturnType<typeof loadImage>;
  try { input = loadImage(req); }
  catch (error) { return { ok: false, state: 'invalid_request', note: error instanceof Error && !('code' in error) ? error.message : 'The image file could not be read.' }; }
  const image = storeVisionImage(input.bytes, input.mimeType, input.filename, options);
  const parameters = req.parameters ?? {};
  const execution = {
    version: 1, runtime, ...(runtime === 'http' ? { serverUrl: validateServer(cfg.serverUrl), apiKeyTransport: 'header' } : {}),
    ...(workflow ? { workflowId, workspace, specification: req.specification, parameters, imageInput: req.imageInput ?? 'image', disableSinks: true }
      : { modelId, disableActiveLearning: true }),
  };
  const sanitizedExecution = redactVisionValue(execution, cfg.env);
  const executionManifest = storeVisionManifest(sanitizedExecution, canonicalJson(execution) !== canonicalJson(sanitizedExecution), options);
  const result = await bridge({
    action: 'inspect', runtime, serverUrl: validateServer(cfg.serverUrl), imagePath: image.path,
    ...(workflow ? { workflowId, workspace, specification: req.specification, parameters, imageInput: req.imageInput ?? 'image' } : { modelId }),
  }, options);
  const cleanResult = redactVisionValue(result.ok ? result.result : { state: result.state, note: result.note }, cfg.env);
  const scores = confidences(cleanResult);
  const provenance: VisionProvenance = {
    runtime, ...(runtime === 'http' ? { serverUrl: validateServer(cfg.serverUrl) } : {}),
    ...(workflow ? { workspace, workflowId: workflowId || undefined } : { modelId }),
    ...(req.specification ? { specificationHash: visionHash(req.specification) } : {}),
    workflowDefinitionCaptured: Boolean(req.specification), parametersHash: visionHash(parameters),
    executionManifest,
    ...(typeof result.sdkVersion === 'string' ? { sdkVersion: result.sdkVersion } : {}),
  };
  const min = scores.length ? Math.min(...scores) : null;
  const event = saveVisionEvent({
    state: result.ok ? 'observed' : 'failed', templateId: req.templateId, sourceId: req.sourceId,
    image, provenance, metadata: redactVisionValue(req.metadata ?? {}, cfg.env) as Record<string, unknown>,
    result: cleanResult, resultHash: visionHash(cleanResult),
    confidence: { count: scores.length, min, max: scores.length ? Math.max(...scores) : null },
    needsReview: result.ok && (min === null || min < threshold),
    ...(result.ok && (min === null || min < threshold) ? { reviewReason: min === null ? 'No confidence values were reported; inspect the result.' : 'At least one prediction is below the review confidence threshold.' } : {}),
  }, options);
  return { ok: result.ok, state: result.ok ? 'observed' : result.state, note: result.note, event, receipt: event.receiptHash };
}

export async function syncVisionEvent(req: { eventId: string; includeImage?: boolean }, options: VisionRuntimeOptions = {}) {
  const cfg = settings(options);
  if (!cfg.env.ROBOFLOW_API_KEY || !cfg.workspace || !cfg.useCaseId) return { ok: false, state: 'not_configured', note: 'Cloud sync requires ROBOFLOW_API_KEY, ROBOFLOW_WORKSPACE, and TIMMY_VISION_USE_CASE_ID.' };
  const event = readVisionEvent(req.eventId, options);
  if (!event) return { ok: false, state: 'not_found', note: 'Vision event not found.' };
  if (event.state !== 'observed') return { ok: false, state: 'invalid_request', note: 'Only completed observations can be synced.' };
  if (!verifyVisionEvent(event, options)) return { ok: false, state: 'integrity_error', note: 'Stored observation does not match its signed receipt.' };
  if (req.includeImage) {
    try { if (imageHash(readFileSync(event.image.path)) !== event.image.sha256) throw new Error('hash'); }
    catch { return { ok: false, state: 'integrity_error', note: 'The stored image is unavailable or its hash changed.' }; }
  }
  const prior = listVisionEvents({ limit: 500 }, options).events.find(item => item.id === event.id)?.sync;
  if (prior?.useCaseId === cfg.useCaseId) return { ok: true, state: 'already_synced', sync: prior, note: 'This event is already synced. Its original cloud payload is preserved.' };
  const result = await bridge({ action: 'sync_event', workspace: cfg.workspace, useCaseId: cfg.useCaseId, event, includeImage: Boolean(req.includeImage) }, options);
  if (!result.ok) return result;
  const sync = saveVisionSync({ eventId: event.id, includeImage: Boolean(req.includeImage), useCaseId: cfg.useCaseId, response: result.result }, options);
  return { ok: true, state: 'synced', sync, receipt: sync.receiptHash, warnings: result.warnings };
}

export async function queryCloudVisionEvents(req: { limit?: number; cursor?: string } = {}, options: VisionRuntimeOptions = {}) {
  const cfg = settings(options);
  if (!cfg.env.ROBOFLOW_API_KEY || !cfg.workspace || !cfg.useCaseId) return { ok: false, state: 'not_configured', note: 'Cloud queries require ROBOFLOW_API_KEY, ROBOFLOW_WORKSPACE, and TIMMY_VISION_USE_CASE_ID.' };
  return bridge({ action: 'query_events', workspace: cfg.workspace, useCaseId: cfg.useCaseId,
    limit: Math.min(100, Math.max(1, req.limit ?? 25)), cursor: req.cursor }, options);
}
