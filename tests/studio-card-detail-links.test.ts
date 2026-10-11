/**
 * Round R4 (H81; review of 6fb765a..4338fdb, finding 4, hashing): what a drawn card says a file is now
 * (src/studio/card-detail.ts shaNow) is read only inside the project, with no link anywhere on its path: before, only the
 * last part of the path was checked, so a folder link in the middle (out -> a folder outside the project) let the canvas
 * hash, and size, a file outside the project. Real files and real symbolic links in temporary folders.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { shaNow } from '../src/studio/card-detail.js';

const sha = (b: string): string => createHash('sha256').update(b).digest('hex');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const temp = (prefix: string): string => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); dirs.push(d); return d; };

describe('shaNow: a project file\'s sha256 now, never through a link anywhere on its path', () => {
  it('hashes a file of the project; refuses a folder link in the middle (to a folder outside the project or inside it), a link at the end, and a private file', () => {
    const root = temp('h81-detail-');
    const outside = temp('h81-outside-');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside the project\n');
    fs.mkdirSync(path.join(root, 'results', 'run1'), { recursive: true });
    fs.writeFileSync(path.join(root, 'results', 'run1', 'out.txt'), 'made by a run\n');
    // a folder link in the middle, to a folder outside the project
    fs.symlinkSync(outside, path.join(root, 'results', 'out'));
    // a folder link in the middle, to a folder inside the project
    fs.symlinkSync(path.join(root, 'results', 'run1'), path.join(root, 'results', 'alias'));
    // a link at the end
    fs.symlinkSync(path.join(root, 'results', 'run1', 'out.txt'), path.join(root, 'results', 'run1', 'same.txt'));
    fs.writeFileSync(path.join(root, '.env'), 'NOT_A_REAL_KEY=1\n');

    expect(shaNow(root, 'results/run1/out.txt')).toEqual({ sha: sha('made by a run\n'), bytes: 14 });
    expect(shaNow(root, 'results/out/secret.txt')).toEqual({ why: 'link' });
    expect(shaNow(root, 'results/alias/out.txt')).toEqual({ why: 'link' });
    expect(shaNow(root, 'results/run1/same.txt')).toEqual({ why: 'link' });
    expect(shaNow(root, 'results/run1/gone.txt')).toEqual({ why: 'gone' });
    expect(shaNow(root, '.env')).toEqual({ why: 'unreadable' });
  });
});
