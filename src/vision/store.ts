import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { appendReceipt, readChain, verifySignature, withLockDir } from '../utils/receipts.js';

export interface VisionStoreOptions { dir?: string; env?: NodeJS.ProcessEnv }
export interface VisionImage { path: string; sha256: string; mimeType: string; filename: string }
export interface VisionProvenance {
  runtime: 'http' | 'library'; serverUrl?: string; modelId?: string; workspace?: string;
  workflowId?: string; specificationHash?: string; workflowDefinitionCaptured: boolean;
  parametersHash: string; sdkVersion?: string;
  executionManifest?: { path: string; sha256: string; redacted: boolean };
}
export interface VisionEvent {
  id: string; timestamp: string; state: 'observed' | 'failed'; templateId?: string;
  sourceId?: string; image: VisionImage; provenance: VisionProvenance;
  metadata: Record<string, unknown>; result: unknown; resultHash: string;
  confidence: { count: number; min: number | null; max: number | null };
  needsReview: boolean; reviewReason?: string; receiptHash: string;
  feedback?: VisionFeedback; sync?: VisionSync;
}
export interface VisionFeedback {
  id: string; eventId: string; timestamp: string;
  verdict: 'correct' | 'incorrect' | 'inconclusive'; note?: string; operator?: string;
  receiptHash: string;
}
export interface VisionSync {
  id: string; eventId: string; timestamp: string; includeImage: boolean;
  useCaseId: string; response: unknown; receiptHash: string;
}

/** Stable JSON makes receipts reproducible across object key ordering. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(v => canonicalJson(v ?? null)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
export const visionHash = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');
export const imageHash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

export function visionStorageDir(options: VisionStoreOptions = {}): string {
  const dir = options.dir ?? process.cwd();
  return resolve(dir, (options.env ?? process.env).TIMMY_VISION_STORAGE_DIR ?? '.timmy/vision');
}
function journalPath(name: string, options: VisionStoreOptions) { return join(visionStorageDir(options), `${name}.jsonl`); }
function readJournal<T>(name: string, options: VisionStoreOptions): T[] {
  const path = journalPath(name, options);
  if (!existsSync(path)) return [];
  // Invalid records are surfaced, never silently interpreted as an empty history.
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as T);
}
function appendJournal(name: string, value: unknown, options: VisionStoreOptions) {
  const path = journalPath(name, options);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(value) + '\n', { encoding: 'utf8', mode: 0o600 });
}

export function storeVisionImage(bytes: Buffer, mimeType: string, filename: string, options: VisionStoreOptions): VisionImage {
  const sha256 = imageHash(bytes);
  const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
  const path = join(visionStorageDir(options), 'images', `${sha256}.${ext}`);
  mkdirSync(dirname(path), { recursive: true });
  try { writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (imageHash(readFileSync(path)) !== sha256) throw new Error('Stored image hash mismatch');
  }
  return { path, sha256, mimeType, filename };
}

export function storeVisionManifest(value: unknown, redacted: boolean, options: VisionStoreOptions) {
  const sha256 = visionHash(value);
  const path = join(visionStorageDir(options), 'manifests', `${sha256}.json`);
  mkdirSync(dirname(path), { recursive: true });
  try { writeFileSync(path, canonicalJson(value) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (visionHash(JSON.parse(readFileSync(path, 'utf8'))) !== sha256) throw new Error('Stored execution manifest hash mismatch');
  }
  return { path, sha256, redacted };
}

export function saveVisionEvent(event: Omit<VisionEvent, 'id' | 'timestamp' | 'receiptHash' | 'feedback' | 'sync'>, options: VisionStoreOptions): VisionEvent {
  const value = { ...event, id: randomUUID(), timestamp: new Date().toISOString() };
  return withLockDir(join(visionStorageDir(options), '.lock'), () => {
    const receipt = appendReceipt('runs', {
      kind: 'vision.inspection', subject: `Vision inspection ${value.id}`, policy: 'auto',
      status: value.state === 'observed' ? 'ok' : 'failed',
      ...(value.state === 'failed' ? { error_class: 'vision_inference' } : {}),
      artifacts: [value.image.path, ...(value.provenance.executionManifest ? [value.provenance.executionManifest.path] : [])], output_sha256: value.resultHash,
      manifest_sha256: visionHash(value), prompt_hash: value.provenance.specificationHash,
      model_requested: value.provenance.modelId, via: `roboflow.${value.provenance.runtime}`,
      sources: [{ image_sha256: value.image.sha256, provenance: value.provenance }],
    }, options.dir);
    const sealed = { ...value, receiptHash: receipt.hash };
    appendJournal('events', sealed, options);
    return sealed;
  });
}

export function readVisionEvent(eventId: string, options: VisionStoreOptions = {}): VisionEvent | undefined {
  return readJournal<VisionEvent>('events', options).find(event => event.id === eventId);
}
/** Re-hashing an edited event cannot bypass its original signed receipt. */
export function verifyVisionEvent(event: VisionEvent, options: VisionStoreOptions = {}): boolean {
  const { receiptHash, feedback: _feedback, sync: _sync, ...body } = event;
  const receipt = readChain('runs', options.dir).find(item => item.hash === receiptHash);
  const manifest = event.provenance.executionManifest;
  try {
    if (manifest && visionHash(JSON.parse(readFileSync(manifest.path, 'utf8'))) !== manifest.sha256) return false;
  } catch { return false; }
  return Boolean(receipt && verifySignature(receipt) && receipt.manifest_sha256 === visionHash(body)
    && receipt.output_sha256 === event.resultHash && event.resultHash === visionHash(event.result));
}
export function listVisionEvents(query: { limit?: number; templateId?: string } = {}, options: VisionStoreOptions = {}) {
  const feedback = new Map(readJournal<VisionFeedback>('feedback', options).map(row => [row.eventId, row]));
  const sync = new Map(readJournal<VisionSync>('sync', options).map(row => [row.eventId, row]));
  const events = readJournal<VisionEvent>('events', options)
    .filter(event => !query.templateId || event.templateId === query.templateId).reverse()
    .slice(0, Math.min(500, Math.max(1, query.limit ?? 50)))
    .map(event => ({ ...event, feedback: feedback.get(event.id), sync: sync.get(event.id) }));
  return { ok: true as const, state: 'local' as const, events };
}

export function recordVisionFeedback(req: { eventId: string; verdict: VisionFeedback['verdict']; note?: string; operator?: string }, options: VisionStoreOptions = {}) {
  if (!['correct', 'incorrect', 'inconclusive'].includes(req.verdict)) return { ok: false, state: 'invalid_request', note: 'Feedback must be correct, incorrect, or inconclusive.' };
  if (!readVisionEvent(req.eventId, options)) return { ok: false, state: 'not_found', note: 'Vision event not found.' };
  return withLockDir(join(visionStorageDir(options), '.lock'), () => {
    const secrets = Object.entries(options.env ?? process.env).filter(([key, value]) => value && /KEY|TOKEN|SECRET|PASSWORD/i.test(key)).map(([, value]) => value!).filter(value => value.length >= 4);
    const scrub = (text: string) => secrets.reduce((value, secret) => value.split(secret).join('[redacted]'), text)
      .replace(/Bearer\s+[\w.-]+/gi, 'Bearer [redacted]');
    const feedback = {
      id: randomUUID(), eventId: req.eventId, verdict: req.verdict, timestamp: new Date().toISOString(),
      ...(req.note ? { note: scrub(req.note).slice(0, 2000) } : {}),
      ...(req.operator ? { operator: scrub(req.operator).slice(0, 200) } : {}),
    };
    const receipt = appendReceipt('runs', {
      kind: 'vision.feedback', subject: `Vision feedback ${feedback.eventId}`, policy: 'auto', status: 'ok',
      output_sha256: visionHash(feedback), sources: [{ eventId: feedback.eventId, verdict: feedback.verdict }],
    }, options.dir);
    const sealed: VisionFeedback = { ...feedback, receiptHash: receipt.hash };
    appendJournal('feedback', sealed, options);
    return { ok: true, state: 'recorded', feedback: sealed, receipt: receipt.hash };
  });
}

export function saveVisionSync(value: Omit<VisionSync, 'id' | 'timestamp' | 'receiptHash'>, options: VisionStoreOptions) {
  return withLockDir(join(visionStorageDir(options), '.lock'), () => {
    const sync = { ...value, id: randomUUID(), timestamp: new Date().toISOString() };
    const receipt = appendReceipt('runs', {
      kind: 'vision.cloud_sync', subject: `Vision event sync ${value.eventId}`, policy: 'auto', status: 'ok',
      output_sha256: visionHash(sync), sources: [{ eventId: value.eventId, useCaseId: value.useCaseId, includeImage: value.includeImage }],
    }, options.dir);
    const sealed = { ...sync, receiptHash: receipt.hash };
    appendJournal('sync', sealed, options);
    return sealed;
  });
}

export function listLearningCandidates(query: { limit?: number; threshold?: number } = {}, options: VisionStoreOptions = {}) {
  const threshold = Math.min(1, Math.max(0, query.threshold ?? 0.6));
  const events = listVisionEvents({ limit: 500 }, options).events.filter(event => {
    if (event.state !== 'observed' || event.feedback?.verdict === 'correct') return false;
    return event.needsReview || (event.confidence.min !== null && event.confidence.min < threshold)
      || event.feedback?.verdict === 'incorrect' || event.feedback?.verdict === 'inconclusive';
  }).slice(0, Math.min(500, Math.max(1, query.limit ?? 50)));
  return { ok: true as const, state: 'local_review_queue' as const, events, note: 'Local review candidates only. Nothing is uploaded or trained automatically.' };
}
