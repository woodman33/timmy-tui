/**
 * Round R4 (H99, gap 5): progress lines while a /run runs (src/repl/run-progress.ts). On the Mac (r24) nothing moved for the
 * four minutes a /run took: its block's `timmy act` ran the flow, its agent and its rebuild in another process, and the REPL
 * said nothing until the block ended. Here: a line as the state changes (a block starts; the flow's step; the agent's tool
 * calls and messages and its latest line, read from its own progress log), a "still running" line while nothing changes,
 * with the time it has run, and nothing invented (over a pipe the block that runs is never named; the agent's turns are
 * not counted).
 *
 * FAKE pieces, each labelled:
 * - upmd is tests/fixtures/fake-upmd.mjs (a TEST DOUBLE of upmd 0.2.7's --ci behaviour; on a pty it draws as upmd drew on
 *   the operator's Mac), run on a real pty through workers/upmd/pty_run.py by this machine's python3, or over a pipe;
 * - the code agent is tests/fixtures/fake-code-agent.mjs (a TEST DOUBLE: no model, nothing sent) as Qwen Code on a local
 *   endpoint: SLEEP keeps it in its agent step, PYREPLACE edits the parameter file;
 * - OpenSCAD is tests/fixtures/fake-openscad.mjs (a TEST DOUBLE with no geometry engine); its `hang` mode keeps the flow in
 *   its OpenSCAD step;
 * - the first two tests read records written by hand in the shapes Timmy writes them (a job record, a flow's state file, an
 *   agent's run record and progress log), with a FAKE clock, for the timing rules alone.
 * The `timmy` a block runs is the real CLI (tests/helpers/ops-sandbox.ts); every folder is under os.tmpdir().
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { JobRecord } from '../src/jobs/index.js';
import { folderProject } from '../src/project/index.js';
import { elapsedWords, progressWords, RunProgress, type RunFacts } from '../src/repl/run-progress.js';
import { Workspace, type WorkspaceDeps } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import { appendReceipt, readChain } from '../src/utils/receipts.js';
import { FAKE_UPMD, opsKit, sandbox as opsSandbox, sleep, text, until, type OpsKit, type Sandbox } from './helpers/ops-sandbox.js';

const kit = opsKit();
afterEach(() => kit.cleanup(), 60_000);

const g = glyphSet(true);
const PYTHON3 = String(spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).stdout ?? '').trim() || null;
const F = '```';

/** The REPL of a sandbox (as tests/helpers/ops-sandbox.ts replOf), with the Workspace deps a test gives (progress timings). */
function repl(k: OpsKit, s: Sandbox, extra: Partial<WorkspaceDeps> = {}): { ws: Workspace; notes: string[] } {
  for (const key of ['PATH', 'HOME', 'TIMMY_HOME', 'TIMMY_STORE', 'TIMMY_AGENT_QWEN_BIN', 'TIMMY_AGENT_MODEL', 'TIMMY_OPENSCAD', 'NO_COLOR'] as const) vi.stubEnv(key, s.env[key] ?? '');
  vi.stubEnv('TIMMY_OPERATION', '');
  const notes: string[] = [];
  const ws = new Workspace({
    glyphs: g, env: { ...process.env, UPMD_BIN: FAKE_UPMD }, onPath: () => null,
    notify: (l) => notes.push(l.map((x) => x.text).join('')), openWeb: (u) => u, link: (t) => t,
    seal: (input) => appendReceipt('runs', input, s.root).hash.slice(7, 15), receipts: () => readChain('runs', s.root),
    jobsDir: path.join(s.home, 'timmy', 'jobs'), chdir: () => {}, recoverAtStart: false, roomTools: async () => [],
    ...extra,
  }, folderProject(s.root));
  k.spaces.push(ws);
  return { ws, notes };
}

/** The progress lines of one job among the notices. */
const progressOf = (notes: string[], job: string): string[] => notes.filter((n) => n.startsWith(`  ${g.bullet} ${job}  running: `) || n.startsWith(`  ${g.bullet} ${job}  still running: `));

describe('the words of a progress line', () => {
  it('a duration: 45 s, 1 min 30 s, 1 h 5 min', () => {
    expect([0, 999, 45_000, 60_000, 90_000, 3_600_000, 3_900_000].map(elapsedWords)).toEqual(['0 s', '0 s', '45 s', '1 min', '1 min 30 s', '1 h', '1 h 5 min']);
  });
  it('the block, the time, the flow and its step, the agent\'s own count; over a pipe only the blocks that ended', () => {
    const p: RunFacts = { block: 'change', ended: 0, of: 3, elapsedMs: 90_000, flow: { id: 'f1a2b3c4d', kind: 'scad', step: 'agent' }, agent: { run: 'a1a2b3c4d', tools: 4, messages: 1, latest: 'tool edit box.params.json' } };
    // R4 (H99, the review): what changes first (the agent's counts and latest action), then the flow, then the block and the
    // run's own time
    expect(progressWords(p, ' · ')).toBe('agent a1a2b3c4d: 4 tool calls, 1 message so far; latest: tool edit box.params.json · flow f1a2b3c4d (/iterate scad) in its agent step · change · run 1 min 30 s');
    expect(progressWords({ ended: 1, of: 3, elapsedMs: 15_000 }, ' · ')).toBe('1 of 3 blocks ended · run 15 s');
    expect(progressWords({ ended: 0, of: 1, elapsedMs: 15_000, agent: { run: 'a1a2b3c4d', tools: 0, messages: 0 } }, ' · ')).toBe('agent a1a2b3c4d: no tool call or message in its progress log yet · 0 of 1 block ended · run 15 s');
    // a line cut at 80 or 100 columns keeps what moved: the agent's counts and its latest action come first
    const line = `  ● j0a0b0c  still running: ${progressWords(p, ' · ')}`;
    expect(line.slice(0, 80)).toContain('agent a1a2b3c4d: 4 tool calls, 1 message so far');
    expect(line.slice(0, 100)).toContain('latest: tool edit');
    // the latest line is cut, never the counts
    const long = progressWords({ ended: 0, of: 1, elapsedMs: 0, agent: { run: 'a1a2b3c4d', tools: 1, messages: 0, latest: `says ${'x'.repeat(300)}` } }, ' · ');
    expect(long).toMatch(new RegExp(`^agent a1a2b3c4d: 1 tool call, 0 messages so far; latest: says x+… · 0 of 1 block ended · run 0 s$`));
  });
});

describe('when a line is printed (FAKE clock, records written by hand in Timmy\'s shapes)', () => {
  const start = Date.parse('2026-10-11T10:00:00.000Z');
  const job = (steps: JobRecord['steps'], state: JobRecord['state'] = 'running'): JobRecord => ({
    id: 'j0a0b0c', kind: 'workflow', label: 'W.md › b', project: 'p', root: '/', command: 'upmd', args: [], state, startedAt: new Date(start).toISOString(), steps, logPath: '/dev/null',
  } as unknown as JobRecord);

  it('a block\'s start at once; a line each quietMs while nothing changes; nothing once the job ended', () => {
    let now = start;
    let j = job([]);
    const lines: string[] = [];
    const rp = new RunProgress({ jobs: { get: () => j }, notify: (l) => lines.push(l.map((x) => x.text).join('')), glyphs: g, scrub: (t) => t, now: () => now, tickMs: 1e9, quietMs: 15_000, minGapMs: 2000 });
    rp.follow('j0a0b0c', { root: os.tmpdir(), order: ['a', 'b'], live: true });
    const at = (s: number): void => { now = start + s * 1000; rp.tick(); };
    at(0.5); // nothing to say yet: no block has started
    j = job([{ name: 'a', state: 'running' }]);
    at(1);
    at(2); at(10); at(15.9); // quiet, under 15 s since the last line
    at(16);
    j = job([{ name: 'a', state: 'completed', code: 0 }, { name: 'b', state: 'running' }]);
    at(16.5); // b started: at once, however close to the last line
    at(31); at(31.5);
    j = job([{ name: 'a', state: 'completed', code: 0 }, { name: 'b', state: 'completed', code: 0 }], 'completed');
    at(50);
    expect(lines).toEqual([
      `  ${g.bullet} j0a0b0c  running: a ${g.sep} run 1 s`,
      `  ${g.bullet} j0a0b0c  still running: a ${g.sep} run 16 s`,
      `  ${g.bullet} j0a0b0c  running: b ${g.sep} run 16 s`,
      `  ${g.bullet} j0a0b0c  still running: b ${g.sep} run 31 s`,
    ]);
    expect(rp.following()).toEqual([]);
    rp.stopAll();
  });

  it('the flow\'s step and the agent\'s progress from their own records; a change closer than minGapMs waits; over a pipe no block is named', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'run-progress-')));
    kit.dirs.push(root);
    const op = 'o1a2b3c4d';
    const put = (rel: string, body: string): void => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), body); };
    const flowState = (step: string): void => put('.timmy/flows/f1a2b3c4d/state.json', JSON.stringify({ schema: 'timmy.flow/1', id: 'f1a2b3c4d', kind: 'iterate', target: 'scad', operation: op, outcome: 'running', step }));
    flowState('agent');
    put('.timmy/agents/a1a2b3c4d/run.json', JSON.stringify({ agent_run: 1, run: 'a1a2b3c4d', agent: 'qwen', job: 'j0a0b0d', operation: op, started_at: new Date(start).toISOString(), state: 'submitted' }));
    put('.timmy/agents/a1a2b3c4d/progress.log', 'started  model qwen3:4b\nsays  I will make it wider.\n');
    // another operation's flow and agent are not this run's
    put('.timmy/flows/f99999999/state.json', JSON.stringify({ schema: 'timmy.flow/1', id: 'f99999999', kind: 'iterate', target: 'tray', operation: 'o99999999', outcome: 'running', step: 'build' }));
    let now = start;
    const j = job([]);
    const lines: string[] = [];
    const rp = new RunProgress({ jobs: { get: () => j }, notify: (l) => lines.push(l.map((x) => x.text).join('')), glyphs: g, scrub: (t) => t, now: () => now, tickMs: 1e9, quietMs: 15_000, minGapMs: 2000 });
    rp.follow('j0a0b0c', { root, operation: op, order: ['change'], live: false });
    const at = (s: number): void => { now = start + s * 1000; rp.tick(); };
    at(1);
    fs.appendFileSync(path.join(root, '.timmy/agents/a1a2b3c4d/progress.log'), 'tool  edit  box.params.json\n');
    at(1.5); // under minGapMs since the last line: it waits
    at(3.1);
    // the agent ended (its run record says so) and the flow went on to its readback
    put('.timmy/agents/a1a2b3c4d/run.json', JSON.stringify({ agent_run: 1, run: 'a1a2b3c4d', agent: 'qwen', job: 'j0a0b0d', operation: op, started_at: new Date(start).toISOString(), state: 'ended', outcome: 'completed' }));
    flowState('readback');
    at(5.5);
    at(21);
    // the flow has its record: it ended, as its record says
    put('results/flows/f1a2b3c4d.json', JSON.stringify({ schema: 'timmy.flow/1', id: 'f1a2b3c4d', outcome: 'no change' }));
    at(23.5);
    expect(lines).toEqual([
      `  ${g.bullet} j0a0b0c  running: agent a1a2b3c4d: 0 tool calls, 1 message so far; latest: says I will make it wider. ${g.sep} flow f1a2b3c4d (/iterate scad) in its agent step ${g.sep} 0 of 1 block ended ${g.sep} run 1 s`,
      `  ${g.bullet} j0a0b0c  running: agent a1a2b3c4d: 1 tool call, 1 message so far; latest: tool edit box.params.json ${g.sep} flow f1a2b3c4d (/iterate scad) in its agent step ${g.sep} 0 of 1 block ended ${g.sep} run 3 s`,
      `  ${g.bullet} j0a0b0c  running: flow f1a2b3c4d (/iterate scad) in its readback step ${g.sep} 0 of 1 block ended ${g.sep} run 5 s`,
      `  ${g.bullet} j0a0b0c  still running: flow f1a2b3c4d (/iterate scad) in its readback step ${g.sep} 0 of 1 block ended ${g.sep} run 21 s`,
      `  ${g.bullet} j0a0b0c  running: flow f1a2b3c4d (/iterate scad) ended: no change ${g.sep} 0 of 1 block ended ${g.sep} run 23 s`,
    ]);
    rp.stopAll();
  });

  it('a flow that ended in an earlier block is not said of the blocks after it', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'run-progress-')));
    kit.dirs.push(root);
    const op = 'o1a2b3c4d';
    const put = (rel: string, body: string, at: number): void => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), body);
      fs.utimesSync(path.join(root, rel), new Date(at), new Date(at));
    };
    put('.timmy/flows/f1a2b3c4d/state.json', JSON.stringify({ schema: 'timmy.flow/1', id: 'f1a2b3c4d', kind: 'iterate', target: 'scad', operation: op, outcome: 'succeeded', step: 'done' }), start + 9000);
    put('results/flows/f1a2b3c4d.json', JSON.stringify({ schema: 'timmy.flow/1', id: 'f1a2b3c4d', outcome: 'succeeded' }), start + 10_000);
    let now = start;
    let j = job([{ name: 'change', state: 'running' }]);
    const lines: string[] = [];
    const rp = new RunProgress({ jobs: { get: () => j }, notify: (l) => lines.push(l.map((x) => x.text).join('')), glyphs: g, scrub: (t) => t, now: () => now, tickMs: 1e9, quietMs: 15_000, minGapMs: 2000 });
    rp.follow('j0a0b0c', { root, operation: op, order: ['change', 'inspect'], live: true });
    const at = (s: number): void => { now = start + s * 1000; rp.tick(); };
    at(11); // change runs, its flow has ended
    j = job([{ name: 'change', state: 'completed', code: 0 }, { name: 'inspect', state: 'running' }]);
    at(12);
    at(28);
    expect(lines).toEqual([
      `  ${g.bullet} j0a0b0c  running: flow f1a2b3c4d (/iterate scad) ended: succeeded ${g.sep} change ${g.sep} run 11 s`,
      `  ${g.bullet} j0a0b0c  running: inspect ${g.sep} run 12 s`,
      `  ${g.bullet} j0a0b0c  still running: inspect ${g.sep} run 28 s`,
    ]);
    rp.stopAll();
  });
});

describe('what a look reads (R4 H99, the review: every flow\'s state file and every agent\'s record, each second)', () => {
  it('only this run\'s records, each again only when its time or size changed; records of before the run are not read', () => {
    const start = Date.now();
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'run-progress-reads-')));
    kit.dirs.push(root);
    const op = 'o1a2b3c4d';
    const put = (rel: string, body: string, at?: number): string => {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
      if (at !== undefined) fs.utimesSync(abs, new Date(at), new Date(at));
      return abs;
    };
    const flowState = (id: string, operation: string, step: string, at?: number): string => put(`.timmy/flows/${id}/state.json`, JSON.stringify({ schema: 'timmy.flow/1', id, kind: 'iterate', target: 'scad', operation, outcome: 'running', step }), at);
    // FAKE records in Timmy's shapes: two of before the run, one of another operation during it, and this run's own
    const old = flowState('f00000001', 'o99999999', 'agent', start - 60_000);
    const oldAgent = put('.timmy/agents/a00000001/run.json', JSON.stringify({ agent_run: 1, run: 'a00000001', operation: 'o99999999', state: 'submitted' }), start - 60_000);
    const other = flowState('f00000002', 'o99999999', 'agent');
    const mine = flowState('f00000003', op, 'agent');
    const agent = put('.timmy/agents/a00000003/run.json', JSON.stringify({ agent_run: 1, run: 'a00000003', operation: op, state: 'submitted' }));
    put('.timmy/agents/a00000003/progress.log', 'says  working on it\n');
    const j = { id: 'j0a0b0c', kind: 'workflow', label: 'W.md › b', project: 'p', root: '/', command: 'upmd', args: [], state: 'running', startedAt: new Date(start).toISOString(), steps: [], logPath: '/dev/null' } as unknown as JobRecord;
    const lines: string[] = [];
    const rp = new RunProgress({ jobs: { get: () => j }, notify: (l) => lines.push(l.map((x) => x.text).join('')), glyphs: g, scrub: (t) => t, tickMs: 1e9, quietMs: 1e9, minGapMs: 0 });
    rp.follow('j0a0b0c', { root, operation: op, order: ['b'], live: false });
    const reads = vi.spyOn(fs, 'readFileSync');
    const readsOf = (abs: string): number => reads.mock.calls.filter((c) => c[0] === abs).length;
    try {
      rp.tick(); rp.tick(); rp.tick();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('flow f00000003 (/iterate scad) in its agent step');
      expect(readsOf(old)).toBe(0);
      expect(readsOf(oldAgent)).toBe(0);
      expect(readsOf(other)).toBe(1);
      expect(readsOf(mine)).toBe(1);
      expect(readsOf(agent)).toBe(1);
      // this run's flow moves on: its state file is read again, once
      flowState('f00000003', op, 'readback');
      rp.tick(); rp.tick();
      expect(readsOf(mine)).toBe(2);
      expect(readsOf(other)).toBe(1);
      expect(lines.at(-1)).toContain('flow f00000003 (/iterate scad) in its readback step');
    } finally {
      reads.mockRestore();
      rp.stopAll();
    }
  });
});

describe('/run says how it goes while it runs (FAKE upmd, agent and OpenSCAD; real child processes)', () => {
  it.skipIf(!PYTHON3)('on a pty: each block as it starts, a line while it runs, its end from the job\'s own notice, and nothing after the run ended', async () => {
    const s = opsSandbox(kit, 'run-progress-pty-');
    const { ws, notes } = repl(kit, s, { onPath: (cmd) => (cmd === 'python3' ? PYTHON3 : null), runProgress: { tickMs: 100, quietMs: 1000, minGapMs: 300 } });
    fs.writeFileSync(path.join(s.root, 'SLOW.md'), ['# FAKE workflow for the progress test', '', `${F}bash [name:first]`, 'sleep 2.6', F, '', `${F}bash [name:second, deps:first]`, 'sleep 0.8', F, ''].join('\n'));
    const out = text(await ws.operate('/run SLOW.md second', 'repl', () => ws.run('SLOW.md second')));
    expect(out).not.toMatch(/Live block states are not available/);
    const job = /Running\s+(j[0-9a-f]{6})/.exec(out)![1];
    const done = await ws.jobs.done(job);
    expect(done.state, ws.jobs.tail(job, 100).join('\n')).toBe('completed');
    const ended = notes.length;
    await sleep(600); // a few more looks: nothing is said of a run that ended
    expect(notes.length).toBe(ended);
    const lines = progressOf(notes, job);
    // the first block as it started, then while it ran (at most one line a second here), then the second as it started
    expect(lines[0]).toMatch(new RegExp(`^  ${g.bullet} ${job}  running: first ${g.sep} run [01] s$`));
    const still = lines.filter((l) => l.includes(`still running: first ${g.sep} run `));
    expect(still.length, lines.join('\n')).toBeGreaterThanOrEqual(1);
    expect(still.length, lines.join('\n')).toBeLessThanOrEqual(3);
    expect(lines.some((l) => new RegExp(`^  ${g.bullet} ${job}  running: second ${g.sep} run [2-4] s$`).test(l)), lines.join('\n')).toBe(true);
    // in order with the job's own notices: first's end is the job's notice, between first's lines and second's start
    const firstEnd = notes.findIndex((n) => n.startsWith(`  ${g.bullet} ${job}  first completed`));
    const secondStart = notes.findIndex((n) => n.includes(`${job}  running: second`));
    const lastFirst = notes.map((n, i) => (n.includes(`${job}  still running: first`) ? i : -1)).filter((i) => i >= 0).at(-1)!;
    expect(lastFirst).toBeLessThan(firstEnd);
    expect(firstEnd).toBeLessThan(secondStart);
    expect(notes.findIndex((n) => n.startsWith(`  ${g.ok} ${job} completed`))).toBeGreaterThan(secondStart);
  }, 60_000);

  it('over a pipe, a block\'s `timmy act`: its flow\'s step and its agent\'s progress from their own records; no block named; /stop ends the lines', async () => {
    const s = opsSandbox(kit, 'run-progress-act-');
    const { ws, notes } = repl(kit, s, { runProgress: { tickMs: 100, quietMs: 1500, minGapMs: 300 } });
    const { root } = s;
    const run = async (doc: string, code: string): Promise<{ job: string; op: string }> => {
      fs.writeFileSync(path.join(root, doc), ['# FAKE workflow for the progress test', '', `${F}bash [name:change]`, code, F, ''].join('\n'));
      const out = text(await ws.operate(`/run ${doc} change`, 'repl', () => ws.run(`${doc} change`)));
      expect(out).toMatch(/Live block states are not available/); // a pipe: blocks are seen only as they end
      return { job: /Running\s+(j[0-9a-f]{6})/.exec(out)![1], op: /Operation\s+(o[0-9a-f]{8})/.exec(out)![1] };
    };
    const stopAndSettle = async (job: string): Promise<void> => {
      await ws.stop(job);
      await ws.jobs.done(job);
      const ended = notes.length;
      await sleep(500);
      expect(progressOf(notes.slice(ended), job)).toEqual([]);
    };

    // 1. The agent in its agent step (SLEEP): the flow and the agent, read from their records, then a quiet line.
    const a = await run('AGENT.md', 'timmy act \'/iterate scad box.scad "make it wider SLEEP"\' --wait');
    const agentLine = new RegExp(`^  ${g.bullet} ${a.job}  still running: agent (a[0-9a-f]{8}): 0 tool calls, 1 message so far; latest: says Thinking for a long time \\(a FAKE\\)\\. ${g.sep} flow (f[0-9a-f]{8}) \\(/iterate scad\\) in its agent step ${g.sep} 0 of 1 block ended ${g.sep} run \\d+ s$`);
    await until(() => progressOf(notes, a.job).some((l) => agentLine.test(l)), 60_000, 'a still running line naming the flow and the agent');
    const lines = progressOf(notes, a.job);
    const [, agent, flow] = agentLine.exec(lines.find((l) => agentLine.test(l))!)!;
    // the flow and the agent are the run's own: its operation is in their records
    expect(JSON.parse(fs.readFileSync(path.join(root, '.timmy', 'flows', flow, 'state.json'), 'utf8'))).toMatchObject({ operation: a.op, target: 'scad' });
    expect(JSON.parse(fs.readFileSync(path.join(root, '.timmy', 'agents', agent, 'run.json'), 'utf8'))).toMatchObject({ operation: a.op });
    // a line came as the agent's step began, before the quiet one
    expect(lines.findIndex((l) => l.includes(`${a.job}  running: `) && l.includes(`flow ${flow} (/iterate scad) in its agent step`))).toBeGreaterThanOrEqual(0);
    // the time it has run, as the lines go on, never goes back
    const secs = lines.map((l) => Number(/run (\d+) s$/.exec(l)?.[1]));
    expect(secs).toEqual([...secs].sort((x, y) => x - y));
    // over a pipe, the block that runs is never named
    expect(lines.filter((l) => /running: change/.test(l))).toEqual([]);
    await stopAndSettle(a.job);

    // 2. The agent edits and OpenSCAD runs (FAKE, `hang`): the flow's step as its state file says it, the agent no more.
    const b = await run('BUILD.md', 'FAKE_OPENSCAD_MODE=hang timmy act \'/iterate scad box.scad "make it 100 wide PYFILE:box.params.json PYREPLACE:60,=>100,"\' --wait');
    const buildLine = new RegExp(`^  ${g.bullet} ${b.job}  (still )?running: flow f[0-9a-f]{8} \\(/iterate scad\\) in its openscad step ${g.sep} 0 of 1 block ended ${g.sep} run \\d+ s$`);
    await until(() => progressOf(notes, b.job).some((l) => buildLine.test(l)), 60_000, 'a line naming the flow in its OpenSCAD step');
    await stopAndSettle(b.job);
  }, 180_000);
});
