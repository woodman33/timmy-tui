import { describe, it, expect } from 'vitest';
import { runParliament } from '../src/forge/judges/parliament.js';
import { newPromptVersion, diffVersions } from '../src/forge/prompt-version.js';
import type { PromptVersion } from '../src/forge/prompt-version.js';

function makePrev(): PromptVersion {
  return newPromptVersion({
    mission_id: 'm1',
    stage: 't2i',
    prompt: 'A walnut with a city on top.',
    beats: [
      { id: 'b1', t: 0, text: 'wide establishing shot' },
      { id: 'b2', t: 4, text: 'hero detail of walnut grain' },
      { id: 'b3', t: 8, text: 'city lights flicker on' },
    ],
  });
}

type LlmResult = { text: string; via: string; cost_usd: number; ms: number; model: string };
const ok = (text: unknown): LlmResult => ({ text: typeof text === 'string' ? text : JSON.stringify(text), via: 'ollama', cost_usd: 0, ms: 1, model: '' });

// Count calls per model, dispatch via handler(model, callIndex).
function spyLlm(handler: (model: string, prompt: string) => string | Error) {
  const calls: { model: string; prompt: string }[] = [];
  const llm = async (o: { model: string; system: string; prompt: string }): Promise<LlmResult> => {
    calls.push({ model: o.model, prompt: o.prompt });
    const out = handler(o.model, o.prompt);
    if (out instanceof Error) throw out;
    return { text: out, via: 'ollama', cost_usd: 0, ms: 1, model: o.model };
  };
  return { llm, calls };
}

const rewrite = (entries: Record<string, string>, critique = 'c') =>
  JSON.stringify({ rewrites: Object.entries(entries).map(([beat_id, text]) => ({ beat_id, text })), critique_of_change: critique });

const REWRITERS = ['r1', 'r2', 'r3'];
const JUDGE = 'judge';

describe('parliament', () => {
  it('unanimous: identical rewrites short-circuit after round 1 — no judge call', async () => {
    const { llm, calls } = spyLlm((model) => {
      if (model === JUDGE) throw new Error('judge must never be called');
      return rewrite({ b1: 'new wide shot', b2: 'new hero detail' }, `crit-${model}`);
    });
    const prev = makePrev();
    const r = await runParliament({
      prev, failingBeatIds: ['b1', 'b2'], critique: 'panel says weak',
      rewriters: REWRITERS, judgeModel: JUDGE, llmCall: llm,
    });
    expect(r.unanimous).toBe(true);
    expect(r.rounds).toBe(1);
    expect(r.winningRewriter).toBe('r1'); // first rewriter wins
    expect(r.winningText).toEqual({ b1: 'new wide shot', b2: 'new hero detail' });
    expect(r.losingCritiques).toEqual([]);
    expect(calls.filter(c => c.model === JUDGE).length).toBe(0);
    expect(r.receipts.length).toBe(3); // rewriters only
    // nextPromptVersion chain intact
    expect(r.version.version).toBe(prev.version + 1);
    expect(r.version.parent).toBe(prev.id);
    expect(r.version.beats.find(b => b.id === 'b1')!.text).toBe('new wide shot');
    expect(r.version.beats.find(b => b.id === 'b3')!.text).toBe('city lights flicker on'); // untouched beat carries over
    expect(r.version.critique).toBe('panel says weak');
  });

  it('disagreement: judge picks per beat; losing critiques recorded for non-winners only; judge receipt present', async () => {
    const texts: Record<string, Record<string, string>> = {
      r1: { b1: 'r1-b1', b2: 'r1-b2' },
      r2: { b1: 'r2-b1', b2: 'r2-b2' },
      r3: { b1: 'r3-b1', b2: 'r3-b2' },
    };
    const { llm, calls } = spyLlm((model) => {
      if (model === JUDGE) {
        return JSON.stringify({
          picks: [
            { beat_id: 'b1', rewriter: 'r2', reason: 'more cinematic' },
            { beat_id: 'b2', rewriter: 'r3', reason: 'better grain' },
          ],
        });
      }
      return rewrite(texts[model]!, `crit-${model}`);
    });
    const prev = makePrev();
    const r = await runParliament({
      prev, failingBeatIds: ['b1', 'b2'], critique: 'weak beats',
      rewriters: REWRITERS, judgeModel: JUDGE, llmCall: llm,
    });
    expect(r.unanimous).toBe(false);
    expect(r.rounds).toBe(1);
    expect(r.winningText).toEqual({ b1: 'r2-b1', b2: 'r3-b2' });
    // winners r2 (b1) and r3 (b2) excluded from losing list; r1 lost both
    expect(r.losingCritiques).toEqual([
      { rewriter: 'r1', beatId: 'b1', critique: 'crit-r1' },
      { rewriter: 'r3', beatId: 'b1', critique: 'crit-r3' },
      { rewriter: 'r1', beatId: 'b2', critique: 'crit-r1' },
      { rewriter: 'r2', beatId: 'b2', critique: 'crit-r2' },
    ]);
    expect(calls.filter(c => c.model === JUDGE).length).toBe(1);
    expect(r.receipts.some(x => x.model === JUDGE)).toBe(true);
    expect(r.receipts.length).toBe(4); // 3 rewriters + judge
    expect(r.version.beats.find(b => b.id === 'b1')!.text).toBe('r2-b1');
  });

  it('judge merge wins over picks when present and only touching failing beats', async () => {
    const texts: Record<string, Record<string, string>> = {
      r1: { b1: 'r1-b1' },
      r2: { b1: 'r2-b1' },
    };
    const { llm } = spyLlm((model) => {
      if (model === JUDGE) {
        return JSON.stringify({
          picks: [{ beat_id: 'b1', rewriter: 'r1', reason: 'pick r1' }],
          merged: [{ beat_id: 'b1', text: 'merged best of both', reason: 'combines strengths' }],
        });
      }
      return rewrite(texts[model]!);
    });
    const prev = makePrev();
    const r = await runParliament({
      prev, failingBeatIds: ['b1'], critique: 'x',
      rewriters: ['r1', 'r2'], judgeModel: JUDGE, llmCall: llm,
    });
    expect(r.winningText).toEqual({ b1: 'merged best of both' });
    expect(r.winningRewriter).toBe(JUDGE);
    expect(r.version.beats.find(b => b.id === 'b1')!.text).toBe('merged best of both');
  });

  it('judge merge touching a non-failing beat is ignored; falls back to pick', async () => {
    const texts: Record<string, Record<string, string>> = { r1: { b1: 'r1-b1' }, r2: { b1: 'r2-b1' } };
    const { llm } = spyLlm((model) => {
      if (model === JUDGE) {
        return JSON.stringify({
          picks: [{ beat_id: 'b1', rewriter: 'r2', reason: 'pick r2' }],
          merged: [{ beat_id: 'b3', text: 'sneaky', reason: 'out of scope' }],
        });
      }
      return rewrite(texts[model]!);
    });
    const prev = makePrev();
    const r = await runParliament({
      prev, failingBeatIds: ['b1'], critique: 'x',
      rewriters: ['r1', 'r2'], judgeModel: JUDGE, llmCall: llm,
    });
    expect(r.winningText).toEqual({ b1: 'r2-b1' });
    expect(r.version.beats.find(b => b.id === 'b3')!.text).toBe('city lights flicker on'); // untouched
  });

  it('judge unparseable → round 2 rewrites, plurality decides, NO second judge call', async () => {
    const seen = new Map<string, number>();
    const { llm, calls } = spyLlm((model) => {
      if (model === JUDGE) return 'not json at all';
      const n = seen.get(model) ?? 0;
      seen.set(model, n + 1);
      return rewrite(n === 0 ? { b1: `${model}-round1` } : { b1: model === 'r3' ? 'other' : 'plurality-wins' });
    });
    const prev = makePrev();
    const r = await runParliament({
      prev, failingBeatIds: ['b1'], critique: 'x',
      rewriters: REWRITERS, judgeModel: JUDGE, maxRounds: 2, llmCall: llm,
    });
    expect(r.rounds).toBe(2);
    expect(r.unanimous).toBe(false);
    expect(r.winningText).toEqual({ b1: 'plurality-wins' });
    expect(calls.filter(c => c.model === JUDGE).length).toBe(1);
    expect(calls.filter(c => c.model !== JUDGE).length).toBe(6); // 2 rounds × 3 rewriters
  });

  it('cost cap: maxRounds=2 bounds rewriter rounds and judge calls', async () => {
    let rewriterCalls = 0;
    let judgeCalls = 0;
    const { llm } = spyLlm((model) => {
      if (model === JUDGE) { judgeCalls++; return 'garbage'; }
      rewriterCalls++;
      return rewrite({ b1: `w${rewriterCalls}` });
    });
    const prev = makePrev();
    await runParliament({
      prev, failingBeatIds: ['b1'], critique: 'x',
      rewriters: REWRITERS, judgeModel: JUDGE, maxRounds: 2, llmCall: llm,
    });
    expect(rewriterCalls).toBeLessThanOrEqual(6); // 2 rounds × 3
    expect(judgeCalls).toBeLessThanOrEqual(1);
  });

  it('unanimous requires full coverage: all rewriters omit one failing beat → judge path → fail-closed throw (no TypeError)', async () => {
    const { llm, calls } = spyLlm((model) => {
      if (model === JUDGE) return JSON.stringify({ picks: [] }); // judge also leaves b2 unresolved
      return rewrite({ b1: 'shared b1' }); // NO rewriter covers b2
    });
    const prev = makePrev();
    await expect(runParliament({
      prev, failingBeatIds: ['b1', 'b2'], critique: 'x',
      rewriters: REWRITERS, judgeModel: JUDGE, llmCall: llm,
    })).rejects.toThrow(/no usable rewrite for beat\(s\): b2/);
    expect(calls.filter(c => c.model === JUDGE).length).toBe(1); // fell through to judge, not short-circuited
  });

  it('unanimous short-circuit still applies when every answering rewriter covers every failing beat', async () => {
    const { llm, calls } = spyLlm((model) => {
      if (model === JUDGE) throw new Error('judge must never be called');
      return rewrite({ b1: 'same b1', b2: 'same b2', b3: 'same b3' }, `crit-${model}`);
    });
    const prev = makePrev();
    const r = await runParliament({
      prev, failingBeatIds: ['b1', 'b2', 'b3'], critique: 'x',
      rewriters: REWRITERS, judgeModel: JUDGE, llmCall: llm,
    });
    expect(r.unanimous).toBe(true);
    expect(r.rounds).toBe(1);
    expect(r.winningText).toEqual({ b1: 'same b1', b2: 'same b2', b3: 'same b3' });
    expect(calls.filter(c => c.model === JUDGE).length).toBe(0);
    expect(r.receipts.length).toBe(3);
  });

  it('partial coverage (b1 identical across all, b2 covered by none) → judge path engaged; judge merge covers the gap', async () => {
    const { llm, calls } = spyLlm((model) => {
      if (model === JUDGE) {
        return JSON.stringify({
          picks: [{ beat_id: 'b1', rewriter: 'r2', reason: 'fine' }],
          merged: [{ beat_id: 'b2', text: 'judge-authored b2', reason: 'no candidates offered' }],
        });
      }
      return rewrite({ b1: 'shared b1' });
    });
    const prev = makePrev();
    const r = await runParliament({
      prev, failingBeatIds: ['b1', 'b2'], critique: 'x',
      rewriters: REWRITERS, judgeModel: JUDGE, llmCall: llm,
    });
    expect(r.unanimous).toBe(false);
    expect(calls.filter(c => c.model === JUDGE).length).toBe(1); // partial coverage → judge engaged
    expect(r.winningText).toEqual({ b1: 'shared b1', b2: 'judge-authored b2' });
    // b1 → r2 (judge pick), b2 → judge (merge): tie on win count, so the
    // cheapest-first tie-break names r2 (rank 1) over the unrated judge.
    expect(r.winningRewriter).toBe('r2');
  });

  it('rewriter with unknown beat id counts as not answering; all failing → fail-closed throw', async () => {
    const { llm, calls } = spyLlm(() => rewrite({ b9: 'ghost beat' }));
    const prev = makePrev();
    await expect(runParliament({
      prev, failingBeatIds: ['b1'], critique: 'x',
      rewriters: REWRITERS, judgeModel: JUDGE, llmCall: llm,
    })).rejects.toThrow(/no rewriter produced a usable rewrite/);
    expect(calls.filter(c => c.model === JUDGE).length).toBe(0); // never reached a judge
  });

  it('rewriter answering a strict subset still resolves: single-candidate beat wins without plurality', async () => {
    const { llm } = spyLlm((model) => {
      if (model === JUDGE) return JSON.stringify({ picks: [] }); // judge omits everything
      if (model === 'r1') return rewrite({ b1: 'r1-b1-only', b2: 'r1-b2' }, 'c1');
      if (model === 'r2') return rewrite({ b2: 'r2-b2' }, 'c2');
      return rewrite({ b2: 'r3-b2' }, 'c3');
    });
    const prev = makePrev();
    const r = await runParliament({
      prev, failingBeatIds: ['b1', 'b2'], critique: 'x',
      rewriters: ['r1', 'r2', 'r3'], judgeModel: JUDGE, llmCall: llm,
    });
    expect(r.winningText).toEqual({ b1: 'r1-b1-only', b2: 'r1-b2' }); // b1 single candidate; b2 three-way tie → first rewriter
    expect(r.winningRewriter).toBe('r1');
    expect(r.losingCritiques).toEqual([
      { rewriter: 'r2', beatId: 'b2', critique: 'c2' },
      { rewriter: 'r3', beatId: 'b2', critique: 'c3' },
    ]);
  });

  it('plurality tie → cheapest-first (first rewriter in array order)', async () => {
    const { llm } = spyLlm((model) => {
      if (model === JUDGE) return JSON.stringify({ picks: [] });
      if (model === 'r1') return rewrite({ b1: 'alpha' });
      if (model === 'r2') return rewrite({ b1: 'beta' });
      return rewrite({ b1: 'gamma' });
    });
    const prev = makePrev();
    const r = await runParliament({
      prev, failingBeatIds: ['b1'], critique: 'x',
      rewriters: ['r1', 'r2'], judgeModel: JUDGE, llmCall: llm,
    });
    expect(r.winningText).toEqual({ b1: 'alpha' });
    expect(r.winningRewriter).toBe('r1');
  });

  it('maxRounds=1 with broken judge falls back to round-1 plurality immediately', async () => {
    const { llm, calls } = spyLlm((model) => {
      if (model === JUDGE) return 'garbage';
      if (model === 'r1' || model === 'r2') return rewrite({ b1: 'tied-text' });
      return rewrite({ b1: 'loser' });
    });
    const prev = makePrev();
    const r = await runParliament({
      prev, failingBeatIds: ['b1'], critique: 'x',
      rewriters: REWRITERS, judgeModel: JUDGE, maxRounds: 1, llmCall: llm,
    });
    expect(r.rounds).toBe(1);
    expect(r.winningText).toEqual({ b1: 'tied-text' });
    expect(calls.filter(c => c.model !== JUDGE).length).toBe(3); // no round 2
  });

  it('plurality: majority text wins over first position', async () => {
    const { llm } = spyLlm((model) => {
      if (model === JUDGE) return 'garbage forever';
      if (model === 'r1') return rewrite({ b1: 'minority' });
      return rewrite({ b1: 'majority' });
    });
    const prev = makePrev();
    const r = await runParliament({
      prev, failingBeatIds: ['b1'], critique: 'x',
      rewriters: REWRITERS, judgeModel: JUDGE, llmCall: llm,
    });
    expect(r.winningText).toEqual({ b1: 'majority' });
    expect(r.rounds).toBe(2); // judge unparseable forced round 2
  });

  it('strips ```json fences from rewriter and judge output', async () => {
    const { llm } = spyLlm((model) => {
      if (model === JUDGE) return '```json\n{"picks":[{"beat_id":"b1","rewriter":"r2","reason":"x"}]}\n```';
      return `\`\`\`json\n${rewrite({ b1: model === 'r1' ? 'r1-text' : 'other' })}\n\`\`\``;
    });
    const prev = makePrev();
    const r = await runParliament({
      prev, failingBeatIds: ['b1'], critique: 'x',
      rewriters: ['r1', 'r2'], judgeModel: JUDGE, llmCall: llm,
    });
    expect(r.winningText).toEqual({ b1: 'other' }); // judge picked r2, whose rewrite text is 'other'
  });

  it('rewriter prompt carries prev prompt, failing beat text, critique, and rival existence', async () => {
    const { llm, calls } = spyLlm(() => rewrite({ b1: 'x', b2: 'y' }));
    const prev = makePrev();
    await runParliament({
      prev, failingBeatIds: ['b1', 'b2'], critique: 'the panel critique',
      rewriters: REWRITERS, judgeModel: JUDGE, llmCall: llm,
    });
    const p = calls.find(c => c.model === 'r1')!.prompt;
    expect(p).toContain('A walnut with a city on top.'); // full prev prompt
    expect(p).toContain('wide establishing shot'); // failing beat current text
    expect(p).toContain('the panel critique');
    expect(p).toContain('2 other rewriter'); // rivals exist, outputs never shared
  });

  it('throws on empty failingBeatIds and on unknown failing beat ids (fail closed)', async () => {
    const { llm } = spyLlm(() => rewrite({ b1: 'x' }));
    const prev = makePrev();
    await expect(runParliament({
      prev, failingBeatIds: [], critique: 'x', rewriters: REWRITERS, judgeModel: JUDGE, llmCall: llm,
    })).rejects.toThrow(/failingBeatIds/);
    await expect(runParliament({
      prev, failingBeatIds: ['nope'], critique: 'x', rewriters: REWRITERS, judgeModel: JUDGE, llmCall: llm,
    })).rejects.toThrow(/failingBeatIds/);
  });

  it('nextPromptVersion integration: diffVersions shows only failing beats changed', async () => {
    const { llm } = spyLlm((model) => {
      if (model === JUDGE) return JSON.stringify({ picks: [{ beat_id: 'b2', rewriter: 'r1', reason: 'x' }] });
      return rewrite({ b2: 'reworked hero detail' });
    });
    const prev = makePrev();
    const r = await runParliament({
      prev, failingBeatIds: ['b2'], critique: 'panel critique text',
      rewriters: REWRITERS, judgeModel: JUDGE, llmCall: llm,
    });
    const d = diffVersions(prev, r.version);
    expect(d.changed_beat_ids).toEqual(['b2']);
    expect(d.unchanged_beat_ids).toEqual(['b1', 'b3']);
    expect(r.version.critique).toBe('panel critique text');
    expect(r.version.version).toBe(prev.version + 1);
    expect(r.version.parent).toBe(prev.id);
  });

  it('defaults to 3 local rewriters when rewriters not provided', async () => {
    const { llm, calls } = spyLlm(() => rewrite({ b1: 'same' }));
    const prev = makePrev();
    await runParliament({
      prev, failingBeatIds: ['b1'], critique: 'x', llmCall: llm,
    });
    expect(calls.length).toBe(3); // 3 default rewriters, no judge (unanimous)
    expect(new Set(calls.map(c => c.model)).size).toBe(3);
  });

  it('throws on duplicate rewriter ids (input validation)', async () => {
    const { llm } = spyLlm(() => rewrite({ b1: 'x' }));
    await expect(runParliament({
      prev: makePrev(), failingBeatIds: ['b1'], critique: 'x',
      rewriters: ['r1', 'r1', 'r2'], judgeModel: JUDGE, llmCall: llm,
    })).rejects.toThrow(/duplicate rewriter ids/);
  });

  it('rejected (thrown) rewriter llmCall leaves NO receipt; two identical answers still resolve unanimous', async () => {
    const { llm, calls } = spyLlm((model) => {
      if (model === JUDGE) throw new Error('judge must never be called');
      if (model === 'r2') return new Error('r2 call rejected by provider');
      return rewrite({ b1: 'shared b1', b2: 'shared b2' }, `crit-${model}`);
    });
    const prev = makePrev();
    const r = await runParliament({
      prev, failingBeatIds: ['b1', 'b2'], critique: 'x',
      rewriters: REWRITERS, judgeModel: JUDGE, llmCall: llm,
    });
    expect(r.unanimous).toBe(true);
    expect(r.rounds).toBe(1);
    expect(r.winningText).toEqual({ b1: 'shared b1', b2: 'shared b2' });
    // House convention: a throwing llmCall never incurs cost → NO receipt.
    // Only the 2 fulfilled calls are receipted, before any parsing.
    expect(r.receipts.map(x => x.model).sort()).toEqual(['r1', 'r3']);
    expect(calls.length).toBe(3); // all 3 attempted
  });

  it('judge llmCall THROWS (vs returning garbage) → round-2 plurality, still at most 1 judge call', async () => {
    const seen = new Map<string, number>();
    const { llm, calls } = spyLlm((model) => {
      if (model === JUDGE) throw new Error('judge endpoint down');
      const n = seen.get(model) ?? 0;
      seen.set(model, n + 1);
      return rewrite(n === 0 ? { b1: `${model}-round1` } : { b1: model === 'r3' ? 'other' : 'plurality-wins' });
    });
    const prev = makePrev();
    const r = await runParliament({
      prev, failingBeatIds: ['b1'], critique: 'x',
      rewriters: REWRITERS, judgeModel: JUDGE, maxRounds: 2, llmCall: llm,
    });
    expect(r.rounds).toBe(2); // same round-2 path as an unparseable judge
    expect(r.unanimous).toBe(false);
    expect(r.winningText).toEqual({ b1: 'plurality-wins' });
    expect(calls.filter(c => c.model === JUDGE).length).toBe(1); // no retry of a throwing judge
    expect(calls.filter(c => c.model !== JUDGE).length).toBe(6); // 2 rounds × 3 rewriters
    expect(r.receipts.some(x => x.model === JUDGE)).toBe(false); // rejected call leaves no receipt
  });

  it('round-2 carry-forward: a rewriter that answered round 1 but throws in round 2 keeps its round-1 answer as best-available', async () => {
    const seen = new Map<string, number>();
    const { llm } = spyLlm((model) => {
      if (model === JUDGE) return 'not json at all';
      const n = seen.get(model) ?? 0;
      seen.set(model, n + 1);
      if (n === 0) return rewrite({ b1: model === 'r1' ? 'r1-round1' : 'divergent' });
      if (model === 'r1') return new Error('r1 gone in round 2');
      return rewrite({ b1: 'carried-winner' }); // r2 + r3 agree in round 2
    });
    const prev = makePrev();
    const r = await runParliament({
      prev, failingBeatIds: ['b1'], critique: 'x',
      rewriters: REWRITERS, judgeModel: JUDGE, maxRounds: 2, llmCall: llm,
    });
    expect(r.rounds).toBe(2);
    // Plurality across best-available: r1's round-1 answer counts (1 vote),
    // r2/r3's fresh round-2 answers agree (2 votes) → deterministic outcome.
    expect(r.winningText).toEqual({ b1: 'carried-winner' });
    expect(r.winningRewriter).toBe('r2'); // r2/r3 tied on wins; cheapest-first tie-break
    // r1's round-2 call threw → no receipt (rejection convention); the judge
    // was fulfilled-but-malformed → receipted. 6 receipts total.
    expect(r.receipts.map(x => x.model).sort()).toEqual(['judge', 'r1', 'r2', 'r2', 'r3', 'r3']);
  });

  it('judge pick naming a rewriter that did NOT offer that beat → plurality fallback', async () => {
    const { llm, calls } = spyLlm((model) => {
      if (model === JUDGE) {
        return JSON.stringify({
          // Crossed picks: each names the rewriter that offered the OTHER beat.
          picks: [
            { beat_id: 'b1', rewriter: 'r2', reason: 'hallucinated pick' },
            { beat_id: 'b2', rewriter: 'r1', reason: 'hallucinated pick' },
          ],
        });
      }
      if (model === 'r1') return rewrite({ b1: 'r1-b1' }, 'c1');
      return rewrite({ b2: 'r2-b2' }, 'c2');
    });
    const prev = makePrev();
    const r = await runParliament({
      prev, failingBeatIds: ['b1', 'b2'], critique: 'x',
      rewriters: ['r1', 'r2'], judgeModel: JUDGE, llmCall: llm,
    });
    expect(r.unanimous).toBe(false);
    expect(calls.filter(c => c.model === JUDGE).length).toBe(1);
    // Neither pick matches an actual candidate for that beat → per-beat
    // plurality fallback (single candidate each) keeps the real rewrites.
    expect(r.winningText).toEqual({ b1: 'r1-b1', b2: 'r2-b2' });
  });

  it('round-2 partial answers retain omitted beats and their original critiques', async () => {
    const seen = new Map<string, number>();
    const { llm, calls } = spyLlm((model) => {
      if (model === JUDGE) return 'malformed judge response';
      const round = (seen.get(model) ?? 0) + 1;
      seen.set(model, round);
      return round === 1
        ? rewrite({ b1: `${model}-old-b1`, b2: `${model}-retained-b2` }, `${model}-old-critique`)
        : rewrite({ b1: `${model}-fresh-b1` }, `${model}-fresh-critique`);
    });
    const r = await runParliament({
      prev: makePrev(), failingBeatIds: ['b1', 'b2'], critique: 'revise both',
      rewriters: ['r1', 'r2'], judgeModel: JUDGE, maxRounds: 2, llmCall: llm,
    });
    expect(r.rounds).toBe(2);
    expect(r.winningText).toEqual({ b1: 'r1-fresh-b1', b2: 'r1-retained-b2' });
    expect(r.losingCritiques).toEqual([
      { rewriter: 'r2', beatId: 'b1', critique: 'r2-fresh-critique' },
      { rewriter: 'r2', beatId: 'b2', critique: 'r2-old-critique' },
    ]);
    expect(calls).toHaveLength(5);
    expect(r.receipts).toHaveLength(5);
    expect(r.version.beats.find(b => b.id === 'b3')!.text).toBe('city lights flicker on');
  });

  it.each([NaN, Infinity, -Infinity, 1.5, 0, -1])('rejects invalid maxRounds %s before any model call', async (maxRounds) => {
    const { llm, calls } = spyLlm(() => rewrite({ b1: 'same' }));
    await expect(runParliament({
      prev: makePrev(), failingBeatIds: ['b1'], critique: 'x',
      rewriters: REWRITERS, judgeModel: JUDGE, maxRounds, llmCall: llm,
    })).rejects.toThrow(/maxRounds/);
    expect(calls).toHaveLength(0);
  });
});
