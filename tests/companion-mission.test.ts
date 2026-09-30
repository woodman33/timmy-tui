import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startManagedLogServer, type LogServerHandle } from '../src/utils/logserver.js';
import { getPlan } from '../src/utils/dispatch.js';
import * as doctor from '../src/utils/doctor.js';

// Companion arming gateway integration: the survey surface compiles and
// emits hash-bound store requests; arming without an operator token is
// denied by the controller; path escapes on theatre state fail closed.
let server: LogServerHandle;
let workspace: string;
const originalCwd = process.cwd();
const up = async (): Promise<number> => server.port;
beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'timmy-companion-'));
  process.chdir(workspace);
  vi.spyOn(doctor, 'dockerReady').mockImplementation(() => { throw new Error('unexpected Docker probe'); });
  server = await startManagedLogServer({ port: 0, host: '127.0.0.1' });
});
afterAll(async () => {
  try { await server?.stop(); }
  finally {
    vi.restoreAllMocks();
    process.chdir(originalCwd);
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  }
});

const DOC = {
  nodes: [
    { id: 'cap', kind: 'capsule', objective: 'companion gateway probe' },
    { id: 'h', kind: 'harness', harness: 'hyperframes', workspace: 'host-ephemeral' as const }
  ],
  edges: [{ from: 'h', to: 'cap', kind: 'harness' }]
};

describe('mission studio gateway (isolated listener)', () => {
  it('serves the studio page', async () => {
    const p = await up();
    const r = await fetch(`http://127.0.0.1:${p}/mission`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('MISSION STUDIO');
    expect(html).toContain('send to controller');
  });

  it('compiles docs and stores plans with immutable hashes', async () => {
    const p = await up();
    const c = await (await fetch(`http://127.0.0.1:${p}/mission/compile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc: DOC }) })).json();
    expect(c.ok).toBe(true);
    expect(c.plans).toHaveLength(1);
    expect(c.plans[0].plan.workspace.kind).toBe('host-ephemeral');
    const s = await (await fetch(`http://127.0.0.1:${p}/mission/store`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plan: c.plans[0].plan }) })).json();
    expect(s.ok).toBe(true);
    expect(s.id).toMatch(/^dp_/);
    expect(s.plan_hash).toMatch(/^[0-9a-f]{16,}$/);
  });

  it('denies arming without an operator token (J-BANG boundary)', async () => {
    const p = await up();
    const c = await (await fetch(`http://127.0.0.1:${p}/mission/compile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ doc: DOC }) })).json();
    const s = await (await fetch(`http://127.0.0.1:${p}/mission/store`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plan: c.plans[0].plan }) })).json();
    expect(s.ok).toBe(true);
    const a = await (await fetch(`http://127.0.0.1:${p}/dispatch/action`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: s.id, action: 'arm', token: 'garbage' }) })).json();
    expect(a.ok).toBe(false);
    expect(a.note).toBe('unknown approval token');
    expect(getPlan(s.id)?.lifecycle).toBe('needs_approval');
    expect(doctor.dockerReady).not.toHaveBeenCalled();
  });

  it('fails closed on theatre-state path escapes', async () => {
    const p = await up();
    const r = await (await fetch(`http://127.0.0.1:${p}/mission/theatre?folder=${encodeURIComponent('../../etc')}`)).json();
    expect(r.sheets).toBeUndefined();
    expect(r.error).toBeTruthy();
  });

  it('returns the assigned port and releases its owned listener on stop', async () => {
    const isolated = await startManagedLogServer({ port: 0, host: '127.0.0.1' });
    try {
      expect(isolated.port).toBeGreaterThan(0);
      expect(isolated.port).not.toBe(server.port);
      const health = await (await fetch(`http://127.0.0.1:${isolated.port}/health`)).json();
      expect(health.port).toBe(isolated.port);
    } finally { await isolated.stop(); }
    await isolated.stop(); // cleanup is safe to call more than once
    await expect(fetch(`http://127.0.0.1:${isolated.port}/health`)).rejects.toThrow();
  });

});
