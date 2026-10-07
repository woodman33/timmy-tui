import { EventEmitter } from 'node:events';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bridgeAgent } from '../src/repl/agent-bridge.js';
import type { TurnEvent } from '../src/repl/transcript.js';

// The agent emits OpenRouter stream items; the bridge turns them into turn events. Text is keyed by
// message id (playbook §17.4: one global cursor truncates later messages), tools by call id.
const msg = (id: string, text: string) => ({ type: 'message', id, content: [{ type: 'output_text', text }] });

describe('bridgeAgent', () => {
  it('maps thinking, per-message text, tool calls and outputs, and errors', () => {
    const agent = new EventEmitter();
    const events: TurnEvent[] = [];
    const stop = bridgeAgent(agent, (e) => events.push(e));
    agent.emit('thinking:start');
    agent.emit('item:update', msg('m1', 'Checking'));
    agent.emit('item:update', msg('m1', 'Checking the time.'));
    agent.emit('item:update', { type: 'function_call', callId: 'c1', name: 'get_current_time', arguments: '{"zone":"PT"}', status: 'in_progress' });
    agent.emit('item:update', { type: 'function_call', callId: 'c1', name: 'get_current_time', arguments: '{"zone":"PT"}', status: 'completed' });
    agent.emit('item:update', { type: 'function_call', callId: 'c1', name: 'get_current_time', arguments: '{"zone":"PT"}', status: 'completed' });
    agent.emit('item:update', { type: 'function_call_output', callId: 'c1', output: { time: '23:48' } });
    agent.emit('item:update', msg('m2', 'It is 23:48.'));
    agent.emit('error', new Error('OpenRouter request failed for m.\nReason: 429 Too Many Requests.\nNext: choose another model or run /model fallback.'));
    stop();
    agent.emit('item:update', msg('m3', 'after stop'));
    expect(events).toEqual([
      { type: 'thinking' },
      { type: 'text', id: 'm1', text: 'Checking' },
      { type: 'text', id: 'm1', text: 'Checking the time.' },
      { type: 'tool-start', id: 'c1', tool: 'get_current_time', args: { zone: 'PT' } },
      { type: 'tool-end', id: 'c1', ok: true, preview: '{"time":"23:48"}' },
      { type: 'text', id: 'm2', text: 'It is 23:48.' },
      { type: 'error', message: 'OpenRouter request failed for m.', cause: '429 Too Many Requests.', fix: 'choose another model: /model <id>' },
    ]);
  });
  it('shows an error once even when the agent emits it twice, and keeps model-fallback notices', () => {
    const agent = new EventEmitter();
    const events: TurnEvent[] = [];
    bridgeAgent(agent, (e) => events.push(e));
    const err = new Error('OpenRouter request failed for m.');
    agent.emit('error', err);
    agent.emit('error', err);
    agent.emit('message:user', { role: 'assistant', content: '⚙️ **[SYSTEM]** Selected model `a` failed. Retried with `b`.' });
    agent.emit('message:user', { role: 'user', content: 'my own prompt' });
    expect(events).toEqual([
      { type: 'error', message: 'OpenRouter request failed for m.' },
      { type: 'text', id: 'notice-1', text: 'Selected model `a` failed. Retried with `b`.' },
    ]);
  });
  it('turns a key failure into a key fix, and never suggests a command the REPL does not have', () => {
    const agent = new EventEmitter();
    const events: TurnEvent[] = [];
    bridgeAgent(agent, (e) => events.push(e));
    agent.emit('error', new Error('OpenRouter request failed for m.\nReason: Missing Authentication header.\nNext: choose another model or run /model fallback.'));
    agent.emit('error', new Error('OpenRouter request failed for m.\nReason: model not found.\nNext: choose another model or run /model fallback.'));
    expect(events.map((e) => (e as { fix?: string }).fix)).toEqual([
      'timmy init, or export OPENROUTER_API_KEY=<your key>',
      'choose another model: /model <id>',
    ]);
  });
  it('cleans everything the agent sends before it reaches the screen (escapes, control characters)', () => {
    const agent = new EventEmitter();
    const events: TurnEvent[] = [];
    bridgeAgent(agent, (e) => events.push(e));
    agent.emit('item:update', msg('m1', 'ok\x1b]52;c;ZXZpbA==\x07 done'));
    agent.emit('item:update', { type: 'function_call', callId: 'c', name: 'shell\x1b[2J', arguments: '{"command":"del x\\b\\b\\b\\bls"}', status: 'completed' });
    agent.emit('item:update', { type: 'function_call_output', callId: 'c', output: 'a\x1b[31mred\x1b[0m\tb' });
    agent.emit('error', new Error('bad\x1b]8;;http://evil.test\x1b\\ link'));
    expect(events).toEqual([
      { type: 'text', id: 'm1', text: 'ok done' },
      { type: 'tool-start', id: 'c', tool: 'shell', args: { command: 'del xls' } },
      { type: 'tool-end', id: 'c', ok: true, preview: 'ared    b' },
      { type: 'error', message: 'bad link' },
    ]);
  });
  it('caps a tool output preview at 200 characters', () => {
    const agent = new EventEmitter();
    const events: TurnEvent[] = [];
    bridgeAgent(agent, (e) => events.push(e));
    agent.emit('item:update', { type: 'function_call', callId: 'c', name: 'x', arguments: '', status: 'completed' });
    agent.emit('item:update', { type: 'function_call_output', callId: 'c', output: 'y'.repeat(500) });
    expect((events[1] as { preview: string }).preview).toBe(`${'y'.repeat(200)}...`);
  });
});

describe("createAgent(config, { multiplexer: 'none' })", () => {
  const run = (options: string) => {
    const dir = mkdtempSync('/tmp/tb-');
    try {
      const bin = join(dir, 'bin');
      execFileSync('mkdir', ['-p', bin]);
      writeFileSync(join(bin, 'tmux'), `#!/bin/sh\necho "$@" >> ${dir}/tmux.log\n`);
      chmodSync(join(bin, 'tmux'), 0o755);
      const code = `import { createAgent } from '${resolve('src/agent/core.ts')}'; createAgent({ apiKey: 'x', model: 'm', instructions: '', maxSteps: 1, maxCost: 1 }${options}); setTimeout(() => process.exit(0), 1500);`;
      spawnSync(resolve('node_modules/.bin/tsx'), ['-e', code], { cwd: dir, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TIMMY_MULTIPLEXER: '' }, encoding: 'utf8' });
      return existsSync(join(dir, 'tmux.log')) ? readFileSync(join(dir, 'tmux.log'), 'utf8') : '';
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  it('starts no tmux sessions (negative control: the default starts them)', () => {
    expect(run(", { multiplexer: 'none' }")).toBe('');
    expect(run('')).toContain('new-session');
  });
});

describe('notice ids', () => {
  it('never repeat across turns, so a later notice is never cut against an earlier one', () => {
    const ids: string[] = [];
    for (let turn = 0; turn < 2; turn++) {
      const agent = new EventEmitter();
      const stop = bridgeAgent(agent, (e) => { if (e.type === 'text') ids.push(e.id); });
      agent.emit('message:user', { role: 'assistant', content: 'Retried with b.' });
      stop();
    }
    expect(new Set(ids).size).toBe(2);
  });
});
