/**
 * R8 (H155): the Control Room's panes on the companion (tab 7; src/companion/panels/control.ts over src/ops/panes.ts), through
 * the real companion server on 127.0.0.1 and its token: the shown project's panes by the Workbench's rule (what runs first, a
 * chat turn being answered among them, then the newest ended in the slots left), each with its run name, its state, its log's
 * last lines, its exit and its receipt (verified only when verifyReceiptIn confirms it in this reading: one changed on its
 * chain is "does not verify", never verified), and the stop words as the workspace frame gives them; more running than four:
 * the first four, and how many more run; the refusals (no token, a project the companion does not know).
 *
 * REAL here: the server, its token check, the job store's jobs (sh and sleep, in this file's Timmy home) and their logs, the
 * receipts the job store's seal wrote into this test's own store (TIMMY_STORE) and the verifier; a chat turn's hold taken by
 * this process (as a REPL turn takes it); the workspace frame (src/ops/workspace-frame.ts, made by the companion).
 * FAKE here: the projects (folders named FAKE-…), the jobs' labels and what they print, and one receipt changed on its chain by
 * the test (its subject edited in the store's file).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { takeTurnHold } from '../src/agent/chat-turn.js';
import { startCompanionServer, type CompanionServer } from '../src/companion/server.js';
import { TABS, type WorkspaceFrame } from '../src/contracts/workspace.js';
import { JobManager } from '../src/jobs/index.js';
import { PANES_MAX, TAIL_MAX } from '../src/ops/panes.js';
import { projectId } from '../src/project/index.js';
import { appendReceipt, receiptsPath } from '../src/utils/receipts.js';

const TOKEN = 'c7'.repeat(32);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, get: () => T | undefined | false | null, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(25);
  }
}

interface Pane {
  kind: 'job' | 'turn'; id: string; name: string; quiet: boolean; state: { glyph: string; word: string; failed: boolean };
  who: string; from?: string; since: string; operation: string | null; noDetail?: string; tail: { lines: string[] } | { why: string }; every?: number;
  exit?: string; receipt?: { id: string | null; state: string; words: string }; stop?: { words: string; command?: string };
}
interface Panes { ok: true; schema: string; every: number; running: number; more: number; panes: Pane[]; stop: { words: string; command: string | null } | null; project: { id: string; name: string }; notes: string[] }

describe('the Control Room\'s panes on the companion (R8 H155)', () => {
  const kept = { TIMMY_HOME: process.env.TIMMY_HOME, TIMMY_REPO: process.env.TIMMY_REPO };
  let box = '';
  let companion: CompanionServer;
  const managers: JobManager[] = [];

  beforeAll(async () => {
    box = mkdtempSync(join(tmpdir(), 'r8-control-panel-'));
    process.env.TIMMY_HOME = join(box, 'home');
    delete process.env.TIMMY_REPO;
    mkdirSync(join(box, 'home', 'projects'), { recursive: true });
    companion = await startCompanionServer(0, { token: TOKEN, workspace: { env: { TIMMY_HOME: process.env.TIMMY_HOME, TIMMY_SETTINGS_DIR: join(box, 'settings') }, shareMs: 0 } });
  }, 60_000);
  afterEach(async () => { for (const m of managers.splice(0)) await m.stopAll(); });
  afterAll(async () => {
    await companion?.shutdown();
    for (const [k, v] of Object.entries(kept)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    if (box) rmSync(box, { recursive: true, force: true });
  });

  const project = (name: string): { root: string; id: string } => {
    const root = join(process.env.TIMMY_HOME!, 'projects', name);
    mkdirSync(root, { recursive: true });
    return { root, id: projectId(root) };
  };
  /** REAL: the job store in this file's Timmy home (the companion reads it there), sealing each ended job into this test's store. */
  const store = (name: string, root: string): JobManager => {
    const m = new JobManager({
      dir: join(process.env.TIMMY_HOME!, 'jobs'),
      seal: (j) => appendReceipt('runs', { kind: 'run', subject: `task · ${j.label} · ${j.state}`, policy: 'human-gated', status: j.state === 'completed' ? 'ok' : 'failed', project: name, project_id: projectId(root), job: { id: j.id, kind: j.kind, label: j.label, state: j.state, exit_code: j.exitCode ?? null }, spans: [], artifacts: [] }).hash.slice(7, 15),
    });
    managers.push(m);
    return m;
  };
  const get = (path: string, token: string | null = TOKEN): Promise<Response> => fetch(new URL(path, companion.address), { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const panes = async (id: string): Promise<Panes> => {
    const r = await get(`/api/panel/control/panes?project=${id}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    return await r.json() as Panes;
  };

  it('tab 7 stays marked unfinished, its words saying the companion shows the panes, read-only; not yet: harnesses, a broadcast, live browser panes (the contract\'s words, as the frame carries them)', async () => {
    const t = TABS.find((x) => x.id === 'control')!;
    expect(t.unfinished).toBeDefined();
    expect(t.unfinished!.works).toBe('this project\'s jobs, chat turns and runs, each run\'s pane (the Workbench draws up to four as a grid, and the companion shows them, read-only) and what waits on you');
    // (R9 lead, after the R9 review: typing into a run's pane is named as missing too)
    expect(t.unfinished!.missing).toBe('adding or removing harnesses, a broadcast to every pane, typing into a run\'s pane, and live browser panes');
    const d = project('FAKE-control-words');
    const frame = await (await get(`/api/workspace?project=${d.id}`)).json() as WorkspaceFrame;
    expect(frame.tabs.find((x) => x.id === 'control')!.unfinished).toEqual(t.unfinished);
  });

  it('refuses without the token (401) and for a project the companion does not know (404)', async () => {
    const no = await get('/api/panel/control/panes', null);
    expect(no.status).toBe(401);
    expect(await no.text()).toContain('Refused: this needs the browser companion\'s token');
    const unknown = await get('/api/panel/control/panes?project=0123456789abcdef');
    expect(unknown.status).toBe(404);
  });

  it('what runs first (a turn being answered among it), then the newest ended in the slots left, each with its name, state, log, exit and receipt; a receipt changed on its chain does not verify and is never green; the stop words are the frame\'s', async () => {
    const a = project('FAKE-control-a');
    const b = project('FAKE-control-b');
    const jobs = store('FAKE-control-a', a.root);
    const other = store('FAKE-control-b', b.root);
    // three ended runs, oldest first: one that passes, a workflow block that fails, one whose receipt the test changes after
    const ok = jobs.start({ kind: 'task', label: 'FAKE job (test): passes', project: 'FAKE-control-a', root: a.root, command: 'sh', args: ['-c', 'echo "FAKE: fine"'] });
    await jobs.done(ok.id);
    await sleep(15);
    const failed = jobs.start({ kind: 'workflow', label: 'FAKE.md › fails', project: 'FAKE-control-a', root: a.root, command: 'sh', args: ['-c', 'echo "FAKE: about to fail"; exit 3'] });
    await jobs.done(failed.id);
    await sleep(15);
    const changed = jobs.start({ kind: 'task', label: 'FAKE job (test): its receipt is changed', project: 'FAKE-control-a', root: a.root, command: 'sh', args: ['-c', 'echo "FAKE: sealed, then changed"'] });
    await jobs.done(changed.id);
    // the third job's receipt, the newest job receipt on this test's chain: its subject changed in the store's file, so its body
    // hash fails (the two sealed before it still verify: the chain up to them is as sealed)
    const file = receiptsPath('runs');
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    const at = lines.findIndex((l) => (JSON.parse(l) as { job?: { id?: string } }).job?.id === changed.id);
    expect(at, lines.map((l) => l.slice(0, 160)).join('\n')).toBeGreaterThan(-1);
    const sealed = JSON.parse(lines[at]) as { subject: string };
    lines[at] = JSON.stringify({ ...sealed, subject: `${sealed.subject} (changed by the test)` });
    writeFileSync(file, `${lines.join('\n')}\n`);
    // another project's run: never one of this project's panes
    const theirs = other.start({ kind: 'task', label: 'FAKE job (test): another project\'s', project: 'FAKE-control-b', root: b.root, command: 'sh', args: ['-c', 'echo theirs'] });
    await other.done(theirs.id);

    // nothing runs: the three newest ended are the panes (four slots, three runs), each with its exit and receipt
    const quiet = await panes(a.id);
    expect(quiet.ok).toBe(true);
    expect(quiet.schema).toBe('timmy.control-panes/1');
    expect(quiet.project).toEqual({ id: a.id, name: 'FAKE-control-a' });
    expect(quiet.running).toBe(0);
    expect(quiet.more).toBe(0);
    expect(quiet.stop).toBeNull();
    expect(quiet.panes.map((p) => [p.id, p.quiet])).toEqual([[changed.id, true], [failed.id, true], [ok.id, true]]);
    const byId = Object.fromEntries(quiet.panes.map((p) => [p.id, p]));
    expect(byId[ok.id]).toMatchObject({ kind: 'job', name: 'FAKE job (test): passes', state: { glyph: '✓', word: 'completed', failed: false }, exit: 'exit 0', tail: { lines: ['FAKE: fine'] } });
    expect(byId[ok.id].receipt).toMatchObject({ state: 'verified' });
    expect(byId[ok.id].receipt!.words).toMatch(/^✓ receipt [0-9a-f]{8} verified$/);
    // a workflow block's run is named as it ran: document › block
    expect(byId[failed.id]).toMatchObject({ name: 'FAKE.md › fails', state: { glyph: '✕', word: 'failed', failed: true }, exit: 'exit 3', tail: { lines: ['FAKE: about to fail'] } });
    expect(byId[failed.id].receipt).toMatchObject({ state: 'verified' });
    // the changed one: not verified, with why, never green
    expect(byId[changed.id].receipt!.state).toBe('failed');
    expect(byId[changed.id].receipt!.words).toMatch(/^✕ receipt [0-9a-f]{8} does not verify: .+/);
    expect(byId[changed.id].receipt!.words).not.toMatch(/verified$/);
    // no operation here (no request started these): no run detail, said so
    expect(byId[ok.id]).toMatchObject({ operation: null, noDetail: 'this job names no operation' });
    expect(JSON.stringify(quiet)).not.toContain(theirs.id);
    expect(JSON.stringify(quiet)).not.toContain(box);

    // a running job and a chat turn being answered: they come first, and leave two slots for the newest ended
    const live = jobs.start({ kind: 'task', label: 'FAKE job (test): nine lines, then waits', project: 'FAKE-control-a', root: a.root, command: 'sh', args: ['-c', 'for i in 1 2 3 4 5 6 7 8 9; do echo "FAKE line $i"; done; sleep 30'] });
    await until('its nine lines', () => (jobs.get(live.id)?.lines ?? 0) >= 9);
    const held = takeTurnHold(a.root, 'repl');
    if (!held.ok) throw new Error(held.lines.join(' '));
    try {
      const now = await panes(a.id);
      expect(now.running).toBe(2);
      expect(now.panes.map((p) => [p.kind, p.id, p.quiet])).toEqual([['job', live.id, false], ['turn', held.hold.id, false], ['job', changed.id, true], ['job', failed.id, true]]);
      const run = now.panes[0];
      expect(run).toMatchObject({ name: 'FAKE job (test): nine lines, then waits', state: { glyph: '▶', word: 'running', failed: false }, who: 'another session' });
      // its log's last lines (TAIL_MAX of them), read again by the page every `every` ms while the tab is shown
      expect(run.tail).toEqual({ lines: Array.from({ length: TAIL_MAX }, (_, k) => `FAKE line ${10 - TAIL_MAX + k}`) });
      expect(run.every).toBe(now.every);
      expect(now.every).toBeGreaterThanOrEqual(1000);
      expect(now.every).toBeLessThanOrEqual(5000);
      expect(run.exit).toBeUndefined();
      expect(run.receipt).toBeUndefined();
      // the turn: where it was sent from, how it is stopped there (the frame's words), and no run detail until it is sealed
      const turn = now.panes[1];
      expect(turn).toMatchObject({ kind: 'turn', name: 'chat turn', from: 'the REPL', who: `pid ${process.pid}`, state: { glyph: '▶', word: 'answering', failed: false }, operation: null, noDetail: 'a turn being answered has none until its receipt is sealed', tail: { why: 'its words are where it was sent' }, stop: { words: 'Ctrl+C in the REPL stops it' } });
      expect(Date.parse(turn.since)).toBeGreaterThan(Date.now() - 60_000);
      // the stop words as the frame gives them: Stop current names the running job, with its action's command
      const frame = await (await get(`/api/workspace?project=${a.id}`)).json() as WorkspaceFrame;
      expect(frame.activity.stopCurrent.job).toBe(live.id);
      const stopAct = frame.actions.control.find((x) => x.label === 'Stop current')!;
      expect(now.stop).toEqual({ words: frame.activity.stopCurrent.words, command: stopAct.command });
      expect(run.stop).toEqual({ words: frame.activity.stopCurrent.words, command: stopAct.command });
      expect(now.stop!.words).toBe(`Stop current: ${live.id} FAKE job (test): nine lines, then waits`);
    } finally { held.hold.release(); }
    await jobs.stop(live.id);
  }, 60_000);

  it('more running than four: the first four are the panes (no ended run among them), and how many more run is said; only the shown panes\' logs are in the answer', async () => {
    const c = project('FAKE-control-c');
    const jobs = store('FAKE-control-c', c.root);
    const started = [];
    for (let k = 0; k < PANES_MAX + 2; k += 1) {
      started.push(jobs.start({ kind: 'task', label: `FAKE job (test): runner ${k}`, project: 'FAKE-control-c', root: c.root, command: 'sh', args: ['-c', `echo "FAKE runner ${k}"; sleep 30`] }));
      await sleep(15);
    }
    await until('every runner printed', () => started.every((j) => (jobs.get(j.id)?.lines ?? 0) >= 1));
    const now = await panes(c.id);
    expect(now.running).toBe(PANES_MAX + 2);
    expect(now.more).toBe(2);
    expect(now.panes).toHaveLength(PANES_MAX);
    expect(now.panes.every((p) => !p.quiet && p.state.word === 'running')).toBe(true);
    // the newest first, as the Workbench lists them
    expect(now.panes.map((p) => p.name)).toEqual([5, 4, 3, 2].map((k) => `FAKE job (test): runner ${k}`));
    expect(JSON.stringify(now)).not.toContain('FAKE runner 0');
    expect(JSON.stringify(now)).not.toContain('FAKE runner 1');
    for (const j of started) await jobs.stop(j.id);
  }, 60_000);
});
