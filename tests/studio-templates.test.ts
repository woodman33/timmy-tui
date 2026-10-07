import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { publicTemplates } from '../src/studio/templates.js';

// Fourth order, step 5: public templates start blank. A board seed shipped in the public tree
// (templates/boards) is read as its id, title, domain and capability names only, and Timmy Canvas
// opens it as a blank board: the title and an empty slot per capability, nothing else.
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const seeds = (files: Record<string, unknown>): string => {
  const dir = mkdtempSync(join(tmpdir(), 'timmy-boards-'));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  return dir;
};

describe('public board templates', () => {
  it("are the repo's seeds, each its id, title, domain and capability names, in the index's order", () => {
    const listed = publicTemplates();
    expect(listed.map((t) => t.id)).toEqual(['P63', 'T20', 'V111', 'T9', 'P59', 'T19', 'T21', 'T18']);
    expect(listed[0]).toEqual({ id: 'P63', title: 'Prompt Lab', domain: 'media generation', caps: ['prompt.draft', 'prompt.variant', 'prompt.score'] });
    for (const t of listed) expect(Object.keys(t).sort()).toEqual(['caps', 'domain', 'id', 'title']);
  });
  it('keep only those four fields, and skip a seed that carries anything that is not a template', () => {
    const dir = seeds({
      'INDEX.json': { boards: ['A1', 'B2', 'C3', 'D4', 'MISSING'] },
      'A1.json': { id: 'A1', title: 'Board', domain: 'ops', caps: ['run.status'], notes: 'kept out', owner: 'someone' },
      'B2.json': { id: 'B2', title: 'Board', domain: 'ops', caps: ['../notes/private.txt'] },
      'C3.json': { id: 'X9', title: 'Board', domain: 'ops', caps: ['run.status'] },
      'D4.json': '{ not json',
    });
    expect(publicTemplates(dir)).toEqual([{ id: 'A1', title: 'Board', domain: 'ops', caps: ['run.status'] }]);
  });
  it('are none when there is no index', () => {
    expect(publicTemplates(seeds({}))).toEqual([]);
  });
});

describe('the npm package', () => {
  it('ships the public board templates, so an installed canvas offers them', async () => {
    const { readFileSync } = await import('node:fs');
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { files: string[] };
    expect(pkg.files).toContain('templates/boards');
  });
});
