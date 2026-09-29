// tui-redesign-p6a3 CUTOVER (ui.cutover-plan C1-C5): v2 shell is the DEFAULT;
// legacy stays behind TIMMY_SHELL=v1 for one release; the root dispatcher's
// nav globals are v1-only (digit-shadowing dead at the root). FIX 3 policy
// seed, STEP 8 chat.turn seal and FIX 1 row budget assert on direct ShellV2
// renders (App-level mounts are probe-slow in CI-less environments).
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import React from 'react';
import { cleanup, render } from 'ink-testing-library';
import { EventEmitter } from 'node:events';
import { App } from '../src/tui/app.js';
import { ShellV2 } from '../src/tui/components/ShellV2.js';
import { readChain } from '../src/utils/receipts.js';
import { readPolicy } from '../src/harness/policy.js';
import { dirname, join } from 'path';
import { createAgent } from '../src/agent/core.js';

// Exercise the real App, dispatcher, both shells and useAgent, while replacing
// host/provider boundaries. Mounting this UI must never start a real lane.
const guards = vi.hoisted(() => ({ launch: vi.fn(), fetch: vi.fn() }));
vi.mock('ink', async importOriginal => ({
  ...await importOriginal<typeof import('ink')>(),
  // ink-testing-library's stream has no rows; align App's viewport with the
  // tall content grid used by the direct-shell assertions below.
  useWindowSize: () => ({ columns: 100, rows: 80 }),
}));
vi.mock('child_process', async importOriginal => ({
  ...await importOriginal<typeof import('child_process')>(),
  spawnSync: vi.fn(() => ({ status: 1, stdout: '', stderr: '' })),
  execSync: vi.fn(() => ''),
  execFileSync: vi.fn(() => { throw new Error('host probe unavailable in cutover fixture'); }),
  spawn: (...args: unknown[]) => { guards.launch(...args); throw new Error('unexpected subprocess in cutover test'); },
  exec: (...args: unknown[]) => { guards.launch(...args); throw new Error('unexpected subprocess in cutover test'); },
  execFile: (...args: unknown[]) => { guards.launch(...args); throw new Error('unexpected subprocess in cutover test'); },
  fork: (...args: unknown[]) => { guards.launch(...args); throw new Error('unexpected subprocess in cutover test'); },
}));
vi.mock('../src/agent/core.js', async () => {
  const { EventEmitter } = await import('node:events');
  return { createAgent: vi.fn(() => {
    const agent = new EventEmitter() as EventEmitter & Record<string, any>;
    agent.totalCost = 0;
    agent.getModel = () => 'fixture/sovereign';
    agent.conversation = { getHistory: () => [] };
    agent.runStartupHealthCheck = vi.fn();
    agent.clearHistory = vi.fn();
    agent.setModel = vi.fn();
    agent.send = vi.fn(async (text: string) => {
      agent.emit('message:user', { role: 'user', content: text });
      agent.totalCost += 0.125;
      agent.emit('cost:update', 0.125, agent.totalCost);
      agent.emit('stream:end', 'Synthetic cutover response');
      return 'Synthetic cutover response';
    });
    return agent;
  }) };
});
vi.mock('../src/tui/hooks/useTelemetryBridge.js', () => ({ useTelemetryBridge: () => ({ telemetryStatus: 'off', queuedTelemetryCount: 0 }) }));
vi.mock('../src/tui/hooks/useCompanionSync.js', () => ({ useCompanionSync: () => undefined }));
vi.mock('../src/tui/hooks/useModeAgentConfig.js', () => ({ useModeAgentConfig: () => undefined }));
vi.mock('../src/tui/hooks/useTerminalCapabilities.js', () => ({ useTerminalCapabilities: () => ({ capabilities: null, detected: true }) }));
vi.mock('../src/tui/hooks/useGraphicsPipeline.js', () => ({ useGraphicsPipeline: () => ({ pipeline: null }) }));
vi.mock('../src/harness/commander.js', () => ({
  edgeToken: () => null,
  CommanderClient: class { online = false; connect() {} close() {} send() { throw new Error('unexpected commander send'); } },
}));
vi.mock('../src/harness/cockpit.js', async importOriginal => ({ ...await importOriginal<object>(), loadBoard: () => null }));
vi.mock('../src/harness/warroom.js', async importOriginal => ({ ...await importOriginal<object>(), panes: () => [] }));
vi.mock('../src/harness/warroom2.js', async importOriginal => ({
  ...await importOriginal<object>(), swarmPresets: () => [], swarmRuns: () => [],
  nodeStats: () => [], sbxRuns: () => [], dockerPorts: () => ({}), abilities: () => [], projects: () => [],
}));
vi.mock('../src/harness/uinext.js', async importOriginal => ({ ...await importOriginal<object>(), signalState: () => null, modelStrictness: () => [] }));
vi.mock('../src/utils/starter.js', () => ({ seedStarter: () => undefined }));
vi.mock('../src/utils/envlock.js', async importOriginal => ({
  ...await importOriginal<object>(),
  captureEnvLock: () => ({ os: { platform: 'fixture', build: 'cutover-test' }, arch: 'fixture', tools: {}, models: {} }),
}));
vi.mock('../src/utils/projects.js', async importOriginal => ({ ...await importOriginal<object>(), listProjects: () => [] }));
vi.mock('../src/utils/templates.js', async importOriginal => ({ ...await importOriginal<object>(), listTemplates: () => [] }));
vi.mock('../src/utils/dispatch.js', async importOriginal => ({
  ...await importOriginal<object>(), listPlans: () => [],
  listLanes: () => ['webcontainers', 'anythingllm', 'houdini-mcp', 'hyperframes'].map((id, i) => ({ id, label: id, available: i === 0 })),
}));
vi.mock('../src/models/registry.js', async importOriginal => ({
  ...await importOriginal<object>(),
  listModelsSync: () => [{ id: 'qwen/qwen3-coder', role: 'coding', pinned: true, ctx: 128000,
    price_in: 0.000001, price_out: 0.000002, supported_parameters: ['tools', 'reasoning'], spend_usd: 0 }],
}));

beforeEach(() => {
  vi.stubEnv('TIMMY_SHELL', undefined);
  vi.stubEnv('TIMMY_DISABLE_ANIMATION', '1');
  guards.launch.mockClear();
  guards.fetch.mockReset().mockRejectedValue(new Error('network forbidden in cutover test'));
  vi.stubGlobal('fetch', guards.fetch);
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  expect(guards.launch).not.toHaveBeenCalled();
  expect(guards.fetch).not.toHaveBeenCalled();
});

process.env.TIMMY_TELEMETRY_URL = 'off';

// ui-cockpit-k7m3 C5: rows are bounded now. This file checks content across the
// WHOLE LIBRARY rail (every fleet id, every demo family), which only fit a frame
// that overflowed the terminal; it pins a tall grid so the rail need not fold.
// The reference grids (80x24 · 120x40) are covered by tests/bounded-rows.test.tsx.
Object.defineProperty(process.stdout, 'rows', { value: 80, configurable: true });
delete process.env.TIMMY_SHELL; // default = v2 after cutover
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(view: ReturnType<typeof render>, pred: (f: string) => boolean, ms = 3000): Promise<string> {
  const t0 = Date.now();
  for (;;) {
    const f = view.lastFrame() ?? '';
    if (pred(f)) return f;
    if (Date.now() - t0 > ms) throw new Error(`UI did not reach expected state:\n${view.frames.join('\n')}`);
    await sleep(50);
  }
}

describe('cutover: v2 default vs v1 legacy at the root', { timeout: 150000 }, () => {
  it('default env renders the v2 shell and digits switch tabs at the root', async () => {
    const view = render(React.createElement(App, { config: { onboarded: true } as never }));
    let f = await until(view, x => x.includes('YOUR JOURNEY'));
    expect(f).toContain('YOUR JOURNEY');
    expect(f).not.toContain('MODE:NAV'); // legacy footer gone by default
    view.stdin.write('3');
    f = await until(view, x => x.includes('RECEIPTS'));
    expect(f).toContain('RECEIPTS');
    view.unmount();
  }, 140000);

  it('TIMMY_SHELL=v1 keeps the legacy nine-view shell for one release', async () => {
    process.env.TIMMY_SHELL = 'v1';
    const view = render(React.createElement(App, { config: { onboarded: true } as never }));
    const f = await until(view, x => x.includes('MODE:NAV'));
    expect(f).toContain('MODE:NAV');
    view.stdin.write('2');
    const f2 = await until(view, x => x.includes('SLATE DAG'));
    expect(f2).toContain('SLATE DAG');
    view.unmount();
    delete process.env.TIMMY_SHELL;
  }, 140000);
});

describe('cutover companions on the shell directly', { timeout: 60000 }, () => {
  it('FIX 3: first run seeds the policy default and seals model.policy', async () => {
    const view = render(React.createElement(ShellV2, { width: 120 }));
    await until(view, x => x.includes('YOUR JOURNEY'));
    const pdir = dirname(process.env.TIMMY_STORE as string);
    const t0 = Date.now();
    while (!readPolicy(pdir).default && Date.now() - t0 < 10000) await sleep(100);
    expect(readPolicy(pdir).default).toBeTruthy();
    expect(readChain('runs').some(r => String(r.subject).startsWith('model.policy'))).toBe(true);
    view.unmount();
  });

  it('STEP 8: chat drawer opens with [c]; Enter seals chat.turn with model + cost', async () => {
    const agent = createAgent({} as never);
    const view = render(React.createElement(ShellV2, { width: 120, agent }));
    await until(view, x => x.includes('YOUR JOURNEY'));
    view.stdin.write('c');
    const f = await until(view, x => x.includes('SOVEREIGN CHAT'));
    expect(f).toContain('sovereign ·'); // footer names the policy model
    view.stdin.write('hello world');
    view.stdin.write('\r');
    const t1 = Date.now();
    let turn;
    while (!(turn = readChain('runs').find(r => r.kind === 'chat')) && Date.now() - t1 < 10000) await sleep(100);
    expect(turn).toBeTruthy();
    expect(String(turn?.subject)).toContain('chat.turn ·');
    expect(typeof turn?.cost_usd).toBe('number');
    expect(turn?.cost_usd).toBe(0.125);
    expect(turn?.model_resolved).toBe('fixture/sovereign');
    expect(agent.send).toHaveBeenCalledExactlyOnceWith('hello world');
    view.unmount();
  });

  it('FIX 1: MODELS rows carry no ellipsis and fit the 74-col column', async () => {
    const view = render(React.createElement(ShellV2, { width: 120 }));
    await until(view, x => x.includes('YOUR JOURNEY'));
    view.stdin.write('4');
    const f = await until(view, x => x.includes('◇ MODELS'));
    const rows = f.split('\n').filter(l => l.includes('$') && l.trimStart().startsWith('│')
      && !l.includes('notes:') && !l.includes('[Enter]'))
      .map(l => l.slice(0, 74)); // left column only; the rail fuses onto the line
    expect(rows.length).toBeGreaterThan(0);
    for (const ln of rows) {
      expect(ln, `ellipsis in cell: ${ln}`).not.toContain('…');
      expect(ln.trimEnd().length, `row over column: ${ln}`).toBeLessThanOrEqual(74);
    }
    // FLEET rail routes carry the (policy)/(harness) suffix without ellipsis
    expect(f).toContain('(policy)');
    expect(f.split('\n').filter(l => l.includes('(policy)')).every(l => !l.includes('…'))).toBe(true);
    // FIX 2 (close): fleet ids are never cut mid-token — full ids present
    for (const id of ['webcontainers', 'anythingllm', 'houdini-mcp', 'hyperframes']) {
      expect(f, `fleet id cut: ${id}`).toContain(id);
    }
    expect(f.split('\n').filter(l => l.includes('■') || l.includes('□')).every(l => !l.includes('…'))).toBe(true);
    // FIX 1+3 (close): catalog-listed models carry ctx + $in/$out + caps, not dashes
    const qwen = f.split('\n').find(l => l.includes('qwen/qwen3-coder'));
    expect(qwen).toBeTruthy();
    expect(qwen, `qwen row still dashed: ${qwen}`).not.toContain('—/—');
    expect(qwen).toMatch(/\d+k/);
    expect(qwen).toMatch(/[T·][V·][R·]/);
    view.unmount();
  });
});
