// PTY fixture for tests/repl-input-pty.test.ts: read one prompt the way `timmy repl` does, print it.
import { appendFileSync } from 'node:fs';
import { currentCapabilities } from '../../src/term/capabilities.js';
import { LiveRegion } from '../../src/term/live-region.js';
import { TerminalSession } from '../../src/term/session.js';
import { buildTheme } from '../../src/term/theme.js';
import { LineEditor } from '../../src/repl/editor.js';
import { readPrompt } from '../../src/repl/input.js';
import { measureTerminal } from '../../src/repl/main.js';

const log = process.env.FIXTURE_WRITE_LOG;
if (log) {
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
    stream.write = ((chunk: unknown, ...rest: unknown[]) => { appendFileSync(log, String(chunk)); return write(chunk, ...rest); }) as typeof stream.write;
  }
}
const caps = currentCapabilities();
const session = new TerminalSession({ stdin: process.stdin, stdout: process.stdout, stderr: process.stderr });
session.install();
const theme = buildTheme(caps, await measureTerminal(caps, process.env, { stdin: process.stdin, stdout: process.stdout }));
const region = new LiveRegion({ out: process.stdout, err: process.stderr }, { live: caps.animate });
const result = await readPrompt({ stdin: process.stdin, stdout: process.stdout, caps, theme, region, session, editor: new LineEditor() });
session.restore();
process.stdout.write(`RESULT=${JSON.stringify(result)}\n`);
process.exit(0);
