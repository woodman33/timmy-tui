import { describe, it, expect, beforeAll, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpegAvailable } from '../src/utils/framecap.js';
import { sliceProbe, recordSegments, readSegments, verifySegments } from '../src/forge/probe/segments.js';
import { appendLedger } from '../src/forge/ledger.js';
import type { Beat } from '../src/forge/prompt-version.js';

// Lazily generated synthetic probe: 3s of testsrc at 10fps. The mp4 is
// gitignored (tests/fixtures/probe-*.mp4) so no binary fixture is committed.
const FIXTURE = join(__dirname, 'fixtures', 'probe-3s.mp4');

function beats(spec: Array<[string, number]>): Beat[] {
  return spec.map(([id, t]) => ({ id, t, text: `beat ${id}` }));
}

function sha256OfFile(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

const hasFfmpeg = ffmpegAvailable();
(hasFfmpeg ? describe : describe.skip)('forge probe segments', () => {
  beforeAll(() => {
    if (!existsSync(FIXTURE)) {
      mkdirSync(join(FIXTURE, '..'), { recursive: true });
      execFileSync('ffmpeg', [
        '-y', '-v', 'error',
        '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=10',
        '-pix_fmt', 'yuv420p', FIXTURE,
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
    }
  });

  it('slices a probe into beat-aligned segments with distinct content hashes', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'forge-seg-'));
    const segs = await sliceProbe(FIXTURE, beats([['b1', 0], ['b2', 1], ['b3', 2]]), outDir);
    expect(segs).toHaveLength(3);
    for (const s of segs) {
      expect(s.end_s - s.start_s).toBeCloseTo(1, 1);
      expect(existsSync(s.file)).toBe(true);
      expect(readFileSync(s.file).length).toBeGreaterThan(0);
      // hashOf convention is for canonical JSON records; segment hashes are
      // raw byte digests (hex, no prefix)
      expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(s.sha256).toBe(sha256OfFile(s.file));
      expect(s.probe_validated).toBe(false);
    }
    expect(new Set(segs.map(s => s.sha256)).size).toBe(3);
    expect(segs.map(s => s.beat_id)).toEqual(['b1', 'b2', 'b3']);
  });

  it('clamps segments to the video duration and skips beats beyond the end', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'forge-seg-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const segs = await sliceProbe(FIXTURE, beats([['b1', 0], ['b2', 1], ['b3', 2.5], ['b4', 99]]), outDir);
    expect(segs).toHaveLength(3);
    // b3 clamps [2.5, 3.0); b4 starts past the end and is skipped
    expect(segs[2].beat_id).toBe('b3');
    expect(segs[2].start_s).toBeCloseTo(2.5, 3);
    expect(segs[2].end_s).toBeCloseTo(3.0, 3);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    for (const s of segs) expect(existsSync(s.file)).toBe(true);
  });

  it('round-trips segments through the ledger with mission isolation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-seg-ledger-'));
    const outDir = mkdtempSync(join(tmpdir(), 'forge-seg-'));
    const mk = (id: string) => ({
      beat_id: id, start_s: 0, end_s: 1,
      file: join(outDir, `${id}.mp4`),
      sha256: sha256OfFile(FIXTURE), probe_validated: false,
    });
    const a1 = mk('a1');
    const a2 = mk('a2');
    const b1 = mk('b1');
    const lastSeq = recordSegments(dir, 'mA', [a1, a2]);
    expect(typeof lastSeq).toBe('number');
    recordSegments(dir, 'mB', [b1]);

    const back = readSegments(dir, 'mA');
    expect(back).toHaveLength(2);
    expect(back.map(s => s.beat_id)).toEqual(['a1', 'a2']);
    expect(back.every(s => s.probe_validated === false)).toBe(true);
    // ledgers store the basename only — never machine-specific absolute paths
    expect(back.every(s => !s.file.includes('/'))).toBe(true);
    expect(back[0].file).toBe('a1.mp4');
    // mission isolation
    expect(readSegments(dir, 'mB').map(s => s.beat_id)).toEqual(['b1']);
    expect(readSegments(dir, 'mMissing')).toEqual([]);
  });

  it('writes one ledger record per segment with kind probe_segment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-seg-ledger-'));
    const seg = {
      beat_id: 's1', start_s: 0.5, end_s: 1.5,
      file: join(tmpdir(), 'somewhere', 's1.mp4'),
      sha256: 'f'.repeat(64), probe_validated: false,
    };
    const seq = recordSegments(dir, 'mX', [seg]);
    const ledgerPath = join(dir, '.timmy', 'forge', 'ledger.jsonl');
    const rows = readFileSync(ledgerPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('probe_segment');
    expect(rows[0].mission_id).toBe('mX');
    expect(rows[0].beat_id).toBe('s1');
    expect(rows[0].start_s).toBe(0.5);
    expect(rows[0].end_s).toBe(1.5);
    expect(rows[0].sha256).toBe(seg.sha256);
    expect(rows[0].file).toBe('s1.mp4');
    expect(rows[0].seq).toBe(seq);
  });

  it('produces byte-identical segment hashes across different output dirs', async () => {
    const dirA = mkdtempSync(join(tmpdir(), 'forge-seg-a-'));
    const dirB = mkdtempSync(join(tmpdir(), 'forge-seg-b-'));
    const spec = [['b1', 0], ['b2', 1], ['b3', 2]] as Array<[string, number]>;
    const a = await sliceProbe(FIXTURE, beats(spec), dirA);
    const b = await sliceProbe(FIXTURE, beats(spec), dirB);
    expect(a.map(s => s.beat_id)).toEqual(b.map(s => s.beat_id));
    // pins the byte-determinism contract: same environment → same encoded bytes
    expect(a.map(s => s.sha256)).toEqual(b.map(s => s.sha256));
  });

  it('orders segments by beat time regardless of input order', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'forge-seg-'));
    const segs = await sliceProbe(FIXTURE, beats([['b3', 2], ['b1', 0], ['b2', 1]]), outDir);
    expect(segs.map(s => s.beat_id)).toEqual(['b1', 'b2', 'b3']);
    expect(segs.map(s => s.start_s)).toEqual([0, 1, 2]);
  });

  it('rejects unsafe or duplicate beat ids before any ffmpeg call', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'forge-seg-'));
    await expect(sliceProbe(FIXTURE, beats([['a', 0], ['a', 1]]), outDir))
      .rejects.toThrow(/duplicate beat id/);
    await expect(sliceProbe(FIXTURE, beats([['../../x', 0]]), outDir))
      .rejects.toThrow(/not a safe filename/);
    await expect(sliceProbe(FIXTURE, beats([['a\\b', 0]]), outDir))
      .rejects.toThrow(/not a safe filename/);
    await expect(sliceProbe(FIXTURE, beats([['   ', 0]]), outDir))
      .rejects.toThrow(/empty/);
    // nothing was written for the rejected slices
    expect(existsSync(join(outDir, 'a.mp4'))).toBe(false);
  });

  it('rejects invalid or duplicate times before creating output directories', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'forge-invalid-times-'));
    try {
      for (const t of [-1, NaN, Infinity]) {
        const out = join(parent, 'not-created');
        await expect(sliceProbe(FIXTURE, beats([['a', 0], ['b', t]]), out)).rejects.toThrow(/time/);
        expect(existsSync(out)).toBe(false);
      }
      await expect(sliceProbe(FIXTURE, beats([['a', 0], ['b', 0]]), join(parent, 'same'))).rejects.toThrow(/time/);
      expect(existsSync(join(parent, 'same'))).toBe(false);
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });

  it('preserves existing files and symlink targets instead of overwriting them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-no-clobber-'));
    try {
      const victim = join(dir, 'victim');
      writeFileSync(victim, 'preserved');
      symlinkSync(victim, join(dir, 'b2.mp4'));
      await expect(sliceProbe(FIXTURE, beats([['b1', 0], ['b2', 1]]), dir)).rejects.toThrow(/exist/);
      expect(readFileSync(victim, 'utf8')).toBe('preserved');
      expect(existsSync(join(dir, 'b1.mp4'))).toBe(false);
      rmSync(join(dir, 'b2.mp4'));
      writeFileSync(join(dir, 'b2.mp4'), 'older segment');
      await expect(sliceProbe(FIXTURE, beats([['b1', 0], ['b2', 1]]), dir)).rejects.toThrow(/exist/);
      expect(readFileSync(join(dir, 'b2.mp4'), 'utf8')).toBe('older segment');
      expect(readdirSync(dir).sort()).toEqual(['b2.mp4', 'victim']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('throws when the probe file is missing', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'forge-seg-'));
    await expect(sliceProbe(join(outDir, 'nope.mp4'), beats([['b1', 0]]), outDir))
      .rejects.toThrow(/probe not found/);
  });

  it('surfaces ffprobe/ffmpeg failure for a non-video probe file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-seg-'));
    const fake = join(dir, 'not-a-video.mp4');
    writeFileSync(fake, 'this is not video data');
    await expect(sliceProbe(fake, beats([['b1', 0]]), dir)).rejects.toThrow();
  });

  it('returns [] for empty beats without slicing anything', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'forge-seg-'));
    // beats.length === 0 short-circuits before the ffmpeg check — assert []
    // only, not whether ffmpeg ran
    await expect(sliceProbe(FIXTURE, [], outDir)).resolves.toEqual([]);
  });

  it('verifySegments confirms an intact slice, detects tampering and missing files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-seg-ledger-'));
    const outDir = mkdtempSync(join(tmpdir(), 'forge-seg-'));
    const segs = await sliceProbe(FIXTURE, beats([['b1', 0], ['b2', 1], ['b3', 2]]), outDir);
    recordSegments(dir, 'mVerify', segs);

    const ok = verifySegments(dir, 'mVerify', outDir);
    expect(ok.map(r => r.beat_id)).toEqual(['b1', 'b2', 'b3']);
    expect(ok.every(r => r.ok)).toBe(true);
    expect(ok[0].sha256).toBe(ok[0].expected_sha256);

    // tamper with one segment file — hash must no longer match the ledger
    appendFileSync(segs[1].file, 'tamper');
    const tampered = verifySegments(dir, 'mVerify', outDir);
    expect(tampered[1].ok).toBe(false);
    expect(tampered[1].sha256).not.toBe(tampered[1].expected_sha256);
    expect(tampered[1].expected_sha256).toBe(segs[1].sha256);
    expect(tampered[0].ok).toBe(true);

    // missing segment file reports reason 'missing', never throws
    rmSync(segs[2].file);
    const missing = verifySegments(dir, 'mVerify', outDir);
    expect(missing[2].ok).toBe(false);
    expect(missing[2].reason).toBe('missing');
    expect(missing[2].expected_sha256).toBe(segs[2].sha256);
  });
});

// These checks use only synthetic local bytes and run even without ffmpeg.
describe('forge segment readback boundaries', () => {
  it('rejects tampered ledger commitments even when file bytes match the forged digest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-ledger-tamper-'));
    try {
      const file = join(dir, 'b1.mp4');
      writeFileSync(file, 'original');
      recordSegments(dir, 'm', [{ beat_id: 'b1', start_s: 0, end_s: 1, file, sha256: sha256OfFile(file), probe_validated: false }]);
      writeFileSync(file, 'tampered');
      const ledger = join(dir, '.timmy', 'forge', 'ledger.jsonl');
      const row = JSON.parse(readFileSync(ledger, 'utf8').trim());
      row.sha256 = sha256OfFile(file);
      writeFileSync(ledger, JSON.stringify(row) + '\n');
      expect(() => verifySegments(dir, 'm', dir)).toThrow(/hash mismatch/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('rejects traversal in a valid ledger record and refuses symlink or directory readback', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-read-boundary-'));
    try {
      const out = join(dir, 'out'); mkdirSync(out);
      const outside = join(dir, 'outside.mp4'); writeFileSync(outside, 'private synthetic bytes');
      const base = { kind: 'probe_segment', beat_id: 'b1', start_s: 0, end_s: 1, sha256: sha256OfFile(outside) };
      appendLedger({ ...base, mission_id: 'traversal', file: '../outside.mp4' }, dir);
      expect(() => verifySegments(dir, 'traversal', out)).toThrow(/filename/);
      symlinkSync(outside, join(out, 'link.mp4'));
      appendLedger({ ...base, mission_id: 'link', file: 'link.mp4' }, dir);
      expect(verifySegments(dir, 'link', out)[0]).toMatchObject({ ok: false, reason: 'unsafe_file' });
      mkdirSync(join(out, 'directory.mp4'));
      appendLedger({ ...base, mission_id: 'directory', file: 'directory.mp4' }, dir);
      expect(verifySegments(dir, 'directory', out)[0]).toMatchObject({ ok: false, reason: 'unsafe_file' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
