import { describe, expect, it, vi } from 'vitest';
import { detectCapabilities } from '../src/term/capabilities.js';
import { LiveRegion } from '../src/term/live-region.js';
import { measuredFromPalette, TIMMY_NIGHT } from '../src/term/palettes.js';
import { buildTheme } from '../src/term/theme.js';
import { visibleWidth } from '../src/term/width.js';
import { Transcript, type TurnEvent } from '../src/repl/transcript.js';
import { DEMO_TURN } from '../src/repl/demo.js';

// The turn transcript (plan C-6, playbook §17.1, §17.4, §17.5): prompt, lanes, grouped tool steps,
// streamed text per message id, diffs, receipt. Everything finished goes to scrollback once.
class Sink { writes: string[] = []; constructor(public isTTY: boolean, public columns = 80) {} write(s: string) { this.writes.push(s); return true; } get text() { return this.writes.join(''); } }

function render(events: TurnEvent[], opts: { columns?: number; color?: boolean; unicode?: boolean } = {}) {
  const columns = opts.columns ?? 80;
  const stdout = { isTTY: opts.color === true, columns, rows: 24 };
  const env: Record<string, string> = { TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: opts.unicode === false ? 'C' : 'en_US.UTF-8' };
  const caps = detectCapabilities({ env, stdin: stdout, stdout, stderr: { isTTY: false } });
  const theme = buildTheme(caps, measuredFromPalette(TIMMY_NIGHT));
  const out = new Sink(stdout.isTTY, columns), err = new Sink(false);
  const t = new Transcript(theme, new LiveRegion({ out, err }, { live: false }), { columns });
  for (const e of events) t.handle(e);
  t.endTurn();
  return out.text;
}

describe('streamed text', () => {
  it('keeps every message whole in a text, tool, text turn (emitted length per message id)', () => {
    const text = render([
      { type: 'text', id: 'a', text: 'Let me look at the' },
      { type: 'text', id: 'a', text: 'Let me look at the package file.' },
      { type: 'tool-start', id: 't1', tool: 'file_read', args: { path: 'package.json' } },
      { type: 'tool-end', id: 't1', ok: true, preview: '{"name": "timmy-tui"}' },
      { type: 'text', id: 'b', text: 'It is version' },
      { type: 'text', id: 'b', text: 'It is version 2.0.0.' },
    ]);
    expect(text).toBe(['Let me look at the package file.', '', '● Read package.json', '  └ {"name": "timmy-tui"}', '', 'It is version 2.0.0.', ''].join('\n'));
  });
  it('turns headings bold with a blank line before, and code spans and **bold** into strong text', () => {
    const text = render([{ type: 'text', id: 'a', text: 'Plan:\n## Next\nRun `npm test` **now**.\n' }], { color: true });
    expect(text).toBe('Plan:\n\n\x1b[1mNext\x1b[22m\nRun \x1b[1mnpm test\x1b[22m \x1b[1mnow\x1b[22m.\n');
  });
  it('wraps prose at min(columns, 80) by display width', () => {
    const text = render([{ type: 'text', id: 'a', text: 'word '.repeat(30).trim() }], { columns: 60 });
    for (const line of text.split('\n')) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
  });
});

describe('tool steps', () => {
  it('merges repeats of the same verb under one header', () => {
    const text = render([
      { type: 'tool-start', id: '1', tool: 'file_read', args: { path: 'package.json' } },
      { type: 'tool-end', id: '1', ok: true },
      { type: 'tool-start', id: '2', tool: 'file_read', args: { path: 'src/cli.ts' } },
      { type: 'tool-end', id: '2', ok: true },
      { type: 'tool-start', id: '3', tool: 'shell', args: { command: 'npm test' } },
      { type: 'tool-end', id: '3', ok: false, preview: 'exit 1: 3 tests failed' },
    ]);
    // Round R1 review: a failed step's head says it failed in words, and never "Ran".
    expect(text).toBe(['● Read 2 files', '  ├ package.json', '  └ src/cli.ts', '', '✖ Run failed: npm test', '  └ exit 1: 3 tests failed', ''].join('\n'));
  });
  it('says how many of a group failed, and marks each failed one, never "Ran" (round R1 review)', () => {
    const text = render([
      { type: 'tool-start', id: '1', tool: 'run_in_daytona_workspace', args: { command: 'git status' } },
      { type: 'tool-end', id: '1', ok: true, preview: 'Ran in Daytona workspace (exit 0).' },
      { type: 'tool-start', id: '2', tool: 'run_in_daytona_workspace', args: { command: 'git log' } },
      { type: 'tool-end', id: '2', ok: false, preview: 'Not run: Daytona could not be reached. Nothing ran on this machine.' },
    ], { columns: 100 });
    expect(text).toBe([
      '✖ Run failed: 1 of 2 workspace commands',
      '  ├ git status  Ran in Daytona workspace (exit 0).',
      '  └ git log  failed: Not run: Daytona could not be reached. Nothing ran on this machine.',
      '',
    ].join('\n'));
  });
  it('a turn that ends at its limit with a call still open says so, and never shows the call done (round R1)', () => {
    const text = render([
      { type: 'tool-start', id: '1', tool: 'canvas_exec', args: { code: 'draw()' } },
      { type: 'unfinished', count: 1 },
    ], { columns: 100 });
    expect(text).toBe([
      '● canvas_exec draw()',
      '  └ outcome unknown',
      '  The turn ended at its step or spend limit before 1 call answered, so it may not have run. Send',
      '  another message to go on.',
      '',
    ].join('\n'));
  });
  it('colors the marker and verb by risk: shell red, writes yellow, model or network violet', () => {
    const text = render([
      { type: 'tool-start', id: '1', tool: 'shell', args: { command: 'ls' } },
      { type: 'tool-end', id: '1', ok: true },
      { type: 'tool-start', id: '2', tool: 'file_write', args: { path: 'a.md' } },
      { type: 'tool-end', id: '2', ok: true },
      { type: 'tool-start', id: '3', tool: 'generate_image', args: { path: 'frame.png' } },
      { type: 'tool-end', id: '3', ok: true },
    ], { color: true });
    expect(text).toContain('\x1b[1;31m● Ran\x1b[22;39m ls');
    expect(text).toContain('\x1b[33m● Wrote\x1b[39m a.md');
    expect(text).toContain('\x1b[35m◉ Generated\x1b[39m frame.png');
  });
  it('never wraps a preview at 60 or 80 columns', () => {
    for (const columns of [60, 80]) {
      const text = render([
        { type: 'tool-start', id: '1', tool: 'shell', args: { command: 'cat '.repeat(40) } },
        { type: 'tool-end', id: '1', ok: true, preview: 'x'.repeat(300) },
      ], { columns });
      for (const line of text.split('\n')) expect(visibleWidth(line), line).toBeLessThanOrEqual(columns);
      expect(text).toContain('…');
    }
  });
  it('draws a call whose argument spans lines (canvas code) on one line, cut to the width', () => {
    // LIVE-01 (row 65): an unknown tool's argument kept its newlines, so the code ran down the screen
    // unindented and the live region lost count of its rows.
    const code = "const id = helpers.createShapeId();\neditor.createShape({\n  id,\n  type: 'geo',\n});";
    const text = render([
      { type: 'tool-start', id: 't1', tool: 'canvas_exec', args: { code } },
      { type: 'tool-end', id: 't1', ok: true, preview: '{"ok":true}' },
    ], { columns: 60 });
    const lines = text.split('\n');
    expect(lines[0]).toBe('● canvas_exec const id = helpers.createShapeId(); editor.cr…');
    expect(lines[1]).toBe('  └ {"ok":true}');
    for (const line of lines) expect(visibleWidth(line), line).toBeLessThanOrEqual(60);
  });
  it('shows edits as a unified diff, + green and - red (B5)', () => {
    const diff = '@@ -1,2 +1,2 @@\n title\n-old line\n+new line';
    const text = render([
      { type: 'tool-start', id: '1', tool: 'file_edit', args: { path: 'script.md' } },
      { type: 'tool-end', id: '1', ok: true, diff },
    ], { color: true });
    expect(text).toContain('\x1b[33m● Edited\x1b[39m script.md');
    expect(text).toContain('    \x1b[31m-old line\x1b[39m');
    expect(text).toContain('    \x1b[32m+new line\x1b[39m');
  });
});

describe('lanes and receipt', () => {
  it('prints lanes as a checklist with at most one running', () => {
    const text = render([{ type: 'lanes', lanes: [
      { label: 'Write the script', state: 'done' }, { label: 'Draw the storyboard', state: 'running' }, { label: 'Record the voiceover', state: 'waiting' },
    ] }]);
    expect(text).toBe(['Lanes  1 of 3 done', '  [x] Write the script', '  [~] Draw the storyboard', '  [ ] Record the voiceover', ''].join('\n'));
  });
  it('after the first checklist, lists only the lanes that changed', () => {
    const lanes = (states: Array<'done' | 'running' | 'waiting'>) => ({
      type: 'lanes' as const,
      lanes: ['Script', 'Storyboard', 'Voiceover'].map((label, i) => ({ label, state: states[i] })),
    });
    const text = render([lanes(['running', 'waiting', 'waiting']), lanes(['done', 'running', 'waiting']), lanes(['done', 'running', 'waiting'])]);
    expect(text).toBe(['Lanes  0 of 3 done', '  [~] Script', '  [ ] Storyboard', '  [ ] Voiceover', '', 'Lanes  1 of 3 done', '  [x] Script', '  [~] Storyboard', ''].join('\n'));
  });
  it('links the receipt id to its page on a terminal (OSC 8)', () => {
    const receipt = { type: 'receipt' as const, id: '0142', verified: true, lanes: 1, steps: 1, spend: '$0.01', seconds: 2, url: 'http://127.0.0.1:4590/r/0142' };
    expect(render([receipt], { color: true })).toContain('\x1b]8;;http://127.0.0.1:4590/r/0142\x1b\\✓ RECEIPT 0142\x1b]8;;\x1b\\');
    expect(render([receipt])).toContain('✓ RECEIPT 0142 (http://127.0.0.1:4590/r/0142) signed and verified');
  });
  it('turns the receipt line green only after a real verify, and shows a broken chain as ✖', () => {
    const receipt = { type: 'receipt' as const, id: '0142', lanes: 3, steps: 7, spend: '$0.42', seconds: 41 };
    expect(render([{ ...receipt, verified: true }], { color: true })).toContain('\x1b[1;32m✓ RECEIPT 0142\x1b[22;39m signed and verified');
    const pending = render([{ ...receipt, verified: false }], { color: true });
    expect(pending).toContain('RECEIPT 0142');
    expect(pending).not.toContain('\x1b[1;32m');
    expect(render([{ ...receipt, verified: 'broken' }], { color: true })).toContain('\x1b[1;31m✖ RECEIPT 0142\x1b[22;39m chain broken');
  });
});

describe('the demo turn', () => {
  it('renders in ASCII with no Unicode left over (the middle-dot leak)', () => {
    const text = render(DEMO_TURN.map((s) => s.event), { unicode: false });
    expect([...text].filter((ch) => ch > '~' ).join('')).toBe('');
    expect(text).toContain('[OK] RECEIPT 0142');
  });
  it('is deterministic', () => {
    expect(render(DEMO_TURN.map((s) => s.event))).toBe(render(DEMO_TURN.map((s) => s.event)));
  });
});

describe('streams and the footer', () => {
  it('sends prose to stdout and steps, lanes, footer and errors to stderr when given a separate log region', () => {
    const out = new Sink(false), err = new Sink(false), logOut = new Sink(false);
    const caps = detectCapabilities({ env: { LANG: 'en_US.UTF-8' }, stdin: { isTTY: false }, stdout: { isTTY: false }, stderr: { isTTY: false } });
    const theme = buildTheme(caps);
    const t = new Transcript(theme, new LiveRegion({ out, err }, { live: false }), { columns: 80, log: new LiveRegion({ out: logOut, err }, { live: false }) });
    t.handle({ type: 'text', id: 'a', text: 'The answer is 4.' });
    t.handle({ type: 'tool-start', id: '1', tool: 'calculate', args: { expression: '2+2' } });
    t.handle({ type: 'tool-end', id: '1', ok: true, preview: '4' });
    t.handle({ type: 'footer', steps: 1, spend: '$0.004', seconds: 2.5 });
    t.endTurn();
    expect(out.text).toBe('The answer is 4.\n');
    expect(logOut.text).toBe(['● calculate 2+2', '  └ 4', '', '  1 step · $0.004 · 2.5s', ''].join('\n'));
  });
  it('never starts the piped answer with a blank line left over from the other stream', () => {
    const out = new Sink(false), err = new Sink(false), logOut = new Sink(false);
    const caps = detectCapabilities({ env: { LANG: 'en_US.UTF-8' }, stdin: { isTTY: false }, stdout: { isTTY: false }, stderr: { isTTY: false } });
    const t = new Transcript(buildTheme(caps), new LiveRegion({ out, err }, { live: false }), { columns: 80, log: new LiveRegion({ out: logOut, err }, { live: false }) });
    t.handle({ type: 'tool-start', id: '1', tool: 'calculate', args: { expression: '2+2' } });
    t.handle({ type: 'tool-end', id: '1', ok: true, preview: '4' });
    t.handle({ type: 'text', id: 'a', text: 'The answer is 4.' });
    t.endTurn();
    expect(out.text).toBe('The answer is 4.\n');
  });
  it('prints a per-turn footer in secondary text', () => {
    expect(render([{ type: 'footer', steps: 2, spend: '$0.004', seconds: 12.3 }])).toBe('  2 steps · $0.004 · 12.3s\n');
  });
});

describe('NEEDS YOU in the turn', () => {
  it('shows the box only while it waits, then records the answer under the step', () => {
    const out = new Sink(false), err = new Sink(true);
    const caps = detectCapabilities({ env: { LANG: 'C' }, stdin: { isTTY: false }, stdout: { isTTY: false }, stderr: { isTTY: true } });
    const region = new LiveRegion({ out, err }, { live: true });
    const t = new Transcript(buildTheme(caps), region, { columns: 60 });
    t.handle({ type: 'tool-start', id: 'c1', tool: 'run_in_daytona_workspace', args: { command: 'rm -rf dist' } });
    t.handle({ type: 'needs-you', tool: 'run_in_daytona_workspace', reason: 'destructive shell command', summary: 'rm -rf dist' });
    expect(err.text).toContain('NEEDS YOU');
    t.handle({ type: 'needs-you-answered', tool: 'run_in_daytona_workspace', decision: 'deny' });
    t.handle({ type: 'tool-end', id: 'c1', ok: false, preview: 'The operator denied run_in_daytona_workspace; it did not run.' });
    t.endTurn();
    expect(out.text.replaceAll('\x1b[K', '')).toBe(['[FAIL] Not run: rm -rf dist', '  | [FAIL] Denied by you', '  ` The operator denied run_in_daytona_workspace; it did ...', ''].join('\n'));
    expect(out.text).not.toContain('NEEDS YOU');
  });
  it('fits the code it asks about to the terminal, and says how much it left out', () => {
    // LIVE-01 (row 65): the operator saw one line of the canvas code before approving it.
    const out = new Sink(false), err = Object.assign(new Sink(true), { rows: 24 });
    const caps = detectCapabilities({ env: { LANG: 'C' }, stdin: { isTTY: false }, stdout: { isTTY: false }, stderr: { isTTY: true } });
    const region = new LiveRegion({ out, err }, { live: true });
    const t = new Transcript(buildTheme(caps), region, { columns: 60, rows: 24 });
    const detail = Array.from({ length: 40 }, (_, i) => `step(${i + 1});`).join('\n');
    t.handle({ type: 'tool-start', id: 'c1', tool: 'canvas_exec', args: { code: detail } });
    t.handle({ type: 'needs-you', tool: 'canvas_exec', reason: 'runs code in the canvas page', summary: 'step(1); ...', detail });
    const frame = err.writes.at(-1) ?? '';
    const rows = frame.split('\n');
    expect(rows.length).toBeLessThanOrEqual(23);
    // The whole box, top to bottom: the region drops its oldest rows when it overflows the terminal.
    expect(frame).toContain('NEEDS YOU');
    expect(frame).toContain('runs code in the canvas page');
    expect(frame).toContain('step(1);');
    expect(frame).toContain('more lines not shown');
    expect(frame).not.toContain('step(40);');
    expect(frame).toContain('y allow once');
  });
  it('records approvals in words, never with the green check (green is proof only)', () => {
    const text = render([
      { type: 'tool-start', id: 'c1', tool: 'get_env', args: { name: 'HOME' } },
      { type: 'needs-you', tool: 'get_env', reason: 'sends a value from your environment to the model', summary: 'HOME' },
      { type: 'needs-you-answered', tool: 'get_env', decision: 'session' },
      { type: 'tool-end', id: 'c1', ok: true, preview: 'HOME is set' },
    ], { color: true });
    expect(text).toContain('\x1b[1mApproved\x1b[22m');
    expect(text).toContain('for this session');
    expect(text).not.toContain('\x1b[1;32m');
  });
});

describe('errors at narrow widths', () => {
  it('keeps every error row inside the width, in ASCII too', () => {
    const long = 'x'.repeat(200);
    for (const unicode of [true, false]) {
      const text = render([{ type: 'error', message: long, cause: long, fix: long }], { columns: 60, unicode });
      for (const line of text.split('\n')) expect(visibleWidth(line), line).toBeLessThanOrEqual(60);
    }
  });
});

describe('a cancel that does not land at once', () => {
  it('says how to quit, keeps saying it under new output, and drops it once the turn is cancelled', () => {
    const out = new Sink(false), err = new Sink(true);
    const caps = detectCapabilities({ env: { LANG: 'C' }, stdin: { isTTY: false }, stdout: { isTTY: false }, stderr: { isTTY: true } });
    const t = new Transcript(buildTheme(caps), new LiveRegion({ out, err }, { live: true }), { columns: 60 });
    const note = 'Cancelling. Press Ctrl+C again to quit.';
    t.handle({ type: 'text', id: 'a', text: 'Line 1\nLine 2' });
    t.handle({ type: 'cancelling' });
    expect(err.writes.at(-1)).toContain(note);
    t.handle({ type: 'text', id: 'a', text: 'Line 1\nLine 2\nLine 3' });
    expect(err.writes.at(-1)).toContain(note);
    t.handle({ type: 'tool-start', id: 't1', tool: 'file_read', args: { path: 'a.txt' } });
    expect(err.writes.at(-1)).toContain(note);
    t.handle({ type: 'cancelled' });
    t.endTurn();
    expect(err.writes.at(-1)).not.toContain(note);
    expect(out.text).toContain('Cancelled.');
  });
});

// Third order, checkpoint 2: the active tool. While a step runs, its row says what it is doing; once it
// ends, what it did. A row never claims a step is done while it still runs.
describe('a running step', () => {
  it('reads as running while it runs, and as done once it ends', () => {
    const out = new Sink(false), err = new Sink(true);
    const caps = detectCapabilities({ env: { LANG: 'C' }, stdin: { isTTY: false }, stdout: { isTTY: false }, stderr: { isTTY: true } });
    const t = new Transcript(buildTheme(caps), new LiveRegion({ out, err }, { live: true }), { columns: 60 });
    t.handle({ type: 'tool-start', id: 't1', tool: 'shell', args: { command: 'npm run render' } });
    expect(err.text).toContain('Running npm run render');
    expect(err.text).not.toContain('Ran npm run render');
    t.handle({ type: 'tool-end', id: 't1', ok: true, preview: 'done' });
    t.endTurn();
    expect(out.text).toContain('Ran npm run render');
  });
});

// Third order, checkpoint 2: the elapsed time stays visible under the cancel note.
describe('the cancel note', () => {
  it('keeps the running step\'s elapsed time under the note, second by second', () => {
    vi.useFakeTimers();
    try {
      const out = new Sink(false), err = new Sink(true);
      const caps = detectCapabilities({ env: { LANG: 'C' }, stdin: { isTTY: false }, stdout: { isTTY: false }, stderr: { isTTY: true } });
      const t = new Transcript(buildTheme(caps), new LiveRegion({ out, err }, { live: true }), { columns: 80 });
      t.handle({ type: 'tool-start', id: 't1', tool: 'shell', args: { command: 'npm run render' } });
      vi.advanceTimersByTime(3000);
      t.handle({ type: 'cancelling' });
      expect(err.writes.at(-1)).toContain('Cancelling. The step has run 3s. Press Ctrl+C again to quit.');
      vi.advanceTimersByTime(2000);
      expect(err.writes.at(-1)).toContain('Cancelling. The step has run 5s.');
      t.handle({ type: 'cancelled' });
      t.endTurn();
      const n = err.writes.length;
      vi.advanceTimersByTime(3000);
      expect(err.writes.length).toBe(n);
    } finally {
      vi.useRealTimers();
    }
  });
});
