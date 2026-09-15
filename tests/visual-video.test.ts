import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { renderVisualVideo, videoAvailability } from '../src/utils/visual-video.js';
import { readChain, verifySignature } from '../src/utils/receipts.js';
import type { StudioComposition } from '../src/utils/studio-composition.js';

const actualCli = process.env.TIMMY_HYPERFRAMES_CLI;
const retainedProof = process.env.TIMMY_VIDEO_PROOF_DIR;
const native = process.env.TIMMY_VIDEO_NATIVE === '1' && process.platform === 'darwin' && !!actualCli;
const storyboard: StudioComposition = { id: 'local-video-test', title: 'Local export', duration: 2,
  width: 640, height: 360, appearance: { background: '#000000', text: '#ffffff', label: '#ff6b35',
    fontFamilies: ['Avenir', 'sans-serif'], headlinePx: 52, labelPx: 20 },
  beats: [{ at: 0, dur: 2, label: 'TIMMY', text: 'LOCAL EXPORT' }] };
let originalCwd: string, fixture: string;
beforeEach(() => {
  originalCwd = process.cwd();
  fixture = realpathSync(mkdtempSync(join(tmpdir(), 'timmy-video-test-')));
  mkdirSync(join(fixture, 'receipts'));
  process.chdir(fixture);
  vi.stubEnv('TIMMY_STORE', join(fixture, 'receipts'));
});
afterEach(() => { vi.useRealTimers(); process.chdir(originalCwd); vi.unstubAllEnvs(); rmSync(fixture, { recursive: true, force: true }); });

describe('bounded local MP4 export', () => {
  it('refuses unavailable or relative runtime configuration without a download or receipt', async () => {
    vi.stubEnv('TIMMY_HYPERFRAMES_CLI', 'relative/renderer.mjs');
    vi.stubEnv('PATH', '');
    expect(videoAvailability().available).toBe(false);
    expect((await renderVisualVideo(storyboard)).status).toBe('refused');
    expect(readChain('runs')).toEqual([]);
    expect(readdirSync(join(fixture, 'receipts'))).toEqual([]);
  });

  describe.skipIf(process.platform !== 'darwin')('macOS confined controls', () => {
    function fakeCli(source = 'process.exit(7);') {
      const path = join(fixture, 'fixture-renderer.mjs'); writeFileSync(path, source);
      vi.stubEnv('TIMMY_HYPERFRAMES_CLI', path);
      // Presence checks use local fixture stand-ins. No Chrome/encoder is invoked by these refusals.
      vi.stubEnv('HYPERFRAMES_BROWSER_PATH', process.execPath);
      vi.stubEnv('HYPERFRAMES_FFMPEG_PATH', process.execPath);
      vi.stubEnv('HYPERFRAMES_FFPROBE_PATH', process.execPath);
      return path;
    }
    it.each([
      { duration: 31 }, { width: 3840, height: 2160 }, { width: 641 }, { width: 2048, height: 100 },
      { beats: [{ at: 0, dur: 3, label: 'BAD', text: 'outside duration' }] },
    ])('refuses resource or timing bounds before execution: %j', async invalid => {
      fakeCli();
      expect(videoAvailability().available).toBe(true);
      expect((await renderVisualVideo({ ...storyboard, ...invalid })).status).toBe('refused');
      expect(readChain('runs')).toEqual([]);
    });
    it('refuses a missing explicit browser rather than substituting a download', async () => {
      fakeCli(); vi.stubEnv('HYPERFRAMES_BROWSER_PATH', join(fixture, 'missing-browser'));
      expect(videoAvailability().available).toBe(false);
      expect((await renderVisualVideo(storyboard)).status).toBe('refused');
      expect(readChain('runs')).toEqual([]);
    });
    it('retains a native failed exit and signed result without reporting an MP4', async () => {
      fakeCli('console.log("fixture-render-failure"); process.exit(7);');
      const result = await renderVisualVideo(storyboard);
      expect(result.status).toBe('failed');
      expect(result.artifactHash).toBeUndefined();
      expect(result.artifactPath).toMatch(/render-result\.json$/);
      const report = JSON.parse(readFileSync(result.artifactPath!, 'utf8'));
      expect(report.render).toMatchObject({ exit_code: 7, failure: null });
      expect(report.failure).toBe('renderer_exit');
      expect(report.video_sha256).toBeNull();
      const sourceDir = dirname(result.artifactPath!);
      expect(readFileSync(join(sourceDir, 'render.stdout.txt'), 'utf8')).toContain('fixture-render-failure');
      expect(readFileSync(join(sourceDir, 'loopback-only.sb'), 'utf8')).toContain('(deny network*)');
      const receipts = readChain('runs');
      expect(receipts.map(r => r.kind)).toEqual(['visual.video.intent', 'visual.video.result']);
      expect(receipts[1]).toMatchObject({ status: 'failed', exit_code: 7, plan_hash: receipts[0].hash });
      expect(receipts[1].id).toBe(result.receiptId);
      expect(receipts.every(verifySignature)).toBe(true);
    });
    it('terminates the owned process on the fixed response-output limit', async () => {
      fakeCli('process.stdout.write(Buffer.alloc(3 * 1024 * 1024, 120)); setInterval(() => {},1000);');
      const result = await renderVisualVideo(storyboard);
      const report = JSON.parse(readFileSync(result.artifactPath!, 'utf8'));
      expect(result.status).toBe('failed');
      expect(report.failure).toBe('output_limit');
      expect(report.render.signal).toBe('SIGKILL');
      expect(readFileSync(join(dirname(result.artifactPath!), 'render.stdout.txt')).length).toBeLessThanOrEqual(2 * 1024 * 1024);
    });
    it('terminates the owned process on the fixed deadline and records the timeout', async () => {
      fakeCli('setInterval(() => {},1000);');
      vi.useFakeTimers();
      const pending = renderVisualVideo(storyboard);
      await vi.advanceTimersByTimeAsync(300_001);
      vi.useRealTimers();
      const result = await pending;
      const report = JSON.parse(readFileSync(result.artifactPath!, 'utf8'));
      expect(result.status).toBe('failed');
      expect(report.failure).toBe('timeout');
      expect(report.render.signal).toBe('SIGKILL');
    });
    it.each(['duration', 'nb_frames'])('rejects non-finite native %s metadata after exit zero', async field => {
      fakeCli('import fs from "node:fs"; fs.writeFileSync(process.argv[process.argv.indexOf("--output")+1],"fixture bytes");');
      const probePath = join(fixture, 'fixture-probe');
      const response = { streams: [{ codec_type: 'video', width: 640, height: 360,
        duration: '2', nb_frames: '48', r_frame_rate: '24/1', [field]: 'not-a-number' }], format: { format_name: 'mp4' } };
      writeFileSync(probePath, `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(response))});\n`);
      chmodSync(probePath, 0o700); vi.stubEnv('HYPERFRAMES_FFPROBE_PATH', probePath);
      const result = await renderVisualVideo(storyboard);
      const report = JSON.parse(readFileSync(result.artifactPath!, 'utf8'));
      expect(result.status).toBe('failed');
      expect(report.render.exit_code).toBe(0); expect(report.probe.exit_code).toBe(0);
      expect(report.failure).toBe('video_metadata'); expect(report.video_sha256).toBeNull();
    });
  });

  it.skipIf(!native)('renders one real two-second MP4 with the installed CLI, without cloud or downloads', async () => {
    vi.stubEnv('TIMMY_HYPERFRAMES_CLI', actualCli!);
    const result = await renderVisualVideo(storyboard);
    expect(result.status, result.summary + ' ' + result.artifactPath).toBe('completed');
    expect(result.artifactPath).toMatch(/preview\.mp4$/);
    const bytes = readFileSync(result.artifactPath!);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(result.artifactHash);
    const report = JSON.parse(readFileSync(join(dirname(result.artifactPath!), 'render-result.json'), 'utf8'));
    expect(report.metadata).toMatchObject({ width: 640, height: 360, frames: 48, seconds: 2, fps: '24/1' });
    expect(report.render.exit_code).toBe(0);
    expect(report.probe.exit_code).toBe(0);
    expect(report.limits).toMatchObject({ per_frame_fidelity_verified: false, models_called: false,
      network: 'loopback and local IPC only', durable_job: false });
    expect(report.command.executable).toBe('/usr/bin/sandbox-exec');
    expect(report.command.args).toContain('--workers');
    expect(report.command.args).not.toContain('npx');
    const receipts = readChain('runs');
    expect(receipts).toHaveLength(2);
    expect(receipts[1]).toMatchObject({ status: 'ok', plan_hash: receipts[0].hash, exit_code: 0 });
    expect(receipts.every(verifySignature)).toBe(true);
    if (retainedProof) {
      // Operator-requested qualification copy only. Never mix a test chain into production.
      mkdirSync(retainedProof, { mode: 0o700 });
      cpSync(dirname(result.artifactPath!), join(retainedProof, 'artifacts'), { recursive: true });
      cpSync(join(fixture, 'receipts', 'runs.jsonl'), join(retainedProof, 'isolated-test-receipts.jsonl'));
      writeFileSync(join(retainedProof, 'scope.json'), JSON.stringify({ scope: 'Retained copy of an isolated test export; no production receipts',
        artifact_sha256: result.artifactHash, receipt_id: result.receiptId, per_frame_fidelity_verified: false }, null, 2));
    }
  }, 330_000);
});
