// Round R4 (H58, ledger row 157): a workflow run's block states as they happen. The reader of upmd's terminal output
// (src/workflows/upmd-live.ts) against upmd 0.2.7's own bytes, the job module's record of a step's moments and of an
// interrupted run (src/jobs), and the connected card's words for them (src/repl/board-workflows.ts).
// tests/fixtures/upmd-0.2.7-pty-third.bin and upmd-0.2.7-pipe-third.bin are REAL upmd 0.2.7 output, captured on the
// operator's Mac (a probe document of three blocks, `upmd --ci -b third probe.md`, exit 1; the first under python3's pty,
// the second with stdout a pipe); they hold no personal data. The job records below are FAKE (written by hand in the shape
// src/jobs writes) and no block runs here; tests/workflow-live-pty.test.ts runs real processes.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JobManager, LineSplitter, type JobRecord, type JobStep } from '../src/jobs/index.js';
import { kit } from '../src/repl/board-kit.js';
import { renderWorkflowCard, workflowForBoard } from '../src/repl/board-nodes.js';
import { connectWorkflow, workflowSummaryLines, type ConnectContext } from '../src/repl/board-workflows.js';
import { isLiveRun, liveProgram, ptyKnown, ptyReady, terminalText, upmdJob, upmdLineParser } from '../src/workflows/upmd-live.js';
import { parseWorkflow } from '../src/workflows/upmd.js';

const F = '```';
/** The probe document the fixtures were captured from (three blocks: first; second needs first and exits 3; third needs second). */
const PROBE = [
  '# Probe', '',
  `${F}bash [name:first]`, 'echo "first says hello"', 'sleep 1', 'echo "first done"', F, '',
  `${F}bash [name:second, deps:first]`, 'echo "second starts"', 'sleep 1', 'echo "second fails" >&2', 'exit 3', F, '',
  `${F}bash [name:third, deps:second]`, 'echo "third never runs"', F, '',
].join('\n');
const fixture = (name: string): Buffer => readFileSync(join('tests', 'fixtures', name));
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const text = (lines: { text: string }[][]): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Feeds bytes to the parser exactly as a job's output reaches it: split into lines by the job module's own splitter, in chunks. */
function feed(bytes: Buffer, format: 'pty' | 'pipe', chunk = bytes.length) {
  let tick = 0;
  const parse = upmdLineParser(parseWorkflow(PROBE), format, () => new Date(Date.UTC(2026, 9, 10, 6, 44, 0) + (tick += 100)));
  const steps: JobStep[] = [];
  const changes: string[] = [];
  const split = new LineSplitter();
  const take = (lines: string[]): void => {
    for (const line of lines) {
      const before = JSON.stringify(steps);
      parse(line, steps);
      if (JSON.stringify(steps) !== before) changes.push(steps.map((s) => `${s.name}:${s.state}${s.code === undefined ? '' : `:${s.code}`}`).join(' '));
    }
  };
  // a decoder per stream, as the job module's spawn gives text: a multi-byte character may be cut between chunks
  const decoder = new TextDecoder('utf-8');
  for (let i = 0; i < bytes.length; i += chunk) take(split.push(decoder.decode(bytes.subarray(i, i + chunk), { stream: true })));
  take([...split.push(decoder.decode()), ...split.end()]);
  return { steps, changes };
}

describe("upmd 0.2.7's real output, byte for byte", () => {
  it('the fixtures are the captured bytes (sha256 pinned)', () => {
    expect(sha(fixture('upmd-0.2.7-pty-third.bin'))).toBe('fcd16798c8c52e1f46e81206626d8f28327bf74259a0443995df8313e4f71330');
    expect(sha(fixture('upmd-0.2.7-pipe-third.bin'))).toBe('c43252b750fd5da67674200ac331a8823daa4639543fe67010d3e49e31a0e9a3');
  });

  it('on a terminal: each block starts at its header, ends at its summary; the failing block fails, its exit after; the rest never starts', () => {
    const bytes = fixture('upmd-0.2.7-pty-third.bin');
    for (const chunk of [bytes.length, 7, 1]) {
      const { steps, changes } = feed(bytes, 'pty', chunk);
      expect(changes, `chunks of ${chunk}`).toEqual([
        'first:running', // ` [1/3] Bash` (its redraw adds nothing)
        'first:completed:0', // `==> first [block 1]` … `✔ exited with code 0`
        'first:completed:0 second:running', // ` [2/3] Bash  [first]`, drawn twice: one step
        'first:completed:0 second:failed', // `Block 2 failed - stopping dependency chain`, before its summary
        'first:completed:0 second:failed:3', // `✘ exited with code 3`
      ]);
      expect(steps.map((s) => s.index)).toEqual([1, 2]);
      // each moment as it was seen (the fake clock ticks 100 ms a line): started before it ended
      for (const s of steps) expect(Date.parse(s.endedAt!)).toBeGreaterThan(Date.parse(s.startedAt!));
    }
    // the bytes do hold the redraw, the repeated header and the hidden cursor this reader tolerates
    const raw = bytes.toString('utf8');
    expect(new LineSplitter().push(raw).map(terminalText).filter((l) => l === ' [2/3] Bash  [first]')).toHaveLength(2);
    expect(raw).toMatch(/\x1b\[\d+A\r\x1b\[J/);
    expect(raw.startsWith('\x1b[?25l\r\n')).toBe(true);
  });

  it('over a pipe: the same blocks from the pipe format, with no moments (both lines came when each block ended)', () => {
    for (const chunk of [1000, 3]) {
      const { steps, changes } = feed(fixture('upmd-0.2.7-pipe-third.bin'), 'pipe', chunk);
      expect(changes).toEqual(['first:running', 'first:completed:0', 'first:completed:0 second:running', 'first:completed:0 second:failed:3']);
      expect(steps.every((s) => s.startedAt === undefined && s.endedAt === undefined)).toBe(true);
    }
  });

  it('terminalText removes colours, cursor moves and CRs: the summary and end lines read as upmd wrote them', () => {
    const lines = new LineSplitter().push(fixture('upmd-0.2.7-pty-third.bin').toString('utf8')).map(terminalText);
    expect(lines).toContain(' [1/3] Bash');
    expect(lines).toContain(' [2/3] Bash  [first]');
    expect(lines).toContain('==> second [block 2]');
    expect(lines).toContain('  ✘ exited with code 3');
    expect(lines).toContain('  second starts');
    expect(lines.some((l) => /\x1b|\r/.test(l))).toBe(false);
  });
});

describe('reading the terminal format: what is upmd\'s and what is a block\'s', () => {
  const run = (lines: string[], doc = PROBE) => {
    const parse = upmdLineParser(parseWorkflow(doc), 'pty', () => new Date(0));
    const steps: JobStep[] = [];
    for (const l of lines) parse(l, steps);
    return steps;
  };

  it("a block's output, always indented by two spaces, is never read as upmd's own lines", () => {
    const steps = run([' [1/3] Bash', '  [2/3] Bash', '  ==> second [block 2]', '  Block 2 failed - stopping dependency chain', '  ✔ exited with code 0']);
    expect(steps).toEqual([{ name: 'first', index: 1, state: 'running', startedAt: new Date(0).toISOString() }]);
  });

  it("an end line counts only in a summary, and the summary's last one is upmd's own", () => {
    const steps = run([' [1/3] Bash', '==> first [block 1]', '  ✔ exited with code 0', '  ✘ exited with code 2', '', ' [2/3] Bash  [first]', '  ✔ exited with code 0']);
    expect(steps.map((s) => [s.name, s.state, s.code ?? null])).toEqual([['first', 'failed', 2], ['second', 'running', null]]);
  });

  it("a block's number names the document's block of that number; the summary's name is upmd's and is kept", () => {
    // the same count of blocks, another name at 2 (the document changed after the run began): upmd's name wins at the end
    const changed = PROBE.replace('[name:second, deps:first]', '[name:renamed, deps:first]');
    const steps = run([' [2/3] Bash  [first]'], changed);
    expect(steps[0].name).toBe('renamed');
    const parse = upmdLineParser(parseWorkflow(changed), 'pty', () => new Date(0));
    parse('==> second [block 2]', steps);
    parse('  ✘ exited with code 3', steps);
    expect(steps.map((s) => [s.name, s.state, s.code])).toEqual([['second', 'failed', 3]]);
    // another count of blocks: named by its number until upmd names it
    const fewer = run([' [2/5] Bash  [first]']);
    expect(fewer[0].name).toBe('block 2');
  });

  it("the wrapper's stop line stops the running block; an end line upmd writes after it keeps it stopped, with its code", () => {
    const parse = upmdLineParser(parseWorkflow(PROBE), 'pty', () => new Date(5000));
    const steps: JobStep[] = [{ name: 'first', index: 1, state: 'completed', code: 0 }, { name: 'second', index: 2, state: 'running', startedAt: new Date(1000).toISOString() }];
    parse('pty_run: SIGTERM received: stopping upmd (process group 4242) and the 1 process group it started (4250) with SIGTERM', steps);
    expect(steps[1]).toEqual({ name: 'second', index: 2, state: 'stopped', startedAt: new Date(1000).toISOString(), endedAt: new Date(5000).toISOString() });
    parse('==> second [block 2]', steps);
    parse('  ✘ exited with code 143', steps);
    expect(steps[1]).toMatchObject({ state: 'stopped', code: 143 });
    expect(steps[0]).toMatchObject({ state: 'completed', code: 0 });
  });

  it('a header is a number, a count, at most one word and the needs; a progress line shaped like one is not taken for it', () => {
    // a progress line that reached the start of a line (`[2/3] Building …`, `[2/3] Linking`) while first ran: no start of block 2
    const steps = run([' [1/3] Bash', '[2/3] Building CXX object x.o', '[2/3] Linking', ' [2/3] Bash  [first]']);
    expect(steps.map((s) => [s.name, s.index, s.state])).toEqual([['first', 1, 'running'], ['second', 2, 'running']]);
    // a block with no language: no word between its count and its needs
    const plain = PROBE.replace(`${F}bash [name:third, deps:second]`, `${F} [name:third, deps:second]`);
    expect(run([' [3/3]  [second]'], plain).map((s) => [s.name, s.index])).toEqual([['third', 3]]);
  });

  it('a summary whose start was not seen is a step with no start moment (its own time is not made up)', () => {
    const steps = run(['==> first [block 1]', '  first says hello', '  ✔ exited with code 0']);
    expect(steps).toEqual([{ name: 'first', index: 1, state: 'completed', code: 0, endedAt: new Date(0).toISOString() }]);
  });
});

describe('the job that runs upmd: on a pty through the wrapper, else over a pipe', () => {
  it('builds python3 -I <wrapper> -- <upmd> <args>, or upmd itself with the reason; tells a live run by its arguments', () => {
    const args = ['--ci', '-b', 'third', '-d', join('/', 'w'), join('/', 'w', 'probe.md')];
    const live = upmdJob(join('/', 'opt', 'upmd'), args, { ok: true, python: join('/', 'usr', 'bin', 'python3'), script: join('/', 'pkg', 'workers', 'upmd', 'pty_run.py') });
    expect(live).toEqual({ live: true, command: join('/', 'usr', 'bin', 'python3'), args: ['-I', join('/', 'pkg', 'workers', 'upmd', 'pty_run.py'), '--', join('/', 'opt', 'upmd'), ...args] });
    expect(isLiveRun(live.args)).toBe(true);
    expect(liveProgram({ kind: 'workflow', args: live.args })).toBe(join('/', 'opt', 'upmd'));
    expect(liveProgram({ kind: 'task', args: live.args })).toBeUndefined();
    const piped = upmdJob(join('/', 'opt', 'upmd'), args, { ok: false, why: 'no python3 on PATH' });
    expect(piped).toEqual({ live: false, why: 'no python3 on PATH', command: join('/', 'opt', 'upmd'), args });
    expect(isLiveRun(piped.args)).toBe(false);
    expect(liveProgram({ kind: 'workflow', args: piped.args })).toBeUndefined();
  });

  it('no python3, or no wrapper: not ready, with the reason, known at once', async () => {
    expect(await ptyReady(null)).toEqual({ ok: false, why: 'no python3 on PATH' });
    expect(ptyKnown(null)).toEqual({ ok: false, why: 'no python3 on PATH' });
    const missing = join(tmpdir(), 'no-such-dir-h58', 'pty_run.py');
    expect(await ptyReady('python3', missing)).toEqual({ ok: false, why: 'its pty wrapper (workers/upmd/pty_run.py) is missing from this Timmy' });
  });
});

describe("the job module's record of a run's moments and of an interrupted run", () => {
  it('keeps each step\'s start and end and the new states; endLeft interrupted marks the running step and names it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'h58-jobs-'));
    dirs.push(dir);
    const jobs = join(dir, 'jobs');
    mkdirSync(jobs);
    // FAKE: a run's record as a REPL that ended left it (its process long gone), written in src/jobs' shape
    writeFileSync(join(jobs, 'j0a0b0c.json'), JSON.stringify({
      id: 'j0a0b0c', kind: 'workflow', label: 'probe.md › third', project: 'demo', root: dir, command: 'python3', args: ['-I', 'pty_run.py', '--', 'upmd', '--ci', '-b', 'third', '-d', dir, join(dir, 'probe.md')],
      state: 'running', pid: 2147480000, startedAt: '2026-10-10T06:44:00.000Z', lines: 40,
      steps: [
        { name: 'first', index: 1, state: 'completed', code: 0, startedAt: '2026-10-10T06:44:00.100Z', endedAt: '2026-10-10T06:44:01.200Z' },
        { name: 'second', index: 2, state: 'running', startedAt: '2026-10-10T06:44:01.300Z' },
        { name: 'odd', state: 'paused' },
      ],
    }));
    const m = new JobManager({ dir: jobs });
    const left = m.get('j0a0b0c')!;
    expect(left.stale).toBe(true);
    expect(left.steps).toEqual([
      { name: 'first', index: 1, state: 'completed', code: 0, startedAt: '2026-10-10T06:44:00.100Z', endedAt: '2026-10-10T06:44:01.200Z' },
      { name: 'second', index: 2, state: 'running', startedAt: '2026-10-10T06:44:01.300Z' },
    ]);
    const ended = m.endLeft('j0a0b0c', { state: 'failed', error: 'interrupted: its REPL ended while second was running; its process is gone', interrupted: true })!;
    expect(ended).toMatchObject({ state: 'failed', exitCode: null, signal: null, interrupted: { step: 'second' } });
    expect(ended.steps[1]).toEqual({ name: 'second', index: 2, state: 'interrupted', startedAt: '2026-10-10T06:44:01.300Z' });
    // read back from its file by another manager: the same
    const again = new JobManager({ dir: jobs }).get('j0a0b0c')!;
    expect(again).toMatchObject({ state: 'failed', interrupted: { step: 'second' } });
    expect(again.stale).toBeUndefined();
    expect(again.steps.map((s) => s.state)).toEqual(['completed', 'interrupted']);
    // once ended, never again
    expect(new JobManager({ dir: jobs }).endLeft('j0a0b0c', { state: 'cancelled', error: 'again', interrupted: true })).toBeUndefined();
  });
});

describe("the connected card's words for live runs (FAKE job records)", () => {
  const root = (): string => { const d = mkdtempSync(join(tmpdir(), 'h58-card-')); dirs.push(d); writeFileSync(join(d, 'probe.md'), PROBE); return d; };
  const run = (dir: string, o: Partial<JobRecord> & { id: string }): JobRecord => ({
    kind: 'workflow', label: 'probe.md › third', project: 'demo', root: dir, command: 'python3',
    args: ['-I', join(dir, 'workers', 'upmd', 'pty_run.py'), '--', 'upmd', '--ci', '-b', 'third', '-d', dir, join(dir, 'probe.md')],
    state: 'running', startedAt: '2026-10-10T06:44:00.000Z', steps: [], logPath: '/dev/null', lines: 0, ...o,
  });
  const view = (dir: string, jobs: JobRecord[], ctx: Partial<ConnectContext> = {}) => connectWorkflow(workflowForBoard('probe.md', { text: PROBE, sha256: sha(PROBE) }), { root: dir, jobs, chain: [], files: ['probe.md'], upmd: true, mine: () => true, ...ctx });
  const t = (s: number): string => new Date(Date.parse('2026-10-10T06:44:00.000Z') + s * 1000).toISOString();

  it('while it runs: the running block from its start, the next waiting; once a block failed the rest are not run', () => {
    const dir = root();
    const going = run(dir, { id: 'j00b001', steps: [{ name: 'first', index: 1, state: 'completed', code: 0, startedAt: t(0), endedAt: t(1.1) }, { name: 'second', index: 2, state: 'running', startedAt: t(1.2) }] });
    expect(view(dir, [going]).connected!.nodes.map((n) => [n.name, n.word, n.detail])).toEqual([['first', 'completed', 'exit 0 · 1.1 s'], ['second', 'running', ''], ['third', 'waiting', '']]);
    const chain = run(dir, { id: 'j00b002', steps: [{ name: 'first', index: 1, state: 'completed', code: 0 }, { name: 'second', index: 2, state: 'failed', startedAt: t(1.2), endedAt: t(2.3) }] });
    expect(view(dir, [chain]).connected!.nodes.map((n) => [n.name, n.word])).toEqual([['first', 'completed'], ['second', 'failed'], ['third', 'not run']]);
  });

  it('a stop while a block ran: that block stopped, with its own time to the stop; the run bar names it', () => {
    const dir = root();
    const stopped = run(dir, { id: 'j00b003', state: 'cancelled', endedAt: t(3), steps: [{ name: 'first', index: 1, state: 'completed', code: 0, startedAt: t(0), endedAt: t(1) }, { name: 'second', index: 2, state: 'stopped', startedAt: t(1.1), endedAt: t(2.6) }] });
    const w = view(dir, [stopped]);
    expect(w.connected!.nodes.map((n) => [n.name, n.word, n.detail])).toEqual([['first', 'completed', 'exit 0 · 1.0 s'], ['second', 'stopped', '1.5 s'], ['third', 'not run', '']]);
    const live = renderWorkflowCard(w, kit({ live: true, base: '../../' }));
    expect(live).toContain('Stopped with /stop (or Stop) before it ended, while second was running.');
    expect(live).toContain('It was running when j00b003 was stopped; upmd did not finish it.');
  });

  it("interrupted, as recovery recorded it: the block that was running is named, with how the run's end was found", () => {
    const dir = root();
    const gone = run(dir, { id: 'j00b004', state: 'failed', endedAt: t(60), exitCode: null, error: 'interrupted: its REPL ended while second was running; its process is gone', interrupted: { step: 'second' },
      steps: [{ name: 'first', index: 1, state: 'completed', code: 0, startedAt: t(0), endedAt: t(1) }, { name: 'second', index: 2, state: 'interrupted', startedAt: t(1.1) }] });
    const w = view(dir, [gone], { mine: () => false });
    expect(w.connected!.nodes.map((n) => n.word)).toEqual(['completed', 'interrupted', 'not run']);
    expect(w.connected!.runs[0]).toMatchObject({ word: 'interrupted', interruptedAt: 'second', interruptedHow: 'recorded gone', live: true, stoppable: false });
    const html = renderWorkflowCard(w, kit({ live: true, base: '../../' }));
    expect(html).toContain("The session that ran j00b004 ended while second was running; its process was gone when a later session&#39;s recovery recorded its end, so how it ended is not known. upmd does not resume a run, and Timmy does not either: /run probe.md third runs it again from first.");
    expect(html).toContain('data-wf-rerun="3"');
    expect(text(workflowSummaryLines(w, { sep: ' · ', link: (r) => r, upmd: { version: '0.2.7' } }))).toContain('its session ended while second ran; its process was gone; recovery recorded its end. Nothing resumes it: /run probe.md third runs it again.');
    // its group stopped by recovery
    const cut = run(dir, { ...gone, id: 'j00b005', state: 'cancelled', cleanup: 'complete', error: 'interrupted: its REPL ended while second was running; recovery stopped its process group with SIGTERM' });
    expect(renderWorkflowCard(view(dir, [cut], { mine: () => false }), kit({ live: true, base: '../../' }))).toContain("ended while second was running; a later session&#39;s recovery stopped its process group, so how the block would have ended is not known.");
    // no block was running (between two): said so, never "a block"
    const between = run(dir, { id: 'j00b006', state: 'failed', endedAt: t(60), interrupted: {}, steps: [{ name: 'first', index: 1, state: 'completed', code: 0, startedAt: t(0), endedAt: t(1) }] });
    expect(renderWorkflowCard(view(dir, [between], { mine: () => false }), kit({ live: true, base: '../../' }))).toContain('ended while no block was running (before upmd started one, or between two)');
  });

  it('where live states are not available here: the card and /workflows say so, with the reason', () => {
    const dir = root();
    const none = view(dir, [], { live: { ok: false, why: 'no python3 on PATH' } });
    const html = renderWorkflowCard(none, kit({ live: true, base: '../../' }));
    expect(html).toContain('Live block states are not available here: no python3 on PATH. upmd then writes to a pipe and prints each block only when it ends, so a block is never shown running and its own time is not measured. Setup: install Python 3 (brew install python), then start Timmy again.');
    expect(text(workflowSummaryLines(none, { sep: ' · ', link: (r) => r, upmd: { version: '0.2.7' } }))).toContain('Live      not available here: no python3 on PATH; a run\'s blocks are seen only as each one ends');
    const ready = renderWorkflowCard(view(dir, [], { live: { ok: true, python: 'python3', script: 'pty_run.py' } }), kit({ live: true, base: '../../' }));
    expect(ready).not.toContain('Live block states are not available');
  });
});
