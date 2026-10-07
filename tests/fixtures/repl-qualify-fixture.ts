// PTY fixture for the C-15 qualification (scripts/ui/qualify.ts): the real REPL loop, the real
// terminal session, theme, live region and transcript, with a scripted agent chosen by TIMMY_Q_SCRIPT.
// No network and no model. TIMMY_Q_SEAL=1 also seals each turn into TIMMY_STORE through appendReceipt.
//   text      one streamed answer
//   long      a paragraph longer than 80 columns (prose wraps at min(columns, 80))
//   ttt       text, two tools, then a second message (the whole second message must show)
//   slowtool  a shell tool that runs 31 seconds (the running-tool indicator must stay live)
//   error     the provider fails; the error prints in the flow and the prompt comes back
import { EventEmitter } from 'node:events';
import { currentCapabilities } from '../../src/term/capabilities.js';
import { LiveRegion } from '../../src/term/live-region.js';
import { TerminalSession } from '../../src/term/session.js';
import { buildTheme } from '../../src/term/theme.js';
import { measureTerminal, replLoop } from '../../src/repl/main.js';
import { sealTurn } from '../../src/repl/seal.js';
import { Transcript } from '../../src/repl/transcript.js';

const SCRIPT = process.env.TIMMY_Q_SCRIPT ?? 'text';
const LONG = 'The storyboard has six frames over twenty seconds, and each frame names the asset it needs, the line of the voiceover it sits under, and the receipt that will seal it once it renders.';
const SECOND = 'Both files are written: script.md now opens on a receipt sealing in real time, and the storyboard keeps six frames at twenty seconds.';

class QualifyAgent extends EventEmitter {
  getModel() { return 'fake/qualify'; }
  setModel() {}
  startSession() { return 's1'; }

  private wait(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('Cancelled.'), { name: 'AbortError' })); }, { once: true });
    });
  }

  private async stream(id: string, text: string, signal?: AbortSignal): Promise<void> {
    const words = text.split(' ');
    for (let i = 1; i <= words.length; i += 4) {
      this.emit('item:update', { type: 'message', id, content: [{ text: words.slice(0, i + 3).join(' ') }] });
      await this.wait(40, signal);
    }
  }

  private async tool(callId: string, name: string, args: Record<string, unknown>, ms: number, output: string, signal?: AbortSignal): Promise<void> {
    this.emit('item:update', { type: 'function_call', callId, name, arguments: JSON.stringify(args), status: 'completed' });
    await this.wait(ms, signal);
    this.emit('item:update', { type: 'function_call_output', callId, output });
  }

  async send(_text: string, opts: { signal?: AbortSignal } = {}): Promise<string> {
    const signal = opts.signal;
    this.emit('thinking:start');
    await this.wait(150, signal);
    switch (SCRIPT) {
      case 'long':
        await this.stream('m1', LONG, signal);
        return LONG;
      case 'ttt':
        await this.stream('m1', "I'll read the brief, then update the script.", signal);
        await this.tool('c1', 'file_read', { path: 'brief.md' }, 200, 'Launch video: 20 seconds, upbeat, end on the receipt chain.', signal);
        await this.tool('c2', 'file_edit', { path: 'script.md' }, 200, 'Edited script.md', signal);
        await this.stream('m2', SECOND, signal);
        return SECOND;
      case 'slowtool':
        await this.tool('c1', 'shell', { command: 'npm run render:storyboard' }, 31_000, 'storyboard.mp4  20.0s  1920x1080', signal);
        await this.stream('m1', 'The render finished.', signal);
        return 'The render finished.';
      case 'error': {
        const err = new Error('OpenRouter request failed with status 503.\nReason: the provider is overloaded.\nNext: try again in a minute.');
        this.emit('error', err);
        throw err;
      }
      default:
        await this.stream('m1', 'Hello. The answer streams here, one line at a time.', signal);
        return 'Hello.';
    }
  }
}

const caps = currentCapabilities();
const session = new TerminalSession({ stdin: process.stdin, stdout: process.stdout, stderr: process.stderr });
session.install();
const theme = buildTheme(caps, await measureTerminal(caps, process.env, { stdin: process.stdin, stdout: process.stdout }));
const region = new LiveRegion({ out: process.stdout, err: process.stderr }, { live: caps.animate });
const transcript = new Transcript(theme, region, { columns: caps.columns, err: process.stderr });
const agent = new QualifyAgent();
const code = await replLoop({
  agent, caps, theme, region, transcript, session, stdin: process.stdin, stdout: process.stdout,
  ...(process.env.TIMMY_Q_SEAL === '1' ? { seal: (facts: Parameters<typeof sealTurn>[0]) => sealTurn({ ...facts, model: agent.getModel() }) } : {}),
});
process.exit(code);
