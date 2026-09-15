import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants, createReadStream, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir, release } from 'node:os';
import { appendReceipt, receiptsDir } from './receipts.js';
import { renderStudioComposition, type StudioComposition } from './studio-composition.js';

const MAX_LOG = 2 * 1024 * 1024;
const MAX_VIDEO = 128 * 1024 * 1024;
const RENDER_TIMEOUT = 300_000;
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const sandbox = '/usr/bin/sandbox-exec';
type Runtime = { cli: string; browser: string; ffmpeg: string; ffprobe: string };
export interface VideoResult {
  status: 'completed' | 'refused' | 'failed';
  summary: string;
  artifactPath?: string;
  artifactHash?: string;
  receiptId?: string;
}

function file(path: string, executable = false): string | null {
  try {
    if (!isAbsolute(path) || !statSync(path).isFile()) return null;
    accessSync(path, executable ? constants.X_OK : constants.R_OK);
    return realpathSync(path);
  } catch { return null; }
}
function onPath(name: string): string | null {
  for (const entry of (process.env.PATH ?? '').split(':')) {
    if (!isAbsolute(entry)) continue;
    const found = file(join(entry, name), true);
    if (found) return found;
  }
  return null;
}
function runtime(): Runtime {
  if (process.platform !== 'darwin' || !file(sandbox, true)) throw new Error('Local MP4 export requires macOS loopback confinement.');
  const explicit = process.env.TIMMY_HYPERFRAMES_CLI;
  const cli = explicit ? file(explicit) : onPath('hyperframes');
  if (!cli) throw new Error('Set TIMMY_HYPERFRAMES_CLI to an existing absolute HyperFrames CLI path. No downloads are performed.');
  const browser = file(process.env.HYPERFRAMES_BROWSER_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', true);
  const ffmpeg = process.env.HYPERFRAMES_FFMPEG_PATH ? file(process.env.HYPERFRAMES_FFMPEG_PATH, true) : onPath('ffmpeg') ?? file('/opt/homebrew/bin/ffmpeg', true);
  const ffprobe = process.env.HYPERFRAMES_FFPROBE_PATH ? file(process.env.HYPERFRAMES_FFPROBE_PATH, true) : onPath('ffprobe') ?? file('/opt/homebrew/bin/ffprobe', true);
  if (!browser || !ffmpeg || !ffprobe) throw new Error('Existing Chrome, FFmpeg and FFprobe are required; installation is never automatic.');
  return { cli, browser, ffmpeg, ffprobe };
}
/** File discovery only; the actual sandbox invocation must still succeed. */
export function videoAvailability(): { available: boolean; reason: string } {
  try { runtime(); return { available: true, reason: 'Local runtime files found; confined execution is checked when run.' }; }
  catch (error) { return { available: false, reason: (error as Error).message }; }
}

type Execution = { code: number | null; signal: string | null; stdout: string; stderr: string; failure: string | null };
function execute(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout: number): Promise<Execution> {
  return new Promise(resolveResult => {
    const child = spawn(command, args, { cwd, env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', bytes = 0, failure: string | null = null;
    const stop = (reason: string) => {
      if (failure) return;
      failure = reason;
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
      catch { child.kill('SIGKILL'); }
    };
    const timer = setTimeout(() => stop('timeout'), timeout);
    const collect = (chunk: Buffer, error: boolean) => {
      if (failure) return;
      bytes += chunk.length;
      if (bytes > MAX_LOG) { stop('output_limit'); return; }
      if (error) stderr += chunk.toString(); else stdout += chunk.toString();
    };
    child.stdout.on('data', chunk => collect(chunk, false));
    child.stderr.on('data', chunk => collect(chunk, true));
    child.once('error', () => { failure = 'spawn_error'; });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolveResult({ code, signal, stdout, stderr, failure });
    });
  });
}

/** Explicit finite export of generated Timmy source, not arbitrary HTML execution or a durable job. */
export async function renderVisualVideo(storyboard: StudioComposition, dir = process.cwd()): Promise<VideoResult> {
  let rt: Runtime, source: string;
  const width = storyboard.width ?? 1920, height = storyboard.height ?? 1080;
  try {
    rt = runtime();
    if (JSON.stringify(storyboard).length > 65_536 || storyboard.duration > 30
      || width > 1920 || height > 1080 || width % 2 !== 0 || height % 2 !== 0) {
      throw new Error('MP4 export is limited to 30 seconds, 1920×1080 pixels, even dimensions and a 64 KiB storyboard.');
    }
    source = renderStudioComposition(storyboard);
  } catch (error) { return { status: 'refused', summary: (error as Error).message }; }
  const out = resolve(receiptsDir(dir), 'visual-tools', randomUUID());
  mkdirSync(out, { recursive: true, mode: 0o700 });
  const retain = (name: string, body: string) => {
    const path = join(out, name); writeFileSync(path, body, { flag: 'wx', mode: 0o600 }); return path;
  };
  const inputPath = retain('storyboard.json', JSON.stringify(storyboard, null, 2) + '\n');
  const sourcePath = retain('index.html', source);
  const video = join(out, 'preview.mp4');
  // Existing HyperFrames settings may be read, but this invocation cannot change shared settings.
  const profile = '(version 1)\n(allow default)\n(deny network*)\n'
    + '(allow network-inbound (local ip "localhost:*"))\n'
    + '(allow network-outbound (remote ip "localhost:*"))\n'
    + '(allow network* (local unix-socket) (remote unix-socket))\n'
    + `(deny file-write* (subpath ${JSON.stringify(join(homedir(), '.hyperframes'))}))\n`;
  const profilePath = retain('loopback-only.sb', profile);
  const env: NodeJS.ProcessEnv = {
    PATH: [...new Set([dirname(process.execPath), dirname(rt.ffmpeg), dirname(rt.ffprobe), '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':'),
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}), LANG: 'en_US.UTF-8',
    HYPERFRAMES_BROWSER_PATH: rt.browser, HYPERFRAMES_FFMPEG_PATH: rt.ffmpeg,
    HYPERFRAMES_FFPROBE_PATH: rt.ffprobe, HYPERFRAMES_FONT_CACHE_DIR: join(out, 'font-cache'),
    HYPERFRAMES_NO_TELEMETRY: '1', DO_NOT_TRACK: '1',
  };
  const args = ['-f', profilePath, process.execPath, rt.cli, 'render', out, '--output', video,
    '--format', 'mp4', '--fps', '24', '--quality', 'high', '--workers', '1', '--experimental-fast-capture=false'];
  const envLock = { os: { platform: process.platform, build: release() }, arch: process.arch, tools: {}, models: {} };
  const intent = appendReceipt('runs', { kind: 'visual.video.intent', subject: 'motion.mp4',
    policy: 'Explicit local export of a bounded storyboard; loopback network only', prompt_hash: sha(source),
    artifacts: [inputPath, sourcePath, profilePath], env_lock: envLock,
    sources: [{ source_sha256: sha(source), confinement_sha256: sha(profile), cli_entry_sha256: sha(readFileSync(rt.cli)) }] }, dir);
  const started = Date.now();
  let render: Execution | null = null, probe: Execution | null = null;
  let failure: string | null = null, videoHash: string | undefined, metadata: unknown = null;
  try {
    render = await execute(sandbox, args, out, env, RENDER_TIMEOUT);
    if (render.failure || render.code !== 0) throw new Error(render.failure ?? 'renderer_exit');
    const stat = lstatSync(video);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_VIDEO) throw new Error('video_size');
    probe = await execute(sandbox, ['-f', profilePath, rt.ffprobe, '-v', 'error', '-show_streams', '-show_format', '-of', 'json', video], out, env, 20_000);
    if (probe.failure || probe.code !== 0) throw new Error(probe.failure ?? 'probe_exit');
    const parsed = JSON.parse(probe.stdout);
    const videos = parsed.streams?.filter((s: { codec_type?: string }) => s.codec_type === 'video');
    const stream = videos?.[0];
    const seconds = Number(stream?.duration), frames = Number(stream?.nb_frames);
    if (videos?.length !== 1 || stream.width !== width || stream.height !== height
      || !Number.isFinite(seconds) || seconds <= 0 || !Number.isSafeInteger(frames) || frames <= 0
      || stream.r_frame_rate !== '24/1' || Math.abs(seconds - storyboard.duration) > 1 / 24
      || frames !== Math.ceil(storyboard.duration * 24)
      || !String(parsed.format?.format_name).split(',').includes('mp4')) throw new Error('video_metadata');
    metadata = { width: stream.width, height: stream.height, fps: stream.r_frame_rate,
      frames: Number(stream.nb_frames), seconds: Number(stream.duration), bytes: stat.size };
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(video)) hash.update(chunk);
    videoHash = hash.digest('hex');
  } catch (error) { failure = error instanceof Error ? error.message : 'export_failed'; }
  retain('render.stdout.txt', render?.stdout ?? ''); retain('render.stderr.txt', render?.stderr ?? '');
  retain('probe.stdout.txt', probe?.stdout ?? ''); retain('probe.stderr.txt', probe?.stderr ?? '');
  const report = JSON.stringify({ schema: 'timmy.visual-video/1', status: failure ? 'failed' : 'completed',
    source_sha256: sha(source), video_sha256: videoHash ?? null, intent_receipt: intent.id,
    runtime: rt, command: { executable: sandbox, args }, confinement_sha256: sha(profile),
    log_sha256: { render_stdout: sha(render?.stdout ?? ''), render_stderr: sha(render?.stderr ?? ''),
      probe_stdout: sha(probe?.stdout ?? ''), probe_stderr: sha(probe?.stderr ?? '') },
    render: render && { exit_code: render.code, signal: render.signal, failure: render.failure },
    probe: probe && { exit_code: probe.code, signal: probe.signal, failure: probe.failure },
    metadata, failure, elapsed_ms: Date.now() - started,
    limits: { models_called: false, network: 'loopback and local IPC only', per_frame_fidelity_verified: false,
      durable_job: false, accepted_video_byte_limit: MAX_VIDEO, renderer_timeout_ms: RENDER_TIMEOUT } }, null, 2) + '\n';
  const reportPath = retain('render-result.json', report);
  const receipt = appendReceipt('runs', { kind: 'visual.video.result', subject: 'motion.mp4',
    status: failure ? 'failed' : 'ok', policy: 'Native execution and MP4 metadata; not per-frame content verification',
    plan_hash: intent.hash, output_sha256: sha(report), artifacts: [reportPath, ...(videoHash ? [video] : [])],
    ms: Date.now() - started, exit_code: render?.code ?? -1, env_lock: envLock,
    ...(failure ? { error_class: 'exec' } : {}) }, dir);
  return { status: failure ? 'failed' : 'completed', receiptId: receipt.id,
    artifactPath: failure ? reportPath : video, ...(videoHash ? { artifactHash: videoHash } : {}),
    summary: failure ? `MP4 export failed (${failure}); execution receipt and report retained.`
      : 'MP4 exported locally; stream metadata checked. Frame content is not independently verified.' };
}
