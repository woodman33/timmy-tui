// R10 (H163; the R9 review's F11): a dispatch copy kept because its session ended outside Timmy (its tmux session or server
// killed, the computer restarted) is released at the next start of a dispatch in its project, when its marker says its
// session is gone. Up to R9 such a copy stayed until someone cancelled the dispatch: the copy was released only where Timmy
// itself ended the session.
//
// Each dispatch now records where its session runs (the tmux server's socket, read from tmux right after the session started)
// in its record and in its copy's marker. At the next dispatch's start (and through releaseEndedCopies, for any start that
// calls it), a copy still "in use" whose marker names its session and that server, where tmux says no such session runs, has
// its outputs kept and is removed, as a cancel does; its record, an event and a receipt say it was released at the next start
// because its session had ended outside Timmy. A session that still runs, a record from before R10 (no server recorded) and a
// marker that does not name the session are left as they are, each said.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { armPlan, createPlan, dispatchPlan, getPlan, pauseOrCancelLane, releaseEndedCopies, type DispatchPlan } from '../src/utils/dispatch.js';
import { issueApproval } from '../src/utils/approvals.js';
import { readChain } from '../src/utils/receipts.js';
import { dispatchTmuxOfItsOwn } from './helpers/dispatch-tmux.js';
import { dispatchTempOfItsOwn } from './helpers/dispatch-temp.js';

const hasTmux = spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status === 0;
const basePlan = (over: Partial<DispatchPlan> = {}): DispatchPlan => ({
  schema_version: 'dispatch/0.1', objective: 'red test to green test', deliverables: ['patch'], acceptance_tests: ['npm test'],
  harnesses: ['pi'], model_policy: { requested: 'local/qwen', allow_paid: false, max_spend_usd: 0 }, copies: 1,
  cadence: { mode: 'parallel', depends_on: [] }, context_manifest: [], repo_ref: 'main', workspace: { kind: 'host-ephemeral' },
  permissions: { filesystem: 'rw-ephemeral', network: false, tools: [], secrets: [] }, limits: { cost_usd: 0, wall_ms: 60000 },
  retry_limit: 1, approval: { required: true, mode: 'manual' }, expected_artifacts: ['patch.diff'], telemetry: { redact: true, events: true },
  ...over,
});

const own = dispatchTmuxOfItsOwn();
const temp = dispatchTempOfItsOwn();
let dir = '';
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'timmy-dispatch-start-')); process.env.TIMMY_DISPATCH_DRYRUN = '1'; });
afterAll(() => { delete process.env.TIMMY_DISPATCH_DRYRUN; rmSync(dir, { recursive: true, force: true }); });

/** True once tmux says no server runs on `label` (its exit seen), at most 5 s after asking. */
function serverGone(label: string): boolean {
  for (const end = Date.now() + 5000; Date.now() < end;) {
    const h = spawnSync('tmux', ['-L', label, 'has-session'], { encoding: 'utf8', timeout: 2000 });
    if (h.status !== 0 && /no server running on |error connecting to .*\(No such file or directory\)/.test(String(h.stderr ?? ''))) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return false;
}

function launched(over: Partial<DispatchPlan> = {}) {
  const c = createPlan(basePlan(over), dir);
  expect(c.ok, c.note).toBe(true);
  expect(armPlan(c.id!, issueApproval(c.plan_hash!).token, dir).ok).toBe(true);
  const d = dispatchPlan(c.id!, dir);
  expect(d.ok, d.note).toBe(true);
  return { id: c.id!, copy: getPlan(c.id!, dir)!.copy! };
}
const sessionOf = (id: string) => `timmy-dp-${id}`;
const kill = (id: string) => expect(spawnSync('tmux', ['-L', own.label, 'kill-session', '-t', `=${sessionOf(id)}`]).status).toBe(0);
const socket = (): string => spawnSync('tmux', ['-L', own.label, 'display-message', '-p', '#{socket_path}'], { encoding: 'utf8' }).stdout.trim();
const eventsOf = (d: string) => readFileSync(join(d, '.timmy', 'receipts', 'runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e: { hash?: string }) => !e.hash);

describe.skipIf(!hasTmux)('a copy whose session ended outside Timmy is released at the next start (R10, H163; review F11)', { timeout: 60_000 }, () => {
  it('the record and the marker name the session and the tmux server it runs on', () => {
    const l = launched();
    const rec = getPlan(l.id, dir)!;
    expect(rec.copy!.tmux).toEqual({ socket: socket(), session: sessionOf(l.id) });
    expect(JSON.parse(readFileSync(join(l.copy.path, '.timmy-dispatch-copy'), 'utf8'))).toMatchObject({ plan_id: l.id, marker: l.copy.marker, session: sessionOf(l.id), socket: socket() });
    expect(pauseOrCancelLane(l.id, 'cancel', dir).copy).toMatchObject({ state: 'removed' });
  });

  it('killed outside Timmy, then the next dispatch starts: the outputs are kept, the copy removed, and its record, event and receipt say why', () => {
    const l = launched();
    writeFileSync(join(l.copy.path, 'patch.diff'), 'made before the end\n');   // FAKE output, standing in for what a lane writes
    kill(l.id);
    expect(getPlan(l.id, dir)!.copy).toMatchObject({ state: 'in_use' });
    const next = launched();   // the next start
    const rec = getPlan(l.id, dir)!.copy!;
    expect(rec.state).toBe('removed');
    expect(rec.why).toBe(`released at the next start: its session (${sessionOf(l.id)}) had ended outside Timmy; outputs kept at .timmy/dispatch/${l.id}/outputs`);
    expect(existsSync(l.copy.path)).toBe(false);
    expect(readFileSync(join(dir, `.timmy/dispatch/${l.id}/outputs/patch.diff`), 'utf8')).toBe('made before the end\n');
    const ev = eventsOf(dir).find((e) => e.kind === 'dispatch.copy_released' && e.payload?.plan_id === l.id);
    expect(ev?.payload?.words).toBe(`temporary copy ${rec.why}`);
    const receipt = (readChain('runs', dir) as Array<{ subject: string; outputs?: Array<{ path: string; sha256: string }> }>).find((r) => r.subject.startsWith(`dispatch ${l.id} copy released`));
    expect(receipt?.subject).toBe(`dispatch ${l.id} copy released at the next start · temporary copy ${rec.why}`);
    expect(receipt?.outputs?.map((o) => o.path)).toEqual([`.timmy/dispatch/${l.id}/outputs/patch.diff`]);
    // the next dispatch's own copy is in use, and a later cancel of the released one changes nothing of it
    expect(getPlan(next.id, dir)!.copy).toMatchObject({ state: 'in_use' });
    expect(pauseOrCancelLane(l.id, 'cancel', dir).copy).toMatchObject({ state: 'removed' });
    expect(pauseOrCancelLane(next.id, 'cancel', dir).copy).toMatchObject({ state: 'removed' });
  });

  it('a session that still runs keeps its copy; releaseEndedCopies says what it did and what it left', () => {
    const alive = launched();
    const ended = launched();
    kill(ended.id);
    const did = releaseEndedCopies(dir);
    expect(did).toEqual([{ id: ended.id, state: 'removed', words: `temporary copy released at the next start: its session (${sessionOf(ended.id)}) had ended outside Timmy; outputs kept at .timmy/dispatch/${ended.id}/outputs` }]);
    // its one output was not made (a dry run writes none): recorded as missing, as a cancel records it
    expect(getPlan(ended.id, dir)!.copy!.outputs).toEqual([{ path: 'patch.diff', state: 'missing' }]);
    expect(getPlan(alive.id, dir)!.copy).toMatchObject({ state: 'in_use' });
    expect(existsSync(alive.copy.path)).toBe(true);
    expect(releaseEndedCopies(dir)).toEqual([]);
    pauseOrCancelLane(alive.id, 'cancel', dir);
  });

  it('a record made before R10 (no server recorded) and a marker that does not name the session are left in use, said', () => {
    const old = launched();
    const odd = launched();
    kill(old.id);
    kill(odd.id);
    // FAKE: the record as R9 wrote it (no server); and a marker rewritten to name another session
    const p = join(dir, '.timmy', 'dispatch', `${old.id}.json`);
    const s = JSON.parse(readFileSync(p, 'utf8'));
    delete s.copy.tmux;
    writeFileSync(p, JSON.stringify(s));
    const m = join(odd.copy.path, '.timmy-dispatch-copy');
    writeFileSync(m, JSON.stringify({ ...JSON.parse(readFileSync(m, 'utf8')), session: 'timmy-dp-someone-else' }));
    expect(releaseEndedCopies(dir)).toEqual([
      { id: odd.id, state: 'in_use', words: 'left in use: its marker does not name this dispatch\'s session and tmux server (it releases only a copy its marker says is this session\'s)' },
      { id: old.id, state: 'in_use', words: 'left in use: its record does not say which tmux server its session ran on (made before Timmy recorded it), so whether it ended is not known; a cancel releases it' },
    ].sort((a, b) => a.id.localeCompare(b.id)));
    expect(existsSync(old.copy.path) && existsSync(odd.copy.path)).toBe(true);
    // a cancel still releases each, as before (its own check: the marker's plan and token)
    expect(pauseOrCancelLane(old.id, 'cancel', dir).copy).toMatchObject({ state: 'removed' });
    expect(pauseOrCancelLane(odd.id, 'cancel', dir).copy).toMatchObject({ state: 'removed' });
  });

  it('bounded when asked, as the Workbench asks after its first frame: at most `max` copies looked at, the rest at the next look', () => {
    const a = launched();
    const b = launched();
    kill(a.id);
    kill(b.id);
    const [first, second] = [a.id, b.id].sort();
    expect(releaseEndedCopies(dir, { max: 1, timeoutMs: 2000 }).map((d) => [d.id, d.state])).toEqual([[first, 'removed']]);
    expect(getPlan(second, dir)!.copy).toMatchObject({ state: 'in_use' });
    expect(releaseEndedCopies(dir, { max: 1, timeoutMs: 2000 }).map((d) => [d.id, d.state])).toEqual([[second, 'removed']]);
    expect(releaseEndedCopies(dir, { max: 1, timeoutMs: 2000 })).toEqual([]);
  });

  it('the whole tmux server gone (as after a restart): released at the next start too', () => {
    const l = launched();
    expect(spawnSync('tmux', ['-L', own.label, 'kill-server']).status).toBe(0);
    // R10 (H163; check h163-p2a-1 under load): kill-server returns before its server has exited, and a has-session asked at once
    // can still reach the server going away, which the product rightly reads as not known (the copy stays in use): the restart
    // this case stands for comes after the server has gone, so the case waits for that first
    expect(serverGone(own.label), 'the tmux server had not exited 5 s after kill-server').toBe(true);
    const did = releaseEndedCopies(dir);
    expect(did.map((d) => [d.id, d.state])).toEqual([[l.id, 'removed']]);
    expect(existsSync(l.copy.path)).toBe(false);
  });
});
