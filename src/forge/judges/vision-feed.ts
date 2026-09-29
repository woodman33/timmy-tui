// Vision feeds for judges — Roboflow detections as unqualified machine observations.
//
// Probe segments (src/forge/probe/segments.ts) are run through the vision
// bridge (src/vision/runtime.ts runVisionBridge; detection shape per
// scripts/vision-bridge.py annotation_data: {class, confidence, x, y, width,
// height}, x/y/width/height in PIXELS as reported by Roboflow). Each detection
// becomes a DetectionObservation with a stable cite handle so judges can
// reference it by id. These IDs alone do not admit evidence: this adapter has
// no run/revision-bound observation registry or observed cite(handle_id) tool calls.
//
// Evidence discipline (hard contract): a detection is a machine inference,
// never proof. `inference_judgment_is_proof` is the LITERAL false on every
// observation and in every rendered header; it must never be true, omitted,
// or lost in rendering. Matches the limits convention in
// src/vision/integrations/runner.ts (`inferenceJudgmentIsProof: false`).
//
// INTEGRATION POINT (documented, NOT implemented here): runPanel's artifactRef
// prompt is extended by the caller (Task 15/16 wiring) to include
// renderObservations output; the panel itself stays unchanged.
//
// Adapter contract: the injected BridgeFn takes a segment FILE PATH (segments
// are videos; the wiring layer extracts/references a frame per its own
// convention and passes the image path to the bridge) and returns Roboflow-
// shaped detections with boxes ALREADY NORMALIZED to 0..1 — the px→norm
// conversion needs image dimensions, which only the wiring layer knows (from
// the vision event). collectObservations enforces the 0..1 contract by
// warning and omitting out-of-range boxes. Tests inject fixtures; no network.
import type { ProbeSegment } from '../probe/segments.js';

export interface DetectionBox { x: number; y: number; w: number; h: number } // normalized 0..1

export interface DetectionObservation {
  // Legacy observation reference, not a qualified evidence handle. Repeated
  // segment bytes or shared hash prefixes can collide; collisions are refused.
  // Never use matching text as proof of a current-run, current-revision cite.
  handle: string;
  segment_sha256: string;
  beat_id: string;
  kind: 'subject_presence' | 'face_region' | 'text_region' | 'label';
  label: string;               // e.g. 'person', 'face', 'text-block'
  confidence: number;          // 0..1 from the detector
  box?: DetectionBox;          // normalized 0..1; omitted for classification-style detections
  inference_judgment_is_proof: false; // LITERAL false — the evidence flag, always
}

// Roboflow-shaped detection as the bridge reports it. All fields validated at
// runtime; malformed detections are DROPPED with console.warn (never throws
// on one bad detection).
export interface BridgeDetection {
  class?: unknown;
  label?: unknown;             // accepted as a fallback for the class name
  confidence?: unknown;
  x?: unknown; y?: unknown; width?: unknown; height?: unknown; // normalized 0..1 per the adapter contract
}

export type BridgeFn = (file: string) => Promise<BridgeDetection[]>;

// person/subject/human → subject_presence; face → face_region; text/ocr →
// text_region; everything else stays a plain label. Case-insensitive
// substring match on the detector's class name.
function mapKind(label: string): DetectionObservation['kind'] {
  const l = label.toLowerCase();
  if (/(?:person|subject|human)/.test(l)) return 'subject_presence';
  if (/face/.test(l)) return 'face_region';
  if (/(?:text|ocr)/.test(l)) return 'text_region';
  return 'label';
}

// Run the vision bridge once per segment file; normalize to observations,
// preserving segment order then detection order. Malformed detections are
// dropped with console.warn; the run itself never throws on one bad row.
export async function collectObservations(segments: ProbeSegment[], runBridge: BridgeFn): Promise<DetectionObservation[]> {
  const out: DetectionObservation[] = [];
  for (const [segmentIndex, seg] of segments.entries()) {
    if (!/^[0-9a-f]{64}$/i.test(seg.sha256)) throw new Error('vision-feed: invalid segment hash');
    const raw = await runBridge(seg.file);
    const detections = Array.isArray(raw) ? raw : [];
    detections.forEach((d, i) => {
      const where = `detection ${i} of segment ${segmentIndex}`;
      const rawLabel = typeof d?.class === 'string' && d.class.trim() ? d.class
        : typeof d?.label === 'string' && d.label.trim() ? d.label : null;
      // Preserve detector output exactly. Rendering escapes untrusted text;
      // it must not rewrite the retained label to make an observation pass.
      const label = rawLabel;
      if (label === null || !label.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim()) {
        console.warn(`vision-feed: dropping ${where}: no usable class/label`);
        return;
      }
      const conf = d?.confidence;
      if (typeof conf !== 'number' || !Number.isFinite(conf) || conf < 0 || conf > 1) {
        console.warn(`vision-feed: dropping ${where}: confidence must be a finite number in [0,1]`);
        return;
      }
      const box = normalizeBox(d, where);
      out.push({
        // Lowercased so HANDLE_RE ([0-9a-f]{12}) always matches even if a
        // segment sha256 is ever produced uppercase.
        handle: `det:${seg.sha256.slice(0, 12).toLowerCase()}:${i}`,
        segment_sha256: seg.sha256,
        beat_id: seg.beat_id,
        kind: mapKind(label),
        label,
        confidence: conf,
        ...(box ? { box } : {}),
        inference_judgment_is_proof: false,
      });
    });
  }
  assertUniqueHandles(out);
  return out;
}

// Box is included only when all four coords are finite numbers in [0,1]
// (adapter contract) and the box extent stays inside the frame (x+w ≤ 1,
// y+h ≤ 1). Anything else (missing, partial, un-normalized pixels, or a box
// running past the frame edge) omits the box with a warning — the observation
// itself is kept.
function normalizeBox(d: BridgeDetection, where: string): DetectionBox | null {
  const { x, y, width, height } = d ?? {};
  if (x === undefined && y === undefined && width === undefined && height === undefined) return null;
  if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number'
    || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
    console.warn(`vision-feed: ${where}: partial/non-numeric box omitted`);
    return null;
  }
  if (x < 0 || x > 1 || y < 0 || y > 1 || width < 0 || width > 1 || height < 0 || height > 1
    || x + width > 1 || y + height > 1) {
    console.warn(`vision-feed: ${where}: box outside [0,1] or past frame edge omitted — adapter must normalize pixel coords`);
    return null;
  }
  return { x, y, w: width, h: height };
}

const HEADER = 'VISION OBSERVATIONS (machine inferences — inference_judgment_is_proof: false; evidence unknown: cite tool and run/revision binding unavailable):';

// Render observations into judge-context text: header with the proof-flag
// line, then one handle-first line per observation. Pure.
export function renderObservations(obs: DetectionObservation[]): string {
  assertUniqueHandles(obs);
  const lines = [HEADER];
  if (!obs.length) lines.push('(none)');
  for (const o of obs) {
    const box = o.box
      ? `${o.box.x.toFixed(4)},${o.box.y.toFixed(4)},${o.box.w.toFixed(4)},${o.box.h.toFixed(4)}`
      : '-';
    lines.push(`[${o.handle}] beat=${quoted(o.beat_id)} kind=${quoted(o.kind)} label=${quoted(o.label)} conf=${o.confidence.toFixed(4)} box=${box}`);
  }
  return lines.join('\n');
}

// Escape display text without changing retained detector/model output.
function quoted(value: string): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f\u2028\u2029]/g,
    c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function assertUniqueHandles(obs: DetectionObservation[]): void {
  const seen = new Set<string>();
  for (const o of obs) {
    if (!/^det:[0-9a-f]{12}:(?:0|[1-9]\d*)$/.test(o.handle)) throw new Error('vision-feed: invalid observation handle');
    if (seen.has(o.handle)) throw new Error('vision-feed: duplicate observation handle');
    seen.add(o.handle);
  }
}

// Diagnostic token extraction only. Preserve duplicates, and never match a
// valid-looking prefix inside a longer invalid token. This is not cite().
const HANDLE_RE = /(?<![\w:])det:[0-9a-f]{12}:(?:0|[1-9]\d*)(?![\w:])/g;
export function citedHandles(text: string): string[] {
  return text.match(HANDLE_RE) ?? [];
}

export interface CitationRefusal {
  ok: false;
  evidence: 'unknown';
  reason: 'duplicate_handle' | 'unobserved_handle' | 'citation_context_unavailable';
  dangling: string[];
  raw_output: string;
}

// Legacy token membership cannot satisfy AGENTS §4. No successful admission
// path exists until the actual controller supplies a current run/revision
// registry and observed successful cite(handle_id) calls. Refuse even a known
// token or empty citation set; retain the exact model output with the refusal.
// Never synthesize a cite event or repair a model's labels after the fact.
export function checkCitations(text: string, obs: DetectionObservation[]): CitationRefusal {
  const handles = citedHandles(text);
  const known = new Set(obs.map(o => o.handle));
  const dangling = handles.filter(h => !known.has(h));
  const duplicate = known.size !== obs.length || new Set(handles).size !== handles.length;
  return {
    ok: false,
    evidence: 'unknown',
    reason: duplicate ? 'duplicate_handle' : dangling.length ? 'unobserved_handle' : 'citation_context_unavailable',
    dangling,
    raw_output: text,
  };
}
