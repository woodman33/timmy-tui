// Legacy synchronous Roboflow route. New vision jobs use the async runtime;
// keeping this call synchronous preserves its existing CLI/MCP caller contract.
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { appendReceipt } from './receipts.js';
import { publish as appendEvent } from '../bus/index.js';
import { visionAsset } from '../vision/config.js';
import { redactVisionValue } from '../vision/runtime.js';

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

type RoboflowResult = { ok: boolean; state?: string; note?: string; [key: string]: unknown };
const isFile = (path: string) => {
  try { return existsSync(path) && statSync(path).isFile(); } catch { return false; }
};

export function roboflowRun(req: RoboflowReq, dir?: string): RoboflowResult {
  const cwd = dir ?? process.cwd();
  const env = { ...process.env };
  const refuse = (state: string, note: string): RoboflowResult => {
    const rec = appendReceipt('runs', { kind: 'run', subject: `roboflow ${req.action} ${state}`, policy: 'auto', status: 'failed', error_class: state, discrepancies: [note], spans: [], artifacts: [] }, cwd);
    return { ok: false, state, note, receipt: rec.hash };
  };
  const bridge = visionAsset('scripts/roboflow-bridge.py', cwd);
  if (!isFile(bridge)) return refuse('not_available', 'The Roboflow bridge is missing from this Timmy installation. Install a build that includes scripts/roboflow-bridge.py.');
  if (!env.ROBOFLOW_API_KEY) return refuse('not_configured', 'ROBOFLOW_API_KEY is missing. Configure your Roboflow workspace key.');

  // The project's venv wins; TIMMY_VISION_PYTHON (the OpenCV Python, by VoxVision's setup words) stands in only when the
  // project has no venv: the same order as roboflowReady in src/vox/tools.ts (R11 lead).
  const candidates = [join(cwd, '.timmy', 'venv-vision', 'bin', 'python'), join(cwd, '.timmy', 'venv-roboflow', 'bin', 'python')];
  const venv = candidates.find(isFile);
  const override = env.TIMMY_VISION_PYTHON;
  if (!venv && override !== undefined && (!isAbsolute(override) || !isFile(override))) {
    return refuse('not_configured', 'TIMMY_VISION_PYTHON must name an existing absolute Python executable.');
  }
  const python = venv ?? override;
  if (!python) return refuse('not_configured', 'Choose a vision Python environment with TIMMY_VISION_PYTHON, or configure the project vision environment.');

  const child = spawnSync(python, [bridge], {
    input: JSON.stringify(req), encoding: 'utf8', timeout: 300000,
    maxBuffer: 8 * 1024 * 1024, env, cwd,
  });
  // Never relay stderr or spawn exception messages: SDK diagnostics can contain keys.
  let out: RoboflowResult = { ok: false, state: 'execution_error', note: 'The Roboflow bridge did not return a valid response.' };
  if (child.error) {
    out = { ok: false, state: child.error.message?.includes('ETIMEDOUT') ? 'timeout' : 'execution_error', note: 'The configured Roboflow bridge could not complete. Check the local runtime.' };
  } else {
    try {
      const parsed: unknown = JSON.parse(child.stdout ?? '');
      if (parsed && typeof parsed === 'object' && typeof (parsed as RoboflowResult).ok === 'boolean') {
        out = redactVisionValue(parsed, env) as RoboflowResult;
        if (child.status !== 0 && out.ok) out = { ok: false, state: 'execution_error', note: 'The Roboflow bridge exited unsuccessfully.' };
      }
    } catch { /* retain the structured refusal, never raw process output */ }
  }
  appendReceipt('runs', {
    kind: 'run', subject: `roboflow ${req.action} · ${req.project}`, policy: 'auto',
    status: out.ok ? 'ok' : 'failed',
    ...(out.ok ? {} : { error_class: out.state === 'not_configured' ? 'not_configured' : 'exec' }),
    spans: [{ name: `roboflow.${req.action}`, kind: 'execute_tool' }],
    artifacts: req.path ? [req.path] : req.video ? [req.video] : [],
  }, cwd);
  appendEvent(out.ok ? 'roboflow.done' : 'roboflow.failed', { action: req.action, project: req.project }, cwd);
  return out;
}
