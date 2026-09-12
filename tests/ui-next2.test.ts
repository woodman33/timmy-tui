// ui-next-2 — LIBRARY DEMOS surface (families, PREDICTION|EVIDENCE seals,
// armed [Enter] open), studio.preserve typed view, HOME empty state on a fresh
// install, and the `timmy init` wizard screen (dry-run write). Placeholder
// fixtures only (privacy-d5n9).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShellV2 } from '../src/tui/components/ShellV2.js';
import { WizardScreen } from '../src/tui/wizard.js';
import { demosRows } from '../src/harness/uinext.js';
import { typedLines } from '../src/tui/chain-views.js';
import type { Receipt } from '../src/utils/receipts.js';

const rec = (subject: string, m: Record<string, unknown>): Receipt =>
  ({ v: 1, id: `rc_${subject}`, stream: 'runs', ts: '2026-01-01T00:00:00.000Z', kind: 'seal', subject, policy: 'auto', sources: [m], hash: 'sha256_0000000000000000', prev_hash: 'genesis' }) as unknown as Receipt;

let root = '';
let store = '';
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'uinext2-root-'));
  store = mkdtempSync(join(tmpdir(), 'uinext2-store-'));
  const w = (rel: string, body: string) => {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, body);
  };
  w('lanes/demos/families.json', JSON.stringify({ v: 1, families: [
    { id: 'card-film', family: 'card-film', demo: 'canvas', open: 'renders/card-film/index.html', prediction: { text: 'cheap/local wins', seal: 'sha256_aaaaaaaa11111111' }, evidence: { path: 'cut/x.mp4', seal: 'sha256_bbbbbbbb22222222' }, scope: 'historical', origin: 'intake' },
    { id: 'house', family: 'house', demo: 'native', open: null, prediction: { text: 'span matches', seal: null }, evidence: { path: null, seal: null }, scope: 'cutaway', origin: 'survey' },
    { id: 'unreal-observatory', family: 'unreal-observatory', demo: 'native', open: null, prediction: { text: 'rc render matches', seal: null }, evidence: { path: null, seal: null }, fill: 'unreal.render', scope: 'cutaway', origin: 'unreal lane' },
    { id: 'grand-canyon', family: 'grand-canyon', demo: 'native', open: null, prediction: { text: 'stage import survives', seal: null }, evidence: { path: null, seal: null }, fill: 'unreal.stage-import', scope: 'cutaway', origin: 'unreal lane' },
    { id: 'signal', family: 'signal', demo: 'canvas', open: null, prediction: { text: 'day replays', seal: null }, evidence: { path: null, seal: null }, fill: 'signal.', scope: 'historical', origin: 'signal lane' },
  ] }));
  for (const k of ['TIMMY_REPO_ROOT', 'TIMMY_STORE', 'TIMMY_DEMO']) saved[k] = process.env[k];
  process.env.TIMMY_REPO_ROOT = root;
  process.env.TIMMY_STORE = store;
  process.env.TIMMY_DEMO = '1';
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(view: ReturnType<typeof render>, pred: (f: string) => boolean, ms = 15000): Promise<string> {
  const t0 = Date.now();
  let f = '';
  for (;;) {
    f = view.lastFrame() ?? '';
    if (pred(f) || Date.now() - t0 > ms) return f;
    await sleep(50);
  }
}

describe('demos readers + typed studio.preserve', () => {
  it('families carry prediction/evidence seals; missing seals are inert dashes', () => {
    const rows = demosRows();
    expect(rows.length).toBe(5);
    expect(rows[0].prediction.seal).toBe('aaaaaaaa');
    expect(rows[0].evidence.seal).toBe('bbbbbbbb');
    expect(rows[1].prediction.seal).toBeNull();
  });
  it('null seals fill from unreal.render / unreal.stage-import / signal.* receipts', () => {
    const render_ = rec('unreal.render', { stage: 'world-01/observatory.usdc', ms: '4200', ok: 'true', prediction_seal: 'sha256_dddddddd44444444' });
    const sig = rec('signal.round', { round: '3', attention: '9' });
    const rows = demosRows([render_, sig]);
    const obs = rows.find(r => r.id === 'unreal-observatory');
    const canyon = rows.find(r => r.id === 'grand-canyon');
    const signal = rows.find(r => r.id === 'signal');
    expect(obs?.evidence.seal).toBe(String(render_.hash).slice(7, 15));
    expect(obs?.prediction.seal).toBe('dddddddd');
    expect(canyon?.evidence.seal).toBeNull(); // no unreal.stage-import receipt yet
    expect(canyon?.prediction.seal).toBeNull();
    expect(signal?.evidence.seal).toBe(String(sig.hash).slice(7, 15));
    // families without a fill source keep their static seals/dashes
    expect(rows.find(r => r.id === 'card-film')?.evidence.seal).toBe('bbbbbbbb');
  });
  it('studio.preserve renders studio, project, preserved count and sha', () => {
    const lines = typedLines(rec('studio.preserve', { studio: 'houdini-22', project: 'house-fix', preserved: '7', preserve_sha256: 'sha256_cccccccc33333333' }));
    expect(lines.join('\n')).toContain('studio houdini-22');
    expect(lines.join('\n')).toContain('preserved 7');
    expect(lines.join('\n')).toContain('cccccccc');
    for (const l of lines) {
      expect(l.length).toBeLessThanOrEqual(42);
      expect(l).not.toContain('…');
    }
  });
});

describe('LIBRARY DEMOS surface + HOME empty state', { timeout: 60000 }, () => {
  it('fresh store HOME says nothing sealed yet; DEMOS card arms and opens (demo no-op)', async () => {
    const view = render(React.createElement(ShellV2, { width: 120 }));
    const home = await until(view, x => x.includes('YOUR JOURNEY'));
    expect(home).toContain('nothing sealed yet');
    view.stdin.write('4');
    const lib = await until(view, x => x.includes('DEMOS'));
    expect(lib).toContain('card-film');
    expect(lib).toContain('PRED aaaaaaaa EV bbbbbbbb');
    expect(lib).toContain('house');
    view.stdin.write('D');
    const armed = await until(view, x => x.includes('armed — [ ] selects'));
    expect(armed).toContain('▶ card-film');
    view.stdin.write(']');
    await sleep(300);
    view.stdin.write('\r');
    const opened = await until(view, x => x.includes('no recorded surface yet') || x.includes('demo no-op open'));
    expect(opened.match(/house: no recorded surface yet|card-film: demo no-op open/)).not.toBeNull();
    view.unmount();
  });
});

describe('timmy init wizard screen', { timeout: 30000 }, () => {
  it('renders five steps and dry-runs the overlay write', async () => {
    process.env.TIMMY_WIZARD_DRY = '1';
    const view = render(React.createElement(WizardScreen));
    const f0 = await until(view, x => x.includes('TIMMY INIT'));
    expect(f0).toContain('operator');
    expect(f0).toContain('edge host');
    expect(f0).toContain('commander ws');
    expect(f0).toContain('model policy');
    view.stdin.write('w');
    const f1 = await until(view, x => x.includes('dry run'));
    expect(f1).toContain('overlay not written');
    view.unmount();
    delete process.env.TIMMY_WIZARD_DRY;
  });
});
