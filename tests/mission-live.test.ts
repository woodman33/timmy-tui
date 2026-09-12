import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { startLogServer } from '../src/utils/logserver.js';
import { issueApproval } from '../src/utils/approvals.js';
import { appendReceipt } from '../src/utils/receipts.js';
import { buildAgentPass } from '../src/utils/agent-pass.js';
import { armEscrow, lockEscrow } from '../src/utils/escrow-engine.js';
import { busPath } from '../src/bus/index.js';

// Mission Studio live launch (v0.7.6): the arming gateway triggers the
// containerized lane for openhands+docker plans and telemetry lands on the
// event bus the studio streams. DRYRUN exercises the mechanics without a
// real container; approval/isolation gates still apply.
let port = 0;
beforeAll(async () => {
  process.env.TIMMY_DISPATCH_DRYRUN = '1';
  port = await startLogServer({ port: 4397 });
});
afterAll(() => { delete process.env.TIMMY_DISPATCH_DRYRUN; });

const DOC = {
  nodes: [
    { id: 'cap', kind: 'capsule', objective: 'live mission telemetry probe' },
    { id: 'h', kind: 'harness', harness: 'openhands', workspace: 'docker' }
  ],
  edges: [{ from: 'h', to: 'cap', kind: 'harness' }]
};

const post = async (p: number, path: string, body: unknown) =>
  (await fetch(`http://127.0.0.1:${p}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();

describe('mission studio live launch (:4310/mission)', () => {
  it('compiles openhands+docker capsules with the container workspace kind', async () => {
    const c = await post(port, '/mission/compile', { doc: DOC });
    expect(c.ok).toBe(true);
    expect(c.plans[0].plan.workspace.kind).toBe('docker');
    expect(c.plans[0].plan.harnesses[0]).toBe('openhands');
  });

  it('refuses launch before arm (chat prepares, authority launches)', async () => {
    const c = await post(port, '/mission/compile', { doc: DOC });
    const s = await post(port, '/mission/store', { plan: c.plans[0].plan });
    expect(s.ok).toBe(true);
    const l = await post(port, '/dispatch/action', { id: s.id, action: 'launch' });
    expect(l.ok).toBe(false);
    expect(String(l.note)).toContain('not armed');
  });

  it('armed container plan launches and streams telemetry events', async () => {
    const c = await post(port, '/mission/compile', { doc: DOC });
    const s = await post(port, '/mission/store', { plan: c.plans[0].plan });
    const a = await post(port, '/dispatch/action', { id: s.id, action: 'arm', token: issueApproval(s.plan_hash).token });
    expect(a.ok).toBe(true);
    const l = await post(port, '/dispatch/action', { id: s.id, action: 'launch' });
    expect(l.ok).toBe(true);
    expect(l.container).toBe(true);
    // telemetry for THIS plan landed on the bus (studio SSE filters by plan_id)
    const evs = readFileSync(busPath(), 'utf8')
      .trim().split('\n').map(x => JSON.parse(x)).filter((e: { hash?: string }) => !e.hash)
      .filter((e: { payload?: { plan_id?: string } }) => e.payload?.plan_id === s.id);
    expect(evs.some((e: { kind: string }) => e.kind === 'dispatch.container_started')).toBe(true);
    expect(evs.some((e: { kind: string }) => e.kind === 'dispatch.container_done')).toBe(true);
    const plans = await (await fetch(`http://127.0.0.1:${port}/dispatch`)).json();
    expect(plans.find((p: { id: string }) => p.id === s.id).lifecycle).toBe('judging');
  });

  it('telemetry panel is hardened: drop recovery + bounded autoscroll buffer', async () => {
    const html = await (await fetch(`http://127.0.0.1:${port}/mission`)).text();
    expect(html).toContain('sse.connection-dropped');
    expect(html).toContain('sse.reconnected');
    expect(html).toContain('TELE_CAP = 200');
    expect(html).toContain('5 · INSPECTORS');
  });

  it('inspectors: merkle proof tree matches; stage hierarchy resolves', async () => {
    const parent = appendReceipt('runs', { kind: 'run', subject: 'inspector parent', policy: 'human-gated', status: 'ok', spans: [], artifacts: [] }).hash;
    const b = buildAgentPass({ parent_receipt: parent });
    const m = await post(port, '/mission/inspect', { kind: 'merkle', pass: b.pass });
    expect(m.ok).toBe(true);
    expect(m.matches).toBe(true);
    expect(m.levels.length).toBe(1);
    const s = await post(port, '/mission/inspect', {
      kind: 'stage',
      scene: { schema_version: 'usd/0.1', name: 'insp', meters_per_unit: 0.01, up_axis: 'Z', prims: [{ id: 'a', kind: 'cube' }] }
    });
    expect(s.ok).toBe(true);
    expect(s.hierarchy[0]).toEqual({ path: '/World', kind: 'Xform' });
    expect(s.usda).toContain('def Cube "a"');
  });

  it('escrow ledger: live locks surface via endpoint + events', async () => {
    const a = armEscrow({ plan_hash: 'f'.repeat(64), ceiling_usd: 1, qa_threshold: 0.5 });
    expect(a.ok).toBe(true);
    lockEscrow(a.escrow!.escrow_id);
    const r = await (await fetch(`http://127.0.0.1:${port}/mission/escrows`)).json();
    expect(r.ok).toBe(true);
    const row = r.escrows.find((e: { escrow_id: string }) => e.escrow_id === a.escrow!.escrow_id);
    expect(row).toBeTruthy();
    expect(row.state).toBe('locked');
    expect(row.ceiling_usd).toBe(1);
    const html = await (await fetch(`http://127.0.0.1:${port}/mission`)).text();
    expect(html).toContain('6 · ESCROW LEDGER');
    const evs = readFileSync(busPath(), 'utf8')
      .trim().split('\n').map(x => JSON.parse(x)).filter((e: { hash?: string }) => !e.hash);
    expect(evs.some((e: { kind: string; payload?: { escrow_id?: string } }) => e.kind === 'escrow.locked' && e.payload?.escrow_id === a.escrow!.escrow_id)).toBe(true);
  });
});
