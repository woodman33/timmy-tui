/**
 * The 2026-10-27 shared-integrator order: Treg through the host's job model (src/companion/connector-ops.ts).
 *
 * Real pieces: `timmy act "/mcp call …"` as a child process (the real CLI through tsx), Timmy's two MCP routes (its SDK route,
 * mcp-sdk-cli, and MCPorter), the project's records (.timmy/mcp/<call>/) and its receipt chain.
 * FAKE pieces, labelled: tests/fixtures/fake-treg-mcp.mjs, a TEST DOUBLE of Treg's MCP server (made-up catalog, price,
 * balance and call; nothing contacts treg.to), started where Timmy's bridge would be; and a made-up sign-in file whose
 * token must never appear in any record, receipt or answer Timmy keeps.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectorOps, tregState, type ConnectorOpView, type ConnectorScope } from '../src/companion/connector-ops.js';
import { readChain } from '../src/utils/receipts.js';
import { CLI, FIXTURES, LOADER, opsKit, sandbox, until } from './helpers/ops-sandbox.js';

const kit = opsKit();
afterEach(kit.cleanup);

const FAKE_TREG = path.join(FIXTURES, 'fake-treg-mcp.mjs');
const TOKEN = 'fake-treg-token-MUST-NOT-APPEAR';

function setup(o: { signedIn?: boolean; operator?: boolean; slow?: boolean } = {}) {
  const s = sandbox(kit, 'treg-ops-');
  const signIn = path.join(s.base, 'treg-login.json');
  if (o.signedIn !== false) fs.writeFileSync(signIn, JSON.stringify({ token: TOKEN, active_org: 'fake-team' }));
  const log = path.join(s.base, 'fake-treg.log');
  const env = { ...s.env, TREG_CONFIG: signIn };
  delete env.TIMMY_STORE;
  const scope: ConnectorScope = { principal: 'operator', operator: o.operator !== false, project: { name: 'project', root: s.root }, env };
  // a route gives a server only its base environment (and TREG_CONFIG): the FAKE's own settings go on its command line
  const bridge = ['/usr/bin/env', `FAKE_TREG_LOG=${log}`, ...(o.slow ? ['FAKE_TREG_CALL=slow', 'FAKE_TREG_SLOW_MS=4000'] : []), process.execPath, FAKE_TREG];
  const ops = new ConnectorOps({ timmy: [process.execPath, '--import', LOADER, CLI], bridge });
  const calls = (): Array<{ tool: string; args: Record<string, unknown>; treg_config: string | null }> => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { s, scope, ops, calls, signIn, bridge };
}

async function ended(ops: ConnectorOps, scope: ConnectorScope, id: string, ms = 90_000): Promise<ConnectorOpView> {
  let v: ConnectorOpView | null = null;
  await until(() => { const r = ops.read(scope, id); v = r ? ops.view(scope, r) : null; return !!v && !v.live; }, ms, `operation ${id} to end`);
  return v!;
}

/** Every file under a folder, as text (to look for the token). */
function allText(dir: string): string {
  let out = '';
  const walk = (d: string): void => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) out += fs.readFileSync(p, 'utf8'); } };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

describe('Treg connector operations (the FAKE Treg MCP server; real timmy act and routes)', () => {
  it('refuses before anything is sent: a signed-in user who is not the operator, no sign-in file, a paid call without a proposal', async () => {
    const a = setup({ operator: false });
    expect(a.ops.start(a.scope, { tool: 'balance' })).toMatchObject({ ok: false, status: 403, refused: 'operator' });
    const b = setup({ signedIn: false });
    const r = b.ops.start(b.scope, { tool: 'balance' });
    expect(r).toMatchObject({ ok: false, status: 409, refused: 'setup' });
    expect((r as { error: string }).error).toMatch(/Not signed in to Treg/);
    const c = setup();
    expect(c.ops.start(c.scope, { tool: 'call', args: { endpoint_id: 'fake.demo.profile' } })).toMatchObject({ ok: false, refused: 'usage' });
    expect(c.ops.start(c.scope, { tool: 'catalog_search', args: { query: '' } })).toMatchObject({ ok: false, refused: 'usage' });
    expect(c.ops.start(c.scope, { proposal: 'qnothere' })).toMatchObject({ ok: false, status: 404 });
    expect(c.calls()).toEqual([]);
    const st = tregState(b.scope, [], b.ops.bridge());
    expect(st.signed_in.ok).toBe(false);
    expect(st.qualified.ok).toBe(false);
  });

  it('discovers, searches for free, previews a price, and makes one approved paid call: its result, its charge as Treg states it, two receipts, no token anywhere', async () => {
    const { s, scope, ops, calls } = setup();
    const d = await ops.discover(scope, { route: 'sdk' });
    expect(d.ok).toBe(true);
    const disc = (d as { op: ConnectorOpView }).op;
    expect(disc.state).toBe('answered');
    expect(disc.discovered!.tools.map((t) => t.name).sort()).toEqual(['balance', 'call', 'catalog_get', 'catalog_search']);

    // a free search, through `timmy act "/mcp call …"`
    const started = ops.start(scope, { tool: 'catalog_search', args: { query: 'profile lookup', limit: 3 }, route: 'sdk' });
    expect(started.ok).toBe(true);
    const search = await ended(ops, scope, (started as { op: ConnectorOpView }).op.id);
    expect(search.state).toBe('answered');
    expect(search.operation).toMatch(/^o[0-9a-f]{8}$/);
    expect(search.mcp!.id).toMatch(/^m[0-9a-f]{8}$/);
    expect(search.mcp!.receipt).toMatch(/^[0-9a-f]{8}$/); // the mcp.call receipt, verified against call.json
    expect(search.receipt).toMatch(/^[0-9a-f]{8}$/); // the connector.call receipt
    expect(search.answer).toContain('fake.demo.profile');
    expect(search.paid).toBe(false);
    expect(fs.existsSync(path.join(s.root, search.mcp!.record))).toBe(true);

    // the price preview: catalog_get, then a proposal from it
    const p = ops.start(scope, { tool: 'catalog_get', args: { endpoint_id: 'fake.demo.profile' }, route: 'sdk' });
    const price = await ended(ops, scope, (p as { op: ConnectorOpView }).op.id);
    expect(price.quote).toMatchObject({ endpoint_id: 'fake.demo.profile', usd: 0.001, type: 'per_success' });
    expect(ops.propose(scope, { price_op: search.id })).toMatchObject({ ok: false, refused: 'price' }); // not a price preview
    const prop = ops.propose(scope, { price_op: price.id, request: { query: { uniqueId: 'fake' }, method: 'GET' } });
    expect(prop.ok).toBe(true);
    const proposal = (prop as { proposal: { id: string; idempotency_key: string; words: string[]; quote: { usd: number } } }).proposal;
    expect(proposal.words.join(' ')).toMatch(/quote, not a cap/);
    expect(proposal.quote.usd).toBe(0.001);
    expect(ops.propose(scope, { price_op: price.id, request: { headers: { Authorization: 'x' } } })).toMatchObject({ ok: false, refused: 'usage' });

    const paidStart = ops.start(scope, { proposal: proposal.id });
    expect(paidStart.ok).toBe(true);
    expect(ops.start(scope, { proposal: proposal.id })).toMatchObject({ ok: false, status: 404 }); // used once
    const paid = await ended(ops, scope, (paidStart as { op: ConnectorOpView }).op.id);
    expect(paid.state).toBe('answered');
    expect(paid.paid).toBe(true);
    expect(paid.charged).toEqual({ usd: 0.001, field: 'charged_micro', raw: 1000 }); // never data.cost: that is upstream data
    expect(paid.args.idempotency_key).toBe(proposal.idempotency_key);
    expect(paid.approved!.quote.usd).toBe(0.001);

    // exactly one paid call reached the (FAKE) server, with the sign-in file named and the idempotency key Timmy chose
    const seen = calls();
    expect(seen.filter((c) => c.tool === 'call')).toHaveLength(1);
    expect(seen.find((c) => c.tool === 'call')!.args).toMatchObject({ endpoint_id: 'fake.demo.profile', method: 'GET', query: { uniqueId: 'fake' }, idempotency_key: proposal.idempotency_key });
    expect(seen.every((c) => c.treg_config === scope.env.TREG_CONFIG)).toBe(true);

    // the receipts: connector.call sealed in the project's chain, with the quote and the charge Treg's answer states
    const chain = readChain('runs', s.root);
    const conn = chain.filter((r) => r.kind === 'connector.call');
    expect(conn).toHaveLength(3);
    const paidRc = conn.find((r) => (r as { connector?: { paid: boolean } }).connector?.paid)! as unknown as { status: string; cost_usd: number; cost_measured: boolean; connector: Record<string, unknown> };
    expect(paidRc).toMatchObject({ status: 'ok', cost_usd: 0.001, cost_measured: true });
    expect(paidRc.connector).toMatchObject({ tool: 'call', quote_usd: 0.001, charged_usd: 0.001, mcp_receipt: paid.mcp!.receipt });
    expect(chain.filter((r) => r.kind === 'mcp.call').length).toBeGreaterThanOrEqual(3);

    // the token: in no record, answer, receipt or log Timmy keeps
    expect(allText(s.root)).not.toContain(TOKEN);
    expect(allText(path.join(s.home, 'timmy'))).not.toContain(TOKEN);
    const state = tregState(scope, ops.list(scope), ops.bridge());
    expect(state.signed_in.ok && state.discovered.ok && state.ran_here.ok).toBe(true);
    expect(state.qualified.ok).toBe(false);
    expect(JSON.stringify(state)).not.toContain(TOKEN);
  }, 240_000);

  it('a proposal for an endpoint whose answer states no price in USD is refused; MCPorter is a route of its own', async () => {
    const { scope, ops } = setup();
    const p = ops.start(scope, { tool: 'catalog_get', args: { endpoint_id: 'fake.demo.unpriced' }, route: 'mcporter' });
    expect(p.ok).toBe(true);
    const price = await ended(ops, scope, (p as { op: ConnectorOpView }).op.id);
    expect(price.state).toBe('answered');
    expect(price.route).toBe('mcporter');
    expect(price.quote).toBeUndefined();
    const r = ops.propose(scope, { price_op: price.id });
    expect(r).toMatchObject({ ok: false, refused: 'price' });
    expect((r as { error: string }).error).toMatch(/states no price in USD/);
  }, 120_000);

  it('Stop while the paid call is in flight: the request already sent is not withdrawn; its answer is kept and the operation says so', async () => {
    const { scope, ops, calls } = setup({ slow: true });
    const p = ops.start(scope, { tool: 'catalog_get', args: { endpoint_id: 'fake.demo.profile' }, route: 'sdk' });
    const price = await ended(ops, scope, (p as { op: ConnectorOpView }).op.id);
    const prop = ops.propose(scope, { price_op: price.id }) as { ok: true; proposal: { id: string } };
    const started = ops.start(scope, { proposal: prop.proposal.id }) as { ok: true; op: ConnectorOpView };
    await until(() => calls().some((c) => c.tool === 'call'), 60_000, 'the FAKE server to get the call');
    const stopped = ops.stop(scope, started.op.id);
    expect(stopped).toMatchObject({ ok: true, op: { state: 'stopping' } });
    const end = await ended(ops, scope, started.op.id);
    expect(end.state).toBe('stopped');
    expect(end.stop!.in_flight).toBe(true);
    expect(end.why).toMatch(/cannot be withdrawn/);
    expect(end.mcp!.outcome).toBe('answered');
    expect(end.charged).toEqual({ usd: 0.001, field: 'charged_micro', raw: 1000 });
    expect(end.receipt).toMatch(/^[0-9a-f]{8}$/);
    expect(calls().filter((c) => c.tool === 'call')).toHaveLength(1);
  }, 180_000);

  it('an act that ended without its end is interrupted; Recover settles it from the project, and a paid call with no record is unknown (never called again)', async () => {
    const { s, scope, calls, bridge } = setup();
    const die = path.join(s.base, 'act-dies.mjs');
    fs.writeFileSync(die, 'process.stderr.write("  (a FAKE act that ends at once, without its end)\\n"); process.exit(1);\n');
    const ops = new ConnectorOps({ timmy: [process.execPath, die], bridge });
    const free = ops.start(scope, { tool: 'balance', route: 'sdk' }) as { ok: true; op: ConnectorOpView };
    const gone = await ended(ops, scope, free.op.id);
    expect(gone.state).toBe('interrupted');
    expect(ops.recover(scope, free.op.id)).toMatchObject({ ok: true, op: { state: 'failed' } });

    // a paid one: its proposal from a real price preview, then the act that dies
    const real = new ConnectorOps({ timmy: [process.execPath, '--import', LOADER, CLI], bridge });
    const p = real.start(scope, { tool: 'catalog_get', args: { endpoint_id: 'fake.demo.profile' }, route: 'sdk' }) as { ok: true; op: ConnectorOpView };
    await ended(real, scope, p.op.id);
    const prop = ops.propose(scope, { price_op: p.op.id }) as { ok: true; proposal: { id: string } };
    const paid = ops.start(scope, { proposal: prop.proposal.id }) as { ok: true; op: ConnectorOpView };
    expect((await ended(ops, scope, paid.op.id)).state).toBe('interrupted');
    const rec = ops.recover(scope, paid.op.id) as { ok: true; op: ConnectorOpView };
    expect(rec.op.state).toBe('unknown');
    expect(rec.op.why).toMatch(/check Treg’s history/);
    expect(rec.op.next).toMatch(/Timmy does not call again/);
    expect(calls().filter((c) => c.tool === 'call')).toHaveLength(0);
    expect(ops.recover(scope, paid.op.id)).toMatchObject({ ok: false, refused: 'busy' });
  }, 180_000);
});
