// FORGE higgsfield dispatch tests (Task 5): the provider follows the comfy
// dispatch shape, but spend authority is the operator-token pattern
// (consumeApproval bound to a plan hash) + a max_spend bound — NOT the
// --allow-spend flag. All chain writes go to a tmp dir; the approval store is
// cwd-based, so tests chdir into the tmp dir and restore in finally.
import { describe, it, expect } from 'vitest';
import { inspect } from 'node:util';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGen, hfSlotPlanHash, sha256 } from '../src/forge/gen.js';
import { issueApproval } from '../src/utils/approvals.js';
import { readChain, formatCostUsd } from '../src/utils/receipts.js';
import { promptHashOf } from '../src/forge/plan-hash.js';
import { _setHfV2LoaderForTests } from '../src/forge/higgsfield/client.js';

function sheet(dir: string, provider: string) {
  const p = join(dir, 'sheet.json');
  writeFileSync(p, JSON.stringify({
    sheet_id: 'sheet-hf', budget_cap_usd: 1, aspect: '16:9',
    slots: [
      { slot_id: 'slot-a', class: 'hero', required: true, prompt: 'a rotating product', provider_pref: provider },
    ],
  }));
  return p;
}

describe('higgsfield dispatch', () => {
  it('stub provider runs at $0 and seals receipts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-dispatch-'));
    const prevForge = process.env.TIMMY_FORGE;
    process.env.TIMMY_FORGE = '1';
    try {
      const lines = await runGen({ sheet: sheet(dir, 'higgsfield-stub'), dir });
      expect(lines.length).toBe(1);
      expect(lines[0].cost).toBe(0);
      expect(lines[0].local).toBe(true); // stub path consults no API key (D2)
      expect(existsSync(lines[0].artifact)).toBe(true);
      const res = readChain('runs', dir).find(r => r.kind === 'gen.result');
      expect(res?.via).toBe('higgsfield-stub');
      expect(res?.cost_usd).toBe(0);
      expect(res?.cost_measured).toBe(true);
      expect(lines[0].cost_measured).toBe(true);
      expect(res?.prompt_hash).toBe(promptHashOf('a rotating product'));
      expect(res).toHaveProperty('request_id', expect.any(String));
    } finally {
      if (prevForge === undefined) delete process.env.TIMMY_FORGE; else process.env.TIMMY_FORGE = prevForge;
    }
  });

  it('live provider without approval token is denied', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-dispatch-'));
    const prevCwd = process.cwd();
    const prevForge = process.env.TIMMY_FORGE;
    const prevCreds = process.env.HF_CREDENTIALS;
    process.env.TIMMY_FORGE = '1';
    process.env.HF_CREDENTIALS = 'kid:ksec';
    process.chdir(dir); // approvals store is cwd-based — keep it out of the repo
    try {
      await expect(runGen({ sheet: sheet(dir, 'higgsfield'), dir }))
        .rejects.toThrow(/approval/);
    } finally {
      process.chdir(prevCwd);
      if (prevForge === undefined) delete process.env.TIMMY_FORGE; else process.env.TIMMY_FORGE = prevForge;
      if (prevCreds === undefined) delete process.env.HF_CREDENTIALS; else process.env.HF_CREDENTIALS = prevCreds;
    }
  });

  it('live provider with token + max_spend spends and records declared-unknown cost', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-dispatch-'));
    const prevCwd = process.cwd();
    const prevForge = process.env.TIMMY_FORGE;
    const prevCreds = process.env.HF_CREDENTIALS;
    process.env.TIMMY_FORGE = '1';
    process.env.HF_CREDENTIALS = 'kid:ksec';
    process.chdir(dir);
    _setHfV2LoaderForTests(() => ({
      config: () => undefined,
      higgsfield: {
        subscribe: async () => ({ status: 'completed', request_id: 'req-live-1', video: { url: 'https://cdn.example/clip.mp4' } }),
      },
    }));
    try {
      const slot = { slot_id: 'slot-a', class: 'hero' as const, required: true, prompt: 'a rotating product', provider_pref: 'higgsfield' };
      const token = issueApproval(hfSlotPlanHash(slot, 0.5)).token;
      const lines = await runGen({ sheet: sheet(dir, 'higgsfield'), dir, approval: token, maxSpend: 0.5 });
      expect(lines.length).toBe(1);
      expect(lines[0].local).toBe(false); // live path consults HF_CREDENTIALS (D2)
      expect(existsSync(lines[0].artifact)).toBe(true);
      const res = readChain('runs', dir).find(r => r.kind === 'gen.result');
      expect(res?.via).toBe('higgsfield');
      // cost_measured:false → declared-unknown, recorded as $0 never measured $0
      expect(res?.cost_usd).toBe(0);
      expect(res?.cost_measured).toBe(false);
      expect(lines[0].cost_measured).toBe(false);
      expect(formatCostUsd({ cost_usd: lines[0].cost, cost_measured: lines[0].cost_measured }, 2)).toBe('cost unknown');
      expect(res?.prompt_hash).toBe(promptHashOf('a rotating product'));
      expect(res).toHaveProperty('request_id', 'req-live-1');
    } finally {
      _setHfV2LoaderForTests(undefined);
      process.chdir(prevCwd);
      if (prevForge === undefined) delete process.env.TIMMY_FORGE; else process.env.TIMMY_FORGE = prevForge;
      if (prevCreds === undefined) delete process.env.HF_CREDENTIALS; else process.env.HF_CREDENTIALS = prevCreds;
    }
  });

  // Gate security contract (code-review findings on 9e179c2): the four
  // headline properties of the operator-token spend gate, pinned as tests.
  const SLOT = { slot_id: 'slot-a', class: 'hero' as const, required: true, prompt: 'a rotating product', provider_pref: 'higgsfield' };

  const okLoader = () => ({
    config: () => undefined,
    higgsfield: {
      subscribe: async () => ({ status: 'completed', request_id: 'req-live-1', video: { url: 'https://cdn.example/clip.mp4' } }),
    },
  });

  // Live-path harness: forge env + creds + cwd into tmp dir (approval store
  // is cwd-based); always restores env/cwd and the real v2 loader.
  async function inLiveEnv(dir: string, fn: () => Promise<void>): Promise<void> {
    const prevCwd = process.cwd();
    const prevForge = process.env.TIMMY_FORGE;
    const prevCreds = process.env.HF_CREDENTIALS;
    process.env.TIMMY_FORGE = '1';
    process.env.HF_CREDENTIALS = 'kid:ksec';
    process.chdir(dir);
    try { await fn(); }
    finally {
      _setHfV2LoaderForTests(undefined);
      process.chdir(prevCwd);
      if (prevForge === undefined) delete process.env.TIMMY_FORGE; else process.env.TIMMY_FORGE = prevForge;
      if (prevCreds === undefined) delete process.env.HF_CREDENTIALS; else process.env.HF_CREDENTIALS = prevCreds;
    }
  }

  it('token replay: a used token is denied on the second live run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-dispatch-'));
    await inLiveEnv(dir, async () => {
      _setHfV2LoaderForTests(okLoader);
      const token = issueApproval(hfSlotPlanHash(SLOT, 0.5)).token;
      const first = await runGen({ sheet: sheet(dir, 'higgsfield'), dir, approval: token, maxSpend: 0.5 });
      expect(first.length).toBe(1); // first spend consumes the single-use token
      await expect(runGen({ sheet: sheet(dir, 'higgsfield'), dir, approval: token, maxSpend: 0.5 }))
        .rejects.toThrow(/single-use|replay/);
    });
  });

  it('plan binding: a token minted for a different spend bound is denied', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-dispatch-'));
    await inLiveEnv(dir, async () => {
      _setHfV2LoaderForTests(okLoader); // would pass the gate if it were reached
      const token = issueApproval(hfSlotPlanHash(SLOT, 0.5)).token; // minted at $0.50…
      await expect(runGen({ sheet: sheet(dir, 'higgsfield'), dir, approval: token, maxSpend: 0.75 })) // …run at $0.75
        .rejects.toThrow(/different plan hash/);
    });
  });

  it('expiry: a token minted with a past TTL is denied', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-dispatch-'));
    await inLiveEnv(dir, async () => {
      _setHfV2LoaderForTests(okLoader);
      const token = issueApproval(hfSlotPlanHash(SLOT, 0.5), -1000).token; // already expired
      await expect(runGen({ sheet: sheet(dir, 'higgsfield'), dir, approval: token, maxSpend: 0.5 }))
        .rejects.toThrow(/approval expired/);
    });
  });

  it('spend policy: valid token without a max_spend bound is denied', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-dispatch-'));
    await inLiveEnv(dir, async () => {
      _setHfV2LoaderForTests(okLoader);
      // Token binds the no-spend-bound plan hash (max_spend 0); the gate
      // passes, then the spend-policy check rejects before any dispatch.
      const token = issueApproval(hfSlotPlanHash(SLOT, undefined)).token;
      await expect(runGen({ sheet: sheet(dir, 'higgsfield'), dir, approval: token }))
        .rejects.toThrow(/spend_policy/);
    });
  });

  it('live dispatch failure seals a failed receipt with spend_status + request_id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-dispatch-'));
    await inLiveEnv(dir, async () => {
      _setHfV2LoaderForTests(() => ({
        config: () => undefined,
        higgsfield: {
          // Accepted server-side then died: the enriched reconcileError must
          // carry request_id → spend unknown → receipt must land on the chain.
          subscribe: async () => { throw Object.assign(new Error('provider boom'), { request_id: 'req-fail-1' }); },
        },
      }));
      const token = issueApproval(hfSlotPlanHash(SLOT, 0.5)).token;
      await expect(runGen({ sheet: sheet(dir, 'higgsfield'), dir, approval: token, maxSpend: 0.5 }))
        .rejects.toThrow(/higgsfield request failed/);
      const res = readChain('runs', dir).find(r => r.kind === 'gen.result' && r.status === 'failed');
      expect(res).toBeDefined();
      expect(res).toMatchObject({
        via: 'higgsfield', request_id: 'req-fail-1', spend_status: 'unknown',
        cost_usd: 0, cost_measured: false, model_resolved: 'higgsfield/dop-turbo',
      });
    });
  });

  it.each([
    { status: 'failed', url: 'https://cdn.example/failed.mp4', receipt: 'failed', artifact: 'present' },
    { status: 'nsfw', url: 'https://cdn.example/refused.mp4', receipt: 'denied', artifact: 'present' },
    { status: 'completed', url: undefined, receipt: 'failed', artifact: 'missing' },
    { status: 'completed', url: '', receipt: 'failed', artifact: 'missing' },
    { status: 'completed', url: 'not-a-url', receipt: 'failed', artifact: 'invalid' },
    { status: 'completed', url: 'file:///tmp/private.mp4', receipt: 'failed', artifact: 'invalid' },
    { status: 'completed', url: 'https://user:password@example.com/clip.mp4', receipt: 'failed', artifact: 'invalid' },
  ])('retains $status / $artifact without a successful artifact receipt', async ({ status, url, receipt, artifact }) => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-outcome-'));
    await inLiveEnv(dir, async () => {
      _setHfV2LoaderForTests(() => ({
        config: () => undefined,
        higgsfield: { subscribe: async () => ({
          status, request_id: 'req-terminal-outcome',
          ...(url !== undefined ? { video: { url } } : {}),
        }) },
      }));
      const token = issueApproval(hfSlotPlanHash(SLOT, 0.5)).token;
      await expect(runGen({ sheet: sheet(dir, 'higgsfield'), dir, approval: token, maxSpend: 0.5 }))
        .rejects.toThrow('higgsfield outcome rejected');
      const results = readChain('runs', dir).filter(r => r.kind === 'gen.result');
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        status: receipt, provider_status: status, artifact_status: artifact,
        request_id: 'req-terminal-outcome', spend_status: 'unknown',
        cost_measured: false, artifacts: [], error_class: 'provider_outcome',
      });
      expect(results.some(r => r.status === 'ok')).toBe(false);
      expect(existsSync(join(dir, '.timmy', 'forge', 'slot-a.bin'))).toBe(false);
    });
  });


  it('keeps credentials out of terminal failure identities and rendered receipts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-outcome-redaction-'));
    await inLiveEnv(dir, async () => {
      const fakeSecret = 'ksec'; // inLiveEnv installs only this synthetic credential.
      _setHfV2LoaderForTests(() => ({
        config: () => undefined,
        higgsfield: { subscribe: async () => ({ status: 'failed', request_id: `req-${fakeSecret}` }) },
      }));
      const token = issueApproval(hfSlotPlanHash(SLOT, 0.5)).token;
      let failure: unknown;
      try { await runGen({ sheet: sheet(dir, 'higgsfield'), dir, approval: token, maxSpend: 0.5 }); }
      catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect(inspect(failure, { depth: 10 })).not.toContain(fakeSecret);
      const result = readChain('runs', dir).find(r => r.kind === 'gen.result');
      expect(result).toMatchObject({ status: 'failed', request_id: 'req-[redacted]', spend_status: 'unknown' });
      expect(JSON.stringify(result)).not.toContain(fakeSecret);
    });
  });

});
