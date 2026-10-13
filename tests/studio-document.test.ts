import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CanvasDocuments, canvasDir } from '../src/studio/document.js';

// Fourth order, step 5: Timmy Canvas is saved by Timmy, on this machine, so it reopens where it was,
// the terminal and the page agree on what it holds, and each job is tied to the exact document it
// produced: its source revision, the sha256 of the saved document (as the vision lane uses the term).
let dir = '';
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'timmy-canvas-doc-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const SNAP = { store: { 'page:page': { id: 'page:page', typeName: 'page', name: 'Page 1', index: 'a1', meta: {} } }, schema: { schemaVersion: 2, sequences: {} } };
const sha = (o: unknown): string => createHash('sha256').update(JSON.stringify(o)).digest('hex');

describe('the canvas file', () => {
  it("lives in Timmy's home, beside the rest of the operator's state", () => {
    expect(canvasDir({ TIMMY_HOME: '/x/home' })).toBe(join('/x/home', 'canvas'));
  });
  it('a new canvas is blank at revision 0, with no source revision, and reading it writes nothing', () => {
    expect(new CanvasDocuments(dir).load()).toEqual({ revision: 0, sourceRevision: null, savedAt: null, snapshot: null });
    expect(readdirSync(dir)).toEqual([]);
  });
  it('saves the whole document, readable by its owner only, named by the sha256 of what was saved', () => {
    const saved = new CanvasDocuments(dir).save({ snapshot: SNAP, revision: 3, baseRevision: 0 });
    expect(saved).toEqual({ ok: true, revision: 3, sourceRevision: sha(SNAP), savedAt: expect.any(String) });
    expect(readdirSync(dir)).toEqual(['canvas.json']); // written whole: no temporary file left behind
    expect(statSync(join(dir, 'canvas.json')).mode & 0o777).toBe(0o600);
  });
  it('reopens what was saved, in a new process as in this one', () => {
    const first = new CanvasDocuments(dir).save({ snapshot: SNAP, revision: 3, baseRevision: 0 });
    expect(new CanvasDocuments(dir).load()).toEqual({ revision: 3, sourceRevision: sha(SNAP), savedAt: (first as { savedAt: string }).savedAt, snapshot: SNAP });
  });
  it('refuses a save made from an older revision: another window saved since, and nothing is merged', () => {
    const docs = new CanvasDocuments(dir);
    docs.save({ snapshot: SNAP, revision: 5, baseRevision: 0 });
    const before = readFileSync(join(dir, 'canvas.json'), 'utf8');
    expect(docs.save({ snapshot: { ...SNAP, store: {} }, revision: 4, baseRevision: 0 })).toEqual({
      ok: false, conflict: true, revision: 5,
      error: 'Another window saved this canvas at revision 5 after this one opened it. Reload to continue; changes made here since then are not saved.',
    });
    expect(readFileSync(join(dir, 'canvas.json'), 'utf8')).toBe(before);
  });
  it('keeps an unreadable canvas file aside, never deletes it, and opens blank saying where it went', () => {
    writeFileSync(join(dir, 'canvas.json'), '{ not json');
    const opened = new CanvasDocuments(dir).load();
    expect(opened).toMatchObject({ revision: 0, sourceRevision: null, snapshot: null });
    const kept = readdirSync(dir).find((f) => f.startsWith('canvas.json.unreadable-'));
    expect(kept).toBeDefined();
    expect(readFileSync(join(dir, kept!), 'utf8')).toBe('{ not json');
    expect(opened.notice).toBe(`The saved canvas could not be read, so it was kept as ${kept} beside it and this one starts blank.`);
  });
  it('refuses a document over the size cap, saying so', () => {
    const docs = new CanvasDocuments(dir, { maxBytes: 200 });
    expect(docs.save({ snapshot: { ...SNAP, big: 'x'.repeat(500) }, revision: 1, baseRevision: 0 })).toEqual({ ok: false, tooLarge: true, error: 'This canvas is too large to save (over 200 bytes).' });
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('peeking at the canvas', () => {
  it('reads the revision, source revision and save time without the document, and moves nothing', () => {
    const docs = new CanvasDocuments(dir);
    expect(docs.peek()).toEqual({ revision: 0, sourceRevision: null, savedAt: null });
    const saved = docs.save({ snapshot: SNAP, revision: 4, baseRevision: 0 }) as { savedAt: string };
    expect(docs.peek()).toEqual({ revision: 4, sourceRevision: sha(SNAP), savedAt: saved.savedAt });
    writeFileSync(join(dir, 'canvas.json'), '{ not json');
    expect(docs.peek()).toEqual({ revision: null, sourceRevision: null, savedAt: null, unreadable: true });
    expect(readdirSync(dir).sort()).toEqual(['canvas.json']); // still there: only the canvas page moves it aside
  });
});

describe('the jobs ledger', () => {
  it('records each job with the revision and source revision it produced, and links its receipt', () => {
    const docs = new CanvasDocuments(dir);
    expect(docs.jobs()).toEqual([]);
    docs.recordJob('turn-1a2b', { ok: true, revision: 3, sourceRevision: sha(SNAP) });
    docs.recordJob('turn-1a2b', { ok: true, revision: 6, sourceRevision: sha({ a: 1 }) });
    docs.linkReceipt('turn-1a2b', '0f3c9a12');
    expect(docs.jobs()).toEqual([{ id: 'turn-1a2b', ok: true, calls: 2, failed: 0, revision: 6, sourceRevision: sha({ a: 1 }), at: expect.any(String), receipt: '0f3c9a12' }]);
    expect(new CanvasDocuments(dir).jobs()).toHaveLength(1);
  });
  it('a failed call marks the job failed; newest jobs first; job IDs and receipt IDs are checked', () => {
    const docs = new CanvasDocuments(dir);
    docs.recordJob('a', { ok: true, revision: 1, sourceRevision: sha(1) });
    docs.recordJob('b', { ok: false, revision: 1, sourceRevision: sha(1) });
    expect(docs.jobs().map((j) => [j.id, j.ok])).toEqual([['b', false], ['a', true]]);
    expect(() => docs.recordJob('bad id!', { ok: true, revision: 1, sourceRevision: sha(1) })).toThrow('job ID');
    expect(() => docs.linkReceipt('a', '<script>')).toThrow('receipt ID');
    expect(docs.linkReceipt('nope', '0f3c9a12')).toBe(false);
  });
  it('keeps the newest 200 jobs', () => {
    const docs = new CanvasDocuments(dir);
    for (let i = 0; i < 205; i++) docs.recordJob(`job-${i}`, { ok: true, revision: i, sourceRevision: sha(i) });
    const jobs = docs.jobs();
    expect(jobs).toHaveLength(200);
    expect(jobs[0].id).toBe('job-204');
    expect(jobs.at(-1)!.id).toBe('job-5');
  });
});
