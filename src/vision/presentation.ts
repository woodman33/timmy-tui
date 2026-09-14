import { createHash } from 'node:crypto';
import type { VisionEvent } from './store.js';

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_BASE64_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const MAX_CHARACTERS = 32 * 1024 * 1024;
const MAX_NODES = 30_000;
const MAX_DEPTH = 24;
const MAX_TOTAL_IMAGE_BYTES = 24 * 1024 * 1024;

export interface VisionOutputReference {
  sha256: string;
  url: string;
  mimeType: string;
  byteLength: number;
}
export interface VisionPresentationSummary {
  detectionCount: number | null;
  classes: { name: string; count: number }[];
  predictionSets: number;
  reviewNeeded: boolean;
  minConfidence: number | null;
  maxConfidence: number | null;
}
export type PublicVisionEvent = VisionEvent & {
  outputs: VisionOutputReference[];
  summary: VisionPresentationSummary;
  presentation: {
    compacted: boolean;
    inlineImagesReplaced: number;
    truncated: boolean;
    originalResultHash: string;
  };
};

interface ImageValue { bytes: Buffer; mimeType: string }
interface Context {
  eventId: string;
  nodes: number;
  characters: number;
  imageBytes: number;
  truncated: boolean;
  replaced: number;
  ancestors: Set<object>;
  outputs: Map<string, VisionOutputReference>;
  classes: Map<string, number>;
  detections: number;
  predictionSets: number;
  confidences: number[];
  requestedDigest?: string;
  found?: ImageValue;
}

/** Only own data properties are inspected. Accessors and prototypes are never followed. */
function own(value: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Validate base64 before allocation, then identify the allowed image format by its bytes. */
function imageValue(value: string): ImageValue | undefined {
  if (value.length < 8 || value.length > MAX_BASE64_LENGTH || value.length % 4 !== 0) return undefined;
  if (!value.startsWith('/9j/') && !value.startsWith('iVBORw0KGgo') && !value.startsWith('UklGR')) return undefined;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return undefined;
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== value) return undefined;
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { bytes, mimeType: 'image/png' };
  }
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217) {
    return { bytes, mimeType: 'image/jpeg' };
  }
  if (bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
    && bytes.readUInt32LE(4) + 8 === bytes.length) {
    return { bytes, mimeType: 'image/webp' };
  }
  return undefined;
}

function imageReference(value: string, context: Context): VisionOutputReference | undefined {
  const image = imageValue(value);
  if (!image) return undefined;
  const sha256 = createHash('sha256').update(image.bytes).digest('hex');
  const existing = context.outputs.get(sha256);
  if (!existing && context.imageBytes + image.bytes.length > MAX_TOTAL_IMAGE_BYTES) {
    context.truncated = true;
    return undefined;
  }
  if (!existing) context.imageBytes += image.bytes.length;
  const reference = existing ?? {
    sha256,
    url: `/api/vision/events/${encodeURIComponent(context.eventId)}/outputs/${sha256}`,
    mimeType: image.mimeType,
    byteLength: image.bytes.length,
  };
  context.outputs.set(sha256, reference);
  context.replaced += 1;
  if (context.requestedDigest === sha256) context.found = image;
  return reference;
}

function inspectPredictions(value: unknown, context: Context) {
  if (!Array.isArray(value) || value.length > MAX_NODES) return;
  const predictions: Record<string, unknown>[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const prediction = own(value, index);
    if (!record(prediction) || !['x', 'y', 'width', 'height'].every(key => finite(own(prediction, key)))) return;
    predictions.push(prediction);
  }
  context.predictionSets += 1;
  context.detections += predictions.length;
  for (const prediction of predictions) {
    const className = own(prediction, 'class');
    const name = typeof className === 'string' && className.length > 0 && className.length <= 512 ? className : 'Unknown';
    context.classes.set(name, (context.classes.get(name) ?? 0) + 1);
    const confidence = own(prediction, 'confidence');
    if (finite(confidence) && confidence >= 0 && confidence <= 1) context.confidences.push(confidence);
  }
}

function clone(value: unknown, context: Context, depth: number, extractImages: boolean): unknown {
  if (context.found && context.requestedDigest) return null;
  context.nodes += 1;
  if (context.nodes > MAX_NODES || depth > MAX_DEPTH) {
    context.truncated = true;
    return null;
  }
  if (typeof value === 'string') {
    context.characters += value.length;
    if (context.characters > MAX_CHARACTERS) {
      context.truncated = true;
      return null;
    }
    return extractImages ? imageReference(value, context)?.url ?? value : value;
  }
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value !== 'object' || context.ancestors.has(value)) {
    context.truncated = true;
    return null;
  }
  if (!Array.isArray(value) && !record(value)) {
    context.truncated = true;
    return null;
  }
  context.ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const length = Math.min(value.length, Math.max(0, MAX_NODES - context.nodes));
      if (length !== value.length) context.truncated = true;
      return Array.from({ length }, (_, index) => clone(own(value, index), context, depth + 1, extractImages));
    }
    const wrapper = extractImages && own(value, 'type') === 'base64' && typeof own(value, 'value') === 'string';
    let wrappedReference: VisionOutputReference | undefined;
    if (wrapper) {
      const text = own(value, 'value') as string;
      // The normal property walk accounts for this string's size only once.
      if (context.characters + text.length <= MAX_CHARACTERS) wrappedReference = imageReference(text, context);
    }
    const entries: [string, unknown][] = [];
    for (const key of Object.keys(value)) {
      if (context.nodes >= MAX_NODES) { context.truncated = true; break; }
      context.characters += key.length;
      if (context.characters > MAX_CHARACTERS) { context.truncated = true; break; }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) {
        context.truncated = true;
        entries.push([key, null]);
        continue;
      }
      const child = descriptor.value;
      if (extractImages && (key === 'predictions' || key === 'detections')) inspectPredictions(child, context);
      if (wrappedReference && key === 'type') entries.push([key, 'url']);
      else if (wrappedReference && key === 'value') {
        context.characters += (child as string).length;
        entries.push([key, wrappedReference.url]);
      } else entries.push([key, clone(child, context, depth + 1, extractImages || depth === 0 && key === 'result')]);
    }
    // fromEntries creates data properties safely, including a literal own __proto__ key.
    return Object.fromEntries(entries);
  } finally {
    context.ancestors.delete(value);
  }
}

function contextFor(event: VisionEvent, requestedDigest?: string): Context {
  const id = own(event, 'id');
  return {
    eventId: typeof id === 'string' ? id : '',
    nodes: 0, characters: 0, imageBytes: 0, truncated: false, replaced: 0,
    ancestors: new Set(), outputs: new Map(), classes: new Map(), detections: 0,
    predictionSets: 0, confidences: [], requestedDigest,
  };
}

/** Compact browser representation. Its result is intentionally not the stored receipt's hash input. */
export function publicVisionEvent(event: VisionEvent): PublicVisionEvent {
  const context = contextFor(event);
  const copy = clone(event, context, 0, false) as VisionEvent;
  const feedback = own(event, 'feedback');
  const verdict = record(feedback) ? own(feedback, 'verdict') : undefined;
  const resultHash = own(event, 'resultHash');
  return {
    ...copy,
    outputs: [...context.outputs.values()],
    summary: {
      detectionCount: context.predictionSets ? context.detections : null,
      classes: [...context.classes].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
      predictionSets: context.predictionSets,
      reviewNeeded: verdict === 'correct' ? false : Boolean(own(event, 'needsReview')) || verdict === 'incorrect' || verdict === 'inconclusive',
      minConfidence: context.confidences.length ? Math.min(...context.confidences) : null,
      maxConfidence: context.confidences.length ? Math.max(...context.confidences) : null,
    },
    presentation: {
      compacted: context.replaced > 0 || context.truncated,
      inlineImagesReplaced: context.replaced,
      truncated: context.truncated,
      originalResultHash: typeof resultHash === 'string' ? resultHash : '',
    },
  };
}

/** Resolve only content-addressed image bytes found inside this event's stored result. */
export function findVisionOutput(event: VisionEvent, digest: string): ImageValue | undefined {
  if (!/^[a-f0-9]{64}$/.test(digest)) return undefined;
  const context = contextFor(event, digest);
  clone(own(event, 'result'), context, 0, true);
  return context.found;
}
