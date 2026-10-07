// PTY fixture for the C-8 turn receipt (tests/repl-seal.test.ts): the real REPL loop and the real
// sealer (appendReceipt into TIMMY_STORE), with a scripted agent that answers without a network.
import { EventEmitter } from 'node:events';
import { currentCapabilities } from '../../src/term/capabilities.js';
import { LiveRegion } from '../../src/term/live-region.js';
import { TerminalSession } from '../../src/term/session.js';
import { buildTheme } from '../../src/term/theme.js';
import { measureTerminal, replLoop } from '../../src/repl/main.js';
import { sealTurn } from '../../src/repl/seal.js';
import { Transcript } from '../../src/repl/transcript.js';

class ScriptedAgent extends EventEmitter {
  getModel() { return 'fake/scripted'; }
  setModel() {}
  startSession() { return 's1'; }
  async send(_text: string): Promise<string> {
    this.emit('item:update', { type: 'function_call', callId: 'c1', name: 'get_current_time', arguments: '{}', status: 'completed' });
    this.emit('item:update', { type: 'function_call_output', callId: 'c1', output: '07:00' });
    this.emit('item:update', { type: 'message', id: 'm1', content: [{ text: 'It is 07:00.' }] });
    return 'It is 07:00.';
  }
}

const caps = currentCapabilities();
const session = new TerminalSession({ stdin: process.stdin, stdout: process.stdout, stderr: process.stderr });
session.install();
const theme = buildTheme(caps, await measureTerminal(caps, process.env, { stdin: process.stdin, stdout: process.stdout }));
const region = new LiveRegion({ out: process.stdout, err: process.stderr }, { live: caps.animate });
const transcript = new Transcript(theme, region, { columns: caps.columns, err: process.stderr });
const agent = new ScriptedAgent();
const code = await replLoop({
  agent, caps, theme, region, transcript, session, stdin: process.stdin, stdout: process.stdout,
  seal: (facts) => sealTurn({ ...facts, model: agent.getModel() }),
});
process.exit(code);
