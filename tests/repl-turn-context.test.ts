/**
 * Round R1, gap 2: every turn says where it runs, which model handles it, and where to inspect the
 * result: the canvas job it left (the editable result and its preview) and the receipt's page, in
 * plain text as well as a link (a terminal without OSC 8 shows nothing for a bare link).
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { detectCapabilities } from '../src/term/capabilities.js';
import { LiveRegion } from '../src/term/live-region.js';
import { measuredFromPalette, TIMMY_NIGHT } from '../src/term/palettes.js';
import { buildTheme } from '../src/term/theme.js';
import { Transcript, type TurnEvent } from '../src/repl/transcript.js';
import { runTurn } from '../src/repl/turn.js';
import { bridgeAgent } from '../src/repl/agent-bridge.js';
import { runSlash, type ReplContext } from '../src/repl/commands.js';
import { glyphSet } from '../src/term/glyphs.js';

class Sink { writes: string[] = []; constructor(public isTTY = false) {} write(s: string) { this.writes.push(s); return true; } get text() { return this.writes.join(''); } }

function render(events: TurnEvent[], opts: { color?: boolean; columns?: number } = {}) {
  const columns = opts.columns ?? 80;
  const stdout = { isTTY: opts.color === true, columns, rows: 24 };
  const caps = detectCapabilities({ env: { TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8' }, stdin: stdout, stdout, stderr: { isTTY: false } });
  const out = new Sink(stdout.isTTY);
  const t = new Transcript(buildTheme(caps, measuredFromPalette(TIMMY_NIGHT)), new LiveRegion({ out, err: new Sink() }, { live: false }), { columns });
  for (const e of events) t.handle(e);
  t.endTurn();
  return out.text;
}

describe('where and who', () => {
  it('the turn opens with the folder and the model that handles it', () => {
    expect(render([{ type: 'prompt', text: 'draw a box', cwd: '~/project', echoed: true, model: 'anthropic/claude-haiku-4.5' }]))
      .toBe('  ~/project · anthropic/claude-haiku-4.5\n');
    // Without a model (the demo), the row is the folder alone, as before.
    expect(render([{ type: 'prompt', text: 'x', cwd: '~/project', echoed: true }])).toBe('  ~/project\n');
  });
  it('the receipt names the model that answered', () => {
    const text = render([{ type: 'receipt', id: '1a2b3c4d', verified: true, lanes: 0, steps: 2, spend: '$0.004', seconds: 6.1, model: 'anthropic/claude-haiku-4.5' }]);
    expect(text).toContain('  2 steps · $0.004 · 6.1s · anthropic/claude-haiku-4.5');
  });
});

describe('where to inspect', () => {
  const rows: TurnEvent = {
    type: 'inspect',
    rows: [
      { label: 'Canvas', text: 'job turn-ab12cd34, rev 14', url: 'http://127.0.0.1:4337/', hint: '/canvas open' },
      { label: 'Receipt', text: 'http://127.0.0.1:4337/receipts/1a2b3c4d', url: 'http://127.0.0.1:4337/receipts/1a2b3c4d', hint: 'or timmy receipts' },
    ],
  };
  it('lists the editable result, its preview and the receipt, each in words', () => {
    expect(render([rows])).toBe([
      '  Canvas   job turn-ab12cd34, rev 14 · http://127.0.0.1:4337/ · /canvas open',
      '  Receipt  http://127.0.0.1:4337/receipts/1a2b3c4d · or timmy receipts',
      '',
    ].join('\n'));
  });
  it('links the address on a terminal, and still prints it', () => {
    const text = render([rows], { color: true });
    expect(text).toContain('\x1b]8;;http://127.0.0.1:4337/receipts/1a2b3c4d\x1b\\http://127.0.0.1:4337/receipts/1a2b3c4d\x1b]8;;\x1b\\');
  });
  it('fits each row to the width: the hint goes first, then the words are cut', () => {
    const narrow = render([rows], { columns: 50 }).split('\n');
    for (const line of narrow) expect(line.length).toBeLessThanOrEqual(50);
    expect(narrow[0]).not.toContain('/canvas open');
  });
});

describe('runTurn with an inspector', () => {
  class FakeAgent extends EventEmitter {
    constructor(private readonly model = 'anthropic/claude-haiku-4.5') { super(); }
    getModel(): string { return this.model; }
    async send(): Promise<string> {
      this.emit('item:update', { type: 'message', id: 'm', content: [{ text: 'Done.' }] });
      return 'Done.';
    }
  }
  it('after the receipt, prints what the inspector found, with the model on the receipt', async () => {
    const out = new Sink();
    const caps = detectCapabilities({ env: { LANG: 'en_US.UTF-8' }, stdin: { isTTY: false }, stdout: { isTTY: false }, stderr: { isTTY: false } });
    const transcript = new Transcript(buildTheme(caps), new LiveRegion({ out, err: new Sink() }, { live: false }), { columns: 80 });
    let asked: string | undefined;
    const result = await runTurn(new FakeAgent(), transcript, 'hi', () => 0, undefined, undefined,
      () => ({ id: '1a2b3c4d', hash: 'sha256:1a2b3c4d', verified: true }), undefined,
      { inspect: async (sealed) => { asked = sealed?.id; return [{ label: 'Receipt', text: 'timmy receipts' }]; } });
    expect(result).toBe('ok');
    expect(asked).toBe('1a2b3c4d');
    const text = out.text;
    expect(text).toContain('anthropic/claude-haiku-4.5');
    expect(text.indexOf('RECEIPT 1a2b3c4d')).toBeLessThan(text.indexOf('  Receipt  timmy receipts'));
  });
});

describe('a canvas step says where it went', () => {
  it('names the canvas job and revision instead of raw JSON', () => {
    const agent = new EventEmitter();
    const events: TurnEvent[] = [];
    bridgeAgent(agent, (e) => events.push(e));
    agent.emit('item:update', { type: 'function_call_output', callId: 'c1', output: '{"ok":true,"result":3,"jobId":"turn-ab12cd34","revision":14}' });
    agent.emit('item:update', { type: 'function_call_output', callId: 'c2', output: '{"ok":false,"error":"No canvas is open.","jobId":"turn-ab12cd34"}' });
    expect(events).toEqual([
      { type: 'tool-end', id: 'c1', ok: true, preview: 'Timmy Canvas job turn-ab12cd34, revision 14: 3' },
      { type: 'tool-end', id: 'c2', ok: false, preview: 'Timmy Canvas job turn-ab12cd34: No canvas is open.' },
    ]);
  });
});

describe('slash commands may wait', () => {
  const ctx = (extra: Partial<ReplContext> = {}) => {
    const printed: string[] = [];
    const c: ReplContext = { agent: { getModel: () => 'm', setModel: () => {}, startSession: () => 's' }, print: (s) => printed.push(s.map((x) => x.text).join('')), glyphs: glyphSet(true), ...extra };
    return { c, printed };
  };
  it('/canvas prints what the canvas check found, after it answers', async () => {
    const { c, printed } = ctx({ canvas: async (args) => [[{ text: `  Canvas   http://127.0.0.1:4337/ (${args || 'status'})` }]] });
    expect(await runSlash('/canvas', c)).toBe('handled');
    expect(await runSlash('/canvas open', c)).toBe('handled');
    expect(printed).toEqual(['  Canvas   http://127.0.0.1:4337/ (status)', '  Canvas   http://127.0.0.1:4337/ (open)']);
  });
  it('/canvas says so where the canvas is not available', async () => {
    const { c, printed } = ctx();
    await runSlash('/canvas', c);
    expect(printed).toEqual(['  Timmy Canvas is not available here.']);
  });
});
