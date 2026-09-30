import React from 'react';
import { EventEmitter } from 'node:events';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { useAgent } from '../src/tui/hooks/useAgent.js';
import { useCompanionSync } from '../src/tui/hooks/useCompanionSync.js';
import type { Agent } from '../src/agent/core.js';
import type { Message } from '../src/types/index.js';

const retained: Message[] = [{ role: 'user', content: 'Synthetic retained question', timestamp: 1 }];
function fixture(history: Message[] = retained) {
  return Object.assign(new EventEmitter(), {
    conversation: { getHistory: () => history }, getModel: () => 'fixture/offline',
    totalCost: 0, tmuxSessions: [], send: vi.fn(async () => null),
    clearHistory: vi.fn(), setModel: vi.fn(),
  }) as unknown as Agent & EventEmitter;
}
let state: ReturnType<typeof useAgent>;
let server: Record<string, any>;
let previousServer: unknown;
function Harness({ agent }: { agent: Agent }) {
  state = useAgent(agent);
  useCompanionSync({ agent, messages: state.mirrorHistory });
  return null;
}
async function untilHistory(length: number) {
  await vi.waitFor(() => expect(server.lastHistory).toHaveLength(length));
}
function toolArguments(message: Message): unknown {
  const payload = message.content.split(' with arguments: ')[1];
  expect(payload).toBeDefined();
  return JSON.parse(payload);
}
beforeEach(() => {
  previousServer = (global as any).companionServer;
  server = { sendUpdate: vi.fn() };
  (global as any).companionServer = server;
});
afterEach(() => {
  cleanup();
  (global as any).companionServer = previousServer;
});

describe('retained companion tool history', () => {
  it('keeps one tool row through final synchronization and a later user message', async () => {
    const agent = fixture();
    const view = render(<Harness agent={agent} />);
    await untilHistory(1);
    agent.emit('tool:call', 'synthetic-tool', { target: 'offline fixture' });
    await untilHistory(2);
    expect(server.lastHistory[1]).toMatchObject({ isTool: true });
    expect(server.lastHistory[1].content).toContain('synthetic-tool');
    expect(server.lastHistory[1].content).toContain('offline fixture');
    expect(toolArguments(server.lastHistory[1])).toEqual({ target: 'offline fixture' });
    expect(state.messages).toEqual(retained);
    agent.emit('stream:end', 'Synthetic final answer');
    await untilHistory(3);
    agent.emit('message:user', { role: 'user', content: 'Synthetic next question', timestamp: 2 });
    await untilHistory(4);
    expect(server.lastHistory.filter((message: Message & { isTool?: boolean }) => message.isTool)).toHaveLength(1);
    expect(state.messages.map(message => message.content)).toEqual(['Synthetic retained question', 'Synthetic final answer', 'Synthetic next question']);
    expect(agent.conversation.getHistory()).toEqual(retained);
    expect(agent.send).not.toHaveBeenCalled();
    view.unmount();
  });

  it('clears both histories and current tools without retaining a tool after a new turn', async () => {
    const agent = fixture();
    const view = render(<Harness agent={agent} />);
    await untilHistory(1);
    agent.emit('tool:call', 'synthetic-cleared-tool', {});
    await untilHistory(2);
    state.clearHistory();
    await untilHistory(0);
    expect(state.messages).toEqual([]);
    expect(state.currentTools).toEqual([]);
    expect(agent.clearHistory).toHaveBeenCalledTimes(1);
    agent.emit('message:user', { role: 'user', content: 'Synthetic clean question', timestamp: 3 });
    await untilHistory(1);
    expect(server.lastHistory).toEqual([{ role: 'user', content: 'Synthetic clean question', timestamp: 3 }]);
    view.unmount();
  });

  it('replaces an agent without carrying foreign tools into the new history', async () => {
    const previous = fixture();
    const nextHistory: Message[] = [{ role: 'assistant', content: 'Synthetic replacement history', timestamp: 4 }];
    const next = fixture(nextHistory);
    const view = render(<Harness agent={previous} />);
    await untilHistory(1);
    previous.emit('tool:call', 'synthetic-foreign-tool', {});
    await untilHistory(2);
    view.rerender(<Harness agent={next} />);
    await vi.waitFor(() => expect(server.agent).toBe(next));
    expect(server.lastHistory).toEqual(nextHistory);
    expect(state.messages).toEqual(nextHistory);
    expect(state.currentTools).toEqual([]);
    expect(previous.eventNames()).toEqual([]);
    next.emit('tool:call', 'synthetic-new-tool', {});
    await untilHistory(2);
    expect(server.lastHistory[1].content).toContain('synthetic-new-tool');
    expect(JSON.stringify(server.lastHistory)).not.toContain('synthetic-foreign-tool');
    view.unmount();
  });

  it('retains safe tool markers when arguments are absent or cannot be serialized', async () => {
    const agent = fixture();
    const view = render(<Harness agent={agent} />);
    await untilHistory(1);
    expect(() => agent.emit('tool:call', 'synthetic-no-args')).not.toThrow();
    await untilHistory(2);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => agent.emit('tool:call', 'synthetic-circular-args', circular)).not.toThrow();
    await untilHistory(3);
    expect(server.lastHistory.slice(1).every((message: Message & { isTool?: boolean }) => message.isTool && typeof message.content === 'string')).toBe(true);
    expect(server.lastHistory[1].content).toContain('synthetic-no-args');
    expect(server.lastHistory[2].content).toContain('synthetic-circular-args');
    expect(toolArguments(server.lastHistory[1])).toEqual({ unavailable: 'Tool arguments were not provided' });
    expect(toolArguments(server.lastHistory[2])).toEqual({ unavailable: 'Tool arguments could not be serialized' });
    expect(state.messages).toEqual(retained);
    expect(agent.conversation.getHistory()).toEqual(retained);
    view.unmount();
  });
});
