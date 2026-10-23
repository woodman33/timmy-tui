// timmy doctor preflight tier (v1.0.0-rc1, friction log #2): automated
// environment auditor. Required checks gate their lanes at arm time so
// headless daemons never die silently mid-phase; optional tools report
// not_configured without blocking unrelated lanes. Read-only, never
// auto-fixes.
import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createConnection } from 'net';
import { openscadBin } from './usd-compiler.js';
import { probeDockerServerVersion } from './docker-server.js';
import { packagedPath } from './asset-dirs.js';

export interface DoctorCheck {
  name: string;
  required: boolean;
  state: 'ok' | 'warn' | 'not_configured';
  note?: string;
}
export interface DoctorReport { ok: boolean; checks: DoctorCheck[] }

export const comfyToolPython = (): string =>
  join(homedir(), '.local', 'share', 'uv', 'tools', 'comfy-cli', 'bin', 'python');

export function checkDocker(): DoctorCheck {
  const version = probeDockerServerVersion(5000);
  return version !== null
    ? { name: 'docker daemon', required: true, state: 'ok', note: `v${version}` }
    : { name: 'docker daemon', required: true, state: 'not_configured', note: 'docker info failed — containerized lanes fail closed' };
}

export const dockerReady = (): boolean => checkDocker().state === 'ok';

export function checkComfyCli(): DoctorCheck {
  const probe = spawnSync('comfy', ['--json', 'env'], { encoding: 'utf8', timeout: 15000 });
  if (probe.status === 0) return { name: 'comfy-cli', required: true, state: 'ok' };
  const fb = join(homedir(), '.local', 'bin', 'comfy');
  return existsSync(fb)
    ? { name: 'comfy-cli', required: true, state: 'ok', note: 'via ~/.local/bin fallback' }
    : { name: 'comfy-cli', required: true, state: 'not_configured', note: 'comfy CLI missing' };
}

// the 0.28 asset-scanner crash window: filelock + sqlalchemy must import in
// the tool venv or the daemon dies silently mid-phase
export function checkComfyVenv(): DoctorCheck {
  const py = comfyToolPython();
  if (!existsSync(py)) return { name: 'comfy venv (filelock+sqlalchemy)', required: true, state: 'not_configured', note: 'tool python missing' };
  const r = spawnSync(py, ['-c', 'import filelock, sqlalchemy'], { encoding: 'utf8', timeout: 15000 });
  return r.status === 0
    ? { name: 'comfy venv (filelock+sqlalchemy)', required: true, state: 'ok' }
    : { name: 'comfy venv (filelock+sqlalchemy)', required: true, state: 'not_configured', note: 'asset-scanner deps missing — uv pip install into the tool env' };
}

export function checkCue(): DoctorCheck {
  const r = spawnSync('cue', ['version'], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0
    ? { name: 'cue CLI', required: true, state: 'ok' }
    : { name: 'cue CLI', required: true, state: 'not_configured', note: 'brew install cue' };
}

export function checkOpenscad(): DoctorCheck {
  return openscadBin()
    ? { name: 'openscad', required: false, state: 'ok' }
    : { name: 'openscad', required: false, state: 'not_configured', note: 'CSG renders fail closed; stage provenance still ships' };
}

export function checkTmux(): DoctorCheck {
  const r = spawnSync('tmux', ['-V'], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0
    ? { name: 'tmux', required: false, state: 'ok', note: (r.stdout ?? '').trim() }
    : { name: 'tmux', required: false, state: 'not_configured', note: 'lane dispatch needs tmux' };
}

export const probePort = (port: number, ms = 750): Promise<boolean> => new Promise(res => {
  const s = createConnection({ port, host: '127.0.0.1' });
  const done = (v: boolean) => { s.destroy(); res(v); };
  s.once('connect', () => done(true));
  s.once('error', () => done(false));
  setTimeout(() => done(false), ms);
});

/**
 * R11 (H170; Phase 0 item 5): what this build carries, and what it does not. The npm package (and so the review package,
 * scripts/review/build-review.sh) now lists scripts/roboflow-bridge.py, scripts/vision-bridge.py (recovered in the R11
 * vision integration) and lanes/geo/*, and still leaves out lanes/engines. Each is a row that names the capability it lacks
 * and the one step that would supply it, never a required check: a package without them is complete for chat, VoxVision's
 * measurements and the native apps, and the doctor never fails for them. Files only; nothing is run. A bridge found here is
 * a file, not a verified model: Roboflow inference stays unverified until a real authorized run succeeds.
 */
export const BUILD_CONTENTS: ReadonlyArray<{ name: string; rel: string; absent: string; present: string }> = [
  { name: 'Roboflow bridge', rel: 'scripts/roboflow-bridge.py', absent: 'needs setup (the bridge is missing from this installation; the npm package carries it): reinstall Timmy, or run it from a checkout of its repository; a hosted detection also needs ROBOFLOW_API_KEY and the venv (.timmy/venv-roboflow). VoxVision\'s /observe, /detect (QR, ArUco, colour) and /measure do not need it', present: 'in this build; a hosted detection also needs ROBOFLOW_API_KEY and the venv (.timmy/venv-roboflow)' },
  { name: 'geo lane (voxel scorer)', rel: 'lanes/geo/voxel_score.py', absent: 'needs setup (the lane is missing from this installation; the npm package carries it): reinstall Timmy, or run it from a checkout of its repository; it also needs python3 with numpy and scipy', present: 'in this build; it needs python3 with numpy and scipy' },
  { name: 'engine shelf (timmy engine run)', rel: 'lanes/engines/engines.json', absent: 'needs setup (lanes/engines is not in this package): run Timmy from a checkout of its repository', present: 'in this build; each engine needs its own program' },
  { name: 'vision bridge (timmy vision run, timmy_vision_* tools)', rel: 'scripts/vision-bridge.py', absent: 'not available: the vision bridge is missing from this installation (the npm package carries it): reinstall Timmy, or run it from a checkout of its repository. VoxVision\'s /observe, /detect and /measure do not need it', present: 'in this build; a Roboflow model run through it also needs ROBOFLOW_API_KEY, a Python with inference-sdk and a configured model or server; Roboflow inference is unverified until a real authorized run succeeds' },
];

/** The rows for what this build carries (BUILD_CONTENTS); `probe` answers whether a packaged file is here (a test's FAKE). */
export function checkBuildContents(probe: (rel: string) => boolean = (rel) => packagedPath(rel, import.meta.url, { kind: 'file' }) !== undefined): DoctorCheck[] {
  return BUILD_CONTENTS.map((c) => {
    const here = probe(c.rel);
    return { name: c.name, required: false, state: here ? 'ok' : 'not_configured', note: here ? c.present : c.absent };
  });
}

export async function runDoctor(): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [checkDocker(), checkComfyCli(), checkComfyVenv(), checkCue(), checkOpenscad(), checkTmux(), ...checkBuildContents()];
  const comfyUp = await probePort(8188);
  checks.push({ name: 'port 8188 (ComfyUI)', required: false, state: comfyUp ? 'ok' : 'warn', note: comfyUp ? 'listener up' : 'no listener — comfy launch --background' });
  const logsUp = await probePort(Number(process.env.TIMMY_LOGS_PORT ?? 4310));
  checks.push({ name: 'port 4310 (companion)', required: false, state: 'ok', note: logsUp ? 'companion live' : 'free — binds on start' });
  return { ok: checks.filter(c => c.required).every(c => c.state === 'ok'), checks };
}

/** The oldest Node major Timmy runs on (package.json `engines`: >=24). */
export const NODE_MAJOR = 24;
/** The REPL here: it answers; it opens but has no model key to answer with; or it cannot start. */
export type ReplState = 'ready' | 'no-key' | 'unsupported';
export interface Readiness {
  repl: { state: ReplState; node: string };
  /** The lanes are optional: their required checks gate the lanes only, never the REPL. */
  lanes: { state: 'ready' | 'blocked'; missing: string[] };
  /** The doctor's exit code, the REPL's alone: 0 ready, 78 no model key (EX_CONFIG, as the REPL's own), 1 cannot start. */
  exit: 0 | 1 | 78;
}

/**
 * What works here, from the preflight and the REPL's own facts (the operator's 22:23 order): the doctor
 * said "Preflight BLOCKED" and then "Ready for demo: YES". The REPL and the optional lanes are now judged
 * apart, and the exit code says only whether the REPL is ready.
 */
export function readiness(pre: DoctorReport, facts: { node: string; key: boolean }): Readiness {
  const node = facts.node.replace(/^v/, '');
  const state: ReplState = !(Number(node.split('.')[0]) >= NODE_MAJOR) ? 'unsupported' : facts.key ? 'ready' : 'no-key';
  const missing = pre.checks.filter((c) => c.required && c.state !== 'ok').map((c) => c.name);
  return { repl: { state, node }, lanes: { state: missing.length ? 'blocked' : 'ready', missing }, exit: state === 'ready' ? 0 : state === 'no-key' ? 78 : 1 };
}

const inWords = (names: string[]): string => names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/** The doctor's "What works here" block: a line per capability, then its exit code and what each code means. */
export function readinessLines(r: Readiness): string[] {
  const repl = r.repl.state === 'ready' ? `  ✓ REPL: ready (Node ${r.repl.node}, a model key is set): \`timmy\` opens it and answers`
    : r.repl.state === 'no-key' ? `  ! REPL: opens, but has no model key to answer with (Node ${r.repl.node}); /setup says how to add one: timmy init, or OPENROUTER_API_KEY`
      : `  ✗ REPL: cannot start here: Node ${r.repl.node}, Timmy needs ${NODE_MAJOR} or later`;
  const lanes = r.lanes.state === 'ready' ? '  ✓ Lanes (optional): ready: their Docker, ComfyUI and CUE checks pass'
    : `  ✗ Lanes (optional): blocked until ${inWords(r.lanes.missing)} pass; the REPL does not need them`;
  const meaning = r.exit === 0 ? 'the REPL is ready.' : r.exit === 78 ? 'the REPL opens, but cannot answer until a model key is set.' : 'the REPL cannot start here.';
  return ['What works here:', repl, lanes,
    `Exit ${r.exit}: ${meaning} The codes: 0 ready, 78 no model key, 1 cannot start. The lanes never change them; \`timmy doctor preflight\` exits 1 while they are blocked.`];
}

// CLI shim: `npx tsx src/utils/doctor.ts preflight` (mission-grade entry)
if (process.argv[1]?.endsWith('doctor.ts') && process.argv[2] === 'preflight') {
  runDoctor().then(r => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  });
}
