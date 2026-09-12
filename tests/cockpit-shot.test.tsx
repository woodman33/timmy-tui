// ui-cockpit-k7m3 C6 — DEMO: the film shot. The eight-hand chart is a
// SYNTHETIC FIXTURE (seal ids read fixt000N, never a chain hash); the HANDS
// frame names its board so a fixture stays visibly synthetic; the shot script
// writes captures + cast + manifest only after every frame passes the privacy
// gate. Negative controls (§12): a frame carrying a personal string refuses
// the gate, and a chart whose worktree cell carries a home path refuses the
// whole shot — nothing is written, nothing is sealed.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ShellV2 } from '../src/tui/components/ShellV2.js';
import * as ck from '../src/harness/cockpit.js';

const REPO = process.cwd();
const FIXTURE = join(REPO, 'lanes', 'demos', 'hands-8.rounds.md');
const NAMES = ['cc1', 'cc2', 'cc3', 'cc4', 'cc5', 'codex', 'qwen', 'bugbot'];

let root = '';
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cockpit-shot-root-'));
  for (const k of ['TIMMY_REPO_ROOT', 'TIMMY_STORE']) saved[k] = process.env[k];
  process.env.TIMMY_REPO_ROOT = root;
  process.env.TIMMY_STORE = mkdtempSync(join(tmpdir(), 'cockpit-shot-store-'));
  mkdirSync(join(root, 'lanes', 'demos'), { recursive: true });
  copyFileSync(FIXTURE, join(root, 'lanes', 'demos', 'hands-8.rounds.md'));
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
const runShot = (extra: string[], out: string) =>
  spawnSync('npx', ['tsx', 'src/demo/cockpit-shot.ts', ...extra, '--out', out, '--marker', 'test', '--no-film', '--no-seal', '--json'], { cwd: REPO, encoding: 'utf8', timeout: 110000 });

describe('C6 DEMO — the film shot', { timeout: 120000 }, () => {
  it('the chart is a synthetic fixture: eight hands, all five states, fixture seal ids', () => {
    const md = readFileSync(FIXTURE, 'utf8');
    expect(md).toContain('SYNTHETIC FIXTURE');
    const { hands, prompts } = ck.parseRounds(md);
    expect(hands.map(h => h.name)).toEqual(NAMES);
    expect(new Set(hands.map(h => h.state))).toEqual(new Set(['idle', 'running', 'HOLD', 'STOP', 'needs-approval']));
    expect(hands.every(h => h.lastSeal === '—' || h.lastSeal.startsWith('sha256_fixt'))).toBe(true);
    expect(prompts['cc1']?.['R4']).toContain('C6 DEMO');
    // the cell prompts never carry a home path
    expect(ck.scanLog(md)).toEqual([]);
  });

  it('HANDS puts all eight hands on screen and names its board (the fixture stays visibly synthetic)', async () => {
    const r = ck.importRounds(join(root, 'lanes', 'demos', 'hands-8.rounds.md'));
    expect(r).toMatchObject({ ok: true, hands: 8, prompts: 7 });
    const view = render(React.createElement(ShellV2, { width: 120 }));
    view.stdin.write('6');
    await until(view, f => f.includes('[h] hands'));
    view.stdin.write('h');
    const grid = await until(view, f => f.includes('HANDS') && NAMES.every(n => f.includes(n)));
    expect(grid).toContain('8 hands');
    expect(grid).toContain('board hands-8.rounds.md');
    expect(grid).toContain('fixt0001');
    expect(grid).toContain('needs-approval');
    expect(grid).toContain('STOP');
    view.unmount();
  });

  it('NEGATIVE §12: a frame carrying a personal string refuses the gate', () => {
    const personal = `  ${join(homedir(), 'Desktop', 'wt')} · ui-cockpit-k7m3`;
    const refused = ck.gateFrames([{ name: 'x-120', width: 120, text: `HANDS\n${personal}\n` }]);
    expect(refused.ok).toBe(false);
    expect(refused.note).toContain('shot refused');
    const clean = ck.gateFrames([{ name: 'x-120', width: 120, text: 'HANDS\n  wt-cockpit · ui-cockpit-k7m3\n' }]);
    expect(clean.ok).toBe(true);
    expect(clean.patterns_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the shot writes 120/80 captures + prompt beat + cast + manifest with matching hashes (no seal under --no-seal)', () => {
    const out = mkdtempSync(join(tmpdir(), 'cockpit-shot-out-'));
    const r = runShot(['--rounds', 'lanes/demos/hands-8.rounds.md'], out);
    expect(r.status, r.stderr).toBe(0);
    const j = JSON.parse(r.stdout.trim().split('\n').pop() as string);
    expect(j.ok).toBe(true);
    expect(j.board).toMatchObject({ kind: 'fixture', hands: 8, source: 'lanes/demos/hands-8.rounds.md' });
    expect(j.sealed).toBeNull();
    const m = JSON.parse(readFileSync(join(out, 'manifest-test.json'), 'utf8'));
    expect(m).toMatchObject({ order: 'ui-cockpit-k7m3', checkpoint: 'C6', marker: 'test' });
    expect(m.shots.map((s: { name: string }) => s.name)).toEqual(['test-cockpit-hands-120', 'test-cockpit-hands-prompt-120', 'test-cockpit-hands-80']);
    for (const s of m.shots) {
      const body = readFileSync(join(out, s.name), 'utf8');
      expect(ck.promptSha(body)).toBe(`sha256_${s.sha256}`);
      expect(NAMES.every(n => body.includes(n))).toBe(true);
    }
    expect(readFileSync(join(out, 'test-cockpit-hands-prompt-120'), 'utf8')).toContain('prompt cc1 R4');
    const cast = readFileSync(join(out, m.film.cast.file), 'utf8').trim().split('\n');
    expect(JSON.parse(cast[0])).toMatchObject({ version: 2, width: 120 });
    expect(cast.length - 1).toBe(m.film.cast.frames);
    expect(m.gate).toMatchObject({ findings: 0 });
    expect(m.gate.frames).toBeGreaterThanOrEqual(5);
  });

  it('NEGATIVE §12: a chart whose worktree carries a home path refuses the whole shot — nothing written', () => {
    const bad = mkdtempSync(join(tmpdir(), 'cockpit-shot-bad-'));
    const chart = readFileSync(FIXTURE, 'utf8').replace('| cc1 | claude | wt-cockpit |', `| cc1 | claude | ${join(homedir(), 'Desktop', 'wt')} |`);
    writeFileSync(join(bad, 'ROUNDS.md'), chart);
    const out = mkdtempSync(join(tmpdir(), 'cockpit-shot-refused-'));
    const r = runShot(['--rounds', join(bad, 'ROUNDS.md')], out);
    expect(r.status).toBe(1);
    const j = JSON.parse(r.stdout.trim().split('\n').pop() as string);
    expect(j.ok).toBe(false);
    expect(j.note).toContain('shot refused');
    expect(readdirSync(out)).toEqual([]);
    expect(existsSync(join(out, 'manifest-test.json'))).toBe(false);
  });
});
