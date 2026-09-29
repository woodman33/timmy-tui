// B1 cross-seam regression: ONE canonical plan-hash shape binds operator
// approval tokens across both mint surfaces — the MCP-advertised forgeRun plan
// (timmy_forge_run → `timmy approve <planHash>`) and the gen.ts dispatch gate
// (`timmy gen --approval <token>`, hfSlotPlanHash). Before the plan-hash seam
// module, forgeRun hashed {tool, mission_id, prompt_hash, beats, stage,
// provider, endpoint, max_spend} while gen.ts hashed {slot_id, prompt_hash,
// endpoint, max_spend}, so a token minted via the MCP flow failed
// consumeApproval in gen.ts with 'approval bound to a different plan hash'.
//
// Equivalence contract pinned here: mission_id === slot_id, same prompt (the
// gen.ts side has no beats; a no-beats forgeRun brief shares the same V2
// prompt identity on both sides), same endpoint, same max_spend → the SAME 32-hex plan hash,
// minted on one seam and consumed on the other.
import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forgeRunPlanOf, forgeRunPlanHash } from '../src/forge/mcp-tools.js';
import { hfSlotPlanHash } from '../src/forge/gen.js';
import { higgsfieldPlanHash, promptHashOf } from '../src/forge/plan-hash.js';
import { issueApproval, consumeApproval, planHashOf } from '../src/utils/approvals.js';

describe('canonical higgsfield plan-hash seam', () => {
  it('forgeRun plan shape is exactly the canonical four fields', () => {
    const brief = {
      mission_id: 'mission-seam', prompt: 'a keeper who trusts receipts',
      beats: [{ id: 'hook1', t: 0 }, { id: 'turn', t: 2 }],
      stage: 't2i' as const, provider: 'higgsfield' as const, max_spend_usd: 0.5,
    };
    expect(Object.keys(forgeRunPlanOf(brief)).sort()).toEqual(['endpoint', 'max_spend', 'mission_id', 'prompt_hash']);
    expect(forgeRunPlanOf(brief)).toEqual({
      mission_id: 'mission-seam',
      prompt_hash: promptHashOf(brief.prompt, brief.beats),
      endpoint: 'dop-turbo',
      max_spend: 0.5,
    });
  });

  it('forgeRunPlanHash(brief) === planHashOf(forgeRunPlanOf(brief)) — one shape, two call sites', () => {
    const brief = {
      mission_id: 'm', prompt: 'p', beats: [{ id: 'b1', t: 1 }],
      stage: 'i2v' as const, provider: 'higgsfield-stub' as const, max_spend_usd: 1,
    };
    expect(forgeRunPlanHash(brief)).toBe(planHashOf(forgeRunPlanOf(brief)));
  });

  it('beats are prompt identity: same prompt, different beats → different prompt_hash', () => {
    const p1 = promptHashOf('prompt', [{ id: 'a', t: 0 }]);
    const p2 = promptHashOf('prompt', [{ id: 'a', t: 0 }, { id: 'b', t: 2 }]);
    const p3 = promptHashOf('prompt', [{ id: 'b', t: 2 }, { id: 'a', t: 0 }]); // reordered, same timeline
    expect(p1).not.toBe(p2);
    expect(p2).toBe(p3); // canonical sort: beat order in the brief is not identity
  });

  it('absent and empty beats share the V2 prompt identity', () => {
    expect(promptHashOf('same prompt')).toBe(promptHashOf('same prompt', []));
    expect(promptHashOf('same prompt')).toBe(promptHashOf('same prompt', undefined));
  });

  it('MCP-minted token consumes at the gen.ts dispatch seam (the B1 regression)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-plan-hash-'));
    const prevCwd = process.cwd();
    process.chdir(dir); // approvals store is cwd-based
    try {
      const missionId = 'mission-seam';
      const prompt = 'a rotating product on a marble plinth';
      const maxSpend = 0.5;
      // Mint via the MCP-advertised path: the operator runs `timmy approve`
      // on the forgeRun plan hash…
      const brief = {
        mission_id: missionId, prompt,
        stage: 't2i' as const, provider: 'higgsfield' as const, max_spend_usd: maxSpend,
      };
      const mintedHash = forgeRunPlanHash(brief);
      const token = issueApproval(mintedHash).token;
      // …and the gen.ts dispatch gate recomputes hfSlotPlanHash for the
      // equivalent slot (mission_id === slot_id, same prompt, no beats on the
      // gen side — promptHashOf(prompt) covers both).
      const slot = { slot_id: missionId, class: 'hero' as const, required: true, prompt, provider_pref: 'higgsfield' };
      const consumeHash = hfSlotPlanHash(slot, maxSpend);
      expect(consumeHash).toBe(mintedHash);
      expect(consumeApproval(token, consumeHash).ok).toBe(true);
    } finally {
      process.chdir(prevCwd);
    }
  });

  it('different max_spend → different hash (spend bound is part of the plan)', () => {
    const base = { mission_id: 'm', prompt_hash: promptHashOf('p'), endpoint: 'dop-turbo' };
    expect(higgsfieldPlanHash({ ...base, max_spend: 0.5 })).not.toBe(higgsfieldPlanHash({ ...base, max_spend: 0.75 }));
  });

  it('different prompt → different hash', () => {
    const h = (prompt: string) => higgsfieldPlanHash({ mission_id: 'm', prompt_hash: promptHashOf(prompt), endpoint: 'dop-turbo', max_spend: 1 });
    expect(h('a cat')).not.toBe(h('a dog'));
  });
});


describe('V2 approval identity admission', () => {
  it('separates plain prompts from encoded beat-bearing payloads', () => {
    const beats = [{ id: 'a', t: 0 }];
    expect(promptHashOf('p', beats)).not.toBe(promptHashOf(JSON.stringify({ prompt: 'p', beats })));
    expect(promptHashOf('p', beats)).not.toBe(promptHashOf(JSON.stringify({ schema: 'timmy-hf-prompt/v2', prompt: 'p', beats })));
  });

  it('canonicalizes beat property order and timeline permutation', () => {
    expect(promptHashOf('p', [{ id: 'a', t: 0 }, { id: 'b', t: 1 }]))
      .toBe(promptHashOf('p', [{ t: 1, id: 'b' }, { t: 0, id: 'a' }]));
  });

  it.each([
    null, {}, new Array(1), [{ id: 'a' }], [{ id: 'a', t: 0, evidence: 'unsupported' }],
    [{ id: 'a', t: NaN }], [{ id: 'a', t: Infinity }], [{ id: 'a', t: -1 }],
    [{ id: 'a', t: 0 }, { id: 'a', t: 1 }], [{ id: 'a', t: 0 }, { id: 'b', t: 0 }],
  ])('refuses malformed or ambiguous beats (%j)', (beats) => {
    expect(() => promptHashOf('p', beats as never)).toThrow(/beat/);
  });

  it.each([NaN, Infinity, -Infinity, -1, null, '1'])('refuses invalid cap %j', (max_spend) => {
    expect(() => higgsfieldPlanHash({ mission_id: 'm', prompt_hash: promptHashOf('p'), endpoint: 'dop-turbo', max_spend: max_spend as never }))
      .toThrow(/finite and nonnegative/);
  });

  it('requires fresh approval for a legacy prompt hash with no fallback', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-plan-v2-'));
    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      const base = { mission_id: 'm', endpoint: 'dop-turbo', max_spend: 0.5 };
      const legacy = planHashOf({ ...base, prompt_hash: 'sha256_' + createHash('sha256').update('p').digest('hex') });
      const current = higgsfieldPlanHash({ ...base, prompt_hash: promptHashOf('p') });
      const token = issueApproval(legacy).token;
      expect(consumeApproval(token, current)).toEqual({ ok: false, note: 'approval bound to a different plan hash' });
      expect(current).not.toBe(legacy);
    } finally { process.chdir(prevCwd); }
  });
});
