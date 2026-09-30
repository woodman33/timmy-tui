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

export async function runDoctor(): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [checkDocker(), checkComfyCli(), checkComfyVenv(), checkCue(), checkOpenscad(), checkTmux()];
  const comfyUp = await probePort(8188);
  checks.push({ name: 'port 8188 (ComfyUI)', required: false, state: comfyUp ? 'ok' : 'warn', note: comfyUp ? 'listener up' : 'no listener — comfy launch --background' });
  const logsUp = await probePort(Number(process.env.TIMMY_LOGS_PORT ?? 4310));
  checks.push({ name: 'port 4310 (companion)', required: false, state: 'ok', note: logsUp ? 'companion live' : 'free — binds on start' });
  return { ok: checks.filter(c => c.required).every(c => c.state === 'ok'), checks };
}

// CLI shim: `npx tsx src/utils/doctor.ts preflight` (mission-grade entry)
if (process.argv[1]?.endsWith('doctor.ts') && process.argv[2] === 'preflight') {
  runDoctor().then(r => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  });
}
