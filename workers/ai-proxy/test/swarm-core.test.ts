import { describe, expect, it } from 'vitest';
import {
  type Abilities, type CallOpts, type ChatMessage, type MemberCall, type SwarmMember, type SwarmSpec,
  Governor, candidatesBlock, firstJson, memberReceiptData, parseSwarmSpec, roleFor, runSwarm, swarmReceiptData
} from '../src/swarm-core.js';
import { verifyEdgeChain, appendEdgeReceipt, type EdgeReceipt } from '../src/chain.js';

const m = (id: string, model = `m/${id}`): Record<string, unknown> => ({ id, kind: 'model', model });
const spec = (over: Record<string, unknown>): SwarmSpec => parseSwarmSpec({ v: 1, id: 't', topology: 'fanout', members: [m('a'), m('b')], budget: { usd: 1 }, judge: { tier: 'edge', model: 'j/udge' }, network: { policy: 'open' }, ...over });

/** A scripted executor: `answers[member]` may be a string, an array (one per call), or a function of (messages, opts). */
function fake(answers: Record<string, string | string[] | ((msgs: ChatMessage[], o: CallOpts) => string) | { error: string }>, cost = 0.001) {
  const seen: { member: string; phase: string; round?: number; msgs: ChatMessage[] }[] = [];
  const counts: Record<string, number> = {};
  const call = async (member: SwarmMember, msgs: ChatMessage[], o: CallOpts): Promise<MemberCall> => {
    seen.push({ member: member.id, phase: o.phase, round: o.round, msgs });
    const a = answers[member.id];
    const n = (counts[member.id] = (counts[member.id] ?? 0) + 1);
    const base = { role: 'actor' as const, model: member.model ?? member.id, ms: 1, tokens_in: 1, tokens_out: 1, counted: true, provider_used: 'p', model_used: member.model ?? null, generation_id: `gen-${member.id}-${n}`, tokens_cached: 0, tokens_reasoning: 0, member: member.id, kind: member.kind, receipt: null };
    if (a && typeof a === 'object' && !Array.isArray(a) && 'error' in a) return { ...base, ok: false, usd: 0, content: '', content_sha256: null, error: a.error };
    const content = typeof a === 'function' ? a(msgs, o) : Array.isArray(a) ? a[Math.min(n - 1, a.length - 1)] : a ?? `answer from ${member.id}`;
    return { ...base, ok: true, usd: cost, content, content_sha256: 'x'.repeat(64), error: null };
  };
  const judge = (msgs: ChatMessage[], o: CallOpts) => call({ id: 'judge', kind: 'model', node: 'edge', sandbox: 'none', weight: 1, model: 'j/udge' }, msgs, o);
  return { exec: call, judge, seen };
}

describe('swarm spec (the CUE mirror)', () => {
  it('accepts a valid spec and fills defaults', () => {
    const s = spec({});
    expect(s.size).toBe(2);
    expect(s.budget).toEqual({ usd: 1, max_calls: 64, max_ms: 600000 });
    expect(s.rounds).toBe(2);
    expect(s.members[0]).toMatchObject({ id: 'a', kind: 'model', node: 'edge', sandbox: 'none', weight: 1, provider: 'openrouter' });
  });

  it('refuses what the schema refuses', () => {
    expect(() => spec({ members: [] })).toThrow(/members/);
    expect(() => spec({ members: [m('a'), m('a')] })).toThrow(/unique/);
    expect(() => spec({ size: 5 })).toThrow(/size/);
    expect(() => spec({ topology: 'yolo' })).toThrow(/topology/);
    expect(() => spec({ topology: 'council' })).toThrow(/council needs at least 3/);
    expect(() => spec({ topology: 'council', members: [m('a'), m('b'), m('c')], rounds: 1 })).toThrow(/2 rounds/);
    expect(() => spec({ topology: 'relay', members: [m('a')] })).toThrow(/relay needs at least 2/);
    expect(() => spec({ topology: 'fusion', judge: { tier: 'edge' } })).toThrow(/judge.model/);
    expect(() => spec({ members: [{ id: 'h', kind: 'harness', harness: 'jcode' }] })).toThrow(/never runs at the edge/);
    expect(() => spec({ members: [{ id: 'h', kind: 'harness', harness: 'nope', node: 'mac' }] })).toThrow(/harness must be one of/);
    expect(() => spec({ members: [{ id: 't', kind: 'timmy' }] })).toThrow(/room required/);
    expect(() => spec({ members: [{ id: 'x', kind: 'model', model: 'm', provider: 'ollama:moon' }] })).toThrow(/provider/);
    expect(() => spec({ budget: { usd: -1 } })).toThrow(/budget.usd/);
    expect(() => spec({ network: { policy: 'closed' } })).toThrow(/topology closed/);
  });

  it('closed: local members only, local judge, empty egress, sandbox closed', () => {
    const closed = { topology: 'closed', network: { policy: 'closed' }, judge: { tier: 'local', model: 'q' } };
    expect(() => spec(closed)).toThrow(/sandbox closed/);
    const local = (id: string) => ({ id, kind: 'model', model: 'q', provider: 'ollama:mac', node: 'mac', sandbox: 'closed' });
    expect(spec({ ...closed, members: [local('a'), local('b')] }).topology).toBe('closed');
    expect(() => spec({ ...closed, members: [{ ...local('a'), provider: 'openrouter' }] })).toThrow(/ollama:<node>/);
    expect(() => spec({ ...closed, judge: { tier: 'edge', model: 'q' }, members: [local('a')] })).toThrow(/judge.tier local/);
    expect(() => spec({ ...closed, network: { policy: 'closed', egress_allow: ['x'] }, members: [local('a')] })).toThrow(/empty egress_allow/);
    expect(() => spec({ ...closed, members: [{ id: 't', kind: 'timmy', room: 'r', sandbox: 'closed' }] })).toThrow(/leave the air gap/);
  });
});

describe('topologies', () => {
  it('fanout keeps every answer; a failed member is shown, not hidden', async () => {
    const f = fake({ a: 'alpha', b: { error: 'boom' } });
    const r = await runSwarm(spec({}), 'task', f);
    expect(r.ok).toBe(true);
    expect(r.answer).toContain('[1] a\nalpha');
    expect(r.answer).toContain('[2] b (failed)');
    expect(r.calls.map((c) => c.phase)).toEqual(['answer', 'answer']);
    expect(r.usd).toBe(0.001);
  });

  it('fusion: members then one judge who sees every good candidate', async () => {
    const f = fake({ a: 'alpha', b: 'beta', judge: 'FUSED' });
    const r = await runSwarm(spec({ topology: 'fusion' }), 'task', f);
    expect(r.answer).toBe('FUSED');
    const j = f.seen.find((s) => s.member === 'judge')!;
    expect(j.msgs[1].content).toContain('candidate 1 (a)');
    expect(j.msgs[1].content).toContain('beta');
    expect(r.calls.at(-1)).toMatchObject({ member: 'judge', phase: 'judge', crew_role: 'judge' });
  });

  it('relay: each link sees the previous answer; a broken link is skipped', async () => {
    const f = fake({ a: 'v1', b: { error: 'down' }, c: (msgs) => `v2 after ${msgs[1].content.includes('PREVIOUS LINK (a)') ? 'a' : '?'}` });
    const r = await runSwarm(spec({ topology: 'relay', members: [m('a'), m('b'), m('c')] }), 'task', f);
    expect(r.answer).toBe('v2 after a');
    expect(r.winner).toBe('c');
    expect(f.seen[0].msgs[1].content).not.toContain('PREVIOUS');
  });

  it('coordinator: the judge assigns parts, members work them, the judge composes', async () => {
    const f = fake({ judge: ['{"assignments":[{"member":"a","subtask":"do A"},{"member":"b","subtask":"do B"}]}', 'COMPOSED'], a: 'A done', b: 'B done' });
    const r = await runSwarm(spec({ topology: 'coordinator' }), 'task', f);
    expect(r.assignments).toEqual({ a: 'do A', b: 'do B' });
    expect(r.answer).toBe('COMPOSED');
    expect(f.seen.map((s) => s.phase)).toEqual(['coordinate', 'work', 'work', 'compose']);
    expect(f.seen[1].msgs[1].content).toContain('YOUR PART:\ndo A');
    // an unparsable plan: everyone takes the whole task
    const g = fake({ judge: ['not json', 'C'], a: 'x', b: 'y' });
    const r2 = await runSwarm(spec({ topology: 'coordinator' }), 'the task', g);
    expect(r2.assignments).toEqual({ a: 'the task', b: 'the task' });
  });

  it('tournament: the judge picks one winner; the losers are recorded', async () => {
    const f = fake({ a: 'A', b: 'B', c: 'C', judge: '```json\n{"winner": 2, "reason": "B is right"}\n```' });
    const r = await runSwarm(spec({ topology: 'tournament', members: [m('a'), m('b'), m('c')] }), 'task', f);
    expect(r.winner).toBe('b');
    expect(r.answer).toBe('B');
    expect(r.losers).toEqual(['a', 'c']);
    expect(r.calls.map((c) => c.phase)).toEqual(['candidate', 'candidate', 'candidate', 'pick']);
    // a pick out of range falls back to the first candidate
    const g = fake({ a: 'A', b: 'B', judge: '{"winner": 9}' });
    expect((await runSwarm(spec({ topology: 'tournament' }), 'task', g)).winner).toBe('a');
  });

  it('council: positions, then weighted votes with no self-votes; a tie goes to the judge', async () => {
    const vote = (self: string, to: string) => (msgs: ChatMessage[], o: CallOpts) => (o.phase === 'position' ? `${self} position` : `{"position":"${self} final","vote":"${to}"}`);
    const three = [m('a'), m('b'), { ...m('c'), weight: 2 }];
    const f = fake({ a: vote('a', 'b'), b: vote('b', 'a'), c: vote('c', 'a') });
    const r = await runSwarm(spec({ topology: 'council', members: three, rounds: 2 }), 'task', f);
    expect(r.votes).toEqual({ a: 3, b: 1, c: 0 });
    expect(r.winner).toBe('a');
    expect(r.answer).toBe('a final');
    expect(r.rounds.map((x) => x.phase)).toEqual(['position', 'vote']);
    expect(f.seen.filter((s) => s.phase === 'vote')[0].msgs[1].content).toContain('YOU ARE: a');
    // self-votes do not count, and a tie is broken by the judge
    const g = fake({ a: vote('a', 'a'), b: vote('b', 'c'), c: vote('c', 'b'), judge: '{"winner": 2}' });
    const r2 = await runSwarm(spec({ topology: 'council', members: [m('a'), m('b'), m('c')] }), 'task', g);
    expect(r2.votes).toEqual({ a: 0, b: 1, c: 1 });
    expect(r2.calls.at(-1)?.phase).toBe('tiebreak');
    expect(r2.winner).toBe('c');
  });

  it('crew: roles come from harness.abilities; the judge plans and composes', async () => {
    const abilities: Abilities = { jcode: { one_shot: true, file_edits: true, tool_use: true, mcp_client: true }, hermes: { one_shot: true, mcp_client: true }, minds: { one_shot: true } };
    expect(roleFor('jcode', abilities)).toBe('builder');
    expect(roleFor('hermes', abilities)).toBe('bridge');
    expect(roleFor('minds', abilities)).toBe('answerer');
    expect(roleFor('nope', abilities)).toBe('unmeasured');
    const members = [{ id: 'j', kind: 'harness', harness: 'jcode', node: 'mac' }, { id: 'h', kind: 'harness', harness: 'hermes', node: 'mac' }, { id: 's', kind: 'harness', harness: 'minds', node: 'mac', role: 'scribe' }];
    const f = fake({ judge: ['{"assignments":[{"member":"j","instruction":"build it"},{"member":"h","instruction":"bridge it"},{"member":"s","instruction":"write it"}]}', 'REPORT'], j: 'built', h: 'bridged', s: 'written' });
    const r = await runSwarm(spec({ topology: 'crew', members }), 'ship it', { ...f, abilities });
    expect(r.roles).toEqual({ j: 'builder', h: 'bridge', s: 'scribe' });
    expect(r.assignments?.j).toBe('build it');
    expect(r.answer).toBe('REPORT');
    expect(f.seen[0].msgs[1].content).toContain('j: jcode, role builder, abilities one_shot/file_edits/tool_use/mcp_client');
  });

  it('closed runs as fusion over local members', async () => {
    const local = (id: string) => ({ id, kind: 'model', model: 'q', provider: 'ollama:mac', node: 'mac', sandbox: 'closed' });
    const f = fake({ a: 'A', b: 'B', judge: 'AB' });
    const r = await runSwarm(spec({ topology: 'closed', network: { policy: 'closed' }, judge: { tier: 'local', model: 'q' }, members: [local('a'), local('b')] }), 'task', f);
    expect(r.answer).toBe('AB');
    expect(r.topology).toBe('closed');
  });
});

describe('cost governor', () => {
  it('stops issuing calls when the usd budget is spent and records the kills', async () => {
    const f = fake({ a: 'A', b: 'B', c: 'C', judge: 'J' }, 0.6);
    const r = await runSwarm(spec({ topology: 'relay', members: [m('a'), m('b'), m('c')], budget: { usd: 1 } }), 'task', f);
    expect(r.calls.map((c) => [c.member, c.ok, !!c.killed])).toEqual([['a', true, false], ['b', true, false], ['c', false, true]]);
    expect(r.budget.exhausted).toMatch(/budget: 1.2000 USD of 1 USD/);
    expect(r.budget.kills).toEqual([{ member: 'c', phase: 'relay', reason: expect.stringContaining('budget') }]);
    expect(r.answer).toBe('B');
  });

  it('max_calls and the room gate kill the rest', async () => {
    const f = fake({ a: 'A', b: 'B', judge: 'J' });
    const r = await runSwarm(spec({ topology: 'fusion', budget: { usd: 1, max_calls: 2 } }), 'task', f);
    expect(r.calls.at(-1)).toMatchObject({ member: 'judge', killed: true });
    expect(r.answer).toContain('[1] a');
    let killed = false;
    const g = fake({ a: () => { killed = true; return 'A'; }, b: 'B' });
    const r2 = await runSwarm(spec({}), 'task', { ...g, gate: () => (killed ? 'kill switch' : null) });
    expect(r2.calls.some((c) => c.killed)).toBe(true);
    expect(r2.budget.exhausted).toContain('killed: kill switch');
  });

  it('a zero-usd budget (local slots) counts calls and time only', () => {
    const g = new Governor(spec({ budget: { usd: 0, max_calls: 3 } }), () => 0);
    expect(g.allow()).toBeNull();
    g.record({ usd: 5 } as MemberCall); g.record({ usd: 5 } as MemberCall); g.record({ usd: 5 } as MemberCall);
    expect(g.allow()).toContain('3 of 3 calls');
  });
});

describe('receipts', () => {
  it('swarm.run cites every member receipt and never the texts', async () => {
    const chain: EdgeReceipt[] = [];
    const s = spec({ topology: 'tournament', members: [m('a'), m('b')] });
    const f = fake({ a: 'secret alpha', b: 'secret beta', judge: '{"winner":1}' });
    // members run in parallel, so seals must be serialised (the DO does the same) or two would share a prev_hash
    let queue: Promise<unknown> = Promise.resolve();
    const seal = (data: Record<string, unknown>) => { const p = queue.then(() => appendEdgeReceipt(chain, { kind: 'swarm.member', subject: 'commander:r', data })); queue = p.catch(() => undefined); return p; };
    const sealing = { ...f, exec: async (mem: SwarmMember, msgs: ChatMessage[], o: CallOpts) => { const c = await f.exec(mem, msgs, o); const rec = await seal(await memberReceiptData(s, 'run', 'task', { ...c, phase: o.phase })); return { ...c, receipt: rec.hash }; } };
    const r = await runSwarm(s, 'task', sealing);
    const data = await swarmReceiptData(s, 'task', r, 'commander');
    const rec = await appendEdgeReceipt(chain, { kind: 'swarm.run', subject: 'commander:r', data });
    expect((await verifyEdgeChain(chain)).ok).toBe(true);
    const cited = (data.calls as { member: string; receipt: string | null }[]).filter((c) => c.member !== 'judge').map((c) => c.receipt);
    expect(cited).toEqual(chain.slice(0, 2).map((x) => x.hash));
    expect(data).toMatchObject({ topology: 'tournament', winner: 'a', losers: ['b'], size: 2, by: 'commander' });
    expect(JSON.stringify(rec)).not.toContain('secret');
    expect(data.task_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('helpers', () => {
    expect(firstJson('sure: ```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(firstJson('nope')).toBeNull();
    expect(candidatesBlock('t', [{ id: 'x', content: '' }])).toContain('(empty)');
  });
});
