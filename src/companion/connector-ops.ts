/**
 * The 2026-10-27 shared-integrator order: Treg (https://treg.to) through the host's job model — discovery, a price preview,
 * an authorized call, its actual result and cost, and its receipt — for Tools & integrations, and for any mini-app that later
 * consumes it (through these routes, never a login of its own). One connector owner: the Timmy integrator; one sign-in: the
 * Treg CLI's own login file, read by Timmy's bridge (src/connectors/treg-bridge.ts) and nowhere else. No token reaches a page,
 * a prompt, a log, a record or a receipt.
 *
 * Each operation is durable, as a Control Room run is (src/companion/control-runs.ts): a record under the principal's Timmy
 * home (<TIMMY_HOME>/connector-ops/<project id>/<op>/op.json), its own id, its state, and its end.
 *   - discover: tools/list through the route the person chose (MCPorter, or Timmy's SDK route), Timmy's bridge as an ad-hoc
 *     stdio command; the tools Treg listed (its descriptions are its own words: untrusted) are kept in the record. A listing
 *     is not sealed (as /mcp tools is not).
 *   - a call: `timmy act "/mcp call --route <route> <tool> <json> -- <bridge>" --wait --json --project <project>`, detached,
 *     its stdout (the end's JSON) and stderr beside the record. /mcp call keeps the call in the project
 *     (.timmy/mcp/<call>/call.json and output.json) and seals its mcp.call receipt; at the end this module reads that record
 *     and seals one connector.call receipt in the project's chain (the quote, what Treg's answer says it charged, the MCP call
 *     and its receipt). catalog_search, catalog_get and balance are free (Treg's own words), so a press starts them.
 *   - a paid call (`call`): only from a proposal, and a proposal only from a price preview — a catalog_get operation of this
 *     principal and project that ended answered within PROPOSAL_MS, whose answer states a price in USD. The proposal shows the
 *     quote and the request, carries an idempotency key Timmy chose, is used once, and lapses after PROPOSAL_MS. One paid call
 *     runs at a time in a project. There is no retry, no top-up, no cap invented: the quote is the catalog's, not a limit.
 *   - Stop: SIGTERM to the act process. A request already sent to Treg cannot be withdrawn: act waits for its answer (the
 *     bridge's 20 s, the route's time limit) and keeps it; the record says the stop came while the call was in flight.
 *   - Recover: an act process gone without its end's JSON is interrupted; Recover reads what it left (the operation record
 *     act wrote in the project, the MCP call record) and settles the operation from it. A paid call with no record of its
 *     end is "unknown": it may have been charged — Treg's history says; Timmy never calls again on its own.
 *
 * The operator only: the sign-in is this computer's operator's, so a signed-in user of the companion is refused (their own
 * Treg sign-in is not supported here; the operator's keys are never a user's, src/companion/identity/scope.ts).
 * Catalog results are research, never admitted evidence: no answer here is a citation of anything.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type express from 'express';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listTools, mcpRoutes, MCP_ROUTE_IDS, type McpRouteId } from '../connectors/mcp-cli.js';
import { MCP_CALL_ID, MCP_CALL_SCHEMA, mcpCallRel, mcpOutputRel, readMcpCalls } from '../connectors/mcp-records.js';
import {
  answerValue, balanceOf, callParts, chargedOf, freeArgs, isFreeTool, quoteOf, tregBridgeArgv, tregSignIn, usdWords,
  FREE_TOOLS, TREG_TOOLS, ENDPOINT_ID, type TregQuote, type TregTool,
} from '../connectors/treg.js';
import { listOperationRecords } from '../ops/operations.js';
import { projectId } from '../project/index.js';
import { realOnPath } from '../repl/center.js';
import { timmyHome } from '../setup/home.js';
import { scrubHomes } from '../utils/home-scrub.js';
import { appendReceipt, readChain } from '../utils/receipts.js';

type Env = Record<string, string | undefined>;

export const CONNECTOR_OP_SCHEMA = 'timmy.connector-op/1' as const;
export const PROPOSAL_MS = 10 * 60_000;
export const DISCOVER_MS = 45_000;
const OP_ID = /^t[0-9a-f]{8}$/;
const TAIL_MAX = 30;

export interface ConnectorScope {
  principal: string;
  /** whether the principal is this computer's operator (the Treg sign-in is the operator's) */
  operator: boolean;
  project: { name: string; root: string };
  env: Env;
}

export type OpState = 'running' | 'stopping' | 'answered' | 'failed' | 'stopped' | 'interrupted' | 'unknown';

export interface ConnectorOpRecord {
  schema: typeof CONNECTOR_OP_SCHEMA;
  id: string;
  principal: string;
  project: { id: string; name: string };
  connector: 'treg';
  kind: 'discover' | 'call';
  /** the Treg tool called (null for a discovery) */
  tool: TregTool | null;
  route: McpRouteId;
  /** what was sent as the tool's arguments (a paid call: with Timmy's idempotency key) */
  args: Record<string, unknown>;
  paid: boolean;
  /** a paid call: the proposal the person approved, its quote and the price preview it came from */
  approved?: { proposal: string; quote: TregQuote; price_op: string; request_sha256: string; at: string };
  started_at: string;
  /** the act process (a call), or the companion itself (a discovery, which runs in it), while it runs */
  pid: number | null;
  /** the act process's pid as it started (kept after the end: act's operation record in the project names its owner by it) */
  act_pid?: number | null;
  state: OpState;
  stop?: { asked_at: string; by: string; in_flight: boolean };
  ended_at?: string;
  act?: { operation: string | null; outcome: string; exit_code: number; why: string; receipts: Array<{ id: string; kind: string; status?: string }> } | null;
  exit?: { code: number | null; signal: string | null; seen: boolean };
  /** the /mcp call's record in the project (a call) */
  mcp?: { id: string; outcome: string; isError: boolean | null; ms: number; receipt: string | null; record: string; output: string | null; error?: string };
  /** a discovery: the tools Treg listed, as it listed them (names, the parameters, its descriptions cut to 300 characters) */
  discovered?: { tools: Array<{ name: string; required: string[]; params: string[]; description?: string }>; ms: number };
  /** what Treg's answer says it charged, by its own field; null: it states none */
  charged?: { usd: number; field: string; raw: number } | null;
  /** the project's connector.call receipt (its short id), sealed once */
  receipt?: string;
  why?: string;
}

const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
const now = (): string => new Date().toISOString();
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('\n')[0];

export function opsDir(scope: Pick<ConnectorScope, 'env' | 'project'>): string {
  return path.join(timmyHome(scope.env), 'connector-ops', projectId(scope.project.root));
}
const opDirOf = (scope: ConnectorScope, id: string): string => path.join(opsDir(scope), id);
const recordPath = (dir: string): string => path.join(dir, 'op.json');

function readRecord(dir: string): ConnectorOpRecord | null {
  try { const r = JSON.parse(fs.readFileSync(recordPath(dir), 'utf8')) as ConnectorOpRecord; return r && r.schema === CONNECTOR_OP_SCHEMA ? r : null; } catch { return null; }
}
function writeRecord(dir: string, r: ConnectorOpRecord): void {
  const tmp = `${recordPath(dir)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(r, null, 1)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, recordPath(dir));
}

export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

export interface ConnectorProposal {
  id: string;
  endpoint_id: string;
  quote: TregQuote;
  /** the request parts (params, method, query, body) as they will be sent */
  request: Record<string, unknown>;
  route: McpRouteId;
  idempotency_key: string;
  /** the price preview it came from */
  price_op: string;
  /** in words, for the page: what will happen and what will not */
  words: string[];
  expires_at: string;
  request_sha256: string;
}

interface Kept { p: ConnectorProposal; principal: string; projectRoot: string; until: number }

export type Refusal = { ok: false; status: number; refused: 'usage' | 'setup' | 'operator' | 'busy' | 'unknown' | 'price'; error: string };

export interface ConnectorDeps {
  /** the command that is `timmy` (default: this package's CLI under this node) */
  timmy?: string[];
  /** the command that starts the Treg MCP server (default: Timmy's own bridge); tests give a FAKE server here */
  bridge?: string[];
  now?: () => number;
}

const routeWord = (r: McpRouteId): string => (r === 'sdk' ? 'Timmy’s SDK route' : 'MCPorter');
const isRoute = (v: unknown): v is McpRouteId => typeof v === 'string' && (MCP_ROUTE_IDS as readonly string[]).includes(v);
/** A word of a command line for /mcp call (splitCommandLine reads quotes as a shell does). */
const quoteWord = (w: string): string => (/^[\w./:@%+=-]+$/.test(w) ? w : `"${w}"`);

export class ConnectorOps {
  private readonly proposals = new Map<string, Kept>();
  private readonly children = new Map<string, ChildProcess>();
  /** discoveries running in this process */
  private readonly listing = new Set<string>();

  constructor(private readonly d: ConnectorDeps = {}) {}

  private t(): number { return this.d.now ? this.d.now() : Date.now(); }
  private timmy(): string[] { return this.d.timmy ?? [process.execPath, fileURLToPath(new URL('../cli.js', import.meta.url))]; }
  bridge(): string[] | null { return this.d.bridge ?? tregBridgeArgv(); }

  /** The environment a route, act and the bridge get: the principal's, with the sign-in file named, no operation joined. */
  private childEnv(scope: ConnectorScope): Env {
    const env: Env = { ...scope.env };
    delete env.TIMMY_OPERATION;
    delete env.TIMMY_STORE; // act seals in the project's own chain, where this module reads and seals
    env.TREG_CONFIG = tregSignIn(scope.env).path;
    return env;
  }

  private gate(scope: ConnectorScope): Refusal | null {
    if (!scope.operator) return { ok: false, status: 403, refused: 'operator', error: 'Treg here uses this computer’s operator’s sign-in, so only the operator uses it from this companion. Nothing was sent.' };
    const s = tregSignIn(scope.env);
    if (!s.token) return { ok: false, status: 409, refused: 'setup', error: `Not signed in to Treg: ${s.why ?? 'no token'}. Nothing was sent.` };
    if (!this.bridge()) return { ok: false, status: 409, refused: 'setup', error: 'Timmy’s Treg bridge is not built here (npm run build). Nothing was sent.' };
    return null;
  }

  // ── discovery ─────────────────────────────────────────────────────────────────────────────────────────────────────────

  async discover(scope: ConnectorScope, body: { route?: unknown }): Promise<{ ok: true; op: ConnectorOpView } | Refusal> {
    const g = this.gate(scope); if (g) return g;
    const route = isRoute(body.route) ? body.route : 'sdk';
    const r = mcpRoutes(scope.env).find((x) => x.id === route);
    if (!r?.available) return { ok: false, status: 409, refused: 'setup', error: `${routeWord(route)} is not installed here: ${r?.setup ?? 'see /mcp'}. Nothing was sent.` };
    const { id, dir } = this.newOp(scope);
    const rec: ConnectorOpRecord = this.base(scope, id, { kind: 'discover', tool: null, route, args: {}, paid: false, pid: process.pid });
    writeRecord(dir, rec);
    this.listing.add(id);
    try {
      const listed = await listTools(route, { command: this.bridge()! }, { cwd: scope.project.root, env: this.childEnv(scope), timeoutMs: DISCOVER_MS });
      const end = readRecord(dir) ?? rec;
      end.ended_at = now(); end.pid = null;
      if (listed.ok) {
        end.state = 'answered';
        end.discovered = { ms: listed.ms, tools: listed.tools.map((t) => ({ name: t.name, required: t.required, params: t.params, ...(t.description ? { description: t.description.slice(0, 300) } : {}) })) };
        end.why = `listed ${listed.tools.length} tool${listed.tools.length === 1 ? '' : 's'} through ${routeWord(route)} in ${listed.ms} ms`;
      } else {
        end.state = 'failed';
        end.why = scrubHomes(listed.error ?? 'the listing failed', scope.env as NodeJS.ProcessEnv);
      }
      writeRecord(dir, end);
      return { ok: true, op: this.view(scope, end) };
    } finally { this.listing.delete(id); }
  }

  // ── a call (free, or from a proposal) ────────────────────────────────────────────────────────────────────────────────

  start(scope: ConnectorScope, body: { tool?: unknown; args?: unknown; route?: unknown; proposal?: unknown }): { ok: true; op: ConnectorOpView } | Refusal {
    const g = this.gate(scope); if (g) return g;
    if (body.proposal !== undefined) return this.startPaid(scope, body.proposal);
    if (body.tool === 'call') return { ok: false, status: 400, refused: 'usage', error: 'A paid call starts only from a proposal: preview its price first. Nothing was sent.' };
    if (!isFreeTool(body.tool)) return { ok: false, status: 400, refused: 'usage', error: `Choose ${FREE_TOOLS.join(', ')}; a paid call starts from a proposal. Nothing was sent.` };
    const a = freeArgs(body.tool, body.args);
    if (!a.ok) return { ok: false, status: 400, refused: 'usage', error: `${a.error} Nothing was sent.` };
    const route = isRoute(body.route) ? body.route : 'sdk';
    return this.spawnCall(scope, { tool: body.tool, args: a.args, route, paid: false });
  }

  private startPaid(scope: ConnectorScope, proposal: unknown): { ok: true; op: ConnectorOpView } | Refusal {
    this.sweep();
    const pid = typeof proposal === 'string' ? proposal : '';
    const kept = this.proposals.get(pid);
    if (!kept || kept.principal !== scope.principal || kept.projectRoot !== path.resolve(scope.project.root)) return { ok: false, status: 404, refused: 'unknown', error: 'That proposal is not here (it was used, or it is more than 10 minutes old): preview the price again. Nothing was sent.' };
    if (this.list(scope).some((o) => o.paid && o.live)) return { ok: false, status: 409, refused: 'busy', error: 'A paid call is still running in this project: one at a time. Nothing was sent.' };
    this.proposals.delete(pid); // used once, whatever happens next
    const p = kept.p;
    const args = { endpoint_id: p.endpoint_id, ...p.request, idempotency_key: p.idempotency_key };
    return this.spawnCall(scope, { tool: 'call', args, route: p.route, paid: true, approved: { proposal: p.id, quote: p.quote, price_op: p.price_op, request_sha256: p.request_sha256, at: now() } });
  }

  private spawnCall(scope: ConnectorScope, c: { tool: TregTool; args: Record<string, unknown>; route: McpRouteId; paid: boolean; approved?: ConnectorOpRecord['approved'] }): { ok: true; op: ConnectorOpView } | Refusal {
    const r = mcpRoutes(scope.env).find((x) => x.id === c.route);
    if (!r?.available) return { ok: false, status: 409, refused: 'setup', error: `${routeWord(c.route)} is not installed here: ${r?.setup ?? 'see /mcp'}. Nothing was sent.` };
    const bridge = this.bridge()!;
    if (bridge.some((w) => w.includes('"'))) return { ok: false, status: 409, refused: 'setup', error: 'The bridge’s path has a double quote in it, which a /mcp call line cannot carry. Nothing was sent.' };
    const line = `/mcp call --route ${c.route} ${c.tool} ${JSON.stringify(c.args)} -- ${bridge.map(quoteWord).join(' ')}`;
    const { id, dir } = this.newOp(scope);
    const [cmd, ...pre] = this.timmy();
    const out = fs.openSync(path.join(dir, 'act.out'), 'w', 0o600);
    const err = fs.openSync(path.join(dir, 'act.err'), 'w', 0o600);
    let child: ChildProcess;
    try {
      child = spawn(cmd, [...pre, 'act', line, '--wait', '--json', '--project', scope.project.root], { cwd: scope.project.root, env: this.childEnv(scope) as NodeJS.ProcessEnv, stdio: ['ignore', out, err], detached: true });
    } catch (e) {
      fs.closeSync(out); fs.closeSync(err);
      return { ok: false, status: 500, refused: 'setup', error: `timmy act could not start: ${msg(e)}. Nothing was sent.` };
    }
    fs.closeSync(out); fs.closeSync(err);
    const rec = this.base(scope, id, { kind: 'call', tool: c.tool, route: c.route, args: c.args, paid: c.paid, pid: child.pid ?? null, ...(c.approved ? { approved: c.approved } : {}) });
    rec.act_pid = child.pid ?? null;
    writeRecord(dir, rec);
    this.children.set(id, child);
    child.on('error', (e) => { this.children.delete(id); this.settle(scope, id, { code: null, signal: null, seen: true }, `timmy act could not run: ${msg(e)}`); });
    child.on('exit', (code, signal) => { this.children.delete(id); this.settle(scope, id, { code, signal, seen: true }); });
    child.unref();
    return { ok: true, op: this.view(scope, rec) };
  }

  // ── a price preview becomes a proposal ───────────────────────────────────────────────────────────────────────────────

  propose(scope: ConnectorScope, body: { price_op?: unknown; request?: unknown; route?: unknown }): { ok: true; proposal: ConnectorProposal } | Refusal {
    const g = this.gate(scope); if (g) return g;
    const priceId = typeof body.price_op === 'string' ? body.price_op : '';
    const price = this.read(scope, priceId);
    if (!price || price.kind !== 'call' || price.tool !== 'catalog_get') return { ok: false, status: 400, refused: 'price', error: 'Preview the endpoint’s price first (a catalog lookup of it): a paid call is proposed only from one. Nothing was sent.' };
    if (price.state !== 'answered' || price.mcp?.isError) return { ok: false, status: 409, refused: 'price', error: `That price preview ${price.state === 'running' ? 'has not ended yet' : 'did not answer'}: preview it again. Nothing was sent.` };
    if (!price.ended_at || this.t() - Date.parse(price.ended_at) > PROPOSAL_MS) return { ok: false, status: 409, refused: 'price', error: 'That price preview is more than 10 minutes old: preview it again, prices change. Nothing was sent.' };
    const quote = quoteOf(this.answerOf(scope, price));
    if (!quote) return { ok: false, status: 409, refused: 'price', error: 'Treg’s answer for that endpoint states no price in USD, so Timmy proposes no paid call for it. Nothing was sent.' };
    if (quote.endpoint_id !== price.args.endpoint_id) return { ok: false, status: 409, refused: 'price', error: 'Treg answered for a different endpoint than the one asked about: Timmy proposes nothing from it. Nothing was sent.' };
    if (!ENDPOINT_ID.test(quote.endpoint_id)) return { ok: false, status: 409, refused: 'price', error: 'The endpoint id Treg answered is not one Timmy passes on. Nothing was sent.' };
    const parts = callParts(body.request);
    if (!parts.ok) return { ok: false, status: 400, refused: 'usage', error: `${parts.error} Nothing was sent.` };
    this.sweep();
    const route = isRoute(body.route) ? body.route : price.route;
    const id = `q${randomBytes(6).toString('hex')}`;
    const idempotency_key = `timmy-${randomBytes(8).toString('hex')}`;
    const request_sha256 = sha(JSON.stringify({ endpoint_id: quote.endpoint_id, ...parts.parts }));
    const words = [
      `Calls ${quote.endpoint_id}${quote.name ? ` (${quote.name})` : ''} once through Treg, on this computer’s Treg sign-in, through ${routeWord(route)}.`,
      `Treg’s catalog quotes ${usdWords(quote.usd)}${quote.type ? ` ${quote.type.replace(/_/g, ' ')}` : ''}${quote.note ? ` (${quote.note})` : ''}${quote.checked ? `, checked ${quote.checked}` : ''}${quote.confidence ? `, ${quote.confidence}` : ''}. That is a quote, not a cap: what Treg charges is what its answer and its history say.`,
      'It is sent once, with an idempotency key Timmy chose. If it fails or its end is unknown, Timmy does not call again: check Treg’s history first.',
      'Its answer is research data from a provider, not admitted evidence.',
    ];
    const p: ConnectorProposal = { id, endpoint_id: quote.endpoint_id, quote, request: parts.parts, route, idempotency_key, price_op: price.id, words, expires_at: new Date(this.t() + PROPOSAL_MS).toISOString(), request_sha256 };
    this.proposals.set(id, { p, principal: scope.principal, projectRoot: path.resolve(scope.project.root), until: this.t() + PROPOSAL_MS });
    return { ok: true, proposal: p };
  }

  private sweep(): void { const t = this.t(); for (const [k, v] of this.proposals) if (v.until <= t) this.proposals.delete(k); }

  // ── stop and recover ──────────────────────────────────────────────────────────────────────────────────────────────────

  stop(scope: ConnectorScope, id: string): { ok: true; op: ConnectorOpView } | Refusal {
    const dir = this.own(scope, id);
    if (!dir) return { ok: false, status: 404, refused: 'unknown', error: 'No such operation in this project.' };
    const rec = this.read(scope, id)!;
    if (rec.state !== 'running') return { ok: true, op: this.view(scope, rec) };
    if (rec.kind === 'discover') return { ok: false, status: 409, refused: 'busy', error: 'A listing ends on its own within 45 s (it is free); it is not stopped.' };
    if (!rec.pid || !alive(rec.pid)) return { ok: true, op: this.view(scope, this.read(scope, id)!) };
    try { process.kill(rec.pid, 'SIGTERM'); } catch (e) { return { ok: false, status: 409, refused: 'setup', error: `The stop could not be sent: ${msg(e)}` }; }
    rec.state = 'stopping';
    rec.stop = { asked_at: now(), by: 'the Stop on Tools & integrations', in_flight: true };
    writeRecord(dir, rec);
    return { ok: true, op: this.view(scope, rec) };
  }

  /** An interrupted call: what act left in the project (its operation record, the MCP call record) settles it. */
  recover(scope: ConnectorScope, id: string): { ok: true; op: ConnectorOpView } | Refusal {
    const dir = this.own(scope, id);
    if (!dir) return { ok: false, status: 404, refused: 'unknown', error: 'No such operation in this project.' };
    const rec = this.read(scope, id)!;
    if (rec.state !== 'interrupted') return { ok: false, status: 409, refused: 'busy', error: `This operation is ${rec.state}: only an interrupted one is recovered.` };
    const root = scope.project.root;
    const started = Date.parse(rec.started_at) - 5000;
    const opRec = rec.act_pid ? listOperationRecords(root, 200).list.map((x) => x.record).find((o) => o.owner?.pid === rec.act_pid && Date.parse(o.started) >= started && /^\/mcp call /.test(o.request)) : undefined;
    const mcpId = opRec?.runs.find((x) => x.kind === 'mcp')?.id;
    const r = readRecord(dir)!;
    if (mcpId && MCP_CALL_ID.test(mcpId)) {
      r.mcp = this.mcpOf(scope, mcpId);
      r.state = r.mcp && r.mcp.outcome === 'answered' && !r.mcp.isError ? 'answered' : 'failed';
      r.why = `recovered from the project’s records: act’s operation ${opRec!.id} (${opRec!.state}) and MCP call ${mcpId} (${r.mcp?.outcome ?? 'no record'})`;
      if (r.paid) r.charged = chargedOf(this.answerOf(scope, r));
    } else {
      r.state = r.paid ? 'unknown' : 'failed';
      r.why = r.paid
        ? `act ended without its end, and the project keeps no record of the call${opRec ? ` (its operation ${opRec.id} names none)` : ''}: whether Treg charged it is unknown — check Treg’s history (Timmy never calls again on its own)`
        : `act ended without its end, and the project keeps no record of the call${opRec ? ` (its operation ${opRec.id} names none)` : ''}: nothing is known of its answer; a free lookup can be made again`;
    }
    writeRecord(dir, r);
    this.seal(scope, dir, r);
    return { ok: true, op: this.view(scope, this.read(scope, id)!) };
  }

  // ── read ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

  private newOp(scope: ConnectorScope): { id: string; dir: string } {
    for (;;) {
      const id = `t${randomBytes(4).toString('hex')}`;
      const dir = opDirOf(scope, id);
      if (fs.existsSync(dir)) continue;
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      return { id, dir };
    }
  }

  private base(scope: ConnectorScope, id: string, o: Pick<ConnectorOpRecord, 'kind' | 'tool' | 'route' | 'args' | 'paid' | 'pid'> & Partial<Pick<ConnectorOpRecord, 'approved'>>): ConnectorOpRecord {
    return { schema: CONNECTOR_OP_SCHEMA, id, principal: scope.principal, project: { id: projectId(scope.project.root), name: scope.project.name }, connector: 'treg', started_at: now(), state: 'running', ...o };
  }

  private own(scope: ConnectorScope, id: string): string | null {
    if (!OP_ID.test(id)) return null;
    const dir = opDirOf(scope, id);
    const r = readRecord(dir);
    return r && r.principal === scope.principal && r.project.id === projectId(scope.project.root) ? dir : null;
  }

  read(scope: ConnectorScope, id: string): ConnectorOpRecord | null {
    const dir = this.own(scope, id);
    if (!dir) return null;
    const r = readRecord(dir)!;
    if (r.state === 'running' || r.state === 'stopping') {
      const gone = r.kind === 'discover' ? !this.listing.has(id) && !(r.pid && r.pid !== process.pid && alive(r.pid)) : !this.children.has(id) && !(r.pid && alive(r.pid));
      if (gone) {
        if (r.kind === 'discover') { r.state = 'interrupted'; r.pid = null; r.ended_at = now(); r.why = 'the companion that ran the listing stopped before it ended (a listing is free: list again)'; writeRecord(dir, r); return r; }
        this.settle(scope, id, { code: null, signal: null, seen: false });
        return readRecord(dir);
      }
    }
    return r;
  }

  list(scope: ConnectorScope): ConnectorOpView[] {
    let ids: string[] = [];
    try { ids = fs.readdirSync(opsDir(scope)).filter((n) => OP_ID.test(n)); } catch { ids = []; }
    const recs = ids.map((id) => this.read(scope, id)).filter((r): r is ConnectorOpRecord => Boolean(r));
    recs.sort((a, b) => b.started_at.localeCompare(a.started_at));
    return recs.slice(0, 30).map((r) => this.view(scope, r));
  }

  private mcpOf(scope: ConnectorScope, mcpId: string): ConnectorOpRecord['mcp'] {
    const root = scope.project.root;
    let rec: { schema?: string; outcome?: string; isError?: boolean | null; ms?: number; error?: string; output_file?: string | null } | null = null;
    try { rec = JSON.parse(fs.readFileSync(path.join(root, mcpCallRel(mcpId)), 'utf8')); } catch { rec = null; }
    if (!rec || rec.schema !== MCP_CALL_SCHEMA) return { id: mcpId, outcome: 'no record', isError: null, ms: 0, receipt: null, record: mcpCallRel(mcpId), output: null };
    let chain: ReturnType<typeof readChain> = [];
    try { chain = readChain('runs', root); } catch { chain = []; }
    const read = readMcpCalls(root, chain, 40).list.find((x) => x.record.id === mcpId);
    return {
      id: mcpId, outcome: String(rec.outcome ?? ''), isError: rec.isError ?? null, ms: Number(rec.ms) || 0,
      receipt: read?.check.status === 'verified' ? read.check.receipt : null, record: mcpCallRel(mcpId),
      output: rec.output_file === 'output.json' ? mcpOutputRel(mcpId) : null, ...(rec.error ? { error: scrubHomes(rec.error, scope.env as NodeJS.ProcessEnv).slice(0, 600) } : {}),
    };
  }

  /** The value of the call's answer, from its output.json in the project (Treg's data: untrusted, read for its numbers). */
  private answerOf(scope: ConnectorScope, r: ConnectorOpRecord): unknown {
    if (!r.mcp?.output) return null;
    try {
      const text = fs.readFileSync(path.join(scope.project.root, r.mcp.output), 'utf8');
      return answerValue(text, r.route);
    } catch { return null; }
  }

  /** act's end, read from its stdout; then the MCP call record it names; the record settled once, and sealed. */
  private settle(scope: ConnectorScope, id: string, exit: NonNullable<ConnectorOpRecord['exit']>, error?: string): void {
    const dir = opDirOf(scope, id);
    const r = readRecord(dir);
    if (!r || (r.state !== 'running' && r.state !== 'stopping')) return;
    const act = readActEnd(dir);
    r.exit = exit; r.act = act; r.ended_at = now();
    const mcpId = act?.runs.find((x) => x.kind === 'mcp')?.id;
    if (act && mcpId && MCP_CALL_ID.test(mcpId)) {
      r.mcp = this.mcpOf(scope, mcpId);
      const answered = r.mcp?.outcome === 'answered' && !r.mcp.isError;
      r.state = r.stop ? 'stopped' : answered ? 'answered' : 'failed';
      r.why = r.stop
        ? `Stop came while the call was in flight: a request already sent to Treg cannot be withdrawn, so act waited for its answer and kept it (${r.mcp?.outcome}${r.mcp?.isError ? ', Treg’s own error' : ''})`
        : answered ? `answered through ${routeWord(r.route)} in ${r.mcp!.ms} ms` : `${r.mcp?.outcome ?? 'failed'}${r.mcp?.isError ? ': Treg answered with its own error' : ''}${r.mcp?.error ? `: ${r.mcp.error}` : ''}`;
      if (r.paid) r.charged = chargedOf(this.answerOf(scope, r));
    } else if (act) {
      r.state = r.stop ? 'stopped' : 'failed';
      r.why = scrubHomes(`act ended ${act.outcome} (exit ${act.exit_code}) and named no MCP call: ${act.why || 'it said nothing more'}`, scope.env as NodeJS.ProcessEnv);
    } else {
      r.state = 'interrupted';
      r.why = error ?? (exit.seen
        ? `timmy act ended (${exit.signal ? `signal ${exit.signal}` : `exit ${exit.code}`}) without printing its end: Recover reads what it left in the project`
        : 'timmy act is gone and printed no end (the companion that started it was not there to see it end): Recover reads what it left in the project');
    }
    r.pid = null;
    writeRecord(dir, r);
    if (r.state !== 'interrupted') this.seal(scope, dir, r);
  }

  /** The project's connector.call receipt for the operation, sealed once (appendReceipt: the project's own chain). */
  private seal(scope: ConnectorScope, dir: string, r: ConnectorOpRecord): void {
    if (r.receipt || r.kind !== 'call') return;
    const status = r.state === 'answered' ? 'ok' as const : r.state === 'stopped' ? 'cancelled' as const : 'failed' as const;
    const endpoint = typeof r.args.endpoint_id === 'string' ? r.args.endpoint_id : null;
    try {
      const rc = appendReceipt('runs', {
        kind: 'connector.call', subject: `Treg ${r.tool}${endpoint ? ` ${endpoint}` : ''} (${r.id})`, policy: 'human-gated', status,
        project: r.project.name, project_id: r.project.id,
        ...(r.act?.operation ? { operation_id: r.act.operation } : {}),
        ...(r.paid && r.charged ? { cost_usd: r.charged.usd, cost_measured: true } : {}),
        connector: {
          connector: 'treg', op: r.id, tool: r.tool ?? '', route: r.route, paid: r.paid, state: r.state, principal: r.principal,
          endpoint_id: endpoint, args_sha256: sha(JSON.stringify(r.args)),
          ...(r.approved ? { proposal: r.approved.proposal, price_op: r.approved.price_op, quote_usd: r.approved.quote.usd, quote_type: r.approved.quote.type, request_sha256: r.approved.request_sha256, idempotency_key: String(r.args.idempotency_key ?? '') } : {}),
          charged_usd: r.paid ? (r.charged ? r.charged.usd : null) : null,
          ...(r.paid ? { charged_from: r.charged ? `Treg's answer, field ${r.charged.field}` : 'not stated in Treg\'s answer: Treg\'s history says' } : {}),
          mcp_call: r.mcp?.id ?? null, mcp_receipt: r.mcp?.receipt ?? null, ...(r.stop ? { stopped_in_flight: true } : {}),
        },
      }, scope.project.root);
      r.receipt = rc.hash.slice(7, 15);
      writeRecord(dir, r);
    } catch (e) {
      r.why = `${r.why ?? ''} (its receipt could not be sealed in ${r.project.name}: ${msg(e)})`.trim();
      writeRecord(dir, r);
    }
  }

  // ── what the page reads ───────────────────────────────────────────────────────────────────────────────────────────────

  view(scope: ConnectorScope, r: ConnectorOpRecord): ConnectorOpView {
    const dir = opDirOf(scope, r.id);
    const scrub = (s: string): string => scrubHomes(s.split(path.resolve(scope.project.root)).join(scope.project.name), scope.env as NodeJS.ProcessEnv);
    const live = r.state === 'running' || r.state === 'stopping';
    const value = !live && r.kind === 'call' ? this.answerOf(scope, r) : null;
    const answer = value === null ? null : typeof value === 'string' ? value.slice(0, 12_000) : JSON.stringify(value, null, 2).slice(0, 12_000);
    const quote = r.tool === 'catalog_get' && value !== null ? quoteOf(value) : null;
    const balance = r.tool === 'balance' && value !== null ? balanceOf(value) : null;
    return {
      id: r.id, connector: r.connector, kind: r.kind, tool: r.tool, route: r.route, paid: r.paid, state: r.state, live,
      started_at: r.started_at, ...(r.ended_at ? { ended_at: r.ended_at } : {}),
      args: r.args, ...(r.approved ? { approved: r.approved } : {}), ...(r.stop ? { stop: r.stop } : {}),
      ...(r.why ? { why: scrub(r.why) } : {}), operation: r.act?.operation ?? null,
      mcp: r.mcp ?? null, receipt: r.receipt ?? null,
      ...(r.discovered ? { discovered: r.discovered } : {}),
      ...(r.paid ? { charged: r.charged ?? null } : {}),
      ...(quote ? { quote } : {}), ...(balance ? { balance } : {}),
      answer, log: live ? tailOf(path.join(dir, 'act.err'), TAIL_MAX).map(scrub) : [],
      next: nextWords(r),
    };
  }

  /** The act processes this companion started, stopped with it (each through act's own stop). */
  async stopAll(waitMs = 20_000): Promise<void> {
    const live = [...this.children.values()].filter((c) => c.exitCode === null && c.signalCode === null);
    await Promise.all(live.map((c) => new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, waitMs);
      c.once('exit', () => { clearTimeout(timer); resolve(); });
      try { c.kill('SIGTERM'); } catch { clearTimeout(timer); resolve(); }
    })));
  }
}

/** What to do next, in plain words, from the operation's own state. */
function nextWords(r: ConnectorOpRecord): string {
  if (r.state === 'running') return r.kind === 'discover' ? 'Wait: the listing ends within 45 s.' : r.paid ? 'Wait for Treg’s answer. Stop ends the job, but a request already sent cannot be withdrawn.' : 'Wait for Treg’s answer (a free lookup).';
  if (r.state === 'stopping') return 'Stopping: act is waiting for the answer to the request already sent, and keeps it.';
  if (r.state === 'interrupted') return 'Recover reads what the call left in the project and settles it.';
  if (r.state === 'unknown') return 'Check Treg’s history (treg.to) to see whether it was charged before calling again. Timmy does not call again on its own.';
  if (r.state === 'failed') return r.paid ? 'Read Treg’s error, then check Treg’s history before deciding on another call: Timmy does not retry.' : 'Read the error; a free lookup can be made again.';
  if (r.kind === 'discover') return 'Search the catalog, or preview an endpoint’s price.';
  if (r.tool === 'catalog_search') return 'Preview the price of an endpoint it lists (its id), or search again.';
  if (r.tool === 'catalog_get') return 'Propose a call: Timmy shows the quote and the request, and you approve it or not.';
  if (r.tool === 'balance') return 'The balance is Treg’s own figure; Timmy never tops it up.';
  return 'The answer is research data, not admitted evidence. Put it on the Canvas; its record and receipt stay with the project.';
}

export interface ConnectorOpView {
  id: string; connector: 'treg'; kind: 'discover' | 'call'; tool: TregTool | null; route: McpRouteId; paid: boolean; state: OpState; live: boolean;
  started_at: string; ended_at?: string; args: Record<string, unknown>;
  approved?: ConnectorOpRecord['approved']; stop?: ConnectorOpRecord['stop']; why?: string; operation: string | null;
  mcp: ConnectorOpRecord['mcp'] | null; receipt: string | null; discovered?: ConnectorOpRecord['discovered'];
  charged?: { usd: number; field: string; raw: number } | null; quote?: TregQuote; balance?: { usd: number | null; micro: number | null };
  answer: string | null; log: string[]; next: string;
}

function readActEnd(dir: string): ConnectorOpRecord['act'] & { runs: Array<{ kind: string; id: string }> } | null {
  try {
    const lines = fs.readFileSync(path.join(dir, 'act.out'), 'utf8').trim().split('\n').filter(Boolean);
    const j = JSON.parse(lines[lines.length - 1] ?? '') as { schema?: string; operation?: string | null; outcome?: string; exit_code?: number; why?: string; runs?: Array<{ kind: string; id: string }>; receipts?: Array<{ id: string; kind: string; status?: string }> | null };
    if (j.schema !== 'timmy.act/1' || typeof j.exit_code !== 'number') return null;
    return { operation: j.operation ?? null, outcome: String(j.outcome ?? ''), exit_code: j.exit_code, why: String(j.why ?? ''), runs: Array.isArray(j.runs) ? j.runs : [], receipts: Array.isArray(j.receipts) ? j.receipts : [] };
  } catch { return null; }
}

function tailOf(file: string, n: number): string[] {
  try {
    // eslint-disable-next-line no-control-regex
    return fs.readFileSync(file, 'utf8').slice(-32 * 1024).replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').split('\n').filter((l) => l.trim()).slice(-n);
  } catch { return []; }
}

// ── what Tools & integrations shows: the five words, each from a record ─────────────────────────────────────────────────

export interface Rung { ok: boolean; words: string; record?: string; at?: string }

export interface TregState {
  id: 'treg'; title: string;
  installed: Rung; signed_in: Rung; discovered: Rung; ran_here: Rung; qualified: Rung;
  routes: Array<{ id: McpRouteId; available: boolean; version?: string }>;
  tools: Array<{ name: TregTool; paid: boolean }>;
  operator: boolean;
  next: string;
}

export function tregState(scope: ConnectorScope, ops: ConnectorOpView[], bridge: string[] | null): TregState {
  const env = scope.env as NodeJS.ProcessEnv;
  const routes = mcpRoutes(scope.env).map((r) => ({ id: r.id, available: r.available, ...(r.version ? { version: r.version } : {}) }));
  const cli = realOnPath('treg', scope.env);
  const s = tregSignIn(scope.env);
  const where = scrubHomes(s.path, env);
  const installed: Rung = bridge && routes.some((r) => r.available)
    ? { ok: true, words: `Timmy’s Treg bridge is here; routes: ${routes.filter((r) => r.available).map((r) => `${routeWord(r.id)}${r.version ? ` ${r.version}` : ''}`).join(', ')}. The treg CLI ${cli ? 'is on PATH' : 'is not on PATH (only its sign-in file is needed)'}. Installed is not working.` }
    : { ok: false, words: !bridge ? 'Timmy’s Treg bridge is not built here (npm run build).' : 'No MCP route is installed here (see /mcp).' };
  const signedIn: Rung = s.token
    ? { ok: true, words: `A sign-in file is at ${where} (${s.from === 'TREG_CONFIG' ? 'named by TREG_CONFIG' : 'the home’s'}), with a token${s.team ? ' and a team' : ''}. Its contents are never shown; Treg has not checked it until a call answers.`, record: where, ...(s.written ? { at: s.written } : {}) }
    : { ok: false, words: `Not signed in here: ${s.why ?? 'no token'} (looked at ${where}).` };
  const lastDiscovery = ops.find((o) => o.kind === 'discover' && o.state === 'answered');
  const discovered: Rung = lastDiscovery
    ? { ok: true, words: `Treg listed ${(lastDiscovery.discovered?.tools ?? []).map((t) => t.name).join(', ') || 'no tools'} through ${routeWord(lastDiscovery.route)} (operation ${lastDiscovery.id}).`, record: lastDiscovery.id, at: lastDiscovery.ended_at }
    : { ok: false, words: 'Not discovered in this project: Discover asks Treg for its tools (free).' };
  const answered = ops.filter((o) => o.kind === 'call' && o.state === 'answered');
  const ranHere: Rung = answered.length
    ? { ok: true, words: `${[...new Set(answered.map((o) => o.tool))].map((t) => { const o = answered.find((x) => x.tool === t)!; return `${t} (operation ${o.id}${o.receipt ? `, receipt ${o.receipt}` : ''}${o.mcp?.receipt ? `, MCP receipt ${o.mcp.receipt}` : ''})`; }).join('; ')} answered here.`, record: answered[0].id, at: answered[0].ended_at }
    : { ok: false, words: 'No call has answered in this project yet.' };
  const qualified: Rung = { ok: false, words: 'Not qualified: no qualification of Treg has been run in this build. A Treg answer is provider data for research; it is never admitted evidence.' };
  const next = !scope.operator ? 'Treg is the operator’s connection on this computer.'
    : !installed.ok ? installed.words
      : !signedIn.ok ? 'Sign in with the Treg CLI (`treg login`) on this computer, or set TREG_CONFIG to its sign-in file, then read this page again.'
        : !discovered.ok ? 'Discover Treg’s tools (free), then search its catalog.'
          : !ranHere.ok ? 'Search the catalog for what you want to do (free).'
            : 'Preview an endpoint’s price; a paid call waits for your approval of its quote.';
  return {
    id: 'treg', title: 'Treg · API catalog and calls', installed, signed_in: signedIn, discovered, ran_here: ranHere, qualified, routes,
    tools: TREG_TOOLS.map((t) => ({ name: t, paid: t === 'call' })), operator: scope.operator, next,
  };
}

// ── the routes ──────────────────────────────────────────────────────────────────────────────────────────────────────────
//
//   GET  /api/connectors                      Treg's five words, each from a record, and this project's operations
//   POST /api/connectors/treg/discover        { route }: list Treg's tools (free)
//   POST /api/connectors/treg/ops             { tool, args, route } (a free tool) or { proposal } (the approved paid call)
//   POST /api/connectors/treg/propose         { price_op, request, route }: a paid call's proposal from a price preview
//   GET  /api/connectors/ops/:id              one operation
//   POST /api/connectors/ops/:id/stop         Stop (act's own stop path; a request already sent is not withdrawn)
//   POST /api/connectors/ops/:id/recover      Recover an interrupted call from what it left in the project

export const CONNECTOR_ROUTES = { state: '/api/connectors', treg: '/api/connectors/treg', ops: '/api/connectors/ops' } as const;

export interface ConnectorRoutesContext {
  withToken: express.RequestHandler;
  withUser: express.RequestHandler;
  json: express.RequestHandler;
  scopeOf: (req: express.Request) => ConnectorScope | null;
  ops: ConnectorOps;
}

export function mountConnectorOps(app: express.Express, ctx: ConnectorRoutesContext): void {
  const scoped = (h: (req: express.Request, res: express.Response, scope: ConnectorScope) => void | Promise<void>, body = false): express.RequestHandler[] => [ctx.withToken, ctx.withUser, ...(body ? [ctx.json] : []), async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const scope = ctx.scopeOf(req);
    if (!scope) { res.status(404).json({ ok: false, error: 'No project is open for this page, so no connector operation can be kept.' }); return; }
    try { await h(req, res, scope); } catch (e) { res.status(500).json({ ok: false, error: `The connector could not answer: ${scrubHomes(msg(e), scope.env as NodeJS.ProcessEnv)}` }); }
  }];
  const answer = (res: express.Response, r: { ok: true } | Refusal): void => {
    if (r.ok) res.json(r); else res.status(r.status).json({ ok: false, refused: r.refused, error: r.error });
  };
  app.get(CONNECTOR_ROUTES.state, ...scoped((_req, res, scope) => {
    const ops = ctx.ops.list(scope);
    res.json({ ok: true, treg: tregState(scope, ops, ctx.ops.bridge()), ops, project: { name: scope.project.name } });
  }));
  app.post(`${CONNECTOR_ROUTES.treg}/discover`, ...scoped(async (req, res, scope) => { answer(res, await ctx.ops.discover(scope, (req.body ?? {}) as Record<string, unknown>)); }, true));
  app.post(`${CONNECTOR_ROUTES.treg}/ops`, ...scoped((req, res, scope) => { answer(res, ctx.ops.start(scope, (req.body ?? {}) as Record<string, unknown>)); }, true));
  app.post(`${CONNECTOR_ROUTES.treg}/propose`, ...scoped((req, res, scope) => { answer(res, ctx.ops.propose(scope, (req.body ?? {}) as Record<string, unknown>)); }, true));
  app.get(`${CONNECTOR_ROUTES.ops}/:id`, ...scoped((req, res, scope) => {
    const r = ctx.ops.read(scope, String(req.params.id));
    if (!r) { res.status(404).json({ ok: false, error: 'No such operation in this project.' }); return; }
    res.json({ ok: true, op: ctx.ops.view(scope, r) });
  }));
  app.post(`${CONNECTOR_ROUTES.ops}/:id/stop`, ...scoped((req, res, scope) => { answer(res, ctx.ops.stop(scope, String(req.params.id))); }));
  app.post(`${CONNECTOR_ROUTES.ops}/:id/recover`, ...scoped((req, res, scope) => { answer(res, ctx.ops.recover(scope, String(req.params.id))); }));
}
