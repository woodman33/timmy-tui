// chain-views-e6p2 — typed CHAIN views + [o] cross-links. Fixtures are
// placeholder-only (privacy-d5n9): no hosts, paths, names or secrets.
import { describe, it, expect } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { ShellV2 } from '../src/tui/components/ShellV2.js';
import { typedLines, runIdOf, isTyped } from '../src/tui/chain-views.js';
import { appendReceipt } from '../src/utils/receipts.js';
import type { Receipt } from '../src/utils/receipts.js';

const rec = (subject: string, m: Record<string, unknown>): Receipt =>
  ({ v: 1, id: `rc_${subject}`, stream: 'runs', ts: '2026-01-01T00:00:00.000Z', kind: 'seal', subject, policy: 'auto', sources: [m], hash: 'sha256_0000000000000000', prev_hash: 'genesis' }) as unknown as Receipt;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(view: ReturnType<typeof render>, pred: (f: string) => boolean, ms = 15000): Promise<string> {
  const t0 = Date.now();
  let f = '';
  for (;;) {
    f = view.lastFrame() ?? '';
    if (pred(f) || Date.now() - t0 > ms) return f;
    await sleep(50);
  }
}

describe('typed views', () => {
  it('swarm.run / member / airgap render members, judge, spend, egress and the ⊘ glyph', () => {
    const run = typedLines(rec('swarm.run', { run_id: 'swarm_fix1_a', swarm_id: 'fixture-3', topology: 'council', size: '3', where: 'edge', room: 'fixture-room', usd: '0.01', ms: '900', ok: 'true', judge_tier: 'edge', policy: 'closed', task_sha256: 'abcdef0123456789' }));
    expect(run.join('\n')).toContain('⊘');
    expect(run.join('\n')).toContain('council');
    expect(run.join('\n')).toContain('judge edge');
    expect(run.join('\n')).toContain('$0.0100');
    const member = typedLines(rec('swarm.member', { run_id: 'swarm_fix1_a', member: 'seat-1', kind: 'model', phase: 'work', model: 'placeholder/one', node: 'edge', provider_used: 'Placeholder', usd: '0.002', ms: '300', ok: 'true' }));
    expect(member.join('\n')).toContain('ph work');
    expect(member.join('\n')).toContain('[o]');
    const air = typedLines(rec('swarm.airgap', { run_id: 'swarm_fix1_a', swarm_id: 'fixture-2', egress: '0', egress_tools: '', hands: 'sbx-lockdown', policy_sha256: 'sha256_abcdef012345', swarm_run: 'sha256_0123456789ab' }));
    expect(air[0].startsWith('⊘')).toBe(true);
    expect(air.join('\n')).toContain('egress 0');
  });
  it('node + privacy + hands + escrow views render their contract', () => {
    expect(typedLines(rec('node.join', { node: 'node-a', gpu: 'fixture-gpu', mem_total_gb: '128', ollama: '0.33.1', transport: 'tailscale-ssh' })).join('\n')).toContain('128G');
    expect(typedLines(rec('node.inventory', { node: 'node-a', models: 'placeholder/one,placeholder/two', mem_avail_gb: '90', serve: 'up' })).join('\n')).toContain('placeholder/one');
    const net = typedLines(rec('net.policy', { policy_sha256: 'sha256_abcdef012345', ssh_block_sha256: 'sha256_0123456789ab', fix: 'ssh action check to accept' }));
    expect(net.join('\n')).toContain('policy_sha  abcdef012345');
    expect(net.join('\n')).not.toContain('workers.dev');
    expect(net.join('\n')).not.toContain('http');
    expect(typedLines(rec('privacy.audit', { scanners: 'gitleaks + timmy', patterns_sha256: 'sha256_abcdef012345', trees: '6', history_commits: '242', history_blobs: '2604', findings: '0' })).join('\n')).toContain('gitleaks');
    expect(typedLines(rec('privacy.gate', { layers: 'pre-commit + CI', hook: 'githooks', ci: 'workflows', cites_audit: 'sha256_abcdef012345', seal_refusal: 'timmy seal' })).join('\n')).toContain('pre-commit + CI');
    expect(typedLines(rec('hands.change', { before: 'placeholder/one', after: 'placeholder/two', trigger: 'operator' })).join('\n')).toContain('one → two');
    expect(typedLines(rec('escrow.human', { refused: 'spend over cap', approver: 'operator', reason: 'ok' })).join('\n')).toContain('approved by operator');
  });
  it('runIdOf links members to their run; unknown kinds are untyped', () => {
    expect(runIdOf(rec('swarm.member', { run_id: 'swarm_fix1_a' }))).toBe('swarm_fix1_a');
    expect(runIdOf(rec('seal', { note: 'x' }))).toBeNull();
    expect(isTyped(rec('seal', { note: 'x' }))).toBe(false);
  });
  it('every typed line fits the 42-col DETAIL rail without an ellipsis', () => {
    const subjects = ['swarm.run', 'swarm.member', 'swarm.airgap', 'node.join', 'node.inventory', 'net.policy', 'privacy.audit', 'privacy.gate', 'hands.change', 'escrow.human', 'unreal.render'];
    const metas: Record<string, Record<string, unknown>> = {
      'swarm.run': { run_id: 'swarm_fixtures_01', swarm_id: 'fixture-3', topology: 'coordinator', size: '3', where: 'edge', room: 'fixture-room', usd: '0.01234', ms: '12345', ok: 'true', judge_tier: 'frontier', policy: 'tailnet', task_sha256: 'sha256_abcdef0123456789' },
      'swarm.member': { run_id: 'swarm_fixtures_01', member: 'seat-12', kind: 'harness', phase: 'compose', model: 'placeholder/long-model-name', node: 'node-b', provider_used: 'PlaceholderProvider', usd: '0.01234', ms: '12345', ok: 'true', killed: 'true' },
      'swarm.airgap': { run_id: 'swarm_fixtures_01', swarm_id: 'fixture-3', egress: '12', egress_tools: 'tool-a,tool-b', hands: 'sbx-lockdown', policy_sha256: 'sha256_abcdef012345', swarm_run: 'sha256_0123456789ab' },
      'node.join': { node: 'node-a', gpu: 'fixture-gpu-with-a-long-name', mem_total_gb: '128', ollama: '0.33.1-long', transport: 'tailscale-ssh', envlock_sha256: 'sha256_abcdef012345', fleet_entry: 'node-a' },
      'node.inventory': { node: 'node-a', transport: 'tailscale-ssh', models: 'placeholder/one,placeholder/two,placeholder/three', mem_avail_gb: '128', serve: 'serving' },
      'net.policy': { policy_sha256: 'sha256_abcdef012345', ssh_block_sha256: 'sha256_0123456789ab', fix: 'ssh action check to accept for autogroup' },
      'privacy.audit': { scanners: 'gitleaks-8.30 + timmy-pattern-set', patterns_sha256: 'sha256_abcdef012345', trees: '12', history_commits: '1234', history_blobs: '123456', findings: '12' },
      'privacy.gate': { layers: 'pre-commit + CI + seal-refusal', hook: 'githooks-pre-commit-x', ci: 'github-workflows-privacy', cites_audit: 'sha256_abcdef012345', seal_refusal: 'timmy seal' },
      'hands.change': { before: 'placeholder/long-before-model', after: 'placeholder/long-after-model', trigger: 'operator switched the mind' },
      'escrow.human': { refused: 'spend over the daily cap', approver: 'operator-x', reason: 'approved once' },
      'unreal.render': { stage: 'world/abcdefghijklmnopqr', cameras: '/Rig/1234567890', ms: '123456', ok: 'true', proof_sha256: 'sha256_abcdef0123456789' },
    };
    for (const subj of subjects) {
      for (const line of typedLines(rec(subj, metas[subj]))) {
        expect(line.length, `${subj}: ${line}`).toBeLessThanOrEqual(42);
        expect(line, `${subj}: ${line}`).not.toContain('…');
      }
    }
  });
});

describe('CHAIN cross-link [o]', { timeout: 60000 }, () => {
  it('links a swarm.run to its members and unlinks', async () => {
    // placeholder fixtures into this file's isolated store (privacy-d5n9)
    appendReceipt('runs', { kind: 'seal', subject: 'swarm.run', policy: 'auto', status: 'ok', sources: [{ run_id: 'swarm_fix1_a', swarm_id: 'fixture-3', topology: 'council', size: '2', where: 'edge', room: 'fixture-room', usd: '0.01', ms: '900', ok: 'true', judge_tier: 'edge', policy: 'closed' }] } as never);
    appendReceipt('runs', { kind: 'seal', subject: 'swarm.member', policy: 'auto', status: 'ok', sources: [{ run_id: 'swarm_fix1_a', member: 'seat-1', kind: 'model', phase: 'work', model: 'placeholder/one', node: 'edge', usd: '0.002', ms: '300', ok: 'true' }] } as never);
    appendReceipt('runs', { kind: 'seal', subject: 'swarm.airgap', policy: 'auto', status: 'ok', sources: [{ run_id: 'swarm_fix1_a', swarm_id: 'fixture-3', egress: '0', hands: 'sbx-lockdown', policy_sha256: 'sha256_abcdef012345' }] } as never);
    const view = render(React.createElement(ShellV2, { width: 120 }));
    await until(view, x => x.includes('YOUR JOURNEY') || x.includes('TIMMY'));
    view.stdin.write('3');
    await until(view, x => x.includes('RECEIPTS'));
    view.stdin.write('/');
    await sleep(150);
    view.stdin.write('swarm.run');
    await sleep(150);
    view.stdin.write('\x1b');
    await sleep(150);
    await until(view, x => x.includes('swarm.run'));
    view.stdin.write('o');
    const linked = await until(view, x => x.includes('[o] unlink'));
    expect(linked).toContain('⊗');
    view.stdin.write('o');
    const unlinked = await until(view, x => !x.includes('[o] unlink'));
    expect(unlinked).toContain('RECEIPTS');
    view.unmount();
  });
});
