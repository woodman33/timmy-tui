/**
 * Round R4 (H51): the tray-workflow starter (templates/tray-workflow): registered like the other starters; its files; its
 * parameter file the tray recipe card's defaults, as Timmy writes a parameter file; its WORKFLOW.md parsed into its four
 * blocks with their needs (change, inspect after change, result after inspect, lesson after result); and its blocks' shell,
 * run.
 *
 * R4 (H102): the blocks find this run's evidence by its operation id (`timmy evidence`, src/ops/evidence.ts), never by a
 * file's time: inspect takes the STEP this operation's flow delivered, lesson this operation's flow and VoxVision records.
 * The tests below put a newer file of another operation beside each (what `ls -t … | head -n 1` took before), and a run
 * with no record of its own, which refuses.
 *
 * Real here: the blocks' own shell (sh), `timmy evidence` as a real child process (the CLI through tsx, reading the
 * project's records and its real receipt chain), and, in the run of `lesson`, every `timmy act` but the change block's: the
 * VoxVision inspection (its STEP worker FAKE, below), `/op` and `/lesson add`, joining the run's operation.
 * FAKE pieces, each labelled where it is used:
 * - upmd is tests/fixtures/fake-upmd.mjs (a TEST DOUBLE of upmd 0.2.7's --ci behaviour; each block through sh -c): upmd
 *   itself is not installed here (the Mac rehearsal runs the real one);
 * - `timmy act '/iterate tray …'` is tests/fixtures/fake-tray-flow.ts (a TEST DOUBLE: no agent runs and nothing is built; it
 *   writes FAKE STEP bytes, a flow record in its shape and seals a real flow receipt under the block's operation), since the
 *   tray's agent, CadQuery build and readback cannot run here;
 * - in the block tests, `timmy act` itself is a TEST DOUBLE shell script that notes how it was called and runs nothing, and
 *   the flow and VoxVision records are FAKE ones in their shapes (no flow ran, nothing was measured), sealed on a real chain;
 * - the STEP worker VoxVision runs is the FAKE of tests/helpers/vox-fakes.ts (not OCP).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyStarter, listStarters, STARTERS } from '../src/project/starters.js';
import { groupFiles, listProjectFiles } from '../src/project/index.js';
import { readCard } from '../src/recipes/index.js';
import { parseParams, paramsText } from '../src/recipes/params-file.js';
import { parseWorkflow, runOrder } from '../src/workflows/upmd.js';
import { OPERATION_ID } from '../src/ops/context.js';
import { readChain, receiptsPath, verifyChain } from '../src/utils/receipts.js';
import { riskyBlocks } from '../src/repl/workflow-gate.js';
import { runDetail } from '../src/ops/run-detail.js';
import { CLI, FIXTURES, opsKit, replOf, REPO, sandbox, text, TSX, json } from './helpers/ops-sandbox.js';
import { fakeTools } from './helpers/vox-fakes.js';
import { runAsync } from './helpers/run-async.js';
import { fakeTrayFlow, fakeVoxRecord } from './fixtures/fake-tray-flow.js';

const TEMPLATE = path.join(REPO, 'templates', 'tray-workflow');
const FAKE_TRAY = path.join(FIXTURES, 'fake-tray-flow.ts');
const kit = opsKit();
afterEach(() => kit.cleanup(), 60_000);
const temp = (prefix: string): string => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); kit.dirs.push(d); return d; };
const doc = (): string => fs.readFileSync(path.join(TEMPLATE, 'WORKFLOW.md'), 'utf8');
const block = (name: string): string => parseWorkflow(doc()).find((b) => b.name === name)!.code;
const SENTENCE = 'A tray size change by /iterate tray is confirmed by its STEP readback and by a VoxVision inspection of the exported STEP.';
/** R4 (H102, part 2): the lesson's sentence when the request made no change: no readback is claimed; the flow and its check are named. */
const NO_CHANGE_SENTENCE = (flow: string): string => `This tray request made no change: nothing was rebuilt or read back. The check of flow ${flow} found the last build current, and VoxVision inspected the STEP of that build.`;
/** A file's time set back by `ago` seconds (what `ls -t` sorts by). */
const age = (abs: string, ago: number): void => { const t = new Date(Date.now() - ago * 1000); fs.utimesSync(abs, t, t); };

interface Box { base: string; root: string; bin: string; env: NodeJS.ProcessEnv; calls: string }
/**
 * A project made from the starter, with its own receipt chain (.timmy/receipts), a HOME of its own and a `timmy` on PATH:
 * FAKE for `act` (a TEST DOUBLE shell script that notes each call, with the TIMMY_OPERATION it was given, and runs
 * nothing), the real CLI for everything else (`timmy evidence`).
 */
function box(prefix: string): Box {
  const base = temp(prefix);
  const root = path.join(base, 'project');
  const bin = path.join(base, 'bin');
  const home = path.join(base, 'home');
  for (const d of [bin, home]) fs.mkdirSync(d, { recursive: true });
  expect(copyStarter('tray-workflow', root)).toHaveProperty('files');
  const calls = path.join(base, 'act-calls.txt');
  fs.writeFileSync(path.join(bin, 'timmy'), [
    '#!/bin/sh',
    '# `timmy act` here is FAKE (a TEST DOUBLE): it notes how it was called, one argument per field, and runs nothing.',
    '# Everything else is the real CLI (src/cli.ts through tsx): `timmy evidence` reads the real records and chain.',
    'if [ "$1" = "act" ]; then',
    `  { printf '%s' "$TIMMY_OPERATION"; for a in "$@"; do printf '|%s' "$a"; done; echo; } >> "${calls}"`,
    '  echo "FAKE timmy $*"',
    '  exit 0',
    'fi',
    `exec "${TSX}" "${CLI}" "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  const env: NodeJS.ProcessEnv = {
    ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, HOME: home, TIMMY_HOME: path.join(home, 'timmy'),
    TIMMY_STORE: path.join(root, '.timmy', 'receipts'), NO_COLOR: '1',
  };
  delete env.TIMMY_OPERATION;
  // The records sealed here (appendReceipt with the project as its folder) and the ones `timmy evidence` reads (TIMMY_STORE
  // from the project) are one chain.
  expect(receiptsPath('runs', root)).toBe(path.join(root, '.timmy', 'receipts', 'runs.jsonl'));
  return { base, root, bin, env, calls };
}
const callsOf = (b: Box): string[][] => (fs.existsSync(b.calls) ? fs.readFileSync(b.calls, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split('|')) : []);
const runBlock = (b: Box, name: string, operation?: string) => runAsync('sh', ['-c', block(name)], { cwd: b.root, env: { ...b.env, ...(operation ? { TIMMY_OPERATION: operation } : {}) }, timeout: 120_000 });

describe('the tray-workflow starter', () => {
  it('is registered with the other starters, and holds its four files: two workflow documents', () => {
    expect(STARTERS['tray-workflow']).toContain('/run WORKFLOW.md lesson');
    expect(listStarters().map((s) => s.name)).toContain('tray-workflow');
    const dest = path.join(temp('tray-workflow-'), 'mytray');
    const r = copyStarter('tray-workflow', dest);
    expect(r).toEqual({ files: ['APPROVAL.md', 'README.md', 'recipes/tray.params.json', 'WORKFLOW.md'] });
    // r19 (ledger row 158, F5): the workflow documents, as /workflows and the board list them; the parameter file is source.
    const roles = groupFiles(listProjectFiles(dest).files).map((g) => [g.label, g.files.map((f) => f.rel)]);
    expect(roles).toEqual([['Source', ['recipes/tray.params.json']], ['References', ['README.md']], ['Workflows', ['APPROVAL.md', 'WORKFLOW.md']]]);
  });

  it('its parameter file is the tray recipe card\'s defaults, written as Timmy writes a parameter file, and the recipe\'s rules take it', () => {
    const file = fs.readFileSync(path.join(TEMPLATE, 'recipes', 'tray.params.json'), 'utf8');
    expect(file).toBe(paramsText(readCard().parameters));
    expect(parseParams(file)).toEqual({ ok: true, parameters: readCard().parameters });
  });

  it('its WORKFLOW.md parses into change, inspect (needs change), result (needs inspect) and lesson (needs result); no block is risky, and none picks a file by its time', () => {
    const blocks = parseWorkflow(doc());
    expect(blocks.map((b) => [b.name, b.lang, b.deps])).toEqual([['change', 'bash', []], ['inspect', 'bash', ['change']], ['result', 'bash', ['inspect']], ['lesson', 'bash', ['result']]]);
    expect(runOrder(blocks, 'result')).toEqual({ order: ['change', 'inspect', 'result'], missing: [] });
    expect(runOrder(blocks, 'lesson')).toEqual({ order: ['change', 'inspect', 'result', 'lesson'], missing: [] });
    expect(blocks[0].code).toBe('timmy act \'/iterate tray "make the tray 150 mm wide"\' --wait');
    expect(blocks[1].code).toBe('step=$(timmy evidence step) || exit 1\ntimmy act "/inspect $step" --wait');
    expect(blocks[2].code).toBe('timmy act \'/op\' --wait');
    expect(blocks[3].code).toBe([
      'flow=$(timmy evidence flow) || exit 1',
      'outcome=$(timmy evidence flow --outcome) || exit 1',
      'step=$(timmy evidence step) || exit 1',
      'vox=$(timmy evidence vox --of "$step") || exit 1',
      'case "$outcome" in',
      `  succeeded) lesson="${SENTENCE}" ;;`,
      `  "no change") lesson="${NO_CHANGE_SENTENCE('$(basename "$flow" .json)')}" ;;`,
      '  *) echo "No lesson kept: flow $flow ended $outcome, and neither sentence here says what that run showed." >&2; exit 1 ;;',
      'esac',
      'timmy act "/lesson add \\"$lesson\\" --from $flow --from $vox --applies tray" --wait',
    ].join('\n'));
    // No block asks a person (/run WORKFLOW.md lesson needs no NEEDS YOU box), and none sorts files by their time.
    expect(riskyBlocks(blocks, ['change', 'inspect', 'result', 'lesson'])).toEqual([]);
    for (const b of blocks) expect(b.code, b.name).not.toMatch(/\bls\b|mtime|sort|head -n/);
    // The prose explains the request, how the evidence is found, and the lesson: the user's sentence, a draft, checked only by /lesson check.
    const d = doc().replace(/\s+/g, ' ');
    expect(d).toContain('The instruction in the `change` block is the request');
    expect(d).toContain('finds this run\'s flow by the run\'s operation id, never by a file\'s time');
    expect(d).toContain('Edit the sentences to say what you learned.');
    // R4 (H102, part 2): the sentence says only what ran, by how the flow ended
    expect(d).toContain('Its sentence says only what ran, by how the flow ended (`timmy evidence flow --outcome`)');
    expect(d).toContain('No model is trained.');
    // Nothing personal, no absolute path.
    for (const f of ['README.md', 'WORKFLOW.md', 'APPROVAL.md', 'recipes/tray.params.json']) expect(fs.readFileSync(path.join(TEMPLATE, f), 'utf8'), f).not.toMatch(/\/Users\/|\/home\/|@[a-z0-9-]+\.[a-z]/i);
  });
});

describe('the blocks find this run\'s evidence by its operation id (timmy evidence), never by a file\'s time', () => {
  const OP = 'o1a2b3c4d';
  const OTHER = 'o9f8e7d6c';

  it('inspect: two STEPs, the older one this operation\'s: it inspects this operation\'s STEP (the newer file is another operation\'s, which ls -t took)', async () => {
    const b = box('tray-inspect-');
    const mine = fakeTrayFlow(b.root, { operation: OP, job: 'aaaaaaaa', dir: b.root });
    const theirs = fakeTrayFlow(b.root, { operation: OTHER, job: 'bbbbbbbb', dir: b.root });
    age(path.join(b.root, mine.step), 3600);
    age(path.join(b.root, mine.rel), 3600);
    const r = await runBlock(b, 'inspect', OP);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(callsOf(b)).toEqual([[OP, 'act', '/inspect out/recipes/aaaaaaaa/console-tray.step', '--wait']]);
    // how it was found, in the block's output: by the flow of this operation, its bytes as recorded, its record sealed
    expect(r.stderr).toContain(`step out/recipes/aaaaaaaa/console-tray.step: the STEP flow ${mine.id} delivered (succeeded; its readback matches), sha256 ${mine.stepSha256.slice(0, 12)} as the flow recorded it, and the same now; flow ${mine.id} is operation ${OP}'s, and receipt ${mine.receipt} on the runs chain sealed its record`);
    expect(r.stderr).not.toContain(theirs.id);
  }, 120_000);

  it('inspect with no flow record of this operation refuses and inspects nothing, though another operation\'s STEP is there', async () => {
    const b = box('tray-inspect-none-');
    fakeTrayFlow(b.root, { operation: OTHER, job: 'bbbbbbbb', dir: b.root });
    const r = await runBlock(b, 'inspect', OP);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`timmy evidence step: none: no STEP of this run: no flow record of operation ${OP} in results/flows/ (1 record there is of other operations or of none, and is not this run's evidence)`);
    expect(callsOf(b)).toEqual([]);
  }, 120_000);

  it('inspect outside a run (no TIMMY_OPERATION) refuses: it is not in an operation', async () => {
    const b = box('tray-inspect-noop-');
    fakeTrayFlow(b.root, { operation: OP, job: 'aaaaaaaa', dir: b.root });
    const r = await runBlock(b, 'inspect');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('timmy evidence step: not in an operation: TIMMY_OPERATION is not set (each block of a /run has it)');
    expect(callsOf(b)).toEqual([]);
  }, 120_000);

  it('lesson: this operation\'s flow and VoxVision records, though another operation\'s are newer; it refuses without them', async () => {
    const b = box('tray-lesson-');
    const mine = fakeTrayFlow(b.root, { operation: OP, job: 'aaaaaaaa', dir: b.root });
    const myVox = fakeVoxRecord(b.root, mine.step, { operation: OP, dir: b.root });
    const theirs = fakeTrayFlow(b.root, { operation: OTHER, job: 'bbbbbbbb', dir: b.root });
    const theirVox = fakeVoxRecord(b.root, theirs.step, { operation: OTHER, dir: b.root });
    for (const rel of [mine.step, mine.rel, myVox.rel]) age(path.join(b.root, rel), 3600);
    const r = await runBlock(b, 'lesson', OP);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(callsOf(b)).toEqual([[OP, 'act', `/lesson add "${SENTENCE}" --from ${mine.rel} --from ${myVox.rel} --applies tray`, '--wait']]);
    expect(r.stderr).toContain(`flow ${mine.rel}: flow ${mine.id} of operation ${OP} (succeeded); receipt ${mine.receipt} on the runs chain sealed this record`);
    expect(r.stderr).toContain(`vox ${myVox.rel}: VoxVision record ${myVox.id} of operation ${OP} (inspect, ok) about ${mine.step}`);
    expect(r.stderr).not.toContain(theirVox.id);

    // An operation that has a flow but no VoxVision record: refused, and no lesson is asked for.
    const c = box('tray-lesson-novox-');
    const flow = fakeTrayFlow(c.root, { operation: OP, job: 'aaaaaaaa', dir: c.root });
    const other = fakeTrayFlow(c.root, { operation: OTHER, job: 'bbbbbbbb', dir: c.root });
    fakeVoxRecord(c.root, other.step, { operation: OTHER, dir: c.root });
    const none = await runBlock(c, 'lesson', OP);
    expect(none.status).toBe(1);
    expect(none.stderr).toContain(`timmy evidence vox: none: no VoxVision record of operation ${OP} in results/vox/ (1 record there is of other operations or of none, and is not this run's evidence)`);
    expect(none.stderr).toContain(`flow ${flow.rel}: flow ${flow.id} of operation ${OP}`);
    expect(callsOf(c)).toEqual([]);
  }, 180_000);

  it('lesson in a run that made no change (R4 H102, part 2): its sentence names no readback, and names the flow whose check found the last build current', async () => {
    const b = box('tray-lesson-nochange-');
    // the last build: another operation's flow made its STEP (FAKE bytes); this operation's flow made no change and its
    // check (FAKE, in the check's shape) found that build current
    fakeTrayFlow(b.root, { operation: OTHER, job: 'aaaaaaaa', dir: b.root });
    const mine = fakeTrayFlow(b.root, { operation: OP, job: 'aaaaaaaa', outcome: 'no change', dir: b.root });
    const myVox = fakeVoxRecord(b.root, mine.step, { operation: OP, dir: b.root });
    const r = await runBlock(b, 'lesson', OP);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(callsOf(b)).toEqual([[OP, 'act', `/lesson add "${NO_CHANGE_SENTENCE(mine.id)}" --from ${mine.rel} --from ${myVox.rel} --applies tray`, '--wait']]);
    expect(r.stderr).toContain(`flow ${mine.rel}: flow ${mine.id} of operation ${OP} (no change); receipt ${mine.receipt} on the runs chain sealed this record`);
    expect(r.stderr).toContain(`step ${mine.step}: the last build's STEP (recipe job aaaaaaaa), which flow ${mine.id}'s check found current (the flow made no change)`);
    expect(JSON.stringify(callsOf(b))).not.toContain('readback');
  }, 120_000);
});

describe('a /run of the starter through the test-double upmd', () => {
  it('/project new --from tray-workflow, then /run WORKFLOW.md result: the three blocks run in order, each calling timmy act with the run\'s operation id, and inspect takes the STEP the run\'s flow delivered', async () => {
    const s = sandbox(kit, 'tray-workflow-run-');
    const { ws } = replOf(kit, s);
    const out = text(ws.project_('new mytray --from tray-workflow'));
    expect(out).toContain('Made mytray from tray-workflow: 4 files, yours to edit.');
    const root = path.join(s.home, 'timmy', 'projects', 'mytray');
    expect(fs.existsSync(path.join(root, 'WORKFLOW.md'))).toBe(true);
    // An older run's flow and STEP (another operation's), newer by their time than this run's will be: never taken.
    const older = fakeTrayFlow(root, { operation: 'o0f0f0f0f', job: 'cccccccc', dir: root });
    const ahead = new Date(Date.now() + 3600_000);
    for (const rel of [older.step, older.rel]) fs.utimesSync(path.join(root, rel), ahead, ahead);
    // `timmy` on PATH: FAKE `act` (a TEST DOUBLE that notes each call with its TIMMY_OPERATION); the change block's act is
    // the FAKE tray flow (tests/fixtures/fake-tray-flow.ts: a flow record and a sealed receipt, no agent, no build); every
    // other word is the real CLI (`timmy evidence`).
    const calls = path.join(s.base, 'calls.txt');
    fs.writeFileSync(path.join(s.bin, 'timmy'), [
      '#!/bin/sh',
      'if [ "$1" = "act" ]; then',
      `  echo "$TIMMY_OPERATION|$*" >> "${calls}"`,
      `  case "$2" in /iterate*) FAKE_TRAY_JOB=1a2b3c4d exec "${TSX}" "${FAKE_TRAY}" "$@" ;; esac`,
      '  echo "FAKE timmy $*"; exit 0',
      'fi',
      `exec "${TSX}" "${CLI}" "$@"`, '',
    ].join('\n'), { mode: 0o755 });
    vi.stubEnv('PATH', s.env.PATH ?? '');
    const started = text(await ws.operate('/run WORKFLOW.md result', 'repl', () => ws.run('WORKFLOW.md result')));
    const job = /Running\s+(j[0-9a-f]{6})/.exec(started)?.[1];
    expect(job, started).toBeDefined();
    const done = await ws.jobs.done(job!);
    expect(done.state, ws.jobs.tail(job!, 200).join('\n')).toBe('completed');
    const op = ws.ops.latest!.id;
    expect(op).toMatch(OPERATION_ID);
    expect(done.operation).toBe(op);
    expect(fs.readFileSync(calls, 'utf8').trim().split('\n')).toEqual([
      `${op}|act /iterate tray "make the tray 150 mm wide" --wait`,
      `${op}|act /inspect out/recipes/1a2b3c4d/console-tray.step --wait`,
      `${op}|act /op --wait`,
    ]);
    expect(done.steps.map((x) => [x.name, x.state])).toEqual([['change', 'completed'], ['inspect', 'completed'], ['result', 'completed']]);
  }, 180_000);

  it('/run WORKFLOW.md lesson with the real timmy act for inspect, result and lesson: the lesson\'s evidence is this run\'s flow and VoxVision records, never another run\'s newer ones', async () => {
    const s = sandbox(kit, 'tray-workflow-lesson-');
    // the starter's files, as /project new makes them, in the sandbox's project
    fs.rmSync(s.root, { recursive: true, force: true });
    expect(copyStarter('tray-workflow', s.root)).toHaveProperty('files');
    // FAKE: the STEP worker VoxVision runs (tests/helpers/vox-fakes.ts: not OCP; it answers in the worker's shape)
    const tools = fakeTools(temp('tray-vox-tools-'));
    // An earlier run (another operation): its flow, its STEP and its VoxVision record, all newer by their time.
    const older = fakeTrayFlow(s.root, { operation: 'o0f0f0f0f', job: 'cccccccc', dir: s.root });
    const olderVox = fakeVoxRecord(s.root, older.step, { operation: 'o0f0f0f0f', dir: s.root });
    const ahead = new Date(Date.now() + 3600_000);
    for (const rel of [older.step, older.rel, olderVox.rel]) fs.utimesSync(path.join(s.root, rel), ahead, ahead);
    // `timmy` on PATH: the real CLI, but for the change block's act, the FAKE tray flow.
    fs.writeFileSync(path.join(s.bin, 'timmy'), [
      '#!/bin/sh',
      `if [ "$1" = "act" ]; then case "$2" in /iterate*) FAKE_TRAY_JOB=1a2b3c4d exec "${TSX}" "${FAKE_TRAY}" "$@" ;; esac; fi`,
      `exec "${TSX}" "${CLI}" "$@"`, '',
    ].join('\n'), { mode: 0o755 });
    vi.stubEnv('TIMMY_CADQUERY_PYTHON', tools.step);
    vi.stubEnv('FAKE_STEP_SIZE', '150,80,30');
    const { ws } = replOf(kit, s);
    const started = text(await ws.operate('/run WORKFLOW.md lesson', 'repl', () => ws.run('WORKFLOW.md lesson')));
    const job = /Running\s+(j[0-9a-f]{6})/.exec(started)?.[1];
    expect(job, started).toBeDefined();
    const done = await ws.jobs.done(job!);
    const log = ws.jobs.tail(job!, 400).join('\n');
    expect(done.state, log).toBe('completed');
    const op = ws.ops.latest!.id;
    expect(done.steps.map((x) => [x.name, x.state])).toEqual([['change', 'completed'], ['inspect', 'completed'], ['result', 'completed'], ['lesson', 'completed']]);

    // This run's flow (FAKE), and the VoxVision record the real /inspect made of its STEP, under the run's operation.
    const flows = fs.readdirSync(path.join(s.root, 'results', 'flows')).filter((n) => n !== `${older.id}.json`);
    expect(flows).toHaveLength(1);
    const flowRel = `results/flows/${flows[0]}`;
    expect(json(path.join(s.root, flowRel))).toMatchObject({ operation: op, outcome: 'succeeded' });
    const voxes = fs.readdirSync(path.join(s.root, 'results', 'vox')).filter((n) => n.endsWith('.json') && n !== `${olderVox.id}.json`);
    expect(voxes).toHaveLength(1);
    const voxRel = `results/vox/${voxes[0]}`;
    expect(json(path.join(s.root, voxRel))).toMatchObject({ action: 'inspect', status: 'ok', operation: op, inputs: [{ path: 'out/recipes/1a2b3c4d/console-tray.step' }] });
    expect(log).toContain('step out/recipes/1a2b3c4d/console-tray.step: the STEP flow');

    // The lesson the real /lesson add made: its evidence is exactly this run's two records, never the older run's.
    const lessons = fs.readdirSync(path.join(s.root, '.timmy', 'memory', 'lessons')).filter((n) => n.endsWith('.json'));
    expect(lessons).toHaveLength(1);
    const lesson = json(path.join(s.root, '.timmy', 'memory', 'lessons', lessons[0]));
    expect(lesson).toMatchObject({ text: SENTENCE, status: 'draft', operation: op });
    expect((lesson.evidence as Array<{ path: string }>).map((e) => e.path)).toEqual([flowRel, voxRel]);
    expect(JSON.stringify(lesson)).not.toContain(older.id);
    expect(JSON.stringify(lesson)).not.toContain(olderVox.id);
    // Every receipt of the run names its operation; the chain verifies.
    const chain = readChain('runs', s.root).filter((r) => r.operation_id === op);
    for (const k of ['predict', 'flow', 'vox', 'lesson', 'workflow']) expect(chain.map((r) => r.kind), k).toContain(k);
    expect(verifyChain('runs', s.root).ok).toBe(true);
  }, 240_000);

  it('R4 (H102, part 2): /run WORKFLOW.md lesson when the request made no change: inspect takes the last build\'s STEP, and the lesson names the flow and its check, never a readback that did not run', async () => {
    const s = sandbox(kit, 'tray-workflow-nochange-');
    fs.rmSync(s.root, { recursive: true, force: true });
    expect(copyStarter('tray-workflow', s.root)).toHaveProperty('files');
    // FAKE: the STEP worker VoxVision runs (tests/helpers/vox-fakes.ts: not OCP; it answers in the worker's shape)
    const tools = fakeTools(temp('tray-vox-tools-'));
    // The last build: an earlier run (another operation) made its STEP (FAKE bytes) and its record.
    const last = fakeTrayFlow(s.root, { operation: 'o0f0f0f0f', job: '1a2b3c4d', dir: s.root });
    // `timmy` on PATH: the real CLI, but for the change block's act, the FAKE tray flow, which makes no change and finds that
    // last build current (its check in the check's shape; exit 0, as `timmy act` exits then).
    fs.writeFileSync(path.join(s.bin, 'timmy'), [
      '#!/bin/sh',
      `if [ "$1" = "act" ]; then case "$2" in /iterate*) FAKE_TRAY_OUTCOME="no change" FAKE_TRAY_JOB=1a2b3c4d exec "${TSX}" "${FAKE_TRAY}" "$@" ;; esac; fi`,
      `exec "${TSX}" "${CLI}" "$@"`, '',
    ].join('\n'), { mode: 0o755 });
    vi.stubEnv('TIMMY_CADQUERY_PYTHON', tools.step);
    vi.stubEnv('FAKE_STEP_SIZE', '150,80,30');
    const { ws } = replOf(kit, s);
    const started = text(await ws.operate('/run WORKFLOW.md lesson', 'repl', () => ws.run('WORKFLOW.md lesson')));
    const job = /Running\s+(j[0-9a-f]{6})/.exec(started)?.[1];
    expect(job, started).toBeDefined();
    const done = await ws.jobs.done(job!);
    const log = ws.jobs.tail(job!, 400).join('\n');
    expect(done.state, log).toBe('completed');
    const h = ws.ops.latest!;
    await ws.ops.done(h);
    const op = h.id;
    expect(done.steps.map((x) => [x.name, x.state, x.outcome ?? ''])).toEqual([['change', 'completed', 'no change'], ['inspect', 'completed', ''], ['result', 'completed', ''], ['lesson', 'completed', '']]);
    const flowName = fs.readdirSync(path.join(s.root, 'results', 'flows')).find((n) => n !== `${last.id}.json`)!;
    const flowRel = `results/flows/${flowName}`;
    expect(json(path.join(s.root, flowRel))).toMatchObject({ operation: op, outcome: 'no change', last_build: { state: 'current' } });
    expect(log).toContain(`step ${last.step}: the last build's STEP (recipe job 1a2b3c4d), which flow ${flowName.slice(0, -5)}'s check found current (the flow made no change)`);
    const voxName = fs.readdirSync(path.join(s.root, 'results', 'vox')).find((n) => n.endsWith('.json'))!;
    const voxRel = `results/vox/${voxName}`;
    expect(json(path.join(s.root, voxRel))).toMatchObject({ action: 'inspect', operation: op, inputs: [{ path: last.step }] });

    // The lesson the real /lesson add made: the no-change sentence, with this run's flow and VoxVision records as evidence.
    const lessons = fs.readdirSync(path.join(s.root, '.timmy', 'memory', 'lessons')).filter((n) => n.endsWith('.json'));
    expect(lessons).toHaveLength(1);
    const lesson = json(path.join(s.root, '.timmy', 'memory', 'lessons', lessons[0]));
    expect(lesson).toMatchObject({ text: NO_CHANGE_SENTENCE(flowName.slice(0, -5)), status: 'draft', operation: op });
    expect(String(lesson.text)).not.toContain('readback');
    expect((lesson.evidence as Array<{ path: string }>).map((e) => e.path)).toEqual([flowRel, voxRel]);

    // The run detail of the operation (src/ops/run-detail.ts) says no change, and names the lesson it made among its records.
    const d = runDetail(op, { project: s.root });
    expect(d.verdict.state).toBe('no change');
    expect(d.files).toContainEqual({ path: `.timmy/memory/lessons/${lessons[0]}`, role: 'record', from: `.timmy/memory/lessons/${lessons[0]}` });
  }, 240_000);
});
