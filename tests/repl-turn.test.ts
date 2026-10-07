import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { detectCapabilities } from '../src/term/capabilities.js';
import { LiveRegion } from '../src/term/live-region.js';
import { buildTheme } from '../src/term/theme.js';
import { Transcript } from '../src/repl/transcript.js';
import { runTurn } from '../src/repl/turn.js';

// One real turn through the agent interface: the agent's events become the transcript, a footer
// closes a good turn, and a failed turn prints its error in the flow and returns (non-fatal, §17.8).
class Sink { writes: string[] = []; isTTY = false; write(s: string) { this.writes.push(s); return true; } get text() { return this.writes.join(''); } }
class FakeAgent extends EventEmitter {
  constructor(private readonly script: (a: FakeAgent) => void, private readonly fail = false) { super(); }
  async send(_text: string): Promise<string> {
    this.emit('thinking:start');
    this.script(this);
    if (this.fail) { const e = new Error('OpenRouter request failed for m.\nReason: 503 Service Unavailable.'); this.emit('error', e); throw e; }
    return 'ok';
  }
}
const setup = () => {
  const out = new Sink(), err = new Sink();
  const caps = detectCapabilities({ env: { LANG: 'en_US.UTF-8' }, stdin: { isTTY: false }, stdout: { isTTY: false }, stderr: { isTTY: false } });
  return { out, transcript: new Transcript(buildTheme(caps), new LiveRegion({ out, err }, { live: false }), { columns: 80 }) };
};
let t = 0;
const clock = () => (t += 1500);

describe('runTurn', () => {
  it('renders the turn and closes it with a footer of steps, spend and time', async () => {
    const { out, transcript } = setup();
    const agent = new FakeAgent((a) => {
      a.emit('item:update', { type: 'function_call', callId: 'c1', name: 'get_current_time', arguments: '{}', status: 'completed' });
      a.emit('item:update', { type: 'function_call_output', callId: 'c1', output: '23:55' });
      a.emit('cost:update', 0.0042, 0.0042);
      a.emit('item:update', { type: 'message', id: 'm1', content: [{ text: 'It is 23:55.' }] });
    });
    t = 0;
    expect(await runTurn(agent, transcript, 'what time is it', clock)).toBe('ok');
    expect(out.text).toBe(['● get_current_time', '  └ 23:55', '', 'It is 23:55.', '', '  1 step · $0.004 · 1.5s', ''].join('\n'));
  });
  it('prints a failed turn in the flow and returns instead of throwing', async () => {
    const { out, transcript } = setup();
    expect(await runTurn(new FakeAgent(() => {}, true), transcript, 'hi', clock)).toBe('failed');
    // Playbook §16.5: what, why, the fix when there is one, and where to get help.
    expect(out.text).toBe(['  ✖ Error: OpenRouter request failed for m.', '    Cause: 503 Service Unavailable.', '    Help: /help, or timmy repl --help', ''].join('\n'));
  });
});

// C-8: with a sealer, a finished turn closes with its receipt instead of the footer, sealed from the
// turn's facts; the line is green only when the sealer verified it; a cancelled turn is not sealed.
describe('the turn\'s receipt', () => {
  const timeAgent = () => new FakeAgent((a) => {
    a.emit('item:update', { type: 'function_call', callId: 'c1', name: 'get_current_time', arguments: '{}', status: 'completed' });
    a.emit('item:update', { type: 'function_call_output', callId: 'c1', output: '23:55' });
    a.emit('cost:update', 0.0042, 0.0042);
    a.emit('item:update', { type: 'message', id: 'm1', content: [{ text: 'It is 23:55.' }] });
  });
  it('closes a finished turn with its receipt, sealed from the turn\'s facts', async () => {
    const { out, transcript } = setup();
    const seen: unknown[] = [];
    t = 0;
    const r = await runTurn(timeAgent(), transcript, 'what time is it', clock, undefined, undefined, (f) => { seen.push(f); return { id: '1fb6eb93', hash: 'sha256_1fb6eb93', verified: true }; });
    expect(r).toBe('ok');
    expect(seen).toEqual([{ prompt: 'what time is it', answer: 'ok', steps: 1, spend: 0.0042, ms: 1500, status: 'ok' }]);
    expect(out.text).toBe(['● get_current_time', '  └ 23:55', '', 'It is 23:55.', '', '✓ RECEIPT 1fb6eb93 signed and verified', '  1 step · $0.004 · 1.5s', ''].join('\n'));
  });
  it('seals a failed turn as failed, and a broken chain shows ✖, never green', async () => {
    const { out, transcript } = setup();
    const seen: Array<{ status: string }> = [];
    t = 0;
    await runTurn(new FakeAgent(() => {}, true), transcript, 'hi', clock, undefined, undefined, (f) => { seen.push(f); return { id: 'deadbeef', hash: 'sha256_deadbeef', verified: 'broken' }; });
    expect(seen.map((f) => f.status)).toEqual(['failed']);
    expect(out.text).toContain('✖ RECEIPT deadbeef chain broken');
  });
  // C-13: the receipt line links to the receipt's page (OSC 8) when the sealer gives its address.
  it('passes the receipt page address on to the receipt line', async () => {
    const events: Array<{ type: string; url?: string }> = [];
    const sink = { handle: (e: { type: string; url?: string }) => events.push(e), endTurn: () => {} };
    await runTurn(timeAgent(), sink as never, 'hi', clock, undefined, undefined, () => ({ id: '1fb6eb93', hash: 'h', verified: true, url: 'http://127.0.0.1:4337/receipts/1fb6eb93' }));
    expect(events.find((e) => e.type === 'receipt')?.url).toBe('http://127.0.0.1:4337/receipts/1fb6eb93');
  });
  it('does not seal a cancelled turn', async () => {
    const { transcript } = setup();
    const controller = new AbortController();
    const agent = new (class extends EventEmitter {
      async send(_text: string, opts: { signal?: AbortSignal } = {}): Promise<string> {
        return new Promise((_resolve, reject) => opts.signal?.addEventListener('abort', () => reject(Object.assign(new Error('Cancelled.'), { name: 'AbortError' }))));
      }
    })();
    setTimeout(() => controller.abort(), 20);
    let sealed = 0;
    expect(await runTurn(agent, transcript, 'go', clock, undefined, controller.signal, () => { sealed++; return { id: 'x', hash: 'x', verified: true }; })).toBe('cancelled');
    expect(sealed).toBe(0);
  });
});

describe('cancel', () => {
  it('cancels a running turn: "Cancelled." in the flow, no error, no footer', async () => {
    const { out, transcript } = setup();
    const controller = new AbortController();
    const agent = new (class extends EventEmitter {
      async send(_text: string, opts: { signal?: AbortSignal } = {}): Promise<string> {
        this.emit('item:update', { type: 'message', id: 'm1', content: [{ text: 'Working on it.\n' }] });
        return new Promise((_resolve, reject) => opts.signal?.addEventListener('abort', () => reject(Object.assign(new Error('Cancelled.'), { name: 'AbortError' }))));
      }
    })();
    setTimeout(() => controller.abort(), 20);
    expect(await runTurn(agent, transcript, 'go', clock, undefined, controller.signal)).toBe('cancelled');
    expect(out.text).toBe(['Working on it.', '', '  Cancelled.', ''].join('\n'));
  });
});

