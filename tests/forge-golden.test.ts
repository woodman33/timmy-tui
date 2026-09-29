// Golden missions (Task 18): synthetic pipeline regression at $0; no evidence qualification. Three scripted
// mission briefs run through the REAL module wiring — states.ts transitions,
// runner.ts ledger I/O, orchestrator.ts spend gates, judges panel/parliament
// with injected scripted llmCalls, prompt-version.ts chain, probe segment
// slicing on the shared fixture, dryrun.ts spend-curve assertion, and the OTIO
// chain export. Generation is scripted per call (with the clean mission's
// first call routed through the real hfGenerate stub to prove stub
// integration). Any module drift fails loudly, naming the mission id.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transition, type EventName, type PipelineState } from '../src/forge/pipeline/states.js';
import {
  submitMission,
  recordTransition,
  recordRunStarted,
  recordModeSwitch,
} from '../src/forge/pipeline/runner.js';
import {
  makeOrchestratorState,
  canSpend,
  applySpend,
  type OrchestratorState,
  type PlanCaps,
} from '../src/forge/pipeline/orchestrator.js';
import {
  simulateSpendCurve,
  estimateRecordedCostFloor,
  recordGeneration,
  requestKeyOf,
} from '../src/forge/pipeline/dryrun.js';
import { runPanel } from '../src/forge/judges/panel.js';
import { runParliament } from '../src/forge/judges/parliament.js';
import { newPromptVersion, type Beat, type PromptVersion } from '../src/forge/prompt-version.js';
import { hfGenerate, type HfGenResult } from '../src/forge/higgsfield/client.js';
import type { Balance } from '../src/forge/higgsfield/balance.js';
import { sliceProbe, recordSegments, verifySegments } from '../src/forge/probe/segments.js';
import { readLedger } from '../src/forge/ledger.js';
import { emitTimeline } from '../src/forge/timeline.js';
import { sha256 } from '../src/forge/gen.js';
import { appendReceipt, verifyChain } from '../src/utils/receipts.js';
import { ffmpegAvailable } from '../src/utils/framecap.js';

// Lazily generated synthetic probe reused from Task 11 (gitignored media).
const FIXTURE = join(__dirname, 'fixtures', 'probe-3s.mp4');

interface GoldenMission {
  id: string;
  brief: {
    mission_id: string; prompt: string; stage: string; provider: string;
    beats: Beat[]; max_spend_usd: number; max_probe_calls: number; max_render_calls: number;
    declared_balance_usd: number; threshold: number; facets: string[];
    local_judges: string[]; frontier_judges: string[];
    rewriters: string[]; judge_model: string;
    max_iterations: number; max_probe_attempts: number;
  };
  script: {
    generations: Array<{ stage: 'probe' | 'render'; status: 'completed' | 'failed' | 'nsfw'; cost_usd: number; cost_measured: boolean; via: 'scripted' | 'real-hf-stub' }>;
    probe_judge_verdicts: Array<{ scores: Record<string, number>; confidence: number; critique: string }>;
    parliament?: {
      failingBeatIds: string[];
      rewrites: Record<string, Record<string, string>>;
      judge: { picks: Array<{ beat_id: string; rewriter: string; reason: string }> };
    };
    expected: {
      final_stage: string; generations: number; probe_panels: number; parliaments: number;
      iterations: number; versions: number; probe_calls: number; render_calls: number;
      total_calls: number; within_budget: boolean; toxic?: boolean;
    };
  };
}

interface GoldenReport {
  id: string;
  stage: string;
  transitions: number;
  versions: PromptVersion[];
  spent_usd: number;
  sliced: boolean;
}

// The contract gate: every cross-cutting check fails loudly, naming the
// mission, so a drifted module points at the golden mission that caught it.
function check(missionId: string, cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`GOLDEN DRIFT [${missionId}]: ${msg}`);
}

async function runGoldenMission(mission: GoldenMission, dir: string): Promise<GoldenReport> {
  const id = mission.id;
  // Each replay owns its queues; do not consume the shared corpus fixture.
  const { brief, script } = structuredClone(mission);
  const exp = script.expected;

  const caps: PlanCaps = {
    max_spend_usd: brief.max_spend_usd,
    max_probe_calls: brief.max_probe_calls,
    max_render_calls: brief.max_render_calls,
    declared_balance_usd: brief.declared_balance_usd,
  };
  // Declared balance per the evidence rules — labeled, never measured.
  const balance: Balance = {
    usd: brief.declared_balance_usd,
    source: 'declared',
    detail: 'golden: operator-declared balance (declared, not measured)',
  };

  // Orchestrator: approval → autonomous on operator plan approval; exactly one
  // mode receipt lands in the ledger for the whole mission.
  let orch = makeOrchestratorState(id);
  const modeRec = recordModeSwitch(dir, {
    mission_id: id, from: 'approval', to: 'autonomous', reason: 'golden: operator plan approval',
  });
  orch = { ...orch, mode: 'autonomous' };

  let pv: PromptVersion = newPromptVersion({
    mission_id: id,
    stage: brief.stage,
    prompt: brief.prompt,
    beats: brief.beats.map(b => ({ id: b.id, t: b.t, text: b.text })),
  });
  const versions: PromptVersion[] = [pv];

  let state: PipelineState = {
    mission_id: id,
    stage: 'intake',
    prompt_version_id: pv.id,
    probe_attempts: 0,
    iterations: 0,
    degraded: false,
    toxic: false,
    config: {
      on_budget_exhausted: 'escalate',
      max_probe_attempts: brief.max_probe_attempts,
      max_iterations: brief.max_iterations,
    },
    history: [],
  };

  let transitions = 0;
  const step = (event: EventName): void => {
    const r = transition(state, event); // pure machine
    recordTransition(dir, state, r.state, event); // ledger I/O + close logic
    state = r.state;
    transitions++;
  };

  const genQueue = [...script.generations];
  const genResults: HfGenResult[] = [];
  const generationVersionIds: string[] = [];
  const generationInputs: Array<{ prompt: string; beats: Beat[] }> = [];
  const spendDecisions: Array<{ kind: string; est: number; ok: boolean; reason?: string }> = [];
  let probePanels = 0;
  let parliaments = 0;
  let sliced = false;

  // One paid generation call behind the real spend gates and ledger guards.
  const paidGenerate = async (kind: 'probe' | 'render', promptText: string): Promise<HfGenResult> => {
    const entry = genQueue.shift();
    check(id, entry, `generate called beyond scripted generations (${kind})`);
    check(id, entry.stage === kind, `scripted generation stage mismatch: script says ${entry.stage}, call was ${kind}`);
    // Open the in-flight submission guard. A duplicate-in-flight refusal is the
    // real dedup path (probe→probe_judging→full_render keeps one open); any
    // other refusal is drift.
    const sub = submitMission(dir, {
      mission_id: id, prompt_version_id: state.prompt_version_id, segment: 'main',
    });
    check(id, sub.ok || sub.reason === 'duplicate submission in flight',
      `submitMission refused: ${(sub as { reason: string }).reason}`);
    const dec = canSpend(orch, caps, balance, entry.cost_usd, kind);
    spendDecisions.push({
      kind, est: entry.cost_usd, ok: dec.ok === true,
      ...(!dec.ok ? { reason: (dec as { reason: string }).reason } : {}),
    });
    check(id, dec.ok, `canSpend refused ${kind} est $${entry.cost_usd}: ${(dec as { reason: string }).reason}`);
    orch = applySpend(orch, kind, entry.cost_usd);
    recordRunStarted(dir, {
      mission_id: id, prompt_version_id: state.prompt_version_id, segment: 'main',
      stage: kind === 'probe' ? 'probe' : 'full_render',
      endpoint: 'dop-turbo', plan_seq: modeRec.seq,
    });
    const generationInput = { prompt: promptText, beats: structuredClone(pv.beats) };
    generationInputs.push(generationInput);
    let result: HfGenResult;
    if (entry.via === 'real-hf-stub') {
      // Prove real stub integration on the clean mission: no creds, $0 measured.
      result = await hfGenerate({ endpoint: 'dop-turbo', input: generationInput, mode: 'stub' });
      check(id, result.status === 'completed' && result.cost_usd === 0 && result.cost_measured === true,
        'real hfGenerate stub must return a measured $0 completed result');
    } else {
      result = {
        request_id: `golden-${id}-${genResults.length + 1}`,
        status: entry.status,
        artifact_url: `stub://golden/${id}/${genResults.length + 1}.mp4`,
        cost_usd: entry.cost_usd,
        probe: kind === 'probe',
        cost_measured: entry.cost_measured,
      };
    }
    // Record for dry-run replay + drive the spend-curve assertion from these.
    recordGeneration(dir, {
      request_key: requestKeyOf('dop-turbo', { ...generationInput, probe: kind === 'probe' }),
      response: result, mode: 'stub',
    });
    genResults.push(result);
    generationVersionIds.push(pv.id);
    return result;
  };

  const runProbePanel = async (artifactRef: string) => {
    const verdict = script.probe_judge_verdicts.shift();
    check(id, verdict, 'probe panel called beyond scripted verdicts');
    const panel = await runPanel({
      llmCall: async o => ({ text: JSON.stringify(verdict), via: 'ollama', cost_usd: 0, ms: 1, model: o.model }),
      localJudges: brief.local_judges,
      frontierJudges: brief.frontier_judges,
      threshold: brief.threshold,
      facets: brief.facets,
      artifactRef,
    });
    probePanels++;
    return panel;
  };

  // ---- drive the state machine ----
  step('submitted'); // intake → pre_vetting
  step('passed');    // pre_vetting → probe (scripted vetting pass)

  for (;;) {
    if (state.stage === 'probe') {
      const res = await paidGenerate('probe', pv.prompt);
      if (res.status === 'nsfw') {
        step('nsfw'); // → quarantined, toxic
        break;
      }
      if (res.status !== 'completed') {
        step('failed'); // → iterate; unscripted for these missions → loop throws loud
        continue;
      }
      step('completed'); // → probe_judging
      const panel = await runProbePanel(res.artifact_url);
      if (panel.final.pass) {
        pv = { ...pv, beats: pv.beats.map(b => ({ ...b, probe_validated: true })) };
        versions[versions.length - 1] = pv;
        // Segments: slice the shared probe fixture when ffmpeg is present;
        // otherwise the pipeline still runs on scripted segment metadata.
        if (ffmpegAvailable()) {
          const outDir = join(dir, 'segments');
          const segs = await sliceProbe(FIXTURE, pv.beats, outDir);
          check(id, segs.length === pv.beats.length,
            `sliceProbe produced ${segs.length}/${pv.beats.length} segments`);
          recordSegments(dir, id, segs);
          const verified = verifySegments(dir, id, outDir);
          check(id, verified.every(v => v.ok),
            `verifySegments mismatch: ${JSON.stringify(verified.filter(v => !v.ok))}`);
          sliced = true;
        } else {
          console.warn(`golden [${id}]: ffmpeg absent — segments not sliced, scripted metadata only`);
        }
        step('passed'); // → full_render
      } else {
        step('failed'); // probe_judging → iterate
        const parlScript = script.parliament;
        check(id, parlScript, 'panel failed but mission scripts no parliament');
        const parl = await runParliament({
          prev: pv,
          failingBeatIds: parlScript.failingBeatIds,
          critique: panel.final.verdict.critique,
          rewriters: brief.rewriters,
          judgeModel: brief.judge_model,
          llmCall: async o => {
            if (o.model === brief.judge_model) {
              return { text: JSON.stringify(parlScript.judge), via: 'ollama', cost_usd: 0, ms: 1, model: o.model };
            }
            const rw = parlScript.rewrites[o.model];
            check(id, rw, `parliament rewriter ${o.model} not scripted`);
            return {
              text: JSON.stringify({
                rewrites: Object.entries(rw).map(([beat_id, text]) => ({ beat_id, text })),
                critique_of_change: `crit-${o.model}`,
              }),
              via: 'ollama', cost_usd: 0, ms: 1, model: o.model,
            };
          },
        });
        parliaments++;
        pv = parl.version; // nextPromptVersion really used
        versions.push(pv);
        step('revised'); // close the old-version transition first.
        state = { ...state, prompt_version_id: pv.id }; // next generation belongs to the revised prompt.
      }
      continue;
    }
    if (state.stage === 'full_render') {
      const res = await paidGenerate('render', pv.prompt);
      check(id, res.status === 'completed', `full_render generation status ${res.status}`);
      step('completed'); // → chain
      // OTIO chain export: one gen.result receipt per validated beat, then
      // emit with probe-validation metadata.
      const validations = pv.beats.map(b => ({ beat_id: b.id, probe_validated: b.probe_validated === true }));
      for (const b of pv.beats) {
        appendReceipt('runs', {
          kind: 'gen.result', subject: `forge ${b.id} · golden ${id}`,
          policy: 'auto', prompt_hash: sha256(b.text), model_resolved: 'higgsfield/dop-turbo',
          via: brief.provider, ms: 1, cost_usd: 0, output_sha256: sha256(`golden:${id}:${b.id}`),
          artifacts: [res.artifact_url], status: 'ok',
          sources: [{ slot_id: b.id, local: true }], cost_measured: true,
        } as never, dir);
      }
      const tl = emitTimeline({ dir, segments: validations });
      check(id, tl.clips === pv.beats.length, `OTIO clip count ${tl.clips} != ${pv.beats.length} beats`);
      const otio = JSON.parse(readFileSync(tl.file, 'utf8')) as {
        tracks: { children: { children: { name: string; metadata: { timmy: Record<string, unknown> } }[] }[] };
      };
      for (const clip of otio.tracks.children[0].children) {
        const m = clip.metadata.timmy;
        check(id, m.probe_validated === false, `OTIO clip ${clip.name} incorrectly upgrades a synthetic declaration to verified`);
        check(id, m.probe_validation_declared === true && m.probe_validation_state === 'declared',
          `OTIO clip ${clip.name} must retain declared-only synthetic probe status`);
        check(id, typeof m.beat_id === 'string' && m.beat_id.length > 0, `OTIO clip ${clip.name} missing beat_id`);
        check(id, typeof m.receipt_hash === 'string' && m.receipt_hash.startsWith('sha256_'), `OTIO clip ${clip.name} missing receipt hash`);
      }
      check(id, verifyChain('runs', dir).ok, 'runs receipt chain failed verification after timeline emit');
      step('completed'); // chain → done
      break;
    }
    throw new Error(`GOLDEN DRIFT [${id}]: unhandled stage ${state.stage} — script and machine diverged`);
  }

  // ---- cross-cutting assertions ----
  check(id, state.stage === exp.final_stage, `final stage ${state.stage} != expected ${exp.final_stage}`);
  check(id, state.toxic === Boolean(exp.toxic), `toxic ${state.toxic} != expected ${Boolean(exp.toxic)}`);
  check(id, state.iterations === exp.iterations, `iterations ${state.iterations} != ${exp.iterations}`);
  check(id, genQueue.length === 0 && script.probe_judge_verdicts.length === 0, 'scripted generation or judge replies were left unconsumed');
  check(id, genResults.length === exp.generations, `generations ${genResults.length} != ${exp.generations}`);
  check(id, probePanels === exp.probe_panels, `probe panels ${probePanels} != ${exp.probe_panels}`);
  check(id, parliaments === exp.parliaments, `parliaments ${parliaments} != ${exp.parliaments}`);
  check(id, versions.length === exp.versions, `prompt versions ${versions.length} != ${exp.versions}`);
  check(id, orch.probe_calls === exp.probe_calls, `probe calls ${orch.probe_calls} != ${exp.probe_calls}`);
  check(id, orch.render_calls === exp.render_calls, `render calls ${orch.render_calls} != ${exp.render_calls}`);
  check(id, genResults.length === exp.total_calls, `total calls ${genResults.length} != ${exp.total_calls}`);
  check(id, spendDecisions.every(d => d.ok),
    `canSpend refusals: ${JSON.stringify(spendDecisions.filter(d => !d.ok))}`);

  // Prompt-version chain: nextPromptVersion increments and parents for real.
  check(id, versions[0]!.version === 1, `initial version ${versions[0]!.version} != 1`);
  for (let i = 1; i < versions.length; i++) {
    check(id, versions[i]!.version === versions[i - 1]!.version + 1, `version chain broke at index ${i}`);
    check(id, versions[i]!.parent === versions[i - 1]!.id, `version parent chain broke at index ${i}`);
  }

  // Every recorded generation input includes the exact beat text of its revision.
  for (let i = 0; i < generationInputs.length; i++) {
    const revision = versions.find(v => v.id === generationVersionIds[i]);
    check(id, revision, 'generation referenced an unknown prompt revision');
    check(id, JSON.stringify(generationInputs[i]!.beats.map(b => ({ id: b.id, t: b.t, text: b.text }))) ===
      JSON.stringify(revision.beats.map(b => ({ id: b.id, t: b.t, text: b.text }))), 'generation omitted revised beat text');
  }

  // Spend curve over the recorded generation responses vs the mission cap.
  const curve = simulateSpendCurve(genResults, { max_spend_usd: caps.max_spend_usd }, estimateRecordedCostFloor);
  check(id, curve.ok, `spend curve exceeded cap: ${JSON.stringify(curve)}`);
  if (curve.ok && exp.within_budget) {
    check(id, curve.spend.estimated_spend_usd <= caps.max_spend_usd,
      `simulated spend ${curve.spend.estimated_spend_usd} > cap ${caps.max_spend_usd}`);
  }
  check(id, orch.spent_usd <= caps.max_spend_usd,
    `orchestrator spent ${orch.spent_usd} > cap ${caps.max_spend_usd}`);

  // Ledger integrity: sealed chain verifies; record kinds account for the run.
  const rows = readLedger(dir, { verify: true }); // throws on any chain break
  const byKind = (k: string) => rows.filter(r => r.kind === k);
  check(id, byKind('pipeline_stage').length === transitions,
    `pipeline_stage records ${byKind('pipeline_stage').length} != transitions ${transitions}`);
  check(id, state.history.length === transitions, `history length ${state.history.length} != ${transitions}`);
  check(id, byKind('orchestrator_mode').length === 1,
    `orchestrator_mode records ${byKind('orchestrator_mode').length} != 1`);
  check(id, byKind('pipeline_run_started').length === genResults.length,
    `run_started records ${byKind('pipeline_run_started').length} != ${genResults.length} generations`);
  check(id, byKind('pipeline_run_started').every((r, i) => r.prompt_version_id === generationVersionIds[i]),
    'run_started prompt version does not match the generation input revision');
  check(id, byKind('generation').length === genResults.length,
    `generation records ${byKind('generation').length} != ${genResults.length}`);
  check(id, Boolean(exp.toxic) === (byKind('pipeline_toxic').length === 1),
    `pipeline_toxic records ${byKind('pipeline_toxic').length} for toxic=${Boolean(exp.toxic)}`);
  const opens = byKind('pipeline_submission').filter(r => r.action === 'open').length;
  const closes = byKind('pipeline_submission').filter(r => r.action === 'close').length;
  check(id, opens > 0 && opens === closes, `submission open/close imbalance: ${opens} opens, ${closes} closes`);

  return { id, stage: state.stage, transitions, versions, spent_usd: orch.spent_usd, sliced };
}

const FIXTURES = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'golden-missions.json'), 'utf8')
) as { schema_version: number; missions: GoldenMission[] };

const PREV_ENV: Record<string, string | undefined> = {};

beforeAll(() => {
  // House env hygiene: no ambient creds may leak into the $0 contract; the
  // forge lane flag must be armed for the OTIO emit.
  PREV_ENV.HF_CREDENTIALS = process.env.HF_CREDENTIALS;
  PREV_ENV.TIMMY_FORGE = process.env.TIMMY_FORGE;
  delete process.env.HF_CREDENTIALS;
  process.env.TIMMY_FORGE = '1';
  // Lazily materialize the shared probe fixture (same recipe as Task 11).
  if (ffmpegAvailable() && !existsSync(FIXTURE)) {
    mkdirSync(join(FIXTURE, '..'), { recursive: true });
    execFileSync('ffmpeg', [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=10',
      '-pix_fmt', 'yuv420p', FIXTURE,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
  }
});

afterAll(() => {
  for (const k of ['HF_CREDENTIALS', 'TIMMY_FORGE'] as const) {
    if (PREV_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = PREV_ENV[k];
  }
});

describe('golden missions (synthetic pipeline regression, $0; no evidence qualification)', () => {
  it('fixture schema sanity: three missions, three distinct terminal paths', () => {
    expect(FIXTURES.schema_version).toBe(1);
    expect(FIXTURES.missions).toHaveLength(3);
    // Three distinct terminal PATHS: clean pass, iterate→parliament→done,
    // nsfw→quarantined. Two missions share the 'done' stage by design.
    const byId = new Map(FIXTURES.missions.map(m => [m.id, m.script.expected]));
    expect(byId.get('golden-product-shot')).toMatchObject({ final_stage: 'done', iterations: 0, parliaments: 0 });
    expect(byId.get('golden-scene-orbit')).toMatchObject({ final_stage: 'done', iterations: 1, parliaments: 1 });
    expect(byId.get('golden-talking-head')).toMatchObject({ final_stage: 'quarantined', toxic: true });
  });

  for (const mission of FIXTURES.missions) {
    it(`${mission.id}: ${mission.script.expected.final_stage} path`, async () => {
      const dir = mkdtempSync(join(tmpdir(), `forge-golden-${mission.id}-`));
      const fixtureBefore = JSON.stringify(mission);
      const report = await runGoldenMission(mission, dir);
      expect(JSON.stringify(mission)).toBe(fixtureBefore);
      expect(report.stage).toBe(mission.script.expected.final_stage);
      expect(report.spent_usd).toBeLessThanOrEqual(mission.brief.max_spend_usd);
      if (mission.script.expected.final_stage === 'done') {
        expect(report.versions[report.versions.length - 1]!.beats.every(b => b.probe_validated === true)).toBe(true);
        if (ffmpegAvailable()) expect(report.sliced).toBe(true);
      }
    });
  }
});
