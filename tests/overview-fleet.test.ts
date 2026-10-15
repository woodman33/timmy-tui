/**
 * Round R4 (lead): God's Eye View's Fleets part (src/overview/fleet.ts), in the terminal (/overview) and on the board.
 * REAL: the plan files, the ledger, the scheduler, the operation record and receipts `timmy fleet` writes, read back by the
 * overview's own builder; the terminal lines and the board's HTML drawn from that model. FAKE: the backend (no compute, no
 * harness, no model). One record is HAND-WRITTEN, labelled where it is made: a plan whose provider is changed to a real
 * one's name with an unknown worker and no process, to show what a real fleet would put in Needs you (no real provider
 * exists in this slice, so no run can make that record).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fakeBackend } from '../src/fleet/fake.js';
import { planFleet, runPlan, type PlanRequest } from '../src/fleet/service.js';
import { buildOverview, type Overview } from '../src/overview/index.js';
import { overviewSection, OVERVIEW_CSS } from '../src/repl/board-overview.js';
import { kit as boardKit } from '../src/repl/board-kit.js';
import { overviewFirstLines, overviewLines } from '../src/repl/overview.js';
import { glyphSet } from '../src/term/glyphs.js';
import { HOMEBREW } from '../src/theme/tokens.js';

const g = glyphSet(true);
type Seg = { text: string; role?: string };
const plain = (lines: Seg[][]): string[] => lines.map((l) => l.map((x) => x.text).join(''));
const roots: string[] = [];
afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

function project(): { root: string; home: string } {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-fleet-'));
  roots.push(top);
  const root = path.join(top, 'proj');
  fs.mkdirSync(root);
  const git = (...a: string[]) => spawnSync('git', ['-c', 'user.email=fake', '-c', 'user.name=FAKE', ...a], { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'FAKE');
  return { root, home: path.join(top, 'home') };
}
const overviewOf = (p: { root: string; home: string }): Overview => buildOverview(p.root, {
  name: 'proj', jobsDir: path.join(p.home, 'timmy', 'jobs'), store: path.join(p.root, '.timmy', 'receipts'), env: { TIMMY_HOME: path.join(p.home, 'timmy') },
});
const req = (over: Partial<PlanRequest> = {}): PlanRequest => ({ agents: 6, concurrency: 2, provider: 'fake', isolation: 'vm', harness: 'codex', model: 'fake-model', prompt: 'FAKE task', ...over });

describe('a project without a fleet plan sees the overview it saw before', () => {
  it('has no fleet part, no Fleets line and no Fleets card, even with an empty .timmy/fleet', () => {
    const p = project();
    for (const step of ['none', 'empty folder']) {
      if (step === 'empty folder') fs.mkdirSync(path.join(p.root, '.timmy', 'fleet'), { recursive: true });
      const o = overviewOf(p);
      expect('fleet' in o, step).toBe(false);
      expect(plain(overviewFirstLines(o, { glyphs: g })).some((l) => l.startsWith('  Fleets')), step).toBe(false);
      expect(overviewSection(o, boardKit({ live: false, base: '' })).html, step).not.toMatch(/data-ov="fleet"/);
      expect(plain(overviewLines(o, 'fleet', { glyphs: g })).join('\n')).toMatch(/No fleet plan in this project\. timmy fleet plan --workers <n> makes one/);
    }
  });
});

describe('a FAKE fleet run, read back', () => {
  let o: Overview;
  let planId = '';
  let operation = '';
  let root = '';

  it('reads the plan from its own files: finished, delivered and verified kept apart, labelled a simulation', async () => {
    const p = project();
    root = p.root;
    const made = planFleet(p.root, req());
    if (!made.ok) throw new Error('not planned');
    planId = made.plan.id;
    operation = made.plan.operationId;
    const before = overviewOf(p);
    expect(before.fleet?.items[0]).toMatchObject({ plan: planId, status: 'planned', simulation: true, tone: 'attention' });
    expect(before.fleet?.items[0].commands).toEqual([`timmy fleet status ${planId}`, `timmy fleet run ${planId}`, expect.stringMatching(/^timmy approve [0-9a-f]{32}$/), `timmy fleet events ${planId}`, `timmy op ${operation}`]);
    const rep = await runPlan(p.root, planId, { by: 'person', backendFor: () => fakeBackend() });
    expect(rep.status).toBe('finished');
    o = overviewOf(p);
    const f = o.fleet!;
    expect(f).toMatchObject({ id: 'fleet', title: 'Fleets', state: 'read', more: 0 });
    expect(f.summary).toBe('1 plan, 6 delivered (not verified), simulation');
    expect(f.urgent).toBeUndefined(); // a finished plan is not urgent
    const i = f.items[0];
    expect(i).toMatchObject({ plan: planId, operation, status: 'finished', running_proven: false, backend: 'FAKE', simulation: true, workers: 6, concurrency: 2, tone: 'neutral', needs: [] });
    expect(i.counts).toMatchObject({ requested: 6, delivered: 6, verified: 0, failed: 0 });
    expect(i.isolation_words).toBe('each a simulated virtual machine (FAKE: nothing was allocated)');
    expect(i.spend_words).toMatch(/^nothing spent: a simulation/);
    expect(i.worker_lines).toHaveLength(2); // all delivered: two examples, the rest counted
    expect(i.workers_more).toBe(4);
    expect(i.worker_lines[0].words).toMatch(/^w001 delivered \(not verified\) · simulated fake-vm-\S+ destroyed · session \S+ · 1 file collected$/);
    expect(i.results).toBe(`.timmy/fleet/${planId}/w<NNN>/result/ (6 workers' results, each with its MANIFEST.json)`);
    expect(i.source).toEqual({ record: `.timmy/fleet/${planId}/state.json`, command: `timmy fleet status ${planId}`, board: 'ov-fleet', detail: `ov-fleet-${planId}` });
    // nothing a simulation left can need a person
    expect(o.needs.items.some((n) => String(n.kind).startsWith('fleet-'))).toBe(false);
    // the model names no absolute path
    expect(JSON.stringify(o)).not.toContain(p.root);
  }, 60_000);

  it('the first screen has one Fleets line, after Costs and before Project', () => {
    const first = plain(overviewFirstLines(o, { glyphs: g }));
    const at = (w: string): number => first.findIndex((l) => l.startsWith(`  ${w}`));
    expect(at('Fleets')).toBe(at('Costs') + 1);
    expect(at('Project')).toBe(at('Fleets') + 1);
    expect(first[at('Fleets')]).toBe('  Fleets      1 plan, 6 delivered (not verified), simulation');
    expect(first.length).toBeLessThanOrEqual(25);
  });

  it('/overview fleet in full, and --all, with the next actions in the attention colour and nothing green', () => {
    const lines = overviewLines(o, 'fleets', { glyphs: g }) as Seg[][];
    const text = plain(lines).join('\n');
    expect(text).toContain(`    ${planId}  finished: 6 of 6 delivered (not verified) · a simulation`);
    expect(text).toContain('      backend   FAKE (fake) · a simulation: no compute, no harness, no model');
    expect(text).toContain('      workers   6, at most 2 at once · each a simulated virtual machine (FAKE: nothing was allocated)');
    expect(text).toContain(`      type      timmy fleet status ${planId} · timmy fleet events ${planId} · timmy op ${operation}`);
    expect(text).toContain('      counts    6 requested · 6 admitted · 0 queued · 0 running · 0 live and 0 unknown allocations · 6 delivered (not verified) · 0 verified · 0 failed · 0 cancelled · 0 refused');
    const type = lines.find((l) => l[0]?.text === '      type      ')!;
    expect(type[1].role).toBe('estimate');
    const fleetPart = lines.slice(1, -2); // the head line and the two closing lines are the overview's own
    expect(fleetPart.flat().some((s) => s.role === 'accent'), 'no green in the Fleets part').toBe(false);
    const all = plain(overviewLines(o, '--all', { glyphs: g }));
    const head = (w: string): number => all.findIndex((l) => l.startsWith(`  ${w}`));
    expect(head('FLEETS')).toBeGreaterThan(head('COSTS'));
    expect(head('PROJECT')).toBeGreaterThan(head('FLEETS'));
    expect(plain(overviewLines(o, 'nonsense', { glyphs: g }))).toEqual(['  Usage: /overview [needs|devices|hosting|agents|workflows|apps|spatial|history|costs|fleet|project|map] [--all] [--json]']);
  });

  it('the board draws a Fleets card after Costs: the plan opens in place, its commands to copy in the attention colour', () => {
    const html = overviewSection(o, boardKit({ live: false, base: '' })).html;
    const order = [...html.matchAll(/<article class="[^"]*" data-ov="([a-z]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(['needs', 'devices', 'hosting', 'agents', 'workflows', 'apps', 'spatial', 'history', 'costs', 'fleet', 'project']);
    const card = /<article class="card ov-sec ov-fleet ov-state-read ov-wide" data-ov="fleet">[\s\S]*?<\/article>/.exec(html)?.[0] ?? '';
    expect(card).toContain(`<details class="ov-sel ov-fleet-plan" data-keep="overview:fleet:${planId}">`);
    expect(card).toContain(`id="ov-fleet-${planId}"`);
    expect(card).toContain('<span class="ov-tag">simulation</span>');
    expect(card).toContain(`<div class="cmds ov-next"><button type="button" class="cmd" data-cmd="timmy fleet status ${planId}"`);
    expect(card).toContain('each a simulated virtual machine (FAKE: nothing was allocated)');
    expect(html).not.toContain(root);
    expect(OVERVIEW_CSS).toContain(`.card.ov-fleet .cmd, .card.ov-fleet .ov-next .cmd { color: ${HOMEBREW.attention}; }`);
  });
});

describe('a real fleet that left work behind goes to Needs you (a HAND-WRITTEN record)', () => {
  it('an unknown worker and a process that ended while it ran: each a need with reconcile; the part says attention', () => {
    const p = project();
    const made = planFleet(p.root, req({ agents: 3, concurrency: 1 }));
    if (!made.ok) throw new Error('not planned');
    const dir = path.join(p.root, '.timmy', 'fleet', made.plan.id);
    // HAND-WRITTEN: the provider renamed to a real one's and the ledger set as a crashed run would leave it. No real
    // provider exists in this slice, so no run can make this record; it shows what the overview does with one.
    const plan = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'));
    fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ ...plan, provider: 'cloudroom' }));
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    state.status = 'running';
    state.workers[0].phase = 'unknown';
    state.workers[0].compute.state = 'unknown';
    state.workers[0].reason = 'the create call timed out; whether its VM exists is not known (a person must check)';
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
    const o = overviewOf(p);
    const i = o.fleet!.items[0];
    expect(i).toMatchObject({ simulation: false, status: 'running', running_proven: false, tone: 'attention' });
    expect(i.words).toMatch(/its process ended while it ran \(0 of 3 delivered \(not verified\)\): what it left is not known until it is reconciled$/);
    expect(i.needs).toHaveLength(2);
    expect(i.commands).toContain(`timmy fleet reconcile ${made.plan.id}`);
    expect(i.spend_words).toMatch(/^budgets \$0\.00 compute and \$0\.00 inference \(ceilings, not spend\); spend: not reported$/);
    const needs = o.needs.items.filter((n) => String(n.kind).startsWith('fleet-'));
    expect(needs.map((n) => n.kind).sort()).toEqual(['fleet-left', 'fleet-unknown']);
    expect(needs.find((n) => n.kind === 'fleet-unknown')!.title).toBe(`fleet ${made.plan.id}: worker 1: the create call timed out; whether its VM exists is not known (a person must check)`);
    for (const n of needs) expect(n.commands[0]).toBe(`timmy fleet reconcile ${made.plan.id}`);
    expect(o.needs.counts.map((c) => c.of)).toContain('of them from this project\'s fleets (timmy fleet)');
    expect(o.fleet!.urgent).toMatchObject({ tone: 'attention', text: `${made.plan.id}: worker 1: the create call timed out; whether its VM exists is not known (a person must check)` });
  });

  it('a plan that cannot be read is named with why; the others are still read', async () => {
    const p = project();
    const made = planFleet(p.root, req({ agents: 2 }));
    if (!made.ok) throw new Error('not planned');
    const bad = path.join(p.root, '.timmy', 'fleet', 'f00000000');
    fs.mkdirSync(bad, { recursive: true });
    fs.writeFileSync(path.join(bad, 'plan.json'), '{ not json');
    fs.writeFileSync(path.join(bad, 'state.json'), '{}');
    const o = overviewOf(p);
    expect(o.fleet).toMatchObject({ state: 'partial', why: '1 plan could not be read' });
    expect(o.fleet!.unreadable).toEqual([{ record: '.timmy/fleet/f00000000', why: expect.stringMatching(/JSON/) }]);
    expect(o.fleet!.items.map((i) => i.plan)).toEqual([made.plan.id]);
    fs.rmSync(path.join(p.root, '.timmy', 'fleet', made.plan.id), { recursive: true });
    expect(overviewOf(p).fleet).toMatchObject({ state: 'unknown', items: [] });
  });
});
