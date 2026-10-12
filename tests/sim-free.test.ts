// R4 (H103): the operator's finding, verbatim: "local c3b4b20 lanes/sim/sim.mjs --free changed actors but left a paid
// simulator". Under a strict free-model policy (planners, workers, simulators, judges, summaries, retries and fallback
// models), --free covers the simulator too: a free model of its own (--sim-model <id ending in :free>, different from the
// actors'), or a refusal that names the flag; a model not known to be free is refused before anything is sent. The run's
// header and footer say both models and the policy.
//
// The lane runs as a real child process, scripted (--dry: no model is called, the turns are the lane's own scripted ones) and
// with nothing sealed (--no-seal). No network: a refusal happens before any request, and a dry run makes none. The one run
// file a run writes (lanes/sim/runs/<run>.jsonl) is read, then removed.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SIM = resolve('lanes/sim/sim.mjs');
const RUNS = resolve('lanes/sim/runs');
const FREE_SIM = 'meta-llama/llama-3.3-70b-instruct:free';
const runsNow = (): string[] => (existsSync(RUNS) ? readdirSync(RUNS).sort() : []);
const sim = (args: string[]) => spawnSync(process.execPath, [SIM, 'run', '--dry', '--no-seal', '--turns', '1', '--layers', 'L1', ...args], { encoding: 'utf8', timeout: 60_000, env: { PATH: process.env.PATH, HOME: process.env.HOME, OPENROUTER_API_KEY: '' } });

describe('timmy sim run --free: every model of the run free, the simulator too', () => {
  it('without a free model for the simulator, the run is refused and names the flag; nothing is sent, no run is written', () => {
    const before = runsNow();
    const r = sim(['--free']);
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('refusing: --free covers the simulator too: give it a free model of its own with --sim-model <id ending in :free>, different from the actors\' openrouter/free. Nothing was sent to any model.');
    expect(runsNow()).toEqual(before);
  });

  it('a simulator or actor model not known to be free is refused, before anything is sent', () => {
    const before = runsNow();
    const paidSim = sim(['--free', '--sim-model', 'x-ai/grok-4.6']);
    expect(paidSim.status).toBe(3);
    expect(paidSim.stderr).toContain('refusing: --free: the simulator model x-ai/grok-4.6 is not a free one (an id ending in :free), so it may be paid. Nothing was sent to any model.');
    const paidActor = sim(['--free', '--actor-model', 'google/gemini-3.7-flash', '--sim-model', FREE_SIM]);
    expect(paidActor.status).toBe(3);
    expect(paidActor.stderr).toContain('refusing: --free: the actor model google/gemini-3.7-flash is not a free one');
    // the simulator must still differ from the actors, free or not
    expect(sim(['--free', '--actor-model', FREE_SIM, '--sim-model', FREE_SIM]).status).toBe(3);
    expect(runsNow()).toEqual(before);
  });

  it('with a free simulator: the run goes (scripted here), and its header, its footer and its first line say both models and the policy', () => {
    const before = new Set(runsNow());
    const r = sim(['--free', '--sim-model', FREE_SIM]);
    const made = runsNow().filter((f) => !before.has(f));
    try {
      expect(r.status, r.stderr).toBe(0);
      expect(made).toHaveLength(1);
      expect(r.stderr).toMatch(new RegExp(`^run sim_\\S+ · .+ · free models only · sim dry/sim \\(a live run: ${FREE_SIM.replace(/[.]/g, '\\.')}\\) · actors dry/actor \\(a live run: openrouter/free\\)$`, 'm'));
      const lines = readFileSync(join(RUNS, made[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const header = lines.find((l) => l.header);
      const footer = lines.find((l) => l.footer);
      for (const end of [header, footer, JSON.parse(r.stdout)]) {
        expect(end).toMatchObject({ policy: 'free models only', chosen: { sim: FREE_SIM, actor: 'openrouter/free' }, models: { sim: 'dry/sim', actor: 'dry/actor' }, dry: true });
      }
    } finally {
      for (const f of made) rmSync(join(RUNS, f), { force: true });
    }
  });

  it('a live run under --free (FAKE OpenRouter, in the process): each request names a free model, and none carries a plugin whose price is not known', () => {
    const box = mkdtempSync(join(tmpdir(), 'sim-free-'));
    const log = join(box, 'requests.jsonl');
    const before = new Set(runsNow());
    // the key is made here, for this run only; the FAKE answers, and nothing leaves the process
    const r = spawnSync(process.execPath, ['--import', resolve('tests/fixtures/fake-openrouter-preload.mjs'), SIM, 'run', '--no-seal', '--turns', '1', '--layers', 'L1', '--free', '--sim-model', FREE_SIM], {
      encoding: 'utf8', timeout: 60_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, OPENROUTER_API_KEY: `sk-or-FAKE-${randomBytes(8).toString('hex')}`, TIMMY_TEST_FETCH_LOG: log },
    });
    const made = runsNow().filter((f) => !before.has(f));
    try {
      expect(r.status, r.stderr).toBe(0);
      const sent = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(sent.map((q) => [q.method, q.url, q.body.model])).toEqual([
        ['POST', 'https://openrouter.ai/api/v1/chat/completions', 'openrouter/free'],
        ['POST', 'https://openrouter.ai/api/v1/chat/completions', FREE_SIM],
      ]);
      // the simulator still asks for JSON (a request parameter), and no plugin rides along
      expect(sent[1].body.response_format).toEqual({ type: 'json_object' });
      expect(sent.filter((q) => 'plugins' in q.body)).toEqual([]);
      expect(JSON.parse(r.stdout)).toMatchObject({ policy: 'free models only', models: { sim: FREE_SIM, actor: 'openrouter/free' }, dry: false, usd: 0 });
    } finally {
      for (const f of made) rmSync(join(RUNS, f), { force: true });
      rmSync(box, { recursive: true, force: true });
    }
  });

  it('without --free the board\'s models stand, and the run says they may be paid', () => {
    const before = new Set(runsNow());
    const r = sim([]);
    const made = runsNow().filter((f) => !before.has(f));
    try {
      expect(r.status, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout)).toMatchObject({ policy: 'paid models allowed', chosen: { sim: 'x-ai/grok-4.6', actor: 'google/gemini-3.7-flash' } });
    } finally {
      for (const f of made) rmSync(join(RUNS, f), { force: true });
    }
  });
});
