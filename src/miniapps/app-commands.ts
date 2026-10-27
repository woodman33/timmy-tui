/**
 * R13 (the operator's 15:31 order, item 4): `timmy video` (Film Room) and `timmy animate` (Timmy Animate), through the one
 * mini-app host (C1, src/companion/miniapps/). Each command opens the owner's app for the active project exactly as the page
 * does (the same data folder, the same durable server job, the same worker guard), runs the app's own job, waits for the
 * app's own end state, and prints the receipt Timmy sealed for it in the project's runs chain. A job is stopped by Ctrl+C or
 * `--cancel-after <seconds>`: Timmy asks the app to cancel it and seals the app's own outcome. The owners' authoring commands
 * (Animate's scene editing, which needs no server) run as the owner ships them, from the hosted copy.
 *
 * These replace the owners' reference host hunks (Film Room's `timmy video` against its `/api/miniapps/video-analysis`
 * contract, Animate's `timmy animate` against its own server on 4327): the contract here is C1's, the apps are unchanged.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { hostProblem } from '../companion/miniapps/host.js';
import { miniAppOf } from '../companion/miniapps/registry.js';
import { openAppSession, waitFor, type AppSession } from '../companion/miniapps/session.js';

type Out = (line: string) => void;
interface Io { out?: Out; err?: Out; env?: Record<string, string | undefined>; signal?: AbortSignal }

const flag = (args: string[], name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const without = (args: string[], ...names: string[]): string[] => { const out: string[] = []; for (let i = 0; i < args.length; i++) { if (names.includes(args[i]!)) { i++; continue; } out.push(args[i]!); } return out; };

/** Runs one of the app's jobs to its end: waits, cancels on Ctrl+C / --cancel-after, seals, prints. */
async function runJob(s: AppSession, o: { started: unknown; read: (id: string) => Promise<Record<string, unknown> | null>; ended: (j: Record<string, unknown> | null) => boolean; stateOf: (j: Record<string, unknown> | null) => string; cancel: (id: string) => Promise<void>; cancelAfterS?: number; out: Out; json: boolean; signal?: AbortSignal }): Promise<number> {
  const start = o.started as { id?: string; jobId?: string; error?: string } | null;
  const id = start?.jobId ?? start?.id;
  if (!id) { o.out(`${s.spec.title} did not start the job: ${start?.error ?? 'no job id in its answer'}`); return 1; }
  let cancelled = false;
  const doCancel = async () => { if (cancelled) return; cancelled = true; await o.cancel(id).catch(() => undefined); };
  const onSig = () => { void doCancel(); };
  process.once('SIGINT', onSig);
  o.signal?.addEventListener('abort', onSig, { once: true });
  const timer = o.cancelAfterS !== undefined ? setTimeout(() => { void doCancel(); }, o.cancelAfterS * 1000) : null;
  if (!o.json) o.out(`${s.spec.title} job ${id} started in ${s.project.name}.`);
  const end = await waitFor(() => o.read(id), o.ended, 600_000);
  if (timer) clearTimeout(timer);
  process.removeListener('SIGINT', onSig);
  // (the receipt: the app's own end word, sealed from its record once the record says it ended; then the worker stops)
  await s.sealFor(id);
  await s.close();
  const receipts = s.receiptsOf(id);
  const state = o.stateOf(end);
  if (o.json) o.out(JSON.stringify({ app: s.spec.id, project: s.project.name, job: id, state, cancelRequested: cancelled, receipts, result: end }, null, 2));
  else {
    o.out(`${s.spec.title} job ${id}: ${state}${cancelled ? ' (cancel asked)' : ''}.`);
    for (const r of receipts) o.out(`receipt ${r.id}: ${r.status} (the app said ${r.state})`);
    if (!receipts.length) o.out('No receipt was sealed: the app did not report this job ended.');
  }
  return state === 'complete' || state === 'succeeded' ? 0 : state === 'cancelled' ? 130 : 1;
}

const VIDEO_HELP = `timmy video: Film Room (video analysis) through Timmy's mini-app host, in the active project
  status                         the app's capabilities here (ffmpeg, ffprobe, OpenTimelineIO, cloud: off)
  assets                         the project's media
  import <file>                  bring a video in (the app's own ingest job); prints the job's end and its receipt
  render <asset-id> <manifest.json> [--reel] [--otio]
                                 cut clips (the app's render job); prints the job's end and its receipt
  jobs                           the project's video jobs as the app keeps them
  job <id>                       one job, and the receipts Timmy sealed for it
  --cancel-after <s>, Ctrl+C     on import and render: ask the app to cancel the job; its outcome is sealed as it ends
  --json                         machine-readable answers
No provider key or paid switch reaches the app (Airtable, Roboflow and Cloudflare stay off here).`;

export async function runVideoCli(argv: string[], io: Io = {}): Promise<number> {
  const out = io.out ?? ((l) => console.log(l)); const err = io.err ?? ((l) => console.error(l));
  const json = argv.includes('--json');
  const cancelAfter = flag(argv, '--cancel-after');
  const args = without(argv.filter((a) => a !== '--json'), '--cancel-after');
  const [op, a1, a2] = args;
  if (!op || op === '--help' || op === '-h' || op === 'help') { out(VIDEO_HELP); return 0; }
  const env = io.env ?? process.env;
  const s = await openAppSession('film-room', { env });
  if ('error' in s) { err(s.error); return 2; }
  const done = async (code: number) => { await s.close(); return code; };
  const show = (v: unknown) => out(json ? JSON.stringify(v, null, 2) : JSON.stringify(v, null, 2));
  if (op === 'status') { const r = await s.request('GET', '/api/config'); show(r.json); return done(r.status === 200 ? 0 : 1); }
  if (op === 'assets') { const r = await s.request('GET', '/api/assets'); show(r.json); return done(r.status === 200 ? 0 : 1); }
  if (op === 'jobs') { const { APP_JOBS } = await import('../companion/miniapps/app-jobs.js'); show((await APP_JOBS['film-room']({ json: async () => null, dataDir: s.app.dataDir })).map((j) => ({ id: j.id, kind: j.kind, state: j.status, receipts: s.receiptsOf(j.id) }))); return done(0); }
  if (op === 'job' && a1) { const r = await s.request('GET', `/api/jobs/${encodeURIComponent(a1)}`); show({ job: r.json, receipts: s.receiptsOf(a1) }); return done(r.status === 200 ? 0 : 1); }
  const read = async (id: string) => (await s.request('GET', `/api/jobs/${encodeURIComponent(id)}`)).json as Record<string, unknown> | null;
  const ended = (j: Record<string, unknown> | null) => !j || !['queued', 'running'].includes(String(j.state));
  const cancel = async (id: string) => { await s.request('POST', `/api/jobs/${encodeURIComponent(id)}/cancel`, {}); };
  const common = { read, ended, stateOf: (j: Record<string, unknown> | null) => String(j?.state ?? 'unknown'), cancel, cancelAfterS: cancelAfter ? Number(cancelAfter) : undefined, out, json, signal: io.signal };
  if (op === 'import' && a1) {
    const file = resolve(a1);
    if (!existsSync(file)) { err(`No such file: ${a1}`); return done(2); }
    const r = await s.request('POST', `/api/assets?name=${encodeURIComponent(basename(file))}`, readFileSync(file), { 'content-type': 'application/octet-stream' });
    if (r.status >= 400) { err(`Film Room refused the import (${r.status}): ${(r.json as { error?: string } | null)?.error ?? ''}`); return done(1); }
    return runJob(s, { ...common, started: r.json });
  }
  if (op === 'render' && a1 && a2) {
    let manifest: unknown;
    try { manifest = JSON.parse(readFileSync(resolve(a2), 'utf8')); } catch { err(`The manifest is not readable JSON: ${a2}`); return done(2); }
    // R13 (the Mac run of 7bf70af): Film Room renders a manifest only when it names the asset it cuts (asset.name, and id and
    // sha256 when given, must be the selected asset's: its runtime's validateManifest). A manifest that names none gets the
    // chosen asset's, read from the app's own list, and the command says so; one that names an asset goes as written.
    if (manifest && typeof manifest === 'object' && !(manifest as { asset?: unknown }).asset) {
      const list = (await s.request('GET', '/api/assets')).json as { assets?: Array<{ id: string; name?: string; sha256?: string }> } | null;
      const chosen = list?.assets?.find((x) => x.id === a1);
      if (!chosen) { err(`Film Room has no asset ${a1} in ${s.project.name} (timmy video assets lists them).`); return done(1); }
      (manifest as Record<string, unknown>).asset = { id: chosen.id, name: chosen.name, ...(chosen.sha256 ? { sha256: chosen.sha256 } : {}) };
      if (!json) out(`The manifest names no asset: the chosen one (${chosen.name ?? chosen.id}) is named in it, as Film Room asks.`);
    }
    const r = await s.request('POST', '/api/render-jobs', { assetId: a1, manifest, ...(args.includes('--reel') ? { reel: true } : {}), ...(args.includes('--otio') ? { otio: true } : {}) });
    if (r.status >= 400) { err(`Film Room refused the render (${r.status}): ${(r.json as { error?: string } | null)?.error ?? ''}`); return done(1); }
    return runJob(s, { ...common, started: r.json });
  }
  err(`Unknown or incomplete: timmy video ${args.join(' ')}\n${VIDEO_HELP}`);
  return done(2);
}

const ANIMATE_HELP = `timmy animate: Timmy Animate through Timmy's mini-app host, in the active project
  doctor                         what is installed here: the hosted copy, its build, Blender for native export
  render <scene.json>            the app's native export (Blender: .blend, .usda, previews); prints its end and its receipt
  job <id>                       one export, and the receipts Timmy sealed for it
  --cancel-after <s>, Ctrl+C     on render: ask the app to cancel the export; its outcome is sealed as it ends
  --json                         machine-readable answers
Scene authoring (no server, no receipt; the owner's own commands): new, example, templates, template, recipe, inspect,
add, theme, motion, keyframe, path, path-preset, layer, distort, draw, audio, svg, lottie, after-effects, xstate,
motion-react, states-init, state. Example: timmy animate example scene.json`;
const AUTHORING = new Set(['new', 'example', 'templates', 'template', 'recipe', 'motion-react', 'lottie', 'after-effects', 'xstate', 'states-init', 'state', 'path-preset', 'layer', 'inspect', 'add', 'theme', 'motion', 'keyframe', 'path', 'distort', 'draw', 'audio', 'svg']);

export async function runAnimateCli(argv: string[], io: Io = {}): Promise<number> {
  const out = io.out ?? ((l) => console.log(l)); const err = io.err ?? ((l) => console.error(l));
  const json = argv.includes('--json');
  const cancelAfter = flag(argv, '--cancel-after');
  const args = without(argv.filter((a) => a !== '--json'), '--cancel-after');
  const [op, a1] = args;
  const env = io.env ?? process.env;
  if (!op || op === '--help' || op === '-h' || op === 'help') { out(ANIMATE_HELP); return 0; }
  const spec = miniAppOf('animate')!;
  const dir = env[spec.host!.sourceEnv];
  if (op === 'doctor') {
    const problem = hostProblem(spec, env);
    const blender = env.ANIMATE_BLENDER || ['/Applications/Blender.app/Contents/MacOS/Blender'].find((p) => existsSync(p)) || (spawnSync('blender', ['--version'], { stdio: 'ignore', timeout: 10_000 }).status === 0 ? 'blender (on PATH)' : null);
    const report = { installed: dir ?? null, problem, blender: blender ?? null, tldrawLicense: env.TLDRAW_LICENSE_KEY ? 'set (never printed)' : 'not set' };
    out(json ? JSON.stringify(report, null, 2) : [problem ? `Timmy Animate needs setup: ${problem}` : `Timmy Animate is installed here (${dir}).`, blender ? `Native export: Blender at ${blender}.` : 'Native export: no Blender found (set ANIMATE_BLENDER).', `tldraw licence: ${report.tldrawLicense}.`].join('\n'));
    return problem ? 1 : 0;
  }
  if (AUTHORING.has(op)) {
    if (!dir || !existsSync(join(dir, 'tools', 'animate-cli.mjs'))) { err(`Timmy Animate's authoring commands are not installed here: ${spec.host!.sourceEnv} names no folder with tools/animate-cli.mjs.`); return 2; }
    // (the owner's command, as shipped; scene files are read and written where the person names them)
    const r = spawnSync(process.execPath, [join(dir, 'tools', 'animate-cli.mjs'), ...args], { stdio: 'inherit', env: { PATH: env.PATH, HOME: env.HOME, LANG: env.LANG } as NodeJS.ProcessEnv });
    return r.status ?? 1;
  }
  const s = await openAppSession('animate', { env });
  if ('error' in s) { err(s.error); return 2; }
  if (op === 'job' && a1) { const r = await s.request('GET', `/api/jobs/${encodeURIComponent(a1)}`); out(JSON.stringify({ job: r.json, receipts: s.receiptsOf(a1) }, null, 2)); await s.close(); return r.status === 200 ? 0 : 1; }
  if (op === 'render' && a1) {
    let scene: unknown;
    try { scene = JSON.parse(readFileSync(resolve(a1), 'utf8')); } catch { err(`The scene is not readable JSON: ${a1}`); await s.close(); return 2; }
    const r = await s.request('POST', '/api/jobs', { scene });
    if (r.status >= 400) { err(`Timmy Animate refused the export (${r.status}): ${(r.json as { error?: string } | null)?.error ?? ''}`); await s.close(); return 1; }
    return runJob(s, {
      started: r.json, out, json, signal: io.signal, cancelAfterS: cancelAfter ? Number(cancelAfter) : undefined,
      read: async (id) => (await s.request('GET', `/api/jobs/${id}`)).json as Record<string, unknown> | null,
      ended: (j) => !j || !['queued', 'running'].includes(String(j.status)),
      stateOf: (j) => String(j?.status ?? 'unknown'),
      cancel: async (id) => { await s.request('POST', `/api/jobs/${id}/cancel`, {}); },
    });
  }
  await s.close();
  err(`Unknown or incomplete: timmy animate ${args.join(' ')}\n${ANIMATE_HELP}`);
  return 2;
}
