// p13 FORGE lane tests (decisions.md D1-D6; DESIGN.md §1 read-only law).
// All chain writes go to a tmp dir — the real ledger is never touched here.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runGen, forgeEnabled } from '../src/forge/gen.js';
import { emitTimeline } from '../src/forge/timeline.js';
import { loadSheet, validateSheet } from '../src/forge/sheet.js';
import { wireLanes } from '../src/forge/stubs.js';
import { readChain, verifyChain } from '../src/utils/receipts.js';

const SHEET = {
  tldrawVersion: '2.0.0', sheet_id: 'sheet-test', budget_cap_usd: 1, aspect: '16:9',
  shapes: {
    a: { id: 'a', type: 'frame', meta: { slot_id: 'slot-hero-1', class: 'hero', required: true, prompt: 'a keeper who trusts receipts', provider_pref: 'stub', est_cost_usd: 0.4 } },
    b: { id: 'b', type: 'frame', meta: { slot_id: 'slot-terrain-1', class: 'terrain', required: true, prompt: 'fog over black water', provider_pref: 'stub', est_cost_usd: 0.3 } },
    c: { id: 'c', type: 'frame', meta: { slot_id: 'slot-weather-1', class: 'weather', required: false, prompt: 'drizzle and wind', provider_pref: 'stub', est_cost_usd: 0.2 } },
  },
};

let dir: string;
let sheetPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'forge-test-'));
  sheetPath = join(dir, 'sheet.tldr.json');
  writeFileSync(sheetPath, JSON.stringify(SHEET));
  process.env.TIMMY_FORGE = '1';
});
afterEach(() => { delete process.env.TIMMY_FORGE; });

describe('forge gate (D1)', () => {
  it('refuses to run without TIMMY_FORGE=1', () => {
    delete process.env.TIMMY_FORGE;
    expect(forgeEnabled()).toBe(false);
    expect(() => runGen({ sheet: sheetPath, stub: true, dir })).toThrow(/gated/);
  });
  it('wire lanes report flag_off until armed', () => {
    delete process.env.TIMMY_HOUDINI_MCP;
    const w = wireLanes();
    expect(w.every(x => x.via === 'cmcp')).toBe(true);
    expect(w[0].status).toBe('flag_off');
  });
});

describe('CUE sheet gate (D3, D8)', () => {
  it('accepts a valid tldraw sheet', () => {
    expect(() => validateSheet(loadSheet(sheetPath))).not.toThrow();
  });
  it('rejects over-budget sheets before any gen fires', () => {
    const bad = { ...SHEET, budget_cap_usd: 0.5 };
    const p = join(dir, 'bad.json');
    writeFileSync(p, JSON.stringify(bad));
    expect(() => validateSheet(loadSheet(p))).toThrow(/CUE/);
  });
  it('rejects sheets without a required hero', () => {
    const bad = JSON.parse(JSON.stringify(SHEET)) as typeof SHEET;
    bad.shapes.a.meta.class = 'terrain';
    const p = join(dir, 'nohero.json');
    writeFileSync(p, JSON.stringify(bad));
    expect(() => validateSheet(loadSheet(p))).toThrow(/CUE/);
  });
  it('rejects duplicate slot_id (reconstruction contract, D5)', () => {
    const bad = JSON.parse(JSON.stringify(SHEET)) as typeof SHEET;
    bad.shapes.c.meta.slot_id = 'slot-hero-1';
    const p = join(dir, 'dup.json');
    writeFileSync(p, JSON.stringify(bad));
    expect(() => validateSheet(loadSheet(p))).toThrow(/duplicate/);
  });
});

describe('gen cycle on stub (D2, D4, D5)', () => {
  it('seals gen.request + gen.result per slot with computed local', () => {
    const lines = runGen({ sheet: sheetPath, stub: true, dir });
    expect(lines.length).toBe(3);
    for (const l of lines) {
      expect(l.local).toBe(true); // stub path consults no API key (D2)
      expect(l.cost).toBe(0);
      expect(existsSync(l.artifact)).toBe(true);
    }
    const chain = readChain('runs', dir);
    const reqs = chain.filter(r => r.kind === 'gen.request');
    const res = chain.filter(r => r.kind === 'gen.result');
    expect(reqs.length).toBe(3);
    expect(res.length).toBe(3);
    for (const r of res) {
      const s = (r.sources as { slot_id: string; local: boolean }[])[0];
      expect(s.slot_id).toMatch(/^slot-/); // pinned for reconstruction (D5)
      expect(s.local).toBe(true);
      expect(r.output_sha256).toMatch(/^sha256_/);
      expect(r.prompt_hash).toMatch(/^sha256_/);
    }
  });
  it('agent may fill fewer optional slots', () => {
    const lines = runGen({ sheet: sheetPath, stub: true, dir, slots: ['slot-hero-1'] });
    expect(lines.map(l => l.slot_id)).toEqual(['slot-hero-1']);
  });
  it('chain verifies after a full cycle (§1 intact)', () => {
    runGen({ sheet: sheetPath, stub: true, dir });
    expect(verifyChain('runs', dir).ok).toBe(true);
  });
});

describe('timeline emit (D3, D6)', { timeout: 30000 }, () => {
  it('emits OTIO that the pinned python parses, with timmy metadata', () => {
    runGen({ sheet: sheetPath, stub: true, dir });
    const r = emitTimeline({ dir });
    expect(r.clips).toBe(3);
    const tl = JSON.parse(readFileSync(r.file, 'utf8')) as { tracks: { children: { children: { OTIO_SCHEMA: string; metadata: { timmy: Record<string, string> } }[] }[] } };
    const clip = tl.tracks.children[0].children[0];
    expect(clip.OTIO_SCHEMA).toBe('Clip.2');
    expect(clip.metadata.timmy.receipt_hash).toMatch(/^sha256_/);
    expect(clip.metadata.timmy.prev).toMatch(/^sha256_/);
    expect(clip.metadata.timmy.prompt_hash).toMatch(/^sha256_/);
    expect(clip.metadata.timmy.gen_id).toBeTruthy();
    expect(clip.metadata.timmy.rights).toBeTruthy();
    const chain = readChain('runs', dir);
    expect(chain.some(x => x.kind === 'timeline.emit' && x.output_sha256)).toBe(true);
    expect(verifyChain('runs', dir).ok).toBe(true);
  });
  it('refuses to emit with no gen.result receipts', () => {
    expect(() => emitTimeline({ dir })).toThrow(/no gen.result/);
  });
});
