import React from 'react';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import type { Agent } from '../src/agent/core.js';
import type { Message } from '../src/types/index.js';
import { useCompanionSync } from '../src/tui/hooks/useCompanionSync.js';
import { createAgent } from '../src/agent/core.js';

vi.mock('../src/agent/core.js', () => ({ createAgent: vi.fn(() => {
  const agent = fixtureAgent();
  agent.send = vi.fn(async (text: string) => {
    agent.emit('message:user', { role: 'user', content: text, timestamp: 2 });
    agent.emit('stream:delta', 'reply', 'Synthetic first reply');
    agent.emit('stream:end', 'Synthetic first reply');
    return null;
  });
  return agent;
}) }));

vi.mock('child_process', async original => ({ ...await original<typeof import('child_process')>(),
  spawnSync: vi.fn(() => ({ status: 1, stdout: '', stderr: '' })),
  spawn: vi.fn(() => { throw new Error('Unexpected subprocess in companion fixture'); }),
}));
vi.mock('../src/harness/commander.js', () => ({
  edgeToken: () => null,
  CommanderClient: class { online = false; connect() {} close() {} send() { throw new Error('Unexpected commander send'); } },
}));
vi.mock('../src/utils/dispatch.js', () => ({ listLanes: () => [] }));
vi.mock('../src/models/registry.js', () => ({ listModelsSync: () => [], readNotes: () => '', notesPath: () => 'unused' }));
vi.mock('../src/bus/index.js', () => ({ subscribe: () => ({ stop() {} }), publish: () => {} }));
vi.mock('../src/harness/cockpit.js', async original => ({ ...await original<object>(), loadBoard: () => null }));
vi.mock('../src/harness/uinext.js', async original => ({ ...await original<object>(), signalState: () => null, modelStrictness: () => [] }));
import { ShellV2 } from '../src/tui/components/ShellV2.js';

const history: Message[] = [{ role: 'user', content: 'Synthetic local question', timestamp: 1 }];
const tick = () => new Promise(resolve => setTimeout(resolve, 30));
function fixtureAgent() {
  return Object.assign(new EventEmitter(), {
    getModel: () => 'fixture/offline', conversation: { getHistory: () => history },
    tmuxSessions: [{ id: 'synthetic-session' }], totalCost: 0,
    send: vi.fn(async () => null), clearHistory: vi.fn(), setModel: vi.fn(),
  }) as unknown as Agent & EventEmitter;
}
function Harness(props: Parameters<typeof useCompanionSync>[0]) {
  useCompanionSync(props);
  return null;
}
let server: Record<string, any>;
let originalServer: unknown;
beforeEach(() => {
  originalServer = (global as any).companionServer;
  server = { sendUpdate: vi.fn() };
  (global as any).companionServer = server;
  vi.stubEnv('TIMMY_PRIVATE_DIR', process.env.TIMMY_POLICY_DIR);
  vi.stubEnv('TIMMY_SIGNAL_DIR', `${process.env.TIMMY_POLICY_DIR}/absent-signal`);
});
afterEach(() => {
  cleanup();
  (global as any).companionServer = originalServer;
  vi.unstubAllEnvs();
});

describe('companion synchronization lifecycle', () => {
  it('publishes nothing while disabled, then catches up when enabled without a history change', async () => {
    const agent = fixtureAgent();
    const view = render(<Harness agent={agent} messages={history} enabled={false} />);
    await tick();
    agent.emit('stream:delta', 'ignored', 'ignored');
    expect(server.sendUpdate).not.toHaveBeenCalled();
    expect(agent.eventNames()).toEqual([]);
    expect(server.agent).toBeUndefined();
    view.rerender(<Harness agent={agent} messages={history} enabled />);
    await tick();
    expect(server.agent).toBe(agent);
    expect(server.lastHistory).toBe(history);
    expect(server.sendUpdate).toHaveBeenCalledWith('sync', history);
    expect(server.lastTmux).toBe(agent.tmuxSessions);
    view.rerender(<Harness agent={agent} messages={history} enabled={false} />);
    await tick();
    expect(agent.eventNames()).toEqual([]);
    expect(server.agent).toBeUndefined();
    server.sendUpdate.mockClear();
    agent.emit('stream:delta', 'ignored', 'ignored');
    expect(server.sendUpdate).not.toHaveBeenCalled();
  });

  it('forwards each live delta once, removes old listeners on replacement and unmount', async () => {
    const agent = fixtureAgent();
    const next = fixtureAgent();
    const view = render(<Harness agent={agent} messages={history} />);
    await tick();
    agent.emit('stream:delta', 'chunk', 'Synthetic chunk');
    expect(server.sendUpdate).toHaveBeenCalledWith('agent:delta', { delta: 'chunk', fullText: 'Synthetic chunk' });
    expect(agent.listenerCount('stream:delta')).toBe(1);
    view.rerender(<Harness agent={next} messages={history} />);
    await tick();
    expect(agent.eventNames()).toEqual([]);
    expect(next.listenerCount('stream:delta')).toBe(1);
    expect(server.agent).toBe(next);
    view.unmount();
    await tick();
    expect(next.eventNames()).toEqual([]);
    expect(server.agent).toBeUndefined();
  });

  it('tolerates an absent or closed server and keeps another owner during cleanup', async () => {
    const agent = fixtureAgent();
    delete (global as any).companionServer;
    const view = render(<Harness agent={agent} messages={history} />);
    await tick();
    expect(() => agent.emit('stream:delta', 'chunk', 'Synthetic chunk')).not.toThrow();
    (global as any).companionServer = server;
    server.sendUpdate.mockImplementation(() => { throw new Error('synthetic closed socket'); });
    expect(() => agent.emit('stream:delta', 'chunk', 'Synthetic chunk')).not.toThrow();
    server.agent = 'another owner';
    view.unmount();
    await tick();
    expect(server.agent).toBe('another owner');
    expect(agent.eventNames()).toEqual([]);
  });

  it('mirrors the actual default ShellV2 history, streaming delta and final reply', async () => {
    const agent = fixtureAgent();
    const view = render(<ShellV2 width={120} agent={agent} />);
    await tick();
    expect(server.agent).toBe(agent);
    expect(server.lastHistory[0].content).toBe('Synthetic local question');
    agent.emit('stream:delta', 'answer', 'Synthetic local answer');
    expect(server.sendUpdate).toHaveBeenCalledWith('agent:delta', { delta: 'answer', fullText: 'Synthetic local answer' });
    agent.emit('stream:end', 'Synthetic local answer');
    for (let attempt = 0; attempt < 50 && server.lastHistory.length < 2; attempt++) await tick();
    expect(server.lastHistory.map((m: Message) => m.content)).toEqual(['Synthetic local question', 'Synthetic local answer']);
    expect(agent.send).not.toHaveBeenCalled();
    view.unmount();
    await tick();
    expect(agent.eventNames()).toEqual([]);
    expect(server.agent).toBeUndefined();
  });

  it('does not expose the default shell NOOP agent or overwrite retained history', async () => {
    server.lastHistory = history;
    const view = render(<ShellV2 width={120} />);
    await tick();
    expect(server.agent).toBeUndefined();
    expect(server.lastHistory).toBe(history);
    expect(server.sendUpdate).not.toHaveBeenCalled();
    view.unmount();
  });

  it('attaches listeners before the lazy agent emits its first user message and reply', async () => {
    const view = render(<ShellV2 width={120} config={{ onboarded: true }} />);
    await vi.waitFor(() => expect(view.lastFrame()).toContain('YOUR JOURNEY'));
    view.stdin.write('c');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('SOVEREIGN CHAT'));
    view.stdin.write('Synthetic first request');
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Synthetic first request'));
    view.stdin.write('\r');
    await vi.waitFor(() => expect(server.lastHistory?.map((m: Message) => m.content)).toEqual(['Synthetic first request', 'Synthetic first reply']));
    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(server.agent.send).toHaveBeenCalledExactlyOnceWith('Synthetic first request');
    expect(server.sendUpdate).toHaveBeenCalledWith('agent:delta', { delta: 'reply', fullText: 'Synthetic first reply' });
    view.unmount();
    await tick();
    expect(server.agent).toBeUndefined();
  });
});
