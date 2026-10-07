// PTY fixture for tests/term-session-pty.test.ts: take the terminal over, then end by `mode`.
import { TerminalSession } from '../../src/term/session.js';

const mode = process.argv[2];
const session = new TerminalSession({ stdin: process.stdin, stdout: process.stdout, stderr: process.stderr });
session.install();
session.enterAltScreen();
session.hideCursor();
session.enableBracketedPaste();
session.setRaw(true);
process.stdin.on('data', (chunk: Buffer) => {
  if (chunk.includes(3)) void session.shutdown(130); // raw-mode Ctrl+C arrives as a key (playbook §16.2)
});
process.stdin.resume();
process.stdout.write(`PID=${process.pid} READY\n`);
if (mode === 'return') setTimeout(() => { process.stdin.pause(); process.stdin.unref(); }, 300);
if (mode === 'throw') setTimeout(() => { throw new Error('fixture failure'); }, 300);
