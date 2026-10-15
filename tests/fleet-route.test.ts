/**
 * Round R4 (lead): a fleet plan's route advice (src/fleet/service.ts adviseRoute): one decision per plan through the
 * decision provider (src/decision, H120), shown as a recommendation and never applied. REAL: the plan files, the decision
 * service, its checks and records, the CLI through the shipped entry, God's Eye View's Fleets part. FAKE: the backend and
 * the model's answer (tests/fixtures/clef-omni/fleet-route-pi.json, handwritten; no service is called).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_DECISION_SETTINGS } from '../src/decision/settings.js';
import { adviseRoute, planFleet, readRouteAdvice, type PlanRequest } from '../src/fleet/service.js';
import { buildOverview } from '../src/overview/index.js';
import { overviewLines } from '../src/repl/overview.js';
import { glyphSet } from '../src/term/glyphs.js';
import { planHashOf } from '../src/utils/approvals.js';

const REPO = path.resolve(__dirname, '..');
const LOADER = pathToFileURL(path.join(REPO, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
const CLI = path.join(REPO, 'src', 'cli.ts');
const FIXTURE = path.join(REPO, 'tests', 'fixtures', 'clef-omni', 'fleet-route-pi.json');
const roots: string[] = [];
afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

function project(): string {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-route-'));
  roots.push(r);
  const g = (...a: string[]) => spawnSync('git', ['-c', 'user.email=fake', '-c', 'user.name=FAKE', ...a], { cwd: r, encoding: 'utf8' });
  g('init', '-q');
  g('commit', '-q', '--allow-empty', '-m', 'FAKE');
  return r;
}
const req = (over: Partial<PlanRequest> = {}): PlanRequest => ({ agents: 100, concurrency: 4, provider: 'fake', isolation: 'vm', harness: 'codex', model: 'fake-model', prompt: 'FAKE task', ...over });
const on = { ...DEFAULT_DECISION_SETTINGS, useClef: true };
const decisions = (root: string): string[] => { try { return fs.readdirSync(path.join(root, '.timmy', 'decisions')).filter((f) => f.endsWith('.json')); } catch { return []; } };

describe('route advice for a fleet plan', () => {
  it('asks nothing and records nothing while "Use Clef routing" is off', async () => {
    const root = project();
    const made = planFleet(root, req());
    if (!made.ok) throw new Error('not planned');
    expect(await adviseRoute(root, made.plan, { decide: { settings: DEFAULT_DECISION_SETTINGS } })).toBeUndefined();
    expect(readRouteAdvice(root, made.plan.id)).toBeUndefined();
    expect(decisions(root)).toEqual([]);
  });

  it('a 100-worker plan asks once; the recommendation is shown, never applied; asking again returns the same record', async () => {
    const root = project();
    const made = planFleet(root, req());
    if (!made.ok) throw new Error('not planned');
    const before = fs.readFileSync(path.join(root, '.timmy', 'fleet', made.plan.id, 'plan.json'), 'utf8');
    const advice = await adviseRoute(root, made.plan, { decide: { settings: on, fixture: FIXTURE } });
    expect(advice).toMatchObject({ outcome: 'recommend', recommended: 'pi', kept: 'codex', reused: false });
    expect(advice!.words).toBe('route: pi recommended (62.0%, ahead by 42.0%): a model recommendation, not evidence; not applied, the plan keeps codex (to follow it: timmy fleet plan --harness pi …, a new plan checked again)');
    // one question for 100 workers, one record; the plan file and its approval hash are untouched
    expect(decisions(root)).toHaveLength(1);
    const after = fs.readFileSync(path.join(root, '.timmy', 'fleet', made.plan.id, 'plan.json'), 'utf8');
    expect(after).toBe(before);
    expect(planHashOf(JSON.parse(after))).toBe(planHashOf(made.plan));
    const record = JSON.parse(fs.readFileSync(path.join(root, '.timmy', 'decisions', decisions(root)[0]), 'utf8'));
    expect(record).toMatchObject({ kind: 'route', operationId: made.plan.operationId, outcome: 'recommend', evidence_kind: 'machine_inference', note: 'a model recommendation, not evidence' });
    expect(record.project.revision).toBe(made.plan.project.revision);
    expect(record.options.permitted.map((o: { id: string }) => o.id).sort()).toEqual(['claude-code', 'codex', 'opencode', 'openhands', 'pi']);
    // the same plan asks again: the recorded decision, no second record
    const again = await adviseRoute(root, made.plan, { decide: { settings: on, fixture: FIXTURE } });
    expect(again).toMatchObject({ decision: advice!.decision, reused: true });
    expect(decisions(root)).toHaveLength(1);
    // God's Eye View draws it, in the attention colour, beside the plan
    const o = buildOverview(root, { name: 'proj', env: { TIMMY_HOME: path.join(root, '.fake-home', 'timmy') } });
    expect(o.fleet?.items[0].route).toEqual({ words: advice!.words, decision: advice!.decision, outcome: 'recommend' });
    const line = overviewLines(o, 'fleet', { glyphs: glyphSet(true) }).find((l) => l[0]?.text === '      route     ')!;
    expect(line[1]).toEqual({ text: advice!.words.replace(/^route: /, ''), role: 'estimate' });
  });

  it('through the shipped CLI: the plan line, then status, say the same; Clef off says nothing', () => {
    const root = project();
    const home = path.join(root, '.fake-home');
    const timmy = (env: Record<string, string>, ...args: string[]) => spawnSync(process.execPath, ['--import', LOADER, CLI, ...args], {
      cwd: root, encoding: 'utf8', timeout: 90_000,
      env: { PATH: process.env.PATH, HOME: home, TIMMY_HOME: path.join(home, 'timmy'), TIMMY_SETTINGS_DIR: path.join(home, 'settings'), TMPDIR: process.env.TMPDIR, ...env },
    });
    const off = timmy({}, 'fleet', 'plan', '--workers', '3');
    expect(off.status).toBe(0);
    expect(off.stdout).not.toMatch(/route:/);
    const planned = timmy({ TIMMY_CLEF: '1' }, 'fleet', 'plan', '--workers', '100', '--decide-fixture', FIXTURE, '--json');
    expect(planned.status).toBe(0);
    const j = JSON.parse(planned.stdout.trim().split('\n').pop()!) as { plan: string; route: { recommended: string; kept: string } };
    expect(j.route).toMatchObject({ recommended: 'pi', kept: 'codex' });
    const status = timmy({}, 'fleet', 'status', j.plan);
    expect(status.stdout).toMatch(/route: pi recommended \(62\.0%, ahead by 42\.0%\): a model recommendation, not evidence; not applied, the plan keeps codex/);
  }, 120_000);
});
