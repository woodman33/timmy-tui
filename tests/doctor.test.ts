import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'net';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runDoctor, probePort, checkDocker } from '../src/utils/doctor.js';
import { createPlan, armPlan, type DispatchPlan } from '../src/utils/dispatch.js';
import { issueApproval } from '../src/utils/approvals.js';
import { dockerPresent, comfyPresent } from './service-gate.js';

const dockerPlan = (): DispatchPlan => ({
  schema_version: 'dispatch/0.1', objective: 'doctor gate probe', deliverables: ['x'],
  acceptance_tests: ['true'], harnesses: ['openhands'],
  model_policy: { requested: 'local/qwen', allow_paid: false, max_spend_usd: 0 },
  copies: 1, cadence: { mode: 'parallel', depends_on: [] }, context_manifest: [],
  repo_ref: 'main', workspace: { kind: 'docker' },
  permissions: { filesystem: 'rw-ephemeral', network: false, tools: [], secrets: [] },
  limits: { cost_usd: 0, wall_ms: 60000 }, retry_limit: 1,
  approval: { required: true, mode: 'manual' }, expected_artifacts: ['x.md'],
  telemetry: { redact: true, events: true }
});

let dir = '';
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'timmy-doctor-')); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe.skipIf(!(dockerPresent() && comfyPresent()))('timmy doctor preflight tier (v1.0.0-rc1)', () => {
  it('probePort detects listeners and free ports', async () => {
    const srv = createServer();
    await new Promise<void>(res => srv.listen(0, '127.0.0.1', () => res()));
    const port = (srv.address() as { port: number }).port;
    expect(await probePort(port)).toBe(true);
    srv.close();
    expect(await probePort(port)).toBe(false);
  });

  it('runDoctor reports the required audit surface with a consistent ok flag', async () => {
    const rep = await runDoctor();
    const names = rep.checks.map(c => c.name);
    expect(names).toContain('docker daemon');
    expect(names).toContain('comfy-cli');
    expect(names).toContain('comfy venv (filelock+sqlalchemy)');
    expect(names).toContain('cue CLI');
    expect(names).toContain('openscad');
    expect(names.some(n => n.startsWith('port 8188'))).toBe(true);
    expect(names.some(n => n.startsWith('port 4310'))).toBe(true);
    expect(rep.ok).toBe(rep.checks.filter(c => c.required).every(c => c.state === 'ok'));
  });

  it('docker check fails closed when the binary is unreachable', () => {
    const saved = process.env.PATH;
    process.env.PATH = '/nonexistent';
    expect(checkDocker().state).toBe('not_configured');
    process.env.PATH = saved;
  });

  it('containerized arm fails closed on docker-down WITHOUT burning the token', () => {
    const c = createPlan(dockerPlan(), dir);
    expect(c.ok).toBe(true);
    const saved = process.env.PATH;
    process.env.PATH = '/nonexistent';
    const a = armPlan(c.id!, issueApproval(c.plan_hash!).token, dir);
    process.env.PATH = saved;
    expect(a.ok).toBe(false);
    expect(a.note).toContain('docker');
    // token was not consumed: a retry never hits 'approval already used'
    const retry = armPlan(c.id!, issueApproval(c.plan_hash!).token, dir);
    if (checkDocker().state === 'ok') expect(retry.ok).toBe(true);
    else expect(String(retry.note)).not.toContain('already');
  });
});
