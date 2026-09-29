import { describe, it, expect } from 'vitest';
import { runPanel, extractJson, PanelDiagnosticError } from '../src/forge/judges/panel.js';
import { matchSpecialists, SPECIALISTS } from '../src/forge/judges/registry.js';

const fakeLlm = (verdict: any) => async (o: any) => ({ text: JSON.stringify(verdict), via: 'ollama', cost_usd: 0, ms: 1, model: o.model });

describe('judge panel', () => {
  it('escalates when any local judge reports a configured hard failure', async () => {
    const calls: string[] = [];
    const result = await runPanel({
      localJudges: ['first', 'second'], frontierJudges: ['arb'], threshold: 0.7,
      facets: ['quality'], artifactRef: 'fixture://artifact',
      llmCall: async ({ model }) => {
        calls.push(model);
        return { model, via: 'fixture', cost_usd: 0, ms: 0,
          text: JSON.stringify({ scores: { quality: 9 }, confidence: 0.99,
            hard_fails: model === 'first' ? [] : ['identity_mismatch'] }) };
      },
    });
    expect(calls).toEqual(['first', 'second', 'arb']);
    expect(result.escalated).toBe(true);
    expect(result.final.pass).toBe(false);
  });

  it('cannot average away a missing required facet locally or in arbitration', async () => {
    for (const confidence of [0.99, 0.1]) {
      const result = await runPanel({
        localJudges: ['local'], frontierJudges: ['arb'], threshold: 0.7,
        facets: ['a', 'b', 'c', 'required'], artifactRef: 'fixture://artifact',
        llmCall: fakeLlm({ scores: { a: 10, b: 10, c: 10 }, confidence }),
      });
      expect(result.final.pass).toBe(false);
      expect(result.escalated).toBe(confidence < 0.7);
    }
  });

  it('retains paid malformed local output and exact refusal on terminal failure', async () => {
    const refusal = 'I refuse this request.\n{"reason":"fixture"}';
    const error = await runPanel({
      localJudges: ['local'], frontierJudges: ['never-called'], threshold: 0.7,
      facets: ['quality'], artifactRef: 'fixture://artifact',
      llmCall: async ({ model }) => ({ model, via: 'fixture', cost_usd: 0.23, ms: 5, text: refusal }),
    }).catch(error => error);
    expect(error).toBeInstanceOf(PanelDiagnosticError);
    expect(error.receipts).toEqual([{ model: 'local', via: 'fixture', cost_usd: 0.23, ms: 5 }]);
    expect(error.observations).toEqual([{ requested_model: 'local', model: 'local', raw_output: refusal }]);
  });

  it('retains all fulfilled outputs and rejected-call diagnostics when frontier exhausts', async () => {
    const localRaw = '{"scores":{"quality":5},"confidence":0.1}';
    const frontierRaw = 'paid but malformed';
    const error = await runPanel({
      localJudges: ['local'], frontierJudges: ['paid', 'rejected'], threshold: 0.7,
      facets: ['quality'], artifactRef: 'fixture://artifact',
      llmCall: async ({ model }) => {
        if (model === 'rejected') throw new Error('fixture transport rejection');
        return { model, via: 'fixture', cost_usd: model === 'paid' ? 0.5 : 0, ms: 1,
          text: model === 'local' ? localRaw : frontierRaw };
      },
    }).catch(error => error);
    expect(error).toBeInstanceOf(PanelDiagnosticError);
    expect(error.receipts.map((r: any) => r.model)).toEqual(['local', 'paid']);
    expect(error.receipts.reduce((sum: number, r: any) => sum + r.cost_usd, 0)).toBe(0.5);
    expect(error.observations.filter((r: any) => r.raw_output).map((r: any) => r.raw_output)).toEqual([localRaw, frontierRaw]);
    expect(error.observations).toContainEqual({ requested_model: 'rejected', error: 'Error: fixture transport rejection' });
  });

  it('preserves a malformed frontier refusal verbatim when a later arbitrator succeeds', async () => {
    const refusal = 'I refuse.\n```json\n{"unusable":true}\n```';
    const result = await runPanel({
      localJudges: ['local'], frontierJudges: ['refused', 'accepted'], threshold: 0.7,
      facets: ['quality'], artifactRef: 'fixture://artifact',
      llmCall: async ({ model }) => ({
        model, via: 'fixture', cost_usd: model === 'local' ? 0 : 0.1, ms: 1,
        text: model === 'refused' ? refusal : JSON.stringify({
          scores: { quality: 9 }, confidence: model === 'local' ? 0.1 : 0.9,
        }),
      }),
    });
    expect(result.final.pass).toBe(true);
    expect(result.arbitrator).toBe('accepted');
    expect(result.observations).toContainEqual({ requested_model: 'refused', model: 'refused', raw_output: refusal });
    expect(result.receipts.map(r => r.model)).toEqual(['local', 'refused', 'accepted']);
  });

  it('preserves a malformed local refusal when another local judge succeeds', async () => {
    const refusal = 'REFUSED: fixture\n';
    const result = await runPanel({
      localJudges: ['refused', 'accepted'], frontierJudges: [], threshold: 0.7,
      facets: ['quality'], artifactRef: 'fixture://artifact',
      llmCall: async ({ model }) => ({
        model, via: 'fixture', cost_usd: 0, ms: 1,
        text: model === 'refused' ? refusal : '{"scores":{"quality":9},"confidence":0.9}',
      }),
    });
    expect(result.final.pass).toBe(true);
    expect(result.escalated).toBe(false);
    expect(result.observations).toContainEqual({ requested_model: 'refused', model: 'refused', raw_output: refusal });
  });

  it('passes when local judges agree above threshold — no frontier spend', async () => {
    const r = await runPanel({
      llmCall: fakeLlm({ scores: { adherence: 9, coherence: 8 }, confidence: 0.9, critique: '' }),
      localJudges: ['j1', 'j2'], frontierJudges: ['f1'], threshold: 0.7,
      facets: ['adherence', 'coherence'], artifactRef: 'stub://x',
    });
    expect(r.escalated).toBe(false);
    expect(r.final.pass).toBe(true);
  });

  it('escalates on low confidence and trips hard-fails regardless of confidence', async () => {
    const low = await runPanel({
      llmCall: fakeLlm({ scores: { adherence: 5 }, confidence: 0.4, critique: 'meh' }),
      localJudges: ['j1'], frontierJudges: ['f1'], threshold: 0.7, facets: ['adherence'], artifactRef: 'x',
    });
    expect(low.escalated).toBe(true);
    const nsfw = await runPanel({
      llmCall: fakeLlm({ scores: { adherence: 9, nsfw: 10 }, confidence: 0.99, critique: '', hard_fails: ['nsfw'] }),
      localJudges: ['j1'], frontierJudges: ['f1'], threshold: 0.7, facets: ['adherence', 'nsfw'], artifactRef: 'x',
    });
    expect(nsfw.escalated).toBe(true); // hard-fail always escalates for frontier arbitration
  });

  it('treats unparseable local judge output as "did not answer"', async () => {
    const calls: string[] = [];
    const llm = async (o: any) => {
      calls.push(o.model);
      if (o.model === 'j1') return { text: 'not json at all', via: 'ollama', cost_usd: 0, ms: 1, model: o.model };
      return { text: JSON.stringify({ scores: { adherence: 8 }, confidence: 0.9, critique: '' }), via: 'ollama', cost_usd: 0, ms: 1, model: o.model };
    };
    const r = await runPanel({
      llmCall: llm, localJudges: ['j1', 'j2'], frontierJudges: ['f1'], threshold: 0.7,
      facets: ['adherence'], artifactRef: 'x',
    });
    expect(r.escalated).toBe(false);
    expect(calls).not.toContain('f1'); // frontier never spent when a local judge parsed
  });

  it('throws when no local judge answers — refuses frontier spend', async () => {
    const calls: string[] = [];
    const llm = async (o: any) => { calls.push(o.model); return { text: 'garbage', via: 'ollama', cost_usd: 0, ms: 1, model: o.model }; };
    await expect(runPanel({
      llmCall: llm, localJudges: ['j1', 'j2'], frontierJudges: ['f1'], threshold: 0.7,
      facets: ['adherence'], artifactRef: 'x',
    })).rejects.toThrow(/no local judge answered/);
    expect(calls).not.toContain('f1'); // no frontier spend on total local failure
  });

  it('strips ```json fences before parsing', async () => {
    const fenced = async (o: any) => ({ text: '```json\n{"scores":{"adherence":9},"confidence":0.95,"critique":""}\n```', via: 'ollama', cost_usd: 0, ms: 1, model: o.model });
    const r = await runPanel({
      llmCall: fenced, localJudges: ['j1'], frontierJudges: ['f1'], threshold: 0.7,
      facets: ['adherence'], artifactRef: 'x',
    });
    expect(r.escalated).toBe(false);
    expect(r.final.pass).toBe(true);
  });

  it('rejects malformed verdict shapes (bad confidence) as "did not answer"', async () => {
    const llm = async (o: any) => ({ text: JSON.stringify({ scores: { adherence: 9 }, confidence: 7, critique: '' }), via: 'ollama', cost_usd: 0, ms: 1, model: o.model });
    await expect(runPanel({
      llmCall: llm, localJudges: ['j1'], frontierJudges: ['f1'], threshold: 0.7,
      facets: ['adherence'], artifactRef: 'x',
    })).rejects.toThrow(/no local judge answered/);
  });

  it('tries the next frontier arbitrator when one fails to answer', async () => {
    const calls: string[] = [];
    const llm = async (o: any) => {
      calls.push(o.model);
      if (o.model === 'f1') return { text: 'broken', via: 'api', cost_usd: 0.01, ms: 1, model: o.model };
      if (o.model === 'f2') return { text: JSON.stringify({ scores: { adherence: 9 }, confidence: 0.9, critique: '' }), via: 'api', cost_usd: 0.01, ms: 1, model: o.model };
      return { text: JSON.stringify({ scores: { adherence: 5 }, confidence: 0.2, critique: '' }), via: 'ollama', cost_usd: 0, ms: 1, model: o.model };
    };
    const r = await runPanel({
      llmCall: llm, localJudges: ['j1'], frontierJudges: ['f1', 'f2'], threshold: 0.7,
      facets: ['adherence'], artifactRef: 'x',
    });
    expect(r.escalated).toBe(true);
    expect(r.arbitrator).toBe('f2');
    expect(r.final.pass).toBe(true);
  });

  it('throws when all frontier arbitrators fail', async () => {
    const llm = async (o: any) => ({ text: o.model.startsWith('f') ? 'broken' : JSON.stringify({ scores: { adherence: 5 }, confidence: 0.2, critique: '' }), via: 'ollama', cost_usd: 0, ms: 1, model: o.model });
    await expect(runPanel({
      llmCall: llm, localJudges: ['j1'], frontierJudges: ['f1', 'f2'], threshold: 0.7,
      facets: ['adherence'], artifactRef: 'x',
    })).rejects.toThrow(/frontier escalation failed/);
  });

  it('throws on empty facets', async () => {
    await expect(runPanel({
      llmCall: fakeLlm({ scores: {}, confidence: 0.9, critique: '' }),
      localJudges: ['j1'], frontierJudges: ['f1'], threshold: 0.7,
      facets: [], artifactRef: 'x',
    })).rejects.toThrow(/facets required/);
  });

  it('treats confidence exactly at threshold as passing — no escalation', async () => {
    const calls: string[] = [];
    const llm = async (o: any) => {
      calls.push(o.model);
      return { text: JSON.stringify({ scores: { adherence: 5 }, confidence: 0.7, critique: '' }), via: 'ollama', cost_usd: 0, ms: 1, model: o.model };
    };
    const r = await runPanel({
      llmCall: llm, localJudges: ['j1'], frontierJudges: ['f1'], threshold: 0.7,
      facets: ['adherence'], artifactRef: 'x',
    });
    expect(r.escalated).toBe(false); // boundary is inclusive: >= threshold passes
    expect(calls).not.toContain('f1');
  });

  it('resolves when one local judge rejects and another answers', async () => {
    const llm = async (o: any) => {
      if (o.model === 'j1') throw new Error('ollama connection refused');
      return { text: JSON.stringify({ scores: { adherence: 8 }, confidence: 0.9, critique: '' }), via: 'ollama', cost_usd: 0, ms: 1, model: o.model };
    };
    const r = await runPanel({
      llmCall: llm, localJudges: ['j1', 'j2'], frontierJudges: ['f1'], threshold: 0.7,
      facets: ['adherence'], artifactRef: 'x',
    });
    expect(r.escalated).toBe(false);
    expect(r.final.pass).toBe(true);
  });

  it('rejects NaN and Infinity confidence as "did not answer"', async () => {
    // 1e999 parses to Infinity via JSON.parse
    const inf = await runPanel({
      llmCall: async (o: any) => ({ text: '{"scores":{"adherence":9},"confidence":1e999,"critique":""}', via: 'ollama', cost_usd: 0, ms: 1, model: o.model }),
      localJudges: ['j1'], frontierJudges: ['f1'], threshold: 0.7, facets: ['adherence'], artifactRef: 'x',
    }).then(() => 'resolved', (e) => String(e));
    expect(inf).toMatch(/no local judge answered/);
    const nan = await runPanel({
      llmCall: async (o: any) => ({ text: '{"scores":{"adherence":9},"confidence":NaN,"critique":""}', via: 'ollama', cost_usd: 0, ms: 1, model: o.model }),
      localJudges: ['j1'], frontierJudges: ['f1'], threshold: 0.7, facets: ['adherence'], artifactRef: 'x',
    }).then(() => 'resolved', (e) => String(e));
    expect(nan).toMatch(/no local judge answered/);
  });

  it('ignores extra score keys; missing facet scores count as 0 (fail-closed)', async () => {
    const extra = await runPanel({
      llmCall: fakeLlm({ scores: { adherence: 9, unrelated_key: 0 }, confidence: 0.9, critique: '' }),
      localJudges: ['j1'], frontierJudges: ['f1'], threshold: 0.7, facets: ['adherence'], artifactRef: 'x',
    });
    expect(extra.final.pass).toBe(true); // only facet keys feed the average
    const missing = await runPanel({
      llmCall: fakeLlm({ scores: { adherence: 9 }, confidence: 0.9, critique: '' }),
      localJudges: ['j1'], frontierJudges: ['f1'], threshold: 0.7, facets: ['adherence', 'coherence'], artifactRef: 'x',
    });
    expect(missing.final.pass).toBe(false); // (9 + 0) / 2 = 4.5 < 7
  });

  it('out-of-range scores are treated as malformed — no silent pass', async () => {
    await expect(runPanel({
      llmCall: fakeLlm({ scores: { adherence: 11 }, confidence: 0.9, critique: '' }),
      localJudges: ['j1'], frontierJudges: ['f1'], threshold: 0.7, facets: ['adherence'], artifactRef: 'x',
    })).rejects.toThrow(/no local judge answered/);
    await expect(runPanel({
      llmCall: fakeLlm({ scores: {}, confidence: 0.9, critique: '' }),
      localJudges: ['j1'], frontierJudges: ['f1'], threshold: 0.7, facets: ['adherence'], artifactRef: 'x',
    })).rejects.toThrow(/no local judge answered/);
  });

  it('receipts a paid-but-malformed arbitrator call before moving on', async () => {
    const llm = async (o: any) => {
      if (o.model === 'f1') return { text: JSON.stringify({ scores: { adherence: 12 }, confidence: 0.9, critique: '' }), via: 'api', cost_usd: 0.01, ms: 1, model: o.model };
      if (o.model === 'f2') return { text: JSON.stringify({ scores: { adherence: 9 }, confidence: 0.9, critique: '' }), via: 'api', cost_usd: 0.02, ms: 1, model: o.model };
      return { text: JSON.stringify({ scores: { adherence: 5 }, confidence: 0.2, critique: '' }), via: 'ollama', cost_usd: 0, ms: 1, model: o.model };
    };
    const r = await runPanel({
      llmCall: llm, localJudges: ['j1'], frontierJudges: ['f1', 'f2'], threshold: 0.7,
      facets: ['adherence'], artifactRef: 'x',
    });
    expect(r.arbitrator).toBe('f2');
    const f1 = r.receipts.find(x => x.model === 'f1');
    expect(f1).toBeDefined(); // the spent-but-malformed call left a receipt
    expect(f1!.cost_usd).toBe(0.01);
  });

  it('arbitrator hard_fails veto final.pass even when the average clears the bar', async () => {
    const r = await runPanel({
      llmCall: fakeLlm({ scores: { adherence: 9 }, confidence: 0.9, critique: '', hard_fails: ['nsfw'] }),
      localJudges: ['j1'], frontierJudges: ['f1'], threshold: 0.7, facets: ['adherence'], artifactRef: 'x',
    });
    expect(r.escalated).toBe(true);
    expect(r.final.pass).toBe(false); // avg 9 >= 7 but hard-fail vetoes
  });
});

describe('extractJson', () => {
  it('unwraps fenced JSON', () => {
    expect(extractJson('```json\n{"scores":{"a":9},"confidence":0.9}\n```')).toEqual({ scores: { a: 9 }, confidence: 0.9 });
  });

  it('keeps the outermost envelope across nesting', () => {
    expect(extractJson('noise {"outer":{"inner":{"deep":1}},"x":[1,2]} trailing')).toEqual({ outer: { inner: { deep: 1 } }, x: [1, 2] });
  });

  it('returns null for garbage and for two sibling objects', () => {
    expect(extractJson('not json at all')).toBeNull();
    expect(extractJson('{"a":1} {"b":2}')).toBeNull(); // unparseable outermost span
  });
});

describe('specialist registry', () => {
  it('seeds non-empty specialist entries', () => {
    expect(SPECIALISTS.length).toBeGreaterThan(0);
    for (const s of SPECIALISTS) {
      expect(s.id).toBeTruthy();
      expect(s.trigger_hints.length).toBeGreaterThan(0);
      expect(s.facets.length).toBeGreaterThan(0);
      expect(s.system_prompt_file).toMatch(/^judges\//);
    }
  });

  it('matchSpecialists matches trigger hints case-insensitively by substring', () => {
    const m = matchSpecialists(['Subject is missing from the frame']);
    expect(m.some(s => s.id === 'subject-presence')).toBe(true);
    const multi = matchSpecialists(['GARBLED text with typos']);
    expect(multi.some(s => s.id === 'text-integrity')).toBe(true);
    expect(matchSpecialists(['nothing relevant here'])).toEqual([]);
  });

  it('matchSpecialists dedupes across multiple hints for the same specialist', () => {
    const m = matchSpecialists(['face drift', 'identity mismatch']);
    const ids = m.map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter(i => i === 'identity-lock').length).toBeLessThanOrEqual(1);
  });
});
