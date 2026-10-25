// R6 (H140; the operator's order of 2026-10-16, priority 2: one waiting count everywhere; the R5 interaction review, defect 2):
// what waits on you is the same items, and so the same count, in every process: this process's NEEDS YOU boxes and those other
// live processes of the Timmy home wait on in the project, the newer of the caller's /tools rows and the recorded check, and a
// Studio draft waiting for Accept or Discard (Studio's reader, injected). A stopped chat turn is never an item.
//
// FAKE pieces, labelled: the /tools rows (made up, no tool checked), the boxes (made up; no model asked anything), another
// process's record (written by this test with a made-up pid, its liveness given by the seam), and the drafts reader. Real: the
// record files and their writer and reader, gatherDecisions, the frame producer.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CapabilityRow } from '../src/capabilities/index.js';
import { readToolsCheck, toolsCheckPath, writeToolsCheck } from '../src/capabilities/tools-record.js';
import { projectId } from '../src/project/index.js';
import type { WaitingApproval } from '../src/repl/approvals.js';
import type { Receipt } from '../src/utils/receipts.js';
import { othersWaiting, publishWaiting, waitingDir, WAITING_SCHEMA } from '../src/ops/waiting-record.js';
import { waitingNow } from '../src/ops/waiting.js';

let home: string;
let project: string;
let env: Record<string, string | undefined>;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'h140-waiting-'));
  project = join(home, 'proj');
  mkdirSync(join(project, '.timmy'), { recursive: true });
  env = { HOME: home, TIMMY_HOME: join(home, 'timmy'), PATH: process.env.PATH };
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

/** FAKE /tools rows: Ollama needs setup (a check before Ollama answered) */
const ROWS: CapabilityRow[] = [{ id: 'ollama', kind: 'model', name: 'Ollama (local models)', rung: 'needs setup', detail: 'FAKE: nothing answered', setup: 'ollama serve, then ollama pull <model>' }];
/** SYNTHETIC receipts of chat turns on the Ollama route, in the fields the decisions read (no chain is verified here) */
const turn = (ts: string, status: 'ok' | 'failed' | 'cancelled'): Receipt => ({
  kind: 'turn', subject: `repl · ${status === 'cancelled' ? 'cancelled · ' : ''}0 steps`, via: 'ollama', ts, project_id: projectId(project), hash: `sha256_${ts.replace(/\D/g, '').padEnd(64, '0')}`,
  status, ...(status === 'ok' ? { response_hash: 'd'.repeat(64) } : {}),
}) as unknown as Receipt;
const box = (tool: string, since: number): WaitingApproval => ({ tool, reason: 'FAKE: sends data off this computer', summary: 'FAKE call', session: true, since, shown: true });
const none = () => [] as WaitingApproval[];

describe('the last /tools check, as a record every process reads', () => {
  it('kept 0600 with only the fields a reader uses; the newer of a caller\'s own and the record is used', () => {
    expect(writeToolsCheck([{ ...ROWS[0], ladder: { proposed: null, installed: null, reachable: null, exercised: null, qualified: null } } as CapabilityRow], env, new Date('2026-10-16T18:00:00.000Z'))).toBe(true);
    expect(statSync(toolsCheckPath(env)).mode & 0o777).toBe(0o600);
    expect(readToolsCheck(env)).toEqual({ checkedAt: '2026-10-16T18:00:00.000Z', rows: [{ id: 'ollama', kind: 'model', name: 'Ollama (local models)', rung: 'needs setup', detail: 'FAKE: nothing answered', setup: 'ollama serve, then ollama pull <model>' }] });
    writeFileSync(toolsCheckPath(env), '{not json');
    expect(readToolsCheck(env)).toBeUndefined();
  });
  it('the recorded check counts in a process that never checked: the same setup item in every process', () => {
    const chain = [turn('2026-10-16T17:00:00.000Z', 'failed')];
    // no record yet: no setup item (nothing here checked /tools)
    expect(waitingNow({ root: project, jobs: [], chain, env, own: none, others: () => [] }).total).toBe(0);
    writeToolsCheck(ROWS, env, new Date('2026-10-16T16:00:00.000Z'));
    const v = waitingNow({ root: project, jobs: [], chain, env, own: none, others: () => [] });
    expect(v.items.map((d) => d.title)).toEqual(['Ollama (local models) needs setup']);
    // a caller's own newer check (Ollama reachable now) is used before the older record
    const own = { checkedAt: '2026-10-16T17:30:00.000Z', rows: [{ ...ROWS[0], rung: 'reachable' as const, detail: 'FAKE: 1 local model' }] };
    expect(waitingNow({ root: project, jobs: [], chain, env, tools: own, own: none, others: () => [] }).total).toBe(0);
  });
  it('a stopped turn after an answered one is no item (the R5 false "Ollama needs setup"); the count is 0 in every process', () => {
    writeToolsCheck(ROWS, env, new Date('2026-10-16T16:00:00.000Z'));
    const chain = [turn('2026-10-16T17:00:00.000Z', 'ok'), turn('2026-10-16T17:01:00.000Z', 'cancelled')];
    expect(waitingNow({ root: project, jobs: [], chain, env, own: none, others: () => [] })).toMatchObject({ total: 0, items: [] });
  });
});

describe('NEEDS YOU boxes of every live process of the project', () => {
  it('a process\'s boxes are kept 0600 for the others, named by its process and folder, and gone when its last box is answered', () => {
    expect(publishWaiting([box('get_env', 1000)], { root: project, env })).toBe(true);
    const file = join(waitingDir(env), `${process.pid}.json`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // this process reads its own from memory, never from here
    expect(othersWaiting(project, { env })).toEqual([]);
    expect(publishWaiting([], { root: project, env })).toBe(true);
    expect(() => statSync(file)).toThrow();
  });
  it('another live process\'s box counts here, said as waiting there; a gone process\'s, or another project\'s, does not', () => {
    mkdirSync(waitingDir(env), { recursive: true });
    const record = (pid: number, root: string) => writeFileSync(join(waitingDir(env), `${pid}.json`), JSON.stringify({ schema: WAITING_SCHEMA, pid, started: '2026-10-16T17:00:00.000Z', root, at: '2026-10-16T17:05:00.000Z', boxes: [box('browser_launch_cdp', 2000)] }));
    record(424242, project);
    record(434343, join(home, 'other'));
    record(444444, project);
    // FAKE liveness: 424242 runs, 444444 is gone (killed before its box was answered)
    const alive = (o: { pid?: unknown }) => (o.pid === 444444 ? 'gone' as const : 'alive' as const);
    expect(othersWaiting(project, { env, alive }).map((b) => b.pid)).toEqual([424242]);
    const v = waitingNow({ root: project, jobs: [], chain: [], env, own: () => [box('get_env', 1000)], others: (r, e) => othersWaiting(r, { env: e, alive }) });
    expect(v.total).toBe(2);
    expect(v.items.map((d) => d.title)).toEqual(['NEEDS YOU: browser_launch_cdp (FAKE call)', 'NEEDS YOU: get_env (FAKE call)']);
    const elsewhere = v.items.find((d) => d.title.includes('browser_launch_cdp'))!;
    expect(elsewhere).toMatchObject({ kind: 'approval', blocks: true, kindWords: 'NEEDS YOU, in another process' });
    expect(elsewhere.needed).toBe('answer its NEEDS YOU box where it waits: another Timmy process on this computer (pid 424242); the call waits for it');
    // its keys are pressed where it waits, never here
    expect(elsewhere.keys).toBeUndefined();
  });
});

describe('real processes: two live ones with a box each, and one killed with its box still recorded (the lead\'s condition)', () => {
  const LOADER = createRequire(import.meta.url).resolve('tsx');
  const CHILD = join(import.meta.dirname, 'fixtures', 'h140-waiting-child.mts');
  const kids: ChildProcess[] = [];
  afterEach(() => { for (const k of kids.splice(0)) { try { k.kill('SIGKILL'); } catch { /* ended */ } } });
  const start = async (tool: string): Promise<{ child: ChildProcess; pid: number; exited: Promise<void> }> => {
    const child = spawn(process.execPath, ['--import', LOADER, CHILD], { cwd: project, env: { ...env, H140_TOOL: tool } as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    kids.push(child);
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    let err = '';
    child.stderr!.setEncoding('utf8').on('data', (d: string) => { err += d; });
    const pid = await new Promise<number>((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error(`the child said nothing in 30 s: ${err.slice(-300)}`)), 30_000);
      child.stdout!.setEncoding('utf8').on('data', (d: string) => { out += d; const i = out.indexOf('\n'); if (i >= 0) { clearTimeout(timer); resolve((JSON.parse(out.slice(0, i)) as { pid: number }).pid); } });
    });
    return { child, pid, exited };
  };

  it('counts the two live processes\' boxes and never the killed one\'s; a record is 0600 in a 0700 folder and names only what the box shows', async () => {
    const [a, b, c] = await Promise.all([start('FAKE_tool_a'), start('FAKE_tool_b'), start('FAKE_tool_c')]);
    c.child.kill('SIGKILL');
    await c.exited;
    // the killed process's record is still there (it could not remove it): it is not counted
    expect(statSync(join(waitingDir(env), `${c.pid}.json`)).mode & 0o777).toBe(0o600);
    expect(statSync(waitingDir(env)).mode & 0o777).toBe(0o700);
    const others = othersWaiting(project, { env });
    expect(others.map((x) => [x.pid, x.tool]).sort()).toEqual([[a.pid, 'FAKE_tool_a'], [b.pid, 'FAKE_tool_b']].sort());
    expect(Object.keys(others[0]).sort()).toEqual(['pid', 'reason', 'session', 'shown', 'since', 'summary', 'tool']);
    const v = waitingNow({ root: project, jobs: [], chain: [], env, own: none });
    expect(v.total).toBe(2);
    expect(v.items.map((d) => d.title).sort()).toEqual(['NEEDS YOU: FAKE_tool_a (FAKE box (no model asked))', 'NEEDS YOU: FAKE_tool_b (FAKE box (no model asked))']);
    // a box answered in its process: gone from the count at once
    a.child.stdin!.write('y\n');
    await new Promise<void>((resolve) => a.child.stdout!.on('data', (d: string) => { if (String(d).includes('answered')) resolve(); }));
    expect(waitingNow({ root: project, jobs: [], chain: [], env, own: none }).items.map((d) => d.title)).toEqual(['NEEDS YOU: FAKE_tool_b (FAKE box (no model asked))']);
  }, 60_000);
});

describe('a Studio draft waiting for Accept or Discard counts once (Studio\'s reader, a FAKE here)', () => {
  it('one item, after what blocks, with where to decide it; none without the reader or with no draft', () => {
    const drafts = () => ({ count: 2, jobs: ['turn-3b3c72c2'] });
    const v = waitingNow({ root: project, jobs: [], chain: [], env, own: () => [box('get_env', 1000)], others: () => [], drafts });
    expect(v.total).toBe(2);
    expect(v.items.map((d) => d.title)).toEqual(['NEEDS YOU: get_env (FAKE call)', '2 drafts Timmy proposed on the Studio canvas wait for you']);
    expect(v.items[1]).toMatchObject({ kindWords: 'a Timmy draft on the Studio canvas', blocks: false, commands: ['/studio'], needed: 'Accept or Discard each in Studio (s in the Workbench, or timmy studio, opens it); nothing is kept until you do' });
    expect(waitingNow({ root: project, jobs: [], chain: [], env, own: none, others: () => [], drafts: () => ({ count: 0, jobs: [] }) }).total).toBe(0);
    expect(waitingNow({ root: project, jobs: [], chain: [], env, own: none, others: () => [], drafts: () => null }).total).toBe(0);
    expect(waitingNow({ root: project, jobs: [], chain: [], env, own: none, others: () => [], drafts: () => { throw new Error('FAKE: unreadable'); } }).total).toBe(0);
  });
});
