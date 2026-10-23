// R9 lead, after the R9 independent review of 1fa4020 (its F1, F7 and the Control Room's ledger): the words every surface
// draws say what each surface does. The companion's tab 8 shows no decision, so the ledger's "works now" says the decisions
// show in the Workbench and names the companion's as missing; a decision model that clef.json names is "configured", with
// its model and its pricing as declared, never "not set up" while routing is off. FAKE settings only: nothing is asked.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TABS } from '../src/contracts/workspace.js';
import { buildWorkspaceFrame } from '../src/ops/workspace-frame.js';
import { workspaceLines } from '../src/ops/workspace-cli.js';

let home: string;
let project: string;
let env: Record<string, string | undefined>;
const NOW = Date.parse('2026-10-20T17:30:00.000Z');

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tw-dm-'));
  project = join(home, 'proj');
  mkdirSync(project, { recursive: true });
  env = { HOME: home, TIMMY_HOME: join(home, 'timmy'), TIMMY_SETTINGS_DIR: join(home, 'settings'), PATH: process.env.PATH };
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const clefJson = (v: unknown): void => {
  mkdirSync(join(home, 'timmy', 'decision'), { recursive: true });
  writeFileSync(join(home, 'timmy', 'decision', 'clef.json'), JSON.stringify(v));
};
const decisionModel = async () => {
  const f = await buildWorkspaceFrame({ env, cwd: project, jobs: () => [], chain: () => [], onPath: () => null, now: NOW });
  return f.connections.find((c) => c.id === 'clef')!;
};
const ledger = (id: string) => TABS.find((t) => t.id === id)!.unfinished!;

describe('the completion ledger says which surface does what (the R9 review)', () => {
  it('tab 8: the decisions show in the Workbench; the companion\'s are named as missing', () => {
    expect(ledger('fleet').works).toMatch(/in the Workbench, the decision model clef\.json names/);
    expect(ledger('fleet').works).toMatch(/each recorded decision with the model that answered and its scores as bars/);
    expect(ledger('fleet').missing).toMatch(/^the recorded decisions on the companion's tab 8/);
    expect(ledger('fleet').missing).toContain('on HOLD');
  });
  it('tab 6: the Workbench shows a recording\'s reading once the companion has read it (F7)', () => {
    expect(ledger('create').works).toMatch(/through the installed Rerun CLI, its entities, timelines and time ranges \(or why not; the Workbench shows them once the companion has read them\)/);
  });
  it('tab 7: typing into a run\'s pane is named as missing', () => {
    expect(ledger('control').missing).toMatch(/typing into a run's pane/);
  });
});

describe('the frame\'s decision model (the R9 review\'s F1)', () => {
  it('with no clef.json: not set up, routes deterministic', async () => {
    const c = await decisionModel();
    expect(c.state).toBe('not set up');
    expect(c.words).toBe('no decision model is set up (no decision/clef.json); decision-model routing is off (the default): routes stay deterministic');
  });
  it('with clef.json naming a model and routing off: configured, the model and its pricing as declared, routing off', async () => {
    clefJson({ transport: 'systemone', systemone_url: 'http://127.0.0.1:47391', model: 'clef-flash:latest', pricing: { free: 'local' } });
    const c = await decisionModel();
    expect(c.state).toBe('configured');
    expect(c.words).toBe('clef-flash:latest over SystemOne on this computer, pricing free: local (declared in clef.json); decision-model routing is off (the default): routes stay deterministic');
    expect(c.words).not.toMatch(/not set up/);
  });
  it('with no pricing declared: the pricing is unknown, said so', async () => {
    clefJson({ transport: 'systemone', systemone_url: 'http://127.0.0.1:47391', model: 'clef-flash:latest' });
    const c = await decisionModel();
    expect(c.state).toBe('configured');
    expect(c.words).toMatch(/^clef-flash:latest over SystemOne on this computer, pricing unknown: clef\.json declares none; decision-model routing is off/);
  });
  it('with routing on: configured, on, and not checked here', async () => {
    clefJson({ transport: 'systemone', systemone_url: 'http://127.0.0.1:47391', model: 'clef-flash:latest', pricing: { free: 'local' } });
    env.TIMMY_CLEF = '1';
    const c = await decisionModel();
    expect(c.state).toBe('configured');
    expect(c.words).toMatch(/; decision-model routing is on; no live call is authorized, so it is not checked here$/);
  });
  it('turned off in clef.json, or a clef.json that cannot be used: not set up, with why', async () => {
    clefJson({ transport: 'none' });
    expect(await decisionModel()).toMatchObject({ state: 'not set up', words: expect.stringMatching(/^turned off in clef\.json \(transport "none"\); decision-model routing is off/) });
    clefJson({ transport: 'systemone', systemone_url: 'http://127.0.0.1:47391' });
    expect(await decisionModel()).toMatchObject({ state: 'not set up', words: expect.stringMatching(/^clef\.json cannot be used: /) });
  });
});

// R9 lead, after the R9 independent review (its claim 7: `./review.sh check`'s words listed every tab with no ◌ and no works
// or not-yet words for 6, 7, 8 and 0, while its --json carried them): the check's words mark the unfinished tabs as every
// surface does, and say what works on each now and what does not yet
describe('timmy workspace check\'s words mark the unfinished tabs (the R9 review, claim 7)', () => {
  it('◌ on the Tabs line for 6, 7, 8 and 0 only, and under each one\'s actions what works now and what does not yet', async () => {
    const f = await buildWorkspaceFrame({ env, cwd: project, jobs: () => [], chain: () => [], onPath: () => null, now: NOW });
    const lines = workspaceLines(f);
    const tabs = lines.find((l) => l.startsWith('Tabs     '))!;
    for (const t of f.tabs) expect(tabs, t.key).toContain(t.unfinished ? `${t.key} ${t.label} ◌` : `${t.key} ${t.label}${t.waiting ? ` (${t.waiting} waiting)` : ''}`);
    expect(tabs.match(/◌/g)).toHaveLength(4);
    for (const t of f.tabs.filter((x) => x.unfinished)) {
      const at = lines.indexOf(`  ${t.key} ${t.label} ◌ unfinished`);
      expect(at, t.key).toBeGreaterThan(0);
      expect(lines[at + 1]).toBe(`    works now: ${t.unfinished!.works}`);
      expect(lines[at + 2]).toBe(`    not yet: ${t.unfinished!.missing}`);
    }
    expect(lines).toContain('  1 Home');
  });
});
