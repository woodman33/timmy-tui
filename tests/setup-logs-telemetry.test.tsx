// R4 (H98): "Logs and run events: this computer only", the setup's preselected answer, is what the monitor's telemetry bridge
// does: with an edge host configured (TIMMY_EDGE_HOST), run events go to the worker only when the setup's answer is the
// worker (cloud), which is opt-in. Before, any configured edge host got them (the old FIRST RUN preselected "sync to your
// worker"). The bridge runs for real in a rendered Ink component; the network is a FAKE fetch that records every request.
import React from 'react';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTelemetryBridge } from '../src/tui/hooks/useTelemetryBridge.js';
import { applyInit } from '../src/utils/init.js';
import type { Agent } from '../src/agent/core.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const VARS = ['TIMMY_HOME', 'TIMMY_REPO_ROOT', 'TIMMY_PRIVATE_DIR', 'TIMMY_EDGE_HOST', 'TIMMY_TELEMETRY_URL', 'XDG_CONFIG_HOME'] as const;
const kept = Object.fromEntries(VARS.map((v) => [v, process.env[v]]));
let box = '';
let cwd = '';
beforeEach(() => {
  box = mkdtempSync(join(tmpdir(), 'setup-logs-'));
  mkdirSync(join(box, 'repo'));
  cwd = process.cwd();
  process.chdir(join(box, 'repo')); // the bridge's own log lines go to <cwd>/logs: this test's folder
  process.env.TIMMY_HOME = join(box, 'timmy');
  process.env.TIMMY_REPO_ROOT = join(box, 'repo');
  process.env.XDG_CONFIG_HOME = join(box, 'config');
  process.env.TIMMY_EDGE_HOST = 'edge.example.com';
  delete process.env.TIMMY_PRIVATE_DIR;
  delete process.env.TIMMY_TELEMETRY_URL;
});
afterEach(() => {
  vi.unstubAllGlobals();
  process.chdir(cwd);
  for (const v of VARS) { if (kept[v] === undefined) delete process.env[v]; else process.env[v] = kept[v]; }
  rmSync(box, { recursive: true, force: true });
});

function Bridge({ agent }: { agent: Agent }) {
  useTelemetryBridge({ agent, mode: 'brief', model: 'test/model', totalCost: 0, config: {} as never, operator: 'Sample', enabled: true });
  return null;
}

/** Renders the bridge, emits one event, waits for its 2-second flush, and returns the addresses the FAKE fetch was asked for. */
async function sentAfterOneEvent(): Promise<string[]> {
  const asked: string[] = [];
  vi.stubGlobal('fetch', async (url: string | URL) => { asked.push(String(url)); return new Response('{}', { status: 200 }); });
  const agent = new EventEmitter() as unknown as Agent;
  const view = render(<Bridge agent={agent} />);
  await sleep(100);
  (agent as unknown as EventEmitter).emit('mode:change', 'brief');
  await sleep(2600);
  view.unmount();
  return asked;
}

describe('the setup\'s logs answer, in the monitor\'s telemetry bridge', () => {
  it('this computer only: nothing goes to the configured worker', async () => {
    applyInit({ operator: 'Sample', project: 'demo' }, join(box, 'repo')); // the preselected answers: logs local
    expect(await sentAfterOneEvent()).toEqual([]);
  }, 20_000);

  it('also your worker (opt-in): the run event goes to the worker', async () => {
    applyInit({ operator: 'Sample', project: 'demo', logs: 'cloud' }, join(box, 'repo'));
    expect(await sentAfterOneEvent()).toContain('https://edge.example.com/telemetry');
  }, 20_000);
});
