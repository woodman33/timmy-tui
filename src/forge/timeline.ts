// FORGE OTIO emitter (p13; decisions.md D3/D6; DESIGN.md §1). `timmy
// timeline emit` assembles gen.result receipts into a valid OpenTimelineIO
// file; each clip's metadata carries timmy:{receipt_hash, prev,
// prompt_hash, gen_id, rights}. Defaults come from the CUE-validated
// timeline spec. Emits seal timeline.emit with the file hash. JSON shape
// mirrors otio 0.18.1 serialization exactly (Clip.2 + media_references).
// Optional probe segment info (from probe/segments.ts, matched by beat_id
// to a clip's slot_id) carries caller declarations, not verified evidence; absent info
// leaves clip metadata untouched (byte-equivalent to pre-probe emits).
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, lstatSync, linkSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readChain, receiptsPath, verifyChain, verifySignature, appendReceipt } from '../utils/receipts.js';
import { forgeEnabled, sha256 } from './gen.js';

export interface TimelineSpec {
  clip_seconds: number; width: number; height: number;
  transition: string; xfade_seconds: number; rate: number; rights_line: string;
}
const DEFAULT_SPEC: TimelineSpec = {
  clip_seconds: 5, width: 1280, height: 720, transition: 'cut',
  xfade_seconds: 1, rate: 24, rights_line: 'generated in timmy, proven by receipts',
};

export function validateTimelineSpec(spec: TimelineSpec): void {
  const dir = mkdtempSync(join(tmpdir(), 'forge-tl-'));
  const data = join(dir, 'spec.json');
  writeFileSync(data, JSON.stringify(spec));
  const schema = join(fileURLToPath(new URL('.', import.meta.url)), 'timeline.cue');
  const r = spawnSync('cue', ['vet', schema, data, '-d', 'spec'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`timeline spec rejected by CUE: ${(r.stderr ?? '').split('\n')[0]}`);
}

const UV_OTIO_PY = join(homedir(), '.local', 'share', 'uv', 'tools', 'opentimelineio', 'bin', 'python');

/** Interpreter location varies by installation; the OTIO version remains pinned below. */
function otioPython(): string {
  const configured = process.env.TIMMY_OTIO_PYTHON;
  if (configured !== undefined) {
    if (!configured.trim()) throw new Error('OTIO acceptance failed: TIMMY_OTIO_PYTHON is empty');
    return configured;
  }
  // Local uv tool installations and CI's pinned python3 user-site installation
  // both run the same native parser/version check; never fall back after rejection.
  return existsSync(UV_OTIO_PY) ? UV_OTIO_PY : 'python3';
}

// Probe-validation status for one segment/clip, carried in from
// probe/segments.ts (ProbeSegment.beat_id / probe_validated). Only the two
// fields markProbeValidation needs to write into clip metadata (it mutates
// clips in place) — callers decide how they know validation state
// (ledger judges, verifySegments, etc).
export interface SegmentValidation {
  beat_id: string;
  probe_validated: boolean;
}

// Clip metadata shape this module writes; kept loose. NOTE: markProbeValidation
// MUTATES these blocks in place — it is not pure; callers must own the array.
type ClipMeta = Record<string, unknown>;

// Fold probe-validation status into clip timmy metadata, matched by
// beat_id → slot_id (falling back to gen id for slot-less receipts).
// MUTATES the given clips in place (the metadata.timmy block); callers must
// own the array. Clips with no matching segment keep their metadata
// untouched, and an undefined segments list leaves every clip untouched — so
// emits without probe info stay byte-equivalent to pre-probe emits.
export function markProbeValidation<T extends { metadata: { timmy: ClipMeta }; name: string }>(
  clips: T[], segments: SegmentValidation[] | undefined, slotIdOf: (clip: T) => string,
): void {
  if (!segments || segments.length === 0) return;
  const byBeat = new Map<string, boolean>();
  for (const s of segments) {
    if (typeof s.beat_id !== 'string' || !s.beat_id.trim() || typeof s.probe_validated !== 'boolean') throw new Error('invalid probe validation declaration');
    if (byBeat.has(s.beat_id)) throw new Error('duplicate probe beat id');
    byBeat.set(s.beat_id, s.probe_validated);
  }
  for (const clip of clips) {
    const v = byBeat.get(slotIdOf(clip));
    if (v === undefined) continue;
    // A caller boolean keyed only by slot cannot qualify this generation.
    // Retain the assertion separately until receipt/probe evidence is admitted.
    clip.metadata.timmy.probe_validation_declared = v;
    clip.metadata.timmy.probe_validation_state = 'declared';
    clip.metadata.timmy.probe_validated = false;
    clip.metadata.timmy.beat_id = slotIdOf(clip);
  }
}

export function emitTimeline(opts: { specPath?: string; out?: string; dir?: string; segments?: SegmentValidation[] } = {}): { file: string; clips: number; seal: string } {
  if (!forgeEnabled()) throw new Error('forge lane gated: run with TIMMY_FORGE=1 (D1)');
  const dir = opts.dir ?? process.cwd();
  const spec: TimelineSpec = opts.specPath
    ? { ...DEFAULT_SPEC, ...JSON.parse(readFileSync(opts.specPath, 'utf8')) as Partial<TimelineSpec> }
    : DEFAULT_SPEC;
  validateTimelineSpec(spec);
  const receiptFile = receiptsPath('runs', dir);
  const text = existsSync(receiptFile) ? readFileSync(receiptFile, 'utf8') : '';
  if (text && !text.endsWith('\n')) throw new Error('incomplete timeline receipt stream');
  const rows = text ? text.slice(0, -1).split('\n').map(line => JSON.parse(line)) : [];
  if (rows.some(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return true;
    if (Object.hasOwn(row, 'hash')) return typeof row.hash !== 'string';
    return row.v !== 1 || typeof row.ts !== 'string' || !Number.isFinite(Date.parse(row.ts)) ||
      typeof row.kind !== 'string' || !row.kind || !row.payload || typeof row.payload !== 'object' ||
      Array.isArray(row.payload) || Object.keys(row).some(key => !['v', 'ts', 'kind', 'payload'].includes(key));
  })) throw new Error('invalid timeline receipt stream');
  const chain = readChain('runs', dir);
  const verified = verifyChain('runs', dir);
  if (rows.filter(row => Object.hasOwn(row, 'hash')).length !== chain.length || !verified.ok || verified.segments.some(segment => !segment.ok)) throw new Error('timeline source receipt chain failed verification');
  const gens = chain.filter(r => r.kind === 'gen.result' && r.status === 'ok' && Array.isArray(r.artifacts) && typeof r.artifacts[0] === 'string' && r.artifacts[0].length > 0);
  if (gens.some(g => !verifySignature(g))) throw new Error('timeline source receipt signature failed verification');
  if (gens.length === 0) throw new Error('no gen.result receipts to cut — run timmy gen first');
  const clips = gens.map(g => {
    const src = Array.isArray(g.sources) ? (g.sources as { slot_id?: string; local?: boolean }[])[0] : undefined;
    return {
      OTIO_SCHEMA: 'Clip.2',
      metadata: {
        timmy: {
          receipt_hash: g.hash, prev: g.prev_hash, prompt_hash: g.prompt_hash ?? '',
          gen_id: g.id, rights: spec.rights_line, slot_id: src?.slot_id ?? '',
        },
      },
      name: `forge ${src?.slot_id ?? g.id}`,
      source_range: {
        OTIO_SCHEMA: 'TimeRange.1',
        duration: { OTIO_SCHEMA: 'RationalTime.1', rate: spec.rate, value: spec.clip_seconds * spec.rate },
        start_time: { OTIO_SCHEMA: 'RationalTime.1', rate: spec.rate, value: 0 },
      },
      effects: [], markers: [], enabled: true, color: null,
      media_references: {
        DEFAULT_MEDIA: {
          OTIO_SCHEMA: 'ExternalReference.1', metadata: {}, name: '',
          available_range: null, available_image_bounds: null,
          target_url: `file://${(g.artifacts ?? [''])[0]}`,
        },
      },
      active_media_reference_key: 'DEFAULT_MEDIA',
    };
  });
  markProbeValidation(clips, opts.segments, c => {
    const m = c.metadata.timmy as { slot_id?: string; gen_id?: string };
    return m.slot_id || m.gen_id || '';
  });
  const tl = {
    OTIO_SCHEMA: 'Timeline.1', metadata: {}, name: 'timmy-forge', global_start_time: null,
    tracks: {
      OTIO_SCHEMA: 'Stack.1', metadata: {}, name: 'tracks', source_range: null,
      effects: [], markers: [], enabled: true, color: null,
      children: [{
        OTIO_SCHEMA: 'Track.1', metadata: {}, name: 'forge', source_range: null,
        effects: [], markers: [], enabled: true, color: null,
        children: clips, kind: 'Video',
      }],
    },
  };
  const out = opts.out ?? join(dir, '.timmy', 'forge', 'timeline.otio');
  try { lstatSync(out); throw new Error('timeline output already exists'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  mkdirSync(dirname(out), { recursive: true });
  const staging = mkdtempSync(join(dirname(out), '.timeline-'));
  const candidate = join(staging, 'timeline.otio');
  try {
  writeFileSync(candidate, JSON.stringify(tl, null, 2), { flag: 'wx' });
  // D6 acceptance: the pinned OTIO python must parse what we wrote.
  const chk = spawnSync(otioPython(), ['-c',
    'import opentimelineio as otio,sys\n' +
    'if otio.__version__ != "0.18.1": raise RuntimeError("OTIO version mismatch")\n' +
    't=otio.adapters.read_from_file(sys.argv[1]); c=list(t.tracks[0])\n' +
    'if not c or "timmy" not in c[0].metadata: raise RuntimeError("invalid timeline metadata")\n' +
    'print(len(c), c[0].metadata["timmy"]["receipt_hash"][:12])', candidate], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 });
  if (chk.error) throw new Error(`OTIO acceptance failed: interpreter could not run (${(chk.error as NodeJS.ErrnoException).code ?? 'spawn error'})`);
  if (chk.status !== 0) throw new Error(`OTIO acceptance failed: ${(chk.stderr ?? '').slice(0, 300) || (chk.signal ? `interpreter terminated by ${chk.signal}` : `interpreter exited ${chk.status}`)}`);
  linkSync(candidate, out);
  } finally { rmSync(staging, { recursive: true, force: true }); }
  const seal = appendReceipt('runs', {
    kind: 'timeline.emit', subject: `forge timeline · ${clips.length} clips`,
    policy: 'auto', output_sha256: sha256(readFileSync(out)), artifacts: [out],
    status: 'ok', sources: [{ clips: clips.length, transition: spec.transition }],
  } as never, dir);
  return { file: out, clips: clips.length, seal: seal.hash };
}
