import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import crypto from 'crypto';
import {
  createPlan, armPlan, dispatchPlan, tailLane, pauseOrCancelLane, collectRun,
  getPlan, listLanes, validatePlanCue, type DispatchPlan
} from '../src/utils/dispatch.js';
import { issueApproval, planHashOf } from '../src/utils/approvals.js';
import { readChain } from '../src/utils/receipts.js';
import { dispatchSessionsOnDefault, dispatchTmuxOfItsOwn } from './helpers/dispatch-tmux.js';
import { dispatchTempOfItsOwn } from './helpers/dispatch-temp.js';

const basePlan = (over: Partial<DispatchPlan> = {}): DispatchPlan => ({
  schema_version: 'dispatch/0.1',
  objective: 'red test to green test',
  deliverables: ['patch'],
  acceptance_tests: ['npm test'],
  harnesses: ['pi'],
  model_policy: { requested: 'local/qwen', allow_paid: false, max_spend_usd: 0 },
  copies: 1,
  cadence: { mode: 'parallel', depends_on: [] },
  context_manifest: [],
  repo_ref: 'main',
  workspace: { kind: 'host-ephemeral' },
  permissions: { filesystem: 'rw-ephemeral', network: false, tools: [], secrets: [] },
  limits: { cost_usd: 0, wall_ms: 60000 },
  retry_limit: 1,
  approval: { required: true, mode: 'manual' },
  expected_artifacts: ['patch.diff'],
  telemetry: { redact: true, events: true },
  ...over
});

// R8 (H156; R7's open item H): the dry run's session goes on a tmux server of this file's own (it cancelled its session on the
// default server before; now nothing of it is ever there), and the afterAll checks it left none on the default server
const own = dispatchTmuxOfItsOwn();
// R9 (H161; R8's open item K): its dispatches' copies are made in a temporary folder of this file's own, and its afterAll
// fails when a timmy-dp-* folder is left there (before R9 this file left one after each run: the dry run's)
const temp = dispatchTempOfItsOwn();
const sha256 = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');
/** The bus events the dispatch wrote into the project's runs log (its receipts are the lines with a hash). */
const eventsOf = (d: string) => readFileSync(join(d, '.timmy', 'receipts', 'runs.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter((e: { hash?: string }) => !e.hash);
/** A plan created, armed with an operator token and dispatched (dry run), with the copy its record names. */
function launched(over: Partial<DispatchPlan> = {}) {
  const c = createPlan(basePlan(over), dir);
  expect(c.ok, c.note).toBe(true);
  expect(armPlan(c.id!, issueApproval(c.plan_hash!).token, dir).ok).toBe(true);
  const d = dispatchPlan(c.id!, dir);
  expect(d.ok, d.note).toBe(true);
  const copy = getPlan(c.id!, dir)!.copy!;
  expect(copy, 'the dispatch record names its copy').toBeTruthy();
  return { id: c.id!, plan_hash: c.plan_hash!, copy };
}

let dir = '';
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'timmy-dispatch-'));
  process.env.TIMMY_DISPATCH_DRYRUN = '1';
});
afterAll(() => {
  delete process.env.TIMMY_DISPATCH_DRYRUN;
  rmSync(dir, { recursive: true, force: true });
});

describe('Command Post v0.1 dispatch contract', { timeout: 30000 }, () => {
  it('plan hashing is stable across key order', () => {
    const a = basePlan();
    const b = JSON.parse(JSON.stringify(a));
    b.limits = { wall_ms: 60000, cost_usd: 0 };
    expect(planHashOf(a)).toBe(planHashOf(b));
  });

  it('CUE validates structure and rejects malformed plans', () => {
    expect(validatePlanCue(basePlan(), process.cwd()).ok).toBe(true);
    const bad = basePlan() as any;
    delete bad.objective;
    const v = validatePlanCue(bad, process.cwd());
    expect(v.ok).toBe(false);
    expect(v.error_class).toBe('schema');
  });

  it('rejects unknown harnesses at plan time (lane selection)', () => {
    const r = createPlan(basePlan({ harnesses: ['skynet'] }) as DispatchPlan, dir);
    expect(r.ok).toBe(false);
    expect(r.note).toContain('unknown harness');
    expect(listLanes().some(l => l.id === 'openhands')).toBe(true);
  });

  it('rejects out-of-envelope copies (delegated limits)', () => {
    const r = createPlan(basePlan({ copies: 9 }) as DispatchPlan, dir);
    expect(r.ok).toBe(false);
  });

  it('dispatch without arm is denied (chat prepares, authority launches)', () => {
    const c = createPlan(basePlan(), dir);
    expect(c.ok).toBe(true);
    const d = dispatchPlan(c.id!, dir);
    expect(d.ok).toBe(false);
    expect(d.note).toContain('not armed');
  });

  it('approval binds the plan; mutation after arm invalidates', () => {
    const c = createPlan(basePlan(), dir);
    const hash = c.plan_hash!;
    const tok = issueApproval(hash).token;
    expect(armPlan(c.id!, tok, dir).ok).toBe(true);
    // mutate the stored plan out-of-band
    const p = join(dir, '.timmy', 'dispatch', `${c.id}.json`);
    const s = JSON.parse(readFileSync(p, 'utf8'));
    s.plan.objective = 'smuggled objective';
    writeFileSync(p, JSON.stringify(s));
    const d = dispatchPlan(c.id!, dir);
    expect(d.ok).toBe(false);
    expect(d.note).toContain('mutated');
    const last = readChain('runs', dir).at(-1) as any;
    expect(last.status).toBe('denied');
  });

  it('refuses live-checkout workspaces (isolation law, fail closed)', () => {
    const c = createPlan(basePlan({ workspace: { kind: 'host-ephemeral', path: process.cwd() } }), dir);
    const tok = issueApproval(c.plan_hash!).token;
    armPlan(c.id!, tok, dir);
    const d = dispatchPlan(c.id!, dir);
    expect(d.ok).toBe(false);
    expect(d.blocked?.state).toBe('blocked');
    expect(d.note).toContain('live checkout');
  });

  it('docker isolation fails closed when the daemon is unavailable (not_configured)', () => {
    const c = createPlan(basePlan({ workspace: { kind: 'docker', image: 'ubuntu:24.04' } }), dir);
    const tok = issueApproval(c.plan_hash!).token;
    armPlan(c.id!, tok, dir);
    const oldPath = process.env.PATH;
    process.env.PATH = '/nonexistent';
    const d = dispatchPlan(c.id!, dir);
    process.env.PATH = oldPath;
    expect(d.ok).toBe(false);
    expect(d.blocked?.state).toBe('not_configured');
  });

  it('dry-run dispatch → tail → collect → cancel, all receipted; the cancel ends the session and removes the copy it made', () => {
    const c = createPlan(basePlan(), dir);
    const tok = issueApproval(c.plan_hash!).token;
    expect(armPlan(c.id!, tok, dir).ok).toBe(true);
    const d = dispatchPlan(c.id!, dir);
    expect(d.ok).toBe(true);
    expect(d.session).toBe(`timmy-dp-${c.id}`);
    // R8 (H156): the session is on this file's own tmux server (TIMMY_TMUX_SOCKET), never on the default one
    expect(spawnSync('tmux', ['-L', own.label, 'has-session', '-t', d.session!]).status, `${d.session} on tmux -L ${own.label}`).toBe(0);
    expect(dispatchSessionsOnDefault()).not.toContain(d.session);
    // R9 (H161; R8's K): the record names the copy it made, in the temporary folder, with its marker file
    const copy = getPlan(c.id!, dir)!.copy!;
    expect(copy).toMatchObject({ state: 'in_use', root: temp.folder() });
    expect(dirname(copy.path)).toBe(temp.folder());
    expect(copy.path.startsWith(join(temp.folder(), `timmy-dp-${c.id}-`))).toBe(true);
    expect(JSON.parse(readFileSync(join(copy.path, '.timmy-dispatch-copy'), 'utf8'))).toMatchObject({ plan_id: c.id, marker: copy.marker });
    const t = tailLane(c.id!, dir);
    expect(t.ok).toBe(true);
    const col = collectRun(c.id!, dir);
    expect(col.ok).toBe(true);
    expect(col.receipt).toBeTruthy();
    // its session still runs: collecting keeps the copy, and says so
    expect(col.copy).toMatchObject({ state: 'in_use' });
    expect(col.copy!.words).toContain('the session still runs');
    expect(existsSync(copy.path)).toBe(true);
    const x = pauseOrCancelLane(c.id!, 'cancel', dir);
    expect(x.ok).toBe(true);
    expect(spawnSync('tmux', ['-L', own.label, 'has-session', '-t', `=${d.session!}`]).status, 'the session has ended').not.toBe(0);
    // the session has ended and the one output it names is recorded (missing: a dry run writes none): the copy is removed
    expect(x.copy).toMatchObject({ state: 'removed' });
    expect(existsSync(copy.path)).toBe(false);
    expect(temp.copies()).toEqual([]);
    expect(getPlan(c.id!, dir)!.copy).toMatchObject({ state: 'removed', outputs_at: `.timmy/dispatch/${c.id}/outputs`, outputs: [{ path: 'patch.diff', state: 'missing' }] });
    const last = readChain('runs', dir).at(-1) as any;
    expect(last.subject).toContain('cancelled');
    expect(last.subject).toContain(`temporary copy removed after the session ended; outputs kept at .timmy/dispatch/${c.id}/outputs`);
    expect(last.discrepancies).toContain('patch.diff: missing (the copy had no such file when its session ended)');
    // normalized events landed
    const evs = eventsOf(dir);
    expect(evs.some(e => e.kind === 'dispatch.launched' && e.payload?.plan_hash === c.plan_hash)).toBe(true);
    expect(evs.some(e => e.kind === 'dispatch.cancelled')).toBe(true);
    expect(evs.find(e => e.kind === 'dispatch.copy_removed' && e.payload?.plan_id === c.id)?.payload?.words).toContain('temporary copy removed after the session ended');
  });

  it("a cancel keeps the plan's outputs in the dispatch record, each with its sha256 or recorded as missing, then removes the copy", () => {
    const l = launched({ expected_artifacts: ['patch.diff', 'out/notes.md', 'never-made.txt'] });
    // FAKE outputs: written into the copy by this test, standing in for what a lane writes there
    writeFileSync(join(l.copy.path, 'patch.diff'), 'diff --git a/x b/x\n');
    mkdirSync(join(l.copy.path, 'out'));
    writeFileSync(join(l.copy.path, 'out', 'notes.md'), '# notes\n');
    const x = pauseOrCancelLane(l.id, 'cancel', dir);
    expect(x.copy).toMatchObject({ state: 'removed' });
    expect(existsSync(l.copy.path)).toBe(false);
    const at = `.timmy/dispatch/${l.id}/outputs`;
    expect(readFileSync(join(dir, at, 'patch.diff'), 'utf8')).toBe('diff --git a/x b/x\n');
    expect(readFileSync(join(dir, at, 'out', 'notes.md'), 'utf8')).toBe('# notes\n');
    expect(getPlan(l.id, dir)!.copy!.outputs).toEqual([
      { path: 'patch.diff', state: 'kept', sha256: sha256('diff --git a/x b/x\n'), bytes: 19 },
      { path: 'out/notes.md', state: 'kept', sha256: sha256('# notes\n'), bytes: 8 },
      { path: 'never-made.txt', state: 'missing' },
    ]);
    const last = readChain('runs', dir).at(-1) as any;
    expect(last.subject).toContain(`dispatch ${l.id} cancelled · temporary copy removed after the session ended; outputs kept at ${at}`);
    expect(last.outputs).toEqual([
      { path: `${at}/patch.diff`, sha256: sha256('diff --git a/x b/x\n'), bytes: 19 },
      { path: `${at}/out/notes.md`, sha256: sha256('# notes\n'), bytes: 8 },
    ]);
    expect(last.discrepancies).toEqual(['never-made.txt: missing (the copy had no such file when its session ended)']);
    expect(temp.copies()).toEqual([]);
  });

  it('a copy whose outputs could not all be kept is left; its record, its event and the receipt say it was kept and why', () => {
    const l = launched({ expected_artifacts: ['patch.diff', 'renders', 'link.txt', '../outside.txt'] });
    // FAKE: what the lane left where the plan names outputs: a file, a folder, and a link to a file outside the copy
    writeFileSync(join(l.copy.path, 'patch.diff'), 'diff\n');
    mkdirSync(join(l.copy.path, 'renders'));
    writeFileSync(join(dir, 'not-the-lanes.txt'), 'outside the copy\n');
    symlinkSync(join(dir, 'not-the-lanes.txt'), join(l.copy.path, 'link.txt'));
    const x = pauseOrCancelLane(l.id, 'cancel', dir);
    expect(x.ok).toBe(true);
    expect(x.copy).toMatchObject({ state: 'kept' });
    expect(existsSync(join(l.copy.path, 'patch.diff')), 'the copy is left as it was').toBe(true);
    const rec = getPlan(l.id, dir)!.copy!;
    expect(rec.state).toBe('kept');
    expect(rec.why).toBe('outputs that could not be kept: renders (a folder: only files are kept); link.txt (a symbolic link: not followed); ../outside.txt (outside the copy)');
    expect(rec.outputs).toEqual([
      { path: 'patch.diff', state: 'kept', sha256: sha256('diff\n'), bytes: 5 },
      { path: 'renders', state: 'not_kept', why: 'a folder: only files are kept' },
      { path: 'link.txt', state: 'not_kept', why: 'a symbolic link: not followed' },
      { path: '../outside.txt', state: 'not_kept', why: 'outside the copy' },
    ]);
    // nothing was taken from outside the copy
    expect(existsSync(join(dir, `.timmy/dispatch/${l.id}/outputs/link.txt`))).toBe(false);
    const ev = eventsOf(dir).find(e => e.kind === 'dispatch.copy_kept' && e.payload?.plan_id === l.id);
    expect(ev?.payload?.words).toBe(`temporary copy kept in the temporary folder (${l.copy.path.slice(temp.folder().length + 1)}): ${rec.why}`);
    const last = readChain('runs', dir).at(-1) as any;
    expect(last.subject).toContain(`dispatch ${l.id} cancelled · temporary copy kept`);
    expect(last.discrepancies).toEqual(['renders: a folder: only files are kept', 'link.txt: a symbolic link: not followed', '../outside.txt: outside the copy']);
    // the copy the product rightly kept is this test's to remove (by the path its record names), so the file leaves none
    rmSync(rec.path, { recursive: true, force: true });
  });

  it('removes only the folder this dispatch made: a record that names another folder removes nothing, and says why', () => {
    const l = launched();
    // FAKE tampering: the record is pointed at a folder this dispatch did not make (named like its copy, no marker in it)
    const decoy = mkdtempSync(join(temp.folder(), `timmy-dp-${l.id}-`));
    writeFileSync(join(decoy, 'keep.txt'), 'not the copy\n');
    const p = join(dir, '.timmy', 'dispatch', `${l.id}.json`);
    const s = JSON.parse(readFileSync(p, 'utf8'));
    s.copy.path = decoy;
    writeFileSync(p, JSON.stringify(s));
    const x = pauseOrCancelLane(l.id, 'cancel', dir);
    expect(x.copy).toMatchObject({ state: 'kept' });
    expect(getPlan(l.id, dir)!.copy!.why).toBe('not removed: the folder its record names has no marker of this dispatch (it removes only a folder it made)');
    expect(readFileSync(join(decoy, 'keep.txt'), 'utf8')).toBe('not the copy\n');
    expect(existsSync(l.copy.path)).toBe(true);
    // a record that names a folder outside the temporary folder it was made in removes nothing either
    s.copy.path = dir;
    s.copy.state = 'in_use';
    writeFileSync(p, JSON.stringify(s));
    expect(pauseOrCancelLane(l.id, 'cancel', dir).copy).toMatchObject({ state: 'kept' });
    expect(getPlan(l.id, dir)!.copy!.why).toBe(`not removed: the folder its record names is not a timmy-dp-${l.id}-… folder in the temporary folder it was made in (it removes only a folder it made)`);
    expect(existsSync(join(dir, '.timmy'))).toBe(true);
    rmSync(decoy, { recursive: true, force: true });
    rmSync(l.copy.path, { recursive: true, force: true });
  });

  it('a session ended elsewhere (killed outside Timmy): tail says so and keeps the copy; the cancel then keeps the outputs and removes it', () => {
    const l = launched({ expected_artifacts: ['patch.diff'] });
    writeFileSync(join(l.copy.path, 'patch.diff'), 'made before the end\n'); // FAKE output
    // the session ends outside Timmy (as a tmux kill-session or a closed terminal would), on this file's own server
    expect(spawnSync('tmux', ['-L', own.label, 'kill-session', '-t', `=timmy-dp-${l.id}`]).status).toBe(0);
    const t = tailLane(l.id, dir);
    expect(t).toMatchObject({ ok: false, note: 'session gone', copy: { state: 'in_use' } });
    expect(t.copy!.words).toBe(`temporary copy in use (${l.copy.path.slice(temp.folder().length + 1)}): the session has ended; a cancel keeps its outputs and removes the copy`);
    expect(existsSync(l.copy.path), 'tail removes nothing').toBe(true);
    const x = pauseOrCancelLane(l.id, 'cancel', dir);
    expect(x.copy).toMatchObject({ state: 'removed' });
    expect(readFileSync(join(dir, `.timmy/dispatch/${l.id}/outputs/patch.diff`), 'utf8')).toBe('made before the end\n');
    expect(existsSync(l.copy.path)).toBe(false);
  });

  it('hold suspends the pane of its own session and keeps the copy (a held session has not ended)', () => {
    const l = launched();
    // (the dry run's pane prints its line, then sleeps: C-z reaches that sleep only once it runs)
    for (const end = Date.now() + 5000; !(tailLane(l.id, dir).lines ?? []).some((t) => t.startsWith(`TIMMY_DISPATCH_DRYRUN ${l.id}`)) && Date.now() < end;) spawnSync('sleep', ['0.1']);
    const x = pauseOrCancelLane(l.id, 'hold', dir);
    expect(x).toMatchObject({ ok: true, copy: { state: 'in_use' } });
    expect(spawnSync('tmux', ['-L', own.label, 'has-session', '-t', `=timmy-dp-${l.id}`]).status, 'the held session is still there').toBe(0);
    // its own pane got the C-z: the shell says its job stopped
    let pane = '';
    for (const end = Date.now() + 5000; !/Stopped/.test(pane) && Date.now() < end; spawnSync('sleep', ['0.1'])) pane = spawnSync('tmux', ['-L', own.label, 'capture-pane', '-p', '-t', `=timmy-dp-${l.id}:`], { encoding: 'utf8' }).stdout ?? '';
    expect(pane, 'the held pane').toMatch(/Stopped/);
    expect(existsSync(l.copy.path)).toBe(true);
    expect(pauseOrCancelLane(l.id, 'cancel', dir).copy).toMatchObject({ state: 'removed' });
  });

  it('an isolation that fails after its copy is made removes that copy at once (no session started; nothing ran in it)', () => {
    const c = createPlan(basePlan({ context_manifest: [{ path: 'package.json', sha256: '0'.repeat(64) }] }), dir);
    expect(armPlan(c.id!, issueApproval(c.plan_hash!).token, dir).ok).toBe(true);
    const d = dispatchPlan(c.id!, dir);
    expect(d.ok).toBe(false);
    expect(d.note).toContain('context hash mismatch');
    expect(temp.copies()).toEqual([]);
    expect(getPlan(c.id!, dir)!.copy).toMatchObject({ state: 'removed', why: 'removed at once: isolation failed before any session started, so nothing ran in it' });
  });

  it('a session tmux could not start: the copy is removed at once', () => {
    const c = createPlan(basePlan(), dir);
    expect(armPlan(c.id!, issueApproval(c.plan_hash!).token, dir).ok).toBe(true);
    const oldPath = process.env.PATH;
    process.env.PATH = '/nonexistent';
    let d: ReturnType<typeof dispatchPlan>;
    try { d = dispatchPlan(c.id!, dir); } finally { process.env.PATH = oldPath; }
    expect(d.ok).toBe(false);
    expect(d.note).toContain('tmux spawn failed');
    expect(temp.copies()).toEqual([]);
    expect(getPlan(c.id!, dir)!.copy).toMatchObject({ state: 'removed', why: 'removed at once: tmux started no session, so nothing ran in it' });
  });
});
