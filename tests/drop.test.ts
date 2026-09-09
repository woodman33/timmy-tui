import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ensureDropLanes, processDrop, loadRules, matchTemplate } from '../src/drop/index.js';
import { readChain } from '../src/utils/receipts.js';

let drop: string; let out: string;
beforeEach(() => {
  drop = mkdtempSync(join(tmpdir(), 'timmy-drop-'));
  out = mkdtempSync(join(tmpdir(), 'timmy-out-'));
  process.env.TIMMY_DROP_ROOT = drop;
  process.env.TIMMY_OUT_ROOT = out;
  delete process.env.ROBOFLOW_API_KEY;
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
