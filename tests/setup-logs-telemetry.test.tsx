// R4 (H98, journey-2): "logs: this computer only" is a fact of this version, not an answer. The setup no longer offers "also
// your Cloudflare worker" (it promised a send that never happened where people run: the only sender, the telemetry bridge,
// is mounted in the legacy v1 shell alone). So the bridge sends run events only to an address the operator names for the
// run (TIMMY_TELEMETRY_URL); an edge host configured, even with a setup.json an earlier build wrote ("logs": "cloud"),
// sends nothing. The bridge runs for real in a rendered Ink component; the network is a FAKE fetch that records every
// request.
import React from 'react';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTelemetryBridge } from '../src/tui/hooks/useTelemetryBridge.js';
import { applyInit } from '../src/utils/init.js';
import type { Agent } from '../src/agent/core.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const VARS = ['TIMMY_HOME', 'TIMMY_REPO_ROOT', 'TIMMY_PRIVATE_DIR', 'TIMMY_EDGE_HOST', 'TIMMY_TELEMETRY_URL'] as const;
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

describe('logs and run events stay on this computer unless the operator names an address for the run', () => {
  it('a set-up home with an edge host configured: nothing goes to the worker', async () => {
    applyInit({ operator: 'Sample', project: 'demo' }, join(box, 'repo'));
    expect(await sentAfterOneEvent()).toEqual([]);
  }, 20_000);

  it('a setup.json an earlier build wrote with "logs": "cloud": still nothing (this version offers no such answer)', async () => {
    applyInit({ operator: 'Sample', project: 'demo' }, join(box, 'repo'));
    const file = join(box, 'timmy', 'setup.json');
    const rec = JSON.parse(readFileSync(file, 'utf8')) as { answers: Record<string, unknown> };
    writeFileSync(file, JSON.stringify({ ...rec, answers: { ...rec.answers, logs: 'cloud', edge: 'edge.example.com' } }));
    expect(await sentAfterOneEvent()).toEqual([]);
  }, 20_000);

  it('TIMMY_TELEMETRY_URL names the address for this run: the run event goes there, and only there', async () => {
    applyInit({ operator: 'Sample', project: 'demo' }, join(box, 'repo'));
    // the bridge posts to <TIMMY_TELEMETRY_URL>/telemetry
    process.env.TIMMY_TELEMETRY_URL = 'http://127.0.0.1:9';
    const sent = await sentAfterOneEvent();
    expect(sent.length).toBeGreaterThan(0);
    expect([...new Set(sent)]).toEqual(['http://127.0.0.1:9/telemetry']);
  }, 20_000);
});
