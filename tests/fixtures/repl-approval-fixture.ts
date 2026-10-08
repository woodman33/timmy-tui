// PTY fixture for tests/repl-approvals-pty.test.ts: one risky step waits for NEEDS YOU, then prints the answer.
import { currentCapabilities } from '../../src/term/capabilities.js';
import { LiveRegion } from '../../src/term/live-region.js';
import { TerminalSession } from '../../src/term/session.js';
import { buildTheme } from '../../src/term/theme.js';
import { readDecision, type Decision } from '../../src/repl/approvals.js';
import { measureTerminal } from '../../src/repl/main.js';
import { Transcript } from '../../src/repl/transcript.js';

const caps = currentCapabilities();
const session = new TerminalSession({ stdin: process.stdin, stdout: process.stdout, stderr: process.stderr });
session.install();
const theme = buildTheme(caps, await measureTerminal(caps, process.env, { stdin: process.stdin, stdout: process.stdout }));
const region = new LiveRegion({ out: process.stdout, err: process.stderr }, { live: caps.animate });
const transcript = new Transcript(theme, region, { columns: caps.columns });
const req = { tool: 'run_in_daytona_workspace', reason: 'destructive shell command', summary: 'rm -rf dist' };
transcript.handle({ type: 'tool-start', id: 'c1', tool: req.tool, args: { command: req.summary } });
let decision: Decision = 'deny';
if (caps.interactive && region.live) {
  transcript.handle({ type: 'needs-you', ...req });
  decision = await readDecision(process.stdin, session);
  transcript.handle({ type: 'needs-you-answered', tool: req.tool, decision });
} else {
  transcript.handle({ type: 'needs-you-answered', tool: req.tool, decision: 'no-terminal' });
}
transcript.handle({ type: 'tool-end', id: 'c1', ok: decision !== 'deny', preview: decision === 'deny' ? 'denied' : 'removed dist' });
transcript.endTurn();
session.restore();
process.stdout.write(`DECISION=${decision}\n`);
process.exit(0);
