// TIMMY roboflow lane — perception + observer evidence, key-gated.
// SDK runs in the project-local venv (.timmy/venv-roboflow); every use is
// logged + receipted. Without ROBOFLOW_API_KEY: honest not_configured.
import { existsSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { appendReceipt } from './receipts.js';
import { publish as appendEvent } from '../bus/index.js';

export interface RoboflowReq {
  action: 'upload' | 'detect' | 'sample';
  project: string;
  path?: string;
  video?: string;
  frames?: number;
  every?: number;
  version?: number;
  confidence?: number;
  workspace?: string;
}

export function roboflowRun(req: RoboflowReq, dir?: string): { ok: boolean; state?: string; note?: string; [k: string]: unknown } {
  const cwd = dir ?? process.cwd();
  const key = process.env.ROBOFLOW_API_KEY ?? '';
  const modernPython = join(cwd, '.timmy', 'venv-vision', 'bin', 'python');
  const venvPy = existsSync(modernPython) ? modernPython : join(cwd, '.timmy', 'venv-roboflow', 'bin', 'python');
  if (!key) {
    const rec = appendReceipt('runs', { kind: 'run', subject: `roboflow ${req.action} not_configured`, policy: 'auto', status: 'failed', error_class: 'not_configured', discrepancies: ['ROBOFLOW_API_KEY missing'], spans: [], artifacts: [] }, cwd);
    return { ok: false, state: 'not_configured', note: 'ROBOFLOW_API_KEY missing (console.roboflow.com)', receipt: rec.hash };
  }
  if (!existsSync(venvPy)) {
    const rec = appendReceipt('runs', { kind: 'run', subject: `roboflow ${req.action} not_configured`, policy: 'auto', status: 'failed', error_class: 'not_configured', discrepancies: ['venv missing: python3 -m venv .timmy/venv-roboflow && pip install roboflow'], spans: [], artifacts: [] }, cwd);
    return { ok: false, state: 'not_configured', note: 'roboflow venv missing', receipt: rec.hash };
  }
  const bridge = join(cwd, 'scripts', 'roboflow-bridge.py');
  const r = spawnSync(venvPy, [bridge], {
    input: JSON.stringify(req), encoding: 'utf8', timeout: 300000,
    env: { ...process.env, ROBOFLOW_API_KEY: key }
  });
  let out: any = { ok: false, note: (r.stderr ?? '').slice(0, 300) };
  try { out = JSON.parse(r.stdout ?? ''); } catch { /* keep fallback */ }
  appendReceipt('runs', {
    kind: 'run', subject: `roboflow ${req.action} · ${req.project}`, policy: 'auto',
    status: out.ok ? 'ok' : 'failed',
    ...(out.ok ? {} : { error_class: (out.state === 'not_configured' ? 'not_configured' : 'exec') as string }),
    spans: [{ name: `roboflow.${req.action}`, kind: 'execute_tool' }],
    artifacts: req.path ? [req.path] : req.video ? [req.video] : []
  }, cwd);
  appendEvent(out.ok ? 'roboflow.done' : 'roboflow.failed', { action: req.action, project: req.project }, cwd);
  return out;
}
