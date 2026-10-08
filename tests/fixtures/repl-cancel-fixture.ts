// PTY fixture for tests/repl-cancel-pty.test.ts: the real REPL loop with a slow scripted agent
// (TIMMY_TEST_STUCK=1: the agent ignores the cancel).
import { EventEmitter } from 'node:events';
import { currentCapabilities } from '../../src/term/capabilities.js';
import { LiveRegion } from '../../src/term/live-region.js';
import { TerminalSession } from '../../src/term/session.js';
import { buildTheme } from '../../src/term/theme.js';
import { measureTerminal, replLoop } from '../../src/repl/main.js';
import { Transcript } from '../../src/repl/transcript.js';

class SlowAgent extends EventEmitter {
  private model = 'fake/slow';
  getModel() { return this.model; }
  setModel(m: string) { this.model = m; }
  startSession() { return 's1'; }
  async send(_text: string, opts: { signal?: AbortSignal } = {}): Promise<string> {
    this.emit('thinking:start');
    const lines: string[] = [];
    for (let i = 1; i <= 10; i++) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 300);
        // TIMMY_TEST_STUCK: a stream that ignores the cancel and keeps going.
        if (process.env.TIMMY_TEST_STUCK !== '1') {
          opts.signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('Cancelled.'), { name: 'AbortError' })); }, { once: true });
        }
      });
      lines.push(`Line ${i} of a long answer.`);
      this.emit('item:update', { type: 'message', id: 'm1', content: [{ text: `${lines.join('\n')}\n` }] });
    }
    return lines.join('\n');
  }
}

const caps = currentCapabilities();
const session = new TerminalSession({ stdin: process.stdin, stdout: process.stdout, stderr: process.stderr });
session.install();
const theme = buildTheme(caps, await measureTerminal(caps, process.env, { stdin: process.stdin, stdout: process.stdout }));
const region = new LiveRegion({ out: process.stdout, err: process.stderr }, { live: caps.animate });
const transcript = new Transcript(theme, region, { columns: caps.columns, err: process.stderr });
const code = await replLoop({ agent: new SlowAgent(), caps, theme, region, transcript, session, stdin: process.stdin, stdout: process.stdout });
process.exit(code);
