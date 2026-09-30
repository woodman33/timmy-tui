import React from 'react';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import type { Agent } from '../src/agent/core.js';
import type { AgentConfig, Message } from '../src/types/index.js';
import { createAgent } from '../src/agent/core.js';
import { useCompanionSync } from '../src/tui/hooks/useCompanionSync.js';
import { ViewStage } from '../src/tui/views.js';
import { App } from '../src/tui/app.js';

vi.mock('../src/agent/core.js', () => ({ createAgent: vi.fn() }));
vi.mock('child_process', async original => ({ ...await original<typeof import('child_process')>(),
  spawnSync: vi.fn(() => ({ status: 1, stdout: '', stderr: '' })),
  spawn: vi.fn(() => { throw new Error('Unexpected subprocess in companion owner fixture'); }),
}));
vi.mock('../src/harness/commander.js', () => ({
  edgeToken: () => null,
  CommanderClient: class { online = false; connect() {} close() {} send() { throw new Error('Unexpected commander send'); } },
}));
vi.mock('../src/utils/dispatch.js', async original => ({ ...await original<object>(), listLanes: () => [] }));
vi.mock('../src/models/registry.js', async original => ({ ...await original<object>(), listModelsSync: () => [], readNotes: () => '', notesPath: () => 'unused' }));
vi.mock('../src/bus/index.js', () => ({ subscribe: () => ({ stop() {} }), publish: () => {} }));
vi.mock('../src/harness/cockpit.js', async original => ({ ...await original<object>(), loadBoard: () => null }));
vi.mock('../src/harness/uinext.js', async original => ({ ...await original<object>(), signalState: () => null, modelStrictness: () => [] }));
vi.mock('../src/tui/hooks/useTerminalCapabilities.js', () => ({ useTerminalCapabilities: () => ({ capabilities: null }) }));
vi.mock('../src/tui/hooks/useGraphicsPipeline.js', () => ({ useGraphicsPipeline: () => ({ pipeline: null }) }));
vi.mock('../src/tui/hooks/useTelemetryBridge.js', () => ({ useTelemetryBridge: () => ({ telemetryStatus: 'offline', queuedTelemetryCount: 0 }) }));
vi.mock('../src/tui/hooks/useModeAgentConfig.js', () => ({ useModeAgentConfig: () => {} }));
vi.mock('../src/utils/logger.js', () => ({ agentLogger: { info() {}, warn() {}, error() {}, debug() {} }, tuiLogger: { info() {}, warn() {}, error() {}, debug() {} } }));

const history: Message[] = [{ role: 'user', content: 'Synthetic ownership check', timestamp: 1 }];
function fixtureAgent() {
  return Object.assign(new EventEmitter(), {
    getModel: () => 'fixture/offline', conversation: { getHistory: () => history },
    tmuxSessions: [], totalCost: 0, send: vi.fn(async () => null),
    clearHistory: vi.fn(), setModel: vi.fn(),
  }) as unknown as Agent & EventEmitter;
}

function ParentOwner({ agent, child }: { agent: Agent; child: boolean }) {
  useCompanionSync({ agent, messages: history, activeRunId: 'run_synthetic_owner', activeReceiptUrl: 'about:blank#synthetic-receipt' });
  return child ? <ViewStage view={0} paneFocus={0} agent={agent} setInspector={() => {}} companionSync={false} /> : null;
}
let server: Record<string, any>;
let originalServer: unknown;
beforeEach(() => {
  originalServer = (global as any).companionServer;
  server = { sendUpdate: vi.fn() };
  (global as any).companionServer = server;
  vi.stubEnv('TIMMY_PRIVATE_DIR', process.env.TIMMY_POLICY_DIR);
  vi.stubEnv('TIMMY_SIGNAL_DIR', `${process.env.TIMMY_POLICY_DIR}/absent-signal`);
  vi.stubEnv('TIMMY_SHELL', 'v2');
});
afterEach(() => {
  cleanup();
  (global as any).companionServer = originalServer;
  vi.unstubAllEnvs();
});

function assertSingleEvents(agent: Agent & EventEmitter) {
  server.sendUpdate.mockClear();
  agent.emit('stream:delta', 'Synthetic delta', 'Synthetic full text');
  agent.emit('tool:call', 'synthetic_tool', { offline: true });
  const calls = server.sendUpdate.mock.calls;
  expect(calls.filter(([kind]: [string]) => kind === 'agent:delta')).toHaveLength(1);
  expect(calls.filter(([kind]: [string]) => kind === 'agent:tool')).toHaveLength(1);
}

describe('one companion owner across App and the default ViewStage shell', () => {
  it('the actual full App emits one delta/tool update and retains its run metadata', async () => {
    const agent = fixtureAgent();
    vi.mocked(createAgent).mockReturnValue(agent);
    const view = render(<App config={{ onboarded: true } as unknown as AgentConfig} />);
    await vi.waitFor(() => expect(server.agent).toBe(agent));
    agent.emit('telemetry:run', { runId: 'run_synthetic_app', receiptUrl: 'about:blank#app-receipt' });
    await vi.waitFor(() => expect(server.activeRunId).toBe('run_synthetic_app'));
    assertSingleEvents(agent);
    expect(server.activeReceiptUrl).toBe('about:blank#app-receipt');
    view.unmount();
    await vi.waitFor(() => expect(server.agent).toBeUndefined());
  });

  it('a child ViewStage mount/unmount cannot duplicate updates or clear parent metadata', async () => {
    const agent = fixtureAgent();
    const view = render(<ParentOwner agent={agent} child={false} />);
    await vi.waitFor(() => expect(server.activeRunId).toBe('run_synthetic_owner'));
    view.rerender(<ParentOwner agent={agent} child />);
    await vi.waitFor(() => expect(view.lastFrame()).toContain('TIMMY'));
    assertSingleEvents(agent);
    expect(server.activeRunId).toBe('run_synthetic_owner');
    expect(server.activeReceiptUrl).toBe('about:blank#synthetic-receipt');
    view.rerender(<ParentOwner agent={agent} child={false} />);
    await vi.waitFor(() => expect(agent.listenerCount('stream:delta')).toBe(1));
    expect(server.agent).toBe(agent);
    expect(server.activeRunId).toBe('run_synthetic_owner');
    expect(server.activeReceiptUrl).toBe('about:blank#synthetic-receipt');
    assertSingleEvents(agent);
    view.unmount();
    await vi.waitFor(() => expect(server.agent).toBeUndefined());
  });

  it('a standalone ViewStage still owns and publishes its companion updates', async () => {
    const agent = fixtureAgent();
    const view = render(<ViewStage view={0} paneFocus={0} agent={agent} setInspector={() => {}} />);
    await vi.waitFor(() => expect(server.agent).toBe(agent));
    assertSingleEvents(agent);
    view.unmount();
    await vi.waitFor(() => expect(server.agent).toBeUndefined());
  });
});
