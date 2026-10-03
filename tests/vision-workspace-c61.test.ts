import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVisionApp } from '../src/vision/server.js';
import { workspaceToolIds, type StatusDependencies } from '../src/vision/workspace-status.js';

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
  dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
});
async function route(deps: StatusDependencies) {
  const dir = mkdtempSync(join(tmpdir(), 'timmy-c61-route-')); dirs.push(dir);
  const server = createServer(createVisionApp(dir, { workspaceStatus: deps })); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  const response = await fetch(`http://127.0.0.1:${address.port}/api/vision/workspace`);
  expect(response.status).toBe(200);
  return response.json();
}
const fixed = () => new Date('2026-10-01T12:00:00.000Z');
const valid = () => ({ state: 'available_unchecked' });
const baselineDeps = () => ({ now: fixed, probeTimeoutMs: 5, probes: Object.fromEntries(workspaceToolIds.map(id => [id, valid])) });
describe('C6.1 workspace HTTP boundary', () => {
  it('retains the five schema-valid cards on the actual route', async () => {
    const result = await route(baselineDeps());
    expect(result.tools.map((tool: any) => tool.id)).toEqual([...workspaceToolIds]);
    expect(result.checkedAt).toBe(fixed().toISOString());
  });
  it.each(workspaceToolIds)('isolates %s at the HTTP boundary without leaking refusal details', async id => {
    const baseline = await route(baselineDeps());
    const sentinel = 'synthetic-secret-\"/c61-relative';
    const deps = baselineDeps(); deps.probes[id] = () => { throw new Error(sentinel); };
    const failed = await route(deps);
    expect(failed.tools.map((tool: any) => tool.id)).toEqual([...workspaceToolIds]);
    for (const other of workspaceToolIds.filter(other => other !== id)) {
      expect(JSON.stringify(failed.tools.find((tool: any) => tool.id === other))).toBe(JSON.stringify(baseline.tools.find((tool: any) => tool.id === other)));
    }
    expect(failed.tools.find((tool: any) => tool.id === id).state).toBe('not_configured');
    expect(JSON.stringify(failed)).not.toContain(sentinel);
    expect(JSON.stringify(failed)).not.toContain(JSON.stringify(sentinel).slice(1, -1));
  });
});
