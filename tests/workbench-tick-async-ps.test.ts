// R10 (H163; the turn-holds latency, the lead's item (e)): no synchronous program runs on the Workbench's event loop during a tick
// or a frame build. The process table is read as a child the loop does not wait on (src/ops/process-proof.ts readProcessTable),
// and the tick's readings and the frame's proofs look each writer up in the table so read (withProcessTable with a given table).
// Before, a frame build ran ps -A and ps -p and a tick ran ps -p (the journey's turns being answered), each stopping the loop:
// on a loaded computer 0.1 to 0.5 s in which no timer, key or redraw ran (the turn-3 failure of
// tests/workbench-turn-holds-pty.test.ts). A pid a given table does not list is no proof that its writer runs: a writer that
// started before the table was read would be listed, so it is gone (its pid is another process's now); one that started after
// is unknown, taken as running, until the next reading says.
//
// FAKE pieces, labelled: `ps` is a FAKE on PATH (a script this test writes) that answers as ps does, 300 ms late, and logs when
// each run began and ended: `ps -A` lists the processes this test says the table holds (pid: when it started), `ps -p` answers for
// every process this test started (a process that started after a table was read is not in that table, and ps -p knows it); the
// holds' writers are processes this test starts (sleep). Everything else is the real Workbench Controller and workspace frame over a Timmy home in a temporary
// folder, a tray-workflow project made by the starter code.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CHAT_HOLD_SCHEMA, CHAT_TURNS_DIR } from '../src/agent/chat-turn.js';
import { useProcessTableReader, withProcessTable, writerState } from '../src/ops/process-proof.js';
import { buildWorkspaceFrame } from '../src/ops/workspace-frame.js';
import { createProject, projectId, saveActiveProject } from '../src/project/index.js';
import { copyStarter } from '../src/project/starters.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import { visibleWidth } from '../src/term/width.js';
import { Controller } from '../src/workbench/controller.js';
import { glyphsFor, screenText } from '../src/workbench/frame.js';
import { CompanionControl, StudioControl, type Opener } from '../src/workbench/servers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FAKE_OPENER: Opener = { program: null, open: () => ({ ok: false, why: 'FAKE opener: nothing is opened in this test' }) };
const FAKE_PS_MS = 300;

let box = '';
let home = '';
let jobsDir = '';
let psLog = '';
let psTable = '';
const kids: ChildProcess[] = [];
/** every process this test started, with when it started: what `ps -p` answers */
const live: Record<number, number> = {};
const opened: Controller[] = [];
const spaces: Workspace[] = [];

beforeAll(() => {
  box = mkdtempSync(join(tmpdir(), 'wb-async-ps-'));
  home = join(box, 'timmy');
  jobsDir = join(home, 'jobs');
  mkdirSync(home, { recursive: true });
  // FAKE ps: answers as ps does (-A -o pid= -o etime=, or -o etime= -p <pid>), FAKE_PS_MS late: -A from the table this test sets,
  // -p from every process it started ({ pid: when that process started, ms }); logs when each run began and ended
  const bin = join(box, 'fakebin');
  mkdirSync(bin);
  psLog = join(box, 'ps-runs.jsonl');
  psTable = join(box, 'ps-table.json');
  writeFileSync(psTable, JSON.stringify({ listed: {}, live: {} }));
  writeFileSync(join(bin, 'ps'), `#!${process.execPath}
// FAKE ps (tests/workbench-tick-async-ps.test.ts)
const fs = require('node:fs');
const began = Date.now();
setTimeout(() => {
  const { listed, live } = JSON.parse(fs.readFileSync(${JSON.stringify(psTable)}, 'utf8'));
  const args = process.argv.slice(2);
  const etime = (ms) => { const s = Math.max(0, Math.floor((Date.now() - ms) / 1000)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
  let out = '';
  if (args.includes('-A')) out = Object.entries(listed).map(([pid, ms]) => pid.padStart(7) + ' ' + etime(ms) + '\\n').join('');
  else { const pid = args[args.indexOf('-p') + 1]; const ms = live[pid] ?? listed[pid]; if (ms === undefined) process.exitCode = 1; else out = etime(ms) + '\\n'; }
  process.stdout.write(out);
  fs.appendFileSync(${JSON.stringify(psLog)}, JSON.stringify({ began, ended: Date.now(), args: args.join(' ') }) + '\\n');
}, ${FAKE_PS_MS});
`, { mode: 0o755 });
  vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
});
afterAll(() => { vi.unstubAllEnvs(); rmSync(box, { recursive: true, force: true }); });
afterEach(async () => {
  for (const c of opened.splice(0)) c.dispose();
  for (const ws of spaces.splice(0)) await ws.close({ by: 'as the test ended' });
  for (const k of kids.splice(0)) k.kill('SIGKILL');
});

/** A writer of holds: a process this test starts, with when it started (as the process table would give it). */
function writer(): { pid: number; startedMs: number; started: string } {
  const startedMs = Date.now();
  const k = spawn('sleep', ['60'], { stdio: 'ignore' });
  kids.push(k);
  live[k.pid!] = startedMs;
  return { pid: k.pid!, startedMs, started: new Date(startedMs).toISOString() };
}
/** The FAKE ps's table (ps -A): these processes, with when each started; ps -p answers for every process this test started. */
const psLists = (listed: Record<number, number>): void => writeFileSync(psTable, JSON.stringify({ listed, live }));
const psRuns = (): Array<{ began: number; ended: number; args: string }> =>
  (existsSync(psLog) ? readFileSync(psLog, 'utf8') : '').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { began: number; ended: number; args: string });

/** A timer every 10 ms, queued now: when each fired. */
function ticking(): () => number[] {
  const at: number[] = [];
  const t = setInterval(() => at.push(Date.now()), 10);
  return () => { clearInterval(t); return at; };
}
/** Each FAKE ps run since `from`, and whether the 10 ms timer fired while it ran (the event loop was not waiting on it). */
function loopFreeDuring(ticks: readonly number[], from: number): Array<{ args: string; ms: number; firedWhileItRan: boolean }> {
  return psRuns().filter((r) => r.began >= from).map((r) => ({ args: r.args, ms: r.ended - r.began, firedWhileItRan: ticks.some((t) => t > r.began + 60 && t < r.ended - 60) }));
}

function trayProject(name: string): { name: string; root: string; chosen: boolean } {
  vi.stubEnv('TIMMY_HOME', home);
  vi.stubEnv('TIMMY_SETTINGS_DIR', join(box, 'settings'));
  vi.stubEnv('OPENROUTER_API_KEY', '');
  const made = createProject(name);
  if ('error' in made) throw new Error(made.error);
  const copied = copyStarter('tray-workflow', made.root);
  if ('error' in copied) throw new Error(copied.error);
  saveActiveProject(made);
  mkdirSync(join(made.root, '.timmy'), { recursive: true });
  writeFileSync(join(made.root, '.timmy', 'store-pin'), join(made.root, '.timmy', 'receipts'));
  return made;
}

/** A chat hold "in the REPL", written as the REPL writes one, for `w`'s process; `ageMs`: its file that much older. */
function holdOf(p: { root: string }, w: { pid: number; started: string }, tag: string, ageMs = 0): string {
  const dir = join(p.root, CHAT_TURNS_DIR);
  mkdirSync(dir, { recursive: true });
  const name = `t${w.pid}-${tag}.json`;
  writeFileSync(join(dir, name), `${JSON.stringify({ schema: CHAT_HOLD_SCHEMA, surface: 'repl', owner: { pid: w.pid, started: w.started }, taken: w.started })}\n`);
  if (ageMs) utimesSync(join(dir, name), new Date(Date.now() - ageMs), new Date(Date.now() - ageMs));
  return name.slice(0, -5);
}

/** A Workbench on the project whose holds' watch never looks on its own: only its ticks and frame builds read here. */
function workbench(p: { name: string; root: string; chosen: boolean }): Controller {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.TIMMY_STORE;
  const ws = new Workspace({ glyphs: glyphSet(true), env, onPath: () => null, notify: () => undefined, openWeb: () => '', link: (t) => t, seal: () => undefined, jobsDir, recoverAtStart: false, chdir: () => undefined }, p);
  spaces.push(ws);
  const c = new Controller({
    env, jobsDir, onPath: () => null, glyphs: glyphsFor(true), workspace: ws,
    producers: { runDetail: async () => ({ ok: false, why: 'FIXTURE: none' }), openChat: async () => ({ ok: false, why: 'FIXTURE: no chat session in this test' }) },
    companion: new CompanionControl({ opener: FAKE_OPENER, start: async () => { throw new Error('FAKE: no server is started in this test'); } }),
    studio: new StudioControl({ env: process.env, opener: FAKE_OPENER, project: () => ws.project, projectId, jobsDir, receipts: () => join(box, 'store'), ensure: async () => ({ state: 'failed', error: 'FAKE: no Studio in this test' }) }),
    capabilities: async () => [], tickMs: 100, slowMs: 3_600_000, holdsEveryMs: 3_600_000, holdWatch: false,
  });
  opened.push(c);
  return c;
}

async function until<T>(what: string, get: () => T | undefined | false | null, ms = 15_000, show?: () => string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}${show ? `:\n${show()}` : ''}`);
    await sleep(20);
  }
}

/** Row 2's words as drawn at 160x45 (through its bottom edge: the run state and Stop current). */
function top(c: Controller): string {
  const fr = c.frame(160, 45);
  const rect = fr.regions.top!.rect;
  const text = screenText(fr.screen);
  const out: string[] = [];
  for (let y = rect.y + 1; y <= rect.y + rect.h - 1; y++) {
    let x = 0;
    let row = '';
    for (const ch of text[y] ?? '') { if (x > rect.x && x < rect.x + rect.w - 1) row += ch; x += visibleWidth(ch); }
    out.push(y === rect.y + rect.h - 1 ? row.replace(/[─━]/g, ' ') : row);
  }
  return out.join(' ').replace(/\s+/g, ' ');
}
const turnsBeingAnswered = (c: Controller): string[] => (c.data.recent?.items ?? []).filter((i) => i.kind === 'turn' && i.state === 'running').map((i) => i.id);

describe('no program the Workbench\'s event loop waits on during a tick or a frame build (R10 H163; the turn-holds latency, item (e))', () => {
  it('a frame build reads the process table without stopping the loop (a timer queued before it fires while the FAKE ps runs), and names another process\'s turn from that reading', async () => {
    const p = trayProject('async-frame');
    const w = writer();
    psLists({ [w.pid]: w.startedMs });
    const id = holdOf(p, w, '0000aaaa');
    const from = Date.now();
    const stop = ticking();
    const f = await buildWorkspaceFrame({ cwd: p.root, project: { name: p.name, root: p.root }, env: process.env, jobs: () => [], onPath: () => null });
    const ticks = stop();
    const runs = loopFreeDuring(ticks, from);
    expect(runs.length, 'the FAKE ps ran for the frame').toBeGreaterThan(0);
    expect(runs.filter((r) => !r.firedWhileItRan), 'ps runs the event loop waited on (no 10 ms timer fired while they ran)').toEqual([]);
    expect(f.activity.chatTurn?.id).toBe(id);
  }, 60_000);

  it('a Workbench tick reads the process table without stopping the loop: after a tick that reads the journey, Studio\'s cards and the frame again, a timer queued before it fires while each FAKE ps runs', async () => {
    const p = trayProject('async-tick');
    const w = writer();
    psLists({ [w.pid]: w.startedMs });
    const id = holdOf(p, w, '0000bbbb');
    const c = workbench(p);
    c.start();
    await until('the frame naming the REPL\'s turn', () => c.data.frame?.activity.chatTurn?.id === id, 15_000, () => top(c));
    await until('the journey naming it being answered', () => turnsBeingAnswered(c).includes(id), 15_000);
    await sleep(1200);   // past the frame's once-a-second bound: the tick below builds a frame too
    const from = Date.now();
    const stop = ticking();
    c.say('FIXTURE: a notice, so the next tick reads the journey, the cards and the frame again');
    await sleep(2000);
    const ticks = stop();
    const runs = loopFreeDuring(ticks, from);
    expect(runs.length, 'the FAKE ps ran for the tick').toBeGreaterThan(0);
    expect(runs.filter((r) => !r.firedWhileItRan), 'ps runs the event loop waited on (no 10 ms timer fired while they ran)').toEqual([]);
    expect(top(c)).toContain('run: 1 running (the chat turn in the REPL)');
    expect(turnsBeingAnswered(c)).toEqual([id]);
  }, 60_000);

  it('a pid a given table does not list never makes a stopped turn a running one: a writer that started before the table was read would be listed, so it is gone; one that started after is unknown until the next reading; no program runs for either', () => {
    const listedOne = writer();
    const other = writer();
    let programs = 0;
    const put = useProcessTableReader({ all: () => { programs++; return undefined; }, one: () => { programs++; return undefined; } });
    try {
      const at = Date.now();
      const table = { rows: new Map([[listedOne.pid, 0]]), at };
      const hourAgo = new Date(at - 3_600_000).toISOString();
      const state = (owner: { pid: number; started: string }) => withProcessTable(() => writerState(owner), table);
      expect(state({ pid: listedOne.pid, started: new Date(at).toISOString() }), 'listed, started then').toBe('alive');
      expect(state({ pid: listedOne.pid, started: hourAgo }), 'listed, started at another time: its pid was reused').toBe('gone');
      expect(state({ pid: other.pid, started: hourAgo }), 'not listed, started before the table was read: it would be listed').toBe('gone');
      expect(state({ pid: other.pid, started: new Date(at + 1000).toISOString() }), 'not listed, started after the table was read').toBe('unknown');
      expect(state({ pid: 2 ** 22 + 11, started: new Date(at).toISOString() }), 'no process with its pid').toBe('gone');
      expect(withProcessTable(() => writerState({ pid: other.pid, started: hourAgo }), { rows: null, at }), 'ps could not answer: unknown, as before').toBe('unknown');
      expect(programs, 'programs run for these proofs').toBe(0);
    } finally { put(); }
  });

  it('what the Workbench says, from a table that does not list a pid: a hold left by a turn whose writer ended (its pid another process\'s now) is no running turn; a hold whose writer started after the table is taken as running until the next real reading, which lets it go once that reading proves its writer ended', async () => {
    // 1. a turn that ended long ago left its hold; its pid is now another live process, which the table does not list
    const p = trayProject('async-stopped');
    const reused = writer();
    psLists({});
    holdOf(p, { pid: reused.pid, started: new Date(Date.now() - 3_600_000).toISOString() }, '0000cccc', 3_600_000);
    const c = workbench(p);
    c.start();
    await until('the frame', () => c.data.frame, 15_000, () => top(c));
    await until('the first table read', () => psRuns().some((r) => r.args.includes('-A')), 15_000);
    await sleep(500);
    c.say('FIXTURE: a notice, so the next tick reads the journey and the frame again, against the table as read');
    await sleep(1500);   // that tick and its readings since
    expect(c.data.frame!.activity.chatTurn, 'the frame names no turn').toBeNull();
    expect(turnsBeingAnswered(c), 'the journey lists no turn being answered').toEqual([]);
    expect(top(c)).toContain('run: idle');
    expect(top(c)).toContain('Stop current: idle');
    c.dispose();

    // 2. a hold whose writer started after the table was read: taken as running (unknown); then the next real reading lists its
    // pid as a process that started at another time (its writer ended, the pid reused): the Workbench lets the turn go
    const q = trayProject('async-released');
    const w = writer();
    psLists({});
    // (its writer named as starting 2.5 s after this sleep: well after any table read before it, whatever the load)
    const id = holdOf(q, { pid: w.pid, started: new Date(w.startedMs + 2500).toISOString() }, '0000dddd');
    const d = workbench(q);
    d.start();
    await until('the frame naming the turn (its writer not listed yet: unknown, taken as running)', () => d.data.frame?.activity.chatTurn?.id === id, 15_000, () => top(d));
    live[w.pid] = Date.now() - 3_600_000;
    psLists({ [w.pid]: live[w.pid] });
    d.say('FIXTURE: a notice, so the next tick reads again');
    await until('the next real reading letting the turn go', () => d.data.frame?.activity.chatTurn === null && !turnsBeingAnswered(d).includes(id), 15_000, () => `${top(d)}\nthe frame's turn: ${JSON.stringify(d.data.frame?.activity.chatTurn ?? null)}; being answered: ${JSON.stringify(turnsBeingAnswered(d))}`);
    expect(top(d)).toContain('run: idle');
  }, 90_000);
});
