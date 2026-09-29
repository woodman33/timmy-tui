// Probe segmentation — slice a probe artifact into beat-aligned time-map
// segments, each hashed (sha256 of its bytes) so downstream consumers (the
// OTIO/timeline marking stage) can address segments independently by hash.
// Slicing + hashing only; ledger writes are separate (recordSegments) per the
// forge contract.
//
// Hash commitment contract: each sha256 commits to ONE ENVIRONMENT's encoded
// bytes. The muxer/encoder version tags are embedded in the segment, so the
// same machine + ffmpeg version reproduces byte-identical output (verified
// against the testsrc fixture); different environments will NOT match. This
// is a documented limitation, not a silent guarantee. Segment files are
// caller-owned; the ledger stores basenames only, so verifying a ledgered
// hash requires the original file, located via the caller's own resolution
// (see verifySegments).
import { closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, extname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { appendLedger, readLedger } from '../ledger.js';
import { ffmpegAvailable } from '../../utils/framecap.js';
import type { Beat } from '../prompt-version.js';

export interface ProbeSegment {
  beat_id: string;
  start_s: number;
  end_s: number;
  file: string;             // absolute path to the segment media file
  sha256: string;           // hash of the segment file bytes (hex, no prefix)
  probe_validated: boolean; // ALWAYS false at slice time (v1 contract): the
  // OTIO/timeline marking stage is the consumer that interprets this flag;
  // confidence-weighted judging that would flip it is spec-future, not shipped.
}

function probeDuration(probeFile: string): number {
  const r = spawnSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    probeFile,
  ], { encoding: 'utf8' });
  if (r.status !== 0) {
    const detail = r.status === null ? (r.error?.message ?? 'spawn failed') : (r.stderr?.trim() ?? '');
    throw new Error(`ffprobe failed on ${probeFile}: ${detail}`);
  }
  const d = Number.parseFloat((r.stdout ?? '').trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error(`ffprobe returned no duration for ${probeFile}`);
  return d;
}

// Segment extraction flags: re-encode with libx264 ultrafast. Verified against
// the testsrc fixture that `-c copy` misaligns cuts (it snaps segment starts
// to the nearest keyframe, e.g. a [1,2)s request yields 1.4s), while input
// seeking + re-encode matches that fixture window (1.000s). General cuts
// remain frame-quantized; nonzero output bytes do not qualify decoded duration.
function extractSegment(probeFile: string, start: number, end: number, out: string): void {
  const r = spawnSync('ffmpeg', [
    '-y', '-v', 'error',
    '-ss', String(start), '-to', String(end),
    '-i', probeFile,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-an',
    out,
  ], { encoding: 'utf8' });
  if (r.status !== 0 || !existsSync(out) || statSync(out).size === 0) {
    throw new Error(`ffmpeg failed on segment [${start}, ${end}): ${r.stderr?.trim()}`);
  }
}

function safeFilename(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value !== '.' &&
    !/[\\/\x00-\x1f\x7f]/.test(value) && !value.includes('..');
}

function validWindow(start: unknown, end: unknown): boolean {
  return typeof start === 'number' && Number.isFinite(start) && start >= 0 &&
    typeof end === 'number' && Number.isFinite(end) && end > start;
}

function assertSegment(s: { beat_id: unknown; start_s: unknown; end_s: unknown; file: unknown; sha256: unknown }): void {
  if (!safeFilename(s.beat_id) || !safeFilename(s.file)) throw new Error('segment has an unsafe filename');
  if (!validWindow(s.start_s, s.end_s)) throw new Error('segment has an invalid time window');
  if (typeof s.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(s.sha256)) throw new Error('segment has an invalid sha256');
}

function pathExists(p: string): boolean {
  try { lstatSync(p); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

function sha256OfBytes(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

// Slice a probe artifact into beat-aligned segments. Pure slicing + hashing;
// ledger writes are separate (recordSegments). Segment i = [beats[i].t,
// beats[i+1].t); the last beat runs to the video end. Segments are clamped to
// the video duration; beats starting at/beyond the end are skipped (warned,
// excluded) so no empty files are produced.
//
// Error idiom: sliceProbe throws while framecap returns Result objects —
// deliberate. Slicing is an all-or-nothing operation (partial segment sets
// are worse than no segments), and callers batch-verify completed slices
// against the ledger via verifySegments.
export async function sliceProbe(probeFile: string, beats: Beat[], outDir: string): Promise<ProbeSegment[]> {
  if (!existsSync(probeFile)) throw new Error(`probe not found: ${probeFile}`);
  if (beats.length === 0) return [];
  // Beat ids are agent-authored strings that become output filenames under
  // `ffmpeg -y` — validate ALL of them before any ffmpeg call so a bad id
  // can neither traverse the filesystem nor silently overwrite a sibling
  // beat's segment file.
  const seen = new Set<string>();
  const times = new Set<number>();
  for (const b of beats) {
    if (typeof b.id !== 'string' || !b.id.trim()) throw new Error('sliceProbe: beat id is empty or invalid');
    if (!safeFilename(b.id)) throw new Error(`sliceProbe: beat id ${JSON.stringify(b.id)} is not a safe filename`);
    const key = b.id.normalize('NFC').toLowerCase();
    if (seen.has(key)) throw new Error(`sliceProbe: duplicate beat id ${JSON.stringify(b.id)}`);
    seen.add(key);
    if (typeof b.t !== 'number' || !Number.isFinite(b.t) || b.t < 0) throw new Error('sliceProbe: beat time must be finite and nonnegative');
    if (times.has(b.t)) throw new Error('sliceProbe: duplicate beat time');
    times.add(b.t);
  }
  if (!ffmpegAvailable()) throw new Error('ffmpeg not installed (brew install ffmpeg)');
  // Probe/validate before creating even the destination directory.
  const duration = probeDuration(probeFile);
  const ext = extname(probeFile) || '.mp4';
  const sorted = [...beats].sort((a, b) => a.t - b.t);
  const windows = sorted.flatMap((beat, i) => {
    if (beat.t >= duration) {
      console.warn(`sliceProbe: beat ${beat.id} starts at ${beat.t}s, past video end ${duration}s — skipping`);
      return [];
    }
    const end = Math.min(i + 1 < sorted.length ? sorted[i + 1].t : duration, duration);
    if (!validWindow(beat.t, end)) throw new Error('sliceProbe: invalid time window');
    const name = `${beat.id}${ext}`;
    if (!safeFilename(name)) throw new Error('sliceProbe: unsafe output filename');
    return [{ beat, end, name }];
  });
  if (windows.length === 0) return [];
  mkdirSync(outDir, { recursive: true });
  const outputRoot = realpathSync(outDir);
  // Refuse every pre-existing destination, including dangling symlinks, before
  // encoding. Exclusive hard-link publication also closes the check/write race.
  for (const w of windows) {
    if (pathExists(join(outputRoot, w.name))) throw new Error(`sliceProbe: output already exists: ${w.name}`);
  }
  const staging = mkdtempSync(join(outputRoot, '.segments-'));
  const segments: ProbeSegment[] = [];
  const published: Array<{ file: string; source: string }> = [];
  try {
    for (const w of windows) {
      const temporary = join(staging, w.name);
      extractSegment(probeFile, w.beat.t, w.end, temporary);
      segments.push({ beat_id: w.beat.id, start_s: w.beat.t, end_s: w.end,
        file: join(outputRoot, w.name), sha256: sha256OfBytes(temporary), probe_validated: false });
    }
    for (const s of segments) {
      const source = join(staging, basename(s.file));
      linkSync(source, s.file); // EEXIST preserves concurrent files/symlinks.
      published.push({ file: s.file, source });
    }
  } catch (error) {
    // Remove only links to our own staged inodes, never another writer's file.
    for (const { file, source } of published) {
      if (pathExists(file)) {
        const actual = lstatSync(file), ours = statSync(source);
        if (actual.dev === ours.dev && actual.ino === ours.ino) unlinkSync(file);
      }
    }
    throw error;
  } finally { rmSync(staging, { recursive: true, force: true }); }

  return segments;
}

// Ledger the segments as independently judgeable artifacts: one record per
// segment, basename only (absolute paths are machine-specific and never
// ledgered). Returns the ledger seq of the last record written.
export function recordSegments(dir: string, missionId: string, segments: ProbeSegment[]): number {
  for (const s of segments) {
    if (typeof s.file !== 'string') throw new Error('segment has an invalid filename');
    assertSegment({ ...s, file: basename(s.file) });
  }
  let last = -1;
  for (const s of segments) {
    last = appendLedger({
      kind: 'probe_segment',
      mission_id: missionId,
      beat_id: s.beat_id,
      start_s: s.start_s,
      end_s: s.end_s,
      sha256: s.sha256,
      file: basename(s.file),
    }, dir).seq;
  }
  return last;
}

// Read back a mission's probe segments from the ledger, ordered by seq.
// probe_validated is always false on read (v1 contract): nothing in the
// shipped pipeline flips it — the OTIO/timeline marking stage is the consumer,
// and confidence-weighted judging that would set it remains spec-future.
export function readSegments(dir: string, missionId: string): ProbeSegment[] {
  return readLedger(dir, { verify: true })
    .filter(r => r.kind === 'probe_segment' && r.mission_id === missionId)
    .map(r => {
      assertSegment({ beat_id: r.beat_id, start_s: r.start_s, end_s: r.end_s, file: r.file, sha256: r.sha256 });
      return { beat_id: r.beat_id as string, start_s: r.start_s as number,
        end_s: r.end_s as number, file: r.file as string, sha256: r.sha256 as string,
        probe_validated: false };
    });
}

export interface SegmentVerifyResult {
  beat_id: string;
  ok: boolean;
  sha256?: string;          // actual hash of the located file's bytes
  expected_sha256: string;  // hash recorded in the ledger
  reason?: string;          // missing, unsafe_file, or unreadable
}

// Re-hash a mission's ledgered segments against the caller's own segment
// files: locate join(resolveDir, record.file), re-hash its bytes, compare to
// the ledgered sha256. Never throws on mismatch — returns one result per
// record so callers can batch-verify a slice. See the module header for the
// commitment contract (one environment's encoded bytes; original file
// required).
export function verifySegments(dir: string, missionId: string, resolveDir: string): SegmentVerifyResult[] {
  return readSegments(dir, missionId).map(r => {
    const p = join(resolveDir, r.file);
    let fd: number | undefined;
    try {
      // Do not follow a segment symlink or block while opening a FIFO.
      fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      if (!fstatSync(fd).isFile()) return { beat_id: r.beat_id, ok: false, expected_sha256: r.sha256, reason: 'unsafe_file' };
      const sha256 = createHash('sha256').update(readFileSync(fd)).digest('hex');
      return { beat_id: r.beat_id, ok: sha256 === r.sha256, sha256, expected_sha256: r.sha256 };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const reason = code === 'ENOENT' ? 'missing' : code === 'ELOOP' ? 'unsafe_file' : 'unreadable';
      return { beat_id: r.beat_id, ok: false, expected_sha256: r.sha256, reason };
    } finally { if (fd !== undefined) closeSync(fd); }
  });
}
