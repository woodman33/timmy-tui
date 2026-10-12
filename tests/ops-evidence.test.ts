/**
 * Round R4 (H102): `timmy evidence <flow|step|vox>` (src/ops/evidence.ts): the one record or file of an operation a
 * workflow block needs, found by the operation's id and never by a file's time; or a refusal that says why.
 *
 * Real: the project's files, its receipt chain (appendReceipt in a temporary project; read back with readChain), the
 * records' bytes and the files they name, the tray's own last-build check (trayLastBuild, its words), and the CLI as a real
 * child process (src/cli.ts through tsx) with its exit codes.
 * FAKE: the flow and VoxVision records are tests/fixtures/fake-tray-flow.ts's, in their records' shapes (no flow ran, no
 * tool measured anything); the last build trayLastBuild checks is given through its own test seam (TrayLastBuildDeps), as
 * no recipe job ran here.
 *
 * R4 (H102, part 2): `timmy evidence stl` (the STL a flow delivered: OpenSCAD's in a /iterate scad flow, or a rebuild's
 * export; a no-change flow's last build STL), and `timmy evidence flow --outcome` (how the flow ended, for the tray
 * template's lesson). FAKE: the /iterate scad flow records here are written in their record's shape by fakeScadFlow below
 * (no agent or OpenSCAD ran); each is sealed by a real flow receipt on the project's chain.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { trayLastBuild, type TrayLastBuildDeps } from '../src/flows/iterate.js';
import { deliveredFiles, deliveredSteps, findEvidence, lastBuildFiles, lastBuildSteps, parseEvidenceArgs, type EvidenceAnswer, type EvidenceQuery } from '../src/ops/evidence.js';
import { appendReceipt, readChain, receiptsPath } from '../src/utils/receipts.js';
import { projectId } from '../src/project/index.js';
import { fakeTrayFlow, fakeVoxRecord } from './fixtures/fake-tray-flow.js';
import { CLI, TSX } from './helpers/ops-sandbox.js';
import { runAsync } from './helpers/run-async.js';

const OP = 'o1a2b3c4d';
const OTHER = 'o9f8e7d6c';
const sha = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

/** A project in a temporary folder whose receipt chain is its own (.timmy/receipts). */
function project(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'h102-evidence-')));
  dirs.push(root);
  expect(receiptsPath('runs', root)).toBe(path.join(root, '.timmy', 'receipts', 'runs.jsonl'));
  return root;
}
const ask = (root: string, q: Omit<EvidenceQuery, 'root' | 'chain' | 'operation'> & { operation?: string }): EvidenceAnswer =>
  findEvidence({ root, chain: readChain('runs', root), operation: q.operation ?? OP, ...q });
const refused = (a: EvidenceAnswer): Extract<EvidenceAnswer, { ok: false }> => { if (a.ok) throw new Error(`expected a refusal, got ${a.path}`); return a; };
const found = (a: EvidenceAnswer): Extract<EvidenceAnswer, { ok: true }> => { if (!a.ok) throw new Error(`expected an answer, got ${a.refusal}: ${a.why}`); return a; };

describe('its arguments', () => {
  it('takes one of flow, step, stl or vox and its options; anything else is a usage error that names what it takes', () => {
    expect(parseEvidenceArgs(['step'])).toEqual({ what: 'step', json: false });
    expect(parseEvidenceArgs(['stl'])).toEqual({ what: 'stl', json: false });
    expect(parseEvidenceArgs(['flow', '--outcome'])).toEqual({ what: 'flow', json: false, outcome: true });
    expect(parseEvidenceArgs(['vox', '--of', 'out/a.step', '--operation=o1a2b3c4d', '--json'])).toEqual({ what: 'vox', of: 'out/a.step', operation: 'o1a2b3c4d', json: true });
    expect(parseEvidenceArgs(['flow', '--id', 'f1a2b3c4d', '--project', 'p'])).toEqual({ what: 'flow', id: 'f1a2b3c4d', project: 'p', json: false });
    expect(parseEvidenceArgs(['--help'])).toMatchObject({ help: true });
    const err = (argv: string[]): string => { const r = parseEvidenceArgs(argv); return 'error' in r ? r.error : 'no error'; };
    expect(err([])).toMatch(/^Name what to find: flow, step, stl or vox\. Usage: timmy evidence /);
    expect(err(['png'])).toMatch(/^No evidence png: flow, step, stl or vox\./);
    expect(err(['step', '--outcome'])).toMatch(/^--outcome is for flow \(how the operation's flow ended\)\./);
    expect(err(['step', 'flow'])).toMatch(/^One thing at a time \(it was given step flow\)\./);
    expect(err(['step', '--of', 'x.step'])).toMatch(/^--of is for vox/);
    expect(err(['step', '--id', 'v1a2b3c4d'])).toMatch(/^--id v1a2b3c4d is not a flow id \(f and 8 hex digits\)/);
    expect(err(['vox', '--id', 'f1a2b3c4d'])).toMatch(/^--id f1a2b3c4d is not a VoxVision record id/);
    expect(err(['step', '--operation'])).toMatch(/^--operation needs a value/);
    expect(err(['step', '--newest'])).toMatch(/^No option --newest\./);
  });
});

describe('by the operation\'s id: this run\'s record, never another\'s, whatever their files\' times', () => {
  it('step: the STEP this operation\'s flow delivered, as its bytes are recorded, the record sealed by a receipt of the project', () => {
    const root = project();
    const mine = fakeTrayFlow(root, { operation: OP, job: 'aaaaaaaa', dir: root });
    fakeTrayFlow(root, { operation: OTHER, job: 'bbbbbbbb', dir: root });
    const a = found(ask(root, { what: 'step' }));
    expect(a).toMatchObject({ path: mine.step, sha256: mine.stepSha256, operation: OP, record: { kind: 'flow', id: mine.id, path: mine.rel, receipt: mine.receipt } });
    expect(found(ask(root, { what: 'flow' }))).toMatchObject({ path: mine.rel, record: { id: mine.id } });
    // the other operation's, asked for by its own id
    expect(found(ask(root, { what: 'step', operation: OTHER })).path).toBe('out/recipes/bbbbbbbb/console-tray.step');
    expect(deliveredSteps(JSON.parse(fs.readFileSync(path.join(root, mine.rel), 'utf8')))).toEqual([
      { path: mine.step, sha256: mine.stepSha256, by: 'its rebuild delivered' }, { path: mine.step, sha256: mine.stepSha256, by: 'its readback read' },
    ]);
  });

  it('none: no record of the operation (another operation\'s are named as not this run\'s); a file that cannot be read and a flow still running are named', () => {
    const root = project();
    fakeTrayFlow(root, { operation: OTHER, job: 'bbbbbbbb', dir: root });
    const n = refused(ask(root, { what: 'flow' }));
    expect(n).toMatchObject({ refusal: 'none', why: `no flow record of operation ${OP} in results/flows/ (1 record there is of other operations or of none, and is not this run's evidence)` });
    // a record file that is not JSON: whether it is this operation's is not known, and said
    fs.writeFileSync(path.join(root, 'results', 'flows', 'f0000000e.json'), 'not json');
    // a flow of this operation with no record yet: its state file says it runs
    fs.mkdirSync(path.join(root, '.timmy', 'flows', 'f0000000a'), { recursive: true });
    fs.writeFileSync(path.join(root, '.timmy', 'flows', 'f0000000a', 'state.json'), JSON.stringify({ schema: 'timmy.flow/1', id: 'f0000000a', outcome: 'running', operation: OP }));
    const why = refused(ask(root, { what: 'step' })).why;
    expect(why).toContain('no STEP of this run: no flow record of operation');
    expect(why).toContain('; flow f0000000a of it has no record yet (its state file says it runs)');
    expect(why).toContain('; 1 file there could not be read (results/flows/f0000000e.json: not JSON), so whether one is this operation\'s is not known');
  });

  it('more than one flow of the operation: refused, each named; --id takes one of them, and --id of another operation\'s is not this run\'s', () => {
    const root = project();
    const one = fakeTrayFlow(root, { operation: OP, job: 'aaaaaaaa', dir: root });
    const two = fakeTrayFlow(root, { operation: OP, job: 'cccccccc', dir: root });
    const theirs = fakeTrayFlow(root, { operation: OTHER, job: 'bbbbbbbb', dir: root });
    const r = refused(ask(root, { what: 'step' }));
    expect(r.refusal).toBe('more than one');
    expect(r.why).toMatch(/^which STEP is this run's is not known: operation o1a2b3c4d has 2 flow records \(f[0-9a-f]{8}: succeeded; f[0-9a-f]{8}: succeeded\); this takes exactly one: name it with --id <f…>$/);
    expect(r.candidates?.map((c) => c.id).sort()).toEqual([one.id, two.id].sort());
    expect(found(ask(root, { what: 'step', id: two.id })).path).toBe('out/recipes/cccccccc/console-tray.step');
    expect(refused(ask(root, { what: 'flow', id: theirs.id }))).toMatchObject({ refusal: 'not in this operation', why: `flow record ${theirs.id} is operation ${OTHER}'s, not ${OP}'s, so it is not this run's evidence` });
    expect(refused(ask(root, { what: 'flow', id: 'f00000000' }))).toMatchObject({ refusal: 'none', why: 'no flow record f00000000 in results/flows/' });
  });
});

describe('only sealed records, and only the bytes they name', () => {
  it('a record no receipt of the project names, one changed after its seal, and one whose receipt names another operation are not usable', () => {
    const root = project();
    fakeTrayFlow(root, { operation: OP, job: 'aaaaaaaa', seal: false });
    expect(refused(ask(root, { what: 'flow' }))).toMatchObject({ refusal: 'not usable', why: expect.stringMatching(/^flow f[0-9a-f]{8} of operation o1a2b3c4d: no flow receipt of this project on the runs chain names results\/flows\/f[0-9a-f]{8}\.json, so it is not sealed evidence$/) });

    const root2 = project();
    const f = fakeTrayFlow(root2, { operation: OP, job: 'aaaaaaaa', dir: root2 });
    const abs = path.join(root2, f.rel);
    fs.writeFileSync(abs, fs.readFileSync(abs, 'utf8').replace('"succeeded"', '"succeeded" '));
    expect(refused(ask(root2, { what: 'step' })).why).toMatch(/: results\/flows\/f[0-9a-f]{8}\.json changed after it was sealed: its sha256 now \([0-9a-f]{12}\) is not one a flow receipt of this project names$/);

    // A receipt of this project names its bytes, but under another operation than its record says.
    const root3 = project();
    const g = fakeTrayFlow(root3, { operation: OP, job: 'aaaaaaaa', seal: false });
    const body = fs.readFileSync(path.join(root3, g.rel));
    const r = appendReceipt('runs', { kind: 'flow', subject: 'flow (FAKE)', policy: 'human-gated', project_id: projectId(root3), operation_id: OTHER, outputs: [{ path: g.rel, sha256: sha(body), bytes: body.length }] }, root3);
    expect(refused(ask(root3, { what: 'flow' })).why).toBe(`flow ${g.id} of operation ${OP}: receipt ${r.hash.slice(7, 15)}, which sealed ${g.rel}, names operation ${OTHER}, not ${OP}`);
    // A receipt of another project names nothing here.
    const root4 = project();
    const h = fakeTrayFlow(root4, { operation: OP, job: 'aaaaaaaa', seal: false });
    const b4 = fs.readFileSync(path.join(root4, h.rel));
    appendReceipt('runs', { kind: 'flow', subject: 'flow (FAKE)', policy: 'human-gated', project_id: 'another-project', operation_id: OP, outputs: [{ path: h.rel, sha256: sha(b4), bytes: b4.length }] }, root4);
    expect(refused(ask(root4, { what: 'flow' })).why).toContain('no flow receipt of this project on the runs chain names');
  });

  it('the STEP: refused when it changed since the flow recorded it, when it is gone, and when it is reached through a link', () => {
    const root = project();
    const f = fakeTrayFlow(root, { operation: OP, job: 'aaaaaaaa', dir: root });
    const abs = path.join(root, f.step);
    fs.appendFileSync(abs, 'changed\n');
    expect(refused(ask(root, { what: 'step' })).why).toBe(`${f.step} changed since flow ${f.id} named it as the STEP it delivered: sha256 ${sha(fs.readFileSync(abs)).slice(0, 12)} now, ${f.stepSha256.slice(0, 12)} as it recorded`);
    fs.rmSync(abs);
    expect(refused(ask(root, { what: 'step' })).why).toBe(`flow ${f.id} names ${f.step} as the STEP it delivered, and ${f.step} is not there`);
    // the same bytes, reached through a link to another folder
    const elsewhere = path.join(root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, 'console-tray.step'), 'FAKE STEP of aaaaaaaa (a test double: no geometry)\n');
    fs.rmSync(path.dirname(abs), { recursive: true });
    fs.symlinkSync(elsewhere, path.dirname(abs));
    expect(refused(ask(root, { what: 'step' })).why).toBe(`flow ${f.id} names ${f.step} as the STEP it delivered, and ${f.step} goes through a symbolic link (out/recipes/aaaaaaaa); evidence is read only in place`);
  });

  it('a flow that failed names no STEP (its record is still this run\'s flow)', () => {
    const root = project();
    const f = fakeTrayFlow(root, { operation: OP, job: 'aaaaaaaa', outcome: 'failed', dir: root });
    expect(refused(ask(root, { what: 'step' }))).toMatchObject({ refusal: 'not usable', why: `flow ${f.id} ended failed (FAKE: the recipe job failed; nothing was read back) and names no STEP it delivered` });
    expect(found(ask(root, { what: 'flow' })).how).toBe(`flow ${f.id} of operation ${OP} (failed); receipt ${f.receipt} on the runs chain sealed this record`);
  });
});

describe('a flow that made no change (R4 H99): the last build\'s STEP, only when its check found that build current', () => {
  it('the words of the tray\'s own check (trayLastBuild) name the STEP; it is taken while its bytes are as that check found them', () => {
    const root = project();
    // the last build's exports, in the project (FAKE bytes: no recipe job ran here)
    const prev = fakeTrayFlow(root, { operation: OTHER, job: '1a2b3c4d', dir: root });
    const stl = 'out/recipes/1a2b3c4d/console-tray.stl';
    fs.writeFileSync(path.join(root, stl), 'FAKE STL\n');
    const values = { width: 140, wall: 3, supportOffset: 10, bore: 3 };
    // FAKE: the recipe job trayLastBuild checks, through its own seam (TrayLastBuildDeps); the check itself is the real one
    const deps: TrayLastBuildDeps = {
      list: () => [{ id: '1a2b3c4d-0000-4000-8000-000000000000', created: Date.now(), state: 'succeeded', resultHash: 'FAKE' }],
      load: () => ({ request: { parameters: values }, requestHash: sha('FAKE request'), sources: [{ file: '/FAKE/build.py', hash: sha('FAKE source') }] }),
      request: () => ({ sha256: sha('FAKE request'), parameters: values }),
      hashFile: () => sha('FAKE source'),
      copy: () => ({ ok: true, files: [{ path: prev.step, recorded: prev.stepSha256, now: prev.stepSha256 }, { path: stl, recorded: sha('FAKE STL\n'), now: sha('FAKE STL\n') }] }),
    };
    const lb = trayLastBuild(root, values, { deps });
    expect(lb.state).toBe('current');
    expect(lastBuildSteps({ last_build: lb })).toEqual({ state: 'current', words: lb.words, build: 'recipe job 1a2b3c4d', steps: [{ path: prev.step, sha256: prev.stepSha256 }] });
    const f = fakeTrayFlow(root, { operation: OP, job: '1a2b3c4d', outcome: 'no change', lastBuild: lb, dir: root });
    const a = found(ask(root, { what: 'step' }));
    expect(a.path).toBe(prev.step);
    expect(a.how).toBe(`the last build's STEP (recipe job 1a2b3c4d), which flow ${f.id}'s check found current (the flow made no change), sha256 ${prev.stepSha256.slice(0, 12)} as that check recorded it, and the same now; flow ${f.id} is operation ${OP}'s, and receipt ${f.receipt} on the runs chain sealed its record`);
  });

  it('a last build its check found stale (or not recorded): no STEP of this run, in the check\'s own words', () => {
    const root = project();
    fakeTrayFlow(root, { operation: OTHER, job: '1a2b3c4d', dir: root });
    const f = fakeTrayFlow(root, { operation: OP, job: '1a2b3c4d', outcome: 'no change', dir: root, lastBuild: { state: 'stale', words: 'FAKE: the last build is stale: it was built from width 140' } });
    expect(refused(ask(root, { what: 'step' })).why).toBe(`flow ${f.id} made no change, and its check found the last build stale (FAKE: the last build is stale: it was built from width 140): there is no STEP of this run`);
  });
});

describe('vox: the operation\'s VoxVision record; with --of, the one about that file\'s bytes', () => {
  it('found by the operation, and by --of; another operation\'s record of the same STEP is never taken; a record about other bytes is refused', () => {
    const root = project();
    const f = fakeTrayFlow(root, { operation: OP, job: 'aaaaaaaa', dir: root });
    const theirs = fakeVoxRecord(root, f.step, { operation: OTHER, dir: root });
    expect(refused(ask(root, { what: 'vox' })).why).toBe(`no VoxVision record of operation ${OP} in results/vox/ (1 record there is of other operations or of none, and is not this run's evidence)`);
    const mine = fakeVoxRecord(root, f.step, { operation: OP, dir: root });
    expect(found(ask(root, { what: 'vox' }))).toMatchObject({ path: mine.rel, record: { kind: 'vox', id: mine.id, receipt: mine.receipt } });
    const of = found(ask(root, { what: 'vox', of: f.step }));
    expect(of.how).toBe(`VoxVision record ${mine.id} of operation ${OP} (inspect, ok) about ${f.step} (sha256 ${f.stepSha256.slice(0, 12)} now, as it read it); receipt ${mine.receipt} on the runs chain sealed this record`);
    expect(of.how).not.toContain(theirs.id);
    // --of another file: none of this operation's is about it
    fs.writeFileSync(path.join(root, 'other.step'), 'FAKE other\n');
    expect(refused(ask(root, { what: 'vox', of: 'other.step' })).why).toBe(`operation ${OP}'s 1 VoxVision record (${mine.id}: inspect, ok) is not about other.step`);
    // a second record of this operation about the STEP: more than one
    const measure = fakeVoxRecord(root, f.step, { operation: OP, dir: root, action: 'measure' });
    const two = refused(ask(root, { what: 'vox', of: f.step }));
    expect(two.refusal).toBe('more than one');
    expect(two.candidates?.map((c) => c.id).sort()).toEqual([mine.id, measure.id].sort());
    expect(found(ask(root, { what: 'vox', id: measure.id, of: f.step })).path).toBe(measure.rel);
    // the STEP changed since it was read: that record is not about these bytes
    fs.appendFileSync(path.join(root, f.step), 'changed\n');
    expect(refused(ask(root, { what: 'vox', id: mine.id, of: f.step })).why).toMatch(new RegExp(`^VoxVision record ${mine.id} read ${f.step.replace(/[.]/g, '\\.')} as sha256 ${f.stepSha256.slice(0, 12)}, and the file is [0-9a-f]{12} now: it is not about these bytes$`));
  });
});

/**
 * A FAKE /iterate scad flow (a TEST DOUBLE: no agent or OpenSCAD ran), its record in the record's shape: the STL OpenSCAD
 * made, with its sha256; or, with no change, the last OpenSCAD run its check found current (a native run's written file,
 * named by its path). Sealed by a real flow receipt on the project's chain naming the record's bytes, under the operation.
 */
function fakeScadFlow(root: string, o: { operation: string; run: string; outcome?: 'succeeded' | 'no change' }): { id: string; rel: string; stl: string; stlSha256: string; receipt: string } {
  const outcome = o.outcome ?? 'succeeded';
  const id = `f${sha(`${o.operation} ${o.run} ${outcome}`).slice(0, 8)}`;
  const stl = `out/scad/${o.run}/box.stl`;
  if (!fs.existsSync(path.join(root, stl))) {
    fs.mkdirSync(path.dirname(path.join(root, stl)), { recursive: true });
    fs.writeFileSync(path.join(root, stl), `FAKE STL of OpenSCAD run ${o.run} (a test double: no geometry)\n`);
  }
  const stlSha256 = sha(fs.readFileSync(path.join(root, stl)));
  const now = new Date().toISOString();
  const record = {
    flow: 1, schema: 'timmy.flow/1', id, kind: 'iterate', target: 'scad', instruction: 'FAKE: make it wider', project: path.basename(root),
    operation: o.operation, started_at: now, ended_at: now, outcome,
    ...(outcome === 'succeeded'
      ? { openscad: { run: `${o.run}-0000-4000-8000-000000000000`, state: 'completed', outcome: 'ok', stl: { path: stl, made: true, sha256: stlSha256 } } }
      : {
        why: 'no change: FAKE: the agent changed nothing, so nothing was rebuilt',
        last_build: {
          state: 'current', checked_at: now, build: { kind: 'native', id: `${o.run}-0000-4000-8000-000000000000`, app: 'openscad' },
          checks: [{ what: 'box.scad', recorded: sha('FAKE scad'), now: sha('FAKE scad'), same: true }, { what: stl, recorded: stlSha256, now: stlSha256, same: true }],
          words: 'FAKE: the last OpenSCAD run still matches its recorded inputs',
        },
      }),
  };
  const body = `${JSON.stringify(record, null, 2)}\n`;
  const rel = `results/flows/${id}.json`;
  fs.mkdirSync(path.join(root, 'results', 'flows'), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
  const r = appendReceipt('runs', {
    kind: 'flow', subject: `flow · iterate · scad · ${id} · ${outcome} (FAKE)`, policy: 'human-gated', project: path.basename(root), project_id: projectId(root),
    operation_id: o.operation, outputs: [{ path: rel, sha256: sha(body), bytes: Buffer.byteLength(body) }],
  }, root);
  return { id, rel, stl, stlSha256, receipt: r.hash.slice(7, 15) };
}

describe('stl (R4 H102, part 2): the STL a flow delivered, found as the STEP is, never by a file\'s time', () => {
  it('OpenSCAD\'s STL of this operation\'s /iterate scad flow, though another operation\'s is newer; a scad flow names no STEP', () => {
    const root = project();
    const mine = fakeScadFlow(root, { operation: OP, run: 'aaaaaaaa' });
    const theirs = fakeScadFlow(root, { operation: OTHER, run: 'bbbbbbbb' });
    // the other operation's STL is the newer file (what `ls -t out/scad/*/box.stl | head -n 1` took)
    const ahead = new Date(Date.now() + 3600_000);
    fs.utimesSync(path.join(root, theirs.stl), ahead, ahead);
    const a = found(ask(root, { what: 'stl' }));
    expect(a).toMatchObject({ path: mine.stl, sha256: mine.stlSha256, outcome: 'succeeded', record: { kind: 'flow', id: mine.id, path: mine.rel, receipt: mine.receipt } });
    expect(a.how).toBe(`the STL flow ${mine.id} delivered (succeeded), sha256 ${mine.stlSha256.slice(0, 12)} as the flow recorded it, and the same now; flow ${mine.id} is operation ${OP}'s, and receipt ${mine.receipt} on the runs chain sealed its record`);
    expect(refused(ask(root, { what: 'step' })).why).toBe(`flow ${mine.id} ended succeeded and names no STEP it delivered`);
    // its bytes changed since: not usable
    fs.appendFileSync(path.join(root, mine.stl), 'changed\n');
    expect(refused(ask(root, { what: 'stl' })).why).toMatch(new RegExp(`^out/scad/aaaaaaaa/box\\.stl changed since flow ${mine.id} named it as the STL it delivered: sha256 [0-9a-f]{12} now, ${mine.stlSha256.slice(0, 12)} as it recorded$`));
  });

  it('a flow that made no change: the last build\'s STL its check found current (a native run\'s file, by its path)', () => {
    const root = project();
    fakeScadFlow(root, { operation: OTHER, run: 'cccccccc' });
    const nc = fakeScadFlow(root, { operation: OP, run: 'cccccccc', outcome: 'no change' });
    const a = found(ask(root, { what: 'stl' }));
    expect(a.path).toBe('out/scad/cccccccc/box.stl');
    expect(a.outcome).toBe('no change');
    expect(a.how).toBe(`the last build's STL (openscad run cccccccc), which flow ${nc.id}'s check found current (the flow made no change), sha256 ${nc.stlSha256.slice(0, 12)} as that check recorded it, and the same now; flow ${nc.id} is operation ${OP}'s, and receipt ${nc.receipt} on the runs chain sealed its record`);
    expect(lastBuildFiles(JSON.parse(fs.readFileSync(path.join(root, nc.rel), 'utf8')), 'step').files).toEqual([]);
  });

  it('what each kind takes from a record: a rebuild\'s exports by their names; OpenSCAD\'s STL only when it was made', () => {
    const s1 = sha('FAKE step');
    const s2 = sha('FAKE stl');
    const v = {
      rebuild: { outputs: [{ path: 'out/recipes/1a2b3c4d/console-tray.step', sha256: s1 }, { path: 'out/recipes/1a2b3c4d/console-tray.stl', sha256: s2 }] },
      openscad: { stl: { path: 'out/scad/x/box.stl', made: false, sha256: s2 } },
    };
    expect(deliveredFiles(v, 'stl')).toEqual([{ path: 'out/recipes/1a2b3c4d/console-tray.stl', sha256: s2, by: 'its rebuild delivered' }]);
    expect(deliveredFiles(v, 'step')).toEqual([{ path: 'out/recipes/1a2b3c4d/console-tray.step', sha256: s1, by: 'its rebuild delivered' }]);
    expect(deliveredSteps(v)).toEqual(deliveredFiles(v, 'step'));
  });
});

describe('timmy evidence, the command (a real child process)', () => {
  /** `timmy evidence …` in the project, with its chain from the project (TIMMY_STORE, as a block's `timmy act` has it). */
  const cli = (root: string, args: string[], env: NodeJS.ProcessEnv = {}) => {
    const e: NodeJS.ProcessEnv = { ...process.env, TIMMY_STORE: path.join(root, '.timmy', 'receipts'), NO_COLOR: '1', ...env };
    if (!('TIMMY_OPERATION' in env)) delete e.TIMMY_OPERATION;
    return runAsync(TSX, [CLI, 'evidence', ...args], { cwd: root, env: e, timeout: 90_000 });
  };

  it('prints exactly the one path on stdout (how it was found on stderr), exit 0; refusals exit 1 with why; outside an operation and usage errors exit 2', async () => {
    const root = project();
    const f = fakeTrayFlow(root, { operation: OP, job: 'aaaaaaaa', dir: root });
    fakeTrayFlow(root, { operation: OTHER, job: 'bbbbbbbb', dir: root });
    const ok = await cli(root, ['step'], { TIMMY_OPERATION: OP });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toBe(`${f.step}\n`);
    expect(ok.stderr).toBe(`  step ${f.step}: the STEP flow ${f.id} delivered (succeeded; its readback matches), sha256 ${f.stepSha256.slice(0, 12)} as the flow recorded it, and the same now; flow ${f.id} is operation ${OP}'s, and receipt ${f.receipt} on the runs chain sealed its record\n`);
    // --operation names one (it wins over TIMMY_OPERATION); --project from elsewhere
    const other = await runAsync(TSX, [CLI, 'evidence', 'step', '--operation', OTHER, '--project', root], { cwd: os.tmpdir(), env: { ...process.env, TIMMY_STORE: path.join(root, '.timmy', 'receipts'), TIMMY_OPERATION: OP }, timeout: 90_000 });
    expect(other.status, other.stderr).toBe(0);
    expect(other.stdout).toBe('out/recipes/bbbbbbbb/console-tray.step\n');
    const none = await cli(root, ['vox'], { TIMMY_OPERATION: OP });
    expect(none.status).toBe(1);
    expect(none.stdout).toBe('');
    expect(none.stderr).toBe(`  timmy evidence vox: none: no VoxVision record of operation ${OP} in results/vox/\n`);
    const out = await cli(root, ['step']);
    expect(out.status).toBe(2);
    expect(out.stdout).toBe('');
    expect(out.stderr).toBe('timmy evidence step: not in an operation: TIMMY_OPERATION is not set (each block of a /run has it) and no --operation was given; /ops lists the operations\n');
    const bad = await cli(root, ['step'], { TIMMY_OPERATION: 'j1a2b3c' });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toBe('timmy evidence step: TIMMY_OPERATION "j1a2b3c" is not an operation id (o and 8 hex digits)\n');
    const usage = await cli(root, ['newest'], { TIMMY_OPERATION: OP });
    expect(usage.status).toBe(2);
    expect(usage.stderr).toMatch(/^No evidence newest: flow, step, stl or vox\. Usage: timmy evidence <flow\|step\|stl\|vox>/);
  }, 120_000);

  it('--json: one object on stdout, found or refused, with its exit code; --help and timmy --help name it', async () => {
    const root = project();
    const f = fakeTrayFlow(root, { operation: OP, job: 'aaaaaaaa', dir: root });
    const ok = await cli(root, ['flow', '--json'], { TIMMY_OPERATION: OP });
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout)).toEqual({
      schema: 'timmy.evidence/1', what: 'flow', operation: OP, operation_from: 'TIMMY_OPERATION', found: true, path: f.rel, sha256: sha(fs.readFileSync(path.join(root, f.rel))),
      bytes: fs.statSync(path.join(root, f.rel)).size, record: { kind: 'flow', id: f.id, path: f.rel, sha256: sha(fs.readFileSync(path.join(root, f.rel))), receipt: f.receipt },
      how: `flow ${f.id} of operation ${OP} (succeeded); receipt ${f.receipt} on the runs chain sealed this record`, outcome: 'succeeded', exit_code: 0,
    });
    const no = await cli(root, ['vox', '--json'], { TIMMY_OPERATION: OP });
    expect(no.status).toBe(1);
    expect(JSON.parse(no.stdout)).toEqual({ schema: 'timmy.evidence/1', what: 'vox', operation: OP, operation_from: 'TIMMY_OPERATION', found: false, refusal: 'none', why: `no VoxVision record of operation ${OP} in results/vox/`, exit_code: 1 });
    const outside = await cli(root, ['step', '--json']);
    expect(outside.status).toBe(2);
    expect(JSON.parse(outside.stdout)).toMatchObject({ schema: 'timmy.evidence/1', what: 'step', operation: null, found: false, refusal: 'not in an operation', exit_code: 2 });
    const help = await cli(root, ['--help']);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('timmy evidence: the one record or file of an operation a workflow block needs, found by the operation\'s id, never by a file\'s time.');
    const all = await runAsync(TSX, [CLI, '--help'], { cwd: root, env: { ...process.env, NO_COLOR: '1' }, timeout: 90_000 });
    expect(all.stdout).toContain('evidence flow|step|vox|stl  In a workflow block: this run\'s flow record, its STEP, its VoxVision record or its STL, by the operation\'s id, never by time');
  }, 120_000);

  it('R4 (H102, part 2): stl prints the STL path; flow --outcome prints how the flow ended (succeeded, no change); --outcome with step is a usage error', async () => {
    const root = project();
    const mine = fakeScadFlow(root, { operation: OP, run: 'aaaaaaaa' });
    fakeScadFlow(root, { operation: OTHER, run: 'bbbbbbbb' });
    const stl = await cli(root, ['stl'], { TIMMY_OPERATION: OP });
    expect(stl.status, stl.stderr).toBe(0);
    expect(stl.stdout).toBe(`${mine.stl}\n`);
    expect(stl.stderr).toContain(`  stl ${mine.stl}: the STL flow ${mine.id} delivered (succeeded)`);
    const outcome = await cli(root, ['flow', '--outcome'], { TIMMY_OPERATION: OP });
    expect(outcome.status, outcome.stderr).toBe(0);
    expect(outcome.stdout).toBe('succeeded\n');
    expect(outcome.stderr).toBe(`  flow ${mine.rel}: flow ${mine.id} of operation ${OP} (succeeded); receipt ${mine.receipt} on the runs chain sealed this record\n`);
    const nc = fakeTrayFlow(root, { operation: 'o5a5a5a5a', job: 'dddddddd', outcome: 'no change', dir: root });
    const ncOut = await cli(root, ['flow', '--outcome', '--operation', 'o5a5a5a5a']);
    expect(ncOut.status, ncOut.stderr).toBe(0);
    expect(ncOut.stdout).toBe('no change\n');
    expect(ncOut.stderr).toContain(`flow ${nc.id} of operation o5a5a5a5a (no change)`);
    const bad = await cli(root, ['step', '--outcome'], { TIMMY_OPERATION: OP });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toMatch(/^--outcome is for flow/);
  }, 120_000);
});
