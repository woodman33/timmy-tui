import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { publicTemplates, type GuidedTemplate } from '../src/studio/templates.js';

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

// R5 (H133): the operator's order of 2026-10-15: "Templates shipped publicly start blank and guided, without private creative
// assets." Three guided blank boards: text and empty frames that say what goes where, nothing else.
describe('guided blank boards', () => {
  it('are the workflow, the fleet plan review and the VoxVision review, in the index\'s order, each text and empty frames only', async () => {
    const { guidedTemplates } = await import('../src/studio/templates.js');
    // R11 round 7 (H176): the three Houdini starters (kind 'starter'; tests/studio-starters.test.ts) are listed after them, in the
    // same answer; the guided boards themselves are as they were
    const all = guidedTemplates();
    expect(all.slice(3).map((t) => [t.id, (t as { kind?: string }).kind])).toEqual([['H1', 'starter'], ['H2', 'starter'], ['H3', 'starter']]);
    const listed = all.slice(0, 3).filter((t): t is GuidedTemplate => !('kind' in t));
    expect(listed.map((t) => [t.id, t.title, t.frames.length, t.flow])).toEqual([
      ['G1', 'Workflow: intent → predict → sandbox → review → receipt', 5, true],
      ['G2', 'Fleet plan review', 6, false],
      ['G3', 'VoxVision review', 6, false],
    ]);
    expect(listed[0].frames.map((f) => f.name)).toEqual(['Intent', 'Predict', 'Sandbox', 'Review', 'Receipt']);
    for (const t of listed) {
      expect(Object.keys(t).sort(), t.id).toEqual(['columns', 'domain', 'flow', 'frames', 'id', 'intro', 'title']);
      for (const f of t.frames) expect(Object.keys(f).sort(), `${t.id} ${f.name}`).toEqual(['guide', 'name']);
      // no example metric, address, path or number standing for a result: the words say what goes where, nothing more
      const text = JSON.stringify(t);
      expect(text, t.id).not.toMatch(/https?:|www\.|\/Users\/|\/home\/|~\/|\$|%|\d+(\.\d+)?\s*(ms|s|mm|cm|GB|MB|USD)\b|\.(png|jpe?g|svg|webp|glb|usd[az]?|blend)\b/i);
    }
    // the seeds are unchanged beside them
    expect(publicTemplates().map((t) => t.id)).toEqual(['P63', 'T20', 'V111', 'T9', 'P59', 'T19', 'T21', 'T18']);
  });
  it('read only their text fields, and refuse a seed that carries anything else in them (markup, an address, a home folder)', async () => {
    const { guidedTemplates } = await import('../src/studio/templates.js');
    const ok = { kind: 'guided', title: 'Review', domain: 'ops', intro: 'What this is for.', frames: [{ name: 'One', guide: 'What goes here.', image: 'secret.png' }], image: 'cover.png', owner: 'someone' };
    const dir = seeds({
      'INDEX.json': { guided: ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'X1'] },
      'G1.json': { id: 'G1', ...ok },
      'G2.json': { id: 'G2', ...ok, intro: 'See https://example.com for more.' },
      'G3.json': { id: 'G3', ...ok, frames: [{ name: 'One', guide: `Put ${['', 'Users', 'someone', 'art'].join('/')} here.` }] }, // a home folder (written in parts)
      'G4.json': { id: 'G4', ...ok, title: '<img src=x onerror=alert(1)>' },
      'G5.json': { id: 'G5', ...ok, kind: 'seed' },
      'G6.json': { id: 'G6', ...ok, frames: [] },
      'X1.json': { id: 'X1', ...ok },
    });
    // (the shipped starters follow whatever folder the guided boards are read from: they are code, not seeds of that folder)
    const starters = guidedTemplates(seeds({})).map((t) => t.id);
    expect(starters).toEqual(['H1', 'H2', 'H3']);
    expect(guidedTemplates(dir).slice(0, -starters.length)).toEqual([{ id: 'G1', title: 'Review', domain: 'ops', intro: 'What this is for.', flow: false, columns: 1, frames: [{ name: 'One', guide: 'What goes here.' }] }]);
  });
  it('are served beside the seeds by the canvas server, to anyone (they are public and blank)', async () => {
    const { startStudioServer } = await import('../src/studio/server.js');
    const { guidedTemplates } = await import('../src/studio/templates.js');
    const dir = mkdtempSync(join(tmpdir(), 'timmy-guided-home-'));
    dirs.push(dir);
    const server = await startStudioServer(0, { env: { TIMMY_HOME: dir, HOME: dir }, canvasDir: join(dir, 'canvas') });
    try {
      const port = (server.address() as { port: number }).port;
      const listed = await (await fetch(`http://127.0.0.1:${port}/api/canvas/templates`)).json() as { templates: unknown[]; guided: unknown[] };
      expect(listed.guided).toEqual(guidedTemplates());
      expect(listed.templates).toEqual(publicTemplates());
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});

describe('the npm package', () => {
  it('ships the public board templates, so an installed canvas offers them', async () => {
    const { readFileSync } = await import('node:fs');
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { files: string[] };
    expect(pkg.files).toContain('templates/boards');
  });
});
