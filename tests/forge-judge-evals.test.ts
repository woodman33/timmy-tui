// Judge eval corpus runner — the regression gate for the runPanel contract
// in src/forge/judges/panel.ts. Each corpus case scripts the judges' verdicts
// through a deterministic llmCall stub and asserts the panel's contractual
// behavior (pass/fail, escalation, arbitrator veto). Nothing here networks
// or spends; a drift in panel.ts fails loudly with the case id.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { runPanel, type JudgeVerdict } from '../src/forge/judges/panel.js';

interface CorpusCase {
  id: string;
  class: 'known_good' | 'known_bad';
  facets: string[];
  threshold: number;
  fenced_local?: boolean;
  fenced_arbitrator?: boolean;
  local_verdicts: (JudgeVerdict | string)[];
  arbitrator_verdict?: JudgeVerdict;
  expected: {
    final_pass?: boolean;
    escalated?: boolean;
    arbitrator_must_veto?: boolean;
    veto_facets?: string[];
    throws?: boolean;
    matches?: string;
  };
}

interface Corpus {
  schema_version: number;
  cases: CorpusCase[];
}

function loadCorpus(): Corpus {
  const raw = JSON.parse(readFileSync(new URL('./fixtures/judge-eval-corpus.json', import.meta.url), 'utf8'));
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.cases))
    throw new Error('judge-eval corpus: missing cases[]');
  if (raw.schema_version !== 1)
    throw new Error(`judge-eval corpus: unsupported schema_version ${raw.schema_version}`);
  raw.cases.forEach((c: any, i: number) => {
    const need = (k: string) => { if (c[k] === undefined || c[k] === null) throw new Error(`judge-eval corpus: case [${i}] missing "${k}"`); };
    need('id'); need('class'); need('facets'); need('threshold'); need('local_verdicts'); need('expected');
    if (typeof c.threshold !== 'number' || !Number.isFinite(c.threshold) || c.threshold < 0 || c.threshold > 1)
      throw new Error(`judge-eval corpus: case [${i}] ("${c.id}") has invalid threshold (need finite number 0..1, got ${JSON.stringify(c.threshold)})`);
    if (!Array.isArray(c.local_verdicts))
      throw new Error(`judge-eval corpus: case [${i}] ("${c.id}") local_verdicts must be an array`);
    if (!Array.isArray(c.facets) || !c.facets.length)
      throw new Error(`judge-eval corpus: case [${i}] ("${c.id}") has empty facets`);
    if (c.class !== 'known_good' && c.class !== 'known_bad')
      throw new Error(`judge-eval corpus: case [${i}] ("${c.id}") has invalid class "${c.class}"`);
    const e = c.expected;
    if (e.escalated === true && c.arbitrator_verdict === undefined)
      throw new Error(`judge-eval corpus: case [${i}] requires an explicit arbitrator_verdict; expected outcomes cannot generate replies`);
    if (!e.throws && (typeof e.final_pass !== 'boolean' || typeof e.escalated !== 'boolean'))
      throw new Error(`judge-eval corpus: case [${i}] ("${c.id}") expected must carry final_pass + escalated (or throws: true)`);
    if (e.arbitrator_must_veto && (!Array.isArray(e.veto_facets) || !e.veto_facets.length))
      throw new Error(`judge-eval corpus: case [${i}] ("${c.id}") arbitrator_must_veto requires expected.veto_facets (the specific tripped facets)`);
  });
  return raw as Corpus;
}

const corpus = loadCorpus();

function fail(caseId: string, msg: string): never {
  throw new Error(`[judge-eval:${caseId}] ${msg}`);
}

function check(caseId: string, cond: boolean, msg: string) {
  if (!cond) fail(caseId, msg);
}

// Scripted provider replies are independent of expected outcomes. An
// unexpected frontier call fails instead of synthesizing the desired answer.
function buildStub(c: CorpusCase) {
  const calls: string[] = [];
  const arbVerdict = (): JudgeVerdict => {
    if (!c.arbitrator_verdict) throw new Error(`unscripted arbitrator call: ${c.id}`);
    return c.arbitrator_verdict;
  };
  const llmCall = async (o: { model: string }) => {
    calls.push(o.model);
    if (o.model.startsWith('arb-')) {
      const text = JSON.stringify(arbVerdict());
      return { text: c.fenced_arbitrator ? `\`\`\`json\n${text}\n\`\`\`` : text, via: 'api', cost_usd: 0.01, ms: 1, model: o.model };
    }
    const idx = Number(o.model.split('-')[1]) - 1;
    const v = c.local_verdicts[idx];
    if (v === undefined) return { text: 'garbage — unscripted judge index', via: 'ollama', cost_usd: 0, ms: 1, model: o.model };
    if (typeof v === 'string') return { text: v, via: 'ollama', cost_usd: 0, ms: 1, model: o.model }; // raw garbage
    const text = JSON.stringify(v);
    return { text: c.fenced_local ? `\`\`\`json\n${text}\n\`\`\`` : text, via: 'ollama', cost_usd: 0, ms: 1, model: o.model };
  };
  return { llmCall, calls };
}

describe('judge eval corpus (runPanel contract regression gate)', () => {
  it('expected verdicts cannot change the scripted arbitrator response', async () => {
    const original = corpus.cases.find(c => c.id === 'low-confidence-confirmed-bad')!;
    const altered = { ...original, expected: { ...original.expected, final_pass: true } };
    const a = await buildStub(original).llmCall({ model: 'arb-1' });
    const b = await buildStub(altered).llmCall({ model: 'arb-1' });
    expect(a.text).toBe(b.text);
    expect(JSON.parse(a.text).scores.adherence).toBe(4);
  });

  for (const c of corpus.cases) {
    it(`${c.class === 'known_good' ? 'GOOD' : 'BAD '} ${c.id}`, async () => {
      const { llmCall, calls } = buildStub(c);
      const localJudges = c.local_verdicts.map((_, i) => `judge-${i + 1}`);
      const run = () => runPanel({
        llmCall, localJudges, frontierJudges: ['arb-1'],
        threshold: c.threshold, facets: c.facets, artifactRef: 'eval://fixture',
      });

      if (c.expected.throws) {
        let err: unknown;
        try { await run(); } catch (e) { err = e; }
        if (err === undefined) fail(c.id, `expected throw /${c.expected.matches ?? ''}/ but runPanel resolved`);
        if (c.expected.matches && !(String(err).includes(c.expected.matches)))
          fail(c.id, `threw "${String(err)}" but expected match /${c.expected.matches}/`);
        check(c.id, !calls.some(m => m.startsWith('arb-')), 'frontier was called despite total local failure');
        return;
      }

      const r = await run().catch(e => fail(c.id, `runPanel threw unexpectedly: ${String(e)}`));

      check(c.id, r.final.pass === c.expected.final_pass,
        `final.pass=${r.final.pass}, expected ${c.expected.final_pass}`);
      check(c.id, r.escalated === c.expected.escalated,
        `escalated=${r.escalated}, expected ${c.expected.escalated}`);
      if (c.expected.arbitrator_must_veto) {
        const finalHardFails = r.final.verdict.hard_fails ?? [];
        const missing = c.expected.veto_facets!.filter(f => !finalHardFails.includes(f));
        check(c.id, missing.length === 0,
          `arbitrator veto facets ${JSON.stringify(c.expected.veto_facets)} expected in final.verdict.hard_fails, missing ${JSON.stringify(missing)}, got ${JSON.stringify(finalHardFails)}`);
      }
      // Frontier spend gate: escalation must match actual arbitrator calls.
      const arbCalls = calls.filter(m => m.startsWith('arb-')).length;
      check(c.id, c.expected.escalated ? arbCalls > 0 : arbCalls === 0,
        `escalated=${c.expected.escalated} but arbitrator was called ${arbCalls} time(s)`);
      // Class-level contract pins.
      if (c.class === 'known_bad')
        check(c.id, r.final.pass === false, 'known_bad case yielded final.pass=true');
      if (c.class === 'known_good' && !c.expected.escalated)
        check(c.id, r.final.pass === true, 'known_good case failed without escalation');
    });
  }
});
