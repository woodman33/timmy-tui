/**
 * R5 (H134): tab 8, Fleet & Clef (src/workbench/fleet-tab.ts), over a REAL project in a temporary git folder: two fleet plans
 * written by the fleet service (src/fleet/service.ts planFleet), one of them run to its end on the FAKE backend (no compute,
 * no harness, no model, no cost: a simulation, as it says), two decisions recorded by `timmy decide`'s own code
 * (src/decision/cli.ts decideDo: one answered from a FAKE Clef-Omni response file, no service called; one with Use Clef
 * routing off), and the workspace frame its producer makes (src/ops/workspace-frame.ts). A live connection is made by
 * recording a FAKE observation in the connections record, as `timmy workspace check` writes it.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceFrame } from '../src/contracts/workspace.js';
import { decideDo } from '../src/decision/cli.js';
import { writeCloudroomConfig } from '../src/fleet/cloudroom/index.js';
import { fakeBackend } from '../src/fleet/fake.js';
import { planFleet, runPlan } from '../src/fleet/service.js';
import { buildWorkspaceFrame, CONNECTIONS_SCHEMA, writeConnections } from '../src/ops/workspace-frame.js';
import {
  DECIDE_COMMAND, FLEET_LIST, fleetDetail, fleetView, PLAN_COMMAND, readFleet, type FleetData, type FleetItem,
} from '../src/workbench/fleet-tab.js';
import { glyphsFor, innerWidth } from '../src/workbench/frame.js';
import { bodyKind, layoutFor } from '../src/workbench/layout.js';
import { COLUMNS_FROM } from '../src/workbench/tab-columns.js';
import { lineCells, plain, type Line, type Role } from '../src/workbench/text.js';
import { fixture as clefFixture } from './fixtures/clef-omni/fake.js';
/** The last column of a view's rows (side by side: after the row's last rule; stacked: the whole row), its words joined. */
const lastColumn = (lines: Line[]): string => lines.map((l) => { const parts = l.map((s) => s.text).join('').split('│'); return parts[parts.length - 1]; }).join(' ').replace(/\s+/g, ' ');

const boxes: string[] = [];
afterAll(() => { for (const b of boxes) rmSync(b, { recursive: true, force: true }); });
afterEach(() => { vi.restoreAllMocks(); });

const g = glyphsFor(true);
const SIZES = [[160, 45], [120, 40], [100, 30]] as const;

/** The body's inner size at a terminal size, as the Workbench lays this tab out (src/workbench/layout.ts OWN_COLUMNS: the
 *  whole width at every size, Context the [i] drawer). */
function bodyAt(columns: number, rows: number): { width: number; height: number } {
  const l = layoutFor({ columns, rows, body: bodyKind(false, 'fleet') });
  return { width: innerWidth(l.center!.w), height: l.center!.h - 2 };
}
const ctxAt = (columns: number, rows: number, cursor = 0) => ({ ui: { cursor: { [FLEET_LIST]: cursor } }, g, ...bodyAt(columns, rows), now: Date.now(), columns });
const text = (lines: readonly Line[]): string => lines.map(plain).join('\n');
const rolesOf = (lines: readonly Line[], re: RegExp): Role[] => lines.flat().filter((s) => re.test(s.text)).map((s) => s.role ?? 'text');
const greens = (lines: readonly Line[]): string[] => lines.flat().filter((s) => s.role === 'live').map((s) => s.text);

/** A temporary git project (the fleet's plans and the decisions name its revision) and a Timmy home of its own. */
function project(): { root: string; home: string; box: string } {
  const box = realpathSync(mkdtempSync(join(tmpdir(), 'wb-fleet-')));
  boxes.push(box);
  const root = join(box, 'tray');
  mkdirSync(root);
  const git = (...a: string[]) => spawnSync('git', ['-c', 'user.email=fake@example.com', '-c', 'user.name=FAKE', '-c', 'commit.gpgsign=false', ...a], { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'FAKE');
  return { root, home: process.env.TIMMY_HOME!, box };
}

/** Two plans (one run to its end on the FAKE backend), a decision Clef recommended (a FAKE response file) and a fallback. */
async function fixture(): Promise<{ root: string; home: string; box: string; finished: string; planned: string }> {
  const p = project();
  const run = planFleet(p.root, { agents: 3, concurrency: 2, provider: 'fake', isolation: 'vm', harness: 'codex', model: 'the harness default', prompt: 'FAKE task' });
  if (!run.ok) throw new Error(run.refusals.join('; '));
  const report = await runPlan(p.root, run.plan.id, { by: 'person', backendFor: () => fakeBackend() });
  expect(report.counts.delivered).toBe(3);
  const later = planFleet(p.root, { agents: 2, concurrency: 1, provider: 'fake', isolation: 'container', harness: 'pi', model: 'the harness default', prompt: 'FAKE task 2' });
  if (!later.ok) throw new Error(later.refusals.join('; '));
  const route = ['route', '--option', 'codex:Codex', '--option', 'pi', '--option', 'openhands', '--deterministic', 'codex', '--project', p.root];
  const rec = await decideDo([...route, '--fixture', clefFixture('response-route-ok.json')], { env: { ...process.env, TIMMY_CLEF: '1' } });
  expect(rec.code).toBe(0);
  const off = await decideDo(['route', '--option', 'codex', '--option', 'pi', '--deterministic', 'pi', '--project', p.root], { env: { ...process.env, TIMMY_CLEF: '0' } });
  expect(off.code).toBe(0);
  return { ...p, finished: run.plan.id, planned: later.plan.id };
}

const frameOf = async (root: string): Promise<WorkspaceFrame> => buildWorkspaceFrame({ env: process.env, cwd: root, jobsDir: join(process.env.TIMMY_HOME!, 'jobs') });

function manifest(...dirs: string[]): string {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const n of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, n.name);
      if (n.isDirectory()) walk(p); else { const s = statSync(p); out.push(`${p} ${s.size} ${s.mtimeMs}`); }
    }
  };
  for (const d of dirs) walk(d);
  return out.sort().join('\n');
}

describe('tab 8, Fleet & Clef: the fleet', () => {
  it('lists the plans newest first with their counts kept apart, and the FAKE backend says FAKE (simulation)', async () => {
    const f = await fixture();
    const d = readFleet({ home: f.home, root: f.root, env: process.env });
    expect(d.plans.map((p) => p.view.planId)).toEqual([f.planned, f.finished]);
    const frame = await frameOf(f.root);
    for (const [c, r] of SIZES) {
      // the finished plan selected (the second row), so its whole block shows
      const v = fleetView(ctxAt(c, r, 1), d, frame);
      const all = text(v.lines);
      // FAKE (simulation) is never cut, at any size
      expect(all).toMatch(new RegExp(`▸ ${f.finished} · FAKE \\(simulation\\)`));
      expect(all).toMatch(new RegExp(`  ${f.planned} · FAKE \\(simulation\\)`));
      expect(all).toMatch(/planned 3 · admitted 3 · running 0/);
      expect(all).toMatch(/done 3 · failed 0/);
      expect(all).toMatch(/finished/);
      expect(all).toMatch(/planned 2 · admitted 0 · running 0/);
      // quiet where it is not selected; on the selection bar in the primary text colour (grey on charcoal is below the floor)
      const fake = v.lines.flat().filter((s) => s.text === 'FAKE (simulation)');
      expect(fake.map((s) => [!!s.selected, s.role])).toEqual(expect.arrayContaining([[true, 'text'], [false, 'secondary']]));
      expect(fake.every((s) => s.role === (s.selected ? 'text' : 'secondary'))).toBe(true);
      expect(v.lines.flat().filter((s) => s.selected && s.text.trim()).every((s) => s.role !== 'secondary' && s.role !== 'border')).toBe(true);
    }
    const stacked = text(fleetView(ctxAt(100, 30, 1), d, frame).lines);
    expect(stacked).toMatch(/planned 3 · admitted 3 · running 0 · done 3 · failed 0/);
    expect(stacked).toMatch(/planned 2 · admitted 0 · running 0 · done 0 · failed 0 · queued 2/);
    expect(stacked).toMatch(/done: the runtime said it completed; nothing here verified it/);
    expect(stacked).toMatch(/providers FAKE · the FAKE backend is a simulation: no compute, no harness, no model, no cost/);
  });

  it('the Cloudroom Core as recorded: not connected with its step, or recorded and not checked (no live call is made)', async () => {
    const f = await fixture();
    const frame = await frameOf(f.root);
    const none = readFleet({ home: f.home, root: f.root, env: process.env });
    expect(none.cloudroom).toMatchObject({ recorded: false, available: false, mode: 'off' });
    expect(text(fleetView(ctxAt(100, 30), none, frame).lines)).toMatch(/Cloudroom Core · not connected · timmy fleet connect cloudroom <url> --token-file <file>/);
    const home = join(f.box, 'home-with-core');
    mkdirSync(home);
    const token = join(f.box, 'core.token');
    writeFileSync(token, 'FAKE-token-0001\n', { mode: 0o600 });
    chmodSync(token, 0o600);
    writeCloudroomConfig(home, { url: 'http://127.0.0.1:9', tokenFile: token, label: 'fake-core' });
    const recorded = readFleet({ home, root: f.root, env: process.env });
    expect(recorded.cloudroom.recorded).toBe(true);
    // the frame is another home's (no Core there): this reading's own words, never the frame's mark for another home's Core
    const all = text(fleetView(ctxAt(100, 30), recorded, frame).lines);
    expect(all).toMatch(/Cloudroom Core ○ recorded · not checked here \(no live call is authorized\)/);
    // (the tab takes the whole width: src/workbench/layout.ts OWN_COLUMNS; the short form where the column is narrower)
    expect(text(fleetView(ctxAt(160, 45), recorded, frame).lines)).toMatch(/Cloudroom Core ○ recorded · not checked here \(no live call is authorized\)/);
    expect(text(fleetView(ctxAt(120, 40), recorded, frame).lines)).toMatch(/Cloudroom Core ○ recorded, not checked/);
    // beside an open drawer (i at 120 columns: 78 cells)
    expect(text(fleetView({ ...ctxAt(120, 40), width: 78 }, recorded, frame).lines)).toMatch(/Cloudroom Core ○ recorded, not checked/);
    for (const [c, r] of SIZES) expect(greens(fleetView(ctxAt(c, r), recorded, frame).lines)).toEqual([]);
  });

  it('no plan yet: says so and gives the one command that makes one (the FAKE backend; nothing starts)', async () => {
    const p = project();
    const d = readFleet({ home: p.home, root: p.root, env: process.env });
    const frame = await frameOf(p.root);
    for (const [c, r] of SIZES) {
      const v = fleetView(ctxAt(c, r), d, frame);
      const all = text(v.lines);
      expect(all).toMatch(/No fleet plan in this project\./);
      expect(all).toMatch(/No decision recorded (in this project|here yet)\./);
      // each command whole on rows of its own (wrapped at its words where the column is narrow): the left column's words
      const left = v.lines.map((l) => plain(l).split(' │ ')[0].trim()).join(' ');
      expect(left).toContain(PLAN_COMMAND);
      expect(left).toContain(DECIDE_COMMAND);
      // a command is said plainly: the one amber primary is the frame's (row 2), not the body's
      expect(rolesOf(v.lines, /^timmy (fleet plan|decide route)/)).toEqual(['strong', 'strong']);
    }
    const stacked = text(fleetView(ctxAt(100, 30), d, frame).lines);
    expect(stacked).toMatch(new RegExp(`^  ${PLAN_COMMAND.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
    expect(stacked).toMatch(/makes one on the FAKE backend \(a simulation: nothing starts\)/);
  });
});

describe('tab 8: Clef-Omni', () => {
  it('its mode off by default, its thresholds said to be uncalibrated, and its review rule and transport', async () => {
    const f = await fixture();
    const env = { ...process.env };
    delete env.TIMMY_CLEF;
    const d = readFleet({ home: f.home, root: f.root, env });
    expect(d.clef).toMatchObject({ useClef: false, from: 'default', requireReview: true, thresholds: { minTop: 0.6, minMargin: 0.15 } });
    const frame = await frameOf(f.root);
    for (const [c, r] of SIZES) {
      const v = fleetView(ctxAt(c, r), d, frame);
      const all = text(v.lines);
      // R9 (H162): model-neutral words; no model is set up in this fixture's home
      expect(all).toMatch(/DECISION MODEL · none set up/);
      expect(all).toMatch(/Decision-model routing: off \(the default\)/);
      expect(all).toMatch(/uncalibrated thresholds/);
      expect(rolesOf(v.lines, /^uncalibrated thresholds$/)).toEqual(['attention']);
      // the fullest words that fit: the review rule whole, in a narrow column its short form
      expect(all).toMatch(/Review: (every recommendation waits for a person|a person approves each one)/);
      expect(all).toMatch(/Transport: not set up/);
    }
    expect(text(fleetView(ctxAt(160, 45), d, frame).lines)).toMatch(/uncalibrated thresholds: 60\.0% top, 15\.0% margin/);
    const stacked = fleetView(ctxAt(100, 30), d, frame).lines;
    expect(text(stacked)).toMatch(/Decision-model routing: off \(the default\): routes stay deterministic; no model is asked/);
    expect(text(stacked)).toMatch(/uncalibrated thresholds: 60\.0% top, 15\.0% margin \(placeholders, not checked against outcomes\)/);
    expect(text(stacked)).toMatch(/Review: every recommendation waits for a person \(the default\)/);
    expect(text(stacked)).toMatch(/Transport: not set up \(no decision\/clef\.json in Timmy's home\)/);
    // TIMMY_CLEF=1 turns it on for one process, and says so (in a narrow column, still which variable)
    const on = readFleet({ home: f.home, root: f.root, env: { ...env, TIMMY_CLEF: '1' } });
    expect(text(fleetView(ctxAt(100, 30), on, frame).lines)).toMatch(/Decision-model routing: on \(TIMMY_CLEF=1, for this process\): the model scores the options/);
    expect(text(fleetView(ctxAt(120, 40), on, frame).lines)).toMatch(/Decision-model routing: on \(TIMMY_CLEF=1/);
  });

  it('the decisions newest first: what each recommended, that a recommendation is not a run, and its scores as bars (never green)', async () => {
    const f = await fixture();
    const d = readFleet({ home: f.home, root: f.root, env: process.env });
    expect(d.decisions.map((x) => x.outcome)).toEqual(['fallback', 'recommend']);
    const frame = await frameOf(f.root);
    const at = d.plans.length + 1; // the recommendation, selected
    for (const [c, r] of SIZES) {
      const v = fleetView(ctxAt(c, r, at), d, frame);
      const all = text(v.lines);
      // what it recommended and that it is not a run, at every size
      expect(all).toMatch(/recommended Codex[^\n]*not a run/);
      expect(all).toMatch(/deterministic: pi/);
      // (R7 H150: a recommendation is a prediction, amber as .predict is: role accent, B10)
      expect(rolesOf(v.lines, /^Codex$/)).toEqual(['accent']);
      // the bars: one for each option scored, the recommended amber
      expect(all).toMatch(/Codex +█+░*  \d+\.\d%/);
      expect(all).toMatch(/pi +█*░+ +\d+\.\d%/);
      expect(rolesOf(v.lines, /^█+$/)).toContain('accent');
      for (const s of greens(v.lines)) expect(s).not.toMatch(/Codex|recommend|█/);
    }
    const stacked = text(fleetView(ctxAt(100, 30, at), d, frame).lines);
    expect(stacked).toMatch(/clef-omni recommended Codex \d+\.\d%, ahead by \d+\.\d%: a recommendation, not a run/);
    expect(stacked).toMatch(/deterministic: pi by the existing route the caller named/);
    expect(stacked).toMatch(/⚠ needs you: a person approves before anything is dispatched/);
    expect(stacked).toMatch(/clef-omni via a fixture file \(no service was called\) · cost not measured/);
  });
});

describe('tab 8: Cloudflare and the services', () => {
  it('Cloudflare is optional and not the chat provider, set up or not; the services as the frame observed them, green only for live', async () => {
    const f = await fixture();
    // a FAKE observation, as `timmy workspace check` records one: the companion answered just now
    writeConnections({ schema: CONNECTIONS_SCHEMA, checks: { companion: { answer: 'accepted', at: new Date().toISOString(), detail: 'running' } } }, process.env);
    const frame = await frameOf(f.root);
    expect(frame.connections.find((c) => c.id === 'companion')?.state).toBe('live');
    const d = readFleet({ home: f.home, root: f.root, env: process.env });
    for (const [c, r] of SIZES) {
      const v = fleetView(ctxAt(c, r), d, frame);
      const all = text(v.lines);
      expect(all).toMatch(/CLOUDFLARE · optional/);
      expect(all).toMatch(/edge: · not set up/);
      expect(all).toMatch(/not the chat provider/);
      expect(all).toMatch(/SERVICES · as last observed/);
      expect(all).toMatch(/Workers AI: not used/);
      // every connection's mark and word, as the frame has it, and its name whole (its short form where the column is narrow)
      for (const m of ['● live', '· not set up', '○ configured', '? unknown']) expect(all).toContain(m);
      for (const name of ['Browser companion', 'OpenRouter', 'Cloudroom Core', 'Decision model', 'MCP to CLI: the SDK route']) expect(all).toMatch(new RegExp(`${name}( |$)`, 'm'));
      if (c !== 120) for (const name of ['OpenRouter (cloud chat)', 'Cloudroom Core (fleet backend)', 'Decision model (recommender)']) expect(all).toContain(name);
      // green is the live companion's mark and nothing else
      expect(greens(v.lines)).toEqual(['● live']);
      expect(rolesOf(v.lines, /○ configured/).every((x) => x === 'text')).toBe(true);
    }
    // beside the fleet at 160 (the whole width: src/workbench/layout.ts OWN_COLUMNS): the mark and the name on a row, the
    // frame's words under the name
    expect(text(fleetView(ctxAt(160, 45), d, frame).lines)).toMatch(/│ +● live +Browser companion +\n[^\n]*│ +answered (just now|\d+ min ago)/);
    // beside an open drawer (i at 120 columns: 78 cells), with rows to spare: the name on its row, the mark and the words
    // under it; short of rows, the name and the mark on one row
    expect(text(fleetView({ ...ctxAt(120, 60), width: 78 }, d, frame).lines)).toMatch(/│ +Browser companion +\n[^\n]*│ +● live · answered (just now|\d+ min ago)/);
    expect(text(fleetView({ ...ctxAt(120, 40), width: 78 }, d, frame).lines)).toMatch(/│ +Browser companion +● live *$/m);
    // what a terminal cannot draw, and where it is seen: c the companion, s Studio (the Workbench's own keys), at every size
    for (const [c, r] of SIZES) {
      const v = fleetView(ctxAt(c, r), d, frame);
      // R5 (H131; the QA of e7f853e, defect 2): what no Timmy surface draws of it, and what c shows for it in truth
      // (read in its own column: side by side, its rows sit beside the other column's)
      expect(lastColumn(v.lines)).toMatch(/No Timmy surface draws fleet previews yet\. \[c\] Companion( · Show)?: these cards in words\./);
      expect(rolesOf(v.lines, /^\[(c|s)\]$/)).toEqual(['action']);
    }
    const stacked = text(fleetView(ctxAt(100, 30), d, frame).lines);
    expect(stacked).toMatch(/Workers AI: not used \(the decision model's transport is not Workers AI\)/);
    expect(stacked).toMatch(/not the chat provider: chat goes to OpenRouter or a local Ollama/);
    expect(stacked).toMatch(/● live +Browser companion *\n +answered (just now|\d+ min ago) \(running\)/);
  });

  it('before the frame is read, the services say so; a frame that could not be read says why, amber', async () => {
    const f = await fixture();
    const d = readFleet({ home: f.home, root: f.root, env: process.env });
    expect(text(fleetView(ctxAt(100, 30), d, undefined).lines)).toMatch(/Reading the workspace frame…/);
    const v = fleetView(ctxAt(100, 30), d, undefined, 'EACCES');
    expect(text(v.lines)).toMatch(/The workspace frame could not be read: EACCES\. \[r\] reads it again\./);
    expect(rolesOf(v.lines, /could not be read: EACCES/)).toEqual(['failure']);
  });
});

describe('tab 8: the layout, the items and the Inspector', () => {
  it('beside the services from 120 columns, stacked below; no line longer than its box; at most one amber primary (the body has none)', async () => {
    const f = await fixture();
    const d = readFleet({ home: f.home, root: f.root, env: process.env });
    const frame = await frameOf(f.root);
    const n = d.plans.length + d.decisions.length;
    for (const [c, r] of SIZES) {
      const { width, height } = bodyAt(c, r);
      for (let k = 0; k < n; k++) {
        const v = fleetView(ctxAt(c, r, k), d, frame);
        for (const l of v.lines) expect(lineCells(l)).toBeLessThanOrEqual(width);
        expect(v.items.map((x) => x.item.key)).toEqual([...d.plans.map((p) => `plan:${p.view.planId}`), ...d.decisions.map((x) => `decision:${x.id}`)]);
        expect(v.items[k].line).toBeGreaterThanOrEqual(0);
        expect(plain(v.lines[v.items[k].line])).toContain('▸ ');
        // the row-2 primary is the frame's: the body draws no filled (inverse) amber box of its own
        expect(v.lines.flat().some((s) => s.inverse)).toBe(false);
        const row = (re: RegExp): number => v.lines.findIndex((l) => re.test(plain(l)));
        if (c >= COLUMNS_FROM) {
          expect(v.lines.length).toBeLessThanOrEqual(height);
          // the fleet and Clef-Omni on the left, Cloudflare and the services on the right of the rule
          expect(plain(v.lines[2])).toMatch(/│ CLOUDFLARE · optional/);
          expect(v.lines.slice(2).every((l) => /│/.test(plain(l)))).toBe(true);
          // a clipped column says which of its rows show (at 120 the left column does not hold everything)
          if (c === 120) expect(text(v.lines)).toMatch(/[↑↓] \d+–\d+ of \d+ rows/);
        } else {
          expect(plain(v.lines[row(/^FLEET · plans/)])).not.toMatch(/│/);
          expect(row(/^DECISION MODEL ·/)).toBeGreaterThan(row(/^FLEET · plans/));
          expect(row(/^CLOUDFLARE ·/)).toBeGreaterThan(row(/^DECISION MODEL ·/));
          expect(row(/^SERVICES ·/)).toBeGreaterThan(row(/^CLOUDFLARE ·/));
        }
      }
    }
  });

  it('a plan and a decision each have a detail: every count, the backend as it is, and what a recommendation is', async () => {
    const f = await fixture();
    const d: FleetData = readFleet({ home: f.home, root: f.root, env: process.env });
    const v = fleetView(ctxAt(160, 45), d, await frameOf(f.root));
    const plan = v.items.find((x) => x.item.kind === 'fleet-plan' && x.item.plan.view.planId === f.finished)!.item as FleetItem;
    const p = text(fleetDetail(plan, 44, g)).replace(/\s+/g, ' ');
    expect(p).toMatch(/FLEET PLAN/);
    expect(p).toMatch(/Backend FAKE \(simulation\): no compute, no harness, no model, no cost/);
    expect(p).toMatch(/Planned 3 Admitted 3 Running 0 Done 3 \(the runtime said completed; not verified\)/);
    expect(p).toMatch(/w001 delivered/);
    const decision = v.items.find((x) => x.item.kind === 'clef-decision' && x.item.decision.outcome === 'recommend')!.item as FleetItem;
    const lines = fleetDetail(decision, 44, g);
    const t = text(lines).replace(/\s+/g, ' ');
    expect(t).toMatch(/a model recommendation, not evidence/);
    expect(t).toMatch(/A recommendation is not a run: nothing was dispatched from it/);
    // (R7 H150: a recommendation is a prediction, amber as .predict is: role accent, B10)
    expect(rolesOf(lines, /Recommendation:/)).toEqual(['accent']);
    expect(greens(lines)).toEqual([]);
  });

  it('reads only and asks no network: no file changes, no fetch, while reading and drawing', async () => {
    const f = await fixture();
    const frame = await frameOf(f.root);
    const before = manifest(f.root);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const d = readFleet({ home: f.home, root: f.root, env: process.env });
    for (const [c, r] of SIZES) for (let k = 0; k < 4; k++) fleetView(ctxAt(c, r, k), d, frame);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(manifest(f.root)).toBe(before);
  });
});
