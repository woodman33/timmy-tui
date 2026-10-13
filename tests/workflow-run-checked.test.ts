/**
 * Round R4 (H81; review of 6fb765a..4338fdb, finding 2): what upmd runs is what /run checked. planRun reads the document's
 * bytes, NEEDS YOU asks about them, and upmd is given a private, read-only copy of exactly those bytes in the run's own
 * folder, so a writer that changes the document between the check and upmd's read changes nothing that runs. A document that
 * gives two blocks one name is refused: which of them upmd would run is not known.
 *
 * Real: the Workspace's /run and the board's Run, the job manager's child processes, the files the blocks write, the receipt
 * chain in the project (appendReceipt), the NEEDS YOU gate (askPerson). The writer is a real write to the project's document.
 * FAKE, each labelled where it is used:
 *   - upmd is tests/fixtures/fake-upmd.mjs, a TEST DOUBLE of upmd 0.2.7's --ci behaviour (it is not upmd; it reads the file
 *     it is given and runs each block for real through sh, in the -d folder);
 *   - the person who answers the NEEDS YOU box is the test's `ask`;
 *   - the writer runs when the REPL asks where python3 is (`onPath`), the call /run makes after the answer, after the
 *     prediction is sealed and before upmd starts: the window the review found. No python3 is given, so upmd's output is a
 *     pipe.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { folderProject } from '../src/project/index.js';
import type { ApprovalRequest, Decision } from '../src/repl/approvals.js';
import { runOf } from '../src/repl/board-workflows.js';
import { keepCheckedCopy, planRun } from '../src/repl/workflow-gate.js';
import { Workspace } from '../src/repl/workspace.js';
import { glyphSet } from '../src/term/glyphs.js';
import { appendReceipt, readChain, verifyChain, type Receipt } from '../src/utils/receipts.js';
import { BLOCK_RECEIPT_KIND } from '../src/workflows/block-receipts.js';
import { CHECKED_COPY, isCheckedCopy, repeatedNames, parseWorkflow } from '../src/workflows/upmd.js';

const FAKE_UPMD = path.resolve('tests/fixtures/fake-upmd.mjs');
const F = '```';
const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
const text = (lines: Array<Array<{ text: string }>>): string => lines.map((l) => l.map((s) => s.text).join('')).join('\n');
const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });
async function until<T>(what: string, get: () => T | undefined | false, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/** A risky run as checked: clean removes a file (rm: NEEDS YOU), build writes what it was checked to write. */
const CHECKED = ['# Clean build', '', `${F}bash [name:clean]`, 'rm -f old.txt', F, '', `${F}bash [name:build, deps:clean]`, 'echo checked > made.txt', F, ''].join('\n');
/** The same document as a writer leaves it after the answer: build now writes something else and leaves a flag. */
const SWAPPED = CHECKED.replace('echo checked > made.txt', 'echo swapped > made.txt; touch swapped.flag');
/** A run with no risky block, and the document a writer turns it into: a destructive command no box was asked about. */
const HARMLESS = ['# Notes', '', `${F}bash [name:note]`, 'echo noted > note.txt', F, ''].join('\n');
const HARMFUL = HARMLESS.replace('echo noted > note.txt', 'rm -rf keep; echo swapped > note.txt');
/** Two blocks named build: Timmy's reading takes the first; upmd's choice is not known. */
const TWICE = ['# Twice', '', `${F}bash [name:setup]`, 'echo one > one.txt', F, '', `${F}bash [name:build, deps:setup]`, 'echo built > built.txt', F, '', `${F}bash [name:build]`, 'rm -rf keep', F, ''].join('\n');

const dirs: string[] = [];
const spaces: Workspace[] = [];
afterEach(async () => {
  for (const w of spaces.splice(0)) await w.close();
  for (const d of dirs.splice(0)) {
    // the kept copies are read-only (0400); their folders are not, so they go with them
    fs.rmSync(d, { recursive: true, force: true });
  }
}, 60_000);

function project(docs: Record<string, string>): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'h81-checked-')));
  dirs.push(root);
  for (const [rel, body] of Object.entries(docs)) fs.writeFileSync(path.join(root, rel), body);
  fs.mkdirSync(path.join(root, 'keep'));
  fs.writeFileSync(path.join(root, 'keep', 'precious.txt'), 'keep me\n');
  return root;
}

/** The REPL's Workspace on the project; `writer` runs at /run's python3 lookup (see the header); `ask` the FAKE person. */
function make(root: string, o: { writer?: () => void; ask?: (req: ApprovalRequest) => Promise<Decision> } = {}) {
  const notes: string[] = [];
  const jobs = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'h81-jobs-')));
  dirs.push(jobs);
  const ws = new Workspace({
    glyphs: glyphSet(true), env: { ...process.env, UPMD_BIN: FAKE_UPMD },
    onPath: (cmd) => { if (cmd === 'python3') o.writer?.(); return null; },
    notify: (l) => notes.push(l.map((s) => s.text).join('')), openWeb: (u) => u, link: (t) => t,
    seal: (input) => appendReceipt('runs', input, root).hash.slice(7, 15),
    receipts: () => readChain('runs', root),
    jobsDir: path.join(jobs, 'jobs'), chdir: () => {}, recoverAtStart: false, roomTools: async () => [],
    ...(o.ask ? { askPerson: o.ask } : {}),
  }, folderProject(root));
  spaces.push(ws);
  return { ws, notes, jobsDir: path.join(jobs, 'jobs') };
}
const typed = (ws: Workspace, args: string) => ws.operate(`/run ${args}`, 'repl', () => ws.run(args));
const chainOf = (root: string): Receipt[] => readChain('runs', root);

describe('upmd runs the bytes /run checked (a private copy), never what a writer leaves after the check', () => {
  it('a risky run: the person answers, then a writer swaps a block before upmd starts; upmd runs the checked bytes, and the records name the document by its path with the checked sha256', async () => {
    const root = project({ 'RISKY.md': CHECKED });
    fs.writeFileSync(path.join(root, 'old.txt'), 'old\n');
    let answered = false;
    let swappedAt: 'after the answer' | 'before the answer' | undefined;
    const { ws, jobsDir } = make(root, {
      // FAKE person: allows it once, after seeing the checked command
      ask: async (req) => { expect(req.detail).toContain('rm -f old.txt'); answered = true; return 'once'; },
      // the writer: a real write to the project's document, after the answer and before upmd starts
      writer: () => { if (!swappedAt) { fs.writeFileSync(path.join(root, 'RISKY.md'), SWAPPED); swappedAt = answered ? 'after the answer' : 'before the answer'; } },
    });
    const said = text(await typed(ws, 'RISKY.md build'));
    expect(said).toMatch(/Approved\s+clean, once, in its NEEDS YOU box/);
    expect(swappedAt).toBe('after the answer');
    const job = await until('the job', () => ws.jobs.list().find((j) => j.label === 'RISKY.md › build'));
    expect((await ws.jobs.done(job.id)).state).toBe('completed');
    await sleep(80);
    // what ran is what was checked: the swapped block never ran
    expect(fs.readFileSync(path.join(root, 'made.txt'), 'utf8')).toBe('checked\n');
    expect(fs.existsSync(path.join(root, 'swapped.flag'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'old.txt'))).toBe(false);
    // the writer's change stands: Timmy never rewrites the person's file
    expect(fs.readFileSync(path.join(root, 'RISKY.md'), 'utf8')).toBe(SWAPPED);
    // upmd was given the copy: in the run's own folder, read-only, the checked bytes, the project as its working directory
    const file = job.args.at(-1)!;
    expect(isCheckedCopy(file)).toBe(true);
    expect(path.basename(file)).toBe(CHECKED_COPY);
    expect(file.startsWith(`${jobsDir}${path.sep}runs${path.sep}`)).toBe(true);
    expect(fs.readFileSync(file)).toEqual(Buffer.from(CHECKED));
    expect(fs.statSync(file).mode & 0o777).toBe(0o400);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(job.args.slice(job.args.indexOf('-d'), job.args.indexOf('-d') + 2)).toEqual(['-d', root]);
    expect(job.root).toBe(root);
    // the board and /jobs still name the run by its document in the project
    expect(runOf(job)).toEqual({ doc: 'RISKY.md', target: 'build' });
    // the records: the document by its project path, with the checked bytes' sha256; the block's code is the checked code
    const chain = chainOf(root);
    expect(verifyChain('runs', root).ok).toBe(true);
    const pred = chain.find((r) => r.kind === 'predict')!;
    expect(pred.files).toEqual([{ path: 'RISKY.md', sha256: sha(CHECKED) }]);
    const build = chain.find((r) => r.kind === BLOCK_RECEIPT_KIND && r.block?.name === 'build')!;
    expect(build.block).toMatchObject({ doc: 'RISKY.md', doc_sha256: sha(CHECKED), code_sha256: sha('echo checked > made.txt'), doc_at_end: 'changed', outcome: 'completed' });
  }, 60_000);

  it('a run with no risky block: a writer turns a block into rm -rf before upmd starts; the checked (harmless) block runs and nothing is removed', async () => {
    const root = project({ 'NOTES.md': HARMLESS });
    let asked = 0;
    let swapped = false;
    const { ws } = make(root, {
      ask: async () => { asked += 1; return 'deny'; },
      writer: () => { if (!swapped) { fs.writeFileSync(path.join(root, 'NOTES.md'), HARMFUL); swapped = true; } },
    });
    await typed(ws, 'NOTES.md note');
    expect(swapped).toBe(true);
    const job = await until('the job', () => ws.jobs.list().find((j) => j.label === 'NOTES.md › note'));
    expect((await ws.jobs.done(job.id)).state).toBe('completed');
    expect(asked).toBe(0);
    expect(fs.readFileSync(path.join(root, 'note.txt'), 'utf8')).toBe('noted\n');
    expect(fs.readFileSync(path.join(root, 'keep', 'precious.txt'), 'utf8')).toBe('keep me\n');
  }, 60_000);

  it('the copy is written once, with exactly the bytes held, and refuses to replace a file already there', () => {
    const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'h81-copy-')));
    dirs.push(folder);
    const bytes = Buffer.from(CHECKED);
    const kept = keepCheckedCopy(folder, { bytes, sha256: sha(bytes) });
    expect(kept).toEqual({ ok: true, path: path.join(folder, CHECKED_COPY), sha256: sha(bytes) });
    expect(fs.statSync(path.join(folder, CHECKED_COPY)).mode & 0o777).toBe(0o400);
    expect(keepCheckedCopy(folder, { bytes, sha256: sha(bytes) })).toEqual({ ok: false, why: 'the copy of it that upmd reads could not be kept (EEXIST)' });
    // bytes that are not the ones named: kept nowhere a run would use (the run does not start)
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'h81-copy-')));
    dirs.push(other);
    expect(keepCheckedCopy(other, { bytes, sha256: sha('not these bytes') })).toEqual({ ok: false, why: 'the copy kept for upmd does not hold the bytes Timmy checked' });
  });
});

describe('a document that gives two blocks one name is refused, saying which name, and nothing runs', () => {
  it('planRun says which name repeats and where; /run and the board\'s Run refuse it, for any block of it, and nothing runs or is sealed', async () => {
    expect(repeatedNames(parseWorkflow(TWICE))).toEqual([{ name: 'build', indexes: [2, 3] }]);
    const root = project({ 'TWICE.md': TWICE });
    const why = 'TWICE.md names two blocks build (blocks 2 and 3): Timmy cannot tell which of them upmd would run, so nothing ran. Give each block a name of its own.';
    expect(planRun(root, 'TWICE.md', 'build')).toEqual({ ok: false, why, failure: true, rel: 'TWICE.md' });
    expect(planRun(root, 'TWICE.md', 'setup')).toMatchObject({ ok: false, why });
    expect(planRun(root, 'TWICE.md')).toMatchObject({ ok: false, why });
    let asked = 0;
    const { ws } = make(root, { ask: async () => { asked += 1; return 'once'; } });
    expect(text(await typed(ws, 'TWICE.md build'))).toBe(`  ${why}`);
    expect(text(await typed(ws, 'TWICE.md setup'))).toBe(`  ${why}`);
    expect(text(await ws.operate('/run TWICE.md build', 'board', () => ws.run('TWICE.md build', { from: 'board' })))).toBe(`  ${why}`);
    expect(asked).toBe(0);
    expect(ws.jobs.list()).toEqual([]);
    expect(chainOf(root)).toEqual([]);
    expect(fs.readFileSync(path.join(root, 'keep', 'precious.txt'), 'utf8')).toBe('keep me\n');
    expect(fs.existsSync(path.join(root, 'built.txt'))).toBe(false);
    // two names repeated: each is said
    const both = ['# Both', '', `${F}bash [name:a]`, 'true', F, `${F}bash [name:b]`, 'true', F, `${F}bash [name:a]`, 'true', F, `${F}bash [name:b]`, 'true', F, `${F}bash [name:b]`, 'true', F, ''].join('\n');
    fs.writeFileSync(path.join(root, 'BOTH.md'), both);
    expect(planRun(root, 'BOTH.md', 'a')).toMatchObject({ ok: false, why: 'BOTH.md names two blocks a (blocks 1 and 3) and three blocks b (blocks 2, 4 and 5): Timmy cannot tell which of them upmd would run, so nothing ran. Give each block a name of its own.' });
  }, 60_000);
});
