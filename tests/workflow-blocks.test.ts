/**
 * Round R4 (helper H74; the plan's F-3 and R1 item 5): one receipt per workflow block, and NEEDS YOU before a risky block.
 *
 * Real: the Workspace's /run, the job manager's child processes, the receipt chain in the project (appendReceipt; checked
 * with verifyChain and verifyReceiptIn), the NEEDS YOU gate (src/repl/approvals.ts askPerson, the line every box waits in,
 * and the Control Room's "Waiting on you"), the files the blocks write, the pty wrapper (workers/upmd/pty_run.py under this
 * machine's python3, when there is one).
 * FAKE, each labelled where it is used:
 *   - upmd is tests/fixtures/fake-upmd.mjs, a TEST DOUBLE of upmd 0.2.7's --ci behaviour (it is not upmd; each block runs
 *     for real through sh);
 *   - the person who answers the NEEDS YOU box is the test's `ask` (the REPL's own reads a key: tests/workflow-md-cli.test.ts
 *     presses real keys in a real terminal through `timmy md`);
 *   - the flow record a block writes in the files test is FAKE: no flow ran; it is written in a flow record's shape so the
 *     block receipt's reading of Timmy's own records is exercised through a real run.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { folderProject } from '../src/project/index.js';
import { approvalNeeded, waitingApprovals, type ApprovalRequest, type Decision, type WaitingApproval } from '../src/repl/approvals.js';
import { connectWorkflow } from '../src/repl/board-workflows.js';
import { workflowForBoard } from '../src/repl/board-nodes.js';
import { Workspace } from '../src/repl/workspace.js';
import { riskyBlocks, UPMD_GATE } from '../src/repl/workflow-gate.js';
import { glyphSet } from '../src/term/glyphs.js';
import { appendReceipt, readChain, verifyChain, verifyReceiptIn, type Receipt } from '../src/utils/receipts.js';
import { BLOCK_RECEIPT_KIND, blockReceiptsOf } from '../src/workflows/block-receipts.js';
import { BLOCK_FILES_CHECKED } from '../src/workflows/block-files.js';
import { parseWorkflow } from '../src/workflows/upmd.js';

const FAKE_UPMD = path.resolve('tests/fixtures/fake-upmd.mjs');
const PYTHON3 = String(spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).stdout ?? '').trim() || null;
if (!PYTHON3) console.warn('workflow-blocks: no python3 here, so the pty cases are skipped');
const F = '```';
const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
const short = (r: Receipt): string => r.hash.slice(7, 15);
const text = (lines: Array<Array<{ text: string }>>): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });
const G = glyphSet(true);
async function until<T>(what: string, get: () => T | undefined | false, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

const SAFE = ['# Build', '', 'Make the site.', '', `${F}bash [name:setup]`, 'mkdir -p dist', F, '', `${F}bash [name:build, deps:setup]`, 'echo hi > dist/index.html && echo built', F, ''].join('\n');
const FAILS = ['# Fails', '', `${F}bash [name:first]`, 'echo first', F, '', `${F}bash [name:broken, deps:first]`, 'echo "nope" >&2; exit 3', F, '', `${F}bash [name:after, deps:broken]`, 'touch after.started', F, ''].join('\n');
const LONG = ['# Long', '', `${F}bash [name:first]`, 'echo ready', F, '', `${F}bash [name:long, deps:first]`, 'touch long.started', 'sleep 30', F, ''].join('\n');
const RISKY = [
  '# Clean build', '', 'Clean, then build.', '',
  `${F}bash [name:clean]`, 'rm -rf dist', F, '',
  `${F}bash [name:build, deps:clean]`, 'mkdir -p dist && echo built > dist/out.txt', F, '',
  `${F}bash [name:hello]`, 'echo hello', F, '',
].join('\n');

const dirs: string[] = [];
const spaces: Workspace[] = [];
afterEach(async () => {
  for (const w of spaces.splice(0)) await w.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
}, 60_000);

/** A project in a temporary folder with these documents; its receipt chain is its own (.timmy/receipts). */
function project(docs: Record<string, string>): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'h74-blocks-')));
  dirs.push(root);
  for (const [rel, body] of Object.entries(docs)) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), body); }
  return root;
}

/** The REPL's Workspace on that project: seals on its own chain; `ask` the person at its NEEDS YOU box (absent: none). */
function make(root: string, o: { pty?: boolean; ask?: (req: ApprovalRequest) => Promise<Decision> } = {}) {
  const notes: string[] = [];
  const jobs = fs.mkdtempSync(path.join(os.tmpdir(), 'h74-jobs-'));
  dirs.push(jobs);
  const ws = new Workspace({
    glyphs: glyphSet(true), env: { ...process.env, UPMD_BIN: FAKE_UPMD }, onPath: (cmd) => (o.pty && cmd === 'python3' ? PYTHON3 : null),
    notify: (l) => notes.push(l.map((s) => s.text).join('')), openWeb: (u) => u, link: (t) => t,
    seal: (input) => appendReceipt('runs', input, root).hash.slice(7, 15),
    receipts: () => readChain('runs', root),
    jobsDir: path.join(jobs, 'jobs'), chdir: () => {}, recoverAtStart: false, roomTools: async () => [],
    ...(o.ask ? { askPerson: o.ask } : {}),
  }, folderProject(root));
  spaces.push(ws);
  return { ws, notes };
}

/** A typed /run, as the REPL runs one: one operation. */
const typed = (ws: Workspace, args: string) => ws.operate(`/run ${args}`, 'repl', () => ws.run(args));
const jobOf = (ws: Workspace, label: string) => until(`the job ${label}`, () => ws.jobs.list().find((j) => j.label === label));
const chainOf = (root: string): Receipt[] => readChain('runs', root);
const blocksOf = (chain: Receipt[]): Receipt[] => chain.filter((r) => r.kind === BLOCK_RECEIPT_KIND);

describe('one receipt per block, sealed as it ends (the test-double upmd over a pipe; a real chain)', () => {
  it('each block ended gets its receipt after the prediction and before the run\'s own, which names them; /jobs, /workflows, the card and /op show them', async () => {
    const root = project({ 'BUILD.md': SAFE });
    const { ws, notes } = make(root);
    const said = text(await typed(ws, 'BUILD.md build'));
    expect(said).toMatch(/Predicted\s+setup → build, each exits 0 · receipt [0-9a-f]{8}/);
    const job = await jobOf(ws, 'BUILD.md › build');
    const done = await ws.jobs.done(job.id);
    await sleep(80);
    expect(done.state).toBe('completed');
    const chain = chainOf(root);
    expect(chain.map((r) => r.kind)).toEqual(['predict', BLOCK_RECEIPT_KIND, BLOCK_RECEIPT_KIND, 'workflow']);
    expect(verifyChain('runs', root).ok).toBe(true);
    const [pred, setup, build, run] = chain;
    for (const r of [setup, build]) expect(verifyReceiptIn(chain, r.hash)).toMatchObject({ ok: true });
    // every receipt of the run is under the one operation the typed line was
    const op = pred.operation_id;
    expect(op).toMatch(/^o[0-9a-f]{8}$/);
    expect(chain.every((r) => r.operation_id === op)).toBe(true);
    // what a block receipt holds
    const blocks = parseWorkflow(SAFE);
    expect(setup).toMatchObject({
      status: 'ok', policy: 'human-gated', subject: 'workflow · block · BUILD.md › build · setup · completed',
      block: {
        run: job.id, doc: 'BUILD.md', name: 'setup', index: 1, code_sha256: sha(blocks[0].code), doc_sha256: sha(SAFE), doc_at_end: 'unchanged',
        state: 'completed', outcome: 'completed', exit_code: 0, started_at: null, ms: null, seen: 'timmy', prediction: short(pred), files: [], files_checked: BLOCK_FILES_CHECKED,
      },
    });
    expect(setup.block!.code_sha256).toBe(sha('mkdir -p dist'));
    expect(Date.parse(setup.block!.ended_at!)).toBeGreaterThanOrEqual(Date.parse(done.startedAt));
    expect(build.block).toMatchObject({ name: 'build', index: 2, code_sha256: sha('echo hi > dist/index.html && echo built'), outcome: 'completed', exit_code: 0 });
    expect(setup.block!.interrupted_by).toBeUndefined();
    // the run's own receipt names each block's: in its steps and as its child receipts, in step order
    expect(run).toMatchObject({ status: 'ok', job: { id: job.id, state: 'completed', steps: [{ name: 'setup', state: 'completed', code: 0, receipt: short(setup) }, { name: 'build', state: 'completed', code: 0, receipt: short(build) }] }, child_receipts: [short(setup), short(build)], prediction: { met: true, receipt: short(pred) } });
    // the notices name each block's receipt as it ends
    expect(notes).toContain(`  ${G.bullet} ${job.id}  setup completed · 1 of 2 · block setup: receipt ${short(setup)}`);
    expect(notes).toContain(`  ${G.bullet} ${job.id}  build completed · 2 of 2 · block build: receipt ${short(build)}`);
    // /jobs <id>: each block with its receipt
    const shown = text(ws.jobsView(job.id)).split('\n');
    expect(shown[1]).toBe(`      ✓ setup  exit 0 · receipt ${short(setup)}`);
    expect(shown[2]).toBe(`      ✓ build  exit 0 · receipt ${short(build)}`);
    // /workflows BUILD.md and the card's data: the block's own receipt beside the run's
    const lines = text(await ws.workflows('BUILD.md'));
    expect(lines).toContain(`block setup: receipt ${short(setup)}`);
    const w = connectWorkflow(workflowForBoard('BUILD.md', { text: SAFE }), { root, jobs: [done], chain, files: ['BUILD.md'], upmd: true });
    expect(w.connected!.runs[0].blocks.map((b) => [b.name, b.receipt])).toEqual([['setup', short(setup)], ['build', short(build)]]);
    // /op: the operation's card names them too
    const card = text(ws.op(op!));
    expect(card).toContain(`block setup: receipt ${short(setup)} · block build: receipt ${short(build)}`);
    // the views read the chain: H78 and others get the same through blockReceiptsOf
    expect([...blockReceiptsOf(chain, job.id).values()].map((b) => [b.name, b.receipt, b.outcome])).toEqual([['setup', short(setup), 'completed'], ['build', short(build), 'completed']]);
  }, 60_000);

  it('a failing block: its receipt says failed with its exit; the blocks after it never started and get none', async () => {
    const root = project({ 'FAILS.md': FAILS });
    const { ws } = make(root);
    await typed(ws, 'FAILS.md after');
    const job = await jobOf(ws, 'FAILS.md › after');
    const done = await ws.jobs.done(job.id);
    await sleep(80);
    expect(done.state).toBe('failed');
    const chain = chainOf(root);
    expect(chain.map((r) => [r.kind, r.block?.name ?? null])).toEqual([['predict', null], [BLOCK_RECEIPT_KIND, 'first'], [BLOCK_RECEIPT_KIND, 'broken'], ['workflow', null]]);
    expect(chain[2]).toMatchObject({ status: 'failed', block: { name: 'broken', state: 'failed', outcome: 'failed', exit_code: 3 } });
    expect(chain[3]).toMatchObject({ status: 'failed', job: { steps: [{ name: 'first', receipt: short(chain[1]) }, { name: 'broken', code: 3, receipt: short(chain[2]) }] }, child_receipts: [short(chain[1]), short(chain[2])] });
    expect(fs.existsSync(path.join(root, 'after.started'))).toBe(false);
    expect(blockReceiptsOf(chain, job.id).has('after')).toBe(false);
    expect(text(ws.jobsView(job.id)).split('\n')[3]).toBe(`      ${G.bullet} after  not run`);
  }, 60_000);

  it('the document changed while the run ran: the block\'s receipt says so, and its code hash is the code /run read', async () => {
    const doc = ['# Slow', '', `${F}bash [name:slow]`, 'sleep 1', 'echo slept', F, ''].join('\n');
    const root = project({ 'SLOW.md': doc });
    const { ws } = make(root);
    await typed(ws, 'SLOW.md slow');
    const job = await jobOf(ws, 'SLOW.md › slow');
    await sleep(300);
    fs.writeFileSync(path.join(root, 'SLOW.md'), doc.replace('sleep 1', 'sleep 1 # edited while it ran'));
    await ws.jobs.done(job.id);
    await sleep(80);
    const [block] = blocksOf(chainOf(root));
    expect(block.block).toMatchObject({ name: 'slow', doc_at_end: 'changed', doc_sha256: sha(doc), code_sha256: sha('sleep 1\necho slept'), outcome: 'completed' });
  }, 60_000);

  it('files: only what the records of Timmy\'s own runs of this operation name, for the block during which they ran (a FAKE flow record)', async () => {
    // FAKE: each block writes a flow record by hand, in a flow record's shape, with node: no flow ran. `make` writes one
    // under this run's operation (TIMMY_OPERATION, as a block's `timmy act` joins it), `old` one that started an hour
    // before, and `stranger` one of another operation.
    const writer = (id: string, op: string, ago: number, step: string) => `node -e 'const fs=require("fs");const t=new Date(Date.now()-${ago}).toISOString();fs.mkdirSync("results/flows",{recursive:true});fs.writeFileSync("results/flows/${id}.json",JSON.stringify({id:"${id}",operation:${op},target:"tray",started_at:t,ended_at:new Date().toISOString(),outcome:"succeeded",parameters:{path:"recipes/tray.params.json",after:{sha256:"${step}".repeat(64)}},rebuild:{outputs:[{path:"out/tray.step",sha256:"${step === 'a' ? 'b' : 'c'}".repeat(64)}]}}))'`;
    const doc = [
      '# Records', '',
      `${F}bash [name:make]`, writer('f0000000a', 'process.env.TIMMY_OPERATION', 0, 'a'), writer('f0000000b', 'process.env.TIMMY_OPERATION', 3_600_000, 'd'), writer('f0000000c', '"o00000000"', 0, 'e'), F, '',
      `${F}bash [name:next, deps:make]`, writer('f0000000d', 'process.env.TIMMY_OPERATION', 0, 'f'), F, '',
    ].join('\n');
    const root = project({ 'REC.md': doc });
    const { ws } = make(root);
    await typed(ws, 'REC.md next');
    const job = await jobOf(ws, 'REC.md › next');
    expect((await ws.jobs.done(job.id)).state).toBe('completed');
    await sleep(80);
    const [first, second] = blocksOf(chainOf(root));
    expect(first.block!.files).toEqual([
      { path: 'recipes/tray.params.json', sha256: 'a'.repeat(64), role: 'the editable source (its parameters)', by: 'flow f0000000a', record: 'results/flows/f0000000a.json' },
      { path: 'out/tray.step', sha256: 'b'.repeat(64), role: 'STEP', by: 'flow f0000000a', record: 'results/flows/f0000000a.json' },
    ]);
    // the next block's own record, and only that (the same paths again, the bytes its record names)
    expect(second.block!.files.map((f) => [f.path, f.sha256, f.by])).toEqual([['recipes/tray.params.json', 'f'.repeat(64), 'flow f0000000d'], ['out/tray.step', 'c'.repeat(64), 'flow f0000000d']]);
    expect(first.block!.files_checked).toBe(BLOCK_FILES_CHECKED);
  }, 60_000);
});

describe.skipIf(!PYTHON3)('one receipt per block on a pty (workers/upmd/pty_run.py under python3)', () => {
  it('a block stopped while it runs gets one that says interrupted, by a stop; each block\'s own time from the pty', async () => {
    const root = project({ 'LONG.md': LONG });
    const { ws } = make(root, { pty: true });
    await typed(ws, 'LONG.md long');
    const job = await jobOf(ws, 'LONG.md › long');
    await until('long to run', () => ws.jobs.get(job.id)?.steps.some((s) => s.name === 'long' && s.state === 'running') && fs.existsSync(path.join(root, 'long.started')));
    // first's receipt is sealed already, as first ended; long has none while it runs
    expect(blocksOf(chainOf(root)).map((r) => r.block!.name)).toEqual(['first']);
    await ws.stop(job.id);
    const done = await ws.jobs.done(job.id);
    await sleep(80);
    expect(done.state).toBe('cancelled');
    const chain = chainOf(root);
    expect(chain.map((r) => [r.kind, r.block?.name ?? null])).toEqual([['predict', null], [BLOCK_RECEIPT_KIND, 'first'], [BLOCK_RECEIPT_KIND, 'long'], ['workflow', null]]);
    const [, first, long, run] = chain;
    expect(first.block).toMatchObject({ outcome: 'completed', exit_code: 0, seen: 'timmy' });
    expect(first.block!.started_at).toMatch(/^\d{4}-/);
    expect(first.block!.ms).toEqual(expect.any(Number));
    expect(long).toMatchObject({ status: 'cancelled', block: { name: 'long', state: 'stopped', outcome: 'interrupted', interrupted_by: 'stop', exit_code: null } });
    expect(long.block!.stop_words).toBeUndefined(); // a plain /stop: no words are claimed for it
    expect(run).toMatchObject({ status: 'cancelled', job: { steps: [{ name: 'first', receipt: short(first) }, { name: 'long', state: 'stopped', receipt: short(long) }] }, child_receipts: [short(first), short(long)] });
    expect(verifyChain('runs', root).ok).toBe(true);
    expect(text(ws.jobsView(job.id)).split('\n')[2]).toMatch(new RegExp(`^ {6}${G.bullet} long {2}stopped · (<0\\.1|\\d+\\.\\d) s · receipt ${short(long)}$`));
  }, 60_000);
});

describe('NEEDS YOU before a risky block (the gate the agent\'s tool calls wait in)', () => {
  it('a risky block is the rule the agent\'s shell tool is asked by: a destructive shell command', () => {
    for (const cmd of ['rm -rf dist', 'sudo make install', 'chmod +x run.sh', 'chown me x', 'dd if=/dev/zero of=x', 'mkfs.ext4 /dev/x', 'echo hi', 'ls -la', 'mkdir -p dist', 'cat notes.txt']) {
      const box = approvalNeeded('run_in_daytona_workspace', { command: cmd }, {})!;
      const risky = riskyBlocks(parseWorkflow(`${F}bash [name:a]\n${cmd}\n${F}\n`), ['a']);
      expect(risky.length === 1, cmd).toBe(box.reason.startsWith('destructive shell command'));
    }
    // only the blocks a run would run count: hello needs nothing, so its run has no risky block
    const blocks = parseWorkflow(RISKY);
    expect(riskyBlocks(blocks, ['clean', 'build']).map((b) => [b.name, b.index, b.command, b.code_sha256])).toEqual([['clean', 1, 'rm -rf dist', sha('rm -rf dist')]]);
    expect(riskyBlocks(blocks, ['hello'])).toEqual([]);
  });

  it('the REPL asks before anything runs, Waiting on you lists it with its command meanwhile; y runs it once and the prediction seals what was asked', async () => {
    const root = project({ 'RISKY.md': RISKY });
    let asked: ApprovalRequest | undefined;
    let waiting: WaitingApproval[] = [];
    let decisions = '';
    let ranBefore = true;
    // FAKE person: answers the box with y (allow once), after looking at what waits
    const { ws, notes } = make(root, {
      ask: async (req) => {
        asked = req;
        waiting = waitingApprovals();
        decisions = text(await ws.decisions(''));
        ranBefore = ws.jobs.list().length > 0 || chainOf(root).length > 0 || fs.existsSync(path.join(root, '.timmy', 'operations'));
        return 'once';
      },
    });
    fs.mkdirSync(path.join(root, 'dist'));
    fs.writeFileSync(path.join(root, 'dist', 'old.txt'), 'old');
    const said = text(await typed(ws, 'RISKY.md build'));
    // nothing had run, been sealed or recorded while the box waited
    expect(ranBefore).toBe(false);
    expect(asked).toEqual({
      tool: '/run RISKY.md build', reason: 'runs a destructive shell command on this machine: clean', summary: 'clean: rm -rf dist',
      detail: 'clean (block 1 of RISKY.md):\n  rm -rf dist\nupmd runs clean → build; approved together, before the run', session: false,
    });
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ tool: '/run RISKY.md build', session: false, shown: true, words: { title: 'NEEDS YOU: /run RISKY.md build (clean: rm -rf dist)', keys: true, commands: [] } });
    expect(waiting[0].operation).toMatch(/^o[0-9a-f]{8}$/);
    expect(decisions).toContain('! NEEDS YOU: /run RISKY.md build (clean: rm -rf dist)  blocks a running request');
    expect(decisions).toContain('needed  answer its NEEDS YOU box in the REPL: y runs it once, n, Esc or Enter deny it; nothing of the run starts until then');
    expect(decisions).toContain('why     upmd would run clean → build, and clean runs a destructive shell command on this machine: rm -rf dist; upmd runs a block only after');
    expect(decisions).toContain('keys    y: allow it once · n, Esc or Enter: deny it');
    // the prediction's words, before the box
    expect(notes.slice(0, 3)).toEqual([
      '  Predicted  clean → build, each exits 0 · nothing runs or is sealed until you answer',
      '  Needs you  clean: rm -rf dist · a destructive shell command on this machine',
      `             ${UPMD_GATE}.`,
    ]);
    expect(said).toMatch(/Approved\s+clean, once, in its NEEDS YOU box\n\s+Predicted\s+clean → build, each exits 0 · receipt [0-9a-f]{8}/);
    expect(waitingApprovals()).toEqual([]);
    const job = await jobOf(ws, 'RISKY.md › build');
    expect((await ws.jobs.done(job.id)).state).toBe('completed');
    await sleep(80);
    expect(fs.existsSync(path.join(root, 'dist', 'old.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'dist', 'out.txt'), 'utf8')).toBe('built\n');
    const chain = chainOf(root);
    expect(chain.map((r) => r.kind)).toEqual(['predict', BLOCK_RECEIPT_KIND, BLOCK_RECEIPT_KIND, 'workflow']);
    expect(chain[0]).toMatchObject({
      prediction: { doc: 'RISKY.md', block: 'build', order: ['clean', 'build'], risky: [{ name: 'clean', reason: 'a destructive shell command on this machine', code_sha256: sha('rm -rf dist') }], gate: UPMD_GATE },
      decisions: [{ decision: 'allow once', effect: 'run clean → build', tier: 'NEEDS YOU (the person, in its box)', reason: 'clean: a destructive shell command on this machine' }],
    });
    expect(verifyChain('runs', root).ok).toBe(true);
  }, 60_000);

  it('n denies it: nothing runs, nothing is sealed or recorded; a run of a block with no risky block in it never asks', async () => {
    const root = project({ 'RISKY.md': RISKY });
    let asks = 0;
    const { ws } = make(root, { ask: async () => { asks += 1; return 'deny'; } });
    expect(text(await typed(ws, 'RISKY.md build'))).toBe('  Not run: you denied it in its NEEDS YOU box. Nothing ran, and nothing was sealed.');
    expect(asks).toBe(1);
    expect(ws.jobs.list()).toEqual([]);
    expect(chainOf(root)).toEqual([]);
    expect(fs.existsSync(path.join(root, '.timmy', 'operations'))).toBe(false);
    // hello needs nothing and is not risky: no box
    await typed(ws, 'RISKY.md hello');
    expect(asks).toBe(1);
    const job = await jobOf(ws, 'RISKY.md › hello');
    expect((await ws.jobs.done(job.id)).state).toBe('completed');
  }, 60_000);

  it('the document changed while the person was asked: refused, nothing runs or is sealed (what was approved is not what would run)', async () => {
    const root = project({ 'RISKY.md': RISKY });
    const { ws } = make(root, { ask: async () => { fs.writeFileSync(path.join(root, 'RISKY.md'), RISKY.replace('rm -rf dist', 'rm -rf dist ..')); return 'once'; } });
    expect(text(await typed(ws, 'RISKY.md build'))).toBe('  Not run: RISKY.md changed while you were asked, so what you approved is not what upmd would read. Nothing ran, and nothing was sealed: /run RISKY.md build asks again.');
    expect(ws.jobs.list()).toEqual([]);
    expect(chainOf(root)).toEqual([]);
  }, 60_000);

  it('the live board cannot show the box: its Run is refused before anything runs and waits on you with the command, until a run of it starts or its document changes', async () => {
    const root = project({ 'RISKY.md': RISKY });
    let asks = 0;
    const { ws } = make(root, { ask: async () => { asks += 1; return 'once'; } });
    const refused = text(await ws.operate('/run RISKY.md build', 'board', () => ws.run('RISKY.md build', { from: 'board' })));
    expect(refused).toBe('  Not run: clean (rm -rf dist) is a destructive shell command on this machine, which needs a person, and the board cannot ask you. Type this in the REPL instead: /run RISKY.md build');
    expect(asks).toBe(0);
    expect(ws.jobs.list()).toEqual([]);
    expect(chainOf(root)).toEqual([]);
    const listed = text(await ws.decisions(''));
    // nothing runs: it blocks the run that was requested (as a refused save "blocks a requested save"), not a running one
    expect(listed).toContain('! NEEDS YOU: /run RISKY.md build from the board (clean: rm -rf dist)  blocks a requested run');
    expect(listed).not.toContain('blocks a running request');
    expect(listed).toContain('needed  type the command below in the REPL and answer its NEEDS YOU box: the board cannot show the box, so its Run was refused and nothing ran');
    expect(listed).toContain('type    /run RISKY.md build');
    // a run of it typed in the REPL (asked, allowed once) settles it
    await typed(ws, 'RISKY.md build');
    expect(asks).toBe(1);
    expect(text(await ws.decisions(''))).not.toContain('NEEDS YOU: /run RISKY.md build');
    await ws.jobs.done((await jobOf(ws, 'RISKY.md › build')).id);
    // refused again, then the document changes: it no longer waits
    await ws.run('RISKY.md build', { from: 'board' });
    expect(text(await ws.decisions(''))).toContain('NEEDS YOU: /run RISKY.md build from the board');
    fs.writeFileSync(path.join(root, 'RISKY.md'), `${RISKY}\n`);
    expect(text(await ws.decisions(''))).not.toContain('NEEDS YOU: /run RISKY.md build');
  }, 60_000);

  it('with no person to ask (no terminal: no box), a risky run is refused before anything runs, with the command to type in the REPL', async () => {
    const root = project({ 'RISKY.md': RISKY });
    const { ws, notes } = make(root);
    expect(text(await typed(ws, 'RISKY.md build'))).toBe('  Not run: clean (rm -rf dist) is a destructive shell command on this machine, which needs a person, and this Timmy (no terminal) cannot ask you. Type this in the REPL instead: /run RISKY.md build');
    expect(notes[0]).toBe('  Predicted  clean → build, each exits 0');
    expect(ws.jobs.list()).toEqual([]);
    expect(chainOf(root)).toEqual([]);
  }, 60_000);
});
