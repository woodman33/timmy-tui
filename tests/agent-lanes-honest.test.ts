/**
 * Round R1: a lane's pane and the agent's logs say only what happened. No AgentPass passport, visa or
 * "VERIFIED" scope is shown where AgentPass is not connected (its service lives outside this repo),
 * no storage "SUCCESS" or proof bundle that nothing produced, and no seeded log lines that no run wrote.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { laneStartupScript } from '../src/agent/lanes.js';
import { createAgent } from '../src/agent/core.js';

let dir: string;
let cwd: string;
beforeEach(() => {
  cwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), 'timmy-lanes-'));
  process.chdir(dir);
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

describe('a lane pane\'s first lines', () => {
  it('claim no passport, storage or proof that nothing produced', () => {
    const run = laneStartupScript('pi');
    const script = readFileSync(run.replace(/^bash '(.*)'$/, '$1'), 'utf8');
    for (const invented of ['VERIFIED', 'SUCCESS', 'passport (JTI', 'Visa stamp', 'proof bundle']) expect(script, invented).not.toContain(invented);
    expect(script).toContain('AgentPass: not connected');
    expect(script).toContain('no receipt yet');
  });
});

describe('the agent\'s logs', () => {
  it('start empty: no line that no run wrote', () => {
    const agent = createAgent({ apiKey: 'test-key', model: 'test/model' }, { multiplexer: 'none' }) as unknown as { workspaceContexts: Record<string, string[]>; relayedVmLogs: string[] };
    expect(agent.relayedVmLogs).toEqual([]);
    expect(Object.values(agent.workspaceContexts).flat()).toEqual([]);
  });
});
