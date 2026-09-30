// p13 FORGE lane tests (decisions.md D1-D6; DESIGN.md §1 read-only law).
// All chain writes go to a tmp dir — the real ledger is never touched here.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, appendFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as childProcess from 'node:child_process';
import { tmpdir } from 'node:os';
import { runGen, forgeEnabled } from '../src/forge/gen.js';
import { emitTimeline, markProbeValidation, type SegmentValidation } from '../src/forge/timeline.js';
import { loadSheet, validateSheet } from '../src/forge/sheet.js';
import { wireLanes } from '../src/forge/stubs.js';
import { readChain, receiptsPath, verifyChain, appendReceipt } from '../src/utils/receipts.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

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
  it('refuses to run without TIMMY_FORGE=1', async () => {
    delete process.env.TIMMY_FORGE;
    expect(forgeEnabled()).toBe(false);
    await expect(runGen({ sheet: sheetPath, stub: true, dir })).rejects.toThrow(/gated/);
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
  it('seals gen.request + gen.result per slot with computed local', async () => {
    const lines = await runGen({ sheet: sheetPath, stub: true, dir });
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
  it('agent may fill fewer optional slots', async () => {
    const lines = await runGen({ sheet: sheetPath, stub: true, dir, slots: ['slot-hero-1'] });
    expect(lines.map(l => l.slot_id)).toEqual(['slot-hero-1']);
  });
  it('chain verifies after a full cycle (§1 intact)', async () => {
    await runGen({ sheet: sheetPath, stub: true, dir });
    expect(verifyChain('runs', dir).ok).toBe(true);
  });
});

describe('timeline emit (D3, D6)', { timeout: 30000 }, () => {
  it('emits OTIO that the pinned python parses, with timmy metadata', async () => {
    await runGen({ sheet: sheetPath, stub: true, dir });
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
  it('marks probe-validated vs extrapolated clips, matched by slot beat id', async () => {
    await runGen({ sheet: sheetPath, stub: true, dir });
    const r = emitTimeline({
      dir,
      segments: [
        { beat_id: 'slot-hero-1', probe_validated: true },
        { beat_id: 'slot-terrain-1', probe_validated: false },
      ],
    });
    const tl = JSON.parse(readFileSync(r.file, 'utf8')) as { tracks: { children: { children: { name: string; metadata: { timmy: Record<string, unknown> } }[] }[] } };
    const clips = tl.tracks.children[0].children;
    const byName = new Map(clips.map(c => [c.name, c.metadata.timmy]));
    // validated at probe resolution: flagged true, beat id recorded
    expect(byName.get('forge slot-hero-1')?.probe_validated).toBe(false);
    expect(byName.get('forge slot-hero-1')?.probe_validation_declared).toBe(true);
    expect(byName.get('forge slot-hero-1')?.beat_id).toBe('slot-hero-1');
    // seen only at full render: flagged false
    expect(byName.get('forge slot-terrain-1')?.probe_validated).toBe(false);
    expect(byName.get('forge slot-terrain-1')?.beat_id).toBe('slot-terrain-1');
    // no segment info for this slot: no new keys (differential trust stays silent)
    expect(byName.get('forge slot-weather-1')?.probe_validated).toBeUndefined();
    expect(byName.get('forge slot-weather-1')?.beat_id).toBeUndefined();
    expect(verifyChain('runs', dir).ok).toBe(true);
  });
  it('emits byte-identical clips when no segment info is given (backward compat)', async () => {
    await runGen({ sheet: sheetPath, stub: true, dir });
    const plain = emitTimeline({ dir });
    const tl = JSON.parse(readFileSync(plain.file, 'utf8')) as { tracks: { children: { children: { metadata: { timmy: Record<string, unknown> } }[] }[] } };
    for (const c of tl.tracks.children[0].children) {
      expect('probe_validated' in c.metadata.timmy).toBe(false);
      expect('beat_id' in c.metadata.timmy).toBe(false);
    }
  });
});

// Direct contract tests for the exported helper — synthetic clips, no
// receipts/ledger. MUTATES clips in place; each case builds its own array.
describe('markProbeValidation (unit)', () => {
  type SyntheticClip = { metadata: { timmy: Record<string, unknown> }; name: string };
  const clip = (name: string, meta: Record<string, unknown>): SyntheticClip => ({ metadata: { timmy: meta }, name });
  // mirrors the emitter's slotIdOf: slot_id wins, gen_id falls back, '' last
  const slotIdOf = (c: SyntheticClip) => (c.metadata.timmy.slot_id as string) || (c.metadata.timmy.gen_id as string) || '';

  it('falls back to gen_id when slot_id is absent', () => {
    const clips = [clip('a', { gen_id: 'gen-1' }), clip('b', { gen_id: 'gen-2' })];
    const segments: SegmentValidation[] = [{ beat_id: 'gen-2', probe_validated: true }];
    markProbeValidation(clips, segments, slotIdOf);
    expect(clips[0].metadata.timmy.probe_validated).toBeUndefined(); // no match
    expect(clips[1].metadata.timmy.probe_validated).toBe(false);
    expect(clips[1].metadata.timmy.probe_validation_declared).toBe(true); // matched via gen_id
    expect(clips[1].metadata.timmy.beat_id).toBe('gen-2');
  });

  it('marks every clip when slot_ids repeat across clips', () => {
    const clips = [clip('a', { slot_id: 's1' }), clip('b', { slot_id: 's1' }), clip('c', { slot_id: 's2' })];
    const segments: SegmentValidation[] = [{ beat_id: 's1', probe_validated: false }];
    markProbeValidation(clips, segments, slotIdOf);
    expect(clips[0].metadata.timmy.probe_validated).toBe(false);
    expect(clips[1].metadata.timmy.probe_validated).toBe(false); // duplicate slot_id: both marked
    expect(clips[2].metadata.timmy.probe_validated).toBeUndefined();
  });

  it('rejects duplicate beat_id declarations before mutation', () => {
    const clips = [clip('a', { slot_id: 's1' })];
    const segments: SegmentValidation[] = [
      { beat_id: 's1', probe_validated: true },
      { beat_id: 's1', probe_validated: false },
    ];
    expect(() => markProbeValidation(clips, segments, slotIdOf)).toThrow(/duplicate/);
    expect(clips[0].metadata.timmy.probe_validated).toBeUndefined();
  });

  it('empty-string key matches nothing: clip left untouched', () => {
    const clips = [clip('a', { slot_id: '', gen_id: '' })];
    const segments: SegmentValidation[] = [{ beat_id: 's1', probe_validated: true }];
    markProbeValidation(clips, segments, slotIdOf);
    expect('probe_validated' in clips[0].metadata.timmy).toBe(false);
    expect('beat_id' in clips[0].metadata.timmy).toBe(false);
  });

  it('undefined segments leaves every clip untouched', () => {
    const clips = [clip('a', { slot_id: 's1' })];
    markProbeValidation(clips, undefined, slotIdOf);
    expect('probe_validated' in clips[0].metadata.timmy).toBe(false);
  });
});


describe('probe metadata boundaries', () => {
  it('rejects malformed and duplicate declarations before mutating clips', () => {
    const clips = [{ name: 'a', metadata: { timmy: {} as Record<string, unknown> } }];
    expect(() => markProbeValidation(clips, [{ beat_id: 'a', probe_validated: 'yes' } as unknown as SegmentValidation], () => 'a')).toThrow();
    expect(() => markProbeValidation(clips, [{ beat_id: 'a', probe_validated: true }, { beat_id: 'a', probe_validated: false }], () => 'a')).toThrow(/duplicate/);
    expect(clips[0].metadata.timmy).toEqual({});
  });
  it('retains caller declarations without upgrading them to verified metadata', () => {
    const clips = [{ name: 'a', metadata: { timmy: {} as Record<string, unknown> } }];
    markProbeValidation(clips, [{ beat_id: 'a', probe_validated: true }], () => 'a');
    expect(clips[0].metadata.timmy).toMatchObject({ probe_validated: false, probe_validation_declared: true, probe_validation_state: 'declared' });
  });
});


describe('timeline output preservation', () => {
  it('excludes unsuccessful generation receipts from emitted clips', async () => {
    await runGen({ sheet: sheetPath, stub: true, dir });
    appendReceipt('runs', { kind: 'gen.result', subject: 'synthetic failure', policy: 'auto', status: 'failed', artifacts: [], sources: [] } as never, dir);
    const output = emitTimeline({ dir });
    expect(output.clips).toBe(3);
    expect(readFileSync(output.file, 'utf8')).not.toContain('file://undefined');
  });
  it('refuses existing output without changing its bytes or appending a receipt', async () => {
    await runGen({ sheet: sheetPath, stub: true, dir });
    const out = join(dir, 'existing.otio'); writeFileSync(out, 'keep original');
    const receiptsBefore = readChain('runs', dir).length;
    expect(() => emitTimeline({ dir, out })).toThrow(/already exists/);
    expect(readFileSync(out, 'utf8')).toBe('keep original');
    expect(readChain('runs', dir)).toHaveLength(receiptsBefore);
  });
});


it('rejects malformed physical receipt rows instead of silently dropping them', async () => {
  await runGen({ sheet: sheetPath, stub: true, dir });
  appendFileSync(receiptsPath('runs', dir), '{broken-json}\n');
  expect(() => emitTimeline({ dir })).toThrow();
});

it('native OTIO rejection leaves no public output and no staging directory', async () => {
  await runGen({ sheet: sheetPath, stub: true, dir });
  const out = join(dir, 'rejected.otio');
  const spawn = vi.mocked(childProcess.spawnSync);
  const original = spawn.getMockImplementation()!;
  spawn.mockImplementation(((command: string, ...args: unknown[]) => {
    if (Array.isArray(args[0]) && args[0].some(arg => typeof arg === 'string' && arg.includes('import opentimelineio as otio'))) return { status: 1, stderr: 'synthetic parser failure', stdout: '' };
    return (original as (...a: unknown[]) => unknown)(command, ...args);
  }) as typeof childProcess.spawnSync);
  try {
    expect(() => emitTimeline({ dir, out })).toThrow(/OTIO acceptance failed/);
    expect(existsSync(out)).toBe(false);
    expect(readdirSync(dir).filter(name => name.startsWith('.timeline-'))).toEqual([]);
  } finally { spawn.mockImplementation(original); }
});
