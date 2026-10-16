/**
 * Round R4 (lead): `timmy fleet` as tools on Timmy's own MCP server (src/mcp/server.ts), answering exactly what the CLI's
 * --json answers (one service, src/fleet/service.ts; one verb runner, src/fleet/cli.ts fleetDo). An MCP caller is an agent:
 * a plan that asks for review before dispatch (the default) runs only with a token a person minted for it
 * (`timmy approve <hash>`), and a provider that costs money always needs one. Planning, reading and stopping need none.
 * Both MCP-to-CLI routes (src/connectors/mcp-cli.ts: mcporter and the SDK client) reach these tools as they reach any other.
 */
import { chooseProject } from '../project/index.js';
import { fleetDo, parseFleetArgs, type FleetSaid } from './cli.js';
import { ISOLATION_CLASSES, MAX_WORKERS } from './plan.js';

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });
const text = { type: 'string' }, num = { type: 'number' }, bool = { type: 'boolean' };
const planId = { type: 'string', pattern: '^f[0-9a-f]{8}$', description: 'a fleet plan id (f and 8 hex digits)' };
const project = { type: 'string', description: "the project folder or name (default: the server's current folder)" };

export const FLEET_TOOLS = [
  { name: 'timmy_fleet_providers', description: 'The execution backends Timmy knows for fleets, each available or unavailable with why. FAKE (an offline simulation: no compute, no harness, no model, no cost); Cloudroom Core (one self-hosted Core a person connected with `timmy fleet connect`, its workers sessions on that shared machine; available with TIMMY_FLEET_CLOUDROOM=1; not verified until a live check passes) and its FAKE Core (cloudroom-fake, with TIMMY_FLEET_CLOUDROOM=fake: a simulation); Modal and Hostinger are named and unavailable. Connecting a Core is not an MCP tool: a person runs it.', inputSchema: schema({}) },
  { name: 'timmy_fleet_plan', description: `Make and check a fleet plan (1 to ${MAX_WORKERS} workers, a concurrency cap, provider, isolation, harness, model, per-worker CPU/RAM/disk and TTL, budgets, policy). Nothing starts. A plan the provider cannot honour (an isolation it cannot give, a child path that could share a parent's sandbox under one-VM-per-worker, paid compute without a TTL and budget, local-only or free-only conflicts) is refused in words, never run with less. Returns the preview: counts, the effective concurrency, allocations, the compute ceiling (or unknown), and whether this is a simulation.`, inputSchema: schema({ workers: num, concurrency: num, provider: text, isolation: { type: 'string', enum: [...ISOLATION_CLASSES] }, per_worker: { type: 'string', enum: ['dedicated', 'shared'] }, harness: text, model: text, cpu: num, ram_gb: num, disk_gb: num, ttl_minutes: num, infra_budget_usd: num, inference_budget_usd: num, prompt: text, local_only: bool, allow_paid: bool, no_review: bool, project }, ['workers']) },
  { name: 'timmy_fleet_run', description: 'Run a written fleet plan to its end (the call returns when every worker has ended). An agent needs approval_token, minted by a person for this plan with `timmy approve <hash>`, when the plan asks for review before dispatch (the default) and always for a provider that costs money; without it the run is refused and nothing starts. Delivered means the runtime said completed; nothing is verified by the run.', inputSchema: schema({ plan: planId, approval_token: text, project }, ['plan']) },
  { name: 'timmy_fleet_status', description: "A fleet plan's state from its own files (or every plan's): requested, admitted, queued, running, live and unknown allocations, delivered, verified, failed, cancelled and refused kept apart; each worker's allocation, session and collection; what needs a person.", inputSchema: schema({ plan: planId, project }) },
  { name: 'timmy_fleet_events', description: "A fleet plan's normalized events (each with the runtime's own event beside it, redacted), optionally one worker's, after an event number.", inputSchema: schema({ plan: planId, worker: num, after: num, limit: num, project }, ['plan']) },
  { name: 'timmy_fleet_stop', description: 'Ask the process running a fleet plan to stop: queued workers do not start; running ones are stopped, collected and torn down (each step recorded). Says plainly when no process runs it.', inputSchema: schema({ plan: planId, project }, ['plan']) },
];

const FLAG_OF: Record<string, string> = {
  workers: 'workers', concurrency: 'concurrency', provider: 'provider', isolation: 'isolation', per_worker: 'per-worker', harness: 'harness', model: 'model',
  cpu: 'cpu', ram_gb: 'ram', disk_gb: 'disk', ttl_minutes: 'ttl', infra_budget_usd: 'infra-budget', inference_budget_usd: 'inference-budget', prompt: 'prompt',
  worker: 'worker', after: 'after', limit: 'limit', approval_token: 'approve',
};
const BOOL_OF: Record<string, string> = { local_only: 'local-only', allow_paid: 'allow-paid', no_review: 'no-review' };

/** The CLI argv an MCP call stands for (so both are parsed and checked by one parser). */
export function fleetArgvOf(name: string, args: Record<string, unknown>): string[] {
  const verb = name.replace(/^timmy_fleet_/, '');
  const argv: string[] = [verb];
  if (typeof args.plan === 'string' && args.plan) argv.push(args.plan);
  for (const [k, v] of Object.entries(args)) {
    if (k === 'plan' || k === 'project' || v === undefined || v === null) continue;
    if (BOOL_OF[k]) { if (v === true) argv.push(`--${BOOL_OF[k]}`); continue; }
    if (FLAG_OF[k]) argv.push(`--${FLAG_OF[k]}`, String(v));
    else argv.push(`--${k}`); // an unknown argument is refused by the parser, never ignored
  }
  return argv;
}

export async function callFleetTool(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  if (!FLEET_TOOLS.some((t) => t.name === name)) return { schema: 'timmy.fleet/1', ok: false, error: `no tool ${name}` };
  const p = parseFleetArgs(fleetArgvOf(name, args), { json: true });
  if ('error' in p) return { schema: 'timmy.fleet/1', ok: false, error: p.error, exit_code: 2 };
  let root = process.cwd();
  if (typeof args.project === 'string' && args.project) {
    const chosen = chooseProject(args.project);
    if ('error' in chosen) return { schema: 'timmy.fleet/1', ok: false, error: chosen.error, exit_code: 1 };
    root = chosen.root;
  }
  const said: FleetSaid = await fleetDo(p, root, { by: 'agent' });
  return { ...said.json, exit_code: said.code, lines: said.lines };
}
