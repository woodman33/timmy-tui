import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import { ensureDropLanes, processDrop, loadRules, matchTemplate, startDropWatcher, type DropOutcome } from '../src/drop/index.js';
import { readChain, receiptsPath } from '../src/utils/receipts.js';

let drop: string; let out: string; let scratch: string; let prevTmp: string | undefined;
beforeEach(() => {
  drop = mkdtempSync(join(tmpdir(), 'timmy-drop-'));
  out = mkdtempSync(join(tmpdir(), 'timmy-out-'));
  scratch = mkdtempSync(join(tmpdir(), 'timmy-drop-tmp-'));
  process.env.TIMMY_DROP_ROOT = drop;
  process.env.TIMMY_OUT_ROOT = out;
  delete process.env.ROBOFLOW_API_KEY;
  delete process.env.TIMMY_FORGE;
  // The dispatch plan's CUE check leaves a temporary folder behind; keep it in this test's own.
  prevTmp = process.env.TMPDIR;
  process.env.TMPDIR = scratch;
});
afterEach(() => {
  if (prevTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = prevTmp;
  delete process.env.ROBOFLOW_API_KEY;
  for (const d of [drop, out, scratch]) rmSync(d, { recursive: true, force: true });
});

describe('hot-drop (control-plane-k3e7)', () => {
  it('ships .rules.cue for defold/houdini/observer and matches globs', () => {
    const lanes = ensureDropLanes(drop);
    expect(lanes.sort()).toEqual(['defold', 'houdini', 'observer']);
    expect(matchTemplate('observer', 'x.png', drop)).toBe('observer-roboflow');
    expect(matchTemplate('houdini', 'ref.jpg', drop)).toBe('houdini-sceneforge');
    expect(matchTemplate('defold', 'hero.riv', drop)).toBe('defold-build');
    expect(loadRules('observer', drop).length).toBeGreaterThan(0);
  });

  it('drop seals drop.intake + drop.result and writes a board to out/<lane>/', () => {
    ensureDropLanes(drop);
    const f = join(drop, 'observer', 'frame.png');
    writeFileSync(f, 'fakepng');
    const r = processDrop(f, drop);
    expect(r.lane).toBe('observer');
    expect(r.template).toBe('observer-roboflow');
    expect(r.status).toBe('not_configured'); // honest: no ROBOFLOW key
    expect(r.out && existsSync(r.out)).toBe(true);
    const chain = readChain('runs', drop);
    expect(chain.some(c => String(c.subject).startsWith('drop.intake'))).toBe(true);
    expect(chain.some(c => String(c.subject).startsWith('drop.result'))).toBe(true);
    const board = JSON.parse(readFileSync(r.out!, 'utf8'));
    expect(board.nodes[0].lane).toBe('observer');
  });
});

// R4 H19: the processor's result is what `timmy drop` prints, so it must say what happened. No drop rule starts its
// tool, and the dispatch plan it drafts is refused by schemas/dispatch.cue, so nothing is ever "dispatched".
describe('the drop processor says what happened (R4 H19)', () => {
  it('a file no rule takes is unrouted, never dispatched', () => {
    ensureDropLanes(drop);
    const f = join(drop, 'observer', 'notes.txt');
    writeFileSync(f, 'notes');
    const r = processDrop(f, drop);
    expect(r).toMatchObject({ template: null, rule: null, status: 'unrouted', why: 'no rule in the observer lane takes notes.txt', armed: false });
    expect(readChain('runs', drop).find(c => c.subject === 'drop.result observer/notes.txt')).toMatchObject({ status: 'failed', error_class: 'unrouted' });
  });

  it('a tool that is set up is still not started: nothing runs from a drop', () => {
    ensureDropLanes(drop);
    process.env.ROBOFLOW_API_KEY = 'placeholder-never-sent'; // the processor starts nothing, so it is never used
    const f = join(drop, 'observer', 'frame.png');
    writeFileSync(f, 'png');
    const r = processDrop(f, drop);
    expect(r).toMatchObject({ template: 'observer-roboflow', rule: '*.png', status: 'not_started', why: 'nothing starts Roboflow detection from a drop yet', armed: false });
    expect(readChain('runs', drop).find(c => c.subject === 'drop.result observer/frame.png')).toMatchObject({ status: 'failed', error_class: 'not_started' });
  });

  it("SceneForge's readiness is the forge gate (TIMMY_FORGE=1), not the folder Timmy runs in", () => {
    // vitest runs in the repository, where src/forge/sheet.ts exists; that alone used to count as SceneForge ready
    expect(existsSync(join(process.cwd(), 'src', 'forge', 'sheet.ts'))).toBe(true);
    ensureDropLanes(drop);
    const f = join(drop, 'houdini', 'ref.jpg');
    writeFileSync(f, 'jpg');
    expect(processDrop(f, drop)).toMatchObject({ status: 'not_configured', why: 'SceneForge is in the forge lane, which is off unless TIMMY_FORGE=1 (decisions.md D1)' });
  });

  it('receipts and bus events name the file by lane and name, never by a full path; the result returns both receipts', () => {
    ensureDropLanes(drop);
    const f = join(drop, 'defold', 'hero.riv');
    writeFileSync(f, 'rive');
    const r = processDrop(f, drop);
    const raw = readFileSync(receiptsPath('runs', drop), 'utf8');
    expect(raw).toContain('"path":"defold/hero.riv"');
    expect(raw).not.toContain(drop);
    expect(raw).not.toContain(out);
    expect(readChain('runs', drop).map(c => c.hash)).toEqual([r.receipts!.intake, r.receipts!.result]);
  });
});

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
async function until(ok: () => boolean, ms: number): Promise<void> {
  for (const t0 = Date.now(); !ok(); await sleep(50)) if (Date.now() - t0 > ms) throw new Error(`timed out after ${ms} ms`);
}

describe('the watched drop folder uses the same processor as `timmy drop` (R4 H19)', () => {
  it('processes a file once it stops changing, skips hidden files and folders, and refuses a name no rule takes', async () => {
    const outcomes: DropOutcome[] = [];
    const w = startDropWatcher(o => outcomes.push(o), drop, { settleMs: 1000 });
    const f = join(drop, 'observer', 'frame.png');
    try {
      mkdirSync(join(drop, 'observer', 'stills')); // a folder in a lane: the old scan hashed it inside a timer (EISDIR)
      writeFileSync(join(drop, 'observer', '.DS_Store'), 'finder');
      writeFileSync(f, 'first half,'); // a copy still being written…
      await sleep(300);
      appendFileSync(f, ' second half'); // …that finishes 300 ms later
      writeFileSync(join(drop, 'observer', 'notes.txt'), 'notes');
      await until(() => outcomes.length >= 2, 15_000);
      await sleep(1500); // a second result for the same file would have arrived by now
    } finally { w.stop(); }
    const done = outcomes.filter((o): o is Extract<DropOutcome, { ok: true }> => o.ok);
    expect(done.map(o => o.result.file)).toEqual([f]);
    expect(done[0].result.sha).toBe(createHash('sha256').update('first half, second half').digest('hex'));
    expect(outcomes.filter(o => !o.ok)).toEqual([{ ok: false, file: join(drop, 'observer', 'notes.txt'), reason: 'no rule in the observer lane takes notes.txt' }]);
    expect(readChain('runs', drop).map(c => c.subject)).toEqual(['drop.intake observer/frame.png', 'drop.result observer/frame.png']);
  });
});
