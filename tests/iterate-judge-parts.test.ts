/**
 * Round R4, the review's R4-2, the parts without a REPL: the /iterate check's snapshot (judgeSnapshot) and what is made
 * of it (regularOf, judgedChanges, notComparedText), and the words of the change judge (judgeAgentChanges) when files in
 * a .timmy folder changed; and which recipe job folders count as Timmy's own writes (liveRecipeJobFolders). Real files in
 * os.tmpdir(); every file here is SYNTHETIC, written by the test.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { judgedChanges, judgeSnapshot, notComparedText, NOT_COMPARED_MAX, regularOf, snapshotProject, type ChangeSet } from '../src/code-agents/index.js';
import { judgeAgentChanges } from '../src/flows/iterate.js';
import { liveRecipeJobFolders } from '../src/recipes/index.js';

let root: string;
const write = (rel: string, body = `SYNTHETIC ${rel}\n`): void => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), body); };

beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'iterate-judge-parts-'))); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('the check\'s snapshot covers .timmy and dist at every depth, leaves out Timmy\'s own writes and names what it does not look into', () => {
  it('covers .timmy and dist at the top and nested; skips the own folders; names .git and node_modules wherever they are', () => {
    for (const rel of ['src/a.txt', '.timmy/receipts/runs.jsonl', '.timmy/agents/a0000beef/result.json', '.timmy/agents/a1111beef/run.json',
      '.timmy/flows/f00000001/state.json', 'dist/x.js', 'pkg/dist/y.js', 'pkg/.timmy/z.json', '.git/HEAD', 'pkg/node_modules/m/index.js', 'pkg/sub/.git']) write(rel);
    const s = judgeSnapshot(root, ['.timmy/agents/a1111beef', '.timmy/flows/f00000001/']);
    expect([...s.files.keys()].sort()).toEqual(['.timmy/agents/a0000beef/result.json', '.timmy/receipts/runs.jsonl', 'dist/x.js', 'pkg/.timmy/z.json', 'pkg/dist/y.js', 'src/a.txt']);
    // A folder is named with a trailing /; a file named .git (a worktree's pointer) without one.
    expect(s.notCompared.sort()).toEqual(['.git/', 'pkg/node_modules/', 'pkg/sub/.git']);
    expect(s.truncated).toBe(false);
    // /agent's own view of the same walk: exactly what its own snapshot sees.
    expect([...regularOf(s.files).keys()].sort()).toEqual([...snapshotProject(root).files.keys()].sort());
  });

  it('judgedChanges: the changes under .timmy and dist, the own folders with a trailing /, the entries not looked into (the first 20, then a count)', () => {
    write('.timmy/receipts/runs.jsonl');
    write('dist/x.js');
    for (let i = 0; i < NOT_COMPARED_MAX + 3; i++) write(`p${String(i).padStart(2, '0')}/node_modules/m.js`);
    const own = ['.timmy/agents/a1111beef', '.timmy/flows/f00000001'];
    const before = judgeSnapshot(root, own);
    write('.timmy/receipts/runs.jsonl', 'SYNTHETIC: rewritten\n');
    write('.timmy/agents/a1111beef/result.json');
    write('.timmy/flows/f00000001/state.json');
    write('dist/y.js');
    fs.rmSync(path.join(root, 'dist', 'x.js'));
    const j = judgedChanges(before, judgeSnapshot(root, own), own);
    expect(j.files.added.map((c) => c.path)).toEqual(['dist/y.js']);
    expect(j.files.changed.map((c) => c.path)).toEqual(['.timmy/receipts/runs.jsonl']);
    expect(j.files.deleted.map((c) => c.path)).toEqual(['dist/x.js']);
    expect(j.own).toEqual(['.timmy/agents/a1111beef/', '.timmy/flows/f00000001/']);
    expect(j.not_compared).toHaveLength(NOT_COMPARED_MAX);
    expect(j.not_compared[0]).toBe('p00/node_modules/');
    expect(j.not_compared_more).toBe(3);
    expect(notComparedText(j)).toBe(`${j.not_compared.join(', ')} and 3 more (folders named .git or node_modules are not looked into, for size)`);
    expect(notComparedText({ not_compared: [] })).toBe('');
    expect(notComparedText(undefined)).toBe('');
  });
});

describe('the change judge says changes in a .timmy folder apart (Timmy cannot tell who changed them)', () => {
  const files = (paths: Array<[string, 'added' | 'changed' | 'deleted']>, truncated = false): ChangeSet & { truncated: boolean } => ({
    added: paths.filter(([, h]) => h === 'added').map(([p]) => ({ path: p, size: 1, sha256: 'a'.repeat(64) })),
    changed: paths.filter(([, h]) => h === 'changed').map(([p]) => ({ path: p, size: 1, sha256: 'b'.repeat(64), previous_sha256: 'c'.repeat(64) })),
    deleted: paths.filter(([, h]) => h === 'deleted').map(([p]) => ({ path: p, size: 0, sha256: null, previous_sha256: 'd'.repeat(64) })),
    truncated,
  });

  it('only .timmy changed: stopped in those words alone', () => {
    const j = judgeAgentChanges(files([['recipes/tray.params.json', 'changed'], ['.timmy/receipts/runs.jsonl', 'changed'], ['pkg/.timmy/x', 'deleted']]), 'recipes/tray.params.json');
    expect(j).toMatchObject({ ok: false, reason: 'others' });
    expect(!j.ok && j.why).toBe('changed while the agent ran: .timmy/receipts/runs.jsonl (changed), pkg/.timmy/x (deleted) (Timmy cannot tell who changed it)');
  });

  it('both: the agent\'s words first, then the .timmy words; each list names 12 and counts the rest', () => {
    const many = Array.from({ length: 14 }, (_, i) => [`.timmy/x${String(i).padStart(2, '0')}`, 'added'] as [string, 'added']);
    const j = judgeAgentChanges(files([['dist/x.js', 'added'], ...many]), 'scene.py');
    const named = many.slice(0, 12).map(([p]) => `${p} (added)`).join(', ');
    expect(!j.ok && j.why).toBe(`the agent changed files other than scene.py: dist/x.js (added); changed while the agent ran: ${named} and 2 more (Timmy cannot tell who changed it)`);
    expect(!j.ok && j.others).toHaveLength(15);
  });

  it('nothing in .timmy: the words are as before', () => {
    const j = judgeAgentChanges(files([['notes/other.txt', 'added']]), 'recipes/tray.params.json');
    expect(!j.ok && j.why).toBe('the agent changed files other than recipes/tray.params.json: notes/other.txt (added)');
  });
});

describe('the recipe jobs not over are Timmy\'s own writes while an agent runs (their supervisors keep writing them)', () => {
  it('a job folder with neither terminal.json nor recovered.json is live; an ended one is not; other names are ignored; nothing is made', () => {
    expect(liveRecipeJobFolders(root)).toEqual([]);
    expect(fs.existsSync(path.join(root, '.timmy'))).toBe(false);
    const live = '0b1c2d3e-0000-4000-8000-000000000001';
    const queued = '0b1c2d3e-0000-4000-8000-000000000002';
    const ended = '0b1c2d3e-0000-4000-8000-000000000003';
    const recovered = '0b1c2d3e-0000-4000-8000-000000000004';
    write(`.timmy/recipe-jobs/${live}/claim.json`);
    write(`.timmy/recipe-jobs/${live}/heartbeat.json`);
    write(`.timmy/recipe-jobs/${queued}/job.json`);
    write(`.timmy/recipe-jobs/${ended}/terminal.json`);
    write(`.timmy/recipe-jobs/${recovered}/recovered.json`);
    write('.timmy/recipe-jobs/not-a-job/claim.json');
    expect(liveRecipeJobFolders(root)).toEqual([`.timmy/recipe-jobs/${live}/`, `.timmy/recipe-jobs/${queued}/`]);
  });
});
