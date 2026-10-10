/**
 * Round R4: recipes/tray.params.json, the parameter file /recipe, /iterate and the board's parameter card
 * share. Real files in a temporary project; the recipe's own rules decide what is valid.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PARAMS_SCHEMA, paramsPath, parseParams, readParams, writeParams } from '../src/recipes/params-file.js';
import { RECIPE_ID, readCard } from '../src/recipes/index.js';

const made: string[] = [];
const project = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'params-')); made.push(d); return d; };
afterEach(() => { for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
const put = (root: string, text: string): void => { fs.mkdirSync(path.join(root, 'recipes'), { recursive: true }); fs.writeFileSync(path.join(root, paramsPath()), text); };

describe('the recipe parameter file', () => {
  it('no file: the card defaults, and nothing is written by reading', () => {
    const root = project();
    const r = readParams(root);
    expect(r).toMatchObject({ ok: true, exists: false, path: 'recipes/tray.params.json' });
    expect(r.ok && r.parameters).toEqual(readCard().parameters);
    expect(fs.existsSync(path.join(root, 'recipes'))).toBe(false);
  });

  it('a file with some parameters: the card defaults under it, checked by the recipe rules', () => {
    const root = project();
    put(root, JSON.stringify({ schema: PARAMS_SCHEMA, recipe: RECIPE_ID, parameters: { width: 160 } }));
    const r = readParams(root);
    expect(r.ok && r.exists).toBe(true);
    expect(r.ok && r.parameters).toEqual({ ...readCard().parameters, width: 160 });
  });

  it('a value the recipe refuses, an unknown parameter, extra fields or bad JSON are refused with the reason', () => {
    expect(parseParams(JSON.stringify({ schema: PARAMS_SCHEMA, recipe: RECIPE_ID, parameters: { width: 20 } }))).toMatchObject({ ok: false, error: expect.stringMatching(/Conflicting tray dimensions/) });
    expect(parseParams(JSON.stringify({ schema: PARAMS_SCHEMA, recipe: RECIPE_ID, parameters: { depth: 90 } }))).toMatchObject({ ok: false, error: expect.stringMatching(/no parameter depth/) });
    expect(parseParams(JSON.stringify({ schema: PARAMS_SCHEMA, recipe: RECIPE_ID, parameters: { width: '160' } }))).toMatchObject({ ok: false, error: expect.stringMatching(/width must be a number/) });
    expect(parseParams(JSON.stringify({ schema: PARAMS_SCHEMA, recipe: RECIPE_ID, parameters: {}, note: 'x' }))).toMatchObject({ ok: false, error: expect.stringMatching(/unexpected field note/) });
    expect(parseParams('{ width: 160 }')).toMatchObject({ ok: false, error: expect.stringMatching(/^not JSON/) });
    expect(parseParams(JSON.stringify({ schema: 'other/1', recipe: RECIPE_ID, parameters: {} }))).toMatchObject({ ok: false, error: expect.stringMatching(/schema must be/) });
    const root = project();
    put(root, '{"schema":"timmy.recipe-params/1","recipe":"enclosure.tray/1","parameters":{"wall":11}}');
    const r = readParams(root);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a write checks the values, keeps the previous file under .timmy/params-history and replaces the file', () => {
    const root = project();
    const first = writeParams(root, { width: 150 });
    expect(first).toMatchObject({ ok: true, path: 'recipes/tray.params.json', parameters: { ...readCard().parameters, width: 150 } });
    expect(first.ok && first.previous).toBeUndefined();
    const before = fs.readFileSync(path.join(root, paramsPath()), 'utf8');
    const second = writeParams(root, { width: 170, wall: 2 });
    expect(second.ok).toBe(true);
    if (!second.ok || !second.previous) throw new Error('expected the previous file kept');
    expect(fs.readFileSync(path.join(root, second.previous.kept), 'utf8')).toBe(before);
    expect(readParams(root)).toMatchObject({ ok: true, exists: true, parameters: { width: 170, wall: 2 } });
    const refused = writeParams(root, { width: 2000 });
    expect(refused.ok).toBe(false);
    expect(readParams(root)).toMatchObject({ ok: true, parameters: { width: 170 } });
  });

  it('a symbolic link at the file or its folder is refused, and nothing is written through it', () => {
    const root = project();
    const elsewhere = project();
    fs.mkdirSync(path.join(root, 'recipes'));
    fs.symlinkSync(path.join(elsewhere, 'target.json'), path.join(root, paramsPath()));
    expect(writeParams(root, { width: 150 })).toMatchObject({ ok: false, error: expect.stringMatching(/symbolic link/) });
    expect(fs.existsSync(path.join(elsewhere, 'target.json'))).toBe(false);
    const root2 = project();
    fs.symlinkSync(elsewhere, path.join(root2, 'recipes'));
    expect(readParams(root2)).toMatchObject({ ok: false, error: expect.stringMatching(/symbolic link/) });
    expect(writeParams(root2, { width: 150 })).toMatchObject({ ok: false });
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });
});
