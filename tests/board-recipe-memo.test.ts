/**
 * Round R4, task H29 (5): the live board polls every 2 seconds per open page, and each poll verified up to four recipe
 * jobs afresh, hashing every export several times (measured: 35 ms a poll with 4 MB of exports, 118 ms with 20 MB).
 * The board now keeps each recipe card with a fingerprint of everything its checks read (type, device, inode, size,
 * mtime and ctime of every file and folder) and checks afresh only when the fingerprint changed or is too recent to
 * trust. These tests hold the cache to that: an unchanged project is not read again, and an export changed between
 * two polls, even with its size and modification time kept, shows unverified on the very next poll.
 *
 * The jobs are real (the detached supervisor and native worker of lanes/recipes/jobs.ts) and run a FAKE executor: it
 * writes SYNTHETIC exports (text, not geometry) and signs a result for them; nothing is built or measured.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ChildProcess } from 'node:child_process';
import { enqueue, jobDirectory, start, status } from '../lanes/recipes/jobs.js';
import { deliver, EXPORTS, outDir } from '../src/recipes/index.js';
import { recipeResults, type ResultCard } from '../src/repl/board-cards.js';

const request = { schema: 'timmy.recipe-request/1', recipe: 'enclosure.tray/1', parameters: { width: 140, wall: 3, supportOffset: 10, bore: 3 } };
let root = '';
let supervisors: ChildProcess[] = [];
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-recipe-memo-')); supervisors = []; });
afterEach(async () => {
  vi.restoreAllMocks();
  await until('the supervisors to exit', () => supervisors.every((c) => c.exitCode !== null || c.signalCode !== null), 15_000).catch(() => undefined);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
const until = async (what: string, pred: () => boolean, ms = 30_000) => {
  const end = Date.now() + ms;
  while (!pred()) { if (Date.now() > end) throw Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 50)); }
};

/** The FAKE executor: SYNTHETIC exports and a signed result for them (the pattern of tests/recipe-jobs.test.ts). */
function executor(): string {
  const file = path.join(root, 'fake-exports.mts');
  const m = (rel: string) => JSON.stringify(pathToFileURL(path.resolve(rel)).href);
  fs.writeFileSync(file, `
import fs from 'node:fs'; import path from 'node:path'; import {randomUUID} from 'node:crypto';
import {loadJob,jobDirectory,recordResult} from ${m('lanes/recipes/jobs.ts')};
import {appendReceipt} from ${m('src/utils/receipts.ts')};
import {sha} from ${m('lanes/recipes/tray.ts')};
const [,root,id]=process.argv.slice(2), job=loadJob(root,id), workspace=path.join(jobDirectory(root,id),'workspace');
const run=randomUUID(), base=path.join(workspace,'.timmy','recipe-runs',run);fs.mkdirSync(base,{recursive:true});
fs.writeFileSync(path.join(base,'request.json'),JSON.stringify(job.request));
const common={subject:'synthetic board-cache test; no geometry claim',policy:'auto',status:'ok',cost_usd:0,env_lock:{os:{platform:'test'},tools:{}}};
fs.writeFileSync(path.join(base,'prediction.json'),JSON.stringify({synthetic:true}));fs.writeFileSync(path.join(base,'build.py'),'SYNTHETIC no-native source');
const predictionSources=['request.json','prediction.json','build.py'].map(f=>({path:path.join(base,f),sha256:sha(fs.readFileSync(path.join(base,f)))}));
const prediction=appendReceipt('runs',{...common,kind:'recipe.prediction',sources:predictionSources},workspace);
const native=path.join(base,'native');fs.mkdirSync(native);
const exports=['outer.stl','cavity.stl','bosses.stl','bores.stl','console-tray.step'].map(f=>{fs.writeFileSync(path.join(native,f),'SYNTHETIC export '+f+'; not geometry');return {file:f,sha256:sha(fs.readFileSync(path.join(native,f)))};});
fs.writeFileSync(path.join(native,'result.json'),'{}');fs.writeFileSync(path.join(base,'native.log'),'synthetic worker');
const sources=[path.join(native,'result.json'),path.join(base,'native.log'),...exports.map(e=>path.join(native,e.file))].map(f=>({path:f,sha256:sha(fs.readFileSync(f))}));
const receipt=appendReceipt('runs',{...common,kind:'recipe.build',child_receipts:[prediction.id],sources},workspace);
const result={state:'succeeded',run,receipt:receipt.id,receiptHash:receipt.hash,checksPassed:30,exports};fs.writeFileSync(path.join(base,'report.json'),JSON.stringify(result));
recordResult(root,id,{...result,directory:base});
`);
  return file;
}
/** Two succeeded jobs, delivered into the project, every file of them older than the board's settle time (2 s). */
async function project(): Promise<string[]> {
  const file = executor();
  const ids = [enqueue(request, { root, executor: file }).job.id, enqueue(request, { root, executor: file }).job.id];
  for (const id of ids) await start(root, id, { onSupervisor: (c) => { supervisors.push(c); } });
  await until('both jobs to succeed', () => ids.every((id) => status(root, id).state === 'succeeded'));
  await until('the supervisors to exit', () => supervisors.every((c) => c.exitCode !== null || c.signalCode !== null));
  for (const id of ids) expect(deliver(root, id)).toMatchObject({ ok: true });
  // whole-second times, so tamper() can put a modification time back exactly (utimes takes no nanoseconds)
  const t = new Date(Math.floor(Date.now() / 1000) * 1000 - 10_000);
  for (const id of ids) for (const name of EXPORTS) for (const f of [nativeExport(id, name), copiedExport(id, name)]) fs.utimesSync(f, t, t);
  await new Promise((r) => setTimeout(r, 2300));
  return ids;
}
const nativeExport = (id: string, name: string): string => {
  const envelope = JSON.parse(fs.readFileSync(path.join(jobDirectory(root, id), 'result.json'), 'utf8'));
  return path.join(envelope.result.directory, 'native', name);
};
const copiedExport = (id: string, name: string): string => path.join(root, outDir(id), name);
/** Rewrites a file in place with different bytes of the same length, and puts its modification time back exactly:
 *  only its ctime (which no call can set back) still says it changed. */
function tamper(file: string): Buffer {
  const before = fs.readFileSync(file);
  const was = fs.statSync(file, { bigint: true });
  fs.writeFileSync(file, Buffer.alloc(before.length, 0x58));
  fs.utimesSync(file, new Date(Number(was.atimeMs)), new Date(Number(was.mtimeMs)));
  const now = fs.statSync(file, { bigint: true });
  expect(now.size).toBe(was.size);
  expect(now.mtimeNs, 'its modification time is exactly as it was').toBe(was.mtimeNs);
  expect(now.ctimeNs).not.toBe(was.ctimeNs);
  return before;
}
/** Runs one poll's recipe cards, counting how often each job's exports (in the job and in the project) were read. */
function poll(ids: string[]): { cards: Map<string, ResultCard>; reads: Map<string, number> } {
  const real = fs.readFileSync;
  const reads = new Map<string, number>(ids.map((id) => [id, 0]));
  const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (typeof file === 'string' && (EXPORTS as readonly string[]).includes(path.basename(file))) {
      for (const id of ids) if (file.includes(id) || file.includes(outDir(id))) reads.set(id, (reads.get(id) ?? 0) + 1);
    }
    return (real as (...a: unknown[]) => unknown)(file, ...rest);
  }) as typeof fs.readFileSync);
  try {
    const cards = new Map(recipeResults(root).map((c) => [ids.find((id) => c.title.endsWith(id.slice(0, 8)))!, c]));
    return { cards, reads };
  } finally { spy.mockRestore(); }
}
const verified = (c?: ResultCard) => c?.status.word === 'succeeded' && c.status.tone === 'ok';

describe.skipIf(process.platform === 'win32')('the board\'s recipe cards: kept while nothing they read changed (FAKE executor)', () => {
  it('reads no export again on an unchanged project, and shows an export changed between polls as unverified on the next poll', async () => {
    const [a, b] = await project();
    const first = poll([a, b]);
    expect(verified(first.cards.get(a)) && verified(first.cards.get(b))).toBe(true);

    const second = poll([a, b]);
    expect(second.reads.get(a), 'no export of an unchanged job is read again').toBe(0);
    expect(second.reads.get(b)).toBe(0);
    // shown again, not checked again: the card says when its checks ran, and is otherwise the same card
    const shown = second.cards.get(a)!;
    expect(first.cards.get(a)?.status.detail).toBe('its signed result verified now, and every copied file matches its sha256');
    expect(shown.status).toMatchObject({ word: 'succeeded', tone: 'ok' });
    expect(shown.status.detail).toMatch(/^its signed result and every copied file's sha256 were verified at \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC; no file those checks read has changed since$/);
    expect({ ...shown, status: null }).toEqual({ ...first.cards.get(a), status: null });

    // the project's copy changed: same size, the same modification time
    const copy = copiedExport(a, 'outer.stl');
    const original = tamper(copy);
    const third = poll([a, b]);
    expect(third.cards.get(a)?.status).toMatchObject({ word: 'succeeded', tone: 'attention' });
    expect(third.cards.get(a)?.status.detail).toBe(`but its exports are not verified in the project: ${outDir(a)}/outer.stl differs from the verified result`);
    expect(verified(third.cards.get(b)), 'the other job is unchanged').toBe(true);
    expect(third.reads.get(b), 'and is not read again').toBe(0);

    // put back: verified again (checked afresh, not from what was kept before the change)
    fs.writeFileSync(copy, original);
    expect(verified(poll([a, b]).cards.get(a))).toBe(true);

    // the job's own native export changed the same way: its signed result no longer verifies
    tamper(nativeExport(b, 'cavity.stl'));
    const fifth = poll([a, b]);
    expect(fifth.cards.get(b)?.status).toMatchObject({ word: 'interrupted', tone: 'failed' });
    expect(fifth.cards.get(b)?.status.detail).toMatch(/verification-failed: Recorded result could not be verified/);
  }, 90_000);

  it('checks afresh, on every poll, while a file is too recent to trust its times', async () => {
    const [a] = await project();
    poll([a]);
    // a change now gives the file a time inside the settle window: never kept, checked on every poll
    const copy = copiedExport(a, 'bores.stl');
    const original = tamper(copy);
    expect(verified(poll([a]).cards.get(a))).toBe(false);
    fs.writeFileSync(copy, original);
    const again = poll([a]);
    expect(verified(again.cards.get(a))).toBe(true);
    expect(again.reads.get(a), 'checked afresh: its files were just written').toBeGreaterThan(0);
  }, 90_000);
});
