/**
 * Round R4, the review's R4-7: a finished temporary file is put in place under its final name without replacing
 * anything, also on a disk that makes no hard links (src/utils/place-new.ts), and the places that do this share it:
 * recovery's record of an interrupted flow (src/repl/recover.ts) and an observation's kept file (src/vision/kept.ts).
 *
 * FAKE pieces, each labelled: a disk without hard links is simulated, never real. placeNew is given an injected link
 * function that throws EPERM or ENOTSUP, as link(2) does on exFAT and FAT drives; where the code is reached through its
 * callers, vi.spyOn on fs.linkSync throws the same. The files and folders are real, in os.tmpdir(). The flow state below
 * is SYNTHETIC (written by the test in the shape src/repl/iterate.ts saves).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NO_LINKS, placeNew } from '../src/utils/place-new.js';
import { FLOW_QUIET_MS, recoverProject } from '../src/repl/recover.js';
import { keepPrivate } from '../src/vision/kept.js';
import { DOCTRINE_15 } from '../src/recipes/index.js';
import type { ReceiptInput } from '../src/utils/receipts.js';

const dirs: string[] = [];
const temp = (prefix: string): string => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); dirs.push(d); return d; };
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: simulated by the test (a disk without hard links)`), { code });
/** FAKE: link(2) as a disk without hard links answers it. */
const noLinks = (code: string) => (): void => { throw errno(code); };

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('placeNew: a file takes its final name, never over another', () => {
  it('links where the disk makes hard links: the temporary name is a second name for the same file', () => {
    const dir = temp('place-new-');
    const tmp = path.join(dir, '.a.tmp');
    fs.writeFileSync(tmp, 'the bytes\n');
    expect(placeNew(tmp, path.join(dir, 'a.json'))).toBe('linked');
    expect(fs.readFileSync(path.join(dir, 'a.json'), 'utf8')).toBe('the bytes\n');
    expect(fs.statSync(tmp).ino).toBe(fs.statSync(path.join(dir, 'a.json')).ino);
  });

  for (const code of ['EPERM', 'ENOTSUP']) {
    it(`a disk without hard links (link throws ${code}): renamed into place once nothing is there`, () => {
      const dir = temp('place-new-');
      const tmp = path.join(dir, '.a.tmp');
      fs.writeFileSync(tmp, 'the bytes\n');
      expect(NO_LINKS.has(code)).toBe(true);
      expect(placeNew(tmp, path.join(dir, 'a.json'), noLinks(code))).toBe('renamed');
      expect(fs.readFileSync(path.join(dir, 'a.json'), 'utf8')).toBe('the bytes\n');
      expect(fs.existsSync(tmp)).toBe(false);
    });

    it(`a disk without hard links (${code}) and a name that is taken: refused as EEXIST, nothing replaced, the temporary file kept`, () => {
      const dir = temp('place-new-');
      const tmp = path.join(dir, '.a.tmp');
      fs.writeFileSync(tmp, 'new bytes\n');
      fs.writeFileSync(path.join(dir, 'a.json'), 'already there\n');
      let thrown: NodeJS.ErrnoException | undefined;
      try { placeNew(tmp, path.join(dir, 'a.json'), noLinks(code)); } catch (e) { thrown = e as NodeJS.ErrnoException; }
      expect(thrown?.code).toBe('EEXIST');
      expect(thrown?.message).not.toContain(dir);
      expect(fs.readFileSync(path.join(dir, 'a.json'), 'utf8')).toBe('already there\n');
      expect(fs.readFileSync(tmp, 'utf8')).toBe('new bytes\n');
    });
  }

  it('a taken name where links work: link\'s own EEXIST; any other error comes through as it was, and nothing is placed', () => {
    const dir = temp('place-new-');
    const tmp = path.join(dir, '.a.tmp');
    fs.writeFileSync(tmp, 'new bytes\n');
    fs.writeFileSync(path.join(dir, 'a.json'), 'already there\n');
    expect(() => placeNew(tmp, path.join(dir, 'a.json'))).toThrow(expect.objectContaining({ code: 'EEXIST' }));
    expect(fs.readFileSync(path.join(dir, 'a.json'), 'utf8')).toBe('already there\n');
    expect(() => placeNew(tmp, path.join(dir, 'b.json'), noLinks('EACCES'))).toThrow(expect.objectContaining({ code: 'EACCES' }));
    expect(fs.existsSync(path.join(dir, 'b.json'))).toBe(false);
    expect(fs.existsSync(tmp)).toBe(true);
  });
});

describe('recovery writes an interrupted flow\'s record on a disk without hard links', () => {
  /** SYNTHETIC: a flow's state file as /iterate saves it while its agent runs (src/repl/iterate.ts saveState). */
  const state = (id: string) => ({
    flow: 1, schema: 'timmy.flow/1', id, kind: 'iterate', recipe: 'enclosure.tray/1', instruction: 'make it 160 mm wide', project: 'demo',
    started_at: new Date().toISOString(), outcome: 'running',
    parameters: { path: 'recipes/tray.params.json', created: false, before: { sha256: 'a'.repeat(64), values: { width: 140, wall: 3, supportOffset: 10, bore: 3 } } },
    agent: { run: 'a0123abcd', agent: 'qwen', version: null, route: 'local endpoint, no charge', where: '127.0.0.1:11434', model: 'qwen3:4b', job: 'j0aaaa1', result: '.timmy/agents/a0123abcd/result.json', progress: '.timmy/agents/a0123abcd/progress.log' },
    receipts: {}, child_receipts: [], doctrine: DOCTRINE_15, step: 'agent',
  });

  for (const code of ['EPERM', 'ENOTSUP']) {
    it(`link throws ${code}: the record is renamed into place once, sealed, no temporary file left; a second pass writes nothing`, async () => {
      const root = temp('place-new-project-');
      const id = 'f0000eeee';
      const stateFile = path.join(root, '.timmy', 'flows', id, 'state.json');
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, `${JSON.stringify(state(id), null, 2)}\n`);
      const old = new Date(Date.now() - FLOW_QUIET_MS - 60_000);
      fs.utimesSync(stateFile, old, old);
      // FAKE: link(2) as an exFAT or FAT drive answers it.
      const link = vi.spyOn(fs, 'linkSync').mockImplementation(noLinks(code));
      const sealed: ReceiptInput[] = [];
      const deps = {
        root, project: 'demo', jobs: { list: () => [], get: () => undefined }, seal: (input: ReceiptInput) => { sealed.push(input); return `id${sealed.length}`; },
        receipts: () => [], scrub: (t: string) => t, mine: () => false, reattached: () => false, flowsHere: () => [],
        follow: () => { throw new Error('no recipe is followed in this test'); }, open: () => true, settleMs: 0,
      };
      const report = await recoverProject(deps);
      expect(report.items.map((i) => [i.kind, i.id, i.did])).toEqual([['flow', id, 'interrupted']]);
      expect(link).toHaveBeenCalled();
      const recordFile = path.join(root, 'results', 'flows', `${id}.json`);
      const record = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
      expect(record).toMatchObject({ id, outcome: 'interrupted', ended_in: 'agent' });
      expect(fs.readdirSync(path.dirname(recordFile))).toEqual([`${id}.json`]);
      expect(sealed).toEqual([expect.objectContaining({ kind: 'flow', subject: `flow · iterate · tray · ${id} · interrupted`, outputs: [{ path: `results/flows/${id}.json`, sha256: sha(fs.readFileSync(recordFile)), bytes: fs.statSync(recordFile).size }] })]);
      // Once: the record is the last word; the next pass leaves it as it is.
      expect((await recoverProject(deps)).items).toEqual([]);
      expect(sealed).toHaveLength(1);
    });
  }
});

describe('an observation\'s kept file on a disk without hard links (src/vision/kept.ts goes through the same helper)', () => {
  it('link throws EPERM: kept by rename under its name, then under name-2 when that is taken; no temporary file left', () => {
    const root = temp('place-new-kept-');
    // FAKE: link(2) as an exFAT or FAT drive answers it.
    const link = vi.spyOn(fs, 'linkSync').mockImplementation(noLinks('EPERM'));
    const first = keepPrivate({ root }, 'model-output', 'j0aaaa1-answer.txt', 'the whole answer\n');
    const second = keepPrivate({ root }, 'model-output', 'j0aaaa1-answer.txt', 'another answer\n');
    expect(link).toHaveBeenCalled();
    expect(first).toMatchObject({ ok: true, ref: { path: '.timmy/kept/model-output/j0aaaa1-answer.txt', sha256: sha('the whole answer\n') } });
    expect(second).toMatchObject({ ok: true, ref: { path: '.timmy/kept/model-output/j0aaaa1-answer-2.txt', sha256: sha('another answer\n') } });
    expect(fs.readdirSync(path.join(root, '.timmy', 'kept', 'model-output')).sort()).toEqual(['j0aaaa1-answer-2.txt', 'j0aaaa1-answer.txt']);
    expect(fs.readFileSync(path.join(root, '.timmy', 'kept', 'model-output', 'j0aaaa1-answer.txt'), 'utf8')).toBe('the whole answer\n');
  });
});
